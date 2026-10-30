/** Fictional owners and services prove isolation, web guards, CAS and cleanup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { markdown } from '../../packages/backend/export.ts';
const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  origin = 'https://notes.example.com';
const birthday = { kind: 'birthday', title: 'Alex', date: '10-20', year: 1976 };
const place = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
async function fixture() {
  const store = new FakeStore(
      ['u', 'b'].map((uid) => ({
        pk: 'USER#' + uid,
        sk: 'PROFILE',
        email: uid + '@example.com',
        birthday: '1981-06-14',
        tz: 'America/Chicago',
        send_time: '06:00',
        status: 'active'
      })),
      'T',
      1
    ),
    logs: Item[] = [];
  for (const uid of ['u', 'b'])
    await store.putSession(auth.digest(uid.repeat(43)), { user_id: uid, now, expires: now + 86400 });
  const ctx: ApiContext = {
    store,
    now,
    origin,
    objects: new FakeObjects(),
    mail: new FakeMail(),
    invocations: new FakeInvocations(),
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    log: (f) => logs.push(f)
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path = '/api/upcoming', value?: unknown, uid = 'u', from = origin) {
    const response = await app.request(path, {
      method,
      headers: { origin: from, cookie: auth.COOKIE + '=' + uid.repeat(43) },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, data: await response.json() };
  }
  return { store, ctx, call, logs };
}
test('all kinds create, read, update and delete privately without touching notes/home; export retains saved plans', async () => {
  const f = await fixture();
  for (const value of [
    birthday,
    { kind: 'anniversary', title: 'A project', date: '10-14', year: 2016 },
    { kind: 'trip', title: 'Holiday', date: '2026-10-20', end_date: '2026-10-27', place },
    { kind: 'event', title: 'Concert', date: '2026-10-01', email: false }
  ]) {
    const created = await f.call('POST', undefined, value);
    assert.equal(created.status, 201);
    assert.doesNotMatch(JSON.stringify(created.data), /"(?:pk|sk)"/);
  }
  const list = (await f.call('GET')).data;
  assert.equal(list.entries.length, 4); // fake pages hold one row
  assert.equal(list.entries.at(-1).occurrence.status, 'past');
  assert.equal((await f.call('GET', undefined, undefined, 'b')).data.entries.length, 0);
  const id = list.entries.find((e: Item) => e.title === 'Alex').id;
  assert.equal((await f.call('PUT', '/api/upcoming/' + id, { ...birthday, title: 'Alexa', revision: 1 })).status, 200);
  assert.equal((await f.call('PUT', '/api/upcoming/' + id, { ...birthday, revision: 1 })).status, 409);
  assert.equal((await f.call('DELETE', '/api/upcoming/' + id, { revision: 1 })).status, 409);
  assert.equal((await f.call('DELETE', '/api/upcoming/' + id, { revision: 2 }, 'b')).status, 404);
  assert.equal((await f.store.allNotes('u')).length, 0);
  assert.equal((await f.store.profile('u'))?.tz, 'America/Chicago');
  const exported = (await f.call('GET', '/api/export')).data;
  assert.equal(exported.upcoming.length, 4);
  assert.equal(exported.notes.length, 0);
  assert.doesNotMatch(JSON.stringify(exported.upcoming), /USER#|UPCOMING#/);
  assert.equal((await f.call('DELETE', '/api/upcoming/' + id, { revision: 2 })).status, 200);
  assert.equal((await f.store.profile('u'))?.upcoming_count, 3);
  assert.doesNotMatch(JSON.stringify(f.logs), /Alex|Paris|Concert|@example/);
});
test('optional tags normalize, persist, clear and export without entering journal tags or logs', async () => {
  const f = await fixture();
  const saved = (await f.call('POST', undefined, { ...birthday, tag: ' #SPS ' })).data;
  assert.equal(saved.tag, 'sps');
  assert.equal((await f.call('GET')).data.entries[0].tag, 'sps');
  const exported = (await f.call('GET', '/api/export')).data;
  assert.equal(exported.upcoming[0].tag, 'sps');
  assert.ok(markdown(exported).includes('Tag: \\#sps.'));
  assert.deepEqual((await f.call('GET', '/api/tags')).data.tags, []);
  for (const [revision, tag] of [
    [1, 'Équipe-2016'],
    [2, ''],
    [3, null],
    [4, undefined]
  ] as const) {
    const result = await f.call('PUT', '/api/upcoming/' + saved.id, { ...birthday, tag, revision });
    assert.equal(result.status, 200);
    assert.equal(result.data.tag, revision === 1 ? 'equipe-2016' : null);
  }
  // Older saved rows have no tag field and require no migration.
  f.store.seed({ pk: 'USER#u', sk: 'UPCOMING#legacy', ...birthday, id: 'legacy', revision: 1 });
  assert.equal((await f.call('GET')).data.entries.find((e: Item) => e.id === 'legacy').tag, null);
  assert.doesNotMatch(JSON.stringify(f.logs), /sps|SPS|quipe/);
});
test('signed-out, wrong Origin, no-account and deleting-account requests cannot write', async () => {
  const f = await fixture();
  assert.equal((await f.call('GET', undefined, undefined, '')).status, 401);
  assert.equal((await f.call('POST', undefined, birthday, '')).status, 401);
  assert.equal((await f.call('POST', undefined, birthday, 'u', 'https://elsewhere.example')).status, 403);
  await f.store.putSession(auth.digest('s'.repeat(43)), { email: 'new@example.com', now, expires: now + 86400 });
  assert.equal((await f.call('POST', undefined, birthday, 's')).status, 403);
  await f.store.updateProfile('u', { mcp_deleting: true });
  assert.equal((await f.call('GET')).status, 403);
  assert.equal((await f.call('POST', undefined, birthday)).status, 403);
  assert.equal((await f.store.upcomingEntries('u')).length, 0);
});
test('invalid dates, years, ranges, destinations, reminder bounds and unapproved fields fail before writing', async () => {
  const f = await fixture();
  for (const value of [
    { ...birthday, kind: 'unknown' },
    { ...birthday, title: '\n' },
    { ...birthday, title: 'one\ntwo' },
    { ...birthday, title: '😀'.repeat(121) },
    { ...birthday, date: '02-30' },
    { ...birthday, date: '2026-10-20' },
    { ...birthday, date: '2-01' },
    { ...birthday, year: '1976' },
    { ...birthday, year: 2027 },
    { ...birthday, year: 0 },
    { ...birthday, year: 2026 },
    { ...birthday, date: '02-29', year: 2001 },
    { ...birthday, reminders: [] },
    { ...birthday, reminders: [0, 0] },
    { ...birthday, reminders: [366] },
    { ...birthday, reminders: [-1] },
    { ...birthday, reminders: [1.5] },
    { ...birthday, reminders: ['1'] },
    { ...birthday, reminders: [0, 1, 2, 3, 4, 5, 6] },
    { ...birthday, email: 'yes' },
    ...[
      '#',
      '#sps #family',
      'sps family',
      'sps/family',
      'two--hyphens',
      '123',
      'a'.repeat(51),
      'a\nb',
      '😀',
      true,
      []
    ].map((tag) => ({ ...birthday, tag })),
    { ...birthday, user_id: 'b' },
    { ...birthday, auto_timezone: true },
    { ...birthday, place },
    { kind: 'event', title: 'Concert', date: '2026-10-14', year: 2000 },
    { kind: 'event', title: 'Concert', date: '2026-02-30' },
    { kind: 'trip', title: 'Trip', date: '2026-10-14', end_date: '2026-10-13', place },
    { kind: 'trip', title: 'Trip', date: '2026-10-14', end_date: '2026-10-15' },
    { kind: 'trip', title: 'Trip', date: '2026-10-14', end_date: '2026-10-15', place: { ...place, tz: 'wrong' } }
  ])
    assert.equal((await f.call('POST', undefined, value)).status, 400, JSON.stringify(value));
  assert.equal((await f.store.upcomingEntries('u')).length, 0);
  assert.equal((await f.call('POST', undefined, { ...birthday, title: '😀'.repeat(120) })).status, 201);
  assert.equal((await f.call('POST', undefined, { ...birthday, year: null, date: '02-29' })).status, 201);
});
test('concurrent creates enforce the retained-entry limit atomically and delete frees capacity', async () => {
  const f = await fixture();
  await f.store.updateProfile('u', { upcoming_count: 199 });
  const responses = await Promise.all([f.call('POST', undefined, birthday), f.call('POST', undefined, birthday)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
  const saved = responses.find((r) => r.status === 201)!.data;
  assert.equal((await f.store.profile('u'))?.upcoming_count, 200);
  assert.equal(
    (await f.call('PUT', '/api/upcoming/' + saved.id, { ...birthday, revision: 1, title: 'Edited' })).status,
    200
  );
  assert.equal((await f.call('DELETE', '/api/upcoming/' + saved.id, { revision: 2 })).status, 200);
  assert.equal((await f.call('POST', undefined, birthday)).status, 201);
});
test('revocation or deletion between request authorization and transaction refuses all changes', async () => {
  for (const mutation of ['create', 'edit', 'delete'])
    for (const race of ['session', 'account']) {
      const f = await fixture(),
        entry = (await f.call('POST', undefined, birthday)).data;
      const send = f.store.client.send.bind(f.store.client);
      let raced = false;
      f.store.client.send = async (command) => {
        if (!raced && command.constructor.name === 'TransactWriteCommand') {
          raced = true;
          if (race === 'session') await f.store.deleteSession(auth.digest('u'.repeat(43)));
          else await f.store.updateProfile('u', { mcp_deleting: true });
        }
        return send(command);
      };
      const response =
        mutation === 'create'
          ? await f.call('POST', undefined, birthday)
          : await f.call(
              mutation === 'edit' ? 'PUT' : 'DELETE',
              '/api/upcoming/' + entry.id,
              mutation === 'edit' ? { ...birthday, title: 'Changed', revision: 1 } : { revision: 1 }
            );
      assert.equal(response.status, 409, mutation + ' ' + race);
      assert.equal((await f.store.upcoming('u', entry.id))?.revision, 1);
      assert.equal((await f.store.upcomingEntries('u')).length, 1);
      assert.equal((await f.store.profile('u'))?.upcoming_count, 1);
    }
});
test('concurrent edits accept one revision and leave retained capacity unchanged', async () => {
  const f = await fixture(),
    saved = (await f.call('POST', undefined, birthday)).data;
  const answers = await Promise.all(
    ['One', 'Two'].map((title) => f.call('PUT', '/api/upcoming/' + saved.id, { ...birthday, title, revision: 1 }))
  );
  assert.deepEqual(answers.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.store.upcoming('u', saved.id))?.revision, 2);
  assert.equal((await f.store.profile('u'))?.upcoming_count, 1);
});
test('purpose-verified account deletion removes Upcoming entries with the owner archive', async () => {
  const f = await fixture();
  await f.call('POST', undefined, birthday);
  await f.store.putLogin(
    auth.digest('d'.repeat(43)),
    'u@example.com',
    auth.digest('u@example.com'),
    auth.digest('222222'),
    now,
    900,
    'delete'
  );
  assert.equal((await f.call('DELETE', '/api/me', { code: '222222' })).status, 200);
  assert.equal((await f.store.upcomingEntries('u')).length, 0);
  assert.equal(await f.store.profile('u'), null);
});
test('a batch previews with dry_run, resolves destinations by text, applies as one, and refuses whole on a problem', async () => {
  const f = await fixture();
  const texas = { ...place, region: 'Texas', country: 'United States', tz: 'America/Chicago', lat: 33.66, lon: -95.56 };
  f.ctx.geocode = async (q) => (q.toLowerCase() === 'paris' ? [place, texas] : []);
  const first = (await f.call('POST', undefined, birthday)).data as Item,
    second = (await f.call('POST', undefined, { kind: 'event', title: 'Concert', date: '2026-10-01' })).data as Item;
  // The first date added earns Roadmap alpha, told on the page; the second
  // earns nothing.
  assert.deepEqual(first.unlocked, [
    { id: 'roadmap', key: 'roadmap:alpha', name: 'Roadmap alpha', version: '4.5.121' }
  ]);
  assert.equal(second.unlocked, undefined);
  const batch = {
    add: [
      { kind: 'trip', title: 'Holiday', date: '2026-12-05', end_date: '2026-12-12', place: 'Paris, Texas' },
      { kind: 'trip', title: 'Spring', date: '2027-04-05', end_date: '2027-04-06', place: 'paris' },
      { kind: 'birthday', title: 'Sam', date: '03-03', tag: 'Family' }
    ],
    change: [{ id: first.id, revision: first.revision, kind: 'birthday', title: 'Alex', date: '10-21', year: 1976 }],
    remove: [{ id: second.id, revision: second.revision }]
  };
  const preview = await f.call('POST', '/api/upcoming/batch', { ...batch, dry_run: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const plan = preview.data.plan as { add: Item[]; change: { before: Item; after: Item }[]; remove: string[] };
  assert.deepEqual([preview.data.add, preview.data.change, preview.data.remove], [3, 1, 1]);
  assert.deepEqual(
    plan.add.map((e) => (e.place as Item | null)?.region ?? e.tag),
    ['Texas', 'Ile-de-France', 'family']
  );
  assert.deepEqual([plan.change[0]!.before.date, plan.change[0]!.after.date], ['10-20', '10-21']);
  assert.deepEqual(plan.remove, [second.id]);
  assert.equal((await f.store.upcomingEntries('u')).length, 2, 'a preview writes nothing');
  // Problems name the list and index, and nothing is written.
  for (const [value, status, error, where] of [
    [
      {
        add: [{ kind: 'trip', title: 'Nowhere', date: '2026-12-05', end_date: '2026-12-12', place: 'Atlantis' }],
        ...{}
      },
      400,
      'upcoming-place',
      ['add', 0]
    ],
    [
      { ...batch, add: [...batch.add, { kind: 'birthday', title: 'Bad', date: '13-40' }] },
      400,
      'upcoming-date',
      ['add', 3]
    ],
    [{ ...batch, change: [{ ...batch.change[0], revision: 9 }] }, 409, 'upcoming-changed', ['change', 0]],
    // No revision, or one that isn't a whole number, is malformed, not stale.
    [{ ...batch, change: [{ ...batch.change[0], revision: '1' }] }, 400, 'upcoming-fields', ['change', 0]],
    [{ ...batch, remove: [{ id: batch.remove[0]!.id }] }, 400, 'upcoming-fields', ['remove', 0]],
    [{ ...batch, remove: [{ id: 'missing', revision: 1 }] }, 404, 'upcoming-missing', ['remove', 0]],
    [{ ...batch, remove: [batch.remove[0], batch.remove[0]] }, 400, 'upcoming-fields', ['remove', 1]],
    [{ add: [{ id: 'x', kind: 'birthday', title: 'Bad', date: '01-01' }] }, 400, 'upcoming-fields', ['add', 0]],
    [{ add: 'no' }, 400, 'upcoming-fields', ['add', undefined]],
    [{ extra: true }, 400, 'upcoming-fields', [undefined, undefined]]
  ] as const) {
    const answer = await f.call('POST', '/api/upcoming/batch', value);
    assert.equal(answer.status, status, JSON.stringify(value));
    assert.equal(answer.data.error, error);
    assert.deepEqual([answer.data.list, answer.data.index], where);
  }
  assert.equal((await f.store.upcomingEntries('u')).length, 2);
  assert.equal(
    (await f.call('POST', '/api/upcoming/batch', { add: Array.from({ length: 199 }, () => birthday) })).data.error,
    'upcoming-limit'
  );
  assert.equal(
    (await f.call('POST', '/api/upcoming/batch', { add: Array.from({ length: 201 }, () => birthday) })).data.error,
    'upcoming-batch'
  );
  // Apply.
  const applied = await f.call('POST', '/api/upcoming/batch', batch);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  // Five dates added in all, one of them removed in the same batch: the
  // Roadmap counts what was added, so beta comes now.
  assert.deepEqual(applied.data, {
    ok: true,
    add: 3,
    change: 1,
    remove: 1,
    unlocked: [{ id: 'roadmap', key: 'roadmap:beta', name: 'Roadmap beta', version: '4.5.121' }]
  });
  assert.deepEqual(
    f.store.memory
      .all()
      .filter((i) => i.pk === 'USER#u' && i.kind === 'badge.earned')
      .map((r) => [r.key, r.via])
      .sort(),
    [
      ['roadmap:alpha', 'web'],
      ['roadmap:beta', 'web']
    ]
  );
  assert.ok((await f.store.seenBadges('u')).has('roadmap:beta'));
  const entries = await f.store.upcomingEntries('u');
  assert.deepEqual(entries.map((e) => e.title).toSorted(), ['Alex', 'Holiday', 'Sam', 'Spring']);
  assert.equal(entries.find((e) => e.id === first.id)!.revision, 2);
  assert.equal(entries.find((e) => e.title === 'Holiday')!.place!.region, 'Texas');
  assert.equal((await f.store.profile('u'))!.upcoming_count, 4);
  assert.equal((await f.call('POST', '/api/upcoming/batch', batch)).status, 404, 'the removed id is gone');
  // The other owner sees nothing of it, and the log carries counts only.
  assert.equal(
    (await f.call('POST', '/api/upcoming/batch', { remove: [{ id: first.id, revision: 2 }] }, 'b')).status,
    404
  );
  const logged = f.logs.filter((l) => l.event === 'upcoming' && l.action === 'batch');
  assert.deepEqual(logged, [
    { event: 'upcoming', user: 'u', action: 'batch', add: 3, change: 1, remove: 1, applied: 5 }
  ]);
  assert.ok(!JSON.stringify(f.logs).includes('Holiday'));
  assert.equal((await f.call('POST', '/api/upcoming/batch', batch, 'u', 'https://evil.example')).status, 403);
});
test('the owner adds the upcoming scope to a live connection over the API; origin, ownership and the scope are checked', async () => {
  const f = await fixture(),
    { connected } = await import('../oauth/fixtures.ts'),
    a = await connected(f.ctx as never),
    path = '/api/mcp/connections/' + a.family.id + '/scope';
  assert.equal((await f.call('POST', path, { scope: 'upcoming' }, 'u', 'https://evil.example.com')).status, 403);
  assert.equal((await f.call('POST', path, { scope: 'upcoming' }, 'b')).status, 404);
  assert.equal((await f.call('POST', path, { scope: 'notes:write' })).status, 400);
  assert.equal((await f.call('POST', '/api/mcp/connections/nope/scope', { scope: 'upcoming' })).status, 404);
  const granted = await f.call('POST', path, { scope: 'upcoming' });
  assert.deepEqual([granted.status, granted.data.scope], [200, 'notes:read media:read notes:write upcoming']);
  const listed = (await f.call('GET', '/api/mcp/connections')).data.connections;
  assert.equal(listed[0].scope, 'notes:read media:read notes:write upcoming');
  assert.ok(!JSON.stringify(f.logs).includes(String(a.family.id)));
});
