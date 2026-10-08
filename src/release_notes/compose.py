"""The daily email: one message per subscriber per day, plain text and HTML.

The HTML takes the site's colours (assets/site.css in yourversionnumber.com):
warm paper and the number in mono with cobalt digits and tangerine dots. It is
type on paper: no borders, boxes, shadows or filled panels (Jamie, 2026-10-07).
Rules for it:

- Nothing remote. No images, no web fonts, no tracking of any kind. Martian
  Mono and Bricolage are named first in the stacks, so they show where
  installed; everyone else gets the system fonts.
- Tables and inline styles, because that is what mail clients render. The
  <style> block only adds dark mode and the narrow-screen tweaks; the email
  must read correctly without it (Gmail strips some of it).
- The plain-text part says the same thing. Replies are parsed from the
  replier's own plain text, never from this HTML.
"""

import secrets
from base64 import b32encode
from datetime import date
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html import escape

from .version import Version

SITE = "https://yourversionnumber.com"

# The birthday face's tokens, light then dark (site.css section 1).
PAPER, INK, INK_2 = "#fffbf2", "#14163a", "#3b3d63"
BLUE, ORANGE, ORANGE_INK, PINK_INK = "#1a4fe0", "#ff5a1f", "#c43c00", "#c9186a"

FONT = "'Bricolage Grotesque',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "'Martian Mono',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"


def new_token() -> str:
    # 120 random bits, lowercase base32: safe in an email local part, and
    # unguessable, which is what makes the reply address an authority.
    return b32encode(secrets.token_bytes(15)).decode().lower()


def from_header(from_addr: str) -> str:
    # The one From every email carries; subscribers' mail rules match it.
    # send.py hands the same string to SES, which writes its FromEmailAddress
    # over the message's own From, so a bare address there drops the name.
    return formataddr(("Release Notes", from_addr))


def reply_address(token: str, inbound_domain: str) -> str:
    return f"n-{token}@{inbound_domain}"


def subject(v: Version) -> str:
    return f"You're {v} today"


def birthday_line(v: Version) -> str | None:
    if v.patch == 0 and v.minor == 0 and v.major > 0:
        return "Happy birthday: a major release."
    if v.patch == 0:
        return "Happy birthday: a new release."
    return None


def next_release(v: Version) -> str:
    # From the next age, not by bumping minor: at 49 the next release is 5.0.0.
    nxt = v.age + 1
    return f"{nxt // 10}.{nxt % 10}.0"


def countdown(v: Version) -> str:
    days = "tomorrow" if v.days_until == 1 else f"in {v.days_until} days"
    return f"{next_release(v)} ships {days}."


def plural(n: int, one: str, many: str) -> str:
    return one if n == 1 else many


def long_date(day: date) -> str:
    return f"{day:%A, %B} {day.day}"


# --- plain text ---------------------------------------------------------------

def body(v: Version, birthday: date) -> str:
    opening = f"You're {v} today."
    if line := birthday_line(v):
        opening = f"{opening} {line}"
    return (
        f"{opening}\n"
        "\n"
        "Reply any time today: what happened, what you made, who you saw.\n"
        f"Whatever you send back becomes the release notes for {v}.\n"
        "\n"
        f"{countdown(v)}\n"
        f"{SITE}/birthday/?p={birthday.isoformat()}\n"
        "\n"
        "-- \n"
        "Release Notes, from Your Version Number\n"
    )


# --- HTML -------------------------------------------------------------------------

def vnum_html(v: Version, size: int) -> str:
    out = []
    for ch in str(v):
        if ch == ".":
            out.append(f'<span class="sep" style="color:{ORANGE};">.</span>')
        else:
            out.append(ch)
    return (
        f'<span class="vnum" style="font-family:{MONO};font-weight:700;font-size:{size}px;line-height:1;'
        f'letter-spacing:-0.045em;color:{BLUE};white-space:nowrap;">{"".join(out)}</span>'
    )


def part(kind: str, n: int, label: str, num_color: str) -> str:
    return (
        f'<td class="part part-{kind}" width="33%" valign="top" style="padding:0 8px 0 0;">'
        f'<div class="part-n" style="font-family:{MONO};font-weight:700;font-size:26px;line-height:1.1;'
        f'letter-spacing:-0.04em;color:{num_color};">{n}</div>'
        f'<div class="part-l ink-2" style="font-family:{FONT};font-size:13px;line-height:1.3;color:{INK_2};padding-top:3px;">'
        f"{escape(label)}</div></td>"
    )


DARK_CSS = f"""
:root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
@media (max-width: 480px) {{
  .vnum-hero .vnum {{ font-size: 54px !important; }}
  .part-n {{ font-size: 22px !important; }}
}}
@media (prefers-color-scheme: dark) {{
  body, .paper {{ background: #131634 !important; }}
  .ink {{ color: #fdf6e8 !important; }}
  .ink-2 {{ color: #b9bede !important; }}
  .vnum {{ color: #8fb4ff !important; }}
  .sep {{ color: #ff8a4d !important; }}
  .part-major .part-n {{ color: #8fb4ff !important; }}
  .part-minor .part-n {{ color: #ffab6b !important; }}
  .part-patch .part-n, .party {{ color: #ff9ecb !important; }}
  .link {{ color: #8fb4ff !important; }}
}}
"""


def html_body(v: Version, birthday: date, day: date) -> str:
    vs = escape(str(v))
    party = birthday_line(v)
    party_html = (
        f'<p class="party" style="margin:12px 0 0;font-family:{FONT};font-size:18px;font-weight:700;color:{PINK_INK};">'
        f"{escape(party)}</p>"
        if party
        else ""
    )
    link = f"{SITE}/birthday/?p={birthday.isoformat()}"
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>You're {vs} today</title>
<style>{DARK_CSS}</style>
</head>
<body class="paper" style="margin:0;padding:0;background:{PAPER};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Reply with anything about today, and it becomes the release notes for {vs}.</div>
<table role="presentation" class="paper" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{PAPER};">
<tr><td align="center" style="padding:32px 22px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

<tr><td class="ink-2" style="padding:0 0 22px;font-family:{FONT};font-size:14px;color:{INK_2};">
<strong class="ink" style="color:{INK};">Release notes</strong> &middot; {escape(long_date(day))}
</td></tr>

<tr><td>
<p class="ink" style="margin:0 0 8px;font-family:{FONT};font-size:17px;color:{INK};">Today you&rsquo;re</p>
<div class="vnum-hero" role="heading" aria-level="1" aria-label="{vs}">{vnum_html(v, 64)}</div>
{party_html}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;">
<tr>
{part("major", v.major, plural(v.major, "decade", "decades"), BLUE)}
{part("minor", v.minor, plural(v.minor, "year in", "years in"), ORANGE_INK)}
{part("patch", v.patch, "days since your birthday" if v.patch != 1 else "day since your birthday", PINK_INK)}
</tr>
</table>
<p class="ink-2" style="margin:18px 0 0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
{escape(countdown(v))} <a class="link" href="{escape(link)}" style="color:{BLUE};font-weight:700;text-decoration:underline;">See your number</a>
</p>
</td></tr>

<tr><td style="padding:30px 0 0;">
<p class="ink" style="margin:0;font-family:{FONT};font-size:18px;line-height:1.5;color:{INK};">
<strong>Reply any time today:</strong> what happened, what you made, who you saw.
Whatever you send back becomes the release notes for
<span class="vnum" style="font-family:{MONO};font-weight:700;letter-spacing:-0.03em;color:{BLUE};white-space:nowrap;">{vs.replace(".", f'<span class="sep" style="color:{ORANGE_INK};">.</span>')}</span>.
</p>
</td></tr>

<tr><td class="ink-2" style="padding:30px 0 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{INK_2};">
Release Notes, from <a class="link" href="{SITE}/" style="color:{BLUE};">Your Version Number</a>.
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
"""


def build_message(
    *, to: str, from_addr: str, token: str, inbound_domain: str, v: Version, birthday: date, day: date
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_header(from_addr)
    msg["To"] = to
    msg["Reply-To"] = formataddr(("Release Notes", reply_address(token, inbound_domain)))
    msg["Subject"] = subject(v)
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[1])
    msg.set_content(body(v, birthday))
    msg.add_alternative(html_body(v, birthday, day), subtype="html")
    return msg
