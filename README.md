# hnair-fare-hawk · 海航随心飞低价雷达

<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="hnair-fare-hawk：海航随心飞 666/2666 会员专享价低价监控雷达，命中目标价自动推送提醒">
</p>

<p align="center">
<img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg">
 <img alt="Python 3.12+" src="https://img.shields.io/badge/Python-3.12%2B-0054A6.svg">
<img alt="React 18" src="https://img.shields.io/badge/React-18-61DAFB.svg">
  <img alt="LAN" src="https://img.shields.io/badge/%E7%9B%91%E5%90%AC-0.0.0.0%3A80-98A2B3.svg">
</p>

盯住海航随心飞 **666 / 2666 / 66666 会员专享价**：底表给出航线、班期与可飞日期，价格、经停和余票由官方接口**实时查价**，命中目标价（默认 ≤ ¥199）自动推送到微信 / 飞书等渠道。

> 只读监控与提醒，**不**自动购票 / 锁票 / 付款。请自备抓包票据并遵守航司服务条款（见[限制与合规](#限制与合规)）。

## 截图

<p align="center">
  <img src="./assets/readme/screenshot-overview.png" width="100%" alt="控制台总览：监控状态强调卡、统计卡与最近低价命中列表">
</p>

<p align="center">
  <img src="./assets/readme/screenshot-tasks.png" width="100%" alt="监控任务表：航线、档位、目标价、余票条件与操作">
</p>

<p align="center">
  <img src="./assets/readme/screenshot-mobile-dark.png" width="260" alt="移动端暗色主题：状态卡与监控任务">
</p>

## 为什么这样设计

- **静态与实时分离**：航线 / 班期 / 可飞日期 / 档位规则来自本地底表；价格 / 经停 / 余票 / 舱位永远实时查询，且**绝不回写**底表静态事实。
- **两季底表分开**：2026 秋航季和 2026 冬春 PLUS 适用航班各存一份。冬春表不写回秋航季底表，查询时接在后面。
- **档位×日期规则**：666 档屏蔽春运 / 五一 / 暑运 / 十一，2666 档仅屏蔽春运 / 暑运，66666 没有官方屏蔽条款、默认不限日期。规则单一事实源是 `data/sediment/tier_block_rules.json`，改数据即可，不动代码。更高档会员能看到更低档的专享价。
- **状态三通道**：运行状态 = 文字 + 圆点 + 颜色，不依赖单一信号；浅 / 暗主题，移动端可用。
- **防风控**：前端限频锁 + 控制台与监控循环共用的最小查价间隔（默认 3 秒，记在 `query_gate.json`，不入库）+ 429 自动退避。监控频率可按时段配置，白天默认 90–240 秒，夜间默认 300–600 秒。
- **低成本**：纯标准库 HTTP 后端 + React 单页前端，无数据库、无 Docker，个人电脑即可常驻。

<p align="center">
  <img src="./assets/readme/workflow.svg" width="100%" alt="工作流：静态底表 → 官方接口实时查价 → 三条件判定与多渠道通知">
</p>

## 快速开始

```bash
git clone https://github.com/Kedreamix/hnair-fare-hawk.git && cd hnair-fare-hawk

# conda 或 venv 都可以。下面用 conda。
conda create -n hnair python=3.12 -y
conda activate hnair
pip install -r requirements.txt

# 若用 venv：python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt

cd web && pnpm install && pnpm build && cd ..

# 代码默认监听 0.0.0.0:80。80 端口常被系统网页服务占用，也常需要管理员权限。
# 本机使用时只监听回环地址，并改到空闲的高位端口。
WEB_API_HOST=127.0.0.1 WEB_API_PORT=8502 python web_api.py

# 另开终端，先进入同一个环境，再启动监控循环
python daemon.py
```

打开 http://127.0.0.1:8502 。

`./start_all.sh` 会同时拉起监控循环和控制台，但它固定使用 `.venv/bin/python`，并且不改端口，因此会去占 `0.0.0.0:80`。用 conda，或 80 端口已被占用时，按上面的命令分开启动。

1. **「监控设置 → 抓包票据」**粘贴你在海航官网或 App 抓取的查询接口 cURL。
   - PLUS 必须单独抓 `ffl/airLowFareSearch`，而且 URL 里要有 `token`。
   - 普通票入口是 `airLowFareSearch`。没抓普通票时，可以用 PLUS 票据改回普通票端点。
   - 不能把普通票或 `airCtLowFareSearch` 改地址当成 PLUS，那样验签对不上。
   - 票据与令牌只写本地 `config.json`，**不入版本库**。
2. **「航线查询」**有周末雷达、往返航班和单程。周末雷达最多选 5 个出发地，目的地可以不选。选定到达地之后，点某一天可以查当天的实时价格和余票。同一页可以打开「全国可去地图」。
3. 把心仪航班「转为监控任务」，设置目标价、至少几张余票，以及档位白名单（666 / 2666 / 66666，不选就是不限）。
4. 命中低价后按已配置渠道推送。页面上的「启动监控」只是把状态改成运行；监控循环进程 `daemon.py` 也要开着，才会真正轮询。

> 票据与令牌、任务、查价间隔、运行日志（`config.json` / `tasks.json` / `query_gate.json` / `*.log` 等）都被 `.gitignore` 排除。请勿提交任何含 Cookie / token 的文件。

## 控制台

| 页面 | 做什么 |
| --- | --- |
| 总览 | 监控是否在跑、任务数量、最近低价命中 |
| 监控任务 | 按航线看往返和单程，可暂停某一天、编辑、删除，或跳到官网 |
| 航线查询 | 周末雷达、往返、单程，以及全国可去地图 |
| 通知管理 | 配置渠道、发送测试消息；飞书可看长连接和卡片回执 |
| 监控设置 | 抓包票据、轮询间隔、监控时段、实时查价开关 |
| 历史日志 | 运行日志和低价记录 |

任务里的某一天可以单独暂停，不必删掉整条任务。已经过去的日期不再查询，底表查询也会把有效期已经结束的航班收起来。

监控循环按「出发 + 到达 + 日期 + 普通票或 PLUS」合并请求，同一组只查一次。同一航线、同一档位、相邻日期不超过 4 天的去程和回程算一组往返：其中一段命中目标价时，提醒里会带上另一段最近那天的查询结果。

## 通知渠道

| 渠道 | 说明 |
| --- | --- |
| 微信（Server酱） | 服务号推送，重要提醒可加急 |
| 飞书 | 机器人消息 + 交互卡片确认回执（加急）。长连接收卡片回调，不需要公网地址 |
| 企业微信 | 自建应用，消息可进微信里的企业微信插件 |
| 企业微信机器人 | 按机器人 ID、密钥和会话 ID 发到单聊或群 |
| 钉钉 | 群机器人 Webhook，可选加签 |
| 邮件 | SMTP。填邮箱授权码，不要填登录密码。收件人可以用逗号分隔多个 |
| Bark / ntfy | 手机端轻量推送，可改自建服务器 |

每个渠道卡片里都有配置步骤，也可以发测试消息。飞书、企业微信自建应用、钉钉、Bark、ntfy 的文字说明还在 `docs/notify_channels_guide.md`。邮件和企业微信机器人以控制台里的步骤为准。

## 目录速览

```text
web/                  React 18 + Ant Design 5 控制台（Vite 构建，产物在 web/dist）
web_api.py            轻量 Web API（标准库 http.server，默认 0.0.0.0:80）
daemon.py             监控循环：轮询查价 → 按往返分组判定 → 通知
backend/              fetcher（官方查价）/ sediment（底表）/ route_map（航线地图）
                      channels（多渠道）/ feishu_ws（卡片回执）
data/sediment/        秋航季与冬春航季底表、档位规则（入版本库）
data/map/             航线地图用的国境、机场与冬春航线
scripts/import_plus_winter.py
                      从冬春航线表生成 data/sediment/plus_winter_2026.json
scripts/sedimentation/
                      数据校正与非票据全量自扫管线
tests/                pytest 测试集
docs/                 通知渠道与余票可行性说明
```

环境变量：

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `WEB_API_HOST` | 控制台监听地址 | `0.0.0.0` |
| `WEB_API_PORT` | 控制台端口 | `80` |

## 数据来源

- **秋航季底表（航线 / 班期 / 可飞日期 / 档位规则）**来自海航随心飞官方产品信息（2026 航季 666 / 2666 会员专享档位页面）与上游公开整理的航班计划 CSV。项目对原始数据做了二次加工：
  - 两条源以（航班号、出发城市、到达城市）为键合并归一化，产品档位取两源并集，两源判定不一致时标记 `product_conflict` 供人工复核；
  - 可飞日期优先采用官方页面实际执飞区间，CSV 备注（如「9.28始」「10.8止」「仅9.9」）解析为修正后的日期区间；
  - 第三方校正只更新起降时刻 / 航站楼 / 经停等基础事实，不覆盖航线集合、班期、可飞日期与档位。

  加工产物是 `data/sediment/flights_normalized.json`（1733 条）。档位×日期屏蔽规则见 `data/sediment/tier_block_rules.json`。

- **2026 冬春 PLUS 适用航班**另表存放。`scripts/import_plus_winter.py` 从航线表生成 `data/sediment/plus_winter_2026.json`（1491 条）。官方表没列、但已在海航 App 核实的航班放在 `data/sediment/plus_winter_2026_extra.json`，重新导入时不会覆盖。查询时冬春表和补充表接在秋航季后面。

- **航线地图**优先读 `data/map/plus_winter_2026.json`。没有这份文件时，回退到随心飞底表。机场坐标在 `data/map/airports.json`，省界在 `data/map/china.json`。

- **价格 / 经停 / 余票**不是底表数据，由官方接口实时查价，只作个人监控参考，绝不回写底表。

## 限制与合规

- 默认绑定 `0.0.0.0:80`，局域网可访问。80 端口可能已被占用或需要管理员权限，用 `WEB_API_PORT` 改端口。控制台没有登录，不要暴露到公网；只在本机使用时设 `WEB_API_HOST=127.0.0.1`。
- 实时查价依赖你自行抓取的官方接口票据。PLUS 必须是带 `token` 的 `ffl/airLowFareSearch`，不能用普通票请求改地址代替。接口与签名实现随项目提供，票据与令牌需由你自行抓取维护。本项目不提供任何绕过验证或风控的手段。
- 底表静态数据来源于公开产品信息整理并经过本地二次加工（见[数据来源](#数据来源)）。价格与余票只作个人监控参考。
- 请遵守海航及航司的服务条款与当地法律。因使用本工具产生的任何后果由使用者自行承担。

## License

[MIT](./LICENSE) © 2026 Shrek Wu（晨光）
