import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMcpApp, handleMcp, type McpOptions } from '../../server/mcp/app.ts';
import { Reader, quota } from '../../server/mcp/reader.ts';
import { ToolError, asciiJson, validate, MAX_MEDIA } from '../../server/mcp/common.ts';
import { MCP_CONTRACT, TOOLS } from '../../server/mcp/contract.ts';
import { captureNote } from '../../workers/capture.ts';
import { OAuthService, type OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected, note, ORIGIN, NOW } from '../oauth/fixtures.ts';
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
test('native Hono protocol negotiation, auth challenge, methods/origin, notifications and schemas', async () => {
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
