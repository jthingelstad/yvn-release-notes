import json
import unittest
from datetime import date, timedelta
from pathlib import Path

from release_notes.version import a_year_before, compute_version

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


class AYearBefore(unittest.TestCase):
    def test_same_patch_one_release_back(self):
        self.assertEqual(a_year_before(date(1972, 1, 3), date(2026, 10, 9)), date(2025, 10, 9))  # 5.4.279 -> 5.3.279

    def test_every_answer_is_the_same_patch_a_release_back(self):
        for birthday in (date(1972, 1, 3), date(1972, 2, 29), date(1980, 3, 1), date(1990, 12, 31)):
            day = date(2023, 1, 1)
            while day < date(2029, 1, 1):
                then = a_year_before(birthday, day)
                v = compute_version(birthday, day)
                if then is not None:
                    was = compute_version(birthday, then)
                    self.assertEqual((was.age, was.patch), (v.age - 1, v.patch), (birthday, day))
                else:
                    self.assertEqual(v.patch, v.cycle_days - 1, (birthday, day))  # only a 366th day has no match
                day += timedelta(days=1)

    def test_the_366th_day_has_no_match(self):
        # Born Jan 1: 2028 is a leap year, so Dec 31 2028 is patch 365; 2027 stopped at 364.
        self.assertIsNone(a_year_before(date(1980, 1, 1), date(2028, 12, 31)))

    def test_nothing_before_the_first_birthday(self):
        self.assertIsNone(a_year_before(date(2026, 1, 1), date(2026, 10, 9)))


if __name__ == "__main__":
    unittest.main()
