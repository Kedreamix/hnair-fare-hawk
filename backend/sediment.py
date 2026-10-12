"""666/2666 随心飞底表只读查询模块。

数据源：
- data/sediment/flights_normalized.json（2026 秋航季，由 scripts/sedimentation/update.py
  重建，重建前存时点快照，版本见 data/sediment/versions.json）；
- data/sediment/plus_winter_2026.json（2026 冬春 PLUS 适用航班，由
  scripts/import_plus_winter.py 从航线表生成，查询时接在秋航季后面）；
- data/sediment/plus_winter_2026_extra.json（冬春人工补充：官方 PDF 漏列、经海航 App 核实的航班）；
- data/sediment/tier_block_rules.json（档位×日期屏蔽规则，单一事实源，经
  meta() 下发前端日期选择；query() 按档位日期屏蔽返回空）。

设计：
- 只读，启动后懒加载一次（约 1.6MB），之后常驻内存；
- 查询维度：出发/到达城市、产品档位（666/2666）、日期（班期 + 有效日期区间）、航班号；
- 判断规则：product 必须按 "/" 切分后判成员（"666" in "2666" 是坑）；日期需落在
  effective_dates 任一段且 days 含当天星期（周一=1 … 周日=7，isoweekday）；
- 档位×日期：666 屏蔽春运/五一/暑运/十一，2666 仅屏蔽春运/暑运（见 tier_block_rules.json）。
  指定档位 + 日期/区间落在屏蔽区间内时 query() 直接返回空（业务上该档该日不可兑）。
"""

from __future__ import annotations

import json
import threading
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

SEDIMENT_PATH = Path(__file__).resolve().parents[1] / "data" / "sediment" / "flights_normalized.json"
WINTER_PATH = Path(__file__).resolve().parents[1] / "data" / "sediment" / "plus_winter_2026.json"
# 官方 PDF 漏列、经海航 App 核实的冬春航班；import_plus_winter.py 重新生成时不会覆盖
WINTER_EXTRA_PATH = Path(__file__).resolve().parents[1] / "data" / "sediment" / "plus_winter_2026_extra.json"
TIER_BLOCK_RULES_PATH = Path(__file__).resolve().parents[1] / "data" / "sediment" / "tier_block_rules.json"

_lock = threading.Lock()
_cache: Optional[List[Dict[str, Any]]] = None
_block_lock = threading.Lock()
_block_cache: Optional[Dict[str, Any]] = None


def _read_record_file(path: Path) -> List[Dict[str, Any]]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return list(payload.get("records") or [])


def load_records(path: str | Path | None = None, force: bool = False) -> List[Dict[str, Any]]:
    """加载底表 records，首次调用后缓存。数据文件缺失时返回空列表（不影响其他功能）。

    默认同时读入秋航季底表和冬春 PLUS 表。传入 path 时只读该文件，便于测试替换底表。
    """
    global _cache
    if _cache is None or force:
        with _lock:
            if _cache is None or force:
                try:
                    records = _read_record_file(Path(path) if path else SEDIMENT_PATH)
                except (OSError, ValueError):
                    records = []
                if path is None:
                    for extra in (WINTER_PATH, WINTER_EXTRA_PATH):
                        try:
                            records.extend(_read_record_file(extra))
                        except (OSError, ValueError):
                            pass
                _cache = records
    return _cache


def day_to_weekday(d: date) -> int:
    """date -> 1(周一)..7(周日)。"""
    return d.isoweekday()


def tier_block_rules(force: bool = False) -> Dict[str, Any]:
    """档位×日期屏蔽规则（单一事实源：data/sediment/tier_block_rules.json）。

    返回 {"source": ..., "notes": ..., "tiers": {档位: {"label": ..., "blocks": [[start, end], ...]}}}；
    文件缺失或损坏时返回 {"tiers": {}}（不抛错，前端保留自身兜底规则）。
    """
    global _block_cache
    if _block_cache is None or force:
        with _block_lock:
            if _block_cache is None or force:
                try:
                    _block_cache = json.loads(TIER_BLOCK_RULES_PATH.read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    _block_cache = {"tiers": {}}
    return _block_cache


def tier_blocks(tier: str) -> List[List[str]]:
    """某档位的屏蔽区间列表（闭区间，含首尾）；无规则返回空列表。"""
    return list(tier_block_rules().get("tiers", {}).get(str(tier), {}).get("blocks") or [])


def product_tiers(product: str | None) -> List[str]:
    """product 拆成档位列表（"666/2666" -> ["666","2666"]；空 / "all" -> []）。"""
    if not product or str(product) == "all":
        return []
    return [p for p in str(product).split("/") if p]


def date_in_blocks(blocks: List[List[str]], date_str: str) -> bool:
    """date_str 是否落在任一屏蔽区间内（闭区间）。"""
    try:
        date.fromisoformat(date_str)
    except ValueError:
        return False
    return any(a <= date_str <= b for a, b in blocks)


def range_fully_in_blocks(blocks: List[List[str]], date_start: str = "", date_end: str = "") -> bool:
    """date_start..date_end 是否完全落在某一段屏蔽区间内（闭区间，含首尾）。

    单边（只给 start 或 end）时按该点是否落在区间内判断；空区间返回 False。
    """
    if not date_start and not date_end:
        return False
    try:
        d0 = date.fromisoformat(date_start) if date_start else None
        d1 = date.fromisoformat(date_end) if date_end else None
    except ValueError:
        return False
    if d0 and d1 and d0 > d1:
        return True  # 非法区间：query 语义为不匹配，视为「被屏蔽」直接返回空
    for a, b in blocks:
        try:
            sa, sb = date.fromisoformat(a), date.fromisoformat(b)
        except ValueError:
            continue
        if d0 and d1:
            if sa <= d0 and d1 <= sb:
                return True
        elif d0 and sa <= d0 <= sb:
            return True
        elif d1 and sa <= d1 <= sb:
            return True
    return False


def blocked_by_tier(
    product: str | None,
    date_str: str = "",
    date_start: str = "",
    date_end: str = "",
) -> bool:
    """指定档位（可含多档）在给定日期/区间上是否被任一档位规则屏蔽。

    - 单日：落在任一档位屏蔽区间内即 True；
    - 区间：整个区间完全落在某一档位屏蔽区间内才 True（部分重叠保留原始语义，
      由调用方/前端按具体日期收窄）；
    - 未指定档位（None/all/空）不屏蔽。
    """
    tiers = product_tiers(product)
    if not tiers:
        return False
    for t in tiers:
        blocks = tier_blocks(t)
        if not blocks:
            continue
        if date_str:
            if date_in_blocks(blocks, date_str):
                return True
        elif date_start or date_end:
            if range_fully_in_blocks(blocks, date_start, date_end):
                return True
    return False


def matches_product(record: Dict[str, Any], product: str | None) -> bool:
    """product 过滤：按 "/" 切分后判成员，避免 "666" in "2666" 的误判。"""
    if not product or product == "all":
        return True
    return str(product) in str(record.get("product", "")).split("/")


def matches_date(record: Dict[str, Any], date_str: str) -> bool:
    """日期过滤：落在 effective_dates 任一段，且当天班期 days 含该日星期（1=周一）。"""
    if not date_str:
        return True
    try:
        wd = day_to_weekday(date.fromisoformat(date_str))
    except ValueError:
        return False
    in_range = any(a <= date_str <= b for a, b in (record.get("effective_dates") or []))
    in_days = wd in (record.get("days") or [])
    return in_range and in_days


def matches_date_in_range(record: Dict[str, Any], date_start: str = "", date_end: str = "") -> bool:
    """日期区间过滤：区间与 effective_dates 任一段有交集，且交集内至少存在一个班期日。

    用于「可飞日期选择区间」：只要区间内有任意一天可飞即命中（不要求每天都可飞）。
    """
    if not date_start and not date_end:
        return True
    try:
        d0 = date.fromisoformat(date_start) if date_start else None
        d1 = date.fromisoformat(date_end) if date_end else None
    except ValueError:
        return False
    if d0 and d1 and d0 > d1:
        return False
    days = set(record.get("days") or [])
    if not days:
        return False
    for a, b in (record.get("effective_dates") or []):
        try:
            seg_start = date.fromisoformat(a)
            seg_end = date.fromisoformat(b)
        except ValueError:
            continue
        lo = max(d0, seg_start) if d0 else seg_start
        hi = min(d1, seg_end) if d1 else seg_end
        if lo > hi:
            continue
        span = (hi - lo).days
        if span >= 7:
            # 交集覆盖至少一整周：只要班期非空必有可飞日
            return True
        cur = lo
        while cur <= hi:
            if cur.isoweekday() in days:
                return True
            cur += timedelta(days=1)
    return False


def _airport_matches(airport: Dict[str, Any], target: str) -> bool:
    """机场匹配：支持城市名 / 机场名 / IATA 三字码。"""
    t = str(target or "").strip().upper()
    if not t:
        return True
    iata = str(airport.get("iata", "") or "").upper()
    city = str(airport.get("city", "") or "").strip()
    ap = str(airport.get("airport", "") or "").strip()
    norm = lambda s: s.replace("机场", "").replace(" ", "")
    if t in (iata, city.upper(), norm(ap).upper(), norm(city).upper(), norm(city + ap).upper()):
        return True
    return norm(city) in norm(t) or norm(t) in norm(city)


def query(
    city: str = "",
    from_city: str = "",
    to_city: str = "",
    product: str | None = None,
    date_str: str = "",
    date_start: str = "",
    date_end: str = "",
    flight_no: str = "",
    direction: str = "both",
    limit: int = 300,
) -> List[Dict[str, Any]]:
    """多维度查询底表。

    - city：任一端城市（出发或到达），兼容验收锚点口径（海口 any 方向）；
    - from_city / to_city：分别限定出发/到达端；
    - product：666 / 2666 / all / 空（不限）；
    - date_str：YYYY-MM-DD，校验有效日期区间 + 班期（单日）；
    - date_start / date_end：YYYY-MM-DD 区间，区间内任意一天可飞即命中（二选一与单日互斥）；
    - flight_no：航班号模糊匹配（子串，大小写不敏感）；
    - direction：depart（仅出发）/ arrive（仅到达）/ both（默认，配合 city 使用）。
    """
    records = load_records()
    # 档位×日期屏蔽：指定档位 + 日期/区间落在屏蔽区间内时，业务上该档该日不可兑，直接返回空
    if blocked_by_tier(product, date_str=date_str, date_start=date_start, date_end=date_end):
        return []
    out: List[Dict[str, Any]] = []
    for rec in records:
        o = rec.get("origin") or {}
        de = rec.get("dest") or {}
        o_city, de_city = o.get("city", ""), de.get("city", "")
        if from_city and not _airport_matches(o, from_city):
            continue
        if to_city and not _airport_matches(de, to_city):
            continue
        if city:
            if city not in (o_city, de_city):
                continue
            if direction == "depart" and o_city != city:
                continue
            if direction == "arrive" and de_city != city:
                continue
        if not matches_product(rec, product):
            continue
        if date_str:
            if not matches_date(rec, date_str):
                continue
        elif date_start or date_end:
            if not matches_date_in_range(rec, date_start, date_end):
                continue
        if flight_no:
            fn = str(rec.get("flight_no", "")).upper()
            if str(flight_no).upper() not in fn:
                continue
        out.append(rec)
    if not date_str and not date_start and not date_end:
        today = date.today().isoformat()
        out = [rec for rec in out if _relevant_on_or_after(rec, today)]
    out.sort(key=_flight_sort_key)
    if limit:
        return out[:limit]
    return out


def _range_pairs(record: Dict[str, Any]) -> List[List[str]]:
    pairs = []
    for raw in record.get("effective_dates") or []:
        if isinstance(raw, (list, tuple)) and len(raw) >= 2:
            pairs.append([str(raw[0])[:10], str(raw[1])[:10]])
    return pairs


def _relevant_on_or_after(record: Dict[str, Any], day: str) -> bool:
    """有效期终点不早于 day。没有日期的记录保留。"""
    ranges = _range_pairs(record)
    if not ranges:
        return True
    return any(end >= day for _, end in ranges)


def _flight_sort_key(record: Dict[str, Any]) -> tuple:
    """同一航班号、同一航线排在一起，班期本身不合并。"""
    ranges = _range_pairs(record)
    start = ranges[0][0] if ranges else ""
    origin = str((record.get("origin") or {}).get("iata") or "")
    dest = str((record.get("dest") or {}).get("iata") or "")
    return (
        str(record.get("flight_no") or ""),
        origin,
        dest,
        start,
        str(record.get("dep_time") or ""),
        tuple(record.get("days") or []),
    )


def options(
    city: str = "",
    from_city: str = "",
    to_city: str = "",
    product: str | None = None,
    date_str: str = "",
    date_start: str = "",
    date_end: str = "",
    direction: str = "both",
) -> Dict[str, List[str]]:
    """基于数据的出发/到达联动选项（与 query 同一套过滤口径）。

    返回 {from_options, to_options}：当前筛选条件下「可搜到的航线」两端城市列表，
    格式「城市（IATA1/IATA2）·机场1/机场2」（机场名去「机场」后缀），
    城市/三字码/机场名均可模糊搜索。供前端下拉组件联动筛选。
    """
    records = query(
        city=city,
        from_city=from_city,
        to_city=to_city,
        product=product,
        date_str=date_str,
        date_start=date_start,
        date_end=date_end,
        direction=direction,
        limit=100000,
    )
    origins: Dict[str, set] = {}
    dests: Dict[str, set] = {}
    airport_by_iata: Dict[str, str] = {}
    for rec in records:
        o = rec.get("origin") or {}
        de = rec.get("dest") or {}
        if o.get("iata") and o.get("city"):
            origins.setdefault(str(o["city"]).strip(), set()).add(str(o["iata"]).strip())
            if o.get("airport"):
                airport_by_iata.setdefault(str(o["iata"]).strip(), str(o["airport"]).strip())
        if de.get("iata") and de.get("city"):
            dests.setdefault(str(de["city"]).strip(), set()).add(str(de["iata"]).strip())
            if de.get("airport"):
                airport_by_iata.setdefault(str(de["iata"]).strip(), str(de["airport"]).strip())

    def _label(c: str, ias: set) -> str:
        """城市（IATA1/IATA2）·机场1/机场2，机场名去「机场」后缀，供前端模糊搜索。"""
        names = []
        for iata in sorted(ias):
            name = airport_by_iata.get(iata, "")
            if name:
                names.append(name.replace("机场", ""))
        suffix = f"·{'/'.join(names)}" if names else ""
        return f"{c}（{'/'.join(sorted(ias))}）{suffix}"

    def fmt(m: Dict[str, set]) -> List[str]:
        return sorted(_label(c, ias) for c, ias in m.items())

    return {"from_options": fmt(origins), "to_options": fmt(dests)}


HEATMAP_OPEN_DAYS = 30
HEATMAP_MAX_DAYS = 92
WINTER_SEASON = "2026冬春"
WINTER_START = date(2026, 10, 25)


def _parse_iso_day(value: str) -> date:
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError as exc:
        raise ValueError(f"日期格式应为 YYYY-MM-DD：{value}") from exc


def _heatmap_window(
    date_str: str = "",
    date_start: str = "",
    date_end: str = "",
    today: date | None = None,
) -> tuple:
    """返回 (days, unbounded, truncated)。未指定日期时从 today 起看 30 天。"""
    today = today or date.today()
    if date_str:
        return [_parse_iso_day(date_str)], False, False
    if date_start or date_end:
        start = _parse_iso_day(date_start or date_end)
        end = _parse_iso_day(date_end or date_start)
        if end < start:
            raise ValueError("结束日期不能早于开始日期")
        truncated = False
        if (end - start).days + 1 > HEATMAP_MAX_DAYS:
            end = start + timedelta(days=HEATMAP_MAX_DAYS - 1)
            truncated = True
        days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        return days, False, truncated
    days = [today + timedelta(days=i) for i in range(HEATMAP_OPEN_DAYS)]
    return days, True, False


def _heatmap_tiers(record: Dict[str, Any], day: str, product: str | None) -> List[str]:
    """当天仍可兑的档位。屏蔽区间内的档位去掉；指定档位时只留该档。"""
    tiers = [t for t in product_tiers(record.get("product")) if t in ("666", "2666")]
    wanted = product_tiers(product)
    if wanted:
        tiers = [t for t in tiers if t in wanted]
    return [t for t in tiers if not date_in_blocks(tier_blocks(t), day)]


def _winter_row(record: Dict[str, Any]) -> bool:
    return str(record.get("season") or "") == WINTER_SEASON


def _prefer_heatmap_row(new: Dict[str, Any], old: Dict[str, Any], day: date) -> bool:
    """同一航班同一天只留一条：冬春日起优先冬春表，之前优先秋航季表。"""
    want_winter = day >= WINTER_START
    new_winter = _winter_row(new)
    old_winter = _winter_row(old)
    if new_winter == old_winter:
        return False
    return new_winter if want_winter else not new_winter


def destination_heatmap(
    from_city: str = "",
    product: str | None = None,
    date_str: str = "",
    date_start: str = "",
    date_end: str = "",
    today: date | None = None,
) -> Dict[str, Any]:
    """出发地在日期范围内能飞到的每个目的地，按日给出班次，并区分 666 / 2666。

    数据来自 load_records()：秋航季 flights_normalized.json，以及
    plus_winter_2026.json / plus_winter_2026_extra.json。同一航班、同一天若两表都命中，
    只计一次（2026-10-25 及以后用冬春表，之前用秋航季表）。
    未传日期时统计从 today 起的 30 天；区间超过 92 天时只取前 92 天。
    """
    days, unbounded, truncated = _heatmap_window(date_str, date_start, date_end, today)
    origin_query = str(from_city or "").strip() or "深圳"
    window_start = days[0].isoformat()
    window_end = days[-1].isoformat()
    chosen: Dict[tuple, Dict[str, Any]] = {}

    for rec in load_records():
        origin = rec.get("origin") or {}
        dest = rec.get("dest") or {}
        if not _airport_matches(origin, origin_query):
            continue
        if product and not matches_product(rec, product):
            continue
        if not matches_date_in_range(rec, window_start, window_end):
            continue
        flight_no = str(rec.get("flight_no") or "").strip().upper()
        dest_city = str(dest.get("city") or "").strip()
        dest_iata = str(dest.get("iata") or "").strip().upper()
        if not flight_no or not dest_city or not dest_iata:
            continue
        for day in days:
            day_s = day.isoformat()
            if not matches_date(rec, day_s):
                continue
            tiers = _heatmap_tiers(rec, day_s, product)
            if not tiers:
                continue
            key = (dest_city, dest_iata, flight_no, day_s)
            slot = chosen.get(key)
            if slot is None or _prefer_heatmap_row(rec, slot["rec"], day):
                chosen[key] = {"rec": rec, "tiers": list(tiers), "dest": dest}

    origin_hits: Dict[str, Dict[str, Any]] = {}
    for slot in chosen.values():
        origin = (slot["rec"].get("origin") or {})
        origin_iata = str(origin.get("iata") or "").strip().upper()
        if not origin_iata:
            continue
        bucket = origin_hits.setdefault(origin_iata, {"n": 0, "origin": origin})
        bucket["n"] += 1

    by_city: Dict[str, Dict[str, Any]] = {}
    for (dest_city, dest_iata, flight_no, day_s), slot in chosen.items():
        city = by_city.get(dest_city)
        if city is None:
            city = {
                "city": dest_city,
                "iata_counts": {},
                "airports": {},
                "flight_nos": set(),
                "by_date": {},
                "samples": {},
            }
            by_city[dest_city] = city
        city["iata_counts"][dest_iata] = city["iata_counts"].get(dest_iata, 0) + 1
        city["airports"][dest_iata] = str((slot["dest"] or {}).get("airport") or "")
        city["flight_nos"].add(flight_no)
        row = city["by_date"].get(day_s)
        if row is None:
            row = {"date": day_s, "flight_nos": set(), "666": 0, "2666": 0}
            city["by_date"][day_s] = row
        if flight_no not in row["flight_nos"]:
            row["flight_nos"].add(flight_no)
            if "666" in slot["tiers"]:
                row["666"] += 1
            if "2666" in slot["tiers"]:
                row["2666"] += 1
        tiers = slot["tiers"]
        product_name = "/".join(t for t in ("666", "2666") if t in tiers)
        rec = slot["rec"]
        prev = city["samples"].get(flight_no)
        if prev is None:
            city["samples"][flight_no] = {
                "flight_no": flight_no,
                "dep_time": str(rec.get("dep_time") or ""),
                "arr_time": str(rec.get("arr_time") or ""),
                "product": product_name,
                "dest_iata": dest_iata,
            }
        else:
            parts = set(str(prev.get("product") or "").split("/")) | set(product_name.split("/"))
            parts.discard("")
            prev["product"] = "/".join(t for t in ("666", "2666") if t in parts)
            dep = str(rec.get("dep_time") or "")
            if dep and (not prev.get("dep_time") or dep < prev["dep_time"]):
                prev["dep_time"] = dep
                prev["arr_time"] = str(rec.get("arr_time") or "")
                prev["dest_iata"] = dest_iata

    destinations: List[Dict[str, Any]] = []
    for city in by_city.values():
        by_date = []
        departures = 0
        has_666 = False
        for day_s in sorted(city["by_date"]):
            row = city["by_date"][day_s]
            nos = sorted(row["flight_nos"])
            departures += len(nos)
            has_666 = has_666 or row["666"] > 0
            by_date.append({
                "date": day_s,
                "flights": len(nos),
                "666": row["666"],
                "2666": row["2666"],
                "flight_nos": nos,
            })
        primary = max(city["iata_counts"], key=lambda iata: (city["iata_counts"][iata], iata))
        samples = sorted(city["samples"].values(), key=lambda item: (item.get("dep_time") or "99:99", item["flight_no"]))
        destinations.append({
            "city": city["city"],
            "iata": primary,
            "airport": city["airports"].get(primary) or "",
            "iatas": sorted(city["iata_counts"]),
            "flights": len(city["flight_nos"]),
            "departures": departures,
            "kind": "666" if has_666 else "2666",
            "by_date": by_date,
            "samples": samples[:4],
        })
    destinations.sort(key=lambda item: (-int(item["departures"]), item["city"]))

    if origin_hits:
        origin_iata = max(origin_hits, key=lambda iata: (origin_hits[iata]["n"], iata))
        origin = origin_hits[origin_iata]["origin"]
        origin_view = {
            "city": str(origin.get("city") or origin_query),
            "iata": origin_iata,
            "airport": str(origin.get("airport") or ""),
        }
    else:
        origin_view = {"city": origin_query, "iata": "", "airport": ""}

    return {
        "origin": origin_view,
        "date_start": window_start,
        "date_end": window_end,
        "span_days": len(days),
        "unbounded": unbounded,
        "truncated": truncated,
        "destinations": destinations,
        "stats": {
            "destinations": len(destinations),
            "flights": sum(int(item["flights"]) for item in destinations),
            "departures": sum(int(item["departures"]) for item in destinations),
            "666": sum(1 for item in destinations if item["kind"] == "666"),
            "2666": sum(1 for item in destinations if item["kind"] == "2666"),
        },
    }


def meta() -> Dict[str, Any]:
    """元信息：版本、总数、档位/来源分布、城市与机场列表（供前端筛选器）。"""
    records = load_records()
    cities: Dict[str, set] = {}
    airports: Dict[str, Dict[str, str]] = {}
    product_dist: Dict[str, int] = {}
    source_dist: Dict[str, int] = {}
    for rec in records:
        for key in ("origin", "dest"):
            a = rec.get(key) or {}
            iata = str(a.get("iata", "")).strip()
            city = str(a.get("city", "")).strip()
            if iata:
                airports.setdefault(iata, {"city": city, "airport": str(a.get("airport", "")).strip()})
                cities.setdefault(city, set()).add(iata)
        product_dist[rec.get("product", "")] = product_dist.get(rec.get("product", ""), 0) + 1
        source_dist[rec.get("source", "")] = source_dist.get(rec.get("source", ""), 0) + 1

    version: Any = None
    try:
        versions = json.loads((SEDIMENT_PATH.parent / "versions.json").read_text(encoding="utf-8"))
        vlist = versions.get("versions", [])
        if vlist:
            version = vlist[-1]
    except (OSError, ValueError):
        pass

    city_list = sorted({f"{c}（{'/'.join(sorted(ias))}）" for c, ias in cities.items()})
    return {
        "count": len(records),
        "version": version,
        "city_options": city_list,
        "airports": airports,
        "product_dist": product_dist,
        "source_dist": source_dist,
        "tier_block_rules": tier_block_rules(),
        "generated_at": f"{date.today().isoformat()}",
    }