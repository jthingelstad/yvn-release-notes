/** Fictional in-memory accounts; HTTP and SDK-shaped transactions only. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { FakeStore } from '../../packages/testing/store.ts';
import { OAuthService, publicOAuth, type OAuthContext, type OAuthRow } from '../../packages/backend/oauth.ts';
export const ORIGIN = 'https://notes.example.com',
  NOW = Date.parse('2026-10-13T12:00:00Z') / 1000,
  VERIFIER = 'v'.repeat(43),
  REDIRECT = 'https://client.example/callback';
export const PROFILE = {
  pk: 'USER#u',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1981-06-14',
  tz: 'America/Chicago',
  status: 'active'
};
export const fixture = () => ({ store: new FakeStore([PROFILE], 'test', 2), origin: ORIGIN, now: NOW });
export async function pending(context: OAuthContext, scope = 'notes:read media:read notes:write', name = 'Assistant') {
  const r = await publicOAuth(
    context,
    new Request(ORIGIN + '/oauth/register', {
      method: 'POST',
      body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] })
    }),
    { viewer: '192.0.2.1:12345' }
  );
  assert.equal(r.status, 201);
  const client = (await r.json()) as OAuthRow,
    cid = String(client.client_id);
  const query = new URLSearchParams({
    client_id: cid,
    redirect_uri: REDIRECT,
    response_type: 'code',
    resource: ORIGIN + '/mcp',
    scope,
    state: 'fixture-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url')
  });
  const authorization = await publicOAuth(context, new Request(ORIGIN + '/oauth/authorize?' + query), {
    viewer: '192.0.2.1:12345'
  });
  assert.equal(authorization.status, 303);
  const id = new URLSearchParams(new URL(authorization.headers.get('location')!).hash.slice(1)).get('request')!;
  return { cid, id };
}
export async function consent(context: OAuthContext, write = true, media = true, uid = 'u', upcoming = false) {
  const { cid, id } = await pending(context, 'notes:read media:read notes:write upcoming'),
    approved = await new OAuthService(context).authorize(uid, { request: id, approve: true, media, write, upcoming });
  const code = new URL(String(approved.redirect)).searchParams.get('code')!;
  return {
    grant_type: 'authorization_code',
    code,
    client_id: cid,
    resource: ORIGIN + '/mcp',
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER
  };
}
export async function connected(context: OAuthContext, write = true, media = true, uid = 'u', upcoming = false) {
  const code = await consent(context, write, media, uid, upcoming),
    tokens = await new OAuthService(context).exchange(code),
    family = await new OAuthService(context).bearer(String(tokens.access_token));
  assert.ok(family);
  return { tokens, family, cid: code.client_id, token: String(tokens.access_token) };
}
export function note(
  context: ReturnType<typeof fixture>,
  id = 'w-first',
  text = 'Café by the lake #Maine-2016',
  day = '2026-10-07',
  extra: OAuthRow = {}
) {
  const row = { pk: 'USER#u', sk: `NOTE#${day}#${id}`, text, written_at: day + 'T12:00:00Z', ...extra };
  context.store.seed(row);
  return row;
}
