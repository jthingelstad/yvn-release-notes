// The timeline's quiet runs, the pages' polling, the Map's filters and trails and the book's giving line.
import { describe, expect, it, vi } from 'vitest';
import type { Day, Pin, Stay } from '../lib/types.ts';
import { POLL, pollWhileWriting } from '../lib/queries.ts';
import { groupQuiet } from './Timeline.tsx';
import {
  mapLede,
  moved,
  noteTrail,
  pickedHead,
  releaseMenu,
  sift,
  siftStays,
  stayTrail,
  trailLines,
  trailsSaid,
  type Live
} from './Map.tsx';
import { givingTo } from './Book.tsx';

const day = (date: string, more: Partial<Day> = {}): Day => ({ date, version: '1.2.3', notes: [], ...more });
const note = { id: 'w-1', source: 'web' as const, text: 'hi' };

describe('groupQuiet', () => {
  it('joins paused days in a row with no notes, newest first', () => {
    const rows = groupQuiet([
      day('2026-10-09', { notes: [note] }),
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

  it('joins empty days in a row apart from paused ones', () => {
    const rows = groupQuiet([
      day('2026-10-09'),
      day('2026-10-08'),
      day('2026-10-07', { paused: true }),
      day('2026-10-06'),
      day('2026-10-05', { notes: [note] }),
      day('2026-10-04')
    ]);
    expect(rows.map((r) => ('run' in r ? [r.paused, r.run.map((d) => d.date)] : r.day.date))).toEqual([
      [false, ['2026-10-09', '2026-10-08']],
      [true, ['2026-10-07']],
      [false, ['2026-10-06']],
      '2026-10-05',
      [false, ['2026-10-04']]
    ]);
  });

  it('keeps a paused day with a place of its own as its own row', () => {
    const rows = groupQuiet([
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
    version: release + '.1',
    written_at: null,
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
    version: '5.4.114',
    written_at: null,
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
    const { now, map } = live({ linked: { pins: [pins[0]!], stays: [] }, link: '2026-10-06#a#' });
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

describe('givingTo', () => {
  it("names the year's nonprofit, or says one goes each year before it is named", () => {
    expect(givingTo(2026)).toBe('Signal this year');
    expect(givingTo(2025)).toBe('the Electronic Frontier Foundation this year');
    expect(givingTo(2099)).toBe('a nonprofit, a different one each year');
  });
});

describe('check-ins on the map', () => {
  const stay = (id: string, release: string, label = 'Home') => ({ id, release, label }) as unknown as Stay;
  const stays = [stay('a', '5.4'), stay('b', '5.3')];
  const keep = (more: Partial<Parameters<typeof siftStays>[1]>) =>
    siftStays(stays, { show: '', tag: '', release: '', asked: false, ...more }).map((s) => s.id);
  it('shows them unless the menu says notes, and a release narrows them', () => {
    expect(keep({})).toEqual(['a', 'b']);
    expect(keep({ show: 'check-ins' })).toEqual(['a', 'b']);
    expect(keep({ show: 'notes' })).toEqual([]);
    expect(keep({ release: '5.3' })).toEqual(['b']);
  });
  it('leaves them off for a tag or words, which only notes have', () => {
    expect(keep({ tag: 'lake' })).toEqual([]);
    expect(keep({ asked: true })).toEqual([]);
  });
  it('says what is on the map, of how many', () => {
    expect(mapLede(0, undefined, 0, 0, false)).toBe(
      'No note has a place of its own yet. Add one with Where, or Here on a note.'
    );
    expect(mapLede(3, undefined, 0, 0, false)).toBe('3 notes with a place of their own.');
    expect(mapLede(1, undefined, 2, 2, false)).toBe('1 note with a place of its own, and 2 check-ins.');
    expect(mapLede(0, undefined, 2, 2, false)).toBe('2 check-ins.');
    expect(mapLede(3, 1, 2, 0, true)).toBe('1 of 3 notes with a place of their own, and 0 of 2 check-ins.');
    expect(mapLede(3, 0, 2, 0, true)).toBe('None of your 3 notes with a place of their own or your 2 check-ins match.');
    expect(mapLede(1, 0, 0, 0, true)).toBe('None of your 1 note with a place of its own matches.');
  });
  it('keeps every release on the menu with one chosen, by age, counting what shows', () => {
    const stays = [{ release: '9.9' }, { release: '10.0' }, { release: '10.0' }];
    expect(releaseMenu([{ release: '9.9', notes: 2 }], stays, '9.9')).toEqual([
      { release: '10.0', notes: 2 },
      { release: '9.9', notes: 3 }
    ]);
    expect(releaseMenu([], [], '9.9')).toEqual([{ release: '9.9', notes: 0 }]);
  });
  it('heads a list by what is in it', () => {
    const pin = { place: 'Paris' } as unknown as Pin;
    expect(pickedHead({ pins: [pin, pin], stays: [] })).toBe('2 notes in Paris');
    expect(pickedHead({ pins: [], stays: [stay('a', '5.4')] })).toBe('1 check-in at Home');
    expect(pickedHead({ pins: [pin], stays: [stay('a', '5.4')] })).toBe('1 note and 1 check-in in 2 places');
    expect(pickedHead({ pins: [], stays: [stay('a', '5.4', 'Unnamed stop')] })).toBe('1 check-in at an unnamed stop');
  });
});

describe('trails', () => {
  // A spot by its latitude alone, so a trail reads as a list of numbers.
  const at = (stamp: string, lat: number) => ({ at: stamp, lat, lon: 0 });
  const written = (date: string, stamp: string | null, lat: number) => ({ date, written_at: stamp, lat, lon: 0 });
  const lats = (steps: { lat: number }[]) => steps.map((s) => s.lat);

  it('joins check-ins in the order each stop began, comparing instants whatever the offset', () => {
    // Newest first, as GET /api/check-ins lists them. By the stamps' spelling
    // 09:00-06:00 would come first; as instants it is the last to begin.
    const stays = [
      at('2026-11-08T09:00:00-06:00', 1),
      at('2026-11-08T14:00:00Z', 2),
      at('2026-11-08T10:00:00+01:00', 3)
    ];
    expect(lats(stayTrail(stays))).toEqual([3, 2, 1]);
  });

  it('keeps the older of two check-ins that began at the same instant first', () => {
    // One instant spelled two ways: the one listed later is the older.
    expect(lats(stayTrail([at('2026-11-08T12:00:00Z', 1), at('2026-11-08T06:00:00-06:00', 2)]))).toEqual([2, 1]);
  });

  it('joins notes by day, then by when each was written, as instants', () => {
    const pins = [
      written('2026-11-08', '2026-11-08T08:00:00-06:00', 1),
      written('2026-11-07', '2026-11-07T23:00:00Z', 2),
      written('2026-11-08', '2026-11-08T13:30:00Z', 3),
      written('2026-11-07', '2026-11-07T09:00:00+02:00', 4)
    ];
    // 08:00-06:00 is 14:00 UTC, so it was written after 13:30 UTC.
    expect(lats(noteTrail(pins))).toEqual([4, 2, 3, 1]);
  });

  it('puts a note without a time after its day’s others, in the order it came', () => {
    const pins = [
      written('2026-11-08', null, 1),
      written('2026-11-08', '2026-11-08T20:00:00Z', 2),
      written('2026-11-07', null, 3),
      written('2026-11-08', 'not a time', 4),
      written('2026-11-08', '2026-11-08T07:00:00Z', 5)
    ];
    expect(lats(noteTrail(pins))).toEqual([3, 5, 2, 1, 4]);
  });

  it('drops a spot that repeats the one just before, never a return later on', () => {
    const stays = [
      at('2026-11-08T15:00:00Z', 1),
      at('2026-11-08T14:00:00Z', 2),
      at('2026-11-08T13:00:00Z', 2),
      at('2026-11-08T12:00:00Z', 1),
      at('2026-11-08T11:00:00Z', 1)
    ];
    expect(lats(stayTrail(stays))).toEqual([1, 2, 1]);
    const pins = [
      written('2026-11-08', '2026-11-08T07:00:00Z', 5),
      written('2026-11-08', '2026-11-08T08:00:00Z', 5),
      written('2026-11-08', '2026-11-08T09:00:00Z', 6)
    ];
    expect(lats(noteTrail(pins))).toEqual([5, 6]);
  });

  it('draws a line for each kind with two spots or more, as [lon, lat]', () => {
    const stays = [
        { at: '2026-11-08T15:00:00Z', lat: 44.98, lon: -93.27 },
        { at: '2026-11-08T12:00:00Z', lat: 44.95, lon: -93.1 }
      ],
      pins = [
        { date: '2026-11-08', written_at: '2026-11-08T13:00:00Z', lat: 46.79, lon: -92.1 },
        { date: '2026-11-08', written_at: '2026-11-08T14:00:00Z', lat: 46.79, lon: -92.1 }
      ];
    expect(trailLines(pins, stays)).toEqual([
      {
        kind: 'check-ins',
        line: [
          [-93.1, 44.95],
          [-93.27, 44.98]
        ]
      }
    ]);
    expect(trailLines([...pins, { ...pins[0]!, date: '2026-11-09', lat: 47 }], [])).toEqual([
      {
        kind: 'notes',
        line: [
          [-92.1, 46.79],
          [-92.1, 47]
        ]
      }
    ]);
    expect(trailLines([pins[0]!], [stays[0]!])).toEqual([]);
    expect(trailLines([], [])).toEqual([]);
  });

  it('says what each line means, for the lines it drew', () => {
    expect(trailsSaid(['check-ins', 'notes'])).toBe(
      'A solid line joins the check-ins in the order you stopped, and a dotted one the notes in the order you wrote them.'
    );
    expect(trailsSaid(['check-ins'])).toBe('A solid line joins the check-ins in the order you stopped.');
    expect(trailsSaid(['notes'])).toBe('A dotted line joins the notes in the order you wrote them.');
    expect(trailsSaid([])).toBe('');
  });
});
