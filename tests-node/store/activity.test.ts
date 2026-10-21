/** The activity log's exact DynamoDB requests: one page merged from the
 * account's rows, its assistants' daily reads and the mail rows from before
 * the log; moving one of those; and what an export reads. */
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
const legacy = {
  pk: 'USER#u',
  sk: 'MAILLOG#2026-10-11T10:00:00.000Z#m1',
  message: 'm1',
  received_at: '2026-10-11T10:00:00.000Z',
  via: 'reply',
  outcome: 'filed',
  expires_at: 2000
};

test('a page queries both partitions between its bounds, newest first, and the old mail rows whole', async () => {
  const s = new FakeStore([profile], 'T');
  s.memory.calls.length = 0;
  await s.activity('u', {
    before: '2026-10-12T10:00:00.000Z#mail#m2',
    from: '2026-10-01T05:00:00.000Z',
    limit: 50,
    now: 1000
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
  assert.deepEqual(s.memory.calls, [
    range('USER#u'),
    range('MCPMETA#u'),
    {
      name: 'QueryCommand',
      input: {
        TableName: 'T',
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :m)',
        ExpressionAttributeValues: { ':u': 'USER#u', ':m': 'MAILLOG#' }
      }
    }
  ]);
  s.memory.calls.length = 0;
  await s.activity('u', { limit: 10, now: 1000 });
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
  s.seed(legacy);
  s.seed({
    ...legacy,
    sk: 'MAILLOG#2026-10-10T10:00:00.000Z#m0',
    message: 'm0',
    received_at: '2026-10-10T10:00:00.000Z'
  });
  s.seed({ ...legacy, sk: 'MAILLOG#2026-09-01T10:00:00.000Z#gone', message: 'gone', expires_at: 999 });
  const ids = (rows: Record<string, unknown>[]) => rows.map((r) => String(r.sk).slice('ACTIVITY#'.length));
  const first = await s.activity('u', { limit: 2, now: 1000 });
  assert.deepEqual(
    [ids(first.rows), first.more],
    [['2026-10-12T10:00:00.000Z#mail#a', '2026-10-12T09:00:00.000Z#note.added#n'], true]
  );
  const second = await s.activity('u', { before: '2026-10-12T09:00:00.000Z#note.added#n', limit: 2, now: 1000 });
  // The moved row and its old copy count once.
  assert.deepEqual(
    [ids(second.rows), second.more],
    [['2026-10-12T05:00:00.000Z#reads#f', '2026-10-11T10:00:00.000Z#mail#m1'], true]
  );
  const last = await s.activity('u', { before: '2026-10-11T10:00:00.000Z#mail#m1', limit: 2, now: 1000 });
  assert.deepEqual([ids(last.rows), last.more], [['2026-10-10T10:00:00.000Z#mail#m0'], false]);
  assert.equal(last.rows[0]!.kind, 'mail');
  assert.deepEqual(ids(await s.activityAll('u', 1000, '2026-10-12T00:00:00.000Z')), [
    '2026-10-12T10:00:00.000Z#mail#a',
    '2026-10-12T09:00:00.000Z#note.added#n',
    '2026-10-12T05:00:00.000Z#reads#f'
  ]);
});

test('moving an old mail row puts it in the log without its expiry and deletes it, with the account proof', async () => {
  const s = new FakeStore([profile], 'T');
  s.seed(legacy);
  s.memory.calls.length = 0;
  assert.equal(await s.moveMail('u', legacy), 'moved');
  const fields = { message: 'm1', received_at: '2026-10-11T10:00:00.000Z', via: 'reply', outcome: 'filed' };
  assert.deepEqual(s.memory.calls, [
    {
      name: 'GetCommand',
      input: {
        TableName: 'T',
        Key: { pk: 'USER#u', sk: 'ACTIVITY#2026-10-11T10:00:00.000Z#mail#m1' },
        ConsistentRead: true
      }
    },
    {
      name: 'TransactWriteCommand',
      input: {
        TransactItems: [
          proof,
          {
            Put: {
              TableName: 'T',
              Item: {
                ...fields,
                pk: 'USER#u',
                sk: 'ACTIVITY#2026-10-11T10:00:00.000Z#mail#m1',
                kind: 'mail',
                at: '2026-10-11T10:00:00.000Z'
              },
              ConditionExpression: 'attribute_not_exists(pk)'
            }
          },
          { Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: 'MAILLOG#2026-10-11T10:00:00.000Z#m1' } } }
        ]
      }
    }
  ]);
  assert.equal(await s.mailEntry('u', 'MAILLOG#2026-10-11T10:00:00.000Z#m1'), null);
  // A row already moved by an earlier try keeps its newer fields; the old one goes.
  s.seed({ ...legacy, outcome: 'failed' });
  s.memory.calls.length = 0;
  assert.equal(await s.moveMail('u', { ...legacy, outcome: 'failed' }), 'kept');
  assert.deepEqual(s.memory.calls.at(-1), {
    name: 'TransactWriteCommand',
    input: {
      TransactItems: [proof, { Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: legacy.sk } } }]
    }
  });
  assert.equal((await s.mailEntry('u', 'ACTIVITY#2026-10-11T10:00:00.000Z#mail#m1'))!.outcome, 'filed');
  // A deleting account moves nothing.
  s.seed({ ...profile, mcp_deleting: true });
  s.seed({
    ...legacy,
    sk: 'MAILLOG#2026-10-10T10:00:00.000Z#m0',
    message: 'm0',
    received_at: '2026-10-10T10:00:00.000Z'
  });
  assert.equal(
    await s.moveMail('u', {
      ...legacy,
      sk: 'MAILLOG#2026-10-10T10:00:00.000Z#m0',
      message: 'm0',
      received_at: '2026-10-10T10:00:00.000Z'
    }),
    'gone'
  );
  assert.equal(await s.mailEntry('u', 'ACTIVITY#2026-10-10T10:00:00.000Z#mail#m0'), null);
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
