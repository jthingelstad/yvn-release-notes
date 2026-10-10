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
if it is big enough to be a photo. So is a file whose first bytes are not
the photo or recording it claims to be (looks_like, as for uploads): its
attachment entry is marked `refused`.

On the web (Jamie, 2026-10-09: "add a file to an entry via the web ...
image, audio, PDF"), the browser sends each file straight to the bucket,
since the API takes at most a few megabytes. web.start_upload signs a
form for one file of one type and exact size, to
`media/<user>/web/<upload id>.<ext>`, tagged `outcome=pending`; the
bucket expires pending files after a day. web.attach then reads the
file's first bytes (looks_like) and copies that very version (by its
VersionId) to `media/<user>/files/<file id>.<ext>`, tagged `outcome=note`,
a key no upload form can write; then it deletes the pending version and
lists the copy on the note. So the form, still good for a few minutes,
cannot send other bytes over a file once it was checked (2026-10-09
audit). Notes from before keep their `media/<user>/web/` keys, which every
reader takes as it takes any key under `media/<user>/`. A PDF is kind
`file`, as an imported one is.

A new note or one already there takes photos, recordings and PDFs, up to
50 MB each and 20 a note, and a note with files may have no words. A form
lasts 5 minutes, and since sign-up is open each subscriber gets at most
200 forms or 2 GB of declared size a UTC day (web.UPLOADS_A_DAY,
UPLOAD_BYTES_A_DAY; past either, 429 `upload-limit`). The page's CSP
connect-src and the bucket's CORS name each other for this. upload_type
drops codec parameters (`audio/webm;codecs=opus`), which a recording made
on the page carries.

Nobody but the owner sees a file, and never by a public URL (Jamie,
2026-10-09: signed links, "the right approach", for every file). Each file
on a note in an API answer carries `url`, a link signed on the bucket's own
host, only for keys under the subscriber's own `media/<user>/`
(App.media_links); the key itself is never a field of an answer. A link is
signed for 15 minutes and a warm function hands out the same one for 5, so
the browser reuses its copy (2026-10-09: photos had been one API call each,
and a page of them started several cold functions at once). Past nine
minutes on the page, or when a link fails, the page asks
web.media_file, which checks the session and the key's owner and
redirects to a fresh link. The email's "On this day" links to the day
("See 2 photos") and carries no file.
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
MAX_FILES = 20          # per reply, and per note on the web
PDF = {"application/pdf": "pdf"}
MAX_UPLOAD = 50 * 1024 * 1024  # bytes, one file on the web
UPLOADABLE = {**IMAGES, **AUDIO, **PDF}
HEAD = 64 * 1024        # bytes of an upload read to check what it is


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
    return "image" if ctype in IMAGES else "file" if ctype in PDF else "audio"


def extension(ctype: str) -> str:
    return IMAGES.get(ctype) or AUDIO.get(ctype) or PDF[ctype]


def upload_type(content_type: str, filename: str) -> str | None:
    """What a file chosen on the web is kept as: a photo, a recording or a
    PDF. Browsers leave the type empty for some files, so the name decides
    then, and a recording made in the browser says its codec
    ("audio/webm;codecs=opus"), which is dropped."""
    ctype = (content_type or "").split(";")[0].strip().lower()
    if ctype in PDF or (ctype in ("", "application/octet-stream") and filename.lower().endswith(".pdf")):
        return "application/pdf"
    return media_type(ctype, filename)


def upload_key(user_id: str, upload_id: str, ctype: str) -> str:
    """Where an upload form sends a file, pending until a note takes it."""
    return f"media/{user_id}/web/{upload_id}.{extension(ctype)}"


def kept_key(user_id: str, file_id: str, ctype: str) -> str:
    """Where a checked upload is kept once a note takes it: no form signs
    for this key, so its bytes are the ones attach checked."""
    return f"media/{user_id}/files/{file_id}.{extension(ctype)}"


def looks_like(ctype: str, head: bytes) -> bool:
    """Whether a file's first bytes are what its type says: an upload is
    whatever the browser sent, so it is checked before it joins a note."""
    box = head[4:8] == b"ftyp"  # the ISO media family: HEIC, M4A
    checks = {
        "image/jpeg": head[:3] == b"\xff\xd8\xff",
        "image/png": head[:8] == b"\x89PNG\r\n\x1a\n",
        "image/gif": head[:6] in (b"GIF87a", b"GIF89a"),
        "image/webp": head[:4] == b"RIFF" and head[8:12] == b"WEBP",
        "image/heic": box, "image/heif": box,
        "audio/mp4": box,
        "audio/aac": head[:2] in (b"\xff\xf1", b"\xff\xf9"),
        "audio/mpeg": head[:3] == b"ID3" or (head[:1] == b"\xff" and len(head) > 1 and head[1] & 0xE0 == 0xE0),
        "audio/wav": head[:4] == b"RIFF" and head[8:12] == b"WAVE",
        "audio/ogg": head[:4] == b"OggS",
        "audio/webm": head[:4] == b"\x1a\x45\xdf\xa3",
        "audio/flac": head[:4] == b"fLaC",
        "application/pdf": head[:5] == b"%PDF-",
    }
    return checks.get(ctype, False)


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


def found(msg, refused: list[int] | None = None) -> list[tuple[str, bytes]]:
    """(type, bytes) for each photo and recording in a parsed message, in
    order. Body text is never a file. Like an upload, each is checked by its
    first bytes (looks_like), since its type and name are whatever the
    sender wrote. One that is not what it says stays in the raw message
    only: its place in parse.attachments' list goes in `refused`, and
    inbound marks that entry so it shows as "in the original email"
    (others)."""
    out = []
    n = -1  # the part's place in parse.attachments, which skips the same parts
    for part in msg.walk():
        if part.is_multipart():
            continue
        if part.get_content_disposition() != "attachment" and part.get_content_type().startswith("text/"):
            continue
        n += 1
        ctype = media_type(part.get_content_type(), part.get_filename() or "")
        if not ctype:
            continue
        data = part.get_payload(decode=True) or b""
        if not looks_like(ctype, data[:HEAD]):
            if refused is not None:
                refused.append(n)
            continue
        if worth_keeping(ctype, data):
            out.append((ctype, data))
        if len(out) == MAX_FILES:
            break
    return out


def key(user_id: str, day: str, note_id: str, n: int, ctype: str) -> str:
    return f"media/{user_id}/{day}/{note_id}/{n}.{extension(ctype)}"


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
    """Attachments the app does not show (video, PDFs and the like, and a
    photo or recording whose bytes were not what it said, marked `refused`):
    still in the original email."""
    return sum(1 for a in note.get("attachments") or []
               if a.get("refused") or not media_type(a.get("content_type", ""), a.get("filename", "")))
