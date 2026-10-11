"""把航线收成地图用的机场和连线。

优先使用 data/map/plus_winter_2026.json（2026 冬春 PLUS 适用航班）。
没有这份文件时，回退到随心飞底表。坐标来自 data/map/airports.json。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

from backend.sediment import load_records, matches_product, meta

BASE_DIR = Path(__file__).resolve().parent.parent
AIRPORTS_PATH = BASE_DIR / "data" / "map" / "airports.json"
CHINA_PATH = BASE_DIR / "data" / "map" / "china.json"
WINTER_PATH = BASE_DIR / "data" / "map" / "plus_winter_2026.json"


def load_airports() -> Dict[str, Dict[str, Any]]:
    if not AIRPORTS_PATH.is_file():
        return {}
    data = json.loads(AIRPORTS_PATH.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def load_china() -> Dict[str, Any]:
    if not CHINA_PATH.is_file():
        return {"provinces": []}
    data = json.loads(CHINA_PATH.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {"provinces": []}


def _product_matches(products: List[str], product: str | None) -> bool:
    if not product or product == "all":
        return True
    for name in products:
        if product in str(name).split("/"):
            return True
    return False


def _from_winter(product: str | None) -> Dict[str, Any] | None:
    if not WINTER_PATH.is_file():
        return None
    payload = json.loads(WINTER_PATH.read_text(encoding="utf-8"))
    coords = load_airports()
    airports: Dict[str, Dict[str, Any]] = {}
    routes: List[Dict[str, Any]] = []
    skipped = 0
    for row in payload.get("routes") or []:
        products = list(row.get("products") or [])
        if not _product_matches(products, product):
            continue
        origin_code = str(row.get("from") or "").upper()
        dest_code = str(row.get("to") or "").upper()
        if origin_code not in coords or dest_code not in coords:
            skipped += 1
            continue
        flights = int(row.get("flights") or 0)
        for code, city in (
            (origin_code, row.get("from_city")),
            (dest_code, row.get("to_city")),
        ):
            slot = airports.setdefault(
                code,
                {
                    "iata": code,
                    "city": str(city or coords[code].get("city") or code),
                    "lat": coords[code]["lat"],
                    "lon": coords[code]["lon"],
                    "flights": 0,
                },
            )
            slot["flights"] += flights
        routes.append(
            {
                "from": origin_code,
                "to": dest_code,
                "from_city": str(row.get("from_city") or ""),
                "to_city": str(row.get("to_city") or ""),
                "flights": flights,
                "products": products,
            }
        )
    route_list = sorted(routes, key=lambda row: (-int(row["flights"]), row["from"], row["to"]))
    airport_list = sorted(airports.values(), key=lambda row: (-int(row["flights"]), row["city"]))
    return {
        "ok": True,
        "season": payload.get("season") or "",
        "title": payload.get("title") or "",
        "generated_at": payload.get("season"),
        "airports": airport_list,
        "routes": route_list,
        "stats": {
            "airports": len(airport_list),
            "routes": len(route_list),
            "flights": sum(int(row["flights"]) for row in route_list),
            "skipped": skipped,
        },
    }


def network(product: str | None = None) -> Dict[str, Any]:
    """返回能画出来的机场和有向航线。冬春 PLUS 表优先。"""
    winter = _from_winter(product)
    if winter is not None:
        return winter

    coords = load_airports()
    airports: Dict[str, Dict[str, Any]] = {}
    routes: Dict[tuple, Dict[str, Any]] = {}
    skipped = 0

    for rec in load_records():
        if not matches_product(rec, product):
            continue
        origin = rec.get("origin") or {}
        dest = rec.get("dest") or {}
        origin_code = str(origin.get("iata", "")).strip().upper()
        dest_code = str(dest.get("iata", "")).strip().upper()
        if origin_code not in coords or dest_code not in coords or origin_code == dest_code:
            skipped += 1
            continue

        for code, side in ((origin_code, origin), (dest_code, dest)):
            slot = airports.setdefault(
                code,
                {
                    "iata": code,
                    "city": str(side.get("city") or coords[code].get("city") or code),
                    "lat": coords[code]["lat"],
                    "lon": coords[code]["lon"],
                    "flights": 0,
                },
            )
            slot["flights"] += 1

        key = (origin_code, dest_code)
        item = routes.get(key)
        if item is None:
            item = {
                "from": origin_code,
                "to": dest_code,
                "from_city": str(origin.get("city") or ""),
                "to_city": str(dest.get("city") or ""),
                "flights": 0,
                "products": [],
            }
            routes[key] = item
        item["flights"] += 1
        product_name = str(rec.get("product") or "")
        if product_name and product_name not in item["products"]:
            item["products"].append(product_name)

    route_list: List[Dict[str, Any]] = sorted(
        routes.values(),
        key=lambda row: (-int(row["flights"]), row["from"], row["to"]),
    )
    airport_list = sorted(airports.values(), key=lambda row: (-int(row["flights"]), row["city"]))
    return {
        "ok": True,
        "generated_at": meta().get("generated_at"),
        "airports": airport_list,
        "routes": route_list,
        "stats": {
            "airports": len(airport_list),
            "routes": len(route_list),
            "flights": sum(int(row["flights"]) for row in route_list),
            "skipped": skipped,
        },
    }
