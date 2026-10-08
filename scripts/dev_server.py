#!/usr/bin/env python3
"""Run the web app on this machine, against nothing real.

    scripts/dev_server.py [--port 8000]

Serves web/ and hands /api/* to web.handler with the in-memory fakes from
tests/fakes.py: no AWS, no mail. A sign-in email is printed here instead of
sent, link and code included. A fictional subscriber, ada@example.com
(born 1981-06-14), exists from the start, with one reply token for trying
/unsubscribe/; any other address is new. City search asks the real
Open-Meteo unless --fake-places. Everything is forgotten when it stops.
"""

import argparse
import json
import os
import sys
from email import message_from_bytes
from email.policy import default
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "src"), str(ROOT / "tests")]

from fakes import FakeSES, FakeStore  # noqa: E402
from release_notes import places, web  # noqa: E402

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
    args = ap.parse_args()
    origin = f"http://localhost:{args.port}"
    os.environ.update(WEB_ORIGIN=origin, FROM_ADDRESS="notes@yourversionnumber.com", CONFIG_SET="dev", TABLE="dev")

    store, ses = FakeStore(), PrintingSES()
    store.emails["ada@example.com"] = "u1"
    store.profiles["u1"] = {
        "email": "ada@example.com", "birthday": "1981-06-14", "tz": "America/Chicago",
        "send_time": "06:00", "status": "active", "created_at": "2026-10-01T12:00:00Z",
        "city": "Minneapolis", "region": "Minnesota", "country": "United States",
    }
    store.tokens["abcdefghijklmnopqrstuvwx"] = {"user_id": "u1", "date": "2026-10-01", "version": "4.5.109"}
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
            r = web.handler(event, None, store=store, ses=ses, geocode=geocode)
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
                    "font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
                )
                self.send_header("cache-control", "no-store")
            super().end_headers()

    print(f"Release Notes, locally: {origin}/  (ada@example.com is a subscriber;", flush=True)
    print(f"  {origin}/unsubscribe/#t=abcdefghijklmnopqrstuvwx stops Ada's emails)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
