"""Sign-in by email: a link and a six-digit code, then a session cookie.

Elixir's design (elixir-mcp packages/auth/src/magic.mjs), on DynamoDB:

- One sign-in serves both the link and the code. Whichever is used first
  burns it, with a conditional update, so a race has one winner.
- Code attempts are counted before comparing, at most MAX_CODE_ATTEMPTS, and
  compared in constant time. Only the newest sign-in for an address takes a
  code; an older email's link still works until it expires.
- Secrets are stored only as SHA-256 hashes: the link token, the code and the
  session token. The address itself sits on the sign-in row for its 15
  minutes, because a new address needs it to sign up.
- Limits on sign-in emails, per address, per network and in total, all per
  hour (web.py). The network limit reads CloudFront's viewer address, which
  a caller cannot set: the API answers only requests carrying CloudFront's
  X-Origin-Verify secret, so going straight to its own URL gets a 403. The
  total still bounds the shared SES account against many networks at once.
- The answer to "send me a link" is the same whether or not the address has
  an account, and so is the email.
- The link opens a page with a "Sign in" button, because mail scanners open
  links. The token rides in the fragment, which never reaches a server log.

The session is a random token in an __Host- cookie (Secure, HttpOnly,
SameSite=Lax, Path=/). It lasts 14 days from last use, and every visit
starts the 14 days again, with no outer limit (Jamie, 2026-10-08: "as long
as I return within that time extend my login session"). The cookie's
Max-Age is renewed along with the stored expiry, at most once a day.
"""

import hashlib
import hmac
import ipaddress
import re
import secrets
from email.message import EmailMessage
from email.utils import make_msgid
from html import escape

from .compose import APP, BLUE, FONT, INK, INK_2, MONO, PAPER, from_header

LOGIN_TTL = 15 * 60
MAX_CODE_ATTEMPTS = 5
# Wrong codes for one address in a day, across all its sign-ins. Five an
# email and five emails an hour would otherwise allow 600 guesses a day.
MAX_WRONG_CODES_A_DAY = 20
SESSION_IDLE = 14 * 86400
SESSION_TOUCH = 86400  # renew a session's expiry and cookie at most once a day
COOKIE = "__Host-rn"

# Sign-in emails per hour.
LIMIT_PER_ADDRESS = 5
LIMIT_PER_NETWORK = 20
LIMIT_TOTAL = 200

_EMAIL = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
_CODE = re.compile(r"[0-9]{6}")


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def same(a: str, b: str) -> bool:
    return hmac.compare_digest(a.encode(), b.encode())


def normal_email(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    email = raw.strip().lower()
    return email if len(email) <= 254 and _EMAIL.fullmatch(email) else None


def new_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits, 43 characters


def new_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def valid_token(raw) -> str | None:
    return raw if isinstance(raw, str) and _TOKEN.fullmatch(raw) else None


def valid_code(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    code = re.sub(r"\s", "", raw)
    return code if _CODE.fullmatch(code) else None


def network(viewer: str) -> str:
    """The rate-limit key for a viewer address: the IPv4 address, or the
    IPv6 /64, which is what one household or phone is handed."""
    try:
        ip = ipaddress.ip_address(viewer)
    except ValueError:
        return viewer
    return str(ipaddress.ip_network(f"{ip}/64", strict=False)) if ip.version == 6 else str(ip)


def session_cookie(token: str) -> str:
    return f"{COOKIE}={token}; Path=/; Max-Age={SESSION_IDLE}; Secure; HttpOnly; SameSite=Lax"


def clear_cookie() -> str:
    return f"{COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax"


def cookie_token(cookies: list[str]) -> str | None:
    for c in cookies or []:
        name, _, value = c.strip().partition("=")
        if name == COOKIE:
            return valid_token(value)
    return None


def session_expiry(now: int) -> int:
    return now + SESSION_IDLE


# --- the email ---------------------------------------------------------------


def signin_subject(code: str) -> str:
    return f"{code} is your Release Notes code"


def signin_text(link: str, code: str) -> str:
    return f"""Sign in to Release Notes:

{link}

Or type this code where you asked: {code}

The link and the code work once, for 15 minutes. If you didn't ask, you can
ignore this email: nothing happens without the link or the code.

This comes from the same address as the daily email. Adding it to your
contacts keeps both out of junk.
"""


def signin_html(link: str, code: str) -> str:
    p = f"margin:0 0 18px;font:16px/1.55 {FONT};color:{INK_2}"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Sign in to Release Notes</title></head>
<body style="margin:0;padding:0;background:{PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAPER}"><tr><td style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td>
<p style="margin:0 0 24px;font:800 18px/1.3 {FONT};color:{INK}">Release Notes</p>
<p style="margin:0 0 18px;font:800 26px/1.2 {FONT};color:{INK}"><a href="{escape(link)}" style="color:{BLUE}">Sign in to Release Notes</a></p>
<p style="{p}">Or type this code where you asked:</p>
<p style="margin:0 0 24px;font:700 30px/1 {MONO};letter-spacing:.2em;color:{BLUE}">{escape(code)}</p>
<p style="{p}">The link and the code work once, for 15 minutes. If you didn&rsquo;t ask, you can ignore this email: nothing happens without the link or the code.</p>
<p style="margin:0;font:14px/1.55 {FONT};color:{INK_2}">This comes from the same address as the daily email. Adding it to your contacts keeps both out of junk.</p>
</td></tr></table>
</td></tr></table>
</body></html>
"""


def signin_message(*, to: str, from_addr: str, link: str, code: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_header(from_addr)
    msg["To"] = to
    msg["Subject"] = signin_subject(code)
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[1])
    msg.set_content(signin_text(link, code))
    msg.add_alternative(signin_html(link, code), subtype="html")
    return msg


def delete_text(code: str, settings: str) -> str:
    return f"""Someone signed in to your Release Notes asked to delete the account:
every note, the emails behind them, and your settings.

To go ahead, type this code on the page that asked: {code}

It works once, for 15 minutes. If you didn't ask, ignore this email and
nothing is deleted. To keep a copy first, export from {settings}
"""


def delete_html(code: str, settings: str) -> str:
    p = f"margin:0 0 18px;font:16px/1.55 {FONT};color:{INK_2}"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Delete your Release Notes</title></head>
<body style="margin:0;padding:0;background:{PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAPER}"><tr><td style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td>
<p style="margin:0 0 24px;font:800 18px/1.3 {FONT};color:{INK}">Release Notes</p>
<p style="margin:0 0 18px;font:800 26px/1.2 {FONT};color:{INK}">Delete your Release Notes?</p>
<p style="{p}">Someone signed in to your account asked to delete it: every note, the emails behind them, and your settings. To go ahead, type this code on the page that asked:</p>
<p style="margin:0 0 24px;font:700 30px/1 {MONO};letter-spacing:.2em;color:{BLUE}">{escape(code)}</p>
<p style="{p}">It works once, for 15 minutes. If you didn&rsquo;t ask, ignore this email and nothing is deleted.</p>
<p style="margin:0;font:14px/1.55 {FONT};color:{INK_2}">To keep a copy first, <a href="{escape(settings)}" style="color:{BLUE}">export from settings</a>.</p>
</td></tr></table>
</td></tr></table>
</body></html>
"""


def delete_message(*, to: str, from_addr: str, code: str) -> EmailMessage:
    settings = f"{APP}/settings/"
    msg = EmailMessage()
    msg["From"] = from_header(from_addr)
    msg["To"] = to
    msg["Subject"] = f"{code} confirms deleting your Release Notes"
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[1])
    msg.set_content(delete_text(code, settings))
    msg.add_alternative(delete_html(code, settings), subtype="html")
    return msg
