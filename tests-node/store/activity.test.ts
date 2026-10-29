/** The activity log's exact DynamoDB requests: one page merged from the
 * account's rows and its assistants' daily reads, writing rows, and what an
 * export reads. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
const profile = { pk: 'USER#u', sk: 'PROFILE', birthday: '1981-06-14', tz: 'America/Chicago', status: 'active' };
const proof = {
  ConditionCheck: {
    TableName: 'T',
    Key: { pk: 'USER#u', sk: 'PROFILE' },
    ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
  }
};

test('a page queries both partitions between its bounds, newest first', async () => {
  const s = new FakeStore([profile], 'T');
  s.memory.calls.length = 0;
  await s.activity('u', {
    before: '2026-10-12T10:00:00.000Z#mail#m2',
    from: '2026-10-01T05:00:00.000Z',
    limit: 50
  });
  const range = (pk: string) => ({
    name: 'QueryCommand',
    input: {
      TableName: 'T',
      KeyConditionExpression: 'pk = :p AND sk BETWEEN :lo AND :hi',
      ExpressionAttributeValues: {
        ':p': pk,
        ':lo': 'ACTIVITY#2026-10-01T05:00:00.000Z',
        ':hi': 'ACTIVITY#2026-10-12T10:00:00.000Z#mail#m2'
      },
      ScanIndexForward: false,
      Limit: 52
    }
  });
  assert.deepEqual(s.memory.calls, [range('USER#u'), range('MCPMETA#u')]);
  s.memory.calls.length = 0;
  await s.activity('u', { limit: 10 });
  assert.deepEqual((s.memory.calls[0]!.input as { ExpressionAttributeValues: unknown }).ExpressionAttributeValues, {
    ':p': 'USER#u',
    ':lo': 'ACTIVITY#',
    ':hi': 'ACTIVITY$'
  });
});

test('a page leaves out the row at `before`, merges by key and says when more remain', async () => {
  const s = new FakeStore([profile], 'T', 2),
    row = (pk: string, at: string, kind: string, id: string) =>
      s.seed({ pk, sk: `ACTIVITY#${at}#${kind}#${id}`, kind, at });
  row('USER#u', '2026-10-12T10:00:00.000Z', 'mail', 'a');
  row('USER#u', '2026-10-12T09:00:00.000Z', 'note.added', 'n');
  row('MCPMETA#u', '2026-10-12T05:00:00.000Z', 'reads', 'f');
  row('USER#u', '2026-10-11T10:00:00.000Z', 'mail', 'm1');
  row('USER#u', '2026-10-10T10:00:00.000Z', 'mail', 'm0');
  const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.sk).slice('ACTIVITY#'.length));
  const first = await s.activity('u', { limit: 2 });
  assert.deepEqual(
    [ids(first.rows), first.more],
    [['2026-10-12T10:00:00.000Z#mail#a', '2026-10-12T09:00:00.000Z#note.added#n'], true]
  );
  const second = await s.activity('u', { before: '2026-10-12T09:00:00.000Z#note.added#n', limit: 2 });
  assert.deepEqual(
    [ids(second.rows), second.more],
    [['2026-10-12T05:00:00.000Z#reads#f', '2026-10-11T10:00:00.000Z#mail#m1'], true]
  );
  const last = await s.activity('u', { before: '2026-10-11T10:00:00.000Z#mail#m1', limit: 2 });
  assert.deepEqual([ids(last.rows), last.more], [['2026-10-10T10:00:00.000Z#mail#m0'], false]);
  assert.equal(last.rows[0]!.kind, 'mail');
  assert.deepEqual(ids(await s.activityAll('u', '2026-10-12T00:00:00.000Z')), [
    '2026-10-12T10:00:00.000Z#mail#a',
    '2026-10-12T09:00:00.000Z#note.added#n',
    '2026-10-12T05:00:00.000Z#reads#f'
  ]);
});

test('a page reads on past a response DynamoDB cut short at 1 MB', async () => {
  const s = new FakeStore([profile], 'T');
  for (const hour of ['10', '09', '08', '07'])
    s.seed({
      pk: 'USER#u',
      sk: `ACTIVITY#2026-10-12T${hour}:00:00.000Z#mail#${hour}`,
      kind: 'mail',
      at: `2026-10-12T${hour}:00:00.000Z`
    });
  const send = s.memory.send.bind(s.memory);
  // Large mail rows: one row a response, whatever the limit asked for.
  s.memory.send = (command) => {
    const input = command.input as { Limit?: number };
    if (input.Limit) input.Limit = 1;
    return send(command);
  };
  const page = await s.activity('u', { limit: 2 });
  assert.deepEqual(
    [page.rows.map((r) => r.sk), page.more],
    [['ACTIVITY#2026-10-12T10:00:00.000Z#mail#10', 'ACTIVITY#2026-10-12T09:00:00.000Z#mail#09'], true]
  );
  assert.equal(s.memory.calls.filter((c) => c.input.ExpressionAttributeValues?.[':p'] === 'USER#u').length, 4);
});

test('activity rows go in with the account proof, each only if new, 90 to a transaction', async () => {
  const s = new FakeStore([profile], 'T'),
    row = (n: number) => ({
      pk: 'USER#u',
      sk: `ACTIVITY#2026-10-13T12:00:00.000Z#upcoming.added#d${String(n).padStart(3, '0')}`,
      kind: 'upcoming.added',
      at: '2026-10-13T12:00:00.000Z',
      via: 'web',
      upcoming: `d${n}`
    });
  s.memory.calls.length = 0;
  assert.equal(await s.putActivity('u', [row(1)]), true);
  assert.deepEqual(s.memory.calls, [
    {
      name: 'TransactWriteCommand',
      input: {
        TransactItems: [
          proof,
          { Put: { TableName: 'T', Item: row(1), ConditionExpression: 'attribute_not_exists(pk)' } }
        ]
      }
    }
  ]);
  s.memory.calls.length = 0;
  const many = Array.from({ length: 100 }, (_, i) => row(i + 2));
  assert.equal(await s.putActivity('u', many), true);
  assert.deepEqual(
    s.memory.calls.map((c) => (c.input.TransactItems as unknown[]).length),
    [91, 11]
  );
  // A row already there, or a deleting account, writes nothing.
  assert.equal(await s.putActivity('u', [row(1)]), false);
  s.seed({ ...profile, mcp_deleting: true });
  assert.equal(await s.putActivity('u', [row(500)]), false);
  assert.equal(await s.mailEntry('u', row(500).sk), null);
});

test('an export reads every account row and the daily reads, never other assistant metadata', async () => {
  const s = new FakeStore([profile], 'T');
  s.seed({ pk: 'MCPMETA#u', sk: 'ACTIVITY#2026-10-12T05:00:00.000Z#reads#f', kind: 'reads' });
  s.seed({ pk: 'MCPMETA#u', sk: 'USE#f', at: 1 });
  s.seed({ pk: 'MCPMETA#u', sk: 'LOG#000000000001#x', tool: 'notes_list' });
  s.memory.calls.length = 0;
  const items = await s.exportItems('u');
  assert.deepEqual(s.memory.calls, [
    {
      name: 'QueryCommand',
      input: { TableName: 'T', KeyConditionExpression: 'pk = :u', ExpressionAttributeValues: { ':u': 'USER#u' } }
    },
    {
      name: 'QueryCommand',
      input: {
        TableName: 'T',
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :a)',
        ExpressionAttributeValues: { ':p': 'MCPMETA#u', ':a': 'ACTIVITY#' }
      }
    }
  ]);
  assert.deepEqual(
    items.map((i) => `${String(i.pk)} ${String(i.sk)}`),
    ['USER#u PROFILE', 'MCPMETA#u ACTIVITY#2026-10-12T05:00:00.000Z#reads#f']
  );
});

test('badges read only the activity rows that earn one, with the fields they need', async () => {
  const s = new FakeStore([profile], 'T'),
    row = (kind: string, id: string, extra: Record<string, unknown> = {}) =>
      s.seed({
        pk: 'USER#u',
        sk: `ACTIVITY#2026-10-12T10:00:00.000Z#${kind}#${id}`,
        kind,
        at: '2026-10-12T10:00:00.000Z',
        ...extra
      });
  row('photo.set', 'p', { via: 'web' });
  row('photo.removed', 'q', { via: 'web' });
  row('export.book', 'b', { from: '2026-10-01', to: '2026-10-12' });
  row('upcoming.added', 'e', { via: 'web', upcoming: 'e' });
  row('upcoming.removed', 'e2', { via: 'web', upcoming: 'e' });
  row('note.edited', 'n1', { via: 'web', day: '2026-10-12', note: 'w-a' });
  row('note.edited', 'n2', { via: 'assistant', client: 'Claude', day: '2026-10-12', note: 'w-a' });
  row('mail', 'm', { via: 'email', subject: 'Fictional' });
  row('egg.found', 'g', { via: 'web', egg: 'rtfm' });
  s.memory.calls.length = 0;
  const rows = await s.badgeActivity('u', true);
  assert.deepEqual(s.memory.calls, [
    {
      name: 'QueryCommand',
      input: {
        TableName: 'T',
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        FilterExpression: '#k = :photo OR #k = :book OR #k = :added OR #k = :egg OR (#k = :edited AND #v = :assistant)',
        ProjectionExpression: 'sk, #k, #a, #v, #u, #e',
        ExpressionAttributeNames: { '#k': 'kind', '#a': 'at', '#v': 'via', '#u': 'upcoming', '#e': 'egg' },
        ExpressionAttributeValues: {
          ':p': 'USER#u',
          ':s': 'ACTIVITY#',
          ':photo': 'photo.set',
          ':book': 'export.book',
          ':added': 'upcoming.added',
          ':egg': 'egg.found',
          ':edited': 'note.edited',
          ':assistant': 'assistant'
        },
        ConsistentRead: true
      }
    }
  ]);
  assert.deepEqual(rows.map((r) => r.kind).sort(), [
    'egg.found',
    'export.book',
    'note.edited',
    'photo.set',
    'upcoming.added'
  ]);
  assert.equal(rows.find((r) => r.kind === 'egg.found')!.egg, 'rtfm');
  // Only the projected fields come back: no note, client or dates.
  assert.deepEqual(Object.keys(rows.find((r) => r.kind === 'note.edited')!).sort(), ['at', 'kind', 'sk', 'via']);
  s.memory.calls.length = 0;
  await s.badgeActivity('u');
  assert.equal((s.memory.calls[0]!.input as { ConsistentRead?: boolean }).ConsistentRead, undefined);
});

test('an egg is claimed on BADGES with its rows and the account proof, once', async () => {
  const s = new FakeStore([profile], 'T'),
    row = (id: string) => ({
      pk: 'USER#u',
      sk: `ACTIVITY#2026-10-29T12:00:00.000Z#egg.found#${id}`,
      kind: 'egg.found',
      at: '2026-10-29T12:00:00.000Z',
      via: 'web',
      egg: 'rtfm'
    }),
    at = '2026-10-29T12:00:00.000Z';
  s.memory.calls.length = 0;
  assert.equal(await s.findEgg('u', 'rtfm', [row('a')], at), true);
  assert.deepEqual(s.memory.calls, [
    {
      name: 'TransactWriteCommand',
      input: {
        TransactItems: [
          proof,
          {
            Update: {
              TableName: 'T',
              Key: { pk: 'USER#u', sk: 'BADGES' },
              UpdateExpression: 'ADD eggs :e SET updated_at = :t',
              ConditionExpression: 'attribute_not_exists(eggs) OR NOT contains(eggs, :egg)',
              ExpressionAttributeValues: { ':e': new Set(['rtfm']), ':egg': 'rtfm', ':t': at }
            }
          },
          { Put: { TableName: 'T', Item: row('a'), ConditionExpression: 'attribute_not_exists(pk)' } }
        ]
      }
    }
  ]);
  // Found again, under another row id (a second tab): nothing written.
  assert.equal(await s.findEgg('u', 'rtfm', [row('b')], at), false);
  assert.equal(s.memory.all().filter((i) => i.kind === 'egg.found').length, 1);
  // Another egg is its own.
  assert.equal(await s.findEgg('u', 'developer', [{ ...row('c'), egg: 'developer' }], at), true);
  assert.deepEqual([...(s.memory.read({ pk: 'USER#u', sk: 'BADGES' })!.eggs as Set<string>)].sort(), [
    'developer',
    'rtfm'
  ]);
  // A deleting account writes nothing.
  s.seed({ ...profile, mcp_deleting: true });
  s.memory.calls.length = 0;
  assert.equal(await s.findEgg('u', 'konami', [{ ...row('d'), egg: 'konami' }], at), false);
});
