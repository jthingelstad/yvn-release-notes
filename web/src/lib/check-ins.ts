// How a check-in reads (docs/CHECK-INS.md): by the times of the place it was,
// in that place's zone, with no travel time ever added up.
import { UNNAMED_STOP } from '../../../packages/domain/check-ins.ts';
import { zoneShortDate, zoneTime } from './format.ts';

export const checkInHref = (id: string) => `/check-in/#c=${encodeURIComponent(id)}`;

// "Home", or a stop with no name as a sentence has it.
export const stopName = (label: string) => (label === UNNAMED_STOP ? 'an unnamed stop' : label);

// "70 min", and past two hours "3 hr 5 min".
export function lasted(minutes: number): string {
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60),
    rest = minutes % 60;
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
}

interface Times {
  arrived?: string | null;
  left?: string | null;
  source?: string;
}
// What is known of a stay: "9:05 AM to 10:15 AM, 70 min", the day too when it
// ends on another. iOS can report a stop with no arrival, and a stop can still
// be going on. A tap is a moment, not a stay.
export function stayLine({ arrived, left, source }: Times, tz: string): string {
  if (arrived && left) {
    const days = zoneShortDate(arrived, tz) !== zoneShortDate(left, tz),
      end = (days ? zoneShortDate(left, tz) + ', ' : '') + zoneTime(left, tz),
      minutes = Math.round((Date.parse(left) - Date.parse(arrived)) / 60_000);
    return `${zoneTime(arrived, tz)} to ${end}, ${lasted(minutes)}`;
  }
  if (arrived) return source === 'tap' ? `At ${zoneTime(arrived, tz)}` : `Since ${zoneTime(arrived, tz)}`;
  return left ? `Until ${zoneTime(left, tz)}` : '';
}

// A ring around a spot, for the map to draw: `radius` metres, as lon, lat.
export function circleAround(lat: number, lon: number, radius: number, steps = 64): [number, number][] {
  const north = radius / 111_320,
    east = north / Math.max(Math.cos((lat * Math.PI) / 180), 0.01);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const turn = (2 * Math.PI * (i % steps)) / steps;
    return [lon + east * Math.sin(turn), lat + north * Math.cos(turn)];
  });
}
