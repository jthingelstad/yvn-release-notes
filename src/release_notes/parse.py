"""Turn a reply email into the text of a release note.

Standard library only. The raw message stays in S3 untouched, so anything
this gets wrong can be re-parsed later. Phase 1 keeps text and lists the
attachments without opening them; images and audio are a later phase that
will read the same raw objects.
"""

import re
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from html.parser import HTMLParser


def parse_message(raw: bytes) -> EmailMessage:
    return BytesParser(policy=policy.default).parsebytes(raw)


# --- body text -------------------------------------------------------------

def body_text(msg: EmailMessage) -> str:
    return _text(msg).strip()


def _is_attachment(part) -> bool:
    return part.get_content_disposition() == "attachment"


def _text(part) -> str:
    if part.is_multipart():
        subs = list(part.iter_parts())
        if part.get_content_type() == "multipart/alternative":
            # Prefer the plain alternative. Clients that send one write it
            # themselves and it is far easier to strip quotes from.
            for sub in subs:
                if sub.get_content_type() == "text/plain" and not _is_attachment(sub):
                    return _text(sub)
            return _text(subs[-1]) if subs else ""
        # multipart/mixed and /related: Apple Mail splits text around an
        # inline image into several text parts, so join them all.
        return "\n".join(t.strip("\n") for t in (_text(s) for s in subs) if t.strip())
    if _is_attachment(part):
        return ""
    ctype = part.get_content_type()
    try:
        content = part.get_content()
    except (LookupError, UnicodeDecodeError):
        payload = part.get_payload(decode=True) or b""
        content = payload.decode("utf-8", errors="replace")
    if ctype == "text/plain":
        return content
    if ctype == "text/html":
        return html_to_text(content)
    return ""


class _HTMLText(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "hr"}
    SKIP = {"script", "style", "head", "title", "blockquote"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip_depth = 0
        self.stack: list[tuple[str, bool]] = []
        # Links as mail apps write them into plain text, `words <url>`, so an
        # HTML-only reply keeps its addresses; `anchors` maps url -> words.
        self.open_links: list[tuple[int, str]] = []
        self.anchors: dict[str, str] = {}

    def _skips(self, tag, attrs) -> bool:
        if tag in self.SKIP:
            return True
        a = dict(attrs)
        cls = a.get("class") or ""
        ident = a.get("id") or ""
        # Gmail, Outlook and Yahoo wrap the quoted original in these.
        return (
            "gmail_quote" in cls
            or "yahoo_quoted" in cls
            or ident in ("divRplyFwdMsg", "appendonsend")
        )

    def handle_starttag(self, tag, attrs):
        if tag == "a" and not self.skip_depth:
            self.open_links.append((len(self.out), (dict(attrs).get("href") or "").strip()))
        if tag in ("br", "hr", "img", "meta", "link", "input"):
            if not self.skip_depth and tag in self.BLOCK:
                self.out.append("\n")
            return
        skips = self._skips(tag, attrs)
        self.stack.append((tag, skips))
        if skips:
            self.skip_depth += 1
        elif not self.skip_depth and tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag == "a" and self.open_links and not self.skip_depth:
            start, href = self.open_links.pop()
            words = re.sub(r"\s+", " ", "".join(self.out[start:]).replace("\xa0", " ")).strip()
            if re.match(r"https?://", href, re.IGNORECASE) and words and not re.match(r"https?://", words, re.IGNORECASE):
                self.anchors.setdefault(href, words)
                self.out.append(f" <{href}>")
        while self.stack:
            open_tag, skipped = self.stack.pop()
            if skipped:
                self.skip_depth -= 1
            if open_tag == tag:
                break
        if not self.skip_depth and tag in self.BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if not self.skip_depth:
            self.out.append(data)


def _html(html: str) -> "_HTMLText":
    p = _HTMLText()
    p.feed(html)
    p.close()
    return p


def html_to_text(html: str) -> str:
    text = "".join(_html(html).out).replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


# --- quote and signature stripping ----------------------------------------

_ON_LINE = re.compile(r"^On\b.+", re.IGNORECASE)
_WROTE = re.compile(r"\bwrote:\s*$", re.IGNORECASE)
_SEPARATORS = re.compile(r"^(-{2,}\s*Original Message\s*-{2,}|_{10,}|-{10,})$", re.IGNORECASE)
_HEADER_FROM = re.compile(r"^\*?From:\*?\s", re.IGNORECASE)
_HEADER_NEXT = re.compile(r"^\*?(Sent|Date|To|Subject):\*?\s", re.IGNORECASE)
_MOBILE_SIG = re.compile(
    r"^(Sent from my \w[\w ]*|Sent from (Fastmail|Gmail|Mail|Outlook|Yahoo Mail)\b.*|"
    r"Get Outlook for \w+.*|Sent via .+)$",
    re.IGNORECASE,
)


def strip_reply(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cut = len(lines)
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith(">"):
            cut = i
            break
        if _ON_LINE.match(s):
            # Gmail and Apple wrap a long attribution over two or three lines.
            joined = ""
            for l in lines[i : i + 4]:
                joined = f"{joined} {l.strip()}".strip()
                if _WROTE.search(joined):
                    break
            if _WROTE.search(joined) and len(joined) < 400:
                cut = i
                break
        if _SEPARATORS.match(s):
            cut = i
            break
        if _HEADER_FROM.match(s) and any(_HEADER_NEXT.match(l.strip()) for l in lines[i + 1 : i + 4]):
            cut = i
            break
    lines = lines[:cut]

    # A conventional "-- " signature separator ends the note.
    for i, line in enumerate(lines):
        if line in ("-- ", "--"):
            lines = lines[:i]
            break

    while lines and (not lines[-1].strip() or _MOBILE_SIG.match(lines[-1].strip())):
        lines.pop()
    while lines and not lines[0].strip():
        lines.pop(0)
    return "\n".join(l.rstrip() for l in lines)


def note_text(msg: EmailMessage) -> str:
    return strip_reply(body_text(msg))


def anchors(msg: EmailMessage) -> dict[str, str]:
    """The words each address was linked from in the reply's HTML, for
    links.collect. Quoted text is skipped with everything else."""
    found: dict[str, str] = {}
    for part in msg.walk():
        if part.get_content_type() != "text/html" or _is_attachment(part):
            continue
        try:
            html = part.get_content()
        except (LookupError, UnicodeDecodeError):
            html = (part.get_payload(decode=True) or b"").decode("utf-8", errors="replace")
        for url, words in _html(html).anchors.items():
            found.setdefault(url, words)
    return found


# --- attachments (listed, not stored, in phase 1) --------------------------

def attachments(msg: EmailMessage) -> list[dict]:
    found = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        ctype = part.get_content_type()
        disposition = part.get_content_disposition()
        # Body text is the note; everything else (images, audio, files,
        # including inline ones) is listed so a later phase can find it.
        if disposition != "attachment" and ctype.startswith("text/"):
            continue
        payload = part.get_payload(decode=True) or b""
        found.append(
            {
                "content_type": ctype,
                "filename": part.get_filename() or "",
                "size": len(payload),
            }
        )
    return found
