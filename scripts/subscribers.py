#!/usr/bin/env python3
"""Print one row per subscriber: address, state, sign-up day, send time,
last email, last note, notes and reply rate. The dashboard's counts
(census.py) name nobody; this is the per-person view, kept out of AWS
and the web app (Jamie, 2026-10-09).

    scripts/subscribers.py

Reads only, keys and a few fields: never a note's text or a reply token. It
prints addresses, so the output stays on this Mac, never in a log, a
ticket or a commit. Uses the AWS CLI (the host's cloud-engineer identity),
like scripts/tally.py.
"""

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from release_notes.census import counts  # noqa: E402

TABLE = "yvn-release-notes"


def scan() -> list[dict]:
    out = subprocess.run(
        ["aws", "dynamodb", "scan", "--table-name", TABLE, "--region", "us-east-1", "--output", "json",
         "--filter-expression", "begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :d) OR begins_with(sk, :n))",
         "--projection-expression",
         "pk, sk, email, #st, stopped_reason, created_at, tz, send_time, last_sent_date, pause_from, pause_through, #src, #m[0].#k",
         "--expression-attribute-names", json.dumps({"#st": "status", "#src": "source", "#m": "media", "#k": "kind"}),
         "--expression-attribute-values", json.dumps({":u": {"S": "USER#"}, ":p": {"S": "PROFILE"}, ":d": {"S": "DAY#"}, ":n": {"S": "NOTE#"}})],
        capture_output=True, text=True, check=True,
    ).stdout
    # Strings, and `media` only as "there is some".
    return [{k: (v["S"] if "S" in v else True) for k, v in item.items()} for item in json.loads(out).get("Items", [])]


def main():
    now = datetime.now(timezone.utc)
    by_user: dict[str, list[dict]] = {}
    for item in scan():
        by_user.setdefault(item["pk"], []).append(item)
    rows = []
    for user_rows in by_user.values():
        p = next((r for r in user_rows if r["sk"] == "PROFILE"), None)
        if not p:
            continue
        c = counts(user_rows, now)
        state = "paused" if c["Paused"] else "active" if c["Subscribers"] else f"stopped ({p.get('stopped_reason', '?')})"
        noted = sorted(r["sk"].split("#")[1] for r in user_rows if r["sk"].startswith("NOTE#"))
        rate = c.get("ReplyRate30")
        rows.append([
            p.get("email", "?"),
            state + (" OVERDUE" if c["Overdue"] else ""),
            (p.get("created_at") or "")[:10],
            f"{p.get('send_time', '06:00')} {p.get('tz', '?')}",
            p.get("last_sent_date") or "-",
            noted[-1] if noted else "-",
            str(c["Notes"]),
            f"{rate:.0f}%" if rate is not None else "-",
        ])
    head = ["address", "state", "since", "sends at", "last email", "last note", "notes", "replied 30d"]
    rows.sort(key=lambda r: r[2])
    widths = [max(len(x) for x in col) for col in zip(head, *rows)]
    for r in [head, *rows]:
        print("  ".join(x.ljust(w) for x, w in zip(r, widths)).rstrip())
    print(f"\n{len(rows)} subscriber(s)")


if __name__ == "__main__":
    main()
