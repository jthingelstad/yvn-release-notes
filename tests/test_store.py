import unittest
from decimal import Decimal

from release_notes.store import Store


class Cancelled(Exception):
    def __init__(self, *codes):
        super().__init__("Transaction cancelled")
        self.response = {
            "Error": {"Code": "TransactionCanceledException"},
            "CancellationReasons": [{"Code": c} for c in codes],
        }


class FakeClient:
    def __init__(self, fail=None):
        self.calls, self.fail = [], fail

    def transact_write_items(self, **kw):
        self.calls.append(kw)
        if self.fail:
            raise self.fail


class FakeTable:
    name = "release-notes"

    def __init__(self, client):
        self.meta = type("Meta", (), {"client": client})()


PROFILE = {"birthday": "1990-05-15", "tz": "America/Chicago", "lat": Decimal("44.94")}


class CreateSubscriber(unittest.TestCase):
    def test_items_go_as_plain_values(self):
        # The resource's client serializes; typed values ({"S": ...}) would
        # make the key a map and DynamoDB cancel every sign-up.
        client = FakeClient()
        self.assertTrue(Store(FakeTable(client)).create_subscriber("u1", "ada@example.com", PROFILE))
        email, profile = (i["Put"]["Item"] for i in client.calls[0]["TransactItems"])
        self.assertEqual(email, {"pk": "EMAIL#ada@example.com", "sk": "EMAIL", "user_id": "u1"})
        self.assertEqual(profile, {"pk": "USER#u1", "sk": "PROFILE", "email": "ada@example.com", **PROFILE})

    def test_a_taken_address_is_false(self):
        client = FakeClient(Cancelled("ConditionalCheckFailed", "None"))
        self.assertFalse(Store(FakeTable(client)).create_subscriber("u1", "ada@example.com", PROFILE))

    def test_any_other_cancellation_is_an_error(self):
        client = FakeClient(Cancelled("ValidationError", "None"))
        with self.assertRaises(Cancelled):
            Store(FakeTable(client)).create_subscriber("u1", "ada@example.com", PROFILE)


if __name__ == "__main__":
    unittest.main()
