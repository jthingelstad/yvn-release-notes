// The timeline's paused runs, the pages' polling and the Map's filters.
import { describe, expect, it, vi } from 'vitest';
import type { Day, Pin } from '../lib/types.ts';
import { POLL, pollWhileWriting } from '../lib/queries.ts';
import { groupPaused } from './Timeline.tsx';
import { moved, sift, type Live } from './Map.tsx';

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
  const pin = (date: string, id: string, release: string, tags: string[] = []): Pin => ({
    date,
    id,
    lat: 44.98,
    lon: -93.27,
    place: 'Minneapolis',
    exact: true,
    tags,
    release,
    text: '',
    parts: []
  });
  const pins = [
    pin('2026-10-06', 'a', '5.4', ['cabin', 'lake']),
    pin('2026-07-04', 'b', '5.4', ['lake']),
    pin('2025-08-01', 'c', '5.3', ['cabin']),
    pin('2025-01-02', 'd', '5.3')
  ];
  const ids = (p: Pin[]) => p.map((x) => x.id);

  it('keeps every pin, and offers every tag and release, with no filter', () => {
    const all = sift(pins, { tag: '', release: '', found: null });
    expect(ids(all.shown)).toEqual(['a', 'b', 'c', 'd']);
    expect(all.tags).toEqual([
      { tag: 'cabin', notes: 2 },
      { tag: 'lake', notes: 2 }
    ]);
    expect(all.releases).toEqual([
      { release: '5.4', notes: 2 },
      { release: '5.3', notes: 2 }
    ]);
  });

  it('keeps the pins every filter keeps, and each menu offers what the others leave', () => {
    const lake = sift(pins, { tag: 'lake', release: '', found: null });
    expect(ids(lake.shown)).toEqual(['a', 'b']);
    expect(lake.releases).toEqual([{ release: '5.4', notes: 2 }]);
    expect(lake.tags.map((t) => t.tag)).toEqual(['cabin', 'lake']);
    const then = sift(pins, { tag: '', release: '5.3', found: null });
    expect(ids(then.shown)).toEqual(['c', 'd']);
    expect(then.tags).toEqual([{ tag: 'cabin', notes: 1 }]);
    const words = sift(pins, { tag: 'cabin', release: '', found: new Set(['2025-08-01#c', '2025-01-02#d']) });
    expect(ids(words.shown)).toEqual(['c']);
    expect(words.releases).toEqual([{ release: '5.3', notes: 1 }]);
  });

  it('keeps a choice that keeps nothing on its menu', () => {
    const none = sift(pins, { tag: 'lake', release: '5.3', found: null });
    expect(none.shown).toEqual([]);
    expect(none.tags).toContainEqual({ tag: 'lake', notes: 0 });
    expect(none.releases).toContainEqual({ release: '5.3', notes: 0 });
  });

  it('lists releases newest first by age, 10.0 before 9.9', () => {
    const decades = sift(
      [pin('2026-01-01', 'x', '9.9'), pin('2026-01-02', 'y', '4.4'), pin('2026-01-03', 'z', '10.0')],
      {
        tag: '',
        release: '',
        found: null
      }
    );
    expect(decades.releases.map((r) => r.release)).toEqual(['10.0', '9.9', '4.4']);
  });
});

describe('moved', () => {
  const pin = (id: string, lon: number): Pin => ({
    date: '2026-10-06',
    id,
    lat: 48.85,
    lon,
    place: 'Paris',
    exact: true,
    tags: [],
    release: '5.4',
    text: '',
    parts: []
  });
  class Bounds {
    spots: number[][] = [];
    extend(spot: number[]) {
      this.spots.push(spot);
    }
  }
  const pins = [pin('a', 2.35), pin('b', 2.36)];
  const live = (more: Partial<Live>) => {
    const map = { easeTo: vi.fn(), fitBounds: vi.fn() };
    const now = {
      pins,
      linked: null,
      at: null,
      link: '',
      view: '',
      framed: '',
      centred: '',
      map,
      lib: { LngLatBounds: Bounds },
      ...more
    } as unknown as Live;
    return { now, map };
  };

  it('does not move to what the map already shows', () => {
    const { now, map } = live({});
    moved(now);
    expect([map.easeTo.mock.calls.length, map.fitBounds.mock.calls.length]).toEqual([0, 0]);
  });

  it('closes in on a link it has not shown, then fits every pin once the link is gone', () => {
    const { now, map } = live({ linked: [pins[0]!], link: '2026-10-06#a#' });
    moved(now);
    expect(map.easeTo).toHaveBeenCalledWith({ center: [2.35, 48.85], zoom: 15 });
    Object.assign(now, { linked: null, link: '' });
    moved(now);
    expect((map.fitBounds.mock.calls[0]![0] as Bounds).spots).toEqual([
      [2.35, 48.85],
      [2.36, 48.85]
    ]);
    moved(now);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });

  it('waits for the words before fitting, then fits once', () => {
    const { now, map } = live({ view: null });
    moved(now);
    expect(map.fitBounds).not.toHaveBeenCalled();
    now.view = 'cabin\n\n';
    moved(now);
    moved(now);
    expect(map.fitBounds).toHaveBeenCalledTimes(1);
  });
});
