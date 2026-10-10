"""The API answers only requests that came through CloudFront."""

import json
import os
from unittest import mock

import test_web
from release_notes import auth, web

SECRET = "originsecretfortestsonly0123456789abcdefghij"  # not the live value


class OriginSecretTest(test_web.WebCase):
    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"ORIGIN_SECRET": SECRET})
        patcher.start()
        self.addCleanup(patcher.stop)

    def send(self, method, path, body=None, *, verify=None, **kw):
        event = test_web.request(method, path, body, **kw)
        if verify is not None:
            event["headers"]["X-Origin-Verify"] = verify  # as CloudFront names it
        with mock.patch("sys.stdout", self.out):
            r = web.handler(event, None, store=self.store, ses=self.ses, s3=self.s3, lam=self.lam,
                            geocode=self.geocode, fetch=self.fetch, weather_fetch=self.weather_fetch,
                            clock=lambda: self.now)
        return r, json.loads(r["body"])

    def test_refused_without_the_header(self):
        r, body = self.send("GET", "/api/sample", query={"birthday": "1981-06-14"})
        self.assertEqual((r["statusCode"], body), (403, {"error": "forbidden"}))

    def test_refused_with_a_wrong_header(self):
        for wrong in ["", "nope", SECRET[:-1], SECRET + "x", SECRET.upper()]:
            r, body = self.send("POST", "/api/auth/start", {"email": "ada@example.com"}, verify=wrong)
            self.assertEqual((r["statusCode"], body), (403, {"error": "forbidden"}))
        self.assertEqual(self.ses.sent, [])  # no route ran

    def test_refused_before_any_route(self):
        # The same answer for a path that does not exist, so a direct caller
        # learns nothing about the routes.
        r, body = self.send("GET", "/api/nothing-here")
        self.assertEqual((r["statusCode"], body), (403, {"error": "forbidden"}))

    def test_accepted_with_the_header(self):
        r, _ = self.send("POST", "/api/auth/start", {"email": "ada@example.com"}, verify=SECRET)
        self.assertEqual(r["statusCode"], 202)
        r, _ = self.send("GET", "/api/nothing-here", verify=SECRET)
        self.assertEqual(r["statusCode"], 404)

    def test_header_never_logged_or_kept(self):
        self.send("GET", "/api/sample", verify="a-wrong-guess")
        self.send("GET", "/api/sample", verify=SECRET)
        logged = self.out.getvalue()
        self.assertNotIn(SECRET, logged)
        self.assertNotIn("a-wrong-guess", logged)
        self.assertIn('"path":"direct","status":403', logged)
        req = web.Request({"headers": {"X-Origin-Verify": SECRET}})
        self.assertNotIn(web.ORIGIN_HEADER, req.headers)

    def test_compared_in_constant_time(self):
        with mock.patch.object(auth.hmac, "compare_digest", wraps=auth.hmac.compare_digest) as compare:
            r, _ = self.send("GET", "/api/nothing-here", verify=SECRET)
        self.assertEqual(r["statusCode"], 404)
        compare.assert_called_once_with(SECRET.encode(), SECRET.encode())

    def test_no_secret_no_check(self):
        # The tests and scripts/dev_server.py run without CloudFront.
        with mock.patch.dict(os.environ):
            del os.environ["ORIGIN_SECRET"]
            r, _ = self.send("GET", "/api/nothing-here")
        self.assertEqual(r["statusCode"], 404)


if __name__ == "__main__":
    import unittest

    unittest.main()
