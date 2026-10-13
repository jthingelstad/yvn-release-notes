/** City-level places. Forward search shares only the query with Open-Meteo;
 * reverse geocoding shares rounded coordinates with Amazon Location. */
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
