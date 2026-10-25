/** Deterministic deployment ZIPs from an already built, committed tree.
 * HTTP bundles contain only ordinary index.js + ESM metadata. Native
 * packages are added by name, from the Linux Arm64 tree
 * scripts/build-release.sh stages, only to the workers that load them
 * (NATIVE), with a bundle's own assets/ (the export worker's book fonts). */
import { ZipFile } from 'yazl';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, lstat, readFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
const stamp = new Date(1980, 0, 1, 0, 0, 0);
/** Sharp's runtime closure, for the describer's thumbnails and the book's photos. */
export const SHARP = [
  '@img/colour',
  '@img/sharp-libvips-linux-arm64',
  '@img/sharp-linux-arm64',
  'detect-libc',
  'semver',
  'sharp'
] as const;
/** Typst, which typesets the export worker's books. */
export const TYPST = [
  '@myriaddreamin/typst-ts-node-compiler',
  '@myriaddreamin/typst-ts-node-compiler-linux-arm64-gnu'
] as const;
export const NATIVE: Partial<Record<(typeof workerNames)[number], readonly string[]>> = {
  describe: SHARP,
  export: [...SHARP, ...TYPST]
};
export async function packageBundle(
  directory: string,
  destination: string,
  nativeModules?: string,
  packages?: readonly string[]
): Promise<{ sha256: string; codeSha256: string }> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const done = pipeline(output, createWriteStream(destination));
  void done.catch(() => undefined);
  zip.on('error', (error) => output.destroy(error));
  const add = (path: string, name: string) =>
    zip.addFile(path, name, { mtime: stamp, forceDosTimestamp: true, mode: 0o100644 });
  const walk = async (root: string, folder: string, prefix: string) => {
    for (const name of (await readdir(folder)).sort()) {
      const path = join(folder, name),
        info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error('Native package contains a symlink');
      if (info.isDirectory()) await walk(root, path, prefix);
      else if (info.isFile()) add(path, prefix + relative(root, path).split(sep).join('/'));
    }
  };
  try {
    zip.addBuffer(await readFile(join(directory, 'index.js')), 'index.js', {
      mtime: stamp,
      forceDosTimestamp: true,
      mode: 0o100644
    });
    zip.addBuffer(Buffer.from('{"type":"module"}\n'), 'package.json', {
      mtime: stamp,
      forceDosTimestamp: true,
      mode: 0o100644
    });
    const assets = join(directory, 'assets'),
      found = await lstat(assets).catch(() => null);
    if (found?.isSymbolicLink()) throw new Error('Bundle assets contain a symlink');
    if (found?.isDirectory()) await walk(directory, assets, '');
    if (nativeModules) {
      if ((await lstat(nativeModules)).isSymbolicLink()) throw new Error('Native package contains a symlink');
      if (!packages) await walk(nativeModules, nativeModules, 'node_modules/');
      else
        for (const name of [...packages].sort()) {
          const root = join(nativeModules, name),
            info = await lstat(root).catch(() => null);
          if (!info?.isDirectory() || info.isSymbolicLink())
            throw new Error(`Native package ${name} is missing or linked`);
          await walk(nativeModules, root, 'node_modules/');
        }
    }
    zip.end();
    await done;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error('Artifact packaging failed'));
    await done.catch(() => undefined);
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(destination)) hash.update(bytes);
  const digest = hash.digest();
  return { sha256: digest.toString('hex'), codeSha256: digest.toString('base64') };
}
export async function packageHttp(buildDirectory: string, outputDirectory: string) {
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const kind of ['app', 'mcp'] as const) {
    const path = resolve(outputDirectory, `${kind}.zip`);
    outputs.push({ kind, path, ...(await packageBundle(resolve(buildDirectory, 'dist/server', kind), path)) });
  }
  return outputs;
}

export const workerNames = ['sender', 'inbound', 'events', 'transcribe', 'describe', 'export', 'capture'] as const;
export async function packageWorkers(buildDirectory: string, outputDirectory: string, nativeModules: string) {
  await mkdir(outputDirectory, { recursive: true });
  const outputs = [];
  for (const kind of workerNames) {
    const path = resolve(outputDirectory, `${kind}.zip`);
    outputs.push({
      kind,
      path,
      ...(await packageBundle(
        resolve(buildDirectory, 'dist/workers', kind),
        path,
        NATIVE[kind] ? nativeModules : undefined,
        NATIVE[kind]
      ))
    });
  }
  return outputs;
}

export type Manifest = {
  schema: 1;
  artifacts: {
    kind: 'http' | 'workers';
    name: string;
    file: string;
    sha256: string;
    codeSha256: string;
    size: number;
  }[];
};
/** Every native artifact, packaged in the build step with no cloud access,
 * and a manifest of their hashes for the deploy step to check and upload. */
export async function packageRelease(buildDirectory: string, nativeModules: string, outputDirectory: string) {
  const manifest: Manifest = { schema: 1, artifacts: [] };
  for (const [kind, artifacts] of [
    ['http', await packageHttp(buildDirectory, outputDirectory)],
    ['workers', await packageWorkers(buildDirectory, outputDirectory, nativeModules)]
  ] as const)
    for (const artifact of artifacts)
      manifest.artifacts.push({
        kind,
        name: artifact.kind,
        file: `${artifact.kind}.zip`,
        sha256: artifact.sha256,
        codeSha256: artifact.codeSha256,
        size: (await lstat(artifact.path)).size
      });
  await writeFile(resolve(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
