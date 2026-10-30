// An app's sign-in to /v1 (docs/API.md, Phase 5), as Changelog for iPhone
// makes it, against fictional local data: it registers its own scheme, the
// owner chooses the token on the consent page, and the code is spent once
// for an API token that opens /v1.
import { test, expect } from '@playwright/test';
import { stubTurnstile } from './turnstile-stub.mjs';
import { createHash, randomBytes } from 'node:crypto';

const callback = 'com.yourversionnumber.changelog:/oauth';

// One sign-in as Ada, shared: an address gets five sign-in emails an hour.
test.describe.configure({ mode: 'serial' });
let session;
test.beforeAll(async ({ browser }) => {
  const baseURL = test.info().project.use.baseURL;
  const context = await browser.newContext({ baseURL });
  const post = (path, data) => context.request.post(path, { data, headers: { Origin: baseURL } });
  await post('/api/auth/start', { email: 'ada@example.com' });
  const mail = await (await context.request.get('/dev-mail/?to=ada@example.com')).text();
  const code = mail.match(/type this code where you asked: (\d{6})/)[1];
  expect((await post('/api/auth/verify', { email: 'ada@example.com', code })).ok()).toBeTruthy();
  session = await context.storageState();
  await context.close();
});
test.beforeEach(async ({ context }) => {
  await stubTurnstile(context);
  await context.addCookies(session.cookies);
});

// What Changelog sends, byte for byte (ChangelogKit's SignIn).
async function start(request, baseURL) {
  const verifier = randomBytes(32).toString('base64url'),
    state = randomBytes(32).toString('base64url');
  const registration = await request.post('/oauth/register', {
    data: { client_name: 'Changelog', redirect_uris: [callback], grant_types: ['authorization_code'] }
  });
  expect(registration.status()).toBe(201);
  const { client_id } = await registration.json();
  const authorization = await request.get('/oauth/authorize', {
    maxRedirects: 0,
    params: {
      response_type: 'code',
      client_id,
      redirect_uri: callback,
      scope: 'notes:write media:write upcoming activity',
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: baseURL + '/v1'
    }
  });
  expect(authorization.status()).toBe(303);
  return { client_id, verifier, state, url: authorization.headers().location };
}

// The page sends the browser to the app's own scheme, which no browser here
// opens: the answer is read from the consent call instead.
async function decide(page, button) {
  const answered = page.waitForResponse(
    (r) => r.url().endsWith('/api/mcp/authorize') && r.request().postDataJSON()?.approve !== undefined
  );
  await page.getByRole('button', { name: button, exact: true }).click();
  const r = await answered;
  expect(r.status()).toBe(200);
  return new URL((await r.json()).redirect);
}

const spend = (request, baseURL, s, code) =>
  request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      client_id: s.client_id,
      redirect_uri: callback,
      resource: baseURL + '/v1',
      code_verifier: s.verifier
    }
  });

test('Changelog signs in: the owner names the token and narrows it, and it opens /v1', async ({
  page,
  request,
  baseURL
}) => {
  const s = await start(request, baseURL);
  await page.goto(s.url);
  await expect(page.getByRole('heading', { name: 'Changelog wants to sign in' })).toBeVisible();
  for (const said of ['Add notes', 'Add files', 'Read and change your Upcoming', 'Read the activity log'])
    await expect(page.getByRole('checkbox', { name: new RegExp(said) })).toBeChecked();
  await page.getByRole('textbox', { name: 'Name' }).fill('Changelog e2e');
  await page.getByRole('checkbox', { name: /Read the activity log/ }).uncheck();
  await page.getByRole('combobox', { name: 'Expires' }).selectOption('90d');
  const back = await decide(page, 'Allow');
  expect(back.protocol).toBe('com.yourversionnumber.changelog:');
  expect(back.searchParams.get('state')).toBe(s.state);
  const exchange = await spend(request, baseURL, s, back.searchParams.get('code'));
  expect(exchange.status()).toBe(200);
  const grant = await exchange.json();
  expect(grant).toMatchObject({
    token_type: 'Bearer',
    scope: 'notes:write media:write upcoming',
    expires_in: 90 * 86400
  });
  expect(grant.access_token).toMatch(/^rn_[A-Za-z0-9_-]{43}$/);
  const me = await request.get('/v1/me', { headers: { Authorization: 'Bearer ' + grant.access_token } });
  expect(me.status()).toBe(200);
  expect((await me.json()).token).toMatchObject({
    name: 'Changelog e2e',
    scopes: ['notes:write', 'media:write', 'upcoming']
  });
  // The code is spent once: the second time ends the token it made.
  expect((await spend(request, baseURL, s, back.searchParams.get('code'))).status()).toBe(400);
  const after = await request.get('/v1/me', { headers: { Authorization: 'Bearer ' + grant.access_token } });
  expect(after.status()).toBe(401);
});

test('Cancel sends the app access_denied and makes no token', async ({ page, request, baseURL }) => {
  const s = await start(request, baseURL);
  await page.goto(s.url);
  const back = await decide(page, 'Cancel');
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe(s.state);
  expect(back.searchParams.has('code')).toBe(false);
});
