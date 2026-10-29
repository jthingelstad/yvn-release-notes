/** Exact DocumentClient shapes for filing feedback (row, daily count, the item
 * it follows, the web proofs) and for an answer's revision-checked append. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/backend/store.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
import type { FeedbackItem } from '../../packages/domain/feedback.ts';

const item: FeedbackItem = {
  id: '0123456789abcdef',
  kind: 'bug',
  text: 'Fictional words',
  status: 'open',
  follows: 'fedcba9876543210',
  via: 'web',
  filed_at: '2026-10-28T12:00:00.000Z',
  updated_at: '2026-10-28T12:00:00.000Z',
  revision: 1,
  answers: [],
  screenshots: [
    { n: 1, type: 'image/png', size: 10, width: 2, height: 3, key: 'media/u/feedback/0123456789abcdef-1.png' }
  ]
};
function recording() {
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
  return { commands, raw };
}

test('filing commits the row, the capped daily count, the followed item and the live account and session together', async () => {
  const { commands, raw } = recording();
  const store = withWebProof(raw, 'u', 'hash', 100);
  assert.equal(await store.fileFeedback('u', item, '2026-10-28'), true);
  assert.equal(commands[0]!.constructor.name, 'TransactWriteCommand');
  assert.deepEqual(commands[0]!.input, {
    TransactItems: [
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'USER#u', sk: 'FEEDBACK#0123456789abcdef', ...item },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'FEEDBACKRATE#2026-10-28' },
          UpdateExpression: 'ADD #n :one SET expires_at = :expires',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :cap',
          ExpressionAttributeNames: { '#n': 'n' },
          ExpressionAttributeValues: { ':one': 1, ':cap': 10, ':expires': 1793318400 }
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression:
            '(attribute_exists(pk) AND attribute_not_exists(mcp_deleting)) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))',
          ExpressionAttributeNames: { '#webDeleting': 'mcp_deleting' }
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'FEEDBACK#fedcba9876543210' },
          ConditionExpression: 'attribute_exists(pk)'
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

test('an answer appends to the list at the revision read, with the administrator still the configured account', async () => {
  const { commands, raw } = recording();
  const answer = { at: '2026-10-28T13:00:00.000Z', text: 'Fixed', status: 'done' as const };
  assert.equal(
    await raw.answerFeedback('o', '0123456789abcdef', 2, answer, { user: 'a', email: 'ada@example.com' }),
    true
  );
  assert.deepEqual(commands[0]!.input, {
    TransactItems: [
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#o', sk: 'FEEDBACK#0123456789abcdef' },
          UpdateExpression:
            'SET #a = list_append(if_not_exists(#a, :none), :answer), #s = :status, #u = :at, #r = :next',
          ConditionExpression: 'attribute_exists(pk) AND #r = :revision',
          ExpressionAttributeNames: { '#a': 'answers', '#s': 'status', '#u': 'updated_at', '#r': 'revision' },
          ExpressionAttributeValues: {
            ':none': [],
            ':answer': [answer],
            ':status': 'done',
            ':at': '2026-10-28T13:00:00.000Z',
            ':next': 3,
            ':revision': 2
          }
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#a', sk: 'PROFILE' },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND email = :admin',
          ExpressionAttributeValues: { ':admin': 'ada@example.com' }
        }
      }
    ]
  });
});

test('reads are consistent: the account query, one item and the day count', async () => {
  const { commands, raw } = recording();
  assert.deepEqual(await raw.feedbackItems('u'), []);
  assert.equal(await raw.feedbackItem('u', '0123456789abcdef'), null);
  assert.equal(await raw.feedbackFiled('u', '2026-10-28'), 0);
  assert.deepEqual(commands[0]!.input, {
    TableName: 'T',
    KeyConditionExpression: 'pk = :p AND begins_with(sk, :s)',
    ExpressionAttributeValues: { ':p': 'USER#u', ':s': 'FEEDBACK#' },
    ConsistentRead: true
  });
  assert.deepEqual(commands[1]!.input, {
    TableName: 'T',
    Key: { pk: 'USER#u', sk: 'FEEDBACK#0123456789abcdef' },
    ConsistentRead: true
  });
  assert.deepEqual(commands[2]!.input, {
    TableName: 'T',
    Key: { pk: 'USER#u', sk: 'FEEDBACKRATE#2026-10-28' },
    ConsistentRead: true
  });
});

test("the queue's account scan reads only metadata the overview's IAM limit allows", async () => {
  const { commands, raw } = recording();
  assert.deepEqual(await raw.accountStates(), []);
  assert.equal(commands[0]!.constructor.name, 'ScanCommand');
  assert.deepEqual(commands[0]!.input, {
    TableName: 'T',
    Select: 'SPECIFIC_ATTRIBUTES',
    FilterExpression: 'begins_with(pk, :u) AND sk = :p',
    ProjectionExpression: 'pk, email, #st, mcp_deleting',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE' }
  });
});
