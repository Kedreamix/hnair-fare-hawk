"""多通道消息通知：企业微信 / 企业微信机器人 / 邮件 / 飞书（加急+卡片） / 钉钉 / Bark(iOS) / ntfy(Android)。

统一入口 ``notify_channels``：按 config.notify_channels 路由到所有已启用渠道，
返回 {channel: {"ok": bool, "error": str, "message_id": str}}。

级别语义：
- "info"      ：普通通知（各渠道普通形态，不打扰）
- "important" ：重要通知（加急开关开启时：飞书 urgent_app、钉钉 @所有人、
                Bark 时效性通知、ntfy 最高优先级、企微醒目样式）
- "critical"  ：阻断告警（等价 important，但强制所有渠道发送，即使渠道 enabled=False 也试发）

任何输出都不回显凭证（corp_secret / app_secret / webhook 中的 secret / device_key / topic 摘要）。
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import html
import json
import re
import smtplib
import time
import urllib.parse
from datetime import datetime
from email.mime.text import MIMEText
from typing import Any, Dict, Optional

import requests

# ==================== 海航跳转 ====================

_APP_URL_RE = re.compile(r"hna2app://\S+")
_WEB_URL_RE = re.compile(r"https://new\.hnair\.com/\S+")


def hna_app_url(from_code: str, to_code: str, day: str) -> str:
    """海航 App 搜索页。与控制台「打开 App」同一套 scheme。"""
    origin = str(from_code or "").strip().upper()
    dest = str(to_code or "").strip().upper()
    date = str(day or "").strip()
    if not (origin and dest and date):
        return ""
    return (
        "hna2app://app.hnar.com?url=searchIndex"
        f"&params={{depCode:{origin},dstCode:{dest},startTime:{date},tripType:1}}"
    )


def hna_web_url(from_code: str, to_code: str, day: str, flight: str = "") -> str:
    """官网查询页，给打不开 App 的客户端用。"""
    origin = str(from_code or "").strip().upper()
    dest = str(to_code or "").strip().upper()
    date = str(day or "").strip()
    if not (origin and dest and date):
        return ""
    params = urllib.parse.urlencode({
        "orgCity": origin,
        "dstCity": dest,
        "takeoffDate": date,
        "flightNo": str(flight or "").strip().upper(),
    })
    return f"https://new.hnair.com/hainanair/ibe/common/flightSearch.do?{params}"


def hna_jump_block(from_code: str, to_code: str, day: str, flight: str = "") -> str:
    """提醒正文末尾的跳转地址。邮件发送时会去掉官网这一行。"""
    app_url = hna_app_url(from_code, to_code, day)
    web_url = hna_web_url(from_code, to_code, day, flight)
    lines = []
    if app_url:
        lines.append(f"打开海航 App：{app_url}")
    if web_url:
        lines.append(f"官网查询：{web_url}")
    return "\n".join(lines)


def _card_markdown(content: str) -> str:
    """卡片正文过长时截断说明，跳转地址始终保留。"""
    lines = str(content or "").splitlines()
    jump = [line for line in lines if line.startswith("打开海航 App：") or line.startswith("官网查询：")]
    body = "\n".join(line for line in lines if line not in jump).strip()
    if len(body) > 500:
        body = body[:497] + "..."
    if jump:
        body = f"{body}\n\n" + "\n".join(jump) if body else "\n".join(jump)
    return body


def _first_match(pattern: re.Pattern[str], content: str) -> str:
    matched = pattern.search(str(content or ""))
    return matched.group(0) if matched else ""


def _wecom_plain_lines(content: str) -> list[str]:
    """企业微信正文保留 App 链接，去掉官网地址。"""
    lines = []
    for line in str(content or "").splitlines():
        if line.startswith("官网查询：") or "https://new.hnair.com/" in line:
            continue
        text = line.strip()
        if text:
            lines.append(text)
    return lines


def wecom_link_markdown(title: str, content: str, urgent: bool) -> str:
    """机器人消息带上海航 App 链接。"""
    heading = f"## ⚠️ {title}" if urgent else f"## {title}"
    body = "\n".join(_wecom_plain_lines(content))
    return _trim_utf8(f"{heading}\n\n{body}".strip(), 20000)


def apply_task_email(cfg: Dict[str, Any], notify_email: str) -> Dict[str, Any]:
    """某条航线单独指定收件人时，只替换这一封邮件的收件人。"""
    text = str(notify_email or "").strip()
    if not text:
        return cfg
    copied = dict(cfg)
    email_cfg = dict(copied.get("email") or {})
    email_cfg["receiver"] = text
    copied["email"] = email_cfg
    return copied


def _email_text(content: str) -> str:
    """邮件只保留 App 跳转，去掉官网地址。"""
    kept = []
    for line in str(content or "").splitlines():
        if line.startswith("官网查询：") or "https://new.hnair.com/" in line:
            continue
        kept.append(line)
    return "\n".join(kept).strip()


def _email_html(content: str) -> str:
    """纯文本转 HTML。App 那一行只显示一个「打开海航 App」链接。"""
    chunks = []
    for line in _email_text(content).splitlines():
        if line.startswith("打开海航 App："):
            url = line.split("：", 1)[1].strip()
            chunks.append(f'<p><a href="{html.escape(url, quote=True)}">打开海航 App</a></p>')
            continue
        chunks.append(html.escape(line) + "<br>\n")
    body = "".join(chunks)
    return (
        "<html><body style=\"font-family:sans-serif;line-height:1.6\">"
        f"{body}</body></html>"
    )


# ==================== 工具 ====================


def _mask(value: str, keep_head: int = 4, keep_tail: int = 4) -> str:
    """凭证脱敏：前4后4，中间 ****。空值原样返回。"""
    v = str(value or "").strip()
    if not v:
        return ""
    if len(v) <= keep_head + keep_tail:
        return v[:1] + "****"
    return f"{v[:keep_head]}****{v[-keep_tail:]}"


def _now_iso() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _post_json(url: str, json_body: Dict[str, Any], headers: Optional[Dict[str, str]] = None, timeout: int = 10) -> Dict[str, Any]:
    """POST JSON 并统一解析；请求异常抛 requests.RequestException。"""
    resp = requests.post(url, json=json_body, headers=headers, timeout=timeout)
    try:
        return resp.json()
    except ValueError:
        return {"_http_status": resp.status_code, "_raw": resp.text[:200]}


# ==================== 企业微信自建应用（微信插件） ====================

def _wecom_token(corp_id: str, secret: str) -> Optional[str]:
    """企业微信 access_token（2 小时有效，个人监控并发低无需缓存）。"""
    try:
        resp = requests.get(
            "https://qyapi.weixin.qq.com/cgi-bin/gettoken",
            params={"corpid": corp_id, "corpsecret": secret},
            timeout=10,
        )
        data = resp.json()
    except (requests.RequestException, ValueError):
        return None
    if data.get("errcode") == 0 and data.get("access_token"):
        return str(data["access_token"])
    return None


def send_wecom(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """企业微信自建应用消息（未认证个人也可用，消息直达微信「企业微信」会话）。

    返回 (ok, error, message_id)。cfg: corp_id/agent_id/secret/user_id。
    """
    corp_id = str(cfg.get("corp_id", "") or "").strip()
    agent_id = str(cfg.get("agent_id", "") or "").strip()
    secret = str(cfg.get("secret", "") or "").strip()
    user_id = str(cfg.get("user_id", "") or "").strip() or "@all"
    if not (corp_id and agent_id and secret):
        return False, "企业微信配置不完整（缺少企业ID/应用ID/Secret）", ""

    token = _wecom_token(corp_id, secret)
    if not token:
        return False, "获取企业微信 access_token 失败，请检查企业ID/Secret 是否正确", ""

    agent = int(agent_id) if agent_id.isdigit() else agent_id
    # 卡片按钮只接受 http/https，点开会进官网。这里改发正文，把海航 App 链接带上。
    if urgent:
        payload = {
            "touser": user_id,
            "msgtype": "markdown",
            "agentid": agent,
            "markdown": {"content": wecom_link_markdown(title, content, True)},
            "safe": 0,
        }
    else:
        body = "\n".join(_wecom_plain_lines(content))
        text = _trim_utf8(f"{title}\n{body}".strip(), 2048)
        payload = {
            "touser": user_id,
            "msgtype": "text",
            "agentid": agent,
            "text": {"content": text or title or "有一条航班提醒"},
            "safe": 0,
        }
    try:
        data = _post_json(
            f"https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}",
            payload,
        )
    except requests.RequestException as exc:
        return False, f"请求企业微信接口失败：{exc}", ""
    if data.get("errcode") == 0:
        return True, "", str(data.get("msgid", "") or "")
    # 常见错误码：60011 无权限 / 60111 成员不存在 / 40013 无效 corpid / 40014 无效 token
    errcode = data.get("errcode")
    if errcode in (60011,):
        return False, "应用无发送权限，请在企微管理后台「应用→权限」中开启「发送应用消息」", ""
    if errcode in (60111,):
        return False, f"接收成员 user_id 不存在（{user_id}），请在管理后台通讯录查看自己的 userid", ""
    if errcode in (40013, 40014):
        return False, f"企业ID/Secret 无效（errcode={errcode}）", ""
    return False, f"企业微信接口返回 errcode={errcode}: {data.get('errmsg', '')}", ""


def _trim_utf8(text: str, limit: int) -> str:
    raw = text.encode("utf-8")
    if len(raw) <= limit:
        return text
    return raw[: limit - 3].decode("utf-8", errors="ignore") + "..."


def aibot_send_markdown(bot_id: str, secret: str, chat_id: str, chat_type: int, content: str) -> None:
    """智能机器人长连接：订阅后发一条 markdown。失败抛 RuntimeError，内容不含凭证。"""
    import asyncio
    import ssl
    import uuid

    import certifi
    import websockets

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())

    async def _run() -> None:
        async with websockets.connect("wss://openws.work.weixin.qq.com", ssl=ssl_ctx, open_timeout=15) as ws:
            await ws.send(json.dumps({
                "cmd": "aibot_subscribe",
                "headers": {"req_id": str(uuid.uuid4())},
                "body": {"bot_id": bot_id, "secret": secret},
            }))
            subscribed = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if subscribed.get("errcode") != 0:
                raise RuntimeError(f"订阅失败 errcode={subscribed.get('errcode')}")
            await ws.send(json.dumps({
                "cmd": "aibot_send_msg",
                "headers": {"req_id": str(uuid.uuid4())},
                "body": {
                    "chatid": chat_id,
                    "chat_type": chat_type,
                    "msgtype": "markdown",
                    "markdown": {"content": content},
                },
            }))
            sent = json.loads(await asyncio.wait_for(ws.recv(), timeout=15))
            if sent.get("errcode") != 0:
                raise RuntimeError(f"推送失败 errcode={sent.get('errcode')}")

    asyncio.run(_run())


def send_wechat_bot(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """企业微信机器人，只发个人单聊。"""
    bot_id = str(cfg.get("bot_id", "") or "").strip()
    secret = str(cfg.get("secret", "") or "").strip()
    chat_id = str(cfg.get("chat_id", "") or "").strip()
    chat_type = 1
    if not (bot_id and secret and chat_id):
        return False, "企业微信机器人配置不完整（需要机器人 ID、Secret、接收人）", ""
    body = wecom_link_markdown(title, content, urgent)
    try:
        aibot_send_markdown(bot_id, secret, chat_id, chat_type, body)
    except ImportError:
        return False, "发送失败：缺少 websockets 库", ""
    except RuntimeError as exc:
        return False, str(exc), ""
    except Exception:
        return False, "连接企业微信机器人失败", ""
    return True, "", ""


def send_email(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """QQ 邮箱式 SMTP：465 用 SSL，登录名和发件人可以分开。密码是授权码。"""
    host = str(cfg.get("host", "") or "").strip()
    username = str(cfg.get("username", "") or "").strip()
    password = str(cfg.get("password", "") or "").strip()
    sender = str(cfg.get("sender", "") or "").strip()
    raw_to = str(cfg.get("receiver", "") or "").replace(";", ",").replace("\n", ",")
    receivers = [part.strip() for part in raw_to.split(",") if part.strip()]
    port_raw = str(cfg.get("port", "") or "").strip() or "465"
    if not port_raw.isdigit() or not (1 <= int(port_raw) <= 65535):
        return False, "邮件端口不正确", ""
    port = int(port_raw)
    if not sender and "@" in username:
        sender = username
    if not (host and username and sender and receivers and password):
        return False, "邮件配置不完整（需要服务器、登录账号、授权码、发件人和收件人）", ""

    subject = f"【加急】{title}" if urgent else title
    message = MIMEText(_email_html(content), "html", "utf-8")
    message["From"] = sender
    message["To"] = ",".join(receivers)
    message["Subject"] = subject
    try:
        if port == 465:
            smtp = smtplib.SMTP_SSL(host, port, timeout=15)
        else:
            smtp = smtplib.SMTP(host, port, timeout=15)
            smtp.ehlo()
            if port != 25:
                smtp.starttls()
                smtp.ehlo()
        login_res = smtp.login(username, password)
        code = login_res[0] if isinstance(login_res, tuple) else 0
        if code != 235:
            smtp.quit()
            return False, "邮箱登录失败，请检查账号和授权码", ""
        smtp.sendmail(sender, receivers, message.as_string())
        smtp.quit()
    except smtplib.SMTPAuthenticationError:
        return False, "邮箱登录失败，请检查账号和授权码", ""
    except (OSError, smtplib.SMTPException):
        return False, "发送邮件失败，请检查服务器、端口和收件人", ""
    return True, "", ""


# ==================== 钉钉群机器人 ====================

def _dingtalk_sign(secret: str) -> tuple[str, str]:
    """钉钉加签：timestamp + HMAC-SHA256(secret, f'{ts}\\n{secret}') base64 URL 编码。"""
    ts = str(round(time.time() * 1000))
    if not secret:
        return ts, ""
    string_to_sign = f"{ts}\n{secret}"
    hmac_code = hmac.new(secret.encode("utf-8"), string_to_sign.encode("utf-8"), digestmod=hashlib.sha256).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(hmac_code))
    return ts, sign


def send_dingtalk(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """钉钉群自定义机器人 webhook（可加签）。加急=@所有人。"""
    webhook = str(cfg.get("webhook", "") or "").strip()
    secret = str(cfg.get("secret", "") or "").strip()
    if not webhook:
        return False, "钉钉机器人未配置（缺少 webhook 地址）", ""

    url = webhook
    if secret:
        ts, sign = _dingtalk_sign(secret)
        sep = "&" if "?" in url else "?"
        url = f"{url}{sep}timestamp={ts}&sign={sign}"

    text_body = f"{title}\n{content}"
    at = {"isAtAll": True} if urgent else {}
    payload = {"msgtype": "text", "text": {"content": text_body}, "at": at}
    try:
        data = _post_json(url, payload)
    except requests.RequestException as exc:
        return False, f"请求钉钉接口失败：{exc}", ""
    if data.get("errcode") == 0:
        return True, "", ""
    if data.get("errcode") == 310000:
        return False, "钉钉机器人关键词不匹配，请在机器人安全设置中把标题关键词（如「监控」）加入，或关闭关键词校验", ""
    return False, f"钉钉接口返回 errcode={data.get('errcode')}: {data.get('errmsg', '')}", ""


# ==================== Bark（iOS，APNs 原生推送） ====================

def send_bark(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """Bark：POST /push {device_key,title,body,group,level,sound}。加急=timeSensitive 时效性通知（锁屏强提醒）。"""
    device_key = str(cfg.get("device_key", "") or "").strip()
    server = str(cfg.get("server", "") or "").strip() or "https://api.day.app"
    if not device_key:
        return False, "Bark 未配置（缺少 device_key，iOS 装 Bark App 后打开即得）", ""
    payload = {
        "device_key": device_key,
        "title": title,
        "body": content,
        "group": "海航监控",
        "level": "timeSensitive" if urgent else "active",
        "sound": "alarm.caf" if urgent else "default",
    }
    app_url = _first_match(_APP_URL_RE, content)
    if app_url:
        payload["url"] = app_url
    try:
        data = _post_json(f"{server.rstrip('/')}/push", payload)
    except requests.RequestException as exc:
        return False, f"请求 Bark 接口失败：{exc}", ""
    if data.get("code") == 200:
        return True, "", str(data.get("messageId", "") or "")
    return False, f"Bark 接口返回 code={data.get('code')}: {data.get('message', '')}", ""


# ==================== ntfy（Android/跨平台） ====================

def send_ntfy(cfg: Dict[str, Any], title: str, content: str, urgent: bool) -> tuple[bool, str, str]:
    """ntfy：POST /<topic>，标题/优先级/标签走 headers。加急=priority 5(max)。"""
    topic = str(cfg.get("topic", "") or "").strip()
    server = str(cfg.get("server", "") or "").strip() or "https://ntfy.sh"
    if not topic:
        return False, "ntfy 未配置（缺少 topic，Android 装 ntfy App 后订阅一个主题即得）", ""
    headers = {
        "Title": title,
        "Priority": "5" if urgent else "3",
        "Tags": "rotating_light" if urgent else "ticket",
    }
    app_url = _first_match(_APP_URL_RE, content)
    if app_url:
        headers["Click"] = app_url
    try:
        resp = requests.post(
            f"{server.rstrip('/')}/{topic.lstrip('/')}",
            data=content.encode("utf-8"),
            headers=headers,
            timeout=10,
        )
    except requests.RequestException as exc:
        return False, f"请求 ntfy 接口失败：{exc}", ""
    if resp.status_code in (200, 201):
        try:
            mid = str(resp.json().get("id", "") or "")
        except ValueError:
            mid = ""
        return True, "", mid
    return False, f"ntfy 接口返回 HTTP {resp.status_code}", ""


# ==================== 飞书（加急 + 交互卡片） ====================

def _feishu_token(app_id: str, app_secret: str) -> Optional[str]:
    """租户 access_token。"""
    try:
        resp = requests.post(
            "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
            json={"app_id": app_id, "app_secret": app_secret},
            timeout=10,
        )
        data = resp.json()
        if resp.status_code == 200 and data.get("code") == 0:
            return str(data.get("tenant_access_token", "") or "")
    except (requests.RequestException, ValueError):
        return None
    return None


def send_feishu(
    cfg: Dict[str, Any],
    title: str,
    content: str,
    urgent: bool,
    card: Optional[Dict[str, Any]] = None,
) -> tuple[bool, str, str]:
    """飞书自建应用消息。

    - urgent=True 时发送成功后调 urgent_app 应用内加急（免费无限额）；
    - card 提供交互卡片（msg_type=interactive，卡片卡片可带按钮回调做确认闭环）。
    返回 (ok, error, message_id)。
    """
    app_id = str(cfg.get("app_id", "") or "").strip()
    app_secret = str(cfg.get("app_secret", "") or "").strip()
    receiver = str(cfg.get("receiver", "") or "").strip()
    if not (app_id and app_secret and receiver):
        return False, "飞书配置不完整（缺少 App ID / App Secret / 接收人）", ""
    token = _feishu_token(app_id, app_secret)
    if not token:
        return False, "获取 tenant_access_token 失败，请检查 App ID / App Secret 是否正确", ""

    receive_id_type = "open_id" if receiver.startswith("ou_") else "email"
    if card is not None:
        payload = {"receive_id": receiver, "msg_type": "interactive", "content": json.dumps(card, ensure_ascii=False)}
    else:
        text = f"{title}\n\n{content}"
        payload = {"receive_id": receiver, "msg_type": "text", "content": json.dumps({"text": text}, ensure_ascii=False)}
    try:
        resp = requests.post(
            "https://open.feishu.cn/open-apis/im/v1/messages"
            f"?receive_id_type={receive_id_type}&user_id_type=open_id",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json=payload,
            timeout=10,
        )
        data = resp.json()
    except (requests.RequestException, ValueError) as exc:
        return False, f"请求飞书接口失败：{exc}", ""

    if resp.status_code != 200 or data.get("code") != 0:
        code = data.get("code")
        msg = str(data.get("msg", "") or "")
        if code in (99991661, 99991664):
            return False, f"权限不足（code={code}），请在开放平台为应用开通 im:message:send_as_bot 并重新发布版本", ""
        if code == 99991668:
            return False, f"接收人不存在或不在应用可见范围（code={code}）", ""
        return False, f"飞书接口返回 code={code}: {msg}", ""

    message_id = str((data.get("data") or {}).get("message_id", "") or "")
    # 应用内加急（免费无额度）：只对本应用自己发送的消息有效
    # 注意：user_id_list 必须在请求体（body）里传 JSON 数组；放 query 会报
    # code=230001 "all ids in the user_id_list are invalid"。
    if urgent and message_id:
        try:
            resp = requests.patch(
                f"https://open.feishu.cn/open-apis/im/v1/messages/{message_id}/urgent_app"
                "?user_id_type=open_id",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                json={"user_id_list": [receiver]},
                timeout=10,
            )
            udata = resp.json()
            if udata.get("code") != 0:
                # 加急失败不影响主消息送达；返回警告供状态展示
                return True, f"消息已发送但加急失败（code={udata.get('code')}: {udata.get('msg', '')}，请确认应用开启了加急权限 im:message.urgent_app）", message_id
        except requests.RequestException:
            return True, "消息已发送但加急请求超时", message_id
    return True, "", message_id


def build_confirm_card(
    title: str,
    content: str,
    callback_key: str,
    action_value: str,
) -> Dict[str, Any]:
    """构造「标题 + 正文 + 确认按钮」交互卡片。

    - 按钮 callback 带 callback_key 与 action_value，卡片回调后由回调处理更新；
    - 卡片自带「普通确认」与「忽略」两个按钮。
    """
    content_short = _card_markdown(content)
    actions: list[Dict[str, Any]] = [
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "✅ 确认已处理"},
            "type": "primary",
            "value": {"callback_key": callback_key, "action": action_value, "confirm": "1"},
        },
        {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "忽略"},
            "type": "default",
            "value": {"callback_key": callback_key, "action": action_value, "confirm": "0"},
        },
    ]
    app_url = _first_match(_APP_URL_RE, content)
    web_url = _first_match(_WEB_URL_RE, content)
    if app_url:
        jump = {
            "tag": "button",
            "text": {"tag": "plain_text", "content": "打开海航 App"},
            "type": "primary",
            "url": app_url,
            "multi_url": {
                "url": app_url,
                "android_url": app_url,
                "ios_url": app_url,
                "pc_url": web_url or app_url,
            },
        }
        actions.append(jump)
    if web_url:
        actions.append({
            "tag": "button",
            "text": {"tag": "plain_text", "content": "官网查询"},
            "type": "default",
            "url": web_url,
        })
    return {
        # update_multi 必须为 true：更新已发送卡片接口要求更新前后卡片都显式声明为共享卡片，
        # 否则 PATCH 返回 code=0 但用户端内容不更新（按钮不消失）。
        "config": {"wide_screen_mode": True, "update_multi": True},
        "header": {"template": "red" if "🚨" in title else "blue", "title": {"tag": "plain_text", "content": title}},
        "elements": [
            {"tag": "markdown", "content": content_short},
            {"tag": "action", "actions": actions},
        ],
    }


def build_confirm_resolved_card(origin_card: Dict[str, Any], confirmed: bool) -> Dict[str, Any]:
    """回调后替换按钮为「已确认/已忽略」状态的静态卡片（去按钮）。"""
    card = json.loads(json.dumps(origin_card))
    new_elements = []
    for el in card.get("elements", []):
        if isinstance(el, dict) and el.get("tag") == "action":
            status = "✅ 已确认处理" if confirmed else "已忽略"
            new_elements.append({"tag": "markdown", "content": f"**{status}**（海航监控自动反馈）"})
        else:
            new_elements.append(el)
    card["elements"] = new_elements
    return card


def update_feishu_card(app_id: str, app_secret: str, message_id: str, card: Dict[str, Any]) -> tuple[bool, str]:
    """用新内容更新已发送的交互卡片（回调反馈闭环）。

    官方「更新已发送的消息卡片」接口要求：更新前后卡片的 config 均需显式
    声明 update_multi=true（共享卡片），否则 PATCH 返回 code=0 但内容不生效。
    """
    token = _feishu_token(app_id, app_secret)
    if not token:
        return False, "获取 tenant_access_token 失败"
    # 防御：即使登记的原卡片来自旧版本（config 缺 update_multi），更新侧也强制声明
    card_cfg = dict(card.get("config") or {})
    card_cfg["update_multi"] = True
    card = dict(card)
    card["config"] = card_cfg
    try:
        resp = requests.patch(
            f"https://open.feishu.cn/open-apis/im/v1/messages/{message_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
            json={"content": json.dumps(card, ensure_ascii=False)},
            timeout=10,
        )
        data = resp.json()
    except (requests.RequestException, ValueError) as exc:
        return False, f"更新卡片失败：{exc}"
    if data.get("code") == 0:
        return True, ""
    return False, f"更新卡片失败 code={data.get('code')}: {data.get('msg', '')}"


# ==================== 统一路由 ====================

CHANNEL_NAMES = ("wecom", "feishu", "dingtalk", "bark", "ntfy", "wechat_bot", "email")

CHANNEL_LABELS = {
    "wecom": "企业微信",
    "wechat_bot": "企业微信机器人",
    "email": "邮件",
    "feishu": "飞书",
    "dingtalk": "钉钉",
    "bark": "Bark(iOS)",
    "ntfy": "ntfy(安卓)",
}


def _channel_enabled(cfg: Dict[str, Any], name: str) -> bool:
    ch = cfg.get(name) or {}
    if name == "feishu":
        # 飞书渠道既有配置在 config.feishu，启用 = 配置完整 && 渠道开关开启（默认开）
        feishu_cfg = cfg.get("feishu") or {}
        configured = bool(str(feishu_cfg.get("app_id", "") or "").strip() and str(feishu_cfg.get("app_secret", "") or "").strip())
        return configured and bool(feishu_cfg.get("enabled", True))
    return bool(ch.get("enabled", False))


def _urgent_enabled(cfg: Dict[str, Any], name: str, level: str) -> bool:
    """该渠道本次是否加急：全局开关 + 渠道开关（飞书独立加急开关）+ level 达到重要级别。"""
    global_urgent = bool(cfg.get("urgent_enabled", True))
    if not global_urgent:
        return False
    if name == "feishu":
        # 飞书卡片/消息加急开关：默认开；关闭后该渠道不发加急（仍正常推送）
        feishu_cfg = cfg.get("feishu") or {}
        if not bool(feishu_cfg.get("urgent_enabled", True)):
            return False
    if level in ("important", "critical"):
        return True
    return False


def send_channel(
    cfg: Dict[str, Any],
    name: str,
    level: str,
    title: str,
    content: str,
    card: Optional[Dict[str, Any]] = None,
) -> tuple[bool, str, str]:
    """向单个渠道发送一条消息。返回 (ok, error, message_id)。"""
    urgent = _urgent_enabled(cfg, name, level)
    ch = cfg.get(name) or {}
    if name == "wecom":
        return send_wecom(ch, title, content, urgent)
    if name == "feishu":
        feishu_cfg = dict(cfg.get("feishu") or {})
        # 飞书卡片确认回调键：用于回执记录
        return send_feishu(feishu_cfg, title, content, urgent, card=card)
    if name == "dingtalk":
        return send_dingtalk(ch, title, content, urgent)
    if name == "wechat_bot":
        return send_wechat_bot(ch, title, content, urgent)
    if name == "email":
        return send_email(ch, title, content, urgent)
    if name == "bark":
        return send_bark(ch, title, content, urgent)
    if name == "ntfy":
        return send_ntfy(ch, title, content, urgent)
    return False, f"未知渠道：{name}", ""


def notify_channels(
    cfg: Dict[str, Any],
    level: str = "important",
    title: str = "",
    content: str = "",
    channels: Optional[list[str]] = None,
    card: Optional[Dict[str, Any]] = None,
    history_path: str = "",
) -> Dict[str, Dict[str, Any]]:
    """向所有启用渠道广播一条消息（多通道）。

    - channels 指定时只发这些渠道（供测试）；否则发全部启用渠道；
    - critical 级别强制全渠道（即使个别渠道 enabled=False 也尝试）；
    - 结果写 notification_history.jsonl（若指定 history_path），成功/失败都记录。
    """
    results: Dict[str, Dict[str, Any]] = {}
    names = channels or list(CHANNEL_NAMES)
    for name in names:
        if not _channel_enabled(cfg, name) and level != "critical":
            continue
        ok, error, message_id = send_channel(cfg, name, level, title, content, card=card)
        entry = {
            "ts": _now_iso(),
            "channel": name,
            "channel_label": CHANNEL_LABELS.get(name, name),
            "level": level,
            "title": title[:80],
            "ok": ok,
            "error": error[:200] if error else "",
            "message_id": message_id,
        }
        results[name] = entry
        if history_path:
            try:
                with open(history_path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            except OSError:
                pass
    return results