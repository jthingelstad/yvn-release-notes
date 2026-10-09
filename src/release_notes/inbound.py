"""Inbound replies. SES stores the raw message at raw/<messageId>, then calls
this with the receipt (recipients and verdicts).

A reply is filed only when all of these hold:
  - it was sent to a reply address we issued (the token names the person and day);
  - the From address is that subscriber's;
  - the sender's domain authenticated it (DMARC pass, or an aligned DKIM pass
    when the domain publishes no DMARC policy);
  - SES did not flag it as spam or a virus;
  - it is not an automatic reply (an out-of-office, a vacation notice):
    Auto-Submitted anything but "no", X-Autoreply, or Precedence auto_reply,
    bulk or junk. The daily email also asks Exchange not to send those.

Everything else is tagged outcome=ignored and expires from S3 in 30 days.
Filed messages are tagged outcome=note and kept. Their photos and recordings
are copied out to media/ and listed on the note (media.py); anything else
attached lives in the raw message only.
"""

import json
import os
import re
from email.utils import getaddresses

from . import links, media, tags
from .notes import MAX_NOTE
from .parse import anchors, attachments, note_text, parse_message
from .store import Store

PARSER_VERSION = 3  # 2: HTML-only replies keep link addresses; links named. 3: photos and audio copied out
_AUTH_DKIM = re.compile(r"\bdkim=pass\b[^;]*?\bheader\.[id]=@?([A-Za-z0-9.-]+)", re.IGNORECASE)


def log(**fields):
    # Ids and outcomes only. Addresses and note text never go to logs.
    print(json.dumps(fields, separators=(",", ":")))


def automatic(msg) -> bool:
    """An out-of-office or other machine reply (RFC 3834, and the headers
    Exchange and others use instead)."""
    if (msg.get("Auto-Submitted") or "no").strip().lower() != "no":
        return True
    if msg.get("X-Autoreply") or msg.get("X-Autorespond"):
        return True
    return (msg.get("Precedence") or "").strip().lower() in ("auto_reply", "bulk", "junk")


def token_from(recipient: str, inbound_domain: str) -> str | None:
    m = re.fullmatch(rf"n-([a-z2-7]{{24}})@{re.escape(inbound_domain)}", recipient.strip().lower())
    return m.group(1) if m else None


def _aligned(domain: str, from_domain: str) -> bool:
    domain, from_domain = domain.lower().rstrip("."), from_domain.lower().rstrip(".")
    if "." not in domain or "." not in from_domain:
        return False
    return from_domain == domain or from_domain.endswith("." + domain) or domain.endswith("." + from_domain)


def authenticated(receipt: dict, msg, from_addr: str) -> bool:
    if receipt.get("dmarcVerdict", {}).get("status") == "PASS":
        return True
    if receipt.get("dkimVerdict", {}).get("status") != "PASS":
        return False
    # No DMARC verdict (the domain publishes no policy): look for an aligned
    # DKIM pass. Only SES's own header counts, and SES puts it on top; a
    # sender can forge one further down.
    results = msg.get_all("Authentication-Results") or []
    if not results or not str(results[0]).strip().lower().startswith("amazonses.com"):
        return False
    from_domain = from_addr.rsplit("@", 1)[-1]
    return any(_aligned(m.group(1), from_domain) for m in _AUTH_DKIM.finditer(str(results[0])))


def handler(event, context, *, store: Store | None = None, s3=None):
    if store is None or s3 is None:
        import boto3

        store = store or Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
        s3 = s3 or boto3.client("s3")
    for record in event.get("Records", []):
        process(record["ses"], store, s3)


def process(ses: dict, store: Store, s3, fetch=None) -> str:
    mail, receipt = ses["mail"], ses["receipt"]
    message_id = mail["messageId"]
    bucket, key = os.environ["BUCKET"], f"raw/{message_id}"

    outcome, detail = _file(mail, receipt, store, s3, bucket, key, fetch)
    s3.put_object_tagging(Bucket=bucket, Key=key, Tagging={"TagSet": [{"Key": "outcome", "Value": outcome}]})
    log(event="inbound", message=message_id, outcome=outcome, **detail)
    return outcome


def _file(mail, receipt, store, s3, bucket, key, fetch=None) -> tuple[str, dict]:
    if receipt.get("virusVerdict", {}).get("status") == "FAIL" or receipt.get("spamVerdict", {}).get("status") == "FAIL":
        return "ignored", {"reason": "spam-or-virus"}

    inbound_domain = os.environ["INBOUND_DOMAIN"]
    tokens = [t for t in (token_from(r, inbound_domain) for r in receipt.get("recipients", [])) if t]
    if not tokens:
        return "ignored", {"reason": "no-token"}
    tok = store.get_token(tokens[0])
    if not tok:
        return "ignored", {"reason": "unknown-token"}
    sub = store.get_subscriber(tok["user_id"])
    if not sub:
        return "ignored", {"reason": "unknown-user"}

    froms = getaddresses(mail.get("commonHeaders", {}).get("from", []))
    from_addr = froms[0][1].lower() if len(froms) == 1 else ""
    if from_addr != sub.email.lower():
        return "ignored", {"reason": "from-mismatch", "user": sub.user_id}

    raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    msg = parse_message(raw)
    if not authenticated(receipt, msg, from_addr):
        return "ignored", {"reason": "unauthenticated", "user": sub.user_id}

    if automatic(msg):
        return "ignored", {"reason": "auto-reply", "user": sub.user_id}

    text = note_text(msg)[:MAX_NOTE]
    files = attachments(msg)
    if not text and not files:
        return "ignored", {"reason": "empty", "user": sub.user_id}

    day = tok["date"]
    found = links.collect(text, anchors(msg), fetch=fetch) if text else []
    # Files first: if a copy fails, SES retries the whole reply, and the
    # keys are fixed, so nothing is doubled.
    kept = media.store(s3, bucket, sub.user_id, day, mail["messageId"], media.found(msg))
    stored = store.put_note(
        sub.user_id,
        day,
        mail["messageId"],
        {
            "version": tok["version"],
            "text": text,
            "source": "email",
            "attachments": files,
            "written_at": mail["timestamp"],
            "tz": sub.tz,
            "subject": (mail.get("commonHeaders", {}).get("subject") or "")[:300],
            "raw_key": key,
            "parser_version": PARSER_VERSION,
            **({"links": found} if found else {}),
            **({"tags": tagged} if (tagged := tags.found(text)) else {}),
            **({"media": kept} if kept else {}),
        },
    )
    return "note", {
        "user": sub.user_id,
        "date": day,
        "chars": len(text),
        "attachments": len(files),
        "links": len(found),
        "media": len(kept),
        "duplicate": not stored,
    }
