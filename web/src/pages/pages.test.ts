// The timeline's paused runs, the pages' polling and the Map's filters.
import { describe, expect, it } from 'vitest';
import type { Day, Pin } from '../lib/types.ts';
import { POLL, pollWhileWriting } from '../lib/queries.ts';
import { groupPaused } from './Timeline.tsx';
import { sift } from './Map.tsx';

const day = (date: string, more: Partial<Day> = {}): Day => ({ date, version: '1.2.3', notes: [], ...more });
const note = { id: 'w-1', source: 'web' as const, text: 'hi' };

describe('groupPaused', () => {
  it('joins paused days in a row with no notes, newest first', () => {
    const rows = groupPaused([
      day('2026-10-09'),
      day('2026-10-08', { paused: true }),
      day('2026-10-07', { paused: true }),
      day('2026-10-06', { paused: true, notes: [note] }),
      day('2026-10-05', { paused: true }),
      day('2026-10-03', { paused: true })
    ]);
    expect(rows.map((r) => ('run' in r ? r.run.map((d) => d.date) : r.day.date))).toEqual([
      '2026-10-09',
      ['2026-10-08', '2026-10-07'],
      '2026-10-06',
      ['2026-10-05'],
      ['2026-10-03']
    ]);
  });

  it('keeps a paused day with a place of its own as its own row', () => {
    const rows = groupPaused([
      day('2026-10-08', { paused: true }),
      day('2026-10-07', { paused: true, where: 'Duluth, Minnesota' }),
      day('2026-10-06', { paused: true })
    ]);
    expect(rows.map((r) => ('run' in r ? r.run.map((d) => d.date) : r.day.date))).toEqual([
      ['2026-10-08'],
      '2026-10-07',
      ['2026-10-06']
    ]);
  });
});

describe('pollWhileWriting', () => {
  const q = (writing: boolean, dataUpdateCount = 1) => ({
    state: {
      data: { notes: [{ ...note, media: [{ n: 0, kind: 'audio' as const, type: 'audio/mp4', writing }] }] },
      dataUpdateCount
    }
  });

  it('looks again while a recording is being written out, twenty times at most', () => {
    expect(pollWhileWriting(q(true))).toBe(POLL);
    expect(pollWhileWriting(q(true, 21))).toBe(false);
    expect(pollWhileWriting(q(false))).toBe(false);
    expect(pollWhileWriting({ state: { dataUpdateCount: 0 } })).toBe(false);
  });
});

describe('sift', () => {
  const pin = (date: string, id: string, tags: string[] = []): Pin => ({
    date,
    id,
    lat: 44.98,
    lon: -93.27,
    place: 'Minneapolis',
    exact: true,
    tags,
    text: '',
    parts: []
  });
  const pins = [
    pin('2026-10-06', 'a', ['cabin', 'lake']),
    pin('2026-07-04', 'b', ['lake']),
    pin('2025-08-01', 'c', ['cabin']),
    pin('2025-01-02', 'd')
  ];
  const ids = (p: Pin[]) => p.map((x) => x.id);

  it('keeps every pin, and offers every tag and year, with no filter', () => {
    const all = sift(pins, { tag: '', year: '', found: null });
    expect(ids(all.shown)).toEqual(['a', 'b', 'c', 'd']);
    expect(all.tags).toEqual([
      { tag: 'cabin', notes: 2 },
      { tag: 'lake', notes: 2 }
    ]);
    expect(all.years).toEqual([
      { year: '2026', notes: 2 },
      { year: '2025', notes: 2 }
    ]);
  });

  it('keeps the pins every filter keeps, and each menu offers what the others leave', () => {
    const lake = sift(pins, { tag: 'lake', year: '', found: null });
    expect(ids(lake.shown)).toEqual(['a', 'b']);
    expect(lake.years).toEqual([{ year: '2026', notes: 2 }]);
    expect(lake.tags.map((t) => t.tag)).toEqual(['cabin', 'lake']);
    const then = sift(pins, { tag: '', year: '2025', found: null });
    expect(ids(then.shown)).toEqual(['c', 'd']);
    expect(then.tags).toEqual([{ tag: 'cabin', notes: 1 }]);
    const words = sift(pins, { tag: 'cabin', year: '', found: new Set(['2025-08-01#c', '2025-01-02#d']) });
    expect(ids(words.shown)).toEqual(['c']);
    expect(words.years).toEqual([{ year: '2025', notes: 1 }]);
  });

  it('keeps a choice that keeps nothing on its menu', () => {
    const none = sift(pins, { tag: 'lake', year: '2025', found: null });
    expect(none.shown).toEqual([]);
    expect(none.tags).toContainEqual({ tag: 'lake', notes: 0 });
    expect(none.years).toContainEqual({ year: '2025', notes: 0 });
  });
});
