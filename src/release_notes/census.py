"""The operations dashboard's counts (Jamie, 2026-10-09: "an AWS dashboard
for release notes"). The sender puts them out at the end of every scheduled
run as one CloudWatch embedded-metric line, which CloudWatch turns into
metrics in the ReleaseNotes namespace.

Numbers only: no user id, no address, no note text, so the line is safe in
the logs and the dashboard shows nobody. They come from one scan of keys and
a few fields (Store.census_items), never a note's text.

    Subscribers     active and not paused today
    Paused          active, paused today
    Stopped         unsubscribed, bounced or complained
    Overdue         active and not paused, and today's email has not gone
                    though their send time was over half an hour ago. Should
                    be 0; anything else is someone missing their email.
    Notes           every note; EmailNotes, WebNotes and ImportedNotes split
                    them by source
    NotesWithMedia  notes with a photo or recording
    Writers7        subscribers with a note dated in their last 7 days,
    Writers30       or 30, today included
    ReplyRate30     of the emails sent in the 30 days before today, the
                    percent whose day has a note. Left out when none went.

"Today" is each subscriber's own, in their zone. The line goes out only
after a scheduled run, never a dry run or send_now, and a failure is logged
and never fails the run.

The dashboard (`yvn-release-notes`, behind AWS sign-in) has two other
sources: SES's `mail-metrics` event destination (sends, deliveries,
bounces, complaints, rejects, by the `release-notes-mail` tag, `daily` or
`account`; never opens or clicks), and Logs Insights over the functions'
logs.
"""

from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

NAMESPACE = "ReleaseNotes"
GRACE = timedelta(minutes=30)


def _day(sk: str) -> str:
    return sk.split("#")[1]


def _overdue(profile: dict, here: datetime) -> bool:
    today = here.date().isoformat()
    if (profile.get("last_sent_date") or "") >= today:
        return False
    hh, mm = (int(x) for x in profile.get("send_time", "06:00").split(":"))
    due = datetime.combine(here.date(), time(hh, mm), tzinfo=here.tzinfo)
    return here > due + GRACE


def counts(items: list[dict], now: datetime) -> dict:
    by_user: dict[str, list[dict]] = {}
    for item in items:
        by_user.setdefault(item["pk"], []).append(item)
    c = dict.fromkeys(
        ["Subscribers", "Paused", "Stopped", "Overdue", "Notes", "EmailNotes", "WebNotes", "ImportedNotes", "NotesWithMedia",
         "Writers7", "Writers30"], 0
    )
    sent = replied = 0
    for rows in by_user.values():
        notes = [r for r in rows if r["sk"].startswith("NOTE#")]
        web = sum(1 for n in notes if n.get("source") == "web")
        imported = sum(1 for n in notes if n.get("source") == "import")
        c["Notes"] += len(notes)
        c["WebNotes"] += web
        c["ImportedNotes"] += imported
        c["EmailNotes"] += len(notes) - web - imported
        c["NotesWithMedia"] += sum(1 for n in notes if n.get("media"))

        profile = next((r for r in rows if r["sk"] == "PROFILE"), None)
        if not profile or not profile.get("tz"):
            continue
        here = now.astimezone(ZoneInfo(profile["tz"]))
        today = here.date()
        noted = {_day(n["sk"]) for n in notes}
        if any((today - timedelta(days=6)).isoformat() <= d <= today.isoformat() for d in noted):
            c["Writers7"] += 1
        if any((today - timedelta(days=29)).isoformat() <= d <= today.isoformat() for d in noted):
            c["Writers30"] += 1
        first, last = (today - timedelta(days=30)).isoformat(), (today - timedelta(days=1)).isoformat()
        emailed = {_day(r["sk"]) for r in rows if r["sk"].startswith("DAY#")}
        recent = [d for d in emailed if first <= d <= last]
        sent += len(recent)
        replied += sum(1 for d in recent if d in noted)

        if profile.get("status", "active") != "active":
            c["Stopped"] += 1
        elif profile.get("pause_from") and profile.get("pause_through") and profile["pause_from"] <= today.isoformat() <= profile["pause_through"]:
            c["Paused"] += 1
        else:
            c["Subscribers"] += 1
            c["Overdue"] += _overdue(profile, here)
    if sent:
        c["ReplyRate30"] = round(100 * replied / sent, 1)
    return c


def line(c: dict, now: datetime) -> dict:
    """The embedded-metric line for one set of counts."""
    return {
        "_aws": {
            "Timestamp": int(now.timestamp() * 1000),
            "CloudWatchMetrics": [
                {
                    "Namespace": NAMESPACE,
                    "Dimensions": [[]],
                    "Metrics": [{"Name": k, "Unit": "Percent" if k == "ReplyRate30" else "Count"} for k in c],
                }
            ],
        },
        "event": "census",
        **c,
    }
