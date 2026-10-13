import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  S3Client,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { createObjects } from '../../packages/backend/aws.ts';

test('large archives upload exact bounded parts and ordered receipts without loading the archive', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'export-sdk-'));
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
  const calls: unknown[] = [];
  const bodies: Buffer[] = [];
  client.send = (async (command: { input: Record<string, unknown> }) => {
    calls.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'test-upload' };
    if (command instanceof UploadPartCommand) {
      bodies.push(Buffer.from(command.input.Body as Buffer));
      assert.equal(command.input.ContentLength, bodies.at(-1)?.length);
      return { ETag: `part-${command.input.PartNumber}` };
    }
    return {};
  }) as typeof client.send;
  try {
    const bytes = Buffer.alloc(17 * 1024 * 1024 + 19, 123),
      path = join(directory, 'archive.zip');
    await writeFile(path, bytes);
    await createObjects('fictional-bucket', 'us-east-1', client).uploadFile('exports/u/a.zip', path, {
      type: 'application/zip'
    });
    assert.deepEqual(
      bodies.map((b) => b.length),
      [8 * 1024 * 1024, 8 * 1024 * 1024, 1024 * 1024 + 19]
    );
    assert.deepEqual(Buffer.concat(bodies), bytes);
    const completion = calls.at(-1) as CompleteMultipartUploadCommand;
    assert.ok(completion instanceof CompleteMultipartUploadCommand);
    assert.deepEqual(
      completion.input.MultipartUpload?.Parts,
      [1, 2, 3].map((PartNumber) => ({ PartNumber, ETag: `part-${PartNumber}` }))
    );
  } finally {
    client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
test('multipart receipt failure aborts the upload and preserves the failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'export-sdk-'));
  const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } });
  const calls: unknown[] = [];
  client.send = (async (command: unknown) => {
    calls.push(command);
    if (command instanceof CreateMultipartUploadCommand) return { UploadId: 'test-upload' };
    return {};
  }) as typeof client.send;
  try {
    const path = join(directory, 'archive.zip');
    await writeFile(path, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(
      createObjects('fictional-bucket', 'us-east-1', client).uploadFile('exports/u/a.zip', path, {
        type: 'application/zip'
      }),
      /Missing multipart receipt/
    );
    assert.ok(calls.at(-1) instanceof AbortMultipartUploadCommand);
    assert.ok(!calls.some((c) => c instanceof CompleteMultipartUploadCommand));
  } finally {
    client.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
