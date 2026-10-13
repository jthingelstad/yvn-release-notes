import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fromBuffer, type Entry } from 'yauzl';
import { packageBundle, packageHttp, packageWorkers, workerNames } from '../../tools/package-native.ts';

async function temporary(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-package-test-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function file(path: string, body: string | Buffer) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, body);
}
function unzip(bytes: Buffer): Promise<{ name: string; body: Buffer; mode: number; time: Date }[]> {
  return new Promise((resolve, reject) =>
    fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const results: { name: string; body: Buffer; mode: number; time: Date }[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(results));
      zip.on('entry', (entry: Entry) =>
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return reject(error);
          const chunks: Buffer[] = [];
          stream.on('error', reject);
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => {
            results.push({
              name: entry.fileName,
              body: Buffer.concat(chunks),
              mode: entry.externalFileAttributes >>> 16,
              time: entry.getLastModDate()
            });
            zip.readEntry();
          });
        })
      );
      zip.readEntry();
    })
  );
}
test('HTTP artifacts contain only their own entry and ESM metadata, with verified deterministic digests', async () =>
  temporary(async (dir) => {
    const build = join(dir, 'build');
    for (const kind of ['app', 'mcp']) {
      await file(join(build, 'dist/server', kind, 'index.js'), `export const kind = '${kind}';\n`);
      await file(join(build, 'dist/server', kind, 'private.json'), 'fictional excluded configuration');
      await file(join(build, 'dist/server', kind, 'index.js.map'), 'excluded source map');
    }
    const first = await packageHttp(build, join(dir, 'first'));
    await chmod(join(build, 'dist/server/app/index.js'), 0o755);
    await utimes(join(build, 'dist/server/app/index.js'), new Date('2026-10-13'), new Date('2026-10-13'));
    const second = await packageHttp(build, join(dir, 'second'));
    assert.deepEqual(
      first.map((a) => a.kind),
      ['app', 'mcp']
    );
    assert.notEqual(first[0]!.sha256, first[1]!.sha256);
    for (let i = 0; i < first.length; i++) {
      const artifact = first[i]!,
        bytes = await readFile(artifact.path);
      assert.deepEqual(bytes, await readFile(second[i]!.path));
      assert.equal(artifact.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(artifact.codeSha256, Buffer.from(artifact.sha256, 'hex').toString('base64'));
      const entries = await unzip(bytes);
      assert.deepEqual(
        entries.map((e) => e.name),
        ['index.js', 'package.json']
      );
      assert.equal(entries[0]!.body.toString(), `export const kind = '${artifact.kind}';\n`);
      assert.equal(entries[1]!.body.toString(), '{"type":"module"}\n');
      assert.ok(entries.every((e) => e.mode === 0o100644 && e.time.getUTCFullYear() === 1980));
    }
  }));
test('all seven workers package their own entry; only describe includes sorted, unchanged native modules', async () =>
  temporary(async (dir) => {
    const build = join(dir, 'build'),
      modules = join(dir, 'native_modules');
    for (const kind of workerNames)
      await file(join(build, 'dist/workers', kind, 'index.js'), `export const worker = '${kind}';\n`);
    const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255, 128]);
    await file(join(modules, 'sharp/package.json'), '{"name":"sharp"}');
    await file(join(modules, '@img/sharp-linux-arm64/lib/sharp-linux-arm64.node'), binary);
    await file(join(modules, 'sharp/lib/index.js'), 'export default 1;');
    const artifacts = await packageWorkers(build, join(dir, 'first'), modules);
    const repeated = await packageWorkers(build, join(dir, 'second'), modules);
    assert.deepEqual(
      artifacts.map((a) => a.kind),
      [...workerNames]
    );
    for (let i = 0; i < artifacts.length; i++) {
      const artifact = artifacts[i]!,
        bytes = await readFile(artifact.path),
        entries = await unzip(bytes);
      assert.deepEqual(bytes, await readFile(repeated[i]!.path));
      assert.equal(entries[0]!.body.toString(), `export const worker = '${artifact.kind}';\n`);
      const expected = ['index.js', 'package.json'];
      if (artifact.kind === 'describe')
        expected.push(
          'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64.node',
          'node_modules/sharp/lib/index.js',
          'node_modules/sharp/package.json'
        );
      assert.deepEqual(
        entries.map((e) => e.name),
        expected
      );
      if (artifact.kind === 'describe') assert.deepEqual(entries[2]!.body, binary);
    }
  }));
test('missing entry and native symlinks reject with readable errors and remove incomplete ZIPs', async () =>
  temporary(async (dir) => {
    const entry = join(dir, 'entry'),
      modules = join(dir, 'modules'),
      output = join(dir, 'failed.zip');
    await mkdir(entry);
    await assert.rejects(packageBundle(entry, output), /ENOENT.*index\.js/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await file(join(entry, 'index.js'), 'export default 1;');
    await file(join(modules, 'safe.js'), 'safe');
    await symlink(join(modules, 'safe.js'), join(modules, 'escape.js'));
    await assert.rejects(packageBundle(entry, output, modules), /Native package contains a symlink/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await rm(join(modules, 'escape.js'));
    const alias = join(dir, 'modules-alias');
    await symlink(modules, alias);
    await assert.rejects(packageBundle(entry, output, alias), /Native package contains a symlink/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await packageBundle(entry, output, modules);
    assert.deepEqual(
      (await unzip(await readFile(output))).map((e) => e.name),
      ['index.js', 'package.json', 'node_modules/safe.js']
    );
  }));
test('destination errors retain their useful cause without removing an existing directory', async () =>
  temporary(async (dir) => {
    await file(join(dir, 'entry/index.js'), 'export default 1;');
    const output = join(dir, 'output');
    await mkdir(output);
    await assert.rejects(packageBundle(join(dir, 'entry'), output), { code: 'EISDIR' });
    assert.ok((await stat(output)).isDirectory());
  }));
