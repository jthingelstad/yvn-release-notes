"""Planning a Day One import (dayone.py), on made-up entries."""

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from release_notes import dayone

PROFILE = {"birthday": "1981-06-14", "tz": "America/Chicago", "city": "Minneapolis", "region": "Minnesota",
           "country": "United States", "lat": 44.98, "lon": -93.26}
HARBOR = {"userLabel": "", "placeName": "Town Pier", "localityName": "Bar Harbor", "administrativeArea": "Maine",
          "country": "United States", "latitude": 44.39123456789012, "longitude": -68.2043,
          "region": {"center": {}, "radius": 75.0}}


def entry(uuid, when, text="", tz="America/Chicago", **kw):
    return {"uuid": uuid, "creationDate": when, "timeZone": tz, "text": text, **kw}


def plan(entries, journal="Journal", names=None):
    return dayone.plan(journal, entries, names or {}, PROFILE, "u1", web_origin="https://notes.example")


class PlainTest(unittest.TestCase):
    def test_markdown_becomes_plain_text(self):
        text, named, counts = dayone.plain(
            "# A day\n\n![](dayone-moment://ABC)\n**Big** and *small* and _also_.\n* one\n* two\n"
            "Cost 5\\* stars \\#1 at [the shop](https://shop.example/a_b_c) and https://x.example/*not*/")
        self.assertEqual(text, "A day\n\nBig and small and also.\n- one\n- two\n"
                               "Cost 5* stars #1 at the shop <https://shop.example/a_b_c> and https://x.example/*not*/")
        self.assertEqual(named, {"https://shop.example/a_b_c": "the shop"})
        self.assertEqual((counts["photo_markers"], counts["headings"], counts["emphasis"], counts["bullets"],
                          counts["escapes"], counts["links"]), (1, 1, 3, 2, 2, 1))

    def test_entry_links_go_to_their_day_and_app_links_keep_their_words(self):
        uuid = "A" * 32
        text, named, counts = dayone.plain(
            f"See [the trip](dayone://view?entryId={uuid.lower()}) and [my journal](dayone://journal/1)",
            lambda u: "https://notes.example/day/?d=2016-07-04" if u == uuid else None)
        self.assertEqual(text, "See the trip <https://notes.example/day/?d=2016-07-04> and my journal")
        self.assertEqual(named, {"https://notes.example/day/?d=2016-07-04": "the trip"})
        self.assertEqual((counts["entry_links"], counts["app_links"]), (1, 1))


    def test_awkward_markdown_keeps_its_content(self):
        text, named, _ = dayone.plain("See [**Foo**](https://en.wikipedia.org/wiki/Foo_(bar)) now.<br>Next line"
                                      " \ue000 [a\\_b](https://x.example/a\\_b)")
        self.assertEqual(text, "See **Foo** <https://en.wikipedia.org/wiki/Foo_(bar)> now.\nNext line  a_b <https://x.example/a_b>"
                         .replace("**Foo**", "Foo"))
        self.assertEqual(named, {"https://en.wikipedia.org/wiki/Foo_(bar)": "Foo", "https://x.example/a_b": "a_b"})


class WhenAndWhereTest(unittest.TestCase):
    def test_the_day_is_in_the_entrys_zone_and_old_zone_names_are_renamed(self):
        e = entry("E1", "2016-07-05T01:40:00Z", "Fireworks.", tz="US/Eastern")
        self.assertEqual(dayone.zone(e), "America/New_York")
        self.assertEqual(dayone.day_of(e), "2016-07-04")

    def test_a_place_keeps_all_day_one_knew(self):
        self.assertEqual(dayone.place_of(HARBOR), {"venue": "Town Pier", "city": "Bar Harbor", "region": "Maine",
                                                   "country": "United States", "lat": 44.391235, "lon": -68.2043,
                                                   "accuracy_m": 75})
        self.assertIsNone(dayone.place_of({"placeName": "Nowhere"}))

    def test_a_street_address_is_an_address_and_a_label_is_the_writers(self):
        home = dayone.place_of({**HARBOR, "userLabel": "Cabin", "placeName": "6025 232nd St W"})
        self.assertEqual((home["label"], home["address"], "venue" in home), ("Cabin", "6025 232nd St W", False))
        for found in ("300–338 Washington Ave S", "17 Riesling St"):
            self.assertEqual(dayone.place_of({**HARBOR, "placeName": found})["address"], found)
        for found in ("7-Eleven", "3M Center", "7th St & 3rd/4th Ave", "Bar Harbor"):
            self.assertNotIn("address", dayone.place_of({**HARBOR, "placeName": found}))
        self.assertNotIn("venue", dayone.place_of({**HARBOR, "placeName": "Bar Harbor"}))  # just the town

    def test_places_fall_back_from_entry_to_photo_to_day_to_home(self):
        photo = {"md5": "p1", "type": "jpeg", "location": {"latitude": 44.40, "longitude": -68.21}}
        far = {"md5": "p2", "type": "jpeg", "location": {"latitude": 10.0, "longitude": 10.0}}
        names = {"photos/p1.jpeg": 10, "photos/p2.jpeg": 10}
        p = plan([
            entry("A", "2016-07-04T14:00:00Z", "Pier.", location=HARBOR),
            entry("B", "2016-07-04T15:00:00Z", "Near it.", photos=[photo]),
            entry("C", "2016-07-04T16:00:00Z", "No place."),
            entry("D", "2016-07-06T16:00:00Z", "Far off.", photos=[far]),
            entry("E", "2016-07-08T16:00:00Z", "Home."),
        ], names=names)
        by = {n["id"]: n for n in p["notes"]}
        # The photo's own spot, with the town of an entry within a few km, not its venue.
        self.assertEqual(by["d1-B"]["item"]["place"], {"city": "Bar Harbor", "region": "Maine", "country": "United States",
                                                       "lat": 44.4, "lon": -68.21, "from": "photo"})
        self.assertEqual(by["d1-B"]["item"]["media"][0]["place"], {"lat": 44.4, "lon": -68.21})
        self.assertEqual(by["d1-C"]["item"]["place"]["venue"], "Town Pier")
        self.assertEqual(by["d1-C"]["item"]["place"]["from"], "day")
        self.assertEqual(by["d1-D"]["item"]["place"], {"lat": 10.0, "lon": 10.0, "from": "photo"})
        self.assertEqual(by["d1-E"]["item"]["place"]["city"], "Minneapolis")
        self.assertEqual(by["d1-E"]["item"]["place"]["from"], "home")
        self.assertEqual(p["place_from"], {"entry": 1, "photo": 2, "day": 1, "home": 1})


class FilesTest(unittest.TestCase):
    def test_files_are_found_by_md5_whatever_their_extension(self):
        e = entry("A", "2020-01-01T12:00:00Z", "", audios=[{"md5": "a1", "format": "aac", "duration": 12.34}],
                  photos=[{"md5": "p2", "type": "jpeg", "orderInEntry": 1, "width": 30, "height": 20},
                          {"md5": "p1", "type": "jpeg", "orderInEntry": 0}],
                  pdfAttachments=[{"md5": "f1", "pdfName": "Menu"}, {"md5": "gone"}])
        names = {"audios/a1.m4a": 5, "photos/p1.jpeg": 6, "photos/p2.jpeg": 7, "pdfs/f1.pdf": 8}
        files, missing = dayone.files_of(e, dayone.by_md5(names))
        self.assertEqual([(f["kind"], f["type"], f["from"]) for f in files], [
            ("image", "image/jpeg", "photos/p1.jpeg"), ("image", "image/jpeg", "photos/p2.jpeg"),
            ("audio", "audio/mp4", "audios/a1.m4a"), ("file", "application/pdf", "pdfs/f1.pdf")])
        self.assertEqual((files[1]["width"], files[2]["duration"], files[3]["name"]), (30, 12.3, "Menu.pdf"))
        self.assertEqual(missing, ["gone"])

    def test_media_keys_follow_the_note(self):
        p = plan([entry("A", "2020-01-01T18:00:00Z", photos=[{"md5": "p1", "type": "png"}])],
                 names={"photos/p1.png": 99})
        (m,) = p["notes"][0]["item"]["media"]
        self.assertEqual((m["n"], m["key"], m["size"]), (1, "media/u1/2020-01-01/d1-A/1.png", 99))


class PlanTest(unittest.TestCase):
    def test_an_entry_becomes_a_note_like_any_other(self):
        p = plan([entry("A", "2016-07-05T01:40:00Z", "Fireworks.", tz="US/Eastern", tags=["Maine 2016", "vacation"],
                        location=HARBOR)])
        (n,) = p["notes"]
        self.assertEqual((n["date"], n["id"]), ("2016-07-04", "d1-A"))
        item = n["item"]
        self.assertEqual(item["text"], "Fireworks.\n\n#maine-2016 #vacation")
        self.assertEqual(item["tags"], ["maine-2016", "vacation"])
        self.assertEqual((item["source"], item["tz"], item["written_at"], item["version"]),
                         ("import", "America/New_York", "2016-07-05T01:40:00Z", "3.5.20"))
        self.assertEqual(item["origin"], {"app": "dayone", "journal": "Journal", "id": "A"})
        self.assertEqual(item["raw_key"], "raw/dayone/u1/A.json")
        self.assertEqual(n["original"]["location"], HARBOR)  # kept whole, to store at raw_key

    def test_another_journals_name_is_a_tag(self):
        p = plan([entry("A", "2020-01-01T12:00:00Z", "Thankful.")], journal="Gratitude")
        self.assertEqual(p["notes"][0]["item"]["tags"], ["gratitude"])

    def test_a_long_entry_is_cut_before_its_tags(self):
        from release_notes.notes import MAX_NOTE
        p = plan([entry("A", "2020-01-01T12:00:00Z", "word " * MAX_NOTE, tags=["Long one"])], journal="Travel")
        item = p["notes"][0]["item"]
        self.assertLessEqual(len(item["text"]), MAX_NOTE)
        self.assertTrue(item["text"].endswith("\n\n#long-one #travel"))
        self.assertEqual((item["tags"], p["counts"]["cut"]), (["long-one", "travel"], 1))

    def test_an_entry_of_only_videos_is_counted_not_lost_quietly(self):
        p = plan([entry("A", "2020-01-01T12:00:00Z", videos=[{"md5": "v1"}])])
        self.assertEqual(p["skipped"][0]["why"], "files not carried")
        self.assertEqual(p["counts"]["files_not_carried"], 1)

    def test_files_to_copy_are_listed_apart_from_the_note(self):
        p = plan([entry("A", "2020-01-01T18:00:00Z", "x", photos=[{"md5": "p1", "type": "png"}])],
                 names={"photos/p1.png": 99})
        n = p["notes"][0]
        self.assertEqual(n["files"], [{"from": "photos/p1.png", "key": "media/u1/2020-01-01/d1-A/1.png",
                                       "type": "image/png"}])
        self.assertNotIn("from", n["item"]["media"][0])

    def test_day_ones_own_guide_is_left_out(self):
        p = plan([entry("A", "2024-02-17T12:00:00Z", "Day One Essentials Guide\nWelcome to Day One, we are glad.")])
        self.assertEqual((p["notes"], p["skipped"][0]["why"]), ([], "day one's own"))

    def test_an_all_day_entry_is_all_day_on_its_own_date(self):
        p = plan([entry("A", "2016-12-25T06:00:00Z", "Christmas.", isAllDay=True)])
        n = p["notes"][0]
        self.assertEqual((n["date"], n["item"]["all_day"]), ("2016-12-25", True))

    def test_empty_entries_are_left_out(self):
        p = plan([entry("A", "2020-01-01T12:00:00Z", "![](dayone-moment://X)")])
        self.assertEqual((p["notes"], p["skipped"]), ([], [{"date": "2020-01-01", "uuid": "A", "why": "empty"}]))

    def test_weather_takes_the_days_first_real_place_across_journals(self):
        home = plan([entry("A", "2016-07-04T12:00:00Z", "Early, no place.")])
        away = plan([entry("B", "2016-07-04T18:00:00Z", "Pier.", tz="America/New_York", location=HARBOR)])
        days = dayone.weather_days(home["notes"] + away["notes"])
        # The town and coordinates to two places: all that goes to Open-Meteo.
        self.assertEqual(days["2016-07-04"], {"city": "Bar Harbor", "region": "Maine", "country": "United States",
                                              "lat": 44.39, "lon": -68.2, "tz": "America/New_York"})
        self.assertEqual(dayone.weather_days(home["notes"])["2016-07-04"]["city"], "Minneapolis")


class ReadTest(unittest.TestCase):
    def test_reads_the_journal_and_every_file_size(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d, "export.zip")
            with zipfile.ZipFile(path, "w") as z:
                z.writestr("Travel.json", json.dumps({"entries": [entry("A", "2020-01-01T12:00:00Z", "Hi")]}))
                z.writestr("photos/p1.jpeg", b"12345")
            journal, entries, names = dayone.read(str(path))
        self.assertEqual((journal, len(entries), names["photos/p1.jpeg"]), ("Travel", 1, 5))


if __name__ == "__main__":
    unittest.main()
