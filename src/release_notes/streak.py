"""Reply streaks: days in a row with a note, up to and including yesterday.

A note belongs to the day of the email it answers, so a late reply to an
earlier email fills that day in, and a streak can be mended after the fact
(Jamie, 2026-10-07: "we don't need to be obsessive"). A missed day ends the
streak quietly; the email then shows the longest one instead.

Today never counts: its email is the one asking.

Paused days (Jamie's default, docs/WEB-APP.md) neither break a run nor add
to it: the run steps over them. A paused day with a note counts like any
other day with a note.
"""

from dataclasses import dataclass
from datetime import date, timedelta

ONE_DAY = timedelta(days=1)


@dataclass(frozen=True)
class Streak:
    current: int  # days in a row with a note, ending yesterday
    longest: int  # the longest run there has been, the current one included
    days: tuple[date, ...]  # the current run, oldest first


def compute_streak(note_days, today: date, paused=frozenset()) -> Streak:
    have = {d for d in note_days if d < today}
    skip = {d for d in paused if d < today} - have
    run, d = [], today - ONE_DAY
    while d in have or d in skip:
        if d in have:
            run.append(d)
        d -= ONE_DAY
    longest, length, prev = 0, 0, None
    for d in sorted(have):
        joined = prev is not None and all(prev + ONE_DAY * k in skip for k in range(1, (d - prev).days))
        length = length + 1 if joined else 1
        longest = max(longest, length)
        prev = d
    return Streak(current=len(run), longest=longest, days=tuple(reversed(run)))


def pause_days(pauses, until: date) -> set[date]:
    """The days inside pauses, [(from, through)] as ISO dates, up to until."""
    days = set()
    for start, through in pauses:
        d, end = date.fromisoformat(start), min(date.fromisoformat(through), until)
        while d <= end:
            days.add(d)
            d += ONE_DAY
    return days
