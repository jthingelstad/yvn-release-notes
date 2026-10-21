/** Exact SDK requests for immutable upload validation; fictional data only. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { GetObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { createObjects } from '../../packages/backend/aws.ts';

test('upload tags are read from the checked object version, never the current version', async () => {
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
  let called = false;
  client.send = (async (command: GetObjectTaggingCommand) => {
    called = true;
    assert.ok(command instanceof GetObjectTaggingCommand);
    assert.deepEqual(command.input, {
      Bucket: 'fictional-bucket',
      Key: 'media/fictional/web/photo.png',
      VersionId: 'checked-upload-version'
    });
    return { TagSet: [{ Key: 'outcome', Value: 'pending' }] };
  }) as typeof client.send;
  try {
    assert.deepEqual(
      await createObjects('fictional-bucket', 'us-east-1', client).tags(
        'media/fictional/web/photo.png',
        'checked-upload-version'
      ),
      { outcome: 'pending' }
    );
    assert.equal(called, true);
  } finally {
    client.destroy();
  }
});

test('the HTTP execution role permits version tag checks only for staged uploads', async () => {
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const role = /^  WebRole:\n([\s\S]*?)(?=^  \w+:)/m.exec(template)?.[1];
  assert.ok(role, 'WebRole must remain the HTTP execution role');
  assert.ok(template.includes('ExecutionRoleArn: !GetAtt WebRole.Arn'));
  const grants = role.split(/^\s+- Effect: /m).filter((s) => s.includes('s3:GetObjectVersionTagging'));
  assert.equal(grants.length, 1);
  assert.ok(grants[0]!.startsWith('Allow'));
  assert.match(grants[0]!, /^\s+- s3:GetObjectVersion\s*$/m);
  assert.match(grants[0]!, /^\s+Resource: !Sub "\$\{MailBucket.Arn\}\/media\/\*\/web\/\*"\s*$/m);
});
