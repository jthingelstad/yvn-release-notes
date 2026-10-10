"""Links in notes: found in the text, named once, shown by name.

A note's text keeps every address exactly as it was written. Beside it, the
note carries `links`: [{"url", "title", "site"}] for the addresses it names,
and {"url", "title", "named": True} for one the writer named themselves (a
mail app writes a linked phrase into the plain text as `my post <url>`; the
HTML part says which words were linked). Jamie, 2026-10-08: a link "shouldn't
be raw", and no Markdown.

Titles are fetched once, when the note is written (email or web, and again
when an edit adds an address), so a title outlives the page. The fetch is
guarded, because the address is whatever someone typed:

- http or https on the usual port, no user:password@, at most three
  redirects, each one checked again;
- every address the host resolves to must be public, and the connection goes
  to the address that was checked (no second lookup to rebind);
- two seconds in all by the wall clock, the lookup, the connection, the
  headers and the body together, the first 256 KB, HTML only; three
  fetches a note, so a note's titles take six seconds at most;
- any failure is just no title: the address shows short instead.

segments() splits a note's text into text and links for the email and the
web app alike, so both show a link the same way.
"""

import http.client
import ipaddress
import re
import socket
import ssl
import threading
import time
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

URL = re.compile(r"<?(https?://[^\s<>\"]+)>?", re.IGNORECASE)
URL_TAIL = ".,;:!?'\")]}"  # sentence punctuation after an address, not part of it

MAX_FETCHES = 3  # per note
TIMEOUT = 2.0
MAX_BYTES = 256 * 1024
MAX_REDIRECTS = 3
MAX_TITLE = 200
AGENT = "ReleaseNotes/1.0 (+https://notes.yourversionnumber.com/)"
PORTS = {"http": 80, "https": 443}


# --- finding ---------------------------------------------------------------------

def _matches(text: str):
    """(start, end, url, bracketed) for each address. `<url>` takes its
    brackets with it; a bare address leaves trailing punctuation behind."""
    for m in URL.finditer(text):
        whole = m.group(0)
        if whole.startswith("<") and whole.endswith(">"):
            yield m.start(), m.end(), m.group(1), True
        else:
            url = m.group(1).rstrip(URL_TAIL)
            if url:
                yield m.start(1), m.start(1) + len(url), url, False


def urls(text: str) -> list[str]:
    seen: list[str] = []
    for _, _, url, _ in _matches(text):
        if url not in seen:
            seen.append(url)
    return seen


def short(url: str) -> str:
    return re.sub(r"^https?://(www\.)?", "", url, flags=re.IGNORECASE).rstrip("/")


def clean(value: str, limit: int) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    if len(value) > limit:
        value = value[:limit].rsplit(" ", 1)[0].rstrip() + "…"
    return value


def _words(words: str) -> str:
    """A pattern for `words` however the text wrapped them."""
    return r"\s+".join(re.escape(w) for w in words.split())


def _named_in(text: str, words: str, url: str) -> bool:
    return bool(words) and re.search(_words(words) + r"\s*<" + re.escape(url) + ">", text) is not None


def collect(text: str, named: dict[str, str] | None = None, keep: list[dict] | None = None, fetch=None) -> list[dict]:
    """The links for a note's text. `named` maps an address to the words a
    mail app linked to it; `keep` is what the note had before an edit, reused
    rather than fetched again. Never raises."""
    fetch = fetch or fetch_title
    named, old = named or {}, {l["url"]: l for l in keep or []}
    out, fetched = [], 0
    for url in urls(text):
        words = clean(named.get(url, ""), MAX_TITLE)
        was = old.get(url)
        if _named_in(text, words, url):
            out.append({"url": url, "title": words, "named": True})
        elif was and not (was.get("named") and not _named_in(text, was.get("title", ""), url)):
            out.append(was)  # an edit that took a named link's words away fetches it instead
        elif fetched < MAX_FETCHES:
            fetched += 1
            try:
                meta = fetch(url)
            except Exception:
                meta = None
            if meta:
                out.append({"url": url, **meta})
    return out


# --- showing ---------------------------------------------------------------------

def segments(text: str, links: list[dict] | None) -> list:
    """The text as a list of strings and links, {"url", "label", "site"?}.
    A named link takes the words in front of `<url>`; a fetched one replaces
    the address with its title and site; any other shows short."""
    by_url = {l["url"]: l for l in links or [] if l.get("url")}
    out: list = []
    pos = 0
    for start, end, url, bracketed in _matches(text):
        link = by_url.get(url) or {}
        before = text[pos:start]
        name = re.search(_words(link.get("title", "")) + r"\s*$", before) if link.get("named") and link.get("title") and bracketed else None
        if name:
            out += [before[:name.start()], {"url": url, "label": link["title"]}]
        elif link.get("title") and not link.get("named"):
            out += [before, {"url": url, "label": link["title"], "site": link.get("site", "")}]
        else:
            out += [before, {"url": url, "label": short(url)}]
        pos = end
    out.append(text[pos:])
    return [s for s in out if s]


def plain(text: str, links: list[dict] | None) -> str:
    """The text with titles in, as mail apps write a link: `title <url>`."""
    parts = []
    for s in segments(text, links):
        parts.append(s if isinstance(s, str) else f"{s['label']} <{s['url']}>")
    return "".join(parts)


def markdown(text: str, links: list[dict] | None) -> str:
    parts = []
    for s in segments(text, links):
        parts.append(s if isinstance(s, str) else f"[{s['label']}]({s['url']})")
    return "".join(parts)


# --- fetching --------------------------------------------------------------------

def _public_ip(host: str, port: int, resolve) -> str | None:
    """The address to connect to, if every address the host has is public."""
    try:
        infos = resolve(host, port, type=socket.SOCK_STREAM)
    except (OSError, UnicodeError):
        return None
    ips = []
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%", 1)[0])
        mapped = getattr(ip, "ipv4_mapped", None)
        for one in (ip, mapped) if mapped else (ip,):
            if not one.is_global or one.is_multicast:
                return None
        ips.append(str(ip))
    return ips[0] if ips else None


def _target(url: str):
    """(scheme, host, port, path) for an address we may fetch, else None."""
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return None
    scheme = parts.scheme.lower()
    if scheme not in PORTS or not parts.hostname or parts.username or parts.password:
        return None
    if port not in (None, PORTS[scheme]):
        return None
    path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    return scheme, parts.hostname, PORTS[scheme], path


class _HTTP(http.client.HTTPConnection):
    def __init__(self, host, ip, port, timeout):
        super().__init__(host, port, timeout=timeout)
        self.ip = ip

    def connect(self):
        self.sock = socket.create_connection((self.ip, self.port), self.timeout)


class _HTTPS(http.client.HTTPSConnection):
    def __init__(self, host, ip, port, timeout):
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self.ip = ip

    def connect(self):
        sock = socket.create_connection((self.ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _connect(scheme, host, ip, port, timeout):
    return (_HTTPS if scheme == "https" else _HTTP)(host, ip, port, timeout)


def fetch_title(url: str, *, resolve=socket.getaddrinfo, connect=_connect, clock=time.monotonic,
                limit: float = TIMEOUT) -> dict | None:
    """{"title", "site"} for a page, or None. Never raises, and never takes
    more than `limit` seconds by the wall clock.

    The socket timeouts alone do not hold that: the lookup has none, and a
    server that trickles its headers a byte at a time never lets one read
    time out. So the fetch runs on a daemon thread, and once the time is up
    it is left behind with its socket shut, and this answers no title. That
    works the same in Lambda and in the dev server's threads."""
    box: dict = {}
    opened: list = []
    late = threading.Event()

    def run():
        box["meta"] = _fetch(url, resolve, _tracked(connect, opened, late), clock)

    worker = threading.Thread(target=run, name="link-title", daemon=True)
    worker.start()
    worker.join(limit)
    if worker.is_alive():
        late.set()
        for conn in list(opened):
            _shut(conn)
        return None
    return box.get("meta")


def _tracked(connect, opened: list, late: threading.Event):
    """connect, noting each connection so a fetch out of time can be cut,
    and opening none once it is."""
    def call(*args):
        if late.is_set():
            raise TimeoutError("out of time")
        conn = connect(*args)
        opened.append(conn)
        return conn
    return call


def _shut(conn) -> None:
    # shutdown wakes a read blocked on the socket; close alone may not.
    sock = getattr(conn, "sock", None)
    try:
        if sock is not None:
            sock.shutdown(socket.SHUT_RDWR)
    except OSError:
        pass
    try:
        conn.close()
    except Exception:
        pass


def _fetch(url: str, resolve, connect, clock) -> dict | None:
    deadline = clock() + TIMEOUT
    try:
        for _ in range(MAX_REDIRECTS + 1):
            target = _target(url)
            if not target:
                return None
            scheme, host, port, path = target
            ip = _public_ip(host, port, resolve)
            left = deadline - clock()
            if not ip or left <= 0:
                return None
            conn = connect(scheme, host, ip, port, left)
            try:
                conn.request("GET", path, headers={"User-Agent": AGENT, "Accept": "text/html", "Accept-Encoding": "identity"})
                resp = conn.getresponse()
                if resp.status in (301, 302, 303, 307, 308):
                    location = resp.getheader("Location")
                    if not location:
                        return None
                    url = urljoin(url, location)
                    continue
                ctype = (resp.getheader("Content-Type") or "").lower()
                if resp.status != 200 or "html" not in ctype:
                    return None
                body = _read(resp, deadline, clock, getattr(conn, "sock", None))
            finally:
                conn.close()
            return page_meta(body, ctype, host)
    except Exception:
        return None
    return None


def _read(resp, deadline, clock, sock=None) -> bytes:
    chunks, size = [], 0
    while size < MAX_BYTES and clock() < deadline:
        if sock:
            sock.settimeout(max(deadline - clock(), 0.01))  # no one read outlasts the deadline
        chunk = resp.read1(min(65536, MAX_BYTES - size)) if hasattr(resp, "read1") else resp.read(MAX_BYTES - size)
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    return b"".join(chunks)


# --- reading a page --------------------------------------------------------------

class _Meta(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: list[str] | None = None
        self.done_title = False

    def handle_starttag(self, tag, attrs):
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or "").lower()
            if key in ("og:title", "og:site_name", "twitter:title") and key not in self.meta:
                self.meta[key] = a.get("content", "")
        elif tag == "title" and not self.done_title:
            self.title = []

    def handle_endtag(self, tag):
        if tag == "title" and self.title is not None:
            self.meta.setdefault("title", "".join(self.title))
            self.title, self.done_title = None, True

    def handle_data(self, data):
        if self.title is not None:
            self.title.append(data)


def _charset(body: bytes, ctype: str) -> str:
    m = re.search(r"charset=[\"']?([\w-]+)", ctype) or re.search(rb"<meta[^>]+charset=[\"']?([\w-]+)", body[:4096], re.I)
    name = m.group(1) if m else "utf-8"
    name = name.decode("ascii", "replace") if isinstance(name, bytes) else name
    try:
        "".encode(name)
        return name
    except LookupError:
        return "utf-8"


def page_meta(body: bytes, ctype: str, host: str) -> dict | None:
    p = _Meta()
    p.feed(body.decode(_charset(body, ctype), errors="replace"))
    m = p.meta
    title = clean(m.get("og:title") or m.get("twitter:title") or m.get("title") or "", MAX_TITLE)
    if not title:
        return None
    site = clean(m.get("og:site_name") or re.sub(r"^www\.", "", host.lower()), 100)
    return {"title": title, "site": site}
