// The plain helpers: what the pages say, dates, and the birthday fields.
import { describe, expect, it } from 'vitest';
import { emptyMdy, mdyOf, mdyValue } from '../components/fields.tsx';
import { addDays, clock, count, megabytes, pauseLine, SEND_TIMES } from './format.ts';
import { sayFor, SAY } from './say.ts';

describe('sayFor', () => {
  it('says the line for a known error, and a fallback otherwise', () => {
    expect(sayFor({ error: 'email' })).toBe(SAY.email);
    expect(sayFor({ error: 'nothing-like-it' })).toBe('Something went wrong. Try again.');
    expect(sayFor({}, 'Other.')).toBe('Other.');
  });

  it('counts the tries left after a wrong code', () => {
    expect(sayFor({ error: 'wrong-code', tries_left: 1 })).toBe('That code doesn’t match. One try left.');
    expect(sayFor({ error: 'wrong-code', tries_left: 3 })).toBe('That code doesn’t match. 3 tries left.');
  });

  it('starts a file’s error with its name', () => {
    expect(sayFor({ error: 'file-too-big', file: 'a.mov' })).toBe('a.mov is over 50 MB, more than one file can be.');
    // A whole sentence does not take the name.
    expect(sayFor({ error: 'too-many-files', file: 'a.jpg' })).toBe('A note holds up to 20 files.');
  });

  it('links back to sign in when signed out, saying what became of the draft', () => {
    const line = sayFor({ error: 'signed-out', draft: 'kept' });
    expect(Array.isArray(line)).toBe(true);
    expect(line).toContainEqual({ href: '/#sign-in', text: 'sign in again', back: true });
  });
});

describe('format', () => {
  it('reads a send time on a 12-hour clock', () => {
    expect(clock('00:00')).toBe('12:00 AM');
    expect(clock('06:15')).toBe('6:15 AM');
    expect(clock('12:00')).toBe('12:00 PM');
    expect(clock('23:45')).toBe('11:45 PM');
  });

  it('offers every quarter hour', () => {
    expect(SEND_TIMES).toHaveLength(96);
    expect(SEND_TIMES[0]).toBe('00:00');
    expect(SEND_TIMES[25]).toBe('06:15');
    expect(SEND_TIMES[95]).toBe('23:45');
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('counts and sizes', () => {
    expect(count(1, 'note', 'notes')).toBe('1 note');
    expect(count(0, 'note', 'notes')).toBe('0 notes');
    expect(megabytes(10)).toBe('1 KB');
    expect(megabytes(2_500_000)).toBe('2.5 MB');
    expect(megabytes(25_000_000)).toBe('25 MB');
    expect(megabytes(1_200_000_000)).toBe('1.2 GB');
  });

  it('says a pause under way and one not yet begun', () => {
    const p = { today: '2026-10-09', send_time: '06:00' };
    expect(pauseLine({ ...p, pause: { from: '2026-10-09', through: '2026-10-15' } })).toBe(
      'Paused through Thursday, October 15. They start again Friday, October 16 at 6:00 AM.'
    );
    expect(pauseLine({ ...p, pause: { from: '2026-10-12', through: '2026-10-13' } })).toBe(
      'Paused from Monday, October 12 through Tuesday, October 13.'
    );
    expect(pauseLine(p)).toBe('');
  });
});

describe('the birthday fields', () => {
  it('make a date only from a real one', () => {
    expect(mdyValue({ month: '6', day: '14', year: '1981' })).toBe('1981-06-14');
    expect(mdyValue({ month: '2', day: '29', year: '2024' })).toBe('2024-02-29');
    expect(mdyValue({ month: '2', day: '29', year: '2023' })).toBe('');
    expect(mdyValue({ month: '6', day: '14', year: '81' })).toBe('');
    expect(mdyValue(emptyMdy)).toBe('');
  });

  it('read back what they made', () => {
    expect(mdyValue(mdyOf('1981-06-14'))).toBe('1981-06-14');
  });
});
