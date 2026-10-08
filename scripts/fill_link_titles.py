#!/usr/bin/env python3
"""Name the links in a subscriber's notes written before links.py.

    scripts/fill_link_titles.py EMAIL [--dry-run]

A note written since has its `links` already; this finds the ones with a web
address and no `links`, fetches titles once with the same guarded fetch
(links.collect), and saves them. The write is conditional on the text being
unchanged and `links` still missing, so it never races an edit. With
--dry-run it fetches but writes nothing.

Prints counts only, never note text or addresses. Uses the AWS CLI (the
host's cloud-engineer identity), like read_notes.py, so it runs with nothing
installed. Emailed notes are named from their plain text only; the words a
mail app linked are read from new mail, not re-parsed from the raw message.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from release_notes import links  # noqa: E402

TABLE = "yvn-release-notes"


def ddb(*args) -> dict:
    out = subprocess.run(["aws", "dynamodb", *args, "--region", "us-east-1", "--output", "json"],
                         capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else {}


def typed(found: list[dict]) -> dict:
    """links as a DynamoDB list of maps."""
    def value(v):
        return {"BOOL": v} if isinstance(v, bool) else {"S": str(v)}
    return {"L": [{"M": {k: value(v) for k, v in link.items()}} for link in found]}


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

    values = {":u": {"S": f"USER#{user_id}"}, ":n": {"S": "NOTE#"}}
    items = ddb("query", "--table-name", TABLE, "--key-condition-expression", "pk = :u AND begins_with(sk, :n)",
                "--expression-attribute-values", json.dumps(values)).get("Items", [])

    counts = {"notes": len(items), "with_addresses": 0, "already_named": 0, "named": 0, "no_title": 0, "changed": 0}
    for item in items:
        text = item.get("text", {}).get("S", "")
        if not links.urls(text):
            continue
        counts["with_addresses"] += 1
        if "links" in item:
            counts["already_named"] += 1
            continue
        got = links.collect(text)
        if not got:
            counts["no_title"] += 1
            continue
        counts["named"] += 1
        if args.dry_run:
            continue
        try:
            ddb("update-item", "--table-name", TABLE,
                "--key", json.dumps({"pk": item["pk"], "sk": item["sk"]}),
                "--update-expression", "SET links = :l",
                "--condition-expression", "#t = :t AND attribute_not_exists(links)",
                "--expression-attribute-names", json.dumps({"#t": "text"}),
                "--expression-attribute-values", json.dumps({":l": typed(got), ":t": {"S": text}}))
        except subprocess.CalledProcessError as e:
            if "ConditionalCheckFailed" not in (e.stderr or ""):
                raise
            counts["named"] -= 1
            counts["changed"] += 1
    print(json.dumps({"dry_run": args.dry_run, **counts}))


if __name__ == "__main__":
    main()
