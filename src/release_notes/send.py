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

The email carries the notes from a year ago, by version (5.3.279 for
5.4.279), when there are any. A dry run reports that day, never the text.

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
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from . import census, media, weather
from .compose import MAIL_TAG, build_message, from_header, new_token, welcome_line
from .notes import combine, day_links
from .store import Store, Subscriber
from .streak import Streak, compute_streak, pause_days
from .version import a_year_before, compute_version

WINDOW = timedelta(hours=3)
# Stop starting sends with this much of the function's time left; the next
# quarter hour's run sends the rest, inside the window.
RESERVE_MS = 20_000
# Weather for a whole run gets this long; past it the rest go without.
WEATHER_BUDGET = 30.0
# The dashboard's counts need this much of the function's time left.
CENSUS_MS = 10_000

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


def read_last_year(store: Store, sub: Subscriber, day: date) -> tuple[date, str, list, dict, str | None] | None:
    # Also a nicety: if last year's notes cannot be read, the email goes without.
    try:
        then = a_year_before(sub.birthday, day)
        notes = store.day_notes(sub.user_id, then.isoformat()) if then else []
        text, files = combine(notes), media.counts(notes)
        if not (text or any(files.values())):
            return None
        kept = store.weather_between(sub.user_id, then.isoformat(), then.isoformat()).get(then.isoformat())
        sky = weather.day_line(kept, weather.fahrenheit(sub.place or kept)) if kept else None
        return then, text, day_links(notes), files, sky
    except Exception as e:
        log(event="last-year-error", user=sub.user_id, date=day.isoformat(), error=type(e).__name__)
        return None


def read_weather(store: Store, sub: Subscriber, day: date, fetch, keep: bool, clock) -> str | None:
    """Today's forecast as the email's line; yesterday's weather is kept
    (unless `keep` is False, for a dry run). None without a city or on any
    failure."""
    if not sub.place:
        return None
    try:
        yesterday, today = weather.morning(sub.place, day, fetch)
        if keep and yesterday:
            store.put_weather(sub.user_id, (day - timedelta(days=1)).isoformat(),
                              weather.record(yesterday, sub.place, clock().isoformat()))
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


def handler(event, context, *, store: Store | None = None, ses=None, clock=utc_now, fetch=None):
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
            last_year = read_last_year(store, sub, here.date())
            forecast = read_weather(store, sub, here.date(), fetch, False, clock)
            results.append(
                {
                    "user": sub.user_id,
                    "date": day,
                    "version": str(v),
                    "local": here.isoformat(),
                    "streak": streak.current if streak else None,
                    "longest": streak.longest if streak else None,
                    "last_year": last_year[0].isoformat() if last_year else None,
                    "last_year_weather": bool(last_year and last_year[4]),
                    "forecast": bool(forecast),
                }
            )
            continue
        try:
            results.append(send_one(store, ses, sub, day, v, clock, fetch))
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


def send_one(store: Store, ses, sub: Subscriber, day: str, v, clock, fetch=None) -> dict:
    previous = sub.last_sent_date
    # The slow parts come before the claim, so a run that times out in them
    # has claimed nothing and the next run sends this one.
    streak = read_streak(store, sub.user_id, date.fromisoformat(day))
    last_year = read_last_year(store, sub, date.fromisoformat(day))
    forecast = read_weather(store, sub, date.fromisoformat(day), fetch or weather.fetch_morning, True, clock)
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
            last_year=last_year,
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
