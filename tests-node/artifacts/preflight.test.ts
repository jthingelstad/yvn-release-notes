import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STSClient } from '@aws-sdk/client-sts';
import { main } from '../../tools/native-artifacts.ts';

test('artifact preflight rejects malformed options before touching AWS', async (t) => {
  let attempts = 0;
  t.mock.method(STSClient.prototype, 'send', () => {
    attempts++;
    throw new Error('AWS must not be called');
  });
  const complete = [
    '--build-dir',
    '/fictional/build',
    '--receipt-dir',
    '/fictional/receipt',
    '--commit',
    'a'.repeat(40)
  ];
  for (const args of [
    [],
    ['--unknown', 'x'],
    ['--build-dir'],
    [...complete, '--commit', 'b'.repeat(40)],
    [...complete.slice(0, -1), 'A'.repeat(40)],
    ['--build-dir', 'relative', ...complete.slice(2)],
    ['--build-dir', '/build', '--receipt-dir', 'relative', '--commit', 'a'.repeat(40)]
  ]) {
    await assert.rejects(
      main(args),
      /Invalid artifact option|Absolute build\/receipt paths and a source commit are required/
    );
  }
  assert.equal(attempts, 0);
});
test('receipt privacy guards reject repository paths, symlink aliases and permissive external directories without AWS', async (t) => {
  let attempts = 0;
  t.mock.method(STSClient.prototype, 'send', () => {
    attempts++;
    throw new Error('AWS must not be called');
  });
  const dir = await mkdtemp(join(tmpdir(), 'yvn-artifacts-preflight-'));
  const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const invoke = (receipt: string, extra: string[] = []) =>
    main(['--build-dir', '/fictional/build', '--receipt-dir', receipt, '--commit', 'a'.repeat(40), ...extra]);
  try {
    await assert.rejects(invoke(repo), /Receipts require a private directory outside the repository/);
    const alias = join(dir, 'alias');
    await symlink(repo, alias);
    await assert.rejects(invoke(alias), /Receipts require a private directory outside the repository/);
    const publicDir = join(dir, 'public');
    await mkdir(publicDir);
    await chmod(publicDir, 0o755);
    await assert.rejects(invoke(publicDir), /Receipts require a private directory outside the repository/);
    const privateDir = join(dir, 'private');
    await mkdir(privateDir, { mode: 0o700 });
    await assert.rejects(invoke(privateDir, ['--kind', 'wrong']), /Invalid artifact kind or native module path/);
    await assert.rejects(invoke(privateDir, ['--kind', 'workers']), /Invalid artifact kind or native module path/);
    await assert.rejects(
      invoke(privateDir, ['--kind', 'workers', '--native-modules', 'relative']),
      /Invalid artifact kind or native module path/
    );
    assert.equal(attempts, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
