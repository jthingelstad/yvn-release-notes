/** Exercise the real release shell with fictional control-plane/tool responses.
 * No AWS SDK, credentials, network calls or subscriber data enter this harness. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = resolve('deploy.sh');
const commit = 'a'.repeat(40);
type Event = { program: string; args: string[]; closure?: string[] };

async function fixture() {
  const folder = await mkdtemp(join(tmpdir(), 'yvn-deploy-test-'));
  const repo = join(folder, 'repo'),
    archive = join(folder, 'archive'),
    bin = join(folder, 'bin');
  const receipts = join(folder, 'receipts'),
    log = join(folder, 'calls.jsonl');
  await Promise.all([mkdir(repo), mkdir(archive), mkdir(bin), mkdir(receipts, { mode: 0o700 })]);
  const shell = (await readFile(source, 'utf8')).replace(
    '[[ -d "/opt/homebrew/opt/node@$NODE_MAJOR/bin" ]] && PATH="/opt/homebrew/opt/node@$NODE_MAJOR/bin:$PATH"',
    '# Fixture PATH supplies the actual test Node and fake npm; no host PATH promotion.'
  );
  const account = /ACCOUNT" == (\d+)/.exec(shell)?.[1];
  assert.ok(account);
  await writeFile(
    join(repo, 'deploy.sh'),
    shell.replace(
      'NATIVE_RECEIPT_DIR=/Users/otto/.codex/tmp/yvn-native-release-receipts',
      `NATIVE_RECEIPT_DIR=${receipts}`
    )
  );
  await writeFile(join(repo, '.node-version'), '24\n');
  for (const dir of ['src/release_notes', 'layers', 'infra', 'tools', 'node_modules/tsx'])
    await mkdir(join(archive, dir), { recursive: true });
  await writeFile(join(archive, 'src/release_notes/example.py'), '# fictional\n');
  await writeFile(join(archive, 'layers/pillow.txt'), '# fictional lock\n');
  await writeFile(join(archive, 'infra/template.yaml'), 'Resources: {}\n');
  await writeFile(join(archive, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(archive, 'package-lock.json'), '{}\n');
  await writeFile(join(archive, 'node_modules/tsx/package.json'), '{"type":"module","exports":"./index.js"}\n');
  await writeFile(join(archive, 'node_modules/tsx/index.js'), 'export {};\n');
  const header = `import fs from 'node:fs'; import path from 'node:path';\nconst args = process.argv.slice(2);\nconst record = (program, extra={}) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify({program,args,...extra})+'\\n');\n`;
  const tools = `
const command = args[0];
record('tool');
if (process.env.FIXTURE_FAILURE === command) process.exit(19);
if (process.env.FIXTURE_FAILURE === 'unsafe-parameters') { console.log(JSON.stringify({parameters:{CodeBucket:'unowned'}})); process.exit(0); }
if (process.env.FIXTURE_FAILURE === 'newline-parameters') { console.log(JSON.stringify({parameters:{NativeHttpRouting:'native\\nCodeBucket=unowned'}})); process.exit(0); }
const parameters = command === 'prepare-http' ? {NativeAppLiveRevisionId:'baseline-app',NativeAppRollbackRevisionId:'baseline-app',NativeMcpLiveRevisionId:'baseline-mcp',NativeMcpRollbackRevisionId:'baseline-mcp'}
  : command === 'promote-http' ? {NativeHttpRouting:'native',NativeOriginPoliciesReady:'true',NativeAppLiveRevisionId:'candidate-app',NativeMcpLiveRevisionId:'candidate-mcp'}
  : command === 'rollback-http' ? {NativeHttpRouting:'legacy'}
  : command === 'prepare-workers' ? {SenderNativeLiveVersion:'1',NativeWorkerAliasesReady:'false'}
  : command === 'promote-workers' ? {SenderNativeLiveVersion:'3',NativeWorkerAliasesReady:'true'}
  : {SenderNativeLiveVersion:'2',NativeWorkerAliasesReady:'true'};
console.log(JSON.stringify({parameters}));
`;
  await writeFile(join(archive, 'tools/native-release.ts'), header + tools);
  await writeFile(
    join(archive, 'tools/native-artifacts.ts'),
    header +
      `
const kind=args[args.indexOf('--kind')+1];
const modules=args[args.indexOf('--native-modules')+1];
const closure=[];
if(kind==='workers') for(const name of fs.readdirSync(modules).sort()) {
  if(name==='@img') for(const sub of fs.readdirSync(path.join(modules,name)).sort()) closure.push(name+'/'+sub); else closure.push(name);
}
record('artifacts',{closure});
console.log(JSON.stringify({parameters:kind==='http'?{NativeWebFunctionsEnabled:'true',NativeAppCodeKey:'native/app/fictional.zip',NativeAppCodeVersion:'version with space=one'}:{NativeWorkersEnabled:'true',NativeWorkerBuildId:args[args.indexOf('--commit')+1],SenderNodeCodeKey:'native/workers/sender/fictional.zip'}}));
`
  );
  await writeFile(
    join(archive, 'tools/web-platform.ts'),
    header + `record('policy'); if(process.env.FIXTURE_FAILURE===args[0]) process.exit(20);`
  );
  const programs: Record<string, string> = {
    git: `if(args[0]==='archive') process.stdout.write(fs.readFileSync(process.env.FIXTURE_ARCHIVE)); else if(args[0]==='rev-parse') console.log('${commit}');`,
    python3: `record('python');`,
    npm: `record('npm'); if(process.env.FIXTURE_FAILURE==='verify' && args.includes('verify')) process.exit(18);
if(args.includes('--os=linux')) for(const name of ['sharp','@img/colour','@img/sharp-linux-arm64','@img/sharp-libvips-linux-arm64','detect-libc','semver']) {fs.mkdirSync(path.join('node_modules',name),{recursive:true});fs.writeFileSync(path.join('node_modules',name,'package.json'),'{}');}
if(args.includes('verify')) {fs.mkdirSync('dist/web/assets',{recursive:true});fs.writeFileSync('dist/web/index.html','fictional');}`,
    aws: `record('aws'); const joined=args.join(' ');
if(args[0]==='sts') console.log(joined.includes('Account') ? process.env.FIXTURE_ACCOUNT : 'arn:aws:sts::'+process.env.FIXTURE_ACCOUNT+':assumed-role/ProjectsCloudEngineer/fixture');
else if(args[0]==='cloudformation'&&args[1]==='describe-stack-resource') console.log(args[args.indexOf('--logical-resource-id')+1]);
else if(args[0]==='events') console.log('arn:aws:events:us-east-1:'+process.env.FIXTURE_ACCOUNT+':rule/'+args[args.indexOf('--name')+1]);
else if(args[0]==='cloudformation'&&args[1]==='describe-stacks') {
 if(joined.includes('EventsPythonCodeSha256')) console.log('A'.repeat(43)+'=');
 else if(joined.includes('AliasesReady')) console.log('true');
 else if(joined.includes('WebBucketName')) console.log('fictional-web-bucket');
 else if(joined.includes('WebDistributionId')) console.log('FICTIONAL');
}
else if(args[0]==='acm') console.log('None');
else if(args[0]==='ses') console.log('yvn-release-notes');
else if(args[0]==='cloudfront') console.log('fixture-invalidation');`
  };
  for (const [name, code] of Object.entries(programs))
    await writeFile(join(bin, name), `#!${process.execPath}\n` + header + code, { mode: 0o755 });
  const tar = join(folder, 'archive.tar');
  const packed = spawnSync('tar', ['-cf', tar, '-C', archive, '.']);
  assert.equal(packed.status, 0, packed.stderr.toString());
  return {
    folder,
    receipts,
    run: async (flags: string[] = [], failure = '') => {
      await writeFile(log, '');
      const result = spawnSync('bash', [join(repo, 'deploy.sh'), '--break-glass', ...flags], {
        env: {
          ...process.env,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          FIXTURE_LOG: log,
          FIXTURE_ARCHIVE: tar,
          FIXTURE_ACCOUNT: account,
          FIXTURE_FAILURE: failure
        },
        encoding: 'utf8',
        timeout: 30000
      });
      const events = (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Event);
      return { result, events };
    }
  };
}

function cloudWrites(events: Event[]) {
  return events.filter(
    (event) =>
      event.program === 'artifacts' ||
      event.program === 'policy' ||
      (event.program === 'aws' &&
        ['deploy', 'put-bucket-policy', 'cp', 'sync', 'create-invalidation', 'set-active-receipt-rule-set'].includes(
          event.args[1]!
        ))
  );
}

test('ordinary deployment verifies archived code and preserves all native parameters/artifacts', async () => {
  const f = await fixture();
  try {
    const { result, events } = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(events.some((e) => e.program === 'npm' && e.args.includes('verify')));
    assert.ok(events.some((e) => e.program === 'python'));
    assert.ok(!events.some((e) => ['tool', 'artifacts', 'policy'].includes(e.program)));
    const deploy = events.find((e) => e.program === 'aws' && e.args[1] === 'deploy')!;
    assert.ok(deploy);
    assert.ok(!deploy.args.some((a) => /^(Native|SenderNode|SenderNative)/.test(a)));
    await assert.rejects(access(join(f.receipts, 'deploy.lock')));
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
});

test('all six native phases use structured parameters and publish alone uploads artifacts', async () => {
  const f = await fixture();
  try {
    for (const kind of ['http', 'worker'])
      for (const phase of ['publish', 'activate', 'rollback']) {
        const { result, events } = await f.run([`--native-${kind}-phase=${phase}`]);
        assert.equal(result.status, 0, result.stderr);
        const command = `${phase === 'publish' ? 'prepare' : phase === 'activate' ? 'promote' : 'rollback'}-${kind === 'worker' ? 'workers' : kind}`;
        assert.ok(events.some((e) => e.program === 'tool' && e.args[0] === command));
        assert.equal(events.filter((e) => e.program === 'artifacts').length, phase === 'publish' ? 1 : 0);
        const deployIndex = events.findIndex((e) => e.program === 'aws' && e.args[1] === 'deploy');
        assert.ok(deployIndex > 0);
        if (kind === 'http' && phase === 'publish') {
          assert.ok(events[deployIndex]!.args.includes('NativeAppCodeVersion=version with space=one'));
          assert.deepEqual(
            events.filter((e) => e.program === 'policy').map((e) => e.args[0]),
            ['policy-install', 'policy-verify']
          );
          assert.ok(events.findIndex((e) => e.program === 'policy') > deployIndex);
        } else assert.equal(events.filter((e) => e.program === 'policy').length, 0);
        if (kind === 'worker' && phase === 'publish')
          assert.deepEqual(events.find((e) => e.program === 'artifacts')!.closure, [
            '@img/colour',
            '@img/sharp-libvips-linux-arm64',
            '@img/sharp-linux-arm64',
            'detect-libc',
            'semver',
            'sharp'
          ]);
        await assert.rejects(access(join(f.receipts, 'deploy.lock')));
      }
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
});

test('validation, preparation and malformed parameter failures stop before cloud writes', async () => {
  const f = await fixture();
  try {
    for (const failure of ['verify', 'prepare-http', 'unsafe-parameters', 'newline-parameters']) {
      const { result, events } = await f.run(['--native-http-phase=publish'], failure);
      assert.notEqual(result.status, 0);
      assert.deepEqual(cloudWrites(events), []);
      await assert.rejects(access(join(f.receipts, 'deploy.lock')));
    }
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
});

test('phase ambiguity and an existing deployment lock are refused without mutation', async () => {
  const f = await fixture();
  try {
    for (const flags of [
      ['--native-http-phase=publish', '--native-worker-phase=publish'],
      ['--native-http-phase=publish', '--events-alias-phase=activate'],
      ['--native-http-phase=publish', '--native-http-phase=activate']
    ]) {
      const { result, events } = await f.run(flags);
      assert.notEqual(result.status, 0);
      assert.deepEqual(cloudWrites(events), []);
    }
    await mkdir(join(f.receipts, 'deploy.lock'));
    const { result, events } = await f.run();
    assert.notEqual(result.status, 0);
    assert.deepEqual(cloudWrites(events), []);
    await access(join(f.receipts, 'deploy.lock'));
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
});

test('a policy installation failure stops before frontend publication or activation', async () => {
  const f = await fixture();
  try {
    const { result, events } = await f.run(['--native-http-phase=publish'], 'policy-install');
    assert.notEqual(result.status, 0);
    assert.ok(events.some((e) => e.program === 'aws' && e.args[1] === 'deploy'));
    assert.deepEqual(
      events.filter((e) => e.program === 'policy').map((e) => e.args[0]),
      ['policy-install']
    );
    assert.ok(!events.some((e) => e.program === 'aws' && ['sync', 'create-invalidation'].includes(e.args[1]!)));
    assert.ok(!events.some((e) => e.program === 'tool' && e.args[0] === 'promote-http'));
    await assert.rejects(access(join(f.receipts, 'deploy.lock')));
  } finally {
    await rm(f.folder, { recursive: true, force: true });
  }
});
