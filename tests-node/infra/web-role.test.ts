/** The web app's role grants what every route and the OAuth endpoints
 * request: sign-in mail with the Turnstile secret and verdicts, sign-up and
 * its first-email invoke, settings with a restart's unsuppress, notes with
 * uploads signed, checked and copied, media links, places (a device's spot
 * named) and weather, the Map page's base map,
 * Upcoming and the calendar feed, pauses, exports (the zip invoke, its link and
 * a replaced build's delete), MCP connections, the admin scan and product
 * updates, and both account-deletion cascades (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { createApp, ROUTES } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import type { ApiContext } from '../../packages/backend/sessions.ts';
import type { Item } from '../../packages/backend/store-types.ts';
import { createTurnstileSecret } from '../../packages/backend/aws.ts';
import * as auth from '../../packages/backend/auth.ts';
import * as media from '../../packages/backend/media.ts';
import { zipKey } from '../../workers/export.ts';
import { nameSpot } from '../../packages/backend/places.ts';
import { geoMaps } from '../../packages/backend/maps.ts';
import { REDIRECT, VERIFIER } from '../oauth/fixtures.ts';
import { createHash } from 'node:crypto';
import { Recorder, REGION, ACCOUNT, STACK } from './grants.ts';

const origin = 'https://notes.example.com',
  now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  day = '2026-10-13',
  city = { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
  forecast = {
    daily: {
      time: ['2026-10-12', day],
      temperature_2m_max: [20, 18],
      temperature_2m_min: [10, 8],
      weather_code: [2, 3]
    }
  },
  pdf = Buffer.from('%PDF-1.4 synthetic');
const person = (id: string, email: string, extra: Item = {}): Item[] => [
  {
    pk: `USER#${id}`,
    sk: 'PROFILE',
    email,
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active',
    send_time: '06:00',
    city: 'Minneapolis',
    country: 'United States',
    lat: 44.98,
    lon: -93.26,
    ...extra
  },
  { pk: `EMAIL#${email}`, sk: 'EMAIL', user_id: id }
];

test('the web role grants every request each route and the OAuth endpoints make', async () => {
  const aws = new Recorder('NativeAppRevision'),
    store = new FakeStore(person('u', 'ada@example.com', { stopped_reason: 'bounce', status: 'stopped' }), 'T', 2),
    files = new FakeObjects(),
    mail = new FakeMail(),
    invocations = new FakeInvocations(),
    // The real Turnstile secret adapter, over a client that records the
    // command as IAM authorizes it. The secret is a made-up string.
    secrets = {
      async send(command: { input: { SecretId: string } }) {
        aws.add(
          'turnstile secret',
          'secretsmanager:GetSecretValue',
          `arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${command.input.SecretId}-AbCdEf`
        );
        return { SecretString: JSON.stringify({ TURNSTILE_SECRET_KEY: 'synthetic' }) };
      }
    },
    ctx: ApiContext = {
      store: aws.watch(store),
      objects: aws.objects(files),
      mail: aws.mail(mail),
      invocations: aws.invocations(invocations),
      origin,
      now,
      from: aws.env.FROM_ADDRESS!,
      inboundDomain: aws.env.INBOUND_DOMAIN!,
      senderFunction: aws.env.SENDER_FUNCTION!,
      exportFunction: aws.env.EXPORT_FUNCTION!,
      adminUserId: 'u',
      geocode: async () => [city],
      // Naming a device's spot, the real adapter as IAM authorizes it.
      nameSpot: (spot) =>
        nameSpot(spot, {
          async send() {
            aws.add('places.nameSpot', 'geo-places:ReverseGeocode', `arn:aws:geo-places:${REGION}::provider/default`);
            return {
              ResultItems: [
                {
                  Address: {
                    Locality: 'Paris',
                    Region: { Name: 'Ile-de-France' },
                    Country: { Code2: 'FR', Name: 'France' }
                  }
                }
              ]
            };
          }
        } as never),
      // The Map page's base map, the real adapter as IAM authorizes it.
      maps: geoMaps({
        async send(command: { constructor: { name: string } }) {
          const name = command.constructor.name.replace(/Command$/, '');
          aws.add('maps.geoMaps', `geo-maps:${name}`, `arn:aws:geo-maps:${REGION}::provider/default`);
          return {
            Blob: new TextEncoder().encode(
              name === 'GetStyleDescriptor' ? JSON.stringify({ version: 8, sources: {}, layers: [] }) : 'synthetic'
            )
          };
        }
      } as never),
      fetchTitle: () => null,
      weatherFetch: async () => forecast,
      turnstile: {
        mode: 'observe',
        secret: createTurnstileSecret(aws.env.RUNTIME_SECRET!, REGION, secrets as never),
        fetch: async () => new Response(JSON.stringify({ success: true, hostname: 'notes.example.com' }))
      },
      log: () => undefined
    },
    app = createApp({ context: () => ctx, viewer: () => '192.0.2.1' }),
    hit: [string, string][] = [];
  let cookie = '';
  const call = async (method: string, path: string, value?: unknown, expect = 200) => {
    hit.push([method, new URL(origin + path).pathname]);
    const headers: Record<string, string> = { origin };
    if (cookie) headers.cookie = auth.COOKIE + '=' + cookie;
    if (value !== undefined) headers['content-type'] = 'application/json';
    const r = await app.request(path, {
        method,
        headers,
        ...(value !== undefined ? { body: JSON.stringify(value) } : {})
      }),
      b = r.headers.get('content-type')?.includes('application/json') ? ((await r.json()) as Item) : {};
    assert.equal(r.status, expect, `${method} ${path}: ${JSON.stringify(b)}`);
    const set = /__Host-rn=([^;]*)/.exec(r.headers.get('set-cookie') ?? '');
    if (set) cookie = set[1]!;
    return { r, b };
  };
  const form = async (path: string, fields: Record<string, string>) =>
      (await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields)
      })) as Response,
    lastMail = async () => (await simpleParser(mail.messages.at(-1)!.raw)).text ?? '',
    code = async () => /\b(\d{3} ?\d{3})\b/.exec(await lastMail())![1]!.replace(' ', '');
  // The browser posts the signed form; the bytes land pending.
  const upload = async () => {
    const { b } = await call('POST', '/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: pdf.length });
    await files.put(media.uploadKey(currentUser, String(b.upload), 'application/pdf'), pdf, {
      type: 'application/pdf',
      tags: { outcome: 'pending' }
    });
    return { upload: String(b.upload), type: 'application/pdf', name: 'a.pdf' };
  };
  let currentUser = 'u';

  // Signing in by link, with a Turnstile token checked once and reused.
  await call('GET', '/api/health');
  await call('GET', '/api/sample?birthday=1981-06-14');
  await call('POST', '/api/auth/start', { email: 'ada@example.com', turnstile_token: 't'.repeat(40) }, 202);
  const link = /#t=([A-Za-z0-9_-]{43})/.exec(await lastMail())![1]!;
  await call('POST', '/api/auth/verify', { token: link });
  await call('GET', '/api/me');
  // A bounced account restarts: its address leaves the suppression list.
  await call('PUT', '/api/me', { status: 'active', send_time: '07:00', place: city, transcribe: true, describe: true });
  assert.equal(aws.requests.filter((r) => r.action === 'ses:DeleteSuppressedDestination').length, 1);
  await call('POST', '/api/me/inbox', {});
  await call('GET', '/api/places?q=Paris');
  const here = (await call('POST', '/api/places/here', { lat: 48.856613, lon: 2.352222, accuracy_m: 12 })).b;
  await call('GET', '/api/activity');

  // Notes, files and places.
  const first = (await call('POST', `/api/days/${day}/notes`, { text: 'Lake day #made', place: city }, 201)).b,
    id = String(first.id);
  const withFile = (await call('POST', `/api/days/${day}/notes`, { text: 'A file', uploads: [await upload()] }, 201)).b;
  await call('POST', `/api/days/${day}/notes/${id}/media`, { uploads: [await upload()] });
  // An upload that never arrived reads as missing and is refused as one.
  const unsent = (await call('POST', '/api/uploads', { name: 'a.pdf', type: 'application/pdf', size: pdf.length })).b;
  await call(
    'POST',
    `/api/days/${day}/notes/${id}/media`,
    { uploads: [{ upload: String(unsent.upload), type: 'application/pdf', name: 'a.pdf' }] },
    400
  );
  await call('GET', `/api/days/${day}/notes/${id}/media/1`, undefined, 302);
  await call('PUT', `/api/days/${day}/notes/${id}`, { text: 'Lake day, edited #made' });
  await call('PUT', `/api/days/${day}/notes/${id}/place`, { place: here });
  await call('DELETE', `/api/days/${day}/notes/${id}/place`);
  await call('PUT', `/api/days/${day}/place`, { place: city });
  await call('DELETE', `/api/days/${day}/place`);
  for (const path of [
    '/api/today',
    '/api/days',
    `/api/days/${day}`,
    '/api/releases',
    '/api/releases/4.5',
    '/api/badges',
    '/api/tags',
    '/api/tags/made',
    '/api/map/notes',
    '/api/map/style/Light',
    '/api/map/tiles/3/2/2',
    '/api/map/glyphs/Amazon%20Ember%20Regular,Noto%20Sans%20Regular/0-255.pbf',
    '/api/map/sprites/Dark/sprites@2x.png'
  ])
    await call('GET', path);
  await call('POST', '/api/search', { q: 'lake' });

  // Upcoming and its calendar feed.
  const birthday = { kind: 'birthday', title: 'Alex', date: '10-20', year: 1976 },
    saved = (await call('POST', '/api/upcoming', birthday, 201)).b;
  await call('GET', '/api/upcoming');
  await call('POST', '/api/upcoming/batch', { add: [{ ...birthday, title: 'Sam' }] });
  await call('PUT', `/api/upcoming/${saved.id}`, { ...birthday, title: 'Alexa', revision: saved.revision });
  await call('DELETE', `/api/upcoming/${saved.id}`, { revision: Number(saved.revision) + 1 });
  const feed = String((await call('POST', '/api/calendar')).b.calendar);
  await call('GET', new URL(feed).pathname);
  await call('DELETE', '/api/calendar');

  await call('PUT', '/api/pause', { days: 3 });
  await call('DELETE', '/api/pause');

  // Exports: the zip build is invoked; a ready one is linked, then replaced.
  await call('GET', '/api/export');
  await call('GET', '/api/export?format=md');
  await call('POST', '/api/export/zip', {}, 202);
  const build = String(store.memory.read({ pk: 'USER#u', sk: 'EXPORT' })!.id);
  await aws.aside(store, null, async () => {
    await store.finishExportGuarded('u', build, {
      status: 'ready',
      finished_at: now,
      export_key: zipKey('u', build),
      size: 3,
      files: 0,
      expires_at: now + 86400
    });
  });
  await files.put(zipKey('u', build), Buffer.from('zip'), { type: 'application/zip' });
  await call('GET', '/api/export/zip');
  await call('GET', '/api/export/zip/file', undefined, 302);
  await call('POST', '/api/export/zip', {}, 202);
  assert.ok(files.calls.some((c) => c.operation === 'remove' && c.key === zipKey('u', build)));

  // An MCP connection, made through the public OAuth endpoints and managed here.
  const registered = (await (
    await app.request('/oauth/register', {
      method: 'POST',
      body: JSON.stringify({ client_name: 'Assistant', redirect_uris: [REDIRECT] })
    })
  ).json()) as Item;
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp'])
    assert.equal((await app.request(path)).status, 200, path);
  const query = new URLSearchParams({
      client_id: String(registered.client_id),
      redirect_uri: REDIRECT,
      response_type: 'code',
      resource: origin + '/mcp',
      scope: 'notes:read media:read notes:write',
      state: 'fixture-state',
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(VERIFIER).digest('base64url')
    }),
    pending = (await app.request('/oauth/authorize?' + query)).headers.get('location')!,
    request = new URLSearchParams(new URL(pending).hash.slice(1)).get('request')!,
    approved = (await call('POST', '/api/mcp/authorize', { request, approve: true, media: true, write: true })).b,
    exchange = {
      grant_type: 'authorization_code',
      code: new URL(String(approved.redirect)).searchParams.get('code')!,
      client_id: String(registered.client_id),
      resource: origin + '/mcp',
      redirect_uri: REDIRECT,
      code_verifier: VERIFIER
    },
    tokens = (await (await form('/oauth/token', exchange)).json()) as Item,
    refreshed = (await (
      await form('/oauth/token', {
        grant_type: 'refresh_token',
        refresh_token: String(tokens.refresh_token),
        client_id: exchange.client_id,
        resource: exchange.resource
      })
    ).json()) as Item;
  assert.ok(refreshed.access_token, JSON.stringify(refreshed));
  const connection = String(((await call('GET', '/api/mcp/connections')).b.connections as Item[])[0]!.id);
  await call('POST', `/api/mcp/connections/${connection}/scope`, { scope: 'upcoming' });
  await call('GET', '/api/mcp/activity');
  await call('DELETE', `/api/mcp/connections/${connection}?write_only=true`);
  assert.equal(
    (await form('/oauth/revoke', { token: String(refreshed.access_token), client_id: exchange.client_id })).status,
    200
  );
  await call('DELETE', `/api/mcp/connections/${connection}`);

  // Admin: the subscriber scan and product updates.
  await call('GET', '/api/admin/users');
  const update = (await call('POST', '/api/admin/updates', { title: 'A change', text: 'Words' }, 201)).b;
  await call('GET', '/api/admin/updates');
  await call('PUT', `/api/admin/updates/${update.id}`, { revision: 1, title: 'Edited', text: 'Words' });
  await call('POST', `/api/admin/updates/${update.id}/schedule`, { revision: 2, date: '2026-10-14' });
  await call('DELETE', `/api/admin/updates/${update.id}/schedule`, { revision: 3 });
  await call('DELETE', `/api/admin/updates/${update.id}`, { revision: 4 });

  await call('DELETE', `/api/days/${day}/notes/${withFile.id}`);
  // An emailed note takes its raw message with it.
  store.seed({
    pk: 'USER#u',
    sk: 'NOTE#2026-10-12#mail',
    text: 'By email',
    source: 'email',
    raw_key: 'raw/mail',
    written_at: '2026-10-12T12:00:00Z'
  });
  await call('DELETE', '/api/days/2026-10-12/notes/mail');
  assert.ok(files.calls.some((c) => c.operation === 'remove' && c.key === 'raw/mail'));
  await call('POST', '/api/auth/signout', {});

  // A new address signs up by code, then deletes the account with its files.
  currentUser = '';
  await call('POST', '/api/auth/start', { email: 'bea@example.com', turnstile_token: 't'.repeat(40) }, 202);
  await call('POST', '/api/auth/verify', { email: 'bea@example.com', code: await code() });
  const joined = await call('PUT', '/api/me', { birthday: '1990-01-02', send_time: '06:00', place: city });
  assert.ok(invocations.calls.some((c) => c.name === aws.env.SENDER_FUNCTION));
  currentUser = String(store.memory.read({ pk: 'EMAIL#bea@example.com', sk: 'EMAIL' })!.user_id);
  assert.ok(joined.b);
  await call('POST', `/api/days/${day}/notes`, { text: 'Mine', uploads: [await upload()] }, 201);
  // The reply address from the first email, and its unsubscribe link.
  const token = 'a'.repeat(24);
  await aws.aside(store, null, async () =>
    store.seed({ pk: `TOKEN#${token}`, sk: 'TOKEN', user_id: currentUser, date: day, version: '4.4.300' })
  );
  await call('GET', `/api/unsubscribe?t=${token}`, undefined, 302);
  await call('POST', `/api/unsubscribe?t=${token}`, {});
  await call('POST', '/api/me/delete-code', {}, 202);
  await call('DELETE', '/api/me', { code: await code() });
  assert.equal(store.memory.all().filter((i) => i.pk === `USER#${currentUser}`).length, 0);

  // Every route was called.
  const unseen = ROUTES.filter(
    ([method, path]) =>
      !hit.some(([m, p]) => m === method && new RegExp(`^${path.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(p))
  );
  assert.deepEqual(unseen, []);
  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    'secretsmanager:GetSecretValue',
    'ses:SendRawEmail',
    'ses:DeleteSuppressedDestination',
    'lambda:InvokeFunction',
    's3:PutObject',
    's3:PutObjectTagging',
    's3:GetObjectVersionTagging',
    's3:GetObjectVersion',
    's3:DeleteObjectVersion',
    's3:ListBucket',
    'dynamodb:Scan',
    'dynamodb:BatchWriteItem',
    'geo-places:ReverseGeocode',
    'geo-maps:GetTile'
  ])
    assert.ok(actions.has(action), action);
  // Attachment checks read the tags of the exact version uploaded, so plain
  // GetObjectTagging is never used; the .local log group is not modelled.
  assert.deepEqual(aws.unused(), [
    `s3:GetObjectTagging arn:aws:s3:::${aws.env.MAIL_BUCKET}/media/*/web/*`,
    `logs:CreateLogStream arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-web-native.local:*`,
    `logs:PutLogEvents arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-web-native.local:*`
  ]);
});
