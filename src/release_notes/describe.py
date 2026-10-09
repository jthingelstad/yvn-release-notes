"""Photos described in words, so search finds what is in them (Jamie,
2026-10-09: "creating image descriptions to allow images to appear in
search", with Claude Haiku 4.5 on Bedrock).

Off unless the subscriber sets `describe` in settings: notes are never
processed by a model without their say (AGENTS.md). Bedrock keeps nothing
it is sent. The description is one or two sentences on the photo's entry
in the note's media (`description`, "" when the model could not read it,
so it is not tried again). It is searched, it is the photo's alt text, and
search results show it when it matched (Jamie: "descriptions only on
search results"); it is not shown anywhere else.

Two ways in, one function:

1. The table's stream (as transcribe.py reads it): a note written with
   photos, if its owner has it on, has each one described then and there.
   Turning it on invokes this function on its own, `{"describe_all":
   user}`, which works through every photo already kept until it nears
   its time limit, then invokes itself again for the rest. Each pass
   reads the setting first, so turning it off stops it.
2. That `describe_all` invocation.

Bedrock takes JPEG, PNG, GIF and WebP up to 3.75 MB and 8,000 pixels a
side; the code is standard library only, so nothing is shrunk, and bigger
photos (and HEIC) are left out. Logs ids and counts, never a description.
"""

import json
import os
import time

from . import media
from .store import Store
from .transcribe import plain

MODEL = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
FORMATS = {"image/jpeg": "jpeg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
MAX_BYTES = 3_750_000
MAX_SIDE = 8000
MAX_DESCRIPTION = 600  # characters
LEFT_FOR_NEXT = 60  # seconds: a pass hands over with this much time left
PROMPT = ("Describe this photo in one or two plain sentences, so it can be found by searching later: what is in it, "
          "where it seems to be, and any words you can read in it, such as signs. Just the description, no preamble.")


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def waiting(note: dict) -> list[dict]:
    """The note's photos Bedrock can read that have no description yet."""
    return [m for m in note.get("media") or []
            if m.get("kind") == "image" and m.get("type") in FORMATS and "description" not in m
            and int(m.get("size") or 0) <= MAX_BYTES and str(m.get("key", "")).startswith("media/")]


def _code(e: Exception) -> str | None:
    return (getattr(e, "response", None) or {}).get("Error", {}).get("Code")


def words_for(data: bytes, ctype: str, *, bedrock) -> str:
    """The model's description of one photo, "" if it cannot be read."""
    size = media.image_size(data)
    if len(data) > MAX_BYTES or (size and max(size) > MAX_SIDE):
        return ""
    try:
        r = bedrock.converse(
            modelId=MODEL,
            messages=[{"role": "user", "content": [
                {"image": {"format": FORMATS[ctype], "source": {"bytes": data}}}, {"text": PROMPT}]}],
            inferenceConfig={"maxTokens": 200})
    except Exception as e:
        if _code(e) == "ValidationException":  # not an image it can read
            return ""
        raise
    parts = r.get("output", {}).get("message", {}).get("content", [])
    text = " ".join(p["text"] for p in parts if "text" in p).strip()
    return " ".join(text.split())[:MAX_DESCRIPTION]


def describe(note: dict, user_id: str, *, store, s3, bedrock, bucket: str) -> int:
    """Describe each waiting photo on a note. Returns how many."""
    _, day, note_id = note["sk"].split("#", 2)
    done = 0
    for m in waiting(note):
        try:
            data = s3.get_object(Bucket=bucket, Key=str(m["key"]))["Body"].read()
        except Exception as e:
            if _code(e) != "NoSuchKey":
                raise
            data = None  # gone from the bucket: nothing to describe
        text = words_for(data, m["type"], bedrock=bedrock) if data else ""
        if not store.set_media_text(user_id, day, note_id, int(m["n"]), "description", text):
            break  # the note is gone or changed
        done += 1
    return done


def wanted(store, user_id: str) -> bool:
    return bool((store.profile(user_id) or {}).get("describe"))


def changed(record: dict, *, store, s3, bedrock, lam, bucket: str, cache: dict) -> int:
    images = record.get("dynamodb", {})
    new = {k: plain(v) for k, v in images.get("NewImage", {}).items()}
    old = {k: plain(v) for k, v in images.get("OldImage", {}).items()}
    if not str(new.get("pk", "")).startswith("USER#"):
        return 0
    user_id = new["pk"][5:]
    if new.get("sk") == "PROFILE":
        if new.get("describe") and not old.get("describe"):
            # Just turned on: everything already kept, in passes of its own.
            lam.invoke(FunctionName=os.environ["SELF"], InvocationType="Event",
                       Payload=json.dumps({"describe_all": user_id}).encode())
            log(event="describe-all-start", user=user_id)
        return 0
    if not str(new.get("sk", "")).startswith("NOTE#") or not waiting(new):
        return 0
    if user_id not in cache:
        cache[user_id] = wanted(store, user_id)
    if not cache[user_id]:
        return 0
    # The stream carries this function's own writes, each with the note as
    # it was then: what is still waiting is read afresh.
    _, day, note_id = new["sk"].split("#", 2)
    note = store.note(user_id, day, note_id)
    if not note or not waiting(note):
        return 0
    done = describe(note, user_id, store=store, s3=s3, bedrock=bedrock, bucket=bucket)
    log(event="describe", user=user_id, photos=done)
    return done


def describe_all(user_id: str, *, store, s3, bedrock, lam, bucket: str, time_left) -> dict:
    """One pass over a subscriber's photos. Hands the rest to a new pass
    when time runs short."""
    if not wanted(store, user_id):
        log(event="describe-all", user=user_id, outcome="turned-off")
        return {"photos": 0, "more": False}
    done = 0
    for note in store.all_notes(user_id):
        if not waiting(note):
            continue
        if time_left() < LEFT_FOR_NEXT:
            lam.invoke(FunctionName=os.environ["SELF"], InvocationType="Event",
                       Payload=json.dumps({"describe_all": user_id}).encode())
            log(event="describe-all", user=user_id, photos=done, outcome="continued")
            return {"photos": done, "more": True}
        done += describe(note, user_id, store=store, s3=s3, bedrock=bedrock, bucket=bucket)
    log(event="describe-all", user=user_id, photos=done, outcome="done")
    return {"photos": done, "more": False}


def handler(event, context, *, store=None, s3=None, bedrock=None, lam=None):
    if store is None or s3 is None or bedrock is None or lam is None:
        import boto3

        store = store or Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
        s3 = s3 or boto3.client("s3")
        bedrock = bedrock or boto3.client("bedrock-runtime")
        lam = lam or boto3.client("lambda")
    bucket = os.environ["BUCKET"]
    if "describe_all" in event:
        started = time.monotonic()
        limit = context.get_remaining_time_in_millis() / 1000 if context else 900
        describe_all(event["describe_all"], store=store, s3=s3, bedrock=bedrock, lam=lam, bucket=bucket,
                     time_left=lambda: limit - (time.monotonic() - started))
        return
    cache = {}
    for record in event.get("Records", []):
        changed(record, store=store, s3=s3, bedrock=bedrock, lam=lam, bucket=bucket, cache=cache)
