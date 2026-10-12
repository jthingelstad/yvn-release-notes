"""Small copies of photos, for the email and the web's lists (Jamie,
2026-10-12: the pictures in the email, not only "See 2 photos").

The email loads nothing remote, so its photos travel inside the message
(compose.py), and a phone's 4 MB original is far too big for that. Each
photo gets one thumbnail, made once, when it is filed, whatever brought
it (a reply, the web, an import): at most LONGEST pixels on its longest
side, a JPEG of roughly 50 to 80 KB (a busy photo that is still over
TARGET at the lowest quality is made smaller until it fits, down to
SMALLEST; past that it gets none and stays a link), kept beside the photo under the same
owner prefix, `media/<user>/.../<n>.thumb.jpg` (thumb_key), and listed on
the photo's media entry as `thumb`: {"key", "size", "width", "height"}.
A photo no thumbnail can be made from (a file Pillow cannot read, one
gone from the bucket) gets `thumb: {}`, so it is not tried again, and
shows as a link as before. HEIC is left alone: Pillow cannot read it
without another library, and such a photo stays a link.

The thumbnail is turned upright (the EXIF orientation), keeps its colour
profile and nothing else of the original's metadata: no time, no
camera, no location, so a photo's GPS never travels in an email. The
original is never changed.

Why Pillow (2026-10-12): the standard library cannot decode or resize a
JPEG, and everything else here is standard library only. Pillow is the
smallest honest way: one package with no Python dependencies, from its
own wheel (pinned with its hash in layers/pillow.txt, built into a layer
by deploy.sh), in this module only, imported when a thumbnail is made, so
the tests and every other function run without it. Its one function is
the describe function (describe.py), which already reads the table's
stream for photos: a third stream reader would pass DynamoDB Streams'
two readers a shard. Nothing in the web or inbound path waits on it; a
thumbnail arrives a few seconds after its note, and an email composed
before then shows the link, as it always has.

Untrusted images: Pillow refuses one over MAX_PIXELS (a decompression
bomb), and a JPEG is decoded at a fraction of its size (draft) before it
is shrunk, so a 48-megapixel photo costs little memory.

Photos already kept get theirs from a one-off pass through the same
function: `{"thumbs_all": "<user id>" | "*", "dry_run": true}` counts what
it would make and writes nothing; without dry_run it makes them, handing
the rest to a new pass of itself near its time limit (describe.handler).
Each thumbnail is deleted with its photo (media.keys), and its key once
more after the note has gone, for one made meanwhile. Logs ids and
counts only.

The same read gives a JPEG's EXIF time and place (exif.py, standard
library): `taken_at` and `place` ({"lat", "lon"}) on the photo's entry,
before its thumbnail is listed, so a photo is read once for both.
"""

import io
import json
import os

from . import exif

LONGEST = 640  # pixels, the longest side
TARGET = 80 * 1024  # bytes: lower the quality until a thumbnail is this or less
QUALITIES = (80, 72, 64, 56)
SMALLER = 0.8  # past the last quality, the sides shrink by this until it fits
SMALLEST = 240  # pixels, the longest side: no smaller than this
MAX_PIXELS = 100_000_000  # a larger photo is refused, not decoded
FORMATS = {"image/jpeg", "image/png", "image/gif", "image/webp"}
PAPER = (255, 251, 242)  # transparent parts go on the email's paper
SUFFIX = ".thumb.jpg"
LEFT_FOR_NEXT = 60  # seconds: a pass hands on with this much time left


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def thumb_key(key: str) -> str:
    """media/<user>/<day>/<note>/1.jpg -> media/<user>/<day>/<note>/1.thumb.jpg"""
    return key.rsplit(".", 1)[0] + SUFFIX


def waiting(note: dict) -> list[dict]:
    """The note's photos with no thumbnail yet that one can be made from."""
    return [m for m in note.get("media") or []
            if m.get("kind") == "image" and m.get("type") in FORMATS and "thumb" not in m
            and str(m.get("key", "")).startswith("media/")]


def counts(notes: list[dict]) -> dict:
    """What a pass would do: photos waiting and their bytes, and the photos
    left as links (HEIC and the like) by type."""
    out = {"notes": 0, "photos": 0, "bytes": 0, "left": {}}
    for note in notes:
        todo = waiting(note)
        out["notes"] += bool(todo)
        out["photos"] += len(todo)
        out["bytes"] += sum(int(m.get("size") or 0) for m in todo)
        for m in note.get("media") or []:
            if m.get("kind") == "image" and m.get("type") not in FORMATS and "thumb" not in m:
                out["left"][m.get("type", "")] = out["left"].get(m.get("type", ""), 0) + 1
    return out


def make(data: bytes) -> tuple[bytes, int, int] | None:
    """(JPEG, width, height) at most LONGEST a side, or None if Pillow
    cannot read it (or it is too large to try)."""
    import warnings

    from PIL import Image, ImageOps

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            img = Image.open(io.BytesIO(data))
            icc = img.info.get("icc_profile")
            # A JPEG decodes straight to a fraction of its size; the rest
            # ignore this.
            img.draft("RGB", (LONGEST * 2, LONGEST * 2))
            img = ImageOps.exif_transpose(img)
            img.thumbnail((LONGEST, LONGEST), Image.Resampling.LANCZOS)
            if img.mode in ("RGBA", "LA", "P", "PA"):
                img = img.convert("RGBA")
                paper = Image.new("RGB", img.size, PAPER)
                paper.paste(img, mask=img.getchannel("A"))
                img = paper
            elif img.mode != "RGB":
                img = img.convert("RGB")
            while True:
                for quality in QUALITIES:
                    out = io.BytesIO()
                    img.save(out, "JPEG", quality=quality, optimize=True, progressive=True,
                             **({"icc_profile": icc} if icc else {}))
                    if out.tell() <= TARGET:
                        return out.getvalue(), img.width, img.height
                # A busy photo still too big at the lowest quality: smaller
                # sides, so it never takes more than its share of the email.
                if max(img.size) * SMALLER < SMALLEST:
                    return None
                img = img.resize((max(1, round(img.width * SMALLER)), max(1, round(img.height * SMALLER))),
                                 Image.Resampling.LANCZOS)
    except (OSError, ValueError, SyntaxError, EOFError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        return None


def _code(e: Exception) -> str | None:
    return (getattr(e, "response", None) or {}).get("Error", {}).get("Code")


def thumbnail(note: dict, user_id: str, *, store, s3, bucket: str, maker=make) -> int:
    """Make each waiting photo's thumbnail and list it on its entry.
    Returns how many were made. A note deleted meanwhile takes its
    thumbnail with it."""
    _, day, note_id = note["sk"].split("#", 2)
    done = 0
    for m in waiting(note):
        try:
            data = s3.get_object(Bucket=bucket, Key=str(m["key"]))["Body"].read()
        except Exception as e:
            if _code(e) != "NoSuchKey":
                raise
            data = None
        if data and m.get("type") == "image/jpeg" and ("taken_at" not in m or "place" not in m):
            # When and where it was taken (exif.py), read from the same bytes;
            # only what the entry does not have yet.
            found = exif.read(data)
            if found.get("taken_at") and "taken_at" not in m:
                store.set_media_field(user_id, day, note_id, int(m["n"]), "taken_at", found["taken_at"])
            if "lat" in found and "place" not in m:
                store.set_media_field(user_id, day, note_id, int(m["n"]), "place",
                                      {"lat": found["lat"], "lon": found["lon"]})
        made = maker(data) if data else None
        entry = {}
        if made:
            body, width, height = made
            key = thumb_key(str(m["key"]))
            s3.put_object(Bucket=bucket, Key=key, Body=body, ContentType="image/jpeg", ContentDisposition="inline")
            entry = {"key": key, "size": len(body), "width": width, "height": height}
        if not store.set_media_field(user_id, day, note_id, int(m["n"]), "thumb", entry):
            if entry:
                s3.delete_object(Bucket=bucket, Key=entry["key"])
            break  # the note or the photo is gone
        done += bool(entry)
    return done


def thumbs_all(users: list[str], *, store, s3, lam, bucket: str, time_left, dry_run: bool = False, maker=make) -> dict:
    """One pass over these subscribers' photos. A dry run counts and writes
    nothing; a real one hands the rest on near the time limit."""
    total = {"users": 0, "notes": 0, "photos": 0, "bytes": 0, "left": {}, "made": 0}
    for i, user_id in enumerate(users):
        notes = store.all_notes(user_id)
        found = counts(notes)
        total["users"] += 1
        for k in ("notes", "photos", "bytes"):
            total[k] += found[k]
        for t, n in found["left"].items():
            total["left"][t] = total["left"].get(t, 0) + n
        if dry_run:
            continue
        for note in notes:
            if not waiting(note):
                continue
            if time_left() < LEFT_FOR_NEXT:
                lam.invoke(FunctionName=os.environ["SELF"], InvocationType="Event",
                           Payload=json.dumps({"thumbs_all": users[i:]}).encode())
                log(event="thumbs-all", users=len(users[i:]), made=total["made"], outcome="continued")
                return {**total, "more": True}
            total["made"] += thumbnail(note, user_id, store=store, s3=s3, bucket=bucket, maker=maker)
    log(event="thumbs-all", dry_run=dry_run, users=total["users"], photos=total["photos"], made=total["made"],
        outcome="done")
    return {**total, "more": False}
