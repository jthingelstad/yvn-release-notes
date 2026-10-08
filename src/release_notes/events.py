"""SES delivery events: a hard bounce or a complaint stops a subscriber's
emails, so the account keeps sending only to people who want it.

The stack's configuration set publishes bounces and complaints (with the
other events, for the ops queue) to the alarms topic. This function is
subscribed to that topic with a filter on eventType, so it sees only those
two. A soft bounce (mailbox full, a server down) changes nothing; SES has
already retried it. The person can start the emails again in settings.
"""

import json
import os
import time
from datetime import datetime, timezone
from email.utils import parseaddr

from .auth import normal_email


def log(**fields):
    # User ids and outcomes. Never an address.
    print(json.dumps(fields, separators=(",", ":")))


def recipients(msg: dict) -> tuple[str | None, list[str]]:
    kind = msg.get("eventType") or msg.get("notificationType")
    if kind == "Bounce":
        bounce = msg.get("bounce", {})
        if bounce.get("bounceType") != "Permanent":
            return None, []
        return "bounce", [r.get("emailAddress", "") for r in bounce.get("bouncedRecipients", [])]
    if kind == "Complaint":
        return "complaint", [r.get("emailAddress", "") for r in msg.get("complaint", {}).get("complainedRecipients", [])]
    return None, []


def handler(event, context, *, store=None, clock=time.time):
    if store is None:
        import boto3

        from .store import Store

        store = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
    at = datetime.fromtimestamp(clock(), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    for record in event.get("Records", []):
        try:
            msg = json.loads(record["Sns"]["Message"])
        except (KeyError, ValueError):
            log(event="mail-event", outcome="unreadable")
            continue
        reason, addresses = recipients(msg)
        for raw in addresses:
            email = normal_email(parseaddr(raw)[1])
            user_id = store.user_for_email(email) if email else None
            if not user_id:
                # A sign-in email to an address with no account, most likely.
                log(event="mail-event", reason=reason, outcome="no-account")
                continue
            store.stop(user_id, reason, at)
            log(event="mail-event", reason=reason, outcome="stopped", user=user_id)
