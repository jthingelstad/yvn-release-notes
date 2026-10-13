/** Exact DocumentClient shapes for the global date slot and revision CAS. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/backend/store.ts';
import type { ProductUpdate } from '../../packages/domain/product-updates.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
const draft: ProductUpdate = {
  id: 'update',
  title: 'A change',
  text: 'Fictional words',
  links: [],
  revision: 1,
  status: 'draft',
  date: null,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
test('scheduled snapshot and revision are committed with exact native values and live admin/account/session proofs', async () => {
  const commands: StoreCommand[] = [];
  const raw = new Store(
    {
      send: async (c) => {
        commands.push(c);
        return {};
      }
    },
    'T'
  );
  const store = withWebProof(raw, 'u', 'hash', 100);
  const scheduled: ProductUpdate = { ...draft, revision: 2, status: 'scheduled', date: '2026-10-14' };
  assert.equal(await store.saveProductUpdate('u', 'ada@example.com', scheduled, draft), true);
  assert.equal(commands[0]!.constructor.name, 'TransactWriteCommand');
  assert.deepEqual(commands[0]!.input, {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression:
            '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND email = :admin) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeValues: { ':admin': 'ada@example.com' },
          ExpressionAttributeNames: { '#webDeleting': 'mcp_deleting' }
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'PRODUCT#UPDATES', sk: 'UPDATE#update', ...scheduled },
          ConditionExpression: '#revision = :revision',
          ExpressionAttributeNames: { '#revision': 'revision' },
          ExpressionAttributeValues: { ':revision': 1 }
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'PRODUCT#UPDATES', sk: 'DATE#2026-10-14', ...scheduled },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'SESSION#hash', sk: 'SESSION' },
          ConditionExpression: 'attribute_exists(pk) AND #webUser = :webUser AND #webExpires > :webNow',
          ExpressionAttributeNames: { '#webUser': 'user_id', '#webExpires': 'expires_at' },
          ExpressionAttributeValues: { ':webUser': 'u', ':webNow': 100 }
        }
      }
    ]
  });
});
test('snapshot read is consistent and date-specific; draft listing pages with a native exclusive key', async () => {
  const commands: StoreCommand[] = [];
  const store = new Store(
    {
      send: async (c) => {
        commands.push(c);
        return c.constructor.name === 'GetCommand'
          ? { Item: { pk: 'PRODUCT#UPDATES', sk: 'DATE#2026-10-14', ...draft } }
          : commands.length === 2
            ? { Items: [], LastEvaluatedKey: { pk: 'PRODUCT#UPDATES', sk: 'UPDATE#first' } }
            : { Items: [{ pk: 'PRODUCT#UPDATES', sk: 'UPDATE#update', ...draft }] };
      }
    },
    'T'
  );
  assert.deepEqual(await store.scheduledProductUpdate('2026-10-14'), draft);
  assert.deepEqual(commands[0]!.input, {
    TableName: 'T',
    Key: { pk: 'PRODUCT#UPDATES', sk: 'DATE#2026-10-14' },
    ConsistentRead: true
  });
  assert.deepEqual(await store.productUpdates(), [draft]);
  const query = {
    TableName: 'T',
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'PRODUCT#UPDATES', ':s': 'UPDATE#' },
    ConsistentRead: true
  };
  assert.deepEqual(commands[1]!.input, query);
  assert.deepEqual(commands[2]!.input, { ...query, ExclusiveStartKey: { pk: 'PRODUCT#UPDATES', sk: 'UPDATE#first' } });
});
