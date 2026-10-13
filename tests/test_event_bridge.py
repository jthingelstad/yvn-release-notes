"""Fictional event handoff: qualified and unqualified deliveries share receipts."""
import hashlib
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from io import StringIO
from release_notes import events
from fakes import FakeStore
from test_signup import FakeSNS
from unittest.mock import patch

NOW = 1791849600
MESSAGE = {"eventType": "Bounce", "bounce": {"bounceType": "Permanent", "bounceSubType": "General",
           "bouncedRecipients": [{"emailAddress": "ada@example.com"}]}}

def notification(message_id="fictional-sns-1"):
    return {"Records": [{"Sns": {"Message": json.dumps(MESSAGE), "MessageId": message_id}}]}

class Bridge(unittest.TestCase):
    def setUp(self):
        self.store, self.sns = FakeStore(), FakeSNS()
        self.store.emails["ada@example.com"] = "u1"
        self.store.profiles["u1"] = {"email": "ada@example.com", "status": "active"}
        self.topic = patch.dict("os.environ", {"ALARM_TOPIC": "fictional-topic"})
        self.topic.start()
        self.addCleanup(self.topic.stop)

    def deliver(self, event=None, now=NOW):
        events.handler(event or notification(), None, store=self.store, sns=self.sns, clock=lambda: now)

    def test_parallel_old_new_subscription_deliveries_apply_once(self):
        with patch("release_notes.events.log"):
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda _: self.deliver(), range(32)))
        self.assertEqual(self.store.tallied[("2026-10", "bounces")], 1)
        rows = self.store.items["u1"]
        self.assertEqual(rows, [{"pk": "USER#u1", "sk": "MAILEVENT#" + hashlib.sha256(b"fictional-sns-1").hexdigest(),
                                "expires_at": NOW + 30 * 86400}])
        self.assertEqual(self.store.profiles["u1"]["status"], "stopped")
        self.assertEqual(len(self.sns.published), 32)  # Ops notice remains at least once.

    def test_duplicate_after_owner_restart_does_not_stop_again(self):
        with patch("release_notes.events.log"):
            self.deliver()
            self.store.profiles["u1"].update(status="active")
            self.deliver()
        self.assertEqual(self.store.profiles["u1"]["status"], "active")
        self.assertEqual(self.store.tallied[("2026-10", "bounces")], 1)

    def test_deleted_or_deleting_account_never_recreated_or_counted(self):
        for profile in [None, {"mcp_deleting": True}]:
            self.store.profiles.clear()
            if profile:
                self.store.profiles["u1"] = profile
            with patch("release_notes.events.log"):
                self.deliver()
            self.assertEqual(self.store.items, {})
            self.assertEqual(self.store.tallied, {})
            self.assertEqual(self.store.profiles, {"u1": profile} if profile else {})

    def test_missing_message_id_refuses_account_write(self):
        event = notification()
        del event["Records"][0]["Sns"]["MessageId"]
        with self.assertRaisesRegex(ValueError, "SNS MessageId required"):
            self.deliver(event)
        self.assertEqual(self.store.profiles["u1"]["status"], "active")
        self.assertEqual(self.store.tallied, {})

    def test_sns_publish_failure_retries_receipt_without_second_tally(self):
        with patch.object(self.sns, "publish", side_effect=OSError("fictional failure")), patch("release_notes.events.log"):
            with self.assertRaises(OSError):
                self.deliver()
        with patch("release_notes.events.log"):
            self.deliver()
        self.assertEqual(self.store.tallied[("2026-10", "bounces")], 1)
        self.assertEqual(len(self.sns.published), 1)

    def test_expired_receipt_is_refreshable_and_content_free(self):
        with patch("release_notes.events.log"):
            self.deliver()
            self.deliver(now=NOW + 30 * 86400)
        self.assertEqual(self.store.tallied[("2026-10", "bounces")], 1)
        self.assertEqual(self.store.tallied[("2026-11", "bounces")], 1)
        encoded = json.dumps(self.store.items["u1"])
        self.assertNotIn("ada@example.com", encoded)
        self.assertNotIn("subject", encoded)

    def test_logs_and_ops_notice_preserve_private_boundary(self):
        output = StringIO()
        with redirect_stdout(output):
            self.deliver()
        self.assertNotIn("ada@example.com", output.getvalue())
        self.assertNotIn("fictional-sns-1", output.getvalue())
        self.assertNotIn("ada@example.com", json.dumps(self.sns.published))
