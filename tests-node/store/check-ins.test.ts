/** Check-ins' exact DynamoDB requests (docs/CHECK-INS.md): what a report's
 * match, the later half of a stay and the remembered places read, and what a
 * write commits. The fake table runs the same in tests-node/api/v1-check-ins. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/backend/store.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';

function recorder() {
  const commands: StoreCommand[] = [],
    store = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return {};
        }
      },
      'T'
    );
  return { commands, store, only: () => commands.map((c) => [c.constructor.name, c.input]) };
}
const proof = {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
    }
  },
  writer = {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'APITOKEN#a' },
      ConditionExpression: 'attribute_exists(pk)'
    }
  },
  receipt = { Put: { TableName: 'T', Item: { pk: 'USER#u', sk: 'CAPTURE#api#h' } } },
  guard = (revision: number) => ({
    ConditionExpression: '#revision = :revision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':revision': revision }
  }),
  item = (sk: string, revision = 1) => ({ pk: 'USER#u', sk, revision });

test('a report looks for its stay by the second it began', async () => {
  const r = recorder();
  await r.store.checkInsAt('u', '2026-10-12T14:00:00');
  assert.deepEqual(r.only(), [
    [
      'QueryCommand',
      {
        TableName: 'T',
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': 'USER#u', ':s': 'CHECKIN#2026-10-12T14:00:00' },
        ConsistentRead: true
      }
    ]
  ]);
});

test('check-ins read down from a cursor and up from one', async () => {
  const r = recorder();
  await r.store.checkInsBelow('u', undefined, 100);
  await r.store.checkInsBelow('u', '2026-10-12T14:00:00.000Z#c1-a', 20);
  await r.store.checkInsAbove('u', '2026-10-12T14:00:00.000Z#c1-a', 20);
  const query = (lo: string, hi: string, forward: boolean, Limit: number) => [
    'QueryCommand',
    {
      TableName: 'T',
      KeyConditionExpression: 'pk = :p AND sk BETWEEN :lo AND :hi',
      ExpressionAttributeValues: { ':p': 'USER#u', ':lo': lo, ':hi': hi },
      ScanIndexForward: forward,
      ConsistentRead: true,
      Limit
    }
  ];
  assert.deepEqual(r.only(), [
    query('CHECKIN#', 'CHECKIN$', false, 102),
    query('CHECKIN#', 'CHECKIN#2026-10-12T14:00:00.000Z#c1-a', false, 22),
    query('CHECKIN#2026-10-12T14:00:00.000Z#c1-a', 'CHECKIN$', true, 22)
  ]);
});

test('the remembered places are read whole', async () => {
  const r = recorder();
  await r.store.namedPlaces('u');
  assert.deepEqual(r.only(), [
    [
      'QueryCommand',
      {
        TableName: 'T',
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
        ExpressionAttributeValues: { ':p': 'USER#u', ':s': 'NAMEDPLACE#' },
        ConsistentRead: true
      }
    ]
  ]);
});

test('a new one, a changed one and a deleted one, each with both proofs and the receipt', async () => {
  const r = recorder(),
    fresh = item('CHECKIN#2026-10-12T14:00:00.000Z#c1-a'),
    old = item('CHECKIN#2026-10-11T14:00:00.000Z#c2-a', 2),
    changed = { ...old, left: '2026-10-11T15:00:00.000Z', revision: 3 },
    gone = item('NAMEDPLACE#p-a', 4);
  assert.equal(
    await r.store.checkInWrites('u', [{ next: fresh }, { next: changed, old }, { old: gone }], [writer], [receipt]),
    true
  );
  assert.deepEqual(r.only(), [
    [
      'TransactWriteCommand',
      {
        TransactItems: [
          proof,
          writer,
          { Put: { TableName: 'T', Item: fresh, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: 'T', Item: changed, ...guard(2) } },
          { Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: 'NAMEDPLACE#p-a' }, ...guard(4) } },
          receipt
        ]
      }
    ]
  ]);
});

test('nothing to change still proves the writer and writes the receipt', async () => {
  const r = recorder();
  assert.equal(await r.store.checkInWrites('u', [], [writer], [receipt]), true);
  assert.deepEqual(r.only(), [['TransactWriteCommand', { TransactItems: [proof, writer, receipt] }]]);
});

test('a long list goes 90 at a time, with the receipt on the last', async () => {
  const r = recorder(),
    many = Array.from({ length: 95 }, (_, i) => ({ old: item(`CHECKIN#2026-10-12T14:00:00.000Z#c${i}-a`) }));
  assert.equal(await r.store.checkInWrites('u', many, [writer], [receipt]), true);
  const sizes = r.only().map(([, input]) => (input as { TransactItems: unknown[] }).TransactItems);
  assert.deepEqual(
    sizes.map((ops) => ops.length),
    [92, 8]
  );
  assert.ok(!sizes[0]!.includes(receipt));
  assert.equal(sizes[1]!.at(-1), receipt);
});
