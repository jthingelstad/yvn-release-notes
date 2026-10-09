"""Photos described in words, so search finds what is in them (Jamie,
2026-10-09: "creating image descriptions to allow images to appear in
search", then: Claude Haiku 5.5 through the Anthropic API, with its own
key, rather than Haiku 4.5 on Bedrock).

Off unless the subscriber sets `describe` in settings: notes are never
processed by a model without their say (AGENTS.md). The description is one
or two sentences on the photo's entry in the note's media (`description`,
"" when the model could not or would not describe it, so it is not tried
again). It is searched, it is the photo's alt text, and search results show
it when it matched (Jamie: "descriptions only on search results"); it is
not shown anywhere else.

Two ways in, one function:

1. The table's stream (as transcribe.py reads it): a note written with
   photos, if its owner has it on, has each one described then and there.
   Turning it on invokes this function on its own, `{"describe_all":
   user}`, which works through every photo already kept until it nears
   its time limit, then invokes itself again for the rest. Each pass
   reads the setting first, so turning it off stops it.
2. That `describe_all` invocation.

The key is `api_key` in the Secrets Manager secret named by `SECRET`, read
by the function when it runs. Until it holds a real key (one starting
`sk-ant-`), nothing is sent and photos stay waiting: a pass logs `no-key`.
Invoked with `{"check": true}`, it describes a made-up blue square through
the whole path and returns what came back, writing nothing: run it after
the key changes, before anyone's photos go.

The API takes JPEG, PNG, GIF and WebP up to 5 MB once base64-encoded
(3.75 MB of file) and 8,000 pixels a side; the code is standard library
only, so nothing is shrunk, and bigger photos (and HEIC) are left out.
Haiku 5.5 thinks before it answers, and the thinking counts against
`max_tokens`: low effort and a budget well above the answer (as
librarian-thing's describer does). It takes no temperature. Logs ids and
counts, never a description.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.request

from . import media
from .store import Store
from .transcribe import plain

MODEL = "claude-haiku-5-5"
EFFORT = "low"
MAX_TOKENS = 2000  # thinking included
API = "https://api.anthropic.com/v1/messages"
FORMATS = {"image/jpeg", "image/png", "image/gif", "image/webp"}
MAX_BYTES = 3_750_000
MAX_SIDE = 8000
MAX_DESCRIPTION = 600  # characters
LEFT_FOR_NEXT = 60  # seconds: a pass hands over with this much time left
PROMPT = ("Describe this photo in one or two plain sentences, so it can be found by searching later: what is in it, "
          "where it seems to be, and any words you can read in it, such as signs. Answer with only those sentences: "
          "no preamble, no headings, no list of keywords or search terms.")


class ApiError(Exception):
    """An answer from the API other than 200: its status, error type, and
    whether its message is about the image (the message itself is not kept)."""

    def __init__(self, status: int, kind: str | None, about_image: bool = False):
        super().__init__(f"{status} {kind}" + (" (image)" if about_image else ""))
        self.status, self.kind, self.about_image = status, kind, about_image


class NoKey(Exception):
    """The secret does not hold a real key yet."""


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def waiting(note: dict) -> list[dict]:
    """The note's photos Bedrock can read that have no description yet."""
    return [m for m in note.get("media") or []
            if m.get("kind") == "image" and m.get("type") in FORMATS and "description" not in m
            and int(m.get("size") or 0) <= MAX_BYTES and str(m.get("key", "")).startswith("media/")]


def _code(e: Exception) -> str | None:
    return (getattr(e, "response", None) or {}).get("Error", {}).get("Code")


def claude_with(key: str, timeout: float = 60):
    """A Messages API call with this key: request body in, answer out,
    ApiError for anything but a 200."""
    def ask(body: dict) -> dict:
        req = urllib.request.Request(API, data=json.dumps(body).encode(), method="POST", headers={
            "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            try:
                error = json.loads(e.read()).get("error", {})
            except ValueError:
                error = {}
            raise ApiError(e.code, error.get("type"), "image" in str(error.get("message", "")).lower()) from None
    return ask


def key_from(secrets, secret_id: str) -> str:
    """The key in the secret, or NoKey while it is still the placeholder."""
    key = json.loads(secrets.get_secret_value(SecretId=secret_id)["SecretString"]).get("api_key") or ""
    if not key.startswith("sk-ant-"):
        raise NoKey()
    return key


def words_for(data: bytes, ctype: str, *, claude) -> str:
    """The model's description of one photo, "" if it cannot or will not
    describe it."""
    size = media.image_size(data)
    if len(data) > MAX_BYTES or (size and max(size) > MAX_SIDE):
        return ""
    try:
        r = claude({
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "output_config": {"effort": EFFORT},
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": ctype,
                                             "data": base64.b64encode(data).decode("ascii")}},
                {"type": "text", "text": PROMPT}]}],
        })
    except ApiError as e:
        if e.status == 400 and e.kind == "invalid_request_error" and e.about_image:  # not an image it can read
            return ""
        # Anything else (the key refused, rate limited, overloaded, or a
        # request the API will not take for any photo) is raised and tried
        # again later, never written as "no words" for every photo.
        raise
    if r.get("stop_reason") == "refusal":
        return ""
    # Text blocks only: a thinking block comes first. Thinking that used the
    # whole budget leaves none, and that photo goes without.
    text = " ".join(b.get("text", "") for b in r.get("content", []) if b.get("type") == "text").strip()
    return " ".join(text.split())[:MAX_DESCRIPTION]


def describe(note: dict, user_id: str, *, store, s3, claude, bucket: str) -> int:
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
        text = words_for(data, m["type"], claude=claude) if data else ""
        if not store.set_media_text(user_id, day, note_id, int(m["n"]), "description", text):
            break  # the note is gone or changed
        done += 1
    return done


def wanted(store, user_id: str) -> bool:
    return bool((store.profile(user_id) or {}).get("describe"))


def changed(record: dict, *, store, s3, claude, lam, bucket: str, cache: dict) -> int:
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
    done = describe(note, user_id, store=store, s3=s3, claude=claude(), bucket=bucket)
    log(event="describe", user=user_id, photos=done)
    return done


def describe_all(user_id: str, *, store, s3, claude, lam, bucket: str, time_left) -> dict:
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
        done += describe(note, user_id, store=store, s3=s3, claude=claude(), bucket=bucket)
    log(event="describe-all", user=user_id, photos=done, outcome="done")
    return {"photos": done, "more": False}


def test_image() -> bytes:
    """A 64 x 64 PNG, all one blue: something made up to describe."""
    import struct
    import zlib

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\x00" + b"\x1f\x4f\xc8" * 64 for _ in range(64))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def check(claude) -> dict:
    """`{"check": true}`: the whole path (secret, network, model, request)
    with a made-up image, writing nothing. Says what came back."""
    try:
        return {"ok": True, "words": words_for(test_image(), "image/png", claude=claude)}
    except ApiError as e:
        return {"ok": False, "status": e.status, "error": e.kind, "about_image": e.about_image}


def handler(event, context, *, store=None, s3=None, claude=None, lam=None, secrets=None):
    """`claude` is a Messages API call (claude_with); left out, it is made
    from the secret's key, read once a run and only when a photo needs it."""
    if store is None or s3 is None or lam is None or (claude is None and secrets is None):
        import boto3

        store = store or Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
        s3 = s3 or boto3.client("s3")
        lam = lam or boto3.client("lambda")
        secrets = secrets or boto3.client("secretsmanager")
    bucket = os.environ["BUCKET"]
    made = {}

    def ask():
        if claude is not None:
            return claude
        if "ask" not in made:
            made["ask"] = claude_with(key_from(secrets, os.environ["SECRET"]))
        return made["ask"]

    if event.get("check"):
        try:
            result = check(ask())
        except NoKey:
            result = {"ok": False, "error": "no-key"}
        log(event="describe-check", ok=result["ok"], **{k: v for k, v in result.items() if k not in ("ok", "words")})
        return result
    try:
        if "describe_all" in event:
            started = time.monotonic()
            limit = context.get_remaining_time_in_millis() / 1000 if context else 900
            describe_all(event["describe_all"], store=store, s3=s3, claude=ask, lam=lam, bucket=bucket,
                         time_left=lambda: limit - (time.monotonic() - started))
            return
        cache = {}
        for record in event.get("Records", []):
            changed(record, store=store, s3=s3, claude=ask, lam=lam, bucket=bucket, cache=cache)
    except NoKey:
        # Photos stay waiting; turning the setting off and on again, or a
        # new photo, picks them up once the key is in.
        log(event="describe", outcome="no-key")
