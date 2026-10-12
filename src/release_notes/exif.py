"""When and where a JPEG was taken, from its EXIF, in the standard library.

A phone writes the moment a photo was taken (DateTimeOriginal, with
OffsetTimeOriginal when it knows its zone) and, when location is on, its
GPS position into the JPEG's APP1 segment: a small TIFF structure, read
here with struct. read() returns what it finds:

    {"taken_at": "2026-10-11T14:03:22-05:00", "lat": 44.9778, "lon": -93.265}

`taken_at` is local time as the camera wrote it, with its offset when there
is one. Coordinates are decimal degrees to six places. Anything missing,
malformed or out of range is left out; a file that is not a JPEG with EXIF
gives {}. Nothing is ever raised for a bad file, and nothing is written:
the original keeps every byte (Jamie's prompt, 2026-10-12: "strip nothing
from originals").

HEIC is out of scope: its EXIF sits in an ISO box structure, not APP1, and
a HEIC photo keeps no time or place here. Photos emailed from an iPhone
usually arrive as JPEG.

thumbs.thumbnail reads the original once for its thumbnail and calls this
on the same bytes; the photo's entry gets `taken_at` and `place`
({"lat", "lon"}). Coordinates are never logged.
"""

import struct

MAX_SCAN = 256 * 1024  # APP1 comes first; never walk further than this

TAG_EXIF_IFD = 0x8769
TAG_GPS_IFD = 0x8825
TAG_TAKEN = 0x9003  # DateTimeOriginal, "YYYY:MM:DD HH:MM:SS"
TAG_OFFSET = 0x9011  # OffsetTimeOriginal, "+HH:MM"
GPS_LAT_REF, GPS_LAT, GPS_LON_REF, GPS_LON = 1, 2, 3, 4

SIZES = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}  # bytes per value, by TIFF type


def app1(data: bytes) -> bytes | None:
    """The EXIF segment's TIFF bytes, or None."""
    if data[:2] != b"\xff\xd8":
        return None
    i = 2
    end = min(len(data), MAX_SCAN)
    while i + 4 <= end:
        if data[i] != 0xFF:
            return None
        marker = data[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in (0xD9, 0xDA):  # end of image, start of scan: no EXIF before the pixels
            return None
        (length,) = struct.unpack(">H", data[i + 2:i + 4])
        if length < 2:
            return None
        body = data[i + 4:i + 2 + length]
        if marker == 0xE1 and body[:6] == b"Exif\x00\x00":
            return body[6:]
        i += 2 + length
    return None


class _Tiff:
    def __init__(self, b: bytes):
        if b[:2] == b"II":
            self.e = "<"
        elif b[:2] == b"MM":
            self.e = ">"
        else:
            raise ValueError("byte order")
        if struct.unpack(self.e + "H", b[2:4])[0] != 42:
            raise ValueError("magic")
        self.b = b

    def u16(self, at: int) -> int:
        return struct.unpack_from(self.e + "H", self.b, at)[0]

    def u32(self, at: int) -> int:
        return struct.unpack_from(self.e + "I", self.b, at)[0]

    def ifd(self, at: int) -> dict[int, tuple[int, int, int]]:
        """{tag: (type, count, where its value is)} for the IFD at `at`."""
        out = {}
        if not 8 <= at <= len(self.b) - 2:
            return out
        for k in range(min(self.u16(at), 512)):
            e = at + 2 + 12 * k
            if e + 12 > len(self.b):
                break
            tag, kind, count = self.u16(e), self.u16(e + 2), self.u32(e + 4)
            size = SIZES.get(kind, 0) * count
            where = e + 8 if size <= 4 else self.u32(e + 8)
            if size and where + size <= len(self.b):
                out[tag] = (kind, count, where)
        return out

    def text(self, entry) -> str:
        kind, count, where = entry
        if kind != 2:
            return ""
        return self.b[where:where + count].split(b"\x00", 1)[0].decode("ascii", "replace").strip()

    def rationals(self, entry) -> list[float]:
        kind, count, where = entry
        if kind != 5:
            return []
        out = []
        for k in range(count):
            num, den = self.u32(where + 8 * k), self.u32(where + 8 * k + 4)
            if not den:
                return []
            out.append(num / den)
        return out


def _taken(t: _Tiff, exif: dict) -> str | None:
    raw = t.text(exif[TAG_TAKEN]) if TAG_TAKEN in exif else ""
    try:
        day, time = raw.split(" ")
        y, mo, d = (int(x) for x in day.split(":"))
        h, mi, s = (int(x) for x in time.split(":"))
        if not (1900 < y < 2200 and 1 <= mo <= 12 and 1 <= d <= 31 and 0 <= h < 24 and 0 <= mi < 60 and 0 <= s < 61):
            return None
    except ValueError:
        return None
    out = f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}"
    offset = t.text(exif[TAG_OFFSET]) if TAG_OFFSET in exif else ""
    if len(offset) == 6 and offset[0] in "+-" and offset[3] == ":" and (offset[1:3] + offset[4:]).isdigit():
        out += offset
    return out


def _degrees(t: _Tiff, gps: dict, value: int, ref: int, positive: str, negative: str, limit: float) -> float | None:
    if value not in gps or ref not in gps:
        return None
    parts = t.rationals(gps[value])
    side = t.text(gps[ref]).upper()
    if len(parts) != 3 or side not in (positive, negative):
        return None
    deg = parts[0] + parts[1] / 60 + parts[2] / 3600
    if not 0 <= deg <= limit:
        return None
    return round(-deg if side == negative else deg, 6)


def read(data: bytes) -> dict:
    """{"taken_at", "lat", "lon"}, each only when found; {} for anything else."""
    try:
        tiff = app1(data)
        if not tiff:
            return {}
        t = _Tiff(tiff)
        ifd0 = t.ifd(t.u32(4))
        out = {}
        if TAG_EXIF_IFD in ifd0 and ifd0[TAG_EXIF_IFD][0] == 4:
            if taken := _taken(t, t.ifd(t.u32(ifd0[TAG_EXIF_IFD][2]))):
                out["taken_at"] = taken
        if TAG_GPS_IFD in ifd0 and ifd0[TAG_GPS_IFD][0] == 4:
            gps = t.ifd(t.u32(ifd0[TAG_GPS_IFD][2]))
            lat = _degrees(t, gps, GPS_LAT, GPS_LAT_REF, "N", "S", 90)
            lon = _degrees(t, gps, GPS_LON, GPS_LON_REF, "E", "W", 180)
            # 0,0 is a phone with no fix, not a spot in the Gulf of Guinea.
            if lat is not None and lon is not None and (lat, lon) != (0.0, 0.0):
                out.update(lat=lat, lon=lon)
        return out
    except (ValueError, struct.error, IndexError):
        return {}
