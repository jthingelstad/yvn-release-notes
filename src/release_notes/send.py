"""The daily sender. EventBridge runs it on every quarter hour.

Each run sends to every active subscriber whose local send time has arrived
today and who has not had today's email yet. The window is three hours, so a
missed run catches up but an outage never sends a 3 a.m. email.

Invoke with {"dry_run": true} (and optionally {"now": "<ISO 8601 UTC>"}) to
see who would get what without writing or sending anything. "now" is for dry
runs only: a real send always uses the real clock, so sent_at is when the
email actually went.

Invoke with {"send_now": "<user id>"} to send that subscriber today's email
straight away, outside their send window. It is still once per local day.
Sign-up does this (web.send_first), so a new subscriber's first email is
today's, at once, with a welcome line, and the schedule starts tomorrow.

The email carries "On this day": the notes from every earlier release on
today's patch number (5.3.279, 5.2.279 ... for 5.4.279), when there are
any, and a line of lifetime counts. Above those, "Yesterday": the
subscriber's own yesterday's notes, so the email confirms they came
through; the note index says whether there are any, so a day without
costs no read. A dry run reports those days, whether yesterday shows and
its files, and the note count, never the text.

Photos go in the email inside the message (compose.py): the thumbnails
(thumbs.py) of Yesterday's photos first, then each "On this day" day's,
up to compose's limits, read from the bucket only once chosen. The
function may read thumbnails and nothing else there (its role names
`*.thumb.jpg`). A photo whose thumbnail cannot be read is left out; any
other failure leaves them all out, never the email. A dry run reads them
too, and reports how many and their bytes.

A paused subscriber gets nothing on the days of the pause (pause_from through
pause_through, in their own zone), send_now included.

For a subscriber with a city, one call to Open-Meteo (weather.py) brings
yesterday's weather, which is kept, and today's forecast, which goes in the
email as one line. A dry run fetches it too but keeps nothing. If the call
fails, the email goes without, and so does the rest of that run's mail
(`one_run`), so a slow Open-Meteo never holds the sender.
"""

import json
import os
import time as time_module
from dataclasses import replace
from datetime import date, datetime, time, timedelta, timezone
from email.utils import make_msgid
from zoneinfo import ZoneInfo

from . import census, media, tags, weather
from .compose import (MAIL_TAG, PHOTO_BYTES, PHOTOS_A_DAY, PHOTOS_AN_EMAIL, SHOWN, Inline, Lifetime, OnThisDay,
                      PastDay, Yesterday, build_message, from_header, new_token, welcome_line)
from .notes import combine, day_links, map_url, place_label, written_at
from .store import Store, Subscriber
from .streak import Streak, compute_streak, pause_days
from .version import compute_version, same_day_before

WINDOW = timedelta(hours=3)
# Stop starting sends with this much of the function's time left; the next
# quarter hour's run sends the rest, inside the window.
RESERVE_MS = 20_000
# Weather for a whole run gets this long; past it the rest go without.
WEATHER_BUDGET = 30.0
# The dashboard's counts need this much of the function's time left.
CENSUS_MS = 10_000
# Yesterday's own place, when Yesterday did not read it (no notes).
UNREAD = object()

# Fail at cold start, not at someone's send time, if the runtime ever ships
# without a zone database (zoneinfo reads the system's; there is no tzdata pin).
ZoneInfo("America/Chicago")


def local_now(now_utc: datetime, tz: str) -> datetime:
    return now_utc.astimezone(ZoneInfo(tz))


def is_due(sub: Subscriber, now_local: datetime) -> bool:
    today = now_local.date().isoformat()
    if sub.last_sent_date and sub.last_sent_date >= today:
        return False
    hh, mm = (int(x) for x in sub.send_time.split(":"))
    start = datetime.combine(now_local.date(), time(hh, mm), tzinfo=now_local.tzinfo)
    end = min(start + WINDOW, datetime.combine(now_local.date() + timedelta(days=1), time(0), tzinfo=now_local.tzinfo))
    return start <= now_local < end


def log(**fields):
    # Ids and outcomes only. Addresses and note text never go to logs.
    print(json.dumps(fields, separators=(",", ":")))


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def read_streak(store: Store, user_id: str, day: date) -> Streak | None:
    # The streak is a nicety. If it cannot be read, the day's email still goes.
    try:
        return compute_streak(store.note_days(user_id), day, pause_days(store.pauses(user_id), day))
    except Exception as e:
        log(event="streak-error", user=user_id, date=day.isoformat(), error=type(e).__name__)
        return None


def read_history(store: Store, sub: Subscriber, day: date) -> tuple[OnThisDay | None, Lifetime | None, Yesterday | None,
                                                                   list[dict], object]:
    """"On this day", the lifetime counts and yesterday's notes and own
    place (shown, and as read, for where yesterday's weather was: the place
    is UNREAD when Yesterday did not need it), from one read of every
    note's key and media. All are niceties: on any failure the email goes
    without."""
    try:
        index = store.note_index(sub.user_id)
    except Exception as e:
        log(event="history-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        return None, None, None, [], UNREAD
    days = {d for d, _ in index}
    life = Lifetime(notes=len(index), days=len(days), photos=sum(n for _, n in index),
                    since=int(min(days)[:4])) if index else None
    yesterday, notes, own = read_yesterday(store, sub, day, days)
    return read_on_this_day(store, sub, day, days), life, yesterday, notes, own


def read_yesterday(store: Store, sub: Subscriber, day: date, have: set[str]) -> tuple[Yesterday | None, list[dict],
                                                                                    object]:
    """The subscriber's yesterday (`day` is already their local today), read
    whole only when the index says it has notes, its notes and its own
    place (UNREAD when it was not read)."""
    then = day - timedelta(days=1)
    if then.isoformat() not in have:
        return None, [], UNREAD
    try:
        notes = store.day_notes(sub.user_id, then.isoformat())
        if not notes:
            return None, [], UNREAD
        own = store.day_place(sub.user_id, then.isoformat())
        # Any note shows, even one whose only file stayed in the email (a
        # PDF, a video): the block is there to say it came through.
        text = combine(notes)
        return Yesterday(then, text, day_links(notes), media.counts(notes), tuple(tags.found(text)),
                         sum(media.others(n) for n in notes),
                         places=places_of(notes, own), thumbs=thumbs_of(sub, notes)), notes, own
    except Exception as e:
        log(event="yesterday-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        return None, [], UNREAD


def places_of(notes: list[dict], own: dict | None = None) -> tuple[tuple[str, str | None], ...]:
    """The day's own place (PLACE#<day>) first, as the web shows it, then
    each place the day's notes name, once, in the order written, with its
    map link (web.note_view). Once is the name and the link together: the
    same name somewhere else, or linked where the first was the unlinked
    home city, is shown too."""
    out: dict[tuple[str, str | None], None] = {}
    if own and (name := place_label(own)):
        out[(name, map_url(own))] = None
    for n in sorted(notes, key=written_at):
        if n.get("place") and (name := place_label(n["place"])):
            out.setdefault((name, map_url(n["place"])), None)
    return tuple(out)


def thumbs_of(sub: Subscriber, notes: list[dict]) -> tuple[dict, ...]:
    """The day's photos that have a thumbnail under the subscriber's own
    prefix, in order, with their alt text: the description only for a
    subscriber who turned descriptions on."""
    out = []
    for note in notes:
        for m in note.get("media") or []:
            t = m.get("thumb") or {}
            if m.get("kind") == "image" and str(t.get("key", "")).startswith(f"media/{sub.user_id}/"):
                out.append({"key": str(t["key"]), "size": int(t.get("size") or 0), "width": int(t.get("width") or 0),
                            "height": int(t.get("height") or 0),
                            "alt": (str(m.get("description") or "") if sub.describe else "") or "Photo"})
    return tuple(out)


def with_photos(sub: Subscriber, day: date, yesterday: Yesterday | None, past: OnThisDay | None, s3):
    """Choose the email's photos, Yesterday's first, and read them. Returns
    the blocks with their photos and {cid: bytes}. On any failure, none."""
    if not any(b.thumbs for b in ([yesterday] if yesterday else []) + (list(past.shown) if past else [])):
        return yesterday, past, {}
    images, domain = {}, os.environ["FROM_ADDRESS"].split("@", 1)[1]

    def take(block):
        chosen = []
        for t in block.thumbs:
            if len(chosen) == PHOTOS_A_DAY or len(images) == PHOTOS_AN_EMAIL:
                break
            if sum(map(len, images.values())) + t["size"] > PHOTO_BYTES:
                break
            try:
                data = s3().get_object(Bucket=os.environ["BUCKET"], Key=t["key"])["Body"].read()
            except Exception as e:
                if ((getattr(e, "response", None) or {}).get("Error") or {}).get("Code") != "NoSuchKey":
                    raise
                log(event="photo-missing", user=sub.user_id, date=day.isoformat())
                continue
            cid = make_msgid("photo", domain)[1:-1]
            images[cid] = data
            chosen.append(Inline(cid, t["alt"], t["width"], t["height"]))
        return replace(block, photos=tuple(chosen))

    try:
        yesterday = take(yesterday) if yesterday else None
        past = replace(past, shown=tuple(take(p) for p in past.shown)) if past else None
        return yesterday, past, images
    except Exception as e:
        log(event="photos-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        strip = lambda b: replace(b, photos=())  # noqa: E731
        return (strip(yesterday) if yesterday else None,
                replace(past, shown=tuple(strip(p) for p in past.shown)) if past else None, {})


def read_on_this_day(store: Store, sub: Subscriber, day: date, have: set[str]) -> OnThisDay | None:
    try:
        found = [d for d in same_day_before(sub.birthday, day) if d.isoformat() in have]
        shown = []
        for then in found[:SHOWN]:
            notes = store.day_notes(sub.user_id, then.isoformat())
            text, files = combine(notes), media.counts(notes)
            if not (text or any(files.values())):
                continue
            kept = store.weather_between(sub.user_id, then.isoformat(), then.isoformat()).get(then.isoformat())
            sky = weather.day_line(kept, weather.fahrenheit(sub.place or kept)) if kept else None
            shown.append(PastDay(then, text, day_links(notes), files, sky, tuple(tags.found(text)), thumbs_of(sub, notes)))
        if not shown:
            return None
        return OnThisDay(tuple(shown), tuple(found[SHOWN:]))
    except Exception as e:
        log(event="on-this-day-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        return None


def read_weather(store: Store, sub: Subscriber, day: date, fetch, keep: bool, clock, notes=(),
                 own=UNREAD) -> str | None:
    """Today's forecast as the email's line; yesterday's weather is kept
    (unless `keep` is False, for a dry run) where the subscriber was
    (weather.day_place: the day's own place, `own` if Yesterday read it,
    else its notes'), which for another place than their city costs one
    more fetch. None without a city or on any failure."""
    if not sub.place:
        return None
    try:
        yesterday, today = weather.morning(sub.place, day, fetch)
        if keep:
            then = day - timedelta(days=1)
            if own is UNREAD:
                own = store.day_place(sub.user_id, then.isoformat())
            where = weather.day_place(own, list(notes), sub.tz)
            if where and not weather.same_place(sub.place, where):
                yesterday, at = weather.history(where, then, day, fetch), where
            else:
                at = sub.place
            if yesterday:
                store.put_weather(sub.user_id, then.isoformat(), weather.record(yesterday, at, clock().isoformat()))
        return weather.forecast_line(today, sub.place.get("city", ""), weather.fahrenheit(sub.place)) if today else None
    except Exception as e:
        log(event="weather-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        return None


def one_run(fetch, budget=WEATHER_BUDGET, timer=time_module.monotonic):
    """The fetch for one run: answers are shared (neighbors ask the same
    question), and the first failure turns weather off for the rest of the
    run, so an unreachable Open-Meteo costs one timeout, not one an email.
    A slow one is held to `budget` seconds for the run in all."""
    answers, broken, spent = {}, [], [0.0]

    def call(url):
        if broken or spent[0] >= budget:
            raise RuntimeError("weather is off for this run")
        if url not in answers:
            start = timer()
            try:
                answers[url] = fetch(url)
            except Exception:
                broken.append(url)
                raise
            finally:
                spent[0] += timer() - start
        return answers[url]
    return call


def handler(event, context, *, store: Store | None = None, ses=None, clock=utc_now, fetch=None, s3=None):
    event = event or {}
    dry_run = bool(event.get("dry_run"))
    if event.get("now") and not dry_run:
        raise ValueError('"now" is for dry runs only; use "send_now" to send outside the window')
    now = datetime.fromisoformat(event["now"]) if event.get("now") else clock()
    send_now = event.get("send_now")
    fetch = one_run(fetch or weather.fetch_morning)
    if store is None:
        import boto3

        store = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
    if ses is None and not dry_run:
        import boto3

        ses = boto3.client("sesv2")
    made = {}

    def bucket():
        # Made only when an email has a photo to read.
        if s3 is not None:
            return s3
        if "s3" not in made:
            import boto3

            made["s3"] = boto3.client("s3")
        return made["s3"]

    if send_now:
        sub = store.get_subscriber(send_now)
        if sub is None or sub.status != "active":
            raise ValueError("send_now: no active subscriber with that id")
        subs = [sub]
    else:
        subs = store.active_subscribers()

    results, failed = [], 0
    for sub in subs:
        here = local_now(now, sub.tz)
        day = here.date().isoformat()
        v = compute_version(sub.birthday, here.date())
        if send_now:
            if sub.last_sent_date and sub.last_sent_date >= day:
                log(event="skip", user=sub.user_id, date=day, reason="already-sent")
                results.append({"user": sub.user_id, "date": day, "outcome": "already-sent"})
                continue
        elif not is_due(sub, here):
            continue
        if context is not None and context.get_remaining_time_in_millis() < RESERVE_MS:
            log(event="out-of-time", user=sub.user_id, date=day)
            break
        if sub.paused_on(day):
            # Not logged on a schedule run: it would repeat every quarter hour.
            if send_now:
                log(event="skip", user=sub.user_id, date=day, reason="paused")
                results.append({"user": sub.user_id, "date": day, "outcome": "paused"})
            continue
        if dry_run:
            streak = read_streak(store, sub.user_id, here.date())
            past, life, yesterday, notes, own = read_history(store, sub, here.date())
            yesterday, past, images = with_photos(sub, here.date(), yesterday, past, bucket)
            forecast = read_weather(store, sub, here.date(), fetch, False, clock, notes, own)
            results.append(
                {
                    "user": sub.user_id,
                    "date": day,
                    "version": str(v),
                    "local": here.isoformat(),
                    "streak": streak.current if streak else None,
                    "longest": streak.longest if streak else None,
                    "on_this_day": [p.day.isoformat() for p in past.shown] + [d.isoformat() for d in past.more]
                    if past else [],
                    "on_this_day_weather": bool(past and any(p.sky for p in past.shown)),
                    "yesterday": yesterday.day.isoformat() if yesterday else None,
                    "yesterday_files": {**{k: n for k, n in (yesterday.files or {}).items() if n},
                                        **({"others": yesterday.others} if yesterday.others else {})} if yesterday else {},
                    "notes": life.notes if life else None,
                    "photos": len(images),
                    "photo_bytes": sum(map(len, images.values())),
                    "forecast": bool(forecast),
                }
            )
            continue
        try:
            results.append(send_one(store, ses, sub, day, v, clock, fetch, bucket))
        except Exception:
            # One bad address must not hold up everyone else. The run still
            # fails at the end so the Errors alarm sees it.
            failed += 1
    log(event="run", now=now.isoformat(), dry_run=dry_run, send_now=bool(send_now), due=len(results) + failed, failed=failed)
    if not (dry_run or send_now):
        report(store, now, context)
    if failed:
        raise RuntimeError(f"{failed} send(s) failed")
    return {"dry_run": dry_run, "now": now.isoformat(), "results": results}


def report(store: Store, now: datetime, context) -> None:
    """The dashboard's counts (census.py), once a scheduled run is done. A
    failure here is logged and never fails the run."""
    if context is not None and context.get_remaining_time_in_millis() < CENSUS_MS:
        log(event="census-skipped")
        return
    try:
        print(json.dumps(census.line(census.counts(store.census_items(), now), now), separators=(",", ":")))
    except Exception as e:
        log(event="census-error", error=type(e).__name__)


def send_one(store: Store, ses, sub: Subscriber, day: str, v, clock, fetch=None, bucket=None) -> dict:
    previous = sub.last_sent_date
    # The slow parts come before the claim, so a run that times out in them
    # has claimed nothing and the next run sends this one.
    streak = read_streak(store, sub.user_id, date.fromisoformat(day))
    past, life, yesterday, notes, own = read_history(store, sub, date.fromisoformat(day))
    yesterday, past, images = with_photos(sub, date.fromisoformat(day), yesterday, past, bucket) if bucket \
        else (yesterday, past, {})
    forecast = read_weather(store, sub, date.fromisoformat(day), fetch or weather.fetch_morning, True, clock, notes,
                            own)
    if not store.claim_day(sub.user_id, day):
        log(event="skip", user=sub.user_id, date=day, reason="already-claimed")
        return {"user": sub.user_id, "date": day, "outcome": "already-claimed"}
    token = new_token()
    try:
        store.put_day(sub.user_id, day, str(v), token, clock().isoformat())
        msg = build_message(
            to=sub.email,
            from_addr=os.environ["FROM_ADDRESS"],
            token=token,
            inbound_domain=os.environ["INBOUND_DOMAIN"],
            v=v,
            birthday=sub.birthday,
            day=date.fromisoformat(day),
            streak=streak,
            past=past,
            lifetime=life,
            yesterday=yesterday,
            images=images,
            forecast=forecast,
            # Nothing sent before means this is the one sign-up sends.
            welcome=welcome_line(sub.send_time, os.environ["FROM_ADDRESS"]) if previous is None else None,
        )
        resp = ses.send_email(
            FromEmailAddress=from_header(os.environ["FROM_ADDRESS"]),
            Destination={"ToAddresses": [sub.email]},
            Content={"Raw": {"Data": msg.as_bytes()}},
            ConfigurationSetName=os.environ["CONFIG_SET"],
            EmailTags=[{"Name": MAIL_TAG, "Value": "daily"}],
        )
    except Exception as e:
        store.release_day(sub.user_id, day, previous)
        try:
            store.drop_day(sub.user_id, day, token)  # no orphaned reply address
        except Exception:
            log(event="drop-day-failed", user=sub.user_id, date=day)
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        log(event="error", user=sub.user_id, date=day, error=type(e).__name__, code=code)
        raise
    store.set_day_message_id(sub.user_id, day, resp["MessageId"])
    log(event="sent", user=sub.user_id, date=day, version=str(v))
    return {"user": sub.user_id, "date": day, "version": str(v), "outcome": "sent"}
