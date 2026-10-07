import json
import unittest
from datetime import date
from pathlib import Path

from release_notes.version import compute_version

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


if __name__ == "__main__":
    unittest.main()
