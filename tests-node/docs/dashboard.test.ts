/** Preserve the old count-only dashboard and current structured-log alarm
 * contract independently of runtime tests and CloudFormation lint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { counts, NAMESPACE } from '../../packages/backend/census.ts';
test('dashboard widgets fit without overlap, use emitted count metrics and never query private content', async () => {
  const source = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const body = /DashboardBody: !Sub \|\n((?: {8}.*\n?)+)/.exec(source)![1]!.replace(/^ {8}/gm, '');
  const widgets = JSON.parse(body).widgets as {
    x: number;
    y: number;
    width: number;
    height: number;
    type: string;
    properties: { metrics?: unknown[][]; query?: string };
  }[];
  const cells = new Set<string>(),
    known = new Set([
      ...Object.keys(
        counts(
          [
            { pk: 'USER#u', sk: 'PROFILE', tz: 'UTC', status: 'active' },
            { pk: 'USER#u', sk: 'DAY#1969-12-31' }
          ],
          0
        )
      ),
      'McpFailures'
    ]);
  let shown = 0;
  for (const widget of widgets) {
    assert.ok(widget.x + widget.width <= 24);
    for (let x = widget.x; x < widget.x + widget.width; x++)
      for (let y = widget.y; y < widget.y + widget.height; y++) {
        const cell = `${x},${y}`;
        assert.ok(!cells.has(cell));
        cells.add(cell);
      }
    if (widget.type === 'metric')
      for (const metric of widget.properties.metrics ?? [])
        if (metric[0] === NAMESPACE) {
          assert.ok(known.has(String(metric[1])));
          assert.ok(['Overdue', 'McpFailures'].includes(String(metric[1])));
          shown++;
        }
    if (widget.type === 'log') {
      assert.match(widget.properties.query!, /^SOURCE /);
      assert.doesNotMatch(widget.properties.query!, /\b(text|email|subject)\b/);
      // Logs Insights resolves field references across the query. Reusing a
      // source field as a stats output alias creates cycles or blank cells.
      const query = widget.properties.query!;
      const sourceFields = new Set(
        [...query.matchAll(/coalesce\((\w+), message\.\1\)/g)].map((m) => m[1]!.toLowerCase())
      );
      for (const match of query.matchAll(/(?:latest|max)\(census\w+\) as (\w+)/g))
        assert.ok(!sourceFields.has(match[1]!.toLowerCase()));
    }
  }
  assert.ok(shown > 0);
  const queries = widgets
    .filter((w) => w.type === 'log')
    .map((w) => w.properties.query!)
    .join('\n');
  for (const name of ['Subscribers', 'Writers7', 'ReplyRate30', 'ImportedNotes', 'ApiNotes'])
    assert.ok(queries.includes(name));
  assert.match(queries, /latest\(censusSubscribers\)/);
  assert.match(queries, /max\(censusEmailNotes\).*by bin\(1h\)/);
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
