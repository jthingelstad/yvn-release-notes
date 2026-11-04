/** The structured-log alarm contract, independently of runtime tests and
 * CloudFormation lint. The dashboards are Grafana on Otto (otto-ops). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the stack owns no CloudWatch dashboard: Grafana on Otto has the panels (Jamie, 2026-11-02)', async () => {
  const source = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /AWS::CloudWatch::Dashboard|DashboardUrl/);
});

test('retired alarms retain final-failure destinations and the two delivery alarms', async () => {
  const source = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const resource = (name: string) => {
    const body = new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [A-Za-z0-9]+:|^Outputs:)`, 'm').exec(source)?.[0];
    assert.ok(body, `${name} must remain`);
    return body;
  };
  assert.match(resource('EventsFunction'), /DeadLetterConfig:\s+TargetArn: !GetAtt FailedQueue\.Arn/);
  assert.match(resource('InboundAliasInvokeConfig'), /MaximumRetryAttempts: 2/);
  assert.match(resource('InboundAliasInvokeConfig'), /Destination: !GetAtt InboundFailedQueue\.Arn/);
  for (const name of ['TranscribeStream', 'DescribeStream']) {
    assert.match(resource(name), /MaximumRetryAttempts: 3/);
    assert.match(resource(name), /Destination: !GetAtt FailedQueue\.Arn/);
  }
  const failed = resource('FailedQueueAlarm');
  assert.ok(failed.includes('MetricName: ApproximateNumberOfMessagesVisible'));
  assert.ok(failed.includes('!GetAtt FailedQueue.QueueName'));
  assert.match(failed, /AlarmActions: \[!Ref AlarmTopic\]/);
  assert.match(resource('OverdueAlarm'), /AlarmActions: \[!Ref AlarmTopic\]/);
  // The account keeps alarms only where someone acts on them (Jamie, 2026-11-03):
  // failed-queue and overdue are this stack's two.
  assert.deepEqual(
    [...source.matchAll(/^  ([A-Za-z0-9]+):\n    Type: AWS::CloudWatch::Alarm$/gm)].map((match) => match[1]),
    ['FailedQueueAlarm', 'OverdueAlarm']
  );
  for (const name of [
    'EventsErrorsAlarm',
    'ExportErrorsAlarm',
    'TranscribeErrorsAlarm',
    'DescribeErrorsAlarm',
    'InboundErrorsAlarm'
  ])
    assert.ok(!source.includes(`  ${name}:`));
});
