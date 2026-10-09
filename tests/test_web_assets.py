"""Every page loads the same site.css and app.js, at the same ?v=.

deploy.sh caches assets for ten minutes and pages for one, so a change that
must land with a page bumps ?v= on every page at once. A page left behind
would run new HTML against an old script, or the other way round.
"""

import re
import unittest
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
ASSET = re.compile(r'(?:href|src)="/assets/(site\.css|app\.js)\?v=(\d+)"')


class AssetVersionsTest(unittest.TestCase):
    def test_every_page_uses_the_same_versions(self):
        pages = sorted(WEB.glob("**/index.html"))
        self.assertGreater(len(pages), 5)
        seen: dict[str, dict[str, list[str]]] = {"site.css": {}, "app.js": {}}
        for page in pages:
            found = dict(ASSET.findall(page.read_text()))
            name = str(page.relative_to(WEB))
            self.assertEqual(set(found), {"site.css", "app.js"}, f"{name} loads both assets with a ?v=")
            for asset, version in found.items():
                seen[asset].setdefault(version, []).append(name)
        for asset, versions in seen.items():
            self.assertEqual(len(versions), 1, f"{asset} has more than one ?v= across pages: {versions}")


if __name__ == "__main__":
    unittest.main()
