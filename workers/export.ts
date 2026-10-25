import { runtimeSelfTest } from './runtime.ts';
/** Zip export and book worker. Uses temporary disk and bounded object reads,
 * preserves file bytes, checks the live owner/build before and after
 * uploading, and removes its own archive if deletion or a newer build wins
 * the race. A book (`kind: 'book'`, packages/book) is built the same way
 * from its own row, BOOK; its renderer loads only when a book is asked for.
 * A book with commentary has Claude write it while the photos are made, and
 * reads the API key only then. */
import { ZipFile } from 'yazl';
import { mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { build, markdown, filePaths } from '../packages/backend/export.ts';
import { createObjects, createStore } from '../packages/backend/aws.ts';
import { missing, safeLog, type Objects, type Log } from '../packages/backend/services.ts';
import { iso, localDay, validDay } from '../packages/domain/dates.ts';
import { bookPlan } from '../packages/book/data.ts';
import { isPageSize } from '../packages/book/limits.ts';
import { keyFrom } from '../packages/backend/describe.ts';
import * as commentary from '../packages/book/commentary.ts';
import type { Store, Item } from '../packages/backend/store.ts';
export const READY_FOR = 24 * 3600,
  BUILDING_FOR = 16 * 60;
export const zipKey = (user: string, id: string) => `exports/${user}/${id}.zip`;
export const bookKey = (user: string, id: string) => `exports/${user}/${id}.pdf`;
/** A book stops fetching photos this long after it starts, leaving time to
 * typeset and upload inside the function's fifteen minutes. */
export const BOOK_PHOTOS_FOR = 12 * 60;
export interface ExportContext {
  store: Pick<
    Store,
    'export' | 'exportItems' | 'finishExportGuarded' | 'profile' | 'notesBetween' | 'weatherBetween' | 'placesBetween'
  >;
  objects: Objects;
  now: number;
  clock?: () => number;
  log?: Log;
  /** Claude, for a book with commentary; asked for only then. */
  writer?: () => Promise<commentary.Writer>;
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
    counts = await writeZip(path, await store.exportItems(user), objects, now, user);
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
/** One book: the span on its BOOK row, typeset to a PDF under exports/. */
export async function runBook(
  context: ExportContext,
  user: string,
  id: string
): Promise<'ready' | 'replaced' | 'skipped' | 'empty' | 'unusable'> {
  const { store, objects, now } = context,
    clock = context.clock ?? (() => Date.now() / 1000),
    log = context.log ?? safeLog;
  const found = await store.export(user, 'BOOK'),
    profile = await store.profile(user, true),
    from = String(found?.from ?? ''),
    to = String(found?.to ?? ''),
    // The release it counts against, set when it was asked for (books.ts).
    release = found?.commentary === true && Number.isInteger(found.release) ? Number(found.release) : null;
  if (
    !found ||
    found.id !== id ||
    found.status !== 'building' ||
    !validDay(from) ||
    !validDay(to) ||
    !profile ||
    profile.mcp_deleting ||
    profile.deleting
  ) {
    log({ event: 'book-skipped', user });
    return 'skipped';
  }
  const started = clock(),
    key = bookKey(user, id),
    temp = await mkdtemp(join(tmpdir(), 'release-book-'));
  let size: number, made: { pages: number; photos: number; missing: number };
  try {
    const today = localDay(now, String(profile.tz));
    const [notes, sky, own] = await Promise.all([
        store.notesBetween(user, from, to),
        store.weatherBetween(user, from, to),
        store.placesBetween(user, from, to)
      ]),
      plan = await bookPlan(profile, user, from, to, notes, sky, own, {
        title: typeof found.title === 'string' ? found.title : null,
        made: today,
        page: isPageSize(found.page) ? found.page : '6x9'
      });
    if (!plan.days) {
      await store.finishExportGuarded(
        user,
        id,
        { status: 'failed', reason: 'empty', finished_at: Math.floor(clock()) },
        'BOOK'
      );
      log({ event: 'book-empty', user });
      return 'empty';
    }
    let writing: Promise<commentary.Commentary> | null = null;
    if (release !== null) {
      if (!context.writer) throw new Error('Book commentary unavailable');
      const write = await context.writer(),
        asked = clock();
      writing = write(commentary.request(plan.data)).then((answer) => {
        log({
          event: 'book-commentary',
          user,
          stop: answer.stop ?? 'none',
          input: answer.usage.input,
          output: answer.usage.output,
          seconds: Math.round(clock() - asked)
        });
        return commentary.commentaryFrom(answer, plan.data);
      });
      // Awaited before typesetting; a photo failing first mustn't leave it unheard.
      writing.catch(() => {});
    }
    const { renderBook } = await import('../packages/book/render.ts'),
      book = await renderBook(
        plan,
        async (stored) => {
          try {
            return (await objects.get(stored)).body;
          } catch (error) {
            if (missing(error)) return null;
            throw error;
          }
        },
        {
          now,
          clock,
          deadline: started + BOOK_PHOTOS_FOR,
          ...(writing ? { finish: async (data) => commentary.withCommentary(data, await writing!, today) } : {})
        }
      ),
      path = join(temp, 'book.pdf');
    await writeFile(path, book.pdf);
    size = book.pdf.length;
    made = { pages: book.pages, photos: book.photos, missing: book.missing };
    const current = await store.profile(user, true),
      build = await store.export(user, 'BOOK');
    if (!current || current.mcp_deleting || current.deleting || build?.id !== id || build.status !== 'building') {
      log({ event: 'book-replaced', user });
      return 'replaced';
    }
    await objects.uploadFile(key, path, { type: 'application/pdf' });
  } catch (error) {
    // Claude's part failing is said so on the page; a refusal or an answer
    // the book can't use is no fault of the service, and isn't thrown.
    const claude = error instanceof commentary.Unusable || error instanceof commentary.WriterFailed;
    await store.finishExportGuarded(
      user,
      id,
      { status: 'failed', ...(claude ? { reason: 'commentary' } : {}), finished_at: Math.floor(clock()) },
      'BOOK'
    );
    log({
      event: 'book-failed',
      user,
      ...(claude ? { cause: (error as Error).name } : {}),
      ...(error instanceof commentary.WriterFailed && error.status ? { status: error.status } : {})
    });
    if (error instanceof commentary.Unusable) return 'unusable';
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
    !(await store.finishExportGuarded(
      user,
      id,
      { status: 'ready', finished_at: finished, export_key: key, size, ...made, expires_at: finished + READY_FOR },
      'BOOK',
      // A finished book with commentary counts against its release.
      release ?? undefined
    ))
  ) {
    await objects.remove(key);
    log({ event: 'book-replaced', user });
    return 'replaced';
  }
  log({ event: 'book-built', user, size, seconds: Math.round((clock() - started) * 10) / 10, ...made });
  return 'ready';
}
/** Claude with the runtime secret's key (the photo descriptions' key), read
 * when a book first asks for commentary. */
export function claudeFrom(
  secret: string,
  client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({}),
  make: (key: string) => commentary.Writer = commentary.opusWith
): () => Promise<commentary.Writer> {
  return async () =>
    make(
      await keyFrom(
        {
          get: async (id) =>
            ((await client.send(new GetSecretValueCommand({ SecretId: id }))) as { SecretString?: string }).SecretString
        },
        secret
      )
    );
}
let runtime: Pick<ExportContext, 'store' | 'objects' | 'writer'> | undefined;
export async function runEvent(
  event: { user_id?: unknown; id?: unknown; kind?: unknown; self_test?: unknown },
  services?: ExportContext
) {
  const self = runtimeSelfTest(event);
  if (self) {
    await (await import('../packages/book/render.ts')).selfTest();
    return self;
  }
  if (
    typeof event.user_id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(event.user_id) ||
    typeof event.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(event.id) ||
    (event.kind !== undefined && event.kind !== 'book')
  )
    throw new Error('Invalid export invocation');
  if (!services) {
    runtime ??= {
      store: createStore(process.env.TABLE ?? ''),
      objects: createObjects(process.env.MAIL_BUCKET ?? ''),
      writer: claudeFrom(process.env.SECRET ?? '')
    };
    services = { ...runtime, now: Math.floor(Date.now() / 1000) };
  }
  return event.kind === 'book' ? runBook(services, event.user_id, event.id) : run(services, event.user_id, event.id);
}

/** Node 24 promise-only entrypoint; dependency injection belongs to runEvent. */
export async function handler(event: Parameters<typeof runEvent>[0], _context?: unknown) {
  return runEvent(event);
}
