"""The web app's API, behind CloudFront at notes.yourversionnumber.com/api/.

One function, a small router. API Gateway hands it the HTTP API's payload
2.0: headers lowercased, cookies as a list, the body maybe base64.

- Only CloudFront is answered. The HTTP API's own execute-api URL stays
  reachable (it is CloudFront's origin), so CloudFront sends X-Origin-Verify
  with the stack's generated secret (ORIGIN_SECRET here) and anything
  without it gets a fixed 403 before any route. Behind that,
  CloudFront-Viewer-Address and Origin are CloudFront's own. With no
  ORIGIN_SECRET (the tests, scripts/dev_server.py) there is no CloudFront
  and no check.
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
import unicodedata
import uuid
from base64 import b64decode
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from . import auth, export, export_job, links, media, places, tags, transcribe, weather
from .compose import DOTS, MAIL_TAG, from_header, next_release
from .notes import MAX_NOTE, map_url, place_label, written_at
from .streak import ONE_DAY, compute_streak, pause_days
from .version import anniversary, compute_version

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


# Sent by CloudFront on every request to the API origin (infra/template.yaml).
ORIGIN_HEADER = "x-origin-verify"


class Request:
    def __init__(self, event: dict):
        http = event.get("requestContext", {}).get("http", {})
        self.method = http.get("method", "")
        self.path = event.get("rawPath", "")
        self.headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        # Taken out at once, so nothing after the check can read or log it.
        self._verify = self.headers.pop(ORIGIN_HEADER, "")
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

    def via_cloudfront(self) -> bool:
        # Compared in constant time, so how long a wrong guess takes says
        # nothing about how much of it was right.
        secret = os.environ.get("ORIGIN_SECRET", "")
        return not secret or auth.same(self._verify, secret)

    def viewer(self) -> str:
        # CloudFront's "198.51.100.10:46532" or "2001:db8::1:46532". The
        # handler answers only requests that came through CloudFront, which
        # sets this header itself, so a caller cannot choose it.
        addr = self.headers.get("cloudfront-viewer-address", "")
        return addr.rsplit(":", 1)[0].strip("[]") if ":" in addr else self.source_ip


_clients: dict = {}  # kept across warm invocations


class App:
    def __init__(self, store, ses, now: int, s3=None, lam=None):
        self._store, self._ses, self._s3, self._lam, self.now = store, ses, s3, lam, now
        self.origin = os.environ["WEB_ORIGIN"]
        self.renewed = None  # the session cookie again, when its 14 days start over

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

    @property
    def s3(self):
        if self._s3 is None:
            if "s3" not in _clients:
                import boto3
                from botocore.config import Config

                # The regional, virtual-hosted name, so a photo's link is on
                # the one host the CSP names (the bucket's RegionalDomainName).
                region = os.environ.get("AWS_REGION", "us-east-1")
                _clients["s3"] = boto3.client(
                    "s3", region_name=region, endpoint_url=f"https://s3.{region}.amazonaws.com",
                    config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
                )
            self._s3 = _clients["s3"]
        return self._s3

    @property
    def lam(self):
        if self._lam is None:
            if "lambda" not in _clients:
                import boto3

                _clients["lambda"] = boto3.client("lambda")
            self._lam = _clients["lambda"]
        return self._lam

    def media_link(self, key: str, content_type: str) -> str:
        """A signed link to one of the bucket's files, good for MEDIA_LINK
        seconds at least. The same link for LINK_REUSE seconds, so the
        browser's copy from a page a minute ago is used again."""
        kept = _links.get(key)
        if kept and self.now - kept[1] < LINK_REUSE:
            return kept[0]
        url = self.s3.generate_presigned_url(
            "get_object",
            Params={"Bucket": os.environ["MAIL_BUCKET"], "Key": key, "ResponseContentType": content_type,
                    "ResponseContentDisposition": "inline", "ResponseCacheControl": f"private, max-age={MEDIA_LINK}"},
            ExpiresIn=MEDIA_LINK + LINK_REUSE,
        )
        if len(_links) > 5000:
            _links.clear()
        _links[key] = (url, self.now)
        return url

    def media_links(self, user_id: str):
        """media_link for this subscriber's own files only: anything else
        on a note (a key outside media/<user>/) gets no link."""
        def link(key, content_type):
            return self.media_link(key, content_type) if str(key or "").startswith(f"media/{user_id}/") else None
        return link

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
            s["expires_at"] = auth.session_expiry(self.now)
            self.store.touch_session(h, self.now, s["expires_at"], s.get("user_id"))
            self.renewed = auth.session_cookie(token)
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

    def account(self, req: Request) -> tuple[str, dict]:
        s = self.subscriber(req)
        p = self.store.profile(s["user_id"])
        if not p:
            raise Reject(403, "no-account")
        return s["user_id"], p


# --- routes ------------------------------------------------------------------


def health(app: App, req: Request) -> dict:
    return respond(200, {"ok": True})


SAMPLE_BIRTHDAY = date(1981, 6, 14)  # the design canvas's someone


def sample(app: App, req: Request) -> dict:
    """A version number today: the front page's example, or (with
    ?birthday= and ?tz=) the one sign-up shows as a birthday is typed.
    The arithmetic stays in version.py, not in the page."""
    tz = req.query.get("tz") or "America/Chicago"
    if not places.valid_tz(tz):
        raise Reject(400, "tz")
    today = datetime.fromtimestamp(app.now, ZoneInfo(tz)).date()
    birthday = SAMPLE_BIRTHDAY
    if "birthday" in req.query:
        try:
            birthday = date.fromisoformat(req.query["birthday"])
        except ValueError:
            raise Reject(400, "birthday") from None
        if not date(1900, 1, 1) <= birthday <= today:
            raise Reject(400, "birthday")
    v = compute_version(birthday, today)
    # The front page explains the number: the age it spells, and when the
    # next minor release ships.
    nxt = anniversary(birthday.year + v.age + 1, birthday.month, birthday.day)
    return respond(200, {
        "birthday": birthday.isoformat(),
        "version": str(v),
        "age": v.age,
        "next": {"version": f"{(v.age + 1) // 10}.{(v.age + 1) % 10}.0", "date": nxt.isoformat(), "days": v.days_until},
    })


def mail_limits(email: str, viewer: str | None = None) -> list[tuple[str, str, int]]:
    """The hourly limits one more email to an address meets, narrowest
    first: the address (without its +tag), the network (an IPv6 address's
    /64, then its /48) and the total."""
    checks = [("address", "email:" + auth.digest(auth.limit_address(email)), auth.LIMIT_PER_ADDRESS)]
    if viewer is not None:
        net = auth.network(viewer)
        checks.append(("network", "net:" + auth.digest(net), auth.LIMIT_PER_NETWORK))
        wide = auth.network(viewer, 48)
        if wide != net:  # IPv6 only: an IPv4 address is its own network
            checks.append(("network48", "net48:" + auth.digest(wide), auth.LIMIT_PER_NETWORK48))
    checks.append(("total", "all", auth.LIMIT_TOTAL))
    return checks


def over_limits(app: App, checks) -> None:
    """429 at the first (name, key, limit), narrowest first, that has had
    its hour's emails; otherwise count this email against every one.

    The counts are read first and only added to for an email that goes, so
    a request refused for its own address or network adds nothing to the
    total, and one network cannot lock everyone out of signing in. Two
    requests at once can both read a count just under its limit and both
    go: an overshoot of at most the requests in flight (the API allows a
    burst of 20), which the limits can stand."""
    hour = app.now // 3600
    for name, key, limit in checks:
        if app.store.peek(key, hour) >= limit:
            log(event="mail-limited", limit=name)
            raise Reject(429, "limited")
    for _, key, _ in checks:
        app.store.count(key, hour)


def send_mail(app: App, email: str, msg) -> None:
    from_addr = os.environ["FROM_ADDRESS"]
    try:
        app.ses.send_email(
            FromEmailAddress=from_header(from_addr),
            Destination={"ToAddresses": [email]},
            Content={"Raw": {"Data": msg.as_bytes()}},
            ConfigurationSetName=os.environ["CONFIG_SET"],
            EmailTags=[{"Name": MAIL_TAG, "Value": "account"}],
        )
    except Exception as e:
        code_name = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
        log(event="mail-failed", error=type(e).__name__, code=code_name)
        raise Reject(502, "mail-failed") from None


def new_login(app: App, email: str, purpose: str = auth.SIGNIN) -> tuple[str, str]:
    """A fresh link token and code for an address, for signing in or for
    confirming a deletion; the newest of each is the one a code is checked
    against. A deletion's token is never sent."""
    token, code = auth.new_token(), auth.new_code()
    app.store.put_login(auth.digest(token), email, auth.digest(email), auth.digest(code), app.now, auth.LOGIN_TTL,
                        purpose)
    return token, code


def auth_start(app: App, req: Request) -> dict:
    email = auth.normal_email(req.json().get("email"))
    if not email:
        raise Reject(400, "email")
    over_limits(app, mail_limits(email, req.viewer()))
    token, code = new_login(app, email)
    from_addr = os.environ["FROM_ADDRESS"]
    send_mail(app, email, auth.signin_message(to=email, from_addr=from_addr, link=f"{app.origin}/signin/#t={token}", code=code))
    log(event="signin-sent")
    return respond(202, {"ok": True})


CODE_ERRORS = {"gone": "code-expired", "used": "code-used", "attempts": "too-many-tries"}


def check_code(app: App, email: str, code: str, purpose: str = auth.SIGNIN) -> dict:
    """Spend one of the code attempts of the address's newest sign-in for
    this purpose, then compare; a match uses the sign-in up."""
    token_hash = app.store.newest_login(auth.digest(email), purpose)
    if not token_hash:
        raise Reject(400, "code-expired")
    wrong, day = "codefail:" + auth.digest(email), app.now // 86400
    if app.store.peek(wrong, day) >= auth.MAX_WRONG_CODES_A_DAY:
        log(event="code-limited")
        raise Reject(429, "limited")
    spent = app.store.spend_attempt(token_hash, app.now, auth.MAX_CODE_ATTEMPTS, purpose)
    if isinstance(spent, str):
        raise Reject(400, CODE_ERRORS[spent])
    if not auth.same(auth.digest(code), spent["code_hash"]):
        app.store.count(wrong, day, 86400)
        left = auth.MAX_CODE_ATTEMPTS - int(spent["attempts"])
        raise Reject(400, "wrong-code" if left else "too-many-tries", tries_left=left)
    login = app.store.burn_login(token_hash, app.now, purpose)
    if not login:
        raise Reject(400, "code-used")
    return login


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
        login = check_code(app, email, code)
        how = "code"

    email = login["email"]
    user_id = app.store.user_for_email(email)
    session = auth.new_token()
    app.store.put_session(
        auth.digest(session),
        user_id=user_id,
        email=None if user_id else email,
        now=app.now,
        expires=auth.session_expiry(app.now),
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


def profile_view(p: dict, now: int) -> dict:
    today = datetime.fromtimestamp(now, ZoneInfo(p["tz"])).date()
    view = {
        "new": False,
        "email": p["email"],
        "birthday": p["birthday"],
        "tz": p["tz"],
        "send_time": p.get("send_time", "06:00"),
        "status": p.get("status", "active"),
        "transcribe": bool(p.get("transcribe")),
        "describe": bool(p.get("describe")),
        "today": today.isoformat(),
        "version": str(compute_version(date.fromisoformat(p["birthday"]), today)),
    }
    for k in ("city", "region", "country", "stopped_reason"):
        if p.get(k):
            view[k] = p[k]
    if p.get("pause_through", "") >= today.isoformat() and p.get("pause_from"):
        view["pause"] = {"from": p["pause_from"], "through": p["pause_through"]}
    view["pause_starts"] = pause_start(p, today).isoformat()
    return view


def pause_start(p: dict, today: date) -> date:
    """The first day a new pause would hold back: today, unless today's
    email has gone already."""
    return today + ONE_DAY if p.get("last_sent_date", "") >= today.isoformat() else today


def me(app: App, req: Request) -> dict:
    s = app.signed_in(req)
    if "user_id" not in s:
        return respond(200, {"new": True, "email": s["email"]})
    p = app.store.profile(s["user_id"])
    if not p:
        raise Reject(403, "no-account")
    return respond(200, profile_view(p, app.now))


_SEND_TIME = re.compile(r"([01][0-9]|2[0-3]):(00|15|30|45)")


def send_time_from(body: dict) -> str:
    v = body.get("send_time")
    if not isinstance(v, str) or not _SEND_TIME.fullmatch(v):
        raise Reject(400, "send-time")
    return v


def place_fields(body: dict) -> dict:
    place = places.clean(body.get("place"))
    if not place:
        raise Reject(400, "place")
    return {
        "tz": place["tz"],
        "city": place["name"],
        "region": place["region"],
        "country": place["country"],
        "lat": Decimal(str(place["lat"])),
        "lon": Decimal(str(place["lon"])),
    }


def iso(now: int) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def update_me(app: App, req: Request) -> dict:
    s = app.signed_in(req)
    body = req.json()
    if "user_id" not in s:
        return sign_up(app, s, body)
    user_id = s["user_id"]
    p = app.store.profile(user_id)
    if not p:
        raise Reject(403, "no-account")
    if "birthday" in body and body["birthday"] != p["birthday"]:
        # Changing it would renumber every day already kept.
        raise Reject(400, "birthday-locked")
    fields = {}
    if "send_time" in body:
        fields["send_time"] = send_time_from(body)
    if "place" in body:
        fields.update(place_fields(body))
    if "transcribe" in body:
        # Turning it on writes out every recording already kept (transcribe.py).
        if not isinstance(body["transcribe"], bool):
            raise Reject(400, "transcribe")
        fields["transcribe"] = body["transcribe"]
    if "describe" in body:
        # Turning it on describes every photo already kept (describe.py).
        if not isinstance(body["describe"], bool):
            raise Reject(400, "describe")
        fields["describe"] = body["describe"]
    if "status" in body:
        if body["status"] != "active":
            raise Reject(400, "status")
        fields.update(status="active", restarted_at=iso(app.now))
        if p.get("status") == "stopped":
            if p.get("stopped_reason") in ("bounce", "complaint"):
                unsuppress(app, user_id, p["email"])
            tally(app, "restarts")
    if not fields:
        raise Reject(400, "nothing-to-change")
    remove = ("stopped_reason", "stopped_at") if "status" in fields else ()
    app.store.update_profile(user_id, fields, remove)
    log(event="settings", user=user_id, changed=sorted(k for k in fields if k in ("send_time", "tz", "status", "transcribe", "describe")))
    p = {k: v for k, v in {**p, **fields}.items() if k not in remove}
    return respond(200, profile_view(p, app.now))


def unsuppress(app: App, user_id: str, email: str) -> None:
    """A hard bounce or a complaint put the address on SES's account-level
    suppression list, which would drop every email to it, the daily one
    and sign-in alike, and report each as a new bounce that stops them
    again. Starting again is the person asking for the emails, so take the
    address off the list."""
    try:
        app.ses.delete_suppressed_destination(EmailAddress=email)
        log(event="unsuppressed", user=user_id)
    except Exception as e:
        code = getattr(e, "response", {}).get("Error", {}).get("Code")
        if code != "NotFoundException":
            log(event="unsuppress-failed", user=user_id, code=code)
            raise Reject(502, "restart-failed") from None


def tally(app: App, name: str) -> None:
    """Count it for the month, with no one named (scripts/tally.py reads
    them). A count is never worth a failed request."""
    try:
        app.store.tally(datetime.fromtimestamp(app.now, timezone.utc).strftime("%Y-%m"), name)
    except Exception:
        log(event="tally-failed", name=name)


def sign_up(app: App, s: dict, body: dict) -> dict:
    fields = place_fields(body)
    send_time = send_time_from(body)
    local = datetime.fromtimestamp(app.now, ZoneInfo(fields["tz"]))
    try:
        birthday = date.fromisoformat(body.get("birthday") or "")
    except (TypeError, ValueError):
        raise Reject(400, "birthday") from None
    if not date(1900, 1, 1) <= birthday <= local.date():
        raise Reject(400, "birthday")
    profile = {
        "birthday": birthday.isoformat(),
        "send_time": send_time,
        "status": "active",
        "created_at": iso(app.now),
        **fields,
    }
    email = s["email"]
    user_id = uuid.uuid4().hex
    if not app.store.create_subscriber(user_id, email, profile):
        # Signed up in another tab a moment ago: this session joins it.
        user_id = app.store.user_for_email(email)
        if not user_id:
            raise Reject(409, "try-again")
        profile = app.store.profile(user_id) or {}
    else:
        send_first(app, user_id)
        tally(app, "signups")
    app.store.claim_session(s["hash"], user_id, int(s["expires_at"]))
    log(event="signup", user=user_id)
    return respond(200, profile_view({"email": email, **profile}, app.now))


def send_first(app: App, user_id: str) -> None:
    """Today's email, straight away, so the first one arrives while the
    person is still here (Jamie, 2026-10-08). The sender marks the day
    sent, so the schedule's first is tomorrow's. If the invoke fails, the
    schedule still sends today's when the send time is ahead or under
    three hours past; sign-up never fails over it."""
    try:
        app.lam.invoke(FunctionName=os.environ["SENDER_FUNCTION"], InvocationType="Event",
                       Payload=json.dumps({"send_now": user_id}).encode())
    except Exception:
        log(event="first-email-failed", user=user_id)


def find_places(app: App, req: Request) -> dict:
    app.signed_in(req)
    q = (req.query.get("q") or "").strip()
    if not 2 <= len(q) <= 80:
        raise Reject(400, "query")
    try:
        found = app.geocode(q)
    except Exception as e:
        log(event="places-failed", error=type(e).__name__)
        raise Reject(502, "places-failed") from None
    return respond(200, {"places": found})


_REPLY_TOKEN = re.compile(r"[a-z2-7]{24}")


def unsubscribe(app: App, req: Request) -> dict:
    """The daily email's List-Unsubscribe. A mail app POSTs it (RFC 8058,
    one click, no cookie, no Origin); a person who opens it gets a page
    with a button. The token is that day's reply token: whoever holds the
    email can stop it, which is what unsubscribe links are."""
    token = req.query.get("t", "")
    if not _REPLY_TOKEN.fullmatch(token):
        raise Reject(400, "token")
    if req.method == "GET":
        return respond(302, {}, headers={"location": f"/unsubscribe/#t={token}"})
    found = app.store.get_token(token)
    if not found:
        raise Reject(404, "token")
    p = app.store.profile(found["user_id"])
    if not p:
        raise Reject(404, "token")
    if p.get("status") != "stopped":
        app.store.stop(found["user_id"], "unsubscribed", iso(app.now))
        tally(app, "unsubscribes")
    log(event="unsubscribe", user=found["user_id"])
    return respond(200, {"ok": True})


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


# The zip, with every photo and recording, is built in the background
# (export_job.py): start it, ask how it is going, then fetch it.

ZIP_LINK = 300  # seconds the zip's signed link lasts


def zip_view(item: dict | None, now: int) -> dict:
    """none, building, ready (with size, files and until) or failed. A build
    that has run past the function's limit failed, whatever it says."""
    if not item or int(item.get("expires_at", 0)) <= now:
        return {"status": "none"}
    status = item.get("status")
    if status == "building" and now - int(item["started_at"]) > export_job.BUILDING_FOR:
        status = "failed"
    if status == "ready":
        return {"status": "ready", "size": int(item["size"]), "files": int(item.get("files", 0)),
                "built_at": iso(int(item["finished_at"])), "until": iso(int(item["expires_at"]))}
    return {"status": status}


def export_zip(app: App, req: Request) -> dict:
    user_id, _ = app.account(req)
    return respond(200, zip_view(app.store.export(user_id), app.now))


def export_zip_start(app: App, req: Request) -> dict:
    """Start a build, or answer with the one already going."""
    user_id, _ = app.account(req)
    found = app.store.export(user_id)
    if zip_view(found, app.now)["status"] == "building":
        return respond(202, {"status": "building"})
    if found and found.get("export_key"):
        app.s3.delete_object(Bucket=os.environ["MAIL_BUCKET"], Key=found["export_key"])  # only the newest is kept
    export_id = uuid.uuid4().hex
    app.store.start_export(user_id, export_id, app.now, app.now + export_job.READY_FOR)
    try:
        app.lam.invoke(FunctionName=os.environ["EXPORT_FUNCTION"], InvocationType="Event",
                       Payload=json.dumps({"user_id": user_id, "id": export_id}).encode())
    except Exception:
        app.store.finish_export(user_id, export_id, {"status": "failed", "finished_at": app.now})
        log(event="export-start-failed", user=user_id)
        raise Reject(502, "export-failed") from None
    log(event="export-started", user=user_id)
    return respond(202, {"status": "building"})


def export_zip_file(app: App, req: Request) -> dict:
    """The built zip: a redirect to a link that lasts five minutes."""
    user_id, _ = app.account(req)
    found = app.store.export(user_id)
    if zip_view(found, app.now)["status"] != "ready":
        raise Reject(404, "export")
    name = f"release-notes-{datetime.fromtimestamp(int(found['finished_at']), timezone.utc):%Y-%m-%d}.zip"
    url = app.s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": os.environ["MAIL_BUCKET"], "Key": found["export_key"], "ResponseContentType": "application/zip",
                "ResponseContentDisposition": f'attachment; filename="{name}"'},
        ExpiresIn=ZIP_LINK,
    )
    log(event="export-download", user=user_id)
    return respond(302, {}, headers={"location": url})


# --- notes --------------------------------------------------------------------
# A note is filed under its day (store.py). The web writes its own,
# NOTE#<day>#w-<id> with source=web, for today or any day back to the
# birthday; an emailed note can be edited or deleted the same way, and
# deleting one deletes the email it came in.

DAYS_PAGE, DAYS_MAX = 30, 100


def local_today(p: dict, now: int) -> date:
    return datetime.fromtimestamp(now, ZoneInfo(p["tz"])).date()


def day_from(p: dict, value: str, now: int) -> date:
    """A day this subscriber can have notes for: birthday to today."""
    try:
        day = date.fromisoformat(value)
    except ValueError:
        raise Reject(400, "date") from None
    if not date.fromisoformat(p["birthday"]) <= day <= local_today(p, now):
        raise Reject(400, "date")
    return day


def text_from(body: dict, empty_ok: bool = False) -> str:
    """The note's text. It may be empty only for a note with files."""
    text = body.get("text", "" if empty_ok else None)
    if not isinstance(text, str):
        raise Reject(400, "text")
    text = text.replace("\r\n", "\n").strip()
    if not text and not empty_ok:
        raise Reject(400, "text")
    if len(text) > MAX_NOTE:
        raise Reject(400, "too-long")
    return text


# What an import's `origin.app` is called on the page.
APPS = {"dayone": "Day One"}


def note_view(item: dict, tz: str, writing_out: bool = False, link=None) -> dict:
    """One note for the page. Its time reads in the zone it was written in
    (`tz` on the note), the subscriber's for notes without one. With
    `writing_out` (the subscriber has transcripts on), a recording still
    waiting for its text says so. With `link` (App.media_links), each file
    carries its signed link, so the page loads it without a call here."""
    _, day, note_id = item["sk"].split("#", 2)
    at = written_at(item)
    zone = item["tz"] if places.valid_tz(item.get("tz")) else tz
    view = {"id": note_id, "source": item.get("source", "email"), "text": item.get("text", ""), "at": at, "tz": zone}
    # The text as shown: strings, links by name (links.segments) and tags.
    view["parts"] = tags.split(links.segments(view["text"], item.get("links")))
    if item.get("tags"):
        view["tags"] = list(item["tags"])
    if item.get("place") and (label := place_label(item["place"])):
        view["place"] = label
        if url := map_url(item["place"]):
            view["map"] = url
    if item.get("origin"):
        view["from"] = APPS.get(item["origin"].get("app"), "an import")
    if item.get("updated_at"):
        view["edited_at"] = item["updated_at"]
    if item.get("media"):
        # Each file by number, with its signed link when `link` gives one.
        view["media"] = [{"n": int(m["n"]), "kind": m["kind"], "type": m["type"], **({"name": m["name"]} if m.get("name") else {})}
                         for m in item["media"]]
        for shown, m in zip(view["media"], item["media"]):
            if link and (url := link(m.get("key"), m["type"])):
                shown["url"] = url
            if m.get("transcript"):
                shown["transcript"] = m["transcript"]
            if m.get("description"):
                # The photo's alt text, and shown in search results when it
                # matched (Jamie: "descriptions only on search results").
                shown["description"] = m["description"]
        if writing_out:
            for shown in view["media"]:
                shown["writing"] = any(shown["n"] == int(m["n"]) for m in transcribe.waiting(item))
    if others := media.others(item):
        view["attachments"] = others
    try:
        # Written after its day was over, where it was written: "added later".
        local = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(ZoneInfo(zone)).date()
        view["late"] = local.isoformat() > day
    except ValueError:
        pass
    return view


def writes_out(p: dict) -> bool:
    return bool(p.get("transcribe"))


def day_view(p: dict, day: str, notes: list[dict], sky: dict | None = None, link=None) -> dict:
    v = compute_version(date.fromisoformat(p["birthday"]), date.fromisoformat(day))
    view = {"date": day, "version": str(v), "notes": [note_view(n, p["tz"], writes_out(p), link) for n in notes]}
    if sky:
        # As words, in the subscriber's units: "Partly cloudy, 61° / 44° in Minneapolis".
        view["weather"] = weather.day_line(sky, weather.fahrenheit(weather.place_of(p) or sky))
    return view


def today(app: App, req: Request) -> dict:
    """Today's page: the number, the year so far, today's notes, the streak."""
    user_id, p = app.account(req)
    day = local_today(p, app.now)
    v = compute_version(date.fromisoformat(p["birthday"]), day)
    have = app.store.note_days(user_id)
    paused = pause_days(app.store.pauses(user_id), day)
    # Today counts once it has a note; until then the run ends yesterday.
    s = compute_streak(have, day + ONE_DAY if day in have else day, paused)
    view = day_view(p, day.isoformat(), app.store.notes_between(user_id, day.isoformat(), day.isoformat()),
                    link=app.media_links(user_id))
    view.update(
        tz=p["tz"],
        dots=round(v.patch / v.cycle_days * DOTS),
        next={"version": next_release(v), "date": (day + timedelta(days=v.days_until)).isoformat()},
        streak={"current": s.current, "longest": s.longest, "today": day in have},
    )
    if day in paused:
        view["paused_through"] = p.get("pause_through")
    return respond(200, view)


def days(app: App, req: Request) -> dict:
    """The timeline, newest first: every day with an email, a note or a
    pause, and today. ?before= pages back from a day."""
    user_id, p = app.account(req)
    day = local_today(p, app.now).isoformat()
    try:
        limit = min(max(int(req.query.get("limit") or DAYS_PAGE), 1), DAYS_MAX)
    except ValueError:
        raise Reject(400, "limit") from None
    before = req.query.get("before")
    if before is not None:
        before = day_from(p, before, app.now).isoformat()
    paused = {d.isoformat() for d in pause_days(app.store.pauses(user_id), local_today(p, app.now))}
    dated = app.store.sent_days(user_id) | {d.isoformat() for d in app.store.note_days(user_id)} | paused
    if before is None:
        dated.add(day)
    picked = sorted((d for d in dated if p["birthday"] <= d <= day and (before is None or d < before)), reverse=True)
    page = picked[:limit]
    by_day: dict[str, list[dict]] = {d: [] for d in page}
    skies: dict[str, dict] = {}
    if page:
        for n in app.store.notes_between(user_id, page[-1], page[0]):
            by_day.setdefault(n["sk"].split("#")[1], []).append(n)
        skies = app.store.weather_between(user_id, page[-1], page[0])
    return respond(
        200,
        {
            "today": day,
            "tz": p["tz"],
            "days": [{**day_view(p, d, by_day[d], skies.get(d), app.media_links(user_id)), **({"paused": True} if d in paused else {})} for d in page],
            "before": page[-1] if len(picked) > limit else None,
        },
    )


def one_day(app: App, req: Request, value: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    view = day_view(p, day, app.store.notes_between(user_id, day, day), app.store.weather_between(user_id, day, day).get(day),
                    app.media_links(user_id))
    view.update(tz=p["tz"], today=day == local_today(p, app.now).isoformat())
    return respond(200, view)


def add_note(app: App, req: Request, value: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now)
    body = req.json()
    uploads = body.get("uploads")
    text = text_from(body, empty_ok=bool(uploads))
    # Its files first: one that is not there or not what it says stops the note.
    files = attach(app, user_id, uploads) if uploads else []
    note_id = "w-" + uuid.uuid4().hex[:20]
    item = {
        "version": str(compute_version(date.fromisoformat(p["birthday"]), day)),
        "text": text,
        "source": "web",
        "written_at": iso(app.now),
        # The browser's zone, where the note is being written.
        "tz": body["tz"] if places.valid_tz(body.get("tz")) else p["tz"],
    }
    found = links.collect(text, fetch=app.fetch)
    if found:
        item["links"] = found
    if tagged := tags.found(text):
        item["tags"] = tagged
    if files:
        item["media"] = [{"n": n, **f} for n, f in enumerate(files, 1)]
    app.store.put_note(user_id, day.isoformat(), note_id, item)
    log(event="note-added", user=user_id, date=day.isoformat(), files=len(files))
    keep_weather(app, user_id, p, day)
    view = note_view({"sk": f"NOTE#{day.isoformat()}#{note_id}", **item}, p["tz"], writes_out(p), app.media_links(user_id))
    return respond(201, view)


def keep_weather(app: App, user_id: str, p: dict, day: date) -> None:
    """A day filled in later gets its weather from history, once, where the
    subscriber is now. Today's is kept by tomorrow's email. Never fails the
    note."""
    place = weather.place_of(p)
    if not place or day >= local_today(p, app.now):
        return
    try:
        if app.store.weather_between(user_id, day.isoformat(), day.isoformat()):
            return
        found = weather.history(place, day, local_today(p, app.now), app.weather_fetch)
        if found:
            app.store.put_weather(user_id, day.isoformat(), weather.record(found, place, iso(app.now)))
    except Exception as e:
        log(event="weather-error", user=user_id, date=day.isoformat(), error=type(e).__name__)


def edit_note(app: App, req: Request, value: str, note_id: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    body = req.json()
    old = next((n for n in app.store.notes_between(user_id, day, day) if n["sk"].split("#", 2)[2] == note_id), None)
    if not old:
        raise Reject(404, "note")
    text = text_from(body, empty_ok=bool(old.get("media")))
    # Links the note had keep their names; only a new address is fetched.
    found = links.collect(text, keep=old.get("links"), fetch=app.fetch)
    item = app.store.update_note(user_id, day, note_id, text, iso(app.now), found, tags.found(text))
    if not item:
        raise Reject(404, "note")
    log(event="note-edited", user=user_id, date=day)
    return respond(200, note_view(item, p["tz"], writes_out(p), app.media_links(user_id)))


def delete_note(app: App, req: Request, value: str, note_id: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    note = next((n for n in app.store.notes_between(user_id, day, day) if n["sk"].split("#", 2)[2] == note_id), None)
    if not note:
        raise Reject(404, "note")
    raw = note.get("raw_key", "")
    # The email and its files go first, so a failure leaves the note to try
    # again. The bucket is versioned: old versions expire 30 days later.
    for key in ([raw] if raw.startswith("raw/") else []) + media.keys(note):
        app.s3.delete_object(Bucket=os.environ["MAIL_BUCKET"], Key=key)
    app.store.delete_note(user_id, day, note_id)
    log(event="note-deleted", user=user_id, date=day, source=note.get("source", "email"))
    return respond(200, {"ok": True})


MEDIA_LINK = 600  # seconds a photo's link lasts, at least, once handed out
# A warm function hands out the same link for this long, so a photo seen
# again soon is the browser's cached copy, not another download. Each link
# is signed for MEDIA_LINK + LINK_REUSE.
LINK_REUSE = 300
_links: dict[str, tuple[str, int]] = {}  # key -> (link, signed at); warm invocations only

# --- files from the web -------------------------------------------------------
# media.py has the design: the browser sends each file straight to the bucket
# with a form signed here (the API takes a few megabytes at most), then a
# note takes it: a new one (add_note) or one already there (add_files).

# Seconds a signed upload form lasts. The page asks for each file's form just
# before sending that file, so a form need only outlast one file: 50 MB, the
# most one can be, takes about 200 seconds over a slow phone connection
# (2 Mbit/s up). Shorter than it was (900) so a form is no use for long after.
UPLOAD_FORM = 300
# What one subscriber may ask to send in a UTC day, counted as each form is
# signed, by the size it is signed for: far past what one person adds to their
# notes in a day (a holiday's photos, a long recording), and a ceiling on what
# an open sign-up lets anyone store at the bucket's expense.
UPLOADS_A_DAY = 200
UPLOAD_BYTES_A_DAY = 2 * 1024 ** 3  # 2 GB
PENDING = "<Tagging><TagSet><Tag><Key>outcome</Key><Value>pending</Value></Tag></TagSet></Tagging>"
UPLOAD_ID = re.compile(r"[0-9a-f]{32}")


def start_upload(app: App, req: Request) -> dict:
    """A form for one file, of the type and exact size the page says, to a
    key of its own. Nothing joins a note until attach() has checked it.
    Past the day's ceilings (UPLOADS_A_DAY, UPLOAD_BYTES_A_DAY), 429
    `upload-limit` and no form."""
    user_id, _ = app.account(req)
    body = req.json()
    name, ctype = body.get("name"), body.get("type")
    ctype = media.upload_type(ctype if isinstance(ctype, str) else "", name if isinstance(name, str) else "")
    if not ctype:
        raise Reject(400, "file-type")
    size = body.get("size")
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise Reject(400, "file-size")
    if size > media.MAX_UPLOAD:
        raise Reject(400, "file-too-big")
    if not app.store.count_upload(user_id, app.now // 86400, size, UPLOADS_A_DAY, UPLOAD_BYTES_A_DAY):
        log(event="upload-limited", user=user_id)
        raise Reject(429, "upload-limit")
    upload_id = uuid.uuid4().hex
    form = app.s3.generate_presigned_post(
        Bucket=os.environ["MAIL_BUCKET"], Key=media.upload_key(user_id, upload_id, ctype),
        Fields={"Content-Type": ctype, "tagging": PENDING},
        Conditions=[{"Content-Type": ctype}, {"tagging": PENDING}, ["content-length-range", size, size]],
        ExpiresIn=UPLOAD_FORM,
    )
    log(event="upload-started", user=user_id, kind=media.kind(ctype), size=size)
    return respond(200, {"upload": upload_id, "type": ctype, "url": form["url"], "fields": form["fields"]})


def _missing(e: Exception) -> bool:
    code = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
    return code in ("NoSuchKey", "404", "NotFound")


def file_name(value) -> str:
    """The name the file had on the writer's device, without its folders."""
    if not isinstance(value, str):
        return ""
    name = re.split(r"[\\/]", value)[-1]
    return "".join(c for c in name if c.isprintable()).strip()[:120]


def attach(app: App, user_id: str, uploads) -> list[dict]:
    """Note entries (without `n`) for files sent with start_upload's forms.
    Each must be there, still pending (on no note yet), of the type it was
    signed for, and start like one; any that is not stops them all. Then
    the version checked (by its VersionId, so bytes the form sent since
    are not it) is copied to a key of its own that no form can write
    (media.kept_key), tagged as kept, which keeps it out of the bucket's
    expiry, and the pending version is deleted."""
    if (not isinstance(uploads, list) or not uploads or len(uploads) > media.MAX_FILES
            or not all(isinstance(u, dict) for u in uploads)
            or len({u.get("upload") for u in uploads}) != len(uploads)):
        raise Reject(400, "upload")
    bucket = os.environ["MAIL_BUCKET"]
    entries, checked = [], []
    for u in uploads:
        upload_id, ctype = u.get("upload"), u.get("type")
        if not isinstance(upload_id, str) or not UPLOAD_ID.fullmatch(upload_id) or ctype not in media.UPLOADABLE:
            raise Reject(400, "upload")
        key = media.upload_key(user_id, upload_id, ctype)
        try:
            tagged = {t["Key"]: t["Value"] for t in app.s3.get_object_tagging(Bucket=bucket, Key=key)["TagSet"]}
            got = app.s3.get_object(Bucket=bucket, Key=key, Range=f"bytes=0-{media.HEAD - 1}")
            head = got["Body"].read()
        except Exception as e:
            if _missing(e):
                raise Reject(400, "upload") from None
            raise
        if tagged.get("outcome") != "pending" or got.get("ContentType") != ctype or not media.looks_like(ctype, head):
            raise Reject(400, "upload")
        total = str(got.get("ContentRange") or "").rpartition("/")[2]
        entry = {"kind": media.kind(ctype), "type": ctype, "size": int(total) if total.isdigit() else len(head),
                 "key": media.kept_key(user_id, uuid.uuid4().hex, ctype)}
        if name := file_name(u.get("name")):
            entry["name"] = name
        if ctype in media.IMAGES and (wh := media.image_size(head)):
            entry["width"], entry["height"] = wh
        entries.append(entry)
        checked.append((key, got["VersionId"]))  # the bucket is versioned: this is the version read
    for e, (key, version) in zip(entries, checked):
        app.s3.copy_object(Bucket=bucket, Key=e["key"], CopySource={"Bucket": bucket, "Key": key, "VersionId": version},
                           MetadataDirective="COPY", TaggingDirective="REPLACE", Tagging="outcome=note")
    # That version for good, so the bucket keeps no second copy for 30 days;
    # anything the form sent since stays pending and expires.
    for key, version in checked:
        app.s3.delete_object(Bucket=bucket, Key=key, VersionId=version)
    return entries


def add_files(app: App, req: Request, value: str, note_id: str) -> dict:
    """Files for a note already there, after the ones it has."""
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    uploads = req.json().get("uploads")

    def note():
        found = next((n for n in app.store.notes_between(user_id, day, day) if n["sk"].split("#", 2)[2] == note_id), None)
        if not found:
            raise Reject(404, "note")
        return list(found.get("media") or [])

    had = note()
    if isinstance(uploads, list) and len(had) + len(uploads) > media.MAX_FILES:
        raise Reject(400, "too-many-files")
    files = attach(app, user_id, uploads)
    for _ in range(3):  # another page adding at the same moment takes the numbers first
        first = max((int(m["n"]) for m in had), default=0) + 1
        item = app.store.add_media(user_id, day, note_id, [{"n": first + i, **f} for i, f in enumerate(files)],
                                   len(had), iso(app.now))
        if item:
            log(event="files-added", user=user_id, date=day, files=len(files))
            return respond(200, note_view(item, p["tz"], writes_out(p), app.media_links(user_id)))
        had = note()
    raise Reject(409, "busy")


def media_file(app: App, req: Request, value: str, note_id: str, n: str) -> dict:
    """A photo or recording, for its owner only: a redirect to a link to the
    file that lasts ten minutes. The browser may reuse the redirect for five."""
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    note = next((x for x in app.store.notes_between(user_id, day, day) if x["sk"].split("#", 2)[2] == note_id), None)
    entry = next((m for m in (note or {}).get("media") or [] if int(m["n"]) == int(n)), None)
    if not entry or not str(entry.get("key", "")).startswith(f"media/{user_id}/"):
        raise Reject(404, "media")
    url = app.media_links(user_id)(entry["key"], entry["type"])
    return respond(302, {}, headers={"location": url, "cache-control": "private, max-age=300"})


# --- tags ---------------------------------------------------------------------
# A note's tags are its hashtags (tags.py). One person's notes are few enough
# to read whole, so there is no index: both answers read every note's keys
# and tags. The list brings back only those (Store.note_tags); a tag's page,
# only the notes with it (Store.tagged_notes).


def tag_list(app: App, req: Request) -> dict:
    """Every tag, most used first: notes, days, and the first and last day."""
    user_id, _ = app.account(req)
    seen: dict[str, dict] = {}
    for n in app.store.note_tags(user_id):
        day = n["sk"].split("#")[1]
        for t in n.get("tags") or []:
            e = seen.setdefault(t, {"tag": t, "notes": 0, "days": set(), "first": day, "last": day})
            e["notes"] += 1
            e["days"].add(day)
            e["first"], e["last"] = min(e["first"], day), max(e["last"], day)
    out = [{**e, "days": len(e["days"])} for e in seen.values()]
    out.sort(key=lambda e: (-e["notes"], e["tag"]))
    return respond(200, {"tags": out})


def tagged_days(app: App, req: Request, tag: str) -> dict:
    """Every day with a note tagged so, newest first, with those notes."""
    user_id, p = app.account(req)
    by_day: dict[str, list[dict]] = {}
    for n in app.store.tagged_notes(user_id, tag):
        if tag in (n.get("tags") or []):
            by_day.setdefault(n["sk"].split("#")[1], []).append(n)
    return respond(200, {
        "tag": tag,
        "today": local_today(p, app.now).isoformat(),
        "tz": p["tz"],
        "days": [day_view(p, d, by_day[d], link=app.media_links(user_id)) for d in sorted(by_day, reverse=True)],
    })


# --- search -------------------------------------------------------------------
# Jamie, 2026-10-09: a Search page "to pull posts by tag, showing all tags
# that have been used, as well as search by string across notes". The tags
# are tag_list's; this is the words. Like the tags, it reads every note:
# one person's notes are few enough. The words come in a POST body and are
# never logged, since they are as private as the notes (the page keeps them
# in the address's #, which no server sees).

MAX_QUERY = 200
SEARCH_DAYS = 100  # days of results shown, newest first


def fold(text: str) -> str:
    """Text as search compares it: no case, no accents ("Café" is "cafe")."""
    return "".join(c for c in unicodedata.normalize("NFKD", text.casefold()) if not unicodedata.combining(c))


def search_terms(q: str) -> list[str]:
    """Words, or "a phrase" in quotes, every one of which a note must have."""
    found = [fold(a or b.strip('"')).strip() for a, b in re.findall(r'"([^"]*)"|(\S+)', q)]
    return [t for t in found if t][:10]


def searched_text(n: dict) -> str:
    """What a note is found by: its text, its place's name, its links'
    names, its recordings' words and its photos' descriptions."""
    words = [n.get("text") or ""] + [str(m.get(k) or "") for m in n.get("media") or []
                                     for k in ("transcript", "description")]
    if n.get("place"):
        words.append(place_label(n["place"]))
    words += [str(link.get("title") or "") for link in n.get("links") or []]
    return fold("\n".join(words))


def search(app: App, req: Request) -> dict:
    """The notes with every term, by day, newest first: the newest
    SEARCH_DAYS days, with how many notes and days matched in all."""
    user_id, p = app.account(req)
    q = req.json().get("q")
    if not isinstance(q, str) or not q.strip():
        raise Reject(400, "query")
    if len(q) > MAX_QUERY:
        raise Reject(400, "query-too-long")
    terms = search_terms(q)
    if not terms:
        raise Reject(400, "query")
    by_day: dict[str, list[dict]] = {}
    for n in app.store.all_notes(user_id):
        text = searched_text(n)
        if all(t in text for t in terms):
            by_day.setdefault(n["sk"].split("#")[1], []).append(n)
    days = sorted(by_day, reverse=True)
    log(event="search", user=user_id, terms=len(terms), days=len(days))
    return respond(200, {
        "terms": terms,
        "today": local_today(p, app.now).isoformat(),
        "tz": p["tz"],
        "notes": sum(len(v) for v in by_day.values()),
        "day_count": len(days),
        "days": [day_view(p, d, sorted(by_day[d], key=written_at), link=app.media_links(user_id)) for d in days[:SEARCH_DAYS]],
    })


# --- pause --------------------------------------------------------------------

MAX_PAUSE = 60


def pause(app: App, req: Request) -> dict:
    """Pause for {days: 1-60} or {through: date}. A pause already running
    keeps its start and takes the new end; one not started yet is replaced."""
    user_id, p = app.account(req)
    if p.get("status", "active") != "active":
        raise Reject(400, "stopped")
    body = req.json()
    today = local_today(p, app.now)
    start = pause_start(p, today)
    current = p.get("pause_from") if p.get("pause_through", "") >= today.isoformat() else None
    if current and current <= today.isoformat():
        start = date.fromisoformat(current)
    if "days" in body:
        n = body["days"]
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= MAX_PAUSE:
            raise Reject(400, "days")
        through = start + timedelta(days=n - 1)
    else:
        try:
            through = date.fromisoformat(body.get("through") or "")
        except (TypeError, ValueError):
            raise Reject(400, "through") from None
    if not max(start, today) <= through <= start + timedelta(days=MAX_PAUSE - 1):
        raise Reject(400, "through")
    if current and current != start.isoformat():
        app.store.end_pause(user_id, current, None)
    app.store.put_pause(user_id, start.isoformat(), through.isoformat(), iso(app.now))
    log(event="pause", user=user_id, days=(through - start).days + 1)
    return respond(200, profile_view({**p, "pause_from": start.isoformat(), "pause_through": through.isoformat()}, app.now))


def resume(app: App, req: Request) -> dict:
    """End the pause now. Days already paused stay paused (for the streak);
    a pause that has not begun is dropped."""
    user_id, p = app.account(req)
    today = local_today(p, app.now)
    start, through = p.get("pause_from"), p.get("pause_through")
    if start and through and through >= today.isoformat():
        ended = (today - ONE_DAY).isoformat()
        app.store.end_pause(user_id, start, ended if start <= ended else None)
        log(event="resume", user=user_id)
    p = {k: v for k, v in p.items() if k not in ("pause_from", "pause_through")}
    return respond(200, profile_view(p, app.now))


# --- delete the account -------------------------------------------------------


def delete_code(app: App, req: Request) -> dict:
    """Mail the account's own address a code that confirms deleting it. It
    confirms nothing else: it does not sign in, and a sign-in's code does
    not delete (auth.DELETE)."""
    user_id, p = app.account(req)
    email = p["email"]
    over_limits(app, mail_limits(email))
    _, code = new_login(app, email, auth.DELETE)
    send_mail(app, email, auth.delete_message(to=email, from_addr=os.environ["FROM_ADDRESS"], code=code))
    log(event="delete-code-sent", user=user_id)
    return respond(202, {"ok": True})


def sessions_of(items: list[dict]) -> list[dict]:
    """The keys of the sessions a subscriber's items list (USER#<id> /
    SESSION#<hash>, store.py)."""
    return [{"pk": i["sk"], "sk": "SESSION"} for i in items if i["sk"].startswith("SESSION#")]


def delete_me(app: App, req: Request) -> dict:
    """Delete everything: the original emails, the reply addresses, every
    item under the subscriber, the sessions those list (every browser
    signed in, not only this one), the address's newest sign-in and
    deletion code, the address, and the profile last, so a failure part way
    leaves an account that can try again."""
    s = app.subscriber(req)
    user_id = s["user_id"]
    p = app.store.profile(user_id)
    if not p:
        raise Reject(403, "no-account")
    code = auth.valid_code(req.json().get("code"))
    if not code:
        raise Reject(400, "email-and-code")
    check_code(app, p["email"], code, auth.DELETE)

    items = app.store.user_items(user_id)
    raw = [i["raw_key"] for i in items if str(i.get("raw_key", "")).startswith("raw/")]
    files = raw + [k for i in items for k in media.keys(i)]
    files += [i["export_key"] for i in items if str(i.get("export_key", "")).startswith("exports/")]
    for n in range(0, len(files), 1000):
        out = app.s3.delete_objects(
            Bucket=os.environ["MAIL_BUCKET"], Delete={"Objects": [{"Key": k} for k in files[n : n + 1000]], "Quiet": True}
        )
        if out.get("Errors"):
            log(event="delete-failed", user=user_id, step="mail", errors=len(out["Errors"]))
            raise Reject(502, "delete-failed")
    keys = [{"pk": f"TOKEN#{i['token']}", "sk": "TOKEN"} for i in items if i["sk"].startswith("DAY#") and i.get("token")]
    keys += sessions_of(items)
    keys += [{"pk": i["pk"], "sk": i["sk"]} for i in items if i["sk"] != "PROFILE"]
    keys += app.store.login_keys(auth.digest(p["email"]))
    keys.append({"pk": f"EMAIL#{p['email']}", "sk": "EMAIL"})
    app.store.delete_keys(keys)
    app.store.delete_keys([{"pk": f"USER#{user_id}", "sk": "PROFILE"}])
    # A send or a reply already past its checks may have written something
    # since the first read. With the profile gone, no new one gets that far.
    late = app.store.user_items(user_id)
    if late:
        late_files = [i["raw_key"] for i in late if str(i.get("raw_key", "")).startswith("raw/")]
        late_files += [k for i in late for k in media.keys(i)]
        if late_files:
            app.s3.delete_objects(Bucket=os.environ["MAIL_BUCKET"],
                                  Delete={"Objects": [{"Key": k} for k in late_files[:1000]], "Quiet": True})
        app.store.delete_keys([{"pk": f"TOKEN#{i['token']}", "sk": "TOKEN"} for i in late if i["sk"].startswith("DAY#") and i.get("token")]
                              + sessions_of(late) + [{"pk": i["pk"], "sk": i["sk"]} for i in late])
    app.store.delete_session(s["hash"])
    tally(app, "deletes")
    log(event="account-deleted", user=user_id, items=len(items) + len(late), emails=len(raw), files=len(files) - len(raw))
    return respond(200, {"ok": True}, cookies=[auth.clear_cookie()])


ROUTES = [
    ("GET", "/api/health", health),
    ("GET", "/api/sample", sample),
    ("POST", "/api/auth/start", auth_start),
    ("POST", "/api/auth/verify", auth_verify),
    ("POST", "/api/auth/signout", auth_signout),
    ("GET", "/api/me", me),
    ("PUT", "/api/me", update_me),
    ("DELETE", "/api/me", delete_me),
    ("POST", "/api/me/delete-code", delete_code),
    ("GET", "/api/places", find_places),
    ("GET", "/api/export", export_data),
    ("GET", "/api/export/zip", export_zip),
    ("POST", "/api/export/zip", export_zip_start),
    ("GET", "/api/export/zip/file", export_zip_file),
    ("GET", "/api/today", today),
    ("GET", "/api/days", days),
    ("GET", "/api/days/{date}", one_day),
    ("POST", "/api/days/{date}/notes", add_note),
    ("PUT", "/api/days/{date}/notes/{id}", edit_note),
    ("DELETE", "/api/days/{date}/notes/{id}", delete_note),
    ("GET", "/api/days/{date}/notes/{id}/media/{n}", media_file),
    ("POST", "/api/days/{date}/notes/{id}/media", add_files),
    ("POST", "/api/uploads", start_upload),
    ("GET", "/api/tags", tag_list),
    ("GET", "/api/tags/{tag}", tagged_days),
    ("POST", "/api/search", search),
    ("PUT", "/api/pause", pause),
    ("DELETE", "/api/pause", resume),
    ("GET", "/api/unsubscribe", unsubscribe),
    ("POST", "/api/unsubscribe", unsubscribe),
]
# Writes that carry their own proof (a token) and come from mail apps,
# which send no Origin.
NO_ORIGIN = {"/api/unsubscribe"}
_COMPILED = [(m, re.compile(p.replace("{date}", r"(\d{4}-\d{2}-\d{2})").replace("{id}", r"([A-Za-z0-9_-]{1,80})").replace("{n}", r"([1-9][0-9]?)").replace("{tag}", r"([a-z0-9]{1,50}(?:-[a-z0-9]{1,49})*)")), p, f) for m, p, f in ROUTES]


def match(method: str, path: str):
    for m, rx, pattern, fn in _COMPILED:
        found = rx.fullmatch(path)
        if found and m == method:
            return pattern, fn, found.groups()
    return None, None, ()


def handler(event, context, *, store=None, ses=None, s3=None, lam=None, geocode=places.search, fetch=links.fetch_title,
            weather_fetch=weather.fetch_json, clock=time.time):
    req = Request(event)
    if not req.via_cloudfront():
        # Straight to the API's own URL: one fixed answer, whatever the route.
        log(event="web", method=req.method, path="direct", status=403)
        return respond(403, {"error": "forbidden"})
    pattern, route, args = match(req.method, req.path)
    if not route:
        response = respond(404, {"error": "not-found"})
    elif req.method != "GET" and pattern not in NO_ORIGIN and req.headers.get("origin") != os.environ["WEB_ORIGIN"]:
        response = respond(403, {"error": "origin"})
    else:
        try:
            app = App(store, ses, int(clock()), s3, lam)
            app.geocode, app.fetch, app.weather_fetch = geocode, fetch, weather_fetch
            response = route(app, req, *args)
        except Reject as r:
            response = r.response
        if app.renewed and "cookies" not in response:
            response["cookies"] = [app.renewed]
    log(event="web", method=req.method, path=pattern or "unmatched", status=response["statusCode"])
    return response
