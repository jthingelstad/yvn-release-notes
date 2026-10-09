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
- its place is its own location; else the first spot its photos carry
  (taking the town of an entry's place within a few kilometres when the
  photo has none); else that day's other entries'; else the subscriber's
  city (Jamie, 2026-10-09: "assume no location is Minneapolis"). A place
  keeps everything Day One knew (Jamie, 2026-10-09: "we don't lose the
  resolution"): label, venue or street address, town, coordinates to six
  places and their accuracy, and `from`, which of those it came from;
- photos, the recording and PDFs, in Day One's order, are its media, a
  photo with its own spot and when it was taken;
- the entry itself, as Day One wrote it, is kept whole at `raw_key`
  (`raw/dayone/<user>/<uuid>.json`), the way a reply's raw email is: the
  safety net for anything not carried over (Day One's weather, devices,
  rich text).

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
NEAR_KM = 5.0  # a photo's spot takes the town of an entry's place this close
DIGITS = 6     # coordinates to about ten centimetres: what the device knew, less the noise
# Day One names a spot with no venue by its street address: "5237 Morgan Ave S",
# "300–338 Washington Ave S". "7-Eleven", "3M Center" and "7th St & 3rd Ave"
# are venues.
ADDRESS = re.compile(r"^\d+(?:\s?[–-]\s?\d+)?\s+\S")

# Zone names Day One wrote that browsers or tzdata spell differently now.
ZONES = {"US/Central": "America/Chicago", "US/Eastern": "America/New_York", "US/Mountain": "America/Denver",
         "US/Pacific": "America/Los_Angeles", "Europe/Kiev": "Europe/Kyiv"}

OTHER_FILES = ("videos",)
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
TAGS_HTML = re.compile(r"</?(?:strike|s|del|u|b|i|em|strong)\s*/?>", re.IGNORECASE)
BR = re.compile(r"<br\s*/?>", re.IGNORECASE)
HOLD = re.compile("[\ue000\ue001]")  # the marks plain() holds things with
ESCAPE = re.compile(r"\\([\\`*_{}\[\]()#+\-.!>|~])")
# An address may have one level of brackets in it: .../wiki/Foo_(bar)
MD_LINK = re.compile(r"(?<!!)\[([^\]\n]+)\]\((https?://(?:[^()\s]|\([^()\s]*\))+)\)")
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
    def words_of(s: str) -> str:
        # A link's words as read: escapes back, emphasis off.
        s = put_back(s)
        return ITALIC.sub(lambda m: m.group(1) or m.group(2), BOLD.sub(r"\2", s))

    t = HOLD.sub("", markdown.replace("\r\n", "\n"))
    t, counts["photo_markers"] = MOMENT.subn("", t)
    t = AUTOLINK.sub(r"\1", t)
    t, br = BR.subn("\n", t)
    t, counts["html"] = TAGS_HTML.subn("", t)
    counts["html"] += br
    t, counts["escapes"] = ESCAPE.subn(lambda m: hold(m.group(1)), t)

    def link(m):
        words, url = m.group(1).strip(), m.group(2)
        named.setdefault(put_back(url), words_of(words))
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
        named.setdefault(url, words_of(words))
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


def _coord(x) -> float:
    return round(float(x), DIGITS)


def place_of(location: dict) -> dict | None:
    """A Day One location as a place (notes.py), keeping all it says, or
    None without coordinates: the writer's own `label` ("Cabin", "Home"),
    the `venue` Day One found there, or the street `address` when that is
    what Day One called it, the town, the coordinates and how far off they
    may be (`accuracy_m`, Day One's radius)."""
    if location.get("latitude") is None or location.get("longitude") is None:
        return None
    label = (location.get("userLabel") or "").strip()
    found = (location.get("placeName") or "").strip()
    city = (location.get("localityName") or "").strip()
    address = bool(ADDRESS.match(found))
    radius = (location.get("region") or {}).get("radius")
    out = {"label": label, "venue": "" if address or found in (label, city) else found,
           "address": found if address else "", "city": city,
           "region": (location.get("administrativeArea") or "").strip(),
           "country": (location.get("country") or "").strip(),
           "lat": _coord(location["latitude"]), "lon": _coord(location["longitude"]),
           "accuracy_m": round(float(radius)) if radius else None}
    return {k: v for k, v in out.items() if v not in ("", None)}


def _km(a: dict, b: dict) -> float:
    la1, lo1, la2, lo2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def nearest(point: dict, places: list[dict]) -> dict | None:
    best = min(places, key=lambda p: _km(point, p), default=None)
    return best if best and _km(point, best) <= NEAR_KM else None


TOWN = ("city", "region", "country")


def home_place(profile: dict) -> dict | None:
    if profile.get("lat") is None or profile.get("lon") is None:
        return None
    out = {"city": profile.get("city") or "", "region": profile.get("region") or "",
           "country": profile.get("country") or "", "lat": _coord(profile["lat"]), "lon": _coord(profile["lon"])}
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
            if spot := place_of(f.get("location") or {}):
                item["place"] = spot
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

    towns = [p for e in entries if (p := place_of(e.get("location") or {})) and p.get("city")]

    # Where each entry was, and each day's first place. A photo's spot keeps
    # what the photo says and borrows only the town from an entry nearby.
    where: dict[str, tuple[dict | None, str]] = {}
    for e in entries:
        own = place_of(e.get("location") or {})
        if own:
            where[e["uuid"]] = (own, "entry")
            continue
        pic = next((p for f in e.get("photos") or [] if (p := place_of(f.get("location") or {}))), None)
        if pic and "city" not in pic and (near := nearest(pic, towns)):
            pic.update({k: near[k] for k in TOWN if k in near})
        where[e["uuid"]] = (pic, "photo") if pic else (None, "")
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
        # Kinds this does not carry yet (video): counted, and in the original.
        if other := sum(len(e.get(k) or []) for k in OTHER_FILES):
            counts["files_not_carried"] = counts.get("files_not_carried", 0) + other
        if not text and not files:
            skipped.append({"date": day, "uuid": e["uuid"], "why": "files not carried" if other else "empty"})
            continue
        line = tags.line(list(e.get("tags") or []) + journal_tag)
        room = MAX_NOTE - (len(line) + 2 if line else 0)
        if len(text) > room:  # cut the words, never the tags (the original keeps it all)
            counts["cut"] = counts.get("cut", 0) + 1
            text = text[:room].rstrip()
        if line:
            text = f"{text}\n\n{line}" if text else line
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
            "raw_key": f"raw/{APP}/{user_id}/{e['uuid']}.json",
        }
        if place:
            item["place"] = {**place, "from": source}
        if found := tags.found(text):
            item["tags"] = found
        media, copies = [], []
        for n, f in enumerate(files, 1):
            key = f"media/{user_id}/{day}/{note_id}/{n}.{f['ext']}"
            media.append({"n": n, **{k: v for k, v in f.items() if k not in ("ext", "from")}, "size": names[f["from"]],
                          "key": key})
            copies.append({"from": f["from"], "key": key, "type": f["type"]})
        if media:
            item["media"] = media
        notes.append({"date": day, "id": note_id, "item": item, "named": named, "tag_line": line, "place_from": source,
                      "files": copies,
                      "original": e,
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
                # Only the town and coordinates to two places go to Open-Meteo.
                out[n["date"]] = {**{k: p[k] for k in TOWN if k in p}, "lat": round(p["lat"], 2),
                                  "lon": round(p["lon"], 2), "tz": n["item"]["tz"]}
    return dict(sorted(out.items()))
