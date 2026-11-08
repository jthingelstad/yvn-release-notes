/** The MCP server's role grants what every tool requests: the bearer check,
 * the quota, each read tool, photo and recording bytes and signed links, and
 * the capture invocation for writes (whose own requests are the capture
 * role's, held to it as well) (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpApp, handleMcp, type McpOptions } from '../../server/mcp/app.ts';
import type { MediaReader } from '../../server/mcp/reader.ts';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected, note, ORIGIN } from '../oauth/fixtures.ts';
import { Recorder, functionArn, REGION, ACCOUNT, STACK } from './grants.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import * as places from '../../packages/backend/places.ts';
import { V1_ROUTES } from '../../server/mcp/v1.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { png } from '../../packages/testing/images.ts';

test('the MCP role grants every request each tool makes', async () => {
  const aws = new Recorder('NativeMcpRevision'),
    capture = new Recorder('CaptureFunction'),
    ctx = fixture(),
    // Connecting is the web app's OAuth, under its own role.
    a = await connected(ctx, true, true, 'u', true),
    bucket = `arn:aws:s3:::${aws.env.MAIL_BUCKET}`,
    // As server/mcp/index.ts: a signed GetObject link, or a ranged GetObject.
    media: MediaReader = {
      async download(uid, key) {
        assert.ok(key.startsWith(`media/${uid}/`));
        aws.add('media.download', 's3:GetObject', `${bucket}/${key}`);
        return 'https://private.example/signed';
      },
      async bytes(uid, key) {
        assert.ok(key.startsWith(`media/${uid}/`));
        aws.add('media.bytes', 's3:GetObject', `${bucket}/${key}`);
        return Buffer.from('fixture');
      }
    },
    options: McpOptions = {
      context: () => ({ ...ctx, media, geocode: async () => [] }),
      capture: (event) => {
        aws.add('capture', 'lambda:InvokeFunction', functionArn(aws.env.CAPTURE_FUNCTION!));
        return aws.aside(ctx.store, capture, () => captureNote(event, ctx, { fetchTitle: () => null }));
      },
      log: () => undefined
    },
    call = async (name: string, args: OAuthRow = {}) => {
      const response = await handleMcp(
          new Request(ORIGIN + '/mcp', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
          }),
          options
        ),
        body = (await response.json()) as { result: { structuredContent: OAuthRow; isError?: boolean } };
      assert.ok(!body.result.isError, `${name}: ${JSON.stringify(body.result.structuredContent)}`);
      return body.result.structuredContent;
    };
  note(ctx, 'media', 'Files #made', '2026-10-07', {
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u/original', thumb: { key: 'media/u/thumb' }, size: 7 },
      { n: 2, kind: 'audio', type: 'audio/mp4', key: 'media/u/audio', transcript: 'Words', size: 7 }
    ]
  });
  aws.watch(ctx.store);

  await call('notes_context');
  await call('notes_list');
  await call('notes_search', { q: 'Files' });
  await call('notes_get_day', { date: '2026-10-07' });
  await call('notes_get_note', { date: '2026-10-07', id: 'media' });
  await call('notes_tags');
  await call('notes_map');
  await call('notes_check_ins');
  await call('notes_find_place', { q: 'Paris' });
  await call('notes_view_photo', { date: '2026-10-07', id: 'media', n: 1 });
  await call('notes_view_photo', { date: '2026-10-07', id: 'media', n: 1, original: true });
  await call('notes_get_audio', { date: '2026-10-07', id: 'media', n: 2, inline: true });
  await call('notes_get_audio', { date: '2026-10-07', id: 'media', n: 2 });
  const created = (await call('notes_create', { date: '2026-10-08', text: 'Dinner', idempotency_key: 'c' }))
    .note as OAuthRow;
  await call('notes_append', { date: '2026-10-08', id: created.id, text: 'Walk', idempotency_key: 'a' });
  const entry = { kind: 'anniversary', title: 'Work', date: '01-06', year: 2020, reminders: [7, 1, 0] },
    saved = ((await call('upcoming_save', { entries: [entry], idempotency_key: 's' })).saved as OAuthRow[])[0]!;
  await call('upcoming_list');
  await call('upcoming_delete', { entries: [{ id: saved.id, revision: saved.revision }], idempotency_key: 'r' });

  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    'dynamodb:GetItem',
    'dynamodb:Query',
    'dynamodb:PutItem',
    's3:GetObject',
    'lambda:InvokeFunction'
  ])
    assert.ok(actions.has(action), action);
  for (const via of ['media.bytes', 'media.download', 'capture'])
    assert.ok(
      made.some((r) => r.via === via),
      via
    );
  assert.ok(capture.granted().some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  // The web function platform's .local log group is not modelled here.
  assert.deepEqual(aws.unused(), [
    `logs:CreateLogStream arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-mcp-native.local:*`,
    `logs:PutLogEvents arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda-web/${STACK}-mcp-native.local:*`
  ]);
});

/** `/v1` (server/mcp/v1.ts) under the same role: the token check, the read
 * count, each read route, and every write handed to the capture function,
 * whose own requests are held to the capture role. Every route is called. */
test('the MCP and capture roles grant every request /v1 makes', async () => {
  let calls = 0;
  const aws = new Recorder('NativeMcpRevision'),
    capture = new Recorder('CaptureFunction'),
    ctx = {
      ...fixture(),
      objects: new FakeObjects(),
      // The city search is Open-Meteo, over the internet, with no grant.
      geocode: async () => [
        { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 }
      ],
      // As server/mcp/index.ts: a signed GetObject link.
      media: {
        async download(uid: string, key: string) {
          assert.ok(key.startsWith(`media/${uid}/`));
          aws.add('media.download', 's3:GetObject', `arn:aws:s3:::${aws.env.MAIL_BUCKET}/${key}`);
          return 'https://private.example/signed';
        },
        async bytes() {
          return Buffer.from('fixture');
        }
      }
    },
    // Tokens are made on the web, under its own role.
    made = (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
      name: 'Changelog',
      scopes: ['notes:write', 'media:write', 'notes:read', 'notes:all', 'upcoming', 'activity'],
      expiry: 'never'
    })) as OAuthRow & { token: string },
    // Here's naming, the real adapter as IAM authorizes it, in capture.
    nameSpot = (spot: { lat: number; lon: number }) =>
      places.nameSpot(spot, {
        async send() {
          capture.add('places.nameSpot', 'geo-places:ReverseGeocode', `arn:aws:geo-places:${REGION}::provider/default`);
          return { ResultItems: [{ Address: { Locality: 'Paris', Country: { Code2: 'FR', Name: 'France' } } }] };
        }
      } as never),
    options: McpOptions = {
      context: () => ctx,
      capture: (event) => {
        aws.add('capture', 'lambda:InvokeFunction', functionArn(aws.env.CAPTURE_FUNCTION!));
        return aws.aside(ctx.store, capture, () =>
          captureNote(event, { ...ctx, objects: capture.objects(ctx.objects), nameSpot }, { fetchTitle: () => null })
        );
      },
      log: () => undefined
    },
    app = createMcpApp(options),
    called = new Set<string>(),
    v1 = async (method: string, path: string, body?: OAuthRow, status = 200) => {
      const route = V1_ROUTES.find((r) => r.method === method && r.path.test(new URL(ORIGIN + path).pathname));
      if (route) called.add(route.name);
      const response = await app.request(ORIGIN + path, {
        method,
        headers: {
          authorization: 'Bearer ' + made.token,
          'content-type': 'application/json',
          'idempotency-key': `${method} ${path} ${++calls}`
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      const text = await response.text();
      assert.equal(response.status, status, `${method} ${path}: ${text}`);
      return text ? (JSON.parse(text) as OAuthRow) : {};
    };
  aws.watch(ctx.store);
  await v1('GET', '/v1/me');
  await v1('GET', '/v1/tags');
  const shown = (await v1('POST', '/v1/notes', { text: 'Dinner #home' }, 201)).note as OAuthRow,
    path = `/v1/notes/${String(shown.date)}/${String(shown.id)}`;
  await v1('GET', path);
  // A place written through the capture function (1.16.0). Today has no
  // weather to keep yet, so nothing goes to Open-Meteo.
  const city = { name: 'Paris', region: 'Île-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 };
  await v1('PUT', `${path}/place`, { place: city });
  await v1('DELETE', `${path}/place`);
  await v1('PUT', `/v1/days/${String(shown.date)}/place`, { place: city });
  await v1('DELETE', `/v1/days/${String(shown.date)}/place`, undefined, 204);
  const appended = (await v1('POST', path + '/append', { text: 'Walk' })).note as OAuthRow;
  await v1('PUT', path, { text: 'Dinner and a walk', revision: appended.revision });
  await v1('PUT', '/v1/tags/pinned', { pinned: ['home'] });
  // A file: the form signed in capture, posted by the client outside any
  // role, then taken by a new note and added to this one.
  const upload = async () => {
    const bytes = png(),
      form = await v1('POST', '/v1/uploads', { name: 'p.png', type: 'image/png', size: bytes.length }, 201);
    await ctx.objects.put(String((form.fields as OAuthRow).key), bytes, {
      type: 'image/png',
      tags: { outcome: 'pending' }
    });
    return [{ upload: form.upload, type: 'image/png' }];
  };
  const pictured = (await v1('POST', '/v1/notes', { uploads: await upload() }, 201)).note as OAuthRow;
  await v1('POST', path + '/media', { uploads: await upload() });
  await v1('GET', '/v1/places?q=Paris');
  await v1('POST', '/v1/places/here', { lat: 48.856613, lon: 2.352222 });
  // Reading back by day, and a file's address: a signed GetObject link.
  await v1('GET', `/v1/notes?from=${String(shown.date)}`);
  await v1('GET', `/v1/notes/${String(pictured.date)}/${String(pictured.id)}/media/1`);
  // Taking a file off, through the capture function (1.17.0): this note has
  // words, so it can lose the one it was given.
  await v1('DELETE', `${path}/media/1`);
  const dates = (await v1('POST', '/v1/upcoming/batch', {
    add: [{ kind: 'birthday', title: 'Mom', date: '11-04', year: 1955 }]
  })) as { added: OAuthRow[] };
  await v1('GET', '/v1/upcoming');
  await v1('GET', '/v1/upcoming/reminders');
  await v1(
    'DELETE',
    `/v1/upcoming/${String(dates.added[0]!.id)}?revision=${String(dates.added[0]!.revision)}`,
    undefined,
    204
  );
  // Check-ins (1.18.0): their reads, and the activity log's join under this role.
  const reported = await v1(
    'POST',
    '/v1/check-ins',
    { lat: 48.85, lon: 2.35, source: 'visit', arrived: '2026-10-12T14:00:00Z' },
    201
  );
  await v1('POST', '/v1/check-ins', { lat: 48.85, lon: 2.35, source: 'visit', arrived: '2026-10-12T15:00:00Z' }, 201);
  await v1('GET', '/v1/check-ins?limit=1');
  const pagedStays = await v1('GET', '/v1/check-ins');
  await v1(
    'GET',
    `/v1/check-ins?before=${encodeURIComponent(String(pagedStays.next ?? '2030-01-01T00:00:00.000Z#c1-a'))}`
  );
  await v1('GET', '/v1/check-ins/places');
  await v1('POST', '/v1/check-ins/places', { name: 'Home', lat: 48.85, lon: 2.35 }, 201);
  const rememberedPlaces = await v1('GET', '/v1/check-ins/places'),
    remembered = (rememberedPlaces.places as OAuthRow[])[0]!;
  await v1('PATCH', `/v1/check-ins/places/${String(remembered.id)}`, { name: 'Our home' });
  await v1('DELETE', `/v1/check-ins/places/${String(remembered.id)}`, undefined, 204);
  const reportedStay = reported.check_in as OAuthRow;
  await v1('PATCH', `/v1/check-ins/${String(reportedStay.id)}`, { name: 'Lunch', revision: reportedStay.revision });
  await v1('DELETE', `/v1/check-ins/${String(reportedStay.id)}`, undefined, 204);
  await v1('POST', '/v1/check-ins', { lat: 48.85, lon: 2.35, source: 'tap' }, 201);
  // An ignored place (1.20.0): a stop there kept before, one not kept, the
  // count and the deletion.
  const ignored = (
    (await v1('POST', '/v1/check-ins/places', { name: 'Away', lat: 48.85, lon: 2.35 }, 201)).place as OAuthRow
  ).id as string;
  await v1('PATCH', `/v1/check-ins/places/${ignored}`, { ignored: true });
  await v1('POST', '/v1/check-ins', { lat: 48.85, lon: 2.35, source: 'visit', arrived: '2026-10-12T20:00:00Z' });
  const counted = (await v1('GET', `/v1/check-ins/places/${ignored}`)).place as OAuthRow;
  await v1('DELETE', `/v1/check-ins/places/${ignored}/check-ins?count=${String(counted.check_ins)}`);
  await v1('DELETE', '/v1/check-ins?confirm=all');
  await v1('GET', '/v1/activity');
  // The archive (1.15.0), all reads under the MCP role.
  const liveDay = String((await v1('GET', '/v1/days')).today);
  await v1('GET', `/v1/days/${liveDay}?include=urls`);
  await v1('GET', '/v1/search?q=dinner&include=urls');
  await v1('GET', '/v1/on-this-day?include=urls');
  const releases = (await v1('GET', '/v1/releases')).releases as OAuthRow[];
  await v1('GET', `/v1/releases/${String(releases[0]!.v)}`);
  await v1('GET', '/v1/tags/all');
  await v1('GET', '/v1/map/pins');
  await v1('GET', '/v1/badges');
  await v1('GET', '/v1/mail-log');
  await v1('DELETE', path, undefined, 204);
  await v1('DELETE', `/v1/notes/${String(pictured.date)}/${String(pictured.id)}`, undefined, 204);
  await v1('DELETE', '/v1/token', undefined, 204);

  assert.deepEqual([...called].sort(), V1_ROUTES.map((r) => r.name).sort(), 'every route is called');
  assert.ok(aws.granted().some((r) => r.via === 'capture'));
  assert.ok(capture.granted().some((r) => r.via === 'TransactWriteCommand ConditionCheck'));
  assert.ok(capture.granted().some((r) => r.action === 'geo-places:ReverseGeocode'));
});
