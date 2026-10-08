import json
import os
import re
import unittest
from contextlib import redirect_stdout
from email import message_from_bytes
from email.policy import default
from decimal import Decimal
from io import StringIO

from fakes import FakeS3, FakeSES, FakeStore
from release_notes import auth, export, web

ORIGIN = "https://notes.yourversionnumber.com"
os.environ.update(
    WEB_ORIGIN=ORIGIN,
    FROM_ADDRESS="notes@yourversionnumber.com",
    CONFIG_SET="yvn-release-notes",
    TABLE="t",
    MAIL_BUCKET="mail-bucket",
)
NOW = 1_791_500_000  # 2026-10-08, mid-afternoon Central


def request(method, path, body=None, *, origin=ORIGIN, cookies=None, query=None, viewer="198.51.100.7:4433"):
    headers = {"cloudfront-viewer-address": viewer}
    if origin:
        headers["origin"] = origin
    return {
        "rawPath": path,
        "requestContext": {"http": {"method": method, "sourceIp": "203.0.113.1"}},
        "headers": headers,
        "cookies": cookies or [],
        "queryStringParameters": query,
        "body": json.dumps(body) if body is not None else None,
    }


class WebCase(unittest.TestCase):
    """Helpers for driving web.handler over the fakes; no tests here."""

    def setUp(self):
        self.store, self.ses, self.s3, self.now = FakeStore(), FakeSES(), FakeS3(), NOW
        self.places = []
        self.out = StringIO()

    def call(self, *args, **kw):
        with redirect_stdout(self.out):
            r = web.handler(
                request(*args, **kw), None, store=self.store, ses=self.ses, s3=self.s3, geocode=self.geocode,
                clock=lambda: self.now,
            )
        return r, json.loads(r["body"]) if r["headers"]["content-type"] == "application/json" else r["body"]

    def geocode(self, q):
        if self.places is None:
            raise TimeoutError("geocoder down")
        return self.places

    def subscribe(self, email="ada@example.com", user_id="u1"):
        self.store.emails[email] = user_id
        self.store.profiles[user_id] = {
            "email": email, "birthday": "1981-06-14", "tz": "America/Chicago",
            "send_time": "06:00", "status": "active", "lat": Decimal("44.98"),
        }

    def start(self, email="ada@example.com", **kw):
        r, body = self.call("POST", "/api/auth/start", {"email": email}, **kw)
        if r["statusCode"] != 202:
            return r, None, None
        msg = message_from_bytes(self.ses.sent[-1]["Content"]["Raw"]["Data"], policy=default)
        token = re.search(r"/signin/#t=([A-Za-z0-9_-]{43})\n", msg.get_body(("plain",)).get_content()).group(1)
        code = re.fullmatch(r"(\d{6}) is your Release Notes code", msg["Subject"]).group(1)
        return r, token, code

    def signed_in(self, email="ada@example.com"):
        _, token, _ = self.start(email)
        r, _ = self.call("POST", "/api/auth/verify", {"token": token})
        return r["cookies"][0].split(";")[0]


class WebTest(WebCase):
    # --- basics -------------------------------------------------------------

    def test_health(self):
        r, body = self.call("GET", "/api/health")
        self.assertEqual((r["statusCode"], body), (200, {"ok": True}))
        self.assertEqual(r["headers"]["cache-control"], "no-store")

    def test_sample(self):
        r, body = self.call("GET", "/api/sample")
        self.assertEqual(body, {"birthday": "1981-06-14", "version": "4.5.116"})
        _, body = self.call("GET", "/api/sample", query={"birthday": "1976-10-07", "tz": "Asia/Tokyo"})
        self.assertEqual(body["version"], "5.0.2")  # already Friday in Tokyo
        for q in ({"birthday": "2027-01-01"}, {"birthday": "x"}, {"tz": "Nowhere/Else"}):
            self.assertEqual(self.call("GET", "/api/sample", query=q)[0]["statusCode"], 400, q)

    def test_unknown_route_is_404(self):
        for method, path in [("GET", "/api/nope"), ("POST", "/api/health"), ("GET", "/"), ("PATCH", "/api/me")]:
            r, _ = self.call(method, path)
            self.assertEqual(r["statusCode"], 404, (method, path))

    def test_log_names_no_unmatched_path(self):
        self.call("GET", "/api/someone@example.com")
        self.assertNotIn("example.com", self.out.getvalue())
        self.assertIn('"path":"unmatched"', self.out.getvalue())

    def test_writes_need_our_origin(self):
        for origin in (None, "https://evil.example", "https://d1fxrb44y943g1.cloudfront.net"):
            r, body = self.call("POST", "/api/auth/start", {"email": "ada@example.com"}, origin=origin)
            self.assertEqual((r["statusCode"], body["error"]), (403, "origin"))
        self.assertEqual(self.ses.sent, [])

    def test_bad_bodies(self):
        r, body = self.call("POST", "/api/auth/start", {"email": "not-an-address"})
        self.assertEqual((r["statusCode"], body["error"]), (400, "email"))
        ev = request("POST", "/api/auth/start")
        ev["body"] = "{nope"
        with redirect_stdout(self.out):
            r = web.handler(ev, None, store=self.store, ses=self.ses, clock=lambda: self.now)
        self.assertEqual(r["statusCode"], 400)

    # --- sign-in ------------------------------------------------------------

    def test_start_mails_a_link_and_code_and_stores_only_hashes(self):
        r, token, code = self.start("  Ada@Example.com ")
        self.assertEqual(r["statusCode"], 202)
        sent = self.ses.sent[0]
        self.assertEqual(sent["Destination"], {"ToAddresses": ["ada@example.com"]})
        self.assertEqual(sent["ConfigurationSetName"], "yvn-release-notes")
        self.assertIn("Release Notes <notes@yourversionnumber.com>", sent["FromEmailAddress"])
        stored = json.dumps(self.store.logins) + json.dumps(self.store.newest)
        self.assertNotIn(token, stored)
        self.assertNotIn(code, stored.replace(auth.digest(code), ""))
        self.assertNotIn("ada@example.com", self.out.getvalue())

    def test_same_answer_with_or_without_an_account(self):
        self.subscribe()
        a, _, _ = self.start("ada@example.com")
        b, _, _ = self.start("nobody@example.com")
        self.assertEqual((a["statusCode"], a["body"]), (b["statusCode"], b["body"]))
        self.assertEqual(len(self.ses.sent), 2)

    def test_link_signs_in_once(self):
        self.subscribe()
        _, token, code = self.start()
        r, body = self.call("POST", "/api/auth/verify", {"token": token})
        self.assertEqual((r["statusCode"], body), (200, {"new": False}))
        cookie = r["cookies"][0]
        for part in ("__Host-rn=", "Path=/", "Secure", "HttpOnly", "SameSite=Lax"):
            self.assertIn(part, cookie)
        self.assertNotIn("Domain", cookie)
        r, body = self.call("POST", "/api/auth/verify", {"token": token})
        self.assertEqual((r["statusCode"], body["error"]), (400, "link-used-or-expired"))
        # The link burned the code too.
        r, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        self.assertEqual(body["error"], "code-used")

    def test_code_signs_in_and_burns_the_link(self):
        _, token, code = self.start()
        r, body = self.call("POST", "/api/auth/verify", {"email": "ADA@example.com", "code": code[:3] + " " + code[3:]})
        self.assertEqual((r["statusCode"], body), (200, {"new": True}))
        r, body = self.call("POST", "/api/auth/verify", {"token": token})
        self.assertEqual(body["error"], "link-used-or-expired")

    def test_five_wrong_codes_lock_the_sign_in(self):
        _, _, code = self.start()
        wrong = f"{(int(code) + 1) % 1_000_000:06d}"
        lefts = []
        for _ in range(5):
            _, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": wrong})
            lefts.append(body.get("tries_left"))
        self.assertEqual(lefts, [4, 3, 2, 1, 0])
        _, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        self.assertEqual(body["error"], "too-many-tries")

    def test_code_is_checked_against_the_newest_sign_in(self):
        _, _, first = self.start()
        _, second_token, second = self.start()
        if first != second:
            _, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": first})
            self.assertEqual(body["error"], "wrong-code")
        r, _ = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": second})
        self.assertEqual(r["statusCode"], 200)

    def test_code_for_another_address_fails(self):
        _, _, code = self.start("ada@example.com")
        _, body = self.call("POST", "/api/auth/verify", {"email": "eve@example.com", "code": code})
        self.assertEqual(body["error"], "code-expired")

    def test_sign_in_expires_after_15_minutes(self):
        _, token, code = self.start()
        self.now += auth.LOGIN_TTL
        _, body = self.call("POST", "/api/auth/verify", {"email": "ada@example.com", "code": code})
        self.assertEqual(body["error"], "code-expired")
        _, body = self.call("POST", "/api/auth/verify", {"token": token})
        self.assertEqual(body["error"], "link-used-or-expired")

    def test_limits_per_address_network_and_total(self):
        for _ in range(auth.LIMIT_PER_ADDRESS):
            self.assertEqual(self.start()[0]["statusCode"], 202)
        r, _, _ = self.start()
        self.assertEqual(r["statusCode"], 429)
        # Another address from the same network still works, up to its limit.
        for i in range(auth.LIMIT_PER_NETWORK - auth.LIMIT_PER_ADDRESS - 1):
            self.assertEqual(self.start(f"p{i}@example.com")[0]["statusCode"], 202)
        self.assertEqual(self.start("last@example.com")[0]["statusCode"], 429)
        # A new hour starts over.
        self.now += 3600
        self.assertEqual(self.start()[0]["statusCode"], 202)

    def test_ipv6_networks_share_a_limit(self):
        self.assertEqual(auth.network("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64")
        self.assertEqual(auth.network("198.51.100.7"), "198.51.100.7")
        req = web.Request(request("GET", "/", viewer="2001:db8:1:2::9:443"))
        self.assertEqual(req.viewer(), "2001:db8:1:2::9")

    def test_mail_failure_says_so(self):
        self.ses.fail = True
        r, _, _ = self.start()
        self.assertEqual(r["statusCode"], 502)

    # --- sessions -----------------------------------------------------------

    def test_me_for_a_subscriber_and_a_new_address(self):
        self.subscribe()
        r, body = self.call("GET", "/api/me", cookies=[self.signed_in()])
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual((body["new"], body["version"], body["today"]), (False, "4.5.116", "2026-10-08"))
        r, body = self.call("GET", "/api/me", cookies=[self.signed_in("new@example.com")])
        self.assertEqual(body, {"new": True, "email": "new@example.com"})

    def test_signed_out(self):
        for cookies in ([], ["__Host-rn=" + "x" * 43], ["other=1"]):
            r, body = self.call("GET", "/api/me", cookies=cookies)
            self.assertEqual((r["statusCode"], body["error"]), (401, "signed-out"))

    def test_session_ends_90_days_after_sign_in_however_often_used(self):
        self.subscribe()
        cookie = self.signed_in()
        for _ in range(3):  # days 29, 58 and 87
            self.now += auth.SESSION_IDLE - 86400
            self.assertEqual(self.call("GET", "/api/me", cookies=[cookie])[0]["statusCode"], 200)
        self.now = NOW + auth.SESSION_MAX
        self.assertEqual(self.call("GET", "/api/me", cookies=[cookie])[0]["statusCode"], 401)

    def test_idle_session_expires(self):
        self.subscribe()
        cookie = self.signed_in()
        self.now += auth.SESSION_IDLE
        self.assertEqual(self.call("GET", "/api/me", cookies=[cookie])[0]["statusCode"], 401)

    def test_sign_out_ends_the_session(self):
        self.subscribe()
        cookie = self.signed_in()
        r, _ = self.call("POST", "/api/auth/signout", cookies=[cookie])
        self.assertIn("Max-Age=0", r["cookies"][0])
        self.assertEqual(self.call("GET", "/api/me", cookies=[cookie])[0]["statusCode"], 401)
        self.assertEqual(self.store.sessions, {})

    def test_signing_in_again_replaces_the_old_session(self):
        self.subscribe()
        old = self.signed_in()
        _, token, _ = self.start()
        self.call("POST", "/api/auth/verify", {"token": token}, cookies=[old])
        self.assertEqual(len(self.store.sessions), 1)
        self.assertEqual(self.call("GET", "/api/me", cookies=[old])[0]["statusCode"], 401)

    # --- export -------------------------------------------------------------

    def test_export_needs_an_account(self):
        r, _ = self.call("GET", "/api/export")
        self.assertEqual(r["statusCode"], 401)
        r, body = self.call("GET", "/api/export", cookies=[self.signed_in("new@example.com")])
        self.assertEqual((r["statusCode"], body["error"]), (403, "no-account"))

    def test_export_json_and_markdown(self):
        self.subscribe()
        self.store.items["u1"] = [
            {"pk": "USER#u1", "sk": "DAY#2026-10-07", "version": "4.5.115", "token": "secret-token", "sent_at": "x"},
            {"pk": "USER#u1", "sk": "NOTE#2026-10-07#m2", "version": "4.5.115", "text": "Second.",
             "received_at": "2026-10-07T20:00:00Z", "raw_key": "raw/m2", "attachments": [{"size": Decimal(10)}]},
            {"pk": "USER#u1", "sk": "NOTE#2026-10-07#m1", "version": "4.5.115", "text": "First.",
             "received_at": "2026-10-07T12:00:00Z", "raw_key": "raw/m1", "attachments": []},
            {"pk": "USER#u1", "sk": "NOTE#2026-09-12#w-abc", "source": "web", "text": "Backfilled."},
        ]
        cookie = self.signed_in()
        r, body = self.call("GET", "/api/export", cookies=[cookie], query={"format": "json"})
        self.assertEqual(r["statusCode"], 200)
        self.assertIn('attachment; filename="release-notes-2026-10-', r["headers"]["content-disposition"])
        data = json.loads(body) if isinstance(body, str) else body
        self.assertEqual([n["text"] for n in data["notes"]], ["Backfilled.", "First.", "Second."])
        self.assertEqual(data["notes"][0]["version"], "4.5.90")
        self.assertEqual(data["profile"]["lat"], 44.98)
        self.assertNotIn("secret-token", r["body"])
        self.assertNotIn("raw/m1", r["body"])
        r, md = self.call("GET", "/api/export", cookies=[cookie], query={"format": "md"})
        self.assertTrue(r["headers"]["content-type"].startswith("text/markdown"))
        self.assertIn("## 4.5.115 · Wednesday, October 7, 2026\n\nFirst.\n\nSecond.", md)
        self.assertLess(md.index("4.5.90"), md.index("4.5.115"))
        self.assertNotIn("Backfilled", self.out.getvalue())
        r, body = self.call("GET", "/api/export", cookies=[cookie], query={"format": "csv"})
        self.assertEqual(r["statusCode"], 400)

    def test_export_with_no_notes(self):
        md = export.markdown(export.build([{"sk": "PROFILE", "birthday": "1981-06-14"}], "2026-10-08T00:00:00Z"))
        self.assertIn("No notes yet.", md)


class SigninEmailTest(unittest.TestCase):
    def test_email_reads_in_both_parts(self):
        msg = auth.signin_message(
            to="ada@example.com", from_addr="notes@yourversionnumber.com",
            link="https://notes.yourversionnumber.com/signin/#t=abc", code="012345",
        )
        self.assertEqual(msg["Subject"], "012345 is your Release Notes code")
        text = msg.get_body(("plain",)).get_content()
        html = msg.get_body(("html",)).get_content()
        for part in (text, html):
            self.assertIn("https://notes.yourversionnumber.com/signin/#t=abc", part)
            self.assertIn("012345", part)
        self.assertNotIn("http://", html.replace("http://www.w3.org", ""))
        self.assertNotIn("<img", html)


if __name__ == "__main__":
    unittest.main()
