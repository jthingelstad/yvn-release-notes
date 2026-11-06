/** Check-ins' pure rules (docs/CHECK-INS.md): the name a stop shows, the 100 m
 * match and the merge, with the morning that set the rule: two real shops a
 * minute apart stay two. Places here are fictional. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInId,
  checkInKey,
  checkInKeyOf,
  checkInName,
  continues,
  metres,
  nearestPlace,
  sameName,
  shownName,
  stayRevision,
  stayRow,
  stayTimes,
  stayView,
  UNNAMED_STOP,
  type CheckIn,
  type NamedPlace
} from '../../packages/domain/check-ins.ts';

// About 111 m a thousandth of a degree of latitude.
const HOME = { lat: 45, lon: -93 },
  NEAR = { lat: 45.0005, lon: -93 },
  FAR = { lat: 45.002, lon: -93 };
function stop(at: string, left: string | null, spot = HOME, more: Partial<CheckIn> = {}): CheckIn {
  return {
    id: `c${Date.parse(at)}-a`,
    at,
    arrived: at,
    left,
    source: 'visit',
    day: at.slice(0, 10),
    revision: 1,
    ...spot,
    ...more
  };
}
const place = (id: string, name: string, ...spots: { lat: number; lon: number }[]): NamedPlace => ({
  id,
  name,
  spots,
  revision: 1
});

test('metres goes along the ground, and 100 m is the same place', () => {
  assert.ok(Math.abs(metres(HOME, FAR) - 222.4) < 1, String(metres(HOME, FAR)));
  assert.equal(metres(HOME, HOME), 0);
  const home = place('p-1', 'Home', HOME);
  assert.equal(nearestPlace(NEAR, [home])?.id, 'p-1');
  assert.equal(nearestPlace(FAR, [home]), null);
});

test('the nearest of two remembered places names a stop', () => {
  const a = place('p-a', 'A', { lat: 45.0006, lon: -93 }),
    b = place('p-b', 'B', { lat: 45.0001, lon: -93 });
  assert.equal(nearestPlace(HOME, [a, b])?.id, 'p-b');
});

test('a second spot under one name reaches as far as either', () => {
  const big = place('p-b', 'The big place', HOME, FAR);
  assert.equal(nearestPlace(FAR, [big])?.id, 'p-b');
  assert.equal(nearestPlace({ lat: 45.0021, lon: -93 }, [big])?.id, 'p-b');
});

test('the name a stop shows, first match wins', () => {
  const home = place('p-1', 'Home', HOME),
    at = '2026-11-02T14:00:00.000Z',
    plain = stop(at, null);
  assert.deepEqual(shownName({ ...plain, name: 'Birthday', district: 'Uptown, Springfield' }, [home]), {
    label: 'Birthday',
    named_by: 'own',
    place: null
  });
  assert.deepEqual(shownName({ ...plain, district: 'Uptown, Springfield' }, [home]), {
    label: 'Home',
    named_by: 'place',
    place: 'p-1'
  });
  assert.deepEqual(shownName({ ...plain, district: 'Uptown, Springfield' }, []), {
    label: 'Uptown, Springfield',
    named_by: 'district',
    place: null
  });
  assert.deepEqual(shownName(plain, []), { label: UNNAMED_STOP, named_by: 'none', place: null });
});

test('two real places a minute apart stay two', () => {
  const shop = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z'),
    bakery = stop('2026-11-02T14:41:00.000Z', '2026-11-02T15:10:00.000Z', FAR);
  assert.equal(continues(shop, bakery, []), false);
});

test('a stop within 100 m and 30 minutes of the last one ending is the same stay', () => {
  const first = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z');
  assert.equal(continues(first, stop('2026-11-02T15:10:00.000Z', null, NEAR), []), true);
  assert.equal(continues(first, stop('2026-11-02T15:10:01.000Z', null, NEAR), []), false);
});

test('the same remembered place merges past 100 m; another does not', () => {
  const first = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z'),
    next = stop('2026-11-02T14:50:00.000Z', null, FAR);
  assert.equal(continues(first, next, [place('p-1', 'Both ends', HOME, FAR)]), true);
  assert.equal(continues(first, next, [place('p-1', 'One', HOME), place('p-2', 'Two', FAR)]), false);
});

test('a name kept apart holds two stops apart, and one name given to a stay holds it together', () => {
  const first = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z'),
    next = stop('2026-11-02T14:50:00.000Z', null, NEAR);
  assert.equal(continues({ ...first, name: 'Lunch' }, next, []), false);
  assert.equal(continues(first, { ...next, name: 'Lunch' }, []), false);
  assert.equal(continues({ ...first, name: 'Lunch' }, { ...next, name: 'Coffee' }, []), false);
  assert.equal(continues({ ...first, name: 'Lunch' }, { ...next, name: 'Lunch' }, []), true);
  // Far apart, a name says nothing about a place. A remembered place does, with
  // or without one, so naming a stay that holds two of its spots keeps it whole.
  const far = stop('2026-11-02T14:50:00.000Z', null, FAR);
  assert.equal(continues({ ...first, name: 'Lunch' }, { ...far, name: 'Lunch' }, []), false);
  const both = place('p-b', 'Campus', first, far);
  assert.equal(continues({ ...first, name: 'Lunch' }, { ...far, name: 'Lunch' }, [both]), true);
  assert.equal(continues({ ...first, name: 'Lunch' }, far, [both]), false);
});

test('a stay runs from the first arrival to the last leaving, and an open visit is still there', () => {
  const a = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z'),
    b = stop('2026-11-02T14:50:00.000Z', '2026-11-02T15:00:00.000Z'),
    open = stop('2026-11-02T15:10:00.000Z', null),
    tap = stop('2026-11-02T14:55:00.000Z', null, HOME, { source: 'tap' });
  assert.deepEqual(stayTimes([a, b]), { arrived: a.arrived, left: b.left });
  assert.deepEqual(stayTimes([a, b, open]), { arrived: a.arrived, left: null });
  // A tap is a moment, so the visit it fell in still says when it ended.
  assert.deepEqual(stayTimes([a, b, tap]), { arrived: a.arrived, left: b.left });
  assert.deepEqual(stayTimes([tap]), { arrived: tap.arrived, left: null });
  // Two tokens' reports of one stop, whichever sorts last: one heard it end.
  const heard = stop('2026-11-02T15:10:00.000Z', '2026-11-02T15:40:00.000Z');
  assert.deepEqual(stayTimes([heard, open]), { arrived: heard.arrived, left: heard.left });
  assert.deepEqual(stayTimes([open, heard]), { arrived: open.arrived, left: heard.left });
  assert.equal(stayRevision([a, { ...b, revision: 3 }]), 4);
});

test('a stop with no arrival begins when it left', () => {
  const stay = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:00:00.000Z', HOME, { arrived: null });
  assert.deepEqual(stayTimes([stay]), { arrived: null, left: '2026-11-02T14:00:00.000Z' });
});

test('a row says when and what it showed, and never where', () => {
  const home = place('p-1', 'Home', HOME),
    a = stop('2026-11-02T14:00:00.000Z', '2026-11-02T14:40:00.000Z', HOME, {
      pk: 'USER#u',
      via: 'token',
      token: 'Phone'
    }),
    b = stop('2026-11-02T14:50:00.000Z', null),
    row = stayRow([a, b], [home]);
  assert.equal(row.sk, `ACTIVITY#${a.at}#checkin#${a.id}`);
  assert.equal(row.label, 'Home');
  assert.equal(row.merged, 2);
  assert.equal(row.left, null);
  for (const hidden of ['lat', 'lon', 'accuracy_m', 'district', 'name', 'place']) assert.ok(!(hidden in row), hidden);
  const view = stayView([a, b], [home]);
  assert.deepEqual(view.ids, [a.id, b.id]);
  assert.equal(view.lat, HOME.lat);
  assert.equal(view.named_by, 'place');
});

test('an id finds its key', () => {
  const at = '2026-11-02T14:00:00.123Z',
    id = checkInId(at, 'abc123');
  assert.equal(checkInKeyOf(id), checkInKey(at, id));
  const old = '1969-07-20T20:17:00.000Z';
  assert.equal(checkInKeyOf(checkInId(old, 'ab')), checkInKey(old, checkInId(old, 'ab')));
  for (const wrong of ['places', 'c-x', 'c1-XYZ', 'c99999999999999999-a'])
    assert.equal(checkInKeyOf(wrong), null, wrong);
});

test('a name is one line of up to 100 characters, matched ignoring case', () => {
  assert.equal(checkInName('  Home '), 'Home');
  assert.equal(checkInName('é'.repeat(100)), 'é'.repeat(100));
  for (const wrong of ['', '   ', 'two\nlines', 'x'.repeat(101), 7, null]) assert.equal(checkInName(wrong), null);
  assert.ok(sameName('Corner Bakery', 'corner bakery'));
  assert.ok(!sameName('Corner Bakery', 'Bakery'));
});
