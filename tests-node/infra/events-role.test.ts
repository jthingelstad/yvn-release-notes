/** The events function's role grants what a bounce, a complaint, a duplicate
 * delivery, an unknown address and a delay make it request: the account
 * lookup, the stop with its receipt and tally, and the scrubbed alarm line
 * (tests-node/infra/grants.ts). */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FakeStore } from '../../packages/testing/store.ts';
import type { Item } from '../../packages/backend/store.ts';
import * as events from '../../workers/events.ts';
import { Recorder } from './grants.ts';

const now = Date.parse('2026-10-13T11:00:00Z') / 1000;
function sns(kind: string, id: string, extra: Item = {}) {
  const message = {
    eventType: kind,
    mail: { headers: [{ name: 'List-Unsubscribe', value: 'fictional' }] },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'ada@example.com' }]
    },
    complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'ada@example.com' }] },
    ...extra
  };
  return { Records: [{ Sns: { Message: JSON.stringify(message), MessageId: id } }] };
}

test('the events role grants every request a mail event makes', async () => {
  const aws = new Recorder('EventsFunction'),
    store = aws.watch(
      new FakeStore([
        { pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com', status: 'active', tz: 'America/Chicago' },
        { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' }
      ])
    ),
    lines: Item[] = [],
    services: events.EventServices = {
      store,
      clock: () => now,
      // The entry publishes each line to ALARM_TOPIC.
      publish: async (line) => {
        aws.add('publish', 'sns:Publish', aws.env.ALARM_TOPIC!);
        lines.push(line);
      }
    };
  await events.handler(sns('Bounce', 'one'), null, services);
  await events.handler(sns('Bounce', 'one'), null, services);
  await events.handler(sns('Complaint', 'two'), null, services);
  await events.handler(
    sns('Bounce', 'three', {
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'nobody@example.com' }] }
    }),
    null,
    services
  );
  await events.handler(sns('DeliveryDelay', 'four'), null, services);
  assert.equal(store.memory.read({ pk: 'USER#u', sk: 'PROFILE' })?.stopped_reason, 'complaint');
  assert.equal(lines.length, 4);

  const made = aws.granted();
  assert.deepEqual([...new Set(made.map((r) => r.action))].sort(), [
    'dynamodb:GetItem',
    'dynamodb:PutItem',
    'dynamodb:UpdateItem',
    'logs:CreateLogStream',
    'logs:PutLogEvents',
    'sns:Publish',
    // Its dead-letter queue.
    'sqs:SendMessage'
  ]);
  assert.deepEqual(aws.unused(), [], 'every grant is used');
});
