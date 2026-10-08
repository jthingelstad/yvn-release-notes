#!/usr/bin/env python3
"""Keep the weather for a subscriber's days with notes written before weather.py.

    scripts/fill_weather.py EMAIL [--dry-run]

Since weather.py, the morning email keeps yesterday's weather and a note
written for an earlier day fetches that day's. This finds the finished days
that have notes and no weather, asks Open-Meteo for each (weather.history,
where the subscriber's city is now) and keeps it. Each write is conditional
on the day still having none. With --dry-run it fetches but writes nothing.

Prints counts only, never note text or the city. Uses the AWS CLI (the host's
cloud-engineer identity), like read_notes.py, so it runs with nothing
installed.
"""

import argparse
import json
import subprocess
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from release_notes import weather  # noqa: E402

TABLE = "yvn-release-notes"


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


def typed(fields: dict) -> dict:
    return {k: {"N": str(v)} if isinstance(v, (int, float, Decimal)) else {"S": str(v)} for k, v in fields.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = {"pk": {"S": f"EMAIL#{args.email.strip().lower()}"}, "sk": {"S": "EMAIL"}}
    found = ddb("get-item", "--table-name", TABLE, "--key", json.dumps(key)).get("Item")
    if not found:
        sys.exit("no subscriber with that address")
    user_id = found["user_id"]["S"]
    profile = ddb("get-item", "--table-name", TABLE,
                  "--key", json.dumps({"pk": {"S": f"USER#{user_id}"}, "sk": {"S": "PROFILE"}}))["Item"]
    place = weather.place_of({k: untyped(v) for k, v in profile.items()})
    if not place:
        sys.exit("that subscriber has no city")
    today = datetime.now(ZoneInfo(place["tz"])).date()

    def keys(prefix):
        values = {":u": {"S": f"USER#{user_id}"}, ":p": {"S": prefix}}
        items = ddb("query", "--table-name", TABLE, "--key-condition-expression", "pk = :u AND begins_with(sk, :p)",
                    "--projection-expression", "sk", "--expression-attribute-values", json.dumps(values)).get("Items", [])
        return {i["sk"]["S"].split("#")[1] for i in items}

    days = sorted(d for d in keys("NOTE#") if d < today.isoformat())
    have = keys("WEATHER#")
    counts = {"days_with_notes": len(days), "already_kept": 0, "kept": 0, "no_answer": 0, "changed": 0}
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for day in days:
        if day in have:
            counts["already_kept"] += 1
            continue
        time.sleep(0.2)  # well inside Open-Meteo's free limits
        try:
            reading = weather.history(place, datetime.fromisoformat(day).date(), today)
        except Exception:
            reading = None
        if not reading:
            counts["no_answer"] += 1
            continue
        counts["kept"] += 1
        if args.dry_run:
            continue
        item = {"pk": {"S": f"USER#{user_id}"}, "sk": {"S": f"WEATHER#{day}"},
                **typed(weather.record(reading, place, stamp))}
        try:
            ddb("put-item", "--table-name", TABLE, "--item", json.dumps(item),
                "--condition-expression", "attribute_not_exists(sk)")
        except subprocess.CalledProcessError as e:
            if "ConditionalCheckFailed" not in (e.stderr or ""):
                raise
            counts["kept"] -= 1
            counts["changed"] += 1
    print(json.dumps({"dry_run": args.dry_run, **counts}))


if __name__ == "__main__":
    main()
