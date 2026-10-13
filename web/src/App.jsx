import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert, App as AntApp, Button, Card, Checkbox, Col, Collapse, ConfigProvider, DatePicker, Descriptions, Dropdown, Empty, Form, Input, Tabs,
  InputNumber, Layout, Menu, Modal, Popconfirm, Popover, Radio, Result, Row, Select, Space, Spin,
  Statistic, Steps, Switch, Table, Tag, TimePicker, Tooltip, Typography, theme as antdTheme,
} from 'antd'
import {
  CalendarIcon, ChevronLeftIcon, ChevronRightIcon, CloseIcon, CompassIcon, DeleteIcon, EditIcon, HistoryIcon, MonitorIcon, SwapIcon,
 NotifyIcon, OverviewIcon, PlusIcon, PowerIcon, QuestionIcon, SendIcon, SettingsIcon, TasksIcon, BrandIcon,
 RadarIcon, TargetIcon, MoonIcon, SunriseIcon, SunIcon, SunsetIcon, LuggageIcon, MapIcon,
} from './icons.jsx'
import dayjs from 'dayjs'
import { api, formatTs } from './api.js'
import { usePolling } from './components.jsx'
import { cityWithProvince } from './cityProvince.js'
import { AIRPORT_TAX, FACE_PRICE, weekendFareEstimate } from './weekendFare.js'

const TABS = [
  { key: 'overview', icon: <OverviewIcon />, label: '总览' },
  { key: 'tasks', icon: <TasksIcon />, label: '监控任务' },
  { key: 'flights', icon: <CompassIcon />, label: '航线查询' },
  { key: 'notify', icon: <NotifyIcon />, label: '通知管理' },
  { key: 'monitor', icon: <MonitorIcon />, label: '监控设置' },
  { key: 'history', icon: <HistoryIcon />, label: '历史日志' },
]

/* 舱位白名单常见值（可手输任意舱位码，回车添加）；转监控弹窗与编辑任务弹窗共用 */
const CABIN_OPTIONS = ['B', 'C', 'Y', 'Z', 'R', 'H', 'K', 'L', 'M', 'N', 'Q', 'T', 'X', 'E', 'U', 'V', 'W', 'G', 'S']
const TIER_OPTIONS = [
  { value: '666', label: '666' },
  { value: '2666', label: '2666' },
  { value: '66666', label: '66666' },
]

/* ---------- 通用辅助 ---------- */
function shortCity(label) {
  return String(label || '').split('（')[0] || label
}

/* 从「深圳（SZX）」「深圳宝安（SZX）」或裸三字码里取出机场码。官网链接必须用三字码，不能把中文标签塞进 orgCity。 */
function airportCodeOf(label) {
  const text = String(label || '').trim()
  if (/^[A-Za-z]{3}$/.test(text)) return text.toUpperCase()
  const matched = text.match(/[（(]\s*([A-Za-z]{3})\b/)
  return matched ? matched[1].toUpperCase() : ''
}

// 展开底表 effective_dates 区间到逐日（去重排序）；FlightQuery 与监控任务编辑弹窗共用
function expandDates(ranges) {
  const seen = new Set()
  for (const [a, b] of ranges || []) {
    let cur = dayjs(a)
    const end = dayjs(b)
    let guard = 0
    while (!cur.isAfter(end) && guard < 400) {
      seen.add(cur.format('YYYY-MM-DD'))
      cur = cur.add(1, 'day')
      guard += 1
    }
  }
  return [...seen].sort()
}

// 合并重叠的可飞日期区间（数据源同航班多条记录会带来近似重复区间，展示前并集化简）
function mergeRanges(ranges = []) {
  const arr = (ranges || [])
    .filter((r) => Array.isArray(r) && r.length >= 2)
    .map((r) => [String(r[0]).slice(0, 10), String(r[1]).slice(0, 10)])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
  const out = []
  for (const [a, b] of arr) {
    const last = out[out.length - 1]
    if (last && a <= last[1]) {
      if (b > last[1]) last[1] = b
    } else {
      out.push([a, b])
    }
  }
  return out
}

// 档位×日期固定规则（产品条款，事实源：data/sediment/tier_block_rules.json，
// 经 /api/flights/meta.tier_block_rules 下发；此处为后端未就绪时的兜底，须与底表 JSON 保持一致）：
// 规则来源：搜狗公众号「666元海航随心飞,有效期1年!」(2026-08) × 参考资料 sxfroute 交叉验证。
// 666 元版屏蔽春运/五一/暑运/十一；2666 元版仅屏蔽春运/暑运；66666 无官方条款默认不限。
// 区间均为闭区间（含首尾）。格式：档位 → 不可选日期区间列表；空数组=该档不限。
const DEFAULT_TIER_BLOCK_RULES = {
  '666': [
    ['2026-02-02', '2026-03-13'], // 2026 春运（农历腊月十五~正月廿五，近似）
    ['2026-04-30', '2026-05-06'], // 2026 五一（法定假期及前后各一天）
    ['2026-07-01', '2026-08-31'], // 暑运
    ['2026-09-30', '2026-10-09'], // 2026 十一（国庆法定假期及前后各一天）
  ],
  '2666': [
    ['2026-02-02', '2026-03-13'], // 春运
    ['2026-07-01', '2026-08-31'], // 暑运
  ],
  '66666': [],
}

// 后端 /api/flights/meta.tier_block_rules 形状：{source, notes, tiers: {档位: {label, blocks: [[start,end]]}}}
// 归一为 {档位: [[start,end], ...]} 供 filterTierDates 使用
function normalizeTierRules(metaRules) {
  const out = {}
  for (const [t, v] of Object.entries((metaRules && metaRules.tiers) || {})) {
    out[t] = Array.isArray(v && v.blocks) ? v.blocks : []
  }
  return out
}

// 档位×日期过滤：返回 dates 中该档位允许选择的日期（按规则剔除屏蔽区间内日期）。
// 无档位信息或档位没有规则时原样返回，不做拦截。
function filterTierDates(dates, product, tierBlockRules) {
  if (!dates || !dates.length) return dates
  const rules = tierBlockRules || DEFAULT_TIER_BLOCK_RULES
  const tiers = String(product || '').split('/').map((s) => s.trim()).filter(Boolean)
  const blocks = tiers.flatMap((t) => rules[t] || [])
  if (!blocks.length) return dates
  const blocked = new Set()
  for (const [a, b] of blocks) {
    let cur = dayjs(a)
    const end = dayjs(b)
    let guard = 0
    while (!cur.isAfter(end) && guard < 400) {
      blocked.add(cur.format('YYYY-MM-DD'))
      cur = cur.add(1, 'day')
      guard += 1
    }
  }
  return dates.filter((d) => !blocked.has(String(d).slice(0, 10)))
}

// 展开多条底表记录的可飞日期：区间内且班期匹配（day() 周日=0…周六=6 换算为 周一=1…周日=7），
// 任一记录当天可飞即算（并集），去重排序；无班期数据的记录退化为按区间展开。
// 与班期日历 ScheduleCalendar 的判定一致，保证转监控/编辑弹窗只能选日历里可兑换的天。
function expandRecordDates(records = []) {
  const seen = new Set()
  for (const rec of records || []) {
    const ranges = Array.isArray(rec.effective_dates) ? rec.effective_dates : []
    const days = Array.isArray(rec.days) ? rec.days : []
    if (!days.length) {
      for (const d of expandDates(ranges)) seen.add(d)
      continue
    }
    for (const [a, b] of ranges) {
      if (!a || !b) continue
      let cur = dayjs(a)
      const end = dayjs(b)
      let guard = 0
      while (!cur.isAfter(end) && guard < 500) {
        const iso = cur.day() === 0 ? 7 : cur.day()
        if (days.includes(iso)) seen.add(cur.format('YYYY-MM-DD'))
        cur = cur.add(1, 'day')
        guard += 1
      }
    }
  }
  return [...seen].sort()
}

function suggestReturnDates(outbound, allowedDates) {
  const allowed = new Set(allowedDates || [])
  const picked = new Set()
  for (const leg of outbound || []) {
    for (const day of leg.selected || []) {
      const next = dayjs(day).add(1, 'day').format('YYYY-MM-DD')
      if (allowed.has(next)) picked.add(next)
    }
  }
  return [...picked].sort()
}

function recordsToMonitorGroups(recs, tierBlockRules, todayStr) {
  const groups = []
  const idx = {}
  for (const r of recs || []) {
    const gkey = `${r.origin?.city || ''}|${r.dest?.city || ''}|${r.flight_no || ''}|${r.dep_time || ''}|${r.arr_time || ''}`
    if (!(gkey in idx)) {
      idx[gkey] = groups.length
      groups.push({
        key: gkey,
        from_city: r.origin.city,
        from_iata: r.origin.iata,
        to_city: r.dest.city,
        to_iata: r.dest.iata,
        flight_no: r.flight_no || '',
        dep_time: r.dep_time || '',
        arr_time: r.arr_time || '',
        product: new Set(),
        dates: [],
        selected: [],
        rows: [],
      })
    }
    const g = groups[idx[gkey]]
    for (const p of String(r.product || '').split('/')) if (p) g.product.add(p)
    g.rows.push(r)
  }
  for (const g of groups) {
    const live = g.rows.filter((row) => {
      const ranges = Array.isArray(row.effective_dates) ? row.effective_dates : []
      if (!ranges.length) return true
      return ranges.some((pair) => String(pair?.[1] || '') >= todayStr)
    })
    const source = live.length ? live : g.rows
    const product = new Set()
    source.forEach((row) => {
      String(row.product || '').split('/').forEach((part) => { if (part) product.add(part) })
    })
    g.product = [...product].sort().join('/')
    g.dates = filterTierDates(expandRecordDates(g.rows), g.product, tierBlockRules).filter((d) => d >= todayStr)
  }
  groups.sort((a, b) => String(a.dep_time).localeCompare(String(b.dep_time)) || String(a.flight_no).localeCompare(String(b.flight_no)))
  return groups
}

function outboundLegs(groups) {
  return (groups || []).filter((g) => g.direction !== 'back').map((g) => ({
    dep_time: g.dep_time,
    arr_time: g.arr_time,
    selected: g.selected || [],
  }))
}

// 回程日期跟着去程走，默认是去程的第二天。手动改过日历或取消勾选的不再覆盖。
function withReturnSuggestions(groups) {
  const legs = outboundLegs(groups)
  return (groups || []).map((g) => {
    if (g.direction !== 'back' || g.returnTouched) return g
    const selected = suggestReturnDates(legs, g.dates)
    if (g.choicePinned) return { ...g, selected }
    return { ...g, selected, checked: selected.length > 0 }
  })
}

function HitTag({ hit }) {
  return hit ? <Tag color="magenta">低价命中</Tag> : <Tag>监控中</Tag>
}

/* ================= 总览 ================= */
function Overview({ data, onGo, onToggleStatus, onChanged, msg, onOpenDetail }) {
  const cfg = data.config
  const stats = data.stats
  const running = cfg.status === 'running'
  const hits = [...(data.history || [])].reverse().filter((r) => Number(r.price) <= 500).slice(0, 50)

  const taskOf = (r) => (data.tasks || []).find((t) => Array.isArray(t.ids) && t.ids.includes(r.task_id))

  const columns = [
    { title: '时间', dataIndex: 'ts', width: 160, render: (v) => formatTs(v) },
    {
      title: '航线', key: 'route', width: 320,
      render: (_, r) => (
        <Space direction="vertical" size={3} style={{ padding: '4px 0' }}>
          {/* 标题行：航班号 + 城市（省份） → 城市（省份） */}
          <Space size={6} wrap>
            <span className="mono" style={{ fontWeight: 600 }}>{r.flight || '—'}</span>
            <span className="route-line">
              <span>{cityWithProvince(shortCity(r.from))}</span>
              <i aria-hidden="true" />
              <span>{cityWithProvince(shortCity(r.to))}</span>
            </span>
          </Space>
          {/* 起降时间行 */}
          <Space size={8} wrap>
            <span className="mono" style={{ fontSize: 12 }}>{r.dep_time || '--:--'} → {r.arr_time || '--:--'}</span>
            {!(r.dep_time && r.arr_time) && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>时刻待查询</Typography.Text>
            )}
          </Space>
        </Space>
      ),
    },
    {
      title: '日期', dataIndex: 'date', width: 148,
      render: (v) => {
        const week = cnWeekday(v)
        return week ? `${v}（${week}）` : (v || '—')
      },
    },
    {
      title: '档位', key: 'tiers', width: 130,
      render: (_, r) => {
        const list = Array.isArray(r.tiers) ? r.tiers : []
        if (!list.length) return <Typography.Text type="secondary">—</Typography.Text>
        return list.map((t) => (
          <Tag key={t} color={String(t) === '666' ? 'gold' : 'purple'} style={{ marginInlineEnd: 4 }}>{t}</Tag>
        ))
      },
    },
    {
      // 余票条件来自该命中记录对应的监控任务（按 task_id 匹配分组行），非抓到的余票张数
      title: '余票条件', key: 'seat_cond', width: 140,
      render: (_, r) => {
        const t = taskOf(r)
        const parts = []
        if (t && Number(t.min_seats || 1) > 1) parts.push(`≥${t.min_seats}张`)
        if (t && t.cabins && t.cabins.length) parts.push(`舱位 ${t.cabins.join('/')}`)
        if (!t) return <Typography.Text type="secondary">—</Typography.Text>
        if (!parts.length) return <Typography.Text type="secondary">不限</Typography.Text>
        return (
          <Space size={4} wrap>
            {parts.map((p, i) => <Tag key={i} color={i === 0 ? 'blue' : 'purple'}>{p}</Tag>)}
          </Space>
        )
      },
    },
    {
      title: '价格(元)', dataIndex: 'price', width: 100, align: 'right',
      render: (v) => <span style={{ color: 'var(--color-low-price)', fontWeight: 700 }}>¥{v}</span>,
    },
    {
      title: '操作', key: 'op', width: 168,
      render: (_, r) => {
        const fromCode = airportCodeOf(r.from)
        const toCode = airportCodeOf(r.to)
        const day = r.date
        const canJump = !!(day && fromCode && toCode)
        const webRec = { from_code: fromCode, to_code: toCode, flight_no: r.flight || '' }
        return (
          <Space size={0} wrap>
            <Button
              size="small"
              type="link"
              disabled={!day}
              onClick={() => onOpenDetail && onOpenDetail({
                // 用三字码而不是「北京首都」：城市名子串会把北京首都和北京大兴一起查出来
                from: fromCode || cityNameOf(r.from) || r.from,
                to: toCode || cityNameOf(r.to) || r.to,
                flightNo: r.flight || '',
                date: day,
              })}
            >
              查看详情
            </Button>
            {canJump ? (
              <Button
                size="small"
                type="link"
                className="task-jump"
                href={officialWebUrl(webRec, day, false)}
                target="_blank"
                rel="noreferrer"
                title={`跳到海航官网查询 ${r.flight || ''} ${fromCode}→${toCode} ${day}`}
              >
                跳到官网
              </Button>
            ) : (
              <Button size="small" type="link" disabled title="这条记录没有日期或机场三字码">跳到官网</Button>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <div className="overview">
      <section className="radar-status" aria-label="监控状态">
        <div className="radar-ico"><RadarIcon /></div>
        <div className="radar-body">
          <div className="radar-eyebrow">ROUTE RADAR / MONITORING</div>
          <div className="radar-status-title">
            <span className={`status-orbit ${running ? 'is-running' : ''}`} aria-hidden="true" />
            {running ? '监控运行中' : '监控已停止'}
          </div>
          <div className="radar-status-note">daemon 按已设定时段轮询抓价，命中低价后推送通知。</div>
          <div className="radar-meta">
            <span className="mono">{window.location.host}</span>
            <span>监控任务 {stats.task_count} · 启用 {stats.enabled_count}</span>
          </div>
        </div>
        <div className="radar-action">
          <Button
            type={running ? 'default' : 'primary'}
            icon={running ? <PowerIcon /> : undefined}
            onClick={onToggleStatus}
          >
            {running ? '停止监控' : '启动监控'}
          </Button>
        </div>
      </section>

      <Row className="overview-stats" gutter={[16, 16]} align="stretch">
        <Col xs={24} sm={8}>
          <Card className="stat-card">
            <div className="stat-row">
              <span className="stat-ico blue"><TasksIcon /></span>
              <div className="stat-body">
                <Statistic title="监控任务" value={stats.task_count} />
                <div className="muted">启用 {stats.enabled_count} 个</div>
              </div>
            </div>
            <Button type="default" style={{ marginTop: 'auto' }} onClick={() => onGo('tasks')}>管理任务</Button>
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="stat-card stat-card-hit">
            <div className="stat-row">
              <span className="stat-ico green"><TargetIcon /></span>
              <div className="stat-body">
                <Statistic title="低价命中记录" value={stats.hit_count_24h} valueStyle={stats.hit_count_24h > 0 ? { color: 'var(--color-low-price)' } : undefined} />
                <div className="muted">命中监控目标价的提醒条数（档位 666/2666，近 50 条样本）</div>
              </div>
            </div>
            <div className="stat-card-footer" />
          </Card>
        </Col>
        <Col xs={24} sm={8}>
          <Card className="stat-card">
            <div className="stat-row">
              <span className="stat-ico gray"><HistoryIcon /></span>
              <div className="stat-body">
                <Statistic title="历史记录" value={stats.history_count} />
                <div className="muted">运行日志实时查询（最近 200 行），低价记录最近 50 条</div>
              </div>
            </div>
            <Button type="default" style={{ marginTop: 'auto' }} onClick={() => onGo('history')}>查看历史</Button>
          </Card>
        </Col>
      </Row>

      {!cfg.plus_ticket.configured && !cfg.normal_ticket.configured && (
        <Alert
          style={{ marginTop: 16 }}
          type="warning"
          showIcon
          message="尚未配置任何抓包票据，监控任务将无法查询。"
          action={<Button size="small" type="link" onClick={() => onGo('monitor')}>去配置</Button>}
        />
      )}

      <Card
        className="low-hit-panel"
        style={{ marginTop: 16 }}
        title="最近低价命中（最近 50 条）"
        extra={
          <Space>
            <Button type="link" onClick={() => onGo('history')}>全部历史</Button>
            <Popconfirm
              title="清除最近低价命中记录？"
              description="旧记录将归档为 price_history.jsonl.bak（可找回）。"
              okText="清除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={async () => {
                try {
                  const r = await api.clearPriceHistory()
                  msg.success(r.message || '最近低价命中记录已清除')
                  onChanged()
                } catch (e) { msg.error(e.message) }
              }}
            >
              <Button size="small" danger icon={<DeleteIcon />}>清除历史记录</Button>
            </Popconfirm>
          </Space>
        }
      >
        <Table
          rowKey={(_, i) => i}
          size="small"
          pagination={false}
          dataSource={hits}
          columns={columns}
          scroll={{ x: 1140, y: 400 }}
          locale={{ emptyText: <Empty description="暂无低价命中，监控运行后会出现在这里" /> }}
        />
      </Card>
    </div>
  )
}

/* ================= 任务 ================= */
function ReturnPickList({ groups, onToggle, onDates }) {
  if (!groups.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有找到回程航班" />
  return groups.map((g) => {
    const brief = (g.selected || []).map((d) => String(d).slice(5)).join('、')
    return (
      <Card
        key={g.key}
        size="small"
        style={{ marginBottom: 12 }}
        title={
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0 }}>
            <Checkbox checked={!!g.checked} onChange={(e) => onToggle(g.key, e.target.checked)} />
            <Tag color="blue" style={{ marginInlineEnd: 0 }}>回程</Tag>
            <span className="mono" style={{ fontWeight: 600, fontSize: 12 }}>{g.flight_no || '—'}</span>
            <Typography.Text type="secondary" style={{ fontSize: 11 }}>{g.dep_time || '--:--'} → {g.arr_time || '--:--'}</Typography.Text>
            <span style={{ fontSize: 12 }}>{cityWithProvince(g.from_city)} → {cityWithProvince(g.to_city)}</span>
          </div>
        }
        extra={<Tag color={String(g.product).includes('2666') ? 'purple' : 'gold'}>{g.product}</Tag>}
      >
        {g.checked ? (
          <>
            <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>
              {brief ? `已按去程次日预选 ${brief}。` : '去程次日这班不飞。'}
              可以改成当天或其他日期。
            </div>
            <DatePickCalendar dates={g.dates} value={g.selected} onChange={(v) => onDates(g.key, v)} />
          </>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            {brief ? `次日可飞 ${brief}。勾选后加入监控。` : '去程次日这班不飞。勾选后可以自己选日期。'}
          </div>
        )}
      </Card>
    )
  })
}

function pairEntries(task, day) {
  const raw = (task?.round_pairs || {})[day]
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  return items.map((info) => {
    if (!info || typeof info !== 'object') return null
    const role = info.role
    const mateDate = String(info.mate_date || '')
    const mateFlight = String(info.mate_flight || '').toUpperCase()
    if ((role !== 'out' && role !== 'back') || !mateDate || !mateFlight) return null
    return { role, mateDate, mateFlight }
  }).filter(Boolean)
}

function pairInfo(task, day) {
  return pairEntries(task, day)[0] || null
}

function findMates(legs, task, day) {
  return pairEntries(task, day).map((info) => {
    const mate = (legs || []).find((other) => (
      other !== task
      && String(other.from_code) === String(task.to_code)
      && String(other.to_code) === String(task.from_code)
      && String(other.flight_no || '').toUpperCase() === info.mateFlight
      && (other.dates || []).includes(info.mateDate)
    ))
    return mate ? { ...info, mate } : null
  }).filter(Boolean)
}

function pairMonitorRows(tasks) {
  const pairKey = (t) => [t.from_code, t.to_code].sort().join('|')
  const byPair = new Map()
  tasks.forEach((t, i) => {
    const key = pairKey(t)
    if (!byPair.has(key)) byPair.set(key, [])
    byPair.get(key).push(i)
  })
  const bothWays = new Set()
  for (const [key, idxs] of byPair) {
    const dirs = new Set(idxs.map((i) => `${tasks[i].from_code}>${tasks[i].to_code}`))
    if (dirs.size >= 2) bothWays.add(key)
  }
  const used = new Set()
  const rows = []
  tasks.forEach((t, i) => {
    if (used.has(i)) return
    const key = pairKey(t)
    if (!bothWays.has(key)) {
      used.add(i)
      rows.push({ key: `single-${(t.ids || [t.id]).join('-')}`, bothWays: false, paired: false, legs: [t] })
      return
    }
    const members = byPair.get(key).map((j) => tasks[j])
    byPair.get(key).forEach((j) => used.add(j))
    const paired = members.some((task) => (task.dates || []).some((day) => findMates(members, task, day).length))
    rows.push({ key: `route-${key}`, bothWays: true, paired, legs: members })
  })
  return rows
}

function emailForDay(task, day) {
  const picked = String((task?.notify_email_by_date || {})[day] || '').trim()
  if (picked) return picked
  return String(task?.notify_email || '').trim()
}

function mailSet(value) {
  return String(value || '')
    .split(/[,，;；\s]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join(',')
}

function sameMail(a, b) {
  return mailSet(a) === mailSet(b)
}

function mailParts(value) {
  const seen = new Set()
  const out = []
  String(value || '').split(/[,，;；\s]+/).forEach((part) => {
    const addr = part.trim()
    const key = addr.toLowerCase()
    if (!addr.includes('@') || seen.has(key)) return
    seen.add(key)
    out.push(addr)
  })
  return out
}

function flightMailFallback(task, globalMail) {
  return String(task?.notify_email || '').trim() || String(globalMail || '').trim()
}

function dayMailPayload(nextParts, task, globalMail) {
  const fallback = flightMailFallback(task, globalMail)
  return sameMail(nextParts.join(','), fallback) ? '' : nextParts.join(',')
}

function shownMail(task, day, globalMail) {
  const specific = emailForDay(task, day)
  const addr = specific || String(globalMail || '').trim()
  return { addr, custom: Boolean(specific) && !sameMail(specific, globalMail) }
}

function routeMailSummary(row, globalMail) {
  const kinds = []
  const seen = new Set()
  const lines = []
  ;(row.legs || []).forEach((task) => {
    ;(task.dates || []).forEach((day) => {
      const shown = shownMail(task, day, globalMail)
      if (!shown.custom) return
      const key = mailSet(shown.addr)
      if (!seen.has(key)) {
        seen.add(key)
        kinds.push(shown.addr)
      }
      lines.push(`${monitorDayLabel(day)} ${task.flight_no || ''} ${shown.addr}`.trim())
    })
  })
  return { kinds, lines }
}

function monitorDayLabel(iso) {
  const day = String(iso || '')
  const md = day.slice(5).replace('-', '/')
  const week = cnWeekday(day)
  return week ? `${md}（${week}）` : md
}

function pushRoundGroup(groups, used, taskKey, outTask, outDay, backTask, backDay) {
  const mark = `${taskKey(outTask)}|${outDay}|${String(outTask.flight_no || '').toUpperCase()}`
  const groupKey = `pair-${outDay}-${backDay}-${outTask.flight_no || ''}-${backTask.flight_no || ''}`
  // 同一个回程日期可以同时属于多组往返，所以回程被用过时不拦截。去程这一天只进一组。
  if (used.has(mark) || groups.some((group) => group.key === groupKey)) return
  used.add(mark)
  used.add(`${taskKey(outTask)}|${outDay}`)
  used.add(`${taskKey(backTask)}|${backDay}`)
  const nights = dayjs(backDay).startOf('day').diff(dayjs(outDay).startOf('day'), 'day')
  groups.push({
    key: groupKey,
    sort: outDay,
    label: `${monitorDayLabel(outDay)} – ${monitorDayLabel(backDay)}`,
    stay: nights > 0 ? `${nights + 1}天${nights}晚` : '',
    legs: [
      { task: { ...outTask, leg: 'out' }, dates: [outDay] },
      { task: { ...backTask, leg: 'back' }, dates: [backDay] },
    ],
    roundReq: {
      round: true,
      outTask,
      backTask,
      from: outTask.from_city || outTask.from_code,
      to: outTask.to_city || outTask.to_code,
      outDate: outDay,
      backDate: backDay,
      outFlight: outTask.flight_no || '',
      backFlight: backTask.flight_no || '',
      date: outDay,
    },
  })
}

function monitorTripGroups(legs) {
  const taskKey = (task) => (task.ids || [task.id]).join('-')
  const used = new Set()
  const groups = []
  ;(legs || []).forEach((task) => {
    ;(task.dates || []).forEach((day) => {
      findMates(legs, task, day).forEach((found) => {
        if (found.role !== 'out') return
        pushRoundGroup(groups, used, taskKey, task, day, found.mate, found.mateDate)
      })
    })
  })
  ;(legs || []).forEach((task) => {
    ;(task.dates || []).forEach((day) => {
      findMates(legs, task, day).forEach((found) => {
        if (found.role !== 'back') return
        pushRoundGroup(groups, used, taskKey, found.mate, found.mateDate, task, day)
      })
    })
  })
  ;(legs || []).forEach((task) => {
    ;(task.dates || []).forEach((day) => {
      const mark = `${taskKey(task)}|${day}`
      if (used.has(mark)) return
      used.add(mark)
      groups.push({
        key: `single-${taskKey(task)}-${day}`,
        sort: day,
        label: monitorDayLabel(day),
        stay: '',
        legs: [{ task, dates: [day] }],
        roundReq: null,
      })
    })
  })
  ;(legs || []).filter((task) => !(task.dates || []).length).forEach((task) => {
    groups.push({
      key: `none-${taskKey(task)}`,
      sort: '9999-99-99',
      label: '未选日期',
      stay: '',
      legs: [{ task, dates: [] }],
      roundReq: null,
    })
  })
  return mergeSharedReturns(groups)
}

function mergeSharedReturns(groups) {
  const order = []
  const hosts = new Map()
  ;(groups || []).forEach((group) => {
    const back = group.roundReq ? group.legs[group.legs.length - 1] : null
    const backDay = back?.dates?.[0]
    if (!backDay) {
      order.push(group)
      return
    }
    const taskIds = (back.task.ids || [back.task.id]).join('-')
    const key = `${backDay}|${String(back.task.flight_no || '').toUpperCase()}|${taskIds}`
    const host = hosts.get(key)
    if (!host) {
      hosts.set(key, group)
      order.push(group)
      return
    }
    host.legs.splice(host.legs.length - 1, 0, group.legs[0])
  })
  order.forEach((group) => {
    if (!group.roundReq || group.legs.length < 3) return
    const back = group.legs[group.legs.length - 1]
    const backDay = back.dates[0]
    const outs = group.legs.slice(0, -1).sort((a, b) => (
      a.dates[0].localeCompare(b.dates[0]) || String(a.task.dep_time || '').localeCompare(String(b.task.dep_time || ''))
    ))
    outs.forEach((leg, index) => {
      const nights = dayjs(backDay).startOf('day').diff(dayjs(leg.dates[0]).startOf('day'), 'day')
      leg.task = {
        ...leg.task,
        leg: 'out',
        outNo: index + 1,
        legStay: nights > 0 ? `${nights + 1}天${nights}晚` : '',
      }
    })
    const first = outs[0]
    group.legs = [...outs, back]
    group.sort = first.dates[0]
    group.stay = ''
    group.label = `${outs.map((leg) => monitorDayLabel(leg.dates[0])).join('、')} – ${monitorDayLabel(backDay)}`
    group.key = `weekend-${backDay}-${back.task.flight_no || ''}-${outs.map((leg) => leg.dates[0]).join('-')}`
    group.roundReq = {
      ...group.roundReq,
      outTask: first.task,
      outDate: first.dates[0],
      outFlight: first.task.flight_no || '',
      date: first.dates[0],
    }
  })
  order.sort((a, b) => a.sort.localeCompare(b.sort) || Number(Boolean(b.roundReq)) - Number(Boolean(a.roundReq)))
  return order
}

function matchRoundTrips(outs, backs) {
  const used = new Set()
  const orderedBacks = [...backs].sort((a, b) => a.day.localeCompare(b.day) || String(a.dep || '').localeCompare(String(b.dep || '')))
  const pairs = []
  ;[...outs].sort((a, b) => a.day.localeCompare(b.day)).forEach((out) => {
    const index = orderedBacks.findIndex((back, i) => !used.has(i) && back.day > out.day)
    if (index < 0) return
    used.add(index)
    pairs.push({ out, back: orderedBacks[index] })
  })
  return pairs
}

async function loadFlightDates(t) {
  const from = cityNameOf(t.from_city || t.from_code)
  const to = cityNameOf(t.to_city || t.to_code)
  const flightNo = String(t.flight_no || '').trim()
  let r = await api.flightQuery({ from, to, flight_no: flightNo, limit: 300 })
  let recs = r.records || []
  // 底表查不到该航班号时：优先匹配起降时刻相同的记录（班期贴近该任务对应航班），
  // 仍无匹配才退化为整条航线并集，避免把其他航班的可飞日期带进来
  if (!recs.length && flightNo) {
    r = await api.flightQuery({ from, to, limit: 300 })
    recs = (r.records || []).filter((x) => String(x.dep_time || '') === String(t.dep_time || ''))
    if (!recs.length) recs = r.records || []
  }
  return expandRecordDates(recs)
}

function taskDetailRequest(task, day) {
  return {
    from: task.from_city || task.from_code,
    to: task.to_city || task.to_code,
    flightNo: task.flight_no || '',
    date: day,
  }
}

function listsMatch(rows, pick) {
  if (!rows.length) return { same: true, value: undefined }
  const key = (value) => JSON.stringify(value ?? null)
  const first = pick(rows[0])
  return { same: rows.every((row) => key(pick(row)) === key(first)), value: first }
}

function TaskPowerButton({ on, title, onClick }) {
  return (
    <Tooltip title={title}>
      <Button size="small" className="task-ops-power" type={on ? 'primary' : 'default'} icon={<PowerIcon />} onClick={onClick}>
        {on ? '停止' : '启动'}
      </Button>
    </Tooltip>
  )
}

function DayMailEditor({ task, day, globalMail, msg, onSave }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  if (!day) return null
  const fallback = flightMailFallback(task, globalMail) || globalMail
  const explicit = mailParts(emailForDay(task, day))
  const usingDefault = !explicit.length || sameMail(explicit.join(','), fallback)
  const base = usingDefault ? [] : explicit
  const chips = base
  const defaultHint = !fallback
    ? '通知管理里还没有默认收件人'
    : usingDefault
      ? `不填就发给默认收件人 ${fallback}`
      : '再添加会加在现有收件人后面'

  const write = async (nextParts, note) => {
    setBusy(true)
    try {
      await onSave(task, day, dayMailPayload(nextParts, task, globalMail))
      msg.success(note)
      setDraft('')
      setOpen(false)
    } catch (e) {
      msg.error(e.message)
    } finally {
      setBusy(false)
    }
  }

  const addRecipient = () => {
    const addr = draft.trim()
    if (mailParts(addr).length !== 1 || /[,，;；\s]/.test(addr)) {
      msg.error('一次加一个邮箱')
      return
    }
    const known = base.some((item) => item.toLowerCase() === addr.toLowerCase())
    const alreadyDefault = usingDefault && mailParts(fallback).some((item) => item.toLowerCase() === addr.toLowerCase())
    if (known || alreadyDefault) {
      msg.warning(alreadyDefault ? '不填就会发给这个默认收件人' : '这一天已经有这个收件人')
      return
    }
    write([...base, addr], `已把 ${addr} 加到 ${monitorDayLabel(day)}`)
  }

  const removeRecipient = (addr) => {
    const rest = base.filter((item) => item.toLowerCase() !== addr.toLowerCase())
    if (rest.length) {
      write(rest, `已从 ${monitorDayLabel(day)} 去掉 ${addr}`)
      return
    }
    write([], `已去掉 ${addr}，${monitorDayLabel(day)} 改回默认收件人`)
  }

  return (
    <>
      {chips.map((addr) => (
        <Tag
          key={addr}
          color="gold"
          closable={!busy}
          style={{ marginInlineEnd: 0 }}
          onClose={(event) => {
            event.preventDefault()
            removeRecipient(addr)
          }}
        >
          {addr}
        </Tag>
      ))}
      <Popover
        open={open}
        trigger="click"
        title={`添加到 ${monitorDayLabel(day)}`}
        onOpenChange={(next) => { if (!busy) setOpen(next) }}
        content={(
          <div className="mail-add-pop">
            <div className="mail-add-hint">{defaultHint}</div>
            <Space.Compact>
            <Input
              size="small"
              style={{ width: 220 }}
              placeholder="name@example.com"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={addRecipient}
            />
            <Button size="small" type="primary" loading={busy} onClick={addRecipient}>添加</Button>
            </Space.Compact>
          </div>
        )}
      >
        <Button size="small" type="link" className="task-mail-add">添加</Button>
      </Popover>
    </>
  )
}

function MailField({ value, onChange, fallback, msg, disabled }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const current = mailParts(value)
  const usingDefault = !current.length || sameMail(current.join(','), fallback)
  const base = usingDefault ? [] : current
  const shown = usingDefault ? [] : current
  const commit = (next) => {
    onChange?.(sameMail(next.join(','), fallback) ? '' : next.join(','))
  }
  const addRecipient = () => {
    const addr = draft.trim()
    if (mailParts(addr).length !== 1 || /[,，;；\s]/.test(addr)) {
      msg.error('一次加一个邮箱')
      return
    }
    const known = base.some((item) => item.toLowerCase() === addr.toLowerCase())
    const alreadyDefault = usingDefault && mailParts(fallback).some((item) => item.toLowerCase() === addr.toLowerCase())
    if (known || alreadyDefault) {
      msg.warning(alreadyDefault ? '不填就会发给这个默认收件人' : '已经有这个收件人')
      return
    }
    commit([...base, addr])
    setDraft('')
    setOpen(false)
  }
  const removeRecipient = (addr) => {
    const base = current.length ? current : mailParts(fallback)
    const rest = base.filter((item) => item.toLowerCase() !== addr.toLowerCase())
    if (!rest.length) {
      if (!mailParts(fallback).length || sameMail(base.join(','), fallback)) {
        msg.warning(fallback ? `这是默认收件人 ${fallback}，不能删掉` : '至少留一个收件人')
        return
      }
      commit(mailParts(fallback))
      return
    }
    commit(rest)
  }
  return (
    <div className="mail-field">
      {shown.map((addr) => (
        <Tag
          key={addr}
          color="gold"
          closable={!disabled}
          style={{ marginInlineEnd: 0 }}
          onClose={(event) => {
            event.preventDefault()
            if (!disabled) removeRecipient(addr)
          }}
        >
          {addr}
        </Tag>
      ))}
      <Popover
        open={open && !disabled}
        trigger="click"
        title="添加收件人"
        onOpenChange={(next) => { if (!disabled) setOpen(next) }}
        content={(
          <div className="mail-add-pop">
            <div className="mail-add-hint">{!fallback ? '通知管理里还没有默认收件人' : usingDefault ? `不填就发给默认收件人 ${fallback}` : '再添加会加在现有收件人后面'}</div>
            <Space.Compact>
            <Input
              size="small"
              style={{ width: 220 }}
              placeholder="name@example.com"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onPressEnter={addRecipient}
            />
            <Button size="small" type="primary" onClick={addRecipient}>添加</Button>
            </Space.Compact>
          </div>
        )}
      >
        <Button size="small" type="link" className="task-mail-add" disabled={disabled}>添加</Button>
      </Popover>
    </div>
  )
}

function Tasks({ data, onChanged, msg, onGo, onOpenDetail, tierBlockRules }) {
  const tasks = data.tasks || []
  const globalMail = String(data?.config?.notify_channels?.email?.receiver || '').trim()
  // 「只能查/显示当天及以后」：过去日期从所有可选池剔除（编辑弹窗日期选项、档位联动、兜底池）
  const todayStr = dayjs().format('YYYY-MM-DD')

  const saveDayMail = async (task, day, notifyEmail) => {
    await api.updateTasks(task.ids || [task.id], {
      notify_email: notifyEmail,
      notify_email_dates: [day],
    })
    onChanged()
  }

  const toggleEnabled = async (t, enabled, dates) => {
    try {
      await api.setTaskEnabled(t.ids || [t.id], enabled, dates)
      const oneDay = dates && dates.length === 1
      msg.success(enabled ? (oneDay ? '这一天的监控已开启' : '监控已开启') : (oneDay ? '已停止这一天，其他日期继续监控' : '监控已停止'))
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const groupState = (group) => {
    let on = 0
    let off = 0
    group.legs.forEach(({ task: t, dates }) => {
      const paused = new Set(t.disabled_dates || [])
      dates.forEach((day) => { if (paused.has(day)) off += 1; else on += 1 })
    })
    return off === 0 ? 'on' : on === 0 ? 'off' : 'partial'
  }

  const deleteGroup = async (group) => {
    try {
      for (const { task: t, dates } of group.legs) {
        const drop = new Set(dates)
        const rest = (t.dates || []).filter((day) => !drop.has(day))
        if (rest.length) await api.updateTasks(t.ids || [t.id], { dates: rest })
        else await api.deleteTask(t.ids || [t.id])
      }
      msg.success(`已删除 ${group.label} 这组往返，其他日期还在`)
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const [pairEdit, setPairEdit] = useState(null)
  const [pairOpts, setPairOpts] = useState({ out: [], back: [], loading: false })
  const [pairBusy, setPairBusy] = useState(false)
  const [pairForm] = Form.useForm()
  const pairOutDate = Form.useWatch('outDate', pairForm)
  const pairMailScope = Form.useWatch('mail_scope', pairForm)
  useEffect(() => {
    if (!pairEdit || !pairOutDate) return
    const back = pairForm.getFieldValue('backDate')
    if (back && back <= pairOutDate) {
      pairForm.setFieldsValue({ backDate: pairOpts.back.find((day) => day > pairOutDate) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairOutDate])
  useEffect(() => {
    if (!pairEdit || !pairOutDate) return
    const back = pairForm.getFieldValue('backDate')
    if (back && back <= pairOutDate) {
      pairForm.setFieldsValue({ backDate: pairOpts.back.find((day) => day > pairOutDate) })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairOutDate])

  const openPairEdit = async (group, req) => {
    const out = req.outTask
    setPairEdit({ group, req })
    setPairOpts({ out: [], back: [], loading: true })
    pairForm.setFieldsValue({
      outDate: req.outDate,
      backDate: req.backDate,
      tiers: out.tiers || [],
      min_seats: Number(out.min_seats || 1),
      cabins: out.cabins || [],
      notify_email: emailForDay(out, req.outDate) || emailForDay(req.backTask, req.backDate),
      mail_scope: 'pair',
    })
    const safe = (task) => loadFlightDates(task).catch(() => [])
    const [outDates, backDates] = await Promise.all([safe(out), safe(req.backTask)])
    const keep = (task, list) => {
      const pool = filterTierDates(list.length ? list : (task.dates || []), String(task.product || ''), tierBlockRules)
      return [...new Set(pool)].filter((d) => d >= todayStr).sort()
    }
    setPairOpts({ out: keep(out, outDates), back: keep(req.backTask, backDates) })
  }

  const savePairEdit = async () => {
    let v
    try {
      v = await pairForm.validateFields()
    } catch (e) { return }
    const { req } = pairEdit
    const nextDates = (task, oldDay, newDay) => (
      [...new Set([...(task.dates || []).filter((day) => day !== oldDay), newDay])].sort()
    )
    const mail = v.notify_email || ''
    const shared = {
      tiers: v.tiers || [],
      min_seats: Number(v.min_seats || 1),
      cabins: v.cabins || [],
    }
    const outExtra = v.mail_scope === 'flight'
      ? { ...shared, notify_email: mail }
      : { ...shared, notify_email: mail, notify_email_dates: [v.outDate] }
    const backExtra = v.mail_scope === 'flight'
      ? { ...shared, notify_email: mail }
      : { ...shared, notify_email: mail, notify_email_dates: [v.backDate] }
    const outFlight = req.outTask.flight_no
    const backFlight = req.backTask.flight_no
    const outPayload = { dates: nextDates(req.outTask, req.outDate, v.outDate), ...outExtra }
    const backPayload = { dates: nextDates(req.backTask, req.backDate, v.backDate), ...backExtra }
    if (outFlight && backFlight) {
      outPayload.round_pairs = { [v.outDate]: { role: 'out', mate_date: v.backDate, mate_flight: backFlight } }
      backPayload.round_pairs = { [v.backDate]: { role: 'back', mate_date: v.outDate, mate_flight: outFlight } }
    }
    setPairBusy(true)
    try {
      await api.updateTasks(req.outTask.ids || [req.outTask.id], outPayload)
      await api.updateTasks(req.backTask.ids || [req.backTask.id], backPayload)
      msg.success('往返监控已更新')
      setPairEdit(null)
      onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setPairBusy(false)
    }
  }

  const routeIds = (row) => [...new Set(row.legs.flatMap((t) => t.ids || [t.id]))]
  const routeActive = (row) => row.legs.some((t) => {
    const dates = t.dates || []
    const paused = new Set(t.disabled_dates || [])
    if (!dates.length) return t.enabled !== false
    return dates.some((day) => !paused.has(day))
  })
  const toggleRoute = async (row, enabled) => {
    try {
      await api.setTaskEnabled(routeIds(row), enabled)
      msg.success(enabled ? '整条航线已重新监控' : '整条航线已停止')
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const deleteRoute = async (row) => {
    try {
      await api.deleteTask(routeIds(row))
      msg.success(`已删除整条航线：${routeTitle(row)}`)
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const toggleGroup = async (group, enabled) => {
    try {
      for (const { task: t, dates } of group.legs) {
        if (dates.length) await api.setTaskEnabled(t.ids || [t.id], enabled, dates)
      }
      msg.success(enabled ? `${group.label} 往返已开启监控` : `${group.label} 往返已停止，其他日期继续监控`)
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const doDelete = async (t, day) => {
    try {
      const rest = (t.dates || []).filter((item) => item !== day)
      if (!day || !rest.length) {
        await api.deleteTask(t.ids || [t.id])
        msg.success(`已删除监控：${t.from_city} → ${t.to_city}`)
      } else {
        await api.updateTasks(t.ids || [t.id], { dates: rest })
        msg.success(`已删除 ${monitorDayLabel(day)}，其他日期还在`)
      }
      onChanged()
    } catch (e) { msg.error(e.message) }
  }

  const [returnSource, setReturnSource] = useState(null)
  const [returnGroups, setReturnGroups] = useState([])
  const [returnLoading, setReturnLoading] = useState(false)
  const [returnBusy, setReturnBusy] = useState(false)

  const openReturn = async (t) => {
    setReturnSource(t)
    setReturnGroups([])
    setReturnLoading(true)
    try {
      const r = await api.flightQuery({
        from: cityNameOf(t.to_city || t.to_code),
        to: cityNameOf(t.from_city || t.from_code),
        limit: 300,
      })
      const legs = [{
        dep_time: t.dep_time,
        arr_time: t.arr_time,
        selected: (t.dates || []).filter((d) => d >= todayStr),
      }]
      const groups = recordsToMonitorGroups(r.records || [], tierBlockRules, todayStr).map((g) => {
        const selected = suggestReturnDates(legs, g.dates)
        return { ...g, direction: 'back', selected, checked: selected.length > 0 }
      })
      setReturnGroups(groups)
      if (!groups.length) msg.info('没有找到回程航班。')
    } catch (e) {
      msg.error(e.message)
    } finally {
      setReturnLoading(false)
    }
  }

  const confirmReturn = async () => {
    const source = returnSource
    if (!source) return
    const outDays = (source.dates || []).filter((day) => day >= todayStr && !pairInfo(source, day))
    const backChoices = returnGroups
      .filter((g) => g.checked && (g.selected || []).length)
      .flatMap((g) => (g.selected || []).map((day) => ({
        group: g,
        day,
        flight: g.rows[0]?.flight_no || g.flight_no || '',
        dep: g.dep_time || '',
      })))
    const linked = matchRoundTrips(
      outDays.map((day) => ({ day, flight: source.flight_no || '' })),
      backChoices,
    )
    const pairsByGroup = new Map()
    linked.forEach(({ out, back }) => {
      const current = pairsByGroup.get(back.group) || {}
      current[back.day] = { role: 'back', mate_date: out.day, mate_flight: out.flight }
      pairsByGroup.set(back.group, current)
    })
    const items = returnGroups
      .filter((g) => g.checked && (g.selected || []).length)
      .map((g) => {
        const row = g.rows[0] || {}
        const item = {
          from_code: g.from_iata || row.origin?.iata,
          to_code: g.to_iata || row.dest?.iata,
          dates: g.selected,
          product: g.product,
          tiers: source.tiers || [],
          flight_no: row.flight_no || g.flight_no || '',
          dep_time: g.dep_time || '',
          arr_time: g.arr_time || '',
        }
        if (pairsByGroup.has(g)) item.round_pairs = pairsByGroup.get(g)
        if (Number(source.min_seats) >= 2) item.min_seats = source.min_seats
        if (source.cabins && source.cabins.length) item.cabins = source.cabins
        return item
      })
    if (!items.length) {
      msg.error('请至少勾选一个回程航班，并保留一个日期。')
      return
    }
    setReturnBusy(true)
    try {
      const r = await api.addTasksBatch(items)
      if (linked.length) {
        const outboundPairs = {}
        linked.forEach(({ out, back }) => {
          outboundPairs[out.day] = { role: 'out', mate_date: back.day, mate_flight: back.flight }
        })
        await api.updateTasks(source.ids || [source.id], { round_pairs: outboundPairs })
      }
      msg.success(r.message || '回程监控已创建')
      setReturnSource(null)
      if (onChanged) onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setReturnBusy(false)
    }
  }

  // ---- 编辑弹窗 ----
  const [editRow, setEditRow] = useState(null) // 当前编辑的分组行（null=关闭）
  const [editDay, setEditDay] = useState('')
  const [editBusy, setEditBusy] = useState(false)
  const [dateOpts, setDateOpts] = useState([]) // 该航线真实可飞日期（编辑弹窗日期选项，逐日）
  const [dateLoading, setDateLoading] = useState(false)
  const [editForm] = Form.useForm()
  // 档位条件（多选白名单，空=不限）：编辑弹窗日期池随其联动（档位×日期规则，如 666 节假日不可用）
  const editTiers = Form.useWatch('tiers', editForm)
  const editMailScope = Form.useWatch('mail_scope', editForm)
  const [routeEdit, setRouteEdit] = useState(null)
  const [routeBusy, setRouteBusy] = useState(false)
  const [routeForm] = Form.useForm()
  const routeUnifyMail = Form.useWatch('unify_mail', routeForm)

  const openRouteEdit = (row) => {
    const legs = row.legs || []
    const tiers = listsMatch(legs, (t) => t.tiers || [])
    const seats = listsMatch(legs, (t) => Number(t.min_seats || 1))
    const cabins = listsMatch(legs, (t) => t.cabins || [])
    const mail = listsMatch(legs, (t) => String(t.notify_email || '').trim())
    const dayMail = legs.some((t) => Object.values(t.notify_email_by_date || {}).some((addr) => String(addr || '').trim()))
    setRouteEdit({ row, dayMail, mixed: !tiers.same || !seats.same || !cabins.same || !mail.same })
    routeForm.setFieldsValue({
      tiers: tiers.same ? tiers.value : [],
      min_seats: seats.same ? seats.value : 1,
      cabins: cabins.same ? cabins.value : [],
      notify_email: mail.same ? mail.value : '',
      unify_mail: !dayMail && mail.same,
    })
  }

  const saveRouteEdit = async () => {
    let v
    try {
      v = await routeForm.validateFields()
    } catch (e) { return }
    const payload = {
      tiers: v.tiers || [],
      min_seats: Number(v.min_seats || 1),
      cabins: v.cabins || [],
    }
    if (v.unify_mail) payload.notify_email = v.notify_email || ''
    setRouteBusy(true)
    try {
      const r = await api.updateTasks(routeIds(routeEdit.row), payload)
      msg.success(r.message || '整条航线的提醒条件已更新')
      setRouteEdit(null)
      onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setRouteBusy(false)
    }
  }

  // 拉取该航线真实可飞日期（/api/flights/query 的 effective_dates 区间展开成逐日），作为编辑弹窗日期选项；
  // 只保留可飞日期：原任务里无效日期在打开弹窗时剔除
  const ensureDateOpts = async (t) => {
    setDateLoading(true)
    try {
      // 档位×日期规则（tier_block_rules，如 666 档十一/五一/暑运不可用）不在拉取时固化，
      // 由渲染层按弹窗内「档位条件」实时过滤（见 dateOptions / 联动 useEffect）
      const dates = await loadFlightDates(t)
      setDateOpts(dates)
      if (dates.length) {
        const cur = (editForm.getFieldValue('dates') || []).map((d) => String(d).trim()).filter((d) => dates.includes(d))
        editForm.setFieldsValue({ dates: cur })
      }
    } catch (e) {
      // 拉取失败静默：日期选项回退为原任务日期，用户仍可查看/保存
      setDateOpts([])
    } finally {
      setDateLoading(false)
    }
  }

  const openEdit = async (t, day) => {
    setEditRow(t)
    setEditDay(day || '')
    ensureDateOpts(t)
    editForm.setFieldsValue({
      flight_no: t.flight_no || '',
      dep_time: t.dep_time || '',
      arr_time: t.arr_time || '',
      dates: t.dates || [],
      tiers: t.tiers || [],
      min_seats: Number(t.min_seats || 1),
      cabins: t.cabins || [],
      notify_email: day ? emailForDay(t, day) : (t.notify_email || ''),
      mail_scope: day ? 'day' : 'flight',
    })
  }

  const doUpdate = async () => {
    let v
    try {
      v = await editForm.validateFields()
    } catch (e) { return }
    const dates = (v.dates || []).map((d) => String(d).trim()).filter(Boolean)
    if (!dates.length) {
      msg.error('至少保留一个监控日期')
      return
    }
    setEditBusy(true)
    try {
      const payload = {
        dates,
        tiers: v.tiers || [],
        min_seats: Number(v.min_seats || 1),
        cabins: v.cabins || [],
        notify_email: v.notify_email || '',
      }
      if (v.mail_scope === 'day' && editDay) payload.notify_email_dates = [editDay]
      const r = await api.updateTasks(editRow.ids, payload)
      msg.success(r.message || '已更新监控任务')
      setEditRow(null)
      onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setEditBusy(false)
    }
  }

  // 档位×日期规则生效档位：弹窗内「档位条件」有值用其值，空=不限→按任务产品档位计算
  const editEffTiers = (() => {
    if (editTiers && editTiers.length) return editTiers
    return String(editRow?.product || '').split('/').map((s) => s.trim()).filter(Boolean)
  })()

  // 编辑弹窗日期选项：正常为该航线可飞日期；拉取失败时回退为原任务日期（保证可保存）
  const dateOptions = (() => {
    const pool = filterTierDates(dateOpts.length ? dateOpts : (editRow?.dates || []), editEffTiers.join('/'), tierBlockRules).filter((d) => d >= todayStr)
    return [...new Set(pool)].sort().map((d) => ({ value: d, label: d }))
  })()

  // 档位条件变化时，剔除已被档位×日期规则禁用的已选日期（如 666 档节假日不可用）
  useEffect(() => {
    if (!editRow) return
    const cur = (editForm.getFieldValue('dates') || []).map((d) => String(d).trim()).filter(Boolean)
    const pool = filterTierDates(dateOpts.length ? dateOpts : (editRow?.dates || []), editEffTiers.join('/'), tierBlockRules).filter((d) => d >= todayStr)
    const allowed = new Set(pool)
    const kept = cur.filter((d) => allowed.has(d))
    if (kept.length !== cur.length) editForm.setFieldsValue({ dates: kept })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editTiers, editRow, dateOpts])

  const stopTag = (t) => {
    const s = t.stop
    if (!s || typeof s !== 'object') return null
    if (s.kind === 'stopover') return <Tag color="orange">经停</Tag>
    if (s.kind === 'transfer') return <Tag color="purple">中转{s.legs || ''}段</Tag>
    if (s.kind === 'direct') return <Tag>直飞</Tag>
    return null
  }

  // 经停详情小字（参考航线查询经停列）：城市 · 机场 · 航站楼　到→离（停留）
  const stopDetail = (t) => {
    const s = t.stop
    if (!s || typeof s !== 'object' || s.kind !== 'stopover') return ''
    const details = s.stops_detail || []
    if (!details.length) {
      const via = (s.via || []).join('/')
      return via ? `经停 · ${via}` : ''
    }
    return details
      .map((d) => {
        const where = [d.city, d.airport ? `${d.airport}机场` : '', d.terminal].filter(Boolean).join(' · ')
        return `${where}${d.arrive ? `　${d.arrive}→${d.depart || '?'}${d.stay ? `（${d.stay}）` : ''}` : ''}`
      })
      .join('；')
  }

  const taskRows = useMemo(() => pairMonitorRows(tasks), [tasks])
  const legKey = (t) => (t.ids || [t.id]).join('-')
  const shortDates = (dates) => {
    const list = dates || []
    if (!list.length) return '未选日期'
    const shown = list.slice(0, 4).map((d) => monitorDayLabel(d))
    const rest = list.length - shown.length
    return `${shown.join('、')}${rest ? ` +${rest}` : ''}`
  }
  const routeTitle = (row) => {
    const trip = monitorTripGroups(row.legs).find((group) => group.roundReq)
    const lead = trip?.roundReq?.outTask || row.legs[0]
    const from = cityWithProvince(lead.from_city || lead.from_code)
    const to = cityWithProvince(lead.to_city || lead.to_code)
    return row.bothWays ? `${from} ↔ ${to}` : `${from} → ${to}`
  }

  return (
    <div>
      {!globalMail ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="通知管理里还没设默认收件人，所以每条都会显示邮箱"
          action={<Button size="small" type="link" onClick={() => onGo('notify')}>去设置</Button>}
        />
      ) : null}
      <Card
        className="task-board"
        title={`监控任务 · ${tasks.length} 班 · ${taskRows.length} 条航线`}
        extra={
          <Space>
            <Button type="primary" ghost icon={<CompassIcon />} onClick={() => onGo('flights')}>去航线查询添加</Button>
          </Space>
        }
      >
        {taskRows.length === 0 ? (
          <Empty description="还没有监控任务">
            <Button type="primary" icon={<CompassIcon />} onClick={() => onGo('flights')}>
              去航线查询添加
            </Button>
          </Empty>
        ) : (
          <div className="task-groups">
            {taskRows.map((row) => {
              const rowOn = routeActive(row)
              const mailSummary = routeMailSummary(row, globalMail)
              return (
              <section key={row.key} className="task-group">
                <header className="task-group-head">
                  <b>{routeTitle(row)}</b>
                  <Tag color={row.paired ? 'green' : 'default'} style={{ marginInlineEnd: 0 }}>{row.paired ? '往返' : '单程'}</Tag>
                  <span>{row.legs.length} 班</span>
                  {mailSummary.kinds.length ? (
                    <Tooltip title={mailSummary.lines.map((line) => <div key={line}>{line}</div>)}>
                      <Tag color="gold" style={{ marginInlineEnd: 0 }}>邮件 {mailSummary.kinds.length} 种收件人</Tag>
                    </Tooltip>
                  ) : null}
                  <div className="task-flight-ops task-group-actions">
                    <div className="task-ops-links" />
                    <TaskPowerButton
                      on={rowOn}
                      title={rowOn ? '停止这条航线的全部航班和日期' : '重新监控这条航线的全部航班和日期'}
                      onClick={() => toggleRoute(row, !rowOn)}
                    />
                    <div className="task-ops-icon">
                      <Tooltip title="统一这条航线的收件人、档位和余票条件">
                        <Button size="small" type="text" icon={<EditIcon />} aria-label={`统一 ${routeTitle(row)} 的提醒条件`} onClick={() => openRouteEdit(row)} />
                      </Tooltip>
                    </div>
                    <div className="task-ops-icon">
                      <Popconfirm
                        title={`删除整条航线 ${routeTitle(row)}`}
                        description="去程、回程和所有日期一起删掉。价格历史保留，不可撤销。"
                        okText="删除"
                        cancelText="取消"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => deleteRoute(row)}
                      >
                        <Tooltip title="删除">
                          <Button size="small" type="text" danger icon={<DeleteIcon />} aria-label={`删除 ${routeTitle(row)}`} />
                        </Tooltip>
                      </Popconfirm>
                    </div>
                  </div>
                </header>
                {monitorTripGroups(row.legs).map((group) => {
                  const roundReq = group.roundReq
                  const pairState = roundReq ? groupState(group) : 'on'
                  const pairOn = pairState !== 'off'
                  const outCount = group.legs.filter((leg) => leg.task.leg === 'out').length
                  return (
                  <div key={group.key}>
                    <div className="task-date">
                      <div className="task-date-label">
                        <b>{group.label}</b>
                        {group.stay ? <span>{group.stay}</span> : null}
                        {roundReq ? (
                          pairState === 'on' ? <Tag color="green" style={{ marginInlineEnd: 0 }}>往返监控中</Tag>
                            : pairState === 'off' ? <Tag style={{ marginInlineEnd: 0 }}>往返已停止</Tag>
                              : <Tag color="orange" style={{ marginInlineEnd: 0 }}>部分停止</Tag>
                        ) : row.bothWays ? <Tag style={{ marginInlineEnd: 0 }}>单程</Tag> : null}
                      </div>
                      {roundReq ? (
                        <div className="task-flight-ops">
                          <div className="task-ops-links">
                            <Button size="small" type="link" className="task-ops-link" onClick={() => onOpenDetail && onOpenDetail(roundReq)}>往返详情</Button>
                          </div>
                          <TaskPowerButton
                            on={pairOn}
                            title={pairOn
                              ? (outCount > 1 ? '停止这个周末的全部去程和回程，其他日期不受影响' : '停止监控这组往返（去程、回程一起），其他日期不受影响')
                              : (outCount > 1 ? '重新监控这个周末的全部去程和回程' : '重新监控这组往返（去程、回程一起）')}
                            onClick={() => toggleGroup(group, !pairOn)}
                          />
                          <div className="task-ops-icon">
                            <Tooltip title="编辑这组往返（改日期、提醒条件）">
                              <Button size="small" type="text" icon={<EditIcon />} aria-label={`编辑 ${group.label} 往返`} onClick={() => openPairEdit(group, roundReq)} />
                            </Tooltip>
                          </div>
                          <div className="task-ops-icon">
                            <Popconfirm
                              title={`删除 ${group.label} 这组往返`}
                              description={outCount > 1 ? '这几套去程和同一个回程一起删掉，其他日期继续留在列表里。' : '去程、回程这几天一起删掉，其他日期继续留在列表里。'}
                              okText="删除"
                              cancelText="取消"
                              okButtonProps={{ danger: true }}
                              onConfirm={() => deleteGroup(group)}
                            >
                              <Tooltip title="删除这组往返">
                                <Button size="small" type="text" danger icon={<DeleteIcon />} aria-label={`删除 ${group.label} 往返`} />
                              </Tooltip>
                            </Popconfirm>
                          </div>
                        </div>
                      ) : null}
                    </div>
                    {group.legs.flatMap(({ task: t, dates: legDates }) => {
                  const shownDates = legDates.length ? legDates : [null]
                  return shownDates.map((day) => {
                  const dates = day ? [day] : []
                  const products = String((day && t.product_by_date && t.product_by_date[day]) || t.product || '').split('/').map((s) => s.trim()).filter(Boolean)
                  const paused = new Set(t.disabled_dates || [])
                  const rowOn = day ? !paused.has(day) : t.enabled !== false
                  const seatBits = []
                  if (Number(t.min_seats || 1) > 1) seatBits.push(`≥${t.min_seats}张`)
                  if (t.cabins && t.cabins.length) seatBits.push(t.cabins.join('/'))
                  return (
                    <div key={`${group.key}-${legKey(t)}-${day || 'none'}`} className={`task-flight${rowOn ? '' : ' is-paused'}`}>
                      <div className="task-flight-main">
                        <div className="task-flight-line">
                          {t.leg === 'out' || t.leg === 'back' ? (
                            <Tag color={t.leg === 'back' ? 'blue' : 'gold'} style={{ marginInlineEnd: 0 }}>{t.leg === 'back' ? '回程' : (t.outNo ? `去程${t.outNo}` : '去程')}</Tag>
                          ) : row.bothWays ? (
                            <Tag style={{ marginInlineEnd: 0 }}>{t.from_city || t.from_code}→{t.to_city || t.to_code}</Tag>
                          ) : null}
                          <span className="mono task-flight-no">{t.flight_no || '—'}</span>
                          <span className="mono task-flight-time">{t.dep_time || '--:--'} → {t.arr_time || '--:--'}</span>
                          <Tooltip title={(t.dates || []).join('、') || '未选日期'}>
                            <span className="task-flight-dates">{shortDates(dates)}</span>
                          </Tooltip>
                          {t.legStay ? <span className="task-flight-dates">{t.legStay}</span> : null}
                        </div>
                        <div className="task-flight-meta">
                          {products.map((p) => <Tag key={p} color={p === '666' ? 'gold' : 'purple'} style={{ marginInlineEnd: 0 }}>{p}</Tag>)}
                          <span className="task-flight-price">¥199</span>
                          {rowOn ? <Tag color="green" style={{ marginInlineEnd: 0 }}>监控中</Tag> : <Tag style={{ marginInlineEnd: 0 }}>已停止</Tag>}
                          {(t.tiers || []).map((p) => <Tag key={p} style={{ marginInlineEnd: 0 }}>提醒 {p}</Tag>)}
                          {seatBits.map((bit) => <Tag key={bit} color="blue" style={{ marginInlineEnd: 0 }}>{bit}</Tag>)}
                          {stopTag(t)}
                          <DayMailEditor task={t} day={day} globalMail={globalMail} msg={msg} onSave={saveDayMail} />
                          {stopDetail(t) ? <span className="task-flight-dates">{stopDetail(t)}</span> : null}
                        </div>
                      </div>
                      <div className="task-flight-ops">
                        <div className="task-ops-links">
                          {day ? (isPhone() ? (
                            <Button size="small" type="link" className="task-ops-link" onClick={() => openHnaApp(t, day, msg)}>打开 App</Button>
                          ) : (
                            <Button size="small" type="link" className="task-ops-link" href={officialWebUrl(t, day, false)} target="_blank" rel="noreferrer">跳到官网</Button>
                          )) : null}
                          <Button
                            size="small"
                            type="link"
                            className="task-ops-link"
                            disabled={!day}
                            onClick={() => onOpenDetail && onOpenDetail(taskDetailRequest(t, day))}
                          >
                            查看详情
                          </Button>
                          <Tooltip title="找对向航班，按去程日期的次日一起监控">
                            <Button size="small" type="link" className="task-ops-link" onClick={() => openReturn(t)}>回程</Button>
                          </Tooltip>
                        </div>
                        <TaskPowerButton
                          on={rowOn}
                          title={rowOn ? '停止这一天' : '重新监控这一天'}
                          onClick={() => toggleEnabled(t, !rowOn, dates)}
                        />
                        <div className="task-ops-icon">
                          <Tooltip title="编辑">
                            <Button size="small" type="text" icon={<EditIcon />} aria-label={`编辑 ${t.flight_no || '监控任务'}`} onClick={() => openEdit(t, day)} />
                          </Tooltip>
                        </div>
                        <div className="task-ops-icon">
                          <Popconfirm
                            title={day ? `删除 ${monitorDayLabel(day)} 这一天` : `删除监控 ${t.from_city} → ${t.to_city}`}
                            description={day && (t.dates || []).length > 1 ? '只删这一天，其他日期继续留在列表里。' : '删除后 daemon 将不再查询，价格历史保留。不可撤销。'}
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => doDelete(t, day)}
                          >
                            <Tooltip title="删除">
                              <Button size="small" type="text" danger icon={<DeleteIcon />} aria-label={`删除 ${t.flight_no || '监控任务'}`} />
                            </Tooltip>
                          </Popconfirm>
                        </div>
                      </div>
                    </div>
                  )
                  })
                    })}
                  </div>
                  )
                })}
              </section>
              )
            })}
          </div>
        )}
      </Card>

      <Modal
        open={!!returnSource}
        title={returnSource ? `同时监控回程：${cityWithProvince(shortCity(returnSource.to_city))} → ${cityWithProvince(shortCity(returnSource.from_city))}` : ''}
        width={680}
        okText="创建回程监控"
        okButtonProps={{ loading: returnBusy, disabled: returnLoading }}
        cancelText="取消"
        onCancel={() => setReturnSource(null)}
        onOk={confirmReturn}
        destroyOnClose
      >
        {returnSource && (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            去程 {returnSource.flight_no || ''} {cityWithProvince(shortCity(returnSource.from_city))} → {cityWithProvince(shortCity(returnSource.to_city))}
            ，已选 {(returnSource.dates || []).map((d) => String(d).slice(5)).join('、') || '—'}。
            回程按这些日期的第二天预选。第二天不飞的航班不会勾上，可以自己改日期。
          </Typography.Paragraph>
        )}
        {returnLoading ? <Spin /> : (
          <ReturnPickList
            groups={returnGroups}
            onToggle={(key, checked) => setReturnGroups((prev) => prev.map((x) => (x.key === key ? { ...x, checked, choicePinned: true } : x)))}
            onDates={(key, v) => setReturnGroups((prev) => prev.map((x) => (x.key === key ? { ...x, selected: v, checked: v.length > 0, returnTouched: true, choicePinned: true } : x)))}
          />
        )}
      </Modal>

      <Modal
        open={!!routeEdit}
        title={routeEdit ? `统一条件：${routeTitle(routeEdit.row)}` : ''}
        width={640}
        okText="保存"
        okButtonProps={{ loading: routeBusy }}
        cancelText="取消"
        onCancel={() => setRouteEdit(null)}
        onOk={saveRouteEdit}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
          这条航线上的航班都改成同一套提醒条件。航班号、时刻和日期不动。
        </Typography.Paragraph>
        {routeEdit?.mixed ? (
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="各班现在的条件不完全一样。保存后整条都按这里的档位、余票和舱位。" />
        ) : null}
        {routeEdit?.dayMail ? (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="有些日期单独指定了收件人。勾上「收件人也改成同一个」再保存，这些按天设置会被清掉。" />
        ) : null}
        <Form form={routeForm} layout="vertical">
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="tiers" label="档位条件（多选，空=不限）">
                <Select mode="multiple" placeholder="不限" options={TIER_OPTIONS} maxTagCount="responsive" />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="min_seats" label="余票条件">
                <Select
                  options={[
                    { label: '不限（有票即提醒）', value: 1 },
                    { label: '至少 2 张', value: 2 },
                    { label: '至少 3 张', value: 3 },
                    { label: '至少 4 张', value: 4 },
                    { label: '至少 5 张', value: 5 },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="cabins" label="舱位白名单（空=不限舱位）">
                <Select
                  mode="tags"
                  placeholder="如 B、C、Z、R…"
                  options={CABIN_OPTIONS.map((c) => ({ value: c, label: c }))}
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="unify_mail" valuePropName="checked" style={{ marginBottom: 8 }}>
            <Checkbox>收件人也改成同一个</Checkbox>
          </Form.Item>
          <Form.Item
            name="notify_email"
            label="邮件收件人"
            extra={globalMail ? `不填就发给默认收件人 ${globalMail}。填了就只发给填上的人。` : '不填就用通知管理里的收件人。填了就只发给填上的人。'}
            rules={[{
              validator: (_, value) => {
                const parts = String(value || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
                if (parts.some((part) => !part.includes('@'))) return Promise.reject(new Error('收件人要写成邮箱'))
                return Promise.resolve()
              },
            }]}
          >
            <MailField fallback={globalMail} msg={msg} disabled={!routeUnifyMail} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={!!editRow}
        title={editRow ? `编辑监控任务：${cityWithProvince(shortCity(editRow.from_city))} → ${cityWithProvince(shortCity(editRow.to_city))}${editRow.flight_no ? ` · ${editRow.flight_no}` : ''}` : ''}
        width={680}
        okText="保存"
        okButtonProps={{ loading: editBusy }}
        cancelText="取消"
        onCancel={() => setEditRow(null)}
        onOk={doUpdate}
        destroyOnClose={false}
      >
        <Form form={editForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item label="出发地（不可改）">
                <Input value={editRow ? cityWithProvince(shortCity(editRow.from_city || editRow.from_code)) : ''} disabled />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item label="到达地（不可改）">
                <Input value={editRow ? cityWithProvince(shortCity(editRow.to_city || editRow.to_code)) : ''} disabled />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="flight_no" label="航班号（不可改）">
                <Input disabled className="mono" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="dep_time" label="起飞时刻（不可改）">
                <Input disabled placeholder="HH:MM" className="mono" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="arr_time" label="到达时刻（不可改）">
                <Input disabled placeholder="HH:MM" className="mono" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="dates"
            label="监控日期"
            rules={[{ required: true, message: '至少保留一个监控日期' }]}
          >
            <DatePickCalendar dates={dateOptions.map((o) => o.value)} />
            {dateLoading ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在读取可飞日期…</Typography.Text> : null}
          </Form.Item>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="tiers" label="档位条件（多选，空=不限）" extra={<span style={{ fontSize: 12 }}>只提醒选中的档位；空=全部档位</span>}>
                <Select
                  mode="multiple"
                  placeholder="不限"
                  options={TIER_OPTIONS}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="min_seats" label="余票条件">
                <Select
                  options={[
                    { label: '不限（有票即提醒）', value: 1 },
                    { label: '至少 2 张', value: 2 },
                    { label: '至少 3 张', value: 3 },
                    { label: '至少 4 张', value: 4 },
                    { label: '至少 5 张', value: 5 },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="cabins" label="舱位白名单（空=不限舱位）">
                <Select
                  mode="tags"
                  placeholder="如 B、C、Z、R…"
                  options={CABIN_OPTIONS.map((c) => ({ value: c, label: c }))}
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="notify_email"
            label="邮件收件人"
            extra={(() => {
              const flightMail = String(editRow?.notify_email || '').trim()
              const blankTo = editMailScope === 'flight' ? globalMail : (flightMail || globalMail)
              return blankTo
                ? `不填就发给默认收件人 ${blankTo}。填了就只发给填上的人。`
                : '不填就用通知管理里的收件人。填了就只发给填上的人。'
            })()}
            rules={[{
              validator: (_, value) => {
                const parts = String(value || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
                if (parts.some((part) => !part.includes('@'))) return Promise.reject(new Error('收件人要写成邮箱'))
                return Promise.resolve()
              },
            }]}
          >
            <MailField
              msg={msg}
              fallback={(() => {
                const flightMail = String(editRow?.notify_email || '').trim()
                return editMailScope === 'flight' ? globalMail : (flightMail || globalMail)
              })()}
            />
          </Form.Item>
          <Form.Item name="mail_scope" label="收件人改动范围">
            <Radio.Group>
              {editDay ? <Radio value="day">只改 {monitorDayLabel(editDay)} 这一天</Radio> : null}
              <Radio value="flight">这个航班全部日期</Radio>
            </Radio.Group>
          </Form.Item>
          {editRow && (editRow.ids || []).length > 1 && (
            <Alert type="warning" showIcon message={`该组包含 ${editRow.ids.length} 条底层任务（同一航班的多个监控日期），保存将对组内全部任务生效。`} />
          )}
        </Form>
      </Modal>

      <Modal
        open={!!pairEdit}
        title={pairEdit ? `编辑往返：${cityWithProvince(shortCity(pairEdit.req.from))} ↔ ${cityWithProvince(shortCity(pairEdit.req.to))}` : ''}
        width={860}
        okText="保存"
        okButtonProps={{ loading: pairBusy }}
        cancelText="取消"
        onCancel={() => setPairEdit(null)}
        onOk={savePairEdit}
      >
        {pairEdit ? (
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
            原来是 {monitorDayLabel(pairEdit.req.outDate)} 去（{pairEdit.req.outFlight}）、{monitorDayLabel(pairEdit.req.backDate)} 回（{pairEdit.req.backFlight}）。
            改日期只换这一组，其他日期不动；提醒条件对去程、回程两条任务都生效。
          </Typography.Paragraph>
        ) : null}
        <Form form={pairForm} layout="vertical">
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="outDate" label={`去程日期${pairEdit ? ` · ${pairEdit.req.outFlight}` : ''}`} rules={[{ required: true, message: '请选择去程日期' }]}>
                <DatePickCalendar
                  single
                  dates={[...new Set([...(pairEdit ? [pairEdit.req.outDate] : []), ...pairOpts.out])].filter(Boolean).sort()}
                />
              </Form.Item>
              {pairOpts.loading ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>正在读取可飞日期…</Typography.Text> : null}
            </Col>
            <Col span={12}>
              <Form.Item
                name="backDate"
                label={`回程日期${pairEdit ? ` · ${pairEdit.req.backFlight}` : ''}`}
                dependencies={['outDate']}
                rules={[
                  { required: true, message: '请选择回程日期' },
                  ({ getFieldValue }) => ({
                    validator: (_, value) => (!value || value > getFieldValue('outDate') ? Promise.resolve() : Promise.reject(new Error('回程要晚于去程'))),
                  }),
                ]}
              >
                <DatePickCalendar
                  single
                  after={pairOutDate}
                  dates={[...new Set([...(pairEdit ? [pairEdit.req.backDate] : []), ...pairOpts.back])].filter(Boolean).sort()}
                />
              </Form.Item>
            </Col>
          </Row>
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="tiers" label="档位条件（空=不限）">
                <Select mode="multiple" placeholder="不限" options={TIER_OPTIONS} maxTagCount="responsive" />
              </Form.Item>
            </Col>
            <Col span={7}>
              <Form.Item name="min_seats" label="余票条件">
                <Select
                  options={[
                    { label: '不限（有票即提醒）', value: 1 },
                    { label: '至少 2 张', value: 2 },
                    { label: '至少 3 张', value: 3 },
                    { label: '至少 4 张', value: 4 },
                    { label: '至少 5 张', value: 5 },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col span={9}>
              <Form.Item name="cabins" label="舱位白名单（空=不限）">
                <Select
                  mode="tags"
                  placeholder="如 B、C、Z、R…"
                  options={CABIN_OPTIONS.map((c) => ({ value: c, label: c }))}
                  tokenSeparators={[',', '，']}
                  maxTagCount="responsive"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="notify_email"
            label="邮件收件人"
            extra={(() => {
              const outMail = pairMailScope === 'flight'
                ? globalMail
                : (String(pairEdit?.req?.outTask?.notify_email || '').trim() || globalMail)
              const backMail = pairMailScope === 'flight'
                ? globalMail
                : (String(pairEdit?.req?.backTask?.notify_email || '').trim() || globalMail)
              const blankTo = outMail && backMail && outMail !== backMail
                ? `去程 ${outMail}，回程 ${backMail}`
                : (outMail || backMail)
              return blankTo
                ? `不填就发给默认收件人 ${blankTo}。填了就只发给填上的人。`
                : '不填就用通知管理里的收件人。填了就只发给填上的人。'
            })()}
            rules={[{
              validator: (_, value) => {
                const parts = String(value || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
                if (parts.some((part) => !part.includes('@'))) return Promise.reject(new Error('收件人要写成邮箱'))
                return Promise.resolve()
              },
            }]}
          >
            <MailField msg={msg} fallback={(() => {
              const outMail = String(pairEdit?.req?.outTask?.notify_email || '').trim() || globalMail
              const backMail = String(pairEdit?.req?.backTask?.notify_email || '').trim() || globalMail
              return sameMail(outMail, backMail) ? outMail : ''
            })()} />
          </Form.Item>
          <Form.Item name="mail_scope" label="收件人改动范围">
            <Radio.Group>
              <Radio value="pair">只改这组往返</Radio>
              <Radio value="flight">去程回程全部日期</Radio>
            </Radio.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}

/* ================= 监控管理（票据 + 时段 + 高级设置） ================= */
function detectFareType(raw) {
  // PLUS 只认 ffl/airLowFareSearch。airCtLowFareSearch 不是 PLUS，不能改地址复用。
  const m = String(raw || '').match(/https?:\/\/[^\s'"]+/i)
  const path = m ? m[0] : ''
  if (path.includes('airCtLowFareSearch')) return 'invalid'
  if (path.includes('ffl')) return 'plus'
  if (path.includes('airLowFareSearch')) return 'normal'
  return ''
}

function TicketSetup({ cfg, onChanged, msg }) {
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

function MonitorSettings({ data, onChanged, msg }) {
  const cfg = data.config
  const [busy, setBusy] = useState('')
  const [start, setStart] = useState(() => dayjs(cfg.monitor_window?.start || '07:00', 'HH:mm'))
  const [end, setEnd] = useState(() => dayjs(cfg.monitor_window?.end || '23:00', 'HH:mm'))
  const [proxy, setProxy] = useState(cfg.proxy || '')
  const [signRefresh, setSignRefresh] = useState(cfg.sign_refresh || false)
  const [priceQueryOn, setPriceQueryOn] = useState(cfg.price_query?.enabled !== false)
  const [priceQueryInterval, setPriceQueryInterval] = useState(cfg.price_query?.min_interval || 8)
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

/* ================= 通知管理 ================= */
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
    ? `已配置：${fields.filter((f) => view?.[f.key]).map((f) => `${f.label} ${view[f.key]}`).join('；')}`
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

function Notifications({ data, onChanged, msg }) {
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

/* ================= 航线查询 ================= */
function fmtDays(days = []) {
  if (!days || !days.length) return '—'
  return days.join(',')
}

function weekDaysText(days = []) {
  const list = [...new Set(days || [])].sort((a, b) => a - b)
  if (!list.length) return '—'
  if (list.length === 7) return '每天'
  return `周${list.map((d) => '一二三四五六日'[d - 1]).join('')}`
}

function shortDateText(text = '') {
  return String(text).replace(/(\d{2})-(\d{2})/g, (_, m, d) => `${Number(m)}/${Number(d)}`).replace(/~/g, '–')
}

function fmtDateRanges(ranges = []) {
  if (!ranges || !ranges.length) return '—'
  return mergeRanges(ranges).map(([a, b]) => (a === b ? a.slice(5) : `${a.slice(5)}~${b.slice(5)}`)).join('、')
}

function flightGroupKey(rec) {
  return `${rec.flight_no || ''}|${rec.origin?.iata || ''}|${rec.dest?.iata || ''}`
}

function segmentKey(rec) {
  const dates = (rec.effective_dates || []).map((pair) => pair.join('~')).join(',')
  return `${flightGroupKey(rec)}|${rec.dep_time || ''}|${(rec.days || []).join('')}|${dates}`
}

function groupFlightRecords(records) {
  const groups = []
  const map = new Map()
  for (const rec of records || []) {
    const key = flightGroupKey(rec)
    let group = map.get(key)
    if (!group) {
      group = {
        key,
        flight_no: rec.flight_no,
        carrier: rec.carrier,
        origin: rec.origin,
        dest: rec.dest,
        leg: rec.leg || '',
        segments: [],
      }
      map.set(key, group)
      groups.push(group)
    }
    group.segments.push(rec)
  }
  return groups
}

function operatedDay(rec, prefer) {
  const days = new Set(rec.days || [])
  const ranges = rec.effective_dates || []
  const matches = (value) => {
    if (!value || !value.isValid()) return ''
    const ds = value.format('YYYY-MM-DD')
    const wd = value.day() === 0 ? 7 : value.day()
    const inRange = ranges.some(([a, b]) => ds >= a && ds <= b)
    if (inRange && (!days.size || days.has(wd)) && ds >= dayjs().format('YYYY-MM-DD')) return ds
    return ''
  }
  const preferred = matches(prefer)
  if (preferred) return preferred
  const todayHit = matches(dayjs())
  if (todayHit) return todayHit
  let cursor = dayjs()
  const limit = cursor.add(370, 'day')
  while (cursor.isBefore(limit)) {
    const hit = matches(cursor)
    if (hit) return hit
    cursor = cursor.add(1, 'day')
  }
  return (ranges[0] && ranges[0][0]) || dayjs().format('YYYY-MM-DD')
}

function seasonLabel(seg) {
  const season = String(seg?.season || '')
  const source = String(seg?.source || '')
  if (season.includes('冬春') || source.includes('winter')) return '冬春航班'
  return '夏秋航班'
}

function scheduleBlocks(segments) {
  const groups = []
  const map = new Map()
  for (const seg of segments || []) {
    const key = seg.dep_time || ''
    let block = map.get(key)
    if (!block) {
      block = { segments: [], days: new Set(), ranges: [], product: new Set(), seasons: new Set(), arr: '' }
      map.set(key, block)
      groups.push(block)
    }
    block.segments.push(seg)
    if (!block.arr && seg.arr_time) block.arr = seg.arr_time
    block.seasons.add(seasonLabel(seg))
    for (const day of seg.days || []) block.days.add(day)
    for (const pair of seg.effective_dates || []) block.ranges.push(pair)
    for (const part of String(seg.product || '').split('/')) if (part) block.product.add(part)
  }
  return groups.map((block) => {
    const ranges = [...block.ranges].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    let start = ranges[0] ? ranges[0][0] : ''
    let end = ranges[0] ? ranges[0][1] : ''
    let continuous = true
    for (const [a, b] of ranges) {
      if (start && a > end && dayjs(a).diff(dayjs(end), 'day') > 1) continuous = false
      if (!start || a < start) start = a
      if (b > end) end = b
    }
    const days = [...block.days].sort((a, b) => a - b)
    const base = block.segments[0]
    const record = {
      ...base,
      dep_time: base.dep_time || '',
      arr_time: block.arr || base.arr_time || '',
      days,
      effective_dates: start ? [[start, end]] : base.effective_dates,
      product: [...block.product].join('/'),
    }
    const dateText = !start ? '—' : (continuous ? `${start.slice(5)}~${end.slice(5)}` : fmtDateRanges(ranges))
    return { record, segments: block.segments, days, dateText, product: [...block.product], seasons: [...block.seasons] }
  })
}

function isPhone() {
  return /Android|iPhone|iPad|iPod|OpenHarmony/i.test(navigator.userAgent || '')
}

function officialWebUrl(rec, day, mobile) {
  const from = rec.origin?.iata || airportCodeOf(rec.from_code) || airportCodeOf(rec.from) || airportCodeOf(rec.from_city) || ''
  const to = rec.dest?.iata || airportCodeOf(rec.to_code) || airportCodeOf(rec.to) || airportCodeOf(rec.to_city) || ''
  if (mobile) {
    const params = new URLSearchParams({ depCode: from, dstCode: to, startTime: day, tripType: '1' })
    return `https://m.hnair.com/?${params}#/book/checkTiket`
  }
  const params = new URLSearchParams({
    orgCity: from,
    dstCity: to,
    takeoffDate: day,
    flightNo: rec.flight_no || '',
  })
  return `https://new.hnair.com/hainanair/ibe/common/flightSearch.do?${params}`
}

function openHnaApp(rec, day, msg) {
  const from = rec.origin?.iata || airportCodeOf(rec.from_code) || airportCodeOf(rec.from) || airportCodeOf(rec.from_city) || ''
  const to = rec.dest?.iata || airportCodeOf(rec.to_code) || airportCodeOf(rec.to) || airportCodeOf(rec.to_city) || ''
  const url = `hna2app://app.hnar.com?url=searchIndex&params={depCode:${from},dstCode:${to},startTime:${day},tripType:1}`
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent || '')
  const store = ios
    ? 'https://apps.apple.com/cn/app/id465617429'
    : 'https://app.hnair.com/mapp/download/phone_package_download.jsp?stages=standard'
  const start = Date.now()
  const timer = window.setTimeout(() => {
    if (document.hidden || Date.now() - start > 2500) return
    msg.info(ios ? '没有打开海航 App，正在前往 App Store' : '没有打开海航 App，正在前往下载页')
    window.location.href = store
  }, 1600)
  const cancel = () => window.clearTimeout(timer)
  window.addEventListener('pagehide', cancel, { once: true })
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel() }, { once: true })
  window.location.href = url
}

function cityNameOf(label) {
  // 「成都（CTU/TFU）·双流/天府」→「成都」；直接输入三字码/机场名则原样返回
  return String(label || '').split('（')[0].trim()
}

const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/* 班期日历（滑动翻月）：首屏为当月（限定在放票窗口内），左右/上下滑动或点箭头切月。
   ok=绿色✓可兑换，no=灰色班期不符，off=浅灰未放票。 */
function ScheduleCalendar({ rec }) {
  const ranges = rec.effective_dates || []
  const days = rec.days || []
  const now = dayjs()
  const todayStr = now.format('YYYY-MM-DD') // 过期判定：只允许查看当天及以后
  const startMonth = now.startOf('month')
  const winStart = ranges.length ? dayjs(ranges[0][0]).startOf('month') : startMonth
  const winEndRaw = ranges.length
    ? dayjs(ranges.reduce((m, [, b]) => (b > m ? b : m), ''))
    : now.endOf('year')
  const winEnd = winEndRaw.isAfter(now.endOf('year')) ? now.endOf('year') : winEndRaw
  const minMonth = winStart.isBefore(startMonth) ? startMonth : winStart
  const maxMonth = winEnd.startOf('month')
  const initial = startMonth.isBefore(minMonth) ? minMonth : startMonth.isAfter(maxMonth) ? maxMonth : startMonth
  const [view, setView] = useState(initial)
  const dragRef = useRef({ x: 0, y: 0, active: false })

  const go = (delta) => {
    setView((v) => {
      let nv = v.add(delta, 'month')
      if (nv.isBefore(minMonth)) nv = minMonth
      else if (nv.isAfter(maxMonth)) nv = maxMonth
      return nv
    })
  }

  const dragStart = (e) => {
    const pt = e.touches ? e.touches[0] : e
    dragRef.current = { x: pt.clientX, y: pt.clientY, active: true }
  }
  const dragEnd = (e) => {
    if (!dragRef.current.active) return
    const pt = e.changedTouches ? e.changedTouches[0] : e
    const dx = pt.clientX - dragRef.current.x
    const dy = pt.clientY - dragRef.current.y
    dragRef.current.active = false
    if (Math.abs(dx) >= Math.abs(dy) && Math.abs(dx) > 40) go(dx < 0 ? 1 : -1)
    else if (Math.abs(dy) > 40) go(dy < 0 ? 1 : -1) // 上滑=下一月
  }
  const cancelDrag = () => { dragRef.current.active = false }
  const onWheel = (e) => {
    // 仅接管横向滚轮/触控板横滑，避免影响模态框纵向滚动
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && Math.abs(e.deltaX) > 20) {
      go(e.deltaX > 0 ? -1 : 1)
    }
  }

  const statusOf = (d) => {
    const ds = d.format('YYYY-MM-DD')
    if (ds < todayStr) return 'past' // 已过期：只允许查看当天及以后
    const inRange = ranges.some(([a, b]) => ds >= a && ds <= b)
    if (!inRange) return 'off' // 未放票
    // dayjs 核心无 isoWeekday 插件：day() 周日=0 … 周六=6，换算为 周一=1 … 周日=7
    const iso = d.day() === 0 ? 7 : d.day()
    return days.includes(iso) ? 'ok' : 'no' // 班期不符
  }

  const first = view.startOf('month')
  const offset = (first.day() === 0 ? 7 : first.day()) - 1 // 周一排首位
  const cells = []
  for (let i = 0; i < offset; i++) cells.push(null)
  for (let d = 1; d <= view.daysInMonth(); d++) cells.push(first.date(d))
  while (cells.length % 7 !== 0) cells.push(null)

  const statusText = { past: '已过期（仅可查看当天及以后）', ok: '可兑换（班期+放票区间匹配）', no: '不可兑换（班期不符）', off: '未放票' }

  return (
    <div>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={`放票区间：${fmtDateRanges(ranges)}　班期：${fmtDays(days)}（周一=1 … 周日=7）`}
      />
      <div
        className="cal-wrap"
        role="grid"
        aria-label={`${view.format('YYYY年M月')}班期日历`}
        onTouchStart={dragStart}
        onTouchEnd={dragEnd}
        onTouchCancel={cancelDrag}
        onMouseDown={dragStart}
        onMouseUp={dragEnd}
        onMouseLeave={cancelDrag}
        onWheel={onWheel}
      >
        <div className="cal-head">
          <Button type="text" icon={<ChevronLeftIcon />} aria-label="查看上个月" disabled={view.isSame(minMonth, 'month')} onClick={() => go(-1)} />
          <div className="cal-title">{view.format('YYYY年M月')}</div>
          <Button type="text" icon={<ChevronRightIcon />} aria-label="查看下个月" disabled={view.isSame(maxMonth, 'month')} onClick={() => go(1)} />
        </div>
        <div className="cal-week">
          {WEEK_LABELS.map((w) => <div key={w}>{w}</div>)}
        </div>
        <div key={view.format('YYYY-MM')} className="cal-grid">
          {cells.map((d, i) => (
            d ? (
              <div
                key={i}
                className={`cal-cell cal-cell-${statusOf(d)}${d.isSame(now, 'day') ? ' cal-cell-today' : ''}`}
                title={statusText[statusOf(d)]}
                role="gridcell"
                aria-label={`${d.format('M月D日')}：${statusText[statusOf(d)]}`}
              >
                <span className="cal-num">{d.date()}</span>
                {statusOf(d) === 'ok' && <span className="cal-check" aria-hidden="true" />}
              </div>
            ) : (
              <div key={i} className="cal-cell cal-cell-blank" />
            )
          ))}
        </div>
        <div className="cal-legend">
          <span><i className="cal-dot cal-dot-ok" />可兑换</span>
          <span><i className="cal-dot cal-dot-no" />班期不符</span>
          <span><i className="cal-dot cal-dot-off" />未放票</span>
          <span><i className="cal-dot cal-dot-past" />已过期</span>
          <span className="cal-swipe-hint">左右/上下滑动切换月份</span>
        </div>
      </div>
    </div>
  )
}

function weekendBounds(index, today = dayjs()) {
  const day = today.day()
  const sat = day === 6
    ? today.startOf('day')
    : day === 0
      ? today.startOf('day').subtract(1, 'day')
      : today.startOf('day').add(6 - day, 'day')
  const start = sat.add(index * 7, 'day')
  return [start, endOfWeekend(start)]
}

function endOfWeekend(start) {
  return start.add(1, 'day')
}

const WEEKEND_LIST_FROM = 1
const WEEKEND_RECOMMEND_FROM = 2

function weekendSpanLabel(start, end, index) {
  const a = start.format('M/D')
  const b = end.format('M/D')
  const span = start.isSame(end, 'day') ? a : `${a}–${b}`
  if (index === WEEKEND_LIST_FROM) return `下周末 ${span}`
  if (index === WEEKEND_RECOMMEND_FROM) return `下下周末 ${span}`
  return span
}

function upcomingWeekendOptions(count = 4, today = dayjs()) {
  const todayStr = today.format('YYYY-MM-DD')
  const options = []
  for (let i = WEEKEND_LIST_FROM; options.length < count && i < WEEKEND_LIST_FROM + count + 2; i++) {
    const [sat, sun] = weekendBounds(i, today)
    if (sun.format('YYYY-MM-DD') < todayStr) continue
    const start = sat.format('YYYY-MM-DD') < todayStr ? today.startOf('day') : sat
    options.push({
      key: start.format('YYYY-MM-DD'),
      index: i,
      start,
      end: sun,
      label: weekendSpanLabel(start, sun, i),
    })
  }
  return options
}

function weekendPicksForDates(dates, count = 4, today = dayjs()) {
  const allowed = new Set(dates)
  const todayStr = today.format('YYYY-MM-DD')
  const picks = []
  for (let i = WEEKEND_LIST_FROM; picks.length < count && i < WEEKEND_LIST_FROM + 16; i++) {
    const [sat, sun] = weekendBounds(i, today)
    const days = [sat, sun].map((d) => d.format('YYYY-MM-DD')).filter((ds) => ds >= todayStr && allowed.has(ds))
    if (!days.length) continue
    const start = dayjs(days[0])
    const end = dayjs(days[days.length - 1])
    picks.push({
      key: days[0],
      days,
      label: weekendSpanLabel(start, end, i),
    })
  }
  return picks
}

const WEEKEND_LEAVES = [
  { key: 'none', label: '免请假' },
  { key: 'half', label: '请半天' },
  { key: 'day', label: '请一天' },
  { key: 'custom', label: '自选日期' },
]

const ORIGIN_GROUPS = [
  { name: '海南', emoji: '🌴', cities: ['海口', '三亚', '琼海'] },
  { name: '川渝', emoji: '🐼', cities: ['成都', '重庆'] },
  { name: '广深', emoji: '🏙️', cities: ['广州', '深圳', '珠海'] },
  { name: '江浙沪', emoji: '🌊', cities: ['上海', '杭州', '南京', '宁波'] },
  { name: '云南', emoji: '🌿', cities: ['昆明', '丽江', '西双版纳', '大理'] },
  { name: '东北', emoji: '❄️', cities: ['哈尔滨', '长春', '沈阳', '大连'] },
  { name: '福建', emoji: '🍵', cities: ['福州', '厦门', '泉州'] },
]

const HOT_ORIGIN_CITIES = ['海口', '三亚', '北京', '上海', '广州', '深圳', '成都', '杭州']
const ORIGIN_RECENT_KEY = 'hna-weekend-origin-recent'

const WEEKEND_ORIGIN_LIMIT = 5

function addOriginLabels(current, labels) {
  const next = [...(current || [])]
  for (const label of labels) {
    if (!label || next.includes(label)) continue
    if (next.length >= WEEKEND_ORIGIN_LIMIT) break
    next.push(label)
  }
  return next
}

function groupOriginLabels(options, cities) {
  return cities
    .map((name) => (options || []).find((label) => cityNameOf(label) === name))
    .filter(Boolean)
}

function loadOriginRecent() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(ORIGIN_RECENT_KEY) || '[]')
    return Array.isArray(raw) ? raw.filter(Boolean).slice(0, 8) : []
  } catch (e) {
    return []
  }
}

function writeOriginRecent(list) {
  const next = []
  for (const label of list || []) {
    const city = cityNameOf(label)
    if (!city || next.some((item) => cityNameOf(item) === city)) continue
    next.push(label)
    if (next.length >= 8) break
  }
  try { window.localStorage.setItem(ORIGIN_RECENT_KEY, JSON.stringify(next)) } catch (e) { /* ignore */ }
  return next
}

function matchOriginLabel(options, stored) {
  if (!stored) return ''
  if ((options || []).includes(stored)) return stored
  return (options || []).find((label) => cityNameOf(label) === cityNameOf(stored)) || ''
}

function toggleOriginLabel(current, label) {
  if (!label) return current || []
  if ((current || []).includes(label)) return current.filter((item) => item !== label)
  return addOriginLabels(current, [label])
}

function OriginChip({ label, on, disabled, onClick }) {
  return (
    <button type="button" className={`origin-chip${on ? ' is-on' : ''}`} disabled={!on && disabled} onClick={onClick}>
      <span>{cityNameOf(label)}</span>
      {on ? <span className="origin-chip-check">✓</span> : null}
    </button>
  )
}

function OriginField({ value, onOpen, onChange }) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={`origin-field${value.length ? '' : ' is-empty'}`}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <span className="origin-field-tags">
        {value.length ? value.map((label) => (
          <span key={label} className="origin-field-tag">
            {cityNameOf(label)}
            <button
              type="button"
              aria-label={`移除${cityNameOf(label)}`}
              onClick={(e) => { e.stopPropagation(); onChange(value.filter((item) => item !== label)) }}
            >×</button>
          </span>
        )) : <span className="origin-field-placeholder">选择出发地，如 海口 / 深圳</span>}
      </span>
      <span className="origin-field-meta">{value.length}/{WEEKEND_ORIGIN_LIMIT}</span>
    </div>
  )
}

function DateStrip({ mode, date, onPick, days = 30 }) {
  const ref = useRef(null)
  const [edge, setEdge] = useState({ left: true, right: false })
  const start = dayjs().startOf('day')
  const list = Array.from({ length: days }, (_, i) => start.add(i, 'day'))
  const picked = mode === 'single' && date ? date.format('YYYY-MM-DD') : ''
  const syncEdge = () => {
    const box = ref.current
    if (!box) return
    setEdge({
      left: box.scrollLeft <= 2,
      right: box.scrollLeft + box.clientWidth >= box.scrollWidth - 2,
    })
  }
  useEffect(() => {
    const box = ref.current
    if (!box) return undefined
    let drag = null
    const onWheel = (event) => {
      if (box.scrollWidth <= box.clientWidth + 2) return
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      box.scrollLeft += event.deltaY
    }
    const onDown = (event) => {
      if (event.button !== 0) return
      drag = { x: event.clientX, left: box.scrollLeft, moved: 0, active: true }
    }
    const onMove = (event) => {
      if (!drag?.active) return
      const dx = event.clientX - drag.x
      if (Math.abs(dx) > 4) {
        drag.moved = dx
        box.classList.add('is-dragging')
      }
      if (drag.moved) box.scrollLeft = drag.left - dx
    }
    const onUp = () => {
      if (!drag?.active) return
      drag.active = false
      box.classList.remove('is-dragging')
    }
    const onClick = (event) => {
      if (!drag || Math.abs(drag.moved) <= 6) return
      event.preventDefault()
      event.stopPropagation()
      drag = null
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    box.addEventListener('scroll', syncEdge, { passive: true })
    box.addEventListener('pointerdown', onDown)
    box.addEventListener('click', onClick, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    const observer = new ResizeObserver(syncEdge)
    observer.observe(box)
    syncEdge()
    return () => {
      box.removeEventListener('wheel', onWheel)
      box.removeEventListener('scroll', syncEdge)
      box.removeEventListener('pointerdown', onDown)
      box.removeEventListener('click', onClick, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      observer.disconnect()
    }
  }, [])
  useEffect(() => {
    const box = ref.current
    const node = box?.querySelector('.date-strip-day.is-on')
    if (box && node) box.scrollTo({ left: node.offsetLeft - box.clientWidth / 2 + node.clientWidth / 2, behavior: 'smooth' })
  }, [picked])
  const nudge = (dir) => {
    const box = ref.current
    if (!box) return
    box.scrollBy({ left: dir * Math.max(180, box.clientWidth * 0.8), behavior: 'smooth' })
  }
  return (
    <div className="date-strip-wrap">
      <button type="button" className="date-strip-nav" aria-label="往前看日期" disabled={edge.left} onClick={() => nudge(-1)}>
        <ChevronLeftIcon size={16} />
      </button>
      <div className="date-strip" ref={ref}>
        <button type="button" className={`date-strip-day is-any${mode === 'none' ? ' is-on' : ''}`} onClick={() => onPick('none')}>
          <span className="date-strip-week">日期</span>
          <span className="date-strip-num">不限</span>
          <span className="date-strip-md">看全部班期</span>
        </button>
        {list.map((d) => {
          const key = d.format('YYYY-MM-DD')
          const dow = d.day()
          const tone = dow === 0 || dow === 6 ? ' is-weekend' : dow === 5 ? ' is-fri' : ''
          const week = d.isSame(start, 'day') ? '今天' : d.isSame(start.add(1, 'day'), 'day') ? '明天' : dow === 0 || dow === 6 ? '周末' : cnWeekday(key)
          return (
            <button type="button" key={key} className={`date-strip-day${tone}${picked === key ? ' is-on' : ''}`} onClick={() => onPick('single', d)}>
              <span className="date-strip-week">{week}</span>
              <span className="date-strip-num">{d.date()}</span>
              <span className="date-strip-md">{d.format('M/D')}</span>
            </button>
          )
        })}
        <button type="button" className={`date-strip-day is-any${mode === 'range' ? ' is-on' : ''}`} onClick={() => onPick('range')}>
          <span className="date-strip-week">按区间</span>
          <span className="date-strip-num">区间</span>
          <span className="date-strip-md">选一段日期</span>
        </button>
      </div>
      <button type="button" className="date-strip-nav" aria-label="往后看日期" disabled={edge.right} onClick={() => nudge(1)}>
        <ChevronRightIcon size={16} />
      </button>
    </div>
  )
}

const fieldLabel = (title, hint) => (
  <span className="field-label">{title}{hint ? <span>{hint}</span> : null}</span>
)

function OriginPickerModal({ open, options, value, recent, onCancel, onConfirm, onClearRecent }) {
  const [draft, setDraft] = useState(value || [])
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (!open) return
    setDraft(value || [])
    setQuery('')
  }, [open, value])

  const full = draft.length >= WEEKEND_ORIGIN_LIMIT
  const q = query.trim().toUpperCase()
  const allLabels = options || []
  const searched = q
    ? allLabels.filter((label) => String(label).toUpperCase().includes(q))
    : []
  const hot = groupOriginLabels(options, HOT_ORIGIN_CITIES)
  const recentLabels = []
  for (const stored of recent || []) {
    const label = matchOriginLabel(options, stored)
    if (label && !recentLabels.includes(label)) recentLabels.push(label)
  }

  const toggleGroup = (labels) => {
    const selected = labels.filter((label) => draft.includes(label)).length
    setDraft(selected === labels.length
      ? draft.filter((label) => !labels.includes(label))
      : addOriginLabels(draft, labels))
  }

  return (
    <Modal
      open={open}
      onCancel={onCancel}
      footer={null}
      width={560}
      title={(
        <div className="origin-modal-title">
          <b>选择出发地</b>
          <span>多选 · 最多 {WEEKEND_ORIGIN_LIMIT} 个</span>
        </div>
      )}
    >
      <Input
        allowClear
        value={query}
        placeholder="输入城市名或机场名，如 海口 / 深圳"
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="origin-section-title">快捷城市群 <span>一键选入区域热门航点</span></div>
      <div className="origin-groups">
        {ORIGIN_GROUPS.map((group) => {
          const labels = groupOriginLabels(options, group.cities)
          if (!labels.length) return null
          const selected = labels.filter((label) => draft.includes(label)).length
          return (
            <button
              key={group.name}
              type="button"
              className={`origin-group${selected === labels.length ? ' is-on' : ''}`}
              disabled={selected === 0 && full}
              onClick={() => toggleGroup(labels)}
            >
              <span className="origin-group-ico">{group.emoji}</span>
              <span>{group.name}</span>
              <span className="origin-group-count">（{labels.length}城）</span>
            </button>
          )
        })}
      </div>
      {recentLabels.length > 0 && !q && (
        <>
          <div className="origin-section-title">
            最近搜索
            <button type="button" className="origin-clear" onClick={onClearRecent}>清空</button>
          </div>
          <div className="origin-chips">
            {recentLabels.map((label) => (
              <OriginChip
                key={label}
                label={label}
                on={draft.includes(label)}
                disabled={full}
                onClick={() => setDraft((prev) => toggleOriginLabel(prev, label))}
              />
            ))}
          </div>
        </>
      )}
      <div className="origin-section-title">
        {q ? '搜索结果' : '热门城市'}
        {q ? <span>{searched.length} 个</span> : null}
      </div>
      {(q ? searched : hot).length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={q ? '没有匹配的城市' : '当前没有可选城市'} />
      ) : (
        <div className="origin-chips">
          {(q ? searched : hot).map((label) => (
            <OriginChip
              key={label}
              label={label}
              on={draft.includes(label)}
              disabled={full}
              onClick={() => setDraft((prev) => toggleOriginLabel(prev, label))}
            />
          ))}
        </div>
      )}
      {!q && (
        <>
          <div className="origin-section-title">全部出发地 <span>{allLabels.length} 个</span></div>
          {allLabels.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前没有可选城市" />
          ) : (
            <div className="origin-chips origin-all">
              {allLabels.map((label) => (
                <OriginChip
                  key={label}
                  label={label}
                  on={draft.includes(label)}
                  disabled={full}
                  onClick={() => setDraft((prev) => toggleOriginLabel(prev, label))}
                />
              ))}
            </div>
          )}
        </>
      )}
      <div className="origin-foot">
        <div className="origin-picked">
          <span>已选 {draft.length}/{WEEKEND_ORIGIN_LIMIT}</span>
          {draft.map((label) => (
            <button
              key={label}
              type="button"
              className="origin-picked-tag"
              onClick={() => setDraft((prev) => prev.filter((item) => item !== label))}
            >
              {cityNameOf(label)} ×
            </button>
          ))}
          {draft.length > 0 && (
            <button type="button" className="origin-clear" onClick={() => setDraft([])}>清空</button>
          )}
        </div>
        <Button type="primary" block onClick={() => onConfirm(draft)}>
          确认选择（已选 {draft.length}/{WEEKEND_ORIGIN_LIMIT}）
        </Button>
      </div>
    </Modal>
  )
}

const WEEK_DAY_NAME = { thu: '周四', fri: '周五', sat: '周六', sun: '周日', mon: '周一' }

const PATTERN_ICONS = {
  moon: MoonIcon,
  sunrise: SunriseIcon,
  sun: SunIcon,
  sunset: SunsetIcon,
  luggage: LuggageIcon,
}

const WEEKEND_PATTERNS = [
  {
    key: 'fri',
    leave: 'none',
    title: '周五晚去 · 周日晚回',
    note: '纯周末 · 17:30 后下班飞',
    badge: '48h',
    icon: 'moon',
    outDay: 'fri',
    outCmp: 'gte',
    outBound: '17:30',
    backDay: 'sun',
    backCmp: 'gte',
    backBound: '17:30',
  },
  {
    key: 'sat',
    leave: 'none',
    title: '周六早去 · 周日晚回',
    note: '晨光挑战 · 09:30 前起飞',
    badge: '35h',
    icon: 'sunrise',
    outDay: 'sat',
    outCmp: 'lte',
    outBound: '09:30',
    backDay: 'sun',
    backCmp: 'gte',
    backBound: '17:30',
  },
  {
    key: 'half-afternoon',
    leave: 'half',
    title: '周五下午去 · 周日晚回',
    note: '请半天 · 12:00 后出发，晚上返程',
    badge: '60h',
    icon: 'sun',
    outDay: 'fri',
    outCmp: 'between',
    outBound: '12:00',
    outBoundEnd: '17:30',
    backDay: 'sun',
    backCmp: 'gte',
    backBound: '17:30',
  },
  {
    key: 'half-mon',
    leave: 'half',
    title: '周五晚去 · 周一早回',
    note: '请半天 · 周一 09:30 前抵家',
    badge: '60h',
    icon: 'sunrise',
    outDay: 'fri',
    outCmp: 'gte',
    outBound: '17:30',
    backDay: 'mon',
    backCmp: 'lte',
    backBound: '09:30',
  },
  {
    key: 'day-thu',
    leave: 'day',
    title: '周四晚去 · 周日晚回',
    note: '请周五假 · 畅享周五到周日',
    badge: '72h',
    icon: 'luggage',
    outDay: 'thu',
    outCmp: 'gte',
    outBound: '17:30',
    backDay: 'sun',
    backCmp: 'gte',
    backBound: '17:30',
  },
  {
    key: 'day-mon',
    leave: 'day',
    title: '周五晚去 · 周一晚回',
    note: '请周一假 · 畅享周六到周一',
    badge: '72h',
    icon: 'sunset',
    outDay: 'fri',
    outCmp: 'gte',
    outBound: '17:30',
    backDay: 'mon',
    backCmp: 'gte',
    backBound: '17:30',
  },
  {
    key: 'custom',
    leave: 'custom',
    title: '自选日期',
    note: '自己点去程和返程',
    badge: '自选',
    icon: 'luggage',
    outDay: 'fri',
    outCmp: 'gte',
    outBound: '00:00',
    backDay: 'sun',
    backCmp: 'gte',
    backBound: '00:00',
  },
]

function weekendPlanOptions(count = 4, today = dayjs()) {
  const plans = []
  const todayStr = today.format('YYYY-MM-DD')
  for (let i = WEEKEND_LIST_FROM; plans.length < count && i < WEEKEND_LIST_FROM + count + 2; i++) {
    const [sat, sun] = weekendBounds(i, today)
    if (sun.format('YYYY-MM-DD') < todayStr) continue
    plans.push({ index: i, thu: sat.subtract(2, 'day'), fri: sat.subtract(1, 'day'), sat, sun, mon: sun.add(1, 'day') })
  }
  return plans
}

function findWeekendPlan(index) {
  return weekendPlanOptions(8).find((item) => item.index === index) || weekendPlanOptions(8)[0]
}

function weekendPlanChip(plan) {
  const prefix = plan.index === WEEKEND_LIST_FROM ? '下周末 ' : plan.index === WEEKEND_RECOMMEND_FROM ? '下下周末 ' : ''
  return `${prefix}${plan.fri.format('M/D')}–${plan.sun.format('M/D')}`
}

function hhmmMatch(dep, cmp, bound, boundEnd) {
  const time = String(dep || '')
  if (!/^\d{2}:\d{2}$/.test(time)) return false
  if (cmp === 'between') return time >= bound && time < (boundEnd || bound)
  return cmp === 'lte' ? time <= bound : time >= bound
}

function compactLegFlights(records, cmp, bound, boundEnd) {
  const map = new Map()
  for (const rec of records || []) {
    if (!hhmmMatch(rec.dep_time, cmp, bound, boundEnd)) continue
    if (!rec.origin?.city || !rec.dest?.city || rec.origin.city === rec.dest.city) continue
    const key = `${rec.flight_no}|${rec.dep_time}|${rec.arr_time}|${rec.origin.iata}|${rec.dest.iata}`
    let item = map.get(key)
    if (!item) {
      item = {
        flight_no: rec.flight_no,
        dep_time: rec.dep_time || '',
        arr_time: rec.arr_time || '',
        origin: rec.origin,
        dest: rec.dest,
        product: new Set(),
      }
      map.set(key, item)
    }
    for (const part of String(rec.product || '').split('/')) {
      if (part === '666' || part === '2666') item.product.add(part)
    }
  }
  return [...map.values()]
    .map((item) => ({ ...item, product: [...item.product].sort().join('/') }))
    .sort((a, b) => a.dep_time.localeCompare(b.dep_time) || String(a.flight_no).localeCompare(String(b.flight_no)))
}

function minutesOf(dep) {
  const [hour, minute] = String(dep || '').split(':').map((part) => Number(part))
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return hour * 60 + minute
}

function hasProduct(product, tier) {
  return String(product || '').split('/').map((part) => part.trim()).includes(tier)
}

function orderLegFlights(flights, prefer) {
  const score = (flight) => {
    const mins = minutesOf(flight.dep_time)
    if (prefer === 'early') return mins
    if (prefer === 'late') return -mins
    return Math.abs(mins - (20 * 60 + 30))
  }
  return [...flights].sort((a, b) => {
    const tier = Number(hasProduct(b.product, '666')) - Number(hasProduct(a.product, '666'))
    if (tier) return tier
    return score(a) - score(b) || String(a.flight_no).localeCompare(String(b.flight_no))
  })
}

function pairScore(outbound, inbound) {
  let score = 20
  if (hasProduct(outbound?.product, '666')) score += 50
  if (hasProduct(inbound?.product, '666')) score += 50
  if (flightMark(outbound?.dep_time, 'out')) score += 8
  if (flightMark(inbound?.dep_time, 'back')) score += 8
  return score
}

function planTags(outbound, inbound) {
  const tags = []
  const outOk = hasProduct(outbound?.product, '666')
  const backOk = hasProduct(inbound?.product, '666')
  if (outOk && backOk) tags.push({ text: '双程666可换', color: 'green' })
  else {
    if (!outOk) tags.push({ text: '去程2666专享', color: 'default' })
    if (!backOk) tags.push({ text: '返程2666专享', color: 'default' })
  }
  const outMark = flightMark(outbound?.dep_time, 'out')
  const backMark = flightMark(inbound?.dep_time, 'back')
  if (outMark) tags.push({ text: outMark, color: 'gold' })
  if (backMark && backMark !== outMark) tags.push({ text: backMark, color: 'blue' })
  return tags
}

function staySpanLabel(outDate, backDate) {
  const nights = dayjs(backDate).startOf('day').diff(dayjs(outDate).startOf('day'), 'day')
  if (!Number.isFinite(nights) || nights <= 0) return ''
  return `${nights + 1}天${nights}晚`
}

function stayHours(outDate, outbound, backDate, inbound) {
  if (!outbound?.dep_time || !inbound?.dep_time) return 0
  const start = dayjs(`${outDate} ${outbound.dep_time}`)
  const end = dayjs(`${backDate} ${inbound.dep_time}`)
  const hours = end.diff(start, 'hour', true)
  return Number.isFinite(hours) && hours > 0 ? Math.round(hours) : 0
}

function pairWeekendCities(outRecords, backRecords, pattern) {
  const outs = compactLegFlights(outRecords, pattern.outCmp, pattern.outBound, pattern.outBoundEnd)
  const backs = compactLegFlights(backRecords, pattern.backCmp, pattern.backBound, pattern.backBoundEnd)
  const byCity = new Map()
  for (const flight of outs) {
    const city = flight.dest.city
    if (!byCity.has(city)) byCity.set(city, { city, outs: [], backs: [] })
    byCity.get(city).outs.push(flight)
  }
  for (const flight of backs) {
    const card = byCity.get(flight.origin.city)
    if (card) card.backs.push(flight)
  }
  const outPrefer = pattern.outCmp === 'lte' ? 'early' : 'late'
  return [...byCity.values()]
    .filter((card) => card.outs.length && card.backs.length)
    .map((card) => ({
      ...card,
      outs: orderLegFlights(card.outs, outPrefer).slice(0, 4),
      backs: orderLegFlights(card.backs, pattern.backCmp === 'lte' ? 'early' : 'evening').slice(0, 4),
    }))
    .sort((a, b) => a.city.localeCompare(b.city, 'zh'))
}

function weekendAirport(point) {
  const name = String(point?.airport || point?.city || '').replace(/国际机场|机场/g, '')
  return `${name || point?.city || ''}(${point?.iata || ''})`
}

function productText(product) {
  const parts = String(product || '').split('/').filter(Boolean)
  if (parts.includes('666') && parts.includes('2666')) return '666 / 2666 通用'
  if (parts.includes('2666')) return '2666 专享'
  if (parts.includes('666')) return '666'
  return ''
}

function productTone(product) {
  const parts = String(product || '').split('/')
  if (parts.includes('666')) return 'is-666'
  if (parts.includes('2666')) return 'is-2666'
  return ''
}

/* 国内航班同为北京时间，到达早于起飞视为跨日 */
function flightDuration(dep, arr) {
  if (!/^\d{2}:\d{2}$/.test(String(dep || '')) || !/^\d{2}:\d{2}$/.test(String(arr || ''))) return { text: '', nextDay: false }
  let mins = minutesOf(arr) - minutesOf(dep)
  const nextDay = mins < 0
  if (nextDay) mins += 24 * 60
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return { text: h ? `${h}h${m ? `${m}m` : ''}` : `${m}m`, nextDay }
}

function airportShort(point) {
  const city = point?.city || ''
  const name = String(point?.airport || '').replace(/国际机场|机场/g, '').replace(city, '').trim()
  return [name || point?.iata || '', point?.terminal || ''].filter(Boolean).join(' ')
}

const CITY_FLAVORS = {
  海口: '海岛免税', 三亚: '海岛度假', 琼海: '海岛度假', 成都: '川渝美食', 重庆: '川渝美食', 昆明: '彩云之南', 大理: '彩云之南', 丽江: '彩云之南',
  西双版纳: '彩云之南', 西安: '十三朝古都', 北京: '帝都打卡', 上海: '魔都漫游', 杭州: '西湖慢游', 厦门: '海岛文艺', 青岛: '海滨啤酒',
  哈尔滨: '冰雪之城', 长沙: '网红夜宵', 广州: '早茶美食', 乌鲁木齐: '西域风光', 拉萨: '雪域高原', 桂林: '山水甲天下', 贵阳: '避暑山城', 大连: '浪漫海滨',
}

const LEAVE_PILL_WORD = { none: '畅玩', half: '轻度假', day: '小长假' }

function hourPillText(badge, leave) {
  const word = LEAVE_PILL_WORD[leave]
  return badge && word ? `${badge} ${word}` : badge
}

function weekendScanLabel(origins) {
  const names = (origins || []).map(cityNameOf).filter(Boolean)
  if (!names.length) return '扫描'
  const head = names.slice(0, 2).join('/')
  return `扫描 ${head}${names.length > 2 ? '等' : ''} 出发方案`
}

function lastSundayOf(year, month) {
  const end = dayjs(new Date(year, month + 1, 0))
  return end.subtract(end.day(), 'day')
}

/* IATA 航季：夏秋季始于 3 月最后一个周日，冬春季始于 10 月最后一个周日 */
function flightSeasonInfo(today = dayjs()) {
  const year = today.year()
  const summer = lastSundayOf(year, 2)
  const winter = lastSundayOf(year, 9)
  const day = today.startOf('day')
  if (day.isBefore(summer)) return { name: `${year - 1}冬春航季`, next: summer, nextName: '夏秋', days: summer.diff(day, 'day'), tone: 'winter' }
  if (day.isBefore(winter)) return { name: `${year}夏秋航季`, next: winter, nextName: '冬春', days: winter.diff(day, 'day'), tone: 'summer' }
  const nextSummer = lastSundayOf(year + 1, 2)
  return { name: `${year}冬春航季`, next: nextSummer, nextName: '夏秋', days: nextSummer.diff(day, 'day'), tone: 'winter' }
}

function greatCircleKm(a, b) {
  if (!a || !b || !Number.isFinite(a.lat) || !Number.isFinite(b.lat)) return 0
  const rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad
  const dLon = (b.lon - a.lon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)))
}

function flightMark(dep, kind) {
  const mins = minutesOf(dep)
  if (kind === 'back' && mins >= 19 * 60 && mins <= 21 * 60 + 30) return '黄金档'
  if (mins <= 9 * 60 + 30) return '晨光班'
  if (mins >= 17 * 60 + 30) return '下班飞'
  return ''
}

function WeekendSeatLine({ seat }) {
  if (!seat) return null
  const released = seat.plusSeats > 0 && (seat.plusPrice == null || seat.plusPrice === 199)
  if (released) {
    return (
      <div className="weekend-seat">
        199票余 <b>{seat.plusSeats}</b> 张
        {(seat.plusCabins || []).slice(0, 6).map((cabin) => (
          <Tag key={cabin.cabin} style={{ marginInlineEnd: 0 }}>{cabin.cabin}×{cabin.qty}</Tag>
        ))}
      </div>
    )
  }
  if (seat.plusNote && !seat.plusSeats) {
    return <div className="weekend-seat is-miss">{seat.plusNote}</div>
  }
  return <div className="weekend-seat is-miss">未放199票</div>
}

function cnWeekday(iso) {
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][dayjs(iso).day()] || ''
}

function WeekendDateCalendar({ out, back, focus, onPick }) {
  const minMonth = dayjs().startOf('month')
  const maxMonth = dayjs().add(8, 'month').startOf('month')
  const [view, setView] = useState(() => dayjs(out || undefined).startOf('month'))
  useEffect(() => {
    const anchor = out || focus
    if (anchor) setView(dayjs(anchor).startOf('month'))
  }, [out, focus])
  const go = (delta) => {
    setView((current) => {
      const next = current.add(delta, 'month')
      if (next.isBefore(minMonth)) return minMonth
      if (next.isAfter(maxMonth)) return maxMonth
      return next
    })
  }
  const first = view.startOf('month')
  const offset = (first.day() === 0 ? 7 : first.day()) - 1
  const cells = []
  for (let i = 0; i < offset; i += 1) cells.push(null)
  for (let day = 1; day <= view.daysInMonth(); day += 1) cells.push(first.date(day))
  while (cells.length % 7 !== 0) cells.push(null)
  const today = dayjs().format('YYYY-MM-DD')
  const choose = (ds) => {
    if (ds < today) return
    if (!out || back || ds < out) onPick(ds, '')
    else onPick(out, ds)
  }
  return (
    <div className="cal-wrap weekend-cal">
      <div className="cal-head">
        <Button type="text" icon={<ChevronLeftIcon />} aria-label="上个月" disabled={view.isSame(minMonth, 'month')} onClick={() => go(-1)} />
        <div className="cal-title">{view.format('YYYY年M月')}</div>
        <Button type="text" icon={<ChevronRightIcon />} aria-label="下个月" disabled={view.isSame(maxMonth, 'month')} onClick={() => go(1)} />
      </div>
      <div className="cal-week" aria-hidden="true">
        {WEEK_LABELS.map((label, index) => <div key={label} className={index >= 5 ? 'cal-week-end' : undefined}>{label}</div>)}
      </div>
      <div className="cal-grid" role="grid" aria-label="先点去程，再点返程">
        {cells.map((day, index) => {
          if (!day) return <div key={`blank-${index}`} className="cal-cell cal-cell-blank" />
          const ds = day.format('YYYY-MM-DD')
          const past = ds < today
          const role = ds === out ? '去' : ds === back ? '返' : ''
          const span = out && back && ds > out && ds < back
          return (
            <button
              key={ds}
              type="button"
              className={`cal-cell${past ? ' cal-cell-past' : ' cal-cell-pick'}${role === '去' ? ' is-out' : ''}${role === '返' ? ' is-back' : ''}${span ? ' is-span' : ''}`}
              disabled={past}
              onClick={() => choose(ds)}
            >
              <span className="cal-num">{day.date()}</span>
              {role ? <span className="cal-role">{role}</span> : null}
            </button>
          )
        })}
      </div>
      <div className="cal-legend">先点去程，再点返程。想重选时，再点一天作为新的去程。</div>
    </div>
  )
}

function WeekendFlight({ kind, flight, seat, checking, disabled, onCheck }) {
  const mark = flightMark(flight.dep_time, kind)
  const dur = flightDuration(flight.dep_time, flight.arr_time)
  const product = productText(flight.product)
  return (
    <div className={`weekend-flight weekend-flight-${kind}`}>
      <span className={`weekend-leg-badge is-${kind}`}>{kind === 'back' ? '返程' : '去程'}</span>
      <div className="weekend-flight-main">
        <div className="weekend-flight-top">
          <span className="mono weekend-leg-no">{flight.flight_no}</span>
          {airportShort(flight.origin) ? <span className="weekend-leg-chip">{airportShort(flight.origin)}</span> : null}
        </div>
        <div className="weekend-flight-times mono">
          <b>{flight.dep_time || '--:--'}</b>
          <span className="weekend-flight-dur">{dur.text}<i aria-hidden="true" /></span>
          <b>{flight.arr_time || '--:--'}{dur.nextDay ? <sup>+1</sup> : null}</b>
        </div>
        <div className="weekend-leg-route">{weekendAirport(flight.origin)} → {weekendAirport(flight.dest)}</div>
        <WeekendSeatLine seat={seat} />
      </div>
      <div className="weekend-flight-side">
        {mark ? <span className="weekend-flight-mark">{mark}</span> : null}
        {product ? <span className={`weekend-product-badge ${productTone(flight.product)}`}>{product}</span> : null}
        <Button
          size="small"
          loading={checking}
          disabled={disabled && !checking}
          onClick={onCheck}
        >
          查余票
        </Button>
      </div>
    </div>
  )
}

function WeekendAlt({ kind, flight, active, onPick }) {
  const mark = flightMark(flight.dep_time, kind)
  return (
    <button type="button" className={`weekend-alt${active ? ' is-on' : ''}`} onClick={onPick}>
      <span className="mono weekend-leg-no">{flight.flight_no}</span>
      <span className="mono">{flight.dep_time || '--:--'}–{flight.arr_time || '--:--'}</span>
      {mark ? <span className="weekend-alt-mark">{mark}</span> : null}
      <span className={`weekend-alt-product ${productTone(flight.product)}`}>{productText(flight.product)}</span>
    </button>
  )
}

function weekendLegKey(flight, date) {
  return `${flight?.flight_no || ''}|${date || ''}|${flight?.origin?.iata || ''}|${flight?.dest?.iata || ''}`
}

function WeekendPlanCard({ card, busy, seatBusy, onFollow, onCheckSeats, onSeatLock }) {
  const [outIdx, setOutIdx] = useState(0)
  const [backIdx, setBackIdx] = useState(0)
  const [seats, setSeats] = useState(null)
  const [checkingKey, setCheckingKey] = useState('')
  const outbound = card.outs[outIdx] || card.outs[0]
  const inbound = card.backs[backIdx] || card.backs[0]
  const outKey = weekendLegKey(outbound, card.outDate)
  const backKey = weekendLegKey(inbound, card.backDate)
  const checkLeg = async (flight, date, side) => {
    if (!onCheckSeats || !flight) return
    const key = weekendLegKey(flight, date)
    setCheckingKey(key)
    if (onSeatLock) onSeatLock(true)
    try {
      const seat = await onCheckSeats(flight, date)
      setSeats((prev) => ({
        ...(prev || {}),
        ...(side === 'back' ? { back: seat, backKey: key } : { out: seat, outKey: key }),
      }))
    } catch (err) {
      const seat = { plusNote: err.message || '余票没有查到' }
      setSeats((prev) => ({
        ...(prev || {}),
        ...(side === 'back' ? { back: seat, backKey: key } : { out: seat, outKey: key }),
      }))
    } finally {
      setCheckingKey('')
      if (onSeatLock) onSeatLock(false)
    }
  }
  const [open, setOpen] = useState(false)
  const [distance, setDistance] = useState(0)
  useEffect(() => {
    if (!open || !outbound) return undefined
    let alive = true
    loadWeekendMapBase().then((base) => {
      if (alive) setDistance(greatCircleKm(base.airports[outbound.origin?.iata], base.airports[outbound.dest?.iata]))
    }).catch(() => {})
    return () => { alive = false }
  }, [open, outbound])
  const hours = stayHours(card.outDate, outbound, card.backDate, inbound)
  const span = staySpanLabel(card.outDate, card.backDate)
  const pill = card.leave === 'custom' && span ? span : hourPillText(card.badge, card.leave)
  const fromCity = outbound?.origin?.city || card.fromCity || ''
  const leave = WEEKEND_LEAVES.find((item) => item.key === card.leave)?.label || ''
  const score = pairScore(outbound, inbound)
  const tags = planTags(outbound, inbound).filter((tag) => tag.color === 'green' || tag.color === 'default')
  const flavor = CITY_FLAVORS[card.city]
  const altCount = Math.max(0, card.outs.length - 1) + Math.max(0, card.backs.length - 1)
  const fare = weekendFareEstimate(distance)
  return (
    <Card className="weekend-dest" size="small" id={weekendPlanDomId(card)}>
      <div className="weekend-card-head">
        <div>
          <div className="weekend-card-title">
            <span className="weekend-card-city">{cityWithProvince(card.city)}</span>
            {flavor ? <span className="weekend-flavor">{flavor}</span> : null}
          </div>
          <div className="weekend-card-sub">从{fromCity}出发{span ? ` · ${span}` : ''}</div>
        </div>
        <div className="weekend-card-marks">
          <span className="weekend-score">匹配度 {score}</span>
          {tags.map((tag) => (
            <Tag key={tag.text} color={tag.color} style={{ marginInlineEnd: 0 }}>{tag.text}</Tag>
          ))}
        </div>
      </div>
      <div className="weekend-plan-line">
        {leave ? <Tag color={card.leave === 'none' ? 'green' : 'orange'} style={{ marginInlineEnd: 0 }}>{leave}</Tag> : null}
        <span>
          {String(card.outDate || '').slice(5)} {cnWeekday(card.outDate)} {outbound?.dep_time} 出发 → {String(card.backDate || '').slice(5)} {cnWeekday(card.backDate)} {inbound?.dep_time} 返回
          {hours ? `，在${card.city}约 ${hours} 小时` : ''}
        </span>
        {pill ? <span className="weekend-hour-pill">{pill}</span> : null}
      </div>
      {outbound ? (
        <WeekendFlight
          kind="out"
          flight={outbound}
          seat={seats?.outKey === outKey ? seats.out : null}
          checking={checkingKey === outKey}
          disabled={seatBusy && checkingKey !== outKey}
          onCheck={() => checkLeg(outbound, card.outDate, 'out')}
        />
      ) : null}
      {inbound ? (
        <WeekendFlight
          kind="back"
          flight={inbound}
          seat={seats?.backKey === backKey ? seats.back : null}
          checking={checkingKey === backKey}
          disabled={seatBusy && checkingKey !== backKey}
          onCheck={() => checkLeg(inbound, card.backDate, 'back')}
        />
      ) : null}
      {open && altCount > 0 && (
        <div className="weekend-alts">
          <div className="weekend-alts-title">同日其他可选（点选替换上面的班次）</div>
          {card.outs.length > 1 && (
            <div className="weekend-alts-row">
              <span>去程</span>
              {card.outs.map((flight, index) => (
                <WeekendAlt
                  key={`out-${flight.flight_no}-${flight.dep_time}-${flight.origin?.iata}`}
                  kind="out"
                  flight={flight}
                  active={index === outIdx}
                  onPick={() => setOutIdx(index)}
                />
              ))}
            </div>
          )}
          {card.backs.length > 1 && (
            <div className="weekend-alts-row">
              <span>返程</span>
              {card.backs.map((flight, index) => (
                <WeekendAlt
                  key={`back-${flight.flight_no}-${flight.dep_time}-${flight.dest?.iata}`}
                  kind="back"
                  flight={flight}
                  active={index === backIdx}
                  onPick={() => setBackIdx(index)}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {open && (
        <div className="weekend-fare">
          <div className="weekend-fare-title">会员卡兑换费用参考</div>
          <ul>
            <li>票面：放出 199 票时，666 / 2666 每程固定 <b>¥{FACE_PRICE}</b> 兑换，往返 ¥{fare.faceRound}</li>
            <li>民航发展基金（机建）：成人国内每程 ¥{AIRPORT_TAX}，往返 ¥{fare.airportRound}</li>
            <li>{fare.fuelLine}</li>
            <li>
              预估：{fare.estimate.lead}
              <b className="is-price">{fare.estimate.highlight}</b>
              {fare.estimate.tail}
            </li>
          </ul>
        </div>
      )}
      <div className="weekend-actions">
        <Button onClick={() => setOpen((prev) => !prev)}>
          {open ? '收起详情' : `更多班次与费用${altCount ? `（另有 ${altCount} 班）` : ''}`}
        </Button>
        <Button
          type="primary"
          icon={<PlusIcon />}
          loading={busy}
          onClick={() => onFollow({ ...card, outs: [outbound], backs: [inbound] })}
        >
          开启双向关注
        </Button>
      </div>
    </Card>
  )
}

let weekendMapCache = null

function loadWeekendMapBase() {
  if (weekendMapCache) return Promise.resolve(weekendMapCache)
  if (!loadWeekendMapBase.pending) {
    loadWeekendMapBase.pending = Promise.all([
      fetch('/api/map/china').then((res) => res.json()),
      fetch('/api/map/network').then((res) => res.json()),
    ]).then(([china, network]) => {
      const airports = {}
      for (const airport of network.airports || []) airports[airport.iata] = airport
      weekendMapCache = { provinces: china.provinces || [], airports }
      return weekendMapCache
    })
  }
  return loadWeekendMapBase.pending
}

function reachKind(card) {
  const outOk = hasProduct(card.outs[0]?.product, '666')
  const backOk = hasProduct(card.backs[0]?.product, '666')
  return outOk && backOk ? '666' : '2666'
}

function reachProductLabel(card) {
  const names = new Set()
  for (const flight of [card.outs[0], card.backs[0]]) {
    for (const name of String(flight?.product || '').split('/')) {
      if (name === '666' || name === '2666') names.add(name)
    }
  }
  if (reachKind(card) === '666' && names.has('2666')) return '666/2666'
  if (reachKind(card) === '666') return '666'
  return '2666'
}

function weekendPlanDomId(card) {
  return `weekend-plan-${card.fromCity || ''}-${card.city || ''}`
}

function reachKindOf(card, variant) {
  if (variant === 'overview') return card?.kind === '666' ? '666' : '2666'
  if (variant === 'oneway') return hasProduct((card.outs[0] || card.backs[0])?.product, '666') ? '666' : '2666'
  return reachKind(card)
}

function reachProductOf(card, variant) {
  if (variant === 'overview') return card?.kind === '666' ? '666 可用' : '2666 专享'
  if (variant !== 'oneway') return reachProductLabel(card)
  const names = new Set()
  for (const flight of (card.outs?.length ? card.outs : card.backs) || []) {
    for (const name of String(flight?.product || '').split('/')) {
      if (name === '666' || name === '2666') names.add(name)
    }
  }
  if (names.has('666') && names.has('2666')) return '666/2666'
  if (names.has('666')) return '666'
  return '2666'
}

function reachScoreOf(card, variant) {
  if (variant === 'overview') return Number(card.flightCount) || 0
  if (variant === 'oneway') {
    const flight = card.outs?.[0] || card.backs?.[0]
    const counted = card.outs?.length ? card.outs : (card.backs || [])
    return pairScore(flight, card.trip === 'round' ? card.backs?.[0] : null) + Math.min(24, counted.length)
  }
  return pairScore(card.outs?.[0], card.backs?.[0])
}

function timeFlyLabel(dep) {
  const time = String(dep || '')
  return /^\d{2}:\d{2}$/.test(time) ? `${time}飞` : ''
}

function timeFlyLabels(flights, limit = 2) {
  const seen = new Set()
  const labels = []
  const ordered = [...(flights || [])].sort((a, b) => String(a.dep_time || '').localeCompare(String(b.dep_time || '')))
  for (const flight of ordered) {
    const label = timeFlyLabel(flight.dep_time)
    if (!label || seen.has(label)) continue
    seen.add(label)
    labels.push(label)
    if (labels.length >= limit) break
  }
  return labels
}

function onewayReachCards(records, returns) {
  const backByPair = new Map()
  for (const rec of returns || []) {
    const city = rec.origin?.city
    const fromCity = rec.dest?.city
    if (!city || !fromCity) continue
    const key = `${fromCity}|${city}`
    if (!backByPair.has(key)) backByPair.set(key, [])
    backByPair.get(key).push(rec)
  }
  const byCity = new Map()
  for (const rec of records || []) {
    if (rec.leg === 'back') continue
    const city = rec.dest?.city
    const fromCity = rec.origin?.city
    if (!city || !fromCity) continue
    const key = `${fromCity}|${city}`
    if (!byCity.has(key)) byCity.set(key, { city, fromCity, outs: [], backs: backByPair.get(key) || [] })
    byCity.get(key).outs.push(rec)
  }
  for (const [key, backs] of backByPair) {
    if (byCity.has(key)) continue
    const [fromCity, city] = key.split('|')
    byCity.set(key, { city, fromCity, outs: [], backs })
  }
  return [...byCity.values()].map((card) => {
    const outs = orderLegFlights(card.outs, 'evening')
    const backs = orderLegFlights(card.backs, 'evening')
    const trip = outs.length && backs.length ? 'round' : outs.length ? 'out' : 'back'
    return { ...card, outs, backs, trip }
  })
}

function cardsFromHeatmap(payloads) {
  const cards = []
  for (const payload of payloads || []) {
    const origin = payload?.origin || {}
    const originPoint = {
      city: origin.city,
      iata: origin.iata,
      airport: origin.airport,
      lat: origin.lat,
      lon: origin.lon,
    }
    for (const dest of payload?.destinations || []) {
      const destPoint = {
        city: dest.city,
        iata: dest.iata,
        airport: dest.airport,
        lat: dest.lat,
        lon: dest.lon,
      }
      const direction = dest.direction || (dest.has_outbound && dest.has_inbound ? 'both' : dest.has_inbound ? 'back' : 'out')
      const samples = dest.samples?.length
        ? dest.samples
        : (dest.inbound_samples?.length
          ? dest.inbound_samples
          : [{ flight_no: '', dep_time: '', product: dest.kind === '666' ? '666' : '2666', dest_iata: dest.iata }])
      const outs = samples.map((sample) => ({
        flight_no: sample.flight_no,
        dep_time: sample.dep_time,
        arr_time: sample.arr_time,
        product: sample.product || (dest.kind === '666' ? '666' : '2666'),
        origin: originPoint,
        dest: { ...destPoint, iata: sample.dest_iata || dest.iata },
      }))
      cards.push({
        city: dest.city,
        fromCity: origin.city,
        trip: direction === 'both' ? 'round' : direction === 'back' ? 'back' : 'out',
        outs,
        backs: [],
        kind: dest.kind,
        hasOutbound: dest.has_outbound !== false && direction !== 'back',
        hasInbound: !!dest.has_inbound,
        flightCount: (dest.departures || 0) + (dest.inbound_departures || 0) || dest.flights || outs.length,
        flightTotal: dest.flights || 0,
        inboundFlights: dest.inbound_flights || 0,
        byDate: dest.by_date || [],
      })
    }
  }
  return cards
}

function tripLabel(card) {
  if (card?.trip === 'round') return '往返'
  if (card?.trip === 'back') return '有回无去'
  return '有去无回'
}

/* 地图色板与 styles.css 的浅/暗 token 同源；颜色值为 "r, g, b" 便于拼 rgba */
const MAP_THEMES = {
  light: {
    sea: ['#F4F7FB', '#E8EEF6'], land: '#FFFFFF', border: 'rgba(110, 130, 158, 0.34)',
    text: '#1A2333', muted: '#5A6577', halo: 'rgba(255, 255, 255, 0.92)',
    card: 'rgba(255, 255, 255, 0.96)', shadow: 'rgba(20, 40, 80, 0.16)',
    origin: '212, 83, 43', pin666: '45, 157, 95', pin2666: '139, 150, 168',
    round: '45, 157, 95', out: '178, 110, 0', back: '0, 84, 166', heat: '0, 84, 166', heatOpacity: 0.3,
  },
  dark: {
    sea: ['#0E141A', '#111922'], land: '#1A232D', border: 'rgba(150, 170, 195, 0.2)',
    text: '#E6EDF3', muted: '#96A3B4', halo: 'rgba(14, 20, 26, 0.9)',
    card: 'rgba(22, 29, 38, 0.95)', shadow: 'rgba(0, 0, 0, 0.45)',
    origin: '240, 138, 93', pin666: '79, 174, 119', pin2666: '120, 134, 154',
    round: '79, 174, 119', out: '224, 168, 73', back: '91, 155, 211', heat: '91, 155, 211', heatOpacity: 0.34,
  },
}

function tripTone(trip, dark = false) {
  const palette = MAP_THEMES[dark ? 'dark' : 'light']
  const rgb = trip === 'round' ? palette.round : trip === 'back' ? palette.back : palette.out
  return { rgb, pin: `rgb(${rgb})`, text: `rgb(${rgb})`, stroke: `rgba(${rgb}, 0.4)` }
}

/* 单程热力专用：低饱和，避免和品牌绿/橙/蓝一样抢眼 */
const OVERVIEW_TONES = {
  light: { round: '122, 156, 134', out: '184, 148, 108', back: '122, 148, 170', heat: '158, 170, 180' },
  dark: { round: '146, 176, 158', out: '198, 170, 132', back: '150, 174, 194', heat: '120, 136, 148' },
}

function overviewTone(trip, dark = false) {
  const palette = OVERVIEW_TONES[dark ? 'dark' : 'light']
  return trip === 'round' ? palette.round : trip === 'back' ? palette.back : palette.out
}

/* 单色热度：只用主题主色的深浅表达班次多少，不和图钉、标签抢颜色 */
const heatPaletteCache = {}
function heatPalette(rgb) {
  if (heatPaletteCache[rgb]) return heatPaletteCache[rgb]
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 1
  const ctx = canvas.getContext('2d')
  const grad = ctx.createLinearGradient(0, 0, 256, 0)
  grad.addColorStop(0, `rgba(${rgb}, 0)`)
  grad.addColorStop(0.35, `rgba(${rgb}, 0.45)`)
  grad.addColorStop(1, `rgba(${rgb}, 1)`)
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 256, 1)
  heatPaletteCache[rgb] = ctx.getImageData(0, 0, 256, 1).data
  return heatPaletteCache[rgb]
}

/* 先在灰度层叠加强度，再按色带着色：相邻城市的热度会真实叠加 */
function drawHeatLayer(ctx, points, radius, opacity, rgb) {
  if (!points.length) return
  const { width, height } = ctx.canvas
  const layer = document.createElement('canvas')
  layer.width = width
  layer.height = height
  const lc = layer.getContext('2d')
  for (const point of points) {
    const r = radius * point.spread
    const grad = lc.createRadialGradient(point.x, point.y, 0, point.x, point.y, r)
    grad.addColorStop(0, `rgba(0, 0, 0, ${point.weight})`)
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)')
    lc.fillStyle = grad
    lc.beginPath()
    lc.arc(point.x, point.y, r, 0, Math.PI * 2)
    lc.fill()
  }
  const image = lc.getImageData(0, 0, width, height)
  const data = image.data
  const palette = heatPalette(rgb)
  for (let i = 3; i < data.length; i += 4) {
    const a = data[i]
    if (!a) continue
    const o = a * 4
    data[i - 3] = palette[o]
    data[i - 2] = palette[o + 1]
    data[i - 1] = palette[o + 2]
    data[i] = Math.min(255, palette[o + 3] * opacity)
  }
  lc.putImageData(image, 0, 0)
  ctx.drawImage(layer, 0, 0)
}

function drawRouteArc(ctx, from, to, rgb, alpha, lineWidth, fade = 0.35) {
  const [x1, y1] = from
  const [x2, y2] = to
  const dist = Math.hypot(x2 - x1, y2 - y1)
  if (dist < 2) return
  const bend = Math.min(0.22 * dist, 120)
  const nx = (y1 - y2) / dist
  const ny = (x2 - x1) / dist
  const flip = ny > 0 ? -1 : 1
  const cx = (x1 + x2) / 2 + nx * bend * flip
  const cy = (y1 + y2) / 2 + ny * bend * flip
  const grad = ctx.createLinearGradient(x1, y1, x2, y2)
  grad.addColorStop(0, `rgba(${rgb}, ${alpha * fade})`)
  grad.addColorStop(1, `rgba(${rgb}, ${alpha})`)
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.quadraticCurveTo(cx, cy, x2, y2)
  ctx.strokeStyle = grad
  ctx.lineWidth = lineWidth
  ctx.lineCap = 'round'
  ctx.stroke()
}

function visibleMapCards(cards, filter, variant, tripFilter) {
  return cards.filter((card) => {
    if (filter !== 'all' && reachKindOf(card, variant) !== filter) return false
    if ((variant === 'oneway' || variant === 'overview') && tripFilter !== 'all' && card.trip !== tripFilter) return false
    return true
  })
}

const MAP_FULL_BOUNDS = { minLon: 73.2, maxLon: 134.8, minLat: 15.6, maxLat: 53.6 }

/* 按出发地与可达地收紧视野，并补齐到画布宽高比；范围比全国还大时退回全国 */
function fitMapBounds(points, width, height, pad) {
  if (!points.length) return MAP_FULL_BOUNDS
  const lons = points.map((pt) => pt[0])
  const lats = points.map((pt) => pt[1])
  let minLon = Math.min(...lons) - 3.5
  let maxLon = Math.max(...lons) + 3.5
  let minLat = Math.min(...lats) - 2.6
  let maxLat = Math.max(...lats) + 3.2
  if (maxLat - minLat < 14) {
    const mid = (minLat + maxLat) / 2
    minLat = mid - 7
    maxLat = mid + 7
  }
  const cos = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180)
  const target = (width - pad * 2) / (height - pad * 2)
  const spanX = (maxLon - minLon) * cos
  const spanY = maxLat - minLat
  if (spanX / spanY < target) {
    const need = (spanY * target) / cos
    const mid = (minLon + maxLon) / 2
    minLon = mid - need / 2
    maxLon = mid + need / 2
  } else {
    const need = spanX / target
    const mid = (minLat + maxLat) / 2
    minLat = mid - need / 2
    maxLat = mid + need / 2
  }
  if (maxLon - minLon >= MAP_FULL_BOUNDS.maxLon - MAP_FULL_BOUNDS.minLon) return MAP_FULL_BOUNDS
  return { minLon, maxLon, minLat, maxLat }
}

function mapProjector(width, height, bounds = MAP_FULL_BOUNDS, pad = 28) {
  const midLat = (bounds.minLat + bounds.maxLat) / 2
  const cos = Math.cos((midLat * Math.PI) / 180)
  const spanX = (bounds.maxLon - bounds.minLon) * cos
  const spanY = bounds.maxLat - bounds.minLat
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)
  const usedW = spanX * scale
  const usedH = spanY * scale
  const ox = (width - usedW) / 2
  const oy = (height - usedH) / 2
  return (lon, lat) => [ox + (lon - bounds.minLon) * cos * scale, oy + (bounds.maxLat - lat) * scale]
}

function roundBox(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function drawTierDot(ctx, x, y, r, rgb, ratio, hollow) {
  ctx.save()
  ctx.shadowColor = 'rgba(20, 40, 80, 0.25)'
  ctx.shadowBlur = 3 * ratio
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  if (hollow) {
    ctx.fillStyle = `rgba(${rgb}, 0.16)`
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 2 * ratio
    ctx.strokeStyle = `rgb(${rgb})`
    ctx.stroke()
  } else {
    ctx.fillStyle = `rgb(${rgb})`
    ctx.fill()
    ctx.shadowColor = 'transparent'
    ctx.lineWidth = 1.5 * ratio
    ctx.strokeStyle = '#fff'
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, r + 3.2 * ratio, 0, Math.PI * 2)
    ctx.lineWidth = 1.6 * ratio
    ctx.strokeStyle = `rgba(${rgb}, 0.9)`
    ctx.stroke()
  }
  ctx.restore()
}

function drawMapDot(ctx, x, y, r, color, ratio) {
  ctx.save()
  ctx.shadowColor = 'rgba(20, 40, 80, 0.25)'
  ctx.shadowBlur = 3 * ratio
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.shadowColor = 'transparent'
  ctx.lineWidth = 1.5 * ratio
  ctx.strokeStyle = '#fff'
  ctx.stroke()
  ctx.restore()
}

function reachCaption(card, variant, product) {
  const outN = card.outs?.length || 0
  const backN = card.backs?.length || 0
  if (variant === 'overview') return ''
  if (variant !== 'oneway') return `${product} · 去${outN} 回${backN}`
  const timeSource = outN ? card.outs : card.backs
  const times = timeFlyLabels(timeSource, 1)[0]
  return `${times || product} · ${outN || backN}班`
}

/* 底图 + 热力层只随数据/尺寸/主题重建，悬停时只重绘连线、图钉与标签 */
function mapAirport(base, point) {
  if (!point) return null
  const known = point.iata ? base.airports[point.iata] : null
  if (known?.lat != null && known?.lon != null) return { ...known, city: known.city || point.city, iata: point.iata }
  if (point.lat == null || point.lon == null) return null
  return { iata: point.iata, city: point.city, lat: point.lat, lon: point.lon }
}

function buildReachScene({ base, cards, filter, tripFilter, variant, width, height, ratio, palette }) {
  const grouped = new Map()
  for (const card of visibleMapCards(cards, filter, variant, tripFilter)) {
    const out = card.outs[0]
    const back = card.backs[0]
    const origin = mapAirport(base, out?.origin || (back ? { iata: back.dest?.iata, city: back.dest?.city } : null))
      || mapAirport(base, back?.dest)
    const dest = mapAirport(base, out?.dest || (back ? { iata: back.origin?.iata, city: back.origin?.city } : null))
      || mapAirport(base, back?.origin)
    if (!origin || !dest) continue
    const product = reachProductOf(card, variant)
    const spot = {
      key: dest.iata,
      card,
      origin,
      dest,
      score: reachScoreOf(card, variant),
      kind: reachKindOf(card, variant),
      product,
      caption: reachCaption(card, variant, product),
      mapCaption: variant === 'overview'
        ? ''
        : variant === 'oneway'
          ? reachCaption(card, variant, product)
          : `去${card.outs?.length || 0} 回${card.backs?.length || 0}`,
      options: Number(card.flightCount) || ((card.outs?.length || 0) + (card.backs?.length || 0)),
    }
    const cityKey = card.city || dest.city || dest.iata
    const prev = grouped.get(cityKey)
    if (!prev) grouped.set(cityKey, spot)
    else if (spot.score > prev.score) grouped.set(cityKey, { ...spot, options: spot.options + prev.options })
    else prev.options += spot.options
  }
  const spots = [...grouped.values()]
  const pad = 26 * ratio
  const bounds = fitMapBounds(spots.flatMap((spot) => [[spot.origin.lon, spot.origin.lat], [spot.dest.lon, spot.dest.lat]]), width, height, pad)
  const project = mapProjector(width, height, bounds, pad)

  const layer = document.createElement('canvas')
  layer.width = width
  layer.height = height
  const ctx = layer.getContext('2d')
  const sea = ctx.createLinearGradient(0, 0, 0, height)
  sea.addColorStop(0, palette.sea[0])
  sea.addColorStop(1, palette.sea[1])
  ctx.fillStyle = sea
  ctx.fillRect(0, 0, width, height)
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, 0.7 * ratio)
  ctx.strokeStyle = palette.border
  ctx.fillStyle = palette.land
  for (const province of base.provinces) {
    for (const poly of province.polygons || []) {
      const ring = poly[0] || []
      if (ring.length < 3) continue
      ctx.beginPath()
      ring.forEach((pt, index) => {
        const [x, y] = project(pt[0], pt[1])
        if (index === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      })
      ctx.closePath()
      ctx.fill()
      ctx.stroke()
    }
  }

  const maxOptions = Math.max(1, ...spots.map((spot) => spot.options))
  for (const spot of spots) spot.level = spot.options / maxOptions
  const radius = Math.max(30 * ratio, Math.min(width, height) * 0.075)
  const softHeat = variant === 'overview'
  const heatRgb = softHeat ? (palette.land === '#FFFFFF' ? OVERVIEW_TONES.light.heat : OVERVIEW_TONES.dark.heat) : palette.heat
  drawHeatLayer(ctx, spots.map((spot) => {
    const [x, y] = project(spot.dest.lon, spot.dest.lat)
    return { x, y, weight: 0.3 + 0.7 * spot.level, spread: 0.75 + 0.45 * spot.level }
  }), radius, softHeat ? 0.18 : palette.heatOpacity, heatRgb)
  return { spots, project, layer }
}

const MAP_VIEW_HOME = { zoom: 1, x: 0, y: 0 }
const MAP_ZOOM_MIN = 1
const MAP_ZOOM_MAX = 8

/* 视野以适配全国的画面为 1 倍。滚轮和按钮改 zoom，拖拽改平移，并保证地图不会被拖出画布。 */
function clampMapView(view, width, height) {
  const zoom = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, Number(view?.zoom) || 1))
  const x = Number(view?.x) || 0
  const y = Number(view?.y) || 0
  if (!width || !height) return { zoom, x, y }
  const cx = width / 2
  const cy = height / 2
  const minX = 72 - cx * (1 - zoom) - width * zoom
  const maxX = width - 72 - cx * (1 - zoom)
  const minY = 72 - cy * (1 - zoom) - height * zoom
  const maxY = height - 72 - cy * (1 - zoom)
  return {
    zoom,
    x: Math.min(maxX, Math.max(minX, x)),
    y: Math.min(maxY, Math.max(minY, y)),
  }
}

/* 以鼠标所在点为中心缩放，让该点下的城市留在原地 */
function zoomMapAt(view, mx, my, factor, width, height) {
  const current = clampMapView(view, width, height)
  const nextZoom = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, current.zoom * factor))
  const cx = width / 2
  const cy = height / 2
  const relX = (mx - cx - current.x) / current.zoom
  const relY = (my - cy - current.y) / current.zoom
  return clampMapView({
    zoom: nextZoom,
    x: mx - cx - relX * nextZoom,
    y: my - cy - relY * nextZoom,
  }, width, height)
}

/* 底图按 1 倍缓存；连线、圆点和标签用这个投影画到当前视野，放大后字号不变、能露出更多城市名 */
function applyMapView(project, view, width, height, ratio) {
  const zoom = view?.zoom || 1
  const panX = (view?.x || 0) * ratio
  const panY = (view?.y || 0) * ratio
  if (zoom === 1 && !panX && !panY) return project
  const cx = width / 2
  const cy = height / 2
  return (lon, lat) => {
    const [bx, by] = project(lon, lat)
    return [(bx - cx) * zoom + cx + panX, (by - cy) * zoom + cy + panY]
  }
}

function WeekendReachMap({ cards, filter, tripFilter = 'all', variant = 'weekend', onPick }) {
  const canvasRef = useRef(null)
  const stageRef = useRef(null)
  const layoutRef = useRef([])
  const [base, setBase] = useState(null)
  const [mapErr, setMapErr] = useState('')
  const [hoverKey, setHoverKey] = useState('')
  const [activeKey, setActiveKey] = useState('')
  const [tip, setTip] = useState(null)
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme === 'dark')
  const [view, setView] = useState(MAP_VIEW_HOME)
  const sceneRef = useRef(null)
  const drawRef = useRef(() => {})
  const viewRef = useRef(MAP_VIEW_HOME)
  const dragRef = useRef(null)

  useEffect(() => {
    let alive = true
    loadWeekendMapBase().then((data) => { if (alive) setBase(data) }).catch((err) => {
      if (alive) setMapErr(err.message || '地图没有加载出来')
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    viewRef.current = MAP_VIEW_HOME
    setView(MAP_VIEW_HOME)
    setHoverKey('')
    setActiveKey('')
    setTip(null)
  }, [cards, filter, tripFilter])

  useEffect(() => {
    const root = document.documentElement
    const sync = () => setDark(root.dataset.theme === 'dark')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    const stage = stageRef.current
    if (!canvas || !stage || !base) return undefined
    const draw = () => {
      const ratio = window.devicePixelRatio || 1
      const width = Math.max(320, stage.clientWidth)
      const fullY = MAP_FULL_BOUNDS.maxLat - MAP_FULL_BOUNDS.minLat
      const fullX = (MAP_FULL_BOUNDS.maxLon - MAP_FULL_BOUNDS.minLon) * Math.cos((((MAP_FULL_BOUNDS.minLat + MAP_FULL_BOUNDS.maxLat) / 2) * Math.PI) / 180)
      const height = Math.round(Math.min(560, Math.max(380, (width - 24) * fullY / fullX + 24)))
      const W = Math.floor(width * ratio)
      const H = Math.floor(height * ratio)
      if (canvas.width !== W) canvas.width = W
      if (canvas.height !== H) canvas.height = H
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      const ctx = canvas.getContext('2d')
      const palette = MAP_THEMES[dark ? 'dark' : 'light']
      const sceneKey = `${W}|${H}|${dark}|${filter}|${tripFilter}|${variant}`
      let scene = sceneRef.current
      if (!scene || scene.key !== sceneKey || scene.cards !== cards || scene.base !== base) {
        scene = { ...buildReachScene({ base, cards, filter, tripFilter, variant, width: W, height: H, ratio, palette }), key: sceneKey, cards, base }
        sceneRef.current = scene
      }
      const { spots } = scene
      const mapView = viewRef.current
      const project = applyMapView(scene.project, mapView, W, H, ratio)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const panX = (mapView.x || 0) * ratio
      const panY = (mapView.y || 0) * ratio
      const zoom = mapView.zoom || 1
      ctx.setTransform(zoom, 0, 0, zoom, (W / 2) * (1 - zoom) + panX, (H / 2) * (1 - zoom) + panY)
      ctx.drawImage(scene.layer, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)

      const focusKey = hoverKey || activeKey
      const rgbOf = (spot) => (variant === 'overview'
        ? overviewTone(spot.card.trip, dark)
        : (variant === 'oneway'
          ? tripTone(spot.card.trip, dark).rgb
          : (spot.kind === '666' ? palette.pin666 : palette.pin2666)))
      const arcOrder = [...spots].sort((a, b) => (a.key === focusKey) - (b.key === focusKey))
      for (const spot of arcOrder) {
        const on = spot.key === focusKey
        const overview = variant === 'overview'
        const alpha = on ? 0.88 : (focusKey ? (overview ? 0.24 : 0.06) : (overview ? 0.58 : 0.16))
        const arcRgb = overview || on ? rgbOf(spot) : palette.heat
        const width = (on ? (overview ? 3.4 : 2) : (overview ? 2.6 : 1)) * ratio
        drawRouteArc(
          ctx,
          project(spot.origin.lon, spot.origin.lat),
          project(spot.dest.lon, spot.dest.lat),
          arcRgb,
          alpha,
          width,
          overview ? 0.72 : 0.35,
        )
      }

      const origins = new Map()
      for (const spot of spots) origins.set(spot.origin.city || spot.origin.iata, spot.origin)
      const originBoxes = []
      ctx.font = `600 ${12 * ratio}px "PingFang SC", "Noto Sans SC", sans-serif`
      for (const origin of origins.values()) {
        const [x, y] = project(origin.lon, origin.lat)
        ctx.fillStyle = `rgba(${palette.origin}, 0.14)`
        ctx.beginPath()
        ctx.arc(x, y, 11 * ratio, 0, Math.PI * 2)
        ctx.fill()
        drawMapDot(ctx, x, y, 5 * ratio, `rgb(${palette.origin})`, ratio)
      }
      for (const origin of origins.values()) {
        const [x, y] = project(origin.lon, origin.lat)
        const text = `${origin.city} 出发`
        const w = ctx.measureText(text).width + 4 * ratio
        const h = 16 * ratio
        const slots = [
          { x: x + 10 * ratio, y: y - h / 2 },
          { x: x - w - 10 * ratio, y: y - h / 2 },
          { x: x + 8 * ratio, y: y + 6 * ratio },
          { x: x - w - 8 * ratio, y: y + 6 * ratio },
          { x: x + 8 * ratio, y: y - h - 6 * ratio },
          { x: x - w - 8 * ratio, y: y - h - 6 * ratio },
        ]
        const box = slots.find((c) => !originBoxes.some((o) => !(c.x + w < o.x || o.x + o.w < c.x || c.y + h < o.y || o.y + o.h < c.y))) || slots[0]
        originBoxes.push({ ...box, w, h })
        ctx.lineWidth = 3 * ratio
        ctx.strokeStyle = palette.halo
        ctx.strokeText(text, box.x + 2 * ratio, box.y + 12 * ratio)
        ctx.fillStyle = `rgb(${palette.origin})`
        ctx.fillText(text, box.x + 2 * ratio, box.y + 12 * ratio)
      }

      const dotR = (spot) => (3.5 + 2.5 * (spot.level || 0)) * ratio
      const ordered = [...spots].sort((a, b) => a.score - b.score)
      for (const spot of ordered) {
        const [x, y] = project(spot.dest.lon, spot.dest.lat)
        const hot = spot.key === focusKey
        if (hot) {
          ctx.fillStyle = `rgba(${rgbOf(spot)}, 0.18)`
          ctx.beginPath()
          ctx.arc(x, y, dotR(spot) + 7 * ratio, 0, Math.PI * 2)
          ctx.fill()
        }
        const dotRadius = dotR(spot) + (hot ? 1.5 * ratio : 0)
        if (variant === 'overview') drawTierDot(ctx, x, y, dotRadius, rgbOf(spot), ratio, spot.kind !== '666')
        else drawMapDot(ctx, x, y, dotRadius, `rgb(${rgbOf(spot)})`, ratio)
      }

      const placed = [
        ...originBoxes,
        ...[...origins.values()].map((origin) => {
          const [x, y] = project(origin.lon, origin.lat)
          return { x: x - 7 * ratio, y: y - 7 * ratio, w: 14 * ratio, h: 14 * ratio }
        }),
        ...spots.map((spot) => {
          const [x, y] = project(spot.dest.lon, spot.dest.lat)
          const r = dotR(spot) + 2 * ratio
          return { x: x - r, y: y - r, w: r * 2, h: r * 2 }
        }),
      ]
      const labelOrder = [...spots].sort((a, b) => (b.key === focusKey) - (a.key === focusKey) || b.score - a.score)
      const layout = []
      const cityFont = `600 ${12 * ratio}px "PingFang SC", "Noto Sans SC", sans-serif`
      const subFont = `${11 * ratio}px "PingFang SC", "Noto Sans SC", sans-serif`
      for (const spot of labelOrder) {
        const [x, y] = project(spot.dest.lon, spot.dest.lat)
        const city = spot.card.city || spot.dest.city
        const caption = spot.mapCaption
        const forced = spot.key === focusKey
        ctx.font = cityFont
        const cityW = ctx.measureText(city).width
        ctx.font = subFont
        const subW = caption ? ctx.measureText(caption).width : 0
        const gap = 6 * ratio
        const w = cityW + (subW ? gap + subW : 0) + 16 * ratio
        const h = 22 * ratio
        const off = dotR(spot) + 6 * ratio
        const candidates = [
          { x: x + off, y: y - h / 2 },
          { x: x - w - off, y: y - h / 2 },
          { x: x - w / 2, y: y - h - off },
          { x: x - w / 2, y: y + off },
          { x: x + off, y: y - h - 2 * ratio },
          { x: x - w - off, y: y - h - 2 * ratio },
          { x: x + off, y: y + 2 * ratio },
          { x: x - w - off, y: y + 2 * ratio },
        ]
        let box = null
        for (const candidate of candidates) {
          const next = { ...candidate, w, h }
          const outside = next.x < 4 || next.y < 4 || next.x + next.w > W - 4 || next.y + next.h > H - 4
          const hit = placed.some((item) => !(next.x + next.w < item.x || item.x + item.w < next.x || next.y + next.h < item.y || item.y + item.h < next.y))
          if (!outside && (!hit || forced)) {
            box = next
            break
          }
        }
        if (!box && !forced) {
          layout.push({ ...spot, hitX: x / ratio, hitY: y / ratio })
          continue
        }
        if (!box) box = { ...candidates[0], w, h }
        placed.push(box)
        ctx.save()
        ctx.shadowColor = palette.shadow
        ctx.shadowBlur = (forced ? 10 : 4) * ratio
        ctx.shadowOffsetY = 1 * ratio
        roundBox(ctx, box.x, box.y, box.w, box.h, 6 * ratio)
        ctx.fillStyle = palette.card
        ctx.fill()
        ctx.shadowColor = 'transparent'
        ctx.lineWidth = ratio
        ctx.strokeStyle = forced ? `rgba(${rgbOf(spot)}, 0.7)` : palette.border
        ctx.stroke()
        ctx.restore()
        const baseY = box.y + h / 2 + 4 * ratio
        ctx.font = cityFont
        ctx.fillStyle = palette.text
        ctx.fillText(city, box.x + 8 * ratio, baseY)
        if (caption) {
          ctx.font = subFont
          ctx.fillStyle = palette.muted
          ctx.fillText(caption, box.x + 8 * ratio + cityW + gap, baseY)
        }
        layout.push({
          ...spot,
          hitX: x / ratio,
          hitY: y / ratio,
          tipX: box.x / ratio,
          tipY: box.y / ratio,
          label: { x: box.x / ratio, y: box.y / ratio, w: box.w / ratio, h: box.h / ratio },
        })
      }
      layoutRef.current = layout
    }
    drawRef.current = draw
    draw()
    const observer = new ResizeObserver(() => drawRef.current())
    observer.observe(stage)
    return () => observer.disconnect()
  }, [base, cards, filter, tripFilter, hoverKey, activeKey, variant, dark])

  useEffect(() => {
    viewRef.current = view
    drawRef.current()
  }, [view])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const factor = event.deltaY > 0 ? 1 / 1.18 : 1.18
      const next = zoomMapAt(viewRef.current, event.clientX - rect.left, event.clientY - rect.top, factor, rect.width, rect.height)
      viewRef.current = next
      setView(next)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [mapErr])

  const pickSpot = (event) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    for (const spot of layoutRef.current) {
      const label = spot.label
      if (label && x >= label.x && y >= label.y && x <= label.x + label.w && y <= label.y + label.h) return spot
    }
    let best = null
    let bestD = 18
    for (const spot of layoutRef.current) {
      const dist = Math.hypot(x - spot.hitX, y - spot.hitY)
      if (dist < bestD) {
        best = spot
        bestD = dist
      }
    }
    return best
  }

  const showTip = (spot) => {
    if (!spot) {
      setHoverKey('')
      setTip(null)
      return
    }
    const out = spot.card.outs[0]
    const back = variant === 'oneway' ? spot.card.backs?.[0] : spot.card.backs[0]
    const timed = [...(spot.card.outs?.length ? spot.card.outs : spot.card.backs || [])].sort((a, b) => String(a.dep_time || '').localeCompare(String(b.dep_time || '')))
    const dateRows = variant === 'overview' ? (spot.card.byDate || []) : []
    const outLines = variant === 'overview'
      ? dateRows.slice(0, 4).map((row) => {
        const md = String(row.date || '').slice(5).replace('-', '/')
        const bits = [`${row.flights}班`]
        if (row['666']) bits.push(`666 ${row['666']}`)
        if (row['2666']) bits.push(`2666 ${row['2666']}`)
        return `${md} ${bits.join(' · ')}`
      })
      : variant === 'oneway'
      ? timed.slice(0, 4).map((flight) => `${spot.card.trip === 'back' ? '回程 ' : ''}${timeFlyLabel(flight.dep_time) || flight.dep_time || '--:--'}${flight.arr_time ? ` → ${flight.arr_time}` : ''}`)
      : (out ? [`${out.flight_no}  ${out.dep_time || '--:--'}`] : [])
    if (variant === 'overview' && dateRows.length > 4) outLines.push(`另有 ${dateRows.length - 4} 天有班`)
    if (variant === 'overview' && !dateRows.length) {
      for (const flight of (spot.card.outs || []).filter((item) => item.flight_no).slice(0, 3)) {
        outLines.push(`回程 ${flight.flight_no}${flight.dep_time ? `  ${flight.dep_time}` : ''}`)
      }
    }
    if (variant === 'oneway') {
      const rest = timeFlyLabels(timed.slice(4), 3)
      if (rest.length) outLines.push(rest.join(' / '))
    }
    setHoverKey(spot.key)
    setTip({
      key: spot.key,
      x: spot.hitX + 14,
      y: Math.max(8, spot.hitY - 72),
      city: spot.card.city,
      from: spot.card.fromCity,
      score: spot.score,
      product: spot.product,
      caption: spot.caption,
      outLines,
      tripText: variant === 'oneway' ? tripLabel(spot.card) : '',
      backText: variant === 'oneway'
        ? (back?.dep_time ? `回程 ${timeFlyLabel(back.dep_time) || back.dep_time}` : '')
        : (back ? `${back.flight_no}  ${back.dep_time || '--:--'}` : ''),
    })
  }

  const shown = visibleMapCards(cards, filter, variant, tripFilter)
  const originNames = [...new Set(shown.map((card) => card.fromCity).filter(Boolean))]
  const zoomBy = (factor) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const next = zoomMapAt(viewRef.current, rect.width / 2, rect.height / 2, factor, rect.width, rect.height)
    viewRef.current = next
    setView(next)
  }
  return (
    <div className="weekend-map">
      <div className="weekend-map-head">
        <div>
          <b>当前出发地：{originNames.join('、') || '未选'}</b>
          <span>（{new Set(shown.map((card) => card.city)).size} 个可达城市 · 点城市{variant === 'overview' ? '查看航班' : variant === 'oneway' ? '筛选列表' : '查看方案'} · 滚轮缩放，拖拽平移）</span>
        </div>
        <div className="weekend-map-legend">
          {variant === 'overview' ? (
            <>
              <span><i className="map-dot is-soft-round" />绿 往返</span>
              <span><i className="map-dot is-soft-out" />橙 只有去</span>
              <span><i className="map-dot is-soft-back" />蓝 只有回</span>
              <span><i className="map-dot is-soft-solid" />实心 666</span>
              <span><i className="map-dot is-soft-hollow" />空心 2666</span>
            </>
          ) : variant === 'oneway' ? (
            <>
              <span><i className="map-dot is-round" />往返</span>
              <span><i className="map-dot is-out" />有去无回</span>
              <span><i className="map-dot is-back" />有回无去</span>
            </>
          ) : (
            <>
              <span><i className="map-dot is-round" />双程 666</span>
              <span><i className="map-dot is-muted" />2666 专享</span>
            </>
          )}
          <span className="map-heat-legend" title={variant === 'overview' ? '热度按所选日期内的去程和回程班次' : '热度按该城市可选的去程 + 回程班次数计算'}>
            可选班次 少<i aria-hidden="true" />多
          </span>
        </div>
      </div>
      {mapErr ? <Alert type="error" showIcon message={mapErr} /> : (
        <div className="weekend-map-stage" ref={stageRef}>
          <div className="map-zoom" role="group" aria-label="滚轮缩放，拖拽平移">
            <button type="button" aria-label="放大" onClick={() => zoomBy(1.3)}>＋</button>
            <button type="button" aria-label="缩小" onClick={() => zoomBy(1 / 1.3)}>－</button>
            <button type="button" aria-label="回到全图" onClick={() => { viewRef.current = MAP_VIEW_HOME; setView(MAP_VIEW_HOME) }}>复位</button>
            <span className="map-zoom-level">{Math.round(view.zoom * 100)}%</span>
          </div>
          <canvas
            ref={canvasRef}
            onPointerDown={(event) => {
              if (event.button != null && event.button !== 0) return
              dragRef.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                view: viewRef.current,
                moved: false,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              if (drag && drag.id === event.pointerId) {
                const dx = event.clientX - drag.x
                const dy = event.clientY - drag.y
                if (!drag.moved && Math.hypot(dx, dy) < 5) return
                drag.moved = true
                event.currentTarget.classList.add('is-grabbing')
                const rect = event.currentTarget.getBoundingClientRect()
                const next = clampMapView({
                  zoom: drag.view.zoom,
                  x: drag.view.x + dx,
                  y: drag.view.y + dy,
                }, rect.width, rect.height)
                viewRef.current = next
                setView(next)
                return
              }
              const spot = pickSpot(event)
              if ((spot?.key || '') === hoverKey) return
              showTip(spot)
            }}
            onPointerUp={(event) => {
              const drag = dragRef.current
              event.currentTarget.classList.remove('is-grabbing')
              if (!drag || drag.id !== event.pointerId) return
              dragRef.current = null
              if (drag.moved) {
                showTip(null)
                return
              }
              const spot = pickSpot(event)
              if (!spot) return
              setActiveKey(spot.key)
              showTip(spot)
              if (onPick) onPick(spot.card)
            }}
            onPointerCancel={() => {
              dragRef.current = null
              canvasRef.current?.classList.remove('is-grabbing')
            }}
            onPointerLeave={() => {
              if (!dragRef.current) showTip(null)
            }}
          />
          {tip && (
            <div className="weekend-map-tip" style={{ left: tip.x, top: tip.y }}>
              <b>{tip.city}</b>
              <span>{variant === 'overview' ? `从${tip.from}出发` : variant === 'oneway' ? `从${tip.from}出发 · ${tip.tripText}` : `从${tip.from}出发 · 可选 ${tip.caption.split(' · ')[1] || ''}`}</span>
              <span className={String(tip.product).startsWith('2666') ? 'is-muted' : ''}>{tip.product}</span>
              {(tip.outLines || []).map((line) => <span key={line}>{variant === 'weekend' ? `去程 ${line}` : line}</span>)}
              {tip.backText ? <span>返程 {tip.backText}</span> : null}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DatePickCalendar({ dates = [], value = [], onChange, single = false, after = '' }) {
  const allowed = useMemo(() => new Set(dates), [dates])
  const selected = useMemo(() => new Set(single ? (value ? [value] : []) : (value || [])), [value, single])
  const now = dayjs()
  const sorted = useMemo(() => [...dates].sort(), [dates])
  const minMonth = sorted.length ? dayjs(sorted[0]).startOf('month') : now.startOf('month')
  const maxMonth = sorted.length ? dayjs(sorted[sorted.length - 1]).startOf('month') : now.startOf('month')
  const pickedMonth = single && value ? dayjs(value).startOf('month') : null
  const startMonth = pickedMonth || now.startOf('month')
  const initial = startMonth.isBefore(minMonth) ? minMonth : startMonth.isAfter(maxMonth) ? maxMonth : startMonth
  const [view, setView] = useState(initial)
  const rangeKey = `${sorted[0] || ''}|${sorted[sorted.length - 1] || ''}|${single ? value || '' : ''}`
  useEffect(() => { setView(initial) }, [rangeKey])

  const go = (delta) => {
    setView((v) => {
      let nv = v.add(delta, 'month')
      if (nv.isBefore(minMonth)) nv = minMonth
      else if (nv.isAfter(maxMonth)) nv = maxMonth
      return nv
    })
  }

  const emit = (next) => {
    if (onChange) onChange([...new Set(next)].sort())
  }
  const toggle = (ds) => {
    if (!allowed.has(ds) || (after && ds <= after)) return
    if (single) {
      if (onChange) onChange(ds)
      return
    }
    emit(selected.has(ds) ? (value || []).filter((d) => d !== ds) : [...(value || []), ds])
  }
  const weekendsOf = (onlyMonth) => dates.filter((ds) => {
    const d = dayjs(ds)
    const iso = d.day() === 0 ? 7 : d.day()
    if (iso < 6) return false
    return !onlyMonth || d.isSame(view, 'month')
  })
  const weekendCount = (single ? (value ? [value] : []) : (value || [])).filter((ds) => {
    const d = dayjs(ds)
    const iso = d.day() === 0 ? 7 : d.day()
    return iso >= 6
  }).length
  const weekendPicks = weekendPicksForDates(dates)
  const toggleWeekend = (days) => {
    const cur = new Set(value || [])
    const allOn = days.every((ds) => cur.has(ds))
    days.forEach((ds) => (allOn ? cur.delete(ds) : cur.add(ds)))
    emit([...cur])
  }

  const first = view.startOf('month')
  const offset = (first.day() === 0 ? 7 : first.day()) - 1
  const cells = []
  for (let i = 0; i < offset; i++) cells.push(null)
  for (let d = 1; d <= view.daysInMonth(); d++) cells.push(first.date(d))
  while (cells.length % 7 !== 0) cells.push(null)

  return (
    <div className="cal-wrap">
      <div className="cal-head">
        <Button type="text" icon={<ChevronLeftIcon />} aria-label="上个月" disabled={view.isSame(minMonth, 'month')} onClick={() => go(-1)} />
        <div className="cal-title">{view.format('YYYY年M月')}</div>
        <Button type="text" icon={<ChevronRightIcon />} aria-label="下个月" disabled={!sorted.length || view.isSame(maxMonth, 'month')} onClick={() => go(1)} />
      </div>
      <div className="cal-week" aria-hidden="true">
        {WEEK_LABELS.map((w, i) => <div key={w} className={i >= 5 ? 'cal-week-end' : undefined}>{w}</div>)}
      </div>
      <div className="cal-grid" role="grid" aria-label={`${view.format('YYYY年M月')}，点选要监控的日期`}>
        {cells.map((d, i) => {
          if (!d) return <div key={i} className="cal-cell cal-cell-blank" />
          const ds = d.format('YYYY-MM-DD')
          const weekend = d.day() === 0 || d.day() === 6
          const can = allowed.has(ds) && !(after && ds <= after)
          const on = selected.has(ds)
          return (
            <button
              key={ds}
              type="button"
              className={`cal-cell${weekend ? ' cal-cell-weekend' : ''}${can ? ' cal-cell-pick' : ' cal-cell-locked'}${on ? ' cal-cell-picked' : ''}${d.isSame(now, 'day') ? ' cal-cell-today' : ''}`}
              disabled={!can}
              aria-pressed={on}
              aria-label={`${d.format('M月D日')}${weekend ? ' 周末' : ''}${can ? (on ? ' 已选' : ' 可选') : ' 不可选'}`}
              onClick={() => toggle(ds)}
            >
              <span className="cal-num">{d.date()}</span>
              {on && <span className="cal-check" aria-hidden="true" />}
            </button>
          )
        })}
      </div>
      {!single && weekendPicks.length > 0 && (
        <div className="cal-quick">
          <span>最近周末</span>
          {weekendPicks.map((pick) => {
            const on = pick.days.every((ds) => selected.has(ds))
            return (
              <Button key={pick.key} size="small" type={on ? 'primary' : 'default'} onClick={() => toggleWeekend(pick.days)}>
                {pick.label}
              </Button>
            )
          })}
        </div>
      )}
      <div className="cal-legend">
        {single ? (
          <span>{value ? `已选 ${monitorDayLabel(value)}` : '点一天'}</span>
        ) : (
          <>
            <span>已选 {value?.length || 0} 天，其中周六日 {weekendCount} 天</span>
            <Button size="small" type="default" onClick={() => emit([...(value || []), ...weekendsOf(true)])}>本月周六日</Button>
            <Button size="small" type="default" onClick={() => emit([...(value || []), ...weekendsOf(false)])}>全部周六日</Button>
            <Button size="small" type="text" onClick={() => emit([])}>清空</Button>
          </>
        )}
      </div>
    </div>
  )
}

const FLIGHT_RECENT_KEY = 'hna-flight-query-recent'

function loadFlightRecent() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(FLIGHT_RECENT_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set()
    return raw.filter((item) => {
      if (!item || !(item.from || item.to)) return false
      const key = recentKey(item)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).slice(0, 6)
  } catch (e) {
    return []
  }
}

/* 历史里既有「深圳」也有「深圳（SZX）·深圳宝安国际」，按城市名归并 */
function recentKey(item) {
  return `${cityNameOf(item.from)}|${cityNameOf(item.to)}|${item.product || 'all'}`
}

function recentLabel(item) {
  const product = item.product && item.product !== 'all' ? ` · ${item.product}` : ''
  return `${cityNameOf(item.from) || '任意出发'} → ${cityNameOf(item.to) || '任意到达'}${product}`
}

function writeFlightRecent(list) {
  const next = list.filter((item) => item && (item.from || item.to)).slice(0, 6)
  try { window.localStorage.setItem(FLIGHT_RECENT_KEY, JSON.stringify(next)) } catch (e) { /* ignore */ }
  return next
}

function saveFlightRecent(from, to, product) {
  const item = { from: from || '', to: to || '', product: product || 'all' }
  if (!item.from && !item.to) return loadFlightRecent()
  const key = recentKey(item)
  const current = loadFlightRecent()
  if (current.some((row) => recentKey(row) === key)) return current
  return writeFlightRecent([item, ...current])
}

function removeFlightRecent(item) {
  const key = recentKey(item)
  return writeFlightRecent(loadFlightRecent().filter((row) => recentKey(row) !== key))
}

function FlightQuery({ msg, onChanged, onGo, priceQuery, tierBlockRules, flightDetail, defaultMail = '' }) {
  const [form] = Form.useForm()
  const [recent, setRecent] = useState(() => loadFlightRecent())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState('')
  const [prices, setPrices] = useState(null)
  const [priceLoading, setPriceLoading] = useState(false)
  const [priceTried, setPriceTried] = useState(false)
  const [stopsInfo, setStopsInfo] = useState(null)
  const [timesMap, setTimesMap] = useState(null) // 实时起降时刻/航站楼（查价后覆盖底表静态 CSV 时刻）
  const [seatsInfo, setSeatsInfo] = useState(null) // 实时余票/舱位（按档位）
  const [calRec, setCalRec] = useState(null)
  // 前端查价频控锁（防风控）：发起查价后锁定 priceQuery.min_interval 秒，避免连点
  const priceLockRef = useRef(0)
  const [seatBusy, setSeatBusy] = useState(false)
  // 出发/到达联动选项（基于当前筛选条件可搜到的航线两端城市）
  const [linkOpts, setLinkOpts] = useState({ from: [], to: [] })
  const [queryKind, setQueryKind] = useState('weekend')
  const [weekendOrigins, setWeekendOrigins] = useState([])
  const [routeOrigins, setRouteOrigins] = useState([])
  const [routeOriginOpen, setRouteOriginOpen] = useState(false)
  const [weekendLeave, setWeekendLeave] = useState('none')
  const [weekendPattern, setWeekendPattern] = useState('fri')
  const [weekendPick, setWeekendPick] = useState(WEEKEND_RECOMMEND_FROM)
  const [weekendDates, setWeekendDates] = useState(null)
  const [customCalOpen, setCustomCalOpen] = useState(false)
  const [weekendCards, setWeekendCards] = useState(null)
  const [weekendMeta, setWeekendMeta] = useState(null)
  const [watchCityKey, setWatchCityKey] = useState('')
  const [reachFilter, setReachFilter] = useState('all')
  const [heatDir, setHeatDir] = useState('all')
  const [originOpen, setOriginOpen] = useState(false)
  const [weekendView, setWeekendView] = useState('list')
  const [onewayCity, setOnewayCity] = useState('')
  const [onewayHeat, setOnewayHeat] = useState(null)
  const [onewayHeatLoading, setOnewayHeatLoading] = useState(false)
  const [onewayHeatErr, setOnewayHeatErr] = useState('')
  const [onewayTrip, setOnewayTrip] = useState('all')
  const [originRecent, setOriginRecent] = useState(loadOriginRecent)
  const originDefaulted = useRef(false)
  const routeOriginDefaulted = useRef(false)
  // 周末雷达的出发地候选取全量出发城市，不受往返/单程表单里的出发地、到达地筛选影响
  const [allOrigins, setAllOrigins] = useState([])
  useEffect(() => {
    api.flightOptions({}).then((r) => setAllOrigins(r.from_options || [])).catch(() => {})
  }, [])
  useEffect(() => {
    if (originDefaulted.current) return
    setWeekendOrigins((prev) => {
      if (prev.length) {
        originDefaulted.current = true
        return prev
      }
      const label = allOrigins.find((item) => cityNameOf(item) === '深圳')
      if (!label) return prev
      originDefaulted.current = true
      return [label]
    })
  }, [allOrigins])
  useEffect(() => {
    if (routeOriginDefaulted.current) return
    setRouteOrigins((prev) => {
      if (prev.length) {
        routeOriginDefaulted.current = true
        return prev
      }
      if (!allOrigins.length) return prev
      const last = loadFlightRecent()[0]
      const label = matchOriginLabel(allOrigins, last?.from) || allOrigins.find((item) => cityNameOf(item) === '深圳')
      if (!label) return prev
      routeOriginDefaulted.current = true
      return [label]
    })
  }, [allOrigins])
  // 结果行勾选（批量转监控）与弹窗状态
  const [selKeys, setSelKeys] = useState([])
  const [batchOpen, setBatchOpen] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchGroups, setBatchGroups] = useState([])
  const [batchMinSeats, setBatchMinSeats] = useState(0) // 0=不限
  const [batchCabins, setBatchCabins] = useState([]) // 舱位白名单，空=不限
  const [batchTier, setBatchTier] = useState([]) // 档位条件多选白名单：666/2666/66666；空数组=不限（全部档位）
  const [batchMail, setBatchMail] = useState('')
  const [weekendMail, setWeekendMail] = useState(null)
  const [batchSummary, setBatchSummary] = useState(null)
  const [batchMode, setBatchMode] = useState('single') // 弹窗标题模式：single=转为监控任务 / batch=批量转为监控任务
  const [roundTrip, setRoundTrip] = useState(false)
  const [roundBusy, setRoundBusy] = useState(false)
  // 「未选日期」提示：用户可关闭，下次查询（重新触发该逻辑）时再出现
  const [dateWarnDismissed, setDateWarnDismissed] = useState(false)
  // 冻结查询列：开启时固定首列（航班号）+ 后四列（原价/优惠价/余票舱位/操作），横向滚动时仍可见
  // 默认不冻结（用户手动开启）
  const [freezeQuery, setFreezeQuery] = useState(false)
  const queryCardRef = useRef(null)
  const resultCardRef = useRef(null)

  // 默认停在周末雷达，它的「目的地」与往返/单程共用 to 字段：首屏不回填到达地，切到往返/单程时再补
  useEffect(() => {
    const last = loadFlightRecent()[0]
    if (!last) return
    form.setFieldsValue({ product: last.product || 'all' })
  }, [form])

  const watch = Form.useWatch([], form)
  const dateMode = (watch && watch.dateMode) || 'none'
  useEffect(() => {
    if (queryKind === 'round' && dateMode !== 'range') form.setFieldsValue({ dateMode: 'range' })
  }, [queryKind, dateMode, form])
  // 「只能查/显示当天及以后」：日期选择器禁过去；转监控弹窗的日期池同样剔除过去日期
  const todayStr = dayjs().format('YYYY-MM-DD')
  const todayDisabled = (d) => d.isBefore(dayjs(), 'day')

  // 联动选项：watch 筛选条件（含日期模式），debounce 250ms 调 /api/flights/options
  useEffect(() => {
    if (!watch) return undefined
    const timer = setTimeout(() => {
      const from = routeOrigins.length === 1 ? String(routeOrigins[0] || '').trim() : ''
      const to = String(watch.to || '').trim()
      let date = ''
      let date_start = ''
      let date_end = ''
      if (watch.dateMode === 'single' && watch.date) date = watch.date.format('YYYY-MM-DD')
      else if (watch.dateMode === 'range' && watch.dateRange && watch.dateRange.length === 2) {
        date_start = watch.dateRange[0].format('YYYY-MM-DD')
        date_end = watch.dateRange[1].format('YYYY-MM-DD')
      }
      const params = {
        to: to ? cityNameOf(to) : '',
        product: watch.product === 'all' ? '' : watch.product,
        date,
        date_start,
        date_end,
      }
      // 出发地候选不能被已选出发地收窄，否则选过一个城市后选择器里只剩它自己
      Promise.all([
        api.flightOptions({ ...params, from: from ? cityNameOf(from) : '' }),
        from ? api.flightOptions({ ...params, from: '' }) : null,
      ]).then(([r, all]) => {
        const next = { from: (all || r).from_options || [], to: r.to_options || [] }
        // 当前已选值若不在返回选项里（如手输三字码），并入以避免选中值消失
        for (const label of routeOrigins) {
          if (label && !next.from.includes(label)) next.from = [label, ...next.from]
        }
        if (to && !next.to.includes(to)) next.to = [to, ...next.to]
        setLinkOpts(next)
      }).catch(() => {})
    }, 250)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watch, routeOrigins])

  const heatKey = [
    queryKind,
    routeOrigins.map(cityNameOf).join('|'),
    watch?.product || '',
    watch?.dateMode || '',
    watch?.dateMode === 'single' && watch?.date ? watch.date.format('YYYY-MM-DD') : '',
    watch?.dateMode === 'range' && watch?.dateRange?.length === 2 ? watch.dateRange[0].format('YYYY-MM-DD') : '',
    watch?.dateMode === 'range' && watch?.dateRange?.length === 2 ? watch.dateRange[1].format('YYYY-MM-DD') : '',
  ].join('~')
  useEffect(() => {
    if (queryKind !== 'oneway') return undefined
    const origins = routeOrigins.slice(0, WEEKEND_ORIGIN_LIMIT)
    if (!origins.length) {
      setOnewayHeat(null)
      return undefined
    }
    const product = !watch || watch.product === 'all' ? '' : (watch.product || '')
    let date = ''
    let date_start = ''
    let date_end = ''
    if (watch?.dateMode === 'single' && watch.date) date = watch.date.format('YYYY-MM-DD')
    else if (watch?.dateMode === 'range' && watch.dateRange && watch.dateRange.length === 2) {
      date_start = watch.dateRange[0].format('YYYY-MM-DD')
      date_end = watch.dateRange[1].format('YYYY-MM-DD')
    }
    let alive = true
    const timer = setTimeout(() => {
      setOnewayHeatLoading(true)
      Promise.all(origins.map((label) => api.flightHeatmap({
        from: cityNameOf(label),
        product,
        date,
        date_start,
        date_end,
      }))).then((list) => {
        if (!alive) return
        setOnewayHeat(list)
        setOnewayHeatErr('')
      }).catch((err) => {
        if (!alive) return
        setOnewayHeatErr(err.message || '目的地热力图没有加载出来')
      }).finally(() => {
        if (alive) setOnewayHeatLoading(false)
      })
    }, 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // heatKey 已覆盖出发地、日期和档位；watch / routeOrigins 只在回调里读当前值
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heatKey])

  const optProps = (list) => ({
    showSearch: true,
    allowClear: true,
    // 只显示城市名；搜索仍匹配完整「城市（IATA）·机场」，三字码/机场名也能搜到
    options: list.map((v) => ({ value: v, label: cityNameOf(v) || v })),
    filterOption: (input, opt) => {
      const q = String(input || '').toUpperCase().trim()
      return String(opt.value ?? opt.label).toUpperCase().includes(q)
    },
    notFoundContent: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="当前条件下没有可联动城市" />,
  })

  const scanWeekend = async (patternKey, planIndex, values, originOverride, dateOverride) => {
    const origins = (originOverride || weekendOrigins).slice(0, WEEKEND_ORIGIN_LIMIT)
    const to = String(values.to || '').trim()
    const pattern = WEEKEND_PATTERNS.find((item) => item.key === patternKey) || WEEKEND_PATTERNS[0]
    const plan = findWeekendPlan(planIndex)
    setErrMsg('')
    setWeekendCards(null)
    setWeekendMeta(null)
    if (!origins.length) {
      setErrMsg('周末雷达至少选一个出发地，最多 5 个。目的地可以不选。')
      return
    }
    if (!plan) {
      setErrMsg('没有可推荐的周末。')
      return
    }
    const chosen = dateOverride?.out && dateOverride?.back
      ? dateOverride
      : (pattern.key === 'custom' && weekendDates?.out && weekendDates?.back ? weekendDates : null)
    if (pattern.key === 'custom' && !chosen) {
      setErrMsg('自选日期要先点完去程和返程。')
      return
    }
    setLoading(true)
    try {
      const outDate = chosen?.out || plan[pattern.outDay].format('YYYY-MM-DD')
      const backDate = chosen?.back || plan[pattern.backDay || 'sun'].format('YYYY-MM-DD')
      const span = staySpanLabel(outDate, backDate)
      const product = values.product === 'all' ? '' : (values.product || '')
      const lists = await Promise.all(origins.map(async (label) => {
        const city = cityNameOf(label)
        const outQuery = { from: city, date: outDate, product, limit: 2000 }
        const backQuery = { to: city, date: backDate, product, limit: 2000 }
        if (to) {
          outQuery.to = cityNameOf(to)
          backQuery.from = cityNameOf(to)
        }
        const [outbound, inbound] = await Promise.all([
          api.flightQuery(outQuery),
          api.flightQuery(backQuery),
        ])
        return pairWeekendCities(outbound.records, inbound.records, pattern).map((card) => ({
          ...card,
          fromCity: city,
          fromLabel: label,
          leave: pattern.leave,
          badge: pattern.key === 'custom' && span ? span : pattern.badge,
          outDate,
          backDate,
        }))
      }))
      const cards = lists.flat().sort((a, b) => (
        pairScore(b.outs[0], b.backs[0]) - pairScore(a.outs[0], a.backs[0])
        || a.fromCity.localeCompare(b.fromCity, 'zh')
        || a.city.localeCompare(b.city, 'zh')
      ))
      setWeekendCards(cards)
      setWeekendMeta({ title: pattern.title, outDate, backDate, span, origins: origins.map(cityNameOf) })
      setRecent(saveFlightRecent(origins[0], to, values.product || 'all'))
    } catch (e) {
      setErrMsg(e.message)
    } finally {
      setLoading(false)
    }
  }

  const reservePriceQuery = async () => {
    const pq = priceQuery || {}
    if (pq.enabled === false) throw new Error('实时查价已关闭（防风控），可在「监控管理」重新开启。')
    const interval = Math.max(8, Number(pq.min_interval) || 8) * 1000
    const wait = priceLockRef.current - Date.now()
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
    priceLockRef.current = Date.now() + interval
  }

  const readWeekendSeat = (payload, flightNo) => {
    if (payload?.disabled) {
      return { plusNote: payload.prices?.plus?.note || '实时查价已关闭' }
    }
    const want = String(flightNo || '').replace(/\s+/g, '').toUpperCase()
    const pick = (map) => {
      if (!map) return null
      if (map[flightNo]) return map[flightNo]
      const key = Object.keys(map).find((item) => item.replace(/\s+/g, '').toUpperCase() === want)
      return key ? map[key] : null
    }
    const plus = pick(payload?.seats?.plus)
    const normal = pick(payload?.seats?.normal)
    const plusPrice = pick(payload?.prices?.plus?.prices)
    return {
      plusSeats: plus ? plus.seats : null,
      plusCabins: plus?.cabins || [],
      plusPrice: plusPrice == null ? null : Number(plusPrice),
      plusNote: payload?.prices?.plus?.note || '',
      normalSeats: normal ? normal.seats : null,
    }
  }

  const checkWeekendSeats = async (flight, date) => {
    if (!flight?.origin?.iata || !flight?.dest?.iata) throw new Error('这班缺少机场三字码，没法查余票。')
    await reservePriceQuery()
    let payload
    try {
      payload = await api.flightPrices({ from: flight.origin.iata, to: flight.dest.iata, date })
    } catch (err) {
      if (!(err.status === 429 && err.retry_after)) throw err
      priceLockRef.current = Date.now() + err.retry_after * 1000
      await new Promise((resolve) => setTimeout(resolve, err.retry_after * 1000))
      await reservePriceQuery()
      payload = await api.flightPrices({ from: flight.origin.iata, to: flight.dest.iata, date })
    }
    return readWeekendSeat(payload, flight.flight_no)
  }

  const followWeekend = async (card) => {
    const mailParts = String(weekendMail ?? defaultMail).split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
    if (mailParts.some((part) => !part.includes('@'))) {
      msg.error('收件人要写成邮箱，多个用逗号分开')
      return
    }
    const items = [
      ...card.outs.map((flight) => ({ flight, date: card.outDate })),
      ...card.backs.map((flight) => ({ flight, date: card.backDate })),
    ].map(({ flight, date }) => ({
      from_code: flight.origin?.iata,
      to_code: flight.dest?.iata,
      dates: [date],
      product: flight.product,
      flight_no: flight.flight_no,
      dep_time: flight.dep_time,
      arr_time: flight.arr_time,
      ...(mailParts.length ? { notify_email: mailParts.join(',') } : {}),
    }))
    const outbound = items.find((item) => item.dates[0] === card.outDate)
    const inbound = items.find((item) => item !== outbound && item.dates[0] === card.backDate)
    if (outbound?.flight_no && inbound?.flight_no) {
      outbound.round_pairs = {
        [card.outDate]: { role: 'out', mate_date: card.backDate, mate_flight: inbound.flight_no },
      }
      inbound.round_pairs = {
        [card.backDate]: { role: 'back', mate_date: card.outDate, mate_flight: outbound.flight_no },
      }
    }
    setWatchCityKey(`${card.fromCity}|${card.city}`)
    try {
      const r = await api.addTasksBatch(items)
      const go = card.outs[0]
      const back = card.backs[0]
      msg.success(`已关注 ${card.city}：${go?.flight_no || '去程'} ${card.outDate}，${back?.flight_no || '返程'} ${card.backDate}`)
      if (onChanged) onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setWatchCityKey('')
    }
  }

  const submit = async (values, originOverride, kindOverride, detailFlights) => {
    const kind = kindOverride || queryKind
    const origins = (originOverride || routeOrigins).slice(0, WEEKEND_ORIGIN_LIMIT)
    const from = origins[0] ? cityNameOf(origins[0]) : ''
    const to = String(values.to || '').trim()
    if (kind === 'weekend') {
      await scanWeekend(weekendPattern, weekendPick, values)
      return
    }
    setLoading(true)
    setErrMsg('')
    setResult(null)
    setPrices(null)
    setStopsInfo(null)
    setTimesMap(null)
    setSeatsInfo(null)
    setPriceTried(false)
    setSelKeys([])
    setDateWarnDismissed(false)
    try {
      if (!origins.length) {
        setErrMsg('至少选一个出发地，最多 5 个。')
        return
      }
      const queryParams = {
        to: to ? cityNameOf(to) : '',
        product: values.product === 'all' ? '' : values.product,
        flight_no: String(values.flight_no || '').trim(),
      }
      if (kind === 'round') {
        if (!to) {
          setErrMsg('往返查询需要选择到达地。出发地可以多选。')
          return
        }
        if (values.dateRange && values.dateRange.length === 2) {
          queryParams.date_start = values.dateRange[0].format('YYYY-MM-DD')
          queryParams.date_end = values.dateRange[1].format('YYYY-MM-DD')
        }
      } else if (values.dateMode === 'single' && values.date) queryParams.date = values.date.format('YYYY-MM-DD')
      else if (values.dateMode === 'range' && values.dateRange && values.dateRange.length === 2) {
        queryParams.date_start = values.dateRange[0].format('YYYY-MM-DD')
        queryParams.date_end = values.dateRange[1].format('YYYY-MM-DD')
      }
      if (kind === 'oneway' && !to) queryParams.limit = 2000
      setOnewayCity('')
      const wantRound = kind === 'round'
      const batches = await Promise.all(origins.map(async (label) => {
        const fromCity = cityNameOf(label)
        const outbound = await api.flightQuery({ ...queryParams, from: fromCity })
        let records = (outbound.records || []).map((rec) => ({ ...rec, leg: wantRound ? 'out' : '' }))
        let returns = []
        if (kind === 'oneway') {
          const backParams = { to: fromCity, product: queryParams.product, limit: 2000 }
          if (queryParams.to) backParams.from = queryParams.to
          if (queryParams.date_start && queryParams.date_end) {
            backParams.date_start = queryParams.date_start
            backParams.date_end = queryParams.date_end
          }
          const back = await api.flightQuery(backParams)
          returns = back.records || []
        }
        if (wantRound) {
          const backParams = { ...queryParams, from: queryParams.to, to: fromCity }
          delete backParams.flight_no
          const back = await api.flightQuery(backParams)
          records = records.concat((back.records || []).map((rec) => ({ ...rec, leg: 'back' })))
        }
        return { records, returns }
      }))
      let records = batches.flatMap((batch) => batch.records)
      const returns = batches.flatMap((batch) => batch.returns)
      if (detailFlights && (detailFlights.out || detailFlights.back)) {
        records = records.filter((rec) => {
          if (rec.leg === 'back') return !detailFlights.back || rec.flight_no === detailFlights.back
          return !detailFlights.out || rec.flight_no === detailFlights.out
        })
      }
      let saved = loadFlightRecent()
      origins.forEach((label) => { saved = saveFlightRecent(label, to, values.product || 'all') })
      setRecent(saved)
      setResult({ ok: true, records, returns, count: records.length, round: wantRound })
      // 仅单日查询时并行查当日低价（原价/优惠价）；区间/不限日期不自动查价
      const singleDate = kind === 'oneway' ? queryParams.date : ''
      if (origins.length === 1 && from && to && singleDate) {
        const pq = priceQuery || {}
        const interval = Math.max(2, Number(pq.min_interval) || 8)
        const now = Date.now()
        setPriceTried(true)
        if (pq.enabled === false) {
          setErrMsg('实时查价已关闭（防风控），航班信息仍可查询；可在「监控管理」重新开启。')
        } else if (priceLockRef.current > now) {
          const remain = Math.ceil((priceLockRef.current - now) / 1000)
          setErrMsg(`实时查价过于频繁，请 ${remain} 秒后再试（防风控）。`)
        } else {
          priceLockRef.current = now + interval * 1000
          setPriceLoading(true)
          try {
            const p = await api.flightPrices({ from: cityNameOf(from), to: cityNameOf(to), date: singleDate })
            if (p.disabled) {
              setErrMsg(p.prices?.normal?.note || '实时查价已关闭（防风控）。')
            } else {
              setPrices(p.prices)
              setStopsInfo(p.stops || null)
              setTimesMap(p.times || null)
              setSeatsInfo(p.seats || null)
              const rejected = ['normal', 'plus'].flatMap((key) => {
                const item = p.prices?.[key]
                if (item?.status !== 'rejected') return []
                const label = key === 'plus' ? '优惠价' : '原价'
                return [`${label}被接口拒绝：${item.reason || item.note || '未说明原因'}（不是无航班）`]
              })
              if (rejected.length) setErrMsg(rejected.join('；'))
            }
          } catch (e) {
            if (e.status === 429 && e.retry_after) {
              priceLockRef.current = Date.now() + e.retry_after * 1000
            }
            setErrMsg(e.message)
          } finally {
            setPriceLoading(false)
          }
        }
      }
    } catch (e) {
      setErrMsg(e.message)
    } finally {
      setLoading(false)
    }
  }

  const openedDetail = useRef('')
  useEffect(() => {
    const req = flightDetail
    if (!req?.id || openedDetail.current === req.id) return
    openedDetail.current = req.id
    const round = !!(req.round && req.outDate && req.backDate)
    const values = round
      ? {
          to: req.to,
          flight_no: '',
          product: 'all',
          dateMode: 'range',
          dateRange: [dayjs(req.outDate), dayjs(req.backDate)],
        }
      : {
          to: req.to,
          flight_no: req.flightNo || '',
          product: 'all',
          dateMode: 'single',
          date: dayjs(req.date),
        }
    setQueryKind(round ? 'round' : 'oneway')
    setRouteOrigins([req.from])
    routeOriginDefaulted.current = true
    form.setFieldsValue(values)
    submit(values, [req.from], round ? 'round' : 'oneway', round ? { out: req.outFlight, back: req.backFlight } : null)
    queryCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [flightDetail])

  const flightGroups = useMemo(() => groupFlightRecords(result?.records || []), [result])
  const onewayCards = useMemo(
    () => (queryKind === 'oneway' && result && !result.round ? onewayReachCards(result.records, result.returns) : []),
    [queryKind, result],
  )
  const heatCards = useMemo(
    () => (queryKind === 'oneway' ? cardsFromHeatmap(onewayHeat) : []),
    [queryKind, onewayHeat],
  )
  const onewayCardByPair = useMemo(
    () => new Map(onewayCards.map((card) => [`${card.fromCity}|${card.city}`, card])),
    [onewayCards],
  )
  const visibleGroups = useMemo(() => {
    if (queryKind !== 'oneway' || result?.round) return flightGroups
    const cityKind = new Map(onewayCards.map((card) => [`${card.fromCity}|${card.city}`, reachKindOf(card, 'oneway')]))
    const cityTrip = new Map(onewayCards.map((card) => [`${card.fromCity}|${card.city}`, card.trip]))
    return flightGroups.filter((group) => {
      const key = `${group.origin?.city}|${group.dest?.city}`
      if (onewayCity && group.dest?.city !== onewayCity) return false
      if (onewayTrip !== 'all' && cityTrip.get(key) !== onewayTrip) return false
      if (reachFilter === 'all') return true
      return cityKind.get(key) === reachFilter
    })
  }, [flightGroups, queryKind, result, onewayCards, onewayCity, onewayTrip, reachFilter])

  const groupsFromRecords = (recs, direction) => {
    const searchFrom = queryKind === 'oneway' && watch?.dateMode === 'single' ? (form.getFieldValue('date') || null) : null
    const searchRange = (queryKind === 'round' || watch?.dateMode === 'range') && watch?.dateRange?.length === 2 ? watch.dateRange : null
    return recordsToMonitorGroups(recs, tierBlockRules, todayStr).map((g) => {
      let selected = []
      if (searchRange) {
        const [a, b] = searchRange
        selected = g.dates.filter((d) => d >= a.format('YYYY-MM-DD') && d <= b.format('YYYY-MM-DD'))
      } else if (searchFrom) {
        const ds = searchFrom.format('YYYY-MM-DD')
        selected = g.dates.includes(ds) ? [ds] : []
      }
      return { ...g, key: `${direction}|${g.key}`, direction, selected }
    })
  }

  const recordsForKeys = (keys) => {
    const wanted = new Set(keys)
    const recs = []
    for (const group of flightGroups) {
      if (wanted.has(group.key)) {
        recs.push(...group.segments)
        continue
      }
      for (const seg of group.segments) {
        if (wanted.has(segmentKey(seg))) recs.push(seg)
      }
    }
    return recs
  }

  const pairRoundSelection = (recs) => {
    const all = result?.records || []
    const outSelected = recs.filter((rec) => rec.leg !== 'back')
    const backSelected = recs.filter((rec) => rec.leg === 'back')
    const sameCity = (a, b) => a?.origin?.city && a.origin.city === b?.dest?.city && a.dest?.city === b?.origin?.city
    const out = outSelected.length
      ? outSelected
      : all.filter((rec) => rec.leg !== 'back' && backSelected.some((back) => sameCity(rec, back)))
    const back = backSelected.length
      ? backSelected
      : all.filter((rec) => rec.leg === 'back' && out.some((outbound) => sameCity(outbound, rec)))
    return { out, back }
  }

  // 按「航线+航班号+起降时刻」分组生成弹窗清单：同一天内多个起飞时间的航班各自成组
  const openBatch = (keys) => {
    const recs = recordsForKeys(keys)
    if (!recs.length) return
    let groups = []
    let followBoth = false
    if (result?.round) {
      const paired = pairRoundSelection(recs)
      const outGroups = groupsFromRecords(paired.out, 'out')
      const backGroups = groupsFromRecords(paired.back, 'back')
      followBoth = backGroups.length > 0
      groups = followBoth ? withReturnSuggestions([...outGroups, ...backGroups]) : outGroups
      if (!outGroups.length && backGroups.length) {
        groups = backGroups.map((group) => ({ ...group, checked: group.selected.length > 0 }))
        followBoth = true
      }
    } else {
      groups = groupsFromRecords(recs, 'out')
    }
    setRoundTrip(followBoth)
    setBatchGroups(groups)
    setBatchMinSeats(0)
    setBatchCabins([])
    setBatchTier([])
    setBatchMail('')
    setBatchOpen(true)
  }

  const toggleRoundTrip = async (checked) => {
    if (!checked) {
      setRoundTrip(false)
      setBatchGroups((prev) => prev.filter((g) => g.direction !== 'back'))
      return
    }
    const outbound = batchGroups.filter((g) => g.direction !== 'back')
    const pairs = []
    const seen = new Set()
    for (const g of outbound) {
      const key = `${g.to_city}|${g.from_city}`
      if (seen.has(key) || !g.from_city || !g.to_city) continue
      seen.add(key)
      pairs.push(g)
    }
    if (!pairs.length) return
    if (result?.round) {
      const wanted = new Set(pairs.map((g) => `${g.to_city}|${g.from_city}`))
      const known = (result.records || []).filter((rec) => rec.leg === 'back' && wanted.has(`${rec.origin?.city}|${rec.dest?.city}`))
      if (known.length) {
        setRoundTrip(true)
        setBatchGroups(withReturnSuggestions([...outbound, ...groupsFromRecords(known, 'back')]))
        return
      }
    }
    setRoundBusy(true)
    try {
      const product = form.getFieldValue('product')
      const extras = []
      for (const g of pairs) {
        const r = await api.flightQuery({
          from: g.to_city,
          to: g.from_city,
          product: !product || product === 'all' ? '' : product,
          limit: 300,
        })
        extras.push(...groupsFromRecords(r.records || [], 'back'))
      }
      if (!extras.length) {
        msg.info('没有找到回程航班。')
        setRoundTrip(false)
        return
      }
      setRoundTrip(true)
      setBatchGroups(withReturnSuggestions([...outbound, ...extras]))
    } catch (e) {
      msg.error(e.message)
      setRoundTrip(false)
    } finally {
      setRoundBusy(false)
    }
  }

  const confirmBatch = async () => {
    const mailParts = String(batchMail || '').split(/[,，;；\s]+/).map((s) => s.trim()).filter(Boolean)
    if (mailParts.some((part) => !part.includes('@'))) {
      msg.error('收件人要写成邮箱，多个用逗号分开')
      return
    }
    const chosen = batchGroups.filter((g) => (g.direction !== 'back' || g.checked) && (g.selected || []).length)
    const outs = []
    const backs = []
    chosen.forEach((g) => {
      const flight = g.rows[0]?.flight_no || ''
      ;(g.selected || []).forEach((day) => {
        const point = { group: g, day, flight, dep: g.dep_time || g.rows[0]?.dep_time || '' }
        if (g.direction === 'back') backs.push(point)
        else outs.push(point)
      })
    })
    const pairsByGroup = new Map()
    matchRoundTrips(outs, backs).forEach(({ out, back }) => {
      const put = (group, day, pair) => {
        const current = pairsByGroup.get(group) || {}
        current[day] = pair
        pairsByGroup.set(group, current)
      }
      put(out.group, out.day, { role: 'out', mate_date: back.day, mate_flight: back.flight })
      put(back.group, back.day, { role: 'back', mate_date: out.day, mate_flight: out.flight })
    })
    const items = chosen
      .map((g) => {
        const row = g.rows[0] || {}
        const item = {
          from_code: g.from_iata || row.origin?.iata,
          to_code: g.to_iata || row.dest?.iata,
          dates: g.selected,
          product: g.product,
          tiers: batchTier,
          flight_no: row.flight_no || '',
          dep_time: row.dep_time || '',
          arr_time: row.arr_time || '',
        }
        if (pairsByGroup.has(g)) item.round_pairs = pairsByGroup.get(g)
        // 余票/舱位监控条件：至少 N 张（≥2 才显式写入，1/不限=默认）+ 舱位白名单
        if (batchMinSeats >= 2) item.min_seats = batchMinSeats
        if (batchCabins.length) item.cabins = batchCabins
        if (mailParts.length) item.notify_email = mailParts.join(',')
        return item
      })
      .filter((it) => it.dates.length)
    if (!items.length) {
      msg.error('请至少为一组航线选择一个监控日期。')
      return
    }
    setBatchBusy(true)
    try {
      const r = await api.addTasksBatch(items)
      const dateCount = items.reduce((sum, item) => sum + item.dates.length, 0)
      setBatchSummary({ groups: items.length, dates: dateCount, message: r.message || '监控任务已创建' })
      msg.success(r.message || '已创建监控任务')
      setBatchOpen(false)
      setSelKeys([])
      if (onChanged) onChanged()
    } catch (e) {
      msg.error(e.message)
    } finally {
      setBatchBusy(false)
    }
  }

  const goMonitor = (seg) => {
    const key = segmentKey(seg)
    setBatchMode('single')
    setSelKeys([key])
    openBatch([key])
  }

  const preferDay = watch && watch.dateMode === 'single' && watch.date ? watch.date : null

  const columns = [
    {
      title: '航班号', dataIndex: 'flight_no', width: result?.round ? 168 : 110, fixed: freezeQuery || isPhone() ? 'left' : undefined,
      render: (v, g) => {
        const phone = isPhone()
        const block = phone ? scheduleBlocks(g.segments)[0] : null
        const seg = block?.record
        const day = seg ? operatedDay(seg, preferDay) : ''
        return (
        <Space size={4} direction={phone ? 'vertical' : 'horizontal'}>
          <Space size={4}>
            {result?.round && (
              <Tag color={g.leg === 'back' ? 'blue' : 'gold'} style={{ marginInlineEnd: 0 }}>{g.leg === 'back' ? '回程' : '去程'}</Tag>
            )}
            <span className="mono">{v}</span>
          </Space>
          {seg ? (
            <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => openHnaApp(seg, day, msg)}>打开 App</Button>
          ) : null}
        </Space>
        )
      },
    },
    { title: '航司', dataIndex: 'carrier', width: 90 },
    {
      title: '出发', key: 'origin', width: 170,
      render: (_, g) => {
        const rt = timesMap?.[g.flight_no]
        const term = g.origin?.terminal || rt?.dep_terminal
        return (
          <Space direction="vertical" size={0}>
            <span>{cityWithProvince(g.origin.city)}</span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {g.origin.iata} · {(g.origin.airport || '').replace('机场', '')}
              {term ? ` · ${term}` : ''}
            </Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '到达', key: 'dest', width: 170,
      render: (_, g) => {
        const stop = stopsInfo?.[g.flight_no]
        const isStopover = !!(stop && stop.kind === 'stopover')
        const rt = timesMap?.[g.flight_no]
        const term = g.dest?.terminal || rt?.arr_terminal
        return (
          <Space direction="vertical" size={0}>
            <span>
              {cityWithProvince(g.dest.city)}
              {isStopover && <Tag color="orange" style={{ marginLeft: 6 }}>经</Tag>}
              {(() => {
                const card = !result?.round && onewayCardByPair.get(`${g.origin?.city}|${g.dest?.city}`)
                if (!card || card.trip !== 'round') return null
                const byFlight = new Map()
                for (const rec of card.backs) {
                  const times = byFlight.get(rec.flight_no) || new Set()
                  times.add(rec.dep_time || '--:--')
                  byFlight.set(rec.flight_no, times)
                }
                const backs = [...byFlight].map(([no, times]) => `${no} ${[...times].join('/')}`)
                return (
                  <Tooltip title={`回程 ${g.dest.city}→${g.origin.city}：${backs.slice(0, 6).join('、')}${backs.length > 6 ? ` 等 ${backs.length} 班` : ''}`}>
                    <Tag color="green" className="round-ok-tag">可凑往返</Tag>
                  </Tooltip>
                )
              })()}
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {g.dest.iata} · {(g.dest.airport || '').replace('机场', '')}
              {term ? ` · ${term}` : ''}
            </Typography.Text>
          </Space>
        )
      },
    },
    {
      title: '班期', key: 'segments', width: 440,
      render: (_, g) => (
        <div className="sched">
          {scheduleBlocks(g.segments).map((block) => {
            const rt = timesMap?.[block.record.flight_no]
            const dep = (rt?.dep && rt.dep === block.record.dep_time) ? rt.dep : (block.record.dep_time || '—')
            const arr = (rt?.arr && rt.dep === block.record.dep_time) ? rt.arr : (block.record.arr_time || '')
            const nextDay = arr && dep !== '—' && arr < dep
            const winter = block.seasons.includes('冬春航班')
            return (
              <div key={`${block.record.dep_time}|${block.dateText}`} className="sched-row">
                <span className={`sched-season${winter ? ' is-winter' : ''}`}>{winter ? '冬春' : '夏秋'}</span>
                <span className="sched-time mono">
                  {dep}<span className="sched-arrow">→</span>{arr || '--:--'}{nextDay && <sup>+1</sup>}
                </span>
                <span className="sched-days">{weekDaysText(block.days)}</span>
                <span className="sched-dates mono">{shortDateText(block.dateText)}</span>
                <span className="sched-tiers">
                  {['666', '2666'].filter((p) => block.product.includes(p)).map((p) => (
                    <span key={p} className={`sched-tier is-${p}`}>{p}</span>
                  ))}
                </span>
              </div>
            )
          })}
        </div>
      ),
    },
    {
      title: '经停', key: 'stops', width: 150,
      render: (_, g) => {
        const s = stopsInfo?.[g.flight_no]
        if (!s) return <Typography.Text type="secondary">—</Typography.Text>
        if (s.kind === 'direct') return <Tag color="green">直飞</Tag>
        if (s.kind === 'stopover') {
          const via = (s.via || []).join('/')
          const details = s.stops_detail || []
          if (!details.length) {
            return <div className="muted" style={{ fontSize: 12 }}>经停{via ? `·${via}` : ''}</div>
          }
          return (
            <div style={{ padding: '3px 0' }}>
              {details.map((d, i) => {
                const where = [d.city, d.airport ? `${d.airport}机场` : '', d.terminal].filter(Boolean).join(' · ')
                return (
                  <div key={i} className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                    {where}
                    {d.arrive && <span className="mono">　{d.arrive}→{d.depart || '?'}{d.stay ? `（${d.stay}）` : ''}</span>}
                  </div>
                )
              })}
            </div>
          )
        }
        if (s.kind === 'transfer') return <Tag color="purple">中转{s.legs}段</Tag>
        return <Typography.Text type="secondary">—</Typography.Text>
      },
    },
    {
      title: '原价', key: 'orig_price', width: 100, fixed: freezeQuery ? 'right' : undefined,
      render: (_, g) => {
        if (priceLoading) return <Spin size="small" />
        if (prices?.normal?.status === 'rejected') {
          return <Typography.Text type="danger" style={{ fontSize: 12 }} title={prices.normal.reason || prices.normal.note}>已拒绝</Typography.Text>
        }
        const v = prices?.normal?.prices?.[g.flight_no]
        if (v != null) return <span className="mono">¥{v}</span>
        if (priceTried) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>未查询到</Typography.Text>
        return <Typography.Text type="secondary">—</Typography.Text>
      },
    },
    {
      title: '优惠价', key: 'plus_price', width: 100, fixed: freezeQuery ? 'right' : undefined,
      render: (_, g) => {
        if (priceLoading) return <Spin size="small" />
        if (prices?.plus?.status === 'rejected') {
          return <Typography.Text type="danger" style={{ fontSize: 12 }} title={prices.plus.reason || prices.plus.note}>已拒绝</Typography.Text>
        }
        const v = prices?.plus?.prices?.[g.flight_no]
        if (v != null) return <span className="mono" style={{ color: 'var(--color-low-price)', fontWeight: 600 }}>¥{v}</span>
        if (priceTried) return <Typography.Text type="secondary" style={{ fontSize: 12 }}>未查询到</Typography.Text>
        return <Typography.Text type="secondary">—</Typography.Text>
      },
    },
    {
      title: '余票/舱位', key: 'seats', width: 180, fixed: freezeQuery ? 'right' : undefined,
      render: (_, g) => {
        if (priceLoading) return <Spin size="small" />
        const s = seatsInfo?.plus?.[g.flight_no] || seatsInfo?.normal?.[g.flight_no]
        if (!s) {
          return priceTried
            ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>未查询到</Typography.Text>
            : <Typography.Text type="secondary">—</Typography.Text>
        }
        return (
          <Space direction="vertical" size={0}>
            <span><span className="mono" style={{ fontWeight: 600 }}>{s.seats}</span> 张</span>
            <span>
              {(s.cabins || []).map((c) => (
                <Tag
                  key={c.cabin}
                  color={Number(c.qty) >= 10 ? 'green' : Number(c.qty) > 0 ? 'blue' : ''}
                  style={{ marginInlineEnd: 2, fontSize: 11 }}
                >
                  {c.cabin}×{c.qty}
                </Tag>
              ))}
            </span>
          </Space>
        )
      },
    },
    {
      title: '操作', key: 'op', width: 270, fixed: freezeQuery ? 'right' : undefined,
      render: (_, g) => (
        <div className="sched">
          {scheduleBlocks(g.segments).map((block) => {
            const seg = block.record
            const day = operatedDay(seg, preferDay)
            return (
              <div key={`${seg.dep_time}|${block.dateText}`} className="sched-row sched-ops">
                <Button size="small" icon={<CalendarIcon />} onClick={() => setCalRec(seg)}>班期日历</Button>
                <Button size="small" type="primary" ghost icon={<PlusIcon />} onClick={() => {
                  const keys = (block.segments || []).map(segmentKey)
                  if (!keys.length) {
                    msg.error('这条班期没有可监控的记录。')
                    return
                  }
                  setBatchMode('single')
                  setSelKeys(keys)
                  openBatch(keys)
                }}>
                  监控
                </Button>
                {isPhone() ? null : (
                  <Button
                    size="small"
                    type="text"
                    href={officialWebUrl(seg, day, false)}
                    target="_blank"
                    rel="noreferrer"
                    title={`跳到海航官网查询 ${seg.flight_no || ''} ${day}`}
                  >
                    跳到官网
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ),
    },
  ]

  const onewayMulti = new Set(onewayCards.map((card) => card.city)).size > 1
  const hasLiveData = priceLoading || priceTried || !!prices
  const visibleColumns = columns.filter((col) => {
    if (['orig_price', 'plus_price', 'seats'].includes(col.key)) return hasLiveData
    if (col.key === 'stops') return hasLiveData || !!stopsInfo
    if (col.key === 'origin') return result?.round || queryKind !== 'oneway' || new Set(visibleGroups.map((g) => g.origin?.city)).size > 1
    return true
  })

  const pickOnewayDate = (mode, day) => {
    form.setFieldsValue(mode === 'single' ? { dateMode: 'single', date: day } : { dateMode: mode })
    if (mode !== 'range' && routeOrigins.length) form.submit()
  }

  const shiftOnewayDay = (step) => {
    const next = (form.getFieldValue('date') || dayjs()).add(step, 'day')
    if (next.isBefore(dayjs(), 'day')) return
    pickOnewayDate('single', next)
  }

  const reverseRoute = () => {
    const to = form.getFieldValue('to')
    if (routeOrigins.length !== 1 || !to) return
    const fromLabel = routeOrigins[0]
    const toLabel = (linkOpts.from || []).find((label) => label === to || cityNameOf(label) === cityNameOf(to)) || to
    const next = [toLabel]
    setRouteOrigins(next)
    form.setFieldsValue({ to: fromLabel })
    submit({ ...form.getFieldsValue(), to: fromLabel }, next)
  }

  const hasQueryDate = queryKind === 'round'
    ? !!(watch?.dateRange && watch.dateRange.length === 2)
    : !!(watch && (watch.dateMode === 'single' ? watch.date : watch.dateMode === 'range' && watch.dateRange?.length === 2))
  const noDateWarn = result && !hasQueryDate

  return (
    <div>
      <div ref={queryCardRef}>
      <Card
        style={{ marginBottom: 16 }}
        title="随心飞航线查询"
      >
        <Tabs
          activeKey={queryKind}
          onChange={(key) => {
            setQueryKind(key)
            setResult(null)
            setSelKeys([])
            setErrMsg('')
            setPrices(null)
            setPriceTried(false)
            setWeekendCards(null)
            setWeekendMeta(null)
            if (key !== 'weekend' && !form.getFieldValue('to')) {
              const last = loadFlightRecent()[0]
              if (last?.to) form.setFieldsValue({ to: matchOriginLabel(linkOpts.to, last.to) || last.to })
            }
            if (key === 'round') form.setFieldsValue({ dateMode: 'range' })
            else if (!(form.getFieldValue('dateRange')?.length === 2)) form.setFieldsValue({ dateMode: 'none' })
          }}
          items={[
            { key: 'weekend', label: '周末雷达' },
            { key: 'round', label: '往返航班查询' },
            { key: 'oneway', label: '单程查询' },
          ]}
        />
        {recent.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <Typography.Text type="secondary">常用航线</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <Space wrap>
                {recent.map((item) => (
                  <Tag
                    key={recentKey(item)}
                    color="blue"
                    closable
                    style={{ cursor: 'pointer', marginInlineEnd: 0 }}
                    onClose={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setRecent(removeFlightRecent(item))
                    }}
                    onClick={() => {
                      const toLabel = item.to ? (matchOriginLabel(allOrigins, item.to) || item.to) : undefined
                      if (queryKind === 'weekend') {
                        const fromLabel = item.from ? (matchOriginLabel(allOrigins, item.from) || item.from) : ''
                        const origins = fromLabel ? addOriginLabels(weekendOrigins.filter((label) => cityNameOf(label) !== cityNameOf(fromLabel)), [fromLabel]) : weekendOrigins
                        setWeekendOrigins(origins)
                        form.setFieldsValue({ to: toLabel, product: item.product || 'all' })
                        if (origins.length) scanWeekend(weekendPattern, weekendPick, { ...form.getFieldsValue(), to: toLabel, product: item.product || 'all' }, origins)
                        return
                      }
                      const fromLabel = item.from ? (matchOriginLabel(linkOpts.from, item.from) || matchOriginLabel(allOrigins, item.from) || item.from) : ''
                      const next = fromLabel ? [fromLabel] : routeOrigins
                      if (fromLabel) setRouteOrigins(next)
                      form.setFieldsValue({
                        to: toLabel,
                        product: item.product || 'all',
                      })
                      submit({ ...form.getFieldsValue(), to: toLabel, product: item.product || 'all' }, next)
                    }}
                  >
                    {recentLabel(item)}
                  </Tag>
                ))}
              </Space>
            </div>
          </div>
        )}
        <Form form={form} layout="vertical" onFinish={submit} initialValues={{ product: 'all', dateMode: 'range' }}>
          <Row gutter={16}>
            {(() => {
              const weekend = queryKind === 'weekend'
              const origins = weekend ? weekendOrigins : routeOrigins
              return (
                <Col xs={24} lg={weekend ? 12 : 9}>
                  <Form.Item label={fieldLabel('出发地', `多选 · 最多 ${WEEKEND_ORIGIN_LIMIT} 个`)}>
                    <OriginField
                      value={origins}
                      onOpen={() => (weekend ? setOriginOpen(true) : setRouteOriginOpen(true))}
                      onChange={weekend ? setWeekendOrigins : setRouteOrigins}
                    />
                  </Form.Item>
                </Col>
              )
            })()}
            {queryKind !== 'weekend' && (
              <Col xs={24} lg={2}>
                <Form.Item label=" " colon={false} className="route-swap-item">
                  <Tooltip title="对调出发地和到达地">
                    <Button
                      className="route-swap"
                      aria-label="对调出发地和到达地"
                      icon={<SwapIcon size={16} />}
                      disabled={routeOrigins.length !== 1 || !(watch && watch.to)}
                      onClick={reverseRoute}
                    />
                  </Tooltip>
                </Form.Item>
              </Col>
            )}
            <Col xs={24} lg={queryKind === 'weekend' ? 12 : 8}>
              <Form.Item
                name="to"
                label={queryKind === 'weekend'
                  ? fieldLabel('目的地', '可不选 · 不选扫描全部')
                  : queryKind === 'oneway'
                    ? fieldLabel('到达地', '可不选 · 不选地图看全部可达')
                    : fieldLabel('到达地', '只列能查到航线的城市')}
              >
                <Select placeholder="城市 / 机场 / 三字码" {...optProps(linkOpts.to)} />
              </Form.Item>
            </Col>
            {queryKind !== 'weekend' && (
              <Col xs={24} lg={5}>
                <Form.Item name="flight_no" label={fieldLabel('航班号', queryKind === 'round' ? '可选 · 只筛去程' : '可选')}>
                  <Input placeholder="如 JD / JD5037" allowClear />
                </Form.Item>
              </Col>
            )}
            <OriginPickerModal
              open={routeOriginOpen}
              options={allOrigins}
              value={routeOrigins}
              recent={originRecent.length ? originRecent : recent.map((item) => item.from).filter(Boolean)}
              onCancel={() => setRouteOriginOpen(false)}
              onClearRecent={() => setOriginRecent(writeOriginRecent([]))}
              onConfirm={(next) => {
                setRouteOrigins(next)
                setOriginRecent(writeOriginRecent([...next, ...originRecent]))
                setRouteOriginOpen(false)
              }}
            />
            <OriginPickerModal
              open={originOpen}
              options={allOrigins}
              value={weekendOrigins}
              recent={originRecent.length ? originRecent : recent.map((item) => item.from).filter(Boolean)}
              onCancel={() => setOriginOpen(false)}
              onClearRecent={() => setOriginRecent(writeOriginRecent([]))}
              onConfirm={(next) => {
                setWeekendOrigins(next)
                setOriginRecent(writeOriginRecent([...next, ...originRecent]))
                setOriginOpen(false)
              }}
            />
            {queryKind === 'weekend' && (
              <Col span={24}>
                {(() => {
                  const season = flightSeasonInfo()
                  return (
                    <div className={`season-strip is-${season.tone}${season.days <= 30 ? ' is-soon' : ''}`}>
                      <span>
                        当前 <b>{season.name}</b> · 距 {season.next.format('M-D')} {season.nextName}换季还有 <b>{season.days}</b> 天
                        {season.days <= 30 ? '，换季后的周末按新航季班期扫描' : ''}
                        {dayjs().isBefore('2027-01-01') ? '。目前海航放票到 12.31，所以 1 月份暂时也可能约不了' : ''}
                      </span>
                      <span className="season-strip-tag">{season.tone === 'summer' ? '夏秋' : '冬春'}</span>
                    </div>
                  )
                })()}
                <div className="date-quick" style={{ marginBottom: 12 }}>
                  {WEEKEND_LEAVES.map((item) => (
                    <Button
                      key={item.key}
                      size="small"
                      icon={item.key === 'none' ? <MoonIcon /> : item.key === 'half' ? <SunIcon /> : item.key === 'day' ? <LuggageIcon /> : <CalendarIcon />}
                      type={weekendLeave === item.key ? 'primary' : 'default'}
                      onClick={() => {
                        const next = WEEKEND_PATTERNS.find((pattern) => pattern.leave === item.key && pattern.key !== 'custom')
                        setWeekendLeave(item.key)
                        setWeekendDates(null)
                        if (item.key === 'custom') {
                          setWeekendPattern('custom')
                          setCustomCalOpen(true)
                          return
                        }
                        setCustomCalOpen(false)
                        if (next) setWeekendPattern(next.key)
                        const values = form.getFieldsValue()
                        if (weekendOrigins.length && next) scanWeekend(next.key, weekendPick, values, undefined, null)
                      }}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
                <div className="date-quick" style={{ marginBottom: 12 }}>
                  {weekendPlanOptions(7).map((plan) => (
                    <Button
                      key={plan.index}
                      size="small"
                      type={(
                        weekendLeave === 'custom'
                          ? weekendDates?.out === plan.fri.format('YYYY-MM-DD') && weekendDates?.back === plan.sun.format('YYYY-MM-DD')
                          : plan.index === weekendPick
                      ) ? 'primary' : 'default'}
                      onClick={() => {
                        setWeekendPick(plan.index)
                        const values = form.getFieldsValue()
                        if (weekendLeave === 'custom') {
                          const next = { out: plan.fri.format('YYYY-MM-DD'), back: plan.sun.format('YYYY-MM-DD') }
                          setWeekendPattern('custom')
                          setWeekendDates(next)
                          setCustomCalOpen(false)
                          if (weekendOrigins.length) scanWeekend('custom', plan.index, values, undefined, next)
                          return
                        }
                        setWeekendDates(null)
                        if (weekendOrigins.length) scanWeekend(weekendPattern, plan.index, values, undefined, null)
                      }}
                    >
                      {weekendPlanChip(plan)}
                    </Button>
                  ))}
                </div>
                {weekendLeave === 'custom' && (customCalOpen || !(weekendDates?.out && weekendDates?.back)) && (
                  <WeekendDateCalendar
                    out={weekendDates?.out || ''}
                    back={weekendDates?.back || ''}
                    focus={findWeekendPlan(weekendPick)?.sat?.format('YYYY-MM-DD') || ''}
                    onPick={(out, back) => {
                      if (!back) {
                        setWeekendDates({ out, back: '' })
                        setCustomCalOpen(true)
                        return
                      }
                      const next = { out, back }
                      const matched = weekendPlanOptions(7).find((plan) => plan.fri.format('YYYY-MM-DD') === out && plan.sun.format('YYYY-MM-DD') === back)
                      if (matched) setWeekendPick(matched.index)
                      setWeekendDates(next)
                      setCustomCalOpen(false)
                      const values = form.getFieldsValue()
                      if (weekendOrigins.length) scanWeekend('custom', matched ? matched.index : weekendPick, values, undefined, next)
                    }}
                  />
                )}
                {weekendLeave === 'custom' && weekendDates?.out && weekendDates?.back && !customCalOpen && (
                  <div className="weekend-date-picked">
                    <div>
                      <span className="weekend-pattern-kicker">去程（{cnWeekday(weekendDates.out)}）</span>
                      <b className="mono">{weekendDates.out}</b>
                    </div>
                    <span className="weekend-hour-pill">{staySpanLabel(weekendDates.out, weekendDates.back) || '已选'}</span>
                    <div>
                      <span className="weekend-pattern-kicker">返程（{cnWeekday(weekendDates.back)}）</span>
                      <b className="mono">{weekendDates.back}</b>
                    </div>
                    <Button size="small" onClick={() => setCustomCalOpen(true)}>改日期</Button>
                  </div>
                )}
                {weekendLeave !== 'custom' && <div className="weekend-plan">
                  {WEEKEND_PATTERNS.filter((pattern) => pattern.leave === weekendLeave && pattern.key !== 'custom').map((pattern) => {
                    const plan = findWeekendPlan(weekendPick)
                    const start = plan ? plan[pattern.outDay] : null
                    const end = plan ? plan[pattern.backDay || 'sun'] : null
                    const on = weekendPattern === pattern.key
                    const shownOut = on && weekendDates?.out ? weekendDates.out : start?.format('YYYY-MM-DD')
                    const shownBack = on && weekendDates && !weekendDates.back
                      ? ''
                      : (on && weekendDates?.back ? weekendDates.back : end?.format('YYYY-MM-DD'))
                    return (
                      <button
                        key={pattern.key}
                        type="button"
                        className={`weekend-pattern${on ? ' is-on' : ''}`}
                        onClick={() => {
                          setWeekendPattern(pattern.key)
                          setWeekendDates(null)
                          const values = form.getFieldsValue()
                          if (weekendOrigins.length && weekendCards) scanWeekend(pattern.key, weekendPick, values, undefined, null)
                        }}
                      >
                        <div className="weekend-pattern-top">
                          <span className="weekend-pattern-ico">
                            {(() => {
                              const Icon = PATTERN_ICONS[pattern.icon] || MoonIcon
                              return <Icon size={18} />
                            })()}
                          </span>
                          <span>
                            <span className="weekend-pattern-title">{pattern.title}</span>
                            <span className="weekend-pattern-note">{pattern.note}</span>
                          </span>
                        </div>
                        {shownOut && (
                          <div className="weekend-pattern-dates">
                            <div>
                              <div className="weekend-pattern-kicker">去程（{cnWeekday(shownOut)}）</div>
                              <div className="mono">{shownOut}</div>
                            </div>
                            <span className="weekend-hour-pill">{hourPillText(pattern.badge, pattern.leave)}</span>
                            <div>
                              <div className="weekend-pattern-kicker">返程{shownBack ? `（${cnWeekday(shownBack)}）` : ''}</div>
                              <div className="mono">{shownBack || '在日历再点一天'}</div>
                            </div>
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>}
                <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
                  {weekendLeave === 'custom' ? '自选日期先点去程，再点返程。上面的周末可以直接选中那一周。' : '免请假是 48h / 35h，请半天是 60h，请一天是 72h。周五下午 12:00–17:30 的班很少，扫不到就可以换旁边那条。'}
                </Typography.Text>
              </Col>
            )}
            <Col xs={24} lg={queryKind === 'oneway' ? 24 : 12} style={{ display: queryKind === 'weekend' ? 'none' : undefined }}>
              <Form.Item
                label={queryKind === 'round'
                  ? '出行日期'
                  : fieldLabel('出行日期', watch?.to && routeOrigins.length === 1 ? '点某一天直接查当天实时价格、余票和经停' : '选定到达地后点某一天，可查当天实时价格和余票')}
              >
                <Form.Item name="dateMode" hidden><Input /></Form.Item>
                {queryKind === 'oneway' && (
                  <DateStrip mode={dateMode} date={watch?.date} onPick={pickOnewayDate} />
                )}
                <div className="date-nav" style={{ display: queryKind === 'oneway' && dateMode === 'single' ? undefined : 'none' }}>
                  <Button icon={<ChevronLeftIcon size={12} />} disabled={!watch?.date || !watch.date.isAfter(dayjs(), 'day')} onClick={() => shiftOnewayDay(-1)}>前一天</Button>
                  <Form.Item name="date" noStyle>
                    <DatePicker
                      className="date-nav-picker"
                      allowClear={false}
                      format={(v) => `${v.format('YYYY-MM-DD')} ${cnWeekday(v.format('YYYY-MM-DD'))}`}
                      placeholder="选择单日"
                      disabledDate={todayDisabled}
                      onChange={(v) => v && pickOnewayDate('single', v)}
                    />
                  </Form.Item>
                  <Button onClick={() => shiftOnewayDay(1)}>后一天<ChevronRightIcon size={12} /></Button>
                </div>
                <Space direction="vertical" size={8} style={{ width: '100%', display: queryKind === 'round' || dateMode === 'range' ? undefined : 'none' }}>
                  <div className="date-inputs">
                    <Form.Item name="dateRange" noStyle>
                      <DatePicker.RangePicker style={{ width: 260 }} disabledDate={todayDisabled} />
                    </Form.Item>
                  </div>
                  <div className="date-quick">
                    {upcomingWeekendOptions(5).map((opt) => {
                      const range = watch?.dateRange
                      const on = range?.length === 2
                        && range[0].format('YYYY-MM-DD') === opt.start.format('YYYY-MM-DD')
                        && range[1].format('YYYY-MM-DD') === opt.end.format('YYYY-MM-DD')
                      return (
                        <Button
                          key={opt.key}
                          size="small"
                          type={on ? 'primary' : 'default'}
                          onClick={() => {
                            form.setFieldsValue({ dateMode: 'range', dateRange: [opt.start, opt.end] })
                            if (routeOrigins.length && (queryKind === 'oneway' || form.getFieldValue('to'))) form.submit()
                          }}
                        >
                          {opt.label}
                        </Button>
                      )
                    })}
                  </div>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {queryKind === 'round'
                      ? '从下周末起。去程和回程都按这段日期筛选，航班号只筛去程。'
                      : '区间只筛选这段日期里能飞的班，不查实时价格。'}
                  </Typography.Text>
                </Space>
              </Form.Item>
            </Col>
            <Col xs={24} lg={6}>
              <Form.Item name="product" label="产品档位">
                <Select
                  placeholder="全部"
                  options={[
                    { label: '全部', value: 'all' },
                    { label: '666', value: '666' },
                    { label: '2666', value: '2666' },
                  ]}
                />
              </Form.Item>
            </Col>
            <Col xs={24} lg={queryKind === 'oneway' ? 18 : 6}>
              <Form.Item label=" " colon={false}>
                <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
                  <Button onClick={() => { form.resetFields(); if (queryKind === 'round') form.setFieldsValue({ dateMode: 'range' }); setResult(null); setWeekendCards(null); setWeekendMeta(null); setWeekendOrigins([]); setErrMsg(''); setPrices(null); setStopsInfo(null); setTimesMap(null); setSeatsInfo(null); setPriceTried(false); setSelKeys([]) }}>清空</Button>
                  <Button type="primary" htmlType="submit" loading={loading} icon={<CompassIcon />}>{queryKind === 'weekend' ? weekendScanLabel(weekendOrigins) : '查询'}</Button>
                </Space>
              </Form.Item>
            </Col>
          </Row>
        </Form>
        {errMsg && <Alert style={{ marginTop: 8 }} type="error" showIcon message={errMsg} />}
        {queryKind === 'oneway' && (onewayHeat || onewayHeatLoading || onewayHeatErr) && (() => {
          const heatMeta = onewayHeat?.[0]
          const heatFroms = [...new Set((onewayHeat || []).map((item) => item.origin?.city).filter(Boolean))].join('、')
          const heatSpan = !heatMeta ? '' : heatMeta.unbounded
            ? `未来 ${heatMeta.span_days} 天（${heatMeta.date_start} – ${heatMeta.date_end}）`
            : heatMeta.date_start === heatMeta.date_end
              ? heatMeta.date_start
              : `${heatMeta.date_start} – ${heatMeta.date_end}${heatMeta.truncated ? '（区间较长，只显示前 92 天）' : ''}`
          const heat666 = heatCards.filter((card) => card.kind === '666').length
          const heat2666 = heatCards.filter((card) => card.kind === '2666').length
          const heatBoth = heatCards.filter((card) => card.trip === 'round').length
          const heatOut = heatCards.filter((card) => card.trip === 'out').length
          const heatBack = heatCards.filter((card) => card.trip === 'back').length
          const pickHeatCity = async (card) => {
            const label = matchOriginLabel(linkOpts.to, card.city) || card.city
            form.setFieldsValue({ to: label })
            await submit({ ...form.getFieldsValue(), to: label })
            window.setTimeout(() => {
              resultCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }, 80)
          }
          return (
            <div style={{ marginTop: 16 }}>
              <div className="weekend-summary">
                <div>
                  <div className="weekend-summary-title">{heatFroms || '所选城市'} 出发 · 可以去这些地方</div>
                  <div className="weekend-summary-sub">
                    {heatSpan}
                    {heatCards.length ? <> · <b>{heatCards.length}</b> 个城市 · 往返 <b>{heatBoth}</b> · 只有去 <b>{heatOut}</b> · 只有回 <b>{heatBack}</b></> : ''}
                  </div>
                </div>
                <span className="weekend-summary-note">绿是往返，橙是只有去，蓝是只有回。实心 666，空心 2666。</span>
              </div>
              {onewayHeatErr ? <Alert style={{ marginBottom: 12 }} type="error" showIcon message={onewayHeatErr} /> : null}
              {heatCards.length > 0 && (
                <div className="date-quick" style={{ marginBottom: 10 }}>
                  {[
                    { key: 'all', label: `全部方向（${heatCards.length}）` },
                    { key: 'round', label: `往返（${heatBoth}）` },
                    { key: 'out', label: `只有去（${heatOut}）` },
                    { key: 'back', label: `只有回（${heatBack}）` },
                  ].map((item) => (
                    <Button
                      key={item.key}
                      size="small"
                      type={heatDir === item.key ? 'primary' : 'default'}
                      onClick={() => setHeatDir(item.key)}
                    >
                      {item.label}
                    </Button>
                  ))}
                  {[
                    { key: 'all', label: `全部档位（${heatCards.length}）` },
                    { key: '666', label: `666 可用（${heat666}）` },
                    { key: '2666', label: `2666 专享（${heat2666}）` },
                  ].map((item) => (
                    <Button
                      key={`tier-${item.key}`}
                      size="small"
                      type={reachFilter === item.key ? 'primary' : 'default'}
                      onClick={() => setReachFilter(item.key)}
                    >
                      {item.label}
                    </Button>
                  ))}
                </div>
              )}
              {onewayHeatLoading && !heatCards.length ? <Spin /> : null}
              {!onewayHeatLoading && !onewayHeatErr && !heatCards.length ? (
                <Empty description="这段日期没有可兑的目的地" />
              ) : heatCards.length > 0 ? (
                <WeekendReachMap
                  cards={heatCards}
                  filter={reachFilter}
                  tripFilter={heatDir}
                  variant="overview"
                  onPick={pickHeatCity}
                />
              ) : null}
            </div>
          )
        })()}
        {queryKind === 'weekend' && weekendCards && (
          <div style={{ marginTop: 16 }}>
            <div className="weekend-summary">
              <div>
                <div className="weekend-summary-title">
                  {[...new Set(weekendCards.map((card) => card.fromCity).filter(Boolean))].join('、') || '所选城市'} 出发
                </div>
                <div className="weekend-summary-sub">
                  匹配到 <b>{weekendCards.length}</b> 个周末往返成环的目的地
                  {weekendMeta ? ` · ${weekendMeta.title}${weekendMeta.span ? ` · ${weekendMeta.span}` : ''} · ${weekendMeta.outDate} → ${weekendMeta.backDate}` : ''}
                </div>
              </div>
              <span className="weekend-summary-note">双程都能用 666 的排在前面，2666 专享不加分</span>
            </div>
            {weekendCards.length > 0 && (
              <div style={{ margin: '10px 0' }}>
                <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                  双向关注的邮件收件人，多个用逗号分开。那天已经有人关注的，会加在原来的收件人后面。
                </div>
                <Input
                  value={weekendMail ?? defaultMail}
                  placeholder={defaultMail ? `留空发给 ${defaultMail}` : 'name@example.com, other@example.com'}
                  onChange={(e) => setWeekendMail(e.target.value)}
                />
              </div>
            )}
            {weekendCards.length > 0 && (
              <div className="weekend-view-switch">
                <button type="button" className={weekendView === 'list' ? 'is-on' : ''} onClick={() => setWeekendView('list')}>
                  <TasksIcon size={16} />
                  航线排期列表
                </button>
                <button type="button" className={weekendView === 'map' ? 'is-on' : ''} onClick={() => setWeekendView('map')}>
                  <MapIcon size={16} />
                  全国可去地图
                  <span className="weekend-heat-badge">热力视效</span>
                </button>
              </div>
            )}
            {weekendCards.length > 0 && (
              <div className="date-quick" style={{ marginBottom: 10 }}>
                {[
                  { key: 'all', label: `全部可达（${weekendCards.length}）` },
                  { key: '666', label: `仅看 666 可用（${weekendCards.filter((card) => reachKind(card) === '666').length}）` },
                  { key: '2666', label: `仅看 2666 专享（${weekendCards.filter((card) => reachKind(card) === '2666').length}）` },
                ].map((item) => (
                  <Button
                    key={item.key}
                    size="small"
                    type={reachFilter === item.key ? 'primary' : 'default'}
                    onClick={() => setReachFilter(item.key)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            )}
            {weekendCards.length === 0 ? (
              <Empty description="这个周末没有能配成去程加返程的目的地" />
            ) : weekendView === 'map' ? (
              <WeekendReachMap
                cards={weekendCards}
                filter={reachFilter}
                onPick={(card) => {
                  setWeekendView('list')
                  window.setTimeout(() => {
                    document.querySelectorAll('.weekend-dest.is-map-on').forEach((el) => el.classList.remove('is-map-on'))
                    const node = document.getElementById(weekendPlanDomId(card))
                    if (!node) return
                    node.classList.add('is-map-on')
                    node.scrollIntoView({ behavior: 'smooth', block: 'center' })
                  }, 60)
                }}
              />
            ) : weekendCards.filter((card) => reachFilter === 'all' || reachKind(card) === reachFilter).map((card) => (
              <WeekendPlanCard
                key={`${card.fromCity}|${card.city}|${card.outDate}|${card.backDate}`}
                card={card}
                busy={watchCityKey === `${card.fromCity}|${card.city}`}
                seatBusy={seatBusy}
                onFollow={followWeekend}
                onCheckSeats={checkWeekendSeats}
                onSeatLock={setSeatBusy}
              />
            ))}
          </div>
        )}
      </Card>
      </div>

      {batchSummary && (
        <Alert
          className="task-created-summary"
          type="success"
          showIcon
          closable
          onClose={() => setBatchSummary(null)}
          message={batchSummary.message}
          description={
            <Space wrap>
              <span>已加入 {batchSummary.groups} 组航班、{batchSummary.dates} 个监控日期。</span>
              <Button type="link" size="small" onClick={() => onGo('tasks')}>查看监控任务</Button>
            </Space>
          }
        />
      )}

      {result && (
        <div ref={resultCardRef}>
        <Card
          title={result.round
            ? `查询结果（去程 ${flightGroups.filter((g) => g.leg !== 'back').length} 个航班，回程 ${flightGroups.filter((g) => g.leg === 'back').length} 个航班）`
            : `查询结果（${visibleGroups.length} 个航班，${result.records.length} 条班期）`}
          extra={
            <Space wrap>
              <Space size={4}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>冻结查询列</Typography.Text>
                <Switch size="small" checked={freezeQuery} onChange={setFreezeQuery} />
              </Space>
              <Button
                type="primary"
                icon={<PlusIcon />}
                disabled={!selKeys.length}
                onClick={() => { setBatchMode('batch'); openBatch(selKeys) }}
              >
                {result.round ? `同时关注去程和回程${selKeys.length ? `（${selKeys.length}）` : ''}` : `批量转为监控任务${selKeys.length ? `（${selKeys.length}）` : ''}`}
              </Button>
            </Space>
          }
        >
          {noDateWarn && !dateWarnDismissed && (
            <Alert
              style={{ marginBottom: 12 }}
              type="warning"
              showIcon
              closable
              onClose={() => setDateWarnDismissed(true)}
              message={null}
              description={
                <span style={{ fontSize: 12 }}>
                  {queryKind === 'round'
                    ? '未选择出行日期时，去程和回程都只展示静态班期。选一段日期后重新查询，只保留这段日期里能飞的班。'
                    : '已选择日期的前提下才能查询原价/优惠价与经停信息。当前未选择日期，结果列表仅展示静态航班信息（航司/班期/档位）。选择单日后重新查询即可看到实时价格与经停。'}
                </span>
              }
            />
          )}
          {queryKind === 'oneway' && !result.round && onewayCards.length > 0 && (
            <>
              {(() => {
                const cities = new Set(onewayCards.map((card) => card.city))
                const tierCities = (kind) => new Set(onewayCards.filter((card) => reachKindOf(card, 'oneway') === kind).map((card) => card.city)).size
                const froms = [...new Set(onewayCards.map((card) => card.fromCity).filter(Boolean))].join('、')
                return (
                  <div className="reach-summary">
                    <b>{froms || '所选城市'} 出发</b>
                    <span>覆盖 <b>{cities.size}</b> 个城市</span>
                    <span>共 <b>{result.records.length}</b> 个班期</span>
                    <span>666 通达 <b>{tierCities('666')}</b> 城 / 2666 专享 <b>{tierCities('2666')}</b> 城</span>
                    {preferDay && <span className="reach-summary-day">{preferDay.format('M月D日')} {cnWeekday(preferDay.format('YYYY-MM-DD'))}</span>}
                  </div>
                )
              })()}
              <div className="filter-groups" style={{ display: onewayMulti || onewayCity ? undefined : 'none' }}>
                <div className="filter-group">
                <span className="filter-group-label">行程</span>
                {[
                  { key: 'all', label: `全部（${onewayCards.length}）` },
                  { key: 'round', label: `往返（${onewayCards.filter((card) => card.trip === 'round').length}）` },
                  { key: 'out', label: `有去无回（${onewayCards.filter((card) => card.trip === 'out').length}）` },
                  { key: 'back', label: `有回无去（${onewayCards.filter((card) => card.trip === 'back').length}）` },
                ].map((item) => (
                  <Button
                    key={`trip-${item.key}`}
                    size="small"
                    type={onewayTrip === item.key ? 'primary' : 'default'}
                    onClick={() => setOnewayTrip(item.key)}
                  >
                    {item.label}
                  </Button>
                ))}
                </div>
                <div className="filter-group">
                <span className="filter-group-label">档位</span>
                {[
                  { key: 'all', label: `全部（${onewayCards.length}）` },
                  { key: '666', label: `666 可用（${onewayCards.filter((card) => reachKindOf(card, 'oneway') === '666').length}）` },
                  { key: '2666', label: `2666 专享（${onewayCards.filter((card) => reachKindOf(card, 'oneway') === '2666').length}）` },
                ].map((item) => (
                  <Button
                    key={`tier-${item.key}`}
                    size="small"
                    type={reachFilter === item.key ? 'primary' : 'default'}
                    onClick={() => setReachFilter(item.key)}
                  >
                    {item.label}
                  </Button>
                ))}
                </div>
                {onewayCity ? (
                  <Tag closable onClose={() => setOnewayCity('')} style={{ marginInlineEnd: 0 }}>只看 {onewayCity}</Tag>
                ) : null}
              </div>
            </>
          )}
          <Table
            rowKey="key"
            size="small"
            pagination={{ pageSize: 20, showSizeChanger: false }}
            dataSource={visibleGroups}
            columns={visibleColumns}
            scroll={{ x: 'max-content' }}
            rowSelection={{ selectedRowKeys: selKeys, onChange: setSelKeys }}
            locale={{ emptyText: <Empty description="没有符合条件的航班，换个条件试试" /> }}
          />
        </Card>
        </div>
      )}

      <Modal
        open={batchOpen}
        title={batchMode === 'single' ? '转为监控任务' : '批量转为监控任务'}
        width={680}
        okText="确认创建"
        okButtonProps={{ loading: batchBusy }}
        cancelText="取消"
        onCancel={() => setBatchOpen(false)}
        onOk={confirmBatch}
      >
        <Row gutter={8} style={{ marginBottom: 12 }}>
          <Col span={8}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>档位条件 · 多选（空=不限）</div>
            <Select
              mode="multiple"
              style={{ width: '100%' }}
              placeholder="不限（全部档位）"
              value={batchTier}
              onChange={(v) => {
                setBatchTier(v)
                // 档位条件变化：日期选项按档位×日期规则实时收窄（666 档节假日不可用等），
                // 并剔除已被规则禁用的已选日期；空=不限→按航线产品档位计算（同打开时）
                setBatchGroups((prev) => withReturnSuggestions(prev.map((g) => {
                  const eff = v.length ? v : String(g.product || '').split('/').map((s) => s.trim()).filter(Boolean)
                  const dates = filterTierDates(expandRecordDates(g.rows), eff.join('/'), tierBlockRules).filter((d) => d >= todayStr)
                  return { ...g, dates, selected: (g.selected || []).filter((d) => dates.includes(d)) }
                })))
              }}
              options={TIER_OPTIONS}
              maxTagCount="responsive"
            />
          </Col>
          <Col span={7}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>余票条件 · 至少 N 张才提醒</div>
            <Select
              style={{ width: '100%' }}
              value={batchMinSeats}
              onChange={setBatchMinSeats}
              options={[
                { label: '不限（有票即提醒）', value: 0 },
                { label: '至少 1 张', value: 1 },
                { label: '至少 2 张', value: 2 },
                { label: '至少 3 张', value: 3 },
                { label: '至少 4 张', value: 4 },
              ]}
            />
          </Col>
          <Col span={9}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>舱位白名单（多选/手输，空=不限舱位）</div>
            <Select
              mode="tags"
              style={{ width: '100%' }}
              placeholder="如 B、C、Z、R…"
              value={batchCabins}
              onChange={setBatchCabins}
              options={CABIN_OPTIONS.map((c) => ({ value: c, label: c }))}
              tokenSeparators={[',', '，']}
              maxTagCount="responsive"
            />
          </Col>
        </Row>
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>邮件收件人（空=用通知管理里的收件人，多个用逗号分开）</div>
          <Input
            value={batchMail}
            placeholder="name@example.com, other@example.com"
            onChange={(e) => setBatchMail(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Switch size="small" checked={roundTrip} disabled={roundBusy} onChange={toggleRoundTrip} />
          <span>同时监控回程</span>
          {roundBusy && <Spin size="small" />}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {result?.round
              ? '去程和回程一起创建。回程默认勾上去程第二天还飞的班，取消勾选的不会创建。'
              : '按去程已选日期，勾上第二天还飞的回程。取消勾选的不会创建。'}
          </Typography.Text>
        </div>
        {batchGroups.filter((g) => g.direction !== 'back').map((g) => (
          <Card
            key={g.key}
            size="small"
            style={{ marginBottom: 12 }}
            title={
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', minWidth: 0, overflow: 'hidden' }}>
                {roundTrip && <Tag color={g.direction === 'back' ? 'blue' : 'gold'} style={{ marginInlineEnd: 0 }}>{g.direction === 'back' ? '回程' : '去程'}</Tag>}
                <span className="mono" style={{ fontWeight: 600, fontSize: 12, flexShrink: 0 }}>{g.flight_no || '—'}</span>
                <Typography.Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>{g.dep_time || '--:--'} → {g.arr_time || '--:--'}</Typography.Text>
                <ChevronRightIcon size={9} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{cityWithProvince(g.from_city)}</span>
                <ChevronRightIcon size={9} style={{ color: 'var(--color-muted)', flexShrink: 0 }} />
                <span style={{ fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{cityWithProvince(g.to_city)}</span>
              </div>
            }
            extra={<Tag color={g.product.includes('2666') ? 'purple' : 'gold'}>{g.product}</Tag>}
          >
            <div className="muted" style={{ marginBottom: 6, fontSize: 12 }}>
              共有 {g.dates.length} 天可飞。在日历里点选，周六、周日单独标出；灰色日期这班不飞。
            </div>
            <DatePickCalendar
              dates={g.dates}
              value={g.selected}
              onChange={(v) => {
                setBatchGroups((prev) => withReturnSuggestions(prev.map((x) => (x.key === g.key ? { ...x, selected: v } : x))))
              }}
            />
          </Card>
        ))}
        {roundTrip && (
          <ReturnPickList
            groups={batchGroups.filter((g) => g.direction === 'back')}
            onToggle={(key, checked) => setBatchGroups((prev) => prev.map((x) => (x.key === key ? { ...x, checked, choicePinned: true } : x)))}
            onDates={(key, v) => setBatchGroups((prev) => prev.map((x) => (x.key === key ? { ...x, selected: v, checked: v.length > 0, returnTouched: true, choicePinned: true } : x)))}
          />
        )}
      </Modal>

      <Modal
        open={!!calRec}
        title={calRec ? `${calRec.flight_no}　${cityWithProvince(calRec.origin.city)} → ${cityWithProvince(calRec.dest.city)}` : ''}
        footer={null}
        width={680}
        onCancel={() => setCalRec(null)}
        destroyOnClose
      >
        {calRec && <ScheduleCalendar rec={calRec} />}
      </Modal>
    </div>
  )
}

/* ================= 历史日志 ================= */
function History({ data, autoRefresh, setAutoRefresh, msg, refresh }) {
  const [clearBusy, setClearBusy] = useState('')

  const doClearLog = async () => {
    setClearBusy('log')
    try {
      const r = await api.clearLog()
      msg.success(r.message || '运行日志已清除')
      refresh()
    } catch (e) { msg.error(e.message) } finally { setClearBusy('') }
  }

  return (
    <div>
      <Card
        title="运行日志（最近 200 行）"
        extra={
          <Space>
            <Popconfirm
              title="清除运行日志？"
              description="原日志将归档为 .bak 文件（可找回）。"
              okText="清除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={doClearLog}
            >
              <Button size="small" danger loading={clearBusy === 'log'} icon={<DeleteIcon />}>清除</Button>
            </Popconfirm>
            <Typography.Text type="secondary">自动刷新</Typography.Text>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
          </Space>
        }
      >
        <div className="log-view">
          {[...(data.logs || [])].reverse().map((line, i) => {
            const cls = line.includes('错误') || line.includes('[阻断]') || line.includes('E00001') ? 'err'
              : line.includes('警告') || line.includes('退避') ? 'warn' : ''
            return <div key={i} className={cls}>{line}</div>
          })}
          {(data.logs || []).length === 0 && <div className="muted">暂无日志输出。</div>}
        </div>
      </Card>
    </div>
  )
}

/* ================= App ================= */
// 全局主题：基于 antd 开源设计 token 的现代化定制（主色/圆角/控件密度），替代默认观感
const appTheme = (dark) => ({
  algorithm: dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
  token: {
    colorPrimary: dark ? '#5B9BD3' : '#0054A6',
    colorInfo: dark ? '#5B9BD3' : '#0054A6',
    colorSuccess: dark ? '#4FAE77' : '#2D9D5F',
    colorWarning: dark ? '#E0A849' : '#B26E00',
    colorError: dark ? '#E56B61' : '#D63939',
    colorText: dark ? '#E6EDF3' : '#1A2333',
    colorBgLayout: dark ? '#10151B' : '#F6F8FB',
    colorBorderSecondary: dark ? '#2A3442' : '#E4E9F0',
    borderRadius: 8,
    controlHeight: 34,
  },
  components: {
    Button: { fontWeight: 600 },
    Card: { borderRadiusLG: 14 },
    Card: { borderRadiusLG: 12 },
    Menu: { itemBorderRadius: 8, itemHeight: 40, horizontalItemBorderRadius: 8 },
    Table: { headerBg: dark ? '#1D2630' : '#F1F4F9' },
    Switch: { trackHeight: 22 },
  },
})

export default function App() {
  const { message } = AntApp.useApp()
  const [tab, setTab] = useState('overview')
  const [flightDetail, setFlightDetail] = useState(null)
  const openFlightDetail = (req) => {
    setFlightDetail({ ...req, id: `${req.flightNo || ''}|${req.date}|${Date.now()}` })
    setTab('flights')
  }
  const [historyAuto, setHistoryAuto] = useState(false)
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const saved = window.localStorage.getItem('hna-monitor-theme')
      if (saved === 'dark' || saved === 'light') return saved === 'dark'
    } catch (e) { /* localStorage unavailable: follow system preference */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches || false
  })
  useEffect(() => {
    document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
    try { window.localStorage.setItem('hna-monitor-theme', darkMode ? 'dark' : 'light') } catch (e) { /* ignore */ }
  }, [darkMode])
  // 档位×日期屏蔽规则：事实源为底表 data/sediment/tier_block_rules.json（经 meta 下发），
  // 拉取前用 DEFAULT_TIER_BLOCK_RULES（镜像同一份规则）兜底
  const [tierBlockRules, setTierBlockRules] = useState(DEFAULT_TIER_BLOCK_RULES)
  useEffect(() => {
    api.flightMeta()
      .then((r) => { if (r && r.tier_block_rules) setTierBlockRules(normalizeTierRules(r.tier_block_rules)) })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const { data, loading, error, refresh } = usePolling(
    api.state,
    tab === 'history' ? (historyAuto ? 15000 : 30000) : 15000,
  )

  const msg = {
    success: (t) => message.success(t),
    error: (t) => message.error(t),
    info: (t) => message.info(t),
  }

  const toggleStatus = async () => {
    if (!data) return
    const next = data.config.status === 'running' ? 'stopped' : 'running'
    try {
      await api.setStatus(next)
      msg.success(next === 'running' ? '监控已启动' : '监控已停止')
      refresh()
    } catch (e) { msg.error(e.message) }
  }

  if (loading && !data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '60vh' }}>
        <Spin size="large" tip="加载中…" />
      </div>
    )
  }
  if (error && !data) {
    return (
      <Result
        status="warning"
        title="无法连接控制台 API"
        subTitle={error}
        extra={<Button type="primary" onClick={refresh}>重试</Button>}
      />
    )
  }

  return (
    <ConfigProvider theme={appTheme(darkMode)}>
    <Layout className="app-shell" style={{ minHeight: '100vh' }}>
      <Layout.Header className="app-header">
        <div className="command-bar">
          <div className="brand-lockup">
            <BrandIcon size={22} aria-hidden="true" />
            <span className="brand">海航监控</span>
            <span className="brand-mode">航线雷达台</span>
          </div>
          <Menu
            className="app-menu"
            mode="horizontal"
            selectedKeys={[tab]}
            items={TABS}
            onClick={({ key }) => setTab(key)}
            aria-label="主导航"
          />
          <span className="nav-more-hint" aria-hidden="true">更多</span>
          <Tag className="command-status" aria-label={data.config.status === 'running' ? '监控运行中' : '监控已停止'} color={data.config.status === 'running' ? 'green' : 'default'}>
            <span className="status-dot" style={{ background: data.config.status === 'running' ? 'var(--color-success)' : 'var(--color-muted)' }} />
            {data.config.status === 'running' ? '运行中' : '已停止'}
          </Tag>
          <Button
            type="text"
            className="theme-toggle"
            aria-label={darkMode ? '切换为浅色主题' : '切换为暗色主题'}
            aria-pressed={darkMode}
            onClick={() => setDarkMode((v) => !v)}
          >
            {darkMode ? '浅色' : '暗色'}
          </Button>
        </div>
      </Layout.Header>

      <Layout.Content className="app-content">
        {/* 所有 tab 常驻挂载、display 切换，避免切 tab 丢失组件内状态（查询结果/表单/勾选等） */}
        <div className="page">
          <div style={{ display: tab === 'overview' ? 'block' : 'none' }}>
            <Overview data={data} onGo={setTab} onToggleStatus={toggleStatus} onChanged={refresh} msg={msg} onOpenDetail={openFlightDetail} />
          </div>
          <div style={{ display: tab === 'tasks' ? 'block' : 'none' }}>
            <Tasks data={data} onChanged={refresh} msg={msg} onGo={setTab} onOpenDetail={openFlightDetail} tierBlockRules={tierBlockRules} />
          </div>
          <div style={{ display: tab === 'flights' ? 'block' : 'none' }}>
            <FlightQuery
              msg={msg}
              priceQuery={data?.config?.price_query}
              onChanged={refresh}
              onGo={setTab}
              tierBlockRules={tierBlockRules}
              flightDetail={flightDetail}
              defaultMail={String(data?.config?.notify_channels?.email?.receiver || '').trim()}
            />
          </div>
          <div style={{ display: tab === 'notify' ? 'block' : 'none' }}>
            <Notifications data={data} onChanged={refresh} msg={msg} />
          </div>
          <div style={{ display: tab === 'monitor' ? 'block' : 'none' }}>
            <MonitorSettings data={data} onChanged={refresh} msg={msg} />
          </div>
          <div style={{ display: tab === 'history' ? 'block' : 'none' }}>
            <History data={data} autoRefresh={historyAuto} setAutoRefresh={setHistoryAuto} msg={msg} refresh={refresh} />
          </div>
        </div>
      </Layout.Content>
    </Layout>
    </ConfigProvider>
  )
}
