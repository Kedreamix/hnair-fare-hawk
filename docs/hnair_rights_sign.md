# 海航 PLUS 适用航班查询（rightsSearch）

`docs/hnair_rights_sign.py` 调用官方接口 `https://app.hnair.com/trip/flyPlus/rightsSearch`，查询某条航线在指定日期是否属于 666 / 2666 适用航班。命令行默认查 666。要查 2666，在 Python 里把 `rights_type` 传成 `["2666"]`（或同时传入两个档位）。

仅供个人核对 PLUS 航线，不要用来批量爬取。

## 用法

在仓库根目录执行，三个参数依次是出发机场、到达机场、航班日期（`YYYYMMDD`）：

```bash
python3 docs/hnair_rights_sign.py SZX PEK 20261025
```

也可以当模块调用：

```bash
PYTHONPATH=docs python3 -c "from hnair_rights_sign import rights_search; print(rights_search('SZX','TNA','20261025'))"
```

每次更换出发地、到达地、日期或 `stime`，都要重新计算 `hnairSign`。脚本在发请求前会算好。

## 签名

`hnairSign` 是 HMAC-SHA1，密钥为 `SALT`，结果写成大写十六进制。被签名的字符串按下面顺序拼接：

1. 名字里带 `hna` 的请求头，按头名字母序，只拼值。
2. body 里的标量字段（字符串、数字、布尔），按字段名字母序，只拼值。`common` 和 `data` 先摊平再排序。
3. 末尾接上 `CERT`。

数组不进入签名字符串。`rightsType` 是数组，所以不参与签名。

## 请求方式

必须用 `curl` 子进程 POST。直接用 `urllib` 经常过不了验签。脚本已经按这个方式发请求。

## 冬春日期

查冬春日期时，响应里会带 `flightPeriod`，以及 `startDate` / `endDate`，用来表示该季节的班期范围。

## 凭证

`CERT`、`SALT`、`akey` 来自公开的 HTML5 客户端 JS，写在脚本常量里。`riskToken` 和 `stime` 可能会失效，需要时再换。脚本默认用当前毫秒时间戳刷新 `stime`；`riskToken` 仍用常量，失效后要自行更新。
