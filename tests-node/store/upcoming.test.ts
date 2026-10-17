/** Exact DynamoDB shapes, including merged profile/session proofs and CAS. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/backend/store.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';
import type { UpcomingEntry } from '../../packages/domain/upcoming.ts';
const entry: UpcomingEntry = {
  id: 'date',
  kind: 'event',
  tag: null,
  title: 'Concert',
  date: '2026-10-20',
  year: null,
  end_date: null,
  place: null,
  email: true,
  reminders: [7, 1, 0],
  revision: 1,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
const session = {
  ConditionCheck: {
    TableName: 'T',
    Key: { pk: 'SESSION#hash', sk: 'SESSION' },
    ConditionExpression: 'attribute_exists(pk) AND #webUser = :webUser AND #webExpires > :webNow',
    ExpressionAttributeNames: { '#webUser': 'user_id', '#webExpires': 'expires_at' },
    ExpressionAttributeValues: { ':webUser': 'u', ':webNow': 100 }
  }
};
test('create commits native entry/count/live proofs together; edit/delete use exact revision conditions', async () => {
  const commands: StoreCommand[] = [],
    raw = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return {};
        }
      },
      'T'
    ),
    store = withWebProof(raw, 'u', 'hash', 100);
  assert.equal(await store.saveUpcoming('u', entry, null), true);
  assert.equal(commands[0]!.constructor.name, 'TransactWriteCommand');
  assert.deepEqual(commands[0]!.input, {
    TransactItems: [
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'USER#u', sk: 'UPCOMING#date', ...entry },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :change',
          ConditionExpression:
            '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#count) OR #count < :max)) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#count': 'upcoming_count', '#webDeleting': 'mcp_deleting' },
          ExpressionAttributeValues: { ':zero': 0, ':change': 1, ':max': 200 }
        }
      },
      session
    ]
  });
  const next = { ...entry, revision: 2, title: 'Edited' };
  const guard = {
    ConditionExpression: '#revision = :revision',
    ExpressionAttributeNames: { '#revision': 'revision' },
    ExpressionAttributeValues: { ':revision': 1 }
  };
  assert.equal(await store.saveUpcoming('u', next, entry), true);
  assert.deepEqual(commands[1]!.input, {
    TransactItems: [
      { Put: { TableName: 'T', Item: { pk: 'USER#u', sk: 'UPCOMING#date', ...next }, ...guard } },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression:
            '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting)) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#webDeleting': 'mcp_deleting' }
        }
      },
      session
    ]
  });
  assert.equal(await store.saveUpcoming('u', null, entry), true);
  assert.deepEqual(commands[2]!.input, {
    TransactItems: [
      { Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: 'UPCOMING#date' }, ...guard } },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :change',
          ConditionExpression:
            '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND #count > :zero) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#count': 'upcoming_count', '#webDeleting': 'mcp_deleting' },
          ExpressionAttributeValues: { ':zero': 0, ':change': -1 }
        }
      },
      session
    ]
  });
});
test('consistent owner-prefix queries paginate with exact native keys and return only entry fields', async () => {
  const commands: StoreCommand[] = [],
    store = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return commands.length === 1
            ? { Items: [], LastEvaluatedKey: { pk: 'USER#u', sk: 'UPCOMING#first' } }
            : c.constructor.name === 'GetCommand'
              ? { Item: { pk: 'USER#u', sk: 'UPCOMING#date', ...entry } }
              : { Items: [{ pk: 'USER#u', sk: 'UPCOMING#date', ...entry }] };
        }
      },
      'T'
    );
  assert.deepEqual(await store.upcomingEntries('u'), [entry]);
  const query = {
    TableName: 'T',
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'USER#u', ':s': 'UPCOMING#' },
    ConsistentRead: true
  };
  assert.deepEqual(commands[0]!.input, query);
  assert.deepEqual(commands[1]!.input, { ...query, ExclusiveStartKey: { pk: 'USER#u', sk: 'UPCOMING#first' } });
  assert.deepEqual(await store.upcoming('u', 'date'), entry);
  assert.deepEqual(commands[2]!.input, {
    TableName: 'T',
    Key: { pk: 'USER#u', sk: 'UPCOMING#date' },
    ConsistentRead: true
  });
});
test('calendar link rows commit with the profile pointer and live proofs; removal needs the pointer', async () => {
  const commands: StoreCommand[] = [],
    raw = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return {};
        }
      },
      'T'
    ),
    store = withWebProof(raw, 'u', 'hash', 100);
  assert.equal(await store.setCalendar('u', 'new', 'now', 'old'), true);
  assert.equal(commands[0]!.constructor.name, 'TransactWriteCommand');
  assert.deepEqual(commands[0]!.input, {
    TransactItems: [
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'CALENDAR#new', sk: 'CALENDAR', user_id: 'u', created_at: 'now' },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'SET calendar = :t',
          ConditionExpression:
            '(attribute_exists(pk) AND calendar = :old) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#webDeleting': 'mcp_deleting' },
          ExpressionAttributeValues: { ':t': 'new', ':old': 'old' }
        }
      },
      { Delete: { TableName: 'T', Key: { pk: 'CALENDAR#old', sk: 'CALENDAR' } } },
      session
    ]
  });
  assert.equal(await store.dropCalendar('u', 'new'), true);
  assert.deepEqual(commands[1]!.input, {
    TransactItems: [
      { Delete: { TableName: 'T', Key: { pk: 'CALENDAR#new', sk: 'CALENDAR' } } },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'REMOVE calendar',
          ConditionExpression:
            '(attribute_exists(pk) AND calendar = :t) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#webDeleting': 'mcp_deleting' },
          ExpressionAttributeValues: { ':t': 'new' }
        }
      },
      session
    ]
  });
});
test('a batch commits adds, changes and removes with each guard and one net count move; long batches chunk', async () => {
  const commands: StoreCommand[] = [],
    raw = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return {};
        }
      },
      'T'
    ),
    store = withWebProof(raw, 'u', 'hash', 100),
    other = { ...entry, id: 'old', revision: 3 };
  assert.deepEqual(
    await store.upcomingBatch('u', [
      { next: null, previous: other },
      { next: { ...entry, revision: 2 }, previous: entry },
      { next: { ...entry, id: 'new' }, previous: null },
      { next: { ...entry, id: 'new2' }, previous: null }
    ]),
    { ok: true, applied: 4 }
  );
  assert.equal(commands.length, 1);
  const items = (commands[0]!.input as { TransactItems: Record<string, unknown>[] }).TransactItems;
  assert.deepEqual(items[0], {
    Delete: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'UPCOMING#old' },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':revision': 3 }
    }
  });
  assert.deepEqual(items[1], {
    Put: {
      TableName: 'T',
      Item: { pk: 'USER#u', sk: 'UPCOMING#date', ...entry, revision: 2 },
      ConditionExpression: '#revision = :revision',
      ExpressionAttributeNames: { '#revision': 'revision' },
      ExpressionAttributeValues: { ':revision': 1 }
    }
  });
  assert.deepEqual(items[2], {
    Put: {
      TableName: 'T',
      Item: { pk: 'USER#u', sk: 'UPCOMING#new', ...entry, id: 'new' },
      ConditionExpression: 'attribute_not_exists(pk)'
    }
  });
  assert.deepEqual(items[4], {
    Update: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :change',
      ConditionExpression:
        '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#count) OR #count <= :room)) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
      ExpressionAttributeNames: { '#count': 'upcoming_count', '#webDeleting': 'mcp_deleting' },
      ExpressionAttributeValues: { ':zero': 0, ':change': 1, ':room': 199 }
    }
  });
  assert.deepEqual(items[5], session);
  assert.equal(items.length, 6);
  // Removing more than adding lowers the count and needs that many saved.
  commands.length = 0;
  await store.upcomingBatch('u', [
    { next: null, previous: other },
    { next: null, previous: entry }
  ]);
  const lower = (commands[0]!.input as { TransactItems: Record<string, unknown>[] }).TransactItems[2] as {
    Update: { ConditionExpression: string; ExpressionAttributeValues: Record<string, number> };
  };
  assert.match(lower.Update.ConditionExpression, /#count >= :need/);
  assert.equal(lower.Update.ExpressionAttributeValues[':need'], 2);
  // Changes only: the live-account proof instead of a count move.
  commands.length = 0;
  await store.upcomingBatch('u', [{ next: { ...entry, revision: 2 }, previous: entry }]);
  const proof = (commands[0]!.input as { TransactItems: Record<string, unknown>[] }).TransactItems[1] as {
    ConditionCheck: { Key: { sk: string } };
  };
  assert.equal(proof.ConditionCheck.Key.sk, 'PROFILE');
  // 95 adds take two transactions, 90 then 5, each moving the count by its own size.
  commands.length = 0;
  const many = Array.from({ length: 95 }, (_, i) => ({ next: { ...entry, id: 'n' + i }, previous: null }));
  assert.deepEqual(await store.upcomingBatch('u', many), { ok: true, applied: 95 });
  assert.equal(commands.length, 2);
  const sizes = commands.map((c) => (c.input as { TransactItems: unknown[] }).TransactItems.length);
  assert.deepEqual(sizes, [92, 7]);
  await assert.rejects(raw.upcomingBatch('u', many, [session]), RangeError);
  // A refused second chunk reports what the first committed.
  let calls = 0;
  const flaky = withWebProof(
    new Store(
      {
        send: async () => {
          if (++calls === 2) {
            const e = new Error('cancelled');
            e.name = 'TransactionCanceledException';
            Object.assign(e, { CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
            throw e;
          }
          return {};
        }
      },
      'T'
    ),
    'u',
    'hash',
    100
  );
  assert.deepEqual(await flaky.upcomingBatch('u', many), { ok: false, applied: 90 });
  assert.deepEqual(await store.upcomingBatch('u', []), { ok: true, applied: 0 });
});
