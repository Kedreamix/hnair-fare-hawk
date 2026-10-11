"""把《海航 PLUS 适用航班 26 冬春》PDF 解析成航线查询记录。

输出 data/sediment/plus_winter_2026.json，由 backend/sediment.py 与秋航季底表一起查询。
不改 flights_normalized.json。
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import date
from pathlib import Path

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from city_codes import AIRPORTS  # noqa: E402

PDF_DEFAULT = ROOT.parent / "lol_ai_coach" / "海航PLUS适用航班26冬春航线（A-Z排序版）.pdf"
OUT_PATH = ROOT / "data" / "sediment" / "plus_winter_2026.json"
SEDIMENT_PATH = ROOT / "data" / "sediment" / "flights_normalized.json"
AIRPORTS_PATH = ROOT / "data" / "map" / "airports.json"

CARRIERS = {
    "8L": "祥鹏航空",
    "9H": "长安航空",
    "CN": "大新华航空",
    "FU": "福州航空",
    "GS": "天津航空",
    "GX": "北部湾航空",
    "HU": "海南航空",
    "JD": "首都航空",
    "PN": "西部航空",
    "UQ": "乌鲁木齐航空",
    "Y8": "金鹏航空",
}

ROW = re.compile(
    r"^(\S+)\s+(\S+)\s+([A-Z0-9]{2}\d{3,4})\s+([1-7]+)\s+(\d{1,2}:\d{2})\s+"
    r"(\d{1,2}\.\d{1,2})-(\d{1,2}\.\d{1,2})\s+适用(.+)$"
)


def _norm(text: str) -> str:
    return text.strip().replace("机场", "").replace(" ", "").lower()


def _indexes():
    by_label: dict[str, tuple[str, str, str]] = {}
    for item in AIRPORTS:
        entry = (item.city, item.airport, item.code)
        for name in (item.city, item.airport, item.city + item.airport, *item.aliases):
            by_label.setdefault(_norm(name), entry)

    autumn: dict[str, tuple[str, str]] = {}
    payload = json.loads(SEDIMENT_PATH.read_text(encoding="utf-8"))
    for rec in payload.get("records") or []:
        for key in ("origin", "dest"):
            side = rec.get(key) or {}
            code = str(side.get("iata") or "").upper()
            city = str(side.get("city") or "").strip()
            airport = str(side.get("airport") or "").strip()
            if code and city and code not in autumn:
                autumn[code] = (city, airport)
            if city:
                by_label.setdefault(_norm(city), (city, airport or city, code))
            if city and airport:
                by_label.setdefault(_norm(city + airport), (city, airport, code))

    coords = json.loads(AIRPORTS_PATH.read_text(encoding="utf-8"))
    return by_label, autumn, coords


def _resolve(label: str, by_label, autumn, coords) -> dict[str, str]:
    hit = by_label.get(_norm(label))
    if hit:
        city, airport, code = hit
    else:
        matches = []
        for code, info in coords.items():
            city = str(info.get("city") or "")
            if city and (city in label or _norm(city) in _norm(label)):
                matches.append((len(city), code, city))
        if len(matches) != 1 and matches:
            matches = [max(matches, key=lambda item: item[0])]
        if not matches:
            raise KeyError(label)
        _, code, city = matches[0]
        rest = label.replace(city, "").replace("机场", "")
        city_name = city.replace("机场", "") or city
        airport = rest or city_name
        hit = (city_name, airport, code)
        city, airport, code = hit
    if code in autumn:
        city, airport = autumn[code]
    return {"city": city, "airport": airport, "iata": code}


def _date_pair(start: str, end: str) -> list[str]:
    """26 冬春：10–12 月是 2026，1–3 月是 2027。"""
    sm, sd = (int(part) for part in start.split("."))
    em, ed = (int(part) for part in end.split("."))

    def year_of(month: int) -> int:
        return 2027 if month <= 3 else 2026

    begin = date(year_of(sm), sm, sd)
    finish = date(year_of(em), em, ed)
    if finish < begin:
        finish = date(finish.year + 1, em, ed)
    return [begin.isoformat(), finish.isoformat()]


def _product(text: str) -> str:
    if "666或2666" in text or "666/2666" in text:
        return "666/2666"
    if "2666" in text:
        return "2666"
    if "666" in text:
        return "666"
    raise ValueError(text)


def _rows(pdf_path: Path) -> list[str]:
    reader = PdfReader(str(pdf_path))
    lines: list[str] = []
    for page in reader.pages:
        for raw in (page.extract_text() or "").splitlines():
            line = raw.strip()
            if not line or line.startswith("出港城市"):
                continue
            lines.append(line)
    joined: list[str] = []
    buf = ""
    for line in lines:
        if not buf:
            candidate = line
        else:
            candidate = ""
            for sep in ("", " "):
                trial = buf + sep + line
                if ROW.match(trial):
                    candidate = trial
                    break
            if not candidate:
                buf = buf + line
                continue
        if ROW.match(candidate):
            joined.append(candidate)
            buf = ""
        else:
            buf = candidate
    if buf:
        raise ValueError(f"无法解析的残行：{buf}")
    return joined


def build(pdf_path: Path) -> dict:
    by_label, autumn, coords = _indexes()
    records = []
    missing = Counter()
    for line in _rows(pdf_path):
        matched = ROW.match(line)
        if not matched:
            raise ValueError(line)
        origin_label, dest_label, flight_no, days, dep, start, end, product = matched.groups()
        try:
            origin = _resolve(origin_label, by_label, autumn, coords)
            dest = _resolve(dest_label, by_label, autumn, coords)
        except KeyError as exc:
            missing[str(exc)] += 1
            continue
        prefix = flight_no[:2]
        records.append({
            "flight_no": flight_no,
            "carrier": CARRIERS[prefix],
            "origin": origin,
            "dest": dest,
            "dep_time": f"{int(dep.split(':')[0]):02d}:{dep.split(':')[1]}",
            "arr_time": "",
            "days": [int(ch) for ch in days],
            "effective_dates": [_date_pair(start, end)],
            "product": _product("适用" + product),
            "product_conflict": False,
            "source": "plus_winter_2026",
            "season": "2026冬春",
            "notes": None,
        })
    if missing:
        raise SystemExit(f"城市没有对上三字码：{dict(missing)}")
    unique = []
    seen = set()
    for rec in records:
        key = json.dumps(rec, ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        unique.append(rec)
    records = unique
    payload = {
        "season": "2026冬春",
        "title": "海航 PLUS 适用航班 26 冬春",
        "generated_at": date.today().isoformat(),
        "count": len(records),
        "records": records,
    }
    return payload


def main() -> None:
    pdf_path = Path(sys.argv[1]) if len(sys.argv) > 1 else PDF_DEFAULT
    payload = build(pdf_path)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {payload['count']} -> {OUT_PATH}")


if __name__ == "__main__":
    main()
