"""Export: everything a subscriber has here, as JSON and as Markdown.

It comes before deleting, so that deleting never means losing anything.
Kept out of it: the reply tokens (each is an address that files notes) and
the SES and S3 bookkeeping. The original emails behind the notes, with any
photos, are not in it yet; the JSON lists each one's attachments.
"""

from datetime import date
from decimal import Decimal

from .notes import combine
from .version import compute_version

PROFILE_FIELDS = (
    "email", "birthday", "tz", "send_time", "status", "created_at",
    "city", "region", "country", "lat", "lon",
)


def _plain(value):
    """DynamoDB's Decimals, made JSON numbers."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items()}
    return value


def build(items: list[dict], exported_at: str) -> dict:
    profile, days, notes, pauses = {}, [], [], []
    for item in items:
        sk = item["sk"]
        if sk == "PROFILE":
            profile = {k: _plain(item[k]) for k in PROFILE_FIELDS if k in item}
        elif sk.startswith("DAY#"):
            days.append({"date": sk[4:], "version": item.get("version"), "sent_at": item.get("sent_at")})
        elif sk.startswith("NOTE#"):
            notes.append(
                {
                    "id": sk.split("#", 2)[2],
                    "date": sk.split("#")[1],
                    "version": item.get("version"),
                    "source": item.get("source", "email"),
                    "text": item.get("text", ""),
                    "received_at": item.get("received_at"),
                    "updated_at": item.get("updated_at"),
                    "subject": item.get("subject"),
                    "attachments": _plain(item.get("attachments", [])),
                }
            )
        elif sk.startswith("PAUSE#"):
            pauses.append({"from": sk[6:], "through": item.get("through")})
    if profile.get("birthday"):
        born = date.fromisoformat(profile["birthday"])
        for n in notes:
            n["version"] = n["version"] or str(compute_version(born, date.fromisoformat(n["date"])))
    notes.sort(key=lambda n: (n["date"], n["received_at"] or "", n["id"]))
    for n in notes:
        for k in ("updated_at", "subject"):
            if not n[k]:
                del n[k]
    return {
        "exported_at": exported_at,
        "profile": profile,
        "notes": notes,
        "days_sent": sorted(days, key=lambda d: d["date"]),
        "pauses": sorted(pauses, key=lambda p: p["from"]),
    }


def long_date(day: str) -> str:
    d = date.fromisoformat(day)
    return f"{d:%A}, {d:%B} {d.day}, {d.year}"


def markdown(data: dict) -> str:
    profile = data["profile"]
    lines = ["# Release Notes", ""]
    about = [f"Exported {data['exported_at'][:10]}"]
    if profile.get("email"):
        about.append(f"for {profile['email']}")
    lines.append(" ".join(about) + ".")
    if profile.get("birthday"):
        lines += ["", f"Born {long_date(profile['birthday'])}: that day was 0.0.0."]
    if not data["notes"]:
        lines += ["", "No notes yet."]
    by_day: dict[str, list[dict]] = {}
    for n in data["notes"]:
        by_day.setdefault(n["date"], []).append(n)
    for day, notes in by_day.items():
        text = combine(notes)
        lines += ["", f"## {notes[0]['version']} · {long_date(day)}", ""]
        lines.append(text or "(Attachments only. They are in the original email.)")
    return "\n".join(lines) + "\n"
