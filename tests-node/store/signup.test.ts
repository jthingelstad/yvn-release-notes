import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
const email = 'ada@example.com';
const session = { pk: 'SESSION#h', sk: 'SESSION', email, expires_at: 200 };
test('verified signup creates profile/address and claims same live email session atomically', async () => {
  const s = new FakeStore([session], 'T');
  assert.equal(await s.createSubscriberVerified('u', email, { birthday: '1972-03-05' }, 'h', 100, 300), true);
  assert.equal((await s.profile('u'))?.birthday, '1972-03-05');
  assert.equal((await s.getSession('h', true))?.user_id, 'u');
  assert.equal((await s.getSession('h'))?.email, undefined);
  const call = s.memory.calls.find((c) => c.name === 'TransactWriteCommand')!.input as InstanceType<
    typeof TransactWriteCommand
  >['input'];
  assert.equal(call.TransactItems?.length, 4);
  assert.deepEqual(call.TransactItems?.[2], {
    Update: {
      TableName: 'T',
      Key: { pk: 'SESSION#h', sk: 'SESSION' },
      UpdateExpression: 'SET user_id = :u, seen_at = :now, expires_at = :exp REMOVE email',
      ConditionExpression:
        'attribute_exists(pk) AND expires_at > :now AND attribute_not_exists(user_id) AND email = :e',
      ExpressionAttributeValues: { ':u': 'u', ':e': email, ':now': 100, ':exp': 300 }
    }
  });
  const input = s.memory.calls.filter((c) => c.name === 'GetCommand').at(-2)?.input;
  assert.equal(input && 'ConsistentRead' in input && input.ConsistentRead, true);
});
test('revoked expired wrong-email or claimed signup proof leaves no account or index', async () => {
  for (const items of [
    [],
    [{ ...session, expires_at: 100 }],
    [{ ...session, email: 'wrong@example.com' }],
    [{ ...session, user_id: 'other' }],
    [session, { pk: `EMAIL#${email}`, sk: 'EMAIL', user_id: 'old' }]
  ]) {
    const s = new FakeStore(items, 'T');
    const before = s.memory.all();
    assert.equal(await s.createSubscriberVerified('u', email, {}, 'h', 100, 300), false);
    assert.deepEqual(s.memory.all(), before);
  }
});
