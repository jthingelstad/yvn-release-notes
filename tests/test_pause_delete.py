import re
from email import message_from_bytes
from email.policy import default

from fakes import FakeS3
from test_web import WebCase

# NOW is 17:53 in Chicago on 2026-10-08; Ada's email goes at 06:00.


class PauseCase(WebCase):
    def setUp(self):
        super().setUp()
        self.subscribe()
        self.store.profiles["u1"]["last_sent_date"] = "2026-10-08"
        self.cookies = [self.signed_in()]

    def pause(self, body, **kw):
        return self.call("PUT", "/api/pause", body, cookies=self.cookies, **kw)

    def resume(self):
        return self.call("DELETE", "/api/pause", cookies=self.cookies)


class PauseTest(PauseCase):
    def test_pause_starts_after_todays_email(self):
        r, body = self.pause({"days": 3})
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(body["pause"], {"from": "2026-10-09", "through": "2026-10-11"})
        self.assertEqual(self.store.pauses("u1"), [("2026-10-09", "2026-10-11")])
        _, me = self.call("GET", "/api/me", cookies=self.cookies)
        self.assertEqual(me["pause"], {"from": "2026-10-09", "through": "2026-10-11"})

    def test_pause_holds_back_today_when_its_email_has_not_gone(self):
        self.store.profiles["u1"]["last_sent_date"] = "2026-10-07"
        _, me = self.call("GET", "/api/me", cookies=self.cookies)
        self.assertEqual(me["pause_starts"], "2026-10-08")
        _, body = self.pause({"through": "2026-10-08"})
        self.assertEqual(body["pause"], {"from": "2026-10-08", "through": "2026-10-08"})

    def test_lengths_are_checked(self):
        for body, error in [
            ({"days": 0}, "days"), ({"days": 61}, "days"), ({"days": "3"}, "days"), ({"days": True}, "days"),
            ({"through": "2026-10-08"}, "through"),  # before the pause would start
            ({"through": "2026-12-08"}, "through"),  # 61 days
            ({"through": "soon"}, "through"), ({}, "through"),
        ]:
            r, out = self.pause(body)
            self.assertEqual((r["statusCode"], out["error"]), (400, error), body)
        r, out = self.pause({"through": "2026-12-07"})  # 60 days
        self.assertEqual(r["statusCode"], 200)

    def test_changing_a_running_pause_keeps_its_start(self):
        self.store.put_pause("u1", "2026-10-06", "2026-10-10", "x")
        _, body = self.pause({"days": 7})
        self.assertEqual(body["pause"], {"from": "2026-10-06", "through": "2026-10-12"})
        self.assertEqual(self.store.pauses("u1"), [("2026-10-06", "2026-10-12")])

    def test_changing_a_pause_not_yet_begun_replaces_it(self):
        self.store.put_pause("u1", "2026-10-20", "2026-10-25", "x")
        _, body = self.pause({"days": 2})
        self.assertEqual(body["pause"], {"from": "2026-10-09", "through": "2026-10-10"})
        self.assertEqual(self.store.pauses("u1"), [("2026-10-09", "2026-10-10")])

    def test_resume_keeps_the_days_already_paused(self):
        self.store.put_pause("u1", "2026-10-06", "2026-10-10", "x")
        r, body = self.resume()
        self.assertEqual((r["statusCode"], "pause" in body), (200, False))
        self.assertEqual(self.store.pauses("u1"), [("2026-10-06", "2026-10-07")])
        self.assertNotIn("pause_from", self.store.profiles["u1"])

    def test_resume_drops_a_pause_not_yet_begun(self):
        self.store.put_pause("u1", "2026-10-09", "2026-10-10", "x")
        self.resume()
        self.assertEqual(self.store.pauses("u1"), [])
        r, _ = self.resume()  # nothing to resume: still fine
        self.assertEqual(r["statusCode"], 200)

    def test_a_stopped_subscriber_cannot_pause(self):
        self.store.stop("u1", "unsubscribed", "x")
        r, body = self.pause({"days": 3})
        self.assertEqual((r["statusCode"], body["error"]), (400, "stopped"))

    def test_pause_needs_our_origin(self):
        r, _ = self.pause({"days": 3}, origin="https://evil.example")
        self.assertEqual(r["statusCode"], 403)

    def test_today_and_the_timeline_show_the_pause(self):
        self.store.add_note("u1", "2026-10-03", "a", text="x", received_at="2026-10-03T12:00:00Z")
        self.store.add_note("u1", "2026-10-04", "b", text="x", received_at="2026-10-04T12:00:00Z")
        self.store.put_pause("u1", "2026-10-05", "2026-10-09", "x")
        _, today = self.call("GET", "/api/today", cookies=self.cookies)
        self.assertEqual(today["paused_through"], "2026-10-09")
        self.assertEqual(today["streak"], {"current": 2, "longest": 2, "today": False})
        _, days = self.call("GET", "/api/days", cookies=self.cookies)
        self.assertEqual(
            [(d["date"], d.get("paused", False)) for d in days["days"]],
            [("2026-10-08", True), ("2026-10-07", True), ("2026-10-06", True), ("2026-10-05", True),
             ("2026-10-04", False), ("2026-10-03", False)],
        )


class DeleteTest(PauseCase):
    def setUp(self):
        super().setUp()
        self.store.add_day_token("u1", "2026-10-07", "abcdefghijklmnopqrstuvwx")
        self.store.add_note("u1", "2026-10-07", "0100abc", text="Kept.", received_at="2026-10-07T12:00:00Z",
                            raw_key="raw/0100abc", media=[{"n": 1, "kind": "image", "type": "image/jpeg", "size": 9,
                                                           "key": "media/u1/2026-10-07/0100abc/1.jpg"}])
        self.store.add_note("u1", "2026-10-06", "w-1", text="Web.", source="web", received_at="2026-10-06T12:00:00Z")
        self.store.put_pause("u1", "2026-10-01", "2026-10-02", "x")

    def code(self):
        r, _ = self.call("POST", "/api/me/delete-code", cookies=self.cookies)
        self.assertEqual(r["statusCode"], 202)
        msg = message_from_bytes(self.ses.sent[-1]["Content"]["Raw"]["Data"], policy=default)
        self.assertEqual(msg["To"], "ada@example.com")
        return re.fullmatch(r"(\d{6}) confirms deleting your Release Notes", msg["Subject"]).group(1)

    def delete(self, code, **kw):
        return self.call("DELETE", "/api/me", {"code": code}, cookies=self.cookies, **kw)

    def test_delete_everything_with_a_fresh_code(self):
        code = self.code()
        wrong = "000000" if code != "000000" else "111111"
        r, body = self.delete(wrong)
        self.assertEqual((r["statusCode"], body["error"]), (400, "wrong-code"))
        self.assertIn("u1", self.store.profiles)
        r, _ = self.delete(code)
        self.assertEqual(r["statusCode"], 200)
        self.assertIn("Max-Age=0", r["cookies"][0])
        self.assertEqual((self.store.profiles, self.store.emails, self.store.tokens), ({}, {}, {}))
        self.assertEqual(self.store.items["u1"], [])
        self.assertEqual(self.s3.deleted, [{"Bucket": "mail-bucket", "Key": "raw/0100abc"},
                                           {"Bucket": "mail-bucket", "Key": "media/u1/2026-10-07/0100abc/1.jpg"}])
        r, _ = self.call("GET", "/api/me", cookies=self.cookies)
        self.assertEqual(r["statusCode"], 401)
        self.assertNotIn("ada@example.com", self.out.getvalue())
        # The address can start over.
        _, token, _ = self.start()
        _, again = self.call("POST", "/api/auth/verify", {"token": token})
        self.assertTrue(again["new"])

    def test_the_code_is_used_up(self):
        code = self.code()
        self.delete(code)
        r, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        self.assertEqual((r["statusCode"], body["error"]), (400, "code-used"))

    def test_if_the_emails_cannot_be_deleted_nothing_is(self):
        code = self.code()
        self.s3 = FakeS3(fail=True)
        r, body = self.delete(code)
        self.assertEqual((r["statusCode"], body["error"]), (502, "delete-failed"))
        self.assertIn("u1", self.store.profiles)
        self.assertEqual(len(self.store.items["u1"]), 4)

    def test_needs_a_code_a_session_and_our_origin(self):
        r, body = self.delete("")
        self.assertEqual((r["statusCode"], body["error"]), (400, "email-and-code"))
        r, _ = self.call("DELETE", "/api/me", {"code": "123456"})
        self.assertEqual(r["statusCode"], 401)
        r, _ = self.delete("123456", origin="https://evil.example")
        self.assertEqual(r["statusCode"], 403)
        r, _ = self.call("POST", "/api/me/delete-code", cookies=self.cookies, origin=None)
        self.assertEqual(r["statusCode"], 403)
        self.assertIn("u1", self.store.profiles)
