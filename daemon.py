"""后端常驻进程入口。"""

from __future__ import annotations

import json
import os
import random
import time
from datetime import datetime, time as dt_time, timedelta
from typing import Any, Dict, List

import portalocker

from backend.channels import build_confirm_card, hna_jump_block, notify_channels
import backend.feishu_ws as feishu_ws  # noqa: E402
from backend.fetcher import TokenExpiredError, fetch_price_status
from backend.notifier import (
    send_price_alert,
    send_token_expired_alert,
    tier_text,
)
from backend.scheduler import get_next_interval_seconds
from backend.state import AlertStateManager
from city_codes import code_to_city_only

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config.json")
TASKS_PATH = os.path.join(BASE_DIR, "tasks.json")
LOG_PATH = os.path.join(BASE_DIR, "run_log.txt")
STATE_PATH = os.path.join(BASE_DIR, "runtime_state.json")
HISTORY_PATH = os.path.join(BASE_DIR, "price_history.jsonl")
NOTIFY_HISTORY_PATH = os.path.join(BASE_DIR, "notification_history.jsonl")

# 与 app.py DEFAULT_CONFIG 保持一致的多通道通知结构（独立启动 daemon 时防缺键）
DEFAULT_NOTIFY_CHANNELS = {
    "urgent_enabled": True,
    "wecom": {"enabled": False, "corp_id": "", "agent_id": "", "secret": "", "user_id": ""},
    "dingtalk": {"enabled": False, "webhook": "", "secret": ""},
    "wechat_bot": {"enabled": False, "bot_id": "", "secret": "", "chat_id": "", "chat_type": "single"},
    "email": {
        "enabled": False,
        "host": "",
        "port": "465",
        "username": "",
        "password": "",
        "sender": "",
        "receiver": "",
    },
    "bark": {"enabled": False, "device_key": "", "server": "https://api.day.app"},
    "ntfy": {"enabled": False, "topic": "", "server": "https://ntfy.sh"},
}

MAX_LOG_BYTES = 1 * 1024 * 1024  # 单份运行日志最多 1MB，超出轮转
MAX_HISTORY_BYTES = 5 * 1024 * 1024  # 价格历史最多 5MB，超出轮转保留 1 份
TASK_STAGGER_MIN = 10  # 查询组之间错峰（秒）
TASK_STAGGER_MAX = 35
PAIR_STAGGER_MIN = 4  # 同一组（往返）内相邻请求间隔（秒）
PAIR_STAGGER_MAX = 7
ROUND_TRIP_GAP_DAYS = 4  # 同航线相邻日期间隔不超过该天数视为同一组往返（与前端任务列表分组一致）


DEFAULT_CONFIG = {
    "status": "stopped",
    "send_keys": [],
    "polling": {
        "day_min_sec": 90,
        "day_max_sec": 240,
        "night_min_sec": 300,
        "night_max_sec": 600,
    },
    "runtime": {"check_status_interval_sec": 3},
    "monitor_window": {"start": "07:00", "end": "23:00"},
    # 实时查价开关（防风控）：关闭后 daemon 不再请求海航接口
    "price_query": {"enabled": True, "min_interval": 8},
    "alert_cooldown": {
        "hours": 1,  # 价格提醒冷却时间（小时），默认1小时
    },
}

DEFAULT_TASKS = {"tasks": []}


def ensure_file(path: str, default_data: Any) -> None:
    """若文件不存在则创建默认内容。"""
    if os.path.exists(path):
        return

    if path.endswith(".json"):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(default_data, f, ensure_ascii=False, indent=2)
    else:
        with open(path, "w", encoding="utf-8"):
            pass


def read_json(path: str, default_data: Any) -> Any:
    """带锁读取 JSON；读取失败时返回默认值。"""
    ensure_file(path, default_data)

    try:
        with portalocker.Lock(path, mode="a+", timeout=5, encoding="utf-8") as f:
            f.seek(0)
            text = f.read().strip()
            if not text:
                return default_data
            return json.loads(text)
    except Exception:
        return default_data


def append_log(message: str) -> None:
    """追加写运行日志（超 1MB 自动轮转，保留 1 份旧档）。"""
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {message}\n"

    ensure_file(LOG_PATH, "")
    # 单写者（daemon）顺序执行：写前检查体积，超出则轮转。
    try:
        if os.path.getsize(LOG_PATH) >= MAX_LOG_BYTES:
            os.replace(LOG_PATH, LOG_PATH + ".1")
    except OSError:
        pass

    with portalocker.Lock(LOG_PATH, mode="a", timeout=5, encoding="utf-8") as f:
        f.write(line)
        f.flush()


def append_history(record: Dict[str, Any]) -> None:
    """追加写价格历史（JSONL），超 5MB 轮转保留 1 份旧档。"""
    try:
        if os.path.exists(HISTORY_PATH) and os.path.getsize(HISTORY_PATH) >= MAX_HISTORY_BYTES:
            os.replace(HISTORY_PATH, HISTORY_PATH + ".1")
    except OSError:
        pass

    line = json.dumps(record, ensure_ascii=False) + "\n"
    with portalocker.Lock(HISTORY_PATH, mode="a", timeout=5, encoding="utf-8") as f:
        f.write(line)
        f.flush()


def load_config() -> Dict[str, Any]:
    """读取配置并兜底关键字段。"""
    config = read_json(CONFIG_PATH, DEFAULT_CONFIG)
    if not isinstance(config, dict):
        return DEFAULT_CONFIG.copy()

    config.setdefault("status", "stopped")
    config.setdefault("send_keys", [])
    config.setdefault("polling", DEFAULT_CONFIG["polling"])
    config.setdefault("runtime", DEFAULT_CONFIG["runtime"])
    config.setdefault("monitor_window", DEFAULT_CONFIG["monitor_window"])

    if not isinstance(config["send_keys"], list):
        config["send_keys"] = []

    # 实时查价开关（防风控）：关闭后 daemon 本轮不请求海航接口
    config.setdefault("price_query", dict(DEFAULT_CONFIG.get("price_query", {"enabled": True, "min_interval": 8})))
    if not isinstance(config["price_query"], dict):
        config["price_query"] = dict(DEFAULT_CONFIG.get("price_query", {"enabled": True, "min_interval": 8}))
    config["price_query"].setdefault("enabled", True)
    config["price_query"].setdefault("min_interval", 8)

    if not isinstance(config["monitor_window"], dict):
        config["monitor_window"] = dict(DEFAULT_CONFIG["monitor_window"])
    else:
        config["monitor_window"].setdefault("start", DEFAULT_CONFIG["monitor_window"]["start"])
        config["monitor_window"].setdefault("end", DEFAULT_CONFIG["monitor_window"]["end"])

    # 多通道通知：结构兜底（与 app.py 一致）
    nc = config.setdefault("notify_channels", dict(DEFAULT_NOTIFY_CHANNELS))
    if not isinstance(nc, dict):
        nc = dict(DEFAULT_NOTIFY_CHANNELS)
        config["notify_channels"] = nc
    nc.setdefault("urgent_enabled", True)
    for name, default_ch in DEFAULT_NOTIFY_CHANNELS.items():
        if name == "urgent_enabled":
            continue
        ch = nc.setdefault(name, dict(default_ch))
        if not isinstance(ch, dict):
            ch = dict(default_ch)
            nc[name] = ch
        for k, v in default_ch.items():
            ch.setdefault(k, v)
    return config


def load_tasks() -> List[Dict[str, Any]]:
    """读取任务列表。"""
    data = read_json(TASKS_PATH, DEFAULT_TASKS)
    if not isinstance(data, dict):
        return []

    tasks = data.get("tasks", [])
    if not isinstance(tasks, list):
        return []

    result: List[Dict[str, Any]] = []
    for task in tasks:
        if isinstance(task, dict):
            result.append(task)
    return result


def expand_dates(task: Dict[str, Any]) -> List[str]:
    """展开任务监控日期。

    - 新模型：task.dates 为日期列表（同一航线多个监控日期合并，可含不连续日期），直接展开；
    - 旧模型：无 dates 时按 date ~ date_end 之间的每一天（含首尾）展开；
    - 日期无效时原样返回 [date]，交给下游按单日处理。
    """
    dates = task.get("dates")
    if isinstance(dates, list) and dates:
        out: List[str] = []
        for d in dates:
            s = str(d).strip()
            if not s:
                continue
            try:
                datetime.strptime(s, "%Y-%m-%d")
                out.append(s)
            except ValueError:
                continue
        if out:
            disabled = {str(d).strip() for d in (task.get("disabled_dates") or []) if str(d).strip()}
            return [d for d in sorted(set(out)) if d not in disabled]

    start = str(task.get("date", "") or "").strip()
    end = str(task.get("date_end", "") or "").strip() or start
    if not start:
        return []
    try:
        d0 = datetime.strptime(start, "%Y-%m-%d").date()
        d1 = datetime.strptime(end, "%Y-%m-%d").date()
    except ValueError:
        return [start]
    if d1 < d0:
        d0, d1 = d1, d0
    dates: List[str] = []
    cur = d0
    while cur <= d1:
        dates.append(cur.isoformat())
        cur += timedelta(days=1)
    return dates


def _task_codes(task: Dict[str, Any]) -> tuple:
    from_code = str(task.get("from_code", "")).strip().upper()
    to_code = str(task.get("to_code", "")).strip().upper()
    fare_type = str(task.get("fare_type", "normal")).strip().lower()
    if fare_type not in ("normal", "plus"):
        fare_type = "normal"
    return from_code, to_code, fare_type


def _target_price(task: Dict[str, Any]) -> int:
    try:
        return int(task.get("target_price", 199))
    except (TypeError, ValueError):
        return 199


def _day_gap(a: str, b: str) -> int | None:
    try:
        return (datetime.strptime(b, "%Y-%m-%d") - datetime.strptime(a, "%Y-%m-%d")).days
    except ValueError:
        return None


def build_query_units(tasks: List[Dict[str, Any]], today: str | None = None) -> List[List[Dict[str, Any]]]:
    """把任务展开成本轮要发的请求，并按往返分组。

    - 每个请求是一个 (出发, 到达, 日期, 档位)，同一请求只发一次，挂上所有关注它的任务；
    - 早于今天的日期不再查询；
    - 同一航线（不分方向）同档位、相邻日期间隔 ≤ ROUND_TRIP_GAP_DAYS 的请求归为一组，
      组内先去程（组内最早日期的方向）后回程、各自按日期；只有一个方向的组即单程；
    - 组按最早日期排序，近的先查。
    """
    today = today or datetime.now().strftime("%Y-%m-%d")
    requests_by_key: Dict[tuple, Dict[str, Any]] = {}
    for task in tasks:
        from_code, to_code, fare_type = _task_codes(task)
        if not (from_code and to_code):
            continue
        for date in expand_dates(task):
            if _day_gap(today, date) is not None and date < today:
                continue
            key = (from_code, to_code, date, fare_type)
            req = requests_by_key.setdefault(
                key,
                {"from_code": from_code, "to_code": to_code, "date": date, "fare_type": fare_type, "tasks": []},
            )
            if all(t is not task for t in req["tasks"]):
                req["tasks"].append(task)

    routes: Dict[tuple, List[Dict[str, Any]]] = {}
    for req in requests_by_key.values():
        route_key = (tuple(sorted((req["from_code"], req["to_code"]))), req["fare_type"])
        routes.setdefault(route_key, []).append(req)

    units: List[List[Dict[str, Any]]] = []
    for items in routes.values():
        items.sort(key=lambda r: r["date"])
        clusters: List[List[Dict[str, Any]]] = []
        for req in items:
            gap = _day_gap(clusters[-1][-1]["date"], req["date"]) if clusters else None
            if gap is not None and gap <= ROUND_TRIP_GAP_DAYS:
                clusters[-1].append(req)
            else:
                clusters.append([req])
        for cluster in clusters:
            out_dir = (cluster[0]["from_code"], cluster[0]["to_code"])
            cluster.sort(key=lambda r: ((r["from_code"], r["to_code"]) != out_dir, r["date"]))
            units.append(cluster)
    units.sort(key=lambda unit: unit[0]["date"])
    return units


def _companion_text(unit: List[Dict[str, Any]], req: Dict[str, Any], results: Dict[tuple, Dict[str, Any]]) -> str:
    """往返组里命中一段时，描述另一段（最近那天）的查询结果。单程组返回空串。"""
    out_dir = (unit[0]["from_code"], unit[0]["to_code"])
    is_out = (req["from_code"], req["to_code"]) == out_dir
    others = [r for r in unit if ((r["from_code"], r["to_code"]) == out_dir) != is_out]
    if not others:
        return ""
    if is_out:
        later = [r for r in others if r["date"] > req["date"]]
        other = min(later or others, key=lambda r: r["date"])
    else:
        earlier = [r for r in others if r["date"] < req["date"]]
        other = max(earlier or others, key=lambda r: r["date"])
    label = "回程" if is_out else "去程"
    head = (
        f"{label} {other['date'][5:].replace('-', '/')} "
        f"{code_to_city_only(other['from_code'])}→{code_to_city_only(other['to_code'])}"
    )
    result = results.get((other["from_code"], other["to_code"], other["date"]))
    if result is None:
        return f"{head}：本轮未查到结果"
    fares = {str(item.get("flight", "")).strip().upper(): item for item in result.get("fares") or []}
    parts = []
    for task in other["tasks"]:
        flight = str(task.get("flight_no", "") or "").strip().upper()
        if not flight:
            continue
        item = fares.get(flight)
        if not item or not isinstance(item.get("price"), int):
            parts.append(f"{flight} 暂无可兑票")
            continue
        mark = "也达标 ✅" if item["price"] <= _target_price(task) else "未达标"
        parts.append(f"{flight} {item['price']} 元（{_seat_summary(item)}，{mark}）")
    if not parts:
        cheapest = [item["price"] for item in fares.values() if isinstance(item.get("price"), int)]
        parts.append(f"最低 {min(cheapest)} 元" if cheapest else "暂无可兑票")
    return f"{head}：{'；'.join(parts)}"


def sleep_with_status_check(seconds: int, check_interval: int) -> None:
    """分段休眠，便于快速响应 stop。"""
    elapsed = 0
    while elapsed < seconds:
        step = min(max(1, check_interval), seconds - elapsed)
        time.sleep(step)
        elapsed += step

        cfg = load_config()
        if str(cfg.get("status", "stopped")).lower() != "running":
            append_log("检测到状态已停止，提前结束等待。")
            return


def _build_fingerprint(task: Dict[str, Any], flight: str, price: int) -> str:
    """构建去重指纹。"""
    return "|".join(
        [
            str(task.get("id", "")),
            str(task.get("date", "")),
            str(task.get("from_code", "")),
            str(task.get("to_code", "")),
            str(task.get("fare_type", "normal")),
            str(flight),
            str(price),
        ]
    )


def _task_seat_ok(task: Dict[str, Any], item: Dict[str, Any]) -> bool:
    """判断航班是否满足任务的余票/舱位监控条件。

    - min_seats=int(task.min_seats, 默认 1)；min_seats<2 且未指定舱位 → 旧行为（只看价格）；
    - 查询不到余票（seats 缺失）→ True（防漏报，旧行为）；
    - 指定 cabins 白名单时：用白名单舱位余量之和判断 ≥ min_seats；
    - 否则用航班总余票 seats 判断 ≥ min_seats。
    """
    try:
        min_seats = int(task.get("min_seats", 1) or 1)
    except (TypeError, ValueError):
        min_seats = 1
    if min_seats < 1:
        min_seats = 1

    cabin_whitelist = task.get("cabins") or []
    if isinstance(cabin_whitelist, str):
        cabin_whitelist = [c.strip().upper() for c in cabin_whitelist.split(",") if c.strip()]
    else:
        cabin_whitelist = [str(c).strip().upper() for c in cabin_whitelist if str(c).strip()]

    # 旧行为：只关注价格
    if min_seats < 2 and not cabin_whitelist:
        return True

    seats = item.get("seats")
    if seats is None:
        return True  # 解析不到余票时防漏报

    if cabin_whitelist:
        qty = 0
        for c in item.get("cabins") or []:
            code = str(c.get("cabin", "")).strip().upper()
            if code in cabin_whitelist:
                try:
                    qty += int(c.get("qty", 0))
                except (TypeError, ValueError):
                    pass
        return qty >= min_seats

    try:
        return int(seats) >= min_seats
    except (TypeError, ValueError):
        return True


def _seat_summary(item: Dict[str, Any]) -> str:
    """人类可读的余票/舱位摘要，如「余票 12 张（B舱10 · Z舱2）」。"""
    seats = item.get("seats")
    cabins = item.get("cabins") or []
    if seats is None and not cabins:
        return "余票未知"
    if not cabins:
        return f"余票 {seats} 张"
    parts = [f"{c.get('cabin', '?')}舱{c.get('qty', '?')}" for c in cabins]
    return f"余票 {seats} 张（{' · '.join(parts)}）"


def _task_tier_ok(task: Dict[str, Any], item: Dict[str, Any]) -> bool:
    """按任务的档位条件过滤命中（PLUS 专享价监控）。

    语义（与「转监控任务 / 编辑任务」弹窗的档位多选一致，多选=白名单）：
    - task.tiers 为空列表或未设置：不限档位，普通可购价与会员专享价都提醒；
    - task.tiers 非空（白名单）：仅命中档位在白名单内的会员专享价才提醒（精确匹配，
      不再“更高档更不限”）；命中项无会员档（普通可购价）时不提醒，避免提醒买不到的价。
    - 旧任务只有单值 task.tier（兼容，保持旧语义）：tier=666 只提醒 666；
      tier=2666 提醒 666/2666；tier=66666 提醒 666/2666/66666（更高级会员可见更低档专享产品）。
    """
    tiers_cfg = task.get("tiers")
    if isinstance(tiers_cfg, (list, tuple)):
        sel = {int(t) for t in tiers_cfg if str(t).strip() in ("666", "2666", "66666")}
        if not sel:
            return True  # 空=不限
        item_tiers = item.get("tiers") or []
        if not item_tiers:
            return False  # 无会员专享产品（普通可购价）：选了具体档位时不提醒
        return any(int(t) in sel for t in item_tiers if str(t).strip().isdigit())

    # 旧单值兼容
    tier = str(task.get("tier", "") or "").strip()
    if not tier or tier == "all":
        return True
    try:
        limit = int(tier)
    except (TypeError, ValueError):
        return True  # 无法识别的档位值按不限处理，避免漏报
    tiers = item.get("tiers") or []
    if not tiers:
        # 无会员专享产品（普通可购价）：选了具体档位时不提醒，避免买到不上的价格
        return False
    return any(int(t) <= limit for t in tiers)


def _parse_hhmm(value: str, fallback: str) -> dt_time:
    """解析 HH:MM，异常时回退 fallback。"""
    for candidate in (str(value or "").strip(), fallback):
        try:
            return datetime.strptime(candidate, "%H:%M").time()
        except ValueError:
            continue
    return dt_time(hour=7, minute=0)


def _is_in_monitor_window(now_time: dt_time, start_hhmm: str, end_hhmm: str) -> bool:
    """
    判断当前时刻是否位于监控时段。
    - 同日时段：start <= now < end
    - 跨天时段：now >= start 或 now < end
    - start == end：按全天可监控处理，避免误配置导致永久停机
    """
    start_t = _parse_hhmm(start_hhmm, DEFAULT_CONFIG["monitor_window"]["start"])
    end_t = _parse_hhmm(end_hhmm, DEFAULT_CONFIG["monitor_window"]["end"])

    if start_t == end_t:
        return True
    if start_t < end_t:
        return start_t <= now_time < end_t
    return now_time >= start_t or now_time < end_t


def run_one_round(state_mgr: AlertStateManager) -> bool:
    """
    执行一轮抓价与提醒。

    返回：本轮是否取到至少一条价格（用于自适应轮询频率）。
    """
    config = load_config()
    send_keys = config.get("send_keys", [])
    wechat_enabled = bool((config.get("wechat") or {}).get("enabled", True))
    feishu_cfg = config.get("feishu") or {}
    # 多通道通知配置：notify_channels 下各渠道 + 旧 config.feishu（飞书渠道沿用旧配置）
    notify_cfg = dict(config.get("notify_channels") or {})
    notify_cfg.setdefault("urgent_enabled", True)
    notify_cfg["feishu"] = feishu_cfg
    # 防风控总开关：关闭时本轮不请求海航接口（手动查询与监控都停）
    if not (config.get("price_query") or {}).get("enabled", True):
        append_log("实时查价已关闭（防风控），本轮跳过价格查询；可在「监控管理」重新开启。")
        return False
    all_tasks = load_tasks()
    tasks = [task for task in all_tasks if task.get("enabled", True)]
    if not tasks:
        append_log("当前没有监控任务。")
        return False

    append_log(f"开始执行新一轮监控，共 {len(all_tasks)} 条任务（启用 {len(tasks)} 条）。")
    state_mgr.prune_old()

    saw_prices = False
    history_seen: set = set()

    # 先剔除参数不全 / 凭证退避中的任务，其余展开成请求并按往返分组。
    runnable: List[Dict[str, Any]] = []
    for task in tasks:
        from_code, to_code, _ = _task_codes(task)
        if not expand_dates(task):
            append_log(f"任务缺少日期，已跳过：{task}")
            continue
        if not (from_code and to_code):
            append_log(f"任务参数不完整，已跳过：{task}")
            continue
        _, next_ok_ts = state_mgr.get_task_backoff(str(task.get("id", "")))
        if next_ok_ts > time.time():
            remain = int(next_ok_ts - time.time())
            append_log(f"任务 {task.get('flight_no') or task.get('id')} 退避中（剩余约 {remain} 秒），跳过本轮。")
            continue
        runnable.append(task)

    units = build_query_units(runnable)
    if not units:
        append_log("所有监控日期都已过去，本轮没有要查的。")
        return False
    # 组的先后每轮打乱，避免固定顺序被识别；组内仍是先去程后回程。
    random.shuffle(units)
    pushed_count = 0

    for unit_index, unit in enumerate(units):
        if unit_index > 0:
            stagger = random.randint(TASK_STAGGER_MIN, TASK_STAGGER_MAX)
            append_log(f"组间错峰 {stagger} 秒…")
            time.sleep(stagger)

        out_dir = (unit[0]["from_code"], unit[0]["to_code"])
        is_round = any((r["from_code"], r["to_code"]) != out_dir for r in unit)
        span = unit[0]["date"][5:].replace("-", "/")
        last_day = max(r["date"] for r in unit)[5:].replace("-", "/")
        if last_day != span:
            span = f"{span}–{last_day}"
        a_city, b_city = code_to_city_only(out_dir[0]), code_to_city_only(out_dir[1])
        append_log(
            f"{'往返' if is_round else '单程'}组：{a_city}{'↔' if is_round else '→'}{b_city} {span}"
            f"（{len(unit)} 次查询）"
        )

        results: Dict[tuple, Dict[str, Any]] = {}
        hits: List[Dict[str, Any]] = []

        for req_index, req in enumerate(unit):
            if req_index > 0:
                gap = random.randint(PAIR_STAGGER_MIN, PAIR_STAGGER_MAX)
                time.sleep(gap)

            from_code, to_code, date, fare_type = req["from_code"], req["to_code"], req["date"], req["fare_type"]
            fare_label = "PLUS专享" if fare_type == "plus" else "普通票价"
            from_city = code_to_city_only(from_code)
            to_city = code_to_city_only(to_code)
            watched = [str(t.get("flight_no", "") or "").strip().upper() for t in req["tasks"]]
            watched_text = "、".join(f for f in watched if f) or "全部航班"
            targets = sorted({_target_price(t) for t in req["tasks"]})
            leg_label = "" if not is_round else ("去程 " if (from_code, to_code) == out_dir else "回程 ")
            append_log(
                f"查询任务：{leg_label}{date} | {from_city}({from_code})->{to_city}({to_code}) | {fare_label}"
                f" | 监控 {watched_text} | 目标<= {'/'.join(str(t) for t in targets)}"
            )

            try:
                status, fares = fetch_price_status(
                    from_code=from_code,
                    to_code=to_code,
                    date=date,
                    fare_type=fare_type,
                )
            except TokenExpiredError as exc:
                for task in req["tasks"]:
                    state_mgr.mark_task_failure(str(task.get("id", "")))
                reason = str(exc)
                append_log(f"[鉴权失败] {reason}（本轮中止，相关任务进入退避）")

                if state_mgr.should_send_token_alert():
                    if wechat_enabled:
                        send_token_expired_alert(send_keys, reason)
                    else:
                        append_log("微信公众号通知已停用，跳过 Server酱 Token 告警。")
                    # 多通道 critical：强制尝试全部渠道（未配置的渠道也记录失败）
                    notify_channels(
                        cfg=notify_cfg,
                        level="critical",
                        title="🚨 [阻断告警] 海航接口凭证可能已过期",
                        content=(
                            f"原因：{reason}\n\n"
                            "处理建议：\n"
                            "1. 打开控制台 → 票据管理，重新抓取并粘贴查询请求；\n"
                            "2. 保存后无需重启，下一轮监控自动生效。"
                        ),
                        history_path=NOTIFY_HISTORY_PATH,
                    )
                    state_mgr.mark_token_alert()
                    append_log("已发送 Token 过期高优先级告警。")
                else:
                    append_log("Token 告警处于冷却期，跳过重复推送。")
                return saw_prices

            if status == "network":
                append_log("请求失败（网络不通 / 网关错误 / 429 限流），本轮跳过。")
                continue
            if status == "parse":
                append_log("接口返回结构异常（非 JSON 或字段变化），本轮跳过。")
                continue
            if isinstance(status, str) and status.startswith("rejected:"):
                reason = status.split(":", 1)[1].strip() or "未说明原因"
                append_log(f"接口业务拒绝（rejected）：{reason}。不是无可用航班。")
                continue
            results[(from_code, to_code, date)] = {"fares": fares or []}
            if not fares:
                append_log("接口正常返回但无可用航班（无票或价格不可购）。")
                continue

            saw_prices = True
            for task in req["tasks"]:
                state_mgr.mark_task_success(str(task.get("id", "")))

            by_flight = {str(item.get("flight", "UNKNOWN")).strip().upper(): item for item in fares}
            for item in fares:
                price = item.get("price")
                if not isinstance(price, int):
                    continue
                flight = str(item.get("flight", "UNKNOWN"))
                history_key = f"{from_code}|{to_code}|{date}|{flight}"
                if history_key in history_seen:
                    continue
                history_seen.add(history_key)
                owner = next(
                    (t for t in req["tasks"] if str(t.get("flight_no", "") or "").strip().upper() == flight.strip().upper()),
                    None,
                )
                history_record = {
                    "ts": datetime.now().isoformat(timespec="seconds"),
                    "task_id": str(owner.get("id", "")) if owner else "",
                    "date": date,
                    "from": from_code,
                    "to": to_code,
                    "fare_type": fare_type,
                    "flight": flight,
                    "price": price,
                    # 档位（会员专享产品 666/2666/66666…；普通可购价无 tiers 字段）
                    "tiers": item.get("tiers") or [],
                    # 起降时刻：优先实时接口带出的 times，其次任务快照（旧记录可能都没有）
                    "dep_time": (item.get("times") or {}).get("dep") or str((owner or {}).get("dep_time", "") or "").strip(),
                    "arr_time": (item.get("times") or {}).get("arr") or str((owner or {}).get("arr_time", "") or "").strip(),
                }
                if item.get("seats") is not None:
                    history_record["seats"] = item.get("seats")
                    history_record["cabins"] = item.get("cabins") or []
                append_history(history_record)

            for task in req["tasks"]:
                task_flight = str(task.get("flight_no", "") or "").strip().upper()
                target_price = _target_price(task)
                if task_flight:
                    matched = [by_flight[task_flight]] if task_flight in by_flight else []
                else:
                    matched = list(fares)
                if task_flight and not matched:
                    others = [
                        f"{str(i.get('flight', '?'))} {i.get('price')} 元"
                        for i in fares
                        if isinstance(i.get("price"), int)
                    ]
                    append_log(f"{task_flight} 本次未返回（暂无可兑票）" + (f"；同日其他：{'、'.join(others)}" if others else ""))
                    continue
                for item in matched:
                    price = item.get("price")
                    if not isinstance(price, int):
                        continue
                    flight = str(item.get("flight", "UNKNOWN"))
                    append_log(f"{flight} | {price} 元 | {_seat_summary(item)}")
                    if price <= target_price and _task_seat_ok(task, item) and _task_tier_ok(task, item):
                        hits.append({"req": req, "task": task, "item": item, "flight": flight, "price": price,
                                     "target_price": target_price, "fare_label": fare_label})

        # 一组查完再发提醒：往返组的提醒里带上另一段同一时刻的价格。
        for hit in hits:
            req, task, item = hit["req"], hit["task"], hit["item"]
            flight, price, target_price = hit["flight"], hit["price"], hit["target_price"]
            from_code, to_code, date = req["from_code"], req["to_code"], req["date"]
            from_city, to_city = code_to_city_only(from_code), code_to_city_only(to_code)
            # 提醒用“命中当天”的任务视图：正文显示具体日期，指纹含日期可避免区间内重复推送。
            alert_task = dict(task)
            alert_task["date"] = date
            alert_task["date_end"] = str(task.get("date_end", "") or "")
            fingerprint = _build_fingerprint(alert_task, flight, price)
            if not state_mgr.should_alert(fingerprint):
                continue
            companion = _companion_text(unit, req, results)
            seat_text = _seat_summary(item)
            # 保留 Server酱（向后兼容；公众号开关关闭时跳过）
            if wechat_enabled:
                send_price_alert(send_keys, alert_task, flight, price, tiers=item.get("tiers"), extra=companion)
            else:
                append_log("微信公众号通知已停用，跳过 Server酱低价提醒。")
            # 多通道通知：飞书交互卡片（确认/忽略回调）+ 企微/钉钉/Bark/ntfy
            cabin_extra = ""
            cabin_raw = task.get("cabins")
            if isinstance(cabin_raw, (list, tuple)):
                cabin_list = [str(c).strip().upper() for c in cabin_raw if str(c).strip()]
            elif isinstance(cabin_raw, str):
                cabin_list = [c.strip().upper() for c in cabin_raw.split(",") if c.strip()]
            else:
                cabin_list = []
            if cabin_list:
                cabin_extra = f"，舱位条件：{'、'.join(cabin_list)}"
            alert_title = f"🎉 {from_city}→{to_city} {price} 元"
            alert_content = (
                f"航班：{flight}\n"
                f"日期：{date}\n"
                f"航线：{from_city}({from_code}) → {to_city}({to_code})\n"
                f"类型：{hit['fare_label']}（目标 ≤ {target_price} 元，已达标 ✅）\n"
                f"档位：{tier_text(item.get('tiers'))}\n"
                f"价格：{price} 元\n"
                f"余票：{seat_text}{cabin_extra}"
                + (f"\n{companion}" if companion else "")
                + "\n"
                + hna_jump_block(from_code, to_code, date, flight)
            )
            card = build_confirm_card(
                alert_title, alert_content, callback_key="price_alert", action_value=fingerprint
            )
            notify_results = notify_channels(
                cfg=notify_cfg,
                level="important",
                title=alert_title,
                content=alert_content,
                card=card,
                history_path=NOTIFY_HISTORY_PATH,
            )
            # 登记飞书卡片原文：用户点「确认已处理/忽略」时回调能更新卡片并记录回执
            feishu_entry = notify_results.get("feishu") or {}
            if feishu_entry.get("message_id"):
                feishu_ws.record_sent_card(feishu_entry["message_id"], card)
            state_mgr.mark_alert(fingerprint)
            pushed_count += 1

    if pushed_count > 0:
        append_log(f"已发送 {pushed_count} 条低价提醒。")

    return saw_prices


def main() -> None:
    """daemon 主循环。"""
    ensure_file(CONFIG_PATH, DEFAULT_CONFIG)
    ensure_file(TASKS_PATH, DEFAULT_TASKS)
    ensure_file(LOG_PATH, "")
    ensure_file(STATE_PATH, {"price_alerts": {}, "token_alert": {"last_ts": 0}})

    # 读取配置中的冷却时间
    config = load_config()
    alert_cooldown_hours = int(config.get("alert_cooldown", {}).get("hours", 1))
    window_seconds = alert_cooldown_hours * 3600

    state_mgr = AlertStateManager(state_path=STATE_PATH, window_seconds=window_seconds)
    append_log(f"状态管理器已初始化，价格提醒冷却期：{alert_cooldown_hours}小时")

    append_log("daemon 已启动。")
    monitor_window_active: bool | None = None

    while True:
        config = load_config()
        status = str(config.get("status", "stopped")).lower()
        check_interval = int(config.get("runtime", {}).get("check_status_interval_sec", 3))
        if check_interval <= 0:
            check_interval = 3

        if status != "running":
            monitor_window_active = None
            time.sleep(check_interval)
            continue

        window_cfg = config.get("monitor_window", DEFAULT_CONFIG["monitor_window"])
        start_hhmm = str(window_cfg.get("start", DEFAULT_CONFIG["monitor_window"]["start"]))
        end_hhmm = str(window_cfg.get("end", DEFAULT_CONFIG["monitor_window"]["end"]))
        now_time = datetime.now().time()
        in_window = _is_in_monitor_window(now_time=now_time, start_hhmm=start_hhmm, end_hhmm=end_hhmm)

        if not in_window:
            if monitor_window_active is not False:
                append_log(f"当前不在监控时段（{start_hhmm}-{end_hhmm}），daemon 待机中。")
            monitor_window_active = False
            time.sleep(check_interval)
            continue

        if monitor_window_active is not True:
            append_log(f"进入监控时段（{start_hhmm}-{end_hhmm}），开始执行监控。")
        monitor_window_active = True

        saw_prices = run_one_round(state_mgr)

        polling_cfg = config.get("polling", DEFAULT_CONFIG["polling"]) or {}
        day_min = int(polling_cfg.get("day_min_sec", 90))
        night_max = int(polling_cfg.get("night_max_sec", 600))
        wait_seconds = get_next_interval_seconds(polling=polling_cfg)
        if saw_prices:
            # 有价：加密轮询，但不低于日间隔下限。
            wait_seconds = max(int(wait_seconds / 2), day_min)
            append_log(f"本轮有价格数据，下一轮间隔缩短至 {wait_seconds} 秒。")
        else:
            # 无价：拉长轮询，减少无效请求，封顶夜间上限的 2 倍。
            wait_seconds = min(int(wait_seconds * 1.5), night_max * 2)
            append_log(f"本轮无价格数据，下一轮间隔拉长至 {wait_seconds} 秒。")
        sleep_with_status_check(wait_seconds, check_interval)


if __name__ == "__main__":
    main()
