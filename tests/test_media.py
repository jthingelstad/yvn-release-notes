import struct
import unittest
from email.message import EmailMessage

from release_notes import media
from release_notes.compose import files_phrase, past_more
from release_notes.parse import parse_message


def jpeg(w, h, pad=0):
    """A JPEG header: SOI, an APP0 segment, then a baseline frame of w x h."""
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof = b"\xff\xc0" + struct.pack(">HBHHB", 17, 8, h, w, 3) + b"\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return b"\xff\xd8" + app0 + sof + b"\x00" * pad


def png(w, h, pad=0):
    return b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + struct.pack(">II", w, h) + b"\x08\x02\x00\x00\x00" + b"\x00" * pad


def reply(*files, text="Lake day.\n"):
    msg = EmailMessage()
    msg.set_content(text)
    for data, maintype, subtype, name, disposition in files:
        msg.add_attachment(data, maintype=maintype, subtype=subtype, filename=name, disposition=disposition)
    return parse_message(msg.as_bytes())


class Sizes(unittest.TestCase):
    def test_reads_the_common_headers(self):
        self.assertEqual(media.image_size(jpeg(4032, 3024)), (4032, 3024))
        self.assertEqual(media.image_size(png(640, 480)), (640, 480))
        self.assertEqual(media.image_size(b"GIF89a" + struct.pack("<HH", 320, 200) + b"\x00" * 8), (320, 200))
        vp8x = b"RIFF\x00\x00\x00\x00WEBPVP8X" + b"\x0a\x00\x00\x00" + b"\x00" * 4 + (1599).to_bytes(3, "little") + (899).to_bytes(3, "little")
        self.assertEqual(media.image_size(vp8x), (1600, 900))

    def test_unreadable_is_none(self):
        for data in (b"", b"\xff\xd8\xff", b"\xff\xd8garbage-garbage", b"ftypheic" + b"\x00" * 40, png(1, 1)[:12]):
            self.assertIsNone(media.image_size(data), data[:12])


class Types(unittest.TestCase):
    def test_types_and_aliases(self):
        self.assertEqual(media.media_type("image/jpeg", "image0.jpeg"), "image/jpeg")
        self.assertEqual(media.media_type("image/JPG", ""), "image/jpeg")
        self.assertEqual(media.media_type("audio/x-m4a", "Memo.m4a"), "audio/mp4")
        self.assertEqual(media.media_type("application/octet-stream", "IMG_0001.HEIC"), "image/heic")
        self.assertEqual(media.media_type("audio/amr", "voice.m4a"), "audio/mp4")
        for ctype, name in (("application/pdf", "a.pdf"), ("video/quicktime", "IMG.MOV"), ("image/svg+xml", "x.svg"),
                            ("application/octet-stream", "notes.txt"), ("audio/amr", "voice.amr"), ("text/plain", "a.jpg")):
            self.assertIsNone(media.media_type(ctype, name), (ctype, name))


class Found(unittest.TestCase):
    def test_photos_and_recordings_in_order_without_logos(self):
        msg = reply(
            (jpeg(4032, 3024, pad=2000), "image", "jpeg", "image0.jpeg", "inline"),
            (png(64, 64, pad=500), "image", "png", "logo.png", "inline"),  # a signature logo
            (b"\x00" * 4096, "audio", "x-m4a", "Memo.m4a", "attachment"),
            (b"%PDF-1.4" + b"\x00" * 4096, "application", "pdf", "menu.pdf", "attachment"),
            (b"\x00" * 30000, "application", "octet-stream", "IMG_0002.HEIC", "attachment"),  # unmeasured, photo-sized
            (b"\x00" * 900, "application", "octet-stream", "tiny.heic", "attachment"),  # unmeasured, too small
        )
        self.assertEqual([t for t, _ in media.found(msg)], ["image/jpeg", "audio/mp4", "image/heic"])

    def test_text_alone_has_none(self):
        self.assertEqual(media.found(reply()), [])

    def test_at_most_twenty(self):
        photos = [(png(800, 600, pad=10), "image", "png", f"p{i}.png", "attachment") for i in range(25)]
        self.assertEqual(len(media.found(reply(*photos))), media.MAX_FILES)


class Store(unittest.TestCase):
    def test_keys_and_entries(self):
        class S3:
            puts = []

            def put_object(self, **kw):
                self.puts.append(kw)

        s3 = S3()
        entries = media.store(s3, "mail", "u1", "2026-10-07", "m1", [("image/jpeg", b"abc"), ("audio/mp4", b"defg")])
        self.assertEqual(entries, [
            {"n": 1, "kind": "image", "type": "image/jpeg", "size": 3, "key": "media/u1/2026-10-07/m1/1.jpg"},
            {"n": 2, "kind": "audio", "type": "audio/mp4", "size": 4, "key": "media/u1/2026-10-07/m1/2.m4a"},
        ])
        self.assertEqual(s3.puts[0], {"Bucket": "mail", "Key": "media/u1/2026-10-07/m1/1.jpg", "Body": b"abc",
                                      "ContentType": "image/jpeg", "ContentDisposition": "inline"})
        note = {"media": entries, "attachments": [{"content_type": "image/jpeg", "filename": "image0.jpeg"},
                                                  {"content_type": "video/quicktime", "filename": "IMG.MOV"},
                                                  {"content_type": "image/png", "filename": "logo.png"}]}
        self.assertEqual(media.keys(note), ["media/u1/2026-10-07/m1/1.jpg", "media/u1/2026-10-07/m1/2.m4a"])
        self.assertEqual(media.keys({"media": [{"key": "raw/sneaky"}]}), [])
        self.assertEqual(media.others(note), 1)
        self.assertEqual(media.counts([note, {"text": "x"}, {"media": entries[:1]}]), {"image": 2, "audio": 1})


class Words(unittest.TestCase):
    def test_the_links_words(self):
        self.assertEqual(files_phrase({"image": 1}), "the photo")
        self.assertEqual(files_phrase({"image": 3, "audio": 1}), "3 photos and a recording")
        self.assertEqual(files_phrase({"image": 0, "audio": 2}), "2 recordings")
        self.assertEqual(files_phrase(None), "")
        self.assertEqual(files_phrase({"file": 1}), "the file")
        self.assertEqual(files_phrase({"image": 2, "audio": 1, "file": 1}), "2 photos, a recording and a file")
        self.assertEqual(past_more(False, {"file": 2}), "See 2 files")
        self.assertEqual(past_more(False, {"audio": 1, "file": 1}), "See the recording and a file")
        self.assertEqual(past_more(False, None), "See it")
        self.assertEqual(past_more(True, {"image": 0, "audio": 0}), "Read the rest")
        self.assertEqual(past_more(False, {"image": 2}), "See 2 photos")
        self.assertEqual(past_more(False, {"audio": 1}), "Hear the recording")
        self.assertEqual(past_more(True, {"image": 1}), "Read the rest, with the photo")


if __name__ == "__main__":
    unittest.main()
