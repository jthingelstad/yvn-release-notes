import json
import unittest

from release_notes import web


def request(method, path):
    return {"rawPath": path, "requestContext": {"http": {"method": method}}}


class WebTest(unittest.TestCase):
    def test_health(self):
        r = web.handler(request("GET", "/api/health"), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(json.loads(r["body"]), {"ok": True})
        self.assertEqual(r["headers"]["cache-control"], "no-store")

    def test_unknown_route_is_404(self):
        for method, path in [("GET", "/api/nope"), ("POST", "/api/health"), ("GET", "/")]:
            r = web.handler(request(method, path), None)
            self.assertEqual(r["statusCode"], 404, (method, path))

    def test_log_names_no_unmatched_path(self):
        # A probe's path could carry anything; it is logged as "unmatched".
        from contextlib import redirect_stdout
        from io import StringIO

        out = StringIO()
        with redirect_stdout(out):
            web.handler(request("GET", "/api/someone@example.com"), None)
        self.assertNotIn("example.com", out.getvalue())
        self.assertIn('"path":"unmatched"', out.getvalue())


if __name__ == "__main__":
    unittest.main()
