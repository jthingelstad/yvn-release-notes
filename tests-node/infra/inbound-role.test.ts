/** The inbound function's role grants what filing a reply requests: the raw
 * mail read and its outcome tags, media staged with pending tags then tagged
 * or removed (a duplicate the owner trimmed, a refused account), the late
 * notice with its reservation, the standing address, the badges a filed
 * note earned, and a message given up on, read from the inbound failed queue,
 * logged and handed on to the failed queue (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store.ts';
import * as inbound from '../../workers/inbound.ts';
import { Recorder, queueArn } from './grants.ts';

const now = Date.parse('2026-10-13T11:00:00Z') / 1000,
  token = 'a'.repeat(24),
  standing = 'b'.repeat(24),
  // A synthetic AAC frame header and padding: kept as audio, never decoded.
  audio = Buffer.concat([Buffer.from([0xff, 0xf1]), Buffer.alloc(2046)]).toString('base64');
const raw = (text: string) =>
  Buffer.from(
    'From: Ada <ada@example.com>\r\nMessage-ID: <reply@example.com>\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n' +
      `--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n` +
      `--b\r\nContent-Type: audio/aac\r\nContent-Disposition: attachment; filename=a.aac\r\nContent-Transfer-Encoding: base64\r\n\r\n${audio}\r\n--b--`
  );
const ses = (id: string, to: string, date = '2026-10-13T12:00:00Z') => ({
  mail: { messageId: id, timestamp: date, commonHeaders: { from: ['Ada <ada@example.com>'], subject: 'Re: today' } },
  receipt: {
    recipients: [to],
    spamVerdict: { status: 'PASS' },
    virusVerdict: { status: 'PASS' },
    dmarcVerdict: { status: 'PASS' },
    dkimVerdict: { status: 'PASS' }
  }
});

test('the inbound role grants every request filing a reply makes', async () => {
  const aws = new Recorder('InboundFunction'),
    store = new FakeStore([
      {
        pk: 'USER#u',
        sk: 'PROFILE',
        email: 'ada@example.com',
        birthday: '1972-03-05',
        tz: 'America/Chicago',
        status: 'active',
        send_time: '06:00'
      },
      { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' },
      {
        pk: `TOKEN#${token}`,
        sk: 'TOKEN',
        user_id: 'u',
        date: '2026-10-11',
        version: '5.4.220',
        sent_at: now - 2 * 86400
      }
    ]),
    files = new FakeObjects(),
    mail = new FakeMail(),
    domain = aws.env.INBOUND_DOMAIN!,
    services: inbound.InboundServices = {
      store,
      objects: aws.objects(files),
      mail: aws.mail(mail),
      fromAddress: aws.env.FROM_ADDRESS!,
      inboundDomain: domain,
      titleFetch: async () => null,
      // The entry sends each record on to FAILED_QUEUE.
      forward: async () => aws.add('forward', 'sqs:SendMessage', queueArn(aws.env.FAILED_QUEUE!))
    };
  await store.setInbox('u', standing, 'now');
  for (const id of ['reply', 'late', 'address', 'refused'])
    await files.put(`raw/${id}`, raw(`A synthetic ${id} #made`), { type: 'message/rfc822' });
  aws.watch(store);

  assert.equal(await inbound.process(ses('reply', `n-${token}@${domain}`), services), 'note');
  // Read straight from memory: the test's own reads are not the worker's.
  const filed = store.memory.all().find((i) => i.sk === 'NOTE#2026-10-11#reply')!;
  assert.equal((filed.media as Item[]).length, 1);
  // The owner removes the file before SES retries: the retry drops its copy.
  store.memory.seed(Object.fromEntries(Object.entries(filed).filter(([k]) => k !== 'media')));
  assert.equal(await inbound.process(ses('reply', `n-${token}@${domain}`), services), 'note');
  assert.ok(files.calls.some((c) => c.operation === 'remove'));
  // Past the reply window: the account notice, once.
  assert.equal(await inbound.process(ses('late', `n-${token}@${domain}`, '2026-10-20T12:00:00Z'), services), 'ignored');
  assert.equal(mail.messages.length, 1);
  assert.equal(await inbound.process(ses('address', `${standing}@${domain}`), services), 'note');
  // A reply that timed out three times: its failed row and notice, then on.
  const record = {
    requestContext: { approximateInvokeCount: 3 },
    requestPayload: { Records: [{ ses: ses('timeout', `n-${token}@${domain}`) }] }
  };
  await inbound.handler({ Records: [{ body: JSON.stringify(record) }] }, null, services);
  assert.equal(mail.messages.length, 2);
  // An account being deleted refuses the note and removes its staged media.
  store.memory.seed({ ...store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })!, mcp_deleting: true });
  const removed = files.calls.filter((c) => c.operation === 'remove').length;
  assert.equal(await inbound.process(ses('refused', `${standing}@${domain}`), services), 'ignored');
  assert.equal(files.calls.filter((c) => c.operation === 'remove').length, removed + 1);

  const made = aws.granted(),
    actions = new Set(made.map((r) => r.action));
  for (const action of [
    's3:GetObject',
    's3:GetObjectTagging',
    's3:PutObject',
    's3:PutObjectTagging',
    's3:DeleteObject',
    'ses:SendRawEmail',
    'dynamodb:ConditionCheckItem',
    'dynamodb:Query',
    'dynamodb:UpdateItem',
    'sqs:SendMessage',
    'sqs:ReceiveMessage'
  ])
    assert.ok(actions.has(action), action);
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
