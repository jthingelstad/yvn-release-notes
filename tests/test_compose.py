import re
import unittest
from datetime import date
from email import policy
from email.parser import BytesParser

from release_notes.compose import build_message, countdown, html_body
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

    def test_nothing_remote(self):
        # No images, fonts, stylesheets or anything else fetched on open.
        html = html_body(compute_version(BIRTHDAY, date(2026, 10, 8)), BIRTHDAY, date(2026, 10, 8))
        self.assertNotIn("<img", html)
        self.assertNotIn("@import", html)
        self.assertNotIn("url(", html)
        self.assertNotIn("<link", html)
        self.assertNotRegex(html, r"\ssrc=")
        for href in re.findall(r'href="([^"]+)"', html):
            self.assertTrue(href.startswith("https://yourversionnumber.com/"), href)

    def test_birthday_and_countdown(self):
        v = compute_version(BIRTHDAY, date(2027, 6, 20))
        self.assertIn("Happy birthday: a new release.", html_body(v, BIRTHDAY, date(2027, 6, 20)))
        self.assertEqual(countdown(compute_version(BIRTHDAY, date(2027, 6, 19))), "4.6.0 ships tomorrow.")
        self.assertEqual(countdown(compute_version(date(1977, 1, 3), date(2026, 10, 8))), "5.0.0 ships in 87 days.")


if __name__ == "__main__":
    unittest.main()
