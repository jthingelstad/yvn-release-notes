/** Feedback on the web: fictional administrator, subscribers and images only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import { b64, jpeg, png, SECRET } from '../../packages/testing/images.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';

const now = Date.parse('2026-10-28T15:00:00Z') / 1000,
  origin = 'https://notes.example.com';

async function fixture() {
  const store = new FakeStore(
    [
      ['u', 'ada@example.com', 'active'],
      ['b', 'bea@example.com', 'active'],
      ['s', 'sam@example.com', 'stopped']
    ].map(([uid, email, status]) => ({
      pk: 'USER#' + uid,
      sk: 'PROFILE',
      email,
      birthday: '1981-06-14',
      tz: 'America/Chicago',
      status
    })),
    'T',
    1
  );
  for (const uid of ['u', 'b', 's'])
    await store.putSession(auth.digest(uid.repeat(43)), { user_id: uid, now, expires: now + 86400 });
  const logs: Record<string, unknown>[] = [];
  const objects = new FakeObjects(),
    mail = new FakeMail();
  const ctx: ApiContext = {
    store,
    now,
    origin,
    objects,
    mail,
    invocations: new FakeInvocations(),
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    adminUserId: 'u',
    fetchTitle: () => null,
    log: (f) => logs.push(f)
  };
  const app = createApp({ context: () => ctx });
  async function call(method: string, path: string, value?: unknown, token = 'b', from = origin) {
    const response = await app.request(path, {
      method,
      redirect: 'manual',
      headers: { origin: from, cookie: token ? auth.COOKIE + '=' + token.repeat(43) : '' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) })
    });
    const text = await response.text();
    return {
      status: response.status,
      location: response.headers.get('location'),
      data: text ? JSON.parse(text) : null
    };
  }
  return { store, ctx, objects, mail, call, logs };
}

test('signed out, forged origins and other accounts reach no feedback', async () => {
  const f = await fixture();
  assert.equal((await f.call('GET', '/api/feedback', undefined, '')).status, 401);
  assert.equal(
    (await f.call('POST', '/api/feedback', { kind: 'bug', text: 'x' }, 'b', 'https://elsewhere.example')).status,
    403
  );
  for (const [method, path, value] of [
    ['GET', '/api/admin/feedback', undefined],
    ['POST', '/api/admin/feedback/b/0123456789abcdef/answers', { text: 'x', status: 'done', revision: 1 }],
    ['GET', '/api/admin/feedback/b/0123456789abcdef/screenshots/1', undefined]
  ] as const)
    assert.equal((await f.call(method, path, value, 'b')).status, 403);
  const filed = await f.call('POST', '/api/feedback', { kind: 'idea', text: 'Mine alone' });
  assert.equal(filed.status, 201);
  // Another subscriber's id is simply not theirs.
  assert.equal((await f.call('GET', `/api/feedback/${filed.data.id}/screenshots/1`, undefined, 's')).status, 404);
  assert.deepEqual((await f.call('GET', '/api/feedback', undefined, 's')).data.items, []);
});

test('filing stores stripped screenshots privately, lists them and links them only by signed URL', async () => {
  const f = await fixture();
  const filed = await f.call('POST', '/api/feedback', {
    kind: 'bug',
    text: '  The map page is blank on my phone  ',
    screenshots: [
      { type: 'image/png', data: b64(png(390, 844)) },
      { type: 'image/jpeg', data: b64(jpeg(1170, 2532)) }
    ]
  });
  assert.equal(filed.status, 201);
  assert.match(filed.data.id, /^[0-9a-f]{16}$/);
  assert.equal(filed.data.text, 'The map page is blank on my phone');
  assert.equal(filed.data.status, 'open');
  assert.deepEqual(
    filed.data.screenshots.map((s: Record<string, unknown>) => [s.n, s.type, s.width, s.height]),
    [
      [1, 'image/png', 390, 844],
      [2, 'image/jpeg', 1170, 2532]
    ]
  );
  assert.ok(!JSON.stringify(filed.data).includes('media/'));
  const keys = await f.objects.list('media/b/feedback/');
  assert.deepEqual(keys, [`media/b/feedback/${filed.data.id}-1.png`, `media/b/feedback/${filed.data.id}-2.jpg`]);
  for (const k of keys) assert.ok(!(await f.objects.get(k)).body.toString('latin1').includes(SECRET));

  const list = await f.call('GET', '/api/feedback');
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.filed_today, 1);
  assert.equal(list.data.per_day, 10);
  assert.equal(list.data.screenshots_max, 3);
  assert.ok(!JSON.stringify(list.data).includes('media/'));

  const link = await f.call('GET', `/api/feedback/${filed.data.id}/screenshots/2`);
  assert.equal(link.status, 302);
  assert.ok(link.location!.startsWith('https://files.example.test/'));
  assert.equal((await f.call('GET', `/api/feedback/${filed.data.id}/screenshots/4`)).status, 404);
  assert.equal((await f.call('GET', '/api/feedback/not-an-id/screenshots/1')).status, 404);

  // The first item filed earns Issue opened, told on the page and so seen.
  assert.deepEqual(
    filed.data.unlocked.map((u: Record<string, unknown>) => [u.id, u.name]),
    [['issue', 'Issue opened']]
  );
  assert.ok((await f.store.seenBadges('b')).has('issue'));
  // The activity row says what happened, never the words, and the badge's
  // row goes with it, naming no day or note.
  const rows = f.store.memory.all().filter((i) => String(i.sk).startsWith('ACTIVITY#') && i.pk === 'USER#b');
  assert.deepEqual(
    rows.map((r) => [r.kind, r.badge, r.via, r.day, r.note]),
    [
      ['feedback.filed', undefined, 'web', undefined, undefined],
      ['badge.earned', 'issue', 'web', undefined, undefined]
    ]
  );
  assert.equal(rows[0]!.kind, 'feedback.filed');
  assert.equal(rows[0]!.feedback_kind, 'bug');
  assert.equal(rows[0]!.screenshots, 2);
  assert.ok(!JSON.stringify(rows).includes('blank'));
  assert.ok(!JSON.stringify(f.logs).includes('blank'));
  assert.ok(!JSON.stringify(f.logs).includes('@example.com'));
});

test('refusals name the field or picture and keep nothing', async () => {
  const f = await fixture();
  const refused = async (value: unknown, status: number, error: string) => {
    const r = await f.call('POST', '/api/feedback', value);
    assert.equal(r.status, status, JSON.stringify(value).slice(0, 80));
    assert.equal(r.data.error, error);
    return r;
  };
  await refused({ kind: 'rant', text: 'x' }, 400, 'feedback-kind');
  await refused({ kind: 'bug', text: '' }, 400, 'feedback-text');
  await refused({ kind: 'bug', text: 'x'.repeat(4001) }, 400, 'feedback-too-long');
  await refused({ kind: 'bug', text: 'x', follows: '0123456789abcdef' }, 400, 'feedback-follows');
  await refused(
    { kind: 'bug', text: 'x', screenshots: [{ type: 'image/gif', data: 'AAAA' }] },
    400,
    'feedback-image-type'
  );
  const bad = await refused(
    {
      kind: 'bug',
      text: 'x',
      screenshots: [
        { type: 'image/png', data: b64(png()) },
        { type: 'image/png', data: 'AAAA' }
      ]
    },
    400,
    'feedback-image-data'
  );
  assert.equal(bad.data.index, 1);
  await refused(
    { kind: 'bug', text: 'x', screenshots: Array.from({ length: 4 }, () => ({ type: 'image/png', data: b64(png()) })) },
    400,
    'feedback-image-count'
  );
  assert.deepEqual(await f.objects.list('media/'), []);
  assert.equal(f.store.memory.all().filter((i) => String(i.sk).startsWith('FEEDBACK')).length, 0);
});

test('ten a day, a follow-up points at its parent, and the parent is never changed', async () => {
  const f = await fixture();
  const first = await f.call('POST', '/api/feedback', { kind: 'question', text: 'First' });
  const follow = await f.call('POST', '/api/feedback', { kind: 'other', text: 'More', follows: first.data.id });
  assert.equal(follow.status, 201);
  assert.equal(follow.data.follows, first.data.id);
  for (let i = 2; i < 10; i++)
    assert.equal((await f.call('POST', '/api/feedback', { kind: 'idea', text: `${i}` })).status, 201);
  const over = await f.call('POST', '/api/feedback', {
    kind: 'idea',
    text: 'Eleventh',
    screenshots: [{ type: 'image/png', data: b64(png()) }]
  });
  assert.equal(over.status, 429);
  assert.equal(over.data.error, 'feedback-limit');
  assert.deepEqual(await f.objects.list('media/'), []);
  const parent = (await f.call('GET', '/api/feedback')).data.items.find((i: { id: string }) => i.id === first.data.id);
  assert.equal(parent.revision, 1);
  assert.deepEqual(parent.answers, []);
  // Another account's count is its own.
  assert.equal((await f.call('POST', '/api/feedback', { kind: 'idea', text: 'Mine' }, 's')).status, 201);
});

test('the administrator reads the queue, answers once per revision and mails only an active filer', async () => {
  const f = await fixture();
  const b = await f.call('POST', '/api/feedback', {
    kind: 'bug',
    text: 'Broken',
    screenshots: [{ type: 'image/webp', data: b64((await import('../../packages/testing/images.ts')).webp()) }]
  });
  const s = await f.call('POST', '/api/feedback', { kind: 'idea', text: 'Idea' }, 's');
  const queue = await f.call('GET', '/api/admin/feedback', undefined, 'u');
  assert.equal(queue.status, 200);
  assert.deepEqual(
    queue.data.items.map((i: Record<string, unknown>) => [i.owner, i.email, i.account, i.id]).sort(),
    [
      ['b', 'bea@example.com', 'active', b.data.id],
      ['s', 'sam@example.com', 'stopped', s.data.id]
    ].sort()
  );
  assert.ok(!JSON.stringify(queue.data).includes('media/'));
  const shot = await f.call('GET', `/api/admin/feedback/b/${b.data.id}/screenshots/1`, undefined, 'u');
  assert.equal(shot.status, 302);

  const answer = { text: 'Which phone was it?', status: 'needs_info', revision: 1 };
  const answered = await f.call('POST', `/api/admin/feedback/b/${b.data.id}/answers`, answer, 'u');
  assert.equal(answered.status, 201);
  assert.equal(answered.data.mail, 'sent');
  assert.equal(answered.data.item.status, 'needs_info');
  assert.equal(answered.data.item.revision, 2);
  assert.equal(f.mail.messages.length, 1);
  assert.equal(f.mail.messages[0]!.to, 'bea@example.com');
  assert.match(f.mail.messages[0]!.raw.toString(), /Subject: Jamie has a question about your feedback/);
  // A stale revision is refused and mails nothing.
  const stale = await f.call('POST', `/api/admin/feedback/b/${b.data.id}/answers`, answer, 'u');
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'feedback-changed');
  assert.equal(f.mail.messages.length, 1);
  // A stopped subscriber's feedback is answered on the page, without email.
  const quiet = await f.call(
    'POST',
    `/api/admin/feedback/s/${s.data.id}/answers`,
    { text: 'Done', status: 'done', revision: 1 },
    'u'
  );
  assert.equal(quiet.data.mail, 'not-sent');
  assert.equal(f.mail.messages.length, 1);
  assert.equal(
    (await f.call('POST', `/api/admin/feedback/b/fedcba9876543210/answers`, answer, 'u')).data.error,
    'feedback-missing'
  );
  assert.equal(
    (
      await f.call(
        'POST',
        `/api/admin/feedback/b/${b.data.id}/answers`,
        { ...answer, status: 'open', revision: 2 },
        'u'
      )
    ).data.error,
    'feedback-status'
  );
  // The filer sees the answer; its activity row carries no words.
  const mine = (await f.call('GET', '/api/feedback')).data.items[0];
  assert.deepEqual(
    mine.answers.map((a: Record<string, unknown>) => [a.text, a.status]),
    [['Which phone was it?', 'needs_info']]
  );
  const rows = f.store.memory.all().filter((i) => i.pk === 'USER#b' && String(i.sk).includes('#feedback.answered#'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, 'needs_info');
  assert.equal(rows[0]!.mail, 'sent');
  assert.ok(!JSON.stringify(rows).includes('phone'));
  // A failed email never undoes the answer.
  f.mail.fail = true;
  const failed = await f.call(
    'POST',
    `/api/admin/feedback/b/${b.data.id}/answers`,
    { text: 'Fixed now', status: 'done', revision: 2 },
    'u'
  );
  assert.equal(failed.status, 201);
  assert.equal(failed.data.mail, 'failed');
  // A `done` earns the filer Merged upstream (a question does not), in their
  // own log via admin, not seen, so their next email tells of it; a second
  // `done` earns nothing more.
  const again = await f.call(
    'POST',
    `/api/admin/feedback/b/${b.data.id}/answers`,
    { text: 'Fixed again', status: 'done', revision: 3 },
    'u'
  );
  assert.equal(again.status, 201);
  assert.equal(again.data.unlocked, undefined);
  const merged = (owner: string) =>
    f.store.memory
      .all()
      .filter((i) => i.pk === `USER#${owner}` && i.kind === 'badge.earned' && i.badge === 'merged')
      .map((r) => [r.via, r.name, r.day, r.note]);
  assert.deepEqual(merged('b'), [['admin', 'Merged upstream', undefined, undefined]]);
  assert.deepEqual(merged('s'), [['admin', 'Merged upstream', undefined, undefined]]);
  assert.ok(!(await f.store.seenBadges('b')).has('merged'));
  assert.equal(merged('u').length, 0);
});
