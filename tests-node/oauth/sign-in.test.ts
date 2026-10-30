/** An app's sign-in to /v1 (docs/API.md, Phase 5), against the fictional
 * in-memory account: the consent chooses an API token, spending the code
 * makes it once, and it opens /v1 exactly as a token made in Settings does. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { OAuthError, OAuthService, publicOAuth, validRedirect, type OAuthRow } from '../../packages/backend/oauth.ts';
import { ApiError } from '../../packages/backend/sessions.ts';
import { checkToken, Tokens } from '../../packages/backend/tokens.ts';
import { fixture, consent, ORIGIN, NOW, VERIFIER } from './fixtures.ts';

const CALLBACK = 'com.yourversionnumber.changelog:/oauth',
  ALL = 'notes:write media:write upcoming activity',
  viewer = { viewer: '192.0.2.1:12345' };

async function register(ctx: ReturnType<typeof fixture>, name = 'Changelog') {
  const r = await publicOAuth(
    ctx,
    new Request(ORIGIN + '/oauth/register', {
      method: 'POST',
      body: JSON.stringify({ client_name: name, redirect_uris: [CALLBACK], grant_types: ['authorization_code'] })
    }),
    viewer
  );
  assert.equal(r.status, 201);
  return String(((await r.json()) as OAuthRow).client_id);
}
function authorizing(cid: string, scope: string | null = ALL, extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    client_id: cid,
    redirect_uri: CALLBACK,
    response_type: 'code',
    resource: ORIGIN + '/v1',
    state: 'app-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
    ...extra
  });
  if (scope != null) query.set('scope', scope);
  return new Request(ORIGIN + '/oauth/authorize?' + query);
}
async function request(ctx: ReturnType<typeof fixture>, scope: string | null = ALL, name = 'Changelog') {
  const cid = await register(ctx, name),
    r = await publicOAuth(ctx, authorizing(cid, scope), viewer);
  assert.equal(r.status, 303);
  const location = new URL(r.headers.get('location')!);
  assert.equal(location.pathname, '/connect/');
  return { cid, id: new URLSearchParams(location.hash.slice(1)).get('request')! };
}
async function approve(
  ctx: ReturnType<typeof fixture>,
  choice: OAuthRow = { name: 'Changelog', scopes: ['notes:write', 'media:write', 'upcoming', 'activity'], expiry: '1y' }
) {
  const { cid, id } = await request(ctx),
    approved = await new OAuthService(ctx).authorize('u', { request: id, approve: true, ...choice }),
    back = new URL(String(approved.redirect));
  assert.equal(back.protocol, 'com.yourversionnumber.changelog:');
  assert.equal(back.searchParams.get('state'), 'app-state');
  return {
    grant_type: 'authorization_code',
    code: back.searchParams.get('code')!,
    client_id: cid,
    resource: ORIGIN + '/v1',
    redirect_uri: CALLBACK,
    code_verifier: VERIFIER
  };
}
const oauthError = (error: string) => (e: unknown) => e instanceof OAuthError && e.error === error;
const apiError = (error: string) => (e: unknown) => e instanceof ApiError && e.error === error;
const activity = (ctx: ReturnType<typeof fixture>, kind: string) =>
  ctx.store.memory.all().filter((i) => String(i.sk).startsWith('ACTIVITY#') && i.kind === kind);

test('an app callback is its own reverse-DNS scheme, never a web or bare scheme', () => {
  for (const uri of [CALLBACK, 'com.example.app:/oauth2redirect/example-provider', 'com.example.app://callback'])
    assert.ok(validRedirect(uri), uri);
  for (const uri of [
    'myapp:/callback',
    'changelog://oauth',
    'com.example.app:callback',
    'com.example.app:/cb#fragment',
    'com.example.app:/c b',
    'com.example.app:/c\\b',
    '.example.app:/cb',
    'javascript:alert(1)//.x:/'
  ])
    assert.ok(!validRedirect(uri), uri);
});

test('discovery names /v1 as a resource with the token scopes', async () => {
  const ctx = fixture(),
    resource = (await (
      await publicOAuth(ctx, new Request(ORIGIN + '/.well-known/oauth-protected-resource/v1'), viewer)
    ).json()) as OAuthRow,
    server = (await (
      await publicOAuth(ctx, new Request(ORIGIN + '/.well-known/oauth-authorization-server'), viewer)
    ).json()) as OAuthRow;
  assert.equal(resource.resource, ORIGIN + '/v1');
  assert.deepEqual(resource.scopes_supported, ['notes:write', 'media:write', 'upcoming', 'activity']);
  assert.ok((server.scopes_supported as string[]).includes('activity'));
  assert.ok((server.scopes_supported as string[]).includes('notes:read'));
});

test('a sign-in asks only for token scopes, files only beside adding notes', async () => {
  const ctx = fixture(),
    cid = await register(ctx);
  for (const scope of ['notes:read', 'notes:write notes:read', 'media:write', 'upcoming media:write', '', 'mystery'])
    assert.equal((await publicOAuth(ctx, authorizing(cid, scope), viewer)).status, 400, scope);
  // No scope asked for is adding notes alone.
  const r = await publicOAuth(ctx, authorizing(cid, null), viewer),
    id = new URLSearchParams(new URL(r.headers.get('location')!).hash.slice(1)).get('request')!;
  assert.equal((await new OAuthService(ctx).authorize('u', { request: id })).scope, 'notes:write');
});

test("a sign-in makes one API token, the owner's choice, that opens /v1 and never MCP", async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    { id } = await request(ctx);
  const asked = await service.authorize('u', { request: id });
  assert.deepEqual(asked, { client_name: 'Changelog', scope: ALL, resource: '/v1', name: 'Changelog' });
  // Nothing is made until the code is spent.
  await service.authorize('u', {
    request: id,
    approve: true,
    name: 'Changelog',
    scopes: ['notes:write', 'activity'],
    expiry: '1y'
  });
  assert.equal(ctx.store.memory.all().filter((i) => String(i.sk).startsWith('APITOKEN#')).length, 0);
  assert.equal(activity(ctx, 'connection.added').length, 0);

  const body = await approve(ctx, {
      name: 'Changelog on my iPhone',
      scopes: ['notes:write', 'activity'],
      expiry: '1y'
    }),
    answer = await service.exchange(body);
  assert.match(String(answer.access_token), /^rn_[A-Za-z0-9_-]{43}$/);
  assert.equal(answer.token_type, 'Bearer');
  assert.equal(answer.scope, 'notes:write activity');
  assert.equal(answer.expires_in, 365 * 86400);
  assert.ok(!('refresh_token' in answer));
  const check = await checkToken(ctx.store, ORIGIN, NOW, 'Bearer ' + String(answer.access_token));
  assert.ok(check.ok);
  assert.equal(check.token.name, 'Changelog on my iPhone');
  assert.equal(check.token.client_id, body.client_id);
  assert.equal(await service.bearer(String(answer.access_token)), null);
  // Settings lists it with the others; the activity log names the app.
  const listed = await new Tokens(ctx).list('u');
  assert.deepEqual(
    listed.tokens.map((t) => [t.name, t.scopes]),
    [['Changelog on my iPhone', ['notes:write', 'activity']]]
  );
  const [added] = activity(ctx, 'connection.added');
  assert.equal(added!.token, 'Changelog on my iPhone');
  assert.equal(added!.app, 'Changelog');
  assert.equal(added!.scopes, 'notes:write activity');
  // Only its hash is kept.
  assert.ok(!JSON.stringify(ctx.store.memory.all()).includes(String(answer.access_token)));
});

test('a code is spent once: the second time ends the token it made', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    body = await approve(ctx),
    answer = await service.exchange(body);
  await assert.rejects(service.exchange(body), oauthError('invalid_grant'));
  const check = await checkToken(ctx.store, ORIGIN, NOW, 'Bearer ' + String(answer.access_token));
  assert.ok(!check.ok && check.code === 'token_revoked');
  const [removed] = activity(ctx, 'connection.removed');
  assert.equal(removed!.reason, 'token-reuse');
});

test('the code proves its client, verifier, redirect and resource, and lives five minutes', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    body = await approve(ctx);
  for (const changed of <Record<string, string>[]>[
    { client_id: 'wrong' },
    { redirect_uri: 'com.yourversionnumber.changelog:/other' },
    { code_verifier: 'w'.repeat(43) },
    { scope: 'notes:write' },
    { resource: ORIGIN + '/mcp' }
  ])
    await assert.rejects(service.exchange({ ...body, ...changed }), OAuthError, JSON.stringify(changed));
  await assert.rejects(
    service.exchange({ ...body, grant_type: 'refresh_token', refresh_token: body.code }),
    oauthError('unsupported_grant_type')
  );
  await assert.rejects(new OAuthService({ ...ctx, now: NOW + 300 }).exchange(body), oauthError('invalid_grant'));
  // None of those spent it.
  assert.ok((await service.exchange(body)).access_token);
  // An agent's code never makes a token.
  const agent = await consent(ctx);
  await assert.rejects(service.exchange({ ...agent, resource: ORIGIN + '/v1' }), oauthError('invalid_grant'));
});

test('the owner narrows what the app asked for and names its token; a taken name is refused there', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx);
  await new Tokens(ctx).make('u', { name: 'Changelog', scopes: ['notes:write'], expiry: '90d' });
  const { id } = await request(ctx, 'notes:write activity');
  assert.equal((await service.authorize('u', { request: id })).name, 'Changelog 2');
  await assert.rejects(
    service.authorize('u', { request: id, approve: true, name: 'Changelog', scopes: ['notes:write'], expiry: '1y' }),
    apiError('token-name-taken')
  );
  await assert.rejects(
    service.authorize('u', { request: id, approve: true, name: 'Phone', scopes: ['upcoming'], expiry: '1y' }),
    oauthError('invalid_scope')
  );
  await assert.rejects(
    service.authorize('u', { request: id, approve: true, name: 'Phone', scopes: ['notes:write'], expiry: 'soon' }),
    apiError('token-expiry')
  );
  // A refusal leaves the request open to try again.
  const approved = await service.authorize('u', {
    request: id,
    approve: true,
    name: 'Changelog 2',
    scopes: ['activity'],
    expiry: 'never'
  });
  assert.ok(new URL(String(approved.redirect)).searchParams.get('code'));
});

test('a never-expiring token answers no expires_in; a denial makes nothing', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    body = await approve(ctx, { name: 'Changelog', scopes: ['notes:write'], expiry: 'never' }),
    answer = await service.exchange(body);
  assert.ok(!('expires_in' in answer));
  const { id } = await request(ctx),
    denied = await service.authorize('u', { request: id, approve: false });
  assert.equal(new URL(String(denied.redirect)).searchParams.get('error'), 'access_denied');
  await assert.rejects(service.authorize('u', { request: id }), oauthError('request_expired'));
  assert.equal(ctx.store.memory.all().filter((i) => String(i.sk).startsWith('APITOKEN#')).length, 1);
});

test('an account being deleted signs no app in', async () => {
  const ctx = fixture(),
    body = await approve(ctx);
  await ctx.store.mcpBlock('u');
  await assert.rejects(new OAuthService(ctx).exchange(body), oauthError('invalid_grant'));
  assert.equal(ctx.store.memory.all().filter((i) => String(i.sk).startsWith('APITOKEN#')).length, 0);
});

test('/oauth/revoke signs the app out with its own client, and never ends a token made in Settings', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    body = await approve(ctx),
    answer = await service.exchange(body),
    made = await new Tokens(ctx).make('u', { name: 'Terminal', scopes: ['notes:write'], expiry: '1y' });
  const revoke = (token: string, client?: string) =>
    publicOAuth(
      ctx,
      new Request(ORIGIN + '/oauth/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, ...(client ? { client_id: client } : {}) }).toString()
      }),
      viewer
    );
  const live = async (token: string) => (await checkToken(ctx.store, ORIGIN, NOW, 'Bearer ' + token)).ok;
  assert.equal((await revoke(String(answer.access_token))).status, 200);
  assert.equal((await revoke(String(answer.access_token), 'someone-else')).status, 200);
  assert.ok(await live(String(answer.access_token)));
  assert.equal((await revoke(String(made.token), body.client_id)).status, 200);
  assert.ok(await live(String(made.token)));
  assert.equal((await revoke(String(answer.access_token), body.client_id)).status, 200);
  assert.ok(!(await live(String(answer.access_token))));
  const [removed] = activity(ctx, 'connection.removed');
  assert.equal(removed!.reason, 'client');
  assert.equal(removed!.via, 'token');
  // Again is still 200, and records nothing more.
  assert.equal((await revoke(String(answer.access_token), body.client_id)).status, 200);
  assert.equal(activity(ctx, 'connection.removed').length, 1);
});
