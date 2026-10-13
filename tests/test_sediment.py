"""backend/sediment.py 底表查询模块测试（只读，基于真实底表数据）。"""

import sys
import os
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import sediment  # noqa: E402
from city_codes import code_to_city_label, resolve_code  # noqa: E402


@pytest.fixture(scope="module", autouse=True)
def loaded():
    """确保每个测试共享一次加载（模块级缓存）。"""
    sediment.load_records(force=True)
    return sediment.load_records()


def test_records_loaded(loaded):
    assert len(loaded) >= 1700
    assert all({"flight_no", "carrier", "origin", "dest", "product", "days", "effective_dates"} <= set(r.keys()) for r in loaded[:10])


def test_matches_product_split_rule():
    """product 必须按 / 切分判成员：2666 记录不能匹配 666。"""
    rec_2666 = {"product": "2666"}
    rec_both = {"product": "666/2666"}
    rec_666 = {"product": "666"}
    assert sediment.matches_product(rec_666, "666") is True
    assert sediment.matches_product(rec_both, "666") is True
    assert sediment.matches_product(rec_2666, "666") is False  # 坑：直接 in 会误判
    assert sediment.matches_product(rec_2666, "2666") is True
    assert sediment.matches_product(rec_both, "2666") is True
    assert sediment.matches_product(rec_both, None) is True
    assert sediment.matches_product(rec_both, "all") is True


def test_matches_date_range_and_days():
    rec = {
        "effective_dates": [["2026-09-01", "2026-10-24"]],
        "days": [1, 3, 5],  # 周一三五
    }
    # 2026-10-03 是周六，不在班期
    assert sediment.matches_date(rec, "2026-10-03") is False
    # 2026-10-05 是周一，且在有效区间内
    assert sediment.matches_date(rec, "2026-10-05") is True
    # 区间外
    assert sediment.matches_date(rec, "2026-08-15") is False
    # 无日期不过滤
    assert sediment.matches_date(rec, "") is True
    # 非法日期
    assert sediment.matches_date(rec, "not-a-date") is False


def test_tier_block_rules_loaded(loaded):
    """档位×日期屏蔽规则文件加载：存在、档位齐全、十一屏蔽区间与 sxfroute 一致。"""
    rules = sediment.tier_block_rules()
    assert isinstance(rules, dict) and "tiers" in rules
    tiers = rules["tiers"]
    assert "666" in tiers and "2666" in tiers
    blocks666 = [b for b in tiers["666"]["blocks"]]
    assert ["2026-09-30", "2026-10-09"] in blocks666  # 2026 十一（国庆法定及前后各一天）
    assert ["2026-04-30", "2026-05-06"] in blocks666  # 2026 五一
    assert ["2026-07-01", "2026-08-31"] in blocks666  # 暑运
    blocks2666 = tiers["2666"]["blocks"]
    assert ["2026-09-30", "2026-10-09"] not in blocks2666  # 2666 不受国庆限制（sxfroute 同结论）
    # 缺失文件时的兜底：不抛错、返回空 tiers
    assert sediment.tier_blocks("不存在档位") == []
    assert sediment.product_tiers(None) == []
    assert sediment.product_tiers("all") == []
    assert sediment.product_tiers("666/2666") == ["666", "2666"]


def test_blocked_by_tier():
    """blocked_by_tier：单日/区间/多档位判断。"""
    assert sediment.blocked_by_tier("666", date_str="2026-10-03") is True   # 十一屏蔽内
    assert sediment.blocked_by_tier("666", date_str="2026-10-10") is False  # 屏蔽区间外
    assert sediment.blocked_by_tier("666", date_str="2026-09-29") is False  # 屏蔽区间前一日
    assert sediment.blocked_by_tier("2666", date_str="2026-10-03") is False  # 2666 不受国庆限制
    assert sediment.blocked_by_tier("666/2666", date_str="2026-10-03") is True  # 任一档被屏蔽即 True
    assert sediment.blocked_by_tier(None, date_str="2026-10-03") is False  # 不限档位不屏蔽
    assert sediment.blocked_by_tier("666", date_str="2026-07-15") is True  # 暑运（2666 也屏蔽）
    assert sediment.blocked_by_tier("2666", date_str="2026-07-15") is True
    # 区间：完全落在屏蔽区间内才屏蔽；部分重叠不屏蔽（由前端按具体日期收窄）
    assert sediment.blocked_by_tier("666", date_start="2026-10-01", date_end="2026-10-05") is True
    assert sediment.blocked_by_tier("666", date_start="2026-10-05", date_end="2026-10-15") is False
    assert sediment.blocked_by_tier("2666", date_start="2026-10-01", date_end="2026-10-05") is False
    # 2026-10-03 确实是周六（锚点换日依据）
    import datetime
    assert datetime.date(2026, 10, 3).isoweekday() == 6


def test_query_acceptance_anchor_haikou_666():
    """验收锚点：海口相关（出发或到达）+ 666 + 2026-10-10（周六，国庆屏蔽区间外）。

    2026-10-03 原锚点落在 666 档十一屏蔽区间（09-30~10-09）内，按真实规则该档该日不可兑，
    故锚点移到屏蔽区间外的周六 2026-10-10。当前底表（v1）约 102 条。"""
    rows = sediment.query(city="海口", product="666", date_str="2026-10-10", direction="both")
    assert len(rows) >= 100
    assert len(rows) <= 120
    # 每条都与海口相关
    for r in rows:
        assert r["origin"]["city"] == "海口" or r["dest"]["city"] == "海口"
    # 每条都匹配 666 档位 + 日期
    for r in rows:
        assert "666" in r["product"].split("/")
        assert sediment.matches_date(r, "2026-10-10")
    # 校验 2026-10-10 确实是周六
    import datetime
    assert datetime.date(2026, 10, 10).isoweekday() == 6


def test_query_tier_date_block():
    """档位×日期屏蔽：666 在十一屏蔽区间内查不到航班；2666/不限档不受影响。"""
    # 666 + 10-03（十一屏蔽内）→ 空
    assert sediment.query(city="海口", product="666", date_str="2026-10-03") == []
    # 666 + 10-10（屏蔽外）→ 有航班
    assert sediment.query(city="海口", product="666", date_str="2026-10-10")
    # 2666 + 10-03 → 有航班（2666 不受国庆限制）
    assert sediment.query(city="海口", product="2666", date_str="2026-10-03")
    # 666/2666 + 10-03 → 空（任一档被屏蔽即空，与前端日期池口径一致）
    assert sediment.query(city="海口", product="666/2666", date_str="2026-10-03") == []
    # 不限档位 + 10-03 → 有航班（屏蔽只看指定档位）
    assert sediment.query(city="海口", date_str="2026-10-03")
    # 区间完全落在屏蔽内 → 空；部分重叠 → 保留（前端再按具体日期收窄）
    assert sediment.query(city="海口", product="666", date_start="2026-10-01", date_end="2026-10-05") == []
    assert sediment.query(city="海口", product="666", date_start="2026-10-05", date_end="2026-10-15")


def test_meta_includes_tier_block_rules():
    """meta() 下发 tier_block_rules 字段（前端日期选择事实源）。"""
    m = sediment.meta()
    rules = m["tier_block_rules"]
    assert "source" in rules and "notes" in rules and "tiers" in rules
    assert [b for b in rules["tiers"]["666"]["blocks"]].count(["2026-09-30", "2026-10-09"]) == 1


def test_query_from_to_direction():
    # 海口出发 vs 到达 应互斥（用屏蔽区间外的周六，避免档位×日期屏蔽导致全空）
    depart = sediment.query(city="海口", product="666", date_str="2026-10-10", direction="depart")
    arrive = sediment.query(city="海口", product="666", date_str="2026-10-10", direction="arrive")
    both = sediment.query(city="海口", product="666", date_str="2026-10-10", direction="both")
    assert len(depart) + len(arrive) == len(both)
    for r in depart:
        assert r["origin"]["city"] == "海口"
    for r in arrive:
        assert r["dest"]["city"] == "海口"
    # from/to 精确过滤
    rows = sediment.query(from_city="海口", to_city="深圳")
    assert rows and all(r["origin"]["city"] == "海口" and r["dest"]["city"] == "深圳" for r in rows)


def test_query_accepts_iata_for_from_to():
    """出发/到达支持 IATA 三字码 / 机场名。"""
    rows = sediment.query(from_city="HAK", to_city="ZUH", product="666")
    assert rows
    for r in rows:
        assert r["origin"]["iata"] == "HAK" and r["dest"]["iata"] == "ZUH"
    # 机场名
    rows2 = sediment.query(from_city="海口美兰", product="2666")
    assert rows2 and all(r["origin"]["city"] == "海口" for r in rows2)


def test_query_flight_no_filter():
    rows = sediment.query(from_city="海口", flight_no="JD", limit=500)
    assert rows and all(r["flight_no"].startswith("JD") for r in rows)


def test_query_product_2666_does_not_include_666_only():
    rows = sediment.query(product="2666", limit=2000)
    assert rows
    for r in rows:
        assert "2666" in r["product"].split("/")


def test_meta_shape():
    m = sediment.meta()
    assert m["count"] == len(sediment.load_records())
    assert m["version"] and m["version"]["count"] == 1733
    assert m["count"] > m["version"]["count"]
    assert "city_options" in m and len(m["city_options"]) > 0
    assert set(m["product_dist"].keys()) <= {"666", "2666", "666/2666"}
    assert "海口" in "".join(m["city_options"])
    assert m["source_dist"].get("plus_winter_2026", 0) >= 1400


def test_same_flight_keeps_each_schedule():
    """同一航班号排在一起，但不同时刻和日期段保持原样，不合成一条。

    夏秋尾在 flights_normalized；冬春只在 plus_winter。周三命中的是 PLUS 原有拆行，
    官网主班是一二四五六那条。
    """
    rows = sediment.query(from_city="深圳", to_city="北京", flight_no="HU7702")
    assert [row["dep_time"] for row in rows] == ["07:10", "07:30", "07:30"]
    assert rows[0]["source"] != "plus_winter_2026"
    assert rows[0]["arr_time"] == "10:15"
    assert rows[0]["days"] == [1, 2, 3, 4, 5, 6, 7]
    assert rows[0]["effective_dates"] == [["2026-09-02", "2026-10-24"]]
    assert rows[1]["source"] == "plus_winter_2026"
    assert rows[1]["days"] == [3, 7]
    assert rows[1]["effective_dates"] == [["2026-10-25", "2027-03-24"]]
    assert rows[2]["source"] == "plus_winter_2026"
    assert rows[2]["arr_time"] == "10:40"
    assert rows[2]["days"] == [1, 2, 4, 5, 6]
    assert rows[2]["effective_dates"] == [["2026-10-26", "2027-03-27"]]
    winter = sediment.query(from_city="深圳", to_city="北京", flight_no="HU7702", date_str="2026-11-04")
    assert len(winter) == 1
    assert winter[0]["source"] == "plus_winter_2026"
    assert winter[0]["days"] == [3, 7]
    monday = sediment.query(from_city="深圳", to_city="北京", flight_no="HU7702", date_str="2026-11-02")
    assert len(monday) == 1
    assert monday[0]["source"] == "plus_winter_2026"
    assert monday[0]["dep_time"] == "07:30"
    assert monday[0]["days"] == [1, 2, 4, 5, 6]


def test_szx_winter_official_schedule():
    """深圳冬春只在 plus_winter，时刻按官网 2026-10-26；主表只留夏秋尾。"""
    def one(origin, dest, flight_no, day):
        rows = sediment.query(from_city=origin, to_city=dest, flight_no=flight_no, date_str=day)
        assert len(rows) == 1, (flight_no, dest, day, [(r["dep_time"], r["days"], r["source"]) for r in rows])
        assert rows[0]["source"] == "plus_winter_2026"
        return rows[0]

    y87903 = one("SZX", "TNA", "Y87903", "2026-10-26")
    assert y87903["dep_time"] == "06:25" and y87903["arr_time"] == "09:00"
    assert y87903["days"] == [1, 2, 3, 4, 5, 6, 7]
    assert y87903["effective_dates"] == [["2026-10-25", "2027-03-27"]]
    assert y87903["product"] == "666/2666"
    assert sediment.query(from_city="SZX", to_city="TNA", flight_no="Y87525", date_str="2026-10-26") == []
    summer_tna = sediment.query(from_city="SZX", to_city="TNA", flight_no="Y87525", date_str="2026-10-24")
    assert summer_tna and summer_tna[0]["source"] != "plus_winter_2026"

    y87913 = one("SZX", "HSN", "Y87913", "2026-10-26")
    assert (y87913["dep_time"], y87913["arr_time"]) == ("07:40", "09:40")
    assert y87913["days"] == [1, 3, 5, 7]
    assert y87913["effective_dates"] == [["2026-10-25", "2027-03-26"]]
    assert sediment.query(from_city="SZX", to_city="HSN", flight_no="Y87913", date_str="2026-10-25")
    assert sediment.query(from_city="SZX", to_city="HSN", flight_no="Y87913", date_str="2026-10-27") == []

    wuh = one("SZX", "WUH", "HU7779", "2026-10-26")
    assert (wuh["dep_time"], wuh["arr_time"]) == ("07:05", "09:00")
    assert wuh["days"] == [1, 3, 5, 7]
    assert wuh["effective_dates"] == [["2026-10-25", "2026-12-23"]]
    she = one("SZX", "SHE", "HU7779", "2026-10-26")
    assert (she["dep_time"], she["arr_time"]) == ("07:05", "12:40")
    assert she["effective_dates"] == [["2026-10-25", "2026-12-23"]]
    float_wuh = one("SZX", "WUH", "HU7779", "2026-10-27")
    assert float_wuh["dep_time"] == "06:50" and float_wuh["days"] == [2, 4, 6]
    assert sediment.query(from_city="SZX", to_city="WUH", flight_no="HU7779", date_str="2026-12-28") == []

    tao = one("SZX", "TAO", "HU7763", "2026-10-26")
    assert (tao["dep_time"], tao["arr_time"]) == ("06:40", "10:05")
    assert tao["days"] == [1, 2, 3, 5, 6, 7]
    assert tao["effective_dates"] == [["2026-10-26", "2026-12-23"]]
    assert sediment.query(from_city="SZX", to_city="TAO", flight_no="HU7763", date_str="2026-10-29") == []
    assert sediment.query(from_city="SZX", to_city="LHW", flight_no="HU7763", date_str="2026-10-26") == []
    assert sediment.query(from_city="SZX", to_city="LHW", flight_no="HU7763", date_str="2026-10-24")
    lhw = one("SZX", "LHW", "HU7852", "2026-10-26")
    assert (lhw["dep_time"], lhw["arr_time"]) == ("07:45", "11:15")

    ytw = one("SZX", "YTW", "UQ2616", "2026-10-26")
    assert (ytw["dep_time"], ytw["arr_time"]) == ("06:55", "15:50")
    assert ytw["days"] == [1, 2, 3, 4, 5, 6, 7]
    assert ytw["effective_dates"] == [["2026-10-25", "2027-03-27"]]
    urc = one("SZX", "URC", "UQ2616", "2026-10-26")
    assert (urc["dep_time"], urc["arr_time"]) == ("06:55", "12:35")

    late_rows = sediment.query(from_city="SZX", to_city="PEK", flight_no="HU7716", date_str="2026-10-26")
    assert len(late_rows) == 1
    late = late_rows[0]
    assert late["source"] == "hna_booking"
    assert (late["dep_time"], late["arr_time"]) == ("21:10", "00:25")
    assert late["days"] == [1, 2, 3, 4, 5, 6, 7]
    assert late["effective_dates"] == [["2026-10-25", "2027-03-27"]]
    sunday = sediment.query(from_city="SZX", to_city="PEK", flight_no="HU7716", date_str="2026-10-25")
    assert len(sunday) == 1 and sunday[0]["dep_time"] == "21:10" and sunday[0]["source"] == "hna_booking"
    assert sediment.query(from_city="SZX", to_city="PEK", flight_no="HU7716", date_str="2026-10-24")[0]["dep_time"] == "20:10"


def test_blackxool_gap_rows_live_only_in_winter_table():
    """Blackxool 缺口补进行只在 plus_winter，主表不另写一份冬春时刻。"""
    gd = sediment.query(from_city="SWA", to_city="CKG", flight_no="PN6448", date_str="2026-10-27")
    assert len(gd) == 1
    assert gd[0]["source"] == "hna_booking"
    assert gd[0]["dep_time"] == "21:55" and gd[0]["arr_time"] == "00:30"
    assert gd[0]["days"] == [2, 4, 6]
    assert gd[0]["effective_dates"] == [["2026-10-27", "2026-12-17"]]
    assert "订票页" in gd[0]["notes"] and "未列 PN6448" in gd[0]["notes"]
    ret = sediment.query(from_city="TNA", to_city="SZX", flight_no="Y87584", date_str="2026-10-26")
    assert len(ret) == 1 and ret[0]["source"] == "blackxool_v1009"
    assert ret[0]["dep_time"] == "20:30"
    # 周二不飞一三五日
    assert sediment.query(from_city="TNA", to_city="SZX", flight_no="Y87584", date_str="2026-10-27") == []


def test_winter_routes_are_queryable():
    """冬春表按班期和适用日期可查，1 月日期落在 2027 而不是 2026。"""
    rows = sediment.query(from_city="阿勒泰", to_city="西安", date_str="2026-11-02", flight_no="9H8336")
    assert len(rows) == 1
    assert rows[0]["source"] == "plus_winter_2026"
    assert rows[0]["season"] == "2026冬春"
    assert rows[0]["effective_dates"] == [["2026-10-25", "2027-03-27"]]
    assert sediment.query(from_city="阿勒泰", to_city="西安", date_str="2026-10-10", flight_no="9H8336") == []
    january = sediment.query(from_city="亳州", to_city="南宁", date_str="2027-01-04", flight_no="GX8824")
    assert january and january[0]["effective_dates"] == [["2027-01-01", "2027-01-15"]]
    assert sediment.query(from_city="亳州", to_city="南宁", date_str="2026-01-04", flight_no="GX8824") == []


def test_city_codes_merged_with_sediment():
    """底表机场已并入 city_codes：丽江等底表城市可直接解析为三字码。"""
    code, tips = resolve_code("丽江")
    assert code == "LJG"
    # 三字码能显示中文标签
    assert "丽江" in code_to_city_label("LJG")
    # 原有基础城市仍正常
    assert resolve_code("深圳")[0] == "SZX"
    assert code_to_city_label("SZX") == "深圳宝安（SZX）"


def test_matches_date_in_range():
    """区间匹配：与 effective_dates 有交集且交集内有班期日即命中。"""
    rec = {"effective_dates": [["2026-09-01", "2026-10-24"]], "days": [1, 3, 5]}
    # 空区间不过滤
    assert sediment.matches_date_in_range(rec, "", "") is True
    # 2026-10-05 是周一（班期），区间命中
    import datetime
    assert datetime.date(2026, 10, 5).isoweekday() == 1
    assert sediment.matches_date_in_range(rec, "2026-10-03", "2026-10-10") is True
    # 区间完全在放票窗口外
    assert sediment.matches_date_in_range(rec, "2026-12-01", "2026-12-05") is False
    # 区间覆盖整周：只要班期非空必命中
    assert sediment.matches_date_in_range(rec, "2026-09-01", "2026-09-30") is True
    # 起点大于终点
    assert sediment.matches_date_in_range(rec, "2026-10-10", "2026-10-01") is False
    # 非法日期
    assert sediment.matches_date_in_range(rec, "not-a-date", "") is False


def test_query_date_range():
    """query 支持 date_start/date_end 区间（任意一天可飞即命中）。"""
    single = sediment.query(from_city="深圳", to_city="杭州", date_str="2026-10-15")
    ranged = sediment.query(from_city="深圳", to_city="杭州", date_start="2026-09-05", date_end="2026-09-12")
    assert single and ranged
    for r in ranged:
        assert any(
            a <= d <= b for a, b in (r.get("effective_dates") or []) for d in ("2026-09-05", "2026-09-12")
        )


def test_destination_heatmap_szx_winter_and_summer():
    """单程热力按出发地和日期列出目的地：冬春用 plus_winter，秋航季尾仍能看到主表目的地。"""
    winter = sediment.destination_heatmap(from_city="SZX", date_str="2026-10-26")
    assert winter["origin"]["city"] == "深圳" and winter["origin"]["iata"] == "SZX"
    assert winter["date_start"] == winter["date_end"] == "2026-10-26"
    assert winter["stats"]["destinations"] >= 20
    assert winter["stats"]["666"] >= 1 and winter["stats"]["2666"] >= 1
    tna = next(item for item in winter["destinations"] if item["city"] == "济南")
    assert tna["kind"] == "666"
    assert tna["by_date"] == [{
        "date": "2026-10-26",
        "flights": 1,
        "666": 1,
        "2666": 1,
        "flight_nos": ["Y87903"],
    }]
    assert tna["flights"] == 1 and tna["departures"] == 1
    summer = sediment.destination_heatmap(from_city="深圳", date_str="2026-10-12")
    assert any(item["city"] == "兴义" for item in summer["destinations"])
    assert all("Y87903" not in row["flight_nos"] for item in summer["destinations"] for row in item["by_date"])


def test_destination_heatmap_direction_flags():
    """相对出发地标出去程、回程：有去有回 / 只有去程 / 只有回程，回程班号不计入去程。"""
    data = sediment.destination_heatmap(from_city="SZX", date_str="2026-10-26")
    stats = data["stats"]
    assert stats["both"] + stats["outbound_only"] + stats["inbound_only"] == stats["destinations"]
    assert stats["both"] >= 1 and stats["outbound_only"] >= 1 and stats["inbound_only"] >= 1

    tna = next(item for item in data["destinations"] if item["city"] == "济南")
    assert tna["has_outbound"] is True and tna["has_inbound"] is True and tna["direction"] == "both"
    assert tna["inbound_flights"] >= 1 and tna["inbound_departures"] >= tna["inbound_flights"]
    assert "Y87904" in {sample["flight_no"] for sample in tna["inbound_samples"]}
    assert all("Y87904" not in row["flight_nos"] for row in tna["by_date"])

    zhoushan = next(item for item in data["destinations"] if item["city"] == "舟山")
    assert zhoushan["has_outbound"] is True and zhoushan["has_inbound"] is False
    assert zhoushan["direction"] == "out" and zhoushan["inbound_flights"] == 0 and zhoushan["inbound_departures"] == 0

    dalian = next(item for item in data["destinations"] if item["city"] == "大连")
    assert dalian["has_outbound"] is False and dalian["has_inbound"] is True and dalian["direction"] == "back"
    assert dalian["flights"] == 0 and dalian["departures"] == 0 and dalian["by_date"] == []
    assert dalian["iata"] == "DLC" and dalian["inbound_departures"] >= 1
    assert any(sample["flight_no"] == "HU7776" for sample in dalian["inbound_samples"])


def test_destination_heatmap_does_not_double_count_winter_overlap():
    """同一天秋航季和冬春表都有的航班只计一次。"""
    rows = sediment.query(from_city="济南", to_city="重庆", flight_no="HU717", date_str="2026-10-12", limit=10)
    assert len(rows) == 2
    assert {row.get("season") for row in rows} == {None, "2026冬春"}
    data = sediment.destination_heatmap(from_city="TNA", date_str="2026-10-12")
    ckg = next(item for item in data["destinations"] if item["city"] == "重庆")
    assert ckg["by_date"][0]["flight_nos"].count("HU717") == 1
    assert ckg["by_date"][0]["flights"] == len(set(ckg["by_date"][0]["flight_nos"]))


def test_destination_heatmap_date_range_tier_block_and_window():
    """区间按日展开；666 屏蔽日不计 666；未选日期给 30 天，超长区间截断。"""
    span = sediment.destination_heatmap(from_city="深圳", date_start="2026-10-24", date_end="2026-10-26")
    assert span["truncated"] is False and span["span_days"] == 3
    pek = next(item for item in span["destinations"] if item["city"] == "北京")
    assert [row["date"] for row in pek["by_date"]] == ["2026-10-24", "2026-10-25", "2026-10-26"]
    assert pek["departures"] == sum(row["flights"] for row in pek["by_date"])
    assert pek["flights"] <= pek["departures"]

    blocked = sediment.destination_heatmap(from_city="深圳", date_str="2026-10-05", product="666")
    assert blocked["destinations"] == []
    mixed = sediment.destination_heatmap(from_city="深圳", date_str="2026-10-05")
    assert mixed["destinations"]
    assert all(item["kind"] == "2666" for item in mixed["destinations"])
    assert all(row["666"] == 0 and row["2666"] >= 1 for item in mixed["destinations"] for row in item["by_date"])
    only = sediment.destination_heatmap(from_city="SZX", date_str="2026-10-26", product="666")
    assert only["destinations"] and all(item["kind"] == "666" for item in only["destinations"])

    import datetime
    opened = sediment.destination_heatmap(from_city="", today=datetime.date(2026, 10, 12))
    assert opened["unbounded"] is True
    assert opened["origin"]["iata"] == "SZX"
    assert opened["date_start"] == "2026-10-12" and opened["date_end"] == "2026-11-10"
    assert opened["span_days"] == 30
    long = sediment.destination_heatmap(from_city="SZX", date_start="2026-10-01", date_end="2027-03-01")
    assert long["truncated"] is True and long["span_days"] == 92 and long["date_end"] == "2026-12-31"

    with pytest.raises(ValueError):
        sediment.destination_heatmap(from_city="SZX", date_str="2026-13-01")
    with pytest.raises(ValueError):
        sediment.destination_heatmap(from_city="SZX", date_start="2026-11-02", date_end="2026-10-26")


def test_options_linkage():
    """出发/到达联动选项：以「当前可搜到的航线」两端城市为依据。"""
    # 深圳出发 → 到达下拉应有杭州（底表存在 SZX->HGH）
    opts = sediment.options(from_city="深圳")
    assert any(o.startswith("深圳（SZX）") for o in opts["from_options"])
    assert any(o.startswith("杭州（HGH）") for o in opts["to_options"])
    # 枚举格式含机场名（「城市（IATA）·机场」，机场名去「机场」后缀）
    szx = [o for o in opts["from_options"] if o.startswith("深圳（SZX）")]
    assert szx and "·" in szx[0] and "机场" not in szx[0].split("·", 1)[1]
    # 反向：到达杭州 → 出发下拉应有深圳
    opts2 = sediment.options(to_city="杭州")
    assert any(o.startswith("深圳（SZX）") for o in opts2["from_options"])
    assert any(o.startswith("杭州（HGH）") for o in opts2["to_options"])
    # 双向都选时，两端都收敛到该航线
    opts3 = sediment.options(from_city="深圳", to_city="杭州")
    assert all(o.startswith("深圳（SZX）") for o in opts3["from_options"])
    assert all(o.startswith("杭州（HGH）") for o in opts3["to_options"])
    # 档位过滤同样生效
    opts4 = sediment.options(from_city="深圳", to_city="杭州", product="2666")
    assert opts4["to_options"]  # 不抛错、非空即可（数据可能全 666 或双档）