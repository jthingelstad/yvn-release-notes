import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeMail, FakeObjects } from '../../packages/testing/services.ts';
import { handler } from '../../workers/send.ts';
import { body, htmlBody } from '../../packages/mail/compose.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { remindersFor, type UpcomingEntry } from '../../packages/domain/upcoming.ts';
import { build, markdown } from '../../packages/backend/export.ts';
import type { Item } from '../../packages/backend/store.ts';
const entry: UpcomingEntry = {
  id: 'concert',
  kind: 'event',
  tag: null,
  title: 'Concert <script>',
  date: '2026-10-14',
  year: null,
  end_date: null,
  place: null,
  email: true,
  reminders: [7, 1, 0],
  revision: 1,
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
function fixture() {
  const store = new FakeStore([
      ...['east', 'west'].map((uid) => ({
        pk: 'USER#' + uid,
        sk: 'PROFILE',
        email: uid + '@example.com',
        birthday: '1981-06-14',
        tz: uid === 'east' ? 'Pacific/Kiritimati' : 'America/Chicago',
        send_time: '06:00',
        status: 'active'
      })),
      { pk: 'USER#east', sk: 'UPCOMING#concert', ...entry },
      { pk: 'USER#west', sk: 'UPCOMING#concert', ...entry, title: 'Private west title' }
    ]),
    mail = new FakeMail(),
    logs: Item[] = [],
    services = {
      store,
      mail,
      objects: new FakeObjects(),
      fromAddress: 'notes@example.com',
      inboundDomain: 'in.example.com',
      clock: () => Date.parse('2026-10-13T12:00:00Z') / 1000,
      weatherFetch: async () => ({}),
      log: (f: Item) => logs.push(f)
    };
  return { store, mail, logs, services };
}
test('plain/HTML reminders are escaped type on paper with bounded lines, no remote resources and no empty section', () => {
  const v = computeVersion('1981-06-14', '2026-10-13'),
    section = remindersFor([entry], '2026-10-13'),
    text = body(v, '1981-06-14', { upcoming: section }),
    html = htmlBody(v, '1981-06-14', '2026-10-13', { upcoming: section });
  assert.match(text, /Upcoming\n\nTomorrow\nConcert <script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>|src="https?:/);
  assert.match(html, /href="https:\/\/notes.yourversionnumber.com\/upcoming\/"/);
  assert.equal(body(v, '1981-06-14', { upcoming: { shown: [], more: 0 } }), body(v, '1981-06-14'));
  assert.equal(
    htmlBody(v, '1981-06-14', '2026-10-13', { upcoming: { shown: [], more: 0 } }),
    htmlBody(v, '1981-06-14', '2026-10-13')
  );
});
test('sender selects each owner local day, sends once, keeps reminders out of notes and scrubs diagnostics', async () => {
  const f = fixture();
  for (const uid of ['east', 'west']) await handler({ send_now: uid }, null, f.services);
  const east = await simpleParser(f.mail.messages[0]!.raw),
    west = await simpleParser(f.mail.messages[1]!.raw);
  assert.match(east.text!, /Today\nConcert <script>/);
  assert.match(west.text!, /Tomorrow\nPrivate west title/);
  assert.doesNotMatch(east.text!, /Private west title/);
  await handler({ send_now: 'east' }, null, f.services);
  assert.equal(f.mail.messages.length, 2);
  assert.equal((await f.store.allNotes('east')).length, 0);
  assert.doesNotMatch(JSON.stringify(f.logs), /Concert|Private west title/);
});
test('the activity log has the email and each reminder due, those folded into "N more" too, never a title', async () => {
  const f = fixture();
  for (const id of ['b', 'c', 'd', 'e'])
    f.store.seed({ pk: 'USER#west', sk: 'UPCOMING#' + id, ...entry, id, title: 'Private ' + id });
  f.store.seed({ pk: 'USER#west', sk: 'UPCOMING#later', ...entry, id: 'later', date: '2026-10-30' });
  await handler({ send_now: 'west' }, null, f.services);
  assert.match((await simpleParser(f.mail.messages[0]!.raw)).text!, /And 2 more today\./);
  const rows = await f.store.activityAll('west');
  assert.deepEqual(rows.map((r) => [r.kind, r.upcoming ?? null, r.when ?? null, r.day, r.via]).sort(), [
    ['email.sent', null, null, '2026-10-13', 'email'],
    ...['b', 'c', 'concert', 'd', 'e'].map((id) => ['reminder', id, 'Tomorrow', '2026-10-13', 'email'])
  ]);
  // The date's id, how near, and the email's day: nothing of the entry itself.
  assert.deepEqual(Object.keys(rows.find((r) => r.upcoming === 'b')!).sort(), [
    'at',
    'day',
    'kind',
    'pk',
    'sk',
    'upcoming',
    'via',
    'when'
  ]);
  assert.equal(rows.find((r) => r.kind === 'email.sent')!.version, String(computeVersion('1981-06-14', '2026-10-13')));
  assert.doesNotMatch(JSON.stringify(rows), /Private|Concert/);
  // Sent once: a repeat writes nothing more.
  await handler({ send_now: 'west' }, null, f.services);
  assert.equal((await f.store.activityAll('west')).length, 6);
});
test('a send whose activity rows cannot be written still goes, and is counted', async () => {
  const f = fixture(),
    send = f.store.memory.send.bind(f.store.memory);
  f.store.memory.send = (command) => {
    const items = (command.input as { TransactItems?: { Put?: { Item: Item } }[] }).TransactItems;
    if (items?.some((i) => String(i.Put?.Item.sk).startsWith('ACTIVITY#')))
      throw Object.assign(new Error('private'), { name: 'TransactionCanceledException' });
    return send(command);
  };
  const result = await handler({ send_now: 'west' }, null, f.services);
  assert.equal((result.results as Item[])[0]!.outcome, 'sent');
  assert.equal(f.mail.messages.length, 1);
  const unrecorded = f.logs.findIndex((l) => l.event === 'activity-unrecorded');
  assert.deepEqual(f.logs[unrecorded], { event: 'activity-unrecorded', kind: 'email', user: 'west' });
  assert.equal(f.logs[unrecorded + 1]!.ActivityUnrecorded, 1);
});
test('dry run reads only and reports counts; optional failure still sends; paused/stopped never get reminders', async () => {
  const f = fixture(),
    before = f.store.memory.all();
  const result = await handler({ dry_run: true, send_now: 'east' }, null, f.services);
  assert.equal((result.results as Item[])[0]!.upcoming, 1);
  assert.doesNotMatch(JSON.stringify(result), /Concert|Private west title/);
  assert.deepEqual(f.store.memory.all(), before);
  assert.equal(f.mail.messages.length, 0);
  f.store.upcomingEntries = async () => {
    throw new Error('Private west title east@example.com');
  };
  await handler({ send_now: 'east' }, null, f.services);
  assert.equal(f.mail.messages.length, 1);
  assert.doesNotMatch((await simpleParser(f.mail.messages[0]!.raw)).text!, /Upcoming/);
  assert.ok(f.logs.some((f) => f.event === 'upcoming-error'));
  assert.doesNotMatch(JSON.stringify(f.logs), /@|Private west/);
  // Reminders that never reached the email are not in the log.
  assert.deepEqual(
    (await f.store.activityAll('east')).map((r) => r.kind),
    ['email.sent']
  );
  const paused = fixture();
  await paused.store.updateProfile('east', { pause_from: '2026-10-14', pause_through: '2026-10-15' });
  await paused.store.updateProfile('west', { status: 'stopped' });
  const skipped = await handler({ send_now: 'east' }, null, paused.services);
  assert.equal((skipped.results as Item[])[0]!.outcome, 'paused');
  await assert.rejects(handler({ send_now: 'west' }, null, paused.services), /no active subscriber/);
  assert.equal(paused.mail.messages.length, 0);
  for (const uid of ['east', 'west']) assert.deepEqual(await paused.store.activityAll(uid), []);
});
test('JSON/Markdown exports retain dates and destination, with no internal keys or fabricated journal days', () => {
  const data = build(
    [
      { pk: 'USER#u', sk: 'PROFILE', birthday: '1981-06-14' },
      { pk: 'USER#u', sk: 'UPCOMING#concert', ...entry }
    ],
    '2026-10-13T12:00:00Z'
  );
  assert.deepEqual(data.upcoming, [entry]);
  assert.equal(data.notes.length, 0);
  assert.equal(data.days_sent.length, 0);
  assert.doesNotMatch(JSON.stringify(data), /USER#|UPCOMING#/);
  assert.match(markdown(data), /## Upcoming/);
  assert.doesNotMatch(markdown(data), /<script>/);
  assert.match(markdown(data), /2026-10-14/);
});
