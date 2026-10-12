"""City search, through Open-Meteo's geocoder (no key; data CC BY 4.0, which
the setup page credits). The page asks /api/places, never Open-Meteo, so its
CSP stays 'self'.

A place is kept only to the city: its names, its time zone, and coordinates
rounded to two places (about a kilometre), which is enough for weather.

A photo's place (Jamie's prompt, 2026-10-12): a note with no place takes
its first photo's, `from: "photo"`, named by `reverse`, once, when the
photo is filed (describe.py, after thumbs.py has read the photo's EXIF).
`reverse` asks Amazon Location Service's ReverseGeocode for the locality
only: city, region, country and time zone, nothing finer. It is told the
coordinates and nothing else (rounded to three places, about 100 m), with
IntendedUse "Storage", since the answer is kept: Amazon's terms require
that, and charge the Stored rate for it (about $4 per 1,000; a few photos a
day is cents a month). The note keeps the photo's own coordinates, for
the map link; a place no locality is found for is kept with coordinates
alone. Neither coordinates nor names are ever logged.
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


COUNTRY_NAMES = {"US": "United States"}  # as weather.FAHRENHEIT and the city search name it


def reverse(lat: float, lon: float, client) -> dict | None:
    """{"city", "region", "country", "tz"} for a photo's coordinates, from
    Amazon Location (`client` is boto3's geo-places), or None if it knows
    no locality there."""
    answer = client.reverse_geocode(
        QueryPosition=[round(float(lon), 3), round(float(lat), 3)],
        IntendedUse="Storage",
        MaxResults=1,
        Language="en",
        Filter={"IncludePlaceTypes": ["Locality"]},
        AdditionalFeatures=["TimeZone"],
    )
    items = answer.get("ResultItems") or []
    if not items:
        return None
    address = items[0].get("Address") or {}
    country = address.get("Country") or {}
    found = {
        "city": str(address.get("Locality") or "")[:100],
        "region": str((address.get("Region") or {}).get("Name") or "")[:100],
        "country": str(COUNTRY_NAMES.get(country.get("Code2"), country.get("Name")) or "")[:100],
    }
    if not found["city"]:
        return None
    tz = (items[0].get("TimeZone") or {}).get("Name")
    if valid_tz(tz):
        found["tz"] = tz
    return found


def first_photo(note: dict) -> dict | None:
    """The coordinates of the note's first photo that has them (exif.py)."""
    for m in note.get("media") or []:
        where = m.get("place") or {}
        if m.get("kind") == "image" and where.get("lat") is not None and where.get("lon") is not None:
            return {"lat": where["lat"], "lon": where["lon"]}
    return None


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
