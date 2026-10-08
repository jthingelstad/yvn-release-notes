"""The birthday version number, ported from yourversionnumber.com.

This must give the same answer as `computeVersion` in the site's
`birthday/assets/app.js` for every date. `tests/fixtures/versions.json` is
generated from the site's own function (`scripts/gen-version-fixtures.mjs`)
and `tests/test_version.py` holds this port to it. Change the site's
arithmetic and this file in the same week, and regenerate the fixtures.
"""

from calendar import isleap
from dataclasses import dataclass
from datetime import date, timedelta


@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    age: int
    cycle_days: int
    days_until: int

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


def anniversary(year: int, month: int, day: int) -> date:
    # The site builds this with JS `new Date(y, 1, 29)`, which rolls a Feb 29
    # birthday to March 1 in a common year. That is the spec, so match it.
    if month == 2 and day == 29 and not isleap(year):
        return date(year, 3, 1)
    return date(year, month, day)


def compute_version(birthday: date, today: date) -> Version:
    year = today.year
    last = anniversary(year, birthday.month, birthday.day)
    if today < last:
        year -= 1
        last = anniversary(year, birthday.month, birthday.day)
    nxt = anniversary(year + 1, birthday.month, birthday.day)
    age = year - birthday.year
    return Version(
        major=age // 10,
        minor=age % 10,
        patch=(today - last).days,
        age=age,
        cycle_days=(nxt - last).days,
        days_until=(nxt - today).days,
    )


def a_year_before(birthday: date, today: date) -> date | None:
    """The day a year back with the same patch number: 5.3.279 for 5.4.279.
    By version, not calendar: the same count of days into the previous
    release. None before the first birthday, or on the last day of a 366-day
    cycle, which the 365-day one before it has no match for."""
    v = compute_version(birthday, today)
    if v.age == 0:
        return None
    start = anniversary(birthday.year + v.age - 1, birthday.month, birthday.day)
    end = anniversary(birthday.year + v.age, birthday.month, birthday.day)
    day = start + timedelta(days=v.patch)
    return day if day < end else None
