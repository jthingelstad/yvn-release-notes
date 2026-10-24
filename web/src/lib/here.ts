// Where this device is, for a note's "Here" (AGENTS.md, Where a note was):
// the browser asks once, /api/places/here names the spot (city,
// neighbourhood, businesses near enough to offer), and a spot within a short
// walk of the last one reuses its names, so a morning of notes at one table
// asks the server once.
import { api, type ApiData } from './api.ts';
import type { Place } from './types.ts';

const NEAR_M = 150;
let last: Place | null = null;

export const canLocate = () => typeof navigator !== 'undefined' && 'geolocation' in navigator;

function metres(a: { lat?: number; lon?: number }, b: { lat?: number; lon?: number }) {
  const rad = (v = 0) => (v * Math.PI) / 180,
    dLat = rad(b.lat) - rad(a.lat),
    dLon = rad(b.lon) - rad(a.lon),
    h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

function position(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) =>
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 20_000,
      maximumAge: 60_000
    })
  );
}

// The place, or the problem as the pages say it (say.ts): `location`
// when the browser refuses or cannot tell.
export async function whereAmI(): Promise<{ place: Place } | { problem: ApiData }> {
  if (!canLocate()) return { problem: { error: 'location' } };
  let at: GeolocationPosition;
  try {
    at = await position();
  } catch (e) {
    const denied = (e as GeolocationPositionError).code === 1;
    return { problem: { error: denied ? 'location-denied' : 'location' } };
  }
  const spot = { lat: at.coords.latitude, lon: at.coords.longitude, accuracy_m: at.coords.accuracy };
  if (last && metres(last, spot) <= NEAR_M) return { place: { ...last, ...spot } };
  const r = await api<Place>('POST', '/api/places/here', spot);
  if (!r.ok) return { problem: r.data };
  last = r.data;
  return { place: r.data };
}

// What a note keeps: the place without the list it was picked from.
export const kept = ({ nearby: _, ...place }: Place): Place => place;
