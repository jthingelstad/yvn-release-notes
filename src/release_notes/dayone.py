"""Day One exports, as Release Notes notes (Jamie, 2026-10-09).

A Day One export is a zip: `<Journal>.json` (every entry) beside photos/,
audios/ and pdfs/, each file named by its md5. This module only plans: it
turns each entry into the note it would be (notes.py lists the fields) and
lists the files to copy, and touches nothing. scripts/import_dayone.py reads
a subscriber, plans, and reports; writing is a later step.

An entry becomes one note, `NOTE#<day>#d1-<uuid>`:

- its day is its creation time in its own zone, and its version that day's;
- its text is Day One's Markdown made plain (there is no Markdown here):
  photo markers out (the photos come along as media), `# ` off headings,
  `**`, `*` and `_` off emphasis, `\\` off escapes, `* ` bullets as `- `, a
  `[words](url)` link as `words <url>`, the way a mail app writes one;
- its Day One tags, and the journal's name for any journal but the main one,
  become a closing line of hashtags (tags.py);
- its place is its own location; else one its photos carry (named after a
  named place within a few kilometres, if there is one); else that day's
  other entries'; else the subscriber's city (Jamie, 2026-10-09: "assume no
  location is Minneapolis");
- photos, the recording and PDFs, in Day One's order, are its media.

An entry with no text and no file is left out.
"""

import json
import math
import re
import zipfile
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from . import links, tags
from .notes import MAX_NOTE
from .version import compute_version

APP = "dayone"
MAIN_JOURNAL = "Journal"
NEAR_KM = 5.0  # a photo's coordinates take a named place this close

# Zone names Day One wrote that browsers or tzdata spell differently now.
ZONES = {"US/Central": "America/Chicago", "US/Eastern": "America/New_York", "US/Mountain": "America/Denver",
         "US/Pacific": "America/Los_Angeles", "Europe/Kiev": "Europe/Kyiv"}

FILE_KINDS = {
    "photos": {"jpeg": ("image", "image/jpeg", "jpg"), "jpg": ("image", "image/jpeg", "jpg"),
               "png": ("image", "image/png", "png"), "heic": ("image", "image/heic", "heic"),
               "gif": ("image", "image/gif", "gif")},
    "audios": {"m4a": ("audio", "audio/mp4", "m4a"), "aac": ("audio", "audio/mp4", "m4a"),
               "mp3": ("audio", "audio/mpeg", "mp3"), "wav": ("audio", "audio/wav", "wav")},
    "pdfs": {"pdf": ("file", "application/pdf", "pdf")},
}

# --- text ---------------------------------------------------------------------

MOMENT = re.compile(r"!\[[^\]]*\]\(dayone-moment:[^)]*\)")
AUTOLINK = re.compile(r"<(https?://[^\s<>]+)>")
TAGS_HTML = re.compile(r"</?(?:strike|s|del|u|b|i|em|strong|br)\s*/?>", re.IGNORECASE)
ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!>|~])")
MD_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\((https?://[^)\s]+)\)")
# A link to another entry, or into the Day One app.
APP_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\((dayone2?://[^)\s]*)\)")
ENTRY_ID = re.compile(r"entryId=([0-9A-Fa-f]{32})")
BARE_URL = re.compile(r"https?://[^\s<>\"]+")
HEADING = re.compile(r"(?m)^[ \t]*#{1,6}[ \t]+")
BOLD = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1")
ITALIC = re.compile(r"(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])")
STAR_BULLET = re.compile(r"(?m)^([ \t]*)[*+][ \t]+")


def plain(markdown: str, entry_url=lambda uuid: None) -> tuple[str, dict[str, str], dict[str, int]]:
    """Day One's Markdown as plain text, the words each address was linked
    from (for links.collect), and what was changed, counted. A link to
    another entry becomes a link to that entry's day here, where
    `entry_url(uuid)` knows it; any other link into the app, just its words."""
    held: list[str] = []

    def hold(s: str) -> str:
        # Kept out of the emphasis rules until the end: escapes and addresses.
        held.append(s)
        return f"{len(held) - 1}"

    def put_back(s: str) -> str:
        while "" in s:
            s = re.sub("(\\d+)", lambda m: held[int(m.group(1))], s)
        return s

    counts = dict.fromkeys(("photo_markers", "headings", "emphasis", "escapes", "links", "entry_links", "app_links",
                            "bullets", "html"), 0)
    named: dict[str, str] = {}
    t = markdown.replace("\r\n", "\n")
    t, counts["photo_markers"] = MOMENT.subn("", t)
    t = AUTOLINK.sub(r"\1", t)
    t, counts["html"] = TAGS_HTML.subn("", t)
    t, counts["escapes"] = ESCAPE.subn(lambda m: hold(m.group(1)), t)

    def link(m):
        words, url = m.group(1).strip(), m.group(2)
        named.setdefault(url, put_back(words))
        return f"{words} {hold('<' + url + '>')}"

    t, counts["links"] = MD_LINK.subn(link, t)

    def app_link(m):
        found = ENTRY_ID.search(m.group(2))
        url = entry_url(found.group(1).upper()) if found else None
        if not url:
            counts["app_links"] += 1
            return m.group(1).strip()
        counts["entry_links"] += 1
        words = m.group(1).strip()
        named.setdefault(url, put_back(words))
        return f"{words} {hold('<' + url + '>')}"

    t = APP_LINK.sub(app_link, t)
    t = BARE_URL.sub(lambda m: hold(m.group(0)), t)
    t, counts["headings"] = HEADING.subn("", t)
    t, b = BOLD.subn(r"\2", t)
    t, i = ITALIC.subn(lambda m: m.group(1) or m.group(2), t)
    counts["emphasis"] = b + i
    t, counts["bullets"] = STAR_BULLET.subn(r"\1- ", t)
    t = put_back(t)
    t = re.sub(r"[ \t]+\n", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t).strip()
    return t, named, counts


# --- where and when -----------------------------------------------------------

def zone(entry: dict) -> str:
    tz = entry.get("timeZone") or "UTC"
    return ZONES.get(tz, tz)


def written(entry: dict) -> datetime:
    return datetime.fromisoformat(entry["creationDate"].replace("Z", "+00:00"))


def day_of(entry: dict) -> str:
    return written(entry).astimezone(ZoneInfo(zone(entry))).date().isoformat()


def _round(x) -> float:
    return round(float(x), 2)


def place_of(location: dict) -> dict | None:
    """A Day One location as a note's place, or None without coordinates.
    The writer's own label ("Cabin", "Home") is the name when there is one."""
    if location.get("latitude") is None or location.get("longitude") is None:
        return None
    out = {"name": location.get("userLabel") or location.get("placeName") or "",
           "city": location.get("localityName") or "", "region": location.get("administrativeArea") or "",
           "country": location.get("country") or "",
           "lat": _round(location["latitude"]), "lon": _round(location["longitude"])}
    return {k: v for k, v in out.items() if v != ""}


def _km(a: dict, b: dict) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def nearest_named(point: dict, named: list[dict]) -> dict | None:
    best = min(named, key=lambda p: _km(point, p), default=None)
    return best if best and _km(point, best) <= NEAR_KM else None


def home_place(profile: dict) -> dict | None:
    if profile.get("lat") is None or profile.get("lon") is None:
        return None
    out = {"city": profile.get("city") or "", "region": profile.get("region") or "",
           "country": profile.get("country") or "", "lat": _round(profile["lat"]), "lon": _round(profile["lon"])}
    return {k: v for k, v in out.items() if v != ""}


# --- files --------------------------------------------------------------------

def by_md5(names) -> dict[tuple[str, str], str]:
    """(folder, md5) -> the file's path: Day One names a file by its md5, and
    the extension is not always the type the entry gives (an "aac" is .m4a)."""
    out = {}
    for n in names:
        folder, _, base = n.partition("/")
        if base and "." in base:
            out[(folder, base.rsplit(".", 1)[0])] = n
    return out


def files_of(entry: dict, index: dict[tuple[str, str], str]) -> tuple[list[dict], list[str]]:
    """The entry's photos, recordings and PDFs in Day One's order, each
    {"kind", "type", "ext", "from", "size"?, "width"?, "height"?,
    "taken_at"?, "name"?}, and the md5s with no file in the zip."""
    found, missing = [], []
    for folder, key in (("photos", "photos"), ("audios", "audios"), ("pdfs", "pdfAttachments")):
        for f in sorted(entry.get(key) or [], key=lambda f: f.get("orderInEntry", 0)):
            path = index.get((folder, f.get("md5") or ""))
            kind = FILE_KINDS[folder].get(path.rsplit(".", 1)[-1].lower()) if path else None
            if not kind:
                missing.append(f.get("md5") or "?")
                continue
            item = {"kind": kind[0], "type": kind[1], "ext": kind[2], "from": path}
            if f.get("width") and f.get("height"):
                item.update(width=int(f["width"]), height=int(f["height"]))
            if f.get("duration"):
                item["duration"] = round(float(f["duration"]), 1)
            if f.get("date"):
                item["taken_at"] = f["date"]
            if folder == "pdfs" and f.get("pdfName"):
                item["name"] = f"{f['pdfName']}.pdf"
            found.append(item)
    return found, missing


# --- the plan -----------------------------------------------------------------

def journal_name(zip_names: list[str]) -> str:
    json_name = next(n for n in zip_names if n.endswith(".json") and "/" not in n)
    return json_name[: -len(".json")]


def read(zip_path: str) -> tuple[str, list[dict], dict[str, int]]:
    """(journal name, entries, every path in the zip with its size)."""
    with zipfile.ZipFile(zip_path) as z:
        names = {i.filename: i.file_size for i in z.infolist()}
        journal = journal_name(list(names))
        entries = json.loads(z.read(f"{journal}.json"))["entries"]
    return journal, entries, names


def plan(journal: str, entries: list[dict], names: dict[str, int], profile: dict, user_id: str,
         web_origin: str = "https://notes.yourversionnumber.com") -> dict:
    """Every note this export would make, with its files and each day's
    place for weather, plus what was skipped and counted. Writes nothing."""
    born = datetime.fromisoformat(profile["birthday"]).date()
    home = home_place(profile)
    journal_tag = [] if journal == MAIN_JOURNAL else [journal]
    index = by_md5(names)
    days = {e["uuid"].upper(): day_of(e) for e in entries}

    def entry_url(uuid: str) -> str | None:
        return f"{web_origin}/day/?d={days[uuid]}" if uuid in days else None

    named_places = [p for e in entries if (p := place_of(e.get("location") or {})) and p.get("name")]

    # Where each entry was, and each day's first place.
    where: dict[str, tuple[dict | None, str]] = {}
    for e in entries:
        own = place_of(e.get("location") or {})
        if own:
            where[e["uuid"]] = (own, "entry")
            continue
        pic = next((p["location"] for p in e.get("photos") or [] if (p.get("location") or {}).get("latitude") is not None), None)
        if pic:
            point = {"lat": _round(pic["latitude"]), "lon": _round(pic["longitude"])}
            near = nearest_named(point, named_places)
            where[e["uuid"]] = ({**{k: v for k, v in near.items() if k not in ("lat", "lon")}, **point} if near else point, "photo")
        else:
            where[e["uuid"]] = (None, "")
    day_place: dict[str, dict] = {}
    for e in sorted(entries, key=lambda e: e["creationDate"]):
        p, _ = where[e["uuid"]]
        if p:
            day_place.setdefault(day_of(e), p)

    notes, skipped, missing_files = [], [], 0
    counts: dict[str, int] = {}
    place_from: dict[str, int] = {}
    for e in sorted(entries, key=lambda e: e["creationDate"]):
        day = day_of(e)
        text, named, c = plain(e.get("text") or "", entry_url)
        for k, v in c.items():
            counts[k] = counts.get(k, 0) + v
        files, missing = files_of(e, index)
        missing_files += len(missing)
        if not text and not files:
            skipped.append({"date": day, "uuid": e["uuid"], "why": "empty"})
            continue
        line = tags.line(list(e.get("tags") or []) + journal_tag)
        if line:
            text = f"{text}\n\n{line}" if text else line
        if len(text) > MAX_NOTE:
            counts["cut"] = counts.get("cut", 0) + 1
            text = text[:MAX_NOTE]
        place, source = where[e["uuid"]]
        if not place and day in day_place:
            place, source = day_place[day], "day"
        if not place and home:
            place, source = home, "home"
        place_from[source or "none"] = place_from.get(source or "none", 0) + 1
        note_id = f"d1-{e['uuid']}"
        item = {
            "version": str(compute_version(born, datetime.fromisoformat(day).date())),
            "text": text,
            "source": "import",
            "origin": {"app": APP, "journal": journal, "id": e["uuid"]},
            "written_at": written(e).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tz": zone(e),
        }
        if place:
            item["place"] = place
        if found := tags.found(text):
            item["tags"] = found
        media = []
        for n, f in enumerate(files, 1):
            media.append({"n": n, **{k: v for k, v in f.items() if k not in ("ext", "from")}, "size": names[f["from"]],
                          "key": f"media/{user_id}/{day}/{note_id}/{n}.{f['ext']}", "from": f["from"]})
        if media:
            item["media"] = media
        notes.append({"date": day, "id": note_id, "item": item, "named": named, "tag_line": line, "place_from": source,
                      "zone_was": e.get("timeZone"),
                      "urls": links.urls(text), "all_day": bool(e.get("isAllDay")),
                      "starred": bool(e.get("starred")), "modified": e.get("modifiedDate")})
    return {"journal": journal, "notes": notes, "skipped": skipped, "missing_files": missing_files,
            "counts": counts, "place_from": place_from, "weather_days": weather_days(notes)}


def weather_days(notes: list[dict]) -> dict[str, dict]:
    """Each day's place for its weather, in that note's zone: the first
    place written that day other than the subscriber's city, else the city.
    Takes the notes of several exports together (journals share days)."""
    out: dict[str, dict] = {}
    for home in (False, True):
        for n in sorted(notes, key=lambda n: n["item"]["written_at"]):
            p = n["item"].get("place")
            if p and n["date"] not in out and (n["place_from"] == "home") == home:
                out[n["date"]] = {**p, "tz": n["item"]["tz"]}
    return dict(sorted(out.items()))
