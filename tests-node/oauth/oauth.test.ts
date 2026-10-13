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
