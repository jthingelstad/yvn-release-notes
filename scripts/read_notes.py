#!/usr/bin/env python3
"""Print a subscriber's release notes, one block per day. Phase 1 has no
reader; this is the reader.

    scripts/read_notes.py EMAIL [YYYY-MM-DD]

A day's release notes are all its replies, in the order they arrived
(release_notes/notes.py). Without a date, every day with a note. Reads only.
Uses the AWS CLI (the host's cloud-engineer identity), not boto3, so it runs
with nothing installed. It prints note text: run it for the subscriber's own
request or for Jamie's own notes, never to paste into a log or a ticket.
"""

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from release_notes.notes import combine  # noqa: E402

TABLE = "yvn-release-notes"


def ddb(*args) -> dict:
    out = subprocess.run(["aws", "dynamodb", *args, "--region", "us-east-1", "--output", "json"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else {}


def plain(item: dict) -> dict:
    # Only the string fields matter here.
    return {k: v["S"] for k, v in item.items() if "S" in v}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("day", nargs="?", type=date.fromisoformat)
    args = ap.parse_args()

    key = {"pk": {"S": f"EMAIL#{args.email.strip().lower()}"}, "sk": {"S": "EMAIL"}}
    found = ddb("get-item", "--table-name", TABLE, "--key", json.dumps(key)).get("Item")
    if not found:
        sys.exit("no subscriber with that address")
    user_id = found["user_id"]["S"]

    prefix = f"NOTE#{args.day.isoformat()}#" if args.day else "NOTE#"
    values = {":u": {"S": f"USER#{user_id}"}, ":n": {"S": prefix}}
    # The CLI follows LastEvaluatedKey itself.
    items = ddb("query", "--table-name", TABLE, "--key-condition-expression", "pk = :u AND begins_with(sk, :n)",
                "--expression-attribute-values", json.dumps(values)).get("Items", [])

    days = defaultdict(list)
    for item in map(plain, items):
        days[item["sk"].split("#")[1]].append(item)
    if not days:
        print("no notes")
    for day in sorted(days):
        notes = sorted(days[day], key=lambda n: (n.get("written_at") or n.get("received_at", ""), n["sk"]))
        replies = f"{len(notes)} replies" if len(notes) > 1 else "1 reply"
        print(f"{notes[0].get('version', '?')}  {day}  ({replies})\n")
        print(combine(notes) or "(no text)")
        print()


if __name__ == "__main__":
    main()
