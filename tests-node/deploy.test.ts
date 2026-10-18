/** Exercise the real release shells (scripts/release.sh, deploy.sh and
 * scripts/build-release.sh) with fictional aws, git, gh, npm and release-tool
 * stand-ins that record their calls. No AWS SDK, credentials, network calls or
 * subscriber data enter this harness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const releaseScript = resolve('scripts/release.sh');
const commit = 'a'.repeat(40);
const runId = '11111111-2222-3333-4444-555555555555';
const account = /ACCOUNT" == (\d+)/.exec(await readFile(releaseScript, 'utf8'))?.[1] ?? '';
assert.ok(account);
type Event = { program: string; args: string[]; lock?: string; closure?: string[] };

const header = `import fs from 'node:fs'; import path from 'node:path';
const args = process.argv.slice(2);
const record = (program, extra = {}) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({ program, args, ...extra }) + '\\n');
`;

/** The bundled release tool: lock, phases and uploads answered from fixtures. */
const releaseTool = `
const [command, ...rest] = args;
record('cli', { lock: process.env.RELEASE_LOCK ?? '' });
const failure = process.env.FIXTURE_FAILURE;
if (command === 'lock') {
  if (rest[0] === 'acquire') {
    if (process.env.FIXTURE_LOCK_HELD) { console.error('Another deployment holds the deploy lock'); process.exit(1); }
    console.log('${runId}');
  } else if (rest[1] !== '${runId}') process.exit(3);
  else console.log('{"released":true}');
  process.exit(0);
}
if (command === 'changed') {
  const kind = rest[rest.indexOf('--kind') + 1];
  console.log(JSON.stringify({ changed: !(process.env.FIXTURE_UNCHANGED ?? '').split(',').includes(kind) }));
  process.exit(0);
}
// Receipt writers run only under the lock the shell holds.
if (process.env.RELEASE_LOCK !== '${runId}') process.exit(4);
if (command === 'native-release') {
  const phase = rest[0];
  if (failure === phase) process.exit(19);
  if (failure === 'unsafe-parameters') { console.log(JSON.stringify({ parameters: { CodeBucket: 'unowned' } })); process.exit(0); }
  if (failure === 'newline-parameters') { console.log(JSON.stringify({ parameters: { NativeHttpRouting: 'native\\nCodeBucket=unowned' } })); process.exit(0); }
  const parameters = phase === 'prepare-http' ? { NativeAppLiveRevisionId: 'baseline-app', NativeMcpLiveRevisionId: 'baseline-mcp' }
    : phase === 'promote-http' ? { NativeHttpRouting: 'native', NativeOriginPoliciesReady: 'true' }
    : phase === 'rollback-http' ? { NativeHttpRouting: 'legacy' }
    : phase === 'prepare-workers' ? { SenderNativeLiveVersion: '1', NativeWorkerAliasesReady: 'false' }
    : phase === 'promote-workers' ? { SenderNativeLiveVersion: '3', NativeWorkerAliasesReady: 'true' }
    : { SenderNativeLiveVersion: '2', NativeWorkerAliasesReady: 'true' };
  console.log(JSON.stringify({ parameters }));
} else if (command === 'artifacts') {
  const kind = rest[rest.indexOf('--kind') + 1];
  console.log(JSON.stringify({ parameters: kind === 'http'
    ? { NativeWebFunctionsEnabled: 'true', NativeAppCodeKey: 'native/app/fictional.zip', NativeAppCodeVersion: 'version with space=one' }
    : { NativeWorkersEnabled: 'true', NativeWorkerBuildId: rest[rest.indexOf('--commit') + 1], SenderNodeCodeKey: 'native/workers/sender/fictional.zip' } }));
} else if (command === 'platform') {
  if (failure === rest[0]) process.exit(20);
  console.log('{"confirmed":true}');
} else process.exit(5);
`;

const programs: Record<string, string> = {
  aws: `record('aws'); const joined = args.join(' '), account = process.env.FIXTURE_ACCOUNT;
if (args[0] === 'sts') console.log(account + '\\t' + (process.env.FIXTURE_ARN || 'arn:aws:sts::' + account + ':assumed-role/ProjectsCloudEngineer/fixture'));
else if (args[1] === 'describe-stack-resource') console.log(args[args.indexOf('--logical-resource-id') + 1]);
else if (args[0] === 'events') console.log('arn:aws:events:us-east-1:' + account + ':rule/' + args[args.indexOf('--name') + 1]);
else if (args[1] === 'describe-stacks') {
  if (joined.includes('BuildId')) console.log(process.env.FIXTURE_CANDIDATE_BUILD);
  else if (joined.includes('WebBucketName')) console.log('fictional-web-bucket');
  else if (joined.includes('WebDistributionId')) console.log('FICTIONALDIST');
  else console.log('WebBucketName\\tfictional-web-bucket\\nStackSecretOutput\\tfictional-output-' + account);
}
else if (args[1] === 'head-bucket') process.exit(process.env.FIXTURE_NO_CODE_BUCKET ? 1 : 0);
else if (args[1] === 'get-bucket-policy') console.log(process.env.FIXTURE_INSECURE ? '{}' : '{"Statement":[{"Sid":"DenyInsecureTransport"}]}');
else if (args[1] === 'put-object') fs.copyFileSync(args[args.indexOf('--body') + 1], process.env.FIXTURE_UPLOADED);
else if (args[0] === 'acm') console.log('None');
else if (args[1] === 'describe-active-receipt-rule-set') console.log(process.env.FIXTURE_NO_RULE_SET ? 'None' : 'yvn-release-notes');
else if (args[0] === 'cloudfront') console.log('fixture-invalidation');`,
  git: `const rest = args[0] === '-C' ? args.slice(2) : args;
if (rest[0] === 'archive') process.stdout.write(fs.readFileSync(process.env.FIXTURE_ARCHIVE));
else if (rest[0] === 'rev-parse') console.log('${commit}');
else if (rest[0] === 'cat-file') process.exit(process.env.FIXTURE_UNKNOWN_COMMIT ? 1 : 0);
else if (rest[0] === 'merge-base') { record('ancestry', { args: rest }); if (process.env.FIXTURE_NON_ANCESTOR) process.exit(1); }
else if (rest[0] === 'status' || rest[0] === 'fetch') record('git');`,
  gh: `record('gh'); console.log(process.env.FIXTURE_RED ? '0' : '1');`,
  npm: `record('npm'); if (process.env.FIXTURE_FAILURE === 'verify' && args.includes('verify')) process.exit(18);
if (args.includes('--os=linux')) for (const name of ['sharp', '@img/colour', '@img/sharp-linux-arm64', '@img/sharp-libvips-linux-arm64', 'detect-libc', 'semver', 'unrelated']) {
  fs.mkdirSync(path.join('node_modules', name), { recursive: true }); fs.writeFileSync(path.join('node_modules', name, 'package.json'), '{}'); }
if (args.includes('verify')) { fs.mkdirSync('dist/web/assets', { recursive: true }); fs.writeFileSync('dist/web/index.html', 'fictional');
  fs.mkdirSync('dist/release', { recursive: true }); fs.writeFileSync('dist/release/index.js', ''); }`
};

type Options = {
  actions?: boolean;
  failure?: string;
  candidate?: string;
  env?: Record<string, string>;
};

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'yvn-release-test-'));
  const bin = join(folder, 'bin'),
    bundle = join(folder, 'bundle'),
    repo = join(folder, 'repo'),
    log = join(folder, 'calls.jsonl'),
    uploaded = join(folder, 'uploaded.log');
  for (const dir of [bin, repo, join(bundle, 'release'), join(bundle, 'web/assets'), join(bundle, 'artifacts')])
    await mkdir(dir, { recursive: true });
  for (const [name, code] of Object.entries(programs))
    await writeFile(join(bin, name), `#!${process.execPath}\n` + header + code, { mode: 0o755 });
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
    GITHUB_OUTPUT: '',
    RELEASE_LOCK: '',
    FIXTURE_LOG: log,
    FIXTURE_UPLOADED: uploaded,
    FIXTURE_ACCOUNT: account,
    FIXTURE_FAILURE: options.failure ?? '',
    FIXTURE_CANDIDATE_BUILD: options.candidate ?? commit,
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
    await rm(uploaded, { force: true });
    const result = spawnSync('bash', command, { env: environment(options), encoding: 'utf8', timeout: 30000 });
    return { result, events: await events() };
  };
  return {
    folder,
    bin,
    bundle,
    repo,
    uploaded,
    environment,
    spawn,
    release: (flags: string[] = [], options: Options = {}) =>
      spawn([releaseScript, '--bundle', bundle, '--commit', commit, '--repo', repo, ...flags], options)
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
function cloudWrites(events: Event[]) {
  return events.filter(
    (e) =>
      (e.program === 'cli' && ['artifacts', 'platform'].includes(e.args[0]!)) ||
      (e.program === 'aws' &&
        [
          'deploy',
          'create-bucket',
          'put-bucket-policy',
          'sync',
          'create-invalidation',
          'set-active-receipt-rule-set'
        ].includes(e.args[1]!))
  );
}
function lockedAndReleased(events: Event[]) {
  const locks = cli(events, 'lock');
  assert.deepEqual(
    locks.map((e) => e.args[1]),
    ['acquire', 'release']
  );
  assert.equal(locks[1]!.args[2], runId);
}

test('an ordinary release holds the lock, keeps native parameters and deploys through the service role', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release();
    assert.equal(result.status, 0, result.stderr);
    lockedAndReleased(events);
    assert.deepEqual(cli(events, 'native-release'), []);
    assert.deepEqual(cli(events, 'artifacts'), []);
    assert.deepEqual(cli(events, 'platform'), []);
    const deploy = aws(events, 'deploy')[0]!;
    assert.ok(!deploy.args.some((a) => /^(Native|SenderNode|SenderNative)/.test(a)));
    assert.equal(
      deploy.args[deploy.args.indexOf('--role-arn') + 1],
      `arn:aws:iam::${account}:role/ReleaseNotesCloudFormation`
    );
    assert.ok(deploy.args.includes('Repository=jthingelstad/yvn-release-notes'));
    // The Mac keeps the code bucket's TLS policy and shows the outputs.
    assert.equal(aws(events, 'put-bucket-policy').length, 1);
    assert.match(result.stdout, /StackSecretOutput/);
    const upload = aws(events, 'put-object')[0]!;
    assert.match(upload.args[upload.args.indexOf('--key') + 1]!, /^logs\/\d{8}T\d{6}Z-aaaaaaaaaaaa-mac\.log$/);
    assert.equal(upload.args[upload.args.indexOf('--expected-bucket-owner') + 1], account);
    assert.match(await readFile(f.uploaded, 'utf8'), /StackSecretOutput/);
    const sync = events.findIndex((e) => e.program === 'aws' && e.args[1] === 'sync');
    assert.ok(sync > events.indexOf(deploy));
  });
});

test('all six native phases use structured parameters, and publication alone uploads artifacts', async () => {
  await withFixture(async (f) => {
    for (const kind of ['http', 'worker'])
      for (const phase of ['publish', 'activate', 'rollback']) {
        const { result, events } = await f.release([`--native-${kind}-phase=${phase}`]);
        assert.equal(result.status, 0, result.stderr);
        const command = `${phase === 'publish' ? 'prepare' : phase === 'activate' ? 'promote' : 'rollback'}-${kind === 'worker' ? 'workers' : kind}`;
        assert.deepEqual(
          cli(events, 'native-release').map((e) => e.args[1]),
          [command]
        );
        assert.equal(cli(events, 'artifacts').length, phase === 'publish' ? 1 : 0);
        const deploy = aws(events, 'deploy')[0]!;
        if (kind === 'http' && phase === 'publish') {
          assert.ok(deploy.args.includes('NativeAppCodeVersion=version with space=one'));
          assert.deepEqual(
            cli(events, 'platform').map((e) => e.args[1]),
            ['policy-install', 'policy-verify']
          );
          assert.ok(events.indexOf(cli(events, 'platform')[0]!) > events.indexOf(deploy));
        } else assert.deepEqual(cli(events, 'platform'), []);
        if (phase !== 'publish')
          assert.ok(deploy.args.some((a) => /^(NativeHttpRouting|SenderNativeLiveVersion)=/.test(a)));
        lockedAndReleased(events);
      }
  });
});

test('both publications combine in one update; --only-changed leaves out unchanged code', async () => {
  await withFixture(async (f) => {
    const both = ['--native-http-phase=publish', '--native-worker-phase=publish'];
    let { result, events } = await f.release(both);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      cli(events, 'native-release').map((e) => e.args[1]),
      ['prepare-http', 'prepare-workers']
    );
    assert.equal(aws(events, 'deploy').length, 1);
    ({ result, events } = await f.release([...both, '--only-changed'], { env: { FIXTURE_UNCHANGED: 'http' } }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      cli(events, 'native-release').map((e) => e.args[1]),
      ['prepare-workers']
    );
    assert.deepEqual(
      cli(events, 'artifacts').map((e) => e.args[e.args.indexOf('--kind') + 1]),
      ['workers']
    );
    assert.deepEqual(cli(events, 'platform'), []);
    assert.match(result.stdout, /HTTP artifacts unchanged/);
    ({ result, events } = await f.release([...both, '--only-changed'], { env: { FIXTURE_UNCHANGED: 'http,workers' } }));
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(cli(events, 'native-release'), []);
    assert.ok(!aws(events, 'deploy')[0]!.args.some((a) => a.startsWith('Native')));
  });
});

test('in GitHub Actions a release tells the workflow which kinds it published', async () => {
  await withFixture(async (f) => {
    const output = join(await mkdtemp(join(tmpdir(), 'yvn-release-output-')), 'output');
    const env = {
      FIXTURE_ARN: `arn:aws:sts::${account}:assumed-role/ReleaseNotesGitHubDeploy/run`,
      FIXTURE_NO_RULE_SET: '1',
      FIXTURE_UNCHANGED: 'http',
      GITHUB_OUTPUT: output
    };
    const both = ['--native-http-phase=publish', '--native-worker-phase=publish', '--only-changed'];
    const { result } = await f.release(both, { actions: true, env });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(output, 'utf8'), 'published-http=\npublished-workers=true\n');
    await rm(dirname(output), { recursive: true });
  });
});

test('preparation and malformed parameter failures stop before cloud writes and release the lock', async () => {
  await withFixture(async (f) => {
    for (const failure of ['prepare-http', 'unsafe-parameters', 'newline-parameters']) {
      const { result, events } = await f.release(['--native-http-phase=publish'], { failure });
      assert.notEqual(result.status, 0);
      assert.deepEqual(cloudWrites(events), []);
      lockedAndReleased(events);
    }
  });
});

test('a held lock is refused, never stolen, before any release action', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release(['--native-http-phase=publish'], { env: { FIXTURE_LOCK_HELD: '1' } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /holds the deploy lock/);
    assert.deepEqual(
      cli(events, 'lock').map((e) => e.args[1]),
      ['acquire']
    );
    assert.deepEqual(cli(events, 'native-release'), []);
    assert.deepEqual(cloudWrites(events), []);
  });
});

test('malformed, ambiguous or Mac-only arguments are refused before any AWS call', async () => {
  await withFixture(async (f) => {
    for (const [flags, actions] of [
      [['--native-http-phase=publish', '--native-worker-phase=activate'], false],
      [['--native-http-phase=activate', '--native-worker-phase=activate'], false],
      [['--native-http-phase=publish', '--native-http-phase=activate'], false],
      [['--native-http-phase=publish', '--events-alias-phase=activate'], false],
      [['--only-changed'], false],
      [['--native-http-phase=activate', '--only-changed'], false],
      [['--admin-user-id=fictional'], false],
      [['--native-http-phase=publish', '--turnstile-mode=sometimes'], false],
      [['--break-glass'], true],
      [['--native-http-phase=publish', '--admin-user-id=fictional'], true],
      [['--native-http-phase=publish', '--turnstile-mode=enforce'], true]
    ] as const) {
      const { result, events } = await f.release([...flags], { actions });
      assert.notEqual(result.status, 0, flags.join(' '));
      assert.deepEqual(events, [], flags.join(' '));
    }
    const { result, events } = await f.spawn(
      [releaseScript, '--check-arguments', '--native-http-phase=publish', '--admin-user-id='],
      {}
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events, []);
    await writeFile(join(f.bundle, 'commit'), `${'c'.repeat(40)}\n`);
    const other = await f.release();
    assert.match(other.result.stderr, /another commit/);
    assert.deepEqual(other.events, []);
  });
});

test('a policy installation failure stops before the web app or any activation', async () => {
  await withFixture(async (f) => {
    const { result, events } = await f.release(['--native-http-phase=publish'], { failure: 'policy-install' });
    assert.notEqual(result.status, 0);
    assert.equal(aws(events, 'deploy').length, 1);
    assert.deepEqual(
      cli(events, 'platform').map((e) => e.args[1]),
      ['policy-install']
    );
    assert.deepEqual([...aws(events, 'sync'), ...aws(events, 'create-invalidation')], []);
    lockedAndReleased(events);
  });
});

test('activation selects the validated published candidate even when main has advanced', async () => {
  await withFixture(async (f) => {
    const candidate = 'b'.repeat(40);
    const { result, events } = await f.release(['--native-http-phase=activate'], { candidate });
    assert.equal(result.status, 0, result.stderr);
    const phase = cli(events, 'native-release')[0]!;
    assert.equal(phase.args[phase.args.indexOf('--commit') + 1], candidate);
    assert.deepEqual(events.find((e) => e.program === 'ancestry')?.args, [
      'merge-base',
      '--is-ancestor',
      candidate,
      commit
    ]);
    assert.ok(events.some((e) => e.program === 'gh'));
    assert.deepEqual(cli(events, 'artifacts'), []);
  });
});

test('uncommitted, unrelated or unvalidated candidates are refused before release actions', async () => {
  await withFixture(async (f) => {
    for (const [candidate, env] of [
      ['not-a-commit', {}],
      ['b'.repeat(40), { FIXTURE_NON_ANCESTOR: '1' }],
      ['b'.repeat(40), { FIXTURE_RED: '1' }]
    ] as const) {
      const { result, events } = await f.release(['--native-worker-phase=activate'], { candidate, env });
      assert.notEqual(result.status, 0);
      assert.deepEqual(cli(events, 'native-release'), []);
      assert.deepEqual(cloudWrites(events), []);
      lockedAndReleased(events);
    }
  });
});

test('in GitHub Actions the deploy role releases, identifiers are masked and details stay private', async () => {
  await withFixture(async (f) => {
    const actions = {
      actions: true,
      env: {
        FIXTURE_ARN: `arn:aws:sts::${account}:assumed-role/ReleaseNotesGitHubDeploy/run`,
        FIXTURE_NO_RULE_SET: '1'
      }
    };
    const { result, events } = await f.release(['--native-http-phase=publish'], actions);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split('\n');
    assert.ok(lines.includes(`::add-mask::${account}`));
    for (const line of lines.filter((l) => !l.startsWith('::add-mask::')))
      assert.ok(!line.includes(account) && !line.includes('baseline-app') && !line.includes('StackSecretOutput'), line);
    assert.ok(lines.includes('::add-mask::fictional-web-bucket') && lines.includes('::add-mask::FICTIONALDIST'));
    // It can use the code bucket but never creates or reconfigures it, nor SES.
    assert.deepEqual([...aws(events, 'create-bucket'), ...aws(events, 'put-bucket-policy')], []);
    assert.deepEqual(aws(events, 'set-active-receipt-rule-set'), []);
    assert.match(result.stdout, /::warning::No SES receipt rule set/);
    const upload = aws(events, 'put-object')[0]!;
    assert.match(upload.args[upload.args.indexOf('--key') + 1]!, /-4242\.log$/);
    const kept = await readFile(f.uploaded, 'utf8');
    assert.match(kept, /native parameter NativeAppLiveRevisionId=baseline-app/);
    assert.match(kept, /StackSecretOutput/);
    lockedAndReleased(events);

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

    let { result, events } = await deploy(['--native-worker-phase=publish']);
    assert.equal(result.status, 0, result.stderr);
    const build = events.find((e) => e.program === 'npm' && e.args[0] === 'build')!;
    assert.equal(build.args[3], commit);
    assert.ok(events.some((e) => e.program === 'git'));
    assert.ok(events.some((e) => e.program === 'gh'));
    assert.ok(events.indexOf(build) < events.indexOf(cli(events, 'lock')[0]!));
    assert.deepEqual(
      cli(events, 'native-release').map((e) => e.args[1]),
      ['prepare-workers']
    );
    lockedAndReleased(events);

    ({ result, events } = await deploy([], { env: { FIXTURE_BUILD_FAILS: '1' } }));
    assert.notEqual(result.status, 0);
    assert.deepEqual(cli(events, 'lock'), []);
    assert.deepEqual(cloudWrites(events), []);

    ({ result, events } = await deploy([], { env: { FIXTURE_RED: '1' } }));
    assert.match(result.stderr, /validate is not green/);
    assert.deepEqual(cloudWrites(events), []);

    for (const [flags, options] of [
      [['--native-http-phase=publish', '--native-worker-phase=rollback'], {}],
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
  if (name === '@img') for (const sub of fs.readdirSync(path.join(modules, name)).sort()) closure.push(name + '/' + sub); else closure.push(name);
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
