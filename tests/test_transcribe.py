"""Recordings written out (transcribe.py): stream records start jobs, a
finished job puts the words on the note. Made-up notes and the fakes."""

import json
import os
import unittest
from decimal import Decimal
from unittest import mock

from fakes import FakeS3, FakeStore
from release_notes import transcribe

BUCKET = "mail"
M4A = {"n": Decimal(1), "kind": "audio", "type": "audio/mp4", "size": Decimal(9000), "key": "media/u1/2026-10-09/w-1/1.m4a"}
PHOTO = {"n": Decimal(2), "kind": "image", "type": "image/jpeg", "size": Decimal(9000), "key": "media/u1/2026-10-09/w-1/2.jpg"}
AAC = {"n": Decimal(3), "kind": "audio", "type": "audio/aac", "size": Decimal(9000), "key": "media/u1/2026-10-09/w-1/3.aac"}
NAME = "release-notes.u1.2026-10-09.w-1.1"


def typed(v):
    """A value as a stream image carries it."""
    if isinstance(v, bool):
        return {"BOOL": v}
    if isinstance(v, (int, Decimal)):
        return {"N": str(v)}
    if isinstance(v, dict):
        return {"M": {k: typed(x) for k, x in v.items()}}
    if isinstance(v, list):
        return {"L": [typed(x) for x in v]}
    return {"S": v}


def record(new, old=None, name="MODIFY"):
    images = {"NewImage": {k: typed(v) for k, v in new.items()}}
    if old is not None:
        images["OldImage"] = {k: typed(v) for k, v in old.items()}
    return {"eventSource": "aws:dynamodb", "eventName": name, "dynamodb": images}


def note(*media, day="2026-10-09", note_id="w-1"):
    return {"pk": "USER#u1", "sk": f"NOTE#{day}#{note_id}", "text": "", "media": [dict(m) for m in media]}


class FakeTranscribe:
    def __init__(self):
        self.jobs, self.deleted = {}, []

    def start_transcription_job(self, **kw):
        if kw["TranscriptionJobName"] in self.jobs:
            e = Exception("exists")
            e.response = {"Error": {"Code": "ConflictException"}}
            raise e
        self.jobs[kw["TranscriptionJobName"]] = kw
        return {}

    def delete_transcription_job(self, TranscriptionJobName):
        self.deleted.append(TranscriptionJobName)
        self.jobs.pop(TranscriptionJobName, None)


class TranscribeCase(unittest.TestCase):
    def setUp(self):
        self.store, self.s3, self.jobs = FakeStore(), FakeS3(), FakeTranscribe()
        self.store.profiles["u1"] = {"email": "ada@example.com", "tz": "America/Chicago", "transcribe": True}
        env = mock.patch.dict(os.environ, {"TABLE": "t", "BUCKET": BUCKET})
        env.start()
        self.addCleanup(env.stop)

    def arrive(self, n, name="MODIFY"):
        """The note as the table now has it, and its stream record."""
        rows = self.store.items.setdefault("u1", [])
        rows[:] = [r for r in rows if r["sk"] != n["sk"]] + [json.loads(json.dumps(n, default=int))]
        return record(n, name=name)

    def run_it(self, event):
        with mock.patch("builtins.print"):
            transcribe.handler(event, None, store=self.store, transcribe=self.jobs, s3=self.s3)


class StartTest(TranscribeCase):
    def test_a_note_with_a_recording_starts_one_job_for_it_alone(self):
        self.run_it({"Records": [self.arrive(note(M4A, PHOTO, AAC), name="INSERT")]})
        self.assertEqual(list(self.jobs.jobs), [NAME])  # not the photo, not raw AAC Transcribe can't read
        job = self.jobs.jobs[NAME]
        self.assertEqual((job["MediaFormat"], job["Media"], job["OutputBucketName"], job["OutputKey"]),
                         ("m4a", {"MediaFileUri": f"s3://{BUCKET}/{M4A['key']}"}, BUCKET,
                          "transcripts/u1/2026-10-09/w-1/1.json"))

    def test_nothing_starts_unless_its_owner_turned_it_on(self):
        self.store.profiles["u1"]["transcribe"] = False
        self.run_it({"Records": [self.arrive(note(M4A))]})
        del self.store.profiles["u1"]["transcribe"]
        self.run_it({"Records": [self.arrive(note(M4A))]})
        self.assertEqual(self.jobs.jobs, {})

    def test_written_again_while_running_or_once_done_starts_nothing_new(self):
        self.run_it({"Records": [self.arrive(note(M4A))]})
        self.run_it({"Records": [self.arrive(note(M4A))]})  # ConflictException: already running
        self.jobs.jobs.clear()
        self.run_it({"Records": [self.arrive(note({**M4A, "transcript": "Hello."}))]})
        self.run_it({"Records": [self.arrive(note({**M4A, "transcript": ""}))]})  # tried, heard nothing
        self.assertEqual(self.jobs.jobs, {})

    def test_an_old_record_of_a_note_since_written_out_starts_nothing(self):
        stale = record(note(M4A))  # from before its words came back
        self.arrive(note({**M4A, "transcript": "Hello."}))
        self.run_it({"Records": [stale]})
        self.assertEqual(self.jobs.jobs, {})

    def test_turning_it_on_writes_out_every_recording_already_kept(self):
        self.store.profiles["u1"]["transcribe"] = True
        self.store.add_note("u1", "2016-07-04", "d1-A", media=[dict(M4A, key="media/u1/2016-07-04/d1-A/1.m4a")])
        self.store.add_note("u1", "2026-10-09", "w-1", media=[dict(PHOTO)])
        profile = {"pk": "USER#u1", "sk": "PROFILE", "transcribe": True}
        self.run_it({"Records": [record(profile, {**profile, "transcribe": False})]})
        self.assertEqual(list(self.jobs.jobs), ["release-notes.u1.2016-07-04.d1-A.1"])
        self.jobs.jobs.clear()
        self.run_it({"Records": [record(profile, profile)]})  # already on: some other setting changed
        self.assertEqual(self.jobs.jobs, {})

    def test_ids_that_cannot_name_a_job_are_left_alone(self):
        self.assertIsNone(transcribe.job_name("u1", "2026-10-09", "odd.id", 1))
        self.assertIsNone(transcribe.parse_job("release-notes.u1.2026-10-09.w-1"))
        self.assertIsNone(transcribe.parse_job("someone-else.u1.2026-10-09.w-1.1"))
        self.assertEqual(transcribe.parse_job(NAME), ("u1", "2026-10-09", "w-1", 1))


class FinishTest(TranscribeCase):
    def setUp(self):
        super().setUp()
        self.store.add_note("u1", "2026-10-09", "w-1", text="", media=[dict(PHOTO), dict(M4A)])
        self.out = "transcripts/u1/2026-10-09/w-1/1.json"

    def done(self, status="COMPLETED", **detail):
        self.run_it({"source": "aws.transcribe", "detail-type": "Transcribe Job State Change",
                     "detail": {"TranscriptionJobName": NAME, "TranscriptionJobStatus": status, **detail}})

    def media(self):
        return self.store.note("u1", "2026-10-09", "w-1")["media"]

    def test_the_words_go_on_the_recording_then_the_json_and_job_go(self):
        self.jobs.jobs[NAME] = {}
        self.s3.put_object(BUCKET, self.out, json.dumps(
            {"results": {"transcripts": [{"transcript": "Walked to the lake before the rain. "}]}}).encode())
        self.done()
        self.assertEqual(self.media()[1]["transcript"], "Walked to the lake before the rain.")
        self.assertNotIn("transcript", self.media()[0])
        self.assertNotIn(self.out, self.s3.objects)
        self.assertEqual(self.jobs.deleted, [NAME])

    def test_a_failed_job_is_done_with_no_words_and_not_tried_again(self):
        self.done("FAILED", FailureReason="The media format provided does not match the detected media format.")
        self.assertEqual(self.media()[1]["transcript"], "")
        self.assertEqual(transcribe.waiting(self.store.note("u1", "2026-10-09", "w-1")), [])

    def test_a_note_deleted_meanwhile_just_loses_the_json(self):
        self.store.delete_note("u1", "2026-10-09", "w-1")
        self.s3.put_object(BUCKET, self.out, b'{"results": {"transcripts": [{"transcript": "Hi."}]}}')
        self.done()
        self.assertNotIn(self.out, self.s3.objects)
        self.assertEqual(self.jobs.deleted, [NAME])

    def test_a_long_talk_is_cut_to_fit_the_note(self):
        self.s3.put_object(BUCKET, self.out, json.dumps(
            {"results": {"transcripts": [{"transcript": "word " * 20_000}]}}).encode())
        self.done()
        self.assertEqual(len(self.media()[1]["transcript"]), transcribe.MAX_TRANSCRIPT)

    def test_someone_elses_job_is_ignored(self):
        self.run_it({"source": "aws.transcribe", "detail": {"TranscriptionJobName": "other-job",
                                                            "TranscriptionJobStatus": "COMPLETED"}})
        self.assertNotIn("transcript", self.media()[1])


if __name__ == "__main__":
    unittest.main()
