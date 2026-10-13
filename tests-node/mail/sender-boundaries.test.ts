/** Failed optional history/census reads cannot hold a daily email. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeMail, FakeObjects } from '../../packages/testing/services.ts';
import { handler } from '../../workers/send.ts';
import type { Item } from '../../packages/backend/store.ts';
test('history, streak, yesterday and census read failures preserve daily send and log only safe error kind', async () => {
  for (const failure of ['noteIndex', 'noteDays', 'dayNotes'] as const) {
    const store = new FakeStore([
        {
          pk: 'USER#u',
          sk: 'PROFILE',
          email: 'ada@example.com',
          birthday: '1981-06-14',
          tz: 'UTC',
          status: 'active',
          send_time: '06:00'
        },
        {
          pk: 'USER#u',
          sk: 'NOTE#2026-10-12#w-1',
          source: 'web',
          text: 'Fictional private words',
          written_at: '2026-10-12T12:00:00Z'
        }
      ]),
      mail = new FakeMail(),
      logs: Item[] = [];
    store[failure] = async () => {
      throw new Error('Fictional private words ada@example.com');
    };
    const result = await handler(
      {},
      { getRemainingTimeInMillis: () => 60000 },
      {
        store,
        mail,
        objects: new FakeObjects(),
        fromAddress: 'notes@example.com',
        inboundDomain: 'in.example.com',
        clock: () => Date.parse('2026-10-13T06:00:00Z') / 1000,
        report: async () => {
          throw new Error('Fictional private census');
        },
        log: (fields) => logs.push(fields)
      }
    );
    assert.equal((result.results as Item[])[0]!.outcome, 'sent');
    assert.equal(mail.messages.length, 1);
    assert.ok(logs.some((l) => l.event === 'census-error'));
    assert.ok(!JSON.stringify(logs).includes('Fictional private'));
    assert.ok(!JSON.stringify(logs).includes('@'));
  }
});
