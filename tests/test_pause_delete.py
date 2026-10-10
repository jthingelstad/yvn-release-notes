import re
from email import message_from_bytes
from email.policy import default

from fakes import FakeS3
from release_notes import auth
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

    def test_a_reply_saved_during_the_delete_is_deleted_too(self):
        # A reply already past its checks writes after the first read.
        code, delete_keys = self.code(), self.store.delete_keys

        def late_reply(keys):
            delete_keys(keys)
            if {"pk": "USER#u1", "sk": "PROFILE"} in keys:
                self.store.add_note("u1", "2026-10-08", "0100late", text="Late.", received_at="2026-10-08T12:00:00Z",
                                    raw_key="raw/0100late")
        self.store.delete_keys = late_reply
        r, _ = self.delete(code)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.store.items["u1"], [])
        self.assertIn({"Bucket": "mail-bucket", "Key": "raw/0100late"}, self.s3.deleted)
        self.assertEqual(self.store.tallied, {("2026-10", "deletes"): 1})

    def test_the_code_is_used_up_and_the_sign_ins_go_with_the_account(self):
        code = self.code()
        self.assertEqual(len(self.store.logins), 2)  # the sign-in setUp used, and the deletion code
        self.delete(code)
        self.assertEqual((self.store.logins, self.store.newest), ({}, {}))
        r, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        self.assertEqual((r["statusCode"], body["error"]), (400, "code-expired"))

    def test_every_browser_is_signed_out(self):
        # Another browser signed in before, and one from before the
        # sessions were listed under the subscriber, renewed since.
        other = self.signed_in()
        older = self.signed_in()
        old_hash = auth.digest(older.split("=", 1)[1])
        self.store.items["u1"] = [i for i in self.store.items["u1"] if i["sk"] != f"SESSION#{old_hash}"]
        self.now += auth.SESSION_TOUCH
        self.assertEqual(self.call("GET", "/api/me", cookies=[older])[0]["statusCode"], 200)
        self.assertIn(f"SESSION#{old_hash}", [i["sk"] for i in self.store.items["u1"]])
        code = self.code()
        r, _ = self.delete(code)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.store.sessions, {})
        for cookie in (other, older):
            self.assertEqual(self.call("GET", "/api/me", cookies=[cookie])[0]["statusCode"], 401)

    def test_a_sign_in_code_does_not_delete(self):
        self.code()
        _, _, signin = self.start()
        r, body = self.delete(signin)
        self.assertEqual(r["statusCode"], 400)
        self.assertIn("u1", self.store.profiles)
        self.assertEqual(self.store.emails, {"ada@example.com": "u1"})

    def test_a_deletion_code_does_not_sign_in(self):
        code = self.code()
        sessions = dict(self.store.sessions)
        r, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        # It is checked against the newest sign-in, the one setUp used.
        self.assertEqual((r["statusCode"], body["error"]), (400, "code-used"))
        self.assertNotIn("cookies", r)
        self.assertEqual(self.store.sessions, sessions)
        # And it still deletes: asking to sign in spent none of its tries.
        self.assertEqual(self.delete(code)[0]["statusCode"], 200)

    def test_each_kind_keeps_its_own_newest(self):
        _, _, signin = self.start()
        code = self.code()  # does not replace the sign-in
        r, _ = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": signin})
        self.assertEqual(r["statusCode"], 200)
        self.cookies = [r["cookies"][0].split(";")[0]]
        self.start()  # nor a new sign-in the deletion code
        self.assertEqual(self.delete(code)[0]["statusCode"], 200)

    def test_a_sign_in_from_before_purposes_still_signs_in_and_never_deletes(self):
        self.code()
        _, _, signin = self.start()
        for row in self.store.logins.values():
            if row["purpose"] == "signin":
                del row["purpose"]
        r, _ = self.delete(signin)
        self.assertEqual(r["statusCode"], 400)
        r, _ = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": signin})
        self.assertEqual(r["statusCode"], 200)

    def test_if_the_emails_cannot_be_deleted_nothing_is(self):
        code = self.code()
        self.s3 = FakeS3(fail=True)
        r, body = self.delete(code)
        self.assertEqual((r["statusCode"], body["error"]), (502, "delete-failed"))
        self.assertIn("u1", self.store.profiles)
        self.assertEqual(len(self.store.items["u1"]), 5)  # with this browser's session

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
