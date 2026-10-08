"""The daily sender. EventBridge runs it on every quarter hour.

Each run sends to every active subscriber whose local send time has arrived
today and who has not had today's email yet. The window is three hours, so a
missed run catches up but an outage never sends a 3 a.m. email.

Invoke with {"dry_run": true} (and optionally {"now": "<ISO 8601 UTC>"}) to
see who would get what without writing or sending anything.
"""

import json
import os
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from .compose import build_message, new_token
from .store import Store, Subscriber
from .version import compute_version

WINDOW = timedelta(hours=3)

# Fail at cold start, not at someone's send time, if the runtime ever ships
# without a zone database (zoneinfo reads the system's; there is no tzdata pin).
ZoneInfo("America/Chicago")


def local_now(now_utc: datetime, tz: str) -> datetime:
    return now_utc.astimezone(ZoneInfo(tz))


def is_due(sub: Subscriber, now_local: datetime) -> bool:
    today = now_local.date().isoformat()
    if sub.last_sent_date and sub.last_sent_date >= today:
        return False
    hh, mm = (int(x) for x in sub.send_time.split(":"))
    start = datetime.combine(now_local.date(), time(hh, mm), tzinfo=now_local.tzinfo)
    end = min(start + WINDOW, datetime.combine(now_local.date() + timedelta(days=1), time(0), tzinfo=now_local.tzinfo))
    return start <= now_local < end


def log(**fields):
    # Ids and outcomes only. Addresses and note text never go to logs.
    print(json.dumps(fields, separators=(",", ":")))


def handler(event, context, *, store: Store | None = None, ses=None):
    event = event or {}
    dry_run = bool(event.get("dry_run"))
    now = datetime.fromisoformat(event["now"]) if event.get("now") else datetime.now(timezone.utc)
    if store is None:
        import boto3

        store = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
    if ses is None and not dry_run:
        import boto3

        ses = boto3.client("sesv2")

    results, failed = [], 0
    for sub in store.active_subscribers():
        here = local_now(now, sub.tz)
        day = here.date().isoformat()
        v = compute_version(sub.birthday, here.date())
        if not is_due(sub, here):
            continue
        if dry_run:
            results.append({"user": sub.user_id, "date": day, "version": str(v), "local": here.isoformat()})
            continue
        try:
            results.append(send_one(store, ses, sub, day, v, now))
        except Exception:
            # One bad address must not hold up everyone else. The run still
            # fails at the end so the Errors alarm sees it.
            failed += 1
    log(event="run", now=now.isoformat(), dry_run=dry_run, due=len(results) + failed, failed=failed)
    if failed:
        raise RuntimeError(f"{failed} send(s) failed")
    return {"dry_run": dry_run, "now": now.isoformat(), "results": results}


def send_one(store: Store, ses, sub: Subscriber, day: str, v, now: datetime) -> dict:
    previous = sub.last_sent_date
    if not store.claim_day(sub.user_id, day):
        log(event="skip", user=sub.user_id, date=day, reason="already-claimed")
        return {"user": sub.user_id, "date": day, "outcome": "already-claimed"}
    token = new_token()
    try:
        store.put_day(sub.user_id, day, str(v), token, now.isoformat())
        msg = build_message(
            to=sub.email,
            from_addr=os.environ["FROM_ADDRESS"],
            token=token,
            inbound_domain=os.environ["INBOUND_DOMAIN"],
            v=v,
            birthday=sub.birthday,
            day=date.fromisoformat(day),
        )
        resp = ses.send_email(
            FromEmailAddress=os.environ["FROM_ADDRESS"],
            Destination={"ToAddresses": [sub.email]},
            Content={"Raw": {"Data": msg.as_bytes()}},
            ConfigurationSetName=os.environ["CONFIG_SET"],
        )
    except Exception as e:
        store.release_day(sub.user_id, day, previous)
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        log(event="error", user=sub.user_id, date=day, error=type(e).__name__, code=code)
        raise
    store.set_day_message_id(sub.user_id, day, resp["MessageId"])
    log(event="sent", user=sub.user_id, date=day, version=str(v))
    return {"user": sub.user_id, "date": day, "version": str(v), "outcome": "sent"}
