/** The structured-log alarm contract, independently of runtime tests and
 * CloudFormation lint. The dashboards are Grafana on Otto (otto-ops). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the stack owns no CloudWatch dashboard: Grafana on Otto has the panels (Jamie, 2026-11-02)', async () => {
  const source = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /AWS::CloudWatch::Dashboard|DashboardUrl/);
});

test('retired worker alarms retain final-failure destinations and delivery safety alarms', async () => {
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
  for (const [name, queue, metric] of [
    ['FailedQueueAlarm', 'FailedQueue', 'ApproximateNumberOfMessagesVisible'],
    ['InboundFailedQueueAlarm', 'InboundFailedQueue', 'ApproximateAgeOfOldestMessage']
  ]) {
    const alarm = resource(name!);
    assert.ok(alarm.includes(`MetricName: ${metric}`));
    assert.ok(alarm.includes(`!GetAtt ${queue}.QueueName`));
    assert.match(alarm, /AlarmActions: \[!Ref AlarmTopic\]/);
  }
  for (const name of [
    'SenderErrorsAlarm',
    'OverdueAlarm',
    'NativeAppErrorsAlarm',
    'NativeMcpErrorsAlarm',
    'SignInTotalAlarm'
  ])
    assert.match(resource(name), /AlarmActions: \[!Ref AlarmTopic\]/);
  for (const name of [
    'EventsErrorsAlarm',
    'ExportErrorsAlarm',
    'TranscribeErrorsAlarm',
    'DescribeErrorsAlarm',
    'InboundErrorsAlarm'
  ])
    assert.ok(!source.includes(`  ${name}:`));
});
