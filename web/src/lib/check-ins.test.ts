// How a check-in reads, in the zone of the place it was.
import { describe, expect, it } from 'vitest';
import { circleAround, lasted, stayLine, stopName } from './check-ins.ts';

const tz = 'America/Chicago';

describe('stayLine', () => {
  it('reads a stay in its own zone, to the minute', () => {
    expect(stayLine({ arrived: '2026-10-13T14:05:00Z', left: '2026-10-13T15:15:00Z' }, tz)).toBe(
      '9:05 AM to 10:15 AM, 70 min'
    );
    expect(stayLine({ arrived: '2026-10-13T14:05:00Z', left: '2026-10-13T15:15:00Z' }, 'Europe/Paris')).toBe(
      '4:05 PM to 5:15 PM, 70 min'
    );
  });
  it('names the day a stay ends on when it is another', () => {
    expect(stayLine({ arrived: '2026-10-14T02:05:00Z', left: '2026-10-14T12:00:00Z' }, tz)).toBe(
      '9:05 PM to Oct 14, 7:00 AM, 9 hr 55 min'
    );
  });
  it('says what is known of a stop still going, one with no arrival, and a tap', () => {
    expect(stayLine({ arrived: '2026-10-13T14:05:00Z', left: null, source: 'visit' }, tz)).toBe('Since 9:05 AM');
    expect(stayLine({ arrived: null, left: '2026-10-13T14:00:00Z', source: 'visit' }, tz)).toBe('Until 9:00 AM');
    expect(stayLine({ arrived: '2026-10-13T14:05:00Z', left: null, source: 'tap' }, tz)).toBe('At 9:05 AM');
    expect(stayLine({ arrived: null, left: null }, tz)).toBe('');
  });
});

it('reads lengths in minutes, then hours', () => {
  expect(lasted(0)).toBe('0 min');
  expect(lasted(119)).toBe('119 min');
  expect(lasted(120)).toBe('2 hr');
  expect(lasted(185)).toBe('3 hr 5 min');
});

it('calls a stop with no name an unnamed stop in a sentence', () => {
  expect(stopName('Unnamed stop')).toBe('an unnamed stop');
  expect(stopName('Home')).toBe('Home');
});

it('draws a closed ring the right distance out', () => {
  const ring = circleAround(45, -93, 100, 8);
  expect(ring).toHaveLength(9);
  expect(ring[0]).toEqual(ring[8]);
  expect(ring[0]![1]).toBeCloseTo(45 + 100 / 111_320, 6);
  // A degree of longitude is shorter this far north.
  expect(ring[2]![0]).toBeCloseTo(-93 + 100 / 111_320 / Math.cos(Math.PI / 4), 6);
});
