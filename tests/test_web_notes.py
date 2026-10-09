from fakes import FakeS3
from test_web import WebCase

# NOW is 17:53 in Chicago on 2026-10-08. Ada, born 1981-06-14, is 4.5.116.
TODAY = "2026-10-08"


class NotesCase(WebCase):
    def setUp(self):
        super().setUp()
        self.subscribe()
        self.cookies = [self.signed_in()]

    def get(self, path, **kw):
        return self.call("GET", path, cookies=self.cookies, **kw)

    def add(self, day, text, **kw):
        return self.call("POST", f"/api/days/{day}/notes", {"text": text}, cookies=self.cookies, **kw)

    def emailed(self, day, note_id="0100abc-1", at="2026-10-08T11:42:00.000Z", text="Walked before the rain.", **kw):
        self.store.add_note("u1", day, note_id, text=text, received_at=at, version="x", **kw)


class TodayTest(NotesCase):
    def test_today_with_nothing_yet(self):
        r, body = self.get("/api/today")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual((body["date"], body["version"], body["notes"]), (TODAY, "4.5.116", []))
        self.assertEqual(body["dots"], 8)  # 116 of 365 days, in 24 dots
        self.assertEqual(body["next"], {"version": "4.6.0", "date": "2027-06-14"})
        self.assertEqual(body["streak"], {"current": 0, "longest": 0, "today": False})

    def test_a_note_written_today_shows_with_the_emailed_one(self):
        self.emailed(TODAY)
        r, note = self.add(TODAY, "  Shipped the thing.\r\nFinally.  ")
        self.assertEqual(r["statusCode"], 201)
        self.assertEqual((note["source"], note["text"], note["late"]), ("web", "Shipped the thing.\nFinally.", False))
        self.assertTrue(note["id"].startswith("w-"))
        _, body = self.get("/api/today")
        self.assertEqual([n["source"] for n in body["notes"]], ["email", "web"])
        self.assertEqual(body["streak"], {"current": 1, "longest": 1, "today": True})
        stored = self.store.notes_between("u1", TODAY, TODAY)[1]
        self.assertEqual((stored["version"], stored["source"]), ("4.5.116", "web"))
        self.assertNotIn("Shipped", self.out.getvalue())

    def test_streak_counts_today_once_it_has_a_note(self):
        self.emailed("2026-10-06", "a")
        self.emailed("2026-10-07", "b")
        _, body = self.get("/api/today")
        self.assertEqual(body["streak"], {"current": 2, "longest": 2, "today": False})
        self.add(TODAY, "Third.")
        _, body = self.get("/api/today")
        self.assertEqual(body["streak"], {"current": 3, "longest": 3, "today": True})

    def test_needs_an_account(self):
        r, _ = self.call("GET", "/api/today")
        self.assertEqual(r["statusCode"], 401)
        r, body = self.call("GET", "/api/today", cookies=[self.signed_in("new@example.com")])
        self.assertEqual((r["statusCode"], body["error"]), (403, "no-account"))


class WriteTest(NotesCase):
    def test_backfill_any_day_from_the_birthday(self):
        for day, version in [("1981-06-14", "0.0.0"), ("1990-01-01", "0.8.201"), ("2026-10-07", "4.5.115")]:
            r, _ = self.add(day, "Then.")
            self.assertEqual(r["statusCode"], 201, day)
            self.assertEqual(self.store.notes_between("u1", day, day)[0]["version"], version)

    def test_no_day_before_the_birthday_or_after_today(self):
        for day in ("1981-06-13", "2026-10-09", "2026-02-30"):
            r, body = self.add(day, "Never.")
            self.assertEqual((r["statusCode"], body["error"]), (400, "date"), day)
        self.assertEqual(self.store.note_days("u1"), set())

    def test_today_follows_the_subscribers_zone(self):
        # 22:53 UTC is already the 9th in Tokyo.
        self.store.profiles["u1"]["tz"] = "Asia/Tokyo"
        r, _ = self.add("2026-10-09", "Tomorrow, from Chicago.")
        self.assertEqual(r["statusCode"], 201)

    def test_the_text_must_be_something(self):
        for text, error in [("", "text"), ("   \n ", "text"), (None, "text"), (42, "text"), ("x" * 20_001, "too-long")]:
            r, body = self.add(TODAY, text)
            self.assertEqual((r["statusCode"], body["error"]), (400, error), repr(text)[:20])

    def test_writes_need_our_origin(self):
        r, _ = self.add(TODAY, "Hi.", origin="https://evil.example")
        self.assertEqual(r["statusCode"], 403)
        r, _ = self.add(TODAY, "Hi.", origin=None)
        self.assertEqual(r["statusCode"], 403)


class EditDeleteTest(NotesCase):
    def put(self, day, note_id, text):
        return self.call("PUT", f"/api/days/{day}/notes/{note_id}", {"text": text}, cookies=self.cookies)

    def delete(self, day, note_id, cookies=None):
        return self.call("DELETE", f"/api/days/{day}/notes/{note_id}", cookies=cookies or self.cookies)

    def test_edit_any_note_emailed_ones_too(self):
        self.emailed(TODAY)
        r, note = self.put(TODAY, "0100abc-1", "Walked before the rain came in.")
        self.assertEqual((r["statusCode"], note["text"], note["source"]), (200, "Walked before the rain came in.", "email"))
        self.assertEqual(note["edited_at"], "2026-10-08T22:53:20Z")
        r, body = self.put(TODAY, "nope", "x")
        self.assertEqual((r["statusCode"], body["error"]), (404, "note"))
        r, body = self.put(TODAY, "0100abc-1", " ")
        self.assertEqual(body["error"], "text")

    def test_delete_a_web_note(self):
        _, note = self.add(TODAY, "Oops.")
        r, _ = self.delete(TODAY, note["id"])
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.store.notes_between("u1", TODAY, TODAY), [])
        self.assertEqual(self.s3.deleted, [])
        r, _ = self.delete(TODAY, note["id"])
        self.assertEqual(r["statusCode"], 404)

    def test_deleting_an_emailed_note_deletes_its_email(self):
        self.emailed(TODAY, raw_key="raw/0100abc-1")
        r, _ = self.delete(TODAY, "0100abc-1")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.s3.deleted, [{"Bucket": "mail-bucket", "Key": "raw/0100abc-1"}])

    def test_if_the_email_cannot_be_deleted_the_note_stays(self):
        self.emailed(TODAY, raw_key="raw/0100abc-1")
        self.s3 = FakeS3(fail=True)
        with self.assertRaises(ConnectionError):
            self.delete(TODAY, "0100abc-1")
        self.assertEqual(len(self.store.notes_between("u1", TODAY, TODAY)), 1)

    def test_only_your_own(self):
        self.emailed(TODAY)
        self.subscribe("bob@example.com", "u2")
        bob = [self.signed_in("bob@example.com")]
        r, _ = self.delete(TODAY, "0100abc-1", cookies=bob)
        self.assertEqual(r["statusCode"], 404)
        _, day = self.call("GET", f"/api/days/{TODAY}", cookies=bob)
        self.assertEqual(day["notes"], [])
        self.assertEqual(len(self.store.notes_between("u1", TODAY, TODAY)), 1)


class DaysTest(NotesCase):
    def test_one_day(self):
        self.emailed("2026-10-05", at="2026-10-07T13:00:00Z")  # replied two days late
        r, body = self.get("/api/days/2026-10-05")
        self.assertEqual((r["statusCode"], body["version"], body["today"]), (200, "4.5.113", False))
        self.assertEqual(body["notes"][0]["late"], True)
        r, body = self.get("/api/days/1981-06-13")
        self.assertEqual((r["statusCode"], body["error"]), (400, "date"))

    def test_timeline_newest_first_and_pages_back(self):
        for day in ("2026-10-05", "2026-10-06", "2026-10-07"):
            self.store.add_day("u1", day)
        self.emailed("2026-10-07", "a", text="Seventh.")
        self.emailed("2026-10-05", "b", text="Fifth.")
        self.emailed("2020-01-01", "c", text="Long ago.")  # backfilled, no email that day
        _, body = self.get("/api/days", query={"limit": "3"})
        self.assertEqual([d["date"] for d in body["days"]], [TODAY, "2026-10-07", "2026-10-06"])
        self.assertEqual([len(d["notes"]) for d in body["days"]], [0, 1, 0])
        self.assertEqual(body["before"], "2026-10-06")
        _, body = self.get("/api/days", query={"limit": "3", "before": body["before"]})
        self.assertEqual([d["date"] for d in body["days"]], ["2026-10-05", "2020-01-01"])
        self.assertEqual(body["days"][1]["version"], "3.8.201")
        self.assertIsNone(body["before"])
        self.assertNotIn("Seventh", self.out.getvalue())

    def test_timeline_limits(self):
        r, body = self.get("/api/days", query={"limit": "lots"})
        self.assertEqual((r["statusCode"], body["error"]), (400, "limit"))
        r, body = self.get("/api/days", query={"before": "2026-10-10"})
        self.assertEqual((r["statusCode"], body["error"]), (400, "date"))


class LinksTest(NotesCase):
    def setUp(self):
        super().setUp()
        self.titles = {"https://example.com/a": {"title": "Page A", "site": "example.com"},
                       "https://example.com/b": {"title": "Page B", "site": "example.com"}}

    def put(self, note_id, text):
        return self.call("PUT", f"/api/days/{TODAY}/notes/{note_id}", {"text": text}, cookies=self.cookies)

    def test_a_new_note_names_its_links_once(self):
        r, note = self.add(TODAY, "Read https://example.com/a and https://example.com/missing.")
        self.assertEqual(r["statusCode"], 201)
        self.assertEqual(note["parts"], [
            "Read ", {"url": "https://example.com/a", "label": "Page A", "site": "example.com"},
            " and ", {"url": "https://example.com/missing", "label": "example.com/missing"}, ".",
        ])
        stored = self.store.notes_between("u1", TODAY, TODAY)[0]
        self.assertEqual(stored["text"], "Read https://example.com/a and https://example.com/missing.")
        self.assertEqual(stored["links"], [{"url": "https://example.com/a", "title": "Page A", "site": "example.com"}])
        _, today = self.get("/api/today")
        self.assertEqual(today["notes"][0]["parts"][1]["label"], "Page A")
        self.assertNotIn("example.com/a", self.out.getvalue())

    def test_an_edit_fetches_only_new_addresses(self):
        _, note = self.add(TODAY, "https://example.com/a")
        self.titles["https://example.com/a"] = {"title": "Changed since", "site": "example.com"}
        self.fetched.clear()
        r, edited = self.put(note["id"], "https://example.com/a then https://example.com/b")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.fetched, ["https://example.com/b"])
        self.assertEqual([p["label"] for p in edited["parts"] if isinstance(p, dict)], ["Page A", "Page B"])
        r, edited = self.put(note["id"], "No links now.")
        self.assertEqual(edited["parts"], ["No links now."])
        self.assertNotIn("links", self.store.notes_between("u1", TODAY, TODAY)[0])

    def test_a_note_without_addresses_fetches_nothing(self):
        self.add(TODAY, "Cake.")
        self.assertEqual(self.fetched, [])
        self.assertNotIn("links", self.store.notes_between("u1", TODAY, TODAY)[0])


PHOTO = {"n": 1, "kind": "image", "type": "image/jpeg", "size": 2324894, "key": "media/u1/2026-10-07/0100abc-1/1.jpg"}
MEMO = {"n": 2, "kind": "audio", "type": "audio/mp4", "size": 4096, "key": "media/u1/2026-10-07/0100abc-1/2.m4a"}


class MediaTest(NotesCase):
    def setUp(self):
        super().setUp()
        self.emailed("2026-10-07", text="", raw_key="raw/0100abc-1", media=[PHOTO, MEMO],
                     attachments=[{"content_type": "image/jpeg", "filename": "image0.jpeg", "size": 2324894},
                                  {"content_type": "audio/x-m4a", "filename": "Memo.m4a", "size": 4096},
                                  {"content_type": "video/quicktime", "filename": "IMG_0003.MOV", "size": 9000000}])

    def file(self, n, day="2026-10-07", note="0100abc-1", **kw):
        kw.setdefault("cookies", self.cookies)
        return self.call("GET", f"/api/days/{day}/notes/{note}/media/{n}", **kw)

    def test_the_day_lists_files_without_their_keys(self):
        _, day = self.get("/api/days/2026-10-07")
        note = day["notes"][0]
        self.assertEqual(note["media"], [{"n": 1, "kind": "image", "type": "image/jpeg"},
                                         {"n": 2, "kind": "audio", "type": "audio/mp4"}])
        self.assertEqual(note["attachments"], 1)  # the video, still in the email
        _, days = self.get("/api/days")
        self.assertNotIn("media/u1", str(days))

    def test_an_imported_pdf_lists_with_its_name(self):
        pdf = {"n": 1, "kind": "file", "type": "application/pdf", "size": 9, "name": "Menu.pdf",
               "key": "media/u1/2026-10-06/d1-A/1.pdf"}
        self.store.add_note("u1", "2026-10-06", "d1-A", text="Dinner.", source="import", media=[pdf])
        _, day = self.get("/api/days/2026-10-06")
        self.assertEqual(day["notes"][0]["media"],
                         [{"n": 1, "kind": "file", "type": "application/pdf", "name": "Menu.pdf"}])

    def test_a_file_is_a_short_lived_redirect_for_its_owner(self):
        r, _ = self.file(1)
        self.assertEqual(r["statusCode"], 302)
        self.assertEqual(r["headers"]["location"], "/dev-media/media/u1/2026-10-07/0100abc-1/1.jpg")
        self.assertEqual(r["headers"]["cache-control"], "private, max-age=300")
        self.assertEqual(self.s3.signed["ExpiresIn"], 600)
        self.assertEqual(self.s3.signed["Params"]["ResponseContentType"], "image/jpeg")
        self.assertEqual(self.s3.signed["Params"]["Bucket"], "mail-bucket")
        r, _ = self.file(2)
        self.assertEqual(self.s3.signed["Params"]["Key"], MEMO["key"])

    def test_nobody_else_gets_one(self):
        for n, kw in [(3, {}), (1, {"note": "nope"}), (1, {"day": "2026-10-06"}), (1, {"cookies": None})]:
            r, _ = self.file(n, **kw)
            self.assertIn(r["statusCode"], (401, 404), (n, kw))
        self.subscribe("bob@example.com", "u2")
        r, _ = self.file(1, cookies=[self.signed_in("bob@example.com")])
        self.assertEqual(r["statusCode"], 404)
        r, _ = self.call("GET", "/api/days/2026-10-07/notes/0100abc-1/media/0", cookies=self.cookies)
        self.assertEqual(r["statusCode"], 404)

    def test_a_key_outside_the_owners_files_is_never_signed(self):
        self.emailed("2026-10-06", note_id="odd", media=[{**PHOTO, "key": "raw/0100abc-1"}])
        r, _ = self.file(1, day="2026-10-06", note="odd")
        self.assertEqual(r["statusCode"], 404)
        self.assertFalse(hasattr(self.s3, "signed"))

    def test_deleting_the_note_deletes_its_files(self):
        r, _ = self.call("DELETE", "/api/days/2026-10-07/notes/0100abc-1", cookies=self.cookies)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual([d["Key"] for d in self.s3.deleted], ["raw/0100abc-1", PHOTO["key"], MEMO["key"]])


class TagsTest(NotesCase):
    def put(self, day, note_id, text):
        return self.call("PUT", f"/api/days/{day}/notes/{note_id}", {"text": text}, cookies=self.cookies)

    def test_hashtags_are_the_notes_tags(self):
        r, note = self.add(TODAY, "Kubb at the park with #Tyler. #kubb #Tyler")
        self.assertEqual(note["tags"], ["tyler", "kubb"])
        self.assertEqual(note["parts"], ["Kubb at the park with ", {"tag": "tyler", "text": "#Tyler"}, ". ",
                                         {"tag": "kubb", "text": "#kubb"}, " ", {"tag": "tyler", "text": "#Tyler"}])
        self.assertEqual(self.store.notes_between("u1", TODAY, TODAY)[0]["tags"], ["tyler", "kubb"])

    def test_an_edit_works_the_tags_out_again(self):
        _, note = self.add(TODAY, "Up north. #cabin #kubb")
        _, note = self.put(TODAY, note["id"], "Up north. #cabin #Big-Green-Egg")
        self.assertEqual(note["tags"], ["cabin", "big-green-egg"])
        _, note = self.put(TODAY, note["id"], "Up north.")
        self.assertNotIn("tags", note)
        self.assertNotIn("tags", self.store.notes_between("u1", TODAY, TODAY)[0])

    def test_tags_from_an_emailed_note_count_too(self):
        self.emailed("2026-10-01", "m1", text="Cake. #birthday", tags=["birthday"])
        self.add("2026-10-03", "More cake. #birthday #cake")
        self.add(TODAY, "Nothing tagged.")
        r, body = self.get("/api/tags")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(body["tags"], [
            {"tag": "birthday", "notes": 2, "days": 2, "first": "2026-10-01", "last": "2026-10-03"},
            {"tag": "cake", "notes": 1, "days": 1, "first": "2026-10-03", "last": "2026-10-03"},
        ])

    def test_a_tags_days_newest_first_with_only_its_notes(self):
        self.add("2026-10-01", "Cake. #birthday")
        self.add("2026-10-01", "Untagged, same day.")
        self.add("2026-10-03", "More. #Birthday")
        r, body = self.get("/api/tags/birthday")
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual([d["date"] for d in body["days"]], ["2026-10-03", "2026-10-01"])
        self.assertEqual([len(d["notes"]) for d in body["days"]], [1, 1])
        self.assertEqual(body["days"][1]["version"], "4.5.109")

    def test_a_tag_nobody_used_is_no_days_and_a_bad_one_not_found(self):
        _, body = self.get("/api/tags/nothing-here")
        self.assertEqual(body["days"], [])
        r, _ = self.get("/api/tags/Not%20A%20Tag")
        self.assertEqual(r["statusCode"], 404)

    def test_tags_need_an_account(self):
        r, _ = self.call("GET", "/api/tags")
        self.assertEqual(r["statusCode"], 401)


class WhereAndWhenTest(NotesCase):
    def test_a_web_note_keeps_the_browsers_zone(self):
        r, note = self.call("POST", f"/api/days/{TODAY}/notes", {"text": "From Denver.", "tz": "America/Denver"}, cookies=self.cookies)
        self.assertEqual((note["tz"], note["late"]), ("America/Denver", False))
        self.assertEqual(self.store.notes_between("u1", TODAY, TODAY)[0]["tz"], "America/Denver")
        # 17:53 in Chicago is already the 9th in Kyiv: written after its day.
        r, note = self.call("POST", f"/api/days/{TODAY}/notes", {"text": "From Kyiv.", "tz": "Europe/Kyiv"}, cookies=self.cookies)
        self.assertEqual((note["tz"], note["late"]), ("Europe/Kyiv", True))

    def test_no_zone_or_a_bad_one_is_the_subscribers(self):
        for tz in (None, "Mars/Olympus"):
            self.call("POST", f"/api/days/{TODAY}/notes", {"text": "Here.", **({"tz": tz} if tz else {})}, cookies=self.cookies)
        self.assertEqual({n["tz"] for n in self.store.notes_between("u1", TODAY, TODAY)}, {"America/Chicago"})

    def test_late_is_read_where_the_note_was_written(self):
        # 23:30 on the 6th in Denver is 00:30 on the 7th in Chicago: on time.
        self.emailed("2026-10-06", "d1-a", at="2026-10-07T05:30:00Z", source="import", tz="America/Denver")
        self.emailed("2026-10-06", "d1-b", at="2026-10-07T05:30:00Z", source="import")
        _, day = self.get("/api/days/2026-10-06")
        self.assertEqual([(n["tz"], n["late"]) for n in day["notes"]], [("America/Denver", False), ("America/Chicago", True)])

    def test_written_at_or_the_older_received_at(self):
        self.store.add_note("u1", TODAY, "new", text="New.", written_at="2026-10-08T12:00:00Z")
        self.store.add_note("u1", TODAY, "old", text="Old.", received_at="2026-10-08T11:00:00Z")
        _, day = self.get(f"/api/days/{TODAY}")
        self.assertEqual([(n["id"], n["at"]) for n in day["notes"]], [("old", "2026-10-08T11:00:00Z"), ("new", "2026-10-08T12:00:00Z")])

    def test_an_all_day_note_says_so(self):
        self.emailed("2026-10-06", "d1-c", source="import", all_day=True)
        _, day = self.get("/api/days/2026-10-06")
        self.assertTrue(day["notes"][0]["all_day"])
        self.emailed("2026-10-05", "d1-d", source="import")
        _, day = self.get("/api/days/2026-10-05")
        self.assertNotIn("all_day", day["notes"][0])

    def test_an_imported_note_shows_its_place_and_app(self):
        place = {"venue": "Four Seasons Mall", "city": "Plymouth", "region": "Minnesota", "country": "United States",
                 "lat": 45.03, "lon": -93.41}
        self.emailed("2026-10-06", "d1-a", source="import", place=place,
                     origin={"app": "dayone", "journal": "Journal", "id": "ABC"})
        self.emailed("2026-10-06", "d1-b", source="import", place={"city": "Kyiv", "region": "Kyiv City", "country": "Ukraine"},
                     origin={"app": "someday"})
        _, day = self.get("/api/days/2026-10-06")
        self.assertEqual([(n["place"], n["from"], n["source"]) for n in day["notes"]],
                         [("Four Seasons Mall, Plymouth", "Day One", "import"), ("Kyiv, Kyiv City", "an import", "import")])
        self.assertNotIn("45.03", str(day))  # a place shows by name, never its coordinates
