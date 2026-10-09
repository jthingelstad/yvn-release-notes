#!/usr/bin/env python3
"""Plan a Day One import for a subscriber, and write nothing (Jamie, 2026-10-09).

    scripts/import_dayone.py EMAIL ZIP [ZIP ...] [--plan-out DIR] [--weather-sample N]

Reads the subscriber (their profile, the keys of their notes, weather and
pauses), plans every note the export would make (dayone.py) and prints what
the import would do as counts: notes, days, files and bytes by kind, tags,
where places came from, days that already have notes or weather, notes this
export already made, the streak before and after, and the largest item
against DynamoDB's limit. It has no write path: importing is a later step,
after Jamie has seen this.

Each zip is one journal; give them all at once, since journals share days
and the streak and each day's weather are worked out across them.
--plan-out writes each plan as JSON, note text included, so give it a
folder outside the repository (a scratchpad). --weather-sample asks Open-Meteo
for that many of the days, to see the archive answers for the places.

Prints counts only, never note text, tags or places. Uses the AWS CLI (the
host's cloud-engineer identity), like fill_weather.py, so it runs with
nothing installed.
"""

import argparse
import json
import random
import subprocess
import sys
import time
from collections import Counter
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
from release_notes import dayone, tags, weather  # noqa: E402
from release_notes.streak import compute_streak, pause_days  # noqa: E402

TABLE = "yvn-release-notes"
ITEM_LIMIT = 400 * 1024  # DynamoDB's largest item, in bytes


def ddb(*args) -> dict:
    out = subprocess.run(["aws", "dynamodb", *args, "--region", "us-east-1", "--output", "json"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else {}


def untyped(v: dict):
    if "S" in v:
        return v["S"]
    if "N" in v:
        return Decimal(v["N"])
    return None


def subscriber(email: str) -> tuple[str, dict]:
    key = {"pk": {"S": f"EMAIL#{email.strip().lower()}"}, "sk": {"S": "EMAIL"}}
    found = ddb("get-item", "--table-name", TABLE, "--key", json.dumps(key)).get("Item")
    if not found:
        sys.exit("no subscriber with that address")
    user_id = found["user_id"]["S"]
    item = ddb("get-item", "--table-name", TABLE,
               "--key", json.dumps({"pk": {"S": f"USER#{user_id}"}, "sk": {"S": "PROFILE"}}))["Item"]
    return user_id, {k: untyped(v) for k, v in item.items()}


def items(user_id: str, prefix: str, projection: str = "sk") -> list[dict]:
    """Every item under a prefix, these attributes only (the CLI pages)."""
    values = {":u": {"S": f"USER#{user_id}"}, ":p": {"S": prefix}}
    names = {f"#{a}": a for a in projection.split(",")}
    return ddb("query", "--table-name", TABLE, "--key-condition-expression", "pk = :u AND begins_with(sk, :p)",
               "--projection-expression", ",".join(names), "--expression-attribute-names", json.dumps(names),
               "--expression-attribute-values", json.dumps(values)).get("Items", [])


def stored_size(item: dict) -> int:
    """About what DynamoDB counts: the item's names and values as JSON."""
    media = [{k: v for k, v in m.items() if k != "from"} for m in item.get("media", [])]
    return len(json.dumps({**item, "media": media}, default=str).encode())


def streak_of(days: set[str], today: date, paused: set) -> dict:
    s = compute_streak({date.fromisoformat(d) for d in days}, today, paused)
    return {"current": s.current, "longest": s.longest}


def summary(plan: dict) -> dict:
    """One export's counts: nothing in them is note text, a tag or a place."""
    notes = plan["notes"]
    days = {n["date"] for n in notes}
    files, file_bytes, tagged, tag_set, extra_tags = Counter(), Counter(), 0, set(), 0
    for n in notes:
        for m in n["item"].get("media", []):
            files[m["kind"]] += 1
            file_bytes[m["kind"]] += m["size"]
        found = n["item"].get("tags", [])
        tagged += bool(found)
        tag_set.update(found)
        # Hashtags in the entry's own text, beyond its Day One tags.
        extra_tags += bool(set(found) - set(tags.found(n["tag_line"])))
    biggest = max((stored_size(n["item"]) for n in notes), default=0)
    raw_bytes = sum(len(json.dumps(n["original"], ensure_ascii=False).encode()) for n in notes)
    places = [n["item"]["place"] for n in notes if n["item"].get("place")]
    photo_spots = sum(1 for n in notes for m in n["item"].get("media", []) if m.get("place"))
    urls = {u for n in notes for u in n["urls"]}
    named = {u for n in notes for u in n["named"]}
    return {
        "main_journal": plan["journal"] == dayone.MAIN_JOURNAL,
        "notes": len(notes),
        "skipped": dict(Counter(s["why"] for s in plan["skipped"])),
        "days": len(days),
        "first_day": min(days, default=None),
        "last_day": max(days, default=None),
        "busiest_day_notes": max(Counter(n["date"] for n in notes).values(), default=0),
        "text": plan["counts"],
        "files": dict(files),
        "file_mb": {k: round(v / 1e6, 1) for k, v in file_bytes.items()},
        "missing_files": plan["missing_files"],
        "tags": {"notes_tagged": tagged, "distinct": len(tag_set), "notes_with_hashtags_in_text": extra_tags},
        "place_from": plan["place_from"],
        "places": {k: sum(1 for p in places if k in p) for k in ("label", "venue", "address", "city", "accuracy_m")},
        "photos_with_their_own_spot": photo_spots,
        "originals_kb": round(raw_bytes / 1024),
        "zones_renamed": sum(1 for n in notes if n["zone_was"] in dayone.ZONES),
        "all_day": sum(n["all_day"] for n in notes),
        "starred": sum(n["starred"] for n in notes),
        "links": {"urls": len(urls), "named_by_writer": len(named & urls), "need_titles": len(urls - named)},
        "largest_item_kb": round(biggest / 1024, 1),
        "largest_item_fits": biggest < ITEM_LIMIT,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("zips", nargs="+", metavar="ZIP", help="Day One exports, one journal each")
    ap.add_argument("--plan-out", help="a folder for each plan as JSON (note text included): not in the repo")
    ap.add_argument("--weather-sample", type=int, default=0, metavar="N")
    args = ap.parse_args()
    if args.plan_out and Path(args.plan_out).resolve().is_relative_to(ROOT):
        sys.exit("--plan-out holds note text: write it outside the repository")

    user_id, profile = subscriber(args.email)
    today = datetime.now(ZoneInfo(profile["tz"])).date()
    plans, journals = [], []
    for path in args.zips:
        journal, entries, names = dayone.read(path)
        plan = dayone.plan(journal, entries, names, profile, user_id)
        plans.append(plan)
        journals.append({"entries": len(entries), **summary(plan)})
        if args.plan_out:
            Path(args.plan_out, f"plan-{tags.slug(journal)}.json").write_text(
                json.dumps(plan, indent=1, default=str))

    notes = [n for p in plans for n in p["notes"]]
    import_days = {n["date"] for n in notes}
    ids = Counter(n["id"] for n in notes)
    weather_days = dayone.weather_days(notes)

    live = items(user_id, "NOTE#")
    live_days = {i["sk"]["S"].split("#")[1] for i in live}
    live_ids = {i["sk"]["S"].split("#", 2)[2] for i in live}
    kept_weather = {i["sk"]["S"].split("#")[1] for i in items(user_id, "WEATHER#")}
    pauses = [(i["sk"]["S"][6:], untyped(i["through"])) for i in items(user_id, "PAUSE#", "sk,through")]
    paused = pause_days(pauses, today)
    per_day = Counter(n["date"] for n in notes)

    report = {
        "dry_run": True,
        "journals": journals,
        "all": {
            "notes": len(notes),
            "days": len(import_days),
            "days_in_more_than_one_journal": sum(
                1 for d in import_days if sum(d in {n["date"] for n in p["notes"]} for p in plans) > 1),
            "busiest_day_notes": max(per_day.values(), default=0),
            "same_id_twice": sum(1 for c in ids.values() if c > 1),
        },
        "live": {"notes": len(live), "days": len(live_days), "pauses": len(pauses)},
        "overlap": {"days_with_live_notes": len(import_days & live_days),
                    "notes_already_imported": len(set(ids) & live_ids),
                    "days_with_weather_kept": len(import_days & kept_weather),
                    "days_after_today": sum(1 for d in import_days if d > today.isoformat())},
        "weather": {"days_to_fetch": len(set(weather_days) - kept_weather - {today.isoformat()}),
                    "days_without_place": len(import_days - set(weather_days))},
        "streak_before": streak_of(live_days, today, paused),
        "streak_after": streak_of(live_days | import_days, today, paused),
        "lifetime": {"notes_after": len(live) + len(notes), "days_after": len(live_days | import_days)},
    }

    if args.weather_sample:
        days = sorted(d for d in set(weather_days) - kept_weather if d < today.isoformat())
        sample = random.Random(0).sample(days, min(args.weather_sample, len(days)))
        answered = 0
        for d in sample:
            time.sleep(0.2)  # well inside Open-Meteo's free limits
            try:
                answered += bool(weather.history(weather_days[d], date.fromisoformat(d), today))
            except Exception:
                pass
        report["weather"]["sampled"] = len(sample)
        report["weather"]["answered"] = answered

    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main()
