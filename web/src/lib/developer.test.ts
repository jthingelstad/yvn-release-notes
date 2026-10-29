// Developer mode's plain parts: the seven-tap counter and the panel's numbers.
import { describe, expect, it } from 'vitest';
import {
  binary,
  developer,
  GAP_MS,
  hex,
  noTaps,
  patchDone,
  roman,
  romanVersion,
  shortHash,
  subject,
  tap,
  uptime,
  type Taps
} from './developer.ts';

// Taps `n` times, `every` ms apart, from `s`; what each tap said.
function taps(n: number, every = 300, s: Taps = noTaps(), from = 10_000) {
  const said: string[] = [];
  let turnedOn = false;
  for (let i = 0; i < n; i++) {
    const r = tap(s, from + i * every);
    s = r.next;
    said.push(r.say);
    turnedOn ||= r.turnedOn;
  }
  return { s, said, turnedOn };
}

describe('the seven-tap counter', () => {
  it('counts down from the fourth tap and turns on at the seventh', () => {
    const { s, said, turnedOn } = taps(7);
    expect(said).toEqual([
      '',
      '',
      '',
      '3 taps from being a developer.',
      '2 taps from being a developer.',
      '1 tap from being a developer.',
      'You are now a developer.'
    ]);
    expect(turnedOn).toBe(true);
    expect(s.on).toBe(true);
  });
  it('says so once on, and never turns on again', () => {
    const { said, turnedOn } = taps(3, 300, noTaps(true));
    expect(said).toEqual(Array(3).fill('No need, you are already a developer.'));
    expect(turnedOn).toBe(false);
  });
  it('starts over after a gap of more than two seconds', () => {
    const six = taps(6);
    expect(six.s.on).toBe(false);
    const late = tap(six.s, six.s.last + GAP_MS + 1);
    expect([late.next.count, late.say, late.turnedOn]).toEqual([1, '', false]);
    // Exactly two seconds still counts.
    const onTime = tap(six.s, six.s.last + GAP_MS);
    expect([onTime.say, onTime.turnedOn]).toEqual(['You are now a developer.', true]);
  });
  it('is kept in this browser', () => {
    developer.set(true);
    expect(developer.get()).toBe(true);
    developer.set(false);
    expect(developer.get()).toBe(false);
  });
});

describe('the panel', () => {
  it('writes the version in hex, binary and Roman numerals, part by part', () => {
    expect(hex('5.4.300')).toBe('5.4.12c');
    expect(binary('5.4.300')).toBe('101.100.100101100');
    expect(romanVersion('5.4.300')).toBe('V.IV.CCC');
    expect(romanVersion('4.0.0')).toBe('IV.N.N');
    expect(romanVersion('3.9.364')).toBe('III.IX.CCCLXIV');
    expect([roman(0), roman(1), roman(14), roman(49), roman(365)]).toEqual(['N', 'I', 'XIV', 'XLIX', 'CCCLXV']);
  });
  it('gives a note the same seven-digit hash every time', () => {
    const a = shortHash('w-0123456789abcdef');
    expect(a).toMatch(/^[0-9a-f]{7}$/);
    expect(shortHash('w-0123456789abcdef')).toBe(a);
    expect(shortHash('w-0123456789abcdeg')).not.toBe(a);
    expect(shortHash('')).toBe('811c9dc');
  });
  it('cuts a subject at a few words', () => {
    expect(subject('Shipped the  new\nporch light today and it works')).toBe('Shipped the new porch light today…');
    expect(subject('Short one')).toBe('Short one');
  });
  it('counts uptime from midnight of the birthday and the patch through the local day', () => {
    // Midnight 1981-06-14 in Chicago is 05:00 UTC (CDT).
    const born = Date.parse('1981-06-14T05:00:00Z');
    expect(uptime('1981-06-14', 'America/Chicago', born + 90_500)).toBe(90);
    expect(uptime('1981-06-14', 'America/Chicago', born - 1000)).toBe(0);
    const noon = Date.parse('2026-10-13T17:00:00Z');
    expect(patchDone('2026-10-13', 'America/Chicago', noon)).toBeCloseTo(50, 6);
    // The day the clocks go back has 25 hours.
    expect(patchDone('2026-11-01', 'America/Chicago', Date.parse('2026-11-01T17:30:00Z'))).toBeCloseTo(
      (12.5 * 100) / 25,
      6
    );
  });
});
