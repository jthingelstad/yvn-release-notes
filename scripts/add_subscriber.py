#!/usr/bin/env python3
"""Add a subscriber by hand. Phase 1 has no sign-up; this is the sign-up.

    scripts/add_subscriber.py EMAIL YYYY-MM-DD [--tz America/Chicago] [--send-time 06:00]

Writes the PROFILE and EMAIL items in one transaction, so an address can only
be added once. Uses the AWS CLI (the host's cloud-engineer identity), not
boto3, so it runs with nothing installed.
"""

import argparse
import json
import subprocess
import uuid
from datetime import date
from zoneinfo import ZoneInfo

TABLE = "yvn-release-notes"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("email")
    ap.add_argument("birthday", type=date.fromisoformat)
    ap.add_argument("--tz", default="America/Chicago")
    ap.add_argument("--send-time", default="06:00")
    args = ap.parse_args()

    ZoneInfo(args.tz)  # fail now on a bad zone, not at send time
    hh, mm = (int(x) for x in args.send_time.split(":"))
    assert 0 <= hh < 24 and mm in (0, 15, 30, 45), "send time must be on a quarter hour"
    assert args.birthday <= date.today(), "birthday is in the future"

    email = args.email.strip().lower()
    user_id = uuid.uuid4().hex
    now = subprocess.run(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], capture_output=True, text=True).stdout.strip()
    items = [
        {
            "Put": {
                "TableName": TABLE,
                "Item": {
                    "pk": {"S": f"EMAIL#{email}"},
                    "sk": {"S": "EMAIL"},
                    "user_id": {"S": user_id},
                },
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        },
        {
            "Put": {
                "TableName": TABLE,
                "Item": {
                    "pk": {"S": f"USER#{user_id}"},
                    "sk": {"S": "PROFILE"},
                    "email": {"S": email},
                    "birthday": {"S": args.birthday.isoformat()},
                    "tz": {"S": args.tz},
                    "send_time": {"S": f"{hh:02d}:{mm:02d}"},
                    "status": {"S": "active"},
                    "created_at": {"S": now},
                },
                "ConditionExpression": "attribute_not_exists(pk)",
            }
        },
    ]
    subprocess.run(
        ["aws", "dynamodb", "transact-write-items", "--region", "us-east-1", "--transact-items", json.dumps(items)],
        check=True,
    )
    print(f"added user {user_id}")


if __name__ == "__main__":
    main()
