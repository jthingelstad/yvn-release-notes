/** Turnstile on the sign-in email: modes, Cloudflare's answers, the kept
 * verdict and the secret loader, with fictional tokens and no network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FakeStore } from '../../packages/testing/store.ts';
import { createApp } from '../../server/app/app.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import { createTurnstileSecret } from '../../packages/backend/aws.ts';
import * as auth from '../../packages/backend/auth.ts';
import {
  checkTurnstile,
  turnstileAllows,
  turnstileMode,
  turnstileToken,
  SITEVERIFY_URL,
  TURNSTILE_SITE_KEY,
  type TurnstileConfig
} from '../../packages/backend/turnstile.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store.ts';

const now = Date.parse('2026-10-14T12:00:00Z') / 1000;

function cloudflare(answer: Item | (() => never), status = 200) {
  const calls: URLSearchParams[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    assert.equal(url, SITEVERIFY_URL);
    calls.push(new URLSearchParams(String(init.body)));
    if (typeof answer === 'function') answer();
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}
const configured = (fetcher: typeof fetch, mode = 'observe'): TurnstileConfig => ({
  mode,
  secret: async () => 'fictional-secret',
  fetch: fetcher
});
const check = (store: FakeStore, token: string, config: TurnstileConfig, email = 'ada@example.com', at = now) =>
  checkTurnstile({ token, email, viewer: '198.51.100.1', store, now: at, config });

test('modes default to observe and only enforce refuses, and only fail or missing', () => {
  assert.equal(turnstileMode(undefined), 'observe');
  assert.equal(turnstileMode(' Enforce '), 'enforce');
  assert.equal(turnstileMode('off'), 'off');
  assert.equal(turnstileMode('strict'), 'observe');
  for (const result of ['pass', 'fail', 'missing', 'error', 'unconfigured', 'off'] as const) {
    assert.equal(turnstileAllows('observe', result), true);
    assert.equal(turnstileAllows('enforce', result), result !== 'fail' && result !== 'missing');
  }
  assert.equal(turnstileToken({ turnstile_token: ' t ' }), 't');
  assert.equal(turnstileToken({ turnstile_token: 7 }), '');
  assert.equal(turnstileToken({ turnstile_token: 'x'.repeat(3000) }).length, 2048);
  assert.match(TURNSTILE_SITE_KEY, /^0x[0-9A-Za-z]+$/);
});

test('missing, unconfigured, off and a secret that cannot be read never ask Cloudflare', async () => {
  const store = new FakeStore([]),
    cf = cloudflare({ success: true });
  assert.equal((await check(store, '', configured(cf.fetcher))).result, 'missing');
  assert.equal((await check(store, 't', { mode: 'observe', fetch: cf.fetcher })).result, 'unconfigured');
  assert.equal((await check(store, 't', { ...configured(cf.fetcher), secret: async () => '' })).result, 'unconfigured');
  assert.equal((await check(store, 't', configured(cf.fetcher, 'off'))).result, 'off');
  const failed = await check(store, 't', {
    ...configured(cf.fetcher, 'enforce'),
    secret: async () => {
      throw new Error('AccessDenied');
    }
  });
  assert.deepEqual([failed.result, failed.codes, failed.allowed], ['error', ['secret-lookup'], true]);
  assert.equal(cf.calls.length, 0);
  // Enforce: missing is refused, unconfigured goes ahead.
  assert.equal((await check(store, '', configured(cf.fetcher, 'enforce'))).allowed, false);
  assert.equal((await check(store, 't', { mode: 'enforce' })).allowed, true);
});

test('Cloudflare is asked once; the verdict serves the same address three times in five minutes', async () => {
  const store = new FakeStore([]),
    cf = cloudflare({ success: true, hostname: 'notes.yourversionnumber.com', action: 'signin' });
  const first = await check(store, 'tok-1', configured(cf.fetcher));
  assert.deepEqual(
    { result: first.result, reused: first.reused, hostname: first.hostname, action: first.action },
    { result: 'pass', reused: false, hostname: 'notes.yourversionnumber.com', action: 'signin' }
  );
  assert.equal(cf.calls.length, 1);
  assert.equal(cf.calls[0]!.get('secret'), 'fictional-secret');
  assert.equal(cf.calls[0]!.get('response'), 'tok-1');
  assert.equal(cf.calls[0]!.get('remoteip'), '198.51.100.1');
  // Only hashes are kept: no token, no address.
  const kept = await store.turnstileVerdict(auth.digest('tok-1'));
  assert.equal(kept?.email_hash, auth.digest('ada@example.com'));
  assert.ok(!JSON.stringify(kept).includes('ada@example.com') && !JSON.stringify(kept).includes('tok-1'));

  const again = await check(store, 'tok-1', configured(cf.fetcher), 'ada@example.com', now + 60);
  assert.deepEqual([again.result, again.reused], ['pass', true]);
  assert.equal((await check(store, 'tok-1', configured(cf.fetcher), 'ada@example.com', now + 120)).result, 'pass');
  const fourth = await check(store, 'tok-1', configured(cf.fetcher, 'enforce'), 'ada@example.com', now + 180);
  assert.deepEqual([fourth.result, fourth.codes, fourth.allowed], ['fail', ['token-used-up'], false]);
  assert.equal(cf.calls.length, 1);
});

test('a kept token fails for another address and once five minutes pass', async () => {
  const store = new FakeStore([]),
    cf = cloudflare({ success: true });
  await check(store, 'tok-2', configured(cf.fetcher));
  const other = await check(store, 'tok-2', configured(cf.fetcher), 'victim@example.com');
  assert.deepEqual([other.result, other.codes], ['fail', ['token-other-address']]);
  const late = await check(store, 'tok-2', configured(cf.fetcher), 'ada@example.com', now + 301);
  assert.deepEqual([late.result, late.codes], ['fail', ['token-expired']]);
  assert.equal(cf.calls.length, 1);
});

test('a rejected token is kept as a fail; an outage or a bad secret is error and goes ahead', async () => {
  const store = new FakeStore([]);
  const rejected = await check(
    store,
    'tok-3',
    configured(cloudflare({ success: false, 'error-codes': ['invalid-input-response'] }).fetcher, 'enforce')
  );
  assert.deepEqual([rejected.result, rejected.codes, rejected.allowed], ['fail', ['invalid-input-response'], false]);
  const repeat = await check(store, 'tok-3', configured(cloudflare({ success: true }).fetcher, 'enforce'));
  assert.deepEqual([repeat.result, repeat.reused], ['fail', true]);

  const outage = await check(store, 'tok-4', configured(cloudflare({}, 503).fetcher, 'enforce'));
  assert.deepEqual([outage.result, outage.codes, outage.allowed], ['error', ['http-503'], true]);
  const thrown = await check(
    store,
    'tok-5',
    configured(
      cloudflare(() => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      }).fetcher,
      'enforce'
    )
  );
  assert.deepEqual([thrown.result, thrown.codes, thrown.allowed], ['error', ['TimeoutError'], true]);
  const badSecret = await check(
    store,
    'tok-6',
    configured(cloudflare({ success: false, 'error-codes': ['invalid-input-secret'] }).fetcher, 'enforce')
  );
  assert.deepEqual([badSecret.result, badSecret.allowed], ['error', true]);
  // Errors are not kept, so the next try asks Cloudflare again.
  assert.equal(await store.turnstileVerdict(auth.digest('tok-4')), null);
});

function app(turnstile?: TurnstileConfig) {
  const store = new FakeStore([]),
    mail = new FakeMail(),
    logs: Item[] = [];
  const context = (): ApiContext => ({
    store,
    objects: new FakeObjects(),
    mail,
    invocations: new FakeInvocations(),
    origin: 'https://notes.example.com',
    now,
    from: 'notes@example.com',
    inboundDomain: 'in.example.com',
    senderFunction: 'sender',
    exportFunction: 'export',
    turnstile,
    log: (f) => logs.push(f)
  });
  const http = createApp({ context, viewer: () => '198.51.100.1' });
  const start = (value: Item) =>
    http.request('/api/auth/start', {
      method: 'POST',
      headers: { origin: 'https://notes.example.com' },
      body: JSON.stringify(value)
    });
  return { start, mail, logs, store };
}

test('every sign-in email request logs its Turnstile outcome, without the address or token', async () => {
  const unconfigured = app();
  assert.equal((await unconfigured.start({ email: 'ada@example.com' })).status, 202);
  assert.equal(unconfigured.mail.messages.length, 1);
  assert.deepEqual(
    unconfigured.logs.find((l) => l.event === 'turnstile'),
    { event: 'turnstile', result: 'missing', mode: 'observe', allowed: true, reused: false, codes: '' }
  );

  const failing = app(configured(cloudflare({ success: false, 'error-codes': ['invalid-input-response'] }).fetcher));
  assert.equal((await failing.start({ email: 'ada@example.com', turnstile_token: 'tok-secret-7' })).status, 202);
  assert.equal(failing.mail.messages.length, 1, 'observe refuses nobody');
  const line = failing.logs.find((l) => l.event === 'turnstile')!;
  assert.deepEqual([line.result, line.allowed, line.codes], ['fail', true, 'invalid-input-response']);
  assert.ok(!JSON.stringify(failing.logs).includes('ada@example.com'));
  assert.ok(!JSON.stringify(failing.logs).includes('tok-secret-7'));
});

test('enforce refuses a missing or failed token before any limit or mail, and passes the rest', async () => {
  const refused = app(configured(cloudflare({ success: false }).fetcher, 'enforce'));
  for (const body of [{ email: 'ada@example.com' }, { email: 'ada@example.com', turnstile_token: 'bad' }]) {
    const response = await refused.start(body);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'turnstile' });
  }
  assert.equal(refused.mail.messages.length, 0);
  assert.equal(await refused.store.peek('all', Math.floor(now / 3600)), 0, 'no limit spent');
  assert.equal(refused.logs.filter((l) => l.event === 'mail-limited').length, 0);

  const passing = app(configured(cloudflare({ success: true }).fetcher, 'enforce'));
  assert.equal((await passing.start({ email: 'ada@example.com', turnstile_token: 'good' })).status, 202);
  assert.equal((await passing.start({ email: 'ada@example.com', turnstile_token: 'good' })).status, 202);
  assert.equal(passing.mail.messages.length, 2, 'send it again reuses the verdict');
  // The existing limits still apply behind it.
  for (let n = 0; n < 3; n++) await passing.start({ email: 'ada@example.com', turnstile_token: `t${n}` });
  assert.equal((await passing.start({ email: 'ada@example.com', turnstile_token: 'last' })).status, 429);
});

test('the secret loader reads TURNSTILE_SECRET_KEY, retries a missing secret after five minutes, and keeps a value', async () => {
  let clock = 0,
    calls = 0,
    answer: () => unknown = () => {
      throw Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
    };
  const client = {
    send: async (command: { input: { SecretId: string } }) => {
      calls++;
      assert.equal(command.input.SecretId, 'yvn-release-notes-runtime');
      return answer();
    }
  } as never;
  const secret = createTurnstileSecret('yvn-release-notes-runtime', 'us-east-1', client, () => clock);
  assert.equal(await secret(), '');
  answer = () => ({ SecretString: JSON.stringify({ ANTHROPIC_API_KEY: 'other', TURNSTILE_SECRET_KEY: 'fictional' }) });
  clock = 299_000;
  assert.equal(await secret(), '', 'an absent secret is looked for again only after five minutes');
  clock = 300_001;
  assert.equal(await secret(), 'fictional');
  answer = () => {
    throw new Error('should not be asked again');
  };
  clock = 10 ** 9;
  assert.equal(await secret(), 'fictional');
  assert.equal(calls, 2);

  const wrongKey = createTurnstileSecret('s', 'us-east-1', {
    send: async () => ({ SecretString: '{"secret_key":"x","TURNSTILE_SECRET_KEY":""}' })
  } as never);
  assert.equal(await wrongKey(), '');
  const notJson = createTurnstileSecret('s', 'us-east-1', { send: async () => ({ SecretString: 'plain' }) } as never);
  assert.equal(await notJson(), '');
  const denied = createTurnstileSecret('s', 'us-east-1', {
    send: async () => {
      throw Object.assign(new Error('no'), { name: 'AccessDeniedException' });
    }
  } as never);
  await assert.rejects(denied(), { name: 'AccessDeniedException' });
  assert.equal(await createTurnstileSecret('')(), '');
});

test('the stack points the web function and describer at the runtime secret, and the CSP allows the challenge', async () => {
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.match(template, /RuntimeSecretName:\n\s+Type: String\n\s+Default: yvn-release-notes-runtime/);
  assert.match(template, /RUNTIME_SECRET: !Ref RuntimeSecretName/);
  assert.match(template, /SECRET: !Ref RuntimeSecretName/);
  assert.doesNotMatch(template, /SECRET: !Ref (Turnstile|Anthropic)SecretName/);
  assert.equal(template.match(/secret:\$\{RuntimeSecretName\}-\?\?\?\?\?\?/g)?.length, 2);
  assert.match(template, /TURNSTILE_MODE: !If \[HasTurnstileMode, !Ref TurnstileMode, !Ref AWS::NoValue\]/);
  assert.equal(template.match(/secret:\$\{TurnstileSecretName\}-\?\?\?\?\?\?/g)?.length, 1);
  const csp = /ContentSecurityPolicy: !Sub "([^"]+)"/.exec(template)![1]!;
  assert.match(csp, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /frame-src https:\/\/challenges\.cloudflare\.com;/);
  assert.match(csp, /style-src 'self';/);
  const devServer = await readFile(new URL('../../tools/dev-server.ts', import.meta.url), 'utf8');
  assert.match(
    devServer,
    /script-src 'self' https:\/\/challenges\.cloudflare\.com; frame-src https:\/\/challenges\.cloudflare\.com;/
  );
  const web = await readFile(new URL('../../web/src/lib/turnstile.ts', import.meta.url), 'utf8');
  assert.ok(web.includes(`'${TURNSTILE_SITE_KEY}'`), 'the page and the server name the same widget');
});
