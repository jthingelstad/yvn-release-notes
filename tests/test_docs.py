"""The docs name what the code has: every API route, page, key prefix,
module and script. Drift found by hand on 2026-10-09 (five routes, two
pages and a key prefix undocumented) is what these catch."""

import re
import unittest
from pathlib import Path

from release_notes import store, web

ROOT = Path(__file__).resolve().parent.parent
WEB_APP = (ROOT / "docs" / "WEB-APP.md").read_text()
AGENTS = (ROOT / "AGENTS.md").read_text()


def api_table() -> set[tuple[str, str]]:
    """(method, path) for each row of WEB-APP.md's API table, whose first
    cell is like `PUT/DELETE /api/days/{date}/notes/{id}` or `GET /api/sample?birthday=&tz=`."""
    rows = set()
    for methods, path in re.findall(r"^\| `([A-Z/]+) (/api/[^`?\s]*)", WEB_APP, re.M):
        for m in methods.split("/"):
            rows.add((m, path))
    return rows


class Docs(unittest.TestCase):
    def test_every_route_is_in_the_api_table_and_no_more(self):
        routes = {(m, p) for m, p, _ in web.ROUTES}
        table = api_table()
        self.assertEqual(sorted(routes - table), [], "routes missing from docs/WEB-APP.md's API table")
        self.assertEqual(sorted(table - routes), [], "API table rows with no route in web.ROUTES")

    def test_every_page_is_in_the_pages_list(self):
        pages = re.findall(r"page\('(/[a-z-]+)'", (ROOT / "web" / "src" / "main.tsx").read_text())
        self.assertGreater(len(pages), 5)
        listed = WEB_APP.split("- **Pages**", 1)[1].split("\n- ", 1)[0]
        missing = [p for p in pages if f"`{p}/" not in listed]
        self.assertEqual(missing, [], "pages missing from docs/WEB-APP.md's Pages")

    def test_every_key_prefix_is_in_the_store_layout(self):
        prefixes = set()
        for f in (ROOT / "src" / "release_notes").glob("*.py"):
            prefixes |= set(re.findall(r"""f?["']([A-Z]{3,})#""", f.read_text()))
        self.assertIn("USER", prefixes)
        missing = sorted(p for p in prefixes if f"{p}#" not in store.__doc__)
        self.assertEqual(missing, [], "key prefixes missing from store.py's docstring")

    def test_every_module_and_script_is_in_agents_md(self):
        names = [f.name for f in (ROOT / "src" / "release_notes").glob("*.py") if f.name != "__init__.py"]
        names += [f.name for f in (ROOT / "scripts").iterdir() if f.suffix in {".py", ".mjs", ".sh"}]
        missing = sorted(n for n in names if n not in AGENTS)
        self.assertEqual(missing, [], "files AGENTS.md never mentions")


if __name__ == "__main__":
    unittest.main()
