"""The zip export: every note, photo and recording, built in the background.

Jamie, 2026-10-08: "A zip with the files", handed over as a download link.
A subscriber's photos and recordings can add up past what one API answer
carries (six megabytes, thirty seconds), so the web function starts a build
(`POST /api/export/zip`, which writes the EXPORT item, status `building`) and
invokes this function without waiting. This one:

1. checks the EXPORT item still names this build (a newer one, or deleting
   the account, replaces it);
2. writes `release-notes-<date>/` into a zip on local disk:
   `release-notes.md` (photos shown by their path in the zip),
   `release-notes.json` (each note lists its files) and `files/`, every
   photo and recording, named `<day>-<n>.<ext>`;
3. uploads it to the mail bucket at `exports/<user>/<build id>.zip` and marks
   the build `ready`.

The page asks `/api/export/zip/file` for it, which redirects to a signed link
that lasts five minutes. A ready build is offered for a day (the item's
expires_at); the bucket expires everything under exports/ after two. A build
that fails is marked `failed` and raises, so the errors alarm fires. A build
that finds itself replaced deletes its own zip, so only the current one is
ever kept. Logs carry the user id, counts and sizes, never a note.
"""

import json
import os
import shutil
import tempfile
import time
import zipfile
from datetime import datetime, timezone

from . import export

READY_FOR = 24 * 3600         # seconds a built zip is offered
BUILDING_FOR = 16 * 60        # past the function's 15 minutes, a build is over
CHUNK = 1024 * 1024


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def zip_key(user_id: str, export_id: str) -> str:
    return f"exports/{user_id}/{export_id}.zip"


def _missing(e: Exception) -> bool:
    code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
    return code in ("NoSuchKey", "404")


def write_zip(path: str, items: list[dict], s3, bucket: str, now: int) -> dict:
    """Write the export to a zip at `path`; {"files", "missing"} counts. A
    file deleted since its note was read is left out."""
    stamp = datetime.fromtimestamp(now, timezone.utc)
    top = f"release-notes-{stamp:%Y-%m-%d}/"
    files = export.file_paths(items)
    data = export.build(items, stamp.strftime("%Y-%m-%dT%H:%M:%SZ"), files)
    when = stamp.timetuple()[:6]
    counts = {"files": 0, "missing": 0}
    with zipfile.ZipFile(path, "w") as zf:
        for name, body in (("release-notes.md", export.markdown(data)),
                           ("release-notes.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")):
            info = zipfile.ZipInfo(top + name, when)
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, body.encode())
        for entries in files.values():
            for f in entries:
                try:
                    body = s3.get_object(Bucket=bucket, Key=f["key"])["Body"]
                except Exception as e:
                    if not _missing(e):
                        raise
                    counts["missing"] += 1
                    continue
                day = f["path"].split("/")[-1][:10]
                info = zipfile.ZipInfo(top + f["path"], (int(day[:4]), int(day[5:7]), int(day[8:10]), 12, 0, 0))
                info.compress_type = zipfile.ZIP_STORED  # photos and audio are compressed already
                with zf.open(info, "w", force_zip64=True) as out:
                    shutil.copyfileobj(body, out, CHUNK)
                counts["files"] += 1
    return counts


def run(store, s3, bucket: str, user_id: str, export_id: str, now: int, clock=time.time) -> str:
    """Build one export; what became of it: ready, replaced or skipped."""
    found = store.export(user_id)
    if not found or found.get("id") != export_id or found.get("status") != "building":
        log(event="export-skipped", user=user_id)
        return "skipped"
    started = clock()
    key = zip_key(user_id, export_id)
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "export.zip")
            counts = write_zip(path, store.user_items(user_id), s3, bucket, now)
            size = os.path.getsize(path)
            s3.upload_file(path, bucket, key, ExtraArgs={"ContentType": "application/zip"})
    except Exception:
        store.finish_export(user_id, export_id, {"status": "failed", "finished_at": int(clock())})
        log(event="export-failed", user=user_id)
        raise
    finished = int(clock())
    ok = store.finish_export(user_id, export_id, {"status": "ready", "finished_at": finished, "export_key": key,
                                                  "size": size, "files": counts["files"], "expires_at": finished + READY_FOR})
    if not ok:
        s3.delete_object(Bucket=bucket, Key=key)
        log(event="export-replaced", user=user_id)
        return "replaced"
    log(event="export-built", user=user_id, size=size, seconds=round(clock() - started, 1), **counts)
    return "ready"


_clients: dict = {}


def handler(event, context, *, store=None, s3=None, clock=time.time):
    if store is None or s3 is None:
        if "store" not in _clients:
            import boto3

            from .store import Store

            _clients["store"] = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
            _clients["s3"] = boto3.client("s3")
        store, s3 = store or _clients["store"], s3 or _clients["s3"]
    return run(store, s3, os.environ["MAIL_BUCKET"], event["user_id"], event["id"], int(clock()), clock)
