"""A day's release notes: every reply to that day's email, as one text.

Each reply is stored as its own note (store.py), so nothing is lost and a
later phase can show them apart. Read together they are one day: the texts
in the order they arrived, separated by a blank line. A reply with no text
(a photo alone) adds nothing to the text, and a reply sent twice (same text)
is shown once.
"""


def combine(notes: list[dict]) -> str:
    """Join notes already sorted oldest first (Store.day_notes)."""
    parts: list[str] = []
    for note in notes:
        text = (note.get("text") or "").strip()
        if text and text not in parts:
            parts.append(text)
    return "\n\n".join(parts)
