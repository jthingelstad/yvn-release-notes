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
  assert.equal(ROUTES.length, 71);
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
  // The new account's log starts with joining; signing in to make it is not a
  // sign-in to an account. Signing in to one that exists is.
  const bea = String(await s.store.userForEmail('bea@example.com')),
    kinds = (user: string) =>
      s.store.memory
        .all()
        .filter((i) => i.pk === `USER#${user}` && String(i.sk).startsWith('ACTIVITY#'))
        .map((i) => [i.kind, i.how ?? i.via]);
  assert.deepEqual(kinds(bea), [['account.created', 'web']]);
  await s.store.putLogin(
    auth.digest('u'.repeat(43)),
    'ada@example.com',
    auth.digest('ada@example.com'),
    auth.digest('654321'),
    now,
    900
  );
  assert.equal(
    (await s.call('POST', '/api/auth/verify', { email: 'ada@example.com', code: '654321' }, '')).r.status,
    200
  );
  assert.deepEqual(kinds('u'), [['signin', 'code']]);
});
test('notes/readers/tag/search/release share provenance and safe DTOs across routes', async () => {
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
  // A failed seen write keeps badges off, or a later email would announce
  // everything earned meanwhile.
  const send = s.store.client.send.bind(s.store.client);
  s.store.client.send = async (command) => {
    if (JSON.stringify(command.input).includes('"BADGES"')) throw new Error('write');
    return send(command);
  };
  const refused = await s.call('PUT', '/api/me', { badges: true });
  assert.deepEqual([refused.r.status, (refused.b as Item).error], [503, 'badges-failed']);
  s.store.client.send = send;
  assert.equal((await read('GET', '/api/me')).badges, false);
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

test('a pause already set for the rest of this week lowers its cadence bar today', async () => {
  const s = await setup();
  // Today is Tuesday 2026-10-13: a steady week before, notes Monday and
  // Tuesday, and Wednesday to Sunday paused, so two days make it steady.
  for (const day of ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12', '2026-10-13'])
    await s.store.putNote('u', day, 'w-' + day, { text: 'Fictional', source: 'web', written_at: `${day}T15:00:00Z` });
  await s.store.putPause('u', '2026-10-14', '2026-10-18', '2026-10-12T15:00:00Z');
  const cadence = (((await s.call('GET', '/api/badges')).b as Item).tracks as Item[]).find((t) => t.id === 'cadence')!;
  assert.deepEqual([cadence.best, cadence.now, cadence.level], [2, 2, 'alpha']);
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

test("activity answers the owner's rows newest first, a page at a time, with no table keys", async () => {
  const s = await setup(),
    row = (at: string, id: string, fields: Item) =>
      s.store.recordMail('u', `ACTIVITY#${at}#mail#${id}`, {
        kind: 'mail',
        at,
        message: id,
        received_at: at,
        via: 'reply',
        ...fields
      });
  await row('2026-10-12T10:00:00.000Z', 'a', { outcome: 'filed', day: '2026-10-12' });
  await row('2026-10-13T10:00:00.000Z', 'b', {
    outcome: 'not-filed',
    reason: 'expired',
    day: '2026-10-09',
    text: 'Late words',
    notified_at: '2026-10-13T10:00:00.000Z'
  });
  await row('2026-10-11T10:00:00.000Z', 'c', { via: 'address', outcome: 'filed', day: '2026-10-11' });
  // An assistant's reads, which only the MCP reader writes.
  s.store.seed({
    pk: 'MCPMETA#u',
    sk: 'ACTIVITY#2026-10-12T05:00:00.000Z#reads#f1',
    kind: 'reads',
    at: '2026-10-12T05:00:00.000Z',
    day: '2026-10-12',
    client: 'Claude',
    connection: 'f1',
    calls: 3,
    tools: { notes_get_day: 3 },
    last_at: '2026-10-12T18:00:00.000Z',
    revision: 3
  });
  s.store.seed({ pk: 'MCPMETA#other', sk: 'ACTIVITY#2026-10-12T05:00:00.000Z#reads#f9', kind: 'reads' });
  const { r, b } = await s.call('GET', '/api/activity'),
    entries = (b as Item).entries as Item[];
  assert.equal(r.status, 200);
  assert.deepEqual(
    entries.map((e) => [e.kind, e.id]),
    [
      ['mail', '2026-10-13T10:00:00.000Z#mail#b'],
      ['mail', '2026-10-12T10:00:00.000Z#mail#a'],
      ['reads', '2026-10-12T05:00:00.000Z#reads#f1'],
      ['mail', '2026-10-11T10:00:00.000Z#mail#c']
    ]
  );
  assert.deepEqual(
    [entries[0]!.reason, entries[0]!.text, entries[0]!.notified, entries[1]!.reason, entries[1]!.text],
    ['expired', 'Late words', true, null, null]
  );
  assert.deepEqual(
    [entries[2]!.client, entries[2]!.calls, entries[2]!.tools, entries[2]!.revision],
    ['Claude', 3, { notes_get_day: 3 }, undefined]
  );
  assert.deepEqual([(b as Item).email, (b as Item).today, (b as Item).next], ['ada@example.com', '2026-10-13', null]);
  for (const key of ['MCPMETA#', 'USER#', 'expires_at', 'notified_at', 'f9'])
    assert.ok(!JSON.stringify(b).includes(key), key);
  // Older rows start below a row's id.
  const older = await s.call('GET', '/api/activity?before=' + encodeURIComponent('2026-10-12T10:00:00.000Z#mail#a'));
  assert.deepEqual(
    ((older.b as Item).entries as Item[]).map((e) => e.id),
    ['2026-10-12T05:00:00.000Z#reads#f1', '2026-10-11T10:00:00.000Z#mail#c']
  );
  for (const bad of ['yesterday', 'NOTE#2026-10-12', '2026-10-12T10:00:00.000Z' + '#x'.repeat(200)])
    assert.equal(
      (await s.call('GET', '/api/activity?before=' + encodeURIComponent(bad))).r.status,
      400,
      bad.slice(0, 20)
    );
  assert.equal((await s.call('GET', '/api/activity', undefined, '')).r.status, 401);
  assert.ok(!JSON.stringify(s.logs).includes('Late words'));
});

test('each change on the web leaves its activity row, never words, titles, addresses or links', async () => {
  const s = await setup(),
    step = async (method: string, path: string, value?: unknown, cookie?: string, originHeader?: boolean) => {
      s.ctx.now += 1;
      const answer = await s.call(method, path, value, cookie, originHeader);
      assert.ok(answer.r.status < 300, `${method} ${path}: ${answer.r.status}`);
      return answer.b as Item;
    };
  const note = await step('POST', '/api/days/2026-10-12/notes', { text: 'Private words', tz: 'America/Chicago' }),
    id = String(note.id);
  await step('PUT', `/api/days/2026-10-12/notes/${id}`, { text: 'Private words, changed' });
  await step('DELETE', `/api/days/2026-10-12/notes/${id}`);
  await step('PUT', '/api/me', { send_time: '07:15', transcribe: true, badges: true });
  await step('PUT', '/api/pause', { days: 3 });
  await step('DELETE', '/api/pause');
  const inboxes = [await step('POST', '/api/me/inbox', {}), await step('POST', '/api/me/inbox', {})];
  const date = await step('POST', '/api/upcoming', { kind: 'event', title: 'Secret party', date: '2026-11-01' });
  await step('PUT', `/api/upcoming/${String(date.id)}`, {
    kind: 'event',
    title: 'Secret party',
    date: '2026-11-02',
    revision: 1
  });
  const kept = await step('POST', '/api/upcoming', { kind: 'event', title: 'Kept party', date: '2026-11-03' });
  await step('DELETE', `/api/upcoming/${String(date.id)}`, { revision: 2 });
  const calendars = [await step('POST', '/api/calendar'), await step('POST', '/api/calendar')];
  await step('DELETE', '/api/calendar');
  await step('GET', '/api/export?format=md');
  await step('POST', '/api/export/zip', {});
  const token = 'a'.repeat(24);
  await s.store.putDay('u', '2026-10-13', '4.5.121', token, '2026-10-13T10:00:00Z');
  await step('POST', '/api/unsubscribe?t=' + token, {}, '', false);
  await step('PUT', '/api/me', { status: 'active' });

  const rows = s.store.memory
      .all()
      .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#'))
      .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : 1)),
    by = (kind: string) => rows.filter((r) => r.kind === kind);
  assert.deepEqual(
    rows.map((r) => r.kind).filter((k) => k !== 'badge.earned'),
    [
      'note.added',
      'note.edited',
      'note.deleted',
      'settings.changed',
      'pause.set',
      'pause.ended',
      'address.created',
      'address.replaced',
      'upcoming.added',
      'upcoming.changed',
      'upcoming.added',
      'upcoming.removed',
      'calendar.created',
      'calendar.replaced',
      'calendar.removed',
      'export.words',
      'export.zip',
      'status.stopped',
      'status.restarted'
    ]
  );
  // The first note's badges, with it, from the web.
  assert.deepEqual(
    by('badge.earned').map((r) => [r.badge, r.name, r.via, r.day, r.note]),
    [
      ['commit', 'Commit message', 'web', '2026-10-12', id],
      ['hello', 'Hello, world', 'web', '2026-10-12', id],
      ['hotfix', 'Hotfix', 'web', '2026-10-12', id],
      ['web', 'Web release', 'web', '2026-10-12', id]
    ]
  );
  assert.deepEqual(
    by('note.added').map((r) => [r.via, r.day, r.note, r.files]),
    [['web', '2026-10-12', id, 0]]
  );
  // Only what changed, unchanged badges left out; coordinates never.
  assert.deepEqual(by('settings.changed')[0]!.changes, [
    { field: 'send_time', from: '06:00', to: '07:15' },
    { field: 'transcribe', from: false, to: true }
  ]);
  assert.deepEqual(
    [...by('pause.set'), ...by('pause.ended')].map((r) => [r.from, r.through]),
    [
      ['2026-10-13', '2026-10-15'],
      ['2026-10-13', null]
    ]
  );
  assert.deepEqual(
    by('upcoming.removed').map((r) => r.upcoming),
    [date.id]
  );
  assert.deepEqual(by('status.restarted')[0]!.reason, 'unsubscribed');
  assert.deepEqual(by('export.words')[0]!.format, 'md');
  const kept_ = JSON.stringify(rows);
  for (const hidden of [
    'Private words',
    'Secret party',
    'Kept party',
    'ada@example.com',
    ...inboxes.map((b) => String(b.inbox).split('@')[0]!),
    ...calendars.map((b) => String(b.calendar).split('/').at(-1)!.replace('.ics', '')),
    'lat',
    'lon'
  ])
    assert.ok(!kept_.includes(hidden), hidden);

  // The page joins a date's title as it is now; a removed date has none.
  const shown = ((await s.call('GET', '/api/activity')).b as Item).entries as Item[];
  assert.deepEqual(
    shown.filter((e) => String(e.kind).startsWith('upcoming.')).map((e) => [e.kind, e.title]),
    [
      ['upcoming.removed', null],
      ['upcoming.added', 'Kept party'],
      ['upcoming.changed', null],
      ['upcoming.added', null]
    ]
  );
  assert.ok(kept.id);
});
test("a day's own place and repeats in one second each leave a row, the day alone", async () => {
  const s = await setup(),
    call = async (method: string, path: string, value?: unknown) => {
      const answer = await s.call(method, path, value);
      assert.ok(answer.r.status < 300, `${method} ${path}: ${answer.r.status}`);
      return answer.b as Item;
    },
    city = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
  // All in the same second, as a quick hand or an assistant may.
  const id = String(
    (await call('POST', '/api/days/2026-10-12/notes', { text: 'Private words', tz: 'America/Chicago' })).id
  );
  await call('PUT', `/api/days/2026-10-12/notes/${id}`, { text: 'Changed once' });
  await call('PUT', `/api/days/2026-10-12/notes/${id}`, { text: 'Changed twice' });
  await call('PUT', '/api/days/2026-10-12/place', { place: city });
  await call('DELETE', '/api/days/2026-10-12/place');
  await call('PUT', '/api/days/2026-10-12/place', { place: city });

  const rows = s.store.memory
    .all()
    .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#') && i.kind !== 'badge.earned')
    .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : 1));
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['note.added', 'note.edited', 'note.edited', 'place.removed', 'place.set', 'place.set']
  );
  for (const row of rows.filter((r) => String(r.kind).startsWith('place.'))) {
    assert.deepEqual(Object.keys(row).sort(), ['at', 'day', 'kind', 'pk', 'sk', 'via']);
    assert.deepEqual([row.via, row.day], ['web', '2026-10-12']);
  }
  // A repeat's key ends in a random hex tail after the day ('2026-10-12.35…'),
  // which would read as the longitude one time in a hundred: leave tails out.
  const kept = JSON.stringify(rows).replace(/\.[0-9a-f]{8}"/g, '"');
  for (const hidden of ['Paris', 'France', '48.85', '2.35', 'Private words', 'Changed'])
    assert.ok(!kept.includes(hidden), hidden);
});
test('a change whose activity row cannot be written still stands, and is logged without its words', async () => {
  const s = await setup(),
    send = s.store.memory.send.bind(s.store.memory);
  let refusal: Error = Object.assign(new Error('refused'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed' }]
  });
  s.store.memory.send = async (command) => {
    const ops = ((command.input as Item).TransactItems ?? []) as Item[];
    if (ops.some((op) => String(((op.Put as Item | undefined)?.Item as Item | undefined)?.sk).startsWith('ACTIVITY#')))
      throw refusal;
    return send(command);
  };
  const saved = await s.call('POST', '/api/days/2026-10-12/notes', { text: 'Private words', tz: 'America/Chicago' });
  assert.equal(saved.r.status, 201);
  assert.equal((await s.store.allNotes('u')).length, 1);
  assert.deepEqual(
    s.logs.filter((l) => l.event === 'activity-unrecorded'),
    [{ event: 'activity-unrecorded', kind: 'note', user: 'u' }]
  );
  refusal = new Error('Private words');
  assert.equal((await s.call('PUT', '/api/me', { send_time: '07:15' })).r.status, 200);
  assert.equal((await s.store.profile('u'))!.send_time, '07:15');
  assert.deepEqual(s.logs.filter((l) => l.event === 'activity-unrecorded').at(-1), {
    event: 'activity-unrecorded',
    kind: 'settings',
    user: 'u'
  });
  assert.ok(!JSON.stringify(s.logs).includes('Private words'));
});
test('activity pages hold 100 rows and say where the next starts', async () => {
  const s = await setup();
  for (let i = 0; i < 101; i++) {
    const at = new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString();
    s.store.seed({
      pk: 'USER#u',
      sk: `ACTIVITY#${at}#mail#m${i}`,
      kind: 'mail',
      at,
      message: `m${i}`,
      received_at: at
    });
  }
  const first = (await s.call('GET', '/api/activity')).b as Item,
    rows = first.entries as Item[];
  assert.equal(rows.length, 100);
  assert.equal(rows[0]!.message, 'm100');
  assert.equal(first.next, rows[99]!.id);
  const last = (await s.call('GET', '/api/activity?before=' + encodeURIComponent(String(first.next)))).b as Item;
  assert.deepEqual([(last.entries as Item[]).map((e) => e.message), last.next], [['m0'], null]);
});
test("Here names the device's spot; a note keeps the spot exact and its neighbourhood or business, the weather the city", async () => {
  const s = await setup(),
    asked: unknown[] = [],
    cafe = { name: 'Café de Flore', lat: 48.854, lon: 2.3325, distance_m: 30 };
  s.ctx.nameSpot = async (spot) => {
    asked.push(spot);
    return {
      city: 'Paris',
      region: 'Ile-de-France',
      country: 'France',
      tz: 'Europe/Paris',
      district: 'Le Marais',
      nearby: [cafe]
    };
  };
  s.ctx.weatherFetch = async () => ({
    daily: { time: ['2026-10-07'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] }
  });
  const spot = { lat: 48.8566134, lon: 2.3522219, accuracy_m: 11.6 },
    here = await s.call('POST', '/api/places/here', spot);
  assert.equal(here.r.status, 200);
  assert.deepEqual(here.b, {
    name: 'Paris',
    region: 'Ile-de-France',
    country: 'France',
    tz: 'Europe/Paris',
    district: 'Le Marais',
    nearby: [cafe],
    lat: 48.856613,
    lon: 2.352222,
    accuracy_m: 12,
    from: 'device'
  });
  assert.deepEqual(asked, [{ lat: 48.856613, lon: 2.352222, accuracy_m: 12 }]);
  // Refused: signed out, without our Origin, nonsense, and a spot with no city.
  assert.equal((await s.call('POST', '/api/places/here', spot, '')).r.status, 401);
  assert.equal((await s.call('POST', '/api/places/here', spot, s.token, false)).r.status, 403);
  for (const bad of [{}, { lat: 91, lon: 0 }, { lat: '1', lon: 2 }, { lat: 1, lon: 2, accuracy_m: -1 }])
    assert.equal((await s.call('POST', '/api/places/here', bad)).r.status, 400, JSON.stringify(bad));
  const naming = s.ctx.nameSpot;
  s.ctx.nameSpot = async () => null;
  assert.deepEqual((await s.call('POST', '/api/places/here', spot)).b, { error: 'place-unnamed' });
  s.ctx.nameSpot = async () => {
    throw new Error('down');
  };
  assert.equal((await s.call('POST', '/api/places/here', spot)).r.status, 502);
  s.ctx.nameSpot = naming;

  // A note written there keeps the spot; it shows by name, mapped to the spot.
  const added = await s.call('POST', '/api/days/2026-10-07/notes', {
    text: 'Coffee',
    place: here.b,
    tz: 'Europe/Paris'
  });
  assert.equal(added.r.status, 201);
  const id = String((added.b as Item).id),
    note = () => s.store.memory.all().find((i) => i.sk === `NOTE#2026-10-07#${id}`)! as Item & { place: Item };
  assert.equal((added.b as Item).place, 'Le Marais, Paris');
  assert.match(String((added.b as Item).map), /48\.856613,2\.352222/);
  assert.deepEqual(
    [note().place.lat, note().place.lon, note().place.accuracy_m, note().place.from, note().place.district],
    [48.856613, 2.352222, 12, 'device', 'Le Marais']
  );
  // What was near is offered, never kept.
  assert.ok(!Object.hasOwn(note().place, 'nearby'));
  // The day's weather is for the city, never the spot.
  const sky = () => s.store.memory.all().find((i) => i.sk === 'WEATHER#2026-10-07')!;
  assert.deepEqual([sky().lat, sky().lon], [48.86, 2.35]);
  // A made-up device place is refused, nothing written.
  for (const bad of [
    { ...(here.b as Item), name: '' },
    { ...(here.b as Item), tz: 'Mars/Base' },
    { ...(here.b as Item), lat: 200 },
    { ...(here.b as Item), venue: 'x'.repeat(101) },
    { ...(here.b as Item), district: 7 }
  ])
    assert.equal(
      (await s.call('POST', '/api/days/2026-10-07/notes', { text: 'No', place: bad })).r.status,
      400,
      JSON.stringify(bad)
    );
  assert.equal((await s.store.allNotes('u')).length, 1);

  // The business picked from what was near names it, still mapped to the spot.
  const at = await s.call('PUT', `/api/days/2026-10-07/notes/${id}/place`, {
    place: { ...(here.b as Item), venue: 'Café de Flore' }
  });
  assert.equal((at.b as Item).place, 'Café de Flore, Paris');
  assert.match(String((at.b as Item).map), /ll=48\.856613,2\.352222&q=Caf%C3%A9%20de%20Flore,%20Paris$/);
  assert.equal(note().place.venue, 'Café de Flore');
});
test("a saved note's place can be set, changed and cleared, from any channel, and the log never keeps it", async () => {
  const s = await setup();
  s.ctx.weatherFetch = async () => ({
    daily: { time: ['2026-10-07'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] }
  });
  // An emailed note, which came with no place.
  await s.store.putNote('u', '2026-10-07', 'm-1', {
    text: 'By email',
    source: 'email',
    written_at: '2026-10-07T15:00:00Z'
  });
  const path = '/api/days/2026-10-07/notes/m-1/place',
    note = () => s.store.memory.all().find((i) => i.sk === 'NOTE#2026-10-07#m-1')! as Item & { place: Item },
    spot = { name: 'Paris', region: 'Ile-de-France', country: 'France', lat: 48.856613, lon: 2.352222, from: 'device' };
  const set = await s.call('PUT', path, { place: spot });
  assert.equal(set.r.status, 200);
  assert.equal((set.b as Item).place, 'Paris, Ile-de-France');
  assert.equal((set.b as Item).text, 'By email');
  assert.equal(note().place.lat, 48.856613);
  assert.equal(note().updated_at, undefined);
  assert.deepEqual([s.store.memory.all().find((i) => i.sk === 'WEATHER#2026-10-07')!.lat], [48.86]);
  // Changed to a city from the search, which is kept at the city.
  const moved = await s.call('PUT', path, { place: { ...city, name: 'Lyon', lat: 45.76, lon: 4.84 } });
  assert.equal((moved.b as Item).place, 'Lyon, Ile-de-France');
  assert.deepEqual([note().place.lat, note().place.from], [45.76, 'chosen']);
  const cleared = await s.call('DELETE', path);
  assert.equal(cleared.r.status, 200);
  assert.ok(!Object.hasOwn(cleared.b as Item, 'place'));
  assert.ok(!Object.hasOwn(cleared.b as Item, 'place_cleared'));
  assert.equal(note().place_cleared, true);
  assert.ok(!Object.hasOwn(note(), 'place'));
  assert.equal((await s.call('PUT', '/api/days/2026-10-07/notes/missing/place', { place: spot })).r.status, 404);
  assert.equal((await s.call('PUT', path, { place: { ...spot, lat: 'x' } })).r.status, 400);
  assert.equal((await s.call('PUT', path, { place: spot }, s.token, false)).r.status, 403);
  const rows = s.store.memory
    .all()
    .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#') && i.kind === 'note.edited')
    .sort((a, b) => (String(a.sk) < String(b.sk) ? -1 : 1));
  // Rows written in one second order by their ids, not by when.
  assert.deepEqual(rows.map((r) => r.place).sort(), ['removed', 'set', 'set']);
  const kept = JSON.stringify(rows);
  for (const hidden of ['Paris', 'Lyon', '48.85', '2.35', 'By email']) assert.ok(!kept.includes(hidden), hidden);
});
test("a note without a place shows the day's city or home, marked inherited, unless it was cleared", async () => {
  const s = await setup(),
    day = async (d: string) => ((await s.call('GET', `/api/days/${d}`)).b as Item).notes as Item[];
  s.ctx.weatherFetch = async () => ({
    daily: { time: ['2026-10-07'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [2] }
  });
  for (const [id, extra] of [
    ['m-1', {}],
    ['m-2', { place_cleared: true }],
    [
      'w-3',
      {
        place: {
          venue: 'Café de Flore',
          city: 'Paris',
          region: 'Ile-de-France',
          lat: 48.854,
          lon: 2.3325,
          from: 'device'
        }
      }
    ]
  ] as const)
    await s.store.putNote('u', '2026-10-06', id, {
      text: id,
      source: id.startsWith('m') ? 'email' : 'web',
      written_at: `2026-10-06T1${id.at(-1)}:00:00Z`,
      ...extra
    });
  await s.store.putNote('u', '2026-10-05', 'm-4', { text: 'm-4', source: 'email', written_at: '2026-10-05T15:00:00Z' });
  // A day with a placed note: its city, never the business or the spot.
  const [first, cleared, own] = await day('2026-10-06');
  assert.deepEqual([first!.place, first!.place_from, first!.map], ['Paris, Ile-de-France', 'day', undefined]);
  assert.ok(!Object.hasOwn(cleared!, 'place'));
  assert.deepEqual([own!.place, own!.place_from], ['Café de Flore, Paris', undefined]);
  // A day with nothing placed: home.
  const [lone] = await day('2026-10-05');
  assert.deepEqual([lone!.place, lone!.place_from, lone!.map], ['Minneapolis, United States', 'home', undefined]);
  // The day's own place, once set, is what it inherits; the note is unchanged.
  assert.equal((await s.call('PUT', '/api/days/2026-10-05/place', { place: city })).r.status, 200);
  const [moved] = await day('2026-10-05');
  assert.deepEqual([moved!.place, moved!.place_from], ['Paris, Ile-de-France', 'day']);
  assert.ok(
    !Object.hasOwn(
      s.store.memory.all().find((i) => i.sk === 'NOTE#2026-10-05#m-4')!,
      'place'
    )
  );
  // "No place" on it: the inherited city goes too.
  assert.equal((await s.call('DELETE', '/api/days/2026-10-05/notes/m-4/place')).r.status, 200);
  assert.ok(!Object.hasOwn((await day('2026-10-05'))[0]!, 'place'));
});
test('search and tag pages show the inherited city the whole day does, not their matches alone', async () => {
  const s = await setup();
  s.ctx.weatherFetch = async () => ({
    daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [] }
  });
  const add = async (text: string, place?: Item) =>
    String(((await s.call('POST', '/api/days/2026-10-06/notes', { text, ...(place ? { place } : {}) })).b as Item).id);
  await add('Croissants', city);
  const id = await add('Thinking about #walks');
  const matched = async (r: Promise<{ b: unknown }>) =>
    (((await r).b as Item).days as Item[]).flatMap((d) => d.notes as Item[]).find((n) => n.id === id)!;
  for (const found of [
    await matched(s.call('POST', '/api/search', { q: 'thinking' })),
    await matched(s.call('GET', '/api/tags/walks'))
  ])
    assert.deepEqual([found.place, found.place_from], ['Paris, Ile-de-France', 'day']);
});
test('the map pins notes with a place of their own and passes the base map through, kept by the browser alone', async () => {
  const s = await setup(),
    asked: string[] = [];
  s.ctx.weatherFetch = async () => ({
    daily: { time: [], temperature_2m_max: [], temperature_2m_min: [], weather_code: [] }
  });
  const file = (body: string, type: string) => ({ body: new TextEncoder().encode(body), type });
  s.ctx.maps = {
    async style(scheme) {
      asked.push('style ' + scheme);
      return file(
        JSON.stringify({
          version: 8,
          sources: {
            aws: {
              type: 'vector',
              tiles: ['https://maps.geo.us-east-1.amazonaws.com/v2/tiles/vector.basemap/{z}/{x}/{y}']
            },
            other: { type: 'raster', tiles: ['https://elsewhere.example/{z}/{x}/{y}.png'] }
          },
          glyphs: 'https://maps.geo.us-east-1.amazonaws.com/v2/glyphs/{fontstack}/{range}.pbf',
          projection: { type: 'globe' },
          sky: { 'sky-color': 'hsl(208, 90%, 72%)' },
          sprite: 'https://maps.geo.us-east-1.amazonaws.com/v2/styles/x/Standard/Dark/Default/sprites/sprites',
          layers: [
            { id: 'bg', type: 'background' },
            { id: 'roads', source: 'aws' },
            { id: 'pics', source: 'other' }
          ]
        }),
        'application/json'
      );
    },
    tile: async (z, x, y) => (
      asked.push(`tile ${z}/${x}/${y}`),
      z === 9 ? null : file('pbf', 'application/x-protobuf')
    ),
    glyphs: async (fonts, range) => (asked.push(`glyphs ${fonts} ${range}`), file('pbf', 'application/x-protobuf')),
    sprites: async (scheme, name) => (asked.push(`sprites ${scheme} ${name}`), file('{}', 'application/json'))
  };
  const add = async (text: string, place?: Item) =>
    String(((await s.call('POST', '/api/days/2026-10-06/notes', { text, ...(place ? { place } : {}) })).b as Item).id);
  // Links show by name in the preview, as everywhere (links.segments), and
  // a long address counts by its name, not its length.
  s.ctx.fetchTitle = () => ({ title: 'The river walk', site: 'example.com' });
  const long = 'https://example.com/' + 'a'.repeat(200),
    inParis = await add(`Croissants and a long walk along the river ${long} #paris`, city),
    here = await add('On the bench'),
    rambling = await add('Then ' + 'more and '.repeat(30) + 'done', city),
    inherited = await add('An emailed thought'),
    cleared = await add('Nowhere in particular', city);
  await s.call('PUT', `/api/days/2026-10-06/notes/${here}/place`, {
    place: {
      name: 'Paris',
      region: 'Ile-de-France',
      country: 'France',
      district: 'Le Marais',
      lat: 48.856613,
      lon: 2.352222,
      from: 'device'
    }
  });
  await s.call('DELETE', `/api/days/2026-10-06/notes/${cleared}/place`);
  const pins = await s.call('GET', '/api/map/notes');
  assert.equal(pins.r.headers.get('cache-control'), 'no-store');
  assert.equal((pins.b as Item).notes, 5);
  // A pin's release is the year of life its day falls in (born 1981-06-14),
  // not its calendar year.
  const shown = ((pins.b as Item).pins as Item[]).sort((a, b) => String(a.text).localeCompare(String(b.text)));
  assert.deepEqual(shown, [
    {
      date: '2026-10-06',
      id: inParis,
      lat: 48.85,
      lon: 2.35,
      place: 'Paris, Ile-de-France',
      exact: false,
      tags: ['paris'],
      release: '4.5',
      version: '4.5.114',
      text: 'Croissants and a long walk along the river The river walk #paris',
      parts: [
        'Croissants and a long walk along the river ',
        { url: long, label: 'The river walk', site: 'example.com' },
        ' ',
        { tag: 'paris', text: '#paris' }
      ]
    },
    {
      date: '2026-10-06',
      id: here,
      lat: 48.856613,
      lon: 2.352222,
      place: 'Le Marais, Paris',
      exact: true,
      tags: [],
      release: '4.5',
      version: '4.5.114',
      text: 'On the bench',
      parts: ['On the bench']
    },
    {
      date: '2026-10-06',
      id: rambling,
      lat: 48.85,
      lon: 2.35,
      place: 'Paris, Ile-de-France',
      exact: false,
      tags: [],
      release: '4.5',
      version: '4.5.114',
      text: ('Then ' + 'more and '.repeat(30)).slice(0, 139) + '…',
      parts: [('Then ' + 'more and '.repeat(30)).slice(0, 139), '…']
    }
  ]);
  assert.ok(!shown.some((p) => p.id === inherited || p.id === cleared));

  // The Map's search finds pins as the Search page finds notes (a link by
  // its name, a place by its name), and never a note with no spot of its own.
  const ids = async (q: string) =>
    (((await s.call('POST', '/api/map/search', { q })).b as Item).found as Item[]).map((f) => String(f.id)).sort();
  assert.deepEqual(await ids('croissants'), [inParis]);
  assert.deepEqual(await ids('"river walk"'), [inParis]);
  assert.deepEqual(await ids('marais bench'), [here]);
  assert.deepEqual(await ids('PARIS'), [inParis, here, rambling].sort());
  assert.deepEqual(await ids('emailed'), []);
  assert.deepEqual(await ids('nowhere'), []);
  const searched = await s.call('POST', '/api/map/search', { q: 'Croissants' });
  assert.equal(searched.r.headers.get('cache-control'), 'no-store');
  assert.deepEqual(searched.b, { terms: ['croissants'], found: [{ date: '2026-10-06', id: inParis }] });
  for (const [q, error] of [
    ['', 'query'],
    ['""', 'query'],
    ['x'.repeat(201), 'query-too-long']
  ]) {
    const refused = await s.call('POST', '/api/map/search', { q });
    assert.deepEqual([refused.r.status, (refused.b as Item).error], [400, error], q);
  }
  assert.equal((await s.call('POST', '/api/map/search', { q: 'paris' }, '')).r.status, 401);
  assert.equal((await s.call('POST', '/api/map/search', { q: 'paris' }, undefined, false)).r.status, 403);

  // The style points every Amazon address back here and drops other sources.
  const style = await s.call('GET', '/api/map/style/Dark'),
    drawn = style.b as Item;
  assert.equal(style.r.headers.get('cache-control'), 'private, max-age=86400');
  assert.deepEqual(drawn.sources, { aws: { type: 'vector', tiles: [`${origin}/api/map/tiles/{z}/{x}/{y}`] } });
  assert.deepEqual(
    (drawn.layers as Item[]).map((l) => l.id),
    ['bg', 'roads']
  );
  assert.equal(drawn.glyphs, `${origin}/api/map/glyphs/{fontstack}/{range}.pbf`);
  assert.equal(drawn.sprite, `${origin}/api/map/sprites/Dark/sprites`);
  // Flat, not Amazon's globe.
  assert.deepEqual(drawn.projection, { type: 'mercator' });
  assert.ok(!('sky' in drawn));
  const tile = await s.call('GET', '/api/map/tiles/3/2/2');
  assert.equal(tile.r.status, 200);
  assert.equal(tile.r.headers.get('content-type'), 'application/x-protobuf');
  assert.equal(tile.r.headers.get('cache-control'), 'private, max-age=86400');
  assert.equal((await s.call('GET', '/api/map/tiles/9/1/1')).r.headers.get('cache-control'), 'no-store');
  await s.call('GET', '/api/map/glyphs/Amazon%20Ember%20Bold,Noto%20Sans%20Bold/256-511.pbf');
  await s.call('GET', '/api/map/sprites/Light/sprites@2x.json');
  assert.deepEqual(asked, [
    'style Dark',
    'tile 3/2/2',
    'tile 9/1/1',
    'glyphs Amazon Ember Bold,Noto Sans Bold 256-511',
    'sprites Light sprites@2x.json'
  ]);
  // Refused before Amazon Location is asked: signed out, no such tile, scheme,
  // glyph range or sprite file.
  for (const [path, status] of [
    ['/api/map/notes', 401],
    ['/api/map/tiles/3/2/2', 401]
  ] as const)
    assert.equal((await s.call('GET', path, undefined, '')).r.status, status, path);
  for (const path of [
    '/api/map/tiles/3/8/0',
    '/api/map/tiles/23/0/0',
    '/api/map/style/Sepia',
    '/api/map/glyphs/Amazon%20Ember%20Bold/1-256.pbf',
    '/api/map/glyphs/..%2Fetc/0-255.pbf',
    '/api/map/sprites/Light/other.png'
  ])
    assert.equal((await s.call('GET', path)).r.status, 404, path);
  assert.equal(asked.length, 5);
});
test('"Add where I am" is a setting, on until turned off, and recorded as a change', async () => {
  const s = await setup();
  assert.equal(((await s.call('GET', '/api/me')).b as Item).here, true);
  const off = await s.call('PUT', '/api/me', { here: false });
  assert.equal((off.b as Item).here, false);
  assert.equal((await s.call('PUT', '/api/me', { here: 'yes' })).r.status, 400);
  const row = s.store.memory.all().find((i) => i.kind === 'settings.changed')!;
  assert.deepEqual(row.changes, [{ field: 'here', from: true, to: false }]);
});
