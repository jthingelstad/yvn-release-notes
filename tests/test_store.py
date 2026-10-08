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

    def __init__(self, client=None, fail=None):
        self.meta = type("Meta", (), {"client": client})()
        self.calls, self.fail = [], fail

    def put_item(self, **kw):
        self.calls.append(("put_item", kw))

    def update_item(self, **kw):
        self.calls.append(("update_item", kw))
        if self.fail:
            raise self.fail

    def get_item(self, **kw):
        self.calls.append(("get_item", kw))
        return {}


class ConditionFailed(Exception):
    response = {"Error": {"Code": "ConditionalCheckFailedException"}}


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


class ExportItem(unittest.TestCase):
    def test_start_puts_one_item_in_place_of_the_last(self):
        table = FakeTable()
        Store(table).start_export("u1", "e1", 100, 200)
        self.assertEqual(table.calls, [("put_item", {"Item": {
            "pk": "USER#u1", "sk": "EXPORT", "id": "e1", "status": "building", "started_at": 100, "expires_at": 200}})])

    def test_finish_only_the_build_still_named(self):
        table = FakeTable()
        self.assertTrue(Store(table).finish_export("u1", "e1", {"status": "ready", "size": 5}))
        _, kw = table.calls[0]
        self.assertEqual(kw["Key"], {"pk": "USER#u1", "sk": "EXPORT"})
        self.assertEqual(kw["UpdateExpression"], "SET #f0 = :v0, #f1 = :v1")
        self.assertEqual(kw["ConditionExpression"], "#id = :id AND #s = :b")
        # status and size are reserved words, so every name goes through #.
        self.assertEqual(kw["ExpressionAttributeNames"], {"#id": "id", "#s": "status", "#f0": "status", "#f1": "size"})
        self.assertEqual(kw["ExpressionAttributeValues"], {":id": "e1", ":b": "building", ":v0": "ready", ":v1": 5})

    def test_a_replaced_build_is_false(self):
        self.assertFalse(Store(FakeTable(fail=ConditionFailed())).finish_export("u1", "e1", {"status": "ready"}))
        with self.assertRaises(ValueError):
            Store(FakeTable(fail=ValueError())).finish_export("u1", "e1", {"status": "ready"})


if __name__ == "__main__":
    unittest.main()
