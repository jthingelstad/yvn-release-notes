/** The badges earned outside notes (docs/BADGES.md) agree wherever they are
 * worked out: the stored rows read by `badges` (the page, the email and
 * notes_badges) and the export's rows in hand. A failed read of the event
 * rows leaves the rest working. Fictional subscribers only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
import { badges, earnedBy, freshEvent, unlockedByEvents } from '../../packages/backend/badges.ts';
import { build } from '../../packages/backend/export.ts';
import type { Item } from '../../packages/backend/store.ts';

const T = (day: string, hour = '15') => `2026-10-${day}T${hour}:00:00.000Z`;
function account() {
  const store = new FakeStore(
    [
      {
        pk: 'USER#u',
        sk: 'PROFILE',
        email: 'ada@example.com',
        birthday: '1981-06-14',
        tz: 'America/Chicago',
        status: 'active',
        // The photo was set and its row kept; giving is on the stored profile.
        photo: { key: 'media/u/profile/p.jpg', at: T('11'), size: 9, side: 512 },
        giving: { 2026: { first: '2026-10-12', last: '2026-10-12' } }
      }
    ],
    'T'
  );
  const activity = (at: string, kind: string, id: string, extra: Item = {}) =>
    store.seed({ pk: 'USER#u', sk: `ACTIVITY#${at}#${kind}#${id}`, kind, at, ...extra });
  activity(T('11'), 'photo.set', 'p', { via: 'web' });
  activity(T('12'), 'export.book', 'b', { from: '2026-10-01', to: '2026-10-12' });
  activity(T('12', '16'), 'note.edited', 'n', { via: 'assistant', client: 'Claude', day: '2026-10-12', note: 'w-a' });
  activity(T('13'), 'upcoming.added', 'e1', { via: 'web', upcoming: 'e1' });
  activity(T('13', '16'), 'upcoming.added', 'gone', { via: 'web', upcoming: 'gone' });
  activity(T('13', '17'), 'upcoming.removed', 'gone', { via: 'web', upcoming: 'gone' });
  store.seed({
    pk: 'USER#u',
    sk: 'UPCOMING#e1',
    id: 'e1',
    kind: 'event',
    title: 'Fictional party',
    date: '2026-11-01',
    revision: 1,
    created_at: T('13')
  });
  // From before the activity log: an entry alone.
  store.seed({
    pk: 'USER#u',
    sk: 'UPCOMING#old',
    id: 'old',
    kind: 'birthday',
    title: 'Fictional friend',
    date: '03-03',
    revision: 1,
    created_at: '2026-10-05T15:00:00Z'
  });
  store.seed({
    pk: 'USER#u',
    sk: 'FEEDBACK#f1',
    id: 'f1',
    kind: 'idea',
    text: 'Fictional idea',
    status: 'done',
    via: 'web',
    filed_at: '2026-10-12T15:00:00Z',
    updated_at: '2026-10-13T15:00:00Z',
    revision: 2,
    answers: [{ at: '2026-10-13T15:00:00Z', text: 'Built', status: 'done' }],
    screenshots: []
  });
  return store;
}
const shape = (list: { key?: string; id: string; level?: string; version: string; day: string }[]) =>
  list.map((e) => [e.level ? `${e.id}:${e.level.toLowerCase()}` : e.id, e.version, e.day]).sort();

test('the page, the email and the export agree on what was earned outside notes', async () => {
  const store = account(),
    today = '2026-10-13',
    shown = await badges(store, 'u', (await store.profile('u'))!, today),
    exported = build(await store.userItems('u'), '2026-10-13T20:00:00Z').badges ?? [];
  assert.deepEqual(
    shown.earned.map((e) => e.key).sort(),
    ['giving-2026', 'issue', 'merged', 'pair', 'roadmap:alpha', 'signed', 'tarball'].sort()
  );
  assert.deepEqual(shape(exported), shape(shown.earned));
  // Three dates ever added, one since deleted.
  assert.deepEqual(
    [shown.tracks.find((t) => t.id === 'roadmap')!.best, shown.tracks.find((t) => t.id === 'roadmap')!.now],
    [3, 3]
  );
});

test('a failed read of the event rows leaves badges working, logs only the user and the read, and claims nothing', async () => {
  const store = account(),
    logs: Item[] = [],
    log = (f: Item) => void logs.push(f),
    profile = (await store.profile('u'))!;
  await store.putNote('u', '2026-10-13', 'w-b', { text: 'Fictional words', source: 'web' });
  store.badgeActivity = async () => {
    throw new Error('ProvisionedThroughputExceededException');
  };
  const shown = await badges(store, 'u', profile, '2026-10-13', log);
  assert.ok(
    shown.earned.some((e) => e.key === 'hello'),
    'note badges still come'
  );
  assert.ok(
    shown.earned.some((e) => e.key === 'issue'),
    'feedback was still read'
  );
  assert.ok(!shown.earned.some((e) => e.key === 'signed'), 'the photo from the profile is not counted twice');
  assert.deepEqual(logs, [{ event: 'badge-facts-partial', user: 'u', failed: 'activity' }]);
  // An action then claims none of the badges events earn: its rows might
  // hold them already.
  const fresh = [freshEvent('tarball', 'new-book', Date.parse(T('13', '18')) / 1000, profile.tz)];
  assert.deepEqual(await unlockedByEvents(store, 'u', profile, '2026-10-13', fresh, log), []);
  // Every read failing: still nothing thrown, nothing earned, nothing written.
  store.feedbackItems = store.upcomingEntries = async () => {
    throw new Error('TimeoutError');
  };
  const won = await earnedBy(store, 'u', profile, Date.parse(T('13', '18')) / 1000, fresh, {
    via: 'web',
    seen: true,
    log
  });
  assert.deepEqual(won, { unlocked: [], events: [] });
  assert.equal((await store.seenBadges('u')).size, 0);
  assert.ok(!JSON.stringify(logs).includes('Fictional'));
});
