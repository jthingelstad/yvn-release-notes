import unittest

from release_notes.notes import combine
from release_notes.store import Store


class FakeTable:
    """Query in key order, two items to a page, as DynamoDB would."""

    def __init__(self, items):
        self.items = sorted(items, key=lambda i: (i["pk"], i["sk"]))

    def query(self, KeyConditionExpression, ExpressionAttributeValues, ExclusiveStartKey=None, **_):
        v = ExpressionAttributeValues
        if ":n" in v:
            keep = lambda sk: sk.startswith(v[":n"])  # noqa: E731
        else:
            keep = lambda sk: v[":a"] <= sk <= v[":b"]  # noqa: E731
        hits = [i for i in self.items if i["pk"] == v[":u"] and keep(i["sk"])]
        start = hits.index(ExclusiveStartKey) + 1 if ExclusiveStartKey else 0
        page = hits[start : start + 2]
        out = {"Items": page}
        if start + 2 < len(hits):
            out["LastEvaluatedKey"] = page[-1]
        return out


def note(day, msg, at, text):
    return {"pk": "USER#u1", "sk": f"NOTE#{day}#{msg}", "received_at": at, "text": text}


class DayNotes(unittest.TestCase):
    def test_one_day_oldest_first_across_pages(self):
        # Message ids are random: "zz" arrived first, "aa" last.
        table = FakeTable([
            note("2026-10-08", "zz", "2026-10-08T13:00:00Z", "Morning run."),
            note("2026-10-08", "mm", "2026-10-08T18:00:00Z", "Lunch with Grace."),
            note("2026-10-08", "aa", "2026-10-09T03:00:00Z", "Finished the shelf."),
            note("2026-10-07", "bb", "2026-10-08T02:00:00Z", "Yesterday."),
            note("2026-10-08", "cc", "2026-10-08T14:00:00Z", "Coffee."),
        ])
        got = Store(table).day_notes("u1", "2026-10-08")
        self.assertEqual([n["text"] for n in got], ["Morning run.", "Coffee.", "Lunch with Grace.", "Finished the shelf."])

    def test_a_range_of_days_takes_in_the_last_days_notes(self):
        table = FakeTable([
            note("2026-10-06", "zz", "2026-10-06T13:00:00Z", "Before."),
            note("2026-10-07", "zz", "2026-10-07T13:00:00Z", "First."),
            note("2026-10-08", "w-1", "2026-10-08T18:00:00Z", "Web, later."),
            note("2026-10-08", "aa", "2026-10-08T13:00:00Z", "Email, earlier."),
            note("2026-10-09", "aa", "2026-10-09T13:00:00Z", "After."),
        ])
        got = Store(table).notes_between("u1", "2026-10-07", "2026-10-08")
        self.assertEqual([n["text"] for n in got], ["First.", "Email, earlier.", "Web, later."])


class Combine(unittest.TestCase):
    def test_replies_read_as_one_day(self):
        notes = [{"text": "Morning run."}, {"text": "Lunch with Grace.\nGood talk."}]
        self.assertEqual(combine(notes), "Morning run.\n\nLunch with Grace.\nGood talk.")

    def test_one_reply_is_itself(self):
        self.assertEqual(combine([{"text": "Fifty."}]), "Fifty.")

    def test_photo_only_reply_adds_no_text(self):
        self.assertEqual(combine([{"text": "Fifty."}, {"text": "", "attachments": [{"content_type": "image/jpeg"}]}]), "Fifty.")

    def test_a_reply_sent_twice_shows_once(self):
        self.assertEqual(combine([{"text": "Fifty."}, {"text": "Fifty.\n"}, {"text": "Cake."}]), "Fifty.\n\nCake.")

    def test_no_notes(self):
        self.assertEqual(combine([]), "")


if __name__ == "__main__":
    unittest.main()
