/** Exact DynamoDB shapes for the profile photo (profile-photo.ts): a set or
 * replace conditioned on the photo read, a removal on the same, each with the
 * web proofs merged into the profile's own condition. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../packages/backend/store.ts';
import { withWebProof } from '../../packages/backend/guarded-store.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';
const session = {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'SESSION#hash', sk: 'SESSION' },
      ConditionExpression: 'attribute_exists(pk) AND #webUser = :webUser AND #webExpires > :webNow',
      ExpressionAttributeNames: { '#webUser': 'user_id', '#webExpires': 'expires_at' },
      ExpressionAttributeValues: { ':webUser': 'u', ':webNow': 100 }
    }
  },
  photo = { key: 'media/u/profile/b.jpg', at: '2026-10-28T12:00:00.000Z', size: 4000, side: 512 };
test('a first photo, a replacement and a removal each name the photo read, with the web proofs', async () => {
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
  assert.equal(await store.setPhoto('u', photo, null), true);
  assert.equal(await store.setPhoto('u', photo, 'media/u/profile/a.jpg'), true);
  assert.equal(await store.dropPhoto('u', 'media/u/profile/b.jpg'), true);
  assert.deepEqual(
    commands.map((c) => c.constructor.name),
    ['TransactWriteCommand', 'TransactWriteCommand', 'TransactWriteCommand']
  );
  const profile = (condition: string, names: Record<string, string>, values: Record<string, unknown>, set = true) => ({
    TransactItems: [
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: set ? 'SET #photo = :photo' : 'REMOVE #photo',
          ConditionExpression: `(${condition}) AND (attribute_exists(pk) AND attribute_not_exists(#webDeleting))`,
          ExpressionAttributeNames: { ...names, '#webDeleting': 'mcp_deleting' },
          ExpressionAttributeValues: values
        }
      },
      session
    ]
  });
  assert.deepEqual(
    commands[0]!.input,
    profile('attribute_exists(pk) AND attribute_not_exists(#photo)', { '#photo': 'photo' }, { ':photo': photo })
  );
  assert.deepEqual(
    commands[1]!.input,
    profile(
      'attribute_exists(pk) AND #photo.#key = :old',
      { '#photo': 'photo', '#key': 'key' },
      { ':photo': photo, ':old': 'media/u/profile/a.jpg' }
    )
  );
  assert.deepEqual(
    commands[2]!.input,
    profile(
      'attribute_exists(pk) AND #photo.#key = :old',
      { '#photo': 'photo', '#key': 'key' },
      { ':old': 'media/u/profile/b.jpg' },
      false
    )
  );
});
test('the fake table holds a photo to the one read: a stale replace or removal is refused', async () => {
  const s = new FakeStore([{ pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com' }], 'T');
  assert.equal(await s.setPhoto('u', photo, null), true);
  assert.equal(await s.setPhoto('u', { ...photo, key: 'media/u/profile/c.jpg' }, null), false, 'one is set');
  assert.equal(await s.setPhoto('u', { ...photo, key: 'media/u/profile/c.jpg' }, 'media/u/profile/a.jpg'), false);
  assert.equal(await s.dropPhoto('u', 'media/u/profile/a.jpg'), false);
  assert.deepEqual((await s.profile('u'))?.photo, photo);
  assert.equal(await s.setPhoto('u', { ...photo, key: 'media/u/profile/c.jpg' }, photo.key), true);
  assert.equal(await s.dropPhoto('u', 'media/u/profile/c.jpg'), true);
  assert.equal((await s.profile('u'))?.photo, undefined);
  assert.equal(await s.setPhoto('gone', photo, null), false, 'no profile, no photo');
});
