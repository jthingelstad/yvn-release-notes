import unittest
from datetime import date, timedelta

from release_notes.streak import compute_streak, pause_days

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


    def test_paused_days_neither_break_nor_add(self):
        # Notes 1 and 5 days ago, paused 2 to 4: one run of two.
        s = compute_streak(days_ago(1, 5), TODAY, paused=days_ago(2, 3, 4))
        self.assertEqual((s.current, s.longest, s.days), (2, 2, tuple(sorted(days_ago(1, 5)))))
        self.assertEqual(compute_streak(days_ago(1, 5), TODAY).current, 1)

    def test_a_pause_running_now_holds_the_run(self):
        s = compute_streak(days_ago(3, 4), TODAY, paused=days_ago(0, 1, 2))
        self.assertEqual((s.current, s.longest), (2, 2))

    def test_a_note_on_a_paused_day_counts(self):
        s = compute_streak(days_ago(1, 2, 3), TODAY, paused=days_ago(2))
        self.assertEqual(s.current, 3)

    def test_pause_days(self):
        days = pause_days([("2026-10-06", "2026-10-12"), ("2026-01-01", "2026-01-02")], TODAY)
        self.assertEqual(days, days_ago(0, 1, 2) | {date(2026, 1, 1), date(2026, 1, 2)})


if __name__ == "__main__":
    unittest.main()
