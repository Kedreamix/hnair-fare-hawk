import React, { useState } from 'react'
import { Button, Card, Popconfirm, Space, Switch, Typography } from 'antd'
import { DeleteIcon } from '../icons.jsx'
import { api } from '../api.js'

export default function History({ data, autoRefresh, setAutoRefresh, msg, refresh }) {
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
