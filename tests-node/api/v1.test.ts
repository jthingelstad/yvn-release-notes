/** API tokens and the public `/v1` API (docs/API.md): the token's life in
 * Settings, the bearer rule, every route's scope, writes through the
 * capture function with their receipts, counts and refusals, pinned tags,
 * and the activity log trimmed of words. Fictional account only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, handleMcp, type McpOptions } from '../../server/mcp/app.ts';
import { API_VERSION, V1_BODY, V1_ROUTES } from '../../server/mcp/v1.ts';
import { MAX_NOTE } from '../../packages/domain/notes.ts';
import { captureNote } from '../../workers/capture.ts';
import {
  accountId,
  PER_TOKEN_RECEIPTS_UNTIL,
  Tokens,
  TOKEN_FORMAT,
  TOKENS_MAX,
  V1_LIMITS,
  V1_RECEIPT_SECONDS,
  clientProduct
} from '../../packages/backend/tokens.ts';
import { fingerprint } from '../../server/mcp/common.ts';
import { OAuthService, publicOAuth, type OAuthRow } from '../../packages/backend/oauth.ts';
import { activityKey, activityTime } from '../../packages/domain/activity.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { digest } from '../../packages/backend/auth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, connected, note, ORIGIN, NOW, PROFILE } from '../oauth/fixtures.ts';

const TODAY = '2026-10-13',
  VERSION = computeVersion(PROFILE.birthday, TODAY).toString();
type Ctx = ReturnType<typeof fixture> & { objects: FakeObjects };
type Made = OAuthRow & { token: string; id: string };

function setup(logs: OAuthRow[] = []) {
  const ctx: Ctx = { ...fixture(), objects: new FakeObjects() },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => logs.push(f) }),
      log: (f) => logs.push(f)
    };
  return { ctx, options, app: createMcpApp(options), logs };
}
const tokens = (ctx: Ctx) => new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now });
async function make(ctx: Ctx, body: OAuthRow = {}, uid = 'u'): Promise<Made> {
  return (await tokens(ctx).make(uid, {
    name: 'Changelog',
    scopes: ['notes:write', 'activity'],
    expiry: 'never',
    ...body
  })) as Made;
}
type Call = { token?: string; body?: unknown; headers?: Record<string, string> };
async function call(app: ReturnType<typeof createMcpApp>, method: string, path: string, o: Call = {}) {
  const headers: Record<string, string> = { ...(o.token ? { authorization: 'Bearer ' + o.token } : {}) };
  if (o.body !== undefined && typeof o.body !== 'string') headers['content-type'] = 'application/json';
  Object.assign(headers, o.headers);
  const response = await app.request(ORIGIN + path, {
      method,
      headers,
      ...(o.body === undefined ? {} : { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) })
    }),
    text = await response.text();
  let json: OAuthRow | null = null;
  try {
    json = text ? (JSON.parse(text) as OAuthRow) : null;
  } catch {
    /* A text/plain answer. */
  }
  return { response, status: response.status, text, json, error: (json?.error ?? {}) as OAuthRow };
}
const noteOf = (r: { json: OAuthRow | null }) => r.json!.note as OAuthRow;

test('a token is made once, kept only as its hash, listed and ended in Settings', async () => {
  const { ctx } = setup(),
    made = await make(ctx, { name: '  Terminal  ', scopes: ['activity', 'notes:write'], expiry: '90d' });
  assert.match(made.token, TOKEN_FORMAT);
  assert.equal(made.name, 'Terminal');
  assert.deepEqual(made.scopes, ['notes:write', 'activity']);
  assert.equal(made.expires_at, NOW + 90 * 86400);
  const rows = ctx.store.memory.all();
  // Only the hash is kept, anywhere.
  assert.ok(!JSON.stringify(rows).includes(made.token));
  const row = ctx.store.memory.read({ pk: 'USER#u', sk: 'APITOKEN#' + made.id })!;
  assert.equal(row.hash, digest(made.token));
  assert.equal(row.revision, 1);
  const pointer = ctx.store.memory.read({ pk: 'OAUTHACCESS#' + digest(made.token), sk: 'STATE' })!;
  assert.deepEqual(
    { kind: pointer.kind, user_id: pointer.user_id, token: pointer.token, resource: pointer.resource },
    { kind: 'token', user_id: 'u', token: made.id, resource: ORIGIN + '/v1' }
  );
  assert.ok(ctx.store.memory.read({ pk: 'OAUTHUSER#u', sk: 'ROW#OAUTHACCESS#' + digest(made.token) }));
  const added = rows.find((r) => r.kind === 'connection.added')!;
  assert.deepEqual(
    { via: added.via, client: added.client, token: added.token, scopes: added.scopes },
    { via: 'web', client: 'Terminal', token: 'Terminal', scopes: 'notes:write activity' }
  );

  const listed = (await tokens(ctx).list('u')).tokens;
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]!).sort(), [
    'created_at',
    'expired',
    'expires_at',
    'id',
    'last_used',
    'name',
    'scopes'
  ]);

  // Names are unique among live tokens, without case.
  await assert.rejects(make(ctx, { name: 'terminal' }), { status: 409, error: 'token-name-taken' });
  for (const [body, code] of [
    [{ name: '' }, 'token-name'],
    [{ name: 'x'.repeat(41) }, 'token-name'],
    [{ name: 'tab\there' }, 'token-name'],
    [{ scopes: [] }, 'token-scopes'],
    [{ scopes: ['notes:read'] }, 'token-scopes'],
    [{ scopes: ['notes:write', 'notes:write'] }, 'token-scopes'],
    // Files ride on adding notes.
    [{ scopes: ['media:write'] }, 'token-scopes'],
    [{ expiry: '10y' }, 'token-expiry']
  ] as [OAuthRow, string][])
    await assert.rejects(make(ctx, { name: 'Other', ...body }), { status: 400, error: code }, JSON.stringify(body));

  await tokens(ctx).revoke('u', made.id);
  assert.equal(ctx.store.memory.read({ pk: 'USER#u', sk: 'APITOKEN#' + made.id }), null);
  // Its pointer stays a while, so the client is told it was revoked.
  const tomb = ctx.store.memory.read({ pk: 'OAUTHACCESS#' + digest(made.token), sk: 'STATE' })!;
  assert.equal(tomb.revoked, true);
  assert.equal(tomb.expires_at, NOW + 30 * 86400);
  const removed = ctx.store.memory.all().find((r) => r.kind === 'connection.removed')!;
  assert.equal(removed.reason, 'owner');
  // The owner ended it, not the token: no token_id.
  assert.equal(removed.token_id, undefined);
  assert.deepEqual((await tokens(ctx).list('u')).tokens, []);
  await assert.rejects(tokens(ctx).revoke('u', made.id), { status: 404 });
  // The name is free again.
  await make(ctx, { name: 'Terminal' });
});

test('at most 20 live tokens; an expired one leaves room and shows as expired', async () => {
  const { ctx } = setup();
  const first = await make(ctx, { name: 'T0', expiry: '90d' });
  for (let i = 1; i < TOKENS_MAX; i++) await make(ctx, { name: 'T' + i });
  await assert.rejects(make(ctx, { name: 'One more' }), { status: 409, error: 'token-limit' });
  ctx.now = NOW + 91 * 86400;
  await make(ctx, { name: 'One more' });
  const listed = (await tokens(ctx).list('u')).tokens;
  assert.equal(listed.find((t) => t.id === first.id)!.expired, true);
});

test('the bearer rule: /v1 takes an API token alone, /mcp never takes one', async () => {
  const { ctx, app, options } = setup(),
    made = await make(ctx),
    agent = await connected(ctx);
  const me = (token?: string, headers: Record<string, string> = {}) =>
    call(app, 'GET', '/v1/me', { ...(token ? { token } : {}), headers });

  const missing = await me();
  assert.equal(missing.status, 401);
  assert.equal(missing.error.code, 'token_missing');
  assert.equal(missing.response.headers.get('www-authenticate'), 'Bearer realm="Release Notes"');
  // A session cookie is never read here.
  assert.equal((await me(undefined, { cookie: 'session=whatever' })).error.code, 'token_missing');
  assert.equal((await me('rn_short')).error.code, 'token_unknown');
  assert.equal((await me('rn_' + 'A'.repeat(43))).error.code, 'token_unknown');
  // An MCP access token is not an API token.
  assert.equal((await me(agent.token)).error.code, 'token_unknown');
  // An API token opens no MCP tool, and no OAuth bearer check.
  assert.equal(await new OAuthService(ctx).bearer(made.token), null);
  const mcp = await handleMcp(
    new Request(ORIGIN + '/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + made.token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_context' } })
    }),
    options
  );
  assert.equal(mcp.status, 401);
  // /oauth/revoke never ends an API token, with or without a client id.
  for (const body of [{ token: made.token }, { token: made.token, client_id: agent.cid }])
    await publicOAuth(
      ctx,
      new Request(ORIGIN + '/oauth/revoke', {
        method: 'POST',
        body: new URLSearchParams(body as Record<string, string>)
      }),
      { viewer: '192.0.2.1:12345' }
    );
  const ok = await me(made.token);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json!.version, VERSION);
  assert.equal(ok.json!.today, TODAY);
  assert.equal(ok.response.headers.get('release-notes-version'), VERSION);
  assert.equal(ok.response.headers.get('api-version'), API_VERSION);
  assert.equal(ok.response.headers.get('cache-control'), 'no-store');
  assert.equal(ok.response.headers.get('access-control-allow-origin'), null);
  // The birthday is never sent.
  assert.ok(!ok.text.includes(PROFILE.birthday));
  assert.deepEqual(ok.json!.token, {
    id: made.id,
    name: 'Changelog',
    scopes: ['notes:write', 'activity'],
    expires_at: null
  });
  assert.equal((ok.json!.days as OAuthRow[]).length, 14);

  // Not for browsers.
  const browser = await me(made.token, { origin: 'https://elsewhere.example' });
  assert.equal(browser.status, 403);
  assert.equal(browser.error.code, 'origin_refused');
  assert.equal((await me(made.token, { origin: ORIGIN })).status, 200);

  // Expired, revoked by its client, revoked by the owner, account closing.
  const short = await make(ctx, { name: 'Short', expiry: '90d' });
  ctx.now = NOW + 90 * 86400;
  assert.equal((await me(short.token)).error.code, 'token_expired');
  ctx.now = NOW;
  const self = await make(ctx, { name: 'Self' });
  const signout = await call(app, 'DELETE', '/v1/token', { token: self.token });
  assert.equal(signout.status, 204);
  assert.equal(signout.text, '');
  assert.equal((await me(self.token)).error.code, 'token_revoked');
  const signedOut = ctx.store.memory.all().find((r) => r.kind === 'connection.removed' && r.token === 'Self')!;
  assert.equal(signedOut.reason, 'client');
  assert.equal(signedOut.token_id, self.id);
  // Settings removes it for good at the next list; it still reads revoked.
  assert.ok(!(await tokens(ctx).list('u')).tokens.some((t) => t.id === self.id));
  assert.equal((await me(self.token)).error.code, 'token_revoked');
  const owner = await make(ctx, { name: 'Owner' });
  await tokens(ctx).revoke('u', owner.id);
  assert.equal((await me(owner.token)).error.code, 'token_revoked');
  ctx.store.seed({ ...ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!, mcp_deleting: true });
  assert.equal((await me(made.token)).error.code, 'account_closing');
});

test('routes, methods and scopes', async () => {
  const { ctx, app } = setup(),
    bare = await make(ctx, { name: 'Bare', scopes: ['upcoming'] }),
    // A token always has some scope, so each route is tried with one without its own.
    other = await make(ctx, { name: 'Other', scopes: ['activity'] });
  const nothing = await call(app, 'GET', '/v1/nothing', { token: bare.token });
  assert.equal(nothing.error.code, 'not_found');
  const wrong = await call(app, 'PATCH', '/v1/notes/2026-10-13/t-1', { token: bare.token });
  assert.equal(wrong.status, 405);
  assert.equal(wrong.response.headers.get('allow'), 'GET, PUT, DELETE');
  // A good token's wrong request still says today's version; no token's does not.
  const version = (await call(app, 'GET', '/v1/me', { token: bare.token })).json!.version;
  assert.equal(nothing.response.headers.get('release-notes-version'), version);
  assert.equal(wrong.response.headers.get('release-notes-version'), version);
  const anon = await call(app, 'GET', '/v1/nothing');
  assert.equal(anon.error.code, 'not_found');
  assert.equal(anon.response.headers.get('release-notes-version'), null);
  assert.equal((await call(app, 'GET', '/v1/nothing', { token: 'rn_nope' })).status, 404);
  // Any token reads /v1/me and the tags, and can sign itself out.
  assert.equal((await call(app, 'GET', '/v1/me', { token: bare.token })).status, 200);
  assert.equal((await call(app, 'GET', '/v1/tags', { token: bare.token })).status, 200);
  for (const route of V1_ROUTES.filter((r) => r.scope)) {
    const path = route.template.replace('{date}', TODAY).replace('{id}', 't-x'),
      r = await call(app, route.method, path, {
        token: route.scope === 'upcoming' ? other.token : bare.token,
        ...(route.method === 'GET' ? {} : { body: { text: 'Hi' } })
      });
    assert.equal(r.status, 403, route.name);
    assert.equal(r.error.code, 'scope_required', route.name);
  }
  assert.equal((await call(app, 'DELETE', '/v1/token', { token: bare.token })).status, 204);
});

test('a note: create, replay, read back, append, edit, delete', async () => {
  const { ctx, app, logs } = setup(),
    made = await make(ctx);
  const created = await call(app, 'POST', '/v1/notes', {
    token: made.token,
    body: { text: '  Ran by the lake #running #Maine-2016  ' },
    headers: { 'idempotency-key': 'k-1', 'user-agent': 'Changelog/0.1 (iOS 26.1)' }
  });
  assert.equal(created.status, 201, created.text);
  const ref = noteOf(created);
  assert.match(String(ref.id), /^t-[0-9a-f]{32}$/);
  assert.deepEqual(
    { date: ref.date, version: ref.version, token: ref.token },
    { date: TODAY, version: VERSION, token: 'Changelog' }
  );
  assert.equal(typeof ref.revision, 'string');
  assert.equal(created.response.headers.get('ratelimit-limit'), String(V1_LIMITS.create));
  assert.equal(created.response.headers.get('ratelimit-remaining'), String(V1_LIMITS.create - 1));
  const stored = ctx.store.memory.read({ pk: 'USER#u', sk: `NOTE#${TODAY}#${String(ref.id)}` })!;
  assert.deepEqual(
    {
      text: stored.text,
      source: stored.source,
      token: stored.token,
      client: stored.client,
      connection: stored.connection,
      tags: stored.tags,
      author: stored.author
    },
    {
      text: 'Ran by the lake #running #Maine-2016',
      source: 'api',
      token: 'Changelog',
      client: 'Changelog',
      connection: made.id,
      tags: ['running', 'maine-2016'],
      author: undefined
    }
  );
  const added = ctx.store.memory.all().find((r) => r.kind === 'note.added')!;
  assert.deepEqual(
    { via: added.via, token: added.token, client: added.client, day: added.day, note: added.note },
    { via: 'token', token: 'Changelog', client: 'Changelog', day: TODAY, note: ref.id }
  );

  // The same key and request answers the first result again; a different
  // request under it is refused; neither makes a note.
  const again = await call(app, 'POST', '/v1/notes', {
    token: made.token,
    body: { text: '  Ran by the lake #running #Maine-2016  ' },
    headers: { 'idempotency-key': 'k-1' }
  });
  assert.equal(again.status, 201);
  assert.equal(again.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(noteOf(again), ref);
  // A replay carries no unlock line: it was said the first time.
  assert.equal(again.json!.unlocked, undefined);
  const mismatch = await call(app, 'POST', '/v1/notes', {
    token: made.token,
    body: { text: 'Something else' },
    headers: { 'idempotency-key': 'k-1' }
  });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.error.code, 'idempotency_mismatch');
  const notes = () => ctx.store.memory.all().filter((r) => String(r.sk).startsWith('NOTE#'));
  assert.equal(notes().length, 1);

  const path = `/v1/notes/${TODAY}/${String(ref.id)}`,
    read = await call(app, 'GET', path, { token: made.token });
  assert.equal(read.status, 200);
  assert.equal(read.json!.text, 'Ran by the lake #running #Maine-2016');
  assert.equal(read.json!.revision, ref.revision);

  const appended = await call(app, 'POST', path + '/append', {
    token: made.token,
    body: { text: 'Then a swim.' },
    headers: { 'idempotency-key': 'k-2' }
  });
  assert.equal(appended.status, 200, appended.text);
  assert.equal(appended.response.headers.get('ratelimit-limit'), String(V1_LIMITS.change));
  const afterAppend = noteOf(appended);
  assert.notEqual(afterAppend.revision, ref.revision);

  // An edit with no revision is a request missing a field, not a conflict.
  for (const body of [{ text: 'New words' }, { text: 'New words', revision: '' }]) {
    const bare = await call(app, 'PUT', path, { token: made.token, body });
    assert.equal(bare.status, 400, JSON.stringify(body));
    assert.deepEqual([bare.error.code, bare.error.field], ['invalid_request', 'revision']);
  }

  // An edit from a stale revision is refused with the current one.
  const stale = await call(app, 'PUT', path, {
    token: made.token,
    body: { text: 'New words', revision: ref.revision },
    headers: { 'idempotency-key': 'k-3' }
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.error.code, 'revision_mismatch');
  assert.equal(stale.error.revision, afterAppend.revision);
  const edited = await call(app, 'PUT', path, {
    token: made.token,
    body: { text: 'New words #swim', revision: afterAppend.revision },
    headers: { 'idempotency-key': 'k-4' }
  });
  assert.equal(edited.status, 200, edited.text);
  const now = ctx.store.memory.read({ pk: 'USER#u', sk: `NOTE#${TODAY}#${String(ref.id)}` })!;
  assert.equal(now.text, 'New words #swim');
  assert.deepEqual(now.tags, ['swim']);
  // A web edit meanwhile moves the revision too.
  ctx.store.seed({ ...now, text: 'Fixed on the web', updated_at: '2026-10-13T12:30:00Z' });
  const raced = await call(app, 'PUT', path, {
    token: made.token,
    body: { text: 'Mine', revision: noteOf(edited).revision },
    headers: { 'idempotency-key': 'k-5' }
  });
  assert.equal(raced.error.code, 'revision_mismatch');

  const deleted = await call(app, 'DELETE', path, { token: made.token, headers: { 'idempotency-key': 'k-6' } });
  assert.equal(deleted.status, 204, deleted.text);
  assert.equal(notes().length, 0);
  assert.equal(ctx.store.memory.all().filter((r) => r.kind === 'note.deleted').length, 1);
  const gone = await call(app, 'GET', path, { token: made.token });
  assert.equal(gone.error.code, 'not_found');
  // A replayed delete answers 204 again.
  const replayed = await call(app, 'DELETE', path, { token: made.token, headers: { 'idempotency-key': 'k-6' } });
  assert.equal(replayed.status, 204);
  assert.equal(replayed.response.headers.get('idempotent-replayed'), 'true');

  // No log line carries a token, a key or the words.
  const logged = JSON.stringify(logs);
  for (const secret of [made.token, 'Ran by the lake', 'New words', 'k-1']) assert.ok(!logged.includes(secret), secret);
});

test('a token changes and reads only its own notes', async () => {
  const { ctx, app } = setup(),
    mine = await make(ctx),
    other = await make(ctx, { name: 'Other' });
  note(ctx, 'w-web', 'Written on the web', TODAY, { source: 'web' });
  const theirs = noteOf(await call(app, 'POST', '/v1/notes', { token: other.token, body: { text: 'Theirs' } }));
  for (const [date, id] of [
    [TODAY, 'w-web'],
    [TODAY, String(theirs.id)]
  ]) {
    const path = `/v1/notes/${date}/${id}`;
    for (const [method, sub, body] of [
      ['GET', '', undefined],
      ['PUT', '', { text: 'x', revision: 'r' }],
      ['POST', '/append', { text: 'x' }],
      ['DELETE', '', undefined]
    ] as [string, string, OAuthRow | undefined][]) {
      const r = await call(app, method, path + sub, { token: mine.token, ...(body ? { body } : {}) });
      assert.equal(r.status, 403, `${method} ${id}`);
      assert.equal(r.error.code, 'not_yours');
    }
  }
  assert.equal((await call(app, 'GET', `/v1/notes/${TODAY}/t-none`, { token: mine.token })).error.code, 'not_found');
  assert.equal((await call(app, 'GET', '/v1/notes/2026-13-40/t-none', { token: mine.token })).error.code, 'not_found');
});

test('/v1/me names the account and the token by id: stable, one for the account, apart across accounts', async () => {
  const { ctx, app } = setup();
  ctx.store.seed({ ...PROFILE, pk: 'USER#v', email: 'bob@example.com' });
  const first = await make(ctx),
    second = await make(ctx, { name: 'Terminal' }),
    theirs = await make(ctx, {}, 'v'),
    me = async (t: Made) => {
      const r = await call(app, 'GET', '/v1/me', { token: t.token });
      assert.equal(r.status, 200, r.text);
      return r.json!;
    };
  const a = await me(first),
    again = await me(first),
    b = await me(second),
    c = await me(theirs);
  assert.match(String(a.account), /^acct_[0-9a-f]{32}$/);
  assert.equal(a.account, accountId('u'));
  assert.equal(again.account, a.account);
  assert.equal(b.account, a.account);
  assert.notEqual(c.account, a.account);
  assert.match(String(c.account), /^acct_[0-9a-f]{32}$/);
  // Derived, never stored: no table row holds it.
  const table = JSON.stringify(ctx.store.memory.all());
  for (const id of [a.account, c.account]) assert.ok(!table.includes(String(id).slice(5)));

  const ids = [a, again, b, c].map((m) => (m.token as OAuthRow).id);
  assert.deepEqual(ids, [first.id, first.id, second.id, theirs.id]);
  assert.equal(new Set([first.id, second.id, theirs.id]).size, 3);
  for (const [t, id] of [
    [first, first.id],
    [second, second.id]
  ] as const) {
    assert.match(id, /^[0-9a-f]{32}$/);
    // Neither the token nor its hash, nor any part of them.
    assert.ok(!t.token.includes(id) && !digest(t.token).includes(id));
  }
});

test('an Idempotency-Key holds for the account: another of its tokens gets the first answer, another account’s never', async () => {
  const { ctx, app } = setup();
  ctx.store.seed({ ...PROFILE, pk: 'USER#v', email: 'bob@example.com' });
  const old = await make(ctx),
    narrow = await make(ctx, { name: 'Reader', scopes: ['activity'] }),
    theirs = await make(ctx, {}, 'v'),
    post = (t: Made, text = 'Queued offline') =>
      call(app, 'POST', '/v1/notes', { token: t.token, body: { text }, headers: { 'idempotency-key': 'q-1' } }),
    notes = (uid: string) =>
      ctx.store.memory.all().filter((r) => r.pk === 'USER#' + uid && String(r.sk).startsWith('NOTE#'));
  const first = await post(old);
  assert.equal(first.status, 201, first.text);
  // Signed out and in again, with the same name: the queue sends the note
  // again through the new token, and it is answered, not filed twice.
  await tokens(ctx).revoke('u', old.id);
  const fresh = await make(ctx);
  assert.notEqual(fresh.id, old.id);
  const resent = await post(fresh);
  assert.equal(resent.status, 201, resent.text);
  assert.equal(resent.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(noteOf(resent), noteOf(first));
  assert.equal(notes('u').length, 1);
  // One receipt, the account's, under no token's id.
  const receipts = ctx.store.memory.all().filter((r) => String(r.sk).startsWith('CAPTURE#'));
  assert.deepEqual(
    receipts.map((r) => [r.pk, r.sk]),
    [['USER#u', 'CAPTURE#api#' + digest('q-1')]]
  );
  assert.equal(receipts[0]!.expires_at, NOW + V1_RECEIPT_SECONDS);
  // A different request under the key is refused, through any of its tokens.
  const mismatch = await post(fresh, 'Something else');
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.error.code, 'idempotency_mismatch');
  // A token without the scope is refused, not answered from the receipt.
  assert.equal((await post(narrow)).error.code, 'scope_required');
  // Another account's token with the same key files its own note.
  const other = await post(theirs);
  assert.equal(other.status, 201, other.text);
  assert.equal(other.response.headers.get('idempotent-replayed'), null);
  assert.notEqual(noteOf(other).id, noteOf(first).id);
  assert.equal(notes('v').length, 1);
  assert.equal(notes('u').length, 1);
});

test('until PER_TOKEN_RECEIPTS_UNTIL, a receipt kept under its token before 1.4.0 still answers that token', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    other = await make(ctx, { name: 'Terminal' }),
    text = 'Sent before the release',
    post = (t: Made, key: string, words = text) =>
      call(app, 'POST', '/v1/notes', { token: t.token, body: { text: words }, headers: { 'idempotency-key': key } }),
    answer = { note: { id: 't-' + 'a'.repeat(32), date: TODAY, version: VERSION, revision: '1', files: 0 } },
    // A receipt as 1.3.0 kept it, under the token's own id.
    legacy = (key: string, expires = NOW - 3600 + V1_RECEIPT_SECONDS) => ({
      pk: 'USER#u',
      sk: 'CAPTURE#' + made.id + '#' + digest(key),
      request_hash: fingerprint({ api: 'notes.create', arguments: { text } }),
      result: JSON.stringify({ status: 201, body: answer }),
      expires_at: expires
    }),
    notes = () => ctx.store.memory.all().filter((r) => String(r.sk).startsWith('NOTE#'));
  assert.ok(NOW < PER_TOKEN_RECEIPTS_UNTIL);
  ctx.store.seed(legacy('k-old'));
  const replayed = await post(made, 'k-old');
  assert.equal(replayed.status, 201, replayed.text);
  assert.equal(replayed.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(replayed.json, answer);
  assert.equal((await post(made, 'k-old', 'Other words')).error.code, 'idempotency_mismatch');
  assert.equal(notes().length, 0);

  // A write racing one by 1.3.0, whose receipt lands between the read and
  // the commit: the commit is refused and the next attempt answers from it.
  let raced = false;
  ctx.store.memory.beforeSend = (command, client) => {
    if (!raced && command.constructor.name === 'TransactWriteCommand') {
      raced = true;
      client.seed(legacy('k-race'));
    }
  };
  const race = await post(made, 'k-race');
  ctx.store.memory.beforeSend = undefined;
  assert.ok(raced);
  assert.equal(race.status, 201, race.text);
  assert.equal(race.response.headers.get('idempotent-replayed'), 'true');
  assert.deepEqual(race.json, answer);
  assert.equal(notes().length, 0);

  // It was that token's alone, as before 1.4.0: another token files anew.
  const elsewhere = await post(other, 'k-old');
  assert.equal(elsewhere.status, 201, elsewhere.text);
  assert.equal(elsewhere.response.headers.get('idempotent-replayed'), null);
  assert.equal(notes().length, 1);

  // From the cutoff the old key is read no more, even if a receipt there
  // were somehow still live.
  ctx.store.seed(legacy('k-late', PER_TOKEN_RECEIPTS_UNTIL + 86400));
  ctx.now = PER_TOKEN_RECEIPTS_UNTIL;
  const late = await post(made, 'k-late');
  assert.equal(late.status, 201, late.text);
  assert.equal(late.response.headers.get('idempotent-replayed'), null);
  assert.equal(notes().length, 2);
});

test('note fields: dates, written_at, sizes, bodies and plain text', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    post = (body: unknown, headers: Record<string, string> = {}) =>
      call(app, 'POST', '/v1/notes', { token: made.token, body, headers });

  for (const [body, code, field] of [
    [{}, 'text_required', 'text'],
    [{ text: '   ' }, 'text_required', 'text'],
    [{ text: 7 }, 'text_required', 'text'],
    [{ text: 'x'.repeat(20_001) }, 'too_large', 'text'],
    [{ text: 'Hi', date: '2026-10-14' }, 'date_out_of_range', 'date'],
    [{ text: 'Hi', date: '1981-06-13' }, 'date_out_of_range', 'date'],
    [{ text: 'Hi', date: 'yesterday' }, 'invalid_request', 'date'],
    [{ text: 'Hi', written_at: 'last night' }, 'invalid_request', 'written_at'],
    [{ text: 'Hi', written_at: '2026-10-13T12:10:00Z' }, 'invalid_request', 'written_at'],
    // Real times only: Date.parse would roll these over to another day.
    [{ text: 'Hi', written_at: '2026-02-30T10:00:00Z' }, 'invalid_request', 'written_at'],
    [{ text: 'Hi', written_at: '2026-10-12T24:00:00Z' }, 'invalid_request', 'written_at'],
    [{ text: 'Hi', written_at: '2026-10-12T10:60:00Z' }, 'invalid_request', 'written_at'],
    [{ text: 'Hi', written_at: '2026-10-12T10:00:00+24:00' }, 'invalid_request', 'written_at'],
    // Before the birthday, however far: a refusal naming written_at, never
    // a failure (year 1 is past what a zone's calendar can name).
    [{ text: 'Hi', written_at: '1981-06-13T12:00:00Z' }, 'date_out_of_range', 'written_at'],
    [{ text: 'Hi', written_at: '0001-01-01T00:00:00Z' }, 'date_out_of_range', 'written_at'],
    [{ text: 'Hi', written_at: '0000-06-01T00:00:00Z' }, 'invalid_request', 'written_at'],
    [{ text: 'Hi', mood: 'great' }, 'invalid_request', 'mood']
  ] as [OAuthRow, string, string][]) {
    const r = await post(body);
    assert.equal(r.error.code, code, JSON.stringify(body).slice(0, 80));
    if (code !== 'too_large' && code !== 'text_required') assert.equal(r.error.field, field);
  }
  assert.equal((await post('[1]', { 'content-type': 'application/json' })).error.code, 'invalid_request');
  assert.equal((await post('{', { 'content-type': 'application/json' })).error.code, 'invalid_request');
  const huge = await post('x'.repeat(V1_BODY + 1), { 'content-type': 'text/plain' });
  assert.equal(huge.status, 413);
  assert.equal(huge.error.code, 'too_large');
  const badKey = await post({ text: 'Hi' }, { 'idempotency-key': 'ü' });
  assert.equal(badKey.error.field, 'Idempotency-Key');

  // Typed offline late last night, sent this morning: last night's day.
  const late = await post({ text: 'Late', written_at: '2026-10-13T04:30:00Z' });
  assert.equal(noteOf(late).date, '2026-10-12');
  // RFC 3339 lets the T and the Z be lowercase.
  const lower = await post({ text: 'Lower', written_at: '2026-10-13t04:31:00z' });
  assert.equal(lower.status, 201, lower.text);
  assert.equal(noteOf(lower).date, '2026-10-12');
  // A minute ahead of this clock is now.
  const ahead = await post({ text: 'Ahead', written_at: '2026-10-13T12:02:00Z' });
  assert.equal(noteOf(ahead).date, TODAY);
  const kept = ctx.store.memory.read({ pk: 'USER#u', sk: `NOTE#${TODAY}#${String(noteOf(ahead).id)}` })!;
  assert.equal(kept.written_at, '2026-10-13T12:00:00Z');
  const back = await post({ text: 'Back then', date: '2026-10-01', written_at: '2026-10-13T04:30:00Z' });
  assert.equal(noteOf(back).date, '2026-10-01');
  assert.equal(noteOf(back).version, computeVersion(PROFILE.birthday, '2026-10-01').toString());

  // A terminal: a text body is the note, and the answer is one line.
  const line = await post('From the shell #cli', { 'content-type': 'text/plain', accept: 'text/plain' });
  assert.equal(line.status, 201);
  assert.match(line.text, new RegExp(`^Filed in ${VERSION.replace(/\./g, '\\.')}\\.( Unlocked: .+\\.)?\\n$`));
  assert.match(line.response.headers.get('content-type')!, /^text\/plain/);
  const refused = await call(app, 'GET', '/v1/me', { token: 'rn_nope', headers: { accept: 'text/plain' } });
  assert.equal(refused.status, 401);
  assert.match(refused.text, /^That isn't a token/);
  const meLine = await call(app, 'GET', '/v1/me', { token: made.token, headers: { accept: 'text/plain' } });
  assert.equal(meLine.text, `You're ${VERSION} today.\n`);
  // Only notes.create takes a text body.
  const plainEdit = await call(app, 'PUT', `/v1/notes/${TODAY}/${String(noteOf(ahead).id)}`, {
    token: made.token,
    body: 'words',
    headers: { 'content-type': 'text/plain' }
  });
  assert.equal(plainEdit.error.code, 'invalid_request');
});

test('odd bodies (1.7.0): forms, multipart, escaped emoji, control characters, lone surrogates', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    post = (body: unknown, headers: Record<string, string> = {}) =>
      call(app, 'POST', '/v1/notes', { token: made.token, body, headers }),
    form = { 'content-type': 'application/x-www-form-urlencoded' },
    kept = async (r: { json: OAuthRow | null; text: string }) =>
      (await ctx.store.note('u', String(noteOf(r).date), String(noteOf(r).id)))!.text;

  // A Shortcut's Form body: the fields, not the encoded string.
  const shortcut = await post('text=Had%20a%20good%20day%20%23form&date=2026-10-01', form);
  assert.equal(shortcut.status, 201, shortcut.text);
  assert.equal(noteOf(shortcut).date, '2026-10-01');
  assert.equal(await kept(shortcut), 'Had a good day #form');
  assert.equal(
    await kept(await post('text=Hi+there', { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' })),
    'Hi there'
  );
  // curl -d sends any words as a form: one that isn't a note's fields stays the words.
  assert.equal(await kept(await post('my words & more', form)), 'my words & more');
  assert.equal(await kept(await post('text=Hi&mood=great', form)), 'text=Hi&mood=great');
  assert.equal(await kept(await post('text', form)), 'text');
  assert.equal(await kept(await post('text=Hi&date', form)), 'text=Hi&date');
  const twice = await post('text=a&text=b', form);
  assert.equal(twice.error.code, 'invalid_request');
  assert.equal(twice.error.field, 'text');
  assert.equal((await post('text=', form)).error.code, 'text_required');
  for (const type of ['multipart/form-data; boundary=x', 'image/jpeg', 'audio/m4a', 'video/mp4']) {
    const refused = await post('--x\r\nContent-Disposition: form-data; name="text"\r\n\r\nhello\r\n--x--', {
      'content-type': type
    });
    assert.equal(refused.error.code, 'invalid_request', type);
    assert.equal(refused.error.field, 'Content-Type');
  }
  // Only notes.create reads a form; elsewhere a body is JSON.
  const formEdit = await call(app, 'PUT', `/v1/notes/${TODAY}/${String(noteOf(shortcut).id)}`, {
    token: made.token,
    body: 'text=x&revision=1',
    headers: form
  });
  assert.equal(formEdit.error.code, 'invalid_request');

  // The longest note, every character escaped as Python's json.dumps sends it.
  assert.ok(V1_BODY >= MAX_NOTE * 12 + 16 * 1024);
  const escape = (text: string) =>
      JSON.stringify({ text }).replace(
        /[^\x20-\x7e]/g,
        (ch) => '\\' + 'u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
      ),
    emoji = String.fromCodePoint(0x1f600).repeat(MAX_NOTE),
    escaped = escape(emoji);
  assert.ok(escaped.length > 128 * 1024 && escaped.length < V1_BODY);
  const longest = await post(escaped, { 'content-type': 'application/json' });
  assert.equal(longest.status, 201, longest.text);
  assert.equal(await kept(longest), emoji);

  // Control characters go; what text needs stays.
  const c = (...p: number[]) => String.fromCodePoint(...p),
    family = c(0x1f468, 0x200d, 0x1f469),
    odd = await post({ text: `Bell${c(7)} ESC${c(0x1b)}[31m${c(0)} ${family} ${c(0x200f)}ok\ttab` });
  assert.equal(await kept(odd), `Bell ESC[31m ${family} ${c(0x200f)}ok\ttab`);
  const plain = await post(`${c(0xfeff)}From a file${c(0x1b)}\r\n`, { 'content-type': 'text/plain' });
  assert.equal(await kept(plain), 'From a file');

  // A lone surrogate escape is half a character, refused wherever it is.
  const half = '\\' + 'ud83d';
  for (const body of [`{"text": "half ${half}"}`, `{"text": "ok", "place": {"name": "x${half}"}}`, `{"${half}": 1}`]) {
    const refused = await post(body, { 'content-type': 'application/json' });
    assert.equal(refused.error.code, 'invalid_request', body);
    assert.match(String(refused.error.message), /lone surrogate/);
  }
});

test('Accept is read in full: text only where text/plain outranks JSON', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    plain = async (accept: string) =>
      (await call(app, 'GET', '/v1/me', { token: made.token, headers: { accept } })).response.headers
        .get('content-type')!
        .startsWith('text/plain');
  for (const accept of ['text/plain', 'text/*', 'text/plain, application/json', 'application/json;q=0.5, text/plain'])
    assert.equal(await plain(accept), true, accept);
  for (const accept of [
    '',
    '*/*',
    'application/json',
    'application/json, text/plain',
    'text/plain;q=0.1, application/json',
    'text/plain;q=0, */*',
    'text/html'
  ])
    assert.equal(await plain(accept), false, accept);
});

test('the path names the note: a body naming another date or id is refused, the same one is fine', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    note = noteOf(await call(app, 'POST', '/v1/notes', { token: made.token, body: { text: 'Where it is' } })),
    path = `/v1/notes/${String(note.date)}/${String(note.id)}`,
    put = (body: OAuthRow) => call(app, 'PUT', path, { token: made.token, body: { revision: note.revision, ...body } });
  const moved = await put({ text: 'Moved?', date: '2026-10-01' });
  assert.equal(moved.status, 400);
  assert.equal(moved.error.code, 'invalid_request');
  assert.equal(moved.error.field, 'date');
  assert.equal((await put({ text: 'Another?', id: 't-other' })).error.field, 'id');
  const same = await put({ text: 'Same place', date: note.date, id: note.id });
  assert.equal(same.status, 200);
  assert.equal(noteOf(same).date, note.date);
});

test('a token earns badges in the owner voice, said once', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx);
  const first = await call(app, 'POST', '/v1/notes', {
    token: made.token,
    body: { text: 'First words' },
    headers: { 'idempotency-key': 'b-1' }
  });
  assert.ok(Array.isArray(first.json!.unlocked), first.text);
  for (const u of first.json!.unlocked as OAuthRow[]) assert.deepEqual(Object.keys(u).sort(), ['key', 'name']);
  // The first note through a token earns API release; the next earns it no more.
  assert.ok(
    (first.json!.unlocked as OAuthRow[]).some((u) => u.key === 'api'),
    first.text
  );
  const second = await call(app, 'POST', '/v1/notes', { token: made.token, body: { text: 'Second words' } });
  assert.ok(!((second.json!.unlocked ?? []) as OAuthRow[]).some((u) => u.key === 'api'), second.text);
  // With badges off there is no unlock list at all.
  ctx.store.seed({ ...ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!, badges: false });
  const off = await call(app, 'POST', '/v1/notes', { token: made.token, body: { text: 'More' } });
  assert.equal(off.json!.unlocked, undefined);
});

test('daily counts: 100 notes and 200 changes an account a UTC day, Retry-After to midnight', async () => {
  const { ctx, app } = setup(),
    a = await make(ctx),
    b = await make(ctx, { name: 'Other' });
  ctx.store.seed({ pk: 'MCPMETA#u', sk: `WRITERATE#v1-create#${Math.floor(NOW / 86400)}`, n: 99, revision: 3 });
  const last = { token: a.token, body: { text: 'Last' }, headers: { 'idempotency-key': 'r-1' } },
    landed = await call(app, 'POST', '/v1/notes', last);
  assert.equal(landed.status, 201);
  assert.equal(landed.response.headers.get('ratelimit-remaining'), '0');
  // Across every token of the account.
  const over = await call(app, 'POST', '/v1/notes', { token: b.token, body: { text: 'Over' } });
  assert.equal(over.status, 429);
  assert.equal(over.error.code, 'rate_limited');
  assert.equal(over.response.headers.get('retry-after'), String(12 * 3600));
  // A write already made still answers its retry.
  const retried = await call(app, 'POST', '/v1/notes', last);
  assert.equal(retried.status, 201);
  assert.equal(retried.response.headers.get('idempotent-replayed'), 'true');
  ctx.store.seed({ pk: 'MCPMETA#u', sk: `WRITERATE#v1-change#${Math.floor(NOW / 86400)}`, n: 200, revision: 9 });
  const pins = await call(app, 'PUT', '/v1/tags/pinned', { token: a.token, body: { pinned: ['x'] } });
  assert.equal(pins.error.code, 'rate_limited');
  // The next UTC day starts again.
  ctx.now = NOW + 12 * 3600;
  assert.equal((await call(app, 'POST', '/v1/notes', { token: b.token, body: { text: 'Tomorrow' } })).status, 201);
});

test('2,000 reads a token a UTC day', async () => {
  const { ctx, app } = setup(),
    a = await make(ctx),
    b = await make(ctx, { name: 'Other' });
  ctx.store.seed({ pk: 'MCPMETA#u', sk: `TOKENREADS#${a.id}#${Math.floor(NOW / 86400)}`, n: 2000, revision: 1 });
  const over = await call(app, 'GET', '/v1/me', { token: a.token });
  assert.equal(over.status, 429);
  assert.equal(over.response.headers.get('retry-after'), String(12 * 3600));
  assert.equal((await call(app, 'GET', '/v1/me', { token: b.token })).status, 200);
});

test('pinned tags and the recent tags row, the same on every token', async () => {
  const { ctx, app } = setup(),
    a = await make(ctx),
    b = await make(ctx, { name: 'Other', scopes: ['activity'] });
  note(ctx, 'w-1', 'Run #running #trip', '2026-10-12', { tags: ['running', 'trip'] });
  note(ctx, 'w-2', 'Run #running', '2026-10-10', { tags: ['running'] });
  note(ctx, 'w-3', 'Old #ancient', '2026-09-01', { tags: ['ancient'] });
  note(ctx, 'w-4', 'Cake #baking', '2026-10-12', { tags: ['baking'] });
  const empty = await call(app, 'GET', '/v1/tags', { token: b.token });
  assert.deepEqual(empty.json, {
    pinned: [],
    recent: [
      { tag: 'running', count: 2, last_used: '2026-10-12' },
      { tag: 'baking', count: 1, last_used: '2026-10-12' },
      { tag: 'trip', count: 1, last_used: '2026-10-12' }
    ],
    window_days: 30
  });
  const set = await call(app, 'PUT', '/v1/tags/pinned', {
    token: a.token,
    body: { pinned: ['#Trip', 'gratitude', 'trip'] },
    headers: { 'idempotency-key': 'p-1' }
  });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual(set.json!.pinned, ['trip', 'gratitude']);
  // Pinned tags leave the recent row.
  assert.deepEqual(
    (set.json!.recent as OAuthRow[]).map((r) => r.tag),
    ['running', 'baking']
  );
  assert.deepEqual(ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!.pinned_tags, ['trip', 'gratitude']);
  assert.deepEqual((await call(app, 'GET', '/v1/tags', { token: b.token })).json!.pinned, ['trip', 'gratitude']);
  const changed = ctx.store.memory.all().find((r) => r.kind === 'settings.changed')!;
  assert.equal(changed.via, 'token');
  assert.equal(changed.token, 'Changelog');
  assert.equal(changed.token_id, a.id);
  for (const pinned of [Array.from({ length: 13 }, (_, i) => 't' + i), 'trip', ['#'], [3]]) {
    const r = await call(app, 'PUT', '/v1/tags/pinned', { token: a.token, body: { pinned } });
    assert.equal(r.error.code, 'invalid_request', JSON.stringify(pinned));
    assert.equal(r.error.field, 'pinned');
  }
  // Changed on the web meanwhile: the token's write still lands on the latest.
  ctx.store.seed({ ...ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!, pinned_tags: ['web'] });
  const cleared = await call(app, 'PUT', '/v1/tags/pinned', {
    token: a.token,
    body: { pinned: [] },
    headers: { accept: 'text/plain' }
  });
  assert.equal(cleared.text, 'No pinned tags.\n');
  assert.deepEqual(ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!.pinned_tags, []);
});

test('the activity log through a token has no words in it', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx, { scopes: ['notes:write', 'activity', 'upcoming'] }),
    at = (s: number) => activityTime(NOW - s);
  // A token's row from before 1.4.0, which has no token_id.
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(400), 'note.added', 't-old'),
    kind: 'note.added',
    via: 'token',
    token: 'Changelog',
    day: '2026-10-12',
    note: 't-old'
  });
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(300), 'mail', 'm-1'),
    kind: 'mail',
    via: 'email',
    message: 'm-1',
    received_at: '2026-10-13T11:55:00Z',
    day: '2026-10-12',
    subject: 'A private subject',
    sender: 'someone@example.com',
    text: 'Private words',
    outcome: 'note'
  });
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(200), 'settings.changed', 'tz'),
    kind: 'settings.changed',
    via: 'web',
    changes: [{ field: 'city', from: 'Old Town', to: 'New Town' }]
  });
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(100), 'upcoming.added', 'up-1'),
    kind: 'upcoming.added',
    via: 'web',
    upcoming: 'up-1'
  });
  await call(app, 'POST', '/v1/notes', { token: made.token, body: { text: 'Secret words' } });
  const log = await call(app, 'GET', '/v1/activity', { token: made.token });
  assert.equal(log.status, 200, log.text);
  const items = log.json!.items as OAuthRow[];
  // Newest first.
  const order = ['note.added', 'upcoming.added', 'settings.changed', 'mail'].map((k) =>
    items.findIndex((i) => i.kind === k)
  );
  assert.ok(
    order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1]!)),
    JSON.stringify(order)
  );
  for (const secret of ['A private subject', 'someone@example.com', 'Private words', 'Old Town', 'New Town', 'Secret'])
    assert.ok(!log.text.includes(secret), secret);
  const mail = items.find((i) => i.kind === 'mail')!;
  assert.deepEqual(Object.keys(mail).sort(), ['at', 'day', 'id', 'kind', 'message', 'outcome', 'received_at', 'via']);
  assert.deepEqual(items.find((i) => i.kind === 'settings.changed')!.changes, [{ field: 'city' }]);
  assert.equal(items.find((i) => i.kind === 'note.added')!.token, 'Changelog');
  // Rows a token wrote name it by id from 1.4.0; older rows, and rows no
  // token wrote, leave the field out rather than null.
  assert.equal(items.find((i) => i.kind === 'note.added')!.token_id, made.id);
  const old = items.find((i) => i.kind === 'note.added' && i.note === 't-old')!;
  assert.equal(old.token, 'Changelog');
  assert.ok(!Object.hasOwn(old, 'token_id'));
  for (const k of ['mail', 'settings.changed', 'upcoming.added'])
    assert.ok(
      !Object.hasOwn(
        items.find((i) => i.kind === k)!,
        'token_id'
      ),
      k
    );

  // Pages by `before`, filters by kind, and refuses what it doesn't know.
  const one = await call(app, 'GET', '/v1/activity?limit=1&kinds=mail', { token: made.token });
  assert.deepEqual(
    (one.json!.items as OAuthRow[]).map((i) => i.kind),
    ['mail']
  );
  const page = await call(app, 'GET', '/v1/activity?limit=1', { token: made.token });
  assert.ok(page.json!.next);
  const next = await call(app, 'GET', `/v1/activity?limit=10&before=${encodeURIComponent(String(page.json!.next))}`, {
    token: made.token
  });
  assert.ok(!(next.json!.items as OAuthRow[]).some((i) => i.id === (page.json!.items as OAuthRow[])[0]!.id));
  for (const q of ['limit=0', 'limit=101', 'kinds=gossip', 'before=nonsense'])
    assert.equal((await call(app, 'GET', '/v1/activity?' + q, { token: made.token })).error.code, 'invalid_request', q);

  // A token's reads are one row a local day, naming it.
  const reads = ctx.store.memory.all().filter((r) => r.kind === 'reads');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.via, 'token');
  assert.equal(reads[0]!.token, 'Changelog');
  assert.equal(reads[0]!.token_id, made.id);
  const readsView = (await call(app, 'GET', '/v1/activity?kinds=reads', { token: made.token })).json!
    .items as OAuthRow[];
  assert.equal(readsView[0]!.token_id, made.id);
  assert.ok(Number(reads[0]!.calls) >= 4);
});

test('a page of the activity log can end on any row, a badge with a colon in its key too', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx, { scopes: ['activity'] }),
    at = (s: number) => activityTime(NOW - s);
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(200), 'note.added', 't-1'),
    kind: 'note.added',
    via: 'web',
    day: '2026-10-12',
    note: 't-1'
  });
  ctx.store.seed({
    pk: 'USER#u',
    sk: activityKey(at(100), 'badge.earned', 'roadmap:alpha'),
    kind: 'badge.earned',
    via: 'web',
    badge: 'roadmap',
    key: 'roadmap:alpha'
  });
  const page = await call(app, 'GET', '/v1/activity?limit=1&kinds=badge,note', { token: made.token });
  assert.equal(page.status, 200, page.text);
  const next = String(page.json!.next);
  assert.ok(next.endsWith('#badge.earned#roadmap:alpha'), next);
  const older = await call(app, 'GET', `/v1/activity?kinds=badge,note&before=${encodeURIComponent(next)}`, {
    token: made.token
  });
  assert.equal(older.status, 200, older.text);
  assert.deepEqual(
    (older.json!.items as OAuthRow[]).map((i) => i.kind),
    ['note.added']
  );
  const newer = await call(app, 'GET', `/v1/activity?after=${encodeURIComponent(next)}`, { token: made.token });
  assert.equal(newer.status, 200, newer.text);
  // Still not a way in for anything else: a space, or a part missing.
  for (const bad of [next.replace('roadmap:alpha', 'road map'), next.replace('#badge.earned', '')])
    assert.equal(
      (await call(app, 'GET', `/v1/activity?before=${encodeURIComponent(bad)}`, { token: made.token })).error.code,
      'invalid_request',
      bad
    );
});

test('deleting the account removes every token and its pointer', async () => {
  const { ctx, app } = setup(),
    made = await make(ctx),
    ended = await make(ctx, { name: 'Ended' });
  await tokens(ctx).revoke('u', ended.id);
  await call(app, 'POST', '/v1/notes', { token: made.token, body: { text: 'Hi' } });
  await new OAuthService(ctx).deleteUser('u');
  for (const t of [made, ended]) {
    assert.equal(ctx.store.memory.read({ pk: 'OAUTHACCESS#' + digest(t.token), sk: 'STATE' }), null);
    assert.equal(ctx.store.memory.read({ pk: 'OAUTHUSER#u', sk: 'ROW#OAUTHACCESS#' + digest(t.token) }), null);
  }
  assert.ok(!ctx.store.memory.all().some((r) => String(r.pk).startsWith('MCPMETA#u')));
});

test('the User-Agent names a product, never more', () => {
  assert.equal(clientProduct('Changelog/0.1 (iOS 26.1)'), 'Changelog');
  assert.equal(clientProduct('curl/8.7.1'), 'curl');
  assert.equal(clientProduct('Quinn-Android'), 'Quinn-Android');
  assert.equal(clientProduct('<script>'), null);
  assert.equal(clientProduct(''), null);
  assert.equal(clientProduct(null), null);
});
