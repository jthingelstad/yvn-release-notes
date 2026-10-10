"""Photos described (describe.py): stream records and the describe_all
passes put a description on each photo. Made-up notes and the fakes."""

import base64
import json
import os
import struct
import time
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


class FakeClaude:
    """The Messages API: a body in, an answer out, or `fail` as ApiError."""

    def __init__(self, words="A red canoe pulled up on a rocky shore, pines behind it."):
        self.calls, self.words, self.fail, self.stop = [], words, None, "end_turn"

    def __call__(self, body):
        self.calls.append(body)
        if self.fail:
            raise describe.ApiError(*self.fail)
        return {"stop_reason": self.stop, "content": [
            {"type": "thinking", "thinking": "A boat by water."}] + ([{"type": "text", "text": self.words}] if self.words else [])}


class FakeSecrets:
    def __init__(self, key):
        self.key, self.asked = key, []

    def get_secret_value(self, SecretId):
        self.asked.append(SecretId)
        return {"SecretString": json.dumps({"api_key": self.key})}


class DescribeCase(unittest.TestCase):
    def setUp(self):
        self.store, self.s3, self.model, self.lam = FakeStore(), FakeS3(), FakeClaude(), FakeLambda()
        self.store.profiles["u1"] = {"email": "ada@example.com", "tz": "America/Chicago", "describe": True}
        env = mock.patch.dict(os.environ, {"TABLE": "t", "BUCKET": BUCKET, "SELF": "yvn-release-notes-describe",
                                              "SECRET": "yvn-release-notes-anthropic"})
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
            describe.handler(event, context, store=self.store, s3=self.s3, claude=self.model, lam=self.lam)
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
        self.assertEqual((call["model"], call["output_config"], call["max_tokens"]), ("claude-haiku-5-5", {"effort": "low"}, 2000))
        self.assertNotIn("temperature", call)  # Haiku 5.5 refuses one
        source = call["messages"][0]["content"][0]["source"]
        self.assertEqual((source["media_type"], base64.b64decode(source["data"])), ("image/png", png()))
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
        self.assertEqual(describe.words_for(png(9000, 100), "image/png", claude=self.model), "")
        self.assertEqual(self.model.calls, [])

    def test_a_photo_the_model_cannot_read_gets_no_words_and_is_not_tried_again(self):
        self.model.fail = (400, "invalid_request_error", True)
        n = self.keep("2026-10-09", "w-1", photo(1))
        self.run_it({"Records": [record(n)]})
        self.assertEqual(self.media()[0]["description"], "")
        self.assertEqual(describe.waiting(self.store.note("u1", "2026-10-09", "w-1")), [])

    def test_rate_limited_overloaded_or_refused_key_is_raised_so_the_stream_tries_again(self):
        n = self.keep("2026-10-09", "w-1", photo(1))
        for fail in [(429, "rate_limit_error"), (529, "overloaded_error"), (401, "authentication_error")]:
            self.model.fail = fail
            with self.assertRaises(describe.ApiError):
                self.run_it({"Records": [record(n)]})
        self.assertNotIn("description", self.media()[0])

    def test_a_request_the_api_refuses_for_every_photo_leaves_them_waiting(self):
        self.model.fail = (400, "invalid_request_error", False)  # not about the image: a bad request
        n = self.keep("2026-10-09", "w-1", photo(1))
        with self.assertRaises(describe.ApiError):
            self.run_it({"Records": [record(n)]})
        self.assertEqual(len(describe.waiting(self.store.note("u1", "2026-10-09", "w-1"))), 1)

    def test_a_refusal_or_thinking_that_used_every_token_gets_no_words(self):
        for stop, words in [("refusal", "Sorry."), ("max_tokens", "")]:
            self.model.stop, self.model.words = stop, words
            self.assertEqual(describe.words_for(png(), "image/png", claude=self.model), "")

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
        payload = self.lam.invoked[0]["Payload"]
        self.assertEqual((payload["describe_all"], len(payload["chain"])), ("u1", 32))
        self.assertEqual(self.store.locks["describe:u1"]["holder"], payload["chain"])  # still the chain's

    def test_turned_off_meanwhile_it_stops(self):
        self.store.profiles["u1"]["describe"] = False
        self.run_it({"describe_all": "u1"}, Context(900))
        self.assertEqual((self.model.calls, self.lam.invoked), ([], []))
        self.assertTrue(self.store.take_lock("describe:u1", "another", int(time.time()), 60))  # let go

    def test_one_chain_at_a_time_however_often_it_is_turned_on(self):
        # 2026-10-09 audit: each off and on started another chain over the same photos.
        self.run_it({"describe_all": "u1"}, Context(describe.LEFT_FOR_NEXT - 1))  # the first chain, handed on
        chain = self.lam.invoked[0]["Payload"]["chain"]
        logged = self.run_it({"describe_all": "u1"}, Context(900))  # turned off and on again meanwhile
        self.assertIn('"outcome":"already-running"', logged)
        self.assertEqual((self.model.calls, len(self.lam.invoked)), ([], 1))
        self.run_it({"describe_all": "u1", "chain": chain}, Context(900))  # the first chain's next pass
        self.assertEqual(len(self.model.calls), 3)
        self.run_it({"describe_all": "u1"}, Context(900))  # done and let go: a new chain may run, and finds nothing
        self.assertEqual(len(self.model.calls), 3)
        self.assertLessEqual(self.store.locks["describe:u1"]["expires_at"], time.time())

    def test_a_failed_pass_lets_go_and_its_retry_takes_the_lock_back(self):
        self.model.fail = (529, "overloaded_error")
        with self.assertRaises(describe.ApiError):
            self.run_it({"describe_all": "u1", "chain": "c1"}, Context(900))
        self.model.fail = None
        self.run_it({"describe_all": "u1", "chain": "c1"}, Context(900))
        self.assertTrue(all(m["description"] for m in self.media()))

    def test_a_photo_described_meanwhile_is_not_sent_again(self):
        note = self.store.note("u1", "2016-07-04", "d1-A")
        read_before = {**note, "media": [dict(m) for m in note["media"]]}
        ask = self.model

        def and_the_stream_too(body):  # the stream describes photo 2 while this pass does photo 1
            self.store.set_media_text("u1", "2016-07-04", "d1-A", 2, "description", "A boat.")
            return ask(body)

        with mock.patch("builtins.print"):
            done = describe.describe(read_before, "u1", store=self.store, s3=self.s3, claude=and_the_stream_too,
                                     bucket=BUCKET)
        self.assertEqual((done, len(self.model.calls)), (1, 1))
        self.assertEqual(self.media("2016-07-04", "d1-A")[1]["description"], "A boat.")

    def test_a_photo_gone_from_the_bucket_is_skipped(self):
        del self.s3.objects[photo(1)["key"]]
        self.run_it({"describe_all": "u1"}, Context(900))
        self.assertEqual(self.media()[0]["description"], "")
        self.assertEqual(len(self.model.calls), 2)


class KeyTest(DescribeCase):
    """The key comes from the secret, only when a photo needs it, and a
    placeholder sends nothing."""

    def run_with(self, secrets, event):
        with mock.patch("builtins.print") as printed:
            describe.handler(event, None, store=self.store, s3=self.s3, lam=self.lam, secrets=secrets)
        return "\n".join(str(c.args[0]) for c in printed.call_args_list)

    def test_the_placeholder_sends_nothing_and_leaves_photos_waiting(self):
        n = self.keep("2026-10-09", "w-1", photo(1))
        secrets = FakeSecrets("PASTE-ANTHROPIC-API-KEY-HERE")
        with mock.patch("urllib.request.urlopen") as sent:
            logged = self.run_with(secrets, {"Records": [record(n)]})
        sent.assert_not_called()
        self.assertIn('"outcome":"no-key"', logged)
        self.assertEqual(secrets.asked, ["yvn-release-notes-anthropic"])
        self.assertEqual(len(describe.waiting(self.store.note("u1", "2026-10-09", "w-1"))), 1)

    def test_no_photo_waiting_reads_no_key(self):
        secrets = FakeSecrets("sk-ant-test")
        self.run_with(secrets, {"Records": [record({"pk": "USER#u1", "sk": "NOTE#2026-10-09#w-2", "text": "Hi."})]})
        self.assertEqual(secrets.asked, [])

    def test_a_real_key_goes_in_the_header_once_a_run(self):
        self.keep("2026-10-09", "w-1", photo(1), photo(2))
        sent = []

        class Answer:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": "A dock."}]}).encode()

        def urlopen(req, timeout):
            sent.append((req.full_url, req.get_header("X-api-key"), req.get_header("Anthropic-version")))
            return Answer()

        secrets = FakeSecrets("sk-ant-test")
        with mock.patch("urllib.request.urlopen", urlopen):
            self.run_with(secrets, {"describe_all": "u1"})
        self.assertEqual(sent, [("https://api.anthropic.com/v1/messages", "sk-ant-test", "2023-06-01")] * 2)
        self.assertEqual(len(secrets.asked), 1)
        self.assertEqual([m["description"] for m in self.media()], ["A dock.", "A dock."])


class CheckTest(DescribeCase):
    def test_a_check_describes_a_made_up_image_and_writes_nothing(self):
        before = json.dumps(self.store.items, default=str)
        with mock.patch("builtins.print"):
            out = describe.handler({"check": True}, None, store=self.store, s3=self.s3, claude=self.model, lam=self.lam)
        self.assertEqual(out, {"ok": True, "words": self.model.words})
        self.assertEqual(describe.media.image_size(describe.test_image()), (64, 64))
        self.assertEqual(json.dumps(self.store.items, default=str), before)

    def test_a_check_says_what_went_wrong(self):
        self.model.fail = (401, "authentication_error", False)
        with mock.patch("builtins.print"):
            out = describe.handler({"check": True}, None, store=self.store, s3=self.s3, claude=self.model, lam=self.lam)
        self.assertEqual(out, {"ok": False, "status": 401, "error": "authentication_error", "about_image": False})
        with mock.patch("builtins.print"):
            out = describe.handler({"check": True}, None, store=self.store, s3=self.s3, lam=self.lam,
                                   secrets=FakeSecrets("PASTE-ANTHROPIC-API-KEY-HERE"))
        self.assertEqual(out, {"ok": False, "error": "no-key"})


if __name__ == "__main__":
    unittest.main()
