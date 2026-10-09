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



class NoteQueries(unittest.TestCase):
    RANGE = {":u": "USER#u1", ":a": "NOTE#0000-00-00#", ":b": "NOTE#9999-99-99$"}

    def test_every_note_is_the_whole_range_and_nothing_else(self):
        table = FakeTable()
        Store(table).all_notes("u1")
        self.assertEqual(table.calls[0][1], {"KeyConditionExpression": "pk = :u AND sk BETWEEN :a AND :b",
                                             "ExpressionAttributeValues": self.RANGE})

    def test_tags_bring_back_keys_and_tags_only(self):
        table = FakeTable()
        Store(table).note_tags("u1")
        self.assertEqual(table.calls[0][1], {"KeyConditionExpression": "pk = :u AND sk BETWEEN :a AND :b",
                                             "ExpressionAttributeValues": self.RANGE,
                                             "ExpressionAttributeNames": {"#g": "tags"},
                                             "ProjectionExpression": "sk, #g"})

    def test_a_tag_brings_back_only_its_notes(self):
        table = FakeTable()
        Store(table).tagged_notes("u1", "maine-2016")
        self.assertEqual(table.calls[0][1], {"KeyConditionExpression": "pk = :u AND sk BETWEEN :a AND :b",
                                             "ExpressionAttributeValues": {**self.RANGE, ":g": "maine-2016"},
                                             "ExpressionAttributeNames": {"#g": "tags"},
                                             "FilterExpression": "contains(#g, :g)"})


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



class UpdateNote(unittest.TestCase):
    def table(self):
        t = FakeTable()
        t.update_item = lambda **kw: t.calls.append(("update_item", kw)) or {"Attributes": {}}
        return t

    def test_sets_links_and_tags_it_has_and_removes_the_rest(self):
        t = self.table()
        Store(t).update_note("u1", "2026-10-08", "w-1", "Hi #kubb", "2026-10-08T12:00:00Z", None, ["kubb"])
        kw = t.calls[0][1]
        self.assertEqual(kw["UpdateExpression"], "SET #t = :t, updated_at = :at, tags = :g REMOVE links")
        self.assertEqual(kw["ExpressionAttributeValues"], {":t": "Hi #kubb", ":at": "2026-10-08T12:00:00Z", ":g": ["kubb"]})

    def test_with_neither_both_go(self):
        t = self.table()
        Store(t).update_note("u1", "2026-10-08", "w-1", "Hi", "2026-10-08T12:00:00Z")
        self.assertEqual(t.calls[0][1]["UpdateExpression"], "SET #t = :t, updated_at = :at REMOVE links, tags")


class AddMedia(unittest.TestCase):
    def table(self):
        t = FakeTable()
        t.update_item = lambda **kw: t.calls.append(("update_item", kw)) or {"Attributes": {}}
        return t

    def test_appends_only_if_the_note_still_has_what_it_was_read_with(self):
        t = self.table()
        entry = {"n": 3, "kind": "image", "type": "image/png", "size": 10, "key": "media/u1/web/a.png"}
        Store(t).add_media("u1", "2026-10-08", "w-1", [entry], 2, "2026-10-09T12:00:00Z")
        kw = t.calls[0][1]
        self.assertEqual(kw["UpdateExpression"], "SET media = list_append(if_not_exists(media, :none), :m), updated_at = :at")
        self.assertEqual(kw["ConditionExpression"], "attribute_exists(pk) AND size(media) = :had")
        self.assertEqual(kw["ExpressionAttributeValues"],
                         {":m": [entry], ":none": [], ":at": "2026-10-09T12:00:00Z", ":had": 2})

    def test_a_note_without_files_must_still_have_none(self):
        t = self.table()
        Store(t).add_media("u1", "2026-10-08", "w-1", [], 0, "2026-10-09T12:00:00Z")
        kw = t.calls[0][1]
        self.assertEqual(kw["ConditionExpression"], "attribute_exists(pk) AND attribute_not_exists(media)")
        self.assertNotIn(":had", kw["ExpressionAttributeValues"])


class SetMediaText(unittest.TestCase):
    def table(self, media):
        t = FakeTable()
        t.get_item = lambda **kw: {"Item": {"media": media}} if media is not None else {}
        t.update_item = lambda **kw: t.calls.append(("update_item", kw)) or {}
        return t

    def test_the_words_go_on_the_file_with_that_number_if_it_is_still_there(self):
        t = self.table([{"n": Decimal(1), "kind": "image"}, {"n": Decimal(2), "kind": "audio"}])
        self.assertTrue(Store(t).set_media_text("u1", "2026-10-09", "w-1", 2, "transcript", "Hello."))
        kw = t.calls[0][1]
        self.assertEqual(kw["UpdateExpression"], "SET media[1].#f = :t")
        self.assertEqual(kw["ExpressionAttributeNames"], {"#f": "transcript"})
        self.assertEqual(kw["ConditionExpression"], "attribute_exists(pk) AND media[1].n = :n")
        self.assertEqual(kw["ExpressionAttributeValues"], {":t": "Hello.", ":n": 2})

    def test_no_note_or_no_such_file_writes_nothing(self):
        for media in (None, [{"n": Decimal(1)}]):
            t = self.table(media)
            self.assertFalse(Store(t).set_media_text("u1", "2026-10-09", "w-1", 2, "transcript", "Hello."))
            self.assertEqual(t.calls, [])


if __name__ == "__main__":
    unittest.main()


class ScanTable(FakeTable):
    def __init__(self, pages):
        super().__init__()
        self.pages = list(pages)

    def scan(self, **kw):
        self.calls.append(("scan", kw))
        return self.pages.pop(0)


class CensusItems(unittest.TestCase):
    def test_one_paged_scan_of_keys_and_a_few_fields_never_text(self):
        t = ScanTable([{"Items": [{"pk": "USER#u1", "sk": "PROFILE"}], "LastEvaluatedKey": {"pk": "x"}},
                       {"Items": [{"pk": "USER#u1", "sk": "NOTE#2026-10-07#m1"}]}])
        items = Store(t).census_items()
        self.assertEqual(len(items), 2)
        (_, first), (_, second) = t.calls
        self.assertEqual(second["ExclusiveStartKey"], {"pk": "x"})
        self.assertEqual(first["FilterExpression"], "begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :d) OR begins_with(sk, :n))")
        fields = [f.strip() for f in first["ProjectionExpression"].split(",")]
        names = first["ExpressionAttributeNames"]
        named = {names.get(f.split("[")[0], f.split("[")[0]) for f in fields}
        self.assertEqual(named, {"pk", "sk", "status", "tz", "send_time", "last_sent_date", "pause_from", "pause_through", "source", "media"})
        self.assertEqual(first["ExpressionAttributeValues"], {":u": "USER#", ":p": "PROFILE", ":d": "DAY#", ":n": "NOTE#"})
