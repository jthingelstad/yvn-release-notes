import unittest
from email.message import EmailMessage

from release_notes.parse import attachments, html_to_text, note_text, parse_message, strip_reply


def plain(text: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = "ada@example.com"
    msg.set_content(text)
    return parse_message(msg.as_bytes())


class StripReply(unittest.TestCase):
    def test_gmail_attribution_wrapped(self):
        text = (
            "Walked the dog by the lake.\n\nGood day.\n\n"
            "On Tue, Oct 7, 2026 at 8:00 PM Release Notes <\n"
            "n-abc@in.yourversionnumber.com> wrote:\n\n"
            "> You're 5.0.0 today.\n"
        )
        self.assertEqual(strip_reply(text), "Walked the dog by the lake.\n\nGood day.")

    def test_apple_mail(self):
        text = (
            "Shipped the release notes service.\n\n"
            "Sent from my iPhone\n\n"
            "> On Oct 7, 2026, at 8:00 PM, Release Notes <n-abc@in.yourversionnumber.com> wrote:\n"
            ">\n> You're 5.0.0 today.\n"
        )
        self.assertEqual(strip_reply(text), "Shipped the release notes service.")

    def test_apple_mail_unquoted_attribution(self):
        text = "Rain all day.\n\nOn Oct 7, 2026, at 20:00, Release Notes <n-abc@in.yourversionnumber.com> wrote:\n\nYou're 5.0.0 today.\n"
        self.assertEqual(strip_reply(text), "Rain all day.")

    def test_outlook(self):
        text = (
            "Board meeting went long.\n\n"
            "________________________________\n"
            "From: Release Notes <n-abc@in.yourversionnumber.com>\n"
            "Sent: Tuesday, October 7, 2026 8:00 PM\n"
            "Subject: You're 5.0.0 today\n"
        )
        self.assertEqual(strip_reply(text), "Board meeting went long.")

    def test_outlook_headers_without_rule(self):
        text = "Quiet.\n\nFrom: Release Notes <n-abc@in.yourversionnumber.com>\nDate: Tue, 7 Oct 2026\nTo: me\n"
        self.assertEqual(strip_reply(text), "Quiet.")

    def test_signature(self):
        self.assertEqual(strip_reply("Made soup.\n\n-- \nAda\nhttps://example.com\n"), "Made soup.")

    def test_keeps_sentences_that_start_with_on(self):
        text = "On the way home I saw a heron.\nOn balance, a good day."
        self.assertEqual(strip_reply(text), text)

    def test_keeps_a_from_line_that_is_not_a_header_block(self):
        text = "From: the kitchen, a smell of bread.\nThen a nap."
        self.assertEqual(strip_reply(text), text)


class Bodies(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(note_text(plain("Hello.\n\nOn Tue, Oct 7, 2026 Release Notes wrote:\n> x\n")), "Hello.")

    def test_prefers_plain_alternative(self):
        msg = EmailMessage()
        msg.set_content("Plain words.\n")
        msg.add_alternative("<p>Html words.</p>", subtype="html")
        self.assertEqual(note_text(parse_message(msg.as_bytes())), "Plain words.")

    def test_html_only_drops_gmail_quote(self):
        msg = EmailMessage()
        msg.set_content(
            '<div dir="ltr">Pancakes for dinner.<br>Kids loved it.</div><br>'
            '<div class="gmail_quote"><div class="gmail_attr">On Tue ... wrote:</div>'
            "<blockquote>You're 5.0.0 today.</blockquote></div>",
            subtype="html",
        )
        self.assertEqual(note_text(parse_message(msg.as_bytes())), "Pancakes for dinner.\nKids loved it.")

    def test_html_entities_and_blockquote(self):
        self.assertEqual(html_to_text("<p>Fish &amp; chips&nbsp;tonight</p><blockquote>quoted</blockquote>"), "Fish & chips tonight")

    def test_apple_mixed_text_around_image(self):
        msg = EmailMessage()
        msg.set_content("Before the photo.\n")
        msg.add_attachment(b"\x89PNG fake", maintype="image", subtype="png", filename="lake.png", disposition="inline")
        msg.add_attachment("After the photo.\n", disposition="inline")
        parsed = parse_message(msg.as_bytes())
        self.assertEqual(note_text(parsed), "Before the photo.\nAfter the photo.")
        self.assertEqual(attachments(parsed), [{"content_type": "image/png", "filename": "lake.png", "size": 9}])

    def test_audio_attachment_listed_not_read(self):
        msg = EmailMessage()
        msg.set_content("Voice memo attached.\n")
        msg.add_attachment(b"0" * 2048, maintype="audio", subtype="mp4", filename="memo.m4a")
        parsed = parse_message(msg.as_bytes())
        self.assertEqual(note_text(parsed), "Voice memo attached.")
        self.assertEqual(attachments(parsed), [{"content_type": "audio/mp4", "filename": "memo.m4a", "size": 2048}])


if __name__ == "__main__":
    unittest.main()
