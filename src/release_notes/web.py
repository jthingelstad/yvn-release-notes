"""The web app's API, behind CloudFront at notes.yourversionnumber.com/api/.

One function, a small router. API Gateway hands it the HTTP API's payload
2.0: headers lowercased, cookies as a list, the body maybe base64.

- Every write (POST, PUT, DELETE) must carry the site's own Origin. With the
  SameSite=Lax cookie that keeps other sites from acting as a signed-in
  person.
- A session is either a subscriber's (user_id) or an address that has
  proved itself and has no account yet (email): sign-up finishes that.
- Logs carry routes, user ids and outcomes. Never an address, a note or a
  city, and never a path the router did not match.
"""

import json
import os
import re
import time
from base64 import b64decode
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from . import auth, export
from .compose import from_header
from .version import compute_version

MAX_BODY = 64 * 1024


def log(**fields):
    print(json.dumps(fields, separators=(",", ":")))


def respond(status: int, body, *, cookies: list[str] | None = None, headers: dict | None = None) -> dict:
    out = {
        "statusCode": status,
        "headers": {"content-type": "application/json", "cache-control": "no-store", **(headers or {})},
        "body": body if isinstance(body, str) else json.dumps(body, separators=(",", ":")),
    }
    if cookies:
        out["cookies"] = cookies
    return out


class Reject(Exception):
    """Stop a route with an error answer."""

    def __init__(self, status: int, error: str, **extra):
        self.response = respond(status, {"error": error, **extra})


class Request:
    def __init__(self, event: dict):
        http = event.get("requestContext", {}).get("http", {})
        self.method = http.get("method", "")
        self.path = event.get("rawPath", "")
        self.headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        self.cookies = event.get("cookies") or []
        self.query = event.get("queryStringParameters") or {}
        self.source_ip = http.get("sourceIp", "")
        self._body = event.get("body") or ""
        self._b64 = event.get("isBase64Encoded", False)

    def json(self) -> dict:
        raw = b64decode(self._body) if self._b64 else self._body.encode()
        if len(raw) > MAX_BODY:
            raise Reject(413, "too-large")
        try:
            body = json.loads(raw or b"{}")
        except ValueError:
            raise Reject(400, "bad-json") from None
        if not isinstance(body, dict):
            raise Reject(400, "bad-json")
        return body

    def viewer(self) -> str:
        # CloudFront's "198.51.100.10:46532" or "2001:db8::1:46532". A caller
        # using the API's own URL can forge it, which the total limit covers.
        addr = self.headers.get("cloudfront-viewer-address", "")
        return addr.rsplit(":", 1)[0].strip("[]") if ":" in addr else self.source_ip


_clients: dict = {}  # kept across warm invocations


class App:
    def __init__(self, store, ses, now: int):
        self._store, self._ses, self.now = store, ses, now
        self.origin = os.environ["WEB_ORIGIN"]

    @property
    def store(self):
        if self._store is None:
            if "store" not in _clients:
                import boto3

                from .store import Store

                _clients["store"] = Store(boto3.resource("dynamodb").Table(os.environ["TABLE"]))
            self._store = _clients["store"]
        return self._store

    @property
    def ses(self):
        if self._ses is None:
            if "ses" not in _clients:
                import boto3

                _clients["ses"] = boto3.client("sesv2")
            self._ses = _clients["ses"]
        return self._ses

    def session(self, req: Request) -> dict | None:
        token = auth.cookie_token(req.cookies)
        if not token:
            return None
        h = auth.digest(token)
        s = self.store.get_session(h)
        if not s or int(s["expires_at"]) <= self.now:
            return None
        s["hash"] = h
        if self.now - int(s.get("seen_at", 0)) >= auth.SESSION_TOUCH:
            self.store.touch_session(h, self.now, auth.session_expiry(int(s["created_at"]), self.now))
        return s

    def signed_in(self, req: Request) -> dict:
        s = self.session(req)
        if not s:
            raise Reject(401, "signed-out")
        return s

    def subscriber(self, req: Request) -> dict:
        s = self.signed_in(req)
        if "user_id" not in s:
            raise Reject(403, "no-account")
        return s


# --- routes ------------------------------------------------------------------


def health(app: App, req: Request) -> dict:
    return respond(200, {"ok": True})


SAMPLE_BIRTHDAY = date(1981, 6, 14)  # the design canvas's someone


def sample(app: App, req: Request) -> dict:
    """The front page's example: someone's version number today."""
    today = datetime.fromtimestamp(app.now, ZoneInfo("America/Chicago")).date()
    return respond(200, {"birthday": SAMPLE_BIRTHDAY.isoformat(), "version": str(compute_version(SAMPLE_BIRTHDAY, today))})


def auth_start(app: App, req: Request) -> dict:
    email = auth.normal_email(req.json().get("email"))
    if not email:
        raise Reject(400, "email")
    email_hash = auth.digest(email)
    hour = app.now // 3600
    over = [
        name
        for name, key, limit in (
            ("total", "all", auth.LIMIT_TOTAL),
            ("network", "net:" + auth.digest(auth.network(req.viewer())), auth.LIMIT_PER_NETWORK),
            ("address", "email:" + email_hash, auth.LIMIT_PER_ADDRESS),
        )
        if app.store.count(key, hour) > limit
    ]
    if over:
        log(event="signin-limited", limits=over)
        raise Reject(429, "limited")

    token, code = auth.new_token(), auth.new_code()
    app.store.put_login(auth.digest(token), email, email_hash, auth.digest(code), app.now, auth.LOGIN_TTL)
    from_addr = os.environ["FROM_ADDRESS"]
    msg = auth.signin_message(to=email, from_addr=from_addr, link=f"{app.origin}/signin/#t={token}", code=code)
    try:
        app.ses.send_email(
            FromEmailAddress=from_header(from_addr),
            Destination={"ToAddresses": [email]},
            Content={"Raw": {"Data": msg.as_bytes()}},
            ConfigurationSetName=os.environ["CONFIG_SET"],
        )
    except Exception as e:
        code_name = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
        log(event="signin-mail-failed", error=type(e).__name__, code=code_name)
        raise Reject(502, "mail-failed") from None
    log(event="signin-sent")
    return respond(202, {"ok": True})


CODE_ERRORS = {"gone": "code-expired", "used": "code-used", "attempts": "too-many-tries"}


def auth_verify(app: App, req: Request) -> dict:
    body = req.json()
    if "token" in body:
        token = auth.valid_token(body.get("token"))
        login = app.store.burn_login(auth.digest(token), app.now) if token else None
        if not login:
            raise Reject(400, "link-used-or-expired")
        how = "link"
    else:
        email, code = auth.normal_email(body.get("email")), auth.valid_code(body.get("code"))
        if not email or not code:
            raise Reject(400, "email-and-code")
        token_hash = app.store.newest_login(auth.digest(email))
        if not token_hash:
            raise Reject(400, "code-expired")
        spent = app.store.spend_attempt(token_hash, app.now, auth.MAX_CODE_ATTEMPTS)
        if isinstance(spent, str):
            raise Reject(400, CODE_ERRORS[spent])
        if not auth.same(auth.digest(code), spent["code_hash"]):
            left = auth.MAX_CODE_ATTEMPTS - int(spent["attempts"])
            raise Reject(400, "wrong-code" if left else "too-many-tries", tries_left=left)
        login = app.store.burn_login(token_hash, app.now)
        if not login:
            raise Reject(400, "code-used")
        how = "code"

    email = login["email"]
    user_id = app.store.user_for_email(email)
    session = auth.new_token()
    app.store.put_session(
        auth.digest(session),
        user_id=user_id,
        email=None if user_id else email,
        now=app.now,
        expires=auth.session_expiry(app.now, app.now),
    )
    old = auth.cookie_token(req.cookies)
    if old:
        app.store.delete_session(auth.digest(old))
    log(event="signin", how=how, user=user_id, new=user_id is None)
    return respond(200, {"new": user_id is None}, cookies=[auth.session_cookie(session)])


def auth_signout(app: App, req: Request) -> dict:
    token = auth.cookie_token(req.cookies)
    if token:
        app.store.delete_session(auth.digest(token))
    return respond(200, {"ok": True}, cookies=[auth.clear_cookie()])


def me(app: App, req: Request) -> dict:
    s = app.signed_in(req)
    if "user_id" not in s:
        return respond(200, {"new": True, "email": s["email"]})
    p = app.store.profile(s["user_id"])
    if not p:
        raise Reject(403, "no-account")
    today = datetime.fromtimestamp(app.now, ZoneInfo(p["tz"])).date()
    birthday = date.fromisoformat(p["birthday"])
    return respond(
        200,
        {
            "new": False,
            "email": p["email"],
            "birthday": p["birthday"],
            "tz": p["tz"],
            "send_time": p.get("send_time", "06:00"),
            "status": p.get("status", "active"),
            "today": today.isoformat(),
            "version": str(compute_version(birthday, today)),
        },
    )


def export_data(app: App, req: Request) -> dict:
    s = app.subscriber(req)
    fmt = req.query.get("format", "json")
    if fmt not in ("json", "md"):
        raise Reject(400, "format")
    stamp = datetime.fromtimestamp(app.now, timezone.utc)
    data = export.build(app.store.user_items(s["user_id"]), stamp.strftime("%Y-%m-%dT%H:%M:%SZ"))
    name = f"release-notes-{stamp:%Y-%m-%d}.{fmt}"
    if fmt == "md":
        body, ctype = export.markdown(data), "text/markdown; charset=utf-8"
    else:
        body, ctype = json.dumps(data, indent=2, ensure_ascii=False) + "\n", "application/json; charset=utf-8"
    log(event="export", user=s["user_id"], format=fmt, notes=len(data["notes"]))
    return respond(200, body, headers={"content-type": ctype, "content-disposition": f'attachment; filename="{name}"'})


ROUTES = [
    ("GET", "/api/health", health),
    ("GET", "/api/sample", sample),
    ("POST", "/api/auth/start", auth_start),
    ("POST", "/api/auth/verify", auth_verify),
    ("POST", "/api/auth/signout", auth_signout),
    ("GET", "/api/me", me),
    ("GET", "/api/export", export_data),
]
_COMPILED = [(m, re.compile(p.replace("{date}", r"(\d{4}-\d{2}-\d{2})").replace("{id}", r"([A-Za-z0-9_-]{1,80})")), p, f) for m, p, f in ROUTES]


def match(method: str, path: str):
    for m, rx, pattern, fn in _COMPILED:
        found = rx.fullmatch(path)
        if found and m == method:
            return pattern, fn, found.groups()
    return None, None, ()


def handler(event, context, *, store=None, ses=None, clock=time.time):
    req = Request(event)
    pattern, route, args = match(req.method, req.path)
    if not route:
        response = respond(404, {"error": "not-found"})
    elif req.method != "GET" and req.headers.get("origin") != os.environ["WEB_ORIGIN"]:
        response = respond(403, {"error": "origin"})
    else:
        try:
            response = route(App(store, ses, int(clock())), req, *args)
        except Reject as r:
            response = r.response
    log(event="web", method=req.method, path=pattern or "unmatched", status=response["statusCode"])
    return response
