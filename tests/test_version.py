import json
import unittest
from datetime import date, timedelta
from pathlib import Path

from release_notes.version import compute_version, same_day_before

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "versions.json").read_text())


class VersionParity(unittest.TestCase):
    """Every case was produced by the site's own computeVersion."""

    def test_matches_site(self):
        fields = FIXTURES["fields"]
        self.assertGreater(len(FIXTURES["cases"]), 5000)
        for row in FIXTURES["cases"]:
            case = dict(zip(fields, row))
            v = compute_version(date.fromisoformat(case["birthday"]), date.fromisoformat(case["today"]))
            got = (v.major, v.minor, v.patch, v.age, v.cycle_days, v.days_until)
            want = tuple(case[k] for k in ("major", "minor", "patch", "age", "cycleDays", "daysUntil"))
            self.assertEqual(got, want, case)

    def test_leap_day_birthday(self):
        self.assertEqual(str(compute_version(date(1972, 2, 29), date(2027, 3, 1))), "5.5.0")
        self.assertEqual(str(compute_version(date(1972, 2, 29), date(2028, 2, 29))), "5.6.0")

    def test_decade(self):
        self.assertEqual(str(compute_version(date(1976, 10, 7), date(2026, 10, 7))), "5.0.0")


class SameDayBefore(unittest.TestCase):
    def test_every_release_back_newest_first(self):
        days = same_day_before(date(1972, 1, 3), date(2026, 10, 9))  # 5.4.279
        self.assertEqual(days[:2], [date(2025, 10, 9), date(2024, 10, 8)])  # 2024 was a leap year
        self.assertEqual(len(days), 54)
        self.assertEqual(days[-1], date(1972, 10, 8))  # 0.0.279

    def test_every_answer_has_the_same_patch(self):
        for birthday in (date(1972, 1, 3), date(1972, 2, 29), date(1980, 3, 1), date(1990, 12, 31)):
            day = date(2023, 1, 1)
            while day < date(2029, 1, 1):
                v = compute_version(birthday, day)
                days = same_day_before(birthday, day)
                ages = [compute_version(birthday, d).age for d in days]
                self.assertEqual(ages, sorted(ages, reverse=True), (birthday, day))
                for then in days:
                    was = compute_version(birthday, then)
                    self.assertEqual(was.patch, v.patch, (birthday, day))
                    self.assertLess(was.age, v.age)
                if v.patch < 365:
                    self.assertEqual(len(days), v.age, (birthday, day))  # only a 366th day can miss a release
                day += timedelta(days=1)

    def test_the_366th_day_skips_365_day_releases(self):
        # Born Jan 1: 2028 is a leap year, so Dec 31 2028 is patch 365; 2027 stopped at 364.
        days = same_day_before(date(1980, 1, 1), date(2028, 12, 31))
        self.assertTrue(all(compute_version(date(1980, 1, 1), d).patch == 365 for d in days))
        self.assertEqual(days[0], date(2024, 12, 31))

    def test_nothing_before_the_first_birthday(self):
        self.assertEqual(same_day_before(date(2026, 1, 1), date(2026, 10, 9)), [])


if __name__ == "__main__":
    unittest.main()
