/** Packaged artifacts and their manifest are checked before any AWS request:
 * a bundle changed after the build is refused, and unchanged code is seen as
 * unchanged. Fictional bundles only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STSClient } from '@aws-sdk/client-sts';
import { packageRelease, workerNames, type Manifest } from '../../tools/package-native.ts';
import { artifactsChanged, uploadArtifacts } from '../../tools/native-artifacts.ts';
import { MemoryReceiptStore } from '../../tools/receipt-store.ts';

async function built(run: (out: string, manifest: Manifest) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-artifacts-preflight-'));
  try {
    for (const folder of ['dist/server/app', 'dist/server/mcp', ...workerNames.map((name) => `dist/workers/${name}`)]) {
      await mkdir(join(dir, 'build', folder), { recursive: true });
      await writeFile(join(dir, 'build', folder, 'index.js'), `export const name = '${folder}';\n`);
    }
    await mkdir(join(dir, 'modules/sharp'), { recursive: true });
    await writeFile(join(dir, 'modules/sharp/package.json'), '{}\n');
    const manifest = await packageRelease(join(dir, 'build'), join(dir, 'modules'), join(dir, 'out'));
    await run(join(dir, 'out'), manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('the manifest names every HTTP and worker artifact by content hash', async () => {
  await built(async (out, manifest) => {
    assert.deepEqual(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')), manifest);
    assert.deepEqual(
      manifest.artifacts.map((a) => `${a.kind}/${a.name}`),
      ['http/app', 'http/mcp', ...workerNames.map((name) => `workers/${name}`)]
    );
    for (const artifact of manifest.artifacts) assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  });
});

test('unchanged code is recognised from the published keys; any difference is a change', async () => {
  await built(async (out, manifest) => {
    const parameters: Record<string, string> = {};
    for (const a of manifest.artifacts) {
      const name = a.name[0]!.toUpperCase() + a.name.slice(1);
      if (a.kind === 'http') parameters[`Native${name}CodeKey`] = `native/${a.name}/${a.sha256}.zip`;
      else parameters[`${name}NodeCodeKey`] = `native/workers/${a.name}/${a.sha256}.zip`;
    }
    assert.equal(await artifactsChanged('http', out, parameters), false);
    assert.equal(await artifactsChanged('workers', out, parameters), false);
    parameters.DescribeNodeCodeKey = `native/workers/describe/${'0'.repeat(64)}.zip`;
    assert.equal(await artifactsChanged('workers', out, parameters), true);
    assert.equal(await artifactsChanged('http', out, parameters), false);
    delete parameters.NativeMcpCodeKey;
    assert.equal(await artifactsChanged('http', out, parameters), true);
  });
});

test('upload refuses a changed bundle, a bad manifest or a bad commit before touching AWS', async (t) => {
  let attempts = 0;
  t.mock.method(STSClient.prototype, 'send', () => {
    attempts++;
    throw new Error('AWS must not be called');
  });
  await built(async (out) => {
    const store = new MemoryReceiptStore();
    await assert.rejects(uploadArtifacts('http', out, 'not-a-commit', store), /source commit/);
    await assert.rejects(uploadArtifacts('http', 'relative', 'a'.repeat(40), store), /absolute artifact directory/);
    await appendFile(join(out, 'mcp.zip'), 'tampered');
    await assert.rejects(uploadArtifacts('http', out, 'a'.repeat(40), store), /differs from its build manifest/);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Manifest;
    manifest.artifacts[0]!.file = '../escape.zip';
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(uploadArtifacts('http', out, 'a'.repeat(40), store), /Invalid artifact manifest/);
    assert.deepEqual(store.names(), []);
  });
  assert.equal(attempts, 0);
});
