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

Where (Jamie's prompt, 2026-10-12: "the weather following them"): a
finished day's weather is for where the subscriber was that day
(day_place): the day's own place, set on its page, else the first note
written that day with a place (picked on the web, from a photo, from an
import), else their city. keep_day fetches it once, and again only when
that day's place changes. The morning forecast is always for their city.

Kept as `WEATHER#<day>` under the subscriber: high_c, low_c, code (WMO), the
city, region and country, lat and lon, and when it was fetched. Temperatures
are kept in Celsius and shown in Fahrenheit for places that use it.

Weather is a nicety: any failure is no weather, never a held email or a
failed note. Nothing about a person goes to Open-Meteo but the city's
coordinates (rounded to two places, places.py) and its time zone.
"""

from datetime import date, timedelta
from urllib.parse import urlencode

from .notes import written_at
from .places import _get as fetch_json, valid_tz

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


def for_weather(place: dict | None, tz: str) -> dict | None:
    """A note's or a day's place as weather needs it: its names, a zone, and
    coordinates rounded to two places (all Open-Meteo is told). None for
    one without coordinates, or the subscriber's own city ("home")."""
    if not place or place.get("from") == "home" or place.get("lat") is None or place.get("lon") is None:
        return None
    try:
        lat, lon = round(float(place["lat"]), 2), round(float(place["lon"]), 2)
    except (TypeError, ValueError):
        return None
    return {"city": place.get("city") or place.get("label") or place.get("venue") or "",
            "region": place.get("region") or "", "country": place.get("country") or "",
            "tz": place["tz"] if valid_tz(place.get("tz")) else tz, "lat": lat, "lon": lon}


def day_place(own: dict | None, notes: list[dict], tz: str) -> dict | None:
    """Where a day was: its own place (PLACE#<day>), else the first note
    written with one. None means the subscriber's city."""
    if found := for_weather(own, tz):
        return found
    for n in sorted(notes, key=written_at):
        if found := for_weather(n.get("place"), n.get("tz") or tz):
            return found
    return None


def same_place(kept: dict | None, place: dict) -> bool:
    try:
        return bool(kept) and (round(float(kept["lat"]), 2), round(float(kept["lon"]), 2)) == (place["lat"], place["lon"])
    except (KeyError, TypeError, ValueError):
        return False


def keep_day(store, user_id: str, home: dict | None, tz: str, day: date, today: date, fetch, fetched_at: str,
             changed: bool = False) -> str:
    """Keep a finished day's weather where the subscriber was. Once for
    their city; for a day with a place of its own, again whenever that
    place is not the one the kept weather is for. `changed`: the day's
    place was just set or cleared, so a reading for another place is
    replaced either way; when none can be had for the place it has now,
    one for another place is dropped, so the next call tries again, and so
    it is when the fetch fails. Reads
    consistently: it follows the write of a place or a note. Returns what
    it did, for the log."""
    if day >= today:
        return "not-yet"
    d = day.isoformat()
    # Consistent reads: this follows the write of a place or a note.
    where = day_place(store.day_place(user_id, d, consistent=True),
                      store.notes_between(user_id, d, d, ConsistentRead=True), tz)
    place = where or home
    if not place:
        return "no-place"
    kept = store.weather_between(user_id, d, d, consistent=True).get(d)
    if kept and (same_place(kept, place) or not (where or changed)):
        return "kept"
    # Here, anything kept is for a place the day no longer has. If none
    # can be had for the place it has now, it is dropped, so the next call
    # for the day fetches again; a failed fetch drops it too, then raises.
    try:
        found = history(place, day, today, fetch)
    except Exception:
        if kept:
            store.drop_weather(user_id, d)
        raise
    if not found:
        if kept:
            store.drop_weather(user_id, d)
            return "dropped"
        return "none"
    # One written since the read (another page, the describe function) is
    # replaced: this call read the place last.
    if kept or not store.put_weather(user_id, d, record(found, place, fetched_at)):
        store.replace_weather(user_id, d, record(found, place, fetched_at))
    return "fetched"


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
