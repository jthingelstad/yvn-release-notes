#!/usr/bin/env python3
"""Run the web app on this machine, against nothing real.

    scripts/dev_server.py [--port 8000]

Serves web/ and hands /api/* to web.handler with the in-memory fakes from
tests/fakes.py: no AWS, no mail. A sign-in email is printed here instead of
sent, link and code included. A fictional subscriber, ada@example.com
(born 1981-06-14), exists from the start, with a week of emails, a few
made-up notes, a past four-day pause and one reply token for trying
/unsubscribe/; any other address is new. Deleting a note or the account
deletes nothing real. City search asks the real Open-Meteo unless
--fake-places, and a link's page for its title unless --fake-links.
Everything is forgotten when it stops.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from email import message_from_bytes
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

from fakes import FakeS3, FakeSES, FakeStore  # noqa: E402
from release_notes import links, places, web  # noqa: E402

FAKE_PLACES = [
    {"name": "Minneapolis", "region": "Minnesota", "country": "United States", "tz": "America/Chicago", "lat": 44.98, "lon": -93.26},
    {"name": "Minneapolis", "region": "Kansas", "country": "United States", "tz": "America/Chicago", "lat": 39.12, "lon": -97.71},
    {"name": "Paris", "region": "Ile-de-France", "country": "France", "tz": "Europe/Paris", "lat": 48.85, "lon": 2.35},
]


class PrintingSES(FakeSES):
    def send_email(self, **kw):
        msg = message_from_bytes(kw["Content"]["Raw"]["Data"], policy=default)
        print(f"\n--- mail to {msg['To']}: {msg['Subject']}\n{msg.get_body(('plain',)).get_content()}---\n", flush=True)
        return super().send_email(**kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--fake-places", action="store_true", help="answer city searches from a fixed list")
    ap.add_argument("--fake-links", action="store_true", help="title every link 'A page at <host>', fetching nothing")
    args = ap.parse_args()
    origin = f"http://localhost:{args.port}"
    os.environ.update(WEB_ORIGIN=origin, FROM_ADDRESS="notes@yourversionnumber.com", CONFIG_SET="dev", TABLE="dev",
                      MAIL_BUCKET="dev")

    store, ses, s3 = FakeStore(), PrintingSES(), FakeS3()
    store.emails["ada@example.com"] = "u1"
    store.profiles["u1"] = {
        "email": "ada@example.com", "birthday": "1981-06-14", "tz": "America/Chicago",
        "send_time": "06:00", "status": "active", "created_at": "2026-10-01T12:00:00Z",
        "last_sent_date": datetime.now(ZoneInfo("America/Chicago")).date().isoformat(),
        "city": "Minneapolis", "region": "Minnesota", "country": "United States",
    }
    today = datetime.now(ZoneInfo("America/Chicago")).date()
    for n in range(1, 8):
        store.add_day("u1", (today - timedelta(days=n)).isoformat())
    for back, note_id, late, text in [
        (0, "dev-1", 0, "Walked before the rain came in. Coffee on the porch."),
        (1, "dev-2", 0, "Long day of meetings.\nDinner with the neighbours, who brought the good bread."),
        (3, "dev-3", 2, "Back from the lake. Unpacked, mostly."),
        (200, "w-dev4", 150, "Filled in later: the day the new bike came."),
    ]:
        day = today - timedelta(days=back)
        at = datetime.combine(day + timedelta(days=late), datetime.min.time(), ZoneInfo("America/Chicago")) + timedelta(hours=12)
        store.add_note("u1", day.isoformat(), note_id, text=text, source="web" if note_id.startswith("w-") else "email",
                       received_at=at.astimezone(ZoneInfo("UTC")).strftime("%Y-%m-%dT%H:%M:%SZ"),
                       **({} if note_id.startswith("w-") else {"raw_key": f"raw/{note_id}"}))
    store.items["u1"].append({"pk": "USER#u1", "sk": f"PAUSE#{today - timedelta(days=12)}",
                              "through": (today - timedelta(days=9)).isoformat()})
    store.tokens["abcdefghijklmnopqrstuvwx"] = {"user_id": "u1", "date": "2026-10-01", "version": "4.5.109"}
    fetch = (lambda u: {"title": f"A page at {urlsplit(u).hostname}", "site": urlsplit(u).hostname}) if args.fake_links else links.fetch_title
    geocode = (lambda q: [p for p in FAKE_PLACES if p["name"].lower().startswith(q.lower())]) if args.fake_places else places.search

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(ROOT / "web"), **kw)

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
            r = web.handler(event, None, store=store, ses=ses, s3=s3, geocode=geocode, fetch=fetch)
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
            return super().do_GET()

        do_POST = do_PUT = do_DELETE = api

        def end_headers(self):
            if not self.path.startswith("/api/"):
                # The same CSP CloudFront adds, so a page that breaks it breaks here.
                self.send_header(
                    "content-security-policy",
                    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                    "font-src 'self'; connect-src 'self' https://tinylytics.app; form-action 'self'; frame-ancestors 'none'",
                )
                self.send_header("cache-control", "no-store")
            super().end_headers()

    print(f"Release Notes, locally: {origin}/  (ada@example.com is a subscriber;", flush=True)
    print(f"  {origin}/unsubscribe/#t=abcdefghijklmnopqrstuvwx stops Ada's emails)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
