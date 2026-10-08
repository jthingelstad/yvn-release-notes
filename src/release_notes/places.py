"""City search, through Open-Meteo's geocoder (no key; data CC BY 4.0, which
the setup page credits). The page asks /api/places, never Open-Meteo, so its
CSP stays 'self'.

A place is kept only to the city: its names, its time zone, and coordinates
rounded to two places (about a kilometre), which is enough for weather.
"""

import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

GEOCODER = "https://geocoding-api.open-meteo.com/v1/search"
USER_AGENT = "ReleaseNotes/1 (+https://notes.yourversionnumber.com)"


def _get(url: str, timeout: float = 4) -> dict:
    req = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    with urlopen(req, timeout=timeout) as r:
        return json.load(r)


def valid_tz(tz) -> bool:
    if not isinstance(tz, str) or not tz or len(tz) > 64:
        return False
    try:
        ZoneInfo(tz)
        return True
    except (ZoneInfoNotFoundError, ValueError):
        return False


def search(query: str, fetch=_get) -> list[dict]:
    data = fetch(f"{GEOCODER}?{urlencode({'name': query, 'count': 8, 'language': 'en', 'format': 'json'})}")
    found = []
    for r in data.get("results") or []:
        place = clean(
            {
                "name": r.get("name"),
                "region": r.get("admin1") or "",
                "country": r.get("country") or "",
                "tz": r.get("timezone"),
                "lat": r.get("latitude"),
                "lon": r.get("longitude"),
            }
        )
        if place:
            found.append(place)
    return found


def clean(raw) -> dict | None:
    """A place as the client sends it back: checked, trimmed and rounded.
    None if it is not one."""
    if not isinstance(raw, dict):
        return None
    out = {}
    for k in ("name", "region", "country"):
        v = raw.get(k, "")
        if not isinstance(v, str) or len(v) > 100:
            return None
        out[k] = v.strip()
    if not out["name"] or not valid_tz(raw.get("tz")):
        return None
    out["tz"] = raw["tz"]
    for k, limit in (("lat", 90), ("lon", 180)):
        v = raw.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not -limit <= v <= limit:
            return None
        out[k] = round(float(v), 2)
    return out
