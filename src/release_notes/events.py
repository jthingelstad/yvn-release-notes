"""SES delivery events: a hard bounce or a complaint stops a subscriber's
emails, so the account keeps sending only to people who want it.

The stack's configuration set publishes bounces, complaints, rejects,
rendering failures and delivery delays to its own topic, and only this
function reads it. SES's event carries the address, the subject (a sign-in
email's code) and the reply token, so it never goes anywhere else as is:
for the ops queue this function sends one line on the alarms topic with the
kind of event, the kind of email and the user id, nothing else.

A soft bounce (mailbox full, a server down) changes nothing; SES has
already retried it. A delay is routine and only logged. The person can
start the emails again in settings, which also takes the address off SES's
suppression list (web.unsuppress).

Python and Node share a thirty-day, account-owned SNS idempotency receipt.
The stop, profile-deletion proof, receipt and monthly tally commit together;
old/new subscription overlap cannot count twice. Ops publishing remains
at-least-once: a retry can send the same scrubbed notice, never raw mail.
"""

import json
import hashlib
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


def mail_kind(msg: dict) -> str:
    """'daily' for the daily email (it alone has List-Unsubscribe),
    otherwise 'account' (sign-in and delete codes, a late reply's notice)."""
    names = {h.get("name", "").lower() for h in msg.get("mail", {}).get("headers", [])}
    return "daily" if "list-unsubscribe" in names else "account"


def notice(msg: dict, users: list[str | None]) -> dict | None:
    """The ops queue's line for an event, or None for one not worth a line.
    No address, subject, header or token: kinds and user ids only."""
    kind = msg.get("eventType") or msg.get("notificationType") or "unknown"
    line = {"source": "yvn-release-notes", "event": kind, "mail": mail_kind(msg)}
    if kind == "Bounce":
        b = msg.get("bounce", {})
        line.update(bounce_type=b.get("bounceType"), bounce_subtype=b.get("bounceSubType"))
    elif kind == "Complaint":
        line.update(feedback=msg.get("complaint", {}).get("complaintFeedbackType"))
    elif kind == "DeliveryDelay":
        return None
    elif kind == "Reject":
        line.update(reason=msg.get("reject", {}).get("reason"))
    if users:
        line["users"] = users
    return line


def handler(event, context, *, store=None, sns=None, clock=time.time):
    if store is None:
        import boto3

        from .store import Store

        store = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
    now = int(clock())
    at = datetime.fromtimestamp(now, timezone.utc)
    for record in event.get("Records", []):
        try:
            msg = json.loads(record["Sns"]["Message"])
        except (KeyError, ValueError):
            log(event="mail-event", outcome="unreadable")
            continue
        reason, addresses = recipients(msg)
        users = []
        for raw in addresses:
            email = normal_email(parseaddr(raw)[1])
            user_id = store.user_for_email(email) if email else None
            users.append(user_id)
            if not user_id:
                # A sign-in email to an address with no account, most likely.
                log(event="mail-event", reason=reason, outcome="no-account")
                continue
            message_id = record["Sns"].get("MessageId")
            if not isinstance(message_id, str) or not message_id:
                # SNS always supplies one. An absent ID must never fall back
                # to the old, non-transactional stop/tally pair.
                raise ValueError("SNS MessageId required for account event")
            message_hash = hashlib.sha256(message_id.encode()).hexdigest()
            outcome = store.apply_mail_event(user_id, message_hash, reason, at.strftime("%Y-%m-%dT%H:%M:%SZ"), now)
            log(event="mail-event", reason=reason, outcome="stopped" if outcome == "applied" else outcome, user=user_id)
        line = notice(msg, users)
        if line is None:
            log(event="mail-event", kind=msg.get("eventType"), outcome="logged")
            continue
        if sns is None:
            import boto3

            sns = boto3.client("sns")
        sns.publish(TopicArn=os.environ["ALARM_TOPIC"], Subject="Release Notes mail event",
                    Message=json.dumps(line, separators=(",", ":")))
