#!/usr/bin/env python3
"""海航 flyPlus/rightsSearch：HMAC-SHA1 签名 + 查询（standard，可换 OD/日期）。

用法（在仓库根目录）：
  python3 docs/hnair_rights_sign.py SZX PEK 20261025
  PYTHONPATH=docs python3 -c "from hnair_rights_sign import rights_search; print(rights_search('SZX','TNA','20261025'))"

注意：用 curl 发请求（urllib 容易验签失败）。每次改 OD/日期/stime 都要重算 hnairSign。
"""
from __future__ import annotations

import hashlib
import hmac
import json
import subprocess
import time
from pathlib import Path
from typing import Any

CERT = "6093941774D84495A5D15D8F909CAA1E"
SALT = "21047C596EAD45209346AE29F0350491"
URL = "https://app.hnair.com/trip/flyPlus/rightsSearch"

COMMON = {
    "sname": "MacIntel",
    "sver": "5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
    "caller": "HTML5",
    "schannel": "HTML5",
    "mchannel": "",
    "slang": "en-US",
    "did": "defualt_web_did_1791989885760_37955720",
    "stime": 1791989947651,
    "szone": -480,
    "aname": "com.hnair.spa.web.standard",
    "aver": "10.19.0",
    "akey": "9E4BBDDEC6C8416EA380E418161A7CD3",
    "abuild": 24249,
    "atarget": "standard",
    "slat": "slat",
    "slng": "slng",
    "gtcid": "defualt_web_gtcid",
    "riskToken": "6acf987e1XM9iIjPtVGgYW1SyDYgBUXJHXcPuCP1",
    "captchaToken": "",
    "blackBox": "1791989910306WPHVnF7Nloc7d",
    "validateToken": "",
    "sens": "%hna%gvnva4gE3sEXviyHG5bmUreTHKEOjexucBqAfND7IUo=",
}


def fu(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v == int(v):
            return str(int(v) or 0)
        return str(v)
    return str(v)


def hnair_sign(body_flat: dict, header: dict | None = None) -> str:
    """body_flat = {**common, **data}。数组字段（rightsType）不参与签名。"""
    header = header or {"hna-app": "APP", "hna-channel": "HTML5"}
    h_keys = sorted(k for k in header if "hna" in k)
    b_keys = sorted(k for k, v in body_flat.items() if type(v) in (str, int, float, bool))
    payload = "".join(fu(header[k]) for k in h_keys)
    payload += "".join(fu(body_flat[k]) for k in b_keys)
    payload += CERT
    return hmac.new(SALT.encode(), payload.encode(), hashlib.sha1).hexdigest().upper()


def rights_search(
    orig: str,
    dest: str,
    flt_date: str,
    rights_type: list[str] | None = None,
    refresh_stime: bool = True,
) -> dict:
    rights_type = rights_type or ["666"]
    common = dict(COMMON)
    if refresh_stime:
        common["stime"] = int(time.time() * 1000)
    data = {
        "rightsType": rights_type,
        "orig": orig,
        "dest": dest,
        "fltDate": flt_date,
        "_referer": "/hnams/plusMember/airlineQueryList",
    }
    sign = hnair_sign({**common, **data})
    body = json.dumps({"common": common, "data": data}, ensure_ascii=False, separators=(",", ":"))
    cmd = [
        "curl", "-sS", "--max-time", "30",
        f"{URL}?hnairSign={sign}",
        "-H", "accept: application/json, text/plain, */*",
        "-H", "content-type: application/json;charset=UTF-8",
        "-H", "appver: 10.19.0",
        "-H", "hna-app: APP",
        "-H", "hna-channel: HTML5",
        "-H", "origin: https://m.hnair.com",
        "-H", "referer: https://m.hnair.com/",
        "-H", "user-agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        "--data-raw", body,
    ]
    raw = subprocess.check_output(cmd)
    return json.loads(raw.decode())


if __name__ == "__main__":
    import sys

    args = sys.argv[1:]
    orig = args[0] if len(args) > 0 else "SZX"
    dest = args[1] if len(args) > 1 else "PEK"
    date = args[2] if len(args) > 2 else "20261025"
    print(json.dumps(rights_search(orig, dest, date), ensure_ascii=False, indent=2))
