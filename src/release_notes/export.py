"""Export: everything a subscriber has here, as JSON and as Markdown.

It comes before deleting, so that deleting never means losing anything.
Kept out of it: the reply tokens (each is an address that files notes) and
the SES and S3 bookkeeping. The JSON lists each note's attachments.

Two ways out. The words alone, Markdown or JSON, come straight back from
the API. Everything, photos and recordings included, is a zip that
export_job.py builds in the background (Jamie, 2026-10-08): the same two
files plus files/, with the Markdown showing each photo by its path in the
zip, so it reads with its pictures in any Markdown viewer.
"""

from datetime import date
from decimal import Decimal

from . import links
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


def file_paths(items: list[dict]) -> dict[str, list[dict]]:
    """Note id -> [{"path", "kind", "type", "key"}] for the zip: files/<day>-<n>.<ext>,
    numbered through each day in the order its notes arrived."""
    notes = sorted((i for i in items if i["sk"].startswith("NOTE#") and i.get("media")),
                   key=lambda i: (i["sk"].split("#")[1], i.get("received_at", ""), i["sk"]))
    out: dict[str, list[dict]] = {}
    count: dict[str, int] = {}
    for item in notes:
        day, note_id = item["sk"].split("#")[1], item["sk"].split("#", 2)[2]
        for m in item["media"]:
            count[day] = count.get(day, 0) + 1
            ext = str(m["key"]).rsplit(".", 1)[-1]
            out.setdefault(note_id, []).append(
                {"path": f"files/{day}-{count[day]}.{ext}", "kind": m["kind"], "type": m["type"], "key": m["key"]})
    return out


def build(items: list[dict], exported_at: str, files: dict[str, list[dict]] | None = None) -> dict:
    """Everything, as data. With `files` (file_paths), each note lists its
    photos and recordings by their path in the zip."""
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
                    "links": _plain(item.get("links", [])),
                    "files": [{"path": x["path"], "kind": x["kind"], "type": x["type"]}
                              for x in (files or {}).get(sk.split("#", 2)[2], [])],
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
        for k in ("updated_at", "subject", "links", "files"):
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
        # Links by name, as Markdown links; the raw address stays the target.
        text = combine([{"text": links.markdown(n["text"], n.get("links"))} for n in notes])
        lines += ["", f"## {notes[0]['version']} · {long_date(day)}"]
        shown = [f for n in notes for f in n.get("files", [])]
        if text or not shown:
            lines += ["", text or "(Attachments only. They are in the original email.)"]
        for f in shown:
            # Paths inside the zip, so the Markdown reads with its pictures.
            label = "Photo" if f["kind"] == "image" else "Recording"
            lines += ["", f"{'!' if f['kind'] == 'image' else ''}[{label}, {notes[0]['version']}]({f['path']})"]
    return "\n".join(lines) + "\n"
