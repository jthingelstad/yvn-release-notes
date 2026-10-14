/** Turnstile verdict rows (TURNSTILE#<token hash> / VERDICT): exact SDK shapes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';

const now = Date.parse('2026-10-14T12:00:00Z') / 1000;

test('verdict rows have exact DynamoDB request shapes', async () => {
  const store = new FakeStore([], 'T');
  assert.equal(
    await store.saveTurnstileVerdict('h', { result: 'pass', email_hash: 'e', codes: '', now, ttl: 600 }),
    true
  );
  assert.equal(
    await store.saveTurnstileVerdict('h', { result: 'fail', email_hash: 'e', codes: '', now, ttl: 600 }),
    false
  );
  assert.equal(await store.useTurnstileVerdict('h', 'other', 3), false);
  assert.equal(await store.useTurnstileVerdict('h', 'e', 3), true);
  assert.equal(await store.useTurnstileVerdict('h', 'e', 3), true);
  assert.equal(await store.useTurnstileVerdict('h', 'e', 3), false);
  const inputs = store.memory.calls.map((c) => c.input);
  assert.deepEqual(inputs[0], {
    TableName: 'T',
    Item: {
      pk: 'TURNSTILE#h',
      sk: 'VERDICT',
      result: 'pass',
      email_hash: 'e',
      codes: '',
      uses: 1,
      verified_at: now,
      expires_at: now + 600
    },
    ConditionExpression: 'attribute_not_exists(pk)'
  });
  assert.deepEqual(inputs[3], {
    TableName: 'T',
    Key: { pk: 'TURNSTILE#h', sk: 'VERDICT' },
    UpdateExpression: 'ADD uses :one',
    ConditionExpression: 'email_hash = :email AND uses < :max',
    ExpressionAttributeValues: { ':one': 1, ':email': 'e', ':max': 3 }
  });
  assert.equal((await store.turnstileVerdict('h'))?.uses, 3);
});
