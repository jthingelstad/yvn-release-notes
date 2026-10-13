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
