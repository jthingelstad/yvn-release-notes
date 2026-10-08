import json
import zipfile
from contextlib import redirect_stdout
from io import BytesIO, StringIO

from release_notes import export, export_job
from test_web import NOW
from test_web_notes import MEMO, PHOTO, NotesCase

PHOTO_BYTES, MEMO_BYTES = b"\xff\xd8 a photo", b"a recording"


class ZipCase(NotesCase):
    def setUp(self):
        super().setUp()
        self.emailed("2026-10-07", text="By the lake.", media=[PHOTO, MEMO], raw_key="raw/0100abc-1")
        self.store.add_note("u1", "2026-10-07", "w-later", text="Later.", received_at="2026-10-08T15:00:00Z", source="web")
        self.store.add_note("u1", "2026-10-06", "0099", text="", received_at="2026-10-06T12:00:00Z",
                            media=[{**PHOTO, "key": "media/u1/2026-10-06/0099/1.png", "type": "image/png"}])
        self.s3.objects[PHOTO["key"]] = {"Body": PHOTO_BYTES}
        self.s3.objects[MEMO["key"]] = {"Body": MEMO_BYTES}
        self.s3.objects["media/u1/2026-10-06/0099/1.png"] = {"Body": b"png"}

    def build(self, at=NOW):
        """Run the job the web function invoked."""
        out = StringIO()
        with redirect_stdout(out):
            result = export_job.handler(self.lam.invoked[-1]["Payload"], None, store=self.store, s3=self.s3,
                                        clock=lambda: at)
        self.out.write(out.getvalue())
        return result

    def the_zip(self):
        key = self.store.export("u1")["export_key"]
        return zipfile.ZipFile(BytesIO(self.s3.objects[key]["Body"]))


class FilePathsTest(ZipCase):
    def test_numbered_through_each_day_in_order(self):
        paths = export.file_paths(self.store.user_items("u1"))
        self.assertEqual([f["path"] for f in paths["0100abc-1"]], ["files/2026-10-07-1.jpg", "files/2026-10-07-2.m4a"])
        self.assertEqual([f["path"] for f in paths["0099"]], ["files/2026-10-06-1.png"])
        self.assertNotIn("w-later", paths)


class JobTest(ZipCase):
    def test_start_build_download(self):
        r, body = self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertEqual((r["statusCode"], body), (202, {"status": "building"}))
        self.assertEqual(self.lam.invoked[0]["FunctionName"], "yvn-release-notes-export")
        self.assertEqual(self.lam.invoked[0]["InvocationType"], "Event")
        _, body = self.get("/api/export/zip")
        self.assertEqual(body, {"status": "building"})

        self.assertEqual(self.build(), "ready")
        _, body = self.get("/api/export/zip")
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["files"], 3)
        self.assertEqual(body["until"], "2026-10-09T" + body["built_at"][11:])

        r, _ = self.get("/api/export/zip/file")
        self.assertEqual(r["statusCode"], 302)
        key = self.store.export("u1")["export_key"]
        self.assertTrue(key.startswith("exports/u1/") and key.endswith(".zip"))
        self.assertEqual(r["headers"]["location"], f"/dev-media/{key}")
        self.assertEqual(self.s3.signed["ExpiresIn"], 300)
        self.assertEqual(self.s3.signed["Params"]["ResponseContentDisposition"],
                         'attachment; filename="release-notes-2026-10-08.zip"')
        self.assertNotIn("By the lake", self.out.getvalue())

    def test_the_zip_holds_notes_and_files(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.build()
        z = self.the_zip()
        top = "release-notes-2026-10-08/"
        self.assertEqual(sorted(z.namelist()), [
            top + "files/2026-10-06-1.png", top + "files/2026-10-07-1.jpg", top + "files/2026-10-07-2.m4a",
            top + "release-notes.json", top + "release-notes.md"])
        self.assertEqual(z.read(top + "files/2026-10-07-1.jpg"), PHOTO_BYTES)
        self.assertEqual(z.getinfo(top + "files/2026-10-07-1.jpg").date_time[:3], (2026, 10, 7))
        md = z.read(top + "release-notes.md").decode()
        self.assertIn("By the lake.\n\nLater.\n\n![Photo, x](files/2026-10-07-1.jpg)\n\n"
                      "[Recording, x](files/2026-10-07-2.m4a)\n", md)
        self.assertIn("## 4.5.114 · Tuesday, October 6, 2026\n\n![Photo, 4.5.114](files/2026-10-06-1.png)", md)
        self.assertNotIn("Attachments only", md)
        data = json.loads(z.read(top + "release-notes.json"))
        lake = next(n for n in data["notes"] if n["id"] == "0100abc-1")
        self.assertEqual(lake["files"], [{"path": "files/2026-10-07-1.jpg", "kind": "image", "type": "image/jpeg"},
                                         {"path": "files/2026-10-07-2.m4a", "kind": "audio", "type": "audio/mp4"}])
        self.assertNotIn("media/u1", json.dumps(data))

    def test_a_file_gone_since_is_left_out(self):
        del self.s3.objects[MEMO["key"]]
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertEqual(self.build(), "ready")
        self.assertEqual(len(self.the_zip().namelist()), 4)
        self.assertEqual(self.store.export("u1")["files"], 2)

    def test_a_failed_build_says_so_and_raises(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        def down(**kw):
            raise ConnectionError("S3 down")
        self.s3.get_object = down
        with self.assertRaises(Exception):
            self.build()
        _, body = self.get("/api/export/zip")
        self.assertEqual(body, {"status": "failed"})
        r, _ = self.get("/api/export/zip/file")
        self.assertEqual(r["statusCode"], 404)

    def test_a_build_past_its_time_failed(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.now += export_job.BUILDING_FOR + 1
        _, body = self.get("/api/export/zip")
        self.assertEqual(body, {"status": "failed"})
        r, _ = self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertEqual(r["statusCode"], 202)
        self.assertEqual(len(self.lam.invoked), 2)

    def test_one_build_at_a_time(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        r, body = self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertEqual((r["statusCode"], body), (202, {"status": "building"}))
        self.assertEqual(len(self.lam.invoked), 1)

    def test_a_new_build_replaces_the_old_zip(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.build()
        old = self.store.export("u1")["export_key"]
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertNotIn(old, self.s3.objects)
        self.assertEqual(len(self.lam.invoked), 2)

    def test_a_build_replaced_before_it_starts_does_nothing(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        first = self.lam.invoked[0]["Payload"]
        self.now += export_job.BUILDING_FOR + 1
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.lam.invoked.append({"Payload": first})
        self.assertEqual(self.build(), "skipped")
        self.assertEqual(self.s3.objects.keys() & {export_job.zip_key("u1", first["id"])}, set())

    def test_a_build_replaced_while_it_runs_deletes_its_own_zip(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        first = self.lam.invoked[0]["Payload"]
        upload = self.s3.upload_file

        def meanwhile(*args, **kw):
            upload(*args, **kw)
            self.now += export_job.BUILDING_FOR + 1
            self.call("POST", "/api/export/zip", cookies=self.cookies)  # a new build, started meanwhile
        self.s3.upload_file = meanwhile
        self.lam.invoked.append({"Payload": first})
        self.assertEqual(self.build(), "replaced")
        self.assertNotIn(export_job.zip_key("u1", first["id"]), self.s3.objects)
        self.assertEqual(self.store.export("u1")["status"], "building")

    def test_starting_fails_cleanly_when_lambda_is_down(self):
        self.lam.fail = True
        r, body = self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.assertEqual((r["statusCode"], body["error"]), (502, "export-failed"))
        _, body = self.get("/api/export/zip")
        self.assertEqual(body, {"status": "failed"})

    def test_a_ready_zip_is_offered_for_a_day(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.build()
        self.now += export_job.READY_FOR
        _, body = self.get("/api/export/zip")
        self.assertEqual(body, {"status": "none"})
        r, _ = self.get("/api/export/zip/file")
        self.assertEqual(r["statusCode"], 404)

    def test_only_for_an_account_and_from_the_site(self):
        for method, path in [("GET", "/api/export/zip"), ("POST", "/api/export/zip"), ("GET", "/api/export/zip/file")]:
            r, _ = self.call(method, path)
            self.assertEqual(r["statusCode"], 401, path)
        r, _ = self.call("POST", "/api/export/zip", cookies=self.cookies, origin="https://evil.example")
        self.assertEqual(r["statusCode"], 403)
        self.assertEqual(self.lam.invoked, [])

    def test_deleting_the_account_deletes_the_zip(self):
        self.call("POST", "/api/export/zip", cookies=self.cookies)
        self.build()
        key = self.store.export("u1")["export_key"]
        self.call("POST", "/api/me/delete-code", cookies=self.cookies)
        code = self.ses.sent[-1]["Content"]["Raw"]["Data"]
        import re
        code = re.search(rb"\b(\d{6})\b", code).group(1).decode()
        r, _ = self.call("DELETE", "/api/me", {"code": code}, cookies=self.cookies)
        self.assertEqual(r["statusCode"], 200)
        self.assertIn(key, [d["Key"] for d in self.s3.deleted])
        self.assertIsNone(self.store.export("u1"))
