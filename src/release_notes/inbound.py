"""Inbound replies. SES stores the raw message at raw/<messageId>, then calls
this with the receipt (recipients and verdicts).

A reply is filed only when all of these hold:
  - SES did not flag it as spam or a virus, and did not fail to scan it for
    one (a virus verdict of PROCESSING_FAILED counts as a virus; a spam
    verdict of GRAY or PROCESSING_FAILED is let through);
  - it was sent to a reply address we issued (the token names the person and day);
  - it arrived within REPLY_WINDOW, 72 hours, of the email it answers going
    out (Jamie, 2026-10-09: "72 hours after it was sent. After that, the
    user can add a note via the web interface"). The token says when that
    was (`sent_at`); one written before tokens did has only its day (see
    `deadline`). A late reply is ignored as `expired`, with no reply sent.
    The token itself never expires: the email's unsubscribe link uses it
    too, for as long as anyone keeps the email;
  - the From address is that subscriber's, both in SES's reading and in the
    message itself, which has exactly one From header with one address;
  - the sender's domain authenticated it: a DMARC pass or, when the domain
    publishes no DMARC policy (or p=none; SES says GRAY), a DKIM pass for
    the From domain, its parent or a subdomain. A DMARC FAIL stays a fail
    whatever DKIM says;
  - it is not an automatic reply (an out-of-office, a vacation notice):
    Auto-Submitted anything but "no", X-Autoreply, or Precedence auto_reply,
    bulk or junk. The daily email also asks Exchange not to send those.

Those checks read the headers alone. The body is parsed after them, and a
message too broken to parse (MIME nested a thousand deep, say) is ignored as
`unparseable` rather than failing, so SES does not retry it and it expires
like any other.

Everything else is tagged outcome=ignored and expires from S3 in 30 days.
Filed messages are tagged outcome=note and kept. Their photos and recordings
are copied out to media/ and listed on the note (media.py); anything else
attached lives in the raw message only.
"""

import json
import os
import re
from datetime import date, datetime, timedelta, timezone
from email.utils import getaddresses

from . import links, media, tags
from .notes import MAX_NOTE
from .parse import anchors, attachments, note_text, parse_headers, parse_message
from .store import Store

PARSER_VERSION = 3  # 2: HTML-only replies keep link addresses; links named. 3: photos and audio copied out
REPLY_WINDOW = timedelta(hours=72)
_DOMAIN = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?")


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


def deadline(tok: dict) -> datetime:
    """The last moment a reply through this token is filed: REPLY_WINDOW
    after its email went out. Tokens written before 2026-10-09 have no
    `sent_at`, only the day. A day's email goes out by about noon UTC the
    next day in every zone (a late send time, furthest west), so for those
    the deadline is the end of the fourth day after, midnight UTC: at least
    72 hours after the email wherever it went."""
    if tok.get("sent_at") is not None:
        return datetime.fromtimestamp(int(tok["sent_at"]), timezone.utc) + REPLY_WINDOW
    day = date.fromisoformat(tok["date"])
    return datetime(day.year, day.month, day.day, tzinfo=timezone.utc) + timedelta(days=5)


def received(mail: dict) -> datetime:
    """When SES received the message (mail.timestamp, ISO 8601 in UTC)."""
    return datetime.fromisoformat(mail["timestamp"].replace("Z", "+00:00"))


def _aligned(domain: str, from_domain: str) -> bool:
    domain, from_domain = domain.lower().rstrip("."), from_domain.lower().rstrip(".")
    if "." not in domain or "." not in from_domain:
        return False
    return from_domain == domain or from_domain.endswith("." + domain) or domain.endswith("." + from_domain)


def _results(header: str) -> list[list[str]]:
    """An Authentication-Results header as its results, each a list of words
    (`dkim=pass`, `header.i=@example.com`): split on ';' and white space
    outside quoted strings, (comments) dropped (RFC 8601)."""
    results, words, word = [], [], []
    quoted = escaped = False
    depth = 0

    def end_word():
        if word:
            words.append("".join(word))
            word.clear()

    for ch in header:
        if quoted:
            word.append(ch)
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                quoted = False
        elif depth:
            depth += {"(": 1, ")": -1}.get(ch, 0)
        elif ch == '"':
            quoted = True
            word.append(ch)
        elif ch == "(":
            end_word()
            depth = 1
        elif ch == ";":
            end_word()
            results.append(words)
            words = []
        elif ch.isspace():
            end_word()
        else:
            word.append(ch)
    end_word()
    results.append(words)
    return results


def dkim_domains(header: str) -> list[str]:
    """The domain of each DKIM pass in an Authentication-Results header:
    header.d when it is there, else what follows the last '@' of header.i.
    The local part is the signer's to write (`gmail.com@evil.example`), so
    it never counts. Anything that is not plainly a domain is left out."""
    found = []
    for words in _results(header):
        if not words or words[0].lower() != "dkim=pass":
            continue
        props: dict[str, str] = {}
        for w in words[1:]:
            k, sep, v = w.partition("=")
            if sep:
                props.setdefault(k.lower(), v)
        if "header.d" in props:
            domain = props["header.d"]
        elif "@" in props.get("header.i", ""):
            domain = props["header.i"].rsplit("@", 1)[1]
        else:
            continue
        if _DOMAIN.fullmatch(domain):
            found.append(domain)
    return found


def authenticated(receipt: dict, msg, from_addr: str) -> bool:
    """Whether the From domain vouched for the message. `msg` needs only its
    headers."""
    dmarc = receipt.get("dmarcVerdict", {}).get("status")
    if dmarc == "PASS":
        return True
    # FAIL is the domain's own policy turning it down and PROCESSING_FAILED
    # says nothing; only GRAY (no policy, or p=none) falls back to DKIM.
    if dmarc != "GRAY" or receipt.get("dkimVerdict", {}).get("status") != "PASS":
        return False
    # An aligned DKIM pass, then. Only SES's own header counts, and SES puts
    # it on top; a sender can forge one further down.
    results = msg.get_all("Authentication-Results") or []
    if not results or not str(results[0]).strip().lower().startswith("amazonses.com"):
        return False
    from_domain = from_addr.rsplit("@", 1)[-1]
    return any(_aligned(d, from_domain) for d in dkim_domains(str(results[0])))


def sole_from(msg) -> str:
    """The address in the message's From header, lowercased, when it has
    exactly one From header naming exactly one address; else ""."""
    headers = msg.get_all("From") or []
    if len(headers) != 1:
        return ""
    found = getaddresses([str(headers[0])])
    return found[0][1].lower() if len(found) == 1 else ""


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
    if (receipt.get("virusVerdict", {}).get("status") in ("FAIL", "PROCESSING_FAILED")
            or receipt.get("spamVerdict", {}).get("status") == "FAIL"):
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

    if received(mail) > deadline(tok):
        # Too late for the reply address; the web app takes the note now.
        return "ignored", {"reason": "expired", "user": sub.user_id}

    raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
    try:
        head = parse_headers(raw)
        raw_from = sole_from(head)
    except Exception as e:
        return "ignored", {"reason": "unparseable", "user": sub.user_id, "error": type(e).__name__}
    if raw_from != from_addr:
        return "ignored", {"reason": "from-mismatch", "user": sub.user_id}
    if not authenticated(receipt, head, from_addr):
        return "ignored", {"reason": "unauthenticated", "user": sub.user_id}
    if automatic(head):
        return "ignored", {"reason": "auto-reply", "user": sub.user_id}

    # Only now the body. Reading it touches nothing outside the message, so
    # whatever it raises is the message's doing: ignored, never retried.
    try:
        msg = parse_message(raw)
        text = note_text(msg)[:MAX_NOTE]
        files = attachments(msg)
        named = anchors(msg) if text else {}
        refused: list[int] = []
        photos = media.found(msg, refused)
    except Exception as e:  # RecursionError above all: MIME nested too deep
        return "ignored", {"reason": "unparseable", "user": sub.user_id, "error": type(e).__name__}
    for n in refused:
        if n < len(files):
            files[n]["refused"] = True  # not what it said: in the original email only
    if not text and not files:
        return "ignored", {"reason": "empty", "user": sub.user_id}

    day = tok["date"]
    found = links.collect(text, named, fetch=fetch) if text else []
    # Files first: if a copy fails, SES retries the whole reply, and the
    # keys are fixed, so nothing is doubled.
    kept = media.store(s3, bucket, sub.user_id, day, mail["messageId"], photos)
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
