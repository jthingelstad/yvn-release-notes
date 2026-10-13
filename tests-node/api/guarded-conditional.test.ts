/** Exercise conditional counter refusal through the real HTTP guard, plus the
 * SDK reason boundary that must never hide an account/session or service error. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { Store } from '../../packages/backend/store.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import { createApp } from '../../server/app/app.ts';
import * as auth from '../../packages/backend/auth.ts';
test('native HTTP upload count and byte ceilings return 429; refused forms consume no counter', async () => {
  const now = Date.parse('2026-10-13T12:00:00Z') / 1000,
    origin = 'https://notes.example.com';
  for (const [size, accepted] of [
    [1, 200],
    [50 * 1024 ** 2, 40]
  ]) {
    const store = new FakeStore([
        { pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com', birthday: '1981-06-14', status: 'active', tz: 'UTC' }
      ]),
      token = auth.newToken();
    await store.createSession(auth.digest(token), { user_id: 'u', now, expires: auth.sessionExpiry(now) });
    const app = createApp({
      context: () => ({
        store,
        objects: new FakeObjects(),
        mail: new FakeMail(),
        invocations: new FakeInvocations(),
        now,
        origin,
        from: 'notes@example.com',
        inboundDomain: 'in.example.com',
        senderFunction: 'sender',
        exportFunction: 'export',
        weatherFetch: async () => ({}),
        fetchTitle: () => null,
        log: () => {}
      })
    });
    const upload = () =>
      app.request('/api/uploads', {
        method: 'POST',
        headers: { origin, cookie: `${auth.COOKIE}=${token}` },
        body: JSON.stringify({ name: 'a.pdf', type: 'application/pdf', size })
      });
    for (let n = 0; n < accepted!; n++) assert.equal((await upload()).status, 200);
    const before = store.memory.all(),
      refused = await upload();
    assert.equal(refused.status, 429);
    assert.equal((await refused.json()).error, 'upload-limit');
    assert.deepEqual(store.memory.all(), before);
  }
});
test('web guard restores only an independent primary conditional error and preserves proof, SDK and merged failures', async () => {
  let error: Error;
  const source = new Store(
      {
        send: async () => {
          throw error;
        }
      },
      'T'
    ),
    guarded = withWebProof(source, 'u', 'h', 1);
  const cancelled = (codes?: string[]) =>
    Object.assign(new Error('private SDK diagnostic'), {
      name: 'TransactionCanceledException',
      ...(codes ? { CancellationReasons: codes.map((Code) => ({ Code })) } : {})
    });
  error = cancelled(['ConditionalCheckFailed', 'None', 'None']);
  assert.equal(await guarded.countUpload('u', 1, 1, 1, 1), false);
  for (const refused of [
    cancelled(['None', 'ConditionalCheckFailed', 'None']),
    cancelled(['None', 'None', 'ConditionalCheckFailed']),
    cancelled(['ConditionalCheckFailed', 'None', 'ConditionalCheckFailed']),
    cancelled(['TransactionConflict', 'None', 'None']),
    cancelled(['ConditionalCheckFailed']),
    cancelled(),
    Object.assign(new Error('SDK validation'), { name: 'ValidationException' })
  ]) {
    error = refused;
    await assert.rejects(
      () => guarded.countUpload('u', 1, 1, 1, 1),
      (received) => received === refused
    );
  }
  error = cancelled(['ConditionalCheckFailed', 'None']);
  await assert.rejects(
    () => guarded.claimDay('u', '2026-10-13'),
    (received) => received === error
  );
  error = cancelled(['ConditionalCheckFailed', 'None', 'None']);
  await assert.rejects(
    () =>
      guarded.client.send(
        new TransactWriteCommand({
          TransactItems: [{ Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: 'NOTE#day#n' } } }]
        })
      ),
    (received) => received === error
  );
});
