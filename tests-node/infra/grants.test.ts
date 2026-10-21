/** The role harness (tests-node/infra/grants.ts) refuses what a statement does
 * not allow: another action, resource or prefix, a missing or unlisted
 * condition value, and another account's partition key. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statements, grants, resolve, type Request } from './grants.ts';

test('the harness allows only what a statement allows, conditions included', () => {
  const bucket = `arn:aws:s3:::${resolve({ '!Ref': 'MailBucket' })}`,
    table = `arn:aws:dynamodb:us-east-1:123456789012:table/${resolve({ '!Ref': 'Table' })}`,
    allows = (role: string, r: Omit<Request, 'via'>) => statements(role).some((s) => grants(s, { via: 'test', ...r }));
  assert.ok(allows('WebRole', { action: 's3:ListBucket', resource: bucket, context: { 's3:prefix': 'media/u/' } }));
  assert.ok(!allows('WebRole', { action: 's3:ListBucket', resource: bucket, context: { 's3:prefix': 'raw/' } }));
  assert.ok(!allows('WebRole', { action: 's3:ListBucket', resource: bucket }));
  assert.ok(!allows('WebRole', { action: 's3:GetObject', resource: `${bucket}/raw/m` }));
  assert.ok(!allows('SenderRole', { action: 's3:ListBucket', resource: bucket, context: { 's3:prefix': 'media/u/' } }));
  const scan = (attributes: string[]) => ({
    action: 'dynamodb:Scan',
    resource: table,
    context: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES', 'dynamodb:Attributes': attributes }
  });
  assert.ok(allows('WebRole', scan(['pk', 'sk', 'email'])));
  assert.ok(!allows('WebRole', scan(['pk', 'text'])));
  assert.ok(!allows('WebRole', { action: 'dynamodb:Scan', resource: table }));
  const read = (pk: string) => ({
    action: 'dynamodb:GetItem',
    resource: table,
    context: { 'dynamodb:LeadingKeys': [pk] }
  });
  assert.ok(allows('McpRole', read('OAUTHACCESS#digest')));
  assert.ok(!allows('McpRole', read('EMAIL#ada@example.com')));
  const send = (from: string) => ({
    action: 'ses:SendRawEmail',
    resource: 'arn:aws:ses:us-east-1:123456789012:identity/yourversionnumber.com',
    context: { 'ses:FromAddress': from }
  });
  assert.ok(allows('SenderRole', send('Release Notes <notes@yourversionnumber.com>')));
  assert.ok(!allows('SenderRole', send('Someone <someone@yourversionnumber.com>')));
  assert.ok(!allows('EventsRole', send('Release Notes <notes@yourversionnumber.com>')));
});
