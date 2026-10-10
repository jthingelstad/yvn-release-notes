"""Writing an import plan (dayone.py) into a subscriber's notes (Jamie, 2026-10-09).

The plan says what each note is; this writes it, in an order that makes a run
safe to stop and repeat:

1. Each planned note, oldest first, unless its entry is on the import's
   ledger (imported before: still there, or deleted by the subscriber since,
   and never brought back) or a note with its id is on any day:
   a. its files, then its original, go to the bucket, at keys the plan fixed,
      so a repeat writes the same objects;
   b. its links: the writer's own words where it named them, else the
      page's title (links.collect);
   c. the note, only if it is not there (Store.put_note, which turns
      floats into Decimal all the way down);
   d. its entry goes on the ledger, `IMPORT#<app>#<journal>`.
2. Then each day's weather from the plan (dayone.weather_days: that day's
   first place), for finished days with none kept yet. It runs straight
   after the notes so nothing else fills those days with the home city's.

Takes several plans at once, since journals share days. Returns counts and
logs nothing of a note: no text, tags or places.
"""

import json
import time
from datetime import date

from . import links, tags, weather
from .dayone import weather_days


def ledger(plan: dict) -> str:
    app = plan["notes"][0]["item"]["origin"]["app"] if plan["notes"] else "import"
    return f"IMPORT#{app}#{tags.slug(plan['journal']) or 'journal'}"


def write(plans: list[tuple[dict, callable]], user_id: str, *, store, s3, bucket: str, today: date, at: str,
          fetch_title=None, fetch_weather=None, pause: float = 0.0, progress=None) -> dict:
    """plans: (plan, read), where read(path in the export) gives a file's
    bytes. fetch_weather None leaves weather out."""
    counts = dict.fromkeys(("notes", "already_imported", "id_taken", "files", "file_bytes", "originals",
                            "links_named", "links_titled", "weather_kept", "weather_had", "weather_no_answer"), 0)
    taken = store.note_ids(user_id)
    for plan, read in plans:
        book = ledger(plan)
        done = store.imported(user_id, book)
        for n in sorted(plan["notes"], key=lambda n: n["item"]["written_at"]):
            uuid = n["item"]["origin"]["id"]
            if uuid in done:
                counts["already_imported"] += 1
                continue
            if n["id"] in taken:
                counts["id_taken"] += 1
                continue
            for f in n["files"]:
                body = read(f["from"])
                s3.put_object(Bucket=bucket, Key=f["key"], Body=body, ContentType=f["type"],
                              ContentDisposition="inline")
                counts["files"] += 1
                counts["file_bytes"] += len(body)
            s3.put_object(Bucket=bucket, Key=n["item"]["raw_key"], ContentType="application/json",
                          Body=json.dumps(n["original"], ensure_ascii=False, indent=1).encode(), Tagging="outcome=note")
            counts["originals"] += 1
            item = dict(n["item"])
            if found := links.collect(item["text"], n["named"], fetch=fetch_title):
                item["links"] = found
                counts["links_named"] += sum(1 for l in found if l.get("named"))
                counts["links_titled"] += sum(1 for l in found if not l.get("named"))
            if store.put_note(user_id, n["date"], n["id"], item):
                counts["notes"] += 1
            else:
                counts["id_taken"] += 1
            store.add_imported(user_id, book, [uuid], at)
            taken.add(n["id"])
            if progress:
                progress(counts)

    if fetch_weather:
        kept = store.weather_between(user_id, "0000-00-00", "9999-99-99")
        days = weather_days([n for plan, _ in plans for n in plan["notes"]])
        for day, place in days.items():
            if day >= today.isoformat():
                continue
            if day in kept:
                counts["weather_had"] += 1
                continue
            time.sleep(pause)  # well inside Open-Meteo's free limits
            try:
                reading = weather.history(place, date.fromisoformat(day), today, fetch_weather)
            except Exception:
                reading = None
            if not reading:
                counts["weather_no_answer"] += 1
                continue
            if store.put_weather(user_id, day, weather.record(reading, place, at)):
                counts["weather_kept"] += 1
            else:
                counts["weather_had"] += 1
    return counts
