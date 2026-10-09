"""Photos described (describe.py): stream records and the describe_all
passes put a description on each photo. Made-up notes and the fakes."""

import json
import os
import struct
import unittest
import zlib
from decimal import Decimal
from unittest import mock

from fakes import FakeLambda, FakeS3, FakeStore
from release_notes import describe
from test_transcribe import record

BUCKET = "mail"


def png(width=640, height=480):
    """A PNG's signature and header, enough for media.image_size."""
    head = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + struct.pack(">I", 13) + b"IHDR" + head
            + struct.pack(">I", zlib.crc32(b"IHDR" + head)) + b"\x00" * 64)


def photo(n, day="2026-10-09", note_id="w-1", ctype="image/png", size=9000, ext="png"):
    return {"n": Decimal(n), "kind": "image", "type": ctype, "size": Decimal(size),
            "key": f"media/u1/{day}/{note_id}/{n}.{ext}"}


M4A = {"n": Decimal(9), "kind": "audio", "type": "audio/mp4", "size": Decimal(9000), "key": "media/u1/2026-10-09/w-1/9.m4a"}


class FakeBedrock:
    def __init__(self, words="A red canoe pulled up on a rocky shore, pines behind it.", refuse=None):
        self.calls, self.words, self.refuse = [], words, refuse

    def converse(self, **kw):
        self.calls.append(kw)
        if self.refuse:
            e = Exception("no")
            e.response = {"Error": {"Code": self.refuse}}
            raise e
        return {"output": {"message": {"role": "assistant", "content": [{"text": self.words}]}}}


class DescribeCase(unittest.TestCase):
    def setUp(self):
        self.store, self.s3, self.model, self.lam = FakeStore(), FakeS3(), FakeBedrock(), FakeLambda()
        self.store.profiles["u1"] = {"email": "ada@example.com", "tz": "America/Chicago", "describe": True}
        env = mock.patch.dict(os.environ, {"TABLE": "t", "BUCKET": BUCKET, "SELF": "yvn-release-notes-describe"})
        env.start()
        self.addCleanup(env.stop)

    def keep(self, day, note_id, *media):
        for m in media:
            self.s3.put_object(BUCKET, m["key"], png() if m["kind"] == "image" else b"audio", ContentType=m["type"])
        self.store.add_note("u1", day, note_id, text="", media=[dict(m) for m in media])
        n = self.store.note("u1", day, note_id)
        return {"pk": "USER#u1", "sk": n["sk"], "text": "", "media": [dict(m) for m in media]}

    def media(self, day="2026-10-09", note_id="w-1"):
        return self.store.note("u1", day, note_id)["media"]

    def run_it(self, event, context=None):
        with mock.patch("builtins.print") as printed:
            describe.handler(event, context, store=self.store, s3=self.s3, bedrock=self.model, lam=self.lam)
        return "\n".join(str(c.args[0]) for c in printed.call_args_list)


class StreamTest(DescribeCase):
    def test_a_note_with_photos_has_each_described_and_nothing_else_sent(self):
        n = self.keep("2026-10-09", "w-1", photo(1), M4A, photo(2, ctype="image/heic", ext="heic"))
        logged = self.run_it({"Records": [record(n, name="INSERT")]})
        self.assertEqual(self.media()[0]["description"], "A red canoe pulled up on a rocky shore, pines behind it.")
        self.assertNotIn("description", self.media()[1])  # a recording
        self.assertNotIn("description", self.media()[2])  # HEIC: Bedrock can't read it
        call = self.model.calls[0]
        self.assertEqual(len(self.model.calls), 1)
        self.assertEqual(call["modelId"], describe.MODEL)
        image = call["messages"][0]["content"][0]["image"]
        self.assertEqual((image["format"], image["source"]["bytes"]), ("png", png()))
        self.assertNotIn("canoe", logged)  # a description never goes in the logs

    def test_nothing_is_sent_unless_its_owner_turned_it_on(self):
        n = self.keep("2026-10-09", "w-1", photo(1))
        self.store.profiles["u1"]["describe"] = False
        self.run_it({"Records": [record(n)]})
        del self.store.profiles["u1"]["describe"]
        self.run_it({"Records": [record(n)]})
        self.assertEqual(self.model.calls, [])

    def test_an_old_record_of_a_note_since_described_sends_nothing(self):
        n = self.keep("2026-10-09", "w-1", photo(1))
        self.run_it({"Records": [record(n)]})
        self.run_it({"Records": [record(n)]})  # this function's own write, with the note as it was before
        self.assertEqual(len(self.model.calls), 1)

    def test_too_big_to_send_is_left_alone(self):
        n = self.keep("2026-10-09", "w-1", photo(1, size=describe.MAX_BYTES + 1))
        self.run_it({"Records": [record(n)]})
        self.assertEqual(self.model.calls, [])
        self.assertNotIn("description", self.media()[0])

    def test_wider_than_the_model_takes_is_done_with_no_words(self):
        self.assertEqual(describe.words_for(png(9000, 100), "image/png", bedrock=self.model), "")
        self.assertEqual(self.model.calls, [])

    def test_a_photo_the_model_cannot_read_gets_no_words_and_is_not_tried_again(self):
        self.model.refuse = "ValidationException"
        n = self.keep("2026-10-09", "w-1", photo(1))
        self.run_it({"Records": [record(n)]})
        self.assertEqual(self.media()[0]["description"], "")
        self.assertEqual(describe.waiting(self.store.note("u1", "2026-10-09", "w-1")), [])

    def test_throttled_is_raised_so_the_stream_tries_again(self):
        self.model.refuse = "ThrottlingException"
        n = self.keep("2026-10-09", "w-1", photo(1))
        with self.assertRaises(Exception):
            self.run_it({"Records": [record(n)]})
        self.assertNotIn("description", self.media()[0])

    def test_long_words_are_cut_and_runs_of_space_closed_up(self):
        self.model.words = "  A dock.\n\n  " + "x" * 2000
        n = self.keep("2026-10-09", "w-1", photo(1))
        self.run_it({"Records": [record(n)]})
        said = self.media()[0]["description"]
        self.assertTrue(said.startswith("A dock. xxx"))
        self.assertEqual(len(said), describe.MAX_DESCRIPTION)

    def test_turning_it_on_starts_describe_all_and_nothing_else(self):
        profile = {"pk": "USER#u1", "sk": "PROFILE", "describe": True}
        self.run_it({"Records": [record(profile, {**profile, "describe": False})]})
        self.assertEqual(self.lam.invoked, [{"FunctionName": "yvn-release-notes-describe", "InvocationType": "Event",
                                             "Payload": {"describe_all": "u1"}}])
        self.run_it({"Records": [record(profile, profile)]})  # already on: some other setting changed
        self.assertEqual(len(self.lam.invoked), 1)


class Context:
    def __init__(self, seconds):
        self.seconds = seconds

    def get_remaining_time_in_millis(self):
        return self.seconds * 1000


class DescribeAllTest(DescribeCase):
    def setUp(self):
        super().setUp()
        self.keep("2016-07-04", "d1-A", photo(1, "2016-07-04", "d1-A"), photo(2, "2016-07-04", "d1-A"))
        self.keep("2026-10-09", "w-1", photo(1))

    def test_every_photo_already_kept_is_described(self):
        self.run_it({"describe_all": "u1"}, Context(900))
        self.assertEqual(len(self.model.calls), 3)
        self.assertTrue(all(m["description"] for m in self.media("2016-07-04", "d1-A") + self.media()))
        self.assertEqual(self.lam.invoked, [])

    def test_short_on_time_it_hands_the_rest_to_another_pass(self):
        self.run_it({"describe_all": "u1"}, Context(describe.LEFT_FOR_NEXT - 1))
        self.assertEqual(self.model.calls, [])
        self.assertEqual(self.lam.invoked[0]["Payload"], {"describe_all": "u1"})

    def test_turned_off_meanwhile_it_stops(self):
        self.store.profiles["u1"]["describe"] = False
        self.run_it({"describe_all": "u1"}, Context(900))
        self.assertEqual((self.model.calls, self.lam.invoked), ([], []))

    def test_a_photo_gone_from_the_bucket_is_skipped(self):
        del self.s3.objects[photo(1)["key"]]
        self.run_it({"describe_all": "u1"}, Context(900))
        self.assertEqual(self.media()[0]["description"], "")
        self.assertEqual(len(self.model.calls), 2)


if __name__ == "__main__":
    unittest.main()
