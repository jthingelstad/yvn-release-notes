/** notes_edit and files from an agent (Jamie, 2026-10-28: "the mcp interface
 * doesn't provide a way to edit a note" and "doesn't allow an agent to add an
 * image or attachment"). Fictional subscriber only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureNote, type CaptureContext } from '../../workers/capture.ts';
import * as worker from '../../workers/describe.ts';
import { testImage } from '../../packages/backend/describe.ts';
import { thumbKey } from '../../packages/backend/media.ts';
import { FakeObjects, FakeInvocations } from '../../packages/testing/services.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { MAX_INLINE_BYTES } from '../../server/mcp/files.ts';
import { fixture, connected, note, NOW } from '../oauth/fixtures.ts';
import { stream } from '../processing/helpers.ts';
const noFetch = () => null;
const b64 = (data: Buffer) => data.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 1)]),
  M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(2000, 2)]),
  PDF = Buffer.from('%PDF-1.4\n% A fictional one-page file\n');
function setup(files = true) {
  const ctx: CaptureContext & ReturnType<typeof fixture> & { objects: FakeObjects } = {
    ...fixture(),
    objects: new FakeObjects()
  };
  return { ctx, connect: () => connected(ctx, true, true, 'u', false, files) };
}
const activity = (ctx: ReturnType<typeof setup>['ctx']) =>
  ctx.store.memory
    .all()
    .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#') && String(i.kind).startsWith('note.'));

test('notes_edit rewrites its own note from the revision it read, names links again and logs no words', async () => {
  const { ctx, connect } = setup(false),
    a = await connect(),
    run = (tool: string, args: OAuthRow, fetchTitle: () => unknown = noFetch) =>
      captureNote({ token: a.token, tool, arguments: args }, ctx, {
        fetchTitle: fetchTitle as () => null
      });
  const made = (await run('notes_create', { date: '2026-10-12', text: 'Lunch #Cafe', idempotency_key: 'c' }))
      .note as OAuthRow,
    revision = String(made.revision);
  assert.match(revision, /^[0-9a-f]{24}$/);
  let fetched = 0;
  const edit = {
      date: made.date,
      id: made.id,
      text: 'Lunch at the pier https://pier.example/ #Lake',
      revision,
      idempotency_key: 'e'
    },
    edited = await run('notes_edit', edit, () => (fetched++, { title: 'Pier', site: 'example' }));
  assert.equal(edited.replayed, false);
  const shown = edited.note as OAuthRow;
  assert.equal(shown.text, edit.text);
  assert.deepEqual(shown.tags, ['lake']);
  assert.notEqual(shown.revision, revision);
  assert.equal(fetched, 1);
  const stored = (await ctx.store.note('u', '2026-10-12', String(made.id)))!;
  assert.equal(stored.text, edit.text);
  assert.equal((stored.links as OAuthRow[])[0]!.title, 'Pier');
  assert.equal(stored.revision, 2);
  // An exact retry answers from the receipt; the old revision is now stale.
  assert.deepEqual(await run('notes_edit', edit), { ...edited, replayed: true });
  assert.equal((await run('notes_edit', { ...edit, idempotency_key: 'again' })).error, 'conflict');
  // A change made on the web since it was read refuses the edit, and keeps the web's words.
  await ctx.store.updateNote('u', '2026-10-12', String(made.id), 'Owner rewrote it', '2026-10-13T11:59:00Z');
  const refused = await run('notes_edit', { ...edit, revision: String(shown.revision), idempotency_key: 'stale' });
  assert.equal(refused.error, 'conflict');
  assert.match(String(refused.next_step), /notes_get_note/);
  assert.equal((await ctx.store.note('u', '2026-10-12', String(made.id)))!.text, 'Owner rewrote it');
  // Rows say what happened, never the words.
  const rows = activity(ctx);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.via, r.note]),
    [
      ['note.added', 'assistant', made.id],
      ['note.edited', 'assistant', made.id]
    ]
  );
  assert.doesNotMatch(
    JSON.stringify(ctx.store.memory.all().filter((i) => /^(ACTIVITY|LOG)#/.test(String(i.sk)))),
    /Lunch|pier|Lake/
  );
});

test('notes_edit refuses a note this connection did not make, an edit the owner raced, and there is still no delete', async () => {
  const { ctx, connect } = setup(false),
    a = await connect(),
    run = (tool: string, args: OAuthRow) =>
      captureNote({ token: a.token, tool, arguments: { idempotency_key: 'k', text: 'Fixed', ...args } }, ctx, {
        fetchTitle: noFetch
      });
  note(ctx, 'w-mine', 'The owner wrote this', '2026-10-07');
  note(ctx, 'a-other', 'Another agent', '2026-10-07', {
    author: 'assistant',
    connection: 'different',
    client_id: a.cid
  });
  for (const id of ['w-mine', 'a-other']) {
    const answer = await run('notes_edit', { date: '2026-10-07', id, revision: 'x' });
    assert.equal(answer.error, 'forbidden_not_author', id);
    assert.match(String(answer.next_step), /same connection/);
  }
  assert.equal((await ctx.store.note('u', '2026-10-07', 'w-mine'))!.text, 'The owner wrote this');
  assert.equal((await run('notes_edit', { date: '2026-10-07', id: 'missing', revision: 'x' })).error, 'not_found');
  assert.equal((await run('notes_delete', { date: '2026-10-07', id: 'w-mine' })).error, 'unknown_tool');
  // The owner's edit lands between the agent's read and its commit: the
  // commit's condition refuses, the reread sees the new words, and it stops.
  const made = (await run('notes_create', { text: 'First', idempotency_key: 'c' })).note as OAuthRow,
    key = { pk: 'USER#u', sk: `NOTE#${made.date}#${made.id}` },
    commit = ctx.store.captureCommit.bind(ctx.store);
  ctx.store.captureCommit = async (...args) => {
    ctx.store.seed({ ...ctx.store.memory.read(key)!, text: 'Owner, meanwhile', updated_at: '2026-10-13T11:59:30Z' });
    return commit(...args);
  };
  const raced = await run('notes_edit', {
    date: made.date,
    id: made.id,
    revision: String(made.revision),
    idempotency_key: 'r'
  });
  assert.equal(raced.error, 'conflict');
  assert.equal(ctx.store.memory.read(key)!.text, 'Owner, meanwhile');
  assert.ok(!ctx.store.memory.all().some((i) => String(i.sk).startsWith('WRITERATE#notes_edit#')));
});

test('files on notes_create are kept as web uploads are, numbered, without keys in the answer or names in the log', async () => {
  const { ctx, connect } = setup(),
    a = await connect(),
    logs: OAuthRow[] = [];
  const answer = await captureNote(
    {
      token: a.token,
      tool: 'notes_create',
      arguments: {
        text: 'Beach day #Summer',
        files: [
          { name: 'IMG_0001 private.png', type: 'image/png', data: b64(testImage()) },
          { name: 'voice.m4a', type: 'audio/x-m4a', data: b64(M4A) },
          { name: 'ticket.pdf', type: 'application/pdf', data: b64(PDF) }
        ],
        idempotency_key: 'files'
      }
    },
    ctx,
    { fetchTitle: noFetch, log: (f) => logs.push(f) }
  );
  assert.equal(answer.replayed, false, JSON.stringify(answer));
  const shown = answer.note as OAuthRow,
    stored = (await ctx.store.note('u', String(shown.date), String(shown.id)))!,
    media = stored.media as OAuthRow[];
  assert.deepEqual(
    media.map((m) => [m.n, m.kind, m.type, m.name]),
    [
      [1, 'image', 'image/png', 'IMG_0001 private.png'],
      [2, 'audio', 'audio/mp4', 'voice.m4a'],
      [3, 'file', 'application/pdf', 'ticket.pdf']
    ]
  );
  for (const m of media) {
    assert.match(String(m.key), /^media\/u\/files\/[0-9a-f]{32}\.(png|m4a|pdf)$/);
    assert.deepEqual(await ctx.objects.tags(String(m.key)), { outcome: 'note' });
  }
  assert.equal(media[0]!.size, testImage().length);
  assert.ok(Number(media[0]!.width) > 0);
  assert.deepEqual((await ctx.objects.get(String(media[2]!.key))).body, PDF);
  const text = JSON.stringify(answer);
  assert.ok(!text.includes('media/u/'));
  assert.deepEqual(
    (shown.media as OAuthRow[]).map((m) => m.n),
    [1, 2, 3]
  );
  const audit = ctx.store.memory.all().find((i) => String(i.sk).startsWith('LOG#'))!;
  assert.equal(audit.files, 3);
  const [row] = activity(ctx);
  assert.deepEqual([row!.kind, row!.files], ['note.added', 3]);
  const everything = JSON.stringify([
    logs,
    ctx.store.memory.all().filter((i) => /^(ACTIVITY|LOG)#/.test(String(i.sk)))
  ]);
  for (const hidden of ['IMG_0001', 'voice', 'ticket', 'Beach']) assert.ok(!everything.includes(hidden), hidden);
  // A photo-only note is fine; nothing at all is not.
  const photoOnly = await captureNote(
    {
      token: a.token,
      tool: 'notes_create',
      arguments: { files: [{ type: 'image/jpeg', data: b64(JPEG) }], idempotency_key: 'photo' }
    },
    ctx,
    { fetchTitle: noFetch }
  );
  assert.equal((photoOnly.note as OAuthRow).text, '');
  assert.equal(
    (await captureNote({ token: a.token, tool: 'notes_create', arguments: { idempotency_key: 'none' } }, ctx)).error,
    'invalid_arguments'
  );
});

test('an MCP photo gets its thumbnail and, opted in, its description from the same stream reader as a web upload', async () => {
  const { ctx, connect } = setup(),
    a = await connect();
  ctx.store.seed({ ...(await ctx.store.mcpProfile('u'))!, describe: true });
  const shown = (
    await captureNote(
      {
        token: a.token,
        tool: 'notes_create',
        arguments: {
          text: 'Sunset',
          files: [{ name: 'sunset.png', type: 'image/png', data: b64(testImage()) }],
          idempotency_key: 'p'
        }
      },
      ctx,
      { fetchTitle: noFetch }
    )
  ).note as OAuthRow;
  const row = (await ctx.store.note('u', String(shown.date), String(shown.id)))!,
    services: worker.Services = {
      store: ctx.store,
      objects: ctx.objects,
      invocations: new FakeInvocations(),
      self: 'describe:live',
      clock: () => NOW,
      model: async () => async () => ({ content: [{ type: 'text', text: 'An orange sky.' }] }),
      maker: async () => ({ body: Buffer.from('synthetic thumb'), width: 64, height: 64 })
    };
  await worker.runEvent({ Records: [stream(row)] }, {}, services);
  const entry = ((await ctx.store.note('u', String(shown.date), String(shown.id)))!.media as OAuthRow[])[0]!;
  assert.equal((entry.thumb as OAuthRow).key, thumbKey(String(entry.key)));
  assert.equal(entry.description, 'An orange sky.');
});

test('notes_attach adds files to its own note only, after the ones it has, and logs note.files', async () => {
  const { ctx, connect } = setup(),
    a = await connect(),
    run = (tool: string, args: OAuthRow) =>
      captureNote({ token: a.token, tool, arguments: args }, ctx, { fetchTitle: noFetch });
  const made = (await run('notes_create', { text: 'Trip https://pier.example/', idempotency_key: 'c' }))
      .note as OAuthRow,
    key = { pk: 'USER#u', sk: `NOTE#${made.date}#${made.id}` };
  ctx.store.seed({
    ...ctx.store.memory.read(key)!,
    media: [{ n: 1, kind: 'image', type: 'image/png', size: 9, key: 'media/u/files/web.png', description: 'Kept' }]
  });
  const attach = {
      date: made.date,
      id: made.id,
      files: [{ name: 'map.pdf', type: 'application/pdf', data: b64(PDF) }],
      idempotency_key: 'a'
    },
    attached = await run('notes_attach', attach);
  assert.equal(attached.replayed, false, JSON.stringify(attached));
  const stored = ctx.store.memory.read(key)!;
  assert.equal(stored.text, 'Trip https://pier.example/');
  assert.deepEqual(
    (stored.media as OAuthRow[]).map((m) => [m.n, m.type, m.description ?? null]),
    [
      [1, 'image/png', 'Kept'],
      [2, 'application/pdf', null]
    ]
  );
  assert.deepEqual(await run('notes_attach', attach), { ...attached, replayed: true });
  assert.equal(ctx.objects.calls.filter((c) => c.operation === 'put').length, 1);
  assert.deepEqual(
    activity(ctx).map((r) => [r.kind, r.added ?? null]),
    [
      ['note.added', null],
      ['note.files', 1]
    ]
  );
  note(ctx, 'w-mine', 'The owner wrote this', '2026-10-07');
  const refused = await run('notes_attach', { ...attach, date: '2026-10-07', id: 'w-mine', idempotency_key: 'b' });
  assert.equal(refused.error, 'forbidden_not_author');
  // A note holds at most 20 files.
  ctx.store.seed({
    ...ctx.store.memory.read(key)!,
    media: Array.from({ length: 20 }, (_, i) => ({
      n: i + 1,
      kind: 'file',
      type: 'application/pdf',
      size: 1,
      key: `media/u/files/${i}.pdf`
    }))
  });
  assert.equal((await run('notes_attach', { ...attach, idempotency_key: 'full' })).error, 'too_many_files');
  // Nothing refused was kept.
  assert.equal(ctx.objects.calls.filter((c) => c.operation === 'put').length, 1);
});

test('files need media:write, a type the web takes, matching bytes and the call cap; nothing refused is kept', async () => {
  const plain = setup(false),
    b = await plain.connect(),
    create = (ctx: CaptureContext, token: string, files: unknown) =>
      captureNote(
        { token, tool: 'notes_create', arguments: { text: 'With files', files, idempotency_key: 'f' } },
        ctx,
        {
          fetchTitle: noFetch
        }
      );
  const scoped = await create(plain.ctx, b.token, [{ type: 'image/jpeg', data: b64(JPEG) }]);
  assert.equal(scoped.error, 'scope_required');
  assert.match(String(scoped.next_step), /adding files/);
  assert.equal(
    (
      await captureNote(
        {
          token: b.token,
          tool: 'notes_attach',
          arguments: {
            date: '2026-10-13',
            id: 'x',
            files: [{ type: 'image/jpeg', data: b64(JPEG) }],
            idempotency_key: 'a'
          }
        },
        plain.ctx
      )
    ).error,
    'scope_required'
  );
  const { ctx, connect } = setup(),
    a = await connect(),
    big = Buffer.alloc(MAX_INLINE_BYTES / 2 + 1, 0);
  JPEG.copy(big);
  for (const [files, code] of [
    [[{ type: 'text/plain', name: 'notes.txt', data: b64(Buffer.from('hello')) }], 'file_type'],
    [[{ type: 'application/zip', data: b64(Buffer.from('PK\u0003\u0004')) }], 'file_type'],
    [[{ type: 'image/png', data: b64(JPEG) }], 'file_unreadable'],
    [[{ type: 'image/jpeg', data: 'not base64!' }], 'invalid_arguments'],
    [[{ type: 'image/jpeg', data: b64(JPEG), path: '/etc' }], 'invalid_arguments'],
    [
      [
        { type: 'image/jpeg', data: b64(big) },
        { type: 'image/jpeg', data: b64(big) }
      ],
      'file_too_large'
    ],
    // The schema's maxItems refuses a fifth file before anything is decoded.
    [Array.from({ length: 5 }, () => ({ type: 'image/jpeg', data: b64(JPEG) })), 'invalid_arguments']
  ] as const) {
    const answer = await create(ctx, a.token, files);
    assert.equal(answer.error, code, JSON.stringify(files).slice(0, 80));
    assert.ok(answer.next_step);
  }
  assert.equal(ctx.objects.calls.length, 0);
  assert.equal((await ctx.store.allNotes('u')).length, 0);
});

test('a write that cannot commit removes the files it kept', async () => {
  const { ctx, connect } = setup(),
    a = await connect();
  const family = (await ctx.store.mcpGet('OAUTHFAMILY#' + a.family.id))!;
  // The grant loses media:write between the check and the commit.
  ctx.store.captureCommit = async () => {
    ctx.store.seed({ ...family, scope: 'notes:read notes:write', revision: Number(family.revision) + 1 });
    return false;
  };
  const answer = await captureNote(
    {
      token: a.token,
      tool: 'notes_create',
      arguments: { text: 'Lost', files: [{ type: 'image/jpeg', data: b64(JPEG) }], idempotency_key: 'l' }
    },
    ctx,
    { fetchTitle: noFetch }
  );
  assert.equal(answer.error, 'scope_required');
  const put = ctx.objects.calls.find((c) => c.operation === 'put')!,
    removed = ctx.objects.calls.find((c) => c.operation === 'remove')!;
  assert.equal(removed.key, put.key);
  await assert.rejects(() => ctx.objects.get(put.key), { name: 'NoSuchKey' });
});
