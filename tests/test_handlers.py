import json
import os
import unittest
from contextlib import redirect_stdout
from io import StringIO
from datetime import date, datetime, timezone
from email import message_from_bytes
from email.message import EmailMessage
from email.policy import default

from release_notes import inbound, send
from release_notes.store import Subscriber

os.environ.update(
    FROM_ADDRESS="notes@yourversionnumber.com",
    INBOUND_DOMAIN="in.yourversionnumber.com",
    CONFIG_SET="yvn-release-notes",
    BUCKET="mail-bucket",
)

TOKEN = "abcdefghijklmnopqrstuvwx"


def ada(**over):
    base = dict(
        user_id="u1",
        email="ada@example.com",
        birthday=date(1976, 10, 7),
        tz="America/Chicago",
        send_time="20:00",
        status="active",
        last_sent_date=None,
    )
    base.update(over)
    return Subscriber(**base)


class FakeStore:
    def __init__(self, subs):
        self.subs = {s.user_id: s for s in subs}
        self.days, self.tokens, self.notes = {}, {}, {}
        self.note_days_fail = self.day_notes_fail = False
        self.paused = []
        self.weather = {}

    def put_weather(self, user_id, day, fields):
        if (user_id, day) in self.weather:
            return False
        self.weather[(user_id, day)] = fields
        return True

    def weather_between(self, user_id, first, last):
        return {d: w for (u, d), w in self.weather.items() if u == user_id and first <= d <= last}

    def active_subscribers(self):
        return [s for s in self.subs.values() if s.status == "active"]

    def census_items(self):
        if getattr(self, "census_fail", False):
            raise ConnectionError("boom")
        return [{"pk": f"USER#{s.user_id}", "sk": "PROFILE", "status": s.status, "tz": s.tz, "send_time": s.send_time,
                 "last_sent_date": s.last_sent_date} for s in self.subs.values()]

    def get_subscriber(self, user_id):
        return self.subs.get(user_id)

    def claim_day(self, user_id, day):
        s = self.subs[user_id]
        if s.last_sent_date and s.last_sent_date >= day:
            return False
        s.last_sent_date = day
        return True

    def release_day(self, user_id, day, previous):
        self.subs[user_id].last_sent_date = previous

    def put_day(self, user_id, day, version, token, sent_at):
        self.tokens[token] = {"user_id": user_id, "date": day, "version": version,
                              "sent_at": int(datetime.fromisoformat(sent_at).timestamp())}
        self.days[(user_id, day)] = {"version": version, "token": token, "sent_at": sent_at}

    def drop_day(self, user_id, day, token):
        self.tokens.pop(token, None)
        if self.days.get((user_id, day), {}).get("token") == token:
            del self.days[(user_id, day)]

    def set_day_message_id(self, user_id, day, message_id):
        self.days[(user_id, day)]["ses_message_id"] = message_id

    def get_token(self, token):
        return self.tokens.get(token)

    def note_days(self, user_id):
        if self.note_days_fail:
            raise ConnectionError("boom")
        return {date.fromisoformat(d) for (u, d, _) in self.notes if u == user_id}

    def pauses(self, user_id):
        return self.paused

    def day_notes(self, user_id, day):
        if self.day_notes_fail:
            raise ConnectionError("boom")
        return [n for (u, d, _), n in sorted(self.notes.items()) if u == user_id and d == day]

    def put_note(self, user_id, day, message_id, note):
        key = (user_id, day, message_id)
        if key in self.notes:
            return False
        self.notes[key] = note
        return True


class FakeSES:
    def __init__(self, fail=False):
        self.sent, self.fail = [], fail

    def send_email(self, **kw):
        if self.fail:
            raise ConnectionError("boom")
        self.sent.append(kw)
        return {"MessageId": f"ses-{len(self.sent)}"}


class FakeS3:
    def __init__(self, raw: bytes):
        self.raw, self.tags = raw, {}

    def get_object(self, Bucket, Key):
        import io

        return {"Body": io.BytesIO(self.raw)}

    def put_object_tagging(self, Bucket, Key, Tagging):
        self.tags[Key] = Tagging["TagSet"][0]["Value"]

    def put_object(self, Bucket, Key, Body, **kw):
        self.objects = getattr(self, "objects", {})
        self.objects[Key] = {"Body": Body, **kw}


def clock(iso):
    return lambda: datetime.fromisoformat(iso)


# 20:00 in Chicago on 2026-10-07 (CDT, UTC-5) is 01:00 UTC on 10-08.
AT_8PM = clock("2026-10-08T01:00:00+00:00")
AT_8_15PM = clock("2026-10-08T01:15:00+00:00")


class Sending(unittest.TestCase):
    def test_due_window(self):
        s = ada()
        tz = send.ZoneInfo("America/Chicago")
        self.assertFalse(send.is_due(s, datetime(2026, 10, 7, 19, 45, tzinfo=tz)))
        self.assertTrue(send.is_due(s, datetime(2026, 10, 7, 20, 0, tzinfo=tz)))
        self.assertTrue(send.is_due(s, datetime(2026, 10, 7, 22, 45, tzinfo=tz)))
        self.assertFalse(send.is_due(s, datetime(2026, 10, 7, 23, 0, tzinfo=tz)))
        self.assertFalse(send.is_due(ada(last_sent_date="2026-10-07"), datetime(2026, 10, 7, 20, 0, tzinfo=tz)))

    def test_late_send_time_window_stops_at_midnight(self):
        tz = send.ZoneInfo("America/Chicago")
        s = ada(send_time="23:00")
        self.assertTrue(send.is_due(s, datetime(2026, 10, 7, 23, 45, tzinfo=tz)))
        self.assertFalse(send.is_due(s, datetime(2026, 10, 8, 0, 15, tzinfo=tz)))

    def test_sends_once_per_day(self):
        store, ses = FakeStore([ada()]), FakeSES()
        out = send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual(out["results"][0]["version"], "5.0.0")
        self.assertEqual(len(ses.sent), 1)
        raw = ses.sent[0]["Content"]["Raw"]["Data"].decode()
        self.assertIn("Subject: You're 5.0.0 today", raw)
        token = store.days[("u1", "2026-10-07")]["token"]
        self.assertIn(f"n-{token}@in.yourversionnumber.com", raw)
        self.assertIn("Happy birthday: a major release.", raw)
        send.handler({}, None, store=store, ses=ses, clock=AT_8_15PM)
        self.assertEqual(len(ses.sent), 1)

    def test_failed_send_is_released_for_retry(self):
        store = FakeStore([ada(last_sent_date="2026-10-06")])
        with self.assertRaises(RuntimeError):
            send.handler({}, None, store=store, ses=FakeSES(fail=True), clock=AT_8PM)
        self.assertEqual(store.subs["u1"].last_sent_date, "2026-10-06")
        send.handler({}, None, store=store, ses=FakeSES(), clock=AT_8_15PM)
        self.assertEqual(store.subs["u1"].last_sent_date, "2026-10-07")

    def test_ses_from_keeps_the_display_name(self):
        # SES writes FromEmailAddress over the message's From header; a bare
        # address there delivered 2026-10-07's email without "Release Notes".
        ses = FakeSES()
        send.handler({}, None, store=FakeStore([ada()]), ses=ses, clock=AT_8PM)
        self.assertEqual(ses.sent[0]["FromEmailAddress"], "Release Notes <notes@yourversionnumber.com>")
        self.assertIn("From: Release Notes <notes@yourversionnumber.com>", ses.sent[0]["Content"]["Raw"]["Data"].decode())

    def test_daily_email_is_tagged_for_the_mail_metrics(self):
        ses = FakeSES()
        send.handler({}, None, store=FakeStore([ada()]), ses=ses, clock=AT_8PM)
        self.assertEqual(ses.sent[0]["EmailTags"], [{"Name": "release-notes-mail", "Value": "daily"}])

    def test_a_scheduled_run_ends_with_the_census_line(self):
        out = StringIO()
        with redirect_stdout(out):
            send.handler({}, None, store=FakeStore([ada()]), ses=FakeSES(), clock=AT_8PM)
        lines = [json.loads(l) for l in out.getvalue().splitlines()]
        census = [l for l in lines if l.get("event") == "census"]
        self.assertEqual(len(census), 1)
        self.assertEqual(census[0]["_aws"]["CloudWatchMetrics"][0]["Namespace"], "ReleaseNotes")
        self.assertEqual((census[0]["Subscribers"], census[0]["Overdue"]), (1, 0))
        self.assertNotIn("ada@example.com", out.getvalue())

    def test_no_census_on_a_dry_run_or_send_now(self):
        for event in ({"dry_run": True}, {"send_now": "u1"}):
            out = StringIO()
            with redirect_stdout(out):
                send.handler(event, None, store=FakeStore([ada()]), ses=FakeSES(), clock=AT_8PM)
            self.assertNotIn('"census"', out.getvalue())

    def test_a_failed_census_never_fails_the_run(self):
        store, ses, out = FakeStore([ada()]), FakeSES(), StringIO()
        store.census_fail = True
        with redirect_stdout(out):
            send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual(len(ses.sent), 1)
        self.assertIn('"event":"census-error"', out.getvalue())

    def test_sent_at_is_the_real_send_time(self):
        store = FakeStore([ada()])
        send.handler({}, None, store=store, ses=FakeSES(), clock=AT_8_15PM)
        day = store.days[("u1", "2026-10-07")]
        self.assertEqual(day["sent_at"], "2026-10-08T01:15:00+00:00")
        # The reply address carries it too, for inbound's 72 hours.
        self.assertEqual(store.tokens[day["token"]]["sent_at"], 1791422100)

    def test_now_is_refused_on_a_real_send(self):
        store, ses = FakeStore([ada()]), FakeSES()
        with self.assertRaises(ValueError):
            send.handler({"now": "2026-10-08T01:00:00+00:00"}, None, store=store, ses=ses)
        self.assertEqual(ses.sent, [])
        self.assertIsNone(store.subs["u1"].last_sent_date)

    def test_send_now_sends_outside_the_window_once(self):
        # 15:00 in Chicago, five hours before Ada's 20:00 send time.
        store, ses = FakeStore([ada()]), FakeSES()
        three_pm = clock("2026-10-07T20:00:00+00:00")
        out = send.handler({"send_now": "u1"}, None, store=store, ses=ses, clock=three_pm)
        self.assertEqual(out["results"][0]["outcome"], "sent")
        self.assertEqual(store.days[("u1", "2026-10-07")]["sent_at"], "2026-10-07T20:00:00+00:00")
        again = send.handler({"send_now": "u1"}, None, store=store, ses=ses, clock=three_pm)
        self.assertEqual(again["results"][0]["outcome"], "already-sent")
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual(len(ses.sent), 1)

    def test_only_the_first_email_says_welcome(self):
        # Sign-up's send_now is a subscriber's first email; it says when the
        # rest will come.
        store, ses = FakeStore([ada()]), FakeSES()
        send.handler({"send_now": "u1"}, None, store=store, ses=ses, clock=clock("2026-10-07T20:00:00+00:00"))
        first = message_from_bytes(ses.sent[0]["Content"]["Raw"]["Data"], policy=default)
        self.assertIn("every day at 8:00 PM", first.get_body(("plain",)).get_content())
        send.handler({}, None, store=store, ses=ses, clock=clock("2026-10-09T01:00:00+00:00"))
        later = message_from_bytes(ses.sent[1]["Content"]["Raw"]["Data"], policy=default)
        self.assertNotIn("Welcome", later.get_body(("plain",)).get_content())

    def test_a_failed_send_leaves_no_reply_address(self):
        store = FakeStore([ada()])
        with self.assertRaises(RuntimeError):
            send.handler({}, None, store=store, ses=FakeSES(fail=True), clock=AT_8PM)
        self.assertEqual((store.tokens, store.days), ({}, {}))

    def test_the_slow_parts_come_before_the_claim(self):
        # A run that times out fetching weather must not have claimed the
        # day, or that person gets nothing until tomorrow.
        store = FakeStore([ada(place={"lat": 44.98, "lon": -93.26, "tz": "America/Chicago", "city": "Minneapolis"})])
        seen = []

        def fetch(url):
            seen.append(store.subs["u1"].last_sent_date)
            raise TimeoutError("slow")
        send.handler({}, None, store=store, ses=FakeSES(), clock=AT_8PM, fetch=fetch)
        self.assertEqual(seen, [None])
        self.assertEqual(store.subs["u1"].last_sent_date, "2026-10-07")

    def test_stops_starting_sends_when_time_is_short(self):
        store, ses = FakeStore([ada(), ada(user_id="u2", email="bea@example.com")]), FakeSES()
        left = iter([60_000, 10_000, 9_000])
        context = type("Ctx", (), {"get_remaining_time_in_millis": lambda self: next(left)})()
        log = StringIO()
        with redirect_stdout(log):
            out = send.handler({}, context, store=store, ses=ses, clock=AT_8PM)
        # Too little time left for the dashboard's counts as well.
        self.assertIn('"event":"census-skipped"', log.getvalue())
        self.assertEqual(len(ses.sent), 1)
        self.assertEqual(len(out["results"]), 1)
        # The next quarter hour picks up the other.
        send.handler({}, None, store=store, ses=ses, clock=AT_8_15PM)
        self.assertEqual(len(ses.sent), 2)

    def test_weather_has_a_budget_for_the_whole_run(self):
        now = [0.0]

        def slow(url):
            now[0] += 12.0
            return {"url": url}
        call = send.one_run(slow, budget=30.0, timer=lambda: now[0])
        for n in range(3):
            call(f"u{n}")  # 12, 24, 36 seconds spent
        with self.assertRaises(RuntimeError):
            call("u3")

    def test_send_now_only_sends_to_the_named_subscriber(self):
        store, ses = FakeStore([ada(), ada(user_id="u2", email="bea@example.com")]), FakeSES()
        send.handler({"send_now": "u2"}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual([m["Destination"]["ToAddresses"] for m in ses.sent], [["bea@example.com"]])

    def test_send_now_refuses_an_unknown_or_paused_subscriber(self):
        store = FakeStore([ada(status="paused")])
        for who in ("u1", "nobody"):
            with self.assertRaises(ValueError):
                send.handler({"send_now": who}, None, store=store, ses=FakeSES(), clock=AT_8PM)

    def test_dry_run_writes_nothing(self):
        store = FakeStore([ada()])
        out = send.handler({"now": "2026-10-08T01:00:00+00:00", "dry_run": True}, None, store=store)
        self.assertEqual(out["results"][0]["date"], "2026-10-07")
        self.assertIsNone(store.subs["u1"].last_sent_date)

    def test_email_carries_the_streak(self):
        store, ses = FakeStore([ada()]), FakeSES()
        for day in ("2026-10-05", "2026-10-06"):
            store.notes[("u1", day, f"m-{day}")] = {"text": "x"}
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        raw = ses.sent[0]["Content"]["Raw"]["Data"].decode()
        self.assertIn("2 days in a row, your longest yet.", raw)

    def test_email_carries_last_years_notes(self):
        # Ada is 5.0.0 on 2026-10-07; a year back is 4.9.0 on 2025-10-07.
        store, ses = FakeStore([ada()]), FakeSES()
        store.notes[("u1", "2025-10-07", "m1")] = {"text": "Birthday dinner. https://example.com/post/"}
        out = send.handler({"now": "2026-10-08T01:00:00+00:00", "dry_run": True}, None, store=store)
        self.assertEqual(out["results"][0]["last_year"], "2025-10-07")
        self.assertNotIn("Birthday dinner", str(out))
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        msg = message_from_bytes(ses.sent[0]["Content"]["Raw"]["Data"], policy=default)
        self.assertIn("A year ago you were 4.9.0 (Tuesday, October 7, 2025):", msg.get_body(("plain",)).get_content())
        self.assertIn('href="https://example.com/post/"', msg.get_body(("html",)).get_content())

    def test_last_years_photos_are_a_link(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.notes[("u1", "2025-10-07", "m1")] = {"text": "", "media": [
            {"n": 1, "kind": "image", "type": "image/jpeg", "size": 9, "key": "media/u1/2025-10-07/m1/1.jpg"},
            {"n": 2, "kind": "image", "type": "image/jpeg", "size": 9, "key": "media/u1/2025-10-07/m1/2.jpg"}]}
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        msg = message_from_bytes(ses.sent[0]["Content"]["Raw"]["Data"], policy=default)
        self.assertIn("A year ago you were 4.9.0 (Tuesday, October 7, 2025):\n\n"
                      "See 2 photos: https://notes.yourversionnumber.com/day/?d=2025-10-07\n", msg.get_body(("plain",)).get_content())
        html = msg.get_body(("html",)).get_content()
        self.assertIn(">See 2 photos</a>", html)
        self.assertNotIn("media/", html)
        self.assertNotIn("<img", html)

    def test_last_years_links_show_by_name(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.notes[("u1", "2025-10-07", "m1")] = {
            "text": "Birthday dinner. https://example.com/post/",
            "links": [{"url": "https://example.com/post/", "title": "Fifty candles", "site": "Example"}],
        }
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        msg = message_from_bytes(ses.sent[0]["Content"]["Raw"]["Data"], policy=default)
        self.assertIn("Birthday dinner. Fifty candles <https://example.com/post/>", msg.get_body(("plain",)).get_content())
        self.assertIn('href="https://example.com/post/" style="color:#1a4fe0;">Fifty candles</a>'
                      '<span class="ink-2"', msg.get_body(("html",)).get_content())

    def test_no_notes_a_year_ago_no_section(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.notes[("u1", "2025-10-06", "m1")] = {"text": "The day before."}
        out = send.handler({"now": "2026-10-08T01:00:00+00:00", "dry_run": True}, None, store=store)
        self.assertIsNone(out["results"][0]["last_year"])
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertNotIn("A year ago", ses.sent[0]["Content"]["Raw"]["Data"].decode())

    def test_last_year_read_failure_still_sends(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.day_notes_fail = True
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual(len(ses.sent), 1)
        self.assertNotIn("A year ago", ses.sent[0]["Content"]["Raw"]["Data"].decode())

    def test_streak_read_failure_still_sends(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.note_days_fail = True
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual(len(ses.sent), 1)
        self.assertNotIn("in a row", ses.sent[0]["Content"]["Raw"]["Data"].decode())

    def test_a_pause_skips_its_days_only(self):
        # The day in Chicago at 8 PM is 2026-10-07.
        for start, through, sent in [("2026-10-07", "2026-10-09", 0), ("2026-10-01", "2026-10-06", 1), ("2026-10-08", "2026-10-09", 1)]:
            store, ses = FakeStore([ada(pause_from=start, pause_through=through)]), FakeSES()
            send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
            self.assertEqual(len(ses.sent), sent, (start, through))
        store, ses = FakeStore([ada(pause_from="2026-10-07", pause_through="2026-10-07")]), FakeSES()
        out = send.handler({"send_now": "u1"}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertEqual((out["results"][0]["outcome"], ses.sent), ("paused", []))
        self.assertIsNone(store.subs["u1"].last_sent_date)

    def test_the_streak_waits_through_a_pause(self):
        store, ses = FakeStore([ada()]), FakeSES()
        store.notes[("u1", "2026-10-02", "m1")] = {"text": "x"}
        store.notes[("u1", "2026-10-03", "m2")] = {"text": "x"}
        store.paused = [("2026-10-04", "2026-10-06")]
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM)
        self.assertIn("2 days in a row, your longest yet.", ses.sent[0]["Content"]["Raw"]["Data"].decode())

    def test_dry_run_reports_the_streak(self):
        store = FakeStore([ada()])
        store.notes[("u1", "2026-10-06", "m1")] = {"text": "x"}
        out = send.handler({"dry_run": True}, None, store=store, clock=AT_8PM)
        self.assertEqual((out["results"][0]["streak"], out["results"][0]["longest"]), (1, 1))

    def test_local_date_not_utc_date(self):
        # 01:00 UTC is already the 8th in UTC but still the 7th in Chicago.
        out = send.handler({"dry_run": True}, None, store=FakeStore([ada()]), clock=AT_8PM)
        self.assertEqual(out["results"][0]["date"], "2026-10-07")


def reply_raw(from_addr="ada@example.com", auth="amazonses.com; spf=pass; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com"):
    msg = EmailMessage()
    msg["Authentication-Results"] = auth
    msg["From"] = from_addr
    msg["To"] = f"n-{TOKEN}@in.yourversionnumber.com"
    msg["Subject"] = "Re: You're 5.0.0 today"
    msg.set_content("Fifty. Cake with the family.\n\nOn Tue, Oct 7, 2026 at 8:00 PM Release Notes wrote:\n> You're 5.0.0 today.\n")
    return msg.as_bytes()


def ses_event(from_addr="ada@example.com", recipient=f"n-{TOKEN}@in.yourversionnumber.com", dmarc="PASS", dkim="PASS", spam="PASS",
              message_id="m1", timestamp="2026-10-08T02:10:00.000Z"):
    return {
        "mail": {
            "messageId": message_id,
            "timestamp": timestamp,
            "commonHeaders": {"from": [f"Ada <{from_addr}>"], "subject": "Re: You're 5.0.0 today"},
        },
        "receipt": {
            "recipients": [recipient],
            "spamVerdict": {"status": spam},
            "virusVerdict": {"status": "PASS"},
            "spfVerdict": {"status": "PASS"},
            "dkimVerdict": {"status": dkim},
            "dmarcVerdict": {"status": dmarc},
        },
    }


class Inbound(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore([ada()])
        self.store.tokens[TOKEN] = {"user_id": "u1", "date": "2026-10-07", "version": "5.0.0"}
        self.titles, self.fetched = {}, []

    def fetch(self, url):
        self.fetched.append(url)
        return self.titles.get(url)

    def run_one(self, ses, raw=None):
        s3 = FakeS3(raw or reply_raw())
        return inbound.process(ses, self.store, s3, fetch=self.fetch), s3

    def test_files_note_under_the_emails_day(self):
        outcome, s3 = self.run_one(ses_event())
        self.assertEqual(outcome, "note")
        self.assertEqual(s3.tags["raw/m1"], "note")
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual(note["text"], "Fifty. Cake with the family.")
        self.assertEqual(note["version"], "5.0.0")
        self.assertEqual((note["source"], note["tz"], note["written_at"]), ("email", "America/Chicago", "2026-10-08T02:10:00.000Z"))
        self.assertNotIn("tags", note)

    def test_hashtags_in_a_reply_are_its_tags(self):
        msg = message_from_bytes(reply_raw(), policy=default)
        msg.clear_content()
        msg.set_content("Fifty. Cake with the family. #Birthday #cake")
        self.run_one(ses_event(), msg.as_bytes())
        self.assertEqual(self.store.notes[("u1", "2026-10-07", "m1")]["tags"], ["birthday", "cake"])

    def test_links_are_named_and_titled(self):
        msg = message_from_bytes(reply_raw(), policy=default)
        msg.clear_content()
        msg.set_content('<p>Fifty. Wrote it up in <a href="https://example.com/p">my post</a>, '
                        'and this was good: https://example.com/q</p>', subtype="html")
        self.titles["https://example.com/q"] = {"title": "A good page", "site": "example.com"}
        self.run_one(ses_event(), msg.as_bytes())
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual(note["text"], "Fifty. Wrote it up in my post <https://example.com/p>, and this was good: https://example.com/q")
        self.assertEqual(note["links"], [{"url": "https://example.com/p", "title": "my post", "named": True},
                                         {"url": "https://example.com/q", "title": "A good page", "site": "example.com"}])
        self.assertEqual(self.fetched, ["https://example.com/q"])

    def test_photos_and_recordings_are_copied_out(self):
        from test_media import jpeg, m4a, png
        msg = message_from_bytes(reply_raw(), policy=default)
        msg.add_attachment(jpeg(3024, 4032, pad=5000), maintype="image", subtype="jpeg", filename="image0.jpeg", disposition="inline")
        msg.add_attachment(png(48, 48, pad=100), maintype="image", subtype="png", filename="sig.png", disposition="inline")
        msg.add_attachment(m4a(2048), maintype="audio", subtype="x-m4a", filename="Memo.m4a")
        out = StringIO()
        with redirect_stdout(out):
            outcome, s3 = self.run_one(ses_event(), msg.as_bytes())
        self.assertEqual(outcome, "note")
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual(note["media"], [
            {"n": 1, "kind": "image", "type": "image/jpeg", "size": len(jpeg(3024, 4032, pad=5000)), "key": "media/u1/2026-10-07/m1/1.jpg"},
            {"n": 2, "kind": "audio", "type": "audio/mp4", "size": 2048, "key": "media/u1/2026-10-07/m1/2.m4a"},
        ])
        self.assertEqual(len(note["attachments"]), 3)  # every part is still listed
        self.assertEqual(sorted(s3.objects), ["media/u1/2026-10-07/m1/1.jpg", "media/u1/2026-10-07/m1/2.m4a"])
        self.assertEqual(s3.objects["media/u1/2026-10-07/m1/2.m4a"]["ContentType"], "audio/mp4")
        self.assertEqual(s3.tags["raw/m1"], "note")
        self.assertIn('"media":2', out.getvalue())

    def test_a_photo_alone_is_a_note(self):
        from test_media import jpeg
        msg = EmailMessage()
        msg["From"], msg["To"] = "ada@example.com", f"n-{TOKEN}@in.yourversionnumber.com"
        msg["Authentication-Results"] = "amazonses.com; dmarc=pass header.from=example.com"
        msg.add_attachment(jpeg(1200, 900, pad=100), maintype="image", subtype="jpeg", filename="image0.jpeg")
        outcome, s3 = self.run_one(ses_event(), msg.as_bytes())
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual((outcome, note["text"], len(note["media"])), ("note", "", 1))

    def test_a_note_without_links_fetches_nothing(self):
        self.run_one(ses_event())
        self.assertNotIn("links", self.store.notes[("u1", "2026-10-07", "m1")])
        self.assertEqual(self.fetched, [])

    def test_retry_is_idempotent(self):
        self.run_one(ses_event())
        outcome, _ = self.run_one(ses_event())
        self.assertEqual(outcome, "note")
        self.assertEqual(len(self.store.notes), 1)

    def test_every_reply_to_a_days_email_is_kept(self):
        self.run_one(ses_event())
        later = ses_event(message_id="m2", timestamp="2026-10-08T04:30:00.000Z")
        self.assertEqual(self.run_one(later)[0], "note")
        self.assertEqual(sorted(self.store.notes), [("u1", "2026-10-07", "m1"), ("u1", "2026-10-07", "m2")])
        self.assertEqual(self.store.note_days("u1"), {date(2026, 10, 7)})

    def test_from_mismatch_ignored(self):
        outcome, s3 = self.run_one(ses_event(from_addr="someone@example.com"), reply_raw("someone@example.com"))
        self.assertEqual(outcome, "ignored")
        self.assertEqual(s3.tags["raw/m1"], "ignored")
        self.assertEqual(self.store.notes, {})

    def test_two_from_addresses_ignored(self):
        ses = ses_event()
        ses["mail"]["commonHeaders"]["from"] = ["Ada <ada@example.com>", "Eve <eve@example.net>"]
        self.assertEqual(self.run_one(ses)[0], "ignored")
        self.assertEqual(self.store.notes, {})

    def test_out_of_office_ignored(self):
        for name, value in (("Auto-Submitted", "auto-replied"), ("X-Autoreply", "yes"), ("Precedence", "auto_reply")):
            msg = message_from_bytes(reply_raw(), policy=default)
            msg[name] = value
            self.assertEqual(self.run_one(ses_event(), msg.as_bytes())[0], "ignored", name)
        msg = message_from_bytes(reply_raw(), policy=default)
        msg["Auto-Submitted"] = "no"
        self.assertEqual(self.run_one(ses_event(), msg.as_bytes())[0], "note")

    def test_a_very_long_reply_keeps_its_first_20000_characters(self):
        msg = message_from_bytes(reply_raw(), policy=default)
        msg.clear_content()
        msg.set_content("word " * 10_000)
        self.assertEqual(self.run_one(ses_event(), msg.as_bytes())[0], "note")
        self.assertEqual(len(self.store.notes[("u1", "2026-10-07", "m1")]["text"]), 20_000)

    def test_unknown_token_and_plain_address_ignored(self):
        self.assertEqual(self.run_one(ses_event(recipient=f"n-{'b' * 24}@in.yourversionnumber.com"))[0], "ignored")
        self.assertEqual(self.run_one(ses_event(recipient="hello@in.yourversionnumber.com"))[0], "ignored")

    def test_spam_ignored(self):
        self.assertEqual(self.run_one(ses_event(spam="FAIL"))[0], "ignored")

    def test_dmarc_fail_ignored(self):
        self.assertEqual(self.run_one(ses_event(dmarc="FAIL", dkim="FAIL"))[0], "ignored")

    def test_no_dmarc_policy_needs_aligned_dkim_from_ses(self):
        ok = reply_raw(auth="amazonses.com; spf=pass; dkim=pass header.i=@example.com")
        self.assertEqual(self.run_one(ses_event(dmarc="GRAY"), ok)[0], "note")

    def test_no_dmarc_policy_unaligned_dkim_ignored(self):
        bad = reply_raw(auth="amazonses.com; spf=pass; dkim=pass header.i=@attacker.example")
        self.assertEqual(self.run_one(ses_event(dmarc="GRAY"), bad)[0], "ignored")

    def test_forged_results_header_not_trusted(self):
        forged = reply_raw(auth="evil.example; dkim=pass header.i=@example.com")
        self.assertEqual(self.run_one(ses_event(dmarc="GRAY"), forged)[0], "ignored")

    # --- the 2026-10-09 inbound review ------------------------------------------

    def run_logged(self, ses, raw=None):
        out = StringIO()
        with redirect_stdout(out):
            outcome, s3 = self.run_one(ses, raw)
        return outcome, s3, json.loads(out.getvalue().splitlines()[-1])

    def test_a_dkim_local_part_is_not_its_domain(self):
        # header.i=example.com@evil.example is evil.example's signature.
        for auth in ("amazonses.com; dkim=pass header.i=example.com@evil.example",
                     "amazonses.com; dkim=pass header.i=@example.com@evil.example",
                     'amazonses.com; dkim=pass header.i="example.com;"@evil.example',
                     "amazonses.com; dkim=pass header.d=evil.example header.i=@example.com",
                     "amazonses.com; dkim=pass header.i=example.com",
                     "amazonses.com; dkim=pass (header.i=@example.com) header.i=@evil.example"):
            outcome, _, line = self.run_logged(ses_event(dmarc="GRAY"), reply_raw(auth=auth))
            self.assertEqual((outcome, line["reason"]), ("ignored", "unauthenticated"), auth)
        self.assertEqual(inbound.dkim_domains("amazonses.com; dkim=pass header.i=example.com@evil.example"), ["evil.example"])

    def test_header_d_names_the_signer(self):
        for auth in ("amazonses.com; spf=pass (spfCheck: a; b) smtp.mailfrom=example.com; dkim=pass header.d=example.com header.s=s1",
                     "amazonses.com; dkim=pass header.i=@mail.example.com",
                     "amazonses.com; dkim=fail header.i=@evil.example; dkim=pass header.i=ada@example.com"):
            self.assertEqual(self.run_one(ses_event(dmarc="GRAY"), reply_raw(auth=auth))[0], "note", auth)
            self.store.notes.clear()

    def test_a_dmarc_fail_is_not_rescued_by_dkim(self):
        aligned = reply_raw(auth="amazonses.com; spf=pass; dkim=pass header.i=@example.com; dmarc=fail header.from=example.com")
        for dmarc in ("FAIL", "PROCESSING_FAILED", None):
            ses = ses_event(dmarc=dmarc)
            if dmarc is None:
                del ses["receipt"]["dmarcVerdict"]
            outcome, _, line = self.run_logged(ses, aligned)
            self.assertEqual((outcome, line["reason"]), ("ignored", "unauthenticated"), dmarc)
        # No policy (GRAY) with a real aligned DKIM pass still files.
        self.assertEqual(self.run_one(ses_event(dmarc="GRAY"), aligned)[0], "note")

    def test_a_reply_is_filed_for_72_hours_after_its_email(self):
        # Sent 2026-10-08T01:15:00Z, so the window closes 2026-10-11T01:15:00Z.
        self.store.tokens[TOKEN]["sent_at"] = 1791422100
        self.assertEqual(self.run_one(ses_event(timestamp="2026-10-11T01:15:00.000Z"))[0], "note")
        outcome, s3, line = self.run_logged(ses_event(message_id="m2", timestamp="2026-10-11T01:15:01.000Z"))
        self.assertEqual((outcome, s3.tags["raw/m2"]), ("ignored", "ignored"))
        self.assertEqual(line, {"event": "inbound", "message": "m2", "outcome": "ignored", "reason": "expired", "user": "u1"})
        self.assertEqual(list(self.store.notes), [("u1", "2026-10-07", "m1")])
        # The reply address stays: its unsubscribe link keeps working.
        self.assertIn(TOKEN, self.store.tokens)

    def test_a_token_from_before_sent_at_runs_to_the_end_of_four_days_on(self):
        # The token for 2026-10-07 has no sent_at: filed until 2026-10-12T00:00:00Z.
        self.assertNotIn("sent_at", self.store.tokens[TOKEN])
        self.assertEqual(self.run_one(ses_event(timestamp="2026-10-11T23:59:59.000Z"))[0], "note")
        outcome, _, line = self.run_logged(ses_event(message_id="m2", timestamp="2026-10-12T00:00:01.000Z"))
        self.assertEqual((outcome, line["reason"]), ("ignored", "expired"))

    def test_the_raw_from_must_be_the_one_address_too(self):
        two = b"From: eve@example.net\n" + reply_raw()  # a second From header
        other = reply_raw(from_addr="eve@example.net")
        both = reply_raw(from_addr="ada@example.com, eve@example.net")
        for raw in (two, other, both):
            outcome, s3, line = self.run_logged(ses_event(), raw)
            self.assertEqual((outcome, line["reason"], s3.tags["raw/m1"]), ("ignored", "from-mismatch", "ignored"))
        self.assertEqual(self.store.notes, {})
        self.assertEqual(self.run_one(ses_event(), reply_raw(from_addr="Ada <ADA@example.com>"))[0], "note")

    def test_a_virus_scan_that_failed_is_a_virus(self):
        ses = ses_event()
        ses["receipt"]["virusVerdict"]["status"] = "PROCESSING_FAILED"
        self.assertEqual(self.run_one(ses)[0], "ignored")
        for spam in ("GRAY", "PROCESSING_FAILED"):
            self.store.notes.clear()
            self.assertEqual(self.run_one(ses_event(spam=spam))[0], "note", spam)

    def deep(self, depth, auth="amazonses.com; dmarc=pass header.from=example.com"):
        head = (f"Authentication-Results: {auth}\r\nFrom: ada@example.com\r\n"
                f"To: n-{TOKEN}@in.yourversionnumber.com\r\nSubject: Re: hi\r\nMIME-Version: 1.0\r\n").encode()
        body = b"Content-Type: text/plain\r\n\r\nhello\r\n"
        for i in range(depth):
            b = b"b%d" % i
            body = b"Content-Type: multipart/mixed; boundary=" + b + b"\r\n\r\n--" + b + b"\r\n" + body + b"\r\n--" + b + b"--\r\n"
        return head + body

    def test_mime_nested_too_deep_is_ignored_not_retried(self):
        outcome, s3, line = self.run_logged(ses_event(), self.deep(1500))
        self.assertEqual((outcome, s3.tags["raw/m1"], line["reason"], line["error"]),
                         ("ignored", "ignored", "unparseable", "RecursionError"))
        self.assertEqual(self.store.notes, {})
        # Who sent it is checked first, from the headers alone.
        self.assertEqual(self.run_logged(ses_event(dmarc="FAIL"), self.deep(1500))[2]["reason"], "unauthenticated")
        # A little nesting is just a reply.
        self.assertEqual(self.run_one(ses_event(message_id="m3"), self.deep(5))[0], "note")

    def test_an_emailed_file_that_is_not_what_it_says_stays_in_the_email(self):
        from release_notes import media
        from test_media import jpeg
        msg = message_from_bytes(reply_raw(), policy=default)
        msg.add_attachment(b"<svg onload=alert(1)>" + b" " * 30000, maintype="image", subtype="jpeg", filename="photo.jpg")
        msg.add_attachment(jpeg(1200, 900, pad=100), maintype="image", subtype="jpeg", filename="real.jpg")
        outcome, s3 = self.run_one(ses_event(), msg.as_bytes())
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual(outcome, "note")
        self.assertEqual([m["key"] for m in note["media"]], ["media/u1/2026-10-07/m1/1.jpg"])
        self.assertEqual(s3.objects["media/u1/2026-10-07/m1/1.jpg"]["Body"], jpeg(1200, 900, pad=100))
        self.assertEqual([a.get("refused", False) for a in note["attachments"]], [True, False])
        self.assertEqual(media.others(note), 1)


if __name__ == "__main__":
    unittest.main()
