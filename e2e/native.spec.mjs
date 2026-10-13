// Socket-level security and wire acceptance runs alongside the browser flows.
// Its runtime handshake refuses an accidentally reused Python server.
import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
async function signin(request, baseURL) {
  const email = 'native-' + randomUUID() + '@example.com',
    headers = { Origin: baseURL };
  expect((await request.post('/api/auth/start', { headers, data: { email } })).status()).toBe(202);
  const mail = await (await request.get('/dev-mail/?to=' + email)).text(),
    code = mail.match(/type this code where you asked: (\d{6})/)[1],
    answer = await request.post('/api/auth/verify', { headers, data: { email, code } });
  expect(answer.status()).toBe(200);
  const cookie = answer.headers()['set-cookie'];
  expect(cookie).toMatch(/^__Host-rn=/);
  expect(cookie).toContain('Path=/; Max-Age=1209600; Secure; HttpOnly; SameSite=Lax');
  return { Origin: baseURL, Cookie: cookie.split(';')[0] };
}
test.beforeEach(async ({ request }) =>
  expect(await (await request.get('/dev-runtime/')).json()).toEqual({ runtime: 'node24-hono', fictional: true })
);
test('native HTTP failures, cookies and every API response retain private cache/origin contracts', async ({
  request,
  baseURL
}) => {
  const signed = await signin(request, baseURL);
  expect(
    (
      await request.put('/api/me', {
        headers: signed,
        data: {
          birthday: '2000-02-29',
          send_time: '06:00',
          place: {
            name: 'Paris',
            region: 'Ile-de-France',
            country: 'France',
            tz: 'Europe/Paris',
            lat: 48.85,
            lon: 2.35
          }
        }
      })
    ).status()
  ).toBe(200);
  for (const path of [
    '/api/health',
    '/api/me',
    '/api/today',
    '/api/days',
    '/api/releases',
    '/api/tags',
    '/api/export',
    '/api/export/zip',
    '/api/unknown?q=private'
  ]) {
    const response = await request.get(path, { headers: signed });
    expect(response.headers()['cache-control']).toBe('no-store');
  }
  const evil = await request.post('/api/days/2000-02-29/notes', {
    headers: { ...signed, Origin: 'https://evil.example.com' },
    data: { text: 'Refused' }
  });
  expect(evil.status()).toBe(403);
  expect(await evil.json()).toEqual({ error: 'origin' });
  const bad = await request.post('/api/search', {
    headers: { ...signed, 'Content-Type': 'application/json' },
    data: '{invalid'
  });
  expect(bad.status()).toBe(400);
  expect(bad.headers()['cache-control']).toBe('no-store');
  const signout = await request.post('/api/auth/signout', { headers: signed, data: {} });
  expect(signout.status()).toBe(200);
  expect(signout.headers()['set-cookie']).toContain('Max-Age=0');
  expect((await request.get('/api/me', { headers: signed })).status()).toBe(401);
});
test('native OAuth/MCP uses PKCE, explicit scopes and bearer isolation from web ownership', async ({
  request,
  baseURL
}) => {
  const signed = await signin(request, baseURL);
  expect(
    (
      await request.put('/api/me', {
        headers: signed,
        data: {
          birthday: '1981-06-14',
          send_time: '06:00',
          place: {
            name: 'Paris',
            region: 'Ile-de-France',
            country: 'France',
            tz: 'Europe/Paris',
            lat: 48.85,
            lon: 2.35
          }
        }
      })
    ).status()
  ).toBe(200);
  const unauthorized = await request.post('/mcp', { data: {} });
  expect(unauthorized.status()).toBe(401);
  expect(unauthorized.headers()['www-authenticate']).toContain('/.well-known/oauth-protected-resource/mcp');
  expect(unauthorized.headers()['cache-control']).toBe('no-store');
  const callback = 'https://client.example.com/native',
    verifier = 'v'.repeat(43),
    challenge = createHash('sha256').update(verifier).digest('base64url'),
    registration = await request.post('/oauth/register', {
      data: { client_name: 'Native acceptance', redirect_uris: [callback] }
    });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const authorization = await request.get('/oauth/authorize', {
    maxRedirects: 0,
    params: {
      client_id,
      redirect_uri: callback,
      resource: baseURL + '/mcp',
      response_type: 'code',
      scope: 'notes:read notes:write',
      code_challenge: challenge,
      code_challenge_method: 'S256'
    }
  });
  expect(authorization.status()).toBe(303);
  const pending = new URL(authorization.headers().location).hash.split('=')[1];
  const consent = await request.post('/api/mcp/authorize', {
    headers: signed,
    data: { request: pending, approve: true, write: false }
  });
  expect(consent.status()).toBe(200);
  const code = new URL((await consent.json()).redirect).searchParams.get('code');
  const invalid = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      client_id,
      code_verifier: 'wrong',
      redirect_uri: callback,
      resource: baseURL + '/mcp'
    }
  });
  expect(invalid.status()).toBe(400);
  expect(invalid.headers()['cache-control']).toBe('no-store');
  const exchanged = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      client_id,
      code_verifier: verifier,
      redirect_uri: callback,
      resource: baseURL + '/mcp'
    }
  });
  expect(exchanged.status()).toBe(200);
  const { access_token, scope } = await exchanged.json();
  expect(scope).toBe('notes:read');
  const headers = { Authorization: 'Bearer ' + access_token },
    context = await request.post('/mcp', {
      headers,
      data: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_context', arguments: {} } }
    });
  expect(context.status()).toBe(200);
  expect(context.headers()['cache-control']).toBe('no-store');
  expect((await context.json()).result.structuredContent.scope).toBe('notes:read');
  // A fresh request context carries only the bearer, with no email session cookie.
  // supplying an empty Cookie header prevents its existing cookie jar from authenticating.
  expect((await request.get('/api/me', { headers: { ...headers, Cookie: '' } })).status()).toBe(401);
  const refused = await request.post('/mcp', {
    headers,
    data: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'notes_create', arguments: { text: 'Should not write', idempotency_key: 'native-refused' } }
    }
  });
  expect((await refused.json()).result.structuredContent.error).toBe('scope_required');
  expect(
    (await request.post('/mcp', { headers: { ...headers, Origin: 'https://evil.example.com' }, data: {} })).status()
  ).toBe(403);
  const families = await (await request.get('/api/mcp/connections', { headers: signed })).json();
  expect(
    (await request.delete('/api/mcp/connections/' + families.connections[0].id, { headers: signed })).status()
  ).toBe(200);
  expect((await request.post('/mcp', { headers, data: {} })).status()).toBe(401);
});
