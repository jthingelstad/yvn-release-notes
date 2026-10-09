#!/usr/bin/env python3
"""Print the monthly counts: sign-ups, unsubscribes, restarts, bounces,
complaints and account deletes, one row a month.

    scripts/tally.py

Counts only (TALLY#<YYYY-MM> in the table): no user ids, no addresses.
Unsubscribes matter most, since a stopped subscriber gets nothing from the
product (Jamie, 2026-10-08: "track how many folks do that"). Reads only.
Uses the AWS CLI, like scripts/read_notes.py.
"""

import json
import subprocess

TABLE = "yvn-release-notes"
NAMES = ["signups", "unsubscribes", "restarts", "bounces", "complaints", "deletes"]


def main():
    out = subprocess.run(
        ["aws", "dynamodb", "scan", "--table-name", TABLE, "--region", "us-east-1", "--output", "json",
         "--filter-expression", "begins_with(pk, :p)", "--expression-attribute-values", '{":p": {"S": "TALLY#"}}'],
        capture_output=True, text=True, check=True,
    ).stdout
    rows = {}
    for item in json.loads(out).get("Items", []):
        rows[item["pk"]["S"][len("TALLY#"):]] = {k: int(v["N"]) for k, v in item.items() if "N" in v}
    print("month    " + "  ".join(f"{n:>12}" for n in NAMES))
    for month in sorted(rows):
        print(f"{month}  " + "  ".join(f"{rows[month].get(n, 0):>12}" for n in NAMES))
    if not rows:
        print("(nothing counted yet)")


if __name__ == "__main__":
    main()
