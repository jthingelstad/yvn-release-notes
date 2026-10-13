/** Fictional subscriber status and content-free activity metadata. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subscriberOverview } from '../packages/backend/subscriber-overview.ts';
import type { Item } from '../packages/backend/store.ts';
const now = Date.parse('2026-10-13T12:00:00Z') / 1000;
const profile = (id: string, fields: Item = {}) => ({
  pk: 'USER#' + id,
  sk: 'PROFILE',
  email: id + '@example.com',
  status: 'active',
  tz: 'America/Chicago',
  ...fields
});
test('statuses use subscriber local date, stopped wins, expired pauses resume, deleting accounts disappear', () => {
  const users = subscriberOverview(
    [
      profile('a', { pause_from: '2026-10-13', pause_through: '2026-10-13' }),
      profile('b', {
        status: 'stopped',
        stopped_reason: 'bounce',
        pause_from: '2026-10-13',
        pause_through: '2026-10-14'
      }),
      profile('c', { pause_from: '2026-10-01', pause_through: '2026-10-12' }),
      profile('d', { tz: 'Pacific/Auckland', pause_from: '2026-10-14', pause_through: '2026-10-14' }),
      profile('e', { mcp_deleting: true }),
      { pk: 'USER#orphan', sk: 'NOTE#2026-10-13#n' }
    ],
    now
  );
  assert.deepEqual(
    users.map((u) => [u.email, u.status, u.stopped_reason]),
    [
      ['a@example.com', 'paused', null],
      ['b@example.com', 'stopped', 'bounce'],
      ['c@example.com', 'active', null],
      ['d@example.com', 'paused', null]
    ]
  );
  assert.equal(users[0]!.pause_through, '2026-10-13');
  assert.equal(users[1]!.pause_through, null);
});
test('last addition uses timestamps rather than assigned days; imports use ledger time; output is an allowlist', () => {
  const note = (id: string, fields: Item) => ({
    pk: 'USER#a',
    sk: `NOTE#2016-07-04#${id}`,
    text: 'private fixture words',
    links: [{ title: 'secret' }],
    media: [{ key: 'private' }],
    ...fields
  });
  const users = subscriberOverview(
    [
      profile('a', { birthday: '1981-06-14', inbox: 'secret-token', city: 'secret-place' }),
      note('web', { source: 'web', written_at: '2026-10-12T12:00:00Z' }),
      note('mail', { written_at: '2026-10-10T12:00:00Z', received_at: '2026-10-13T11:00:00Z' }),
      note('import', { source: 'import', written_at: '2099-01-01T12:00:00Z' }),
      { pk: 'USER#a', sk: 'IMPORT#journal', ids: new Set(['secret-origin']), updated_at: '2026-10-13T12:00:00Z' },
      note('invalid', { written_at: 'invalid' }),
      profile('b')
    ],
    now
  );
  assert.deepEqual(users[0], {
    email: 'a@example.com',
    status: 'active',
    stopped_reason: null,
    pause_through: null,
    joined_at: null,
    tz: 'America/Chicago',
    send_time: '06:00',
    last_sent_date: null,
    last_added_at: '2026-10-13T12:00:00.000Z',
    entries: 4,
    days: 1
  });
  assert.equal(users[1]!.last_added_at, null);
  assert.equal(users[1]!.entries, 0);
  assert.doesNotMatch(JSON.stringify(users), /private|secret|birthday|USER#|NOTE#/);
});
