"""Recordings written out as text, for subscribers who turn it on (Jamie,
2026-10-09: "speech to text on audio notes", with Amazon Transcribe).

Off unless the subscriber sets `transcribe` in settings: notes are never
processed by a model without their say (AGENTS.md). Jamie, 2026-10-09: "I
don't care if they keep it", so the account has no AI services opt-out and
Amazon may keep the audio. Jamie wanted the settings copy casual and the
service unnamed ("They're sent off to be transcribed").

The words show in italics under the player (Jamie: so it "isn't text you
typed"), are searched, and go in both exports; not in the email.

One function, two triggers:

1. The table's stream. A note written with a recording (by email, the web,
   the page's Record button, an import, a backfill script) starts a batch
   job for each recording with no `transcript` yet, if its owner has it on.
   Turning it on starts jobs for every recording already kept. A job's name
   is fixed by the file (`release-notes.<user>.<day>.<note>.<n>`), so a
   note written again while its jobs run starts nothing new
   (ConflictException).
2. Transcribe's "Job State Change" events. The text goes on the file's
   entry in the note's media as `transcript` ("" when the job failed or
   heard nothing, so it is not tried again); then the job's JSON in the
   bucket and the job itself are deleted. A note deleted meanwhile just
   loses them.

Transcribe bills by the minute, and sign-up is open, so each subscriber
gets at most MAX_A_DAY jobs a UTC day (2026-10-09 audit), counted as each
starts (`RATE#transcribe:<user>#<day>`, store.count). Past that, a
recording is left waiting, never marked done: it has no `transcript`, so
the next thing that looks at it starts its job. Nothing comes back for it
on its own, though: it is written out when its note is written again (an
edit, a file added), or when the setting is turned off and on, which
starts the next day's share of every recording still waiting. A recording
over MAX_BYTES (bigger than anything the web or an email brings; only an
import could) is never sent and stays without words, as a photo too big
to describe does.

Logs ids and counts, never the words.
"""

import json
import os
import re
import time
from decimal import Decimal

from .media import MAX_UPLOAD
from .store import Store

PREFIX = "release-notes"
LANGUAGE = "en-US"
# What Transcribe reads (it takes no raw AAC), and its name for each.
FORMATS = {"audio/mp4": "m4a", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg",
           "audio/webm": "webm", "audio/flac": "flac"}
MAX_TRANSCRIPT = 50_000  # characters, about an hour of talking
# Jobs one subscriber may start in a UTC day: a recording every hour they
# are awake and then some, and a ceiling on what one account can spend.
MAX_A_DAY = 30
MAX_BYTES = MAX_UPLOAD  # 50 MB, the most one file from the web can be
ONE_DAY = 86400
_ID = re.compile(r"[A-Za-z0-9-]{1,80}")
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def job_name(user_id: str, day: str, note_id: str, n: int) -> str | None:
    if not (_ID.fullmatch(user_id) and _DAY.fullmatch(day) and _ID.fullmatch(note_id)):
        return None
    return f"{PREFIX}.{user_id}.{day}.{note_id}.{n}"


def parse_job(name: str) -> tuple[str, str, str, int] | None:
    parts = name.split(".")
    if len(parts) != 5 or parts[0] != PREFIX or not parts[4].isdigit():
        return None
    _, user_id, day, note_id, n = parts
    return (user_id, day, note_id, int(n)) if job_name(user_id, day, note_id, int(n)) == name else None


def output_key(user_id: str, day: str, note_id: str, n: int) -> str:
    return f"transcripts/{user_id}/{day}/{note_id}/{n}.json"


def waiting(note: dict) -> list[dict]:
    """The note's recordings Transcribe can read that have no text yet."""
    return [m for m in note.get("media") or []
            if m.get("kind") == "audio" and m.get("type") in FORMATS and "transcript" not in m
            and int(m.get("size") or 0) <= MAX_BYTES and str(m.get("key", "")).startswith("media/")]


def _code(e: Exception) -> str | None:
    return (getattr(e, "response", None) or {}).get("Error", {}).get("Code")


class Allowance:
    """One subscriber's jobs for one UTC day: each start takes one, and
    past MAX_A_DAY none is given (and the counter is not asked again)."""

    def __init__(self, store, user_id: str, day: int):
        self.store, self.user_id, self.day, self.full = store, user_id, day, False

    def take(self) -> bool:
        if not self.full and self.store.count(f"transcribe:{self.user_id}", self.day, ONE_DAY) > MAX_A_DAY:
            self.full = True
            log(event="transcribe-capped", user=self.user_id)
        return not self.full


def start(note: dict, user_id: str, *, transcribe, bucket: str, allowance: Allowance) -> int:
    """Start a job for each waiting recording, while the day's allowance
    lasts. Returns how many started; the rest stay waiting."""
    _, day, note_id = note["sk"].split("#", 2)
    started = 0
    for m in waiting(note):
        n = int(m["n"])
        name = job_name(user_id, day, note_id, n)
        if not name:
            continue
        if not allowance.take():
            break
        try:
            transcribe.start_transcription_job(
                TranscriptionJobName=name, LanguageCode=LANGUAGE, MediaFormat=FORMATS[m["type"]],
                Media={"MediaFileUri": f"s3://{bucket}/{m['key']}"},
                OutputBucketName=bucket, OutputKey=output_key(user_id, day, note_id, n))
            started += 1
        except Exception as e:
            if _code(e) != "ConflictException":  # already running
                raise
    return started


def plain(value):
    """A stream image's typed value as the table's items read."""
    (kind, v), = value.items()
    if kind == "M":
        return {k: plain(x) for k, x in v.items()}
    if kind == "L":
        return [plain(x) for x in v]
    if kind == "N":
        return Decimal(v)
    if kind == "NULL":
        return None
    return v  # S, BOOL, and the sets as lists


def changed(record: dict, *, store, transcribe, bucket: str, wanted: dict, allowances: dict, today: int) -> int:
    """One stream record. `wanted` caches each user's setting for the batch,
    `allowances` their Allowance for `today` (days since the epoch, UTC)."""
    images = record.get("dynamodb", {})
    new = {k: plain(v) for k, v in images.get("NewImage", {}).items()}
    old = {k: plain(v) for k, v in images.get("OldImage", {}).items()}
    if not str(new.get("pk", "")).startswith("USER#"):
        return 0
    user_id = new["pk"][5:]
    allowance = allowances.setdefault(user_id, Allowance(store, user_id, today))
    if new.get("sk") == "PROFILE":
        if not new.get("transcribe") or old.get("transcribe"):
            return 0
        # Just turned on: everything already kept, as far as today's allowance goes.
        started = 0
        for n in store.all_notes(user_id):
            if allowance.full:
                break
            if waiting(n):
                started += start(n, user_id, transcribe=transcribe, bucket=bucket, allowance=allowance)
        log(event="transcribe-all", user=user_id, started=started)
        return started
    if not str(new.get("sk", "")).startswith("NOTE#") or not waiting(new):
        return 0
    if user_id not in wanted:
        wanted[user_id] = bool((store.profile(user_id) or {}).get("transcribe"))
    if not wanted[user_id]:
        return 0
    # The stream carries this function's own writes, each with the note as
    # it was then: a job finished since must not start again.
    _, day, note_id = new["sk"].split("#", 2)
    note = store.note(user_id, day, note_id)
    if not note or not waiting(note):
        return 0
    started = start(note, user_id, transcribe=transcribe, bucket=bucket, allowance=allowance)
    if started:
        log(event="transcribe-start", user=user_id, started=started)
    return started


def finished(detail: dict, *, store, transcribe, s3, bucket: str) -> str:
    name = detail.get("TranscriptionJobName", "")
    found = parse_job(name)
    if not found:
        return "not-ours"
    user_id, day, note_id, n = found
    key = output_key(user_id, day, note_id, n)
    text = ""
    if detail.get("TranscriptionJobStatus") == "COMPLETED":
        try:
            body = json.loads(s3.get_object(Bucket=bucket, Key=key)["Body"].read())
            text = " ".join(t.get("transcript", "") for t in body["results"]["transcripts"]).strip()
        except Exception as e:
            if _code(e) not in ("NoSuchKey", "404"):
                raise
    text = text[:MAX_TRANSCRIPT]
    kept = store.set_media_text(user_id, day, note_id, n, "transcript", text)
    s3.delete_object(Bucket=bucket, Key=key)
    try:
        transcribe.delete_transcription_job(TranscriptionJobName=name)
    except Exception as e:
        if _code(e) not in ("NotFoundException", "BadRequestException"):
            raise
    outcome = "kept" if kept else "note-gone"
    # Why a job failed is about the file (its format, its length), never its words.
    log(event="transcribe-done", user=user_id, status=detail.get("TranscriptionJobStatus"), outcome=outcome,
        chars=len(text), **({"why": str(detail["FailureReason"])[:300]} if detail.get("FailureReason") else {}))
    return outcome


def handler(event, context, *, store=None, transcribe=None, s3=None, clock=time.time):
    if store is None or transcribe is None or s3 is None:
        import boto3

        store = store or Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
        transcribe = transcribe or boto3.client("transcribe")
        s3 = s3 or boto3.client("s3")
    bucket = os.environ["BUCKET"]
    if event.get("source") == "aws.transcribe":
        finished(event.get("detail", {}), store=store, transcribe=transcribe, s3=s3, bucket=bucket)
        return
    wanted, allowances, today = {}, {}, int(clock()) // ONE_DAY
    for record in event.get("Records", []):
        changed(record, store=store, transcribe=transcribe, bucket=bucket, wanted=wanted, allowances=allowances, today=today)
