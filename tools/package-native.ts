/** Deterministic deployment ZIPs from an already built, committed tree.
 * HTTP bundles contain only ordinary index.js + ESM metadata. Native image
 * libraries are added explicitly for the isolated description worker. */
import { ZipFile } from 'yazl';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, lstat, readFile, mkdir, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { resolve, join, relative, sep } from 'node:path';
const stamp = new Date(1980, 0, 1, 0, 0, 0);
export async function packageBundle(
  directory: string,
  destination: string,
  nativeModules?: string
): Promise<{ sha256: string; codeSha256: string }> {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const done = pipeline(output, createWriteStream(destination));
  void done.catch(() => undefined);
  zip.on('error', (error) => output.destroy(error));
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
    if (nativeModules) {
      if ((await lstat(nativeModules)).isSymbolicLink()) throw new Error('Native package contains a symlink');
      const walk = async (folder: string) => {
        for (const name of (await readdir(folder)).sort()) {
          const path = join(folder, name),
            info = await lstat(path);
          if (info.isSymbolicLink()) throw new Error('Native package contains a symlink');
          if (info.isDirectory()) await walk(path);
          else if (info.isFile())
            zip.addFile(path, 'node_modules/' + relative(nativeModules, path).split(sep).join('/'), {
              mtime: stamp,
              forceDosTimestamp: true,
              mode: 0o100644
            });
        }
      };
      await walk(nativeModules);
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
        kind === 'describe' ? nativeModules : undefined
      ))
    });
  }
  return outputs;
}
