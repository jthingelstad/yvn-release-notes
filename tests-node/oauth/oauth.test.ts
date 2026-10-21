import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { OAuthError, OAuthService, publicOAuth, validRedirect } from '../../packages/backend/oauth.ts';
import { fixture, pending, consent, connected, ORIGIN, NOW } from './fixtures.ts';
test('discovery, exact safe redirects, public clients, duplicate form keys and no metadata leaks', async () => {
  const ctx = fixture(),
    r = await publicOAuth(ctx, new Request(ORIGIN + '/.well-known/oauth-protected-resource/mcp'), { viewer: '' });
  assert.equal((await r.json()).resource, ORIGIN + '/mcp');
  for (const uri of [
    'https://client.example/cb',
    'http://localhost:8989/cb',
    'http://127.0.0.1/cb',
    'http://[::1]:80/cb'
  ])
    assert.ok(validRedirect(uri), uri);
  for (const uri of [
    'javascript:alert(1)',
    'https:client.example',
    'https:/client.example',
    'http://client.example/',
    'https://name:pass@client.example/',
    'https://client.example/#fragment',
    'https://client.example:99999/',
    'https://client.example/\\bad',
    'http://127.1/cb',
    'http://2130706433/cb',
    'https://client.example/\n'
  ])
    assert.ok(!validRedirect(uri), uri);
  const duplicate = await publicOAuth(
    ctx,
    new Request(ORIGIN + '/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'resource=one&resource=two'
    }),
    { viewer: '' }
  );
  assert.equal(duplicate.status, 400);
  const privateClient = await publicOAuth(
    ctx,
    new Request(ORIGIN + '/oauth/register', {
      method: 'POST',
      body: JSON.stringify({
        redirect_uris: ['https://client.example/'],
        token_endpoint_auth_method: 'client_secret_post'
      })
    }),
    { viewer: '' }
  );
  assert.equal(privateClient.status, 400);
});
test('consent is explicit, single-use, account proved and denied pending creates no family', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    p = await pending(ctx, 'notes:read');
  assert.equal((await service.authorize('u', { request: p.id })).scope, 'notes:read');
  await assert.rejects(
    service.authorize('u', { request: p.id, approve: true, write: true }),
    (e) => e instanceof OAuthError && e.error === 'invalid_scope'
  );
  await assert.rejects(service.authorize('u', { request: p.id, approve: 1 }), OAuthError);
  const denied = await service.authorize('u', { request: p.id, approve: false });
  assert.equal(new URL(String(denied.redirect)).searchParams.get('error'), 'access_denied');
  await assert.rejects(service.authorize('u', { request: p.id, approve: true }), OAuthError);
  assert.equal(ctx.store.memory.all().filter((i) => String(i.pk).startsWith('OAUTHFAMILY#')).length, 0);
  const p2 = await pending(ctx);
  await assert.rejects(service.authorize('missing', { request: p2.id, approve: true }), OAuthError);
  const p3 = await pending(ctx);
  await assert.rejects(
    new OAuthService({ ...ctx, now: NOW + 600 }).authorize('u', { request: p3.id, approve: true }),
    OAuthError
  );
});
test('PKCE/resource/client/redirect, code single use and expiry without TTL', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx),
    body = await consent(ctx);
  for (const changed of [
    { resource: ORIGIN + '/else' },
    { client_id: 'wrong' },
    { redirect_uri: 'https://other.example/' },
    { code_verifier: 'w'.repeat(43) }
  ])
    await assert.rejects(service.exchange({ ...body, ...changed }), OAuthError);
  const token = await service.exchange(body);
  assert.ok(await service.bearer(String(token.access_token)));
  await assert.rejects(service.exchange(body), OAuthError);
  assert.equal(await new OAuthService({ ...ctx, now: NOW + 3600 }).bearer(String(token.access_token)), null);
  const expired = await consent(ctx);
  await assert.rejects(new OAuthService({ ...ctx, now: NOW + 300 }).exchange(expired), OAuthError);
  const opaque = String(token.access_token);
  assert.ok(!JSON.stringify(ctx.store.memory.all()).includes(opaque));
});
test('rotating refresh invalidates old access; used refresh revokes the family and indexes extend', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    service = new OAuthService({ ...ctx, now: NOW + 120 });
  const b = await service.exchange({
    grant_type: 'refresh_token',
    refresh_token: String(a.tokens.refresh_token),
    client_id: a.cid,
    resource: ORIGIN + '/mcp'
  });
  assert.equal(await service.bearer(a.token), null);
  assert.ok(await service.bearer(String(b.access_token)));
  const idx = await ctx.store.mcpGet('OAUTHUSER#u', 'ROW#OAUTHFAMILY#' + a.family.id);
  assert.equal(idx!.expires_at, NOW + 120 + 30 * 86400);
  await assert.rejects(
    service.exchange({
      grant_type: 'refresh_token',
      refresh_token: String(a.tokens.refresh_token),
      client_id: a.cid,
      resource: ORIGIN + '/mcp'
    }),
    OAuthError
  );
  assert.equal(await service.bearer(String(b.access_token)), null);
});
test('two concurrent refreshes have at most one result and replay revokes that result', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    body = {
      grant_type: 'refresh_token',
      refresh_token: String(a.tokens.refresh_token),
      client_id: a.cid,
      resource: ORIGIN + '/mcp'
    };
  const replies = await Promise.allSettled([
    new OAuthService(ctx).exchange(body),
    new OAuthService(ctx).exchange(body)
  ]);
  assert.equal(replies.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of replies)
    if (r.status === 'fulfilled') assert.equal(await new OAuthService(ctx).bearer(String(r.value.access_token)), null);
});
test('write removal preserves reads and refresh cannot restore scope; disconnect only owner', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    service = new OAuthService(ctx);
  await service.disconnect('someone-else', String(a.family.id));
  assert.ok(await service.bearer(a.token));
  await service.disconnect('u', String(a.family.id), true);
  assert.equal((await service.bearer(a.token))!.scope, 'notes:read media:read');
  const b = await service.exchange({
    grant_type: 'refresh_token',
    refresh_token: String(a.tokens.refresh_token),
    client_id: a.cid,
    resource: ORIGIN + '/mcp'
  });
  assert.equal(b.scope, 'notes:read media:read');
  await service.disconnect('u', String(a.family.id));
  assert.equal(await service.bearer(String(b.access_token)), null);
});
test('account deletion blocks concurrent token writes first, then purges all indexed credentials/metadata', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    service = new OAuthService(ctx);
  let blocked = false;
  ctx.store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })?.mcp_deleting)
      blocked = true;
  };
  await service.deleteUser('u');
  assert.equal(await service.bearer(a.token), null);
  const refs = ctx.store.memory.all();
  assert.equal(refs.filter((i) => /^OAUTH(?:ACCESS|REFRESH|FAMILY|CODE|USER)#|^MCPMETA#/.test(String(i.pk))).length, 0);
  assert.equal(await ctx.store.mcpCommit([[{ pk: 'MCPMETA#u', sk: 'late' }, null]], 'u'), false);
  assert.ok(blocked);
});

test('consent booleans distinguish explicit null from omitted fields, preserving legacy validation', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx);
  for (const field of ['media', 'write']) {
    const { id } = await pending(ctx);
    await assert.rejects(service.authorize('u', { request: id, approve: true, [field]: null }), OAuthError);
    assert.equal((await ctx.store.mcpGet('OAUTHPENDING#' + id))!.used, undefined);
  }
});
test('the upcoming scope is granted only when ticked, even when the client asked for reading only', async () => {
  const ctx = fixture(),
    service = new OAuthService(ctx);
  const { id } = await pending(ctx, 'notes:read media:read notes:write upcoming');
  assert.deepEqual(await service.authorize('u', { request: id }), {
    client_name: 'Assistant',
    scope: 'media:read notes:read notes:write upcoming'
  });
  const granted = await service.authorize('u', { request: id, approve: true, upcoming: true });
  const code = new URL(String(granted.redirect)).searchParams.get('code')!;
  assert.ok(code);
  const families = ctx.store.memory.all().filter((i) => String(i.pk).startsWith('OAUTHFAMILY#'));
  assert.equal(families.at(-1)!.scope, 'notes:read upcoming');
  const { id: plain } = await pending(ctx, 'notes:read');
  await service.authorize('u', { request: plain, approve: true, upcoming: true });
  assert.equal(
    ctx.store.memory
      .all()
      .filter((i) => String(i.pk).startsWith('OAUTHFAMILY#'))
      .at(-1)!.scope,
    'notes:read upcoming'
  );
  await assert.rejects(service.authorize('u', { request: plain, approve: true, write: true }), OAuthError);
  const { id: quiet } = await pending(ctx, 'notes:read media:read notes:write upcoming');
  await service.authorize('u', { request: quiet, approve: true, write: true });
  assert.equal(
    ctx.store.memory
      .all()
      .filter((i) => String(i.pk).startsWith('OAUTHFAMILY#'))
      .at(-1)!.scope,
    'notes:read notes:write'
  );
  const { id: nulled } = await pending(ctx, 'notes:read media:read notes:write upcoming');
  await assert.rejects(service.authorize('u', { request: nulled, approve: true, upcoming: null }), OAuthError);
});
test('an owner widens a live connection with the upcoming scope in place; the existing token sees it, others cannot', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    service = new OAuthService(ctx),
    fid = String(a.family.id);
  assert.equal((await service.bearer(a.token))!.scope, 'notes:read media:read notes:write');
  await assert.rejects(
    service.grant('someone-else', fid, 'upcoming'),
    (e) => e instanceof OAuthError && e.status === 404
  );
  for (const bad of ['notes:write', 'media:read', '', null, 'upcoming extra'])
    await assert.rejects(service.grant('u', fid, bad), (e) => e instanceof OAuthError && e.error === 'invalid_scope');
  assert.deepEqual(await service.grant('u', fid, 'upcoming'), {
    ok: true,
    scope: 'notes:read media:read notes:write upcoming'
  });
  assert.deepEqual(await service.grant('u', fid, 'upcoming'), {
    ok: true,
    scope: 'notes:read media:read notes:write upcoming'
  });
  assert.equal((await service.bearer(a.token))!.scope, 'notes:read media:read notes:write upcoming');
  const refreshed = await service.exchange({
    grant_type: 'refresh_token',
    refresh_token: String(a.tokens.refresh_token),
    client_id: a.cid,
    resource: ORIGIN + '/mcp'
  });
  assert.equal(refreshed.scope, 'notes:read media:read notes:write upcoming');
  await service.disconnect('u', fid, true);
  assert.equal((await service.bearer(String(refreshed.access_token)))!.scope, 'notes:read media:read upcoming');
  await service.disconnect('u', fid);
  await assert.rejects(service.grant('u', fid, 'upcoming'), (e) => e instanceof OAuthError && e.status === 404);
});
test("connections added, changed and ended are in the owner's activity log, never a token", async () => {
  const ctx = fixture(),
    log = () =>
      ctx.store.memory
        .all()
        .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#'))
        .sort((x, y) => (String(x.sk) < String(y.sk) ? -1 : 1))
        .map((i) => Object.fromEntries(Object.entries(i).filter(([k]) => !['pk', 'sk', 'at'].includes(k)))),
    a = await connected({ ...ctx, now: NOW + 1 }, true, false),
    fid = String(a.family.id);
  await new OAuthService({ ...ctx, now: NOW + 2 }).grant('u', fid, 'upcoming');
  await new OAuthService({ ...ctx, now: NOW + 3 }).disconnect('u', fid, true);
  // A used refresh token coming back ends the connection.
  const later = new OAuthService({ ...ctx, now: NOW + 4 }),
    refresh = { grant_type: 'refresh_token', refresh_token: String(a.tokens.refresh_token), client_id: a.cid };
  await later.exchange({ ...refresh, resource: ORIGIN + '/mcp' });
  await assert.rejects(
    new OAuthService({ ...ctx, now: NOW + 5 }).exchange({ ...refresh, resource: ORIGIN + '/mcp' }),
    OAuthError
  );
  const b = await connected({ ...ctx, now: NOW + 6 }, false, false);
  await new OAuthService({ ...ctx, now: NOW + 7 }).disconnect('u', String(b.family.id));
  const c = await connected({ ...ctx, now: NOW + 8 }, false, false);
  const revoked = await publicOAuth(
    { ...ctx, now: NOW + 9 },
    new Request(ORIGIN + '/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: c.token, client_id: c.cid })
    }),
    { viewer: '192.0.2.1:12345' }
  );
  assert.equal(revoked.status, 200);
  const client = a.family.client_name,
    [bid, cid] = [String(b.family.id), String(c.family.id)];
  assert.deepEqual(log(), [
    {
      kind: 'connection.added',
      via: 'web',
      scopes: 'notes:read notes:write',
      connection: fid,
      client
    },
    {
      kind: 'connection.changed',
      via: 'web',
      from: 'notes:read notes:write',
      to: 'notes:read notes:write upcoming',
      connection: fid,
      client
    },
    {
      kind: 'connection.changed',
      via: 'web',
      from: 'notes:read notes:write upcoming',
      to: 'notes:read upcoming',
      connection: fid,
      client
    },
    { kind: 'connection.removed', reason: 'token-reuse', connection: fid, client },
    { kind: 'connection.added', via: 'web', scopes: 'notes:read', connection: bid, client },
    { kind: 'connection.removed', via: 'web', reason: 'owner', connection: bid, client },
    { kind: 'connection.added', via: 'web', scopes: 'notes:read', connection: cid, client },
    { kind: 'connection.removed', reason: 'client', connection: cid, client }
  ]);
  const kept = JSON.stringify(ctx.store.memory.all().filter((i) => String(i.sk).startsWith('ACTIVITY#')));
  for (const token of [a.token, String(a.tokens.refresh_token), b.token, c.token]) assert.ok(!kept.includes(token));
  // Turning a request down connects nothing, and logs nothing.
  const { id } = await pending(ctx);
  await new OAuthService(ctx).authorize('u', { request: id, approve: false });
  assert.equal(log().length, 8);
});
