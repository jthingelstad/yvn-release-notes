"""Weather: each day's, kept with the notes, and today's forecast in the email.

Jamie, 2026-10-08: "Record + today's forecast". Each finished day's high,
low and conditions are kept with the city they are for, and shown on day
pages, in the email's "On this day" and in the export. The morning email
carries one quiet line of today's forecast. Days filled in later get their
weather from history when a note is written for them.

From Open-Meteo (no key; data CC BY 4.0, credited wherever weather shows):

- the morning email asks the forecast API for yesterday and today in one
  call (`morning`): yesterday's is recorded, today's goes in the email;
- a day filled in later asks for that day (`history`): the forecast API's
  recent past for the last two months, the archive before that.

Kept as `WEATHER#<day>` under the subscriber: high_c, low_c, code (WMO), the
city, region and country, lat and lon, and when it was fetched. Temperatures
are kept in Celsius and shown in Fahrenheit for places that use it.

Weather is a nicety: any failure is no weather, never a held email or a
failed note. Nothing about a person goes to Open-Meteo but the city's
coordinates (rounded to two places, places.py) and its time zone.
"""

from datetime import date, timedelta
from urllib.parse import urlencode

from .places import _get as fetch_json

FORECAST = "https://api.open-meteo.com/v1/forecast"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
DAILY = "weather_code,temperature_2m_max,temperature_2m_min"
RECENT = 60  # days back the forecast API answers for; older days ask the archive
# The sender often starts cold, and its first call to Open-Meteo (DNS, TLS)
# ran past four seconds on 2026-10-08. It waits longer; one_run (send.py)
# keeps that to one wait a run. A page waiting on a note keeps four.
MORNING_TIMEOUT = 12
CREDIT = "Weather from Open-Meteo"
CREDIT_URL = "https://open-meteo.com/"

# WMO weather interpretation codes, as Open-Meteo documents them.
CONDITIONS = {
    0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "cloudy", 45: "fog", 48: "freezing fog",
    51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "showers", 81: "showers", 82: "heavy showers", 85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorms", 96: "thunderstorms with hail", 99: "thunderstorms with hail",
}
# Places that read the thermometer in Fahrenheit, by the country name the
# geocoder gives (places.py).
FAHRENHEIT = {"United States", "Puerto Rico", "Guam", "U.S. Virgin Islands", "Northern Mariana Islands",
              "American Samoa", "Liberia", "Palau", "Marshall Islands", "Micronesia", "Bahamas", "Belize",
              "Cayman Islands"}


def _url(base: str, lat, lon, tz: str, **extra) -> str:
    return f"{base}?{urlencode({'latitude': float(lat), 'longitude': float(lon), 'daily': DAILY, 'timezone': tz, **extra})}"


def _day(data: dict, day: str) -> dict | None:
    """{"high_c", "low_c", "code"} for one day of a daily answer, or None."""
    daily = data.get("daily") or {}
    try:
        i = (daily.get("time") or []).index(day)
        high, low, code = daily["temperature_2m_max"][i], daily["temperature_2m_min"][i], daily["weather_code"][i]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in (high, low, code)):
        return None
    if int(code) not in CONDITIONS or not -90 < low <= high < 60:
        return None
    return {"high_c": round(float(high), 1), "low_c": round(float(low), 1), "code": int(code)}


def fetch_morning(url: str) -> dict:
    return fetch_json(url, timeout=MORNING_TIMEOUT)


def morning(place: dict, today: date, fetch=fetch_morning) -> tuple[dict | None, dict | None]:
    """(yesterday's weather, today's forecast) for a place, in one call."""
    data = fetch(_url(FORECAST, place["lat"], place["lon"], place["tz"], past_days=1, forecast_days=1))
    return _day(data, (today - timedelta(days=1)).isoformat()), _day(data, today.isoformat())


def history(place: dict, day: date, today: date, fetch=fetch_json) -> dict | None:
    """A finished day's weather; None for today or later."""
    if day >= today:
        return None
    base = FORECAST if (today - day).days <= RECENT else ARCHIVE
    return _day(fetch(_url(base, place["lat"], place["lon"], place["tz"], start_date=day.isoformat(),
                           end_date=day.isoformat())), day.isoformat())


def record(reading: dict, place: dict, fetched_at: str) -> dict:
    """A WEATHER item's fields: the reading and where it is for."""
    return {**reading, "city": place.get("city", ""), "region": place.get("region", ""),
            "country": place.get("country", ""), "lat": place["lat"], "lon": place["lon"], "fetched_at": fetched_at}


def place_of(profile: dict) -> dict | None:
    """The subscriber's city, as weather needs it, or None without one."""
    if profile.get("lat") is None or profile.get("lon") is None or not profile.get("tz"):
        return None
    return {k: profile.get(k, "") for k in ("city", "region", "country", "tz")} | {"lat": profile["lat"], "lon": profile["lon"]}


# --- saying it -----------------------------------------------------------------

def fahrenheit(place: dict | None) -> bool:
    return bool(place) and place.get("country") in FAHRENHEIT


def degrees(c, fahrenheit: bool) -> str:
    c = float(c)
    return f"{round(c * 9 / 5 + 32)}°" if fahrenheit else f"{round(c)}°"


def summary(w: dict, fahrenheit: bool) -> str:
    """'Partly cloudy, 61° / 44°'."""
    words = CONDITIONS.get(int(w["code"]), "")
    return f"{words[:1].upper()}{words[1:]}, {degrees(w['high_c'], fahrenheit)} / {degrees(w['low_c'], fahrenheit)}"


def day_line(w: dict, fahrenheit: bool) -> str:
    """A recorded day: 'Partly cloudy, 61° / 44° in Minneapolis'."""
    where = f" in {w['city']}" if w.get("city") else ""
    return summary(w, fahrenheit) + where


def forecast_line(w: dict, city: str, fahrenheit: bool) -> str:
    """The morning email: 'Minneapolis today: partly cloudy, high 61°, low 44°.'"""
    words = CONDITIONS.get(int(w["code"]), "")
    head = f"{city} today" if city else "Today"
    return f"{head}: {words}, high {degrees(w['high_c'], fahrenheit)}, low {degrees(w['low_c'], fahrenheit)}."


def plain(w: dict) -> dict:
    """For the JSON export: numbers as numbers, the conditions in words."""
    return {
        "high_c": float(w["high_c"]), "low_c": float(w["low_c"]), "code": int(w["code"]),
        "conditions": CONDITIONS.get(int(w["code"]), ""), "city": w.get("city", ""), "region": w.get("region", ""),
        "country": w.get("country", ""),
    }
