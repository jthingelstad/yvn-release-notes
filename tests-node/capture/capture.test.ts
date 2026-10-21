import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { captureNote } from '../../workers/capture.ts';
import { OAuthService, type OAuthRow } from '../../packages/backend/oauth.ts';
import { asciiJson, fingerprint } from '../../server/mcp/common.ts';
import { fixture, connected, note, NOW } from '../oauth/fixtures.ts';
const noFetch = () => null;
test('create/append and exact retries preserve original safe result and content-free audit', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    event = {
      token: a.token,
      tool: 'notes_create',
      arguments: { date: '2026-10-07', text: 'Dinner 💡 #Cabin', idempotency_key: 'first' }
    };
  const first = await captureNote(event, ctx, { fetchTitle: noFetch }),
    shown = first.note as OAuthRow;
  assert.equal(first.replayed, false);
  assert.equal(shown.late, true);
  assert.equal(shown.author, 'assistant');
  assert.deepEqual(shown.tags, ['cabin']);
  const append = {
    token: a.token,
    tool: 'notes_append',
    arguments: { date: shown.date, id: shown.id, text: 'A walk #Evening', idempotency_key: 'append' }
  };
  const second = await captureNote(append, ctx, { fetchTitle: noFetch });
  assert.equal((second.note as OAuthRow).text, 'Dinner 💡 #Cabin\n\nA walk #Evening');
  assert.deepEqual(await captureNote(append, ctx, { fetchTitle: noFetch }), { ...second, replayed: true });
  assert.deepEqual(await captureNote(event, ctx, { fetchTitle: noFetch }), { ...first, replayed: true });
  assert.equal(
    (await captureNote({ ...event, arguments: { ...event.arguments, text: 'Changed' } }, ctx, { fetchTitle: noFetch }))
      .error,
    'duplicate_idempotency_key'
  );
  const rows = ctx.store.memory.all(),
    audits = rows.filter((i) => String(i.sk).startsWith('LOG#'));
  assert.equal(audits.length, 2);
  for (const audit of audits)
    for (const forbidden of ['text', 'arguments', 'request_hash', 'token', 'idempotency_key'])
      assert.ok(!Object.hasOwn(audit, forbidden));
  assert.ok(!JSON.stringify(audits).includes('Dinner'));
  assert.equal((await ctx.store.allNotes('u')).length, 1);
});
test('legacy fingerprints keep sorted ASCII JSON and receipt retries after language migration', async () => {
  assert.equal(
    asciiJson({ tool: 'notes_create', arguments: { text: '💡 café', idempotency_key: 'legacy' } }, true),
    '\u007b"arguments":{"idempotency_key":"legacy","text":"\\ud83d\\udca1 caf\\u00e9"},"tool":"notes_create"}'
  );
  const ctx = fixture(),
    a = await connected(ctx),
    event = { token: a.token, tool: 'notes_create', arguments: { text: '💡 café', idempotency_key: 'legacy' } },
    hash = fingerprint({ tool: event.tool, arguments: event.arguments });
  // Generated independently by the legacy Python sorted ensure_ascii serializer.
  assert.equal(hash, '4980f8f602682ecf0cfdf6c2bb5ed1867dfea500d4aa74cb3eeddc1dfd09492a');
  const first = await captureNote(event, ctx, { fetchTitle: noFetch });
  assert.equal(ctx.store.memory.all().find((i) => String(i.sk).startsWith('CAPTURE#'))!.request_hash, hash);
  assert.equal((await captureNote(event, ctx, { fetchTitle: noFetch })).replayed, true);
  assert.ok(first.note);
});
test('only own-connection assistant notes append; dates, keys, Unicode limits and forged fields are strict', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    write = async (tool: string, args: OAuthRow) =>
      captureNote({ token: a.token, tool, arguments: { text: 'Next', idempotency_key: 'k', ...args } }, ctx, {
        fetchTitle: noFetch
      });
  note(ctx, 'human');
  assert.equal((await write('notes_append', { date: '2026-10-07', id: 'human' })).error, 'forbidden_not_author');
  note(ctx, 'other', 'Agent', '2026-10-07', { author: 'assistant', connection: 'different', client_id: a.cid });
  assert.equal((await write('notes_append', { date: '2026-10-07', id: 'other' })).error, 'forbidden_not_author');
  for (const args of [
    { date: '2027-01-01' },
    { date: '2026-02-30' },
    { author: 'user' },
    { text: '\u0085\u001f' },
    { text: 'x'.repeat(20001) },
    { idempotency_key: 'unsafe key' }
  ])
    assert.ok((await write('notes_create', args)).error);
  assert.equal((await write('notes_delete', {})).error, 'unknown_tool');
  const huge = await write('notes_create', { text: '💡'.repeat(20000), idempotency_key: 'unicode' });
  assert.ok((huge.note as OAuthRow).next_offset);
  const shown = huge.note as OAuthRow;
  assert.equal((await ctx.store.note('u', String(shown.date), String(shown.id)))!.text, '💡'.repeat(20000));
  assert.equal(
    (await write('notes_append', { date: shown.date, id: shown.id, idempotency_key: 'overflow' })).error,
    'too_long'
  );
});
test('cross-request duplicate create commits once and quota exact retries remain safe', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    event = { token: a.token, tool: 'notes_create', arguments: { text: 'One', idempotency_key: 'same' } };
  const results = await Promise.all(Array.from({ length: 16 }, () => captureNote(event, ctx, { fetchTitle: noFetch })));
  assert.equal(results.filter((r) => r.replayed === false).length, 1);
  assert.ok(results.every((r) => r.note));
  assert.equal((await ctx.store.allNotes('u')).length, 1);
  const rate = ctx.store.memory.all().find((i) => String(i.sk).startsWith('WRITERATE#'))!;
  ctx.store.seed({ ...rate, n: 20 });
  assert.equal(
    (
      await captureNote({ ...event, arguments: { ...event.arguments, idempotency_key: 'new' } }, ctx, {
        fetchTitle: noFetch
      })
    ).error,
    'rate_limited'
  );
  assert.equal((await captureNote(event, ctx, { fetchTitle: noFetch })).replayed, true);
});
test('live revocation, scope removal and account deletion races commit no note, receipt or audit', async () => {
  for (const change of ['revoked', 'scope', 'mcp_deleting']) {
    const ctx = fixture(),
      a = await connected(ctx);
    let raced = false;
    ctx.store.memory.beforeSend = (command) => {
      if (
        command instanceof TransactWriteCommand &&
        command.input.TransactItems?.some((op) => op.Put?.Item?.sk?.startsWith('CAPTURE#')) &&
        !raced
      ) {
        raced = true;
        if (change === 'mcp_deleting')
          ctx.store.seed({ ...ctx.store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!, mcp_deleting: true });
        else
          ctx.store.seed({
            ...ctx.store.memory.read({ pk: String(a.family.pk), sk: 'STATE' })!,
            [change]: change === 'scope' ? 'notes:read' : true,
            revision: 99
          });
      }
    };
    const result = await captureNote(
      { token: a.token, tool: 'notes_create', arguments: { text: 'Race', idempotency_key: 'race' } },
      ctx,
      { fetchTitle: noFetch }
    );
    assert.equal(result.error, 'scope_required', change);
    assert.equal((await ctx.store.allNotes('u')).length, 0);
    assert.ok(!ctx.store.memory.all().some((i) => /^(CAPTURE|LOG|WRITERATE)#/.test(String(i.sk))));
  }
});
test('owner edits during append are retried and preserve private files/place in storage and safe receipt', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    first = await captureNote(
      { token: a.token, tool: 'notes_create', arguments: { text: 'First', idempotency_key: 'first' } },
      ctx,
      { fetchTitle: noFetch }
    ),
    shown = first.note as OAuthRow,
    key = { pk: 'USER#u', sk: `NOTE#${shown.date}#${shown.id}` };
  let raced = false;
  ctx.store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((op) => op.Update) && !raced) {
      raced = true;
      ctx.store.seed({
        ...ctx.store.memory.read(key)!,
        text: 'Owner edited',
        updated_at: '2026-10-13T12:01:00Z',
        place: { city: 'Paris', country: 'FR', lat: 48.8, lon: 2.3 },
        media: [
          {
            n: 1,
            kind: 'audio',
            type: 'audio/mp4',
            name: 'Walk',
            key: 'media/u/private',
            transcript: 'Private transcript '.repeat(10000)
          }
        ]
      });
    }
  };
  const event = {
      token: a.token,
      tool: 'notes_append',
      arguments: { date: shown.date, id: shown.id, text: 'Next', idempotency_key: 'next' }
    },
    answer = await captureNote(event, ctx, { fetchTitle: noFetch });
  assert.equal((answer.note as OAuthRow).text, 'Owner edited\n\nNext');
  assert.equal((ctx.store.memory.read(key)!.media as OAuthRow[])[0]!.key, 'media/u/private');
  const publicText = JSON.stringify(answer);
  for (const hidden of ['media/u/private', 'Private transcript', '48.8', '2.3'])
    assert.ok(!publicText.includes(hidden));
  assert.deepEqual(await captureNote(event, ctx, { fetchTitle: noFetch }), { ...answer, replayed: true });
});
test('title fetches are cached over conflicts; unexpected errors sanitized and counted', async () => {
  const ctx = fixture(),
    a = await connected(ctx);
  let attempt = 0,
    fetches = 0;
  const commit = ctx.store.captureCommit.bind(ctx.store);
  ctx.store.captureCommit = async (...args) => (++attempt === 1 ? false : commit(...args));
  const event = {
    token: a.token,
    tool: 'notes_create',
    arguments: { text: 'Dinner https://pier.example/', idempotency_key: 'link' }
  };
  const first = await captureNote(event, ctx, {
    fetchTitle: () => {
      fetches++;
      return { title: 'Pier', site: 'example' };
    }
  });
  assert.ok(first.note);
  assert.equal(fetches, 1);
  const logs: OAuthRow[] = [];
  ctx.store.captureCommit = async () => {
    throw new Error('Private note ada@example.com');
  };
  const unavailable = await captureNote({ ...event, arguments: { ...event.arguments, idempotency_key: 'fail' } }, ctx, {
    fetchTitle: noFetch,
    log: (fields) => logs.push(fields)
  });
  assert.equal(unavailable.error, 'temporarily_unavailable');
  assert.ok(logs.some((i) => i.McpFailures === 1));
  assert.ok(logs.some((i) => i.event === 'mcp-error' && i.kind === 'Error'));
  assert.ok(!JSON.stringify(logs).includes('ada@example.com'));
});
test('no implicit write approval and receipts expire at 24 hours', async () => {
  const ctx = fixture(),
    read = await connected(ctx, false);
  assert.equal(
    (
      await captureNote(
        { token: read.token, tool: 'notes_create', arguments: { text: 'Refused', idempotency_key: 'r' } },
        ctx,
        { fetchTitle: noFetch }
      )
    ).error,
    'scope_required'
  );
  const a = await connected(ctx),
    event = { token: a.token, tool: 'notes_create', arguments: { text: 'One', idempotency_key: 'once' } },
    first = await captureNote(event, ctx, { fetchTitle: noFetch }),
    receipt = ctx.store.memory.all().find((i) => String(i.sk).startsWith('CAPTURE#'))!;
  ctx.store.seed({ ...receipt, expires_at: NOW });
  const fresh = await captureNote(event, ctx, { fetchTitle: noFetch });
  assert.equal(fresh.replayed, false);
  assert.notEqual((first.note as OAuthRow).id, (fresh.note as OAuthRow).id);
  await new OAuthService(ctx).disconnect('u', String(a.family.id), true);
  assert.equal(
    (
      await captureNote({ ...event, arguments: { ...event.arguments, idempotency_key: 'blocked' } }, ctx, {
        fetchTitle: noFetch
      })
    ).error,
    'scope_required'
  );
});
test('an Upcoming batch commits entries, count, receipt, audit, daily count and live grant together, and rechecks the grant after a refusal', async () => {
  const ctx = fixture(),
    a = await connected(ctx, true, true, 'u', true),
    sent: OAuthRow[] = [],
    original = ctx.store.memory.send.bind(ctx.store.memory);
  ctx.store.memory.send = async (command) => {
    if (command instanceof TransactWriteCommand) sent.push(command.input as OAuthRow);
    return original(command);
  };
  const event = {
    token: a.token,
    tool: 'upcoming_save',
    arguments: {
      entries: [
        { kind: 'birthday', title: 'Alex', date: '10-20' },
        { kind: 'event', title: 'Concert', date: '2026-11-01' }
      ],
      idempotency_key: 'first'
    }
  };
  const first = await captureNote(event, { ...ctx, geocode: async () => [] });
  assert.equal(first.replayed, false);
  const [batch, logged] = sent.slice(-2) as [OAuthRow, OAuthRow];
  const items = (batch.TransactItems as OAuthRow[]).map(
    (op) =>
      Object.keys(op)[0] +
      ':' +
      String(
        (Object.values(op)[0] as OAuthRow).Key
          ? ((Object.values(op)[0] as OAuthRow).Key as OAuthRow).sk
          : ((Object.values(op)[0] as OAuthRow).Item as OAuthRow).sk
      ).split('#')[0]
  );
  assert.deepEqual(items, [
    'Put:UPCOMING',
    'Put:UPCOMING',
    'Update:PROFILE',
    'ConditionCheck:STATE',
    'Put:CAPTURE',
    'Put:LOG',
    'Put:WRITERATE'
  ]);
  const family = (batch.TransactItems as OAuthRow[])[3]!.ConditionCheck as OAuthRow;
  assert.equal((family.ExpressionAttributeValues as OAuthRow)[':write'], 'upcoming');
  // Then one activity row a date, after the batch and apart from it: the
  // date's id and the assistant's name, never its title.
  const rows = (logged.TransactItems as OAuthRow[]).slice(1).map((op) => (op.Put as OAuthRow).Item as OAuthRow),
    saved = await ctx.store.upcomingEntries('u');
  assert.deepEqual(
    rows.map((r) => [r.kind, r.via, r.client, r.upcoming]).sort(),
    saved.map((e) => ['upcoming.added', 'assistant', a.family.client_name, e.id]).sort()
  );
  assert.doesNotMatch(JSON.stringify(rows), /Alex|Concert/);
  assert.equal((await ctx.store.mcpProfile('u'))!.upcoming_count, 2);
  const rate = ctx.store.memory.all().find((i) => String(i.sk).startsWith('WRITERATE#upcoming#'));
  assert.equal(rate!.n, 1);
  // Daily cap of 50 calls, counted per call.
  ctx.store.seed({ ...rate!, n: 50 });
  const capped = await captureNote(
    { ...event, arguments: { ...event.arguments, idempotency_key: 'capped' } },
    { ...ctx, geocode: async () => [] }
  );
  assert.equal(capped.error, 'rate_limited');
  // A removed grant after the pre-check commits nothing.
  const fid = String(a.family.id);
  const row = (await ctx.store.mcpGet('OAUTHFAMILY#' + fid))!;
  ctx.store.seed({ ...row, scope: 'notes:read', revision: Number(row.revision) + 1 });
  const refused = await captureNote(
    { ...event, arguments: { ...event.arguments, idempotency_key: 'later' } },
    { ...ctx, geocode: async () => [] }
  );
  assert.equal(refused.error, 'scope_required');
  assert.equal((await ctx.store.upcomingEntries('u')).length, 2);
});
test("an assistant's notes and the badges they earn are in the activity log once, never its words", async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    logged = () =>
      ctx.store.memory
        .all()
        .filter((i) => i.pk === 'USER#u' && String(i.sk).startsWith('ACTIVITY#') && i.kind !== 'connection.added'),
    event = {
      token: a.token,
      tool: 'notes_create',
      arguments: { date: '2026-10-13', text: 'Dinner by the lake', idempotency_key: 'first' }
    };
  const shown = (await captureNote(event, ctx, { fetchTitle: noFetch })).note as OAuthRow;
  await captureNote(event, ctx, { fetchTitle: noFetch });
  const append = {
    token: a.token,
    tool: 'notes_append',
    arguments: { date: shown.date, id: shown.id, text: 'A walk', idempotency_key: 'append' }
  };
  await captureNote(append, ctx, { fetchTitle: noFetch });
  await captureNote(append, ctx, { fetchTitle: noFetch });
  const rows = logged(),
    notes = rows.filter((r) => String(r.kind).startsWith('note.')),
    badges = rows.filter((r) => r.kind === 'badge.earned');
  assert.deepEqual(
    notes.map((r) => [r.kind, r.via, r.client, r.day, r.note, r.version]),
    [
      ['note.added', 'assistant', a.family.client_name, '2026-10-13', shown.id, '4.5.121'],
      ['note.edited', 'assistant', a.family.client_name, '2026-10-13', shown.id, '4.5.121']
    ]
  );
  assert.ok(badges.length > 0);
  for (const b of badges)
    assert.deepEqual([b.via, b.client, b.day, b.note], ['assistant', a.family.client_name, '2026-10-13', shown.id]);
  assert.equal(new Set(badges.map((b) => b.key)).size, badges.length);
  // Not marked seen: the email still tells of them.
  assert.deepEqual(await ctx.store.seenBadges('u'), new Set());
  assert.doesNotMatch(JSON.stringify(rows), /Dinner|walk|lake/);

  // With "Show badges" off, the note is logged and no badge is.
  const quiet = fixture();
  quiet.store.seed({ ...(await quiet.store.mcpProfile('u'))!, badges: false });
  const b = await connected(quiet);
  await captureNote({ ...event, token: b.token }, quiet, { fetchTitle: noFetch });
  assert.deepEqual(
    quiet.store.memory
      .all()
      .filter((i) => String(i.sk).startsWith('ACTIVITY#'))
      .map((i) => i.kind),
    ['connection.added', 'note.added']
  );
});
test('a note whose activity row cannot be written is still saved, and counted', async () => {
  const ctx = fixture(),
    a = await connected(ctx),
    logs: OAuthRow[] = [];
  ctx.store.putActivity = async () => false;
  const result = await captureNote(
    { token: a.token, tool: 'notes_create', arguments: { text: 'Kept anyway', idempotency_key: 'k' } },
    ctx,
    { fetchTitle: noFetch, log: (f) => logs.push(f) }
  );
  assert.equal(result.replayed, false);
  assert.equal((await ctx.store.allNotes('u')).length, 1);
  assert.deepEqual(logs[0], { event: 'activity-unrecorded', kind: 'note', user: 'u' });
  assert.equal(logs[1]!.ActivityUnrecorded, 1);
  assert.ok(!JSON.stringify(logs).includes('Kept anyway'));
});
