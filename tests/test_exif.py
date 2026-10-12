"""exif.read: when and where a JPEG was taken, from bytes built here by hand
(and, where Pillow is installed, from a JPEG Pillow wrote)."""

import io
import struct
import unittest

from release_notes import exif


def tiff(order="<", taken=b"2026:10:11 14:03:22\x00", offset=b"-05:00\x00",
         lat=((44, 1), (58, 1), (4008, 100)), lat_ref=b"N\x00", lon=((93, 1), (15, 1), (5400, 100)), lon_ref=b"W\x00"):
    """A little-endian or big-endian TIFF: IFD0 points at an Exif IFD and a
    GPS IFD; values too big for an entry go after them."""
    u16 = lambda v: struct.pack(order + "H", v)  # noqa: E731
    u32 = lambda v: struct.pack(order + "I", v)  # noqa: E731
    head = (b"II" if order == "<" else b"MM") + u16(42) + u32(8)

    def ifd(entries, start):
        # entries: [(tag, type, count, payload bytes)]
        table = u16(len(entries))
        extra = b""
        after = start + 2 + 12 * len(entries) + 4
        for tag, kind, count, payload in entries:
            if len(payload) <= 4:
                table += u16(tag) + u16(kind) + u32(count) + payload.ljust(4, b"\x00")
            else:
                table += u16(tag) + u16(kind) + u32(count) + u32(after + len(extra))
                extra += payload
        return table + u32(0) + extra

    ifd0_at = 8
    ifd0_len = 2 + 12 * 2 + 4
    exif_at = ifd0_at + ifd0_len
    exif_entries = []
    if taken is not None:
        exif_entries.append((0x9003, 2, len(taken), taken))
    if offset is not None:
        exif_entries.append((0x9011, 2, len(offset), offset))
    exif_ifd = ifd(exif_entries, exif_at)
    gps_at = exif_at + len(exif_ifd)
    rat = lambda parts: b"".join(u32(n) + u32(d) for n, d in parts)  # noqa: E731
    gps_entries = []
    if lat is not None:
        gps_entries += [(1, 2, len(lat_ref), lat_ref), (2, 5, 3, rat(lat))]
    if lon is not None:
        gps_entries += [(3, 2, len(lon_ref), lon_ref), (4, 5, 3, rat(lon))]
    gps_ifd = ifd(gps_entries, gps_at)
    ifd0 = u16(2) + u16(0x8769) + u16(4) + u32(1) + u32(exif_at) + u16(0x8825) + u16(4) + u32(1) + u32(gps_at) + u32(0)
    return head + ifd0 + exif_ifd + gps_ifd


def jpeg(t: bytes | None, before: bytes = b"") -> bytes:
    out = b"\xff\xd8" + before
    if t is not None:
        body = b"Exif\x00\x00" + t
        out += b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body
    return out + b"\xff\xda\x00\x02" + b"\x00" * 64 + b"\xff\xd9"


class Read(unittest.TestCase):
    def test_time_and_place(self):
        self.assertEqual(exif.read(jpeg(tiff())), {"taken_at": "2026-10-11T14:03:22-05:00", "lat": 44.9778, "lon": -93.265})

    def test_either_byte_order(self):
        self.assertEqual(exif.read(jpeg(tiff(">"))), exif.read(jpeg(tiff("<"))))

    def test_after_a_jfif_segment(self):
        jfif = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x01" * 9
        self.assertEqual(exif.read(jpeg(tiff(), jfif))["lat"], 44.9778)

    def test_south_and_east(self):
        found = exif.read(jpeg(tiff(lat_ref=b"S\x00", lon_ref=b"E\x00")))
        self.assertEqual((found["lat"], found["lon"]), (-44.9778, 93.265))

    def test_only_what_is_there(self):
        self.assertEqual(exif.read(jpeg(tiff(lat=None, lon=None))), {"taken_at": "2026-10-11T14:03:22-05:00"})
        self.assertEqual(exif.read(jpeg(tiff(offset=None))), {"taken_at": "2026-10-11T14:03:22", "lat": 44.9778,
                                                             "lon": -93.265})
        self.assertEqual(exif.read(jpeg(tiff(taken=None, offset=None))), {"lat": 44.9778, "lon": -93.265})

    def test_no_fix_is_no_place(self):
        zero = ((0, 1), (0, 1), (0, 1))
        self.assertNotIn("lat", exif.read(jpeg(tiff(lat=zero, lon=zero))))

    def test_bad_values_are_left_out(self):
        self.assertNotIn("taken_at", exif.read(jpeg(tiff(taken=b"0000:00:00 00:00:00\x00"))))
        self.assertNotIn("taken_at", exif.read(jpeg(tiff(taken=b"yesterday\x00"))))
        self.assertNotIn("lat", exif.read(jpeg(tiff(lat=((95, 1), (0, 1), (0, 1))))))
        self.assertNotIn("lat", exif.read(jpeg(tiff(lat=((44, 0), (0, 1), (0, 1))))))
        self.assertNotIn("lat", exif.read(jpeg(tiff(lat_ref=b"X\x00"))))

    def test_anything_else_is_nothing(self):
        for data in (b"", b"\x89PNG\r\n\x1a\n" + b"\x00" * 100, jpeg(None), jpeg(b"XX*\x00junk"),
                     jpeg(tiff())[:40], b"\xff\xd8\xff\xe1\x00\x01", b"\xff\xd8" + b"\xff\xe1\xff\xff" + b"Exif\x00\x00II"):
            self.assertEqual(exif.read(data), {}, data[:20])

    def test_a_pointer_past_the_end_is_nothing(self):
        t = bytearray(tiff())
        t[4:8] = struct.pack("<I", 10_000)
        self.assertEqual(exif.read(jpeg(bytes(t))), {})

    def test_never_raises_on_noise(self):
        import random

        rng = random.Random(7)
        good = jpeg(tiff())
        for _ in range(500):
            b = bytearray(good)
            for _ in range(rng.randint(1, 8)):
                b[rng.randrange(len(b))] = rng.randrange(256)
            exif.read(bytes(b))  # must not raise


try:
    import PIL  # noqa: F401
    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


@unittest.skipUnless(HAVE_PIL, "Pillow writes a real camera-style file")
class FromPillow(unittest.TestCase):
    def test_reads_what_pillow_wrote(self):
        from PIL import Image

        e = Image.Exif()
        e[0x8769] = {0x9003: "2025:06:20 08:30:00", 0x9011: "+02:00"}
        e[0x8825] = {1: "N", 2: (59.0, 19.0, 46.8), 3: "E", 4: (18.0, 4.0, 6.0)}
        out = io.BytesIO()
        Image.new("RGB", (64, 48)).save(out, "JPEG", exif=e)
        self.assertEqual(exif.read(out.getvalue()), {"taken_at": "2025-06-20T08:30:00+02:00", "lat": 59.329667,
                                                     "lon": 18.068333})


if __name__ == "__main__":
    unittest.main()
