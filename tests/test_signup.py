import json
import unittest
from contextlib import redirect_stdout
from decimal import Decimal
from io import StringIO

from fakes import FakeLambda, FakeStore
from release_notes import events, places
from test_web import NOW, WebCase

MINNEAPOLIS = {
    "name": "Minneapolis", "region": "Minnesota", "country": "United States",
    "tz": "America/Chicago", "lat": 44.97997, "lon": -93.26384,
}


class SignUpTest(WebCase):
    # NOW is 17:53 in Chicago on 2026-10-08.

    def new_session(self, email="new@example.com"):
        return [self.signed_in(email)]

    def put_me(self, body, cookies, **kw):
        return self.call("PUT", "/api/me", body, cookies=cookies, **kw)

    def test_sign_up_creates_the_account_and_keeps_the_session(self):
        cookies = self.new_session()
        r, body = self.put_me({"birthday": "1981-06-14", "place": MINNEAPOLIS, "send_time": "06:00"}, cookies)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual((body["new"], body["version"], body["city"]), (False, "4.5.116", "Minneapolis"))
        user_id = self.store.emails["new@example.com"]
        p = self.store.profiles[user_id]
        self.assertEqual((p["lat"], p["lon"]), (Decimal("44.98"), Decimal("-93.26")))
        self.assertEqual(p["status"], "active")
        # Today's email goes at once (the sender marks the day sent); the
        # schedule's first is tomorrow's.
        self.assertNotIn("last_sent_date", p)
        self.assertEqual(self.lam.invoked, [{"FunctionName": "yvn-release-notes-sender", "InvocationType": "Event",
                                             "Payload": {"send_now": user_id}}])
        _, again = self.call("GET", "/api/me", cookies=cookies)
        self.assertFalse(again["new"])
        self.assertNotIn("new@example.com", self.out.getvalue())
        self.assertNotIn("Minneapolis", self.out.getvalue())

    def test_first_email_goes_now_even_with_the_send_time_ahead(self):
        cookies = self.new_session()
        self.put_me({"birthday": "1981-06-14", "place": MINNEAPOLIS, "send_time": "20:00"}, cookies)
        self.assertEqual([i["Payload"] for i in self.lam.invoked], [{"send_now": self.store.emails["new@example.com"]}])

    def test_sign_up_stands_when_the_first_email_cannot_start(self):
        # The schedule still sends today's if its send time is ahead or
        # under three hours past.
        self.lam = FakeLambda(fail=True)
        cookies = self.new_session()
        r, body = self.put_me({"birthday": "1981-06-14", "place": MINNEAPOLIS, "send_time": "20:00"}, cookies)
        self.assertEqual((r["statusCode"], body["new"]), (200, False))
        self.assertIn('"event":"first-email-failed"', self.out.getvalue())

    def test_sign_up_checks_everything(self):
        cookies = self.new_session()
        good = {"birthday": "1981-06-14", "place": MINNEAPOLIS, "send_time": "06:00"}
        for change, error in [
            ({"birthday": "2026-10-09"}, "birthday"),
            ({"birthday": "1899-12-31"}, "birthday"),
            ({"birthday": "June 14"}, "birthday"),
            ({"birthday": None}, "birthday"),
            ({"send_time": "06:10"}, "send-time"),
            ({"send_time": "24:00"}, "send-time"),
            ({"place": {**MINNEAPOLIS, "tz": "Mars/Olympus"}}, "place"),
            ({"place": {**MINNEAPOLIS, "lat": 91}}, "place"),
            ({"place": {**MINNEAPOLIS, "name": ""}}, "place"),
            ({"place": "Minneapolis"}, "place"),
        ]:
            r, body = self.put_me({**good, **change}, cookies)
            self.assertEqual((r["statusCode"], body["error"]), (400, error), change)
        self.assertEqual(self.store.emails.get("new@example.com"), None)

    def test_a_second_tab_joins_the_account_the_first_made(self):
        first, second = self.new_session(), self.new_session()
        body = {"birthday": "1981-06-14", "place": MINNEAPOLIS, "send_time": "06:00"}
        self.put_me(body, first)
        r, again = self.put_me(body, second)
        self.assertEqual((r["statusCode"], again["new"]), (200, False))
        self.assertEqual(len(self.store.profiles), 1)
        self.assertEqual(len(self.lam.invoked), 1)  # one first email
        self.assertEqual(self.store.tallied, {("2026-10", "signups"): 1})

    def restart(self, reason):
        self.subscribe()
        self.store.profiles["u1"].update(status="stopped", stopped_reason=reason, stopped_at="2026-10-01T00:00:00Z")
        return self.put_me({"status": "active"}, [self.signed_in()])

    def test_restarting_after_a_bounce_takes_the_address_off_the_suppression_list(self):
        # Otherwise SES drops every email to it, sign-in included, and each
        # drop is a new bounce that stops them again.
        for reason in ("bounce", "complaint"):
            self.ses.suppressed.add("ada@example.com")
            r, body = self.restart(reason)
            self.assertEqual((r["statusCode"], body["status"]), (200, "active"))
            self.assertNotIn("ada@example.com", self.ses.suppressed)
        self.assertEqual(self.store.tallied[("2026-10", "restarts")], 2)

    def test_restarting_after_unsubscribing_leaves_suppression_alone(self):
        r, _ = self.restart("unsubscribed")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.ses.unsuppressed, [])

    def test_restart_is_fine_when_ses_has_already_let_the_address_go(self):
        r, _ = self.restart("bounce")  # not on the list: NotFound
        self.assertEqual(r["statusCode"], 200)

    def test_restart_fails_loudly_when_ses_cannot_be_asked(self):
        def broken(EmailAddress):
            raise ConnectionError("down")
        self.ses.delete_suppressed_destination = broken
        r, body = self.restart("bounce")
        self.assertEqual((r["statusCode"], body["error"]), (502, "restart-failed"))
        self.assertEqual(self.store.profiles["u1"]["status"], "stopped")

    def test_settings_change_send_time_and_city(self):
        self.subscribe()
        cookies = [self.signed_in()]
        r, body = self.put_me({"send_time": "07:15"}, cookies)
        self.assertEqual((r["statusCode"], body["send_time"]), (200, "07:15"))
        r, body = self.put_me({"place": {**MINNEAPOLIS, "name": "Paris", "tz": "Europe/Paris"}}, cookies)
        self.assertEqual((body["tz"], body["city"]), ("Europe/Paris", "Paris"))
        r, body = self.put_me({}, cookies)
        self.assertEqual(body["error"], "nothing-to-change")

    def test_birthday_is_locked(self):
        self.subscribe()
        cookies = [self.signed_in()]
        r, body = self.put_me({"birthday": "1990-01-01"}, cookies)
        self.assertEqual((r["statusCode"], body["error"]), (400, "birthday-locked"))
        r, _ = self.put_me({"birthday": "1981-06-14", "send_time": "06:15"}, cookies)
        self.assertEqual(r["statusCode"], 200)

    def test_put_me_needs_a_session_and_our_origin(self):
        r, _ = self.put_me({"send_time": "07:00"}, [])
        self.assertEqual(r["statusCode"], 401)
        self.subscribe()
        r, _ = self.put_me({"send_time": "07:00"}, [self.signed_in()], origin="https://evil.example")
        self.assertEqual(r["statusCode"], 403)

    # --- places ---------------------------------------------------------------

    def test_places_needs_a_session_and_a_query(self):
        r, _ = self.call("GET", "/api/places", query={"q": "Minneapolis"})
        self.assertEqual(r["statusCode"], 401)
        cookies = self.new_session()
        r, body = self.call("GET", "/api/places", cookies=cookies, query={"q": "M"})
        self.assertEqual(body["error"], "query")
        self.places = [MINNEAPOLIS]
        r, body = self.call("GET", "/api/places", cookies=cookies, query={"q": "Minneap"})
        self.assertEqual(body, {"places": [MINNEAPOLIS]})
        self.places = None
        r, body = self.call("GET", "/api/places", cookies=cookies, query={"q": "Minneap"})
        self.assertEqual((r["statusCode"], body["error"]), (502, "places-failed"))

    # --- stopping and starting -------------------------------------------------

    def test_one_click_unsubscribe(self):
        self.subscribe()
        self.store.tokens["abcdefghijklmnopqrstuvwx"] = {"user_id": "u1", "date": "2026-10-08"}
        # A mail app's POST: no cookie, no Origin.
        r, _ = self.call("POST", "/api/unsubscribe", origin=None, query={"t": "abcdefghijklmnopqrstuvwx"})
        self.assertEqual(r["statusCode"], 200)
        p = self.store.profiles["u1"]
        self.assertEqual((p["status"], p["stopped_reason"]), ("stopped", "unsubscribed"))
        # A second click (or the mail app's retry) counts once.
        r, _ = self.call("POST", "/api/unsubscribe", origin=None, query={"t": "abcdefghijklmnopqrstuvwx"})
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.store.tallied, {("2026-10", "unsubscribes"): 1})
        r, _ = self.call("POST", "/api/unsubscribe", origin=None, query={"t": "bbbbbbbbbbbbbbbbbbbbbbbb"})
        self.assertEqual(r["statusCode"], 404)
        r, _ = self.call("POST", "/api/unsubscribe", origin=None, query={"t": "../../etc"})
        self.assertEqual(r["statusCode"], 400)

    def test_opening_the_unsubscribe_link_shows_a_page(self):
        r, _ = self.call("GET", "/api/unsubscribe", query={"t": "abcdefghijklmnopqrstuvwx"})
        self.assertEqual((r["statusCode"], r["headers"]["location"]), (302, "/unsubscribe/#t=abcdefghijklmnopqrstuvwx"))
        self.assertEqual(self.store.profiles, {})

    def test_start_the_emails_again(self):
        self.subscribe()
        self.store.stop("u1", "unsubscribed", "x")
        cookies = [self.signed_in()]
        _, body = self.call("GET", "/api/me", cookies=cookies)
        self.assertEqual((body["status"], body["stopped_reason"]), ("stopped", "unsubscribed"))
        r, body = self.put_me({"status": "active"}, cookies)
        self.assertEqual((body["status"], "stopped_reason" in body), ("active", False))
        self.assertNotIn("stopped_reason", self.store.profiles["u1"])
        r, body = self.put_me({"status": "stopped"}, cookies)
        self.assertEqual(body["error"], "status")


class PlacesTest(unittest.TestCase):
    def test_search_keeps_the_city_and_rounds(self):
        def fetch(url):
            self.assertIn("name=Minneap", url)
            return {
                "results": [
                    {"name": "Minneapolis", "admin1": "Minnesota", "country": "United States",
                     "timezone": "America/Chicago", "latitude": 44.97997, "longitude": -93.26384, "population": 410939},
                    {"name": "Nowhere", "latitude": 1, "longitude": 1},  # no time zone: dropped
                ]
            }

        found = places.search("Minneap", fetch=fetch)
        self.assertEqual(found, [{**MINNEAPOLIS, "lat": 44.98, "lon": -93.26}])
        self.assertEqual(places.search("zzz", fetch=lambda url: {}), [])


class FakeSNS:
    def __init__(self):
        self.published = []

    def publish(self, TopicArn, Subject, Message):
        self.published.append({"TopicArn": TopicArn, "Message": json.loads(Message)})


class BounceTest(unittest.TestCase):
    def run_events(self, *messages):
        store = FakeStore()
        store.emails["ada@example.com"] = "u1"
        store.profiles["u1"] = {"email": "ada@example.com", "status": "active"}
        out = StringIO()
        with redirect_stdout(out):
            events.handler(
                {"Records": [{"Sns": {"Message": json.dumps(m)}} for m in messages]}, None, store=store, sns=self.sns,
                clock=lambda: NOW,
            )
        self.assertNotIn("ada@example.com", out.getvalue())
        self.store = store
        return store.profiles["u1"]

    def setUp(self):
        self.sns = FakeSNS()

    def test_hard_bounce_stops_the_emails(self):
        p = self.run_events(
            {"eventType": "Bounce", "bounce": {"bounceType": "Permanent", "bouncedRecipients": [{"emailAddress": "Ada@Example.com"}]}}
        )
        self.assertEqual((p["status"], p["stopped_reason"]), ("stopped", "bounce"))

    def test_complaint_stops_the_emails(self):
        p = self.run_events({"eventType": "Complaint", "complaint": {"complainedRecipients": [{"emailAddress": "ada@example.com"}]}})
        self.assertEqual((p["status"], p["stopped_reason"]), ("stopped", "complaint"))

    def test_ops_get_kinds_and_ids_never_addresses_or_subjects(self):
        headers = [{"name": "List-Unsubscribe", "value": "<https://notes.yourversionnumber.com/api/unsubscribe?t=secret>"},
                   {"name": "Reply-To", "value": "n-secret@in.yourversionnumber.com"}]
        self.run_events(
            {"eventType": "Bounce", "mail": {"headers": headers, "destination": ["ada@example.com"],
                                             "commonHeaders": {"subject": "You're 4.5.116 today"}},
             "bounce": {"bounceType": "Permanent", "bounceSubType": "General",
                        "bouncedRecipients": [{"emailAddress": "ada@example.com"}]}},
            {"eventType": "Bounce", "mail": {"headers": [], "commonHeaders": {"subject": "123456 is your Release Notes code"}},
             "bounce": {"bounceType": "Permanent", "bouncedRecipients": [{"emailAddress": "nobody@example.com"}]}},
            {"eventType": "DeliveryDelay", "mail": {"headers": headers}, "deliveryDelay": {}},
        )
        lines = [p["Message"] for p in self.sns.published]
        self.assertEqual(lines, [
            {"source": "yvn-release-notes", "event": "Bounce", "mail": "daily", "bounce_type": "Permanent",
             "bounce_subtype": "General", "users": ["u1"]},
            {"source": "yvn-release-notes", "event": "Bounce", "mail": "account", "bounce_type": "Permanent",
             "bounce_subtype": None, "users": [None]},
        ])
        sent = json.dumps(self.sns.published)
        for secret in ("example.com", "secret", "123456", "4.5.116"):
            self.assertNotIn(secret, sent)
        self.assertEqual(self.store.tallied, {("2026-10", "bounces"): 1})

    def test_soft_bounces_and_strangers_change_nothing(self):
        p = self.run_events(
            {"eventType": "Bounce", "bounce": {"bounceType": "Transient", "bouncedRecipients": [{"emailAddress": "ada@example.com"}]}},
            {"eventType": "Bounce", "bounce": {"bounceType": "Permanent", "bouncedRecipients": [{"emailAddress": "nobody@example.com"}]}},
            {"eventType": "Delivery"},
        )
        self.assertEqual(p["status"], "active")


if __name__ == "__main__":
    unittest.main()
