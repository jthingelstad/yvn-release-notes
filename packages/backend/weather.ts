/** Weather is optional, never a prerequisite for a note or email. Finished
 * days follow their own place, then the first placed note, then home. Slow
 * lookups recheck consistently before and after committing a reading. */
import { addDays, daysBetween, type Day } from '../domain/dates.ts';
import { writtenAt, type NoteRecord, type PlaceRecord } from '../domain/notes.ts';
import { fetchJson, object, rounded, validTz, type JsonFetch } from './places.ts';
import type { Store, Item } from './store.ts';
export const FORECAST = 'https://api.open-meteo.com/v1/forecast';
export const ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
export const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min';
export const RECENT = 60;
export const MORNING_TIMEOUT = 12;
export const CREDIT = 'Weather from Open-Meteo';
export const CREDIT_URL = 'https://open-meteo.com/';
export const CONDITIONS: Record<number, string> = {
  0: 'clear',
  1: 'mostly clear',
  2: 'partly cloudy',
  3: 'cloudy',
  45: 'fog',
  48: 'freezing fog',
  51: 'light drizzle',
  53: 'drizzle',
  55: 'heavy drizzle',
  56: 'freezing drizzle',
  57: 'freezing drizzle',
  61: 'light rain',
  63: 'rain',
  65: 'heavy rain',
  66: 'freezing rain',
  67: 'freezing rain',
  71: 'light snow',
  73: 'snow',
  75: 'heavy snow',
  77: 'snow grains',
  80: 'showers',
  81: 'showers',
  82: 'heavy showers',
  85: 'snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorms',
  96: 'thunderstorms with hail',
  99: 'thunderstorms with hail'
};
const FAHRENHEIT = new Set([
  'United States',
  'Puerto Rico',
  'Guam',
  'U.S. Virgin Islands',
  'Northern Mariana Islands',
  'American Samoa',
  'Liberia',
  'Palau',
  'Marshall Islands',
  'Micronesia',
  'Bahamas',
  'Belize',
  'Cayman Islands'
]);
export interface WeatherPlace extends PlaceRecord {
  lat: number;
  lon: number;
  tz: string;
}
export interface Reading extends Item {
  high_c: number;
  low_c: number;
  code: number;
}
function url(base: string, place: WeatherPlace, extra: Record<string, string>) {
  return `${base}?${new URLSearchParams({ latitude: String(place.lat), longitude: String(place.lon), daily: DAILY, timezone: place.tz, ...extra })}`;
}
export function dayReading(answer: Item, day: Day): Reading | null {
  const daily = object(answer.daily);
  if (!daily || !Array.isArray(daily.time)) return null;
  const index = daily.time.indexOf(day);
  if (index < 0) return null;
  const high = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max[index] : null;
  const low = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min[index] : null;
  const code = Array.isArray(daily.weather_code) ? daily.weather_code[index] : null;
  if (
    typeof high !== 'number' ||
    typeof low !== 'number' ||
    typeof code !== 'number' ||
    ![high, low, code].every(Number.isFinite) ||
    !(Math.trunc(code) in CONDITIONS) ||
    !(-90 < low && low <= high && high < 60)
  )
    return null;
  return { high_c: rounded(high, 1), low_c: rounded(low, 1), code: Math.trunc(code) };
}
export async function morning(
  place: WeatherPlace,
  today: Day,
  fetcher: JsonFetch = (u) => fetchJson(u, MORNING_TIMEOUT)
): Promise<[Reading | null, Reading | null]> {
  const answer = await fetcher(url(FORECAST, place, { past_days: '1', forecast_days: '1' }));
  return [dayReading(answer, addDays(today, -1)), dayReading(answer, today)];
}
export async function history(
  place: WeatherPlace,
  day: Day,
  today: Day,
  fetcher: JsonFetch = fetchJson
): Promise<Reading | null> {
  if (day >= today) return null;
  const base = daysBetween(day, today) <= RECENT ? FORECAST : ARCHIVE;
  return dayReading(await fetcher(url(base, place, { start_date: day, end_date: day })), day);
}
export const NAMED = ['city', 'region', 'country'] as const;
export function record(reading: Reading, place: WeatherPlace, fetchedAt: string): Item {
  return {
    ...reading,
    ...Object.fromEntries(NAMED.map((k) => [k, place[k] ?? ''])),
    lat: place.lat,
    lon: place.lon,
    fetched_at: fetchedAt
  };
}
export function placeOf(profile: Item): WeatherPlace | null {
  if (profile.lat == null || profile.lon == null || typeof profile.tz !== 'string') return null;
  const lat = Number(profile.lat),
    lon = Number(profile.lon);
  if (![lat, lon].every(Number.isFinite)) return null;
  return {
    ...Object.fromEntries(['city', 'region', 'country'].map((k) => [k, profile[k] ?? ''])),
    lat,
    lon,
    tz: profile.tz
  };
}
export function forWeather(place: PlaceRecord | null | undefined, tz: string): WeatherPlace | null {
  if (!place || place.from === 'home' || place.lat == null || place.lon == null) return null;
  const lat = Number(place.lat),
    lon = Number(place.lon);
  if (![lat, lon].every(Number.isFinite)) return null;
  return {
    city: place.city || place.label || place.venue || '',
    region: place.region || '',
    country: place.country || '',
    tz: validTz(place.tz) ? place.tz : tz,
    lat: rounded(lat, 2),
    lon: rounded(lon, 2)
  };
}
export function dayPlace(own: PlaceRecord | null, notes: readonly NoteRecord[], tz: string): WeatherPlace | null {
  const direct = forWeather(own, tz);
  if (direct) return direct;
  for (const note of [...notes].sort((a, b) => writtenAt(a).localeCompare(writtenAt(b)))) {
    const found = forWeather(note.place, typeof note.tz === 'string' ? note.tz : tz);
    if (found) return found;
  }
  return null;
}
export function spot(place: Item | null): [number, number] | null {
  if (!place || place.lat == null || place.lon == null) return null;
  const lat = Number(place.lat),
    lon = Number(place.lon);
  return [lat, lon].every(Number.isFinite) ? [rounded(lat, 2), rounded(lon, 2)] : null;
}
export const named = (place: Item | null) =>
  place ? JSON.stringify([spot(place), NAMED.map((k) => place[k] ?? '')]) : null;
export function samePlace(kept: Item | null, place: WeatherPlace): boolean {
  const where = spot(kept);
  return where !== null && where[0] === place.lat && where[1] === place.lon;
}
export type WeatherStore = Pick<
  Store,
  'dayPlace' | 'notesBetween' | 'weatherBetween' | 'renameWeather' | 'dropWeather' | 'putWeather' | 'replaceWeather'
>;
export async function keepDay(
  store: WeatherStore,
  user: string,
  home: WeatherPlace | null,
  tz: string,
  day: Day,
  today: Day,
  fetcher: JsonFetch,
  fetchedAt: string,
  changed = false,
  again = true
): Promise<string> {
  if (day >= today) return 'not-yet';
  const whereNow = async () =>
    dayPlace(
      await store.dayPlace(user, day, true),
      await store.notesBetween(user, day, day, { ConsistentRead: true }),
      tz
    );
  const where = await whereNow(),
    place = where || home;
  if (!place) return 'no-place';
  const kept = (await store.weatherBetween(user, day, day, true))[day] ?? null;
  if (kept && (samePlace(kept, place) || !(where || changed))) {
    if (changed && samePlace(kept, place) && NAMED.some((k) => (kept[k] ?? '') !== (place[k] ?? ''))) {
      if (!(await store.renameWeather(user, day, kept, Object.fromEntries(NAMED.map((k) => [k, place[k] ?? ''])))))
        return 'moved';
      if (again && named((await whereNow()) || home) !== named(place))
        return keepDay(store, user, home, tz, day, today, fetcher, fetchedAt, true, false);
      return 'renamed';
    }
    return 'kept';
  }
  const still = async () => named((await whereNow()) || home) === named(place);
  let found: Reading | null;
  try {
    found = await history(place, day, today, fetcher);
  } catch (error) {
    if (kept && (await still())) await store.dropWeather(user, day, kept);
    throw error;
  }
  if (!(await still())) return 'moved';
  if (!found) {
    if (kept) {
      await store.dropWeather(user, day, kept);
      return 'dropped';
    }
    return 'none';
  }
  const reading = record(found, place, fetchedAt);
  if (kept || !(await store.putWeather(user, day, reading))) await store.replaceWeather(user, day, reading);
  if (!(await still())) {
    if ((await store.dropWeather(user, day, reading)) && again)
      return keepDay(store, user, home, tz, day, today, fetcher, fetchedAt, true, false);
    return 'moved';
  }
  return 'fetched';
}
export const fahrenheit = (place: PlaceRecord | null): boolean => !!place && FAHRENHEIT.has(place.country ?? '');
export const degrees = (c: number, f: boolean): string => `${rounded(f ? (c * 9) / 5 + 32 : c)}°`;
export function summary(w: Reading, f: boolean): string {
  const words = CONDITIONS[w.code] ?? '';
  return `${words.slice(0, 1).toUpperCase()}${words.slice(1)}, ${degrees(w.high_c, f)} / ${degrees(w.low_c, f)}`;
}
export const dayLine = (w: Reading, f: boolean): string => summary(w, f) + (w.city ? ` in ${w.city}` : '');
export const forecastLine = (w: Reading, city: string, f: boolean): string =>
  `${city ? `${city} today` : 'Today'}: ${CONDITIONS[w.code] ?? ''}, high ${degrees(w.high_c, f)}, low ${degrees(w.low_c, f)}.`;
export const plain = (w: Reading): Item => ({
  high_c: w.high_c,
  low_c: w.low_c,
  code: w.code,
  conditions: CONDITIONS[w.code] ?? '',
  ...Object.fromEntries(NAMED.map((k) => [k, w[k] ?? '']))
});
