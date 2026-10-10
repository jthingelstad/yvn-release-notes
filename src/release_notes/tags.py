"""Tags: the hashtags in a note's text.

Jamie, 2026-10-09: tags are on the note, written as hashtags, lowercase
with hyphens ("maine-2016"). A note's tags are the hashtags in its text,
so every channel tags the same way: a reply, a note typed on the web, an
import (which writes its tags as a closing line of hashtags). The text keeps
each hashtag as written; the note's `tags` list holds their slugs, worked
out again on every write and edit, so removing a hashtag removes the tag.

A hashtag is `#` and a word that has a letter in it, not inside a word or an
address: `#Maine-2016` is the tag `maine-2016`; `#1`, `PR #31`, a page's
`#section` and a Markdown heading (`# Title`) are not tags.

No index: one person's notes are read whole. The tag list brings back keys
and tags only (Store.note_tags) and a tag's page only its notes
(Store.tagged_notes, a filter).
"""

import re
import unicodedata

MAX_TAG = 50   # characters in a slug
MAX_TAGS = 20  # per note

# `#` not after a letter, digit, `#`, `&` (an entity), `/` or `=` (an
# address), then letters and digits in hyphenated runs.
HASHTAG = re.compile(r"(?<![\w#&/=])#([^\W_]+(?:-[^\W_]+)*)")


def slug(name: str) -> str:
    """A tag as stored and matched: ASCII, lowercase, words joined by
    hyphens. "Williamsburg/DC Vacation" -> "williamsburg-dc-vacation"."""
    ascii_ = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_.lower()).strip("-")[:MAX_TAG].strip("-")


def _valid(s: str) -> bool:
    return bool(s) and any(c.isalpha() for c in s)


def spans(text: str) -> list[tuple[int, int, str]]:
    """(start, end, slug) for each hashtag in the text, in order."""
    out = []
    for m in HASHTAG.finditer(text or ""):
        s = slug(m.group(1))
        if _valid(s):
            out.append((m.start(), m.end(), s))
    return out


def found(text: str) -> list[str]:
    """The note's tags: each hashtag's slug once, first use first."""
    seen: list[str] = []
    for _, _, s in spans(text):
        if s not in seen:
            seen.append(s)
    return seen[:MAX_TAGS]


def line(names: list[str]) -> str:
    """Tags from elsewhere (an import) as the closing line of hashtags that
    makes them the note's tags."""
    out: list[str] = []
    for n in names:
        s = slug(n)
        if _valid(s) and s not in out:
            out.append(s)
    return " ".join(f"#{s}" for s in out)


def split(parts: list) -> list:
    """The web's parts (links.segments) with each hashtag in a string part
    split out as {"tag": slug, "text": "#As-Written"}."""
    out: list = []
    for part in parts:
        if not isinstance(part, str):
            out.append(part)
            continue
        last = 0
        for start, end, s in spans(part):
            if start > last:
                out.append(part[last:start])
            out.append({"tag": s, "text": part[start:end]})
            last = end
        if last < len(part):
            out.append(part[last:])
    return out


def without_closing(text: str) -> str:
    """The text without its closing lines of hashtags alone (an import's
    tags, `line`). The email cuts a note short and shows the day's tags on
    a line of their own, so a cut never loses them and none shows twice."""
    lines = (text or "").rstrip().split("\n")
    while lines:
        last = lines[-1]
        found_ = spans(last)
        rest = last
        for start, end, _ in reversed(found_):
            rest = rest[:start] + rest[end:]
        if not found_ or rest.strip():
            break
        lines.pop()
    return "\n".join(lines).rstrip()
