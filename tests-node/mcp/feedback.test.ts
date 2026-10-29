/** notes_send_feedback through the reader and the capture function, and
 * notes_my_feedback with and without media:read. Fictional account only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, MAX_BODY, type McpOptions } from '../../server/mcp/app.ts';
import { INLINE_IMAGE_BYTES } from '../../packages/backend/inline-images.ts';
import { MAX_FEEDBACK_BODY } from '../../server/app/feedback-routes.ts';
import { asciiJson } from '../../server/mcp/common.ts';
import { TOOLS, TOOL_SCOPES, WRITE_TOOLS } from '../../server/mcp/contract.ts';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { b64, png, SECRET } from '../../packages/testing/images.ts';
import { fixture, connected, ORIGIN } from '../oauth/fixtures.ts';

type Body = { result: { structuredContent: OAuthRow; isError?: boolean; content: OAuthRow[] } };
function setup() {
  const objects = new FakeObjects(),
    ctx = { ...fixture(), objects },
    logs: OAuthRow[] = [],
    media = {
      download: async () => 'https://private.example/signed',
      bytes: async (_uid: string, key: string) => (await objects.get(key)).body
    };
  const opts: McpOptions = {
    context: () => ({ ...ctx, media }),
    capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: (f) => logs.push(f) }),
    log: (f) => logs.push(f)
  };
  async function rpc(token: string, name: string, args: OAuthRow = {}) {
    const response = await handleMcp(
      new Request(ORIGIN + '/mcp', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
      }),
      opts
    );
    const body = (await response.json()) as Body,
      value = body.result?.structuredContent;
    if (value && !value.error) {
      const schema = TOOLS.find((t) => t.name === name)!.outputSchema!;
      for (const k of Object.keys(value)) assert.ok(Object.hasOwn(schema.properties!, k), k);
      assert.ok(asciiJson(value).length <= 48000);
    }
    return { status: response.status, body, value };
  }
  return { ctx, objects, logs, rpc };
}

test('the tools are in the contract with notes:read, and sending is a capture write', () => {
  assert.equal(TOOL_SCOPES.notes_send_feedback, 'notes:read');
  assert.equal(TOOL_SCOPES.notes_my_feedback, 'notes:read');
  assert.ok(WRITE_TOOLS.has('notes_send_feedback'));
  assert.ok(!WRITE_TOOLS.has('notes_my_feedback'));
});

test('an assistant files feedback with a stripped screenshot, replays exactly and reads it back', async () => {
  const s = setup(),
    a = await connected(s.ctx, false, false);
  const args = {
    kind: 'bug',
    text: 'notes_search returned nothing for a quoted phrase',
    screenshots: [{ type: 'image/png', data: b64(png(800, 600)) }],
    idempotency_key: 'feedback-1'
  };
  const sent = await s.rpc(a.token, 'notes_send_feedback', args);
  assert.equal(sent.value.replayed, false);
  const view = sent.value.feedback as OAuthRow;
  assert.equal(view.via, 'assistant');
  assert.equal(view.client, 'Assistant');
  assert.equal(view.status, 'open');
  assert.ok(!JSON.stringify(sent.value).includes('media/'));
  const keys = await s.objects.list('media/u/feedback/');
  assert.equal(keys.length, 1);
  assert.ok(!(await s.objects.get(keys[0]!)).body.toString('latin1').includes(SECRET));

  const again = await s.rpc(a.token, 'notes_send_feedback', args);
  assert.equal(again.value.replayed, true);
  assert.deepEqual(again.value.feedback, view);
  assert.equal(
    (await s.rpc(a.token, 'notes_send_feedback', { ...args, text: 'Different' })).value.error,
    'duplicate_idempotency_key'
  );
  const rows = s.ctx.store.memory.all();
  assert.equal(rows.filter((r) => String(r.sk).startsWith('FEEDBACK#')).length, 1);
  // The first item earns Issue opened, once (the replay writes nothing), by
  // the assistant, never marked seen: the email tells of it.
  assert.deepEqual(
    rows.filter((r) => r.kind === 'badge.earned').map((r) => [r.badge, r.via, r.client, r.day, r.note]),
    [['issue', 'assistant', 'Assistant', undefined, undefined]]
  );
  assert.deepEqual(await s.ctx.store.seenBadges('u'), new Set());
  const audit = rows.filter((r) => String(r.pk) === 'MCPMETA#u' && String(r.sk).startsWith('LOG#'));
  assert.ok(audit.some((r) => r.tool === 'notes_send_feedback' && r.feedback_id === view.id));
  assert.ok(!JSON.stringify(rows.filter((r) => String(r.sk).startsWith('ACTIVITY#'))).includes('quoted phrase'));
  assert.ok(!JSON.stringify(s.logs).includes('quoted phrase'));

  const list = await s.rpc(a.token, 'notes_my_feedback');
  assert.equal(list.value.total, 1);
  assert.equal(list.value.filed_today, 1);
  assert.equal(list.value.per_day, 10);
  // A screenshot's bytes need media:read.
  assert.equal(
    (await s.rpc(a.token, 'notes_my_feedback', { id: view.id, screenshot: 1 })).value.error,
    'scope_required'
  );
  const b = await connected(s.ctx, false, true);
  const shot = await s.rpc(b.token, 'notes_my_feedback', { id: view.id, screenshot: 1 });
  assert.equal(shot.body.result.content[1]!.type, 'image');
  assert.equal(shot.body.result.content[1]!.mimeType, 'image/png');
  assert.equal((await s.rpc(b.token, 'notes_my_feedback', { id: view.id, screenshot: 2 })).value.error, 'not_found');
  assert.equal((await s.rpc(b.token, 'notes_my_feedback', { screenshot: 1 })).value.error, 'invalid_arguments');
});

test('refusals are clear and keep nothing', async () => {
  const s = setup(),
    a = await connected(s.ctx, false, false);
  const refused = async (args: OAuthRow, error: string) => {
    const r = await s.rpc(a.token, 'notes_send_feedback', { kind: 'idea', text: 'x', idempotency_key: 'k', ...args });
    assert.equal(r.value.error, error, JSON.stringify(args).slice(0, 80));
    return r;
  };
  await refused({ kind: 'rant' }, 'invalid_arguments');
  await refused({ follows: '0123456789abcdef', idempotency_key: 'k1' }, 'not_found');
  const type = await refused(
    { screenshots: [{ type: 'image/gif', data: b64(png()) }], idempotency_key: 'k2' },
    'invalid_arguments'
  );
  assert.match(JSON.stringify(type.value), /screenshots\[0\]: A screenshot is image\/png, image\/jpeg or image\/webp/);
  const data = await refused(
    {
      screenshots: [
        { type: 'image/png', data: b64(png()) },
        { type: 'image/png', data: 'AAAA' }
      ],
      idempotency_key: 'k3'
    },
    'invalid_arguments'
  );
  assert.match(JSON.stringify(data.value), /screenshots\[1\]/);
  assert.deepEqual(await s.objects.list('media/'), []);
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await s.rpc(a.token, 'notes_send_feedback', { kind: 'idea', text: `${i}`, idempotency_key: `q${i}` })).value
        .replayed,
      false
    );
  await refused({ idempotency_key: 'k4' }, 'rate_limited');
});

test('three screenshots at the cap fit both body limits, which stay well under 6 MB', () => {
  const shot = { type: 'image/png', data: Buffer.alloc(INLINE_IMAGE_BYTES).toString('base64') },
    args = { kind: 'bug', text: 'x'.repeat(4000), screenshots: [shot, shot, shot], idempotency_key: 'k'.repeat(64) },
    rpc = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'notes_send_feedback', arguments: args }
    });
  assert.ok(Buffer.byteLength(rpc) < MAX_BODY);
  assert.ok(Buffer.byteLength(JSON.stringify(args)) < MAX_FEEDBACK_BODY);
  // The web body, even carried in base64 again, is under Lambda's 6 MB.
  assert.ok(Math.ceil(MAX_FEEDBACK_BODY / 3) * 4 < 6_000_000);
});

test('long feedback stays inside the result limit: the list previews, a read by id pages through every word', async () => {
  const s = setup(),
    a = await connected(s.ctx, false, false),
    grin = String.fromCodePoint(0x1f600),
    bulb = String.fromCodePoint(0x1f4a1),
    emoji = grin.repeat(4000);
  // A filing of 4,000 emoji is 48,000 characters of escaped JSON on its own.
  const sent = await s.rpc(a.token, 'notes_send_feedback', { kind: 'idea', text: emoji, idempotency_key: 'long' });
  assert.equal(sent.value.error, undefined);
  const head = sent.value.feedback as OAuthRow;
  assert.equal(head.text_length, 4000);
  assert.equal(head.text_complete, false);
  assert.equal(head.answer_count, 0);
  const replay = await s.rpc(a.token, 'notes_send_feedback', { kind: 'idea', text: emoji, idempotency_key: 'long' });
  assert.equal(replay.value.replayed, true);
  // Jamie's 20 answers, the most an item holds, each 4,000 long.
  const row = s.ctx.store.memory.all().find((r) => String(r.sk).startsWith('FEEDBACK#'))!,
    answers = Array.from({ length: 20 }, (_, i) => ({
      at: `2026-10-28T12:${String(i).padStart(2, '0')}:00Z`,
      text: (i % 2 ? bulb : String.fromCharCode(97 + i)).repeat(4000),
      status: 'needs_info'
    }));
  s.ctx.store.seed({ ...row, answers, status: 'needs_info' });
  for (let i = 0; i < 9; i++)
    await s.rpc(a.token, 'notes_send_feedback', { kind: 'bug', text: 'y'.repeat(4000), idempotency_key: `b${i}` });

  // The list moves on every page and ends.
  const ids: string[] = [];
  let cursor: unknown;
  for (let pages = 0; pages < 20; pages++) {
    const page = (await s.rpc(a.token, 'notes_my_feedback', { limit: 50, ...(cursor ? { cursor } : {}) })).value;
    assert.equal(page.error, undefined);
    const items = page.items as OAuthRow[];
    assert.ok(items.length > 0);
    ids.push(...items.map((i) => String(i.id)));
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  assert.equal(new Set(ids).size, 10);

  // Reading the long one by id gives back every word once, in order.
  const parts: string[] = [emoji, ...answers.map((x) => x.text)],
    got = parts.map(() => '');
  let at: OAuthRow | null = { part: 0, offset: 0 },
    reads = 0;
  while (at) {
    const r: OAuthRow = (await s.rpc(a.token, 'notes_my_feedback', { id: head.id, ...at })).value;
    assert.equal(r.error, undefined, JSON.stringify(at));
    const f = r.feedback as OAuthRow;
    assert.equal(f.answer_count, 20);
    if (f.text !== null) {
      assert.equal(f.text_offset, [...got[0]!].length);
      got[0] += String(f.text);
    }
    for (const x of f.answers as OAuthRow[]) {
      assert.equal(x.offset, [...got[Number(x.n)]!].length);
      got[Number(x.n)] += String(x.text);
    }
    at = f.next as OAuthRow | null;
    assert.ok(++reads < 60);
  }
  assert.deepEqual(got, parts);
  const bad = async (args: OAuthRow) => (await s.rpc(a.token, 'notes_my_feedback', args)).value.error;
  assert.equal(await bad({ id: head.id, part: 21 }), 'invalid_arguments');
  assert.equal(await bad({ id: head.id, offset: 4000 }), 'invalid_arguments');
  assert.equal(await bad({ part: 1 }), 'invalid_arguments');
});
