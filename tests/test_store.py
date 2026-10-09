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

    def delete_item(self, **kw):
        self.calls.append(("delete_item", kw))

    def query(self, **kw):
        self.calls.append(("query", kw))
        return {"Items": [{"pk": "USER#u1", "sk": "WEATHER#2026-10-07", "code": 3}]}


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


class WeatherItem(unittest.TestCase):
    def test_floats_go_as_decimals_and_the_first_reading_stands(self):
        table = FakeTable()
        Store(table).put_weather("u1", "2026-10-07", {"high_c": 19.0, "low_c": -2.5, "code": 3, "lat": Decimal("44.98")})
        _, kw = table.calls[0]
        self.assertEqual(kw["Item"], {"pk": "USER#u1", "sk": "WEATHER#2026-10-07", "high_c": Decimal("19.0"),
                                      "low_c": Decimal("-2.5"), "code": 3, "lat": Decimal("44.98")})
        self.assertEqual(kw["ConditionExpression"], "attribute_not_exists(sk)")

    def test_between_reads_one_range(self):
        table = FakeTable()
        self.assertEqual(Store(table).weather_between("u1", "2026-10-01", "2026-10-07"),
                         {"2026-10-07": {"pk": "USER#u1", "sk": "WEATHER#2026-10-07", "code": 3}})
        _, kw = table.calls[0]
        self.assertEqual(kw["KeyConditionExpression"], "pk = :u AND sk BETWEEN :a AND :b")
        self.assertEqual(kw["ExpressionAttributeValues"],
                         {":u": "USER#u1", ":a": "WEATHER#2026-10-01", ":b": "WEATHER#2026-10-07"})



class ReviewRequests(unittest.TestCase):
    # The exact table calls added after the 2026-10-08 review.

    def test_drop_day_removes_the_reply_address_and_only_its_own_day(self):
        table = FakeTable()
        Store(table).drop_day("u1", "2026-10-08", "tok")
        self.assertEqual(table.calls, [
            ("delete_item", {"Key": {"pk": "TOKEN#tok", "sk": "TOKEN"}}),
            ("delete_item", {"Key": {"pk": "USER#u1", "sk": "DAY#2026-10-08"}, "ConditionExpression": "#t = :t",
                             "ExpressionAttributeNames": {"#t": "token"}, "ExpressionAttributeValues": {":t": "tok"}}),
        ])

    def test_tally_adds_one_to_the_month(self):
        table = FakeTable()
        Store(table).tally("2026-10", "unsubscribes")
        self.assertEqual(table.calls, [("update_item", {
            "Key": {"pk": "TALLY#2026-10", "sk": "TALLY"}, "UpdateExpression": "ADD #n :one",
            "ExpressionAttributeNames": {"#n": "unsubscribes"}, "ExpressionAttributeValues": {":one": 1}})])

    def test_a_daily_counter_expires_two_days_on(self):
        table = FakeTable()
        table.update_item = lambda **kw: table.calls.append(("update_item", kw)) or {"Attributes": {"n": Decimal(1)}}
        self.assertEqual(Store(table).count("codefail:h", 20000, 86400), 1)
        self.assertEqual(table.calls[0][1]["ExpressionAttributeValues"][":exp"], 20002 * 86400)


if __name__ == "__main__":
    unittest.main()
