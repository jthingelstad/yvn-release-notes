/** Release receipts and the deploy lock, in the private receipts bucket that
 * infra/github-deploy-role.yaml makes. The Mac and GitHub Actions share both.
 * Receipts are JSON documents under receipts/: most are written once (a second
 * write is refused), and the two policy journals are rewritten (the bucket
 * keeps every version). The lock is locks/deploy.lock, created only when
 * absent and deleted only by the run that holds it, named by its ETag. A stale
 * lock is never taken over: someone looks at it first. Names never reach
 * logs with their contents; errors say what failed, not what was stored. */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  type PutObjectCommandInput
} from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

export const receiptsBucket = (account: string) => `yvn-rn-deploy-receipts-${account}`;
export const MIGRATION_MARKER = 'complete.json';
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.json$/;

export interface ReceiptStore {
  readRaw(name: string): Promise<Buffer | undefined>;
  /** Write once; refuses a name that already exists. */
  createRaw(name: string, body: Buffer): Promise<void>;
  /** Rewrite; only the policy journals use this. */
  writeRaw(name: string, body: Buffer): Promise<void>;
}

export type LockRecord = { runId: string; owner: string; commit: string; startedAt: string };
export interface DeployLock {
  acquire(owner: string, commit: string): Promise<string>;
  assertHeld(runId: string): Promise<void>;
  release(runId: string): Promise<void>;
}

export function serialize(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}
export function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error('Invalid receipt name');
  return name;
}
export async function readReceipt<T>(store: ReceiptStore, name: string): Promise<T | undefined> {
  const body = await store.readRaw(checkName(name));
  return body === undefined ? undefined : (JSON.parse(body.toString('utf8')) as T);
}
export async function createReceipt(store: ReceiptStore, name: string, value: unknown) {
  await store.createRaw(checkName(name), serialize(value));
}
export async function writeReceipt(store: ReceiptStore, name: string, value: unknown) {
  await store.writeRaw(checkName(name), serialize(value));
}

const errorName = (error: unknown) => (error instanceof Error ? error.name : '');
const missing = (error: unknown) => ['NoSuchKey', 'NotFound'].includes(errorName(error));
// 412 when the object exists; 409 when another conditional write is in flight.
const taken = (error: unknown) => ['PreconditionFailed', 'ConditionalRequestConflict'].includes(errorName(error));

type Send = Pick<S3Client, 'send'>;
async function getObject(s3: Send, bucket: string, account: string, key: string) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, ExpectedBucketOwner: account }));
    const body = Buffer.from((await response.Body?.transformToByteArray()) ?? []);
    return { body, etag: response.ETag };
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}
function put(bucket: string, account: string, key: string, body: Buffer): PutObjectCommandInput {
  return {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    ServerSideEncryption: 'AES256',
    ExpectedBucketOwner: account
  };
}

export class S3ReceiptStore implements ReceiptStore {
  constructor(
    private readonly s3: Send,
    private readonly bucket: string,
    private readonly account: string,
    private readonly prefix = 'receipts/'
  ) {}
  async readRaw(name: string) {
    return (await getObject(this.s3, this.bucket, this.account, this.prefix + checkName(name)))?.body;
  }
  async createRaw(name: string, body: Buffer) {
    try {
      await this.s3.send(
        new PutObjectCommand({
          ...put(this.bucket, this.account, this.prefix + checkName(name), body),
          IfNoneMatch: '*'
        })
      );
    } catch (error) {
      if (taken(error)) throw new Error('Receipt already exists');
      throw error;
    }
  }
  async writeRaw(name: string, body: Buffer) {
    await this.s3.send(new PutObjectCommand(put(this.bucket, this.account, this.prefix + checkName(name), body)));
  }
}

export class S3DeployLock implements DeployLock {
  private readonly key = 'locks/deploy.lock';
  constructor(
    private readonly s3: Send,
    private readonly bucket: string,
    private readonly account: string
  ) {}
  private async current() {
    const found = await getObject(this.s3, this.bucket, this.account, this.key);
    return found && { record: JSON.parse(found.body.toString('utf8')) as LockRecord, etag: found.etag };
  }
  async acquire(owner: string, commit: string) {
    const record: LockRecord = { runId: randomUUID(), owner, commit, startedAt: new Date().toISOString() };
    try {
      await this.s3.send(
        new PutObjectCommand({ ...put(this.bucket, this.account, this.key, serialize(record)), IfNoneMatch: '*' })
      );
    } catch (error) {
      if (!taken(error)) throw error;
      const held = (await this.current())?.record;
      throw new Error(
        `Another deployment holds the deploy lock${held ? ` (${held.owner}, since ${held.startedAt})` : ''}; ` +
          'find out what happened to it before deleting locks/deploy.lock by hand'
      );
    }
    return record.runId;
  }
  async assertHeld(runId: string) {
    if ((await this.current())?.record.runId !== runId) throw new Error('This run does not hold the deploy lock');
  }
  async release(runId: string) {
    const held = await this.current();
    if (!held || held.record.runId !== runId || !held.etag) throw new Error('This run does not hold the deploy lock');
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: this.key,
        IfMatch: held.etag,
        ExpectedBucketOwner: this.account
      })
    );
  }
}

/** Fictional stores for tests: the same write-once and ownership rules. */
export class MemoryReceiptStore implements ReceiptStore {
  readonly objects = new Map<string, Buffer>();
  async readRaw(name: string) {
    return this.objects.get(checkName(name));
  }
  async createRaw(name: string, body: Buffer) {
    if (this.objects.has(checkName(name))) throw new Error('Receipt already exists');
    this.objects.set(name, Buffer.from(body));
  }
  async writeRaw(name: string, body: Buffer) {
    this.objects.set(checkName(name), Buffer.from(body));
  }
  names() {
    return [...this.objects.keys()].sort();
  }
}
export class MemoryDeployLock implements DeployLock {
  held: LockRecord | undefined;
  async acquire(owner: string, commit: string) {
    if (this.held) throw new Error('Another deployment holds the deploy lock');
    this.held = { runId: randomUUID(), owner, commit, startedAt: new Date().toISOString() };
    return this.held.runId;
  }
  async assertHeld(runId: string) {
    if (this.held?.runId !== runId) throw new Error('This run does not hold the deploy lock');
  }
  async release(runId: string) {
    await this.assertHeld(runId);
    this.held = undefined;
  }
}
