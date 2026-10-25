/** Packaged artifacts and their manifest are checked before any AWS request,
 * and each zip is uploaded once under its content hash. Fictional bundles and
 * a fictional bucket only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { S3Client, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SHARP, TYPST, packageRelease, workerNames, type Manifest } from '../../tools/package-native.ts';
import { codeParameter, keyFor, uploadArtifacts } from '../../tools/native-artifacts.ts';

const commit = 'a'.repeat(40);

async function built(run: (out: string, manifest: Manifest) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-artifacts-preflight-'));
  try {
    for (const folder of ['dist/server/app', 'dist/server/mcp', ...workerNames.map((name) => `dist/workers/${name}`)]) {
      await mkdir(join(dir, 'build', folder), { recursive: true });
      await writeFile(join(dir, 'build', folder, 'index.js'), `export const name = '${folder}';\n`);
    }
    for (const name of [...SHARP, ...TYPST]) {
      await mkdir(join(dir, 'modules', name), { recursive: true });
      await writeFile(join(dir, 'modules', name, 'package.json'), '{}\n');
    }
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

test('each zip is a template parameter and a key named by its hash', async () => {
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  await built(async (_out, manifest) => {
    for (const artifact of manifest.artifacts) {
      const parameter = codeParameter(artifact);
      assert.ok(
        template.includes(`\n  ${parameter}:\n    Type: String\n    AllowedPattern: '^[a-f0-9]{64}$'\n`),
        parameter
      );
      const key = keyFor(artifact);
      assert.equal(
        key,
        `native/${artifact.kind === 'workers' ? 'workers/' : ''}${artifact.name}/${artifact.sha256}.zip`
      );
      const folder = key.slice(0, key.lastIndexOf('/'));
      assert.ok(template.includes(`"${folder}/\${${parameter}}.zip"`), parameter);
    }
  });
});

test('upload refuses a changed bundle, a bad manifest or a bad commit before touching AWS', async (t) => {
  let attempts = 0;
  t.mock.method(STSClient.prototype, 'send', () => {
    attempts++;
    throw new Error('AWS must not be called');
  });
  await built(async (out) => {
    await assert.rejects(uploadArtifacts(out, 'not-a-commit'), /source commit/);
    await assert.rejects(uploadArtifacts('relative', commit), /absolute artifact directory/);
    await appendFile(join(out, 'mcp.zip'), 'tampered');
    await assert.rejects(uploadArtifacts(out, commit), /differs from its build manifest/);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as Manifest;
    manifest.artifacts[0]!.file = '../escape.zip';
    await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest));
    await assert.rejects(uploadArtifacts(out, commit), /Invalid artifact manifest/);
  });
  assert.equal(attempts, 0);
});

function cloud(
  t: { mock: { method: typeof test.mock.method } },
  stored: Map<string, { sha256: string; size: number }>
) {
  const puts: PutObjectCommand['input'][] = [];
  t.mock.method(STSClient.prototype, 'send', async (command: unknown) => {
    assert.ok(command instanceof GetCallerIdentityCommand);
    return { Account: '999153317627', Arn: 'arn:aws:sts::999153317627:assumed-role/ProjectsCloudEngineer/fixture' };
  });
  t.mock.method(CloudFormationClient.prototype, 'send', async () => ({
    Stacks: [
      {
        StackId: 'arn:aws:cloudformation:us-east-1:999153317627:stack/yvn-release-notes/fictional',
        Outputs: [{ OutputKey: 'NativeSourceBucketName', OutputValue: 'fictional-bucket' }]
      }
    ]
  }));
  t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      assert.equal(command.input.Bucket, 'fictional-bucket');
      const object = stored.get(command.input.Key!);
      if (!object) throw Object.assign(new Error('fictional'), { name: 'NotFound' });
      return { Metadata: { sha256: object.sha256 }, ContentLength: object.size };
    }
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, '*');
      assert.equal(command.input.ServerSideEncryption, 'AES256');
      puts.push(command.input);
      stored.set(command.input.Key!, { sha256: command.input.Metadata!.sha256!, size: command.input.ContentLength! });
      return {};
    }
    throw new Error('Unreviewed API request');
  });
  return puts;
}

test('a zip is uploaded once under its hash, and a revert finds its code already there', async (t) => {
  await built(async (out, manifest) => {
    const stored = new Map<string, { sha256: string; size: number }>();
    const puts = cloud(t, stored);
    const first = await uploadArtifacts(out, commit);
    assert.equal(puts.length, manifest.artifacts.length);
    assert.deepEqual(
      first.parameters,
      Object.fromEntries(manifest.artifacts.map((artifact) => [codeParameter(artifact), artifact.sha256]))
    );
    for (const put of puts) assert.equal(put.Metadata?.commit, commit);
    const again = await uploadArtifacts(out, 'b'.repeat(40));
    assert.equal(puts.length, manifest.artifacts.length);
    assert.deepEqual(again.parameters, first.parameters);
  });
});

test('an object under a hash key that does not match it is refused, never overwritten', async (t) => {
  await built(async (out, manifest) => {
    const stored = new Map<string, { sha256: string; size: number }>();
    const app = manifest.artifacts[0]!;
    stored.set(keyFor(app), { sha256: '0'.repeat(64), size: app.size });
    const puts = cloud(t, stored);
    await assert.rejects(uploadArtifacts(out, commit), /does not match/);
    assert.equal(puts.length, 0);
  });
});
