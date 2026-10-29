/** Places. Forward search shares only the query with Open-Meteo; naming a
 * photo's spot shares rounded coordinates with Amazon Location, and naming
 * a device's spot ("Here") shares the spot itself (Jamie, 2026-10-24). */
import { GeoPlacesClient, ReverseGeocodeCommand } from '@aws-sdk/client-geo-places';
import { validTimezone } from '../domain/dates.ts';
import { codePointLength, codePointSlice, pythonTrim } from '../domain/unicode.ts';
import type { NoteRecord, PlaceRecord } from '../domain/notes.ts';
export type JsonFetch = (url: string, timeoutSeconds?: number) => Promise<Record<string, unknown>>;
export const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';
export const USER_AGENT = 'ReleaseNotes/1 (+https://notes.yourversionnumber.com)';
export const validTz = validTimezone;
export const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
/** Round ties to even, matching the Python integer rounding used in copy. */
export function rounded(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return value;
  if (!Number.isInteger(digits) || digits < 0 || digits > 6) throw new RangeError('Invalid precision');
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(Math.abs(value));
  const bits = bytes.readBigUInt64BE(),
    exponent = Number((bits >> 52n) & 0x7ffn);
  let numerator = bits & ((1n << 52n) - 1n);
  if (exponent) numerator += 1n << 52n;
  numerator *= 10n ** BigInt(digits);
  const shift = (exponent || 1) - 1023 - 52;
  if (shift >= 0) numerator <<= BigInt(shift);
  const denominator = shift < 0 ? 1n << BigInt(-shift) : 1n;
  const quotient = numerator / denominator,
    rest = numerator % denominator;
  const rounded = quotient + (2n * rest > denominator || (2n * rest === denominator && quotient % 2n === 1n) ? 1n : 0n);
  return ((value < 0 || Object.is(value, -0) ? -1 : 1) * Number(rounded)) / 10 ** digits;
}
export async function fetchJson(url: string, timeoutSeconds = 4): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(timeoutSeconds * 1000),
    redirect: 'error',
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error('Place service unavailable');
  if (Number(response.headers.get('content-length') ?? 0) > 512 * 1024)
    throw new RangeError('Place response too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing place response');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw new RangeError('Place response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const answer = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (!answer) throw new Error('Invalid place response');
  return answer;
}
export interface City extends PlaceRecord {
  name: string;
  region: string;
  country: string;
  tz: string;
  lat: number;
  lon: number;
}
export function clean(raw: unknown): City | null {
  const row = object(raw);
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const key of ['name', 'region', 'country']) {
    const value = row[key] ?? '';
    if (typeof value !== 'string' || codePointLength(value) > 100) return null;
    out[key] = pythonTrim(value);
  }
  if (!out.name || !validTimezone(row.tz)) return null;
  out.tz = row.tz;
  for (const [key, limit] of [
    ['lat', 90],
    ['lon', 180]
  ] as const) {
    const value = row[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) return null;
    out[key] = rounded(value, 2);
  }
  return out as City;
}
/** A city from the search, as a place chosen for a note or a profile. */
export const chosen = (p: City): PlaceRecord => ({
  city: p.name,
  region: p.region,
  country: p.country,
  tz: p.tz,
  lat: p.lat,
  lon: p.lon,
  from: 'chosen'
});
export async function search(query: string, fetcher: JsonFetch = fetchJson): Promise<City[]> {
  const answer = await fetcher(
    `${GEOCODER}?${new URLSearchParams({ name: query, count: '8', language: 'en', format: 'json' })}`
  );
  const found: City[] = [];
  for (const raw of Array.isArray(answer.results) ? answer.results : []) {
    const row = object(raw);
    if (!row) continue;
    const city = clean({
      name: row.name,
      region: row.admin1 || '',
      country: row.country || '',
      tz: row.timezone,
      lat: row.latitude,
      lon: row.longitude
    });
    if (city) found.push(city);
  }
  return found;
}
export function firstPhoto(note: NoteRecord): { lat: number; lon: number } | null {
  for (const media of note.media ?? []) {
    const where = object(media.place);
    if (media.kind === 'image' && typeof where?.lat === 'number' && typeof where.lon === 'number')
      return { lat: where.lat, lon: where.lon };
  }
  return null;
}
/** Names a spot at the city alone: nameSpot's fallback where nothing
 * nearby has an address. */
export async function reverse(lat: number, lon: number, client = new GeoPlacesClient({})): Promise<PlaceRecord | null> {
  const answer = await client.send(
    new ReverseGeocodeCommand({
      QueryPosition: [rounded(lon, 3), rounded(lat, 3)],
      IntendedUse: 'Storage',
      MaxResults: 1,
      Language: 'en',
      Filter: { IncludePlaceTypes: ['Locality'] },
      AdditionalFeatures: ['TimeZone']
    })
  );
  const row = answer.ResultItems?.[0],
    address = row?.Address;
  if (!address?.Locality) return null;
  const found: PlaceRecord = {
    city: codePointSlice(address.Locality, 0, 100),
    region: codePointSlice(address.Region?.Name ?? '', 0, 100),
    country: codePointSlice(address.Country?.Code2 === 'US' ? 'United States' : (address.Country?.Name ?? ''), 0, 100)
  };
  if (validTimezone(row?.TimeZone?.Name)) found.tz = row.TimeZone.Name;
  return found;
}
/** Where a device says it is, for a note (Jamie, 2026-10-24: "for a note
 * detailed location, specific. For a day the city"): kept to six places,
 * as a photo's spot is, with the browser's accuracy in metres. Named at the
 * city by `reverse`, which is told the coordinates alone. */
export const SPOT_DIGITS = 6;
export interface Spot {
  lat: number;
  lon: number;
  accuracy_m?: number;
}
export function spotOf(raw: unknown): Spot | null {
  const row = object(raw);
  if (!row) return null;
  const lat = row.lat,
    lon = row.lon,
    accuracy = row.accuracy_m ?? null;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  if (accuracy !== null && (typeof accuracy !== 'number' || !Number.isFinite(accuracy) || accuracy < 0)) return null;
  const out: Spot = { lat: rounded(lat, SPOT_DIGITS), lon: rounded(lon, SPOT_DIGITS) };
  if (accuracy !== null) out.accuracy_m = Math.min(rounded(accuracy), 100_000);
  return out;
}
/** A spot named for a note, as the browser sends it back: the city's
 * names, the neighbourhood and a chosen business when there are, a valid
 * zone when there is one, and the spot itself. */
export function devicePlace(raw: unknown): PlaceRecord | null {
  const row = object(raw),
    spot = spotOf(row);
  if (!row || !spot) return null;
  const out: PlaceRecord = {};
  for (const [from, to] of [
    ['name', 'city'],
    ['region', 'region'],
    ['country', 'country'],
    ['district', 'district'],
    ['venue', 'venue']
  ] as const) {
    const value = row[from] ?? '';
    if (typeof value !== 'string' || codePointLength(value) > 100) return null;
    if (pythonTrim(value)) out[to] = pythonTrim(value);
  }
  if (!out.city) return null;
  if (row.tz != null) {
    if (!validTimezone(row.tz)) return null;
    out.tz = row.tz;
  }
  return { ...out, ...spot, from: 'device' };
}

/** A note's place: a city from the search, or the spot a device gave
 * ("Here"), kept exact; null when it is neither. The web and a token's note
 * (`/v1`) take the same. */
export function notePlaceOf(raw: unknown): PlaceRecord | null {
  if (object(raw)?.from === 'device') return devicePlace(raw);
  const city = clean(raw);
  return city ? { ...chosen(city) } : null;
}

/** A business or landmark near a device's spot, offered to name a note by
 * ("Caribou Coffee, Minneapolis"), never chosen for it: the nearest one is
 * as often a bus stop or a car park as where someone sat. */
export interface Venue {
  name: string;
  lat: number;
  lon: number;
  distance_m: number;
}
export interface SpotNames extends PlaceRecord {
  city: string;
  district?: string;
  nearby: Venue[];
}
/** The most businesses Here offers. */
export const NEARBY_MAX = 6;
// Kinds no one is "at" when they write a note.
const PASSING = /^(bus_stop|parking|ev_charging|atm|consumer_services|business_services|commercial|industrial)/;
/** The nearest few within the browser's accuracy, kept between a short
 * walk and a block or two, so a vague fix offers no far-off guesses. */
export const nearRadius = (accuracy?: number) => Math.min(Math.max(accuracy ?? 0, 50), 200);

/** Names a device's spot for a note: its city (and zone), the neighbourhood
 * the label defaults to, and the businesses close enough to offer. Falls
 * back to the city alone (`reverse`) where nothing nearby has an address. */
export async function nameSpot(spot: Spot, client = new GeoPlacesClient({})): Promise<SpotNames | null> {
  const answer = await client.send(
    new ReverseGeocodeCommand({
      QueryPosition: [spot.lon, spot.lat],
      IntendedUse: 'Storage',
      MaxResults: 15,
      Language: 'en',
      Filter: { IncludePlaceTypes: ['PointOfInterest', 'PointAddress', 'Street'] },
      AdditionalFeatures: ['TimeZone']
    })
  );
  const rows = answer.ResultItems ?? [],
    first = rows.find((r) => r.Address?.Locality);
  if (!first) {
    const city = await reverse(spot.lat, spot.lon, client);
    return city?.city ? { ...city, city: city.city, nearby: [] } : null;
  }
  const address = first.Address!,
    text = (v?: string) => codePointSlice(pythonTrim(v ?? ''), 0, 100),
    radius = nearRadius(spot.accuracy_m),
    found: SpotNames = {
      city: text(address.Locality),
      region: text(address.Region?.Name),
      country: text(address.Country?.Code2 === 'US' ? 'United States' : address.Country?.Name),
      nearby: []
    },
    district = text(address.District ?? address.SubDistrict);
  if (district && district !== found.city) found.district = district;
  const zone = rows.find((r) => r.TimeZone?.Name)?.TimeZone?.Name;
  if (validTimezone(zone)) found.tz = zone;
  for (const row of rows) {
    const name = text(row.Title),
      [lon, lat] = row.Position ?? [],
      kind = row.Categories?.find((c) => c.Primary)?.Id ?? row.Categories?.[0]?.Id ?? '';
    if (row.PlaceType !== 'PointOfInterest' || !name || PASSING.test(kind)) continue;
    if (typeof lat !== 'number' || typeof lon !== 'number' || (row.Distance ?? Infinity) > radius) continue;
    if (found.nearby.some((v) => v.name === name)) continue;
    found.nearby.push({
      name,
      lat: rounded(lat, SPOT_DIGITS),
      lon: rounded(lon, SPOT_DIGITS),
      distance_m: row.Distance!
    });
    if (found.nearby.length === NEARBY_MAX) break;
  }
  return found;
}
/** Names a photo's spot as Here does, by its neighbourhood, offering
 * nothing: no one is there to pick from what was near. */
export async function namePhoto(
  lat: number,
  lon: number,
  client = new GeoPlacesClient({})
): Promise<PlaceRecord | null> {
  const named = await nameSpot({ lat: rounded(lat, SPOT_DIGITS), lon: rounded(lon, SPOT_DIGITS) }, client);
  if (!named) return null;
  const place: PlaceRecord = { ...named };
  delete place.nearby;
  return place;
}
