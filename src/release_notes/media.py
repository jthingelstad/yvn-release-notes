"""Photos and recordings from a reply.

Jamie, 2026-10-08: "move forward with attachments (images and audio)
support… have those attached to those entries." Any channel may bring them
(Jamie, 2026-10-09); this module handles the ones that come by email.

The raw message stays the source of truth. When a reply is filed, each photo
and recording in it is copied to the mail bucket at
`media/<user>/<day>/<message id>/<n>.<ext>` and listed on the note as
`media`: [{"n", "kind", "type", "size", "key"}]. Video, PDFs and anything
else stay listed in `attachments` and live in the raw message only.

Small images are signature logos and icons, not photos: an image whose
longest side is under MIN_SIDE pixels (read from its header, standard
library only) is left out, and one whose size cannot be read is kept only
if it is big enough to be a photo.

Nobody but the owner sees a file: the web app asks the API, which checks the
session and redirects to a link that lasts ten minutes (web.media_file).
Deleting a note or the account deletes its files too.
"""

import struct

IMAGES = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
          "image/heic": "heic", "image/heif": "heif"}
AUDIO = {"audio/mp4": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/wav": "wav",
         "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac"}
# What mail apps call them -> what a browser plays.
ALIASES = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
           "audio/mp3": "audio/mpeg", "audio/x-wav": "audio/wav", "audio/wave": "audio/wav", "audio/vnd.wave": "audio/wav",
           "audio/x-aac": "audio/aac", "audio/x-flac": "audio/flac"}
BY_EXTENSION = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
                "heic": "image/heic", "heif": "image/heif", "m4a": "audio/mp4", "mp4a": "audio/mp4", "aac": "audio/aac",
                "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "oga": "audio/ogg", "flac": "audio/flac"}

MIN_SIDE = 200          # pixels; smaller images are logos and icons
MIN_UNREAD = 20 * 1024  # bytes; an image we cannot measure must be at least this
MIN_AUDIO = 1024        # bytes
MAX_FILES = 20          # per reply


def media_type(content_type: str, filename: str) -> str | None:
    """The type a file is kept and served as, or None if it is not a photo
    or recording. Mail apps often send application/octet-stream, so the
    file name decides then."""
    ctype = ALIASES.get(content_type.lower(), content_type.lower())
    if ctype in IMAGES or ctype in AUDIO:
        return ctype
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if ctype in ("application/octet-stream", "") or ctype.startswith(("image/", "audio/")):
        return BY_EXTENSION.get(ext)
    return None


def kind(ctype: str) -> str:
    return "image" if ctype in IMAGES else "audio"


def image_size(data: bytes) -> tuple[int, int] | None:
    """(width, height) from a JPEG, PNG, GIF or WebP header, else None."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if chunk == b"VP8L":
                b = data[21:25]
                return 1 + (((b[1] & 0x3F) << 8) | b[0]), 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
            if chunk == b"VP8X":
                return 1 + int.from_bytes(data[24:27], "little"), 1 + int.from_bytes(data[27:30], "little")
            return None
        if data[:2] == b"\xff\xd8":
            i = 2
            while i + 9 < len(data):
                if data[i] != 0xFF:
                    return None
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                length = struct.unpack(">H", data[i + 2 : i + 4])[0]
                # Start of frame: every SOFn except DHT (C4), JPG (C8) and DAC (CC).
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5 : i + 9])
                    return w, h
                i += 2 + length
    except (struct.error, IndexError):
        return None
    return None


def worth_keeping(ctype: str, data: bytes) -> bool:
    if kind(ctype) == "audio":
        return len(data) >= MIN_AUDIO
    size = image_size(data)
    if size:
        return max(size) >= MIN_SIDE
    return len(data) >= MIN_UNREAD


def found(msg) -> list[tuple[str, bytes]]:
    """(type, bytes) for each photo and recording in a parsed message, in
    order. Body text is never a file."""
    out = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        if part.get_content_disposition() != "attachment" and part.get_content_type().startswith("text/"):
            continue
        ctype = media_type(part.get_content_type(), part.get_filename() or "")
        if not ctype:
            continue
        data = part.get_payload(decode=True) or b""
        if worth_keeping(ctype, data):
            out.append((ctype, data))
        if len(out) == MAX_FILES:
            break
    return out


def key(user_id: str, day: str, note_id: str, n: int, ctype: str) -> str:
    return f"media/{user_id}/{day}/{note_id}/{n}.{IMAGES.get(ctype) or AUDIO[ctype]}"


def store(s3, bucket: str, user_id: str, day: str, note_id: str, files: list[tuple[str, bytes]]) -> list[dict]:
    """Copy the files to the bucket; the entries to list on the note. Keys
    are fixed by the note and order, so a retried reply writes the same."""
    entries = []
    for n, (ctype, data) in enumerate(files, 1):
        k = key(user_id, day, note_id, n, ctype)
        s3.put_object(Bucket=bucket, Key=k, Body=data, ContentType=ctype, ContentDisposition="inline")
        entries.append({"n": n, "kind": kind(ctype), "type": ctype, "size": len(data), "key": k})
    return entries


def keys(note: dict) -> list[str]:
    return [str(m["key"]) for m in note.get("media") or [] if str(m.get("key", "")).startswith("media/")]


def counts(notes: list[dict]) -> dict[str, int]:
    """{"image": n, "audio": n} across notes, plus any other kind
    ("file": an imported PDF)."""
    out = {"image": 0, "audio": 0}
    for note in notes:
        for m in note.get("media") or []:
            out[m["kind"]] = out.get(m["kind"], 0) + 1
    return out


def others(note: dict) -> int:
    """Attachments the app does not show (video, PDFs and the like): still
    in the original email."""
    return sum(1 for a in note.get("attachments") or []
               if not media_type(a.get("content_type", ""), a.get("filename", "")))
