#!/usr/bin/env python3
"""Copy photos and recordings out of a subscriber's emailed notes filed
before media.py, as inbound does for every reply since.

    scripts/extract_media.py EMAIL [--dry-run]

Finds notes with a raw message, attachments and no `media`, reads the raw
message, copies its photos and recordings to media/ and lists them on the
note. The note's write is conditional on `media` still missing. With
--dry-run it reads and counts but writes nothing.

Prints counts only, never note text, file names or keys. Uses the AWS CLI
(the host's cloud-engineer identity), like read_notes.py, so it runs with
nothing installed.
"""

import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from release_notes import media  # noqa: E402
from release_notes.parse import parse_message  # noqa: E402

TABLE = "yvn-release-notes"
BUCKET = "yvn-release-notes-mail-999153317627"


def aws(*args, binary=False):
    out = subprocess.run(["aws", *args, "--region", "us-east-1"], capture_output=True, check=True).stdout
    return out if binary else (json.loads(out) if out.strip() else {})


class CliS3:
    """The one call media.store makes, through the CLI."""

    def put_object(self, Bucket, Key, Body, ContentType, ContentDisposition):
        with tempfile.NamedTemporaryFile() as f:
            f.write(Body)
            f.flush()
            aws("s3api", "put-object", "--bucket", Bucket, "--key", Key, "--body", f.name,
                "--content-type", ContentType, "--content-disposition", ContentDisposition, "--output", "json")


def typed(entries: list[dict]) -> dict:
    def value(v):
        return {"N": str(v)} if isinstance(v, int) else {"S": str(v)}
    return {"L": [{"M": {k: value(v) for k, v in e.items()}} for e in entries]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    key = {"pk": {"S": f"EMAIL#{args.email.strip().lower()}"}, "sk": {"S": "EMAIL"}}
    found = aws("dynamodb", "get-item", "--table-name", TABLE, "--key", json.dumps(key), "--output", "json").get("Item")
    if not found:
        sys.exit("no subscriber with that address")
    user_id = found["user_id"]["S"]

    values = {":u": {"S": f"USER#{user_id}"}, ":n": {"S": "NOTE#"}}
    items = aws("dynamodb", "query", "--table-name", TABLE, "--key-condition-expression", "pk = :u AND begins_with(sk, :n)",
                "--expression-attribute-values", json.dumps(values), "--output", "json").get("Items", [])

    counts = {"notes": len(items), "with_attachments": 0, "already_done": 0, "notes_filled": 0, "files": 0, "nothing_to_show": 0}
    s3 = CliS3()
    for item in items:
        raw_key = item.get("raw_key", {}).get("S", "")
        if not raw_key.startswith("raw/") or not item.get("attachments", {}).get("L"):
            continue
        counts["with_attachments"] += 1
        if "media" in item:
            counts["already_done"] += 1
            continue
        msg = parse_message(aws("s3", "cp", f"s3://{BUCKET}/{raw_key}", "-", binary=True))
        files = media.found(msg)
        if not files:
            counts["nothing_to_show"] += 1
            continue
        _, day, note_id = item["sk"]["S"].split("#", 2)
        counts["notes_filled"] += 1
        counts["files"] += len(files)
        if args.dry_run:
            continue
        entries = media.store(s3, BUCKET, user_id, day, note_id, files)
        aws("dynamodb", "update-item", "--table-name", TABLE,
            "--key", json.dumps({"pk": item["pk"], "sk": item["sk"]}),
            "--update-expression", "SET media = :m",
            "--condition-expression", "attribute_not_exists(media)",
            "--expression-attribute-values", json.dumps({":m": typed(entries)}), "--output", "json")
    print(json.dumps({"dry_run": args.dry_run, **counts}))


if __name__ == "__main__":
    main()
