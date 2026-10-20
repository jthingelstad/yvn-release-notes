import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createApp, ROUTES } from '../../server/app/app.ts';
import { MAX_BODY } from '../../server/app/requests.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import * as auth from '../../packages/backend/auth.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
const origin = 'https://notes.example.com',
  now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  profile = {
    pk: 'USER#u',
    sk: 'PROFILE',
    email: 'ada@example.com',
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active',
    send_time: '06:00',
    city: 'Minneapolis',
    country: 'United States',
    lat: 44.98,
    lon: -93.26
  },
  city = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
async function setup() {
  const store = new FakeStore([profile, { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' }], 'T', 2),
    objects = new FakeObjects(),
    mail = new FakeMail(),
    invocations = new FakeInvocations(),
    logs: Item[] = [],
    token = auth.newToken();
  await store.putSession(auth.digest(token), { user_id: 'u', now, expires: now + auth.SESSION_IDLE });
  const ctx: ApiContext = {
    store,
    objects,
    mail,
    invocations,
    origin,
    now,
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    geocode: async () => [city],
    fetchTitle: () => null,
    weatherFetch: async () => ({}),
    log: (f) => logs.push(f)
  };
  const app = createApp({ context: () => ctx, viewer: () => '192.0.2.1' });
  const call = async (method: string, path: string, value?: unknown, cookie = token, originHeader = true) => {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = auth.COOKIE + '=' + cookie;
    if (originHeader) headers.origin = origin;
    if (value !== undefined) headers['content-type'] = 'application/json';
    const r = await app.request(path, {
      method,
      headers,
      ...(value !== undefined ? { body: JSON.stringify(value) } : {})
    });
    return {
      r,
      b: r.headers.get('content-type')?.includes('application/json') ? ((await r.json()) as Item) : await r.text()
    };
  };
  return { ctx, store, objects, mail, invocations, logs, token, app, call };
}
test('every existing route is declared; unknown paths/private queries never logged; Origin precedes body or writes', async () => {
  const s = await setup();
  assert.equal(ROUTES.length, 56);
  const missing = await s.call('GET', '/secret-note?q=token');
  assert.equal(missing.r.status, 404);
  assert.equal(missing.r.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(s.logs).includes('secret-note'));
  assert.ok(!JSON.stringify(s.logs).includes('token'));
  const refused = await s.call('POST', '/api/days/2026-10-13/notes', { text: 'private' }, s.token, false);
  assert.equal(refused.r.status, 403);
  assert.equal((await s.store.allNotes('u')).length, 0);
  const signedOut = await s.call('POST', '/api/days/2026-10-13/notes', { text: 'private' }, '');
  assert.equal(signedOut.r.status, 401);
  assert.ok(!JSON.stringify(s.logs).includes('private'));
});
test('email ownership sign-in burns shared link/code and verifies new addresses before signup', async () => {
  const s = await setup(),
    start = await s.call('POST', '/api/auth/start', { email: 'bea@example.com' }, '');
  assert.equal(start.r.status, 202);
  assert.equal(s.mail.messages.length, 1);
  const login = s.store.memory.all().find((i) => String(i.pk).startsWith('LOGIN#'))!,
    token = 't'.repeat(43),
    code = '123456';
  await s.store.putLogin(
    auth.digest(token),
    'bea@example.com',
    auth.digest('bea@example.com'),
    auth.digest(code),
    now,
    900
  );
  const verify = await s.call('POST', '/api/auth/verify', { email: 'bea@example.com', code }, '');
  assert.equal(verify.r.status, 200);
  const cookie = verify.r.headers.get('set-cookie')!.split(';')[0]!.split('=')[1]!;
  assert.equal(
    (await s.call('GET', '/api/me', undefined, cookie)).b &&
      ((await s.call('GET', '/api/me', undefined, cookie)).b as Item).new,
    true
  );
  assert.equal((await s.call('POST', '/api/auth/verify', { token }, '')).r.status, 400);
  const signup = await s.call('PUT', '/api/me', { birthday: '1981-06-14', send_time: '06:15', place: city }, cookie);
  assert.equal(signup.r.status, 200);
  assert.equal((signup.b as Item).new, false);
  assert.ok((signup.b as Item).inbox);
  assert.equal(s.invocations.calls[0]!.name, 'sender');
  assert.ok(!JSON.stringify(s.logs).includes('bea@example.com'));
  assert.ok(login);
});
test('notes/readers/tag/search/release share provenance and safe DTOs across native routes', async () => {
  const s = await setup(),
    added = await s.call('POST', '/api/days/2026-10-07/notes', {
      text: '  Café #Cabin\r\nA walk.  ',
      place: city,
      tz: 'Europe/Paris'
    });
  assert.equal(added.r.status, 201);
  const id = String((added.b as Item).id);
  assert.equal((added.b as Item).text, 'Café #Cabin\nA walk.');
  assert.equal((added.b as Item).late, true);
  assert.equal((added.b as Item).place, 'Paris, Ile-de-France');
  assert.ok(!Object.hasOwn(added.b as Item, 'lat'));
  assert.ok(!Object.hasOwn(added.b as Item, 'lon'));
  assert.equal((await s.call('POST', '/api/search', { q: 'CAFE cabin' })).r.status, 200);
  assert.equal(((await s.call('POST', '/api/search', { q: 'CAFE' })).b as Item).notes, 1);
  const tags = (await s.call('GET', '/api/tags')).b as Item;
  assert.equal((tags.tags as Item[])[0]!.tag, 'cabin');
  const timeline = (await s.call('GET', '/api/days')).b as Item;
  assert.equal((timeline.days as Item[]).length, 2);
  const releases = (await s.call('GET', '/api/releases')).b as Item;
  assert.equal((releases.releases as Item[])[0]!.notes, 1);
  const view = (await s.call('GET', '/api/releases/4.5')).b as Item;
  assert.equal(view.notes, 1);
  const edited = await s.call('PUT', `/api/days/2026-10-07/notes/${id}`, { text: 'New #Evening' });
  assert.equal(edited.r.status, 200);
  assert.deepEqual((edited.b as Item).tags, ['evening']);
  assert.equal((await s.call('DELETE', `/api/days/2026-10-07/notes/${id}`)).r.status, 200);
  assert.equal((await s.store.allNotes('u')).length, 0);
});
test('settings lock birthday, pause boundaries/resume, inbox rotation, stop/restart and token unsubscribe', async () => {
  const s = await setup();
  assert.equal((await s.call('PUT', '/api/me', { birthday: '1981-06-15' })).r.status, 400);
  assert.equal((await s.call('PUT', '/api/me', { send_time: '06:01' })).r.status, 400);
  const settings = await s.call('PUT', '/api/me', { send_time: '07:15', transcribe: true, describe: true });
  assert.equal(settings.r.status, 200);
  assert.equal((settings.b as Item).transcribe, true);
  assert.equal((await s.call('PUT', '/api/pause', { days: true })).r.status, 400);
  const paused = await s.call('PUT', '/api/pause', { days: 3 });
  assert.deepEqual((paused.b as Item).pause, { from: '2026-10-13', through: '2026-10-15' });
  assert.equal((await s.call('DELETE', '/api/pause')).r.status, 200);
  assert.equal((await s.call('PUT', '/api/pause', { days: 61 })).r.status, 400);
  const first = (await s.call('POST', '/api/me/inbox', {})).b as Item,
    second = (await s.call('POST', '/api/me/inbox', {})).b as Item;
  assert.notEqual(first.inbox, second.inbox);
  const old = String(first.inbox).split('@')[0]!;
  assert.equal(await s.store.getInbox(old), null);
  const token = 'a'.repeat(24);
  await s.store.putDay('u', '2026-10-13', '4.5.121', token, '2026-10-13T10:00:00Z');
  assert.equal((await s.call('POST', '/api/unsubscribe?t=' + token, {}, '', false)).r.status, 200);
  assert.equal((await s.store.profile('u'))!.status, 'stopped');
  assert.equal((await s.call('PUT', '/api/me', { status: 'active' })).r.status, 200);
});
test('guarded writes merge same-key profile conditions and refuse session/profile races atomically', async () => {
  const s = await setup(),
    proved = withWebProof(s.store, 'u', auth.digest(s.token), now);
  await proved.updateProfile('u', { send_time: '08:00' });
  const tx = s.store.memory.calls.find(
    (c) => c.name === 'TransactWriteCommand' && JSON.stringify(c.input).includes('webDeleting')
  )!;
  assert.equal(tx.input.TransactItems!.length, 2);
  assert.equal((await s.store.profile('u'))!.send_time, '08:00');
  for (const change of ['session', 'deletion']) {
    const fresh = await setup();
    let raced = false;
    fresh.store.memory.beforeSend = (command) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some((op) => op.Put?.Item?.sk?.startsWith('NOTE#')) &&
        !raced
      ) {
        raced = true;
        if (change === 'session')
          fresh.store.memory.items.delete(JSON.stringify(['SESSION#' + auth.digest(fresh.token), 'SESSION']));
        else fresh.store.seed({ ...profile, mcp_deleting: true });
      }
    };
    const r = await fresh.call('POST', '/api/days/2026-10-13/notes', { text: 'Never stored' });
    assert.notEqual(r.r.status, 201);
    assert.equal((await fresh.store.allNotes('u')).length, 0);
  }
});
test('uploads check signed exact-size/type, immutable pending version, keep private metadata, clean refused commits', async () => {
  const s = await setup();
  const r = await s.call('POST', '/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: 12 });
  assert.equal(r.r.status, 200);
  const upload = r.b as Item,
    fields = upload.fields as Record<string, string>,
    key = fields.key!;
  await s.objects.put(key, Buffer.from('%PDF-fixture'), { type: 'application/pdf', tags: { outcome: 'pending' } });
  const added = await s.call('POST', '/api/days/2026-10-13/notes', {
    text: 'Files',
    uploads: [{ upload: upload.upload, type: upload.type, name: 'folder/a.pdf' }]
  });
  assert.equal(added.r.status, 201);
  const shown = added.b as Item,
    file = (shown.media as Item[])[0]!;
  assert.equal(file.name, 'a.pdf');
  assert.ok(file.url);
  assert.ok(!Object.hasOwn(file, 'key'));
  const again = await s.call('POST', '/api/days/2026-10-13/notes', {
    text: 'Replay',
    uploads: [{ upload: upload.upload, type: upload.type }]
  });
  assert.equal(again.r.status, 400);
  const wrong = await s.call('POST', '/api/uploads', { name: 'script.js', type: 'text/javascript', size: 1 });
  assert.equal(wrong.r.status, 400);
});
test('account deletion requires purpose-separated code and removes all user objects/sessions/tokens', async () => {
  const s = await setup();
  await s.store.putLogin(
    auth.digest('s'.repeat(43)),
    'ada@example.com',
    auth.digest('ada@example.com'),
    auth.digest('111111'),
    now,
    900,
    'signin'
  );
  assert.equal((await s.call('DELETE', '/api/me', { code: '111111' })).r.status, 400);
  await s.call('POST', '/api/me/delete-code', {});
  await s.store.putLogin(
    auth.digest('d'.repeat(43)),
    'ada@example.com',
    auth.digest('ada@example.com'),
    auth.digest('222222'),
    now,
    900,
    'delete'
  );
  await s.store.putNote('u', '2026-10-07', 'email', { text: 'Private', raw_key: 'raw/fictional' });
  await s.objects.put('raw/fictional', Buffer.from('fixture'), { type: 'text/plain' });
  await s.objects.put('media/u/staged/orphan.pdf', Buffer.from('%PDF-fixture'), { type: 'application/pdf' });
  await s.objects.put('exports/u/orphan.zip', Buffer.from('zip'), { type: 'application/zip' });
  const deleted = await s.call('DELETE', '/api/me', { code: '222222' });
  assert.equal(deleted.r.status, 200);
  assert.deepEqual(await s.objects.list('media/u/'), []);
  assert.deepEqual(await s.objects.list('exports/u/'), []);
  assert.equal(await s.store.profile('u'), null);
  assert.equal(await s.store.userForEmail('ada@example.com'), null);
  assert.equal(await s.store.getSession(auth.digest(s.token)), null);
  assert.equal((await s.call('GET', '/api/me')).r.status, 401);
  assert.ok(s.objects.calls.some((c) => c.operation === 'remove' && c.key === 'raw/fictional'));
  assert.ok(!JSON.stringify(s.logs).includes('Private'));
});

test('concurrent requests retain distinct identities, renewed cookies and transaction guards', async () => {
  const s = await setup(),
    second = auth.newToken();
  s.store.seed({ ...profile, pk: 'USER#v', email: 'bea@example.com', tz: 'Europe/Paris' });
  for (const [token, uid] of [
    [s.token, 'u'],
    [second, 'v']
  ])
    await s.store.putSession(auth.digest(token!), {
      user_id: uid!,
      now: now - auth.SESSION_TOUCH - 1,
      expires: now + 100
    });
  const answers = await Promise.all([
    s.call('POST', '/api/days/2026-10-13/notes', { text: 'First account' }, s.token),
    s.call('POST', '/api/days/2026-10-13/notes', { text: 'Second account' }, second)
  ]);
  for (let i = 0; i < answers.length; i++) {
    assert.equal(answers[i]!.r.status, 201);
    assert.ok(answers[i]!.r.headers.get('set-cookie')!.includes([s.token, second][i]!));
  }
  assert.equal((await s.store.allNotes('u'))[0]!.text, 'First account');
  assert.equal((await s.store.allNotes('v'))[0]!.text, 'Second account');
  assert.equal(s.ctx.store, s.store);
});
test('revocation at attachment commit removes copied media; renewal never resurrects revoked sessions', async () => {
  const s = await setup(),
    upload = (await s.call('POST', '/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: 12 })).b as Item;
  await s.objects.put((upload.fields as Item).key as string, Buffer.from('%PDF-fixture'), {
    type: 'application/pdf',
    tags: { outcome: 'pending' }
  });
  s.store.memory.beforeSend = (command) => {
    if (
      command instanceof TransactWriteCommand &&
      command.input.TransactItems?.some((op) => op.Put?.Item?.sk?.startsWith('NOTE#'))
    )
      s.store.memory.items.delete(JSON.stringify(['SESSION#' + auth.digest(s.token), 'SESSION']));
  };
  const answer = await s.call('POST', '/api/days/2026-10-13/notes', {
    text: 'Refused',
    uploads: [{ upload: upload.upload, type: upload.type }]
  });
  assert.equal(answer.r.status, 503);
  assert.deepEqual(await s.objects.list('media/u/'), []);
  assert.equal((await s.store.allNotes('u')).length, 0);
  const fresh = await setup();
  await fresh.store.putSession(auth.digest(fresh.token), {
    user_id: 'u',
    now: now - auth.SESSION_TOUCH - 1,
    expires: now + 100
  });
  fresh.store.memory.beforeSend = (command) => {
    if (
      command instanceof TransactWriteCommand &&
      command.input.TransactItems?.some((op) => op.Update?.Key?.pk === 'SESSION#' + auth.digest(fresh.token))
    )
      fresh.store.memory.items.delete(JSON.stringify(['SESSION#' + auth.digest(fresh.token), 'SESSION']));
  };
  assert.equal((await fresh.call('GET', '/api/me')).r.status, 401);
  assert.equal(await fresh.store.getSession(auth.digest(fresh.token)), null);
});

test('revoked verified signup session cannot create an account or schedule the welcome email', async () => {
  const s = await setup(),
    email = 'new@example.com',
    token = auth.newToken();
  await s.store.putSession(auth.digest(token), { email, now, expires: now + 100 });
  let raced = false;
  s.store.memory.beforeSend = (command) => {
    if (
      command instanceof TransactWriteCommand &&
      command.input.TransactItems?.some((op) => op.Put?.Item?.sk === 'PROFILE') &&
      !raced
    ) {
      raced = true;
      s.store.memory.items.delete(JSON.stringify(['SESSION#' + auth.digest(token), 'SESSION']));
    }
  };
  const result = await s.call('PUT', '/api/me', { birthday: '1981-06-14', send_time: '06:00', place: city }, token);
  assert.equal(result.r.status, 409);
  assert.equal(await s.store.userForEmail(email), null);
  assert.equal(s.invocations.calls.length, 0);
  assert.equal(s.store.memory.all().filter((i) => i.sk === 'PROFILE').length, 1);
});
test('export words and zip status/download keep owner-private wire contracts', async () => {
  const s = await setup();
  await s.store.putNote('u', '2026-10-07', 'w-test', {
    text: 'Export fixture #walks',
    source: 'web',
    written_at: '2026-10-07T17:00:00Z'
  });
  const words = await s.call('GET', '/api/export');
  assert.equal(words.r.status, 200);
  assert.equal((words.b as Item).profile && ((words.b as Item).notes as Item[])[0]!.text, 'Export fixture #walks');
  assert.ok(words.r.headers.get('content-disposition')?.endsWith('.json"'));
  const md = await s.call('GET', '/api/export?format=md');
  assert.equal(md.r.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.ok(String(md.b).includes('Export fixture'));
  assert.equal(((await s.call('GET', '/api/export/zip')).b as Item).status, 'none');
  assert.equal((await s.call('POST', '/api/export/zip', {})).r.status, 202);
  const build = (await s.store.export('u'))!;
  await s.store.finishExport('u', String(build.id), {
    status: 'ready',
    finished_at: now,
    size: 100,
    files: 0,
    export_key: 'exports/u/test.zip'
  });
  const ready = (await s.call('GET', '/api/export/zip')).b as Item;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.size, 100);
  const file = await s.call('GET', '/api/export/zip/file');
  assert.equal(file.r.status, 302);
  assert.equal(file.r.headers.get('cache-control'), 'no-store');
  assert.ok(file.r.headers.get('location')?.includes('seconds=300'));
});

test('a deleting account blocks ordinary writes but an existing live owner session can finish confirmed deletion', async () => {
  const s = await setup();
  s.store.seed({ ...profile, mcp_deleting: true });
  assert.equal((await s.call('POST', '/api/days/2026-10-13/notes', { text: 'Blocked' })).r.status, 403);
  assert.equal((await s.call('POST', '/api/me/delete-code', {})).r.status, 202);
  await s.store.putLogin(
    auth.digest('d'.repeat(43)),
    'ada@example.com',
    auth.digest('ada@example.com'),
    auth.digest('222222'),
    now,
    900,
    'delete'
  );
  assert.equal((await s.call('DELETE', '/api/me', { code: '222222' })).r.status, 200);
  for (const call of s.store.memory.calls)
    if (call.name === 'TransactWriteCommand')
      for (const operation of call.input.TransactItems ?? []) {
        const entry = operation.Put ?? operation.Update ?? operation.Delete ?? operation.ConditionCheck!;
        if (entry.ExpressionAttributeNames) assert.ok(Object.keys(entry.ExpressionAttributeNames).length > 0);
        if (entry.ExpressionAttributeValues) assert.ok(Object.keys(entry.ExpressionAttributeValues).length > 0);
      }
  assert.equal(await s.store.profile('u'), null);
});
test('HEAD answers like GET with no body, stays a safe method, and 404s where no GET exists', async () => {
  const s = await setup(),
    head = async (path: string, cookie = '') => {
      const r = await s.app.request(path, {
        method: 'HEAD',
        headers: cookie ? { cookie: auth.COOKIE + '=' + cookie } : {}
      });
      return { r, b: await r.text() };
    };
  const get = await s.call('GET', '/api/me'),
    me = await head('/api/me', s.token);
  assert.equal(get.r.status, 200);
  assert.equal(me.r.status, 200);
  assert.equal(me.b, '');
  assert.equal(me.r.headers.get('content-type'), get.r.headers.get('content-type'));
  assert.equal(me.r.headers.get('cache-control'), 'no-store');
  assert.equal((await head('/api/health')).r.status, 200);
  assert.equal((await head('/api/me')).r.status, (await s.call('GET', '/api/me', undefined, '')).r.status);
  const postOnly = await head('/api/search', s.token);
  assert.equal(postOnly.r.status, 404);
  assert.equal(postOnly.b, '');
  assert.equal((await head('/no-such-path')).r.status, 404);
  assert.ok(s.logs.some((l) => l.event === 'web' && l.method === 'HEAD' && l.path === '/api/me' && l.status === 200));
  assert.equal((await createApp().request('/api/health', { method: 'HEAD' })).status, 200);
});
test('a full-length note of four-byte characters fits the body cap; only oversize bodies are 413', async () => {
  const s = await setup(),
    face = String.fromCodePoint(0x1f600),
    full = await s.call('POST', '/api/days/2026-10-13/notes', { text: face.repeat(20_000) });
  assert.ok(Buffer.byteLength(JSON.stringify({ text: face.repeat(20_000) })) > 64 * 1024);
  assert.equal(full.r.status, 201);
  assert.equal([...String((await s.store.allNotes('u'))[0]!.text)].length, 20_000);
  const over = await s.call('POST', '/api/days/2026-10-13/notes', { text: face.repeat(20_001) });
  assert.equal(over.r.status, 400);
  assert.equal((over.b as Item).error, 'too-long');
  const huge = await s.call('POST', '/api/days/2026-10-13/notes', { text: 'a'.repeat(MAX_BODY) });
  assert.equal(huge.r.status, 413);
  assert.equal((await s.store.allNotes('u')).length, 1);
});
test('a saved note answers with what it unlocked; days and releases say what they collected', async () => {
  const s = await setup(),
    keys = (b: Item) => (b.unlocked as Item[]).map((u) => u.key),
    read = async (method: string, path: string, value?: unknown) => (await s.call(method, path, value)).b as Item,
    first = await s.call('POST', '/api/days/2026-10-13/notes', { text: 'Short words', tz: 'America/Chicago' });
  assert.equal(first.r.status, 201);
  assert.deepEqual(keys(first.b as Item), ['hello', 'web', 'commit']);
  assert.deepEqual((first.b as Item).unlocked, [
    { key: 'hello', id: 'hello', name: 'Hello, world', version: '4.5.121' },
    { key: 'web', id: 'web', name: 'Web release', version: '4.5.121' },
    { key: 'commit', id: 'commit', name: 'Commit message', version: '4.5.121' }
  ]);
  // What the line showed is seen, so the email will not say it again.
  assert.deepEqual(await s.store.seenBadges('u'), new Set(['hello', 'web', 'commit']));
  assert.deepEqual((await read('POST', '/api/days/2026-10-13/notes', { text: 'Again' })).unlocked, []);
  // 4.4.100 imported, then 4.5.100 filled in: a hotfix, a twin, and this
  // release's round number for the album.
  await s.store.putNote('u', '2025-09-22', 'd1', { text: 'Old', source: 'import', written_at: '2025-09-22T18:00:00Z' });
  const late = await s.call('POST', '/api/days/2026-09-22/notes', { text: 'Filled in', tz: 'America/Chicago' });
  assert.deepEqual((late.b as Item).unlocked, [
    { key: 'hotfix', id: 'hotfix', name: 'Hotfix', version: '4.5.121' },
    { key: 'compatible', id: 'compatible', name: 'Backward compatible', version: '4.5.100' },
    { key: 'round@2026-09-22', id: 'round', name: 'Round number', version: '4.5.100', album: true }
  ]);
  // A special day collected again is not a badge: it is not kept as seen.
  assert.deepEqual(await s.store.seenBadges('u'), new Set(['hello', 'web', 'commit', 'hotfix', 'compatible']));
  assert.deepEqual((await read('GET', '/api/days/2026-09-22')).collected, ['Round number']);
  assert.ok(!('collected' in (await read('GET', '/api/days/2026-09-21'))));
  assert.deepEqual((await read('GET', '/api/releases/4.5')).badges, {
    coverage: null,
    collected: [{ id: 'round', name: 'Round number', count: 1 }]
  });
  assert.deepEqual((await read('GET', '/api/releases/4.3')).badges, { coverage: null, collected: [] });
  for (const words of ['Short', 'Filled', 'Old']) assert.ok(!JSON.stringify((late.b as Item).unlocked).includes(words));
  // A failed read never fails the note: it is saved, with no `unlocked`.
  // (The web's store is its own wrapper round the same client.)
  const send = s.store.client.send.bind(s.store.client);
  s.store.client.send = async (command) => {
    if (command.constructor.name === 'QueryCommand' && JSON.stringify(command.input).includes('NOTE#'))
      throw new Error('read');
    return send(command);
  };
  const failed = await s.call('POST', '/api/days/2026-10-13/notes', { text: 'Still saved' });
  assert.equal(failed.r.status, 201);
  assert.ok(!('unlocked' in (failed.b as Item)));
  assert.deepEqual(
    s.logs.filter((l) => l.event === 'badges-error'),
    [{ event: 'badges-error', user: 'u', date: '2026-10-13' }]
  );
});

test('"Show badges" off hides every badge line; back on, what was earned meanwhile counts as seen', async () => {
  const s = await setup(),
    read = async (method: string, path: string, value?: unknown) => (await s.call(method, path, value)).b as Item;
  assert.equal((await read('GET', '/api/me')).badges, true);
  assert.equal((await s.call('PUT', '/api/me', { badges: 'no' })).r.status, 400);
  assert.equal((await read('PUT', '/api/me', { badges: false })).badges, false);
  assert.equal((await read('GET', '/api/me')).badges, false);
  // Off: no unlock, nothing seen, no Day or Release lines.
  const saved = await s.call('POST', '/api/days/2026-09-22/notes', { text: 'Filled in', tz: 'America/Chicago' });
  assert.equal(saved.r.status, 201);
  assert.ok(!('unlocked' in (saved.b as Item)));
  assert.deepEqual(await s.store.seenBadges('u'), new Set());
  assert.ok(!('collected' in (await read('GET', '/api/days/2026-09-22'))));
  assert.ok(!('badges' in (await read('GET', '/api/releases/4.5'))));
  // The page itself still answers: nothing is deleted.
  assert.ok(((await read('GET', '/api/badges')).count as number) > 0);
  // Back on: everything earned meanwhile is seen, unannounced.
  const earned = ((await read('GET', '/api/badges')).earned as Item[]).map((e) => e.key);
  assert.equal((await read('PUT', '/api/me', { badges: true })).badges, true);
  assert.deepEqual(await s.store.seenBadges('u'), new Set(earned));
  assert.deepEqual((await read('GET', '/api/days/2026-09-22')).collected, ['Round number']);
  // Saving it on again, or once more, adds nothing new.
  s.store.memory.calls.length = 0;
  await read('PUT', '/api/me', { badges: true });
  assert.ok(!s.store.memory.calls.some((c) => JSON.stringify(c.input).includes('BADGES')));
});

test('badges count stored fields, never answer with note text, and tell a reply from the standing address', async () => {
  const s = await setup(),
    empty = (await s.call('GET', '/api/badges')).b as Item;
  assert.deepEqual([empty.today, empty.version, empty.count], ['2026-10-13', '4.5.121', 0]);
  await s.store.putNote('u', '2026-10-12', 'm1', {
    text: 'A quiet reply',
    source: 'email',
    subject: '',
    written_at: '2026-10-12T23:00:00Z',
    tz: 'America/Chicago'
  });
  await s.store.putNote('u', '2026-10-12', 'm2', {
    text: 'To the standing address',
    source: 'email',
    written_at: '2026-10-13T01:00:00Z'
  });
  const web = await s.call('POST', '/api/days/2026-10-13/notes', {
    text: 'Private words #Kubb',
    tz: 'America/Chicago'
  });
  assert.equal(web.r.status, 201);
  const answer = await s.call('GET', '/api/badges'),
    b = answer.b as Item,
    earned = new Map((b.earned as Item[]).map((e) => [e.key, e]));
  assert.equal(answer.r.status, 200);
  for (const key of ['hello', 'ack', 'webhook', 'web', 'tag', 'commit']) assert.ok(earned.has(key), key);
  assert.ok(!earned.has('hotfix'), 'an evening reply is not late');
  assert.deepEqual([earned.get('ack')!.version, earned.get('web')!.version], ['4.5.120', '4.5.121']);
  assert.equal(b.count, (b.earned as Item[]).length);
  const delivery = (b.tracks as Item[]).find((t) => t.id === 'delivery')!;
  assert.deepEqual([delivery.best, delivery.now, delivery.level], [2, 2, null]);
  assert.equal((b.release as Item).v, '4.5');
  for (const private_ of ['quiet', 'standing', 'Private', 'Kubb', 'm1', 'USER#', 'NOTE#'])
    assert.ok(!JSON.stringify(b).includes(private_), private_);
  assert.ok(!JSON.stringify(s.logs).includes('Private'));
  assert.equal((await s.call('GET', '/api/badges', undefined, '')).r.status, 401);
});
