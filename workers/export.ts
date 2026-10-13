/** Zip export worker. Uses temporary disk and bounded object reads, preserves
 * file bytes, checks the live owner/build before and after uploading, and
 * removes its own archive if deletion or a newer build wins the race. */
import { ZipFile } from 'yazl';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, markdown, filePaths } from '../packages/backend/export.ts';
import { createObjects, createStore } from '../packages/backend/aws.ts';
import { missing, safeLog, type Objects, type Log } from '../packages/backend/services.ts';
import { iso, validDay } from '../packages/domain/dates.ts';
import type { Store, Item } from '../packages/backend/store.ts';
export const READY_FOR = 24 * 3600,
  BUILDING_FOR = 16 * 60;
export const zipKey = (user: string, id: string) => `exports/${user}/${id}.zip`;
export interface ExportContext {
  store: Pick<Store, 'export' | 'userItems' | 'finishExportGuarded' | 'profile'>;
  objects: Objects;
  now: number;
  clock?: () => number;
  log?: Log;
}
export async function writeZip(
  path: string,
  items: readonly Item[],
  objects: Objects,
  now: number,
  owner: string
): Promise<{ files: number; missing: number }> {
  const stamp = iso(now),
    top = `release-notes-${stamp.slice(0, 10)}/`,
    files = filePaths(items, owner),
    data = build(items, stamp, files),
    zip = new ZipFile();
  const temp = await mkdtemp(join(tmpdir(), 'release-files-')),
    counts = { files: 0, missing: 0 };
  const output = zip.outputStream as Readable;
  zip.on('error', (error) => output.destroy(error instanceof Error ? error : new Error('Zip input failed')));
  const completion = pipeline(output, createWriteStream(path));
  // Observe a destination error immediately even while source files are fetched.
  let outputError: unknown = null;
  void completion.catch((error) => {
    outputError = error;
  });
  const epoch = (day: string) => new Date(`${day < '1980-01-01' ? '1980-01-01' : day}T12:00:00Z`);
  try {
    zip.addBuffer(Buffer.from(markdown(data)), top + 'release-notes.md', {
      mtime: new Date(now * 1000),
      compress: true
    });
    zip.addBuffer(Buffer.from(JSON.stringify(data, null, 2) + '\n'), top + 'release-notes.json', {
      mtime: new Date(now * 1000),
      compress: true
    });
    for (const entries of Object.values(files))
      for (const f of entries) {
        if (outputError) throw outputError;
        let body: Buffer;
        try {
          body = (await objects.get(f.key)).body;
        } catch (error) {
          if (!missing(error)) throw error;
          counts.missing++;
          continue;
        }
        const local = join(temp, String(counts.files));
        await writeFile(local, body);
        const day = f.path.split('/').at(-1)!.slice(0, 10);
        if (!validDay(day)) throw new Error('Invalid exported day');
        zip.addFile(local, top + f.path, { mtime: epoch(day), compress: false, forceZip64Format: true });
        counts.files++;
      }
    zip.end();
    await completion;
    return counts;
  } catch (error) {
    output.destroy(error instanceof Error ? error : new Error('Zip build failed'));
    await completion.catch(() => undefined);
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function run(context: ExportContext, user: string, id: string): Promise<'ready' | 'replaced' | 'skipped'> {
  const { store, objects, now } = context,
    clock = context.clock ?? (() => Date.now() / 1000),
    log = context.log ?? safeLog;
  const found = await store.export(user),
    profile = await store.profile(user, true);
  if (
    !found ||
    found.id !== id ||
    found.status !== 'building' ||
    !profile ||
    profile.mcp_deleting ||
    profile.deleting
  ) {
    log({ event: 'export-skipped', user });
    return 'skipped';
  }
  const started = clock(),
    key = zipKey(user, id),
    temp = await mkdtemp(join(tmpdir(), 'release-export-'));
  let counts: { files: number; missing: number }, size: number;
  try {
    const path = join(temp, 'export.zip');
    counts = await writeZip(path, await store.userItems(user), objects, now, user);
    size = (await stat(path)).size;
    const current = await store.profile(user, true),
      build = await store.export(user);
    if (!current || current.mcp_deleting || current.deleting || build?.id !== id || build.status !== 'building') {
      log({ event: 'export-replaced', user });
      return 'replaced';
    }
    await objects.uploadFile(key, path, { type: 'application/zip' });
  } catch (error) {
    await store.finishExportGuarded(user, id, { status: 'failed', finished_at: Math.floor(clock()) });
    log({ event: 'export-failed', user });
    throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  const finished = Math.floor(clock()),
    live = await store.profile(user, true);
  if (
    !live ||
    live.deleting ||
    live.mcp_deleting ||
    !(await store.finishExportGuarded(user, id, {
      status: 'ready',
      finished_at: finished,
      export_key: key,
      size,
      files: counts.files,
      expires_at: finished + READY_FOR
    }))
  ) {
    await objects.remove(key);
    log({ event: 'export-replaced', user });
    return 'replaced';
  }
  log({ event: 'export-built', user, size, seconds: Math.round((clock() - started) * 10) / 10, ...counts });
  return 'ready';
}
let runtime: Pick<ExportContext, 'store' | 'objects'> | undefined;
export async function handler(
  event: { user_id?: unknown; id?: unknown },
  _lambdaContext: unknown,
  services?: ExportContext
) {
  if (
    typeof event.user_id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(event.user_id) ||
    typeof event.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(event.id)
  )
    throw new Error('Invalid export invocation');
  if (!services) {
    runtime ??= { store: createStore(process.env.TABLE ?? ''), objects: createObjects(process.env.MAIL_BUCKET ?? '') };
    services = { ...runtime, now: Math.floor(Date.now() / 1000) };
  }
  return run(services, event.user_id, event.id);
}
