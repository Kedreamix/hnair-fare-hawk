import React, { useEffect, useState } from 'react'
import {
  Alert, Button, Card, Col, Collapse, DatePicker, Descriptions, Input, InputNumber,
  Row, Space, Switch, Tag, TimePicker, Tooltip, Typography,
} from 'antd'
import dayjs from 'dayjs'
import { EditIcon } from '../icons.jsx'
import { api } from '../api.js'

function detectFareType(raw) {
  // PLUS 只认 ffl/airLowFareSearch。airCtLowFareSearch 不是 PLUS，不能改地址复用。
  const m = String(raw || '').match(/https?:\/\/[^\s'"]+/i)
  const path = m ? m[0] : ''
  if (path.includes('airCtLowFareSearch')) return 'invalid'
  if (path.includes('ffl')) return 'plus'
  if (path.includes('airLowFareSearch')) return 'normal'
  return ''
}

export function TicketSetup({ cfg, onChanged, msg }) {
  const plus = cfg.plus_ticket || {}
  const normal = cfg.normal_ticket || {}
  const hasPlus = !!plus.configured
  const hasNormal = !!normal.configured
  const any = hasPlus || hasNormal
  // 主档优先展示 PLUS。只有 PLUS 票据时，普通票可以借用；普通票不能反过来派生 PLUS。
  const primary = hasPlus ? 'plus' : hasNormal ? 'normal' : null
  const primaryTicket = primary === 'plus' ? plus : primary === 'normal' ? normal : null
  const derivedType = primary === 'plus' && !hasNormal ? 'normal' : ''

  const [editing, setEditing] = useState(!any)
  const [raw, setRaw] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revealed, setRevealed] = useState('')
  const [secondsLeft, setSecondsLeft] = useState(0)

  useEffect(() => {
    if (!revealed) return undefined
    const timer = setTimeout(() => { setRevealed(''); setSecondsLeft(0) }, 30000)
    return () => clearTimeout(timer)
  }, [revealed])

  useEffect(() => {
    if (!revealed) return undefined
    const iv = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(iv)
  }, [revealed])

  const detected = detectFareType(raw)
  const detectedLabel = detected === 'plus' ? 'PLUS 专享' : detected === 'normal' ? '普通票价' : detected === 'invalid' ? '不可用' : '未识别'

  const save = async () => {
    setError('')
    if (!raw.trim()) { setError('内容为空，未保存。'); return }
    if (detected === 'invalid') {
      setError('这是 airCtLowFareSearch，不能当作 PLUS。请在 PLUS 专享入口抓取 ffl/airLowFareSearch。')
      return
    }
    if (!detected) { setError('没有识别到 airLowFareSearch 请求，未保存。'); return }
    setBusy(true)
    try {
      const r = await api.saveTicket(detected, raw)
      if (!r.ok) { setError(r.error || '保存失败'); return }
      const extra = detected === 'plus' ? '普通票可借用这份登录态。' : 'PLUS 仍需单独抓取 ffl/airLowFareSearch。'
      msg.success(`票据已识别为「${detectedLabel}」并保存。${extra}daemon 下一轮自动生效`)
      setRaw('')
      setEditing(false)
      onChanged()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const reveal = async () => {
    if (!primary) return
    if (revealed) { setRevealed(''); setSecondsLeft(0); return }
    try {
      const r = await api.ticketRaw(primary)
      setRevealed(r.raw || '')
      setSecondsLeft(30)
    } catch (e) {
      msg.error(e.message)
    }
  }

  const bodyOk = primaryTicket && primaryTicket.configured && primaryTicket.length > 0
  const statusTag = !any
    ? <Tag color="orange">未配置</Tag>
    : hasPlus && hasNormal
      ? <Tag color="green">已配置（两档均有）</Tag>
      : <Tag color="green">已配置</Tag>

  return (
    <Card title="抓包票据" extra={statusTag}>
      <Row gutter={[16, 8]} wrap align="middle">
        <Col flex="auto" style={{ minWidth: 0 }}>
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="当前票据">
              {primary ? (primary === 'plus' ? 'PLUS 专享' : '普通票价') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="请求地址">
              {primaryTicket?.configured ? (
                <Tooltip title={primaryTicket.url}>
                  <Typography.Text ellipsis style={{ maxWidth: '100%', display: 'block' }}>{primaryTicket.url}</Typography.Text>
                </Tooltip>
              ) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="端点">
              {primaryTicket?.configured ? (primaryTicket.endpoint_note || '—') : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="体积">
              {primaryTicket ? `${(primaryTicket.length / 1024).toFixed(1)} KB` : '—'}
            </Descriptions.Item>
          </Descriptions>
        </Col>
        {!editing && (
          <Col flex="none">
            <Button type="primary" icon={<EditIcon />} onClick={() => setEditing(true)}>更新票据</Button>
          </Col>
        )}
      </Row>

      <Space style={{ margin: '12px 0 4px' }} size={[8, 8]} wrap>
        <Tag color={primaryTicket?.configured ? 'green' : 'red'}>{primaryTicket?.configured ? '✓' : '✗'} 请求地址已解析</Tag>
        <Tag color={bodyOk ? 'green' : 'red'}>{bodyOk ? '✓' : '✗'} 请求体完整</Tag>
        {primaryTicket?.configured && (
          <Button size="small" type="link" onClick={reveal}>{revealed ? '收起明文' : '查看明文'}</Button>
        )}
      </Space>

      {derivedType && (
        <Alert
          style={{ marginTop: 8 }}
          type="info"
          showIcon
          message="未单独抓包普通票价票据：运行时会借用 PLUS 票据，并改回普通票端点。"
        />
      )}
      {!derivedType && hasPlus && hasNormal && (
        <Alert style={{ marginTop: 8 }} type="success" showIcon message="PLUS 与普通档均已单独配置，均按原档使用。" />
      )}

      {revealed && (
        <div className="raw-box">
          <pre>{revealed}</pre>
          <div className="muted" style={{ fontSize: 12 }}>{secondsLeft} 秒后自动收起</div>
        </div>
      )}

      {editing && (
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>
            粘贴后自动识别档位，当前识别为
            <Tag color={detected === 'plus' ? 'blue' : detected === 'invalid' ? 'red' : 'default'} style={{ marginInline: '0 4px' }}>{detectedLabel}</Tag>
            （PLUS 与普通票需要各自的请求）
          </div>
          <Input.TextArea
            rows={6}
            placeholder="粘贴完整 cURL（含 Cookie、token、hnairSign）。PLUS 用 ffl/airLowFareSearch，普通票用 airLowFareSearch。"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          {error && <Alert style={{ marginTop: 8 }} type="error" showIcon message={error} />}
          <div style={{ marginTop: 12, textAlign: 'right' }}>
            <Space>
              <Button onClick={() => setRaw('')}>清空</Button>
              {any && <Button onClick={() => setEditing(false)}>取消</Button>}
              <Button type="primary" loading={busy} onClick={save}>保存票据</Button>
            </Space>
          </div>
        </div>
      )}

      <Collapse
        ghost
        style={{ marginTop: 12 }}
        items={[{
          key: 'howto',
          label: '如何获取票据（PLUS 和普通票要各抓一份）',
          children: (
            <div>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <Typography.Text strong>抓包方法：</Typography.Text>
                打开海航官网/App 查询页 → F12 开发者工具 → Network（网络）→ 找到对应查询请求 → 右键 →
                <Typography.Text code>Copy → Copy as cURL (bash)</Typography.Text>，粘贴到上方输入框并保存。
              </Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 8 }}>
                <Typography.Text strong>两种端点：</Typography.Text>
                PLUS 专享请求名
                <Typography.Text code>ffl/airLowFareSearch</Typography.Text>
                ，URL 里要有 token。
                <Typography.Text code>airCtLowFareSearch</Typography.Text>
                不是 PLUS，不能改地址后复用。
                普通票价请求名是不带 ffl 的 <Typography.Text code>airLowFareSearch</Typography.Text>。
              </Typography.Paragraph>
              <Typography.Paragraph style={{ marginBottom: 0 }}>
                <Typography.Text type="secondary">
                  两档签名不能互换。只有 PLUS 票据时，普通票可以借用并改回普通端点；只有普通票时，PLUS 不会自动派生。
                  已配置后保存即生效，daemon 下一轮自动读取，无需重启。
                </Typography.Text>
              </Typography.Paragraph>
            </div>
          ),
        }]}
      />
    </Card>
  )
}

export default function MonitorSettings({ data, onChanged, msg }) {
  const cfg = data.config
  const [busy, setBusy] = useState('')
  const [start, setStart] = useState(() => dayjs(cfg.monitor_window?.start || '07:00', 'HH:mm'))
  const [end, setEnd] = useState(() => dayjs(cfg.monitor_window?.end || '23:00', 'HH:mm'))
  const [proxy, setProxy] = useState(cfg.proxy || '')
  const [signRefresh, setSignRefresh] = useState(cfg.sign_refresh || false)
  const [priceQueryOn, setPriceQueryOn] = useState(cfg.price_query?.enabled !== false)
  const [priceQueryInterval, setPriceQueryInterval] = useState(cfg.price_query?.min_interval || 8)
  const [releaseCutoff, setReleaseCutoff] = useState(() => dayjs(cfg.release_cutoff_date || '2026-12-31', 'YYYY-MM-DD'))
  const [probeMinutes, setProbeMinutes] = useState(cfg.unreleased_probe_minutes || 60)
  useEffect(() => {
    if (cfg.release_cutoff_date) setReleaseCutoff(dayjs(cfg.release_cutoff_date, 'YYYY-MM-DD'))
    if (cfg.unreleased_probe_minutes) setProbeMinutes(cfg.unreleased_probe_minutes)
  }, [cfg.release_cutoff_date, cfg.unreleased_probe_minutes])
  // 监控频率（daemon 轮询间隔范围，秒）：与「实时查价」不同，这里控制后台多久查一次价
  const polling = cfg.polling || {}
  const [pollingForm, setPollingForm] = useState({
    day_min_sec: polling.day_min_sec ?? 90,
    day_max_sec: polling.day_max_sec ?? 240,
    night_min_sec: polling.night_min_sec ?? 300,
    night_max_sec: polling.night_max_sec ?? 600,
  })
  const setPoll = (k) => (v) => setPollingForm((prev) => ({ ...prev, [k]: v }))

  const savePolling = async () => {
    setBusy('polling')
    try {
      const r = await api.savePolling(pollingForm)
      msg.success('监控频率已保存，daemon 下一轮生效')
      if (r.polling) setPollingForm({
        day_min_sec: r.polling.day_min_sec, day_max_sec: r.polling.day_max_sec,
        night_min_sec: r.polling.night_min_sec, night_max_sec: r.polling.night_max_sec,
      })
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const saveWindow = async () => {
    setBusy('window')
    try {
      await api.saveMonitorWindow(start.format('HH:mm'), end.format('HH:mm'))
      msg.success(`监控时段已保存：${start.format('HH:mm')} - ${end.format('HH:mm')}`)
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const saveProxy = async () => {
    setBusy('proxy')
    try {
      await api.saveProxy(proxy)
      msg.success('代理设置已保存')
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  const toggleSignRefresh = async (v) => {
    setSignRefresh(v)
    try {
      await api.saveSignRefresh(v)
      msg.success(v ? '已开启签名刷新：每轮刷新 stime 并重签，失败自动回退' : '已关闭签名刷新')
    } catch (e) { msg.error(e.message) }
  }

  const togglePriceQuery = async (v) => {
    setPriceQueryOn(v)
    try {
      await api.savePriceQuery(v, priceQueryInterval)
      msg.success(v ? '已开启实时查价（原价/优惠价可查）' : '已关闭实时查价（防风控），不再请求海航接口')
      onChanged()
    } catch (e) {
      setPriceQueryOn(!v)
      msg.error(e.message)
    }
  }

  const savePriceInterval = async () => {
    try {
      await api.savePriceQuery(priceQueryOn, priceQueryInterval)
      msg.success(`实时查价最小间隔已保存：${priceQueryInterval} 秒`)
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const saveCutoff = async () => {
    if (!releaseCutoff || !releaseCutoff.isValid()) {
      msg.error('请选择有效的抢票开放截止日期')
      return
    }
    setBusy('cutoff')
    try {
      const dateStr = releaseCutoff.format('YYYY-MM-DD')
      await api.saveReleaseCutoff(dateStr, probeMinutes)
      msg.success(`已更新抢票开放截止日：${dateStr}（未开启抢票日期每 ${probeMinutes} 分钟低频探测一次）`)
      onChanged()
    } catch (e) { msg.error(e.message) } finally { setBusy('') }
  }

  return (
    <div>
      <TicketSetup cfg={cfg} onChanged={onChanged} msg={msg} />

      {/* 实时查价（防风控） */}
      <Card style={{ marginTop: 16, marginBottom: 16 }} title="实时查价（防风控）">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap>
            <Switch checked={priceQueryOn} onChange={togglePriceQuery} checkedChildren="开" unCheckedChildren="关" />
            <Typography.Text strong>允许实时查价（原价/优惠价）</Typography.Text>
            <Typography.Text type="secondary">查询最小间隔</Typography.Text>
            <InputNumber
              min={2}
              max={120}
              value={priceQueryInterval}
              onChange={(v) => setPriceQueryInterval(v || 8)}
              addonAfter="秒"
              style={{ width: 130 }}
            />
            <Button onClick={savePriceInterval} loading={busy === 'pq'}>保存间隔</Button>
          </Space>
          <Alert
            type={priceQueryOn ? 'info' : 'warning'}
            showIcon
            message={
              priceQueryOn
                ? '实时查价会直接请求海航接口（存在风控风险）。已做限流：每次查询间隔不少于设定秒数，手动与监控共用此开关。'
                : '实时查价已关闭：手动查询与监控任务都不再请求海航价格接口，只保留底表航班信息查询。'
            }
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            航班信息（起降时刻/经停/航站楼）的更新走「第三方校正」机制（data/sediment/third_party/），
            不依赖实时查价；如担心被风控可随时关掉本开关，不影响航班信息查询。
          </Typography.Text>
        </Space>
      </Card>

      {/* 抢票开放截止日与未开启抢票低频探测 */}
      <Card style={{ marginTop: 16, marginBottom: 16 }} title="抢票开放截止日（自动探测更新）">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Space wrap>
            <Typography.Text strong>当前已开启抢票至</Typography.Text>
            <DatePicker
              allowClear={false}
              format="YYYY-MM-DD"
              value={releaseCutoff}
              onChange={(v) => v && setReleaseCutoff(v)}
            />
            <Typography.Text type="secondary">待开启抢票日期探测间隔</Typography.Text>
            <InputNumber
              min={5}
              max={720}
              value={probeMinutes}
              onChange={(v) => setProbeMinutes(v || 60)}
              addonAfter="分钟"
              style={{ width: 140 }}
            />
            <Button type="primary" loading={busy === 'cutoff'} onClick={saveCutoff}>保存设置</Button>
          </Space>
          <Alert
            type="info"
            showIcon
            message={`截止日（${releaseCutoff ? releaseCutoff.format('YYYY-MM-DD') : '2026-12-31'}）及以前的航班已开启抢票，每轮正常高频监控；超过该日期的航班标记为「待开启抢票」并按设定间隔低频探测，一旦探测到海航放票会自动推进此截止日并恢复高频监控。`}
          />
        </Space>
      </Card>

      {/* 监控频率（daemon 轮询节奏，区别于实时查价） */}
      <Card style={{ marginTop: 16, marginBottom: 16 }} title="监控频率（daemon 轮询节奏）">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="「监控频率」= 后台 daemon 每隔多久模拟点击一次查询，只影响监控任务的抓价节奏。频率越低越不容易被风控，但价格更新越慢。"
          />
          <Row gutter={16} align="middle">
            <Col xs={24} md={12}>
              <Space size={8} wrap>
                <Typography.Text strong>日间（07:00-23:00）</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>间隔</Typography.Text>
                <InputNumber min={10} max={3600} value={pollingForm.day_min_sec} onChange={setPoll('day_min_sec')} addonAfter="秒" style={{ width: 110 }} />
                <Typography.Text type="secondary">~</Typography.Text>
                <InputNumber min={10} max={3600} value={pollingForm.day_max_sec} onChange={setPoll('day_max_sec')} addonAfter="秒" style={{ width: 110 }} />
              </Space>
            </Col>
            <Col xs={24} md={12}>
              <Space size={8} wrap>
                <Typography.Text strong>夜间（23:00-07:00）</Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>间隔</Typography.Text>
                <InputNumber min={10} max={3600} value={pollingForm.night_min_sec} onChange={setPoll('night_min_sec')} addonAfter="秒" style={{ width: 110 }} />
                <Typography.Text type="secondary">~</Typography.Text>
                <InputNumber min={10} max={3600} value={pollingForm.night_max_sec} onChange={setPoll('night_max_sec')} addonAfter="秒" style={{ width: 110 }} />
              </Space>
            </Col>
          </Row>
          <Space>
            <Button type="primary" loading={busy === 'polling'} onClick={savePolling}>保存频率</Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              建议：日间 90~240 秒、夜间 300~600 秒可平衡及时性与风控；夜间无敏感航班可放宽到 5~10 分钟。
              改为极短间隔（如 10 秒）会显著提高被海航限流风险，请谨慎。
            </Typography.Text>
          </Space>
        </Space>
      </Card>

      {/* 监控时段 */}
      <Card style={{ marginTop: 16, marginBottom: 16 }} title="每日监控时段">
        <Space size="large" wrap>
          <span>
            <Typography.Text strong style={{ marginRight: 8 }}>开始</Typography.Text>
            <TimePicker format="HH:mm" minuteStep={5} value={start} onChange={(v) => v && setStart(v)} />
          </span>
          <span>
            <Typography.Text strong style={{ marginRight: 8 }}>结束</Typography.Text>
            <TimePicker format="HH:mm" minuteStep={5} value={end} onChange={(v) => v && setEnd(v)} />
          </span>
          <Button type="primary" loading={busy === 'window'} onClick={saveWindow}>保存时段</Button>
        </Space>
        <div className="muted" style={{ marginTop: 8 }}>仅在该时段内轮询抓价；跨天请设置例如 22:00 到 07:00（22:00 ~ 次日 07:00）。</div>
      </Card>

      <Collapse
        className="advanced-settings"
        items={[{ key: 'advanced', label: '高级设置（按需展开）', children: (
        <Row gutter={[16, 16]}>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={8}>
              <Space>
                <Switch checked={signRefresh} onChange={toggleSignRefresh} checkedChildren="开" unCheckedChildren="关" />
                <Typography.Text strong>签名刷新（stime + 重签）</Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                开启后每轮刷新 common.stime 并重签；遇验签错误自动回退原签名抓包。建议稳定运行几天后再开。
              </Typography.Text>
            </Space>
          </Col>
          <Col xs={24} md={12}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              <Typography.Text strong>HTTP(S) 代理（可选）</Typography.Text>
              <Space.Compact style={{ width: '100%' }}>
                <Input
                  placeholder="例如 http://127.0.0.1:7890，留空表示直连"
                  value={proxy}
                  onChange={(e) => setProxy(e.target.value)}
                />
                <Button type="primary" loading={busy === 'proxy'} onClick={saveProxy}>保存代理</Button>
              </Space.Compact>
            </Space>
          </Col>
        </Row>
        ) }]}
      />
    </div>
  )
}
