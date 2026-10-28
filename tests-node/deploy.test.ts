/** Exercise the real release shells (scripts/release.sh, deploy.sh and
 * scripts/build-release.sh) with fictional aws, git, gh, npm and release-tool
 * stand-ins that record their calls. No AWS SDK, credentials, network calls or
 * subscriber data enter this harness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { workerNames } from '../tools/package-native.ts';
import { codeParameter } from '../tools/native-artifacts.ts';

const releaseScript = resolve('scripts/release.sh');
const commit = 'a'.repeat(40);
const account = /ACCOUNT" == (\d+)/.exec(await readFile(releaseScript, 'utf8'))?.[1] ?? '';
assert.ok(account);
type Event = { program: string; args: string[]; closure?: string[] };

const header = `import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const record = (program, extra = {}) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ program, args, ...extra }) + '\\n');
`;

/** The zips a release uploads, by the names the template gives their code. */
const codeNames = ['app', 'mcp', ...workerNames].map((name) => codeParameter({ name }));

/** The bundled release tool: uploads, grants and the probe, from fixtures. */
const releaseTool = `
const [command] = args;
record('cli');
const failure = process.env.FIXTURE_FAILURE;
if (failure === command) process.exit(19);
if (command === 'upload') {
  const names = ${JSON.stringify(codeNames)};
  const words = names.map((name, i) => name + '=' + String(i).repeat(64));
  if (failure === 'extra-parameter') words.push('CodeBucket=unowned');
  if (failure === 'missing-parameter') words.pop();
  console.log(words.join(' '));
} else if (command === 'policies') console.log('{"App":"confirmed","Mcp":"confirmed"}');
else if (command === 'probe') console.log('{"workers":7,"endpoints":2,"health":"ok"}');
else process.exit(5);
`;

const programs: Record<string, string> = {
  aws: `record('aws'); const joined = args.join(' '), account = process.env.FIXTURE_ACCOUNT;
if (args[0] === 'sts') console.log(account + '\\t' + (process.env.FIXTURE_ARN || 'arn:aws:sts::' + account + ':assumed-role/ProjectsCloudEngineer/fixture'));
else if (args[1] === 'describe-stack-resource') console.log(args[args.indexOf('--logical-resource-id') + 1]);
else if (args[0] === 'events') console.log('arn:aws:events:us-east-1:' + account + ':rule/' + args[args.indexOf('--name') + 1]);
else if (args[1] === 'deploy') { if (process.env.FIXTURE_FAILURE === 'deploy') process.exit(255); }
else if (args[1] === 'describe-stack-events') console.log('2026-01-01T00:00:00Z\\tNativeAppRevision\\tfictional reason');
else if (args[1] === 'describe-stacks') {
  if (joined.includes('WebBucketName')) console.log('fictional-web-bucket');
  else if (joined.includes('WebDistributionId')) console.log('FICTIONALDIST');
  else if (joined.includes('BuildId')) {
    // FIXTURE_REPLACED: another release has updated the stack after N reads.
    // FIXTURE_UPDATING: another release starts updating it after N reads, for
    // two reads, with BuildId still ours; FIXTURE_UPDATE_ENDS says how it ends:
    // rolled-back (ours stays live), replaced (theirs is) or never.
    const seen = Number(process.env.FIXTURE_REPLACED_AFTER ?? 'NaN'),
      busy = Number(process.env.FIXTURE_UPDATING_AFTER ?? 'NaN'),
      ends = process.env.FIXTURE_UPDATE_ENDS || 'rolled-back',
      file = process.env.FIXTURE_LOG + '.builds', reads = fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8')) : 0,
      settled = reads >= busy + 2 && ends !== 'never',
      status = reads >= busy && !settled ? 'UPDATE_IN_PROGRESS' : settled && ends === 'rolled-back' ? 'UPDATE_ROLLBACK_COMPLETE' : 'UPDATE_COMPLETE';
    fs.writeFileSync(file, String(reads + 1));
    console.log(status + '\t' + (reads >= seen || (settled && ends === 'replaced') ? '${'b'.repeat(40)}' : '${commit}'));
  }
}
else if (args[1] === 'head-bucket') process.exit(process.env.FIXTURE_NO_CODE_BUCKET ? 1 : 0);
else if (args[1] === 'get-bucket-policy') console.log(process.env.FIXTURE_INSECURE ? '{}' : '{"Statement":[{"Sid":"DenyInsecureTransport"}]}');
else if (args[0] === 'acm') console.log('arn:aws:acm:us-east-1:' + account + ':certificate/fictional');
else if (args[1] === 'describe-active-receipt-rule-set') console.log(process.env.FIXTURE_NO_RULE_SET ? 'None' : 'yvn-release-notes');
else if (args[0] === 'cloudfront') console.log('fixture-invalidation');`,
  git: `if (args[0] === 'archive') process.stdout.write(fs.readFileSync(process.env.FIXTURE_ARCHIVE));
else if (args[0] === 'rev-parse') {
  // FIXTURE_MAIN_MOVES: origin/main is this commit at first, another later.
  const marker = process.env.FIXTURE_LOG + '.main', moved = process.env.FIXTURE_MAIN_MOVES && fs.existsSync(marker);
  if (args[1] === 'origin/main') fs.writeFileSync(marker, '');
  console.log(args[1] === 'origin/main' && moved ? '${'b'.repeat(40)}' : '${commit}');
}
else if (args[0] === 'status' || args[0] === 'fetch') record('git');`,
  gh: `record('gh'); if (args[0] === 'run') console.log(process.env.FIXTURE_RUNNING ? '1' : '0');
else console.log(process.env.FIXTURE_RED ? '0' : '1');`,
  npm: `record('npm'); if (process.env.FIXTURE_FAILURE === 'verify' && args.includes('verify')) process.exit(18);
if (args.includes('--os=linux')) for (const name of ['sharp', '@img/colour', '@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64', 'detect-libc', 'semver', '@myriaddreamin/typst-ts-node-compiler', '@myriaddreamin/typst-ts-node-compiler-linux-arm64-gnu', '@myriaddreamin/typst-ts-node-compiler-darwin-arm64', 'unrelated']) {
  fs.mkdirSync(path.join('node_modules', name), { recursive: true }); fs.writeFileSync(path.join('node_modules', name, 'package.json'), '{}'); }
if (args.includes('verify')) { fs.mkdirSync('dist/web/assets', { recursive: true }); fs.writeFileSync('dist/web/index.html', 'fictional');
  fs.mkdirSync('dist/release', { recursive: true }); fs.writeFileSync('dist/release/index.js', ''); }`
};

type Options = {
  actions?: boolean;
  failure?: string;
  env?: Record<string, string>;
};

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'yvn-release-test-'));
  const bin = join(folder, 'bin'),
    bundle = join(folder, 'bundle'),
    repo = join(folder, 'repo'),
    log = join(folder, 'calls.jsonl');
  for (const dir of [bin, repo, join(bundle, 'release'), join(bundle, 'web/assets'), join(bundle, 'artifacts')])
    await mkdir(dir, { recursive: true });
  for (const [name, code] of Object.entries(programs))
    await writeFile(join(bin, name), `#!${process.execPath}\n` + header + code, { mode: 0o755 });
  // A release waits in 15-second sleeps; the stand-in counts them and returns.
  await writeFile(join(bin, 'sleep'), '#!/bin/sh\necho "$1" >> "$FIXTURE_LOG.sleeps"\n', { mode: 0o755 });
  await writeFile(join(bundle, 'release/package.json'), '{"type":"module"}\n');
  await writeFile(join(bundle, 'release/index.js'), header + releaseTool);
  await writeFile(join(bundle, 'template.yaml'), 'Resources: {}\n');
  await writeFile(join(bundle, 'web/index.html'), 'fictional');
  await writeFile(join(bundle, 'artifacts/manifest.json'), '{"schema":1,"artifacts":[]}\n');
  await writeFile(join(bundle, 'commit'), `${commit}\n`);
  await writeFile(join(repo, '.node-version'), `${process.versions.node.split('.')[0]}\n`);
  const environment = (options: Options) => ({
    ...process.env,
    PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
    // The suite itself may run in GitHub Actions; each case says where it runs.
    GITHUB_ACTIONS: options.actions ? 'true' : '',
    GITHUB_RUN_ID: options.actions ? '4242' : '',
    FIXTURE_LOG: log,
    FIXTURE_ACCOUNT: account,
    FIXTURE_FAILURE: options.failure ?? '',
    ...options.env
  });
  const events = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Event);
  const spawn = async (command: string[], options: Options) => {
    await writeFile(log, '');
    for (const extra of ['.builds', '.main', '.sleeps']) await rm(log + extra, { force: true });
    const result = spawnSync('bash', command, { env: environment(options), encoding: 'utf8', timeout: 30000 });
    return { result, events: await events() };
  };
  return {
    folder,
    bin,
    log,
    bundle,
    repo,
    environment,
    spawn,
    release: (flags: string[] = [], options: Options = {}) =>
      spawn([releaseScript, '--bundle', bundle, '--commit', commit, ...flags], options)
  };
}

async function withFixture(run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  try {
    await run(f);
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
}

const cli = (events: Event[], command: string) => events.filter((e) => e.program === 'cli' && e.args[0] === command);
const aws = (events: Event[], operation: string) =>
  events.filter((e) => e.program === 'aws' && e.args[1] === operation);
const steps = (events: Event[]) =>
  events
    .filter(
      (e) =>
        e.program === 'cli' || (e.program === 'aws' && ['deploy', 'sync', 'create-invalidation'].includes(e.args[1]!))
    )
    .map((e) => (e.program === 'cli' ? e.args[0]! : e.args[1]!))
    .filter((step, i, all) => step !== all[i - 1]);
function cloudWrites(events: Event[]) {
  return events.filter(
    (e) =>
      (e.program === 'cli' && ['upload', 'policies'].includes(e.args[0]!)) ||
      (e.program === 'aws' &&
        [
          'deploy',
          'create-bucket',
          'put-bucket-policy',
          'put-object',
          'sync',
          'create-invalidation',
          'set-active-receipt-rule-set'
        ].includes(e.args[1]!))
  );
}
const overrides = (deploy: Event) =>
  deploy.args.slice(deploy.args.indexOf('--parameter-overrides') + 1, deploy.args.indexOf('--tags'));

test('a release uploads the code, stages new web files, updates the stack once, then confirms grants, syncs the web app and probes', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation', 'probe']);
    const upload = cli(events, 'upload')[0]!;
    assert.equal(upload.args[upload.args.indexOf('--commit') + 1], commit);
    const deploy = aws(events, 'deploy')[0]!;
    const given = overrides(deploy);
    assert.equal(given[0], `BuildId=${commit}`);
    for (const name of codeNames)
      assert.ok(
        given.some((word) => new RegExp(`^${name}=[0-9]{64}$`).test(word)),
        name
      );
    // Jamie's settings keep their values unless the Mac sets them.
    assert.ok(!given.some((word) => /^(AdminUserId|TurnstileMode)=/.test(word)));
    assert.equal(
      deploy.args[deploy.args.indexOf('--role-arn') + 1],
      `arn:aws:iam::${account}:role/ReleaseNotesCloudFormation`
    );
    assert.ok(deploy.args.includes('Repository=jthingelstad/yvn-release-notes'));
    // The Mac keeps the code bucket's TLS policy; nothing else is written to S3.
    assert.equal(aws(events, 'put-bucket-policy').length, 1);
    assert.deepEqual(aws(events, 'put-object'), []);
    assert.match(result.stdout, new RegExp(`released ${commit}`));
  });
});

test('the web files staged before the stack update are only added: nothing served is overwritten or deleted', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release();
    assert.equal(result.status, 0, result.stderr);
    const deploy = events.indexOf(aws(events, 'deploy')[0]!),
      syncs = aws(events, 'sync'),
      before = syncs.filter((e) => events.indexOf(e) < deploy),
      after = syncs.filter((e) => events.indexOf(e) > deploy);
    // This build's files, then any page the bucket has not had (front.html,
    // which the stack update starts serving for /).
    assert.deepEqual(
      before.map((e) => e.args.slice(2, 4)),
      [
        [`${f.bundle}/web/assets/`, 's3://fictional-web-bucket/assets/'],
        [`${f.bundle}/web/`, 's3://fictional-web-bucket/']
      ]
    );
    for (const sync of before) {
      assert.ok(sync.args.includes('--no-overwrite'), sync.args.join(' '));
      assert.ok(!sync.args.includes('--delete'), sync.args.join(' '));
    }
    assert.deepEqual(
      before[1]!.args.slice(before[1]!.args.indexOf('--exclude'), before[1]!.args.indexOf('--include') + 2),
      ['--exclude', '*', '--include', '*.html']
    );
    // The web sync after it makes the bucket this build's alone, as before.
    assert.equal(after.length, 5);
    for (const sync of after) {
      assert.ok(sync.args.includes('--delete'), sync.args.join(' '));
      assert.ok(!sync.args.includes('--no-overwrite'), sync.args.join(' '));
    }
    // robots.txt and sitemap.xml go up alone, each with its type and UTF-8.
    const flag = (sync: Event, name: string) => sync.args[sync.args.indexOf(name) + 1];
    assert.ok(['robots.txt', 'sitemap.xml'].every((file) => after[2]!.args.join(' ').includes(`--exclude ${file}`)));
    assert.deepEqual(
      after.slice(3).map((sync) => [flag(sync, '--include'), flag(sync, '--content-type')]),
      [
        ['robots.txt', 'text/plain; charset=utf-8'],
        ['sitemap.xml', 'application/xml; charset=utf-8']
      ]
    );
  });
});

test('a release another one replaced stops before its web sync, or after it, and never probes', async () => {
  await withFixture(async (f) => {
    let { result, events } = await f.release([], { env: { FIXTURE_REPLACED_AFTER: '0' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing: before the web sync: the stack now runs b{40}/);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies']);

    ({ result, events } = await f.release([], { env: { FIXTURE_REPLACED_AFTER: '1' } }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /after the web sync: the stack now runs b{40}, released by another run; re-run the newer release/
    );
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation']);
  });
});

test('a release waits out another one updating the stack, then syncs if that update rolled back and stops if it landed', async () => {
  await withFixture(async (f) => {
    const sleeps = async () =>
      (await readFile(f.log + '.sleeps', 'utf8').catch(() => '')).split('\n').filter(Boolean).length;
    // Before the sync, even before BuildId moves: the other update rolls back.
    let { result, events } = await f.release([], { env: { FIXTURE_UPDATING_AFTER: '0' } });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /before the web sync: another release is updating the stack \(UPDATE_IN_PROGRESS\); waiting/
    );
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation', 'probe']);
    assert.equal(await sleeps(), 2);

    ({ result, events } = await f.release([], {
      env: { FIXTURE_UPDATING_AFTER: '0', FIXTURE_UPDATE_ENDS: 'replaced' }
    }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /refusing: before the web sync: the stack now runs b{40}, released by another run$/m);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies']);

    // After the sync: the other update lands, so its run has the web app to fix.
    ({ result, events } = await f.release([], {
      env: { FIXTURE_UPDATING_AFTER: '1', FIXTURE_UPDATE_ENDS: 'replaced' }
    }));
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /after the web sync: the stack now runs b{40}, released by another run; re-run the newer/
    );
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation']);

    ({ result, events } = await f.release([], { env: { FIXTURE_UPDATING_AFTER: '0', FIXTURE_UPDATE_ENDS: 'never' } }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /before the web sync: another release has been updating the stack for 30 minutes/);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies']);
    assert.equal(await sleeps(), 119);
  });
});

test('every parameter a release overrides is one the template declares, and the release parameters are all given', async () => {
  const template = await readFile(resolve('infra/template.yaml'), 'utf8');
  const block = template.slice(template.indexOf('\nParameters:\n'), template.indexOf('\nConditions:\n'));
  const declared = [...block.matchAll(/^ {2}([A-Za-z0-9]+):$/gm)].map((m) => m[1]!);
  const script = await readFile(releaseScript, 'utf8');
  const named = [...script.matchAll(/(?:PARAMETER_OVERRIDES\+?=\(|\s)"([A-Za-z]+)=\$/g)].map((m) => m[1]!);
  assert.deepEqual(named.sort(), [
    'AdminUserId',
    'BuildId',
    'SenderScheduleArn',
    'TranscribeDoneArn',
    'TurnstileMode',
    'WebCertificateArn',
    'WebDomain'
  ]);
  for (const name of [...named, ...codeNames])
    assert.ok(declared.includes(name), `${name} is not a template parameter`);
  // Every parameter without a default is one a release gives.
  const required = declared.filter((name) => {
    const body = block.slice(block.indexOf(`\n  ${name}:`) + 1).split(/\n  [A-Za-z]/)[0]!;
    return !/Default:/.test(body);
  });
  for (const name of required) assert.ok([...named, ...codeNames].includes(name), `${name} has no value`);
});

/** Stack flags the migration needed (retired 2026-10-20) and the parameters
 * of the phased release (retired with it). CloudFormation fails a deploy that
 * overrides a parameter the template does not declare. */
const retired = [
  'NativeWorkersEnabled',
  'NativeWorkerAliasesReady',
  'NativeWebFunctionsEnabled',
  'NativeHttpRouting',
  'NativeOriginPoliciesReady',
  'NativeWorkerBuildId',
  'NativeAppBuildId',
  'NativeMcpBuildId',
  'NativeAppCodeKey',
  'NativeMcpCodeKey',
  'NativeAppCodeVersion',
  'NativeMcpCodeVersion',
  'NativeAppRollbackRevisionId',
  'NativeMcpRollbackRevisionId',
  'NativeAppRollbackEndpoint',
  'NodeCodeKey',
  'NodeCodeVersion',
  'NodeCodeSha256',
  'NativeLiveVersion',
  'RECEIPTS_BUCKET',
  'RELEASE_LOCK',
  'native-release',
  'receipt-store',
  '--only-changed',
  '--native-http-phase',
  '--native-worker-phase'
];

test('the retired flags, release parameters and phases appear nowhere in the template, tooling or workflows', async () => {
  const sources = ['infra/template.yaml', 'deploy.sh'];
  for (const dir of ['scripts', 'tools', '.github/workflows'])
    for (const name of await readdir(resolve(dir))) sources.push(join(dir, name));
  for (const source of sources) {
    const text = await readFile(resolve(source), 'utf8');
    for (const name of retired) assert.ok(!text.includes(name), `${source} still names ${name}`);
  }
});

test('an upload that fails or gives other parameters stops before the stack update', async () => {
  await withFixture(async (f) => {
    for (const failure of ['upload', 'extra-parameter', 'missing-parameter']) {
      const { result, events } = await f.release([], { failure });
      assert.notEqual(result.status, 0, failure);
      assert.deepEqual(aws(events, 'deploy'), [], failure);
      assert.deepEqual(steps(events), ['upload'], failure);
    }
  });
});

test('a failed stack update says what failed and stops: nothing was released', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release([], { failure: 'deploy' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy']);
    assert.equal(aws(events, 'describe-stack-events').length, 1);
    assert.match(result.stderr, /NativeAppRevision\tfictional reason/);
    assert.match(result.stderr, /rolled back; nothing was released/);
  });
});

test('a grant that cannot be confirmed stops before the web app and the probe', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release([], { failure: 'policies' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies']);
  });
});

test('a failed probe fails the release and says to revert', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release([], { failure: 'probe' });
    assert.notEqual(result.status, 0);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation', 'probe']);
    assert.match(result.stderr, /live but failed its probe; revert the merge/);
  });
});

test('the Mac alone sets the administrator and the Turnstile mode, on any release', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release(['--admin-user-id=fictional-id', '--turnstile-mode=default']);
    assert.equal(result.status, 0, result.stderr);
    const given = overrides(aws(events, 'deploy')[0]!);
    assert.ok(given.includes('AdminUserId=fictional-id'));
    assert.ok(given.includes('TurnstileMode='));
  });
});

test('malformed, retired or Mac-only arguments are refused before any AWS call', async () => {
  await withFixture(async (f) => {
    for (const [flags, actions] of [
      [['--native-http-phase=publish'], false],
      [['--native-worker-phase=activate'], false],
      [['--only-changed'], false],
      [['--repo', f.repo], false],
      [['--admin-user-id=not valid!'], false],
      [['--admin-user-id=a', '--admin-user-id=b'], false],
      [['--turnstile-mode=sometimes'], false],
      [['--break-glass'], true],
      [['--admin-user-id=fictional'], true],
      [['--turnstile-mode=enforce'], true]
    ] as const) {
      const { result, events } = await f.release([...flags], { actions });
      assert.notEqual(result.status, 0, flags.join(' '));
      assert.deepEqual(events, [], flags.join(' '));
    }
    const { result, events } = await f.spawn([releaseScript, '--check-arguments', '--admin-user-id='], {});
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events, []);
    await writeFile(join(f.bundle, 'commit'), `${'c'.repeat(40)}\n`);
    const other = await f.release();
    assert.match(other.result.stderr, /another commit/);
    assert.deepEqual(other.events, []);
  });
});

test('in GitHub Actions the deploy role releases and identifiers are masked', async () => {
  await withFixture(async (f) => {
    const actions = {
      actions: true,
      env: {
        FIXTURE_ARN: `arn:aws:sts::${account}:assumed-role/ReleaseNotesGitHubDeploy/run`,
        FIXTURE_NO_RULE_SET: '1'
      }
    };
    const { result, events } = await f.release([], actions);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.ok(lines.includes(`::add-mask::${account}`));
    for (const line of lines.filter((l) => !l.startsWith('::add-mask::'))) assert.ok(!line.includes(account), line);
    assert.ok(lines.includes('::add-mask::fictional-web-bucket') && lines.includes('::add-mask::FICTIONALDIST'));
    assert.ok(lines.some((line) => line.startsWith('::add-mask::arn:aws:acm:')));
    // It can use the code bucket but never creates or reconfigures it, nor SES.
    assert.deepEqual([...aws(events, 'create-bucket'), ...aws(events, 'put-bucket-policy')], []);
    assert.deepEqual(aws(events, 'set-active-receipt-rule-set'), []);
    assert.match(result.stdout, /::warning::No SES receipt rule set/);
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation', 'probe']);

    for (const env of [{ FIXTURE_NO_CODE_BUCKET: '1' }, { FIXTURE_INSECURE: '1' }] as Record<string, string>[]) {
      const refused = await f.release([], { ...actions, env: { ...actions.env, ...env } });
      assert.notEqual(refused.result.status, 0);
      assert.match(refused.result.stderr, /deploy\.sh run on the Mac/);
      assert.deepEqual(cloudWrites(refused.events), []);
    }
  });
});

test('only the cloud engineer releases outside GitHub Actions, and only this account anywhere', async () => {
  await withFixture(async (f) => {
    for (const [env, actions] of [
      [{ FIXTURE_ARN: `arn:aws:sts::${account}:assumed-role/ReleaseNotesGitHubDeploy/run` }, false],
      [{ FIXTURE_ARN: `arn:aws:sts::${account}:assumed-role/SomethingElse/run` }, true],
      [{ FIXTURE_ACCOUNT: '123456789012' }, false]
    ] as const) {
      const { result, events } = await f.release([], { actions, env });
      assert.notEqual(result.status, 0);
      assert.deepEqual(
        events.filter((e) => e.program !== 'aws' || e.args[0] !== 'sts'),
        []
      );
    }
  });
});

test('deploy.sh builds the committed tree with build-release.sh, then hands it to release.sh', async () => {
  await withFixture(async (f) => {
    const shell = (await readFile(resolve('deploy.sh'), 'utf8')).replace(
      '[[ -d "/opt/homebrew/opt/node@$NODE_MAJOR/bin" ]] && PATH="/opt/homebrew/opt/node@$NODE_MAJOR/bin:$PATH"',
      '# Fixture PATH supplies the test Node; no host PATH promotion.'
    );
    assert.ok(!shell.includes('/opt/homebrew'));
    await writeFile(join(f.repo, 'deploy.sh'), shell, { mode: 0o755 });
    await mkdir(join(f.repo, 'scripts'));
    await cp(releaseScript, join(f.repo, 'scripts/release.sh'));
    // The archived tree's build script: copies the fixture bundle, or fails.
    const archive = join(f.folder, 'archive');
    await mkdir(join(archive, 'scripts'), { recursive: true });
    await writeFile(
      join(archive, 'scripts/build-release.sh'),
      `#!/usr/bin/env bash\nset -e\n"${f.bin}/npm" build "$@"\nif [[ -n "$FIXTURE_BUILD_FAILS" ]]; then exit 1; fi\ncp -R "${f.bundle}" "$2"\n`,
      { mode: 0o755 }
    );
    const tar = join(f.folder, 'archive.tar');
    assert.equal(spawnSync('tar', ['-cf', tar, '-C', archive, '.']).status, 0);
    const deploy = (flags: string[], options: Options = {}) =>
      f.spawn([join(f.repo, 'deploy.sh'), ...flags], {
        ...options,
        env: { FIXTURE_ARCHIVE: tar, ...options.env }
      });

    let { result, events } = await deploy(['--turnstile-mode=observe']);
    assert.equal(result.status, 0, result.stderr);
    const build = events.find((e) => e.program === 'npm' && e.args[0] === 'build')!;
    assert.equal(build.args[3], commit);
    assert.ok(events.some((e) => e.program === 'git'));
    assert.ok(events.some((e) => e.program === 'gh'));
    assert.ok(events.indexOf(build) < events.indexOf(cli(events, 'upload')[0]!));
    assert.ok(overrides(aws(events, 'deploy')[0]!).includes('TurnstileMode=observe'));
    assert.deepEqual(steps(events), ['upload', 'sync', 'deploy', 'policies', 'sync', 'create-invalidation', 'probe']);

    ({ result, events } = await deploy([], { env: { FIXTURE_BUILD_FAILS: '1' } }));
    assert.notEqual(result.status, 0);
    assert.deepEqual(cloudWrites(events), []);

    ({ result, events } = await deploy([], { env: { FIXTURE_RED: '1' } }));
    assert.match(result.stderr, /validate is not green/);
    assert.deepEqual(cloudWrites(events), []);

    // GitHub's queue cannot see the Mac, so the Mac waits for it.
    ({ result, events } = await deploy([], { env: { FIXTURE_RUNNING: '1' } }));
    assert.match(result.stderr, /a GitHub release is running/);
    assert.deepEqual(cloudWrites(events), []);
    assert.ok(!events.some((e) => e.program === 'npm'));

    ({ result, events } = await deploy([], { env: { FIXTURE_MAIN_MOVES: '1' } }));
    assert.match(result.stderr, /main moved while this built/);
    assert.ok(events.some((e) => e.program === 'npm' && e.args[0] === 'build'));
    assert.deepEqual(cloudWrites(events), []);

    for (const [flags, options] of [
      [['--native-http-phase=publish'], {}],
      [[], { actions: true }]
    ] as const) {
      ({ result, events } = await deploy([...flags], options));
      assert.equal(result.status, 2);
      assert.deepEqual(events, []);
    }
  });
});

test('build-release.sh stages only Sharp’s Linux Arm64 closure and refuses to overwrite a bundle', async () => {
  await withFixture(async (f) => {
    const source = join(f.folder, 'source'),
      out = join(f.folder, 'out');
    for (const dir of ['scripts', 'tools', 'infra', 'node_modules/tsx'])
      await mkdir(join(source, dir), { recursive: true });
    await cp(resolve('scripts/build-release.sh'), join(source, 'scripts/build-release.sh'));
    await writeFile(join(source, '.node-version'), `${process.versions.node.split('.')[0]}\n`);
    await writeFile(join(source, 'package.json'), '{"type":"module"}\n');
    await writeFile(join(source, 'package-lock.json'), '{}\n');
    await writeFile(join(source, 'infra/template.yaml'), 'Resources: {}\n');
    await writeFile(join(source, 'node_modules/tsx/package.json'), '{"type":"module","exports":"./index.js"}\n');
    await writeFile(join(source, 'node_modules/tsx/index.js'), 'export {};\n');
    await writeFile(
      join(source, 'tools/release-cli.ts'),
      header +
        `const modules = args[args.indexOf('--native-modules') + 1], out = args[args.indexOf('--out') + 1], closure = [];
for (const name of fs.readdirSync(modules).sort())
  if (name.startsWith('@')) for (const sub of fs.readdirSync(path.join(modules, name)).sort()) closure.push(name + '/' + sub); else closure.push(name);
record('package', { closure });
fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'manifest.json'), '{}');`
    );
    const build = () => f.spawn([join(source, 'scripts/build-release.sh'), source, out, commit], {});
    const { result, events } = await build();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events.find((e) => e.program === 'package')!.closure, [
      '@img/colour',
      '@img/sharp-libvips-linux-arm64',
      '@img/sharp-linux-arm64',
      '@myriaddreamin/typst-ts-node-compiler',
      '@myriaddreamin/typst-ts-node-compiler-linux-arm64-gnu',
      'detect-libc',
      'semver',
      'sharp'
    ]);
    assert.ok(
      events.filter((e) => e.program === 'npm').every((e) => e.args[0] !== 'ci' || e.args.includes('--ignore-scripts'))
    );
    for (const file of ['web/index.html', 'release/index.js', 'artifacts/manifest.json', 'template.yaml'])
      await access(join(out, file));
    assert.equal((await readFile(join(out, 'commit'), 'utf8')).trim(), commit);
    const again = await build();
    assert.notEqual(again.result.status, 0);
    assert.match(again.result.stderr, /already exists/);
  });
});
