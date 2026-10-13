"""daemon 查询分组：同一组往返挨着查，提醒里带另一段价格。"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from daemon import _companion_text, build_query_units  # noqa: E402

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
