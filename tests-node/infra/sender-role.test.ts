/** The sender's role grants what its runs request: a dry run, the scheduled
 * run with photos (one thumbnail gone), weather kept, badges seen and the
 * census scan, a send_now, and a failed send that gives its claim back
 * (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
import { report } from '../../packages/backend/census.ts';
import * as sender from '../../workers/send.ts';
import { Recorder } from './grants.ts';

const now = Date.parse('2026-10-13T11:00:00Z') / 1000;
const person = (id: string, extra: Item = {}): Item[] => [
  {
    pk: `USER#${id}`,
    sk: 'PROFILE',
    email: `${id}@example.com`,
    birthday: '1972-03-05',
    tz: 'America/Chicago',
    status: 'active',
    send_time: '06:00',
    ...extra
  },
  { pk: `EMAIL#${id}@example.com`, sk: 'EMAIL', user_id: id }
];
const photo = (name: string) => ({
  kind: 'image',
  key: `media/u/${name}.jpg`,
  thumb: { key: `media/u/${name}.thumb.jpg`, size: 30, width: 640, height: 480 }
});
const forecast = {
  daily: {
    time: ['2026-10-12', '2026-10-13'],
    temperature_2m_max: [20, 18],
    temperature_2m_min: [10, 8],
    weather_code: [2, 3]
  }
};

test('the sender role grants every request a dry run, a send, send_now and a failed send make', async () => {
  const aws = new Recorder('SenderFunction'),
    store = new FakeStore([
      ...person('u', { city: 'Home', country: 'United States', lat: 44, lon: -93, describe: true }),
      ...person('w', { send_time: '20:00' }),
      ...person('x', { send_time: '20:00' }),
      {
        pk: 'USER#u',
        sk: 'NOTE#2026-10-12#n',
        text: 'A synthetic note #made',
        source: 'email',
        written_at: '2026-10-12T22:00:00Z',
        media: [photo('kept'), photo('gone')]
      },
      {
        pk: 'USER#u',
        sk: 'NOTE#2025-10-13#old',
        text: 'Last year',
        source: 'email',
        written_at: '2025-10-13T12:00:00Z'
      }
    ]),
    files = new FakeObjects(),
    mail = new FakeMail(),
    services: sender.SenderServices = {
      store: aws.watch(store),
      objects: aws.objects(files),
      mail: aws.mail(mail),
      fromAddress: aws.env.FROM_ADDRESS!,
      inboundDomain: aws.env.INBOUND_DOMAIN!,
      clock: () => now,
      weatherFetch: async () => forecast,
      // The census line goes to stdout as EMF; only its scan is a request.
      report: (s, at) => report(s, at, () => {})
    };
  await files.put('media/u/kept.thumb.jpg', Buffer.alloc(30), { type: 'image/jpeg' });

  const dry = await sender.handler({ dry_run: true, now: '2026-10-13T11:00:00Z' }, null, services);
  assert.equal((dry.results as Item[])[0]?.photos, 1);
  const sent = await sender.handler(null, null, services);
  assert.deepEqual(
    (sent.results as Item[]).map((r) => r.outcome),
    ['sent']
  );
  assert.equal(((await sender.handler({ send_now: 'w' }, null, services)).results as Item[])[0]?.outcome, 'sent');
  mail.fail = true;
  await assert.rejects(() => sender.handler({ send_now: 'x' }, null, services), /1 send\(s\) failed/);
  assert.equal(mail.messages.length, 2);

  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    'dynamodb:Scan',
    'dynamodb:Query',
    'dynamodb:ConditionCheckItem',
    's3:GetObject',
    'ses:SendRawEmail'
  ])
    assert.ok(actions.has(action), action);
  assert.ok(store.memory.all().some((i) => i.sk === 'WEATHER#2026-10-12'));
  assert.ok(store.memory.all().some((i) => i.sk === 'BADGES'));
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
