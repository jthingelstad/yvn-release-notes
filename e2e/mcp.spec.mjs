// Whole OAuth/consent/reading/revocation flow against fictional local data.
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';

const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const callback = 'https://client.example.com/callback';

async function pending(request, baseURL) {
  const registration = await request.post('/oauth/register', { data: { client_name: 'Claude test', redirect_uris: [callback] } });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const authorization = await request.get('/oauth/authorize', { maxRedirects: 0, params: {
    client_id, redirect_uri: callback, resource: baseURL + '/mcp', response_type: 'code',
    scope: 'notes:read media:read', code_challenge: challenge, code_challenge_method: 'S256', state: 'state-from-client'
  } });
  expect(authorization.status()).toBe(303);
  return { client_id, url: authorization.headers().location };
}

async function signIn(page, request) {
  await expect(page).toHaveURL(/\/#sign-in$/);
  await page.locator('#start-form [name=email]').fill('ada@example.com');
  await page.getByRole('button', { name: 'Send me a link' }).click();
  const mail = await (await request.get('/dev-mail/?to=ada@example.com')).text();
  await page.locator('#code-form [name=code]').fill(mail.match(/type this code where you asked: (\d{6})/)[1]);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/connect\/#request=/);
}

for (const [name, viewport] of [['desktop', { width: 1400, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
  test.describe(name, () => {
    test.use({ viewport, isMobile: name === 'phone' });
    test('approve, read and disconnect', async ({ page, request, baseURL }) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const p = await pending(request, baseURL);
      let returned;
      await page.route(callback + '**', (route) => {
        returned = new URL(route.request().url());
        return route.fulfill({ contentType: 'text/html', body: '<title>Client callback</title><h1>Returned to client</h1>' });
      });
      await page.goto(p.url);
      await signIn(page, request);
      await expect(page.getByRole('heading', { name: 'Claude test wants to read your notes' })).toBeVisible();
      await expect(page.getByText('Connected as ada@example.com.', { exact: false })).toBeVisible();
      const media = page.getByRole('checkbox', { name: 'Also allow photos and recordings' });
      await expect(media).not.toBeChecked();
      await media.check();
      await mkdir('/tmp/yvn-mcp-qa', { recursive: true });
      await page.screenshot({ path: `/tmp/yvn-mcp-qa/consent-${name}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Allow reading' }).click();
      await expect(page).toHaveURL(new RegExp('^' + callback.replaceAll('.', '\\.')));
      expect(returned.searchParams.get('state')).toBe('state-from-client');
      const exchange = await request.post('/oauth/token', { form: {
        grant_type: 'authorization_code', code: returned.searchParams.get('code'), client_id: p.client_id,
        code_verifier: verifier, redirect_uri: callback, resource: baseURL + '/mcp'
      } });
      expect(exchange.status()).toBe(200);
      const { access_token } = await exchange.json();
      const read = () => request.post('/mcp', { headers: { Authorization: 'Bearer ' + access_token }, data: {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_context', arguments: {} }
      } });
      const answer = await read();
      expect(answer.status()).toBe(200);
      expect((await answer.json()).result.structuredContent.scope).toContain('media:read');
      await page.goto('/settings/');
      await expect(page.getByRole('heading', { name: 'Connected agents' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Disconnect Claude test', exact: true })).toBeVisible();
      await expect(page.getByText(/notes_context · ok/).first()).toBeVisible();
      await page.locator('#agent-connections').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/yvn-mcp-qa/settings-${name}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Disconnect Claude test', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Disconnect Claude test', exact: true })).toHaveCount(0);
      expect((await read()).status()).toBe(401);
      expect(errors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  });
}

test('cancel returns access_denied without creating a connection', async ({ page, request, baseURL }) => {
  const p = await pending(request, baseURL);
  let returned;
  await page.route(callback + '**', (route) => {
    returned = new URL(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<h1>Cancelled</h1>' });
  });
  await page.goto(p.url);
  await signIn(page, request);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(/client.example.com\/callback/);
  expect(returned.searchParams.get('error')).toBe('access_denied');
  expect(returned.searchParams.has('code')).toBe(false);
});
