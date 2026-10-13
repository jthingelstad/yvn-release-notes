/** SDK request and IAM metadata boundary, independent of the fake evaluator. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Store } from '../../packages/backend/store.ts';
import type { StoreCommand } from '../../packages/backend/store-types.ts';
test('overview scan projects only metadata and paginates across empty filtered pages', async () => {
  const commands: StoreCommand[] = [];
  const cursor = { pk: 'USER#u', sk: 'NOTE#2026-10-13#n' };
  const store = new Store(
    {
      send: async (c) => {
        commands.push(c);
        return commands.length === 1
          ? { Items: [], LastEvaluatedKey: cursor }
          : { Items: [{ pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com' }] };
      }
    },
    'T'
  );
  assert.deepEqual(await store.subscriberOverviewItems(), [{ pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com' }]);
  const input = {
    TableName: 'T',
    Select: 'SPECIFIC_ATTRIBUTES',
    FilterExpression: 'begins_with(pk, :u) AND (sk = :p OR begins_with(sk, :n) OR begins_with(sk, :i))',
    ProjectionExpression:
      'pk, sk, email, #st, stopped_reason, created_at, tz, send_time, last_sent_date, pause_from, pause_through, written_at, received_at, #src, updated_at, mcp_deleting',
    ExpressionAttributeNames: { '#st': 'status', '#src': 'source' },
    ExpressionAttributeValues: { ':u': 'USER#', ':p': 'PROFILE', ':n': 'NOTE#', ':i': 'IMPORT#' }
  };
  assert.equal(commands[0]!.constructor.name, 'ScanCommand');
  assert.deepEqual(commands[0]!.input, input);
  assert.deepEqual(commands[1]!.input, { ...input, ExclusiveStartKey: cursor });
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const web = template.split('  WebRole:')[1]!.split(/\n {2}[A-Z]\w+:/, 1)[0]!;
  const policy = web.split('Action: dynamodb:Scan')[1]!.split('              - Effect: Allow')[0]!;
  assert.match(policy, /dynamodb:Select: SPECIFIC_ATTRIBUTES/);
  assert.match(policy, /ForAllValues:StringEquals:/);
  const attributes = policy
    .match(/dynamodb:Attributes: \[([\s\S]*?)\]/)![1]!
    .split(',')
    .map((s) => s.trim());
  const projected = input.ProjectionExpression.split(',').map((s) => {
    const name = s.trim();
    return input.ExpressionAttributeNames[name as keyof typeof input.ExpressionAttributeNames] ?? name;
  });
  assert.deepEqual(attributes.sort(), projected.sort());
});
