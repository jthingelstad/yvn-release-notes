#!/usr/bin/env python3
"""Run the web app on this machine, against nothing real.

    scripts/dev_server.py [--port 8000]

Serves the built web app (dist/web, from `npm run build`) and hands /api/* to web.handler with the in-memory fakes from
tests/fakes.py: no AWS, no mail. A sign-in email is printed here instead of
sent, link and code included, and the newest one to each address is at
/dev-mail/?to=<address> (the browser tests in e2e/ read it). A fictional subscriber, ada@example.com
(born 1981-06-14), exists from the start, with a week of emails, a few
made-up notes, a past four-day pause and one reply token for trying
/unsubscribe/; any other address is new. Deleting a note or the account
deletes nothing real. Three days back, Ada replied with a made-up photo
and a two-second recording, served from memory at /dev-media/ in place of
the bucket's signed links. A zip export builds in a thread, two seconds
after it is asked for, and downloads from /dev-media/ too. Files chosen on
the web post to /dev-upload/, checked as S3 checks a signed form. City search and weather ask the real Open-Meteo
unless --fake-places (the week of emails comes with made-up weather either
way), and a link's page for its title unless --fake-links. With "Write
out what I say" on in settings, each recording gets a made-up transcript
five seconds later, as the transcriber would put it there, and with
"Describe my photos" on, each photo a made-up description (nothing is sent
anywhere). Everything is forgotten when it stops.

    scripts/dev_server.py --dayone EXPORT.zip [--dayone ANOTHER.zip]

imports Day One exports as Ada's notes with the importer itself
(importer.py), to see a real journal in the app before any of it is
imported for real; files are read from the zip when asked for, and the
days' weather is the fake one with --fake-places, else none.
"""

import argparse
import io
import json
import math
import os
import struct
import sys
import threading
import time
import wave
import zipfile
import zlib
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from email import message_from_bytes
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

from fakes import FakeLambda, FakeS3, FakeSES, FakeStore  # noqa: E402
from release_notes import describe, dayone, export_job, importer, links, media, places, tags, transcribe, weather, web  # noqa: E402

FAKE_PLACES = [
    {"name": "Minneapolis", "region": "Minnesota", "country": "United States", "tz": "America/Chicago", "lat": 44.98, "lon": -93.26},
    {"name": "Minneapolis", "region": "Kansas", "country": "United States", "tz": "America/Chicago", "lat": 39.12, "lon": -97.71},
    {"name": "Paris", "region": "Ile-de-France", "country": "France", "tz": "Europe/Paris", "lat": 48.85, "lon": 2.35},
]


def sample_png(w=1200, h=800) -> bytes:
    """A lake at dusk, more or less: a made-up photo for the dev data."""
    rows = b"".join(b"\x00" + bytes(c for x in range(w) for c in (20 + y * 120 // h, 60 + y * 100 // h, 140 - y * 60 // h + x * 40 // w))
                    for y in range(h))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")


def sample_wav() -> bytes:
    """Two seconds of a quiet A, as a made-up voice memo."""
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(3000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(16000)))
    return out.getvalue()


def fake_weather(url: str) -> dict:
    """Open-Meteo's daily answer for whatever days were asked: mild and partly cloudy."""
    q = dict(parse_qsl(urlsplit(url).query))
    if "start_date" in q:
        days = [q["start_date"]]
    else:
        today = datetime.now(ZoneInfo(q["timezone"])).date()
        days = [(today - timedelta(days=1)).isoformat(), today.isoformat()]
    return {"daily": {"time": days, "weather_code": [2] * len(days),
                      "temperature_2m_max": [17.5] * len(days), "temperature_2m_min": [8.0] * len(days)}}


class PrintingSES(FakeSES):
    """Prints each email, and keeps the newest one to each address for
    /dev-mail/ (the browser tests read sign-in codes there)."""

    def __init__(self):
        super().__init__()
        self.newest = {}

    def send_email(self, **kw):
        msg = message_from_bytes(kw["Content"]["Raw"]["Data"], policy=default)
        text = msg.get_body(('plain',)).get_content()
        self.newest[str(msg['To']).lower()] = f"Subject: {msg['Subject']}\n\n{text}"
        print(f"\n--- mail to {msg['To']}: {msg['Subject']}\n{text}---\n", flush=True)
        return super().send_email(**kw)


class ZipMember:
    """A file in a zip, read when its bytes are asked for: an import puts
    hundreds of megabytes of photos, and this server keeps them all."""

    def __init__(self, path: str, name: str):
        self.path, self.name = path, name
        with zipfile.ZipFile(path) as z:
            self.size = z.getinfo(name).file_size

    def __len__(self):
        return self.size

    def __bytes__(self):
        with zipfile.ZipFile(self.path) as z:
            return z.read(self.name)


def load_dayone(paths: list[str], store, s3, fetch, weather_fetch) -> None:
    """Day One exports imported as Ada's notes, by the importer itself."""
    plans = []
    for path in paths:
        journal, entries, names = dayone.read(path)
        plan = dayone.plan(journal, entries, names, store.profiles["u1"], "u1", web_origin=os.environ["WEB_ORIGIN"])
        plans.append((plan, lambda name, path=path: ZipMember(path, name)))
    today = datetime.now(ZoneInfo("America/Chicago")).date()
    counts = importer.write(plans, "u1", store=store, s3=s3, bucket="dev", today=today, at="2026-10-09T12:00:00Z",
                            fetch_title=fetch, fetch_weather=weather_fetch)
    print(f"-- a Day One import: {json.dumps(counts)}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--fake-places", action="store_true", help="answer city searches and weather without Open-Meteo")
    ap.add_argument("--fake-links", action="store_true", help="title every link 'A page at <host>', fetching nothing")
    ap.add_argument("--dayone", action="append", default=[], metavar="ZIP", help="add a Day One export's notes to Ada's")
    args = ap.parse_args()
    origin = f"http://localhost:{args.port}"
    os.environ.update(WEB_ORIGIN=origin, FROM_ADDRESS="notes@yourversionnumber.com", CONFIG_SET="dev", TABLE="dev",
                      MAIL_BUCKET="dev", EXPORT_FUNCTION="dev-export",
                      SENDER_FUNCTION="dev-sender")

    store, ses, s3 = FakeStore(), PrintingSES(), FakeS3()

    def build_later(payload):  # the export function, as Lambda would run it
        if "send_now" in payload:  # sign-up's first email: the sender is not run here
            print(f"-- sender invoked: today's email for {payload['send_now']}", flush=True)
            return
        threading.Timer(2, export_job.handler, (payload, None), {"store": store, "s3": s3}).start()
    lam = FakeLambda(then=build_later)
    store.emails["ada@example.com"] = "u1"
    store.profiles["u1"] = {
        "email": "ada@example.com", "birthday": "1981-06-14", "tz": "America/Chicago",
        "send_time": "06:00", "status": "active", "created_at": "2026-10-01T12:00:00Z",
        "last_sent_date": datetime.now(ZoneInfo("America/Chicago")).date().isoformat(),
        "city": "Minneapolis", "region": "Minnesota", "country": "United States",
        "lat": 44.98, "lon": -93.26,
    }
    today = datetime.now(ZoneInfo("America/Chicago")).date()
    for n in range(1, 8):
        store.add_day("u1", (today - timedelta(days=n)).isoformat())
        store.put_weather("u1", (today - timedelta(days=n)).isoformat(), weather.record(
            {"high_c": 14.0 + n, "low_c": 4.0 + n / 2, "code": [0, 2, 3, 61, 1, 45, 80][n - 1]},
            weather.place_of(store.profiles["u1"]), "2026-10-01T12:00:00Z"))
    for back, note_id, late, text in [
        (0, "dev-1", 0, "Walked before the rain came in. Coffee on the porch. #walks"),
        (1, "dev-2", 0, "Long day of meetings.\nDinner with the neighbours, who brought the good bread."),
        (3, "dev-3", 2, "Back from the lake. Unpacked, mostly. #cabin #walks"),
        (200, "w-dev4", 150, "Filled in later: the day the new bike came."),
    ]:
        day = today - timedelta(days=back)
        at = datetime.combine(day + timedelta(days=late), datetime.min.time(), ZoneInfo("America/Chicago")) + timedelta(hours=12)
        store.add_note("u1", day.isoformat(), note_id, text=text, source="web" if note_id.startswith("w-") else "email",
                       written_at=at.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ"), tz="America/Chicago",
                       **({"tags": found} if (found := tags.found(text)) else {}),
                       **({} if note_id.startswith("w-") else {"raw_key": f"raw/{note_id}"}))
    # An imported entry, written while travelling: its own zone and place.
    store.add_note("u1", "2016-07-04", "d1-DEV", text="Fireworks over the harbour.\n\n#vacation #maine-2016",
                   source="import", written_at="2016-07-05T01:40:00Z", tz="America/New_York", tags=["vacation", "maine-2016"],
                   place={"venue": "Bar Harbor Town Pier", "city": "Bar Harbor", "region": "Maine", "country": "United States",
                          "lat": 44.39, "lon": -68.2},
                   origin={"app": "dayone", "journal": "Journal", "id": "DEV"})
    photo_day = (today - timedelta(days=3)).isoformat()
    kept = media.store(s3, "dev", "u1", photo_day, "dev-3", [("image/png", sample_png()), ("audio/wav", sample_wav())])
    lake = next(i for i in store.items["u1"] if i["sk"] == f"NOTE#{photo_day}#dev-3")
    lake["media"] = kept
    lake["attachments"] = [{"content_type": e["type"], "filename": "", "size": e["size"]} for e in kept]
    store.items["u1"].append({"pk": "USER#u1", "sk": f"PAUSE#{today - timedelta(days=12)}",
                              "through": (today - timedelta(days=9)).isoformat()})
    store.tokens["abcdefghijklmnopqrstuvwx"] = {"user_id": "u1", "date": "2026-10-01", "version": "4.5.109"}
    fetch = (lambda u: {"title": f"A page at {urlsplit(u).hostname}", "site": urlsplit(u).hostname}) if args.fake_links else links.fetch_title
    geocode = (lambda q: [p for p in FAKE_PLACES if p["name"].lower().startswith(q.lower())]) if args.fake_places else places.search
    weather_fetch = fake_weather if args.fake_places else weather.fetch_json
    if args.dayone:
        # Real weather for hundreds of days is minutes of asking: only the fake.
        load_dayone(args.dayone, store, s3, fetch, fake_weather if args.fake_places else None)

    # What transcribe.py and describe.py do, with made-up words: each file
    # five seconds after it is first seen waiting with the setting on, so a
    # page shows it waiting first whatever else the server is doing.
    made_up = {
        "transcript": ("transcribe", transcribe.waiting,
                       "Made up on this machine: back from the lake, and the loons were out on the water."),
        "description": ("describe", describe.waiting,
                        "Made up on this machine: a red canoe pulled up on a rocky shore, pines behind it."),
    }
    seen = {}

    def write_out():
        while True:
            now = time.monotonic()
            for user_id, p in list(store.profiles.items()):
                for field, (setting, waiting, words) in made_up.items():
                    for n in store.all_notes(user_id) if p.get(setting) else []:
                        for m in waiting(n):
                            at = seen.setdefault((user_id, n["sk"], int(m["n"]), field), now)
                            if now - at >= 5:
                                m[field] = words
            time.sleep(0.5)

    threading.Thread(target=write_out, daemon=True).start()

    site = ROOT / "dist" / "web"
    if not (site / "index.html").exists():
        sys.exit("No web app built: run `npm ci --ignore-scripts && npm run build` first.")

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(site), **kw)

        def api(self):
            url = urlsplit(self.path)
            length = int(self.headers.get("content-length") or 0)
            cookies = [c.strip() for c in (self.headers.get("cookie") or "").split(";") if c.strip()]
            event = {
                "rawPath": url.path,
                "requestContext": {"http": {"method": self.command, "sourceIp": self.client_address[0]}},
                "headers": dict(self.headers.items()),
                "cookies": cookies,
                "queryStringParameters": dict(parse_qsl(url.query)) or None,
                "body": self.rfile.read(length).decode() if length else None,
            }
            r = web.handler(event, None, store=store, ses=ses, s3=s3, lam=lam, geocode=geocode, fetch=fetch,
                            weather_fetch=weather_fetch)
            body = r["body"].encode()
            self.send_response(r["statusCode"])
            for k, v in r["headers"].items():
                self.send_header(k, v)
            for c in r.get("cookies", []):
                self.send_header("set-cookie", c)
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/api/"):
                return self.api()
            if self.path.startswith("/dev-mail/"):
                # The newest email to ?to=, as text: only this server has it.
                to = dict(parse_qsl(urlsplit(self.path).query)).get("to", "").lower()
                if to not in ses.newest:
                    return self.send_error(404)
                body = ses.newest[to].encode()
                self.send_response(200)
                self.send_header("content-type", "text/plain; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            if self.path.startswith("/dev-media/"):
                obj = s3.objects.get(self.path.split("?")[0][len("/dev-media/"):])
                if not obj:
                    return self.send_error(404)
                body = bytes(obj["Body"])  # a Day One file is read from its zip now
                self.send_response(200)
                self.send_header("content-type", obj["ContentType"])
                if self.path.startswith("/dev-media/exports/"):
                    self.send_header("content-disposition", 'attachment; filename="release-notes.zip"')
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                return self.wfile.write(body)
            # As CloudFront does: an address that is no file is the app.
            if "." not in urlsplit(self.path).path.rsplit("/", 1)[-1]:
                self.path = "/index.html"
            return super().do_GET()

        def do_POST(self):
            if self.path == "/dev-upload/":
                return self.upload()
            return self.api()

        do_PUT = do_DELETE = api

        def upload(self):
            """A file sent with a form web.start_upload signed, kept as S3
            would keep it (FakeS3.form_upload): 204, or 403 for a form that
            breaks its policy."""
            from email.parser import BytesParser
            from email.policy import HTTP

            raw = self.rfile.read(int(self.headers.get("content-length", 0)))
            msg = BytesParser(policy=HTTP).parsebytes(
                f"content-type: {self.headers['content-type']}\r\n\r\n".encode() + raw)
            fields, data = {}, b""
            for part in msg.iter_parts():
                name = part.get_param("name", header="content-disposition")
                if name == "file":
                    data = part.get_payload(decode=True) or b""
                else:
                    fields[name] = part.get_content().strip("\r\n")
            self.send_response(204 if s3.form_upload(fields, data) else 403)
            self.end_headers()

        def end_headers(self):
            if not self.path.startswith("/api/"):
                # The same CSP CloudFront adds, so a page that breaks it breaks here.
                self.send_header(
                    "content-security-policy",
                    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; "
                    "font-src 'self'; connect-src 'self' https://tinylytics.app; form-action 'self'; frame-ancestors 'none'",
                )
                self.send_header("cache-control", "no-store")
            super().end_headers()

    print(f"Release Notes, locally: {origin}/  (ada@example.com is a subscriber;", flush=True)
    print(f"  {origin}/unsubscribe/#t=abcdefghijklmnopqrstuvwx stops Ada's emails)", flush=True)
    # The browser tests open many pages at once; socketserver's default
    # queue of 5 resets connections past it.
    ThreadingHTTPServer.request_queue_size = 128
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
