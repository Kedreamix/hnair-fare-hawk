"""daemon 查询分组：同一组往返挨着查，提醒里带另一段价格。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daemon import _companion_status, _companion_text, build_query_units  # noqa: E402

TODAY = "2026-10-11"


def _task(tid, frm, to, dates, flight, **extra):
    return {"id": tid, "from_code": frm, "to_code": to, "dates": dates, "flight_no": flight, "fare_type": "plus", **extra}


def _brief(units):
    return [[(r["date"], r["from_code"], r["to_code"]) for r in unit] for unit in units]


def _pair(role, day, flight):
    return {"role": role, "mate_date": day, "mate_flight": flight}


def test_round_trip_legs_grouped_and_ordered():
    tasks = [
        _task("a", "SZX", "TNA", ["2026-11-07", "2026-11-14"], "Y87903", round_pairs={
            "2026-11-07": _pair("out", "2026-11-08", "Y87904"),
            "2026-11-14": _pair("out", "2026-11-15", "Y87904"),
        }),
        _task("b", "TNA", "SZX", ["2026-11-08", "2026-11-15"], "Y87904", round_pairs={
            "2026-11-08": _pair("back", "2026-11-07", "Y87903"),
            "2026-11-15": _pair("back", "2026-11-14", "Y87903"),
        }),
        _task("c", "SZX", "PEK", ["2026-11-06"], "HU7716", round_pairs={
            "2026-11-06": _pair("out", "2026-11-08", "HU7715"),
        }),
        _task("d", "PEK", "SZX", ["2026-11-08"], "HU7715", round_pairs={
            "2026-11-08": _pair("back", "2026-11-06", "HU7716"),
        }),
    ]
    units = build_query_units(tasks, today=TODAY)
    assert _brief(units) == [
        [("2026-11-06", "SZX", "PEK"), ("2026-11-08", "PEK", "SZX")],
        [("2026-11-07", "SZX", "TNA"), ("2026-11-08", "TNA", "SZX")],
        [("2026-11-14", "SZX", "TNA"), ("2026-11-15", "TNA", "SZX")],
    ]


def test_same_route_date_requested_once_with_all_tasks():
    tasks = [
        _task("a", "SZX", "PEK", ["2026-11-07"], "HU7702"),
        _task("b", "SZX", "PEK", ["2026-11-07"], "HU7716"),
    ]
    units = build_query_units(tasks, today=TODAY)
    assert len(units) == 1 and len(units[0]) == 1
    assert [t["flight_no"] for t in units[0][0]["tasks"]] == ["HU7702", "HU7716"]


def test_disabled_date_and_far_dates_split():
    tasks = [
        _task("a", "SZX", "TNA", ["2026-11-07", "2026-11-14"], "Y87903", disabled_dates=["2026-11-14"]),
        _task("b", "TNA", "SZX", ["2026-11-20"], "Y87904"),
    ]
    assert _brief(build_query_units(tasks, today=TODAY)) == [
        [("2026-11-07", "SZX", "TNA")],
        [("2026-11-20", "TNA", "SZX")],
    ]


def test_companion_text_reports_other_leg():
    tasks = [
        _task("a", "SZX", "TNA", ["2026-11-07"], "Y87903", round_pairs={
            "2026-11-07": _pair("out", "2026-11-08", "Y87904"),
        }),
        _task("b", "TNA", "SZX", ["2026-11-08"], "Y87904", round_pairs={
            "2026-11-08": _pair("back", "2026-11-07", "Y87903"),
        }),
    ]
    unit = build_query_units(tasks, today=TODAY)[0]
    out_req, back_req = unit
    results = {
        ("SZX", "TNA", "2026-11-07"): {"fares": [{"flight": "Y87903", "price": 199, "seats": 3}]},
        ("TNA", "SZX", "2026-11-08"): {"fares": [{"flight": "Y87904", "price": 199, "seats": 2}]},
    }
    text = _companion_text(unit, out_req, results)
    assert text.startswith("回程 11/08 ")
    assert "Y87904 199 元" in text and "也达标" in text

    results[("TNA", "SZX", "2026-11-08")] = {"fares": []}
    assert "Y87904 暂无可兑票" in _companion_text(unit, out_req, results)
    assert _companion_text(unit, back_req, results).startswith("去程 11/07 ")


def test_companion_text_empty_for_one_way():
    unit = build_query_units([_task("a", "SZX", "TNA", ["2026-11-07"], "Y87903")], today=TODAY)[0]
    assert _companion_text(unit, unit[0], {}) == ""


def test_past_dates_skipped():
    tasks = [_task("a", "SZX", "PEK", ["2026-10-10", "2026-10-11"], "HU7716")]
    assert _brief(build_query_units(tasks, today=TODAY)) == [[("2026-10-11", "SZX", "PEK")]]


def test_beijing_pairs_stay_separate_from_unpaired_dates():
    """只把 round_pairs 写明的去程和回程放在一组，其余日期各自单查。"""
    outbound = _task(
        "out", "SZX", "PEK",
        ["2026-10-24", "2026-10-25", "2026-10-30", "2026-11-06", "2026-11-14"],
        "HU7716",
        round_pairs={
            "2026-10-24": _pair("out", "2026-10-25", "HU7715"),
            "2026-10-30": _pair("out", "2026-10-31", "HU7715"),
            "2026-11-06": _pair("out", "2026-11-07", "HU7715"),
            "2026-11-14": _pair("out", "2026-11-15", "HU7715"),
        },
    )
    inbound = _task(
        "back", "PEK", "SZX",
        ["2026-10-25", "2026-10-31", "2026-11-01", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-15"],
        "HU7715",
        round_pairs={
            "2026-10-25": _pair("back", "2026-10-24", "HU7716"),
            "2026-10-31": _pair("back", "2026-10-30", "HU7716"),
            "2026-11-07": _pair("back", "2026-11-06", "HU7716"),
            "2026-11-15": _pair("back", "2026-11-14", "HU7716"),
        },
    )
    other = _task("m", "PEK", "SZX", ["2026-10-25", "2026-10-26"], "HU7713")
    morning = _task("e", "SZX", "PEK", ["2026-10-31"], "HU7702")
    units = build_query_units([outbound, inbound, other, morning], today="2026-10-14")
    assert _brief(units) == [
        [("2026-10-24", "SZX", "PEK"), ("2026-10-25", "PEK", "SZX")],
        [("2026-10-25", "SZX", "PEK")],
        [("2026-10-26", "PEK", "SZX")],
        [("2026-10-30", "SZX", "PEK"), ("2026-10-31", "PEK", "SZX")],
        [("2026-10-31", "SZX", "PEK")],
        [("2026-11-01", "PEK", "SZX")],
        [("2026-11-06", "SZX", "PEK"), ("2026-11-07", "PEK", "SZX")],
        [("2026-11-08", "PEK", "SZX")],
        [("2026-11-09", "PEK", "SZX")],
        [("2026-11-14", "SZX", "PEK"), ("2026-11-15", "PEK", "SZX")],
    ]
    first = units[0]
    back_req = first[1]
    results = {
        ("SZX", "PEK", "2026-10-24"): {"fares": [{"flight": "HU7716", "price": 199, "seats": 2}]},
        ("PEK", "SZX", "2026-10-25"): {"fares": [{"flight": "HU7715", "price": 199, "seats": 2}]},
    }
    paired = next(task for task in back_req["tasks"] if task["flight_no"] == "HU7715")
    lone = next(task for task in back_req["tasks"] if task["flight_no"] == "HU7713")
    assert _companion_text(first, back_req, results, paired).startswith("去程 10/24 ")
    assert "HU7716 199 元" in _companion_text(first, back_req, results, paired)
    assert _companion_text(first, back_req, results, lone) == ""


def test_same_day_departed_flight_skipped_while_later_flight_kept():
    """当日已过起飞时刻的航班跳过查询，当日尚未起飞的航班与未来周次均正常保留。"""
    tasks = [
        _task("morning", "SZX", "PEK", ["2026-11-11", "2026-11-18"], "HU7702", dep_time="07:30"),
        _task("night", "SZX", "PEK", ["2026-11-11", "2026-11-18", "2026-12-26"], "HU7716", dep_time="21:10"),
    ]
    units = build_query_units(tasks, today="2026-11-11 12:00")
    by_date = {u[0]["date"]: [t["flight_no"] for t in u[0]["tasks"]] for u in units}
    # 11-11 当天 12:00 时，07:30 的 HU7702 已起飞不再查，21:10 的 HU7716 仍查；远期 11-18、12-26 全部正常查
    assert by_date == {
        "2026-11-11": ["HU7716"],
        "2026-11-18": ["HU7702", "HU7716"],
        "2026-12-26": ["HU7716"],
    }


def test_companion_status_tiered_round_trip():
    """往返配对分级判断：双边同时达标时 both_hit=True，单边达标时 both_hit=False，单程无配对时 has_pair=False。"""
    tasks = [
        _task("out", "SZX", "TNA", ["2026-11-14"], "Y87903", round_pairs={
            "2026-11-14": _pair("out", "2026-11-15", "Y87904"),
        }),
        _task("back", "TNA", "SZX", ["2026-11-15"], "Y87904", round_pairs={
            "2026-11-15": _pair("back", "2026-11-14", "Y87903"),
        }),
    ]
    unit = build_query_units(tasks, today=TODAY)[0]
    out_req, back_req = unit

    # 1) 双边都达标
    results_both = {
        ("SZX", "TNA", "2026-11-14"): {"fares": [{"flight": "Y87903", "price": 199, "seats": 3}]},
        ("TNA", "SZX", "2026-11-15"): {"fares": [{"flight": "Y87904", "price": 199, "seats": 2}]},
    }
    text, has_pair, both_hit = _companion_status(unit, out_req, results_both)
    assert has_pair is True and both_hit is True
    assert "也达标 ✅" in text

    # 2) 仅去程达标，回程无票
    results_single = {
        ("SZX", "TNA", "2026-11-14"): {"fares": [{"flight": "Y87903", "price": 199, "seats": 3}]},
        ("TNA", "SZX", "2026-11-15"): {"fares": []},
    }
    text2, has_pair2, both_hit2 = _companion_status(unit, out_req, results_single)
    assert has_pair2 is True and both_hit2 is False
    assert "暂无可兑票" in text2

    # 3) 普通单程任务
    single_unit = build_query_units([_task("s", "SZX", "TNA", ["2026-11-14"], "Y87903")], today=TODAY)[0]
    text3, has_pair3, both_hit3 = _companion_status(single_unit, single_unit[0], {})
    assert text3 == "" and has_pair3 is False and both_hit3 is False


def test_release_cutoff_tiers_released_and_unreleased_dates():
    """按抢票开放截止日（如 2026-12-31）分级：<= 截止日每轮必查，> 截止日按 should_probe 低频探测。"""
    tasks = [
        _task("a", "SZX", "HRB", ["2026-12-05", "2026-12-31", "2027-01-02", "2027-01-09"], "HU7763"),
    ]
    # 1) 未到探测时间（should_probe 返回 False）：<= 2026-12-31 的所有周次正常查询，2027-01-* 本轮跳过
    units_cool = build_query_units(
        tasks,
        today="2026-11-11",
        release_cutoff="2026-12-31",
        should_probe=lambda k: False,
    )
    assert _brief(units_cool) == [
        [("2026-12-05", "SZX", "HRB")],
        [("2026-12-31", "SZX", "HRB")],
    ]
    assert all(u[0]["unreleased_probe"] is False for u in units_cool)

    # 2) 到达探测时间（例如 2027-01-02 允许探测）：2027-01-02 带着 unreleased_probe=True 进入本轮
    units_probe = build_query_units(
        tasks,
        today="2026-11-11",
        release_cutoff="2026-12-31",
        should_probe=lambda k: "2027-01-02" in k,
    )
    assert _brief(units_probe) == [
        [("2026-12-05", "SZX", "HRB")],
        [("2026-12-31", "SZX", "HRB")],
        [("2027-01-02", "SZX", "HRB")],
    ]
    assert units_probe[0][0]["unreleased_probe"] is False
    assert units_probe[1][0]["unreleased_probe"] is False
    assert units_probe[2][0]["unreleased_probe"] is True


