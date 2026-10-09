"""A day's release notes: every reply to that day's email, as one text.

Each reply is stored as its own note (store.py), so nothing is lost and a
later phase can show them apart. Read together they are one day: the texts
in the order they arrived, separated by a blank line. A reply with no text
(a photo alone) adds nothing to the text, and a reply sent twice (same text)
is shown once.

A note is the same record whichever channel brought it (Jamie, 2026-10-09:
any kind of data can come from any channel):

    text         as written; its hashtags are its tags (tags.py)
    tags         the hashtags' slugs, worked out again on every write
    written_at   when it was written (UTC); notes filed before 2026-10-09
                 have received_at instead, which written_at() reads
    tz           the zone it was written in, so its time reads as it did
                 there; without one, the subscriber's
    place        optional: where it was written, with all that is known
                 (Jamie, 2026-10-09: "we don't lose the resolution"):
                 label (the writer's own name for it: "Cabin"), venue
                 ("Town Pier"), address (a street address, kept, not
                 shown yet), city, region, country, lat and lon (to six
                 places), accuracy_m, and `from`: how it is known (entry,
                 photo, day: another note that day, home: the
                 subscriber's city)
    source       email, web or import; an import also has `origin`:
                 {"app", "journal", "id"}, the entry it came from
    version, links, media, updated_at as before; an emailed note also has
    raw_key, subject, attachments and parser_version; an import has
    raw_key too (the entry as the app wrote it). A media entry may carry
    width, height, duration, taken_at, name and its own place
"""

# The longest a note's text can be, written on the web or emailed. A longer
# reply keeps its first MAX_NOTE characters; the raw email keeps the rest.
MAX_NOTE = 20_000


SOURCES = ("email", "web", "import")


def written_at(note: dict) -> str:
    return note.get("written_at") or note.get("received_at") or ""


def place_label(place: dict) -> str:
    """"Cabin, Grand Marais", "Four Seasons Mall, Plymouth", or "Plymouth,
    Minnesota" with no name. A street address is kept but not shown here."""
    name, city = place.get("label") or place.get("venue") or "", place.get("city") or ""
    if name and city and name != city:
        return f"{name}, {city}"
    return ", ".join(x for x in (name or city, place.get("region") or place.get("country") or "") if x)


def combine(notes: list[dict]) -> str:
    """Join notes already sorted oldest first (Store.day_notes)."""
    parts: list[str] = []
    for note in notes:
        text = (note.get("text") or "").strip()
        if text and text not in parts:
            parts.append(text)
    return "\n\n".join(parts)


def day_links(notes: list[dict]) -> list[dict]:
    """Every note's links (links.py), for showing the combined text."""
    out: dict[str, dict] = {}
    for note in notes:
        for link in note.get("links") or []:
            out.setdefault(link["url"], link)
    return list(out.values())
