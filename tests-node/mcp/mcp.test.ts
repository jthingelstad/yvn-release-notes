import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMcpApp, handleMcp, type McpOptions } from '../../server/mcp/app.ts';
import { Reader, quota } from '../../server/mcp/reader.ts';
import { ToolError, asciiJson, validate, MAX_MEDIA } from '../../server/mcp/common.ts';
import { MCP_CONTRACT, TOOLS, TOOL_SCOPES, VERSION, toolsDigest } from '../../server/mcp/contract.ts';
import { captureNote } from '../../workers/capture.ts';
import { OAuthService, type OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected, note, ORIGIN, NOW, PROFILE } from '../oauth/fixtures.ts';
import { collectedOn } from '../../packages/domain/badges.ts';
import type { UpcomingEntry } from '../../packages/domain/upcoming.ts';
type RpcBody = {
  result: {
    structuredContent: OAuthRow;
    isError?: boolean;
    content: OAuthRow[];
    protocolVersion?: string;
    tools?: unknown[];
  };
  error?: OAuthRow;
  id: unknown;
};
function options(ctx: ReturnType<typeof fixture>, logs: OAuthRow[] = []): McpOptions {
  return {
    context: () => ctx,
    capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => logs.push(f) }),
    log: (f) => logs.push(f)
  };
}
async function rpc(
  ctx: ReturnType<typeof fixture>,
  token: string,
  name = 'notes_context',
  arguments_: OAuthRow = {},
  opts = options(ctx)
) {
  const response = await handleMcp(
      new Request(ORIGIN + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } })
      }),
      opts
    ),
    body = (await response.json()) as RpcBody;
  if (body.result?.structuredContent) {
    const schema = TOOLS.find((t) => t.name === name)?.outputSchema;
    if (schema)
      for (const k of Object.keys(body.result.structuredContent)) assert.ok(Object.hasOwn(schema.properties!, k), k);
    assert.ok(asciiJson(body.result.structuredContent).length <= 48000);
  }
  return { response, body, value: body.result?.structuredContent };
}
test('Hono protocol negotiation, auth challenge, methods/origin, notifications and schemas', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    app = createMcpApp(options(ctx));
  const unauthorized = await app.request('/mcp');
  assert.equal(unauthorized.status, 401);
  assert.ok(unauthorized.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource/mcp'));
  const base = { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' };
  assert.equal((await app.request('/mcp', { headers: base })).status, 405);
  assert.equal(
    (await app.request('/mcp', { method: 'POST', headers: { ...base, origin: 'https://wrong.example/' }, body: '{}' }))
      .status,
    403
  );
  assert.equal(
    (await app.request('/mcp', { method: 'POST', headers: { ...base, 'mcp-protocol-version': 'wrong' }, body: '{}' }))
      .status,
    400
  );
  for (const input of [
    { jsonrpc: '1.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', id: true, method: 'ping' },
    [],
    { jsonrpc: '2.0', id: '💡'.repeat(201), method: 'ping' }
  ])
    assert.equal(
      (await app.request('/mcp', { method: 'POST', headers: base, body: JSON.stringify(input) })).status,
      400
    );
  const notification = await app.request('/mcp', {
    method: 'POST',
    headers: base,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
  const init = await app.request('/mcp', {
    method: 'POST',
    headers: base,
    body: JSON.stringify({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  });
  assert.equal(((await init.json()) as RpcBody).result.protocolVersion, '2025-03-26');
  assert.deepEqual(MCP_CONTRACT, JSON.parse(await readFile('contracts/mcp-surface.json', 'utf8')));
  const schema = TOOLS.find((t) => t.name === 'notes_create')!.inputSchema;
  validate({ text: '💡'.repeat(20000), idempotency_key: 'k' }, schema);
  for (const args of [
    { text: 'One', idempotency_key: 'k', user_id: 'other' },
    { text: 'x'.repeat(20001), idempotency_key: 'k' },
    { text: 'One', idempotency_key: 'k\n' }
  ])
    assert.throws(() => validate(args, schema), ToolError);
  assert.throws(() => validate({ limit: true }, TOOLS.find((t) => t.name === 'notes_list')!.inputSchema), ToolError);
});
test('list/search/day/note/context/tags share writing order, Unicode folding, provenance and strong reads', async () => {
  const ctx = fixture(),
    a = await connected(ctx);
  note(ctx, 'z', 'Café by the lake #Maine-2016', '2026-10-07', {
    written_at: '2026-10-07T10:00:00Z',
    place: { city: 'Paris', country: 'FR', lat: 1, lon: 2 },
    links: [{ url: 'https://pier.example/', title: 'Pier' }]
  });
  note(ctx, 'a', 'Later #maine-2016 #Cabin', '2026-10-07', {
    written_at: '2026-10-07T11:00:00Z',
    author: 'assistant',
    client: 'Fixture',
    connection: 'other',
    on_behalf_of: 'u',
    media: [
      {
        n: 1,
        kind: 'audio',
        type: 'audio/mp4',
        key: 'media/u/secret',
        transcript: 'Voice words',
        description: 'Strasse'
      }
    ]
  });
  note(ctx, 'latest', 'Today', '2026-10-13');
  ctx.store.seed({ pk: 'USER#u', sk: 'PLACE#2026-10-07', city: 'London', country: 'GB', lat: 51.5, lon: -0.1 });
  ctx.store.seed({ pk: 'USER#u', sk: 'WEATHER#2026-10-07', high_c: 20.5, low_c: 10, code: 1, city: 'London' });
  const context = (await rpc(ctx, a.token)).value;
  assert.equal(context.today, '2026-10-13');
  assert.equal(context.first_note_day, '2026-10-07');
  assert.ok(!JSON.stringify(context).includes('ada@example.com'));
  assert.ok(!Object.hasOwn(context, 'birthday'));
  assert.deepEqual(
    ((await rpc(ctx, a.token, 'notes_list')).value.notes as OAuthRow[]).map((n) => n.id),
    ['latest', 'a', 'z']
  );
  assert.deepEqual(
    ((await rpc(ctx, a.token, 'notes_get_day', { date: '2026-10-07' })).value.notes as OAuthRow[]).map((n) => n.id),
    ['z', 'a']
  );
  assert.equal((await rpc(ctx, a.token, 'notes_search', { q: '"CAFE" lake' })).value.total, 1);
  assert.equal((await rpc(ctx, a.token, 'notes_search', { q: 'STRASSE voice' })).value.total, 1);
  assert.equal((await rpc(ctx, a.token, 'notes_search', { q: 'Pier Paris' })).value.total, 1);
  assert.equal(
    (await rpc(ctx, a.token, 'notes_search', { tag: 'maine-2016', include_assistant: false })).value.total,
    1
  );
  const day = (await rpc(ctx, a.token, 'notes_get_day', { date: '2026-10-07' })).value;
  assert.equal(day.place, 'London, GB');
  assert.deepEqual(day.weather, { high_c: 20.5, low_c: 10, code: 1, city: 'London' });
  assert.ok(day.weather_credit);
  const full = (await rpc(ctx, a.token, 'notes_get_note', { date: '2026-10-07', id: 'a' })).value.note as OAuthRow;
  assert.equal(full.client, 'Fixture');
  // The connection that wrote it, never the account's own id; parts only with a link or tag.
  assert.equal(full.connection, 'other');
  assert.ok(!('on_behalf_of' in full));
  assert.deepEqual(full.parts, [
    'Later ',
    { tag: 'maine-2016', text: '#maine-2016' },
    ' ',
    { tag: 'cabin', text: '#Cabin' }
  ]);
  note(ctx, 'url', 'See https://pier.example/', '2026-10-08', {
    links: [{ url: 'https://pier.example/', title: 'Pier' }]
  });
  const linked = (await rpc(ctx, a.token, 'notes_get_note', { date: '2026-10-08', id: 'url' })).value.note as OAuthRow;
  assert.deepEqual(linked.parts, ['See ', { url: 'https://pier.example/', label: 'Pier', site: '' }]);
  const plain = (await rpc(ctx, a.token, 'notes_get_note', { date: '2026-10-13', id: 'latest' })).value
    .note as OAuthRow;
  assert.deepEqual([plain.text, 'parts' in plain], ['Today', false]);
  assert.ok(!JSON.stringify(full).includes('media/u/secret'));
  assert.ok(!JSON.stringify(full).includes('Voice words'));
  assert.deepEqual((await rpc(ctx, a.token, 'notes_tags')).value.tags, [
    { tag: 'cabin', notes: 1 },
    { tag: 'maine-2016', notes: 2 }
  ]);
  const reads = ctx.store.memory.calls
    .filter((c) => c.name === 'GetCommand' || c.name === 'QueryCommand')
    .filter((c) => /USER#/.test(JSON.stringify(c.input)));
  assert.ok(reads.some((c) => JSON.stringify(c.input).includes('"ConsistentRead":true')));
  const activity = await new OAuthService(ctx).activity('u');
  for (const hidden of ['CAFE', 'Voice words', 'Pier Paris', 'ada@example.com', 'secret'])
    assert.ok(!JSON.stringify(activity).includes(hidden));
});
test('cursor binds account, field and filters, tolerates changed page size; release and query limits', async () => {
  const ctx = fixture(),
    a = await connected(ctx);
  for (let i = 0; i < 4; i++) note(ctx, 'w-' + i, 'Fixture #Tag', '2026-10-07');
  const first = (await rpc(ctx, a.token, 'notes_list', { limit: 1 })).value,
    cursor = first.next_cursor;
  assert.equal(((await rpc(ctx, a.token, 'notes_list', { limit: 2, cursor })).value.notes as unknown[]).length, 2);
  for (const args of [{ cursor, from: '2026-10-07' }, { cursor: 'not-json' }])
    assert.equal((await rpc(ctx, a.token, 'notes_list', args)).value.error, 'invalid_cursor');
  ctx.store.seed({ pk: 'USER#other', sk: 'PROFILE', birthday: '1981-06-14', tz: 'UTC' });
  const b = await connected(ctx, true, true, 'other');
  assert.equal((await rpc(ctx, b.token, 'notes_list', { cursor })).value.error, 'invalid_cursor');
  for (const args of [
    { release: '1.0', from: '2026-10-07' },
    { release: '999.9' },
    { from: '2027-01-01' },
    { through: '2026-02-30' },
    { from: '2026-10-08', through: '2026-10-07' }
  ])
    assert.ok((await rpc(ctx, a.token, 'notes_list', args)).value.error);
  for (const args of [{ q: '' }, { q: 'one '.repeat(11) }, { q: '"" '.repeat(11) }])
    assert.equal((await rpc(ctx, a.token, 'notes_search', args)).value.error, 'invalid_arguments');
});
test('all huge Unicode/import notes and audio finish continuation without raw keys or descriptions', async () => {
  const ctx = fixture(),
    a = await connected(ctx);
  const text = '💡'.repeat(18000) + ' #Cabin',
    transcript = '🗣'.repeat(18000);
  note(ctx, 'huge', text, '2026-10-07', {
    source: 'import',
    origin: { app: 'dayone' },
    media: [{ n: 1, kind: 'audio', type: 'audio/mp4', key: 'media/u/private', size: 10, transcript }]
  });
  let offset = 0,
    collected = '';
  for (let i = 0; i < 100; i++) {
    const shown = (await rpc(ctx, a.token, 'notes_get_note', { date: '2026-10-07', id: 'huge', offset })).value
      .note as OAuthRow;
    collected += shown.text;
    if (shown.next_offset === null) break;
    assert.ok(Number(shown.next_offset) > offset);
    offset = Number(shown.next_offset);
  }
  assert.equal(collected, text);
  offset = 0;
  collected = '';
  for (let i = 0; i < 100; i++) {
    const shown = (await rpc(ctx, a.token, 'notes_get_audio', { date: '2026-10-07', id: 'huge', n: 1, offset })).value;
    collected += shown.transcript;
    if (shown.next_offset === null) break;
    assert.ok(Number(shown.next_offset) > offset);
    offset = Number(shown.next_offset);
  }
  assert.equal(collected, transcript);
  for (let i = 0; i < 80; i++) note(ctx, 'more-' + i, '💡'.repeat(800), '2026-10-07');
  let cursor: unknown = undefined,
    count = 0;
  for (let i = 0; i < 100; i++) {
    const answer = (await rpc(ctx, a.token, 'notes_list', { limit: 50, ...(cursor ? { cursor } : {}) })).value;
    count += (answer.notes as unknown[]).length;
    cursor = answer.next_cursor;
    if (cursor === null) break;
  }
  assert.equal(count, 81);
});
test('media read scope, prefixes, existing descriptions/transcripts, bounded bytes and private downloads', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false);
  let calls = 0;
  const media = {
      download: async (_uid: string, key: string, _type: string, seconds: number) => {
        calls++;
        assert.equal(seconds, 600);
        assert.ok(key.startsWith('media/u/'));
        return 'https://private.example/signed';
      },
      bytes: async () => {
        calls++;
        return Buffer.from('fixture');
      }
    },
    opts = { ...options(ctx), context: () => ({ ...ctx, media }) };
  note(ctx, 'media', 'Files', '2026-10-07', {
    media: [
      {
        n: 1,
        kind: 'image',
        type: 'image/jpeg',
        name: 'Photo',
        key: 'media/u/original',
        thumb: { key: 'media/u/thumb' },
        description: 'A tree'
      },
      { n: 2, kind: 'audio', type: 'audio/mp4', key: 'media/u/audio', transcript: 'Words', size: 7 },
      { n: 3, kind: 'audio', type: 'audio/mp4', key: 'media/u/large', size: MAX_MEDIA + 1 },
      { n: 4, kind: 'image', type: 'image/jpeg', key: 'media/other/private' }
    ]
  });
  const arguments_ = { date: '2026-10-07', id: 'media' };
  assert.equal(
    (await rpc(ctx, a.token, 'notes_view_photo', { ...arguments_, n: 1, description_only: true }, opts)).value
      .description,
    'A tree'
  );
  assert.equal((await rpc(ctx, a.token, 'notes_get_audio', { ...arguments_, n: 2 }, opts)).value.transcript, 'Words');
  assert.equal(calls, 0);
  assert.equal(
    (await rpc(ctx, a.token, 'notes_view_photo', { ...arguments_, n: 1 }, opts)).value.error,
    'scope_required'
  );
  assert.equal(
    (await rpc(ctx, a.token, 'notes_get_audio', { ...arguments_, n: 2, inline: true }, opts)).value.error,
    'scope_required'
  );
  const b = await connected(ctx, false, true);
  const image = await rpc(ctx, b.token, 'notes_view_photo', { ...arguments_, n: 1 }, opts);
  assert.equal(image.body.result.content[1]!.type, 'image');
  assert.equal(image.body.result.content[1]!.mimeType, 'image/jpeg');
  assert.equal(
    (await rpc(ctx, b.token, 'notes_get_audio', { ...arguments_, n: 2, inline: true }, opts)).body.result.content[1]!
      .type,
    'audio'
  );
  assert.equal(
    (await rpc(ctx, b.token, 'notes_get_audio', { ...arguments_, n: 3, inline: true }, opts)).value.expires_in,
    600
  );
  assert.equal(
    (await rpc(ctx, b.token, 'notes_view_photo', { ...arguments_, n: 4, original: true }, opts)).value.error,
    'file_unavailable'
  );
  assert.equal(
    (await rpc(ctx, b.token, 'notes_view_photo', { ...arguments_, n: 1, description_only: true, original: true }, opts))
      .value.error,
    'invalid_arguments'
  );
  const oversized = {
    ...opts,
    context: () => ({ ...ctx, media: { ...media, bytes: async () => Buffer.alloc(MAX_MEDIA + 1) } })
  };
  assert.equal(
    (await rpc(ctx, b.token, 'notes_view_photo', { ...arguments_, n: 1 }, oversized)).value.error,
    'file_too_large'
  );
});
test('hour/day quota under concurrency, live deletion and storage failures have bounded sanitized output', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    logs: OAuthRow[] = [];
  ctx.store.seed({ pk: 'MCPMETA#u', sk: `RATE#3600#${Math.floor(NOW / 3600)}`, n: 299, revision: 1 });
  const outcomes = await Promise.allSettled(Array.from({ length: 16 }, () => quota(ctx, 'u')));
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal((await rpc(ctx, a.token, 'notes_context', {}, options(ctx, logs))).value.error, 'rate_limited');
  assert.equal(logs.length, 0);
  ctx.store.mcpGet = async () => {
    throw new Error('Private ada@example.com');
  };
  const failed = await rpc(ctx, a.token, 'notes_context', {}, options(ctx, logs));
  assert.equal(failed.response.status, 200);
  assert.equal(failed.value.error, 'temporarily_unavailable');
  assert.ok(logs.some((i) => i.McpFailures === 1));
  assert.ok(!JSON.stringify(logs).includes('ada@example.com'));
  const ctx2 = fixture(),
    b = await connected(ctx2);
  await ctx2.store.mcpBlock('u');
  assert.equal((await rpc(ctx2, b.token)).response.status, 401);
  await assert.rejects(Reader.create(ctx2, b.family), ToolError);
});
test('lost private invocation response retries one committed note and emits no duplicate successful audit', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    logs: OAuthRow[] = [];
  const args = { text: 'Dinner', idempotency_key: 'lost' },
    lost = {
      ...options(ctx, logs),
      capture: async (event: unknown) => {
        await captureNote(event, ctx, { fetchTitle: () => null });
        throw new Error('Lost response');
      }
    };
  assert.equal((await rpc(ctx, a.token, 'notes_create', args, lost)).value.error, 'temporarily_unavailable');
  const retry = (await rpc(ctx, a.token, 'notes_create', args, options(ctx, logs))).value;
  assert.equal(retry.replayed, true);
  assert.equal((await ctx.store.allNotes('u')).length, 1);
  assert.equal(ctx.store.memory.all().filter((i) => String(i.sk).startsWith('LOG#') && i.outcome === 'ok').length, 1);
});

test('notes_create keeps a city the user named as the note place, as Where on the web does', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    asked: string[] = [],
    geocode = async (q: string) => {
      asked.push(q);
      if (q === 'down') throw new Error('Search down');
      return q.toLowerCase() === 'paris'
        ? [
            { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
            { name: 'Paris', region: 'Texas', country: 'United States', tz: 'America/Chicago', lat: 33.66, lon: -95.56 }
          ]
        : [];
    },
    opts: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, { ...ctx, geocode }, { fetchTitle: () => null }),
      log: () => {}
    };
  const made = await rpc(
    ctx,
    a.token,
    'notes_create',
    { text: 'Café', place: 'Paris, Texas', idempotency_key: 'p' },
    opts
  );
  assert.equal(made.body.result.isError, undefined, JSON.stringify(made.value));
  assert.equal((made.value!.note as OAuthRow).place, 'Paris, Texas');
  const [note] = await ctx.store.allNotes('u');
  assert.deepEqual(note!.place, {
    city: 'Paris',
    region: 'Texas',
    country: 'United States',
    tz: 'America/Chicago',
    lat: 33.66,
    lon: -95.56,
    from: 'chosen'
  });
  // An exact retry replays without searching again.
  const again = await rpc(
    ctx,
    a.token,
    'notes_create',
    { text: 'Café', place: 'Paris, Texas', idempotency_key: 'p' },
    opts
  );
  assert.equal(again.value!.replayed, true);
  assert.deepEqual(asked, ['Paris']);
  // A city the search does not know, or a search that fails, writes nothing.
  const unknown = await rpc(ctx, a.token, 'notes_create', { text: 'X', place: 'Nowhere', idempotency_key: 'u' }, opts);
  assert.equal(unknown.value!.error, 'invalid_arguments');
  assert.match(String(unknown.value!.next_step), /Paris, Texas/);
  const down = await rpc(ctx, a.token, 'notes_create', { text: 'X', place: 'down', idempotency_key: 'd' }, opts);
  assert.equal(down.value!.error, 'temporarily_unavailable');
  assert.equal(
    (await rpc(ctx, a.token, 'notes_create', { text: 'X', place: '', idempotency_key: 'e' }, opts)).value!.error,
    'invalid_arguments'
  );
  // Appending takes no place, and keeps the note's.
  const id = String((made.value!.note as OAuthRow).id),
    date = String((made.value!.note as OAuthRow).date);
  assert.equal(
    (await rpc(ctx, a.token, 'notes_append', { date, id, text: 'More', place: 'Paris', idempotency_key: 'a1' }, opts))
      .value!.error,
    'invalid_arguments'
  );
  await rpc(ctx, a.token, 'notes_append', { date, id, text: 'More', idempotency_key: 'a2' }, opts);
  const notes = await ctx.store.allNotes('u');
  assert.equal(notes.length, 1);
  assert.equal((notes[0]!.place as OAuthRow).region, 'Texas');
});

test('explicit null JSON-RPC params and tool arguments are invalid rather than missing', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    app = createMcpApp(options(ctx)),
    headers = { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' };
  const params = await app.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: null })
  });
  assert.equal(((await params.json()) as RpcBody).error!.code, -32602);
  const args = await app.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'notes_context', arguments: null }
    })
  });
  assert.equal(((await args.json()) as RpcBody).result.isError, true);
});
test('Upcoming tools need the upcoming scope; list pages saved dates with occurrences; save and delete go through capture', async () => {
  const ctx = fixture(),
    without = await connected(ctx),
    a = await connected(ctx, true, true, 'u', true),
    geocode = async (q: string) =>
      q.toLowerCase() === 'paris'
        ? [
            { name: 'Paris', region: 'Ile-de-France', country: 'France', tz: 'Europe/Paris', lat: 48.85, lon: 2.35 },
            { name: 'Paris', region: 'Texas', country: 'United States', tz: 'America/Chicago', lat: 33.66, lon: -95.56 }
          ]
        : [],
    opts: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, { ...ctx, geocode }, { fetchTitle: () => null }),
      log: () => {}
    };
  for (const [name, args] of [
    ['upcoming_list', {}],
    ['upcoming_save', { entries: [{ kind: 'birthday', title: 'Alex', date: '10-20' }], idempotency_key: 'k1' }],
    ['upcoming_delete', { entries: [{ id: 'x', revision: 1 }], idempotency_key: 'k2' }]
  ] as const) {
    const { value } = await rpc(ctx, without.token, name, args as OAuthRow, opts);
    assert.equal(value!.error, 'scope_required', name);
    assert.match(String(value!.next_step), /Upcoming/);
  }
  assert.match(String((await rpc(ctx, a.token, 'notes_context', {}, opts)).value!.scope), /upcoming/);
  // Context names every tool offered now, so an agent can see its own list is stale.
  for (const [token, upcoming] of [
    [without.token, false],
    [a.token, true]
  ] as const) {
    const context = (await rpc(ctx, token, 'notes_context', {}, opts)).value!,
      tools = context.tools as OAuthRow[];
    assert.deepEqual(
      tools.map((t) => t.name),
      TOOLS.map((t) => t.name)
    );
    for (const t of tools) assert.equal(t.granted, t.scope === 'upcoming' ? upcoming : true, String(t.name));
    assert.equal((context.changes as OAuthRow[])[0]!.version, VERSION);
    assert.match(String(context.instructions), /refresh this connector/);
  }
  const empty = await rpc(ctx, a.token, 'upcoming_list', {}, opts);
  assert.deepEqual(empty.value, {
    entries: [],
    next_cursor: null,
    total: 0,
    today: '2026-10-13',
    tz: 'America/Chicago',
    max_entries: 200,
    past_left_out: 0,
    server_version: VERSION
  });
  // A dry run resolves the destination and writes nothing.
  const entries = [
    { kind: 'birthday', title: 'Alex', date: '10-20', year: 1976, tag: 'Family' },
    { kind: 'trip', title: 'Holiday', date: '2026-12-05', end_date: '2026-12-12', place: 'Paris, Texas' },
    { kind: 'event', title: 'Concert', date: '2026-11-01', email: false, reminders: [3, 0] }
  ];
  const dry = await rpc(ctx, a.token, 'upcoming_save', { entries, dry_run: true, idempotency_key: 'save' }, opts);
  assert.equal(dry.value!.dry_run, true);
  assert.deepEqual(
    (dry.value!.saved as OAuthRow[]).map((e) => e.place),
    [null, 'Paris, Texas, United States', null]
  );
  assert.equal((await ctx.store.upcomingEntries('u')).length, 0);
  const saved = await rpc(ctx, a.token, 'upcoming_save', { entries, idempotency_key: 'save' }, opts);
  assert.equal(saved.body.result.isError, undefined, JSON.stringify(saved.value));
  const shown = saved.value!.saved as OAuthRow[];
  assert.deepEqual([saved.value!.replayed, saved.value!.dry_run, shown.length], [false, false, 3]);
  assert.deepEqual(
    shown.map((e) => [e.title, e.tag, e.next, e.status, e.revision]),
    [
      ['Alex', 'family', '2026-10-20', 'upcoming', 1],
      ['Holiday', null, '2026-12-05', 'upcoming', 1],
      ['Concert', null, '2026-11-01', 'upcoming', 1]
    ]
  );
  assert.match(String(shown[0]!.line), /Alex turns 5\.0\.0/);
  assert.equal(shown[1]!.through, '2026-12-12');
  for (const key of Object.keys(shown[0]!)) assert.ok(!['pk', 'sk'].includes(key));
  // Exact retry replays; a changed request under the same key is refused.
  const again = await rpc(ctx, a.token, 'upcoming_save', { entries, idempotency_key: 'save' }, opts);
  assert.deepEqual(again.value, { ...saved.value, replayed: true });
  assert.equal(
    (await rpc(ctx, a.token, 'upcoming_save', { entries: entries.slice(1), idempotency_key: 'save' }, opts)).value!
      .error,
    'duplicate_idempotency_key'
  );
  // The list orders by next occurrence and pages; a trip under way stays, and
  // a trip or event already over is left out, only counted.
  const dated = (id: string, kind: 'trip' | 'event', date: string, end_date: string | null): UpcomingEntry => ({
      id,
      kind,
      tag: null,
      title: id,
      date,
      year: null,
      end_date,
      place: null,
      email: true,
      reminders: [0],
      revision: 1,
      created_at: '2026-09-01T12:00:00Z',
      updated_at: '2026-09-01T12:00:00Z'
    }),
    others = [
      dated('Away', 'trip', '2026-10-10', '2026-10-15'),
      dated('Old trip', 'trip', '2026-09-01', '2026-09-05'),
      dated('Old event', 'event', '2026-10-12', null)
    ];
  for (const e of others) assert.ok(await ctx.store.saveUpcoming('u', e, null));
  const list = await rpc(ctx, a.token, 'upcoming_list', { limit: 2 }, opts);
  assert.deepEqual(
    (list.value!.entries as OAuthRow[]).map((e) => [e.title, e.status]),
    [
      ['Away', 'ongoing'],
      ['Alex', 'upcoming']
    ]
  );
  assert.deepEqual([list.value!.total, list.value!.past_left_out, list.value!.max_entries], [4, 2, 200]);
  const rest = await rpc(ctx, a.token, 'upcoming_list', { limit: 2, cursor: list.value!.next_cursor }, opts);
  assert.deepEqual(
    (rest.value!.entries as OAuthRow[]).map((e) => e.title),
    ['Concert', 'Holiday']
  );
  for (const e of others) assert.ok(await ctx.store.saveUpcoming('u', null, e));
  // A change needs the current revision; a problem names the entry and nothing is written.
  const alex = shown[0]!;
  for (const [rows, error, hint] of [
    [[{ id: alex.id, revision: 9, kind: 'birthday', title: 'Alex', date: '10-21' }], 'conflict', /entries\[0\]/],
    [[{ id: 'nope', revision: 1, kind: 'birthday', title: 'Alex', date: '10-21' }], 'not_found', /entries\[0\]/],
    [
      [entries[0], { kind: 'trip', title: 'Nowhere', date: '2026-12-05', end_date: '2026-12-12', place: 'Atlantis' }],
      'invalid_arguments',
      /city search.*entries\[1\]/
    ],
    [[{ kind: 'birthday', title: 'Alex', date: '2026-10-20' }], 'invalid_arguments', /MM-DD.*entries\[0\]/],
    [[{ kind: 'lunch', title: 'Alex', date: '10-20' }], 'invalid_arguments', /entries\[0\]/],
    [['not an object'], 'invalid_arguments', /object/],
    [[], 'invalid_arguments', /list/]
  ] as const) {
    const { value } = await rpc(ctx, a.token, 'upcoming_save', { entries: rows, idempotency_key: 'bad' }, opts);
    assert.equal(value!.error, error, JSON.stringify(rows));
    assert.match(String(value!.next_step), hint);
  }
  assert.equal((await ctx.store.upcomingEntries('u')).length, 3);
  const changed = await rpc(
    ctx,
    a.token,
    'upcoming_save',
    {
      entries: [{ id: alex.id, revision: 1, kind: 'birthday', title: 'Alex', date: '10-21', year: 1976 }],
      idempotency_key: 'change'
    },
    opts
  );
  assert.deepEqual(
    (changed.value!.saved as OAuthRow[]).map((e) => [e.id, e.date, e.revision, e.tag]),
    [[alex.id, '10-21', 2, null]]
  );
  // Delete by id and revision, replayed on retry; a stale revision removes nothing.
  const stale = await rpc(
    ctx,
    a.token,
    'upcoming_delete',
    { entries: [{ id: alex.id, revision: 1 }], idempotency_key: 'd1' },
    opts
  );
  assert.equal(stale.value!.error, 'conflict');
  const removed = await rpc(
    ctx,
    a.token,
    'upcoming_delete',
    {
      entries: [
        { id: alex.id, revision: 2 },
        { id: shown[2]!.id, revision: 1 }
      ],
      idempotency_key: 'd2'
    },
    opts
  );
  assert.deepEqual(removed.value, { removed: 2, replayed: false, server_version: VERSION });
  assert.deepEqual(
    (
      await rpc(
        ctx,
        a.token,
        'upcoming_delete',
        {
          entries: [
            { id: alex.id, revision: 2 },
            { id: shown[2]!.id, revision: 1 }
          ],
          idempotency_key: 'd2'
        },
        opts
      )
    ).value,
    { ...removed.value, replayed: true }
  );
  assert.deepEqual(
    (await ctx.store.upcomingEntries('u')).map((e) => e.title),
    ['Holiday']
  );
  assert.equal((await ctx.store.mcpProfile('u'))!.upcoming_count, 1);
  // Audit rows carry counts, never titles or destinations.
  const audits = ctx.store.memory
    .all()
    .filter((i) => String(i.sk).startsWith('LOG#') && String(i.tool).startsWith('upcoming_') && i.outcome === 'ok');
  assert.deepEqual(
    audits.filter((i) => i.tool !== 'upcoming_list').map((i) => [i.tool, i.count]),
    [
      ['upcoming_save', 3],
      ['upcoming_save', 1],
      ['upcoming_delete', 2]
    ]
  );
  assert.ok(!JSON.stringify(audits).match(/Alex|Holiday|Paris/));
  // The other scopes are untouched: notes keep working, and notes_create still needs notes:write.
  assert.equal((await rpc(ctx, a.token, 'notes_tags', {}, opts)).value!.total, 0);
  const readOnly = await connected(ctx, false, false, 'u', true);
  assert.equal(
    (await rpc(ctx, readOnly.token, 'notes_create', { text: 'x', idempotency_key: 'n' }, opts)).value!.error,
    'scope_required'
  );
  assert.equal((await rpc(ctx, readOnly.token, 'upcoming_list', {}, opts)).value!.total, 1);
});
test('the whole account reads under notes:read alone: on this day, releases, badges, mail log and account', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false);
  ctx.store.seed({
    ...PROFILE,
    send_time: '07:30',
    city: 'Minneapolis',
    country: 'US',
    inbox: 'standing-secret',
    calendar: 'feed-secret',
    pause_from: '2026-10-01',
    pause_through: '2026-10-20'
  });
  ctx.store.seed({ pk: 'USER#u', sk: 'PAUSE#2026-10-01', through: '2026-10-20' });
  note(ctx, 'today', 'Today #cabin', '2026-10-13', { tags: ['cabin'] });
  note(ctx, 'release-day', 'Birthday', '2026-06-14', { media: [{ n: 1, kind: 'image', type: 'image/jpeg' }] });
  for (let i = 0; i < 6; i++)
    note(ctx, 'past-' + i, 'A year ago ' + i, '2025-10-13', { written_at: `2025-10-13T1${i}:00:00Z`, tags: ['lake'] });
  note(ctx, 'agent', 'Two years ago', '2024-10-13', { author: 'assistant', client: 'Fixture' });
  const context = (await rpc(ctx, a.token)).value;
  for (const name of [
    'notes_on_this_day',
    'notes_releases',
    'notes_badges',
    'notes_mail_log',
    'notes_activity',
    'notes_account'
  ])
    assert.deepEqual(
      (context.tools as OAuthRow[]).find((t) => t.name === name),
      { name, scope: 'notes:read', granted: true }
    );

  // On this day: the same patch of each earlier release, newest first, five previews a day.
  const past = (await rpc(ctx, a.token, 'notes_on_this_day')).value;
  assert.equal(past.date, '2026-10-13');
  assert.equal(past.version, '4.5.121');
  assert.deepEqual(
    (past.days as OAuthRow[]).map((d) => [d.date, d.version, d.notes_total, (d.notes as OAuthRow[]).length]),
    [
      ['2025-10-13', '4.4.121', 6, 5],
      ['2024-10-13', '4.3.121', 1, 1]
    ]
  );
  assert.equal(((past.days as OAuthRow[])[0]!.notes as OAuthRow[])[0]!.id, 'past-0');
  assert.deepEqual(
    ((await rpc(ctx, a.token, 'notes_on_this_day', { include_assistant: false })).value.days as OAuthRow[]).map(
      (d) => d.date
    ),
    ['2025-10-13']
  );
  const paged = (await rpc(ctx, a.token, 'notes_on_this_day', { limit: 1 })).value;
  assert.equal(paged.total, 2);
  assert.deepEqual(
    (
      (await rpc(ctx, a.token, 'notes_on_this_day', { limit: 1, cursor: paged.next_cursor })).value.days as OAuthRow[]
    ).map((d) => d.date),
    ['2024-10-13']
  );
  assert.equal((await rpc(ctx, a.token, 'notes_on_this_day', { date: '2026-10-14' })).value.error, 'invalid_date');

  // Releases: those with notes plus the current one, then one release whole.
  assert.deepEqual(
    ((await rpc(ctx, a.token, 'notes_releases')).value.releases as OAuthRow[]).map((r) => [
      r.v,
      r.days,
      r.notes,
      r.current
    ]),
    [
      ['4.5', 2, 2, true],
      ['4.4', 1, 6, false],
      ['4.3', 1, 1, false]
    ]
  );
  const release = (await rpc(ctx, a.token, 'notes_releases', { release: '4.5' })).value.release as OAuthRow;
  assert.equal(release.from, '2026-06-14');
  assert.equal(release.through, '2027-06-13');
  assert.equal(release.days_with_notes, 2);
  assert.equal(release.paused_days, 13);
  assert.deepEqual(release.tags, [{ tag: 'cabin', notes: 1 }]);
  assert.deepEqual((release.badges as OAuthRow).collected, [{ id: 'release-day', name: 'Release day', count: 1 }]);
  for (const args of [{ release: '4.6' }, { release: '999.9' }, { release: '4.5', cursor: 'x' }])
    assert.ok((await rpc(ctx, a.token, 'notes_releases', args)).value.error);

  // A day says its version, whether it was paused and what it collected.
  const day = (await rpc(ctx, a.token, 'notes_get_day', { date: '2026-06-14' })).value;
  assert.equal(day.version, '4.5.0');
  assert.equal(day.paused, false);
  assert.deepEqual(day.collected, collectedOn(PROFILE.birthday, '2026-06-14'));
  assert.equal((await rpc(ctx, a.token, 'notes_get_day', { date: '2026-10-03' })).value.paused, true);

  // Badges, the same facts as the web page.
  const badges = (await rpc(ctx, a.token, 'notes_badges')).value;
  assert.equal(badges.show_badges, true);
  assert.ok((badges.earned as OAuthRow[]).some((e) => e.id === 'hello'));
  assert.equal(badges.count, (badges.earned as OAuthRow[]).length);
  assert.equal((badges.release as OAuthRow).v, '4.5');

  // The mail log: the owner's rows from the last 30 days, newest first, words cut short.
  const row = (at: string, id: string, extra: OAuthRow) =>
    ctx.store.seed({
      pk: 'USER#u',
      sk: `ACTIVITY#${at}#mail#${id}`,
      kind: 'mail',
      at,
      message: id,
      received_at: at,
      via: 'reply',
      ...extra
    });
  row('2026-10-11T10:00:00.000Z', 'm1', {
    day: '2026-10-11',
    version: '4.5.119',
    subject: 'Re: Your release notes',
    outcome: 'filed'
  });
  row('2026-10-12T10:00:00.000Z', 'm2', {
    subject: 'Late',
    outcome: 'not-filed',
    reason: 'expired',
    text: 'é'.repeat(2500),
    attempts: 1,
    notified_at: '2026-10-12T10:01:00.000Z'
  });
  // Older than 30 days: not in the mail log.
  row('2026-09-01T10:00:00.000Z', 'old', { outcome: 'filed' });
  const log = (await rpc(ctx, a.token, 'notes_mail_log')).value,
    [late, filed] = log.entries as OAuthRow[];
  assert.deepEqual(
    (log.entries as OAuthRow[]).map((e) => e.id),
    ['m2', 'm1']
  );
  assert.equal([...String(late!.text)].length, 2000);
  assert.equal(late!.cut, true);
  assert.equal(late!.notified, true);
  assert.equal(late!.reason, 'expired');
  assert.deepEqual(filed, {
    id: 'm1',
    received_at: '2026-10-11T10:00:00.000Z',
    via: 'reply',
    day: '2026-10-11',
    version: '4.5.119',
    subject: 'Re: Your release notes',
    outcome: 'filed',
    reason: null,
    sender: null,
    text: null,
    attempts: 0,
    notified: false
  });

  // Account: settings and standing, never the addresses that work as credentials.
  const account = (await rpc(ctx, a.token, 'notes_account')).value;
  assert.deepEqual(account.account, {
    birthday: '1981-06-14',
    send_time: '07:30',
    status: 'active',
    transcribe: false,
    describe: false,
    show_badges: true,
    pause: { from: '2026-10-01', through: '2026-10-20' },
    city: 'Minneapolis',
    country: 'US'
  });
  assert.deepEqual(account.streak, { current: 1, longest: 1, today: true });
  assert.deepEqual(account.lifetime, { notes: 9, days: 4, photos: 1 });
  assert.deepEqual(account.next_release, { version: '4.6.0', date: '2027-06-14' });
  for (const hidden of ['ada@example.com', 'standing-secret', 'feed-secret'])
    assert.ok(!JSON.stringify(account).includes(hidden), hidden);

  // Show badges off: badges, a release's badges and a day's collected stay hidden.
  ctx.store.seed({ ...PROFILE, badges: false });
  assert.deepEqual(Object.keys((await rpc(ctx, a.token, 'notes_badges')).value).sort(), [
    'message',
    'server_version',
    'show_badges',
    'today',
    'version'
  ]);
  assert.ok(
    !Object.hasOwn((await rpc(ctx, a.token, 'notes_releases', { release: '4.5' })).value.release as OAuthRow, 'badges')
  );
  assert.ok(!Object.hasOwn((await rpc(ctx, a.token, 'notes_get_day', { date: '2026-06-14' })).value, 'collected'));
  assert.equal(((await rpc(ctx, a.token, 'notes_account')).value.account as OAuthRow).show_badges, false);
});
test('notes_activity reads the activity log by local day and kind, a page at a time, and counts its own reads', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false),
    mail = (at: string, id: string, extra: OAuthRow = {}) =>
      ctx.store.seed({
        pk: 'USER#u',
        sk: `ACTIVITY#${at}#mail#${id}`,
        kind: 'mail',
        at,
        message: id,
        received_at: at,
        via: 'reply',
        outcome: 'filed',
        ...extra
      });
  // Chicago days: 10-11 starts at 05:00Z, 10-12 at 05:00Z, 10-13 at 05:00Z.
  mail('2026-10-11T04:59:00.000Z', 'm0');
  mail('2026-10-11T10:00:00.000Z', 'm1', { day: '2026-10-11' });
  mail('2026-10-12T10:00:00.000Z', 'm2', { outcome: 'not-filed', reason: 'expired', text: 'é'.repeat(2500) });
  ctx.store.seed({
    pk: 'USER#u',
    sk: 'ACTIVITY#2026-10-12T11:00:00.000Z#note.added#n1',
    kind: 'note.added',
    at: '2026-10-12T11:00:00.000Z'
  });
  ctx.store.seed({
    pk: 'MCPMETA#u',
    sk: 'ACTIVITY#2026-10-12T05:00:00.000Z#reads#f0',
    kind: 'reads',
    at: '2026-10-12T05:00:00.000Z',
    day: '2026-10-12',
    client: 'Earlier',
    connection: 'f0',
    calls: 2,
    tools: { notes_list: 2 },
    last_at: '2026-10-12T20:00:00.000Z',
    revision: 2
  });
  ctx.store.seed({
    pk: 'USER#u',
    sk: 'ACTIVITY#2026-10-10T10:00:00.000Z#mail#m0',
    kind: 'mail',
    at: '2026-10-10T10:00:00.000Z',
    message: 'm0',
    received_at: '2026-10-10T10:00:00.000Z',
    via: 'address',
    outcome: 'filed'
  });
  ctx.store.seed({ pk: 'USER#other', sk: 'ACTIVITY#2026-10-12T10:00:00.000Z#mail#theirs', kind: 'mail' });

  // Each call counts once it has answered: one row a connection a local day.
  await rpc(ctx, a.token, 'notes_context');
  const all = (await rpc(ctx, a.token, 'notes_activity')).value,
    ids = (v: OAuthRow) => (v.entries as OAuthRow[]).map((e) => e.id);
  assert.deepEqual([all.today, all.tz, all.next_cursor], ['2026-10-13', 'America/Chicago', null]);
  const [added, own, ...rest] = all.entries as OAuthRow[];
  // Connecting is itself in the log, made on the web.
  assert.deepEqual(added, {
    id: `2026-10-13T12:00:00.000Z#connection.added#${String(a.family.id)}`,
    at: '2026-10-13T12:00:00.000Z',
    kind: 'connection.added',
    via: 'web',
    scopes: 'notes:read',
    connection: a.family.id,
    client: a.family.client_name
  });
  assert.deepEqual(own, {
    id: `2026-10-13T05:00:00.000Z#reads#${String(a.family.id)}`,
    at: '2026-10-13T05:00:00.000Z',
    kind: 'reads',
    day: '2026-10-13',
    client: a.family.client_name,
    connection: a.family.id,
    calls: 1,
    tools: { notes_context: 1 },
    last_at: new Date(NOW * 1000).toISOString()
  });
  assert.deepEqual(
    rest.map((e) => e.id),
    [
      '2026-10-12T11:00:00.000Z#note.added#n1',
      '2026-10-12T10:00:00.000Z#mail#m2',
      '2026-10-12T05:00:00.000Z#reads#f0',
      '2026-10-11T10:00:00.000Z#mail#m1',
      '2026-10-11T04:59:00.000Z#mail#m0',
      '2026-10-10T10:00:00.000Z#mail#m0'
    ]
  );
  const late = rest[1]!;
  assert.equal([...String(late.text)].length, 2000);
  assert.equal(late.cut, true);
  assert.ok(!JSON.stringify(all).includes('theirs'));
  for (const hidden of ['USER#', 'MCPMETA#', 'expires_at', 'revision', 'ada@example.com'])
    assert.ok(!JSON.stringify(all).includes(hidden), hidden);

  // Settings' last use still comes from the use rows, not the ISO reads rows.
  assert.deepEqual(
    ((await new OAuthService(ctx).connections('u')).connections as OAuthRow[]).map((c) => c.last_used),
    [NOW]
  );
  // Later calls add to the same row.
  const counted = (await rpc(ctx, a.token, 'notes_activity', { kinds: ['reads'] })).value.entries as OAuthRow[];
  assert.deepEqual(
    counted.map((e) => [e.client, e.calls, e.tools]),
    [
      [a.family.client_name, 2, { notes_activity: 1, notes_context: 1 }],
      ['Earlier', 2, { notes_list: 2 }]
    ]
  );

  // Local days, both ends kept; kinds by family.
  assert.deepEqual(
    ids((await rpc(ctx, a.token, 'notes_activity', { from: '2026-10-11', through: '2026-10-11' })).value),
    ['2026-10-11T10:00:00.000Z#mail#m1']
  );
  assert.deepEqual(
    ids((await rpc(ctx, a.token, 'notes_activity', { through: '2026-10-12', kinds: ['note', 'mail'] })).value),
    [
      '2026-10-12T11:00:00.000Z#note.added#n1',
      '2026-10-12T10:00:00.000Z#mail#m2',
      '2026-10-11T10:00:00.000Z#mail#m1',
      '2026-10-11T04:59:00.000Z#mail#m0',
      '2026-10-10T10:00:00.000Z#mail#m0'
    ]
  );

  // A page at a time, with a cursor bound to the same filters.
  const seen: unknown[] = [];
  let cursor: unknown = undefined;
  do {
    const page = (
      await rpc(ctx, a.token, 'notes_activity', { kinds: ['mail'], limit: 2, ...(cursor ? { cursor } : {}) })
    ).value;
    assert.ok((page.entries as OAuthRow[]).length <= 2);
    seen.push(...ids(page));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(seen, [
    '2026-10-12T10:00:00.000Z#mail#m2',
    '2026-10-11T10:00:00.000Z#mail#m1',
    '2026-10-11T04:59:00.000Z#mail#m0',
    '2026-10-10T10:00:00.000Z#mail#m0'
  ]);
  const first = (await rpc(ctx, a.token, 'notes_activity', { kinds: ['mail'], limit: 1 })).value;
  for (const args of [
    { kinds: ['note'], cursor: first.next_cursor },
    { kinds: ['mail'], from: '2026-10-11', cursor: first.next_cursor },
    { kinds: ['mail'], cursor: 'not-a-cursor' }
  ])
    assert.equal((await rpc(ctx, a.token, 'notes_activity', args)).value.error, 'invalid_cursor');
  for (const args of [
    { from: '2026-10-12', through: '2026-10-11' },
    { through: '2026-10-14' },
    { kinds: ['notes'] },
    { kinds: ['mail', 'mail'] },
    { kinds: [1] },
    { kinds: [] },
    { limit: 101 }
  ])
    assert.ok((await rpc(ctx, a.token, 'notes_activity', args)).value.error, JSON.stringify(args));
});
test('a read that cannot be counted is logged and still answers', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false),
    logs: OAuthRow[] = [],
    opts = options(ctx, logs);
  // Only the reads row fails; the read quota still commits.
  const commit = ctx.store.mcpCommit.bind(ctx.store);
  ctx.store.mcpCommit = async (changes, uid) =>
    changes.some(([row]) => String(row.sk).startsWith('ACTIVITY#')) ? false : commit(changes, uid);
  const { value } = await rpc(ctx, a.token, 'notes_activity', {}, opts);
  assert.deepEqual(
    (value.entries as OAuthRow[]).map((e) => e.kind),
    ['connection.added']
  );
  assert.deepEqual(
    logs.filter((l) => l.event === 'activity-unrecorded'),
    [{ event: 'activity-unrecorded', kind: 'reads', user: 'u' }]
  );
});
test('a read that loses the race for its reads row several times waits, rereads and still counts', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false),
    logs: OAuthRow[] = [],
    commit = ctx.store.mcpCommit.bind(ctx.store);
  // A parallel call commits the same day's row first, four times over.
  let raced = 0;
  ctx.store.mcpCommit = async (changes, uid) => {
    const reads = changes.find(([row]) => row.kind === 'reads');
    if (reads && raced++ < 4) assert.ok(await commit([reads], uid));
    return commit(changes, uid);
  };
  await rpc(ctx, a.token, 'notes_context', {}, options(ctx, logs));
  assert.deepEqual(
    (await ctx.store.activityAll('u')).filter((r) => r.kind === 'reads').map((r) => [r.calls, r.tools]),
    [[5, { notes_context: 5 }]]
  );
  assert.deepEqual(
    logs.filter((l) => l.event === 'activity-unrecorded'),
    []
  );
});
test("an Upcoming row's title is read now, and only with the upcoming scope", async () => {
  const ctx = fixture(),
    date = (id: string, title: string) =>
      ctx.store.seed({ pk: 'USER#u', sk: `UPCOMING#${id}`, id, kind: 'event', title, date: '2026-11-01', revision: 1 });
  date('d1', 'Concert');
  for (const [at, kind, id] of [
    ['2026-10-12T10:00:00.000Z', 'upcoming.added', 'd1'],
    ['2026-10-12T11:00:00.000Z', 'upcoming.removed', 'd2']
  ])
    ctx.store.seed({ pk: 'USER#u', sk: `ACTIVITY#${at}#${kind}#${id}`, kind, at, via: 'web', upcoming: id });
  const read = async (upcoming: boolean) =>
    (
      (
        await rpc(ctx, (await connected(ctx, false, false, 'u', upcoming)).token, 'notes_activity', {
          kinds: ['upcoming']
        })
      ).value.entries as OAuthRow[]
    ).map((e) => [e.upcoming, e.title]);
  assert.deepEqual(await read(false), [
    ['d2', undefined],
    ['d1', undefined]
  ]);
  // A removed date's title is gone with it.
  assert.deepEqual(await read(true), [
    ['d2', null],
    ['d1', 'Concert']
  ]);
});
test('a past day of long Unicode notes fits one page with at least one whole preview', async () => {
  const ctx = fixture(),
    a = await connected(ctx, false, false);
  for (let i = 0; i < 6; i++) note(ctx, 'long-' + i, '💡'.repeat(5000), '2023-10-13');
  const long = ((await rpc(ctx, a.token, 'notes_on_this_day', { date: '2026-10-13' })).value.days as OAuthRow[]).find(
    (d) => d.date === '2023-10-13'
  )!;
  assert.equal(long.notes_total, 6);
  assert.ok((long.notes as unknown[]).length >= 1 && (long.notes as unknown[]).length < 5);
});
test('every tool change ships as a new server version with a changes entry', async () => {
  assert.deepEqual(Object.keys(TOOL_SCOPES).sort(), TOOLS.map((t) => t.name).sort());
  for (const scope of Object.values(TOOL_SCOPES)) assert.match(scope, /^(notes:read|notes:write|upcoming)$/);
  assert.equal(MCP_CONTRACT.changes[0]?.version, VERSION, 'add a changes entry for the new server_version');
  assert.equal(new Set(MCP_CONTRACT.changes.map((c) => c.version)).size, MCP_CONTRACT.changes.length);
  const versions = JSON.parse(await readFile('contracts/mcp-versions.json', 'utf8')) as Record<string, string>;
  assert.equal(
    versions[VERSION],
    toolsDigest(),
    'the tools changed: bump server_version, add a changes entry, then run tools/export-mcp-contract.ts'
  );
});
