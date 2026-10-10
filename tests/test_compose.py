import re
import unittest
from datetime import date
from email import policy
from email.parser import BytesParser

from release_notes.compose import (PAST_MAX, body, build_message, clock_phrase, countdown, html_body, late_message, linked,
                                   message_id, streak_lines, welcome_line)
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
        self.assertEqual(msg["X-Auto-Response-Suppress"], "OOF, AutoReply")

    def test_a_visible_unsubscribe_link_to_the_page_that_asks(self):
        msg = message(date(2026, 10, 8))
        link = "https://notes.yourversionnumber.com/unsubscribe/#t=abcdefghijklmnopqrstuvwx"
        self.assertIn(f"Unsubscribe: {link}", msg.get_body(("plain",)).get_content())
        self.assertIn(f'href="{link}"', msg.get_body(("html",)).get_content())
        v = compute_version(BIRTHDAY, date(2026, 10, 8))
        self.assertNotIn("Unsubscribe", body(v, BIRTHDAY) + html_body(v, BIRTHDAY, date(2026, 10, 8)))

    def test_says_reply_as_often_as_you_like(self):
        # Jamie, 2026-10-08: every reply to a day's email adds to its notes.
        msg = message(date(2026, 10, 8))
        self.assertIn("Reply as often as you like", msg.get_body(("plain",)).get_content())
        self.assertIn("Reply as often as you like", msg.get_body(("html",)).get_content())

    def test_says_photos_and_voice_memos_work(self):
        # Jamie, 2026-10-08: make sure people know a reply can carry them.
        msg = message(date(2026, 10, 8))
        self.assertIn("Photos and voice memos work too.", msg.get_body(("plain",)).get_content())
        self.assertIn("photos and voice memos work too", msg.get_body(("html",)).get_content())

    def test_welcome_only_when_asked(self):
        v = compute_version(BIRTHDAY, date(2026, 10, 8))
        line = welcome_line("06:30", "notes@yourversionnumber.com")
        self.assertEqual(line, "Welcome to Release Notes. This first one is today's; "
                               "from tomorrow it comes every day at 6:30 AM. "
                               "Add notes@yourversionnumber.com to your contacts so it never lands in junk.")
        self.assertTrue(body(v, BIRTHDAY, welcome=line).startswith(line + "\n\nYou're "))
        self.assertIn("This first one is today&#x27;s", html_body(v, BIRTHDAY, date(2026, 10, 8), welcome=line))
        self.assertNotIn("Welcome", body(v, BIRTHDAY) + html_body(v, BIRTHDAY, date(2026, 10, 8)))
        self.assertEqual(clock_phrase("00:15"), "12:15 AM")
        self.assertEqual(clock_phrase("12:00"), "12:00 PM")
        self.assertEqual(clock_phrase("20:45"), "8:45 PM")

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


class AYearAgo(unittest.TestCase):
    DAY = date(2026, 10, 8)  # 4.5.110; a year back is 4.4.110 on 2025-10-08
    THEN = date(2025, 10, 8)

    def html(self, text):
        return html_body(compute_version(BIRTHDAY, self.DAY), BIRTHDAY, self.DAY, None, (self.THEN, text))

    def test_the_section(self):
        html = self.html("Walked the river.\n\nWrote it up: https://www.example.com/2025/10/08/river/.")
        self.assertIn("A year ago</strong> &middot; Wednesday, October 8, 2025", html)
        self.assertIn('aria-label="4.5.110"', html)
        self.assertIn('4<span class="sep" style="color:#ff5a1f;">.</span>4<span class="sep" style="color:#ff5a1f;">.</span>110', html)
        self.assertIn(">Walked the river.</p>", html)
        self.assertIn('Wrote it up: <a class="link" href="https://www.example.com/2025/10/08/river/" style="color:#1a4fe0;">'
                      'example.com/2025/10/08/river</a>.</p>', html)
        self.assertIn('href="https://notes.yourversionnumber.com/day/?d=2025-10-08"', html)
        text = body(compute_version(BIRTHDAY, self.DAY), BIRTHDAY, None, (self.THEN, "Walked the river."))
        self.assertIn("A year ago you were 4.4.110 (Wednesday, October 8, 2025):\n\nWalked the river.\n\n"
                      "See it: https://notes.yourversionnumber.com/day/?d=2025-10-08\n", text)

    def test_still_type_on_paper_and_ascii(self):
        html = self.html("Caf\u00e9 with Grace \U0001F389")
        for banned in ("border:", "border-radius", "box-shadow", "<img"):
            self.assertNotIn(banned, html)
        self.assertEqual(html.count("background:"), 3)
        html.encode("ascii")
        self.assertIn("Caf&#233; with Grace &#127881;", html)

    def test_note_text_is_escaped_and_only_web_addresses_link(self):
        html = self.html('<script>x</script> javascript:alert(1) "quoted"')
        self.assertIn("&lt;script&gt;x&lt;/script&gt; javascript:alert(1) &quot;quoted&quot;", html)
        self.assertNotIn('href="javascript', html)
        self.assertEqual(linked("(see https://example.com/a)"),
                         '(see <a class="link" href="https://example.com/a" style="color:#1a4fe0;">example.com/a</a>)')

    def test_links_show_by_name(self):
        found = [{"url": "https://www.example.com/river/", "title": "Walking the river", "site": "Example Blog"},
                 {"url": "https://example.com/p", "title": "my post", "named": True}]
        text = "Wrote it up: https://www.example.com/river/ and my post <https://example.com/p>."
        html = html_body(compute_version(BIRTHDAY, self.DAY), BIRTHDAY, self.DAY, None, (self.THEN, text, found))
        self.assertIn('Wrote it up: <a class="link" href="https://www.example.com/river/" style="color:#1a4fe0;">Walking the river</a>'
                      '<span class="ink-2" style="color:#3b3d63;"> &middot; Example Blog</span> and '
                      '<a class="link" href="https://example.com/p" style="color:#1a4fe0;">my post</a>.</p>', html)
        self.assertNotIn("&lt;https://example.com/p&gt;", html)
        text_part = body(compute_version(BIRTHDAY, self.DAY), BIRTHDAY, None, (self.THEN, text, found))
        self.assertIn("Wrote it up: Walking the river <https://www.example.com/river/> and my post <https://example.com/p>.", text_part)

    def test_long_notes_are_cut_between_words(self):
        html = self.html("word " * 400)
        self.assertIn("word&#8230;</p>", html)
        self.assertIn(">Read the rest</a>", html)
        self.assertLess(html.count("word"), PAST_MAX // 5 + 1)

    def test_no_section_without_notes(self):
        self.assertNotIn("A year ago", html_body(compute_version(BIRTHDAY, self.DAY), BIRTHDAY, self.DAY))


class LateReply(unittest.TestCase):
    # The note back when a reply comes in past its 72 hours (inbound.py).

    def message(self, in_reply_to="<reply-1@mail.example.com>"):
        msg = late_message(to="ada@example.com", from_addr="notes@yourversionnumber.com", version="5.0.0",
                           day=date(2026, 10, 7), in_reply_to=in_reply_to)
        return BytesParser(policy=policy.default).parsebytes(msg.as_bytes())

    def test_says_too_late_and_links_to_the_day(self):
        msg = self.message()
        text = msg.get_body(("plain",)).get_content()
        self.assertIn("too late to be added to the release notes for 5.0.0,\nWednesday, October 7, 2026.", text)
        self.assertIn("https://notes.yourversionnumber.com/day/?d=2026-10-07", text)
        html = msg.get_body(("html",)).get_content()
        self.assertIn('href="https://notes.yourversionnumber.com/day/?d=2026-10-07"', html)
        self.assertEqual((msg["Subject"], msg["Auto-Submitted"]), ("Re: You're 5.0.0 today", "auto-replied"))

    def test_type_on_paper_nothing_remote_ascii(self):
        html = self.message().get_body(("html",)).get_content()
        for banned in ("border:", "border-radius", "box-shadow", "<img", "@import", "url(", "<link"):
            self.assertNotIn(banned, html)
        self.assertNotRegex(html, r"\ssrc=")
        for href in re.findall(r'href="([^"]+)"', html):
            self.assertTrue(href.startswith("https://notes.yourversionnumber.com/"), href)
        html.encode("ascii")

    def test_threads_only_under_a_well_formed_message_id(self):
        self.assertEqual(message_id(" <reply-1@mail.example.com> "), "<reply-1@mail.example.com>")
        for bad in (None, "", "reply-1@mail.example.com", "<a b@example.com>", "<a>\r\nBcc: eve@example.net",
                    "<a@example.com> <b@example.com>", "<" + "x" * 300 + ">"):
            self.assertIsNone(message_id(bad), bad)
        self.assertIsNone(self.message(None)["In-Reply-To"])


if __name__ == "__main__":
    unittest.main()
