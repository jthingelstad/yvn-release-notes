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
          shown++;
        }
    if (widget.type === 'log') {
      assert.match(widget.properties.query!, /^SOURCE /);
      assert.doesNotMatch(widget.properties.query!, /\b(text|email|subject)\b/);
    }
  }
  assert.ok(shown > 0);
});
