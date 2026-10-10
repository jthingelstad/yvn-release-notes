import socket
import threading
import time
import unittest

from release_notes import links
from release_notes.links import collect, fetch_title, markdown, page_meta, plain, segments, short


def resolver(table):
    """A getaddrinfo that answers from `table`: host -> [ip, ...]."""
    def resolve(host, port, type=None):
        if host not in table:
            raise socket.gaierror("no such host")
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))
                for ip in table[host]]
    return resolve


class Resp:
    def __init__(self, status=200, headers=None, body=b""):
        self.status, self.headers, self.body = status, {k.lower(): v for k, v in (headers or {}).items()}, body

    def getheader(self, name):
        return self.headers.get(name.lower())

    def read1(self, n):
        chunk, self.body = self.body[:n], self.body[n:]
        return chunk


class Web:
    """A connect() that serves pages by (host, path) and records each
    connection: (scheme, host, ip, port)."""
    def __init__(self, pages):
        self.pages, self.opened = pages, []

    def __call__(self, scheme, host, ip, port, timeout):
        self.opened.append((scheme, host, ip, port))
        web = self

        class Conn:
            def request(self, method, path, headers):
                self.path = path
                assert headers["User-Agent"] == links.AGENT

            def getresponse(self):
                return web.pages[(host, self.path)]

            def close(self):
                pass

        return Conn()


def page(title="", extra=b"", ctype="text/html; charset=utf-8"):
    return Resp(200, {"Content-Type": ctype}, b"<html><head><title>" + title.encode() + b"</title>" + extra + b"</head></html>")


PUBLIC = {"example.com": ["93.184.216.34"], "www.example.com": ["93.184.216.34"], "other.example": ["2606:2800:220:1::1"]}


class Fetch(unittest.TestCase):
    def fetch(self, url, pages, table=PUBLIC):
        self.web = Web(pages)
        return fetch_title(url, resolve=resolver(table), connect=self.web)

    def test_title_and_site(self):
        meta = self.fetch("https://www.example.com/post/?a=1", {
            ("www.example.com", "/post/?a=1"): page("Plain title", b'<meta property="og:title" content="A &amp; B">'),
        })
        self.assertEqual(meta, {"title": "A & B", "site": "example.com"})
        self.assertEqual(self.web.opened, [("https", "www.example.com", "93.184.216.34", 443)])

    def test_follows_redirects_checking_each(self):
        meta = self.fetch("http://example.com/a", {
            ("example.com", "/a"): Resp(301, {"Location": "https://other.example/b"}),
            ("other.example", "/b"): page("Landed"),
        })
        self.assertEqual(meta, {"title": "Landed", "site": "other.example"})
        self.assertEqual([o[3] for o in self.web.opened], [80, 443])

    def test_a_redirect_inward_is_refused(self):
        table = dict(PUBLIC, **{"inside.example": ["10.0.0.5"]})
        meta = self.fetch("https://example.com/a", {
            ("example.com", "/a"): Resp(302, {"Location": "http://inside.example/admin"}),
        }, table)
        self.assertIsNone(meta)
        self.assertEqual(len(self.web.opened), 1)
        for location in ("http://169.254.169.254/latest/meta-data/", "ftp://example.com/", "https://example.com:8443/"):
            meta = self.fetch("https://example.com/a", {("example.com", "/a"): Resp(302, {"Location": location})})
            self.assertIsNone(meta, location)
            self.assertEqual(len(self.web.opened), 1, location)

    def test_at_most_three_redirects(self):
        pages = {("example.com", f"/{i}"): Resp(302, {"Location": f"/{i + 1}"}) for i in range(4)}
        pages[("example.com", "/3")] = page("Three")
        self.assertEqual(self.fetch("https://example.com/0", pages)["title"], "Three")
        pages[("example.com", "/3")] = Resp(302, {"Location": "/4"})
        pages[("example.com", "/4")] = page("Four")
        self.assertIsNone(self.fetch("https://example.com/0", pages))
        self.assertEqual(len(self.web.opened), 4)

    def test_only_html_on_a_200(self):
        self.assertIsNone(self.fetch("https://example.com/f.pdf", {("example.com", "/f.pdf"): page("x", ctype="application/pdf")}))
        self.assertIsNone(self.fetch("https://example.com/gone", {("example.com", "/gone"): Resp(404, {"Content-Type": "text/html"})}))
        self.assertIsNone(self.fetch("https://example.com/untitled", {("example.com", "/untitled"): page("  ")}))

    def test_failures_are_no_title(self):
        def boom(*a):
            raise ConnectionResetError
        self.assertIsNone(fetch_title("https://example.com/", resolve=resolver(PUBLIC), connect=boom))
        self.assertIsNone(fetch_title("https://nowhere.example/", resolve=resolver(PUBLIC), connect=boom))

    def test_out_of_time_before_connecting(self):
        ticks = iter([0.0, 5.0])
        web = Web({})
        self.assertIsNone(fetch_title("https://example.com/", resolve=resolver(PUBLIC), connect=web, clock=lambda: next(ticks)))
        self.assertEqual(web.opened, [])

    def test_a_server_that_trickles_its_headers_is_cut_off(self):
        # Each byte comes in under the socket's timeout, so only the wall
        # clock stops it: no title, on time, and the connection shut.
        release, closed = threading.Event(), []

        class Trickle:
            sock = None

            def request(self, method, path, headers):
                pass

            def getresponse(self):
                release.wait(10)
                return page("Too late")

            def close(self):
                closed.append(True)

        start = time.monotonic()
        self.assertIsNone(fetch_title("https://example.com/", resolve=resolver(PUBLIC), connect=lambda *a: Trickle(), limit=0.2))
        self.assertLess(time.monotonic() - start, 2)
        self.assertEqual(closed, [True])
        release.set()

    def test_a_lookup_that_hangs_is_cut_off(self):
        release = threading.Event()

        def slow(host, port, type=None):
            release.wait(10)
            return resolver(PUBLIC)(host, port, type)

        start = time.monotonic()
        self.assertIsNone(fetch_title("https://example.com/", resolve=slow, connect=Web({}), limit=0.2))
        self.assertLess(time.monotonic() - start, 2)
        release.set()

    def test_the_whole_fetch_has_one_limit(self):
        self.assertEqual(links.TIMEOUT, 2.0)
        self.assertEqual(fetch_title.__kwdefaults__["limit"], links.TIMEOUT)


class Guards(unittest.TestCase):
    def test_targets(self):
        self.assertEqual(links._target("https://example.com"), ("https", "example.com", 443, "/"))
        self.assertEqual(links._target("HTTP://Example.com:80/a?b=c#d"), ("http", "example.com", 80, "/a?b=c"))
        for url in ("ftp://example.com/", "file:///etc/passwd", "https://user:pw@example.com/", "https://u@example.com/",
                    "https://example.com:22/", "http://example.com:443/", "https://example.com:99999/", "https:///x"):
            self.assertIsNone(links._target(url), url)

    def test_only_public_addresses(self):
        for ips in (["127.0.0.1"], ["10.1.2.3"], ["192.168.1.1"], ["172.16.0.1"], ["169.254.169.254"], ["100.64.0.1"],
                    ["0.0.0.0"], ["::1"], ["fe80::1%en0"], ["fd00::1"], ["::ffff:127.0.0.1"], ["::ffff:10.0.0.1"],
                    ["224.0.0.1"], ["ff02::1"], ["93.184.216.34", "10.0.0.1"], []):
            self.assertIsNone(links._public_ip("h.example", 443, resolver({"h.example": ips})), ips)
        self.assertEqual(links._public_ip("h.example", 443, resolver({"h.example": ["93.184.216.34", "2606:2800:220:1::1"]})),
                         "93.184.216.34")
        self.assertIsNone(links._public_ip("missing.example", 443, resolver({})))


class Meta(unittest.TestCase):
    def test_prefers_open_graph_then_twitter_then_title(self):
        def meta(head):
            return page_meta(b"<html><head>" + head + b"</head><body><title>not this</title></body></html>", "text/html", "www.Example.com")
        self.assertEqual(meta(b'<title>T</title><meta name="twitter:title" content="Tw"><meta property="og:title" content="OG">'
                              b'<meta property="og:site_name" content="The Site">'), {"title": "OG", "site": "The Site"})
        self.assertEqual(meta(b'<title>T</title><meta name="twitter:title" content="Tw">'), {"title": "Tw", "site": "example.com"})
        self.assertEqual(meta(b"<title>\n  Fish &amp;\n chips </title>"), {"title": "Fish & chips", "site": "example.com"})
        self.assertIsNone(page_meta(b"<html><body>No title.</body></html>", "text/html", "x.example"))

    def test_charset_from_header_or_meta(self):
        body = "<title>Café</title>".encode("latin-1")
        self.assertEqual(page_meta(body, "text/html; charset=ISO-8859-1", "x.example")["title"], "Café")
        self.assertEqual(page_meta(b'<meta charset="iso-8859-1">' + body, "text/html", "x.example")["title"], "Café")
        self.assertEqual(page_meta(b'<meta charset="nonsense">' + "<title>Café</title>".encode(), "text/html", "x.example")["title"], "Café")

    def test_long_titles_are_cut_between_words(self):
        title = page_meta(b"<title>" + b"word " * 100 + b"</title>", "text/html", "x.example")["title"]
        self.assertTrue(title.endswith("word…"))
        self.assertLessEqual(len(title), links.MAX_TITLE + 1)


class Collect(unittest.TestCase):
    def setUp(self):
        self.asked = []

    def fetch(self, url):
        self.asked.append(url)
        if "boom" in url:
            raise RuntimeError
        return {"title": f"Title {len(self.asked)}", "site": "example.com"} if "none" not in url else None

    def test_fetches_each_address_once_in_order(self):
        found = collect("See https://example.com/a, then <https://example.com/b>. Again: https://example.com/a", fetch=self.fetch)
        self.assertEqual(found, [{"url": "https://example.com/a", "title": "Title 1", "site": "example.com"},
                                 {"url": "https://example.com/b", "title": "Title 2", "site": "example.com"}])

    def test_at_most_three_fetches_and_failures_are_skipped(self):
        text = " ".join(f"https://example.com/{p}" for p in ("boom", "none", "c", "d", "e"))
        found = collect(text, fetch=self.fetch)
        self.assertEqual(self.asked, ["https://example.com/boom", "https://example.com/none", "https://example.com/c"])
        self.assertEqual([l["url"] for l in found], ["https://example.com/c"])

    def test_named_links_are_not_fetched(self):
        text = "Wrote it up in my post <https://example.com/p> today."
        found = collect(text, {"https://example.com/p": "my post"}, fetch=self.fetch)
        self.assertEqual(found, [{"url": "https://example.com/p", "title": "my post", "named": True}])
        self.assertEqual(self.asked, [])
        # The words must still be in front of the address (an edit can take them away).
        found = collect("Wrote it up: https://example.com/p", {"https://example.com/p": "my post"}, fetch=self.fetch)
        self.assertEqual(found[0]["title"], "Title 1")

    def test_named_words_may_wrap(self):
        text = "Wrote it up in my\n post <https://example.com/p>."
        found = collect(text, {"https://example.com/p": "my post"}, fetch=self.fetch)
        self.assertEqual(found, [{"url": "https://example.com/p", "title": "my post", "named": True}])
        self.assertEqual(segments(text, found), ["Wrote it up in ", {"url": "https://example.com/p", "label": "my post"}, "."])

    def test_an_edit_keeps_what_it_had(self):
        old = [{"url": "https://example.com/a", "title": "Kept", "site": "example.com"},
               {"url": "https://example.com/gone", "title": "Gone", "site": "example.com"}]
        found = collect("https://example.com/a and https://example.com/new", keep=old, fetch=self.fetch)
        self.assertEqual(found, [old[0], {"url": "https://example.com/new", "title": "Title 1", "site": "example.com"}])
        self.assertEqual(self.asked, ["https://example.com/new"])

    def test_an_edit_that_drops_a_named_links_words_fetches_it(self):
        old = [{"url": "https://example.com/p", "title": "my post", "named": True}]
        self.assertEqual(collect("Did it: my post <https://example.com/p>", keep=old, fetch=self.fetch), old)
        found = collect("Did it: https://example.com/p", keep=old, fetch=self.fetch)
        self.assertEqual(found, [{"url": "https://example.com/p", "title": "Title 1", "site": "example.com"}])

    def test_no_addresses_no_fetch(self):
        self.assertEqual(collect("Cake. javascript:alert(1) ftp://example.com", fetch=self.fetch), [])
        self.assertEqual(self.asked, [])


class Show(unittest.TestCase):
    LINKS = [{"url": "https://www.example.com/2025/10/08/river/", "title": "Walking the river", "site": "example.com"},
             {"url": "https://example.com/p", "title": "my post", "named": True}]

    def test_segments(self):
        text = "Wrote it up: https://www.example.com/2025/10/08/river/. And my post <https://example.com/p>. Also (https://example.org/x)"
        self.assertEqual(segments(text, self.LINKS), [
            "Wrote it up: ",
            {"url": "https://www.example.com/2025/10/08/river/", "label": "Walking the river", "site": "example.com"},
            ". And ",
            {"url": "https://example.com/p", "label": "my post"},
            ". Also (",
            {"url": "https://example.org/x", "label": "example.org/x"},
            ")",
        ])

    def test_text_without_links_is_one_string(self):
        self.assertEqual(segments("Just cake.", None), ["Just cake."])
        self.assertEqual(segments("", []), [])

    def test_a_named_link_without_its_words_shows_short(self):
        self.assertEqual(segments("<https://example.com/p>", self.LINKS), [{"url": "https://example.com/p", "label": "example.com/p"}])

    def test_plain_and_markdown(self):
        text = "Wrote it up: https://www.example.com/2025/10/08/river/ and my post <https://example.com/p>"
        self.assertEqual(plain(text, self.LINKS),
                         "Wrote it up: Walking the river <https://www.example.com/2025/10/08/river/> and my post <https://example.com/p>")
        self.assertEqual(markdown(text, self.LINKS),
                         "Wrote it up: [Walking the river](https://www.example.com/2025/10/08/river/) and [my post](https://example.com/p)")

    def test_short(self):
        self.assertEqual(short("https://www.example.com/"), "example.com")
        self.assertEqual(short("HTTP://example.com/a/b/"), "example.com/a/b")


if __name__ == "__main__":
    unittest.main()
