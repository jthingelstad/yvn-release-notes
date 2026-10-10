"""Writing an import plan (importer.py), on made-up entries and the fakes."""

import json
import unittest
from datetime import date
from decimal import Decimal

from fakes import FakeS3, FakeStore
from release_notes import dayone, importer
from release_notes.store import Store

PROFILE = {"birthday": "1981-06-14", "tz": "America/Chicago", "city": "Minneapolis", "region": "Minnesota",
           "country": "United States", "lat": 44.98, "lon": -93.26}
HARBOR = {"placeName": "Town Pier", "localityName": "Bar Harbor", "administrativeArea": "Maine",
          "country": "United States", "latitude": 44.391234, "longitude": -68.204321}
FILES = {"photos/p1.jpeg": b"jpeg-bytes", "pdfs/f1.pdf": b"%PDF-1.4"}
TODAY = date(2026, 10, 9)
A, B = "A" * 32, "B" * 32  # entry ids: Day One's are 32 hex digits


def entries():
    return [
        {"uuid": A,"creationDate": "2016-07-05T01:40:00Z", "timeZone": "America/New_York", "location": HARBOR,
         "text": "Fireworks over [the pier](https://pier.example/) and https://news.example/x",
         "photos": [{"md5": "p1", "type": "jpeg", "location": HARBOR}], "tags": ["Maine 2016"]},
        {"uuid": B,"creationDate": "2016-07-06T15:00:00Z", "timeZone": "America/New_York",
         "text": "Menu", "pdfAttachments": [{"md5": "f1", "pdfName": "Menu"}]},
    ]


def a_plan(journal="Journal"):
    return dayone.plan(journal, entries(), {k: len(v) for k, v in FILES.items()}, PROFILE, "u1")


class WriteTest(unittest.TestCase):
    def setUp(self):
        self.store, self.s3 = FakeStore(), FakeS3()
        self.store.profiles["u1"] = dict(PROFILE)
        self.titles, self.skies = [], []

    def title(self, url):
        self.titles.append(url)
        return {"title": "A page", "site": "news.example"}

    def sky(self, url):
        self.skies.append(url)
        day = url.split("start_date=")[1][:10]
        return {"daily": {"time": [day], "temperature_2m_max": [24.0], "temperature_2m_min": [15.5],
                          "weather_code": [1]}}

    def run_it(self, *plans):
        return importer.write([(p, FILES.__getitem__) for p in plans or [a_plan()]], "u1", store=self.store,
                              s3=self.s3, bucket="b", today=TODAY, at="2026-10-09T12:00:00Z",
                              fetch_title=self.title, fetch_weather=self.sky)

    def notes(self):
        return {i["sk"]: i for i in self.store.items["u1"] if i["sk"].startswith("NOTE#")}

    def test_writes_files_originals_notes_links_and_weather(self):
        counts = self.run_it()
        self.assertEqual({k: counts[k] for k in ("notes", "files", "originals", "links_named", "links_titled",
                                                 "weather_kept")},
                         {"notes": 2, "files": 2, "originals": 2, "links_named": 1, "links_titled": 1, "weather_kept": 2})
        a = self.notes()[f"NOTE#2016-07-04#d1-{A}"]
        self.assertEqual(a["source"], "import")
        self.assertEqual(a["links"], [{"url": "https://pier.example/", "title": "the pier", "named": True},
                                      {"url": "https://news.example/x", "title": "A page", "site": "news.example"}])
        self.assertEqual(self.titles, ["https://news.example/x"])  # the writer's own words are never fetched over
        photo = self.s3.objects[f"media/u1/2016-07-04/d1-{A}/1.jpg"]
        self.assertEqual((photo["Body"], photo["ContentType"], photo["ContentDisposition"]),
                         (b"jpeg-bytes", "image/jpeg", "inline"))
        self.assertEqual(self.s3.objects[f"media/u1/2016-07-06/d1-{B}/1.pdf"]["ContentType"], "application/pdf")
        original = self.s3.objects[f"raw/dayone/u1/{A}.json"]
        self.assertEqual((json.loads(original["Body"])["uuid"], original["Tagging"]), (A, "outcome=note"))
        sky = self.store.weather_between("u1", "2016-07-04", "2016-07-04")["2016-07-04"]
        self.assertEqual((sky["city"], sky["lat"], sky["high_c"]), ("Bar Harbor", 44.39, 24.0))
        self.assertIn("latitude=44.39&longitude=-68.2", self.skies[0])  # rounded, all Open-Meteo is told

    def test_a_repeat_writes_nothing_and_a_deleted_note_stays_deleted(self):
        self.run_it()
        self.store.items["u1"] = [i for i in self.store.items["u1"] if i["sk"] != f"NOTE#2016-07-06#d1-{B}"]
        self.s3.objects.clear()
        counts = self.run_it()
        self.assertEqual((counts["notes"], counts["already_imported"], counts["files"], counts["weather_had"]),
                         (0, 2, 0, 2))
        self.assertNotIn(f"NOTE#2016-07-06#d1-{B}", self.notes())
        self.assertEqual(self.s3.objects, {})

    def test_a_note_with_the_id_on_another_day_is_not_doubled(self):
        self.store.add_note("u1", "2016-07-05", f"d1-{A}", text="Moved by a zone change.")
        counts = self.run_it()
        self.assertEqual((counts["notes"], counts["id_taken"]), (1, 1))
        self.assertNotIn(f"NOTE#2016-07-04#d1-{A}", self.notes())

    def test_kept_weather_stands_and_today_is_left_alone(self):
        self.store.put_weather("u1", "2016-07-04", {"code": 3, "city": "Minneapolis"})
        counts = self.run_it()
        self.assertEqual((counts["weather_kept"], counts["weather_had"]), (1, 1))
        self.assertEqual(self.store.weather_between("u1", "2016-07-04", "2016-07-04")["2016-07-04"]["city"],
                         "Minneapolis")

    def test_each_journal_has_its_own_ledger(self):
        self.assertEqual(importer.ledger(a_plan("Gratitude")), "IMPORT#dayone#gratitude")
        self.run_it(a_plan())
        self.assertEqual(self.store.imported("u1", "IMPORT#dayone#journal"), {A, B})


class StoreNumbersTest(unittest.TestCase):
    def test_a_note_goes_with_decimals_all_the_way_down(self):
        class Table:
            def put_item(self, **kw):
                self.kw = kw

        table = Table()
        Store(table).put_note("u1", "2016-07-04", "d1-A", {"place": {"lat": 44.391234, "from": "entry"},
                                                           "media": [{"n": 1, "place": {"lon": -68.2}}]})
        item = table.kw["Item"]
        self.assertEqual(item["place"], {"lat": Decimal("44.391234"), "from": "entry"})
        self.assertEqual(item["media"][0]["place"]["lon"], Decimal("-68.2"))
        self.assertEqual(table.kw["ConditionExpression"], "attribute_not_exists(pk)")


if __name__ == "__main__":
    unittest.main()
