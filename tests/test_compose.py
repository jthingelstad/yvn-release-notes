import re
import unittest
from datetime import date
from email import policy
from email.parser import BytesParser

from release_notes.compose import build_message, countdown, html_body, streak_lines
from release_notes.streak import Streak, compute_streak
from release_notes.version import compute_version

BIRTHDAY = date(1981, 6, 20)


def message(day):
    v = compute_version(BIRTHDAY, day)
    msg = build_message(
        to="ada@example.com",
        from_addr="notes@yourversionnumber.com",
        token="abcdefghijklmnopqrstuvwx",
        inbound_domain="in.yourversionnumber.com",
        v=v,
        birthday=BIRTHDAY,
        day=day,
    )
    return BytesParser(policy=policy.default).parsebytes(msg.as_bytes())


class Email(unittest.TestCase):
    def test_plain_and_html_alternatives(self):
        msg = message(date(2026, 10, 8))
        self.assertEqual(msg.get_content_type(), "multipart/alternative")
        self.assertIn("You're 4.5.110 today.", msg.get_body(("plain",)).get_content())
        html = msg.get_body(("html",)).get_content()
        self.assertIn('aria-label="4.5.110"', html)
        self.assertIn("Thursday, October 8", html)
        self.assertEqual(msg["Subject"], "You're 4.5.110 today")

    def test_pause_or_manage_and_one_click_unsubscribe(self):
        msg = message(date(2026, 10, 8))
        self.assertIn("Pause or manage: https://notes.yourversionnumber.com/settings/", msg.get_body(("plain",)).get_content())
        self.assertIn('href="https://notes.yourversionnumber.com/settings/"', msg.get_body(("html",)).get_content())
        self.assertEqual(
            msg["List-Unsubscribe"], "<https://notes.yourversionnumber.com/api/unsubscribe?t=abcdefghijklmnopqrstuvwx>"
        )
        self.assertEqual(msg["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")

    def test_says_reply_as_often_as_you_like(self):
        # Jamie, 2026-10-08: every reply to a day's email adds to its notes.
        msg = message(date(2026, 10, 8))
        self.assertIn("Reply as often as you like", msg.get_body(("plain",)).get_content())
        self.assertIn("Reply as often as you like", msg.get_body(("html",)).get_content())

    def test_nothing_remote(self):
        # No images, fonts, stylesheets or anything else fetched on open.
        html = html_body(compute_version(BIRTHDAY, date(2026, 10, 8)), BIRTHDAY, date(2026, 10, 8))
        self.assertNotIn("<img", html)
        self.assertNotIn("@import", html)
        self.assertNotIn("url(", html)
        self.assertNotIn("<link", html)
        self.assertNotRegex(html, r"\ssrc=")
        for href in re.findall(r'href="([^"]+)"', html):
            self.assertTrue(href.startswith(("https://yourversionnumber.com/", "https://notes.yourversionnumber.com/")), href)

    def test_type_on_paper_no_boxes(self):
        # Jamie, 2026-10-07: no borders, boxes or shadows. Birthday version too.
        for day in (date(2026, 10, 8), date(2027, 6, 20)):
            html = html_body(compute_version(BIRTHDAY, day), BIRTHDAY, day)
            for banned in ("border:", "border-radius", "box-shadow"):
                self.assertNotIn(banned, html)
            self.assertEqual(html.count("background:"), 3, "only the page paper, light and dark")

    def test_birthday_and_countdown(self):
        v = compute_version(BIRTHDAY, date(2027, 6, 20))
        self.assertIn("Happy birthday: a new release.", html_body(v, BIRTHDAY, date(2027, 6, 20)))
        self.assertEqual(countdown(compute_version(BIRTHDAY, date(2027, 6, 19))), "4.6.0 ships tomorrow.")
        self.assertEqual(countdown(compute_version(date(1977, 1, 3), date(2026, 10, 8))), "5.0.0 ships in 87 days.")


    def test_number_stands_alone(self):
        # Jamie, 2026-10-07: the decades/years/days breakdown was redundant.
        html = html_body(compute_version(BIRTHDAY, date(2026, 10, 8)), BIRTHDAY, date(2026, 10, 8))
        for gone in ("decades", "years in", "days since your birthday"):
            self.assertNotIn(gone, html)

    def test_html_stays_ascii(self):
        day = date(2026, 10, 8)
        streak = compute_streak({date(2026, 10, 6), date(2026, 10, 7)}, day)
        html_body(compute_version(BIRTHDAY, day), BIRTHDAY, day, streak).encode("ascii")

    def test_year_dots(self):
        v = compute_version(BIRTHDAY, date(2026, 10, 8))  # 110 days of 365 in
        html = html_body(v, BIRTHDAY, date(2026, 10, 8))
        self.assertEqual(html.count("&#9679;"), 24)
        self.assertIn('class="dot-on" style="color:#ff5a1f;">' + "&#9679;" * 7 + "<", html)


class StreakCopy(unittest.TestCase):
    v = compute_version(BIRTHDAY, date(2026, 10, 8))

    def lines(self, current, longest):
        return streak_lines(self.v, Streak(current=current, longest=longest, days=()))

    def test_first_ever(self):
        self.assertEqual(self.lines(0, 0), ("Every reply starts a streak.", "Today's can be the first."))

    def test_after_a_break_shows_the_longest(self):
        self.assertEqual(self.lines(0, 12), ("Every reply starts a streak.", "Your longest so far is 12 days."))

    def test_one_day(self):
        self.assertEqual(self.lines(1, 1), ("1 day in a row.", "Reply today and 4.5.110 makes it 2."))

    def test_longest_yet(self):
        self.assertEqual(self.lines(5, 5), ("5 days in a row, your longest yet.", "Reply today and 4.5.110 makes it 6."))

    def test_below_the_longest(self):
        self.assertEqual(
            self.lines(4, 12), ("4 days in a row.", "Your longest is 12 days. Reply today and 4.5.110 makes it 5.")
        )

    def test_email_shows_the_run_by_patch_number(self):
        day = date(2026, 10, 8)
        streak = compute_streak({date(2026, 10, 6), date(2026, 10, 7)}, day)
        msg = build_message(
            to="ada@example.com",
            from_addr="notes@yourversionnumber.com",
            token="abcdefghijklmnopqrstuvwx",
            inbound_domain="in.yourversionnumber.com",
            v=self.v,
            birthday=BIRTHDAY,
            day=day,
            streak=streak,
        )
        parsed = BytesParser(policy=policy.default).parsebytes(msg.as_bytes())
        self.assertIn("2 days in a row, your longest yet. Reply today and 4.5.110 makes it 3.", parsed.get_body(("plain",)).get_content())
        html = parsed.get_body(("html",)).get_content()
        self.assertRegex(html, r">108</span>.*>109</span>.*>110</span>")

    def test_no_number_row_without_a_run(self):
        html = html_body(self.v, BIRTHDAY, date(2026, 10, 8), Streak(current=0, longest=12, days=()))
        self.assertIn("Your longest so far is 12&nbsp;days.", html)
        self.assertNotIn('class="streak-row"', html)

    def test_no_streak_section_without_a_streak(self):
        html = html_body(self.v, BIRTHDAY, date(2026, 10, 8))
        self.assertNotIn("in a row", html)
        self.assertNotIn("streak", html.split("</style>")[1])


if __name__ == "__main__":
    unittest.main()
