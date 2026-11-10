import React, { useEffect, useRef, useState } from 'react'
import {
  Alert, Button, Card, Col, Empty, Form, Input, Popconfirm, Popover,
  Row, Space, Steps, Switch, Table, Tag, Tooltip, Typography,
} from 'antd'
import {
  CloseIcon, DeleteIcon, HistoryIcon, NotifyIcon, QuestionIcon, SendIcon, SettingsIcon,
} from '../icons.jsx'
import { api, formatTs } from '../api.js'

function wsStateTag(ws) {
  if (!ws) return <Tag color="orange">未知</Tag>
  const map = {
    connected: { color: 'green', text: '已连接' },
    connecting: { color: 'blue', text: '连接中' },
    reconnecting: { color: 'blue', text: '重连中' },
    failed: { color: 'red', text: '失败' },
    not_configured: { color: 'orange', text: '未配置' },
    stopped: { color: 'default', text: '已停止' },
  }
  const m = map[ws.state] || { color: 'default', text: ws.state || '未知' }
  return <Tag color={m.color}>{m.text}</Tag>
}

function channelStatusTag(enabled) {
  return enabled ? <Tag color="green">已启用</Tag> : <Tag color="orange">未启用</Tag>
}

/* 教学问号支持鼠标悬停、键盘聚焦与点击展开。 */
function GuideIcon({ title, steps }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger={['hover', 'click']}
      placement="bottomLeft"
      content={
        <div style={{ width: 360 }}>
          <Space style={{ marginBottom: 8, width: '100%', justifyContent: 'space-between' }}>
            <Typography.Text strong>{title}</Typography.Text>
            <Button size="small" type="text" icon={<CloseIcon />} aria-label="关闭配置说明" onClick={() => setOpen(false)}>关闭</Button>
          </Space>
          <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9, maxHeight: 320, overflow: 'auto' }}>
            {steps.map((s, i) => (
              <li key={i}>
                <span style={{ fontWeight: 600 }}>{s.title}</span>
                {s.description ? `：${s.description}` : ''}
              </li>
            ))}
          </ol>
        </div>
      }
    >
      <Button
        type="text"
        size="small"
        className="guide-button"
        icon={<QuestionIcon size={14} />}
        aria-label={`查看${title}`}
        aria-expanded={open}
      />
    </Popover>
  )
}

function ChannelCard({
  name, title, color, guide, view, fields = [], busy, msg, onSave, onTest,
  showSwitch = true, statusLine, testResult, onClearTest, children,
  configured = true, // 未配置时右上角开关禁用（防止开启一个没法用的渠道）
}) {
  const [form] = Form.useForm()
  const [editing, setEditing] = useState(false)
  const enabled = !!view?.enabled

  // 测试结果自动消失：成功 5 秒、失败 10 秒后关闭，避免常驻遮住卡片操作。
  // 用 ref 持有最新 onClearTest，避免轮询刷新导致父组件重建回调而重置计时器。
  const onClearRef = useRef(onClearTest)
  onClearRef.current = onClearTest
  useEffect(() => {
    if (!testResult) return undefined
    const timer = setTimeout(() => onClearRef.current(), testResult.ok ? 5000 : 10000)
    return () => clearTimeout(timer)
  }, [testResult])

  const save = async () => {
    const vals = form.getFieldsValue() || {}
    const payload = {}
    // 只提交真正修改过的字段：与脱敏展示值相同的（未动的掩码预填）视为「不修改」，
    // 避免把掩码值写回真实凭证；秘密字段留空由后端保持原值。
    for (const f of fields) {
      const v = String(vals[f.key] ?? '').trim()
      const cur = String(view?.[f.key] ?? '')
      if (v === cur) continue
      payload[f.key] = v
    }
    try {
      if (Object.keys(payload).length) await onSave({ [name]: { ...payload } })
      msg.success('配置已保存')
      setEditing(false)
      form.resetFields()
    } catch (e) { msg.error(e.message) }
  }

  const toggle = async (v) => {
    try {
      await onSave({ [name]: { enabled: v } })
      msg.success(v ? `${title} 已启用` : `${title} 已停用`)
    } catch (e) { msg.error(e.message) }
  }

  const summary = fields.some((f) => view?.[f.key])
    ? `已配置：${fields.filter((f) => view?.[f.key]).map((f.label ? (f) => `${f.label} ${view[f.key]}` : (f) => `${f.label} ${view[f.key]}`)).join('；')}`
    : ''

  return (
    <Col xs={24} sm={12} xl={8}>
      <Card
        size="small"
        className={`channel-card ${configured ? 'is-configured' : 'is-idle'}`}
        style={{ height: '100%' }}
        title={
          <Space size={6} wrap>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: color, display: 'inline-block' }} />
            {title}
            {guide && <GuideIcon title={guide.title} steps={guide.steps} />}
          </Space>
        }
        extra={showSwitch && <Switch size="small" checked={configured ? enabled : false} disabled={!configured} loading={busy === 'notify-save'} onChange={toggle} />}
      >
        {/* 状态/配置信息行：所有卡片统一在最上方一行（12px 小字） */}
        <div className="channel-status">
          {statusLine || (editing ? null : <Space size={6}>{channelStatusTag(enabled)}{summary && <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '20px' }} ellipsis={{ tooltip: summary }}>{summary}</Typography.Text>}</Space>)}
        </div>

        {/* 中间内容：操作按钮或编辑表单（children 模式给微信/飞书用） */}
        {children
          ? children({ form, editing, setEditing, enabled })
          : !editing && (
            <Space wrap>
              <Button size="small" icon={<SendIcon />} loading={busy === `test-${name}`} onClick={onTest}>
                发送测试消息
              </Button>
              <Button size="small" icon={<SettingsIcon />} onClick={() => { form.setFieldsValue({ ...view }); setEditing(true) }}>
                配置
              </Button>
            </Space>
          )}

        {!children && editing && (
          <Form form={form} layout="vertical" size="small">
            {fields.map((f) => (
              <Form.Item key={f.key} name={f.key} label={
                <span>{f.label}{f.keepEmpty && <Typography.Text type="secondary" style={{ fontSize: 12 }}>（留空不修改）</Typography.Text>}</span>
              } style={{ marginBottom: 6 }}>
                {f.secret ? (
                  <Input.Password placeholder={f.placeholder || '已配置可留空不修改'} autoComplete="new-password" />
                ) : (
                  <Input placeholder={f.placeholder} />
                )}
              </Form.Item>
            ))}
            <Space>
              <Button type="primary" size="small" loading={busy === 'notify-save'} onClick={save}>保存</Button>
              <Button size="small" onClick={() => { setEditing(false); form.resetFields() }}>取消</Button>
            </Space>
          </Form>
        )}

        {/* 测试结果：统一固定在卡片底部区域，无提示时占位保持高度一致 */}
        <div className="channel-result">
          {testResult && (
            <Alert
              type={testResult.ok ? 'success' : 'error'}
              showIcon
              message={
                <Typography.Text
                  style={{ fontSize: 12, lineHeight: '20px', display: 'block' }}
                  ellipsis={{ tooltip: testResult.text }}
                >
                  {testResult.text}
                </Typography.Text>
              }
              action={
                <Button type="text" size="small" icon={<CloseIcon />} aria-label="关闭测试结果" onClick={onClearTest} />
              }
            />
          )}
        </div>
      </Card>
    </Col>
  )
}

export default function Notifications({ data, onChanged, msg }) {
  const cfg = data.config
  const feishu = cfg.feishu || {}
  const nch = cfg.notify_channels || {}
  const ws = nch.feishu_ws || {}
  const historyRows = [...(data.notification_history || [])].reverse()
  const confirms = data.card_confirmations || []
  const [fsForm] = Form.useForm()
  const [keysRaw, setKeysRaw] = useState('')
  const [busy, setBusy] = useState('')
  const [showWechatForm, setShowWechatForm] = useState(false)
  const [showFeishuForm, setShowFeishuForm] = useState(false)
  // 每张渠道卡片自持测试结果，互不串扰（不再用全局 testMsg）
  const [tests, setTests] = useState({})
  const setTest = (channel, ok, text) => setTests((prev) => ({ ...prev, [channel]: { ok, text } }))
  const clearTest = (channel) => setTests((prev) => {
    const next = { ...prev }
    delete next[channel]
    return next
  })

  const saveKeys = async () => {
    setBusy('keys')
    try {
      await api.saveSendKeys(keysRaw)
      msg.success('SendKey 已保存，daemon 下一轮生效')
      setKeysRaw('')
      setTest('wechat', true, 'SendKey 已保存，可发送测试消息验证')
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const testAlert = async () => {
    const keys = keysRaw.split('\n').map((s) => s.trim()).filter(Boolean)
    if (keys.length === 0 && cfg.send_keys_count === 0) {
      msg.error('请先填写至少 1 个 SendKey')
      return
    }
    setBusy('test')
    try {
      const r = await api.testAlert(keys.length ? keys : undefined)
      if (r.success > 0) {
        setTest('wechat', true, `测试消息发送完成：成功 ${r.success} / 总计 ${r.total}`)
        msg.success(`测试消息：成功 ${r.success} / ${r.total}`)
      } else {
        setTest('wechat', false, '测试消息发送失败，请检查 SendKey 是否正确')
        msg.error('测试消息发送失败')
      }
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const saveFeishu = async () => {
    const values = fsForm.getFieldsValue()
    setBusy('feishu-save')
    try {
      const r = await api.saveFeishu({
        app_id: values.app_id || '',
        app_secret: values.app_secret || '',
        receiver: values.receiver || '',
      })
      msg.success(r.message || '飞书配置已保存')
      fsForm.resetFields()
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const sendTestFeishu = async () => {
    const values = fsForm.getFieldsValue()
    setBusy('feishu-test')
    try {
      const r = await api.testFeishu({
        app_id: values.app_id || '',
        app_secret: values.app_secret || '',
        receiver: values.receiver || '',
      })
      if (r.success) {
        msg.success('测试卡片已发送，请到飞书点击按钮验证确认回执')
        setTest('feishu', true, '测试卡片已发送，请到飞书点击按钮验证确认回执')
      } else {
        msg.error(r.error || '测试消息发送失败')
        setTest('feishu', false, `发送失败：${r.error || '未知错误'}`)
      }
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const saveNotify = async (payload) => {
    setBusy('notify-save')
    try {
      await api.saveNotifyChannels(payload)
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const testChannel = async (channel, label) => {
    setBusy(`test-${channel}`)
    try {
      const r = await api.testNotifyChannel(channel)
      if (r.success) {
        msg.success(`${label} 测试消息已发送${channel === 'feishu' ? '，可在飞书点击卡片按钮验证确认回执' : ''}`)
        setTest(channel, true, r.message_id ? `${label}：${r.message}（${r.message_id}）` : `${label}：${r.message || '已发送'}`)
        onChanged()
      } else {
        msg.error(r.error || `${label} 测试发送失败`)
        setTest(channel, false, `${label}：${r.error || '发送失败'}`)
      }
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  /* 每张渠道卡片标题旁「?」的配置教学步骤（hover 查看，可关闭） */
  const guides = {
    wechat: {
      title: '微信推送（Server酱）配置步骤',
      steps: [
        { title: '打开 Server酱官网', description: '浏览器访问 sct.ftqq.com，用微信扫码登录' },
        { title: '复制 SendKey', description: '在「SendKey」页复制 SCT 开头的一串字符' },
        { title: '粘贴到输入框', description: '支持每行一个，多个微信号可各配一个' },
        { title: '保存并验证', description: '点击「保存并验证」' },
        { title: '发送测试消息', description: '微信收到即绑定成功，后续低价与告警自动推送' },
      ],
    },
    feishu: {
      title: '飞书机器人 + 加急卡片确认配置步骤',
      steps: [
        { title: '创建企业自建应用', description: '登录 open.feishu.cn 开发者后台 → 创建企业自建应用' },
        { title: '添加机器人能力', description: '应用功能 → 机器人 → 启用' },
        { title: '开通权限并发布', description: '权限管理开通 im:message:send_as_bot、im:message:urgent_app 等，发布版本并等待审核通过' },
        { title: '事件订阅选长连接', description: '事件与回调 → 长连接模式，无需公网回调地址' },
        { title: '复制凭证', description: '「凭证与基础信息」中复制 App ID / App Secret；接收人填你的飞书邮箱或 ou_ 开头的 OpenID' },
        { title: '保存并测试', description: '填入表单保存；「发送测试消息」默认发确认卡片，到飞书点按钮验证回执' },
      ],
    },
    wecom: {
      title: '企业微信（自建应用）配置步骤',
      steps: [
        { title: '创建自建应用', description: '登录 work.weixin.qq.com 管理后台 → 应用管理 → 自建 → 创建应用' },
        { title: '获取企业ID', description: '「我的企业」→ 企业信息 → 企业ID（corp_id，ww 开头）' },
        { title: '获取 AgentId 与 Secret', description: '进入自建应用详情页：AgentId 直接可见，点「查看」获取 Secret' },
        { title: '填写接收人 UserID', description: '通讯录中成员的 UserID（如 ZhangSan），需在应用可见范围内' },
        { title: '保存并发送测试', description: '保存后点「发送测试消息」，企业微信收到即成功' },
      ],
    },
    dingtalk: {
      title: '钉钉群机器人配置步骤',
      steps: [
        { title: '添加自定义机器人', description: '打开目标钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义' },
        { title: '复制 Webhook', description: '添加完成后复制 Webhook 地址（含 access_token）' },
        { title: '安全设置：加签（可选）', description: '若开启加签，复制密钥填入「加签密钥」' },
        { title: '保存并发送测试', description: '保存后点「发送测试消息」，群内收到即成功' },
      ],
    },
    bark: {
      title: 'iOS · Bark 配置步骤',
      steps: [
        { title: '安装 Bark', description: 'App Store 搜索 Bark 安装并打开' },
        { title: '复制设备 Key', description: 'App 首页即为设备 Key（形如 https://api.day.app/XXXXXXXX）' },
        { title: '自建服务器（可选）', description: '使用自建 Bark 服务时填入 server 地址，默认 https://api.day.app' },
        { title: '保存并发送测试', description: '保存后点「发送测试消息」，手机收到即成功' },
      ],
    },
    ntfy: {
      title: '安卓 · ntfy 配置步骤',
      steps: [
        { title: '订阅主题', description: '安装 ntfy 客户端，订阅一个自定义主题名' },
        { title: '填写主题与服务器', description: 'Topic 填订阅的主题名；server 默认 https://ntfy.sh，自建可改' },
        { title: '保存并发送测试', description: '保存后点「发送测试消息」，手机收到即成功' },
      ],
    },
    wechat_bot: {
      title: '企业微信机器人配置步骤',
      steps: [
        { title: '这是个人提醒', description: '消息发到接收人的单聊，不发群' },
        { title: '填写机器人 ID 和 Secret', description: '机器人 ID 是 Bot ID。Secret 是调用密钥，和 WECOM_BOT_SECRET 是同一个' },
        { title: '填写接收人', description: '填自己的英文名，例如 kaijundeng' },
        { title: '先跟机器人说过话', description: '接收人需要先在单聊里给机器人发过消息，它才能主动推送' },
        { title: '保存并发送测试', description: '保存后打开开关，点「发送测试消息」。单聊收到即成功' },
      ],
    },
    email: {
      title: '邮件提醒配置步骤',
      steps: [
        { title: '打开邮箱 SMTP', description: '在邮箱设置里开启 SMTP，并生成授权码。填授权码，不要填登录密码' },
        { title: '填写服务器', description: 'QQ 邮箱 smtp.qq.com 端口 465；163 邮箱 smtp.163.com 端口 465' },
        { title: '填写收发地址', description: '登录账号可以只填邮箱名。发件人填完整邮箱。收件人可填多个，用逗号分开' },
        { title: '保存并发送测试', description: '保存后点「发送测试消息」，收件箱收到即成功' },
      ],
    },
  }

  const channelCards = [
    {
      name: 'wechat', title: '微信公众号（『方糖』服务号）', color: '#07c160',
      view: cfg.wechat || {}, showSwitch: true, configured: cfg.send_keys_count > 0,
      guide: guides.wechat,
      statusLine: (
        <Space size={6}>
          <Tag color={cfg.send_keys_count > 0 ? 'green' : 'orange'}>
            {cfg.send_keys_count > 0 ? `已绑定 ${cfg.send_keys_count} 个` : '未配置'}
          </Tag>
        </Space>
      ),
      children: () => (
        <>
          {cfg.send_keys_count > 0 && !showWechatForm ? (
            <Space wrap>
              <Button size="small" icon={<SendIcon />} loading={busy === 'test'} onClick={testAlert}>发送测试消息</Button>
              <Button size="small" icon={<SettingsIcon />} onClick={() => setShowWechatForm(true)}>重新配置</Button>
            </Space>
          ) : (
            <>
              {cfg.send_keys_count === 0 && (
                <Steps
                  direction="vertical"
                  size="small"
                  current={5}
                  items={guides.wechat.steps}
                  style={{ marginBottom: 10 }}
                />
              )}
              <Input.TextArea
                rows={3}
                placeholder="每行粘贴一个 SendKey，例如 SCT123..."
                value={keysRaw}
                onChange={(e) => setKeysRaw(e.target.value)}
                style={{ fontSize: 12 }}
              />
              <Space wrap style={{ marginTop: 8 }}>
                <Button type="primary" size="small" icon={<SendIcon />} loading={busy === 'keys'} onClick={saveKeys}>保存并验证</Button>
                <Button size="small" icon={<SendIcon />} loading={busy === 'test'} onClick={testAlert}>发送测试消息</Button>
                {cfg.send_keys_count > 0 && (
                  <Button size="small" onClick={() => { setShowWechatForm(false); setKeysRaw('') }}>收起</Button>
                )}
              </Space>
            </>
          )}
        </>
      ),
    },
    {
      name: 'wechat_bot', title: '企业微信机器人', color: '#1aad19',
      view: nch.wechat_bot || {}, guide: guides.wechat_bot,
      configured: !!(nch.wechat_bot?.bot_id && nch.wechat_bot?.secret && nch.wechat_bot?.chat_id),
      fields: [
        { key: 'bot_id', label: '机器人 ID', placeholder: '智能机器人的 Bot ID', keepEmpty: true, secret: true },
        { key: 'secret', label: 'Secret', placeholder: '调用密钥，留空不修改', keepEmpty: true, secret: true },
        { key: 'chat_id', label: '接收人', placeholder: '个人英文名，例如 kaijundeng。只发单聊' },
      ],
    },
    {
      name: 'email', title: '邮件', color: '#d48806',
      view: nch.email || {}, guide: guides.email,
      configured: !!(nch.email?.host && nch.email?.password && nch.email?.receiver && (nch.email?.sender || nch.email?.username)),
      fields: [
        { key: 'host', label: 'SMTP 服务器', placeholder: '如 smtp.qq.com' },
        { key: 'port', label: '端口', placeholder: '465' },
        { key: 'username', label: '登录账号', placeholder: 'SMTP 登录名，如 kedreamix' },
        { key: 'password', label: '授权码', keepEmpty: true, secret: true },
        { key: 'sender', label: '发件人', placeholder: '完整邮箱，如 name@qq.com' },
        { key: 'receiver', label: '收件人', placeholder: '多个地址用逗号分开' },
      ],
    },
    {
      name: 'feishu', title: '飞书', color: '#3370ff',
      view: feishu, showSwitch: true, configured: !!feishu.configured,
      guide: guides.feishu,
      statusLine: (
        <Space size={6}>
          {feishu.configured ? (
            <Tooltip title={
              <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                <div>App ID：{feishu.app_id}</div>
                <div>接收人：{feishu.receiver || '—'}</div>
                <div>App Secret 已设置（不回显）</div>
                <div>长连接事件 {ws.event_count || 0} 次{ws.last_event_ts ? `，最近 ${formatTs(ws.last_event_ts)}` : ''}</div>
              </div>
            }>
              <Tag color="green" style={{ cursor: 'help' }}>已配置</Tag>
            </Tooltip>
          ) : feishu.has_secret ? (
            <Tag color="orange">配置不完整</Tag>
          ) : (
            <Tag color="orange">未配置</Tag>
          )}
          {wsStateTag(ws)}
        </Space>
      ),
      children: () => (feishu.configured && !showFeishuForm ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <Space wrap>
            <Button size="small" icon={<SendIcon />} loading={busy === 'test-feishu'} onClick={() => testChannel('feishu', '飞书')}>发送测试消息</Button>
            <Button size="small" icon={<SettingsIcon />} onClick={() => setShowFeishuForm(true)}>重新配置</Button>
          </Space>
          <Space size={4}>
            <Tooltip title="低价提醒默认应用内加急（免费）；关闭后仅普通推送">
              <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>默认加急</Typography.Text>
            </Tooltip>
            <Switch size="small" checked={!!feishu.urgent_enabled} loading={busy === 'notify-save'} onChange={(v) => saveNotify({ feishu: { urgent_enabled: v } })} />
          </Space>
        </div>
      ) : (
        <>
          {!feishu.configured && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 8, fontSize: 12 }}
              message={
                <span style={{ fontSize: 12 }}>
                  首次使用按标题旁「<QuestionIcon size={12} style={{ verticalAlign: -2 }} />」完成开放平台建应用/加机器人/权限/长连接；完整图文
                  <Typography.Text code>docs/notify_channels_guide.md</Typography.Text>。
                </span>
              }
            />
          )}
          <Form form={fsForm} layout="vertical" size="small">
            <Form.Item name="app_id" label="App ID" style={{ marginBottom: 6 }}>
              <Input placeholder="cli_ 开头；已配置可留空不修改" style={{ fontSize: 12 }} />
            </Form.Item>
            <Form.Item name="app_secret" label="App Secret" style={{ marginBottom: 6 }}>
              <Input.Password placeholder="已配置可留空不修改（不会回显）" autoComplete="new-password" style={{ fontSize: 12 }} />
            </Form.Item>
            <Form.Item name="receiver" label="接收人" style={{ marginBottom: 6 }}>
              <Input placeholder="你的飞书邮箱，或 ou_ 开头的 OpenID" style={{ fontSize: 12 }} />
            </Form.Item>
          </Form>
          <Space wrap>
            <Button type="primary" size="small" loading={busy === 'feishu-save'} onClick={saveFeishu} icon={<SendIcon />}>保存配置</Button>
            <Button size="small" icon={<SendIcon />} loading={busy === 'feishu-test'} onClick={sendTestFeishu}>发送测试消息</Button>
            {feishu.configured && (
              <Button size="small" onClick={() => { setShowFeishuForm(false); fsForm.resetFields() }}>收起</Button>
            )}
          </Space>
        </>
      )),
    },
    {
      name: 'wecom', title: '企业微信', color: '#0082ef',
      view: nch.wecom || {}, guide: guides.wecom,
      configured: !!(nch.wecom?.corp_id && nch.wecom?.agent_id && nch.wecom?.user_id && nch.wecom?.secret),
      fields: [
        { key: 'corp_id', label: '企业ID', placeholder: 'ww 开头', secret: true },
        { key: 'agent_id', label: '应用 AgentId', secret: true },
        { key: 'secret', label: '应用 Secret', keepEmpty: true, secret: true },
        { key: 'user_id', label: '成员 UserID', placeholder: '接收人，如 ZhangSan', secret: true },
      ],
    },
    {
      name: 'dingtalk', title: '钉钉', color: '#2a9df4',
      view: nch.dingtalk || {}, guide: guides.dingtalk, configured: !!nch.dingtalk?.webhook,
      fields: [
        { key: 'webhook', label: 'Webhook 地址', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...', secret: false },
        { key: 'secret', label: '加签密钥（可选）', keepEmpty: true, secret: true },
      ],
    },
    {
      name: 'bark', title: 'iOS · Bark', color: '#f3a933',
      view: nch.bark || {}, guide: guides.bark, configured: !!nch.bark?.device_key,
      fields: [
        { key: 'device_key', label: '设备 Key', keepEmpty: true, secret: true },
        { key: 'server', label: '服务地址', placeholder: '默认 https://api.day.app，自建可改' },
      ],
    },
    {
      name: 'ntfy', title: '安卓 · ntfy', color: '#17b26a',
      view: nch.ntfy || {}, guide: guides.ntfy, configured: !!nch.ntfy?.topic,
      fields: [
        { key: 'topic', label: '主题 Topic', keepEmpty: true, secret: true },
        { key: 'server', label: '服务器地址', placeholder: '默认 https://ntfy.sh，自建可改' },
      ],
    },
  ]

  const historyColumns = [
    { title: '时间', dataIndex: 'ts', width: 160, render: (v) => formatTs(v) },
    { title: '渠道', dataIndex: 'channel_label', width: 110 },
    { title: '级别', dataIndex: 'level', width: 90, render: (v) => (v === 'critical' ? <Tag color="red">加急/阻断</Tag> : v === 'important' ? <Tag color="blue">重要</Tag> : <Tag>{v}</Tag>) },
    { title: '标题', dataIndex: 'title', ellipsis: true },
    { title: '结果', dataIndex: 'ok', width: 90, render: (v) => (v ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>) },
    { title: '说明/错误', dataIndex: 'error', ellipsis: true, render: (v) => (v ? <Typography.Text type="danger" style={{ fontSize: 12 }}>{v}</Typography.Text> : <Typography.Text type="secondary" style={{ fontSize: 12 }}>—</Typography.Text>) },
  ]

  const confirmColumns = [
    { title: '时间', dataIndex: 'ts', width: 160, render: (v) => formatTs(v) },
    { title: '操作人', dataIndex: 'operator', width: 120 },
    { title: '操作', dataIndex: 'confirmed', width: 100, render: (v) => (v ? <Tag color="green">确认已处理</Tag> : <Tag>忽略</Tag>) },
    { title: '消息', dataIndex: 'message_id', ellipsis: true, render: (v) => <span className="mono" style={{ fontSize: 12 }}>{v}</span> },
    { title: '说明', dataIndex: 'note', ellipsis: true, render: (v) => v || '—' },
  ]

  return (
    <div>
      {/* 通知渠道：卡片统一样式，标题旁「?」为配置教学 */}
      <Card
        style={{ marginBottom: 16 }}
        title={<Space><NotifyIcon style={{ color: 'var(--color-primary)' }} />通知渠道</Space>}
      >
        <Row gutter={[16, 16]} align="stretch">
          {channelCards.slice().sort((a, b) => Number(b.configured) - Number(a.configured)).map((c) => (
            <ChannelCard
              key={c.name}
              name={c.name}
              title={c.title}
              color={c.color}
              view={c.view}
              fields={c.fields}
              busy={busy}
              msg={msg}
              onSave={saveNotify}
              onTest={() => testChannel(c.name, c.title)}
              guide={c.guide}
              showSwitch={c.showSwitch}
              configured={c.configured}
              statusLine={c.statusLine}
              testResult={tests[c.name]}
              onClearTest={() => clearTest(c.name)}
            >
              {c.children}
            </ChannelCard>
          ))}
        </Row>
      </Card>

      {/* 通知历史：独立成块，可往下滚动多行 */}
      <Card
        style={{ marginBottom: 16 }}
        size="small"
        title={<Space><HistoryIcon />通知历史（最近 {historyRows.length} 条）</Space>}
        extra={
          <Popconfirm
            title="清除通知历史？"
            description="旧记录将归档为 notification_history.jsonl.bak（可找回）。"
            okText="清除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={async () => {
              try {
                const r = await api.clearNotifyHistory()
                msg.success(r.message || '通知历史已清除')
                onChanged()
              } catch (e) { msg.error(e.message) }
            }}
          >
            <Button size="small" danger icon={<DeleteIcon />}>清除</Button>
          </Popconfirm>
        }
      >
        <Table
          rowKey={(_, i) => i}
          size="small"
          pagination={false}
          dataSource={historyRows}
          columns={historyColumns}
          scroll={{ y: 320, x: 'max-content' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无通知历史，发送测试或触发提醒后出现在这里" /> }}
        />
      </Card>

      {/* 飞书加急卡片确认回执：独立成块，可往下滚动多行 */}
      <Card
        size="small"
        title={<Space><NotifyIcon />飞书加急卡片确认回执（最近 {confirms.length} 条）</Space>}
      >
        <Table
          rowKey={(_, i) => i}
          size="small"
          pagination={false}
          dataSource={confirms.slice().reverse()}
          columns={confirmColumns}
          scroll={{ y: 320, x: 'max-content' }}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无回执：在飞书点卡片「确认已处理 / 忽略」后记录在这里" /> }}
        />
      </Card>
    </div>
  )
}
