"""把外部到达时刻 CSV 填进 2026 冬春 PLUS 表。

匹配键：flight_no + origin IATA + dest IATA + 班期 + dep_time。
班期允许逗号、中文逗号、空格，以及「1357」这种连写；比较前按数字排序。
起飞时刻统一成 HH:MM。

写入规则：
- 本季确认且 arr_time 非空：写入记录的 arr_time。跨天（CSV「跨天(+1)」为 +1）
  只保存 HH:MM，与表现有跨天记录（例如 20:45→00:05）相同，不另加字段。
- 上季参考 / 夏秋参考：不写 arr_time，把候选时刻、来源 URL、季节标签写入 notes。
- 未补：不改。

同一航班若只因生效日期拆成多行（班期和起飞时刻相同），每行都按同一 CSV 行更新。
不改班期、机场、生效日期、product、product_conflict、source、season。
"""
from __future__ import annotations

import argparse
import csv
import json
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_JSON = ROOT / "data" / "sediment" / "plus_winter_2026.json"

CONFIRMED = "本季确认"
REFERENCE = {"上季参考", "夏秋参考"}
UNFILLED = "未补"


def norm_time(value: str) -> str:
    text = str(value or "").strip()
    if not text or ":" not in text:
        return text
    hour, minute = text.split(":", 1)
    return f"{int(hour):02d}:{minute}"


def norm_days(value) -> tuple[int, ...]:
    if isinstance(value, list):
        return tuple(sorted(int(part) for part in value))
    text = str(value or "").strip().replace("，", ",").replace("、", ",").replace(" ", "")
    if not text:
        return tuple()
    parts = [part for part in text.split(",") if part] if "," in text else list(text)
    return tuple(sorted(int(part) for part in parts))


def match_key(flight_no: str, origin: str, dest: str, days, dep_time: str) -> tuple:
    return (
        str(flight_no).strip().upper(),
        str(origin).strip().upper(),
        str(dest).strip().upper(),
        norm_days(days),
        norm_time(dep_time),
    )


def reference_note(row: dict) -> str:
    arrival = norm_time(row["arr_time"])
    if str(row.get("跨天(+1)") or "").strip() == "+1":
        arrival = f"{arrival}+1"
    label = str(row["置信度"]).strip()
    url = str(row["来源URL"]).strip()
    return f"{label}候选到达 {arrival}。来源 {url}。仅作备注，未写入 arr_time。"


def apply(payload: dict, rows: list[dict]) -> dict:
    records = payload["records"]
    index: dict[tuple, list[int]] = defaultdict(list)
    for i, rec in enumerate(records):
        key = match_key(
            rec["flight_no"],
            rec["origin"]["iata"],
            rec["dest"]["iata"],
            rec["days"],
            rec["dep_time"],
        )
        index[key].append(i)

    stats = Counter()
    unmatched = []
    conflicts = []
    touched_records = set()

    for line_no, row in enumerate(rows, start=2):
        confidence = str(row.get("置信度") or "").strip()
        key = match_key(
            row["flight_no"],
            row["origin_iata"],
            row["dest_iata"],
            row["days"],
            row["dep_time"],
        )
        hits = index.get(key) or []
        if not hits:
            stats["csv_unmatched"] += 1
            unmatched.append(
                {
                    "line": line_no,
                    "flight_no": row["flight_no"],
                    "origin": row["origin_iata"],
                    "dest": row["dest_iata"],
                    "days": row["days"],
                    "dep_time": row["dep_time"],
                    "confidence": confidence,
                }
            )
            continue

        stats["csv_matched"] += 1
        stats[f"csv_{confidence}"] += 1
        if len(hits) > 1:
            stats["csv_matched_split_dates"] += 1

        if confidence == UNFILLED:
            stats["records_left_unchanged_unfilled"] += len(hits)
            continue

        if confidence == CONFIRMED:
            arrival = norm_time(row.get("arr_time"))
            if not arrival:
                stats["confirmed_empty_arr_skipped"] += 1
                continue
            for i in hits:
                rec = records[i]
                current = str(rec.get("arr_time") or "").strip()
                if current and current != arrival:
                    stats["arr_conflicts"] += 1
                    conflicts.append(
                        {
                            "line": line_no,
                            "flight_no": rec["flight_no"],
                            "current": current,
                            "candidate": arrival,
                        }
                    )
                    continue
                if current == arrival:
                    stats["arr_already_set"] += 1
                    continue
                rec["arr_time"] = arrival
                stats["records_arr_time_written"] += 1
                touched_records.add(i)
            continue

        if confidence in REFERENCE:
            note = reference_note(row)
            for i in hits:
                rec = records[i]
                existing = rec.get("notes")
                if existing and note in str(existing):
                    stats["notes_already_present"] += 1
                    continue
                rec["notes"] = f"{existing.rstrip()} {note}" if existing else note
                stats["records_notes_written"] += 1
                stats[f"notes_{confidence}"] += 1
                touched_records.add(i)
            continue

        stats["csv_unknown_confidence"] += 1
        unmatched.append({"line": line_no, "confidence": confidence, "flight_no": row.get("flight_no")})

    if touched_records:
        payload["generated_at"] = date.today().isoformat()
    payload["count"] = len(records)
    stats["records_total"] = len(records)
    stats["records_arr_time_still_empty"] = sum(
        1 for rec in records if not str(rec.get("arr_time") or "").strip()
    )
    stats["records_arr_time_filled"] = stats["records_total"] - stats["records_arr_time_still_empty"]
    return {
        "stats": dict(stats),
        "unmatched": unmatched,
        "conflicts": conflicts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv_path", type=Path)
    parser.add_argument("--json", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    payload = json.loads(args.json.read_text(encoding="utf-8"))
    with args.csv_path.open(encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    report = apply(payload, rows)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if args.dry_run:
        return
    args.json.write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
