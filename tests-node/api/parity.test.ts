/** Golden owner-reader responses emitted by the original Python web.handler
 * with these fictional inputs. The fixture protects wire behavior, ordering,
 * pagination, place/weather units and version calendar semantics. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../../server/app/app.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail, FakeInvocations } from '../../packages/testing/services.ts';
import * as auth from '../../packages/backend/auth.ts';
import type { Item } from '../../packages/backend/store-types.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/python-readers.json', import.meta.url), 'utf8')) as {
  now: number;
  profile: Item;
  items: Item[];
  cases: { method: string; path: string; body: Item | null; status: number; response: Item }[];
};
for (const sample of fixture.cases)
  test('Python HTTP wire parity: ' + sample.method + ' ' + sample.path, async () => {
    const store = new FakeStore([fixture.profile, ...fixture.items]),
      token = 't'.repeat(43),
      origin = 'https://notes.example.com';
    await store.putSession(auth.digest(token), {
      user_id: 'u',
      now: fixture.now,
      expires: fixture.now + auth.SESSION_IDLE
    });
    const app = createApp({
      context: () => ({
        store,
        now: fixture.now,
        origin,
        objects: new FakeObjects(),
        mail: new FakeMail(),
        invocations: new FakeInvocations(),
        from: 'notes@example.com',
        inboundDomain: 'in.example.com',
        senderFunction: 'sender',
        exportFunction: 'export',
        fetchTitle: () => null,
        weatherFetch: async () => ({}),
        log: () => {}
      })
    });
    const answer = await app.request(sample.path, {
      method: sample.method,
      headers: { origin, cookie: auth.COOKIE + '=' + token },
      ...(sample.body ? { body: JSON.stringify(sample.body) } : {})
    });
    assert.equal(answer.status, sample.status);
    assert.deepEqual(await answer.json(), sample.response);
  });
