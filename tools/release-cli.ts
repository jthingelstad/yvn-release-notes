/** The release tools' one entry point. scripts/build-release.sh bundles it into
 * dist/release/index.js, so scripts/release.sh runs it with no npm install
 * where the cloud credentials are. Each command prints one JSON line (or the
 * lock's run id); errors print a message, never an SDK response.
 *
 *   package --build-dir D --native-modules M --out O   packaging, no AWS
 *   changed --kind http|workers --artifacts O          does the stack serve other code?
 *   lock acquire --commit SHA | lock release RUN_ID
 *   native-release PHASE --commit SHA                  tools/native-release.ts
 *   artifacts --kind http|workers --artifacts O --commit SHA
 *   platform prepare|policy-install|policy-verify|policy-remove
 *   migrate-receipts --from DIR [--check]              once, on the Mac
 *
 * Commands that write receipts need the deploy lock: the run id in
 * RELEASE_LOCK (scripts/release.sh holds it for the whole run), or, alone, a
 * lock of their own for the command. */
import { S3Client } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRelease } from './package-native.ts';
import { artifactsChanged, uploadArtifacts } from './native-artifacts.ts';
import { main as nativeRelease } from './native-release.ts';
import { platformCommands, runPlatform, type PlatformCommand } from './web-platform.ts';
import { checkMigration, migrateReceipts } from './migrate-receipts.ts';
import { MIGRATION_MARKER, S3DeployLock, S3ReceiptStore, receiptsBucket } from './receipt-store.ts';
import { releaseIdentity, region, stackName } from './release-identity.ts';

function options(args: string[], allowed: string[], flags: string[] = []) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (flags.includes(key) && !(key in values)) values[key] = 'true';
    else if (allowed.includes(key) && args[i + 1] && !(key in values)) values[key] = args[++i]!;
    else throw new Error('Invalid release option');
  }
  return values;
}
const absolute = (value: string | undefined) => {
  if (!value || !isAbsolute(value)) throw new Error('An absolute path is required');
  return value;
};
const kindOf = (value: string | undefined) => {
  if (value !== 'http' && value !== 'workers') throw new Error('Invalid artifact kind');
  return value;
};
const commitOf = (value: string | undefined) => {
  if (!value || !/^[a-f0-9]{40}$/.test(value)) throw new Error('A committed build is required');
  return value;
};
const owner = () =>
  process.env.GITHUB_ACTIONS === 'true' ? `GitHub Actions run ${process.env.GITHUB_RUN_ID ?? ''}`.trim() : 'the Mac';

async function cloud() {
  const { account } = await releaseIdentity();
  const s3 = new S3Client({ region }),
    bucket = receiptsBucket(account);
  return {
    store: new S3ReceiptStore(s3, bucket, account),
    marker: new S3ReceiptStore(s3, bucket, account, 'migration/'),
    lock: new S3DeployLock(s3, bucket, account)
  };
}

/** Receipt-writing commands: the migration must be done, and the lock held. */
async function locked<T>(commit: string, run: (store: S3ReceiptStore) => Promise<T>) {
  const { store, marker, lock } = await cloud();
  if (!(await marker.readRaw(MIGRATION_MARKER)))
    throw new Error('The release receipts are not in the receipts bucket yet; run migrate-receipts first');
  const held = process.env.RELEASE_LOCK;
  if (held) {
    await lock.assertHeld(held);
    return run(store);
  }
  const runId = await lock.acquire(owner(), commit);
  try {
    return await run(store);
  } finally {
    await lock.release(runId);
  }
}

async function stackParameters() {
  const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName })))
    .Stacks?.[0];
  return Object.fromEntries((stack?.Parameters ?? []).map((p) => [p.ParameterKey!, p.ParameterValue!]));
}

export async function main(argv: string[]): Promise<string> {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Release tooling requires Node 24');
  const [command, ...args] = argv;
  if (command === 'package') {
    const o = options(args, ['--build-dir', '--native-modules', '--out']);
    const manifest = await packageRelease(
      absolute(o['--build-dir']),
      absolute(o['--native-modules']),
      absolute(o['--out'])
    );
    return JSON.stringify({ artifacts: manifest.artifacts.length });
  }
  if (command === 'changed') {
    const o = options(args, ['--kind', '--artifacts']);
    const kind = kindOf(o['--kind']),
      directory = absolute(o['--artifacts']);
    await releaseIdentity();
    return JSON.stringify({ changed: await artifactsChanged(kind, directory, await stackParameters()) });
  }
  if (command === 'lock') {
    const [action, ...rest] = args;
    const { lock } = await cloud();
    if (action === 'acquire') return lock.acquire(owner(), commitOf(options(rest, ['--commit'])['--commit']));
    if (action === 'release' && rest.length === 1 && /^[0-9a-f-]{36}$/.test(rest[0]!)) {
      await lock.release(rest[0]!);
      return JSON.stringify({ released: true });
    }
    throw new Error('Invalid lock command');
  }
  if (command === 'native-release') {
    const [phase, ...rest] = args;
    const commit = commitOf(options(rest, ['--commit'])['--commit']);
    return JSON.stringify(await locked(commit, (store) => nativeRelease([phase ?? '', '--commit', commit], { store })));
  }
  if (command === 'artifacts') {
    const o = options(args, ['--kind', '--artifacts', '--commit']);
    const kind = kindOf(o['--kind']),
      directory = absolute(o['--artifacts']),
      commit = commitOf(o['--commit']);
    return JSON.stringify(await locked(commit, (store) => uploadArtifacts(kind, directory, commit, store)));
  }
  if (command === 'platform') {
    const [step, ...rest] = args;
    if (!platformCommands.includes(step as PlatformCommand) || rest.length) throw new Error('Invalid platform step');
    const result = await locked('0'.repeat(40), (store) => runPlatform(step as PlatformCommand, store));
    return JSON.stringify(step === 'prepare' ? { pins: result.pins } : { confirmed: result.confirmed });
  }
  if (command === 'migrate-receipts') {
    if (process.env.GITHUB_ACTIONS === 'true') throw new Error('The receipt migration runs on the Mac');
    const o = options(args, ['--from'], ['--check']);
    const from = absolute(o['--from']);
    const { store, marker, lock } = await cloud();
    if (o['--check']) {
      const result = await checkMigration(from, store, marker);
      if (!result.ok) process.exitCode = 1;
      return JSON.stringify(result);
    }
    const runId = await lock.acquire(owner(), '0'.repeat(40));
    try {
      return JSON.stringify(await migrateReceipts(from, store, marker));
    } finally {
      await lock.release(runId);
    }
  }
  throw new Error('Unknown release command');
}

// Real paths: macOS temporary folders are /var, which Node reports as /private/var.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (output) => console.info(output),
    (error: unknown) => {
      // SDK error names, never response bodies/headers or credential chains.
      console.error(
        error instanceof Error ? (error.name === 'Error' ? error.message : error.name) : 'Release tool failed'
      );
      process.exitCode = 1;
    }
  );
