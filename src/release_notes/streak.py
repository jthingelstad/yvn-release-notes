"""Reply streaks: days in a row with a note, up to and including yesterday.

A note belongs to the day of the email it answers, so a late reply to an
earlier email fills that day in, and a streak can be mended after the fact
(Jamie, 2026-10-07: "we don't need to be obsessive"). A missed day ends the
streak quietly; the email then shows the longest one instead.

Today never counts: its email is the one asking.
"""

from dataclasses import dataclass
from datetime import date, timedelta

ONE_DAY = timedelta(days=1)


@dataclass(frozen=True)
class Streak:
    current: int  # days in a row with a note, ending yesterday
    longest: int  # the longest run there has been, the current one included
    days: tuple[date, ...]  # the current run, oldest first


def compute_streak(note_days, today: date) -> Streak:
    have = {d for d in note_days if d < today}
    run, d = [], today - ONE_DAY
    while d in have:
        run.append(d)
        d -= ONE_DAY
    longest, length, prev = 0, 0, None
    for d in sorted(have):
        length = length + 1 if prev is not None and d - prev == ONE_DAY else 1
        longest = max(longest, length)
        prev = d
    return Streak(current=len(run), longest=longest, days=tuple(reversed(run)))
