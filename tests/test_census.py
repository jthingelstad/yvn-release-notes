import json
import re
import unittest
from datetime import datetime
from pathlib import Path

from release_notes import census

# 10:00 in Chicago on 2026-10-09 (CDT).
NOW = datetime.fromisoformat("2026-10-09T15:00:00+00:00")


def profile(user, **over):
    item = {"pk": f"USER#{user}", "sk": "PROFILE", "status": "active", "tz": "America/Chicago",
            "send_time": "06:00", "last_sent_date": "2026-10-09"}
    item.update(over)
    return item


def note(user, day, n="m1", **over):
    return {"pk": f"USER#{user}", "sk": f"NOTE#{day}#{n}", **over}


def sent(user, day):
    return {"pk": f"USER#{user}", "sk": f"DAY#{day}"}


class Counts(unittest.TestCase):
    def test_states(self):
        c = census.counts([
            profile("a"),
            profile("b", pause_from="2026-10-08", pause_through="2026-10-12"),
            profile("c", status="stopped"),
            profile("d", pause_from="2026-09-01", pause_through="2026-09-05"),
        ], NOW)
        self.assertEqual((c["Subscribers"], c["Paused"], c["Stopped"]), (2, 1, 1))

    def test_overdue_after_half_an_hour_and_not_while_paused_or_stopped(self):
        late = dict(last_sent_date="2026-10-08")
        c = census.counts([
            profile("a", **late),                          # 06:00, four hours ago
            profile("b", send_time="09:30", **late),       # half an hour ago: due, not late
            profile("c", send_time="11:00", **late),       # not yet
            profile("d", status="stopped", **late),
            profile("e", pause_from="2026-10-09", pause_through="2026-10-09", **late),
            profile("f", send_time="06:00", last_sent_date=None),
        ], NOW)
        self.assertEqual(c["Overdue"], 2)

    def test_today_is_the_subscribers_own(self):
        # 15:00 UTC is already 2026-10-10 in Auckland, and the 06:00 email has gone.
        c = census.counts([profile("a", tz="Pacific/Auckland", last_sent_date="2026-10-10")], NOW)
        self.assertEqual(c["Overdue"], 0)

    def test_notes_by_source_and_media(self):
        c = census.counts([
            profile("a"),
            note("a", "2026-10-09", "m1", media=[{"kind": "photo"}]),
            note("a", "2026-10-09", "w-1", source="web"),
            note("gone", "2026-01-01", "m2"),  # no profile: still a note
        ], NOW)
        self.assertEqual((c["Notes"], c["EmailNotes"], c["WebNotes"], c["NotesWithMedia"]), (3, 2, 1, 1))

    def test_writers_by_their_notes_days(self):
        c = census.counts([
            profile("a"), note("a", "2026-10-03"),   # 7th day back: this week
            profile("b"), note("b", "2026-10-02"),   # 8th day back: this month
            profile("c"), note("c", "2026-09-09"),   # 31st day back: neither
        ], NOW)
        self.assertEqual((c["Writers7"], c["Writers30"]), (1, 2))

    def test_reply_rate_over_the_30_days_before_today(self):
        items = [profile("a")]
        items += [sent("a", f"2026-10-0{d}") for d in range(1, 9)]  # eight emails
        items += [note("a", "2026-10-01"), note("a", "2026-10-02", "m2"), note("a", "2026-10-02", "m3")]
        items += [sent("a", "2026-10-09"), note("a", "2026-10-09")]  # today: not counted yet
        items += [sent("a", "2026-09-08"), note("a", "2026-09-08")]  # 31 days back: not counted
        self.assertEqual(census.counts(items, NOW)["ReplyRate30"], 25.0)

    def test_no_reply_rate_without_emails(self):
        self.assertNotIn("ReplyRate30", census.counts([profile("a")], NOW))

    def test_the_line_is_embedded_metrics_with_numbers_only(self):
        c = census.counts([profile("a"), sent("a", "2026-10-08"), note("a", "2026-10-08")], NOW)
        line = census.line(c, NOW)
        meta = line["_aws"]
        self.assertEqual(meta["Timestamp"], int(NOW.timestamp() * 1000))
        directive = meta["CloudWatchMetrics"][0]
        self.assertEqual(directive["Dimensions"], [[]])
        self.assertEqual({m["Name"] for m in directive["Metrics"]}, set(c))
        self.assertEqual({k for k in line if k not in ("_aws", "event")}, set(c))
        self.assertTrue(all(isinstance(v, (int, float)) for k, v in line.items() if k not in ("_aws", "event")))


class Dashboard(unittest.TestCase):
    """The dashboard's JSON is a string in the template, so nothing else
    checks it before CloudFormation does."""

    @classmethod
    def setUpClass(cls):
        text = (Path(__file__).resolve().parent.parent / "infra" / "template.yaml").read_text()
        start = text.index("DashboardBody: !Sub |") + len("DashboardBody: !Sub |\n")
        lines = []
        for line in text[start:].splitlines():
            if line.strip() and not line.startswith(" " * 8):
                break
            lines.append(line)
        cls.body = json.loads(re.sub(r"\$\{[^}]+\}", "x", "\n".join(lines)))

    def test_widgets_fit_the_grid_without_overlap(self):
        cells = set()
        for w in self.body["widgets"]:
            self.assertLessEqual(w["x"] + w["width"], 24)
            for x in range(w["x"], w["x"] + w["width"]):
                for y in range(w["y"], w["y"] + w["height"]):
                    self.assertNotIn((x, y), cells)
                    cells.add((x, y))

    def test_every_census_metric_it_shows_is_one_the_sender_puts_out(self):
        known = set(census.counts([profile("a"), sent("a", "2026-10-08")], NOW))
        shown = {m[1] for w in self.body["widgets"] if w["type"] == "metric"
                 for m in w["properties"]["metrics"] if isinstance(m[0], str) and m[0] == census.NAMESPACE}
        self.assertTrue(shown)
        self.assertLessEqual(shown, known)

    def test_log_queries_never_ask_for_text_or_addresses(self):
        for w in self.body["widgets"]:
            if w["type"] == "log":
                self.assertTrue(w["properties"]["query"].startswith("SOURCE "))
                self.assertNotRegex(w["properties"]["query"], r"\b(text|email|subject)\b")
