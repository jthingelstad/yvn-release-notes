import unittest
from datetime import date
from decimal import Decimal
from email import message_from_bytes
from email.policy import default
from urllib.parse import parse_qs, urlsplit

from release_notes import export, send, weather
from test_handlers import AT_8PM, FakeSES, FakeStore, ada
from test_web_notes import NotesCase

MPLS = {"city": "Minneapolis", "region": "Minnesota", "country": "United States", "tz": "America/Chicago",
        "lat": Decimal("44.98"), "lon": Decimal("-93.26")}
OSLO = {**MPLS, "city": "Oslo", "region": "Oslo", "country": "Norway", "tz": "Europe/Oslo"}


def answer(*days):
    """An Open-Meteo daily answer: (date, code, high, low) for each day."""
    return {"daily": {"time": [d[0] for d in days], "weather_code": [d[1] for d in days],
                      "temperature_2m_max": [d[2] for d in days], "temperature_2m_min": [d[3] for d in days]}}


class Fetcher:
    def __init__(self, data=None, fail=False):
        self.data, self.fail, self.urls = data, fail, []

    def __call__(self, url):
        self.urls.append(url)
        if self.fail:
            raise TimeoutError("open-meteo down")
        return self.data

    def query(self, n=-1):
        parts = urlsplit(self.urls[n])
        return parts.netloc, {k: v[0] for k, v in parse_qs(parts.query).items()}


class Reading(unittest.TestCase):
    def test_morning_asks_once_for_yesterday_and_today(self):
        f = Fetcher(answer(("2026-10-07", 0, 23.4, 10.4), ("2026-10-08", 3, 19.0, 8.2)))
        yesterday, today = weather.morning(MPLS, date(2026, 10, 8), f)
        self.assertEqual(yesterday, {"high_c": 23.4, "low_c": 10.4, "code": 0})
        self.assertEqual(today, {"high_c": 19.0, "low_c": 8.2, "code": 3})
        host, q = f.query()
        self.assertEqual(host, "api.open-meteo.com")
        self.assertEqual((q["latitude"], q["longitude"], q["timezone"], q["past_days"], q["forecast_days"]),
                         ("44.98", "-93.26", "America/Chicago", "1", "1"))
        self.assertEqual(q["daily"], "weather_code,temperature_2m_max,temperature_2m_min")

    def test_history_recent_from_the_forecast_api_older_from_the_archive(self):
        f = Fetcher(answer(("2026-09-01", 61, 20, 12)))
        self.assertEqual(weather.history(MPLS, date(2026, 9, 1), date(2026, 10, 8), f)["code"], 61)
        self.assertEqual(f.query()[0], "api.open-meteo.com")
        self.assertEqual((f.query()[1]["start_date"], f.query()[1]["end_date"]), ("2026-09-01", "2026-09-01"))
        f.data = answer(("1995-07-04", 95, 31, 22))
        self.assertEqual(weather.history(MPLS, date(1995, 7, 4), date(2026, 10, 8), f)["code"], 95)
        self.assertEqual(f.query()[0], "archive-api.open-meteo.com")

    def test_no_history_for_today(self):
        f = Fetcher()
        self.assertIsNone(weather.history(MPLS, date(2026, 10, 8), date(2026, 10, 8), f))
        self.assertEqual(f.urls, [])

    def test_odd_answers_are_no_weather(self):
        for data in ({}, {"daily": {}}, answer(("2026-10-07", None, 20, 10)), answer(("2026-10-07", 3, 10, 20)),
                     answer(("2026-10-07", 42, 20, 10)), answer(("2026-10-07", True, 20, 10)),
                     answer(("2026-10-06", 3, 20, 10)), {"daily": {"time": ["2026-10-07"]}}):
            self.assertIsNone(weather._day(data, "2026-10-07"), data)


class Saying(unittest.TestCase):
    def test_lines(self):
        w = {"high_c": Decimal("16.1"), "low_c": Decimal("6.6"), "code": 2, "city": "Minneapolis"}
        self.assertEqual(weather.day_line(w, True), "Partly cloudy, 61° / 44° in Minneapolis")
        self.assertEqual(weather.day_line(w, False), "Partly cloudy, 16° / 7° in Minneapolis")
        self.assertEqual(weather.forecast_line(w, "Minneapolis", True), "Minneapolis today: partly cloudy, high 61°, low 44°.")
        self.assertEqual(weather.forecast_line(w, "", False), "Today: partly cloudy, high 16°, low 7°.")

    def test_fahrenheit_where_it_is_used(self):
        self.assertTrue(weather.fahrenheit(MPLS))
        self.assertFalse(weather.fahrenheit(OSLO))
        self.assertFalse(weather.fahrenheit(None))

    def test_a_place_needs_coordinates(self):
        self.assertEqual(weather.place_of({**MPLS})["lat"], Decimal("44.98"))
        self.assertIsNone(weather.place_of({"tz": "America/Chicago", "lat": Decimal("1")}))


class Sending(unittest.TestCase):
    def send(self, fetch, **kw):
        store, ses = FakeStore([ada(place=MPLS)]), FakeSES()
        for (day, text) in kw.get("notes", []):
            store.notes[("u1", day, "m1")] = {"text": text}
        store.weather.update(kw.get("kept", {}))
        out = send.handler(kw.get("event", {}), None, store=store, ses=ses, clock=AT_8PM, fetch=fetch)
        return store, ses, out

    def mail(self, ses):
        msg = message_from_bytes(ses.sent[0]["Content"]["Raw"]["Data"], policy=default)
        return msg.get_body(("plain",)).get_content(), msg.get_body(("html",)).get_content()

    def test_the_morning_keeps_yesterday_and_forecasts_today(self):
        f = Fetcher(answer(("2026-10-06", 63, 12.2, 7.1), ("2026-10-07", 2, 16.1, 6.6)))
        store, ses, _ = self.send(f)
        kept = store.weather[("u1", "2026-10-06")]
        self.assertEqual((kept["code"], kept["high_c"], kept["city"], kept["lat"]), (63, 12.2, "Minneapolis", Decimal("44.98")))
        plain, html = self.mail(ses)
        self.assertIn("You're 5.0.0 today. Happy birthday: a major release.\nMinneapolis today: partly cloudy, high 61°, low 44°.\n", plain)
        self.assertIn("Weather from Open-Meteo: https://open-meteo.com/", plain)
        self.assertIn("Minneapolis today: partly cloudy, high 61&#176;, low 44&#176;.", html)
        self.assertIn('href="https://open-meteo.com/"', html)
        html.encode("ascii")  # still 7-bit

    def test_no_city_no_weather(self):
        store, ses = FakeStore([ada()]), FakeSES()
        f = Fetcher()
        send.handler({}, None, store=store, ses=ses, clock=AT_8PM, fetch=f)
        self.assertEqual(f.urls, [])
        plain, _ = self.mail(ses)
        self.assertNotIn("Open-Meteo", plain)

    def test_neighbors_share_one_call_and_one_failure_ends_weather_for_the_run(self):
        both = [ada(place=MPLS), ada(user_id="u2", email="bea@example.com", place=MPLS)]
        f = Fetcher(answer(("2026-10-06", 63, 12.2, 7.1), ("2026-10-07", 2, 16.1, 6.6)))
        ses = FakeSES()
        send.handler({}, None, store=FakeStore(both), ses=ses, clock=AT_8PM, fetch=f)
        self.assertEqual((len(f.urls), len(ses.sent)), (1, 2))
        down = Fetcher(fail=True)
        ses = FakeSES()
        send.handler({}, None, store=FakeStore([ada(place=MPLS), ada(user_id="u2", email="bea@example.com", place=OSLO)]),
                     ses=ses, clock=AT_8PM, fetch=down)
        self.assertEqual((len(down.urls), len(ses.sent)), (1, 2))

    def test_open_meteo_down_the_email_goes_anyway(self):
        store, ses, _ = self.send(Fetcher(fail=True))
        self.assertEqual(len(ses.sent), 1)
        self.assertEqual(store.weather, {})
        plain, html = self.mail(ses)
        self.assertNotIn("Minneapolis", plain)
        self.assertNotIn("Open-Meteo", html)

    def test_a_dry_run_forecasts_but_keeps_nothing(self):
        f = Fetcher(answer(("2026-10-06", 63, 12.2, 7.1), ("2026-10-07", 2, 16.1, 6.6)))
        store, ses, out = self.send(f, event={"dry_run": True, "now": "2026-10-08T01:00:00+00:00"})
        self.assertEqual(store.weather, {})
        self.assertTrue(out["results"][0]["forecast"])

    def test_a_year_ago_with_its_weather(self):
        kept = {("u1", "2025-10-07"): {"high_c": Decimal("22.0"), "low_c": Decimal("6.6"), "code": 63, "city": "Minneapolis"}}
        store, ses, _ = self.send(Fetcher(fail=True), notes=[("2025-10-07", "Cake.")], kept=kept)
        plain, html = self.mail(ses)
        self.assertIn("A year ago you were 4.9.0 (Tuesday, October 7, 2025):\nRain, 72° / 44° in Minneapolis.\n\nCake.", plain)
        self.assertIn("Rain, 72&#176; / 44&#176; in Minneapolis</p>", html)
        self.assertIn("Weather from Open-Meteo", plain)


class WebTest(NotesCase):
    def setUp(self):
        super().setUp()
        self.store.profiles["u1"].update(MPLS)
        self.sky = Fetcher(answer(("2026-09-12", 61, 18.3, 9.0)))

    def weather_fetch(self, url):
        return self.sky(url)

    def test_a_past_day_gets_its_weather_with_its_first_note(self):
        self.add("2026-09-12", "Backfilled.")
        self.add("2026-09-12", "Again.")
        self.assertEqual(len(self.sky.urls), 1)
        _, day = self.get("/api/days/2026-09-12")
        self.assertEqual(day["weather"], "Light rain, 65° / 48° in Minneapolis")
        _, days = self.get("/api/days")
        self.assertEqual(next(d for d in days["days"] if d["date"] == "2026-09-12")["weather"], day["weather"])
        self.assertNotIn("Minneapolis", self.out.getvalue())

    def test_today_waits_for_tomorrows_email(self):
        self.add("2026-10-08", "Today.")
        self.assertEqual(self.sky.urls, [])

    def test_open_meteo_down_the_note_is_still_saved(self):
        self.sky.fail = True
        r, _ = self.add("2026-09-12", "Backfilled.")
        self.assertEqual(r["statusCode"], 201)
        _, day = self.get("/api/days/2026-09-12")
        self.assertNotIn("weather", day)
        self.assertIn('"weather-error"', self.out.getvalue())

    def test_the_export_carries_it(self):
        self.add("2026-09-12", "Backfilled.")
        data = export.build(self.store.user_items("u1"), "2026-10-08T00:00:00Z")
        self.assertEqual(data["weather"], [{"date": "2026-09-12", "high_c": 18.3, "low_c": 9.0, "code": 61,
                                            "conditions": "light rain", "city": "Minneapolis", "region": "Minnesota",
                                            "country": "United States"}])
        md = export.markdown(data)
        self.assertIn("· Saturday, September 12, 2026\n\nLight rain, 65° / 48° in Minneapolis.\n\nBackfilled.", md)
        self.assertIn("Weather from Open-Meteo (https://open-meteo.com/), CC BY 4.0.", md)
