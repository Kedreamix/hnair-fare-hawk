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


def test_round_trip_legs_grouped_and_ordered():
    tasks = [
        _task("a", "SZX", "TNA", ["2026-11-07", "2026-11-14"], "Y87903"),
        _task("b", "TNA", "SZX", ["2026-11-08", "2026-11-15"], "Y87904"),
        _task("c", "SZX", "PEK", ["2026-11-06"], "HU7716"),
        _task("d", "PEK", "SZX", ["2026-11-08"], "HU7715"),
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
        _task("a", "SZX", "TNA", ["2026-11-07"], "Y87903"),
        _task("b", "TNA", "SZX", ["2026-11-08"], "Y87904"),
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
