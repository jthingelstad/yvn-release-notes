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
