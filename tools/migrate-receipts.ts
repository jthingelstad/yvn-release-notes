/** One-time move of the Mac's local release receipts into the receipts bucket,
 * and the check that every one arrived byte for byte. Run on the Mac with the
 * cloud-engineer profile, through tools/release-cli.ts: `migrate-receipts
 * --from DIR`, then the same with --check. Copying is write-once and safe to
 * repeat; a receipt already in the bucket with different bytes stops it. The
 * marker it writes last is what lets the release tools use the bucket.
 * Prints counts only, never receipt contents or names. */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { MIGRATION_MARKER, checkName, serialize, type ReceiptStore } from './receipt-store.ts';

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
type Marker = { schema: 1; receipts: number; digest: string; migratedAt: string };

async function localReceipts(from: string) {
  if (!isAbsolute(from)) throw new Error('An absolute receipt directory is required');
  const receipts: { name: string; body: Buffer }[] = [];
  let skipped = 0;
  for (const name of (await readdir(from)).sort()) {
    const info = await lstat(resolve(from, name));
    let valid = false;
    try {
      valid = info.isFile() && checkName(name) === name;
    } catch {
      valid = false;
    }
    if (valid) receipts.push({ name, body: await readFile(resolve(from, name)) });
    else skipped++;
  }
  const digest = sha256(Buffer.from(receipts.map((r) => `${r.name} ${sha256(r.body)}\n`).join('')));
  return { receipts, skipped, digest };
}

export async function migrateReceipts(from: string, store: ReceiptStore, marker: ReceiptStore) {
  const { receipts, skipped, digest } = await localReceipts(from);
  let copied = 0,
    present = 0;
  for (const receipt of receipts) {
    const existing = await store.readRaw(receipt.name);
    if (!existing) {
      await store.createRaw(receipt.name, receipt.body);
      copied++;
    } else if (existing.equals(receipt.body)) present++;
    else throw new Error('A receipt in the bucket differs from the local copy; stopping');
  }
  const record: Marker = { schema: 1, receipts: receipts.length, digest, migratedAt: new Date().toISOString() };
  await marker.writeRaw(MIGRATION_MARKER, serialize(record));
  return { receipts: receipts.length, copied, alreadyPresent: present, skipped };
}

export async function checkMigration(from: string, store: ReceiptStore, marker: ReceiptStore) {
  const { receipts, skipped, digest } = await localReceipts(from);
  let matching = 0,
    missing = 0,
    different = 0;
  for (const receipt of receipts) {
    const remote = await store.readRaw(receipt.name);
    if (!remote) missing++;
    else if (remote.equals(receipt.body)) matching++;
    else different++;
  }
  const recorded = await marker.readRaw(MIGRATION_MARKER);
  const record = recorded && (JSON.parse(recorded.toString('utf8')) as Marker);
  const markerState = !record
    ? 'missing'
    : record.digest === digest && record.receipts === receipts.length
      ? 'ok'
      : 'stale';
  return {
    ok: missing === 0 && different === 0 && markerState === 'ok',
    receipts: receipts.length,
    matching,
    missing,
    different,
    skipped,
    marker: markerState
  };
}
