"""The daily email: one message per subscriber per day, plain text and HTML.
(And, at the end, the short note inbound sends back when a reply comes in
too late, `late_message`.)

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
- Under the streak, one quiet line of lifetime counts: notes, days, photos
  and the year they began (Jamie, 2026-10-09: "a good reminder of
  creating value").
- "On this day" (Jamie, 2026-10-09, option A of the design session) shows
  every earlier release with notes for today's patch number
  (version.same_day_before), newest first, after the streak, only when
  there are some. The first SHOWN each get a block sharing PAST_MAX
  characters, with that day's tags on their own line as links to their
  pages (Jamie: "just have the tags on the posts", no trip counts or tag
  anniversaries); a closing line of hashtags alone is left out of the
  words, so no tag shows twice. The rest are year links. One read of every
  note's key and media (Store.note_index) gives the counts and which days
  have notes; only the shown days are read whole. Links in notes show by name (links.py): the words the writer
  linked, or the page title saved when the note was written, else the
  short address.
- Weather (weather.py) is one quiet line of today's forecast under the
  date, and each past day's weather in "On this day", both as text; the footer
  credits Open-Meteo whenever either shows. Without it, the email is the
  same as ever.
"""

import re
import secrets
from dataclasses import dataclass
from base64 import b32encode
from datetime import date
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html import escape

from . import links, tags, weather
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
# MailMetrics destination): "daily" from the sender, "account" for the rest
# (sign-in and delete codes from the web app, inbound's note that a reply
# came too late). A count, never a person.
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


# --- on this day -----------------------------------------------------------------

PAST_MAX = 1000  # characters of past notes in all, shared by the days shown
SHOWN = 4  # past days with a block; any more are year links


@dataclass(frozen=True)
class PastDay:
    """One earlier release's day: its notes' text, their links, how many
    photos and recordings (media.counts), its weather as a line if it was
    kept, and its tags. The email never carries a file: it links to the day."""
    day: date
    text: str
    links: list | None = None
    files: dict | None = None
    sky: str | None = None
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class OnThisDay:
    shown: tuple[PastDay, ...]  # newest first, at most SHOWN
    more: tuple[date, ...] = ()  # the older days beyond those, newest first

    @property
    def count(self) -> int:
        return len(self.shown) + len(self.more)


@dataclass(frozen=True)
class Lifetime:
    notes: int
    days: int
    photos: int
    since: int  # the year of the first note


def count_phrase(n: int, one: str, many: str) -> str:
    return f"{n:,} {one if n == 1 else many}"


def lifetime_line(life: Lifetime) -> str:
    """'1,064 notes across 908 days since 2011, and 847 photos.'"""
    line = f"{count_phrase(life.notes, 'note', 'notes')} across {count_phrase(life.days, 'day', 'days')} since {life.since}"
    return line + (f", and {count_phrase(life.photos, 'photo', 'photos')}." if life.photos else ".")


def past_text(text: str, limit: int = PAST_MAX) -> tuple[str, bool]:
    """Past notes, cut between words near `limit`. True if cut."""
    if len(text) <= limit:
        return text, False
    return text[:limit].rsplit(None, 1)[0].rstrip(), True


def past_link(day: date) -> str:
    return f"{APP}/day/?d={day.isoformat()}"


def tag_link(tag: str) -> str:
    return f"{APP}/tag/?t={tag}"


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


def years_ago(v: Version, then: Version) -> str:
    n = v.age - then.age
    return "A year ago" if n == 1 else f"{n} years ago"


def section_lede(v: Version, past: OnThisDay) -> str:
    n = past.count
    return f"{'One earlier release has' if n == 1 else f'{n} earlier releases have'} notes for day {v.patch}."


def budget(past: OnThisDay) -> int:
    return PAST_MAX // max(1, len(past.shown))


def shown_text(p: PastDay, limit: int) -> tuple[str, bool]:
    """The words shown for a past day: its closing tag lines left off (they
    show as the tag line), cut near `limit`."""
    return past_text(tags.without_closing(p.text), limit)


def past_body(v: Version, birthday: date, past: OnThisDay) -> str:
    out = [f"On this day: {section_lede(v, past)}\n\n"]
    for p in past.shown:
        then = compute_version(birthday, p.day)
        shown, cut = shown_text(p, budget(past))
        shown = links.plain(shown, p.links)
        out.append(
            f"{years_ago(v, then)} you were {then} ({long_date(p.day)}, {p.day.year}):\n"
            + (f"{p.sky}.\n" if p.sky else "")
            + "\n"
            + (f"{shown}{' ...' if cut else ''}\n\n" if shown else "")
            + (" ".join(f"#{t}" for t in p.tags) + "\n\n" if p.tags else "")
            + f"{past_more(cut, p.files)}: {past_link(p.day)}\n\n"
        )
    if past.more:
        out.append(f"And {len(past.more)} more:\n" + "".join(f"{d.year}: {past_link(d)}\n" for d in past.more) + "\n")
    return "".join(out)


def credited(forecast: str | None, past: OnThisDay | None) -> bool:
    return bool(forecast or (past and any(p.sky for p in past.shown)))


def unsubscribe_link(token: str) -> str:
    # The page asks before stopping, so a link scanner opening it stops nothing.
    return f"{APP}/unsubscribe/#t={token}"


def body(v: Version, birthday: date, streak: Streak | None = None, past: OnThisDay | None = None,
         forecast: str | None = None, welcome: str | None = None, token: str | None = None,
         lifetime: Lifetime | None = None) -> str:
    opening = f"You're {v} today."
    if line := birthday_line(v):
        opening = f"{opening} {line}"
    if forecast:
        opening = f"{opening}\n{forecast}"
    if welcome:
        opening = f"{welcome}\n\n{opening}"
    streak_text = " ".join(streak_lines(v, streak)) + "\n" if streak else ""
    if lifetime:
        streak_text += lifetime_line(lifetime) + "\n"
    if streak_text:
        streak_text += "\n"
    if past:
        streak_text += past_body(v, birthday, past)
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
        + (f"{weather.CREDIT}: {weather.CREDIT_URL}\n" if credited(forecast, past) else "")
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


def streak_html(v: Version, birthday: date, s: Streak | None, life: Lifetime | None = None) -> str:
    """The streak, then the lifetime counts under it, quietly."""
    if not (s or life):
        return ""
    parts = []
    if s:
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
        if s.days:
            parts.append(f'<p class="streak-row" style="margin:0 0 8px;font-family:{MONO};font-size:17px;line-height:1.5;'
                         f'letter-spacing:-0.02em;">{past}{today}</p>\n')
        head, tail = streak_lines(v, s)
        parts.append(f'''<p class="ink-2" style="margin:0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
<strong class="ink" style="color:{INK};">{escape(head)}</strong> {"&nbsp;".join(escape(tail).rsplit(" ", 1))}
</p>
''')
    if life:
        parts.append(f'<p class="ink-2" style="margin:{10 if s else 0}px 0 0;font-family:{FONT};font-size:15px;line-height:1.45;'
                     f'color:{INK_2};">{ascii_html(lifetime_line(life))}</p>\n')
    return f'<tr><td style="padding:36px 0 0;">\n{"".join(parts)}</td></tr>\n'


def past_day_html(v: Version, birthday: date, p: PastDay, limit: int) -> str:
    then = compute_version(birthday, p.day)
    sky_html = (
        f'<p class="ink-2" style="margin:0 0 12px;font-family:{FONT};font-size:14px;line-height:1.45;color:{INK_2};">'
        f"{ascii_html(p.sky)}</p>\n"
        if p.sky
        else ""
    )
    shown, cut = shown_text(p, limit)
    paras = [x.strip() for x in re.split(r"\n\s*\n", shown) if x.strip()]
    if cut and paras:
        paras[-1] += "\u2026"
    notes = "".join(
        f'<p class="ink" style="margin:0 0 12px;font-family:{FONT};font-size:17px;line-height:1.5;color:{INK};">'
        + "<br>".join(linked(line, p.links) for line in x.split("\n"))
        + "</p>\n"
        for x in paras
    )
    tag_html = (
        f'<p style="margin:0 0 10px;font-family:{FONT};font-size:14px;line-height:1.6;">'
        + " ".join(f'<a class="link" href="{escape(tag_link(t))}" style="color:{BLUE};text-decoration:none;">#{escape(t)}</a>'
                   for t in p.tags)
        + "</p>\n"
        if p.tags
        else ""
    )
    return f"""<p class="ink-2" style="margin:28px 0 6px;font-family:{FONT};font-size:14px;color:{INK_2};">
<strong class="ink" style="color:{INK};">{escape(years_ago(v, then))}</strong> &middot; {escape(long_date(p.day))}, {p.day.year}
</p>
<p style="margin:0 0 {8 if p.sky else 12}px;">{vnum_html(then, 26)}</p>
{sky_html}{notes}{tag_html}<p class="ink-2" style="margin:2px 0 0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">
<a class="link" href="{escape(past_link(p.day))}" style="color:{BLUE};font-weight:700;text-decoration:underline;">{escape(past_more(cut, p.files))}</a>
</p>
"""


def past_html(v: Version, birthday: date, past: OnThisDay) -> str:
    days = "".join(past_day_html(v, birthday, p, budget(past)) for p in past.shown)
    more = (
        f'<p class="ink-2" style="margin:24px 0 0;font-family:{FONT};font-size:15px;line-height:1.6;color:{INK_2};">'
        f"And {len(past.more)} more: "
        + " &middot; ".join(f'<a class="link" href="{escape(past_link(d))}" style="color:{BLUE};">{d.year}</a>' for d in past.more)
        + "</p>\n"
        if past.more
        else ""
    )
    return f"""<tr><td style="padding:48px 0 0;">
<p class="ink" style="margin:0 0 4px;font-family:{FONT};font-size:22px;line-height:1.2;font-weight:800;color:{INK};">On this day</p>
<p class="ink-2" style="margin:0;font-family:{FONT};font-size:15px;line-height:1.45;color:{INK_2};">{escape(section_lede(v, past))}</p>
{days}{more}</td></tr>
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
    v: Version, birthday: date, day: date, streak: Streak | None = None, past: OnThisDay | None = None,
    forecast: str | None = None, welcome: str | None = None, token: str | None = None,
    lifetime: Lifetime | None = None,
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
        if credited(forecast, past)
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

{streak_html(v, birthday, streak, lifetime)}
{past_html(v, birthday, past) if past else ""}
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
    past: OnThisDay | None = None,
    forecast: str | None = None,
    welcome: str | None = None,
    lifetime: Lifetime | None = None,
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
    msg.set_content(body(v, birthday, streak, past, forecast, welcome, token, lifetime))
    msg.add_alternative(html_body(v, birthday, day, streak, past, forecast, welcome, token, lifetime), subtype="html")
    return msg


# --- a late reply -----------------------------------------------------------------
# A reply address takes notes for 72 hours (inbound.REPLY_WINDOW). A reply
# after that gets this, once per email, so it never fails silently (Jamie,
# 2026-10-09). Shaped like the sign-in email: type on paper, nothing remote.
# It answers what they wrote, so it threads under it, and it is marked as an
# automatic reply (RFC 3834) so their mail app's own robots leave it alone.

_MSG_ID = re.compile(r"<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>")


def message_id(raw) -> str | None:
    """A Message-ID fit to repeat in In-Reply-To: one <id>, printable ASCII,
    of a sane length. Anything else is None, and the notice goes unthreaded."""
    value = str(raw or "").strip()
    return value if _MSG_ID.fullmatch(value) else None


def late_text(version: str, day: date) -> str:
    return f"""Your reply came in too late to be added to the release notes for {version},
{long_date(day)}, {day.year}. A day's email takes replies for 72 hours.

You can still add it on the web, on that day's page:

{past_link(day)}
"""


def late_html(version: str, day: date) -> str:
    p = f"margin:0 0 18px;font:16px/1.55 {FONT};color:{INK_2}"
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Too late for {escape(version)}</title></head>
<body style="margin:0;padding:0;background:{PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PAPER}"><tr><td style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td>
<p style="margin:0 0 24px;font:800 18px/1.3 {FONT};color:{INK}">Release Notes</p>
<p style="{p}">Your reply came in too late to be added to the release notes for <span style="font-family:{MONO};font-weight:700;color:{BLUE};white-space:nowrap">{escape(version)}</span>, {escape(long_date(day))}, {day.year}. A day&rsquo;s email takes replies for 72 hours.</p>
<p style="margin:0;font:800 22px/1.3 {FONT};color:{INK}"><a href="{escape(past_link(day))}" style="color:{BLUE}">Add it on the web, on that day&rsquo;s page</a></p>
</td></tr></table>
</td></tr></table>
</body></html>
"""


def late_message(*, to: str, from_addr: str, version: str, day: date, in_reply_to: str | None) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = from_header(from_addr)
    msg["To"] = to
    msg["Subject"] = f"Re: You're {version} today"
    msg["Message-ID"] = make_msgid(domain=from_addr.split("@", 1)[1])
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        msg["References"] = in_reply_to
    # RFC 3834: a machine's answer. Mail apps and servers do not answer it
    # (no out-of-office loop), and inbound ignores one that comes back.
    msg["Auto-Submitted"] = "auto-replied"
    msg["X-Auto-Response-Suppress"] = "OOF, AutoReply"
    msg.set_content(late_text(version, day))
    msg.add_alternative(late_html(version, day), subtype="html")
    return msg
