import os
import unittest
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

    def active_subscribers(self):
        return [s for s in self.subs.values() if s.status == "active"]

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
        self.tokens[token] = {"user_id": user_id, "date": day, "version": version}
        self.days[(user_id, day)] = {"version": version, "token": token, "sent_at": sent_at}

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

    def test_sent_at_is_the_real_send_time(self):
        store = FakeStore([ada()])
        send.handler({}, None, store=store, ses=FakeSES(), clock=AT_8_15PM)
        self.assertEqual(store.days[("u1", "2026-10-07")]["sent_at"], "2026-10-08T01:15:00+00:00")

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

    def run_one(self, ses, raw=None):
        s3 = FakeS3(raw or reply_raw())
        return inbound.process(ses, self.store, s3), s3

    def test_files_note_under_the_emails_day(self):
        outcome, s3 = self.run_one(ses_event())
        self.assertEqual(outcome, "note")
        self.assertEqual(s3.tags["raw/m1"], "note")
        note = self.store.notes[("u1", "2026-10-07", "m1")]
        self.assertEqual(note["text"], "Fifty. Cake with the family.")
        self.assertEqual(note["version"], "5.0.0")

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


if __name__ == "__main__":
    unittest.main()
