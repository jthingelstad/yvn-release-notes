/** The receipts bucket, deploy lock, migration and release identity against a
 * fictional S3; no AWS calls, credentials or real receipts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { STSClient } from '@aws-sdk/client-sts';
import {
  MIGRATION_MARKER,
  MemoryReceiptStore,
  S3DeployLock,
  S3ReceiptStore,
  createReceipt,
  readReceipt,
  writeReceipt
} from '../../tools/receipt-store.ts';
import { checkMigration, migrateReceipts } from '../../tools/migrate-receipts.ts';
import { allowedCaller } from '../../tools/release-identity.ts';
import { main } from '../../tools/release-cli.ts';

const account = '999153317627',
  bucket = 'fictional-receipts';
const failure = (name: string) => Object.assign(new Error('fictional'), { name });

/** A versioned bucket's current objects, with S3's conditional write rules. */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; etag: string }>();
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let version = 0;
  const s3 = {
    async send(command: unknown) {
      const { input } = command as { input: Record<string, unknown> };
      calls.push({ name: (command as object).constructor.name, input });
      assert.equal(input.Bucket, bucket);
      assert.equal(input.ExpectedBucketOwner, account);
      const key = String(input.Key);
      if (command instanceof GetObjectCommand) {
        const found = objects.get(key);
        if (!found) throw failure('NoSuchKey');
        return { ETag: found.etag, Body: { transformToByteArray: async () => new Uint8Array(found.body) } };
      }
      if (command instanceof PutObjectCommand) {
        assert.equal(input.ServerSideEncryption, 'AES256');
        if (input.IfNoneMatch === '*' && objects.has(key)) throw failure('PreconditionFailed');
        objects.set(key, { body: Buffer.from(input.Body as Buffer), etag: `"etag-${++version}"` });
        return {};
      }
      if (command instanceof DeleteObjectCommand) {
        if (!input.IfMatch || objects.get(key)?.etag !== input.IfMatch) throw failure('PreconditionFailed');
        objects.delete(key);
        return {};
      }
      throw new Error('Unreviewed S3 request');
    }
  };
  return { s3, objects, calls };
}

test('receipts are written once under receipts/, journals rewritten, unsafe names refused before S3', async () => {
  const { s3, objects, calls } = fakeS3();
  const store = new S3ReceiptStore(s3, bucket, account);
  assert.equal(await readReceipt(store, 'fictional-prepared.json'), undefined);
  await createReceipt(store, 'fictional-prepared.json', { build: 'a' });
  assert.deepEqual(await readReceipt(store, 'fictional-prepared.json'), { build: 'a' });
  assert.ok(objects.has('receipts/fictional-prepared.json'));
  await assert.rejects(createReceipt(store, 'fictional-prepared.json', { build: 'b' }), /already exists/);
  assert.deepEqual(await readReceipt(store, 'fictional-prepared.json'), { build: 'a' });
  await writeReceipt(store, 'app-policy.json', { state: 'pending' });
  await writeReceipt(store, 'app-policy.json', { state: 'installed' });
  assert.deepEqual(await readReceipt(store, 'app-policy.json'), { state: 'installed' });
  const before = calls.length;
  for (const name of ['../escape.json', 'locks/deploy.json', 'notes.txt', '.hidden.json', ''])
    await assert.rejects(createReceipt(store, name, {}), /Invalid receipt name/);
  assert.equal(calls.length, before);
  assert.ok(
    calls
      .filter((c) => c.name === 'PutObjectCommand' && c.input.Key !== 'receipts/app-policy.json')
      .every((c) => c.input.IfNoneMatch === '*')
  );
});

test('the deploy lock is taken only when free, never stolen, and released only by its run and ETag', async () => {
  const { s3, objects, calls } = fakeS3();
  const lock = new S3DeployLock(s3, bucket, account),
    other = new S3DeployLock(s3, bucket, account);
  const runId = await lock.acquire('the Mac', 'a'.repeat(40));
  await lock.assertHeld(runId);
  await assert.rejects(
    other.acquire('GitHub Actions run 7', 'b'.repeat(40)),
    /holds the deploy lock \(the Mac, since /
  );
  const held = objects.get('locks/deploy.lock')!;
  assert.equal(JSON.parse(held.body.toString()).runId, runId);
  await assert.rejects(other.assertHeld('00000000-0000-0000-0000-000000000000'), /does not hold/);
  await assert.rejects(other.release('00000000-0000-0000-0000-000000000000'), /does not hold/);
  assert.equal(calls.filter((c) => c.name === 'DeleteObjectCommand').length, 0);
  await lock.release(runId);
  const deletion = calls.find((c) => c.name === 'DeleteObjectCommand')!;
  assert.equal(deletion.input.IfMatch, held.etag);
  assert.equal(objects.has('locks/deploy.lock'), false);
  await assert.rejects(lock.release(runId), /does not hold/);
  const next = await other.acquire('GitHub Actions run 7', 'b'.repeat(40));
  assert.notEqual(next, runId);
});

test('migration copies only receipt files byte for byte, repeats safely, and the check proves it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-migrate-test-'));
  try {
    const receipts = {
      [`${'a'.repeat(40)}-http-prepared.json`]: '{\n  "schema": 1\n}\n',
      'app-policy.json': '{"state":"installed"}\n',
      'artifacts-fictional.json': '{}\n'
    };
    for (const [name, body] of Object.entries(receipts)) await writeFile(join(dir, name), body);
    await mkdir(join(dir, 'deploy.lock'));
    await writeFile(join(dir, '.fictional.tmp'), 'partial');
    await writeFile(join(dir, 'notes.txt'), 'not a receipt');
    const store = new MemoryReceiptStore(),
      marker = new MemoryReceiptStore();
    assert.equal((await checkMigration(dir, store, marker)).marker, 'missing');
    assert.deepEqual(await migrateReceipts(dir, store, marker), {
      receipts: 3,
      copied: 3,
      alreadyPresent: 0,
      skipped: 3
    });
    for (const [name, body] of Object.entries(receipts)) assert.equal(store.objects.get(name)?.toString(), body);
    assert.ok(marker.objects.has(MIGRATION_MARKER));
    assert.deepEqual(await checkMigration(dir, store, marker), {
      ok: true,
      receipts: 3,
      matching: 3,
      missing: 0,
      different: 0,
      skipped: 3,
      marker: 'ok'
    });
    assert.equal((await migrateReceipts(dir, store, marker)).alreadyPresent, 3);
    store.objects.set('app-policy.json', Buffer.from('{"state":"deleted"}\n'));
    const changed = await checkMigration(dir, store, marker);
    assert.equal(changed.ok, false);
    assert.equal(changed.different, 1);
    await assert.rejects(migrateReceipts(dir, store, marker), /differs from the local copy/);
    await writeFile(join(dir, 'artifacts-later.json'), '{}\n');
    assert.equal((await checkMigration(dir, store, marker)).marker, 'stale');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the GitHub deploy role releases only inside GitHub Actions; nothing else does', () => {
  const engineer = `arn:aws:sts::${account}:assumed-role/ProjectsCloudEngineer/fictional`,
    github = `arn:aws:sts::${account}:assumed-role/ReleaseNotesGitHubDeploy/fictional`;
  assert.equal(allowedCaller(engineer, account, false), true);
  assert.equal(allowedCaller(engineer, account, true), true);
  assert.equal(allowedCaller(github, account, true), true);
  assert.equal(allowedCaller(github, account, false), false);
  assert.equal(allowedCaller(engineer, '123456789012', false), false);
  assert.equal(allowedCaller(`arn:aws:sts::${account}:assumed-role/SomethingElse/fictional`, account, true), false);
  assert.equal(allowedCaller(undefined, account, true), false);
});

test('the release CLI refuses malformed commands before any AWS request', async (t) => {
  let attempts = 0;
  t.mock.method(STSClient.prototype, 'send', () => {
    attempts++;
    throw new Error('AWS must not be called');
  });
  for (const args of [
    [],
    ['unknown'],
    ['changed', '--kind', 'everything', '--artifacts', '/fictional'],
    ['changed', '--kind', 'http', '--artifacts', 'relative'],
    ['artifacts', '--kind', 'http', '--artifacts', '/fictional', '--commit', 'A'.repeat(40)],
    [
      'artifacts',
      '--kind',
      'http',
      '--artifacts',
      '/fictional',
      '--commit',
      'a'.repeat(40),
      '--commit',
      'b'.repeat(40)
    ],
    ['native-release', 'prepare-http', '--commit', 'short'],
    ['platform', 'delete-everything'],
    ['package', '--build-dir', 'relative', '--native-modules', '/m', '--out', '/o']
  ])
    await assert.rejects(main(args));
  assert.equal(attempts, 0);
});
