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
import uuid
from base64 import b64decode
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from zoneinfo import ZoneInfo

from . import auth, export, export_job, links, media, places
from .compose import DOTS, from_header, next_release
from .streak import ONE_DAY, compute_streak, pause_days
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
    def __init__(self, store, ses, now: int, s3=None, lam=None):
        self._store, self._ses, self._s3, self._lam, self.now = store, ses, s3, lam, now
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
    return respond(200, {"birthday": birthday.isoformat(), "version": str(compute_version(birthday, today))})


def over_limits(app: App, checks) -> None:
    """Count one more email against each (name, key, limit); 429 past any."""
    hour = app.now // 3600
    over = [name for name, key, limit in checks if app.store.count(key, hour) > limit]
    if over:
        log(event="mail-limited", limits=over)
        raise Reject(429, "limited")


def send_mail(app: App, email: str, msg) -> None:
    from_addr = os.environ["FROM_ADDRESS"]
    try:
        app.ses.send_email(
            FromEmailAddress=from_header(from_addr),
            Destination={"ToAddresses": [email]},
            Content={"Raw": {"Data": msg.as_bytes()}},
            ConfigurationSetName=os.environ["CONFIG_SET"],
        )
    except Exception as e:
        code_name = (getattr(e, "response", None) or {}).get("Error", {}).get("Code")
        log(event="mail-failed", error=type(e).__name__, code=code_name)
        raise Reject(502, "mail-failed") from None


def new_login(app: App, email: str) -> tuple[str, str]:
    """A fresh link token and code for an address; the newest one is the
    one a code is checked against."""
    token, code = auth.new_token(), auth.new_code()
    app.store.put_login(auth.digest(token), email, auth.digest(email), auth.digest(code), app.now, auth.LOGIN_TTL)
    return token, code


def auth_start(app: App, req: Request) -> dict:
    email = auth.normal_email(req.json().get("email"))
    if not email:
        raise Reject(400, "email")
    over_limits(
        app,
        (
            ("total", "all", auth.LIMIT_TOTAL),
            ("network", "net:" + auth.digest(auth.network(req.viewer())), auth.LIMIT_PER_NETWORK),
            ("address", "email:" + auth.digest(email), auth.LIMIT_PER_ADDRESS),
        ),
    )
    token, code = new_login(app, email)
    from_addr = os.environ["FROM_ADDRESS"]
    send_mail(app, email, auth.signin_message(to=email, from_addr=from_addr, link=f"{app.origin}/signin/#t={token}", code=code))
    log(event="signin-sent")
    return respond(202, {"ok": True})


CODE_ERRORS = {"gone": "code-expired", "used": "code-used", "attempts": "too-many-tries"}


def check_code(app: App, email: str, code: str) -> dict:
    """Spend one of the address's newest sign-in's code attempts, then
    compare; a match uses the sign-in up."""
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


def profile_view(p: dict, now: int) -> dict:
    today = datetime.fromtimestamp(now, ZoneInfo(p["tz"])).date()
    view = {
        "new": False,
        "email": p["email"],
        "birthday": p["birthday"],
        "tz": p["tz"],
        "send_time": p.get("send_time", "06:00"),
        "status": p.get("status", "active"),
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
    if "status" in body:
        if body["status"] != "active":
            raise Reject(400, "status")
        fields.update(status="active", restarted_at=iso(app.now))
    if not fields:
        raise Reject(400, "nothing-to-change")
    remove = ("stopped_reason", "stopped_at") if "status" in fields else ()
    app.store.update_profile(user_id, fields, remove)
    log(event="settings", user=user_id, changed=sorted(k for k in fields if k in ("send_time", "tz", "status")))
    p = {k: v for k, v in {**p, **fields}.items() if k not in remove}
    return respond(200, profile_view(p, app.now))


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
    # The first email is the next send time to come: today's if it is still
    # ahead, otherwise tomorrow's. The sender's window would otherwise send
    # today's late, minutes after sign-up.
    if local.strftime("%H:%M") >= send_time:
        profile["last_sent_date"] = local.date().isoformat()
    email = s["email"]
    user_id = uuid.uuid4().hex
    if not app.store.create_subscriber(user_id, email, profile):
        # Signed up in another tab a moment ago: this session joins it.
        user_id = app.store.user_for_email(email)
        if not user_id:
            raise Reject(409, "try-again")
        profile = app.store.profile(user_id) or {}
    app.store.claim_session(s["hash"], user_id)
    log(event="signup", user=user_id)
    return respond(200, profile_view({"email": email, **profile}, app.now))


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
    app.store.stop(found["user_id"], "unsubscribed", iso(app.now))
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

MAX_NOTE = 20_000
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


def text_from(body: dict) -> str:
    text = body.get("text")
    if not isinstance(text, str):
        raise Reject(400, "text")
    text = text.replace("\r\n", "\n").strip()
    if not text:
        raise Reject(400, "text")
    if len(text) > MAX_NOTE:
        raise Reject(400, "too-long")
    return text


def note_view(item: dict, tz: str) -> dict:
    _, day, note_id = item["sk"].split("#", 2)
    at = item.get("received_at") or ""
    view = {"id": note_id, "source": item.get("source", "email"), "text": item.get("text", ""), "at": at}
    # The text as shown: strings and links by name (links.segments).
    view["parts"] = links.segments(view["text"], item.get("links"))
    if item.get("updated_at"):
        view["edited_at"] = item["updated_at"]
    if item.get("media"):
        # Each file by number; its address is the API's, never the bucket's.
        view["media"] = [{"n": int(m["n"]), "kind": m["kind"], "type": m["type"]} for m in item["media"]]
    if others := media.others(item):
        view["attachments"] = others
    try:
        # Written or sent after its day was over: "added later".
        local = datetime.fromisoformat(at.replace("Z", "+00:00")).astimezone(ZoneInfo(tz)).date()
        view["late"] = local.isoformat() > day
    except ValueError:
        pass
    return view


def day_view(p: dict, day: str, notes: list[dict]) -> dict:
    v = compute_version(date.fromisoformat(p["birthday"]), date.fromisoformat(day))
    return {"date": day, "version": str(v), "notes": [note_view(n, p["tz"]) for n in notes]}


def today(app: App, req: Request) -> dict:
    """Today's page: the number, the year so far, today's notes, the streak."""
    user_id, p = app.account(req)
    day = local_today(p, app.now)
    v = compute_version(date.fromisoformat(p["birthday"]), day)
    have = app.store.note_days(user_id)
    paused = pause_days(app.store.pauses(user_id), day)
    # Today counts once it has a note; until then the run ends yesterday.
    s = compute_streak(have, day + ONE_DAY if day in have else day, paused)
    view = day_view(p, day.isoformat(), app.store.notes_between(user_id, day.isoformat(), day.isoformat()))
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
    if page:
        for n in app.store.notes_between(user_id, page[-1], page[0]):
            by_day.setdefault(n["sk"].split("#")[1], []).append(n)
    return respond(
        200,
        {
            "today": day,
            "tz": p["tz"],
            "days": [{**day_view(p, d, by_day[d]), **({"paused": True} if d in paused else {})} for d in page],
            "before": page[-1] if len(picked) > limit else None,
        },
    )


def one_day(app: App, req: Request, value: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    view = day_view(p, day, app.store.notes_between(user_id, day, day))
    view.update(tz=p["tz"], today=day == local_today(p, app.now).isoformat())
    return respond(200, view)


def add_note(app: App, req: Request, value: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now)
    text = text_from(req.json())
    note_id = "w-" + uuid.uuid4().hex[:20]
    item = {
        "version": str(compute_version(date.fromisoformat(p["birthday"]), day)),
        "text": text,
        "source": "web",
        "received_at": iso(app.now),
    }
    found = links.collect(text, fetch=app.fetch)
    if found:
        item["links"] = found
    app.store.put_note(user_id, day.isoformat(), note_id, item)
    log(event="note-added", user=user_id, date=day.isoformat())
    return respond(201, note_view({"sk": f"NOTE#{day.isoformat()}#{note_id}", **item}, p["tz"]))


def edit_note(app: App, req: Request, value: str, note_id: str) -> dict:
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    text = text_from(req.json())
    old = next((n for n in app.store.notes_between(user_id, day, day) if n["sk"].split("#", 2)[2] == note_id), None)
    if not old:
        raise Reject(404, "note")
    # Links the note had keep their names; only a new address is fetched.
    found = links.collect(text, keep=old.get("links"), fetch=app.fetch)
    item = app.store.update_note(user_id, day, note_id, text, iso(app.now), found)
    if not item:
        raise Reject(404, "note")
    log(event="note-edited", user=user_id, date=day)
    return respond(200, note_view(item, p["tz"]))


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


MEDIA_LINK = 600  # seconds a photo's link lasts


def media_file(app: App, req: Request, value: str, note_id: str, n: str) -> dict:
    """A photo or recording, for its owner only: a redirect to a link to the
    file that lasts ten minutes. The browser may reuse the redirect for five."""
    user_id, p = app.account(req)
    day = day_from(p, value, app.now).isoformat()
    note = next((x for x in app.store.notes_between(user_id, day, day) if x["sk"].split("#", 2)[2] == note_id), None)
    entry = next((m for m in (note or {}).get("media") or [] if int(m["n"]) == int(n)), None)
    if not entry or not str(entry.get("key", "")).startswith(f"media/{user_id}/"):
        raise Reject(404, "media")
    url = app.s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": os.environ["MAIL_BUCKET"], "Key": entry["key"], "ResponseContentType": entry["type"],
                "ResponseContentDisposition": "inline", "ResponseCacheControl": f"private, max-age={MEDIA_LINK}"},
        ExpiresIn=MEDIA_LINK,
    )
    return respond(302, {}, headers={"location": url, "cache-control": "private, max-age=300"})


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
    """Mail the account's own address a code that confirms deleting it."""
    user_id, p = app.account(req)
    email = p["email"]
    over_limits(
        app,
        (("total", "all", auth.LIMIT_TOTAL), ("address", "email:" + auth.digest(email), auth.LIMIT_PER_ADDRESS)),
    )
    _, code = new_login(app, email)
    send_mail(app, email, auth.delete_message(to=email, from_addr=os.environ["FROM_ADDRESS"], code=code))
    log(event="delete-code-sent", user=user_id)
    return respond(202, {"ok": True})


def delete_me(app: App, req: Request) -> dict:
    """Delete everything: the original emails, the reply addresses, every
    item under the subscriber, the address, and the profile last, so a
    failure part way leaves an account that can try again."""
    s = app.subscriber(req)
    user_id = s["user_id"]
    p = app.store.profile(user_id)
    if not p:
        raise Reject(403, "no-account")
    code = auth.valid_code(req.json().get("code"))
    if not code:
        raise Reject(400, "email-and-code")
    check_code(app, p["email"], code)

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
    keys += [{"pk": i["pk"], "sk": i["sk"]} for i in items if i["sk"] != "PROFILE"]
    keys.append({"pk": f"EMAIL#{p['email']}", "sk": "EMAIL"})
    app.store.delete_keys(keys)
    app.store.delete_keys([{"pk": f"USER#{user_id}", "sk": "PROFILE"}])
    app.store.delete_session(s["hash"])
    log(event="account-deleted", user=user_id, items=len(items), emails=len(raw), files=len(files) - len(raw))
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
    ("PUT", "/api/pause", pause),
    ("DELETE", "/api/pause", resume),
    ("GET", "/api/unsubscribe", unsubscribe),
    ("POST", "/api/unsubscribe", unsubscribe),
]
# Writes that carry their own proof (a token) and come from mail apps,
# which send no Origin.
NO_ORIGIN = {"/api/unsubscribe"}
_COMPILED = [(m, re.compile(p.replace("{date}", r"(\d{4}-\d{2}-\d{2})").replace("{id}", r"([A-Za-z0-9_-]{1,80})").replace("{n}", r"([1-9][0-9]?)")), p, f) for m, p, f in ROUTES]


def match(method: str, path: str):
    for m, rx, pattern, fn in _COMPILED:
        found = rx.fullmatch(path)
        if found and m == method:
            return pattern, fn, found.groups()
    return None, None, ()


def handler(event, context, *, store=None, ses=None, s3=None, lam=None, geocode=places.search, fetch=links.fetch_title,
            clock=time.time):
    req = Request(event)
    pattern, route, args = match(req.method, req.path)
    if not route:
        response = respond(404, {"error": "not-found"})
    elif req.method != "GET" and pattern not in NO_ORIGIN and req.headers.get("origin") != os.environ["WEB_ORIGIN"]:
        response = respond(403, {"error": "origin"})
    else:
        try:
            app = App(store, ses, int(clock()), s3, lam)
            app.geocode, app.fetch = geocode, fetch
            response = route(app, req, *args)
        except Reject as r:
            response = r.response
    log(event="web", method=req.method, path=pattern or "unmatched", status=response["statusCode"])
    return response
