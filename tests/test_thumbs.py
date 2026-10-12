"""Thumbnails (thumbs.py): made once for each photo, listed on its entry,
deleted with it; the one-off pass over photos already kept. Pillow is only
in the describe function's layer, so most tests pass a fake maker; the
real one is tested where Pillow is installed."""

import io
import json
import os
import sys
import unittest
from decimal import Decimal
from unittest import mock

from fakes import FakeLambda, FakeS3, FakeStore
from release_notes import describe, media, thumbs
from test_describe import png
from test_transcribe import record

BUCKET = "mail"

try:
    import PIL  # noqa: F401
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


def photo(n, ctype="image/jpeg", ext="jpg", note_id="w-1", **more):
    return {"n": Decimal(n), "kind": "image", "type": ctype, "size": Decimal(900_000),
            "key": f"media/u1/2026-10-09/{note_id}/{n}.{ext}", **more}


def fake_maker(data):
    return (b"small:" + data[:4], 640, 480) if data != b"unreadable" else None


class Case(unittest.TestCase):
    def setUp(self):
        self.store, self.s3, self.lam = FakeStore(), FakeS3(), FakeLambda()
        self.store.profiles["u1"] = {"email": "ada@example.com", "tz": "America/Chicago"}
        env = mock.patch.dict(os.environ, {"TABLE": "t", "BUCKET": BUCKET, "SELF": "yvn-release-notes-describe",
                                              "SECRET": "yvn-release-notes-anthropic"})
        env.start()
        self.addCleanup(env.stop)

    def keep(self, *media_, note_id="w-1", body=b"\xff\xd8\xff photo"):
        for m in media_:
            self.s3.put_object(BUCKET, m["key"], body, ContentType=m["type"])
        self.store.add_note("u1", "2026-10-09", note_id, text="", media=[dict(m) for m in media_])
        return self.store.note("u1", "2026-10-09", note_id)


class Keys(unittest.TestCase):
    def test_beside_the_photo(self):
        self.assertEqual(thumbs.thumb_key("media/u1/2026-10-09/0100abc/2.jpg"), "media/u1/2026-10-09/0100abc/2.thumb.jpg")
        self.assertEqual(thumbs.thumb_key("media/u1/files/f-9.png"), "media/u1/files/f-9.thumb.jpg")

    def test_waiting_is_readable_photos_without_one(self):
        note = {"media": [photo(1), photo(2, thumb={}), photo(3, "image/heic", "heic"),
                          {"n": 4, "kind": "audio", "type": "audio/mp4", "key": "media/u1/x/4.m4a"},
                          photo(5, "image/png", "png"), {**photo(6), "key": "raw/elsewhere.jpg"}]}
        self.assertEqual([int(m["n"]) for m in thumbs.waiting(note)], [1, 5])
        self.assertEqual(thumbs.counts([note]), {"notes": 1, "photos": 2, "bytes": 1_800_000, "left": {"image/heic": 1}})

    def test_deleting_a_note_deletes_its_thumbnails(self):
        note = {"media": [photo(1, thumb={"key": "media/u1/2026-10-09/w-1/1.thumb.jpg", "size": 9}), photo(2, thumb={})]}
        self.assertEqual(media.keys(note), ["media/u1/2026-10-09/w-1/1.jpg", "media/u1/2026-10-09/w-1/1.thumb.jpg",
                                            "media/u1/2026-10-09/w-1/2.jpg"])


class Making(Case):
    def test_made_beside_the_photo_and_listed_on_it(self):
        note = self.keep(photo(1), photo(2, "image/png", "png"))
        with mock.patch("builtins.print"):
            self.assertEqual(thumbs.thumbnail(note, "u1", store=self.store, s3=self.s3, bucket=BUCKET, maker=fake_maker), 2)
        got = self.store.note("u1", "2026-10-09", "w-1")["media"]
        self.assertEqual(got[0]["thumb"], {"key": "media/u1/2026-10-09/w-1/1.thumb.jpg", "size": 10, "width": 640, "height": 480})
        self.assertEqual(got[1]["thumb"]["key"], "media/u1/2026-10-09/w-1/2.thumb.jpg")
        kept = self.s3.objects["media/u1/2026-10-09/w-1/1.thumb.jpg"]
        self.assertEqual((kept["ContentType"], kept["Body"]), ("image/jpeg", b"small:\xff\xd8\xff "))
        self.assertEqual(self.s3.objects["media/u1/2026-10-09/w-1/1.jpg"]["Body"], b"\xff\xd8\xff photo")  # untouched

    def test_one_that_cannot_be_made_is_marked_and_not_tried_again(self):
        note = self.keep(photo(1), body=b"unreadable")
        thumbs.thumbnail(note, "u1", store=self.store, s3=self.s3, bucket=BUCKET, maker=fake_maker)
        self.assertEqual(self.store.note("u1", "2026-10-09", "w-1")["media"][0]["thumb"], {})
        self.assertEqual(thumbs.waiting(self.store.note("u1", "2026-10-09", "w-1")), [])
        self.assertFalse(any(k.endswith(".thumb.jpg") for k in self.s3.objects))

    def test_a_photo_gone_from_the_bucket_gets_none(self):
        note = self.keep(photo(1))
        del self.s3.objects[photo(1)["key"]]
        thumbs.thumbnail(note, "u1", store=self.store, s3=self.s3, bucket=BUCKET, maker=fake_maker)
        self.assertEqual(self.store.note("u1", "2026-10-09", "w-1")["media"][0]["thumb"], {})

    def test_a_note_deleted_meanwhile_takes_its_thumbnail_with_it(self):
        note = self.keep(photo(1))
        self.store.delete_note("u1", "2026-10-09", "w-1")
        thumbs.thumbnail(note, "u1", store=self.store, s3=self.s3, bucket=BUCKET, maker=fake_maker)
        self.assertNotIn("media/u1/2026-10-09/w-1/1.thumb.jpg", self.s3.objects)

    def test_the_stream_makes_them_for_everyone_and_describes_only_for_those_who_asked(self):
        note = self.keep(photo(1))
        model = mock.Mock()
        with mock.patch("builtins.print"):
            describe.handler({"Records": [record({"pk": "USER#u1", "sk": note["sk"], "media": note["media"]})]}, None,
                             store=self.store, s3=self.s3, claude=model, lam=self.lam, maker=fake_maker)
        entry = self.store.note("u1", "2026-10-09", "w-1")["media"][0]
        self.assertIn("thumb", entry)
        self.assertNotIn("description", entry)
        model.assert_not_called()

    def test_without_pillow_photos_wait(self):
        note = self.keep(photo(1))
        r = record({"pk": "USER#u1", "sk": note["sk"], "media": note["media"]})
        r["dynamodb"]["Keys"] = {"pk": {"S": "USER#u1"}, "sk": {"S": note["sk"]}}
        with mock.patch.dict(sys.modules, {"PIL": None}), mock.patch("builtins.print") as printed:
            describe.handler({"Records": [r]}, None,
                             store=self.store, s3=self.s3, claude=mock.Mock(), lam=self.lam)
        self.assertNotIn("thumb", self.store.note("u1", "2026-10-09", "w-1")["media"][0])
        self.assertIn('"outcome":"no-pillow"', " ".join(str(c.args[0]) for c in printed.call_args_list))


class AllOfThem(Case):
    def test_a_dry_run_counts_and_writes_nothing(self):
        self.keep(photo(1), photo(2, "image/heic", "heic"))
        self.keep(photo(1, note_id="w-2"), note_id="w-2")
        with mock.patch("builtins.print"):
            out = describe.handler({"thumbs_all": "*", "dry_run": True}, None, store=self.store, s3=self.s3,
                                   claude=mock.Mock(), lam=self.lam, maker=fake_maker)
        self.assertEqual(out, {"users": 1, "notes": 2, "photos": 2, "bytes": 1_800_000, "left": {"image/heic": 1},
                               "made": 0, "more": False})
        self.assertFalse(any(k.endswith(".thumb.jpg") for k in self.s3.objects))
        self.assertNotIn("thumb", self.store.note("u1", "2026-10-09", "w-1")["media"][0])

    def test_a_pass_makes_them_and_hands_on_near_its_limit(self):
        self.keep(photo(1))
        self.keep(photo(1, note_id="w-2"), note_id="w-2")
        left = iter([600, 30])
        with mock.patch("builtins.print"):
            out = thumbs.thumbs_all(["u1"], store=self.store, s3=self.s3, lam=self.lam, bucket=BUCKET,
                                    time_left=lambda: next(left), maker=fake_maker)
        self.assertEqual((out["made"], out["more"]), (1, True))
        self.assertEqual(self.lam.invoked[0]["Payload"], {"thumbs_all": ["u1"]})
        with mock.patch("builtins.print"):
            out = thumbs.thumbs_all(["u1"], store=self.store, s3=self.s3, lam=self.lam, bucket=BUCKET,
                                    time_left=lambda: 600, maker=fake_maker)
        self.assertEqual((out["made"], out["more"]), (1, False))

    def test_a_real_pass_without_pillow_refuses(self):
        with mock.patch.dict(sys.modules, {"PIL": None}), mock.patch("builtins.print"):
            out = describe.handler({"thumbs_all": "u1"}, None, store=self.store, s3=self.s3, claude=mock.Mock(),
                                   lam=self.lam)
        self.assertEqual(out, {"error": "no-pillow"})


@unittest.skipUnless(HAVE_PIL, "Pillow is in the describe function's layer only")
class RealPillow(unittest.TestCase):
    def jpeg(self, size=(4032, 3024), orientation=6, gps=True):
        from PIL import Image

        img = Image.new("RGB", size)
        px = img.load()
        for x in range(0, size[0], 16):  # some detail, so it does not compress to nothing
            for y in range(0, size[1], 16):
                px[x, y] = ((x * 7) % 256, (y * 5) % 256, (x + y) % 256)
        exif = Image.Exif()
        exif[0x0112] = orientation
        if gps:
            exif[0x8825] = {1: "N", 2: (44.0, 58.0, 0.0), 3: "W", 4: (93.0, 15.0, 0.0)}
        out = io.BytesIO()
        img.save(out, "JPEG", quality=92, exif=exif)
        return out.getvalue()

    def test_upright_small_and_without_the_originals_metadata(self):
        from PIL import Image

        body, width, height = thumbs.make(self.jpeg())
        self.assertEqual((width, height), (480, 640))  # orientation 6 turns it upright
        self.assertLessEqual(len(body), thumbs.TARGET)
        small = Image.open(io.BytesIO(body))
        self.assertEqual((small.format, small.size), ("JPEG", (480, 640)))
        self.assertEqual(dict(small.getexif()), {})  # no GPS, no time, no orientation

    def test_transparency_goes_on_paper(self):
        from PIL import Image

        out = io.BytesIO()
        Image.new("RGBA", (800, 400), (0, 0, 0, 0)).save(out, "PNG")
        body, width, height = thumbs.make(out.getvalue())
        self.assertEqual((width, height), (640, 320))
        self.assertEqual(Image.open(io.BytesIO(body)).getpixel((10, 10))[:2], thumbs.PAPER[:2])

    def test_a_busy_photo_is_made_smaller_until_it_fits(self):
        import random

        from PIL import Image

        rnd = random.Random(7)
        img = Image.frombytes("RGB", (640, 480), bytes(rnd.getrandbits(8) for _ in range(640 * 480 * 3)))
        out = io.BytesIO()
        img.save(out, "JPEG", quality=95)
        body, width, height = thumbs.make(out.getvalue())
        self.assertLessEqual(len(body), thumbs.TARGET)
        self.assertLess(width, thumbs.LONGEST)
        self.assertGreaterEqual(width, thumbs.SMALLEST)

    def test_not_an_image_or_a_bomb_is_none(self):
        self.assertIsNone(thumbs.make(b"\xff\xd8\xff not really"))
        self.assertIsNone(thumbs.make(png(30000, 30000)))


if __name__ == "__main__":
    unittest.main()
