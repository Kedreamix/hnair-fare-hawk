"""航线地图数据：底表应收成机场和有向航线，深圳到济南保留 Y87525。"""

import backend.route_map as route_map


def test_network_includes_winter_shenzhen_routes():
    data = route_map.network()

    assert data["ok"] is True
    assert data["season"] == "2026冬春"
    assert data["stats"]["routes"] > 800
    assert any(row["from"] == "TNA" and row["to"] == "SZX" for row in data["routes"])
    assert any(row["from"] == "HLD" and row["to"] == "JGD" for row in data["routes"])
    assert all("lat" in row and "lon" in row for row in data["airports"])


def test_network_product_filter_keeps_only_matching_tier():
    data = route_map.network("666")

    assert data["stats"]["routes"] > 0
    assert all(any("666" == part for part in "/".join(row["products"]).split("/")) for row in data["routes"])
