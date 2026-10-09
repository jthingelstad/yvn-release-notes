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
- The number stands alone: no decades/years/days breakdown under it (Jamie,
  2026-10-07: "super redundant"). Below it, a row of dots for how far through
  the year this release is, then the ask, then the reply streak (streak.py).
- Non-ASCII goes in as entities, so the HTML part stays 7-bit.
- The plain-text part says the same thing. Replies are parsed from the
  replier's own plain text, never from this HTML.
- "A year ago" shows the notes from the same patch number a release back
  (version.a_year_before), after the streak, only when there are some.
  Links in them show by name (links.py): the words the writer linked, or
  the page title saved when the note was written, else the short address.
- Weather (weather.py) is one quiet line of today's forecast under the
  date, and that day's weather in "A year ago", both as text; the footer
  credits Open-Meteo whenever either shows. Without it, the email is the
  same as ever.
"""

import re
import secrets
from base64 import b32encode
from datetime import date
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html import escape

from . import links, weather
from .streak import Streak
from .version import Version, compute_version

SITE = "https://yourversionnumber.com"
APP = "https://notes.yourversionnumber.com"

# The birthday face's tokens, light then dark (site.css section 1).
PAPER, INK, INK_2 = "#fffbf2", "#14163a", "#3b3d63"
BLUE, ORANGE, ORANGE_INK, PINK_INK = "#1a4fe0", "#ff5a1f", "#c43c00", "#c9186a"

FONT = "'Bricolage Grotesque',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"
MONO = "'Martian Mono',ui-monospace,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace"


def new_token() -> str:
    # 120 random bits, lowercase base32: safe in an email local part, and
    # unguessable, which is what makes the reply address an authority.
    return b32encode(secrets.token_bytes(15)).decode().lower()


# SES counts every email under this tag in CloudWatch (the stack's
# MailMetrics destination): "daily" from the sender, "account" (sign-in and
# delete codes) from the web app. A count, never a person.
MAIL_TAG = "release-notes-mail"


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


def ships(v: Version) -> str:
    return "tomorrow" if v.days_until == 1 else f"in {v.days_until} days"


def countdown(v: Version) -> str:
    return f"{next_release(v)} ships {ships(v)}."


def days_phrase(n: int) -> str:
    return f"{n} day" if n == 1 else f"{n} days"


def clock_phrase(hhmm: str) -> str:
    """'06:30' as '6:30 AM', the way the web app shows send times."""
    h, m = (int(x) for x in hhmm.split(":"))
    return f"{(h + 11) % 12 + 1}:{m:02d} {'AM' if h < 12 else 'PM'}"


def welcome_line(send_time: str, from_addr: str) -> str:
    """The first email goes the moment someone signs up (web.send_first)."""
    return (
        f"Welcome to Release Notes. This first one is today's; from tomorrow it comes every day at {clock_phrase(send_time)}. "
        f"Add {from_addr} to your contacts so it never lands in junk."
    )


def streak_lines(v: Version, s: Streak) -> tuple[str, str]:
    """The streak as a bold head and a quiet tail. A missed day is never
    called out: the count starts over and the longest is shown instead."""
    if s.current == 0:
        tail = f"Your longest so far is {days_phrase(s.longest)}." if s.longest else "Today's can be the first."
        return "Every reply starts a streak.", tail
    ask = f"Reply today and {v} makes it {s.current + 1}."
    if s.current >= s.longest and s.current > 1:
        return f"{days_phrase(s.current)} in a row, your longest yet.", ask
    longest = f"Your longest is {days_phrase(s.longest)}. " if s.longest > s.current else ""
    return f"{days_phrase(s.current)} in a row.", longest + ask


def long_date(day: date) -> str:
    return f"{day:%A, %B} {day.day}"


# --- a year ago -------------------------------------------------------------------

PAST_MAX = 1000  # characters of last year's notes before "Read the rest"


def past_text(text: str) -> tuple[str, bool]:
    """Last year's notes, cut between words near PAST_MAX. True if cut."""
    if len(text) <= PAST_MAX:
        return text, False
    return text[:PAST_MAX].rsplit(None, 1)[0].rstrip(), True


def past_link(day: date) -> str:
    return f"{APP}/day/?d={day.isoformat()}"


def ascii_html(text: str) -> str:
    return escape(text).encode("ascii", "xmlcharrefreplace").decode()


def linked(text: str, found: list[dict] | None = None) -> str:
    """Note text for the HTML part: escaped, 7-bit, with links by name
    (links.segments): a fetched title is followed by its site, quietly."""
    out = []
    for seg in links.segments(text, found):
        if isinstance(seg, str):
            out.append(ascii_html(seg))
            continue
        out.append(f'<a class="link" href="{ascii_html(seg["url"])}" style="color:{BLUE};">{ascii_html(seg["label"])}</a>')
        if seg.get("site"):
            out.append(f'<span class="ink-2" style="color:{INK_2};"> &middot; {ascii_html(seg["site"])}</span>')
    return "".join(out)


# The day, its notes' text, their links, how many photos and recordings
# (media.counts), and that day's weather as a line, if it was kept. The
# email never carries a file: it links to the day.
LastYear = tuple[date, str, list, dict, str | None]


FILE_WORDS = (("image", "photo"), ("audio", "recording"), ("file", "file"))


def files_phrase(files: dict | None) -> str:
    """'the photo', '3 photos and a recording', '2 photos, a recording and
    a file', or ''."""
    files = files or {}
    parts = []
    for kind, word in FILE_WORDS:
        n = files.get(kind, 0)
        if n:
            parts.append(f"{n} {word}s" if n > 1 else f"the {word}" if not parts else f"a {word}")
    return parts[0] if len(parts) == 1 else ", ".join(parts[:-1]) + " and " + parts[-1] if parts else ""


def past_more(cut: bool, files: dict | None) -> str:
    """The link's words: 'See it', 'Read the rest', 'See 2 photos',
    'Read the rest, with the photo', 'Hear the recording'."""
    phrase = files_phrase(files)
    if cut:
        return f"Read the rest, with {phrase}" if phrase else "Read the rest"
    if not phrase:
        return "See it"
    verb = "Hear" if set(k for k, n in (files or {}).items() if n) == {"audio"} else "See"
    return f"{verb} {phrase}"


def past_body(birthday: date, then: date, text: str, found: list | None = None, files: dict | None = None,
              sky: str | None = None) -> str:
    shown, cut = past_text(text)
    shown = links.plain(shown, found)
    notes = f"{shown}{' ...' if cut else ''}\n\n" if shown else ""
    return (
        f"A year ago you were {compute_version(birthday, then)} ({long_date(then)}, {then.year}):\n"
        f"{sky + '.' + chr(10) if sky else ''}"
        "\n"
        f"{notes}"
        f"{past_more(cut, files)}: {past_link(then)}\n"
        "\n"
    )


def credited(forecast: str | None, last_year: LastYear | None) -> bool:
    return bool(forecast or (last_year and len(last_year) > 4 and last_year[4]))


def unsubscribe_link(token: str) -> str:
    # The page asks before stopping, so a link scanner opening it stops nothing.
    return f"{APP}/unsubscribe/#t={token}"


def body(v: Version, birthday: date, streak: Streak | None = None, last_year: LastYear | None = None,
         forecast: str | None = None, welcome: str | None = None, token: str | None = None) -> str:
    opening = f"You're {v} today."
    if line := birthday_line(v):
        opening = f"{opening} {line}"
    if forecast:
        opening = f"{opening}\n{forecast}"
    if welcome:
        opening = f"{welcome}\n\n{opening}"
    streak_text = " ".join(streak_lines(v, streak)) + "\n\n" if streak else ""
    if last_year:
        streak_text += past_body(birthday, *last_year)
    return (
        f"{opening}\n"
        "\n"
        "Reply any time today: what happened, what you made, who you saw.\n"
        f"Whatever you send back becomes the release notes for {v}.\n"
        "Photos and voice memos work too.\n"
        "Reply as often as you like; it all adds up to today's notes.\n"
        "\n"
        f"{streak_text}"
        f"{countdown(v)}\n"
        f"{SITE}/birthday/?p={birthday.isoformat()}\n"
        "\n"
        "-- \n"
        "Release Notes, from Your Version Number\n"
        f"Pause or manage: {APP}/settings/\n"
        + (f"Unsubscribe: {unsubscribe_link(token)}\n" if token else "")
        + (f"{weather.CREDIT}: {weather.CREDIT_URL}\n" if credited(forecast, last_year) else "")
    )


# --- HTML -------------------------------------------------------------------------

def vnum_html(v: Version, size: int, sep_color: str = ORANGE) -> str:
    out = []
    for ch in str(v):
        if ch == ".":
            out.append(f'<span class="sep" style="color:{sep_color};">.</span>')
        else:
            out.append(ch)
    return (
        f'<span class="vnum" style="font-family:{MONO};font-weight:700;font-size:{size}px;line-height:1;'
        f'letter-spacing:-0.045em;color:{BLUE};white-space:nowrap;">{"".join(out)}</span>'
    )


DOTS = 24
DOT = "&#9679;"  # a filled circle, as type: the year shown as a row of dots
MIDDOT = "&middot;"
DOT_OFF = "#e3e8f7"
STREAK_SHOWN = 6  # days of the current run spelled out before today's number


def year_dots(v: Version) -> str:
    on = round(v.patch / v.cycle_days * DOTS)
    return (
        f'<p aria-hidden="true" style="margin:0;font-family:{MONO};font-size:11px;line-height:1;letter-spacing:4px;white-space:nowrap;">'
        f'<span class="dot-on" style="color:{ORANGE};">{DOT * on}</span>'
        f'<span class="dot-off" style="color:{DOT_OFF};">{DOT * (DOTS - on)}</span></p>'
    )


def streak_html(v: Version, birthday: date, s: Streak) -> str:
    # Each day in the run by its patch number, then today's, still open.
    past = "".join(
        f'<span class="vnum" style="font-weight:700;color:{BLUE};">{compute_version(birthday, d).patch}</span>'
        f'<span class="sep" style="color:{ORANGE};"> {MIDDOT} </span>'
        for d in s.days[-STREAK_SHOWN:]
    )
    today = (
        f'<span class="today" style="font-weight:700;color:{ORANGE_INK};text-decoration:underline;'
        f'text-decoration-style:dotted;text-underline-offset:5px;">{v.patch}</span>'
    )
    # With no run going, a lone "today" number says nothing: the sentence alone.
    row = (
        f'<p class="streak-row" style="margin:0 0 8px;font-family:{MONO};font-size:17px;line-height:1.5;'
        f'letter-spacing:-0.02em;">{past}{today}</p>\n'
        if s.days
        else ""
    )
    head, tail = streak_lines(v, s)
    return f"""<tr><td style="padding:36px 0 0;">
{row}<p class="ink-2" style="margin:0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
<strong class="ink" style="color:{INK};">{escape(head)}</strong> {"&nbsp;".join(escape(tail).rsplit(" ", 1))}
</p>
</td></tr>
"""


def past_html(birthday: date, then: date, text: str, found: list | None = None, files: dict | None = None,
              sky: str | None = None) -> str:
    v = compute_version(birthday, then)
    sky_html = (
        f'<p class="ink-2" style="margin:0 0 16px;font-family:{FONT};font-size:14px;line-height:1.45;color:{INK_2};">'
        f"{ascii_html(sky)}</p>\n"
        if sky
        else ""
    )
    shown, cut = past_text(text)
    paras = [p.strip() for p in re.split(r"\n\s*\n", shown) if p.strip()]
    if cut:
        paras[-1] += "\u2026"
    notes = "\n".join(
        f'<p class="ink" style="margin:0 0 12px;font-family:{FONT};font-size:17px;line-height:1.5;color:{INK};">'
        + "<br>".join(linked(line, found) for line in p.split("\n"))
        + "</p>"
        for p in paras
    )
    more = escape(past_more(cut, files))
    return f"""<tr><td style="padding:48px 0 0;">
<p class="ink-2" style="margin:0 0 6px;font-family:{FONT};font-size:14px;color:{INK_2};">
<strong class="ink" style="color:{INK};">A year ago</strong> &middot; {escape(long_date(then))}, {then.year}
</p>
<p style="margin:0 0 {10 if sky else 16}px;">{vnum_html(v, 30)}</p>
{sky_html}{notes}
<p class="ink-2" style="margin:4px 0 0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
<a class="link" href="{escape(past_link(then))}" style="color:{BLUE};font-weight:700;text-decoration:underline;">{more}</a>
</p>
</td></tr>
"""


DARK_CSS = f"""
:root {{ color-scheme: light dark; supported-color-schemes: light dark; }}
@media (max-width: 480px) {{
  .vnum-hero .vnum {{ font-size: 58px !important; }}
  .streak-row {{ font-size: 15px !important; }}
}}
@media (prefers-color-scheme: dark) {{
  body, .paper {{ background: #131634 !important; }}
  .ink {{ color: #fdf6e8 !important; }}
  .ink-2 {{ color: #b9bede !important; }}
  .vnum {{ color: #8fb4ff !important; }}
  .sep, .dot-on {{ color: #ff8a4d !important; }}
  .dot-off {{ color: #2b3062 !important; }}
  .today {{ color: #ffab6b !important; }}
  .party {{ color: #ff9ecb !important; }}
  .link {{ color: #8fb4ff !important; }}
}}
"""


def html_body(
    v: Version, birthday: date, day: date, streak: Streak | None = None, last_year: LastYear | None = None,
    forecast: str | None = None, welcome: str | None = None, token: str | None = None,
) -> str:
    vs = escape(str(v))
    party = birthday_line(v)
    party_html = (
        f'<p class="party" style="margin:16px 0 0;font-family:{FONT};font-size:20px;font-weight:800;color:{PINK_INK};">'
        f"{escape(party)}</p>"
        if party
        else ""
    )
    link = f"{SITE}/birthday/?p={birthday.isoformat()}"
    inline_v = vs.replace(".", f'<span class="sep" style="color:{ORANGE_INK};">.</span>')
    welcome_html = (
        f'<tr><td class="ink" style="padding:0 0 32px;font-family:{FONT};font-size:17px;line-height:1.5;color:{INK};">'
        f"{ascii_html(welcome)}</td></tr>\n"
        if welcome
        else ""
    )
    forecast_html = f'<br><span class="ink-2" style="color:{INK_2};">{ascii_html(forecast)}</span>' if forecast else ""
    credit_html = (
        f' &middot; <a class="link" href="{weather.CREDIT_URL}" style="color:{BLUE};">{weather.CREDIT}</a>'
        if credited(forecast, last_year)
        else ""
    )
    unsubscribe_html = (
        f' &middot; <a class="link" href="{escape(unsubscribe_link(token))}" style="color:{BLUE};">Unsubscribe</a>' if token else ""
    )
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
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">Reply with anything about today, and it becomes the release notes for {vs}.</div>
<table role="presentation" class="paper" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:{PAPER};">
<tr><td align="center" style="padding:40px 22px 48px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

<tr><td class="ink-2" style="padding:0 0 40px;font-family:{FONT};font-size:14px;color:{INK_2};">
<strong class="ink" style="color:{INK};">Release notes</strong> &middot; {escape(long_date(day))}{forecast_html}
</td></tr>

{welcome_html}<tr><td>
<p class="ink" style="margin:0 0 10px;font-family:{FONT};font-size:18px;color:{INK};">Today you&rsquo;re</p>
<div class="vnum-hero" role="heading" aria-level="1" aria-label="{vs}">{vnum_html(v, 76)}</div>
{party_html}
</td></tr>

<tr><td style="padding:36px 0 0;">
{year_dots(v)}
<p class="ink-2" style="margin:8px 0 0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
<span class="ink" style="font-family:{MONO};font-weight:700;color:{INK};">{escape(next_release(v))}</span> ships {escape(ships(v))}. <a class="link" href="{escape(link)}" style="color:{BLUE};font-weight:700;text-decoration:underline;">See your number</a>
</p>
</td></tr>

<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 12px;font-family:{FONT};font-size:28px;line-height:1.15;font-weight:800;letter-spacing:-0.01em;color:{INK};">Reply any time today.</p>
<p class="ink" style="margin:0 0 12px;font-family:{FONT};font-size:19px;line-height:1.5;color:{INK};">
What happened, what you made, who you saw. Whatever you send back becomes the release notes for
<span class="vnum" style="font-family:{MONO};font-weight:700;letter-spacing:-0.03em;color:{BLUE};white-space:nowrap;">{inline_v}</span>.
</p>
<p class="ink-2" style="margin:0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">Just hit reply. A line is plenty, and photos and voice memos work too. Reply as often as you like; it all adds up to today&rsquo;s notes.</p>
</td></tr>

{streak_html(v, birthday, streak) if streak else ""}
{past_html(birthday, *last_year) if last_year else ""}
<tr><td class="ink-2" style="padding:48px 0 0;font-family:{FONT};font-size:13px;line-height:1.5;color:{INK_2};">
Release Notes, from <a class="link" href="{SITE}/" style="color:{BLUE};">Your Version Number</a>. <a class="link" href="{APP}/settings/" style="color:{BLUE};">Pause or manage</a>{unsubscribe_html}{credit_html}
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>
"""


def build_message(
    *,
    to: str,
    from_addr: str,
    token: str,
    inbound_domain: str,
    v: Version,
    birthday: date,
    day: date,
    streak: Streak | None = None,
    last_year: LastYear | None = None,
    forecast: str | None = None,
    welcome: str | None = None,
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_header(from_addr)
    msg["To"] = to
    msg["Reply-To"] = formataddr(("Release Notes", reply_address(token, inbound_domain)))
    msg["Subject"] = subject(v)
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[1])
    # One-click unsubscribe (RFC 8058): the mail app POSTs this; web.py stops
    # the emails. The day's reply token names the person.
    msg["List-Unsubscribe"] = f"<{APP}/api/unsubscribe?t={token}>"
    msg["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    # Exchange: no out-of-office or other automatic replies to this.
    msg["X-Auto-Response-Suppress"] = "OOF, AutoReply"
    msg.set_content(body(v, birthday, streak, last_year, forecast, welcome, token))
    msg.add_alternative(html_body(v, birthday, day, streak, last_year, forecast, welcome, token), subtype="html")
    return msg
