/** DynamoDB refuses a reserved word used bare in an expression. The fake table
 * refuses it the same way, and every expression in the source is checked, so
 * one cannot pass the tests and then fail on AWS (2026-10-16: a bare `owner`
 * in the processing lease broke every photo description since 2026-10-13). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { InMemoryDocumentClient } from '../../packages/testing/store.ts';
import { bareReserved, RESERVED } from '../../packages/testing/dynamo-reserved.ts';
import { errorFields } from '../../packages/backend/services.ts';

test('the reserved list is the whole published list, and names are checked without case', () => {
  assert.equal(RESERVED.size, 571);
  for (const word of ['OWNER', 'NAME', 'STATUS', 'SOURCE', 'DATE', 'DATA', 'COUNT', 'TYPE', 'KEY', 'TTL', 'USER'])
    assert.ok(RESERVED.has(word), word);
  assert.deepEqual(bareReserved('attribute_not_exists(pk) OR expires_at <= :now OR owner = :o'), ['owner']);
  assert.deepEqual(bareReserved('Status = :s AND media[0].Name = :n'), ['Status', 'Name']);
  assert.deepEqual(bareReserved('#owner = :o AND #src = :k AND size(media) > :zero'), []);
  assert.deepEqual(bareReserved('SET n = n + :one REMOVE #f ADD c :one'), []);
});

test('the fake table refuses a bare reserved word in every expression and transaction item', async () => {
  const client = new InMemoryDocumentClient([{ pk: 'P', sk: 'S', owner: 'o' }]);
  const key = { pk: 'P', sk: 'S' };
  const refused = { name: 'ValidationException', message: /reserved keyword: owner/ };
  await assert.rejects(
    () =>
      client.send(
        new DeleteCommand({
          TableName: 'T',
          Key: key,
          ConditionExpression: 'owner = :o',
          ExpressionAttributeValues: { ':o': 'o' }
        })
      ),
    refused
  );
  await assert.rejects(
    () =>
      client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Delete: {
                TableName: 'T',
                Key: key,
                ConditionExpression: 'attribute_exists(pk) AND owner = :o',
                ExpressionAttributeValues: { ':o': 'o' }
              }
            }
          ]
        })
      ),
    refused
  );
  await assert.rejects(
    () => client.send(new GetCommand({ TableName: 'T', Key: key, ProjectionExpression: 'pk, owner' })),
    refused
  );
  await assert.rejects(
    () =>
      client.send(
        new QueryCommand({
          TableName: 'T',
          KeyConditionExpression: 'pk = :p',
          FilterExpression: 'owner = :o',
          ExpressionAttributeValues: { ':p': 'P', ':o': 'o' }
        })
      ),
    refused
  );
  // Refused before reading, even where the condition would have failed anyway.
  await assert.rejects(
    () =>
      client.send(
        new PutCommand({
          TableName: 'T',
          Item: { pk: 'Q', sk: 'S' },
          ConditionExpression: 'attribute_not_exists(pk) OR owner = :o',
          ExpressionAttributeValues: { ':o': 'x' }
        })
      ),
    refused
  );
  await client.send(
    new DeleteCommand({
      TableName: 'T',
      Key: key,
      ConditionExpression: '#owner = :o',
      ExpressionAttributeNames: { '#owner': 'owner' },
      ExpressionAttributeValues: { ':o': 'o' }
    })
  );
  assert.equal(client.read(key), null);
});

test('no expression in the source names a reserved word bare', () => {
  const files = execFileSync('git', ['ls-files', 'packages', 'server', 'workers', 'tools', 'tests-node'], {
    encoding: 'utf8'
  })
    .split('\n')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('reserved-words.test.ts'));
  const found: string[] = [];
  let sites = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(
      /(?:^|[{,])\s*(ConditionExpression|UpdateExpression|KeyConditionExpression|FilterExpression|ProjectionExpression)\s*:\s*/gm
    )) {
      sites++;
      let depth = 0,
        value = '';
      for (let i = m.index + m[0].length; i < source.length; i++) {
        const c = source[i]!;
        if ('([{'.includes(c)) depth++;
        if (')]}'.includes(c) && depth-- === 0) break;
        if (c === ',' && depth === 0) break;
        value += c;
      }
      for (const literal of value.matchAll(/'([^']*)'|`([^`]*)`/g))
        for (const word of bareReserved((literal[1] ?? literal[2] ?? '').replace(/\$\{[^}]*\}/g, 'x')))
          found.push(`${file}:${source.slice(0, m.index).split('\n').length} ${word}`);
    }
  }
  assert.ok(sites > 100, `only ${sites} expression sites found`);
  assert.deepEqual(found, []);
});

test('error fields name the failure without its content', () => {
  const validation = Object.assign(
    new Error('Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: owner'),
    { name: 'ValidationException', $metadata: { httpStatusCode: 400 } }
  );
  assert.deepEqual(errorFields(validation), {
    error: 'ValidationException',
    error_status: 400,
    error_message: validation.message
  });
  const cancelled = Object.assign(new Error('private detail'), {
    name: 'TransactionCanceledException',
    $metadata: { httpStatusCode: 400 },
    CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed', Item: { text: 'private' } }]
  });
  assert.deepEqual(errorFields(cancelled), {
    error: 'TransactionCanceledException',
    error_status: 400,
    error_reasons: 'None,ConditionalCheckFailed'
  });
  assert.deepEqual(errorFields(Object.assign(new Error('private note text'), { code: 'ECONNRESET' })), {
    error: 'Error',
    error_code: 'ECONNRESET'
  });
  assert.deepEqual(errorFields(Object.assign(new Error('x'), { name: 'private words here' })), { error: 'Error' });
  assert.deepEqual(errorFields('private'), { error: 'string' });
});
