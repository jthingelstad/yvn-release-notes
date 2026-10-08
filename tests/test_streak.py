import unittest
from datetime import date, timedelta

from release_notes.streak import compute_streak

TODAY = date(2026, 10, 8)


def days_ago(*ns):
    return {TODAY - timedelta(days=n) for n in ns}


class Streaks(unittest.TestCase):
    def test_no_notes(self):
        s = compute_streak(set(), TODAY)
        self.assertEqual((s.current, s.longest, s.days), (0, 0, ()))

    def test_run_ending_yesterday(self):
        s = compute_streak(days_ago(1, 2, 3), TODAY)
        self.assertEqual((s.current, s.longest), (3, 3))
        self.assertEqual(s.days, tuple(sorted(days_ago(1, 2, 3))))

    def test_missed_yesterday_ends_it_quietly(self):
        s = compute_streak(days_ago(2, 3, 4, 5), TODAY)
        self.assertEqual((s.current, s.longest), (0, 4))

    def test_longest_is_kept_after_a_break(self):
        s = compute_streak(days_ago(1, 2, 5, 6, 7, 8, 9), TODAY)
        self.assertEqual((s.current, s.longest), (2, 5))

    def test_late_reply_fills_the_gap(self):
        # A Thursday reply to Tuesday's email is Tuesday's note, so it mends the run.
        before = compute_streak(days_ago(1, 3), TODAY)
        after = compute_streak(days_ago(1, 2, 3), TODAY)
        self.assertEqual((before.current, after.current), (1, 3))

    def test_today_does_not_count(self):
        s = compute_streak(days_ago(0, 1), TODAY)
        self.assertEqual((s.current, s.longest), (1, 1))


if __name__ == "__main__":
    unittest.main()
