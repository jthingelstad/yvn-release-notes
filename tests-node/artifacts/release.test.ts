import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { LambdaWebClient } from '@aws-sdk/client-lambda-web';
import { main } from '../../tools/native-release.ts';
type Fields = Record<string, unknown>;
const names = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'];
const build = 'a'.repeat(40),
  previousBuild = 'b'.repeat(40),
  account = '999153317627';
const stackId = `arn:aws:cloudformation:us-east-1:${account}:stack/yvn-release-notes/fictional-stack`;
async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'yvn-release-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parameters: Record<string, string> = {
    WorkerAliasesReady: 'true',
    EventsAliasesReady: 'true',
    NativeWorkersEnabled: 'false',
    NativeWorkerAliasesReady: 'false',
    NativeWorkerBuildId: previousBuild,
    NativeHttpRouting: 'native',
    NativeWebFunctionsEnabled: 'true',
    NativeAppBuildId: previousBuild,
    NativeMcpBuildId: previousBuild,
    WebDomain: 'notes.example.com',
    FromAddress: 'notes@example.com',
    InboundDomain: 'in.example.com',
    NativeMaxConcurrency: '128'
  };
  const outputs: Record<string, string> = {
    TableName: 'fictional-table',
    MailBucketName: 'fictional-media',
    NativeSourceBucketName: 'fictional-artifacts'
  };
  const current: Record<string, { version: string; revision: string }> = {},
    configs: Record<string, Fields> = {},
    revisions: Record<string, Fields> = {};
  const envs: Record<string, Record<string, string>> = {
    Sender: {
      TABLE: 'fictional-table',
      BUCKET: 'fictional-media',
      FROM_ADDRESS: 'notes@example.com',
      CONFIG_SET: 'fictional-config',
      INBOUND_DOMAIN: 'in.example.com'
    },
    Inbound: {
      TABLE: 'fictional-table',
      BUCKET: 'fictional-media',
      FROM_ADDRESS: 'notes@example.com',
      CONFIG_SET: 'fictional-config',
      INBOUND_DOMAIN: 'in.example.com'
    },
    Events: { TABLE: 'fictional-table', ALARM_TOPIC: 'fictional-topic' },
    Transcribe: { TABLE: 'fictional-table', BUCKET: 'fictional-media' },
    Describe: {
      TABLE: 'fictional-table',
      BUCKET: 'fictional-media',
      SELF: 'yvn-release-notes-describe:live',
      SECRET: 'fictional-secret-name'
    },
    Export: { TABLE: 'fictional-table', MAIL_BUCKET: 'fictional-media' },
    Capture: { TABLE: 'fictional-table', WEB_ORIGIN: 'https://notes.example.com' }
  };
  for (const name of names) {
    const arn = `arn:aws:lambda:us-east-1:${account}:function:yvn-release-notes-${name.toLowerCase()}`;
    outputs[`${name}WorkerAlias`] = `${arn}:live`;
    outputs[`${name}NativeCandidateVersion`] = '2';
    parameters[`${name}NodeCodeSha256`] = `hash-${name}`;
    current[name] = { version: '1', revision: 'initial' };
    const role = `arn:aws:iam::${account}:role/fictional-${name}`;
    configs[`${name}:1`] = { Role: role, Runtime: 'python3.13', Environment: { Variables: envs[name] } };
    configs[`${name}:2`] = {
      Role: role,
      Runtime: 'nodejs24.x',
      Handler: 'index.handler',
      Architectures: ['arm64'],
      State: 'Active',
      LastUpdateStatus: 'Successful',
      CodeSha256: `hash-${name}`,
      Environment: { Variables: { ...envs[name], APP_VERSION: build } }
    };
  }
  const pins: Record<string, string> = {
    NativeAppLiveRevisionId: 'old-app',
    NativeAppRollbackRevisionId: 'older-app',
    NativeMcpLiveRevisionId: 'old-mcp',
    NativeMcpRollbackRevisionId: 'older-mcp'
  };
  for (const name of ['App', 'Mcp']) {
    outputs[`Native${name}FunctionName`] = `yvn-release-notes-${name === 'App' ? 'web' : 'mcp'}-native`;
    outputs[`Native${name}FunctionArn`] =
      `arn:aws:lambda:us-east-1:${account}:webfunction:${outputs[`Native${name}FunctionName`]}`;
    outputs[`Native${name}CandidateRevisionId`] = `new-${name.toLowerCase()}`;
    parameters[`Native${name}CodeKey`] = `native/${name.toLowerCase()}/fictional.zip`;
    parameters[`Native${name}CodeVersion`] = `fictional-${name}-s3-version`;
    const expected: Record<string, string> = {
      TABLE: outputs.TableName!,
      MAIL_BUCKET: outputs.MailBucketName!,
      WEB_ORIGIN: 'https://notes.example.com',
      APP_VERSION: build
    };
    if (name === 'App')
      Object.assign(expected, {
        FROM_ADDRESS: parameters.FromAddress,
        CONFIG_SET: 'fictional-config',
        INBOUND_DOMAIN: parameters.InboundDomain,
        SENDER_FUNCTION: outputs.SenderWorkerAlias,
        EXPORT_FUNCTION: outputs.ExportWorkerAlias
      });
    else expected.CAPTURE_FUNCTION = outputs.CaptureWorkerAlias!;
    revisions[name] = {
      state: 'Active',
      revisionId: outputs[`Native${name}CandidateRevisionId`],
      functionArn: outputs[`Native${name}FunctionArn`],
      buildConfig: {
        runtimeConfig: { runtime: 'nodejs24.x' },
        codeConfig: {
          s3Object: {
            bucket: outputs.NativeSourceBucketName,
            key: parameters[`Native${name}CodeKey`],
            versionId: parameters[`Native${name}CodeVersion`]
          }
        }
      },
      serviceConfig: {
        executionRoleArn: `arn:aws:iam::${account}:role/fictional-${name === 'App' ? 'WebRole' : 'McpRole'}`,
        timeoutSeconds: 28,
        maxConcurrencyPerEnvironment: 128,
        environmentVariables: expected
      }
    };
  }
  let status = 'UPDATE_COMPLETE',
    probes = 0;
  const printed: Record<string, string>[] = [];
  t.mock.method(console, 'info', (value: string) =>
    printed.push((JSON.parse(value) as { parameters: Record<string, string> }).parameters)
  );
  t.mock.method(STSClient.prototype, 'send', async () => ({
    Account: account,
    Arn: `arn:aws:sts::${account}:assumed-role/ProjectsCloudEngineer/fictional-session`
  }));
  t.mock.method(
    CloudFormationClient.prototype,
    'send',
    async (command: { constructor: { name: string }; input: Fields }) => {
      if (command.constructor.name === 'DescribeStackResourceCommand')
        return {
          StackResourceDetail: {
            PhysicalResourceId:
              command.input.LogicalResourceId === 'ConfigurationSet'
                ? 'fictional-config'
                : `fictional-${command.input.LogicalResourceId}`
          }
        };
      assert.equal(command.constructor.name, 'DescribeStacksCommand');
      return {
        Stacks: [
          {
            StackId: stackId,
            StackStatus: status,
            Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({
              ParameterKey,
              ParameterValue
            })),
            Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue }))
          }
        ]
      };
    }
  );
  t.mock.method(LambdaClient.prototype, 'send', async (command: { constructor: { name: string }; input: Fields }) => {
    const name = names.find(
      (name) => String(command.input.FunctionName) === outputs[`${name}WorkerAlias`]!.slice(0, -5)
    );
    assert.ok(name);
    if (command.constructor.name === 'GetAliasCommand')
      return { FunctionVersion: current[name]!.version, RevisionId: current[name]!.revision };
    if (command.constructor.name === 'GetFunctionConfigurationCommand')
      return configs[`${name}:${command.input.Qualifier}`];
    assert.equal(command.constructor.name, 'InvokeCommand');
    probes++;
    assert.ok(['1', '2'].includes(String(command.input.Qualifier)));
    assert.equal(Buffer.from(command.input.Payload as Uint8Array).toString(), '{"self_test":true}');
    return {
      StatusCode: 200,
      Payload: Buffer.from(
        JSON.stringify({
          ok: true,
          runtime: 'Node 24.20.0/linux/arm64',
          build: (configs[`${name}:${command.input.Qualifier}`]!.Environment as { Variables: Record<string, string> })
            .Variables.APP_VERSION
        })
      )
    };
  });
  t.mock.method(
    LambdaWebClient.prototype,
    'send',
    async (command: { constructor: { name: string }; input: Fields }) => {
      assert.equal(command.constructor.name, 'GetWebFunctionRevisionCommand');
      return revisions[command.input.functionName === outputs.NativeAppFunctionName ? 'App' : 'Mcp'];
    }
  );
  const platform = async (phase: string) => {
    assert.ok(['prepare', 'policy-verify'].includes(phase));
    return { pins: { ...pins }, confirmed: true };
  };
  const phase = async (command: string) => {
    await main([command, '--receipt-dir', dir, '--commit', build], { platform });
    return printed.at(-1)!;
  };
  const publish = () => {
    parameters.NativeWorkersEnabled = 'true';
    parameters.NativeWorkerBuildId = build;
    parameters.NativeAppBuildId = build;
    parameters.NativeMcpBuildId = build;
  };
  const serveWorkers = (version: string) => {
    for (const name of names) current[name] = { version, revision: `serving-${version}` };
    parameters.NativeWorkerAliasesReady = version === '2' ? 'true' : 'false';
  };
  return {
    dir,
    parameters,
    outputs,
    current,
    configs,
    revisions,
    pins,
    phase,
    publish,
    serveWorkers,
    probes: () => probes,
    status: (value: string) => {
      status = value;
    }
  };
}
test('worker promotion intents survive unknown CFN outcomes, completed retries and exact rollback', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  const preparedPath = join(f.dir, `${build}-workers-prepared.json`),
    before = await readFile(preparedPath);
  await f.phase('prepare-workers');
  assert.deepEqual(await readFile(preparedPath), before);
  f.publish();
  const target = await f.phase('promote-workers');
  const promotionPath = join(f.dir, `${build}-workers-promotion.json`),
    promotion = await readFile(promotionPath);
  assert.equal((await stat(promotionPath)).mode & 0o077, 0);
  f.status('UPDATE_IN_PROGRESS');
  await assert.rejects(f.phase('promote-workers'), /idle reviewed stack/);
  f.status('UPDATE_COMPLETE');
  f.serveWorkers('2');
  assert.deepEqual(await f.phase('promote-workers'), target);
  assert.deepEqual(await readFile(promotionPath), promotion);
  assert.deepEqual(await readFile(preparedPath), before);
  await assert.rejects(f.phase('prepare-workers'), /Promotion intent already exists/);
  const rollback = await f.phase('rollback-workers');
  assert.equal(rollback.NativeWorkerAliasesReady, 'false');
  for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
  f.serveWorkers('1');
  assert.deepEqual(await f.phase('rollback-workers'), rollback);
  assert.equal((await readdir(f.dir)).includes('native-release.lock'), false);
  assert.equal(f.probes(), 14);
});
test('worker candidates require actual immutable code, role and complete owner environment before probing', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  f.publish();
  const config = f.configs['Sender:2']!;
  const env = (config.Environment as { Variables: Record<string, string> }).Variables;
  delete env.TABLE;
  await assert.rejects(f.phase('promote-workers'), /ownership\/environment Sender/);
  assert.equal(f.probes(), 0);
  env.TABLE = 'fictional-table';
  config.Role = 'wrong-role';
  await assert.rejects(f.phase('promote-workers'), /ownership\/environment Sender/);
  assert.equal(f.probes(), 0);
  config.Role = f.configs['Sender:1']!.Role;
  config.CodeSha256 = 'changed-content';
  await assert.rejects(f.phase('promote-workers'), /Incomplete candidate configuration Sender/);
  assert.equal(f.probes(), 0);
  assert.equal(
    (await readdir(f.dir)).some((name) => name.endsWith('promotion.json')),
    false
  );
});
test('a describer candidate must read the secret the stack names, which may differ from the live one', async (t) => {
  const f = await fixture(t);
  f.parameters.RuntimeSecretName = 'fictional-runtime-secret';
  await f.phase('prepare-workers');
  f.publish();
  await assert.rejects(f.phase('promote-workers'), /ownership\/environment Describe/);
  assert.equal(f.probes(), 4, 'the four workers before it, never the describer');
  (f.configs['Describe:2']!.Environment as { Variables: Record<string, string> }).Variables.SECRET =
    'fictional-runtime-secret';
  const target = await f.phase('promote-workers');
  assert.equal(target.DescribeNativeLiveVersion, '2');
  f.serveWorkers('2');
  const rollback = await f.phase('rollback-workers');
  assert.equal(rollback.DescribeNativeLiveVersion, '1', 'the old version keeps its own secret on rollback');
});
test('worker rollback refuses stale build metadata and alias drift rather than using an old receipt', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  f.publish();
  await f.phase('promote-workers');
  f.serveWorkers('2');
  f.parameters.NativeWorkerBuildId = 'c'.repeat(40);
  await assert.rejects(f.phase('rollback-workers'), /Current worker build differs/);
  f.parameters.NativeWorkerBuildId = build;
  f.current.Capture = { version: '99', revision: 'unrelated' };
  await assert.rejects(f.phase('rollback-workers'), /aliases changed since this promotion/);
  assert.equal(
    (await readdir(f.dir)).some((name) => name.endsWith('rollback.json')),
    false
  );
});
test('HTTP source/configuration verification and completed retries preserve prior pinned revisions', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-http');
  f.publish();
  const target = await f.phase('promote-http');
  assert.equal(target.NativeAppRollbackRevisionId, 'old-app');
  assert.equal(target.NativeMcpRollbackRevisionId, 'old-mcp');
  Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
  const prepared = await readFile(join(f.dir, `${build}-http-prepared.json`));
  assert.deepEqual(await f.phase('promote-http'), target);
  assert.deepEqual(await readFile(join(f.dir, `${build}-http-prepared.json`)), prepared);
  const rollback = await f.phase('rollback-http');
  assert.equal(rollback.NativeAppLiveRevisionId, 'old-app');
  assert.equal(rollback.NativeMcpLiveRevisionId, 'old-mcp');
  Object.assign(f.pins, Object.fromEntries(Object.entries(rollback).filter(([key]) => key.endsWith('RevisionId'))));
  Object.assign(f.parameters, rollback);
  assert.deepEqual(await f.phase('rollback-http'), rollback);
  f.pins.NativeAppLiveRevisionId = 'unexpected-after-rollback';
  await assert.rejects(f.phase('rollback-http'), /routing changed since this promotion/);
});
test('HTTP promotion checks actual APP_VERSION, S3 version and execution role, not only CFN parameters', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-http');
  f.publish();
  const config = f.revisions.App!;
  const service = config.serviceConfig as { environmentVariables: Record<string, string>; executionRoleArn: string };
  service.environmentVariables.ADMIN_USER_ID = 'unexpected-admin';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  f.parameters.AdminUserId = 'operator';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  service.environmentVariables.ADMIN_USER_ID = 'operator';
  service.environmentVariables.TURNSTILE_MODE = 'enforce';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  delete service.environmentVariables.TURNSTILE_MODE;
  f.parameters.TurnstileMode = 'enforce';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  f.parameters.TurnstileMode = '';
  service.environmentVariables.APP_VERSION = previousBuild;
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  service.environmentVariables.APP_VERSION = build;
  const source = (config.buildConfig as { codeConfig: { s3Object: { versionId: string } } }).codeConfig.s3Object;
  source.versionId = 'unrelated-version';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  source.versionId = f.parameters.NativeAppCodeVersion!;
  service.executionRoleArn = 'wrong-role';
  await assert.rejects(f.phase('promote-http'), /configuration\/source mismatch App/);
  assert.equal(
    (await readdir(f.dir)).some((name) => name.endsWith('promotion.json')),
    false
  );
});
test('HTTP rollback refuses unrelated pins and a different currently published build', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-http');
  f.publish();
  const target = await f.phase('promote-http');
  Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
  f.parameters.NativeMcpBuildId = previousBuild;
  await assert.rejects(f.phase('rollback-http'), /Current HTTP build differs/);
  f.parameters.NativeMcpBuildId = build;
  f.pins.NativeAppLiveRevisionId = 'unrelated-app';
  await assert.rejects(f.phase('rollback-http'), /routing changed since this promotion/);
});
test('native worker rollback verifies actual prior alias build/hash after an earlier rollback left newer latest metadata', async (t) => {
  const f = await fixture(t);
  f.parameters.NativeWorkerAliasesReady = 'true';
  f.parameters.NativeWorkerBuildId = 'c'.repeat(40);
  for (const name of names) {
    const old = f.configs[`${name}:1`]!,
      candidate = f.configs[`${name}:2`]!;
    Object.assign(old, {
      Runtime: 'nodejs24.x',
      Handler: 'index.handler',
      Architectures: ['arm64'],
      State: 'Active',
      LastUpdateStatus: 'Successful',
      CodeSha256: `old-${name}`
    });
    (old.Environment as { Variables: Record<string, string> }).Variables.APP_VERSION = previousBuild;
    candidate.Role = old.Role;
    f.parameters[`${name}NodeCodeSha256`] = `stale-latest-${name}`;
  }
  await f.phase('prepare-workers');
  f.publish();
  for (const name of names) f.parameters[`${name}NodeCodeSha256`] = `hash-${name}`;
  await f.phase('promote-workers');
  f.serveWorkers('2');
  const rollback = await f.phase('rollback-workers');
  assert.equal(rollback.NativeWorkerAliasesReady, 'true');
  assert.equal(f.probes(), 14);
  for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
});
test('initial HTTP adoption records the newly provisioned private endpoints while preserving legacy rollback', async (t) => {
  const f = await fixture(t);
  f.parameters.NativeHttpRouting = 'legacy';
  f.parameters.NativeWebFunctionsEnabled = 'false';
  const original = { ...f.pins };
  for (const key of Object.keys(f.pins)) delete f.pins[key];
  assert.deepEqual(await f.phase('prepare-http'), { NativeHttpRouting: 'legacy' });
  f.publish();
  f.parameters.NativeWebFunctionsEnabled = 'true';
  Object.assign(f.pins, original);
  const target = await f.phase('promote-http');
  Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
  f.parameters.NativeHttpRouting = 'native';
  assert.deepEqual(await f.phase('rollback-http'), { NativeHttpRouting: 'legacy' });
  f.parameters.NativeHttpRouting = 'legacy';
  assert.deepEqual(await f.phase('rollback-http'), { NativeHttpRouting: 'legacy' });
});
test('automatic CloudFormation rollback to the exact recorded baseline is a safe resumable no-op', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  f.publish();
  await f.phase('promote-workers');
  f.status('UPDATE_ROLLBACK_COMPLETE');
  const rollback = await f.phase('rollback-workers');
  assert.equal(rollback.NativeWorkerAliasesReady, 'false');
  assert.deepEqual(await f.phase('rollback-workers'), rollback);
});
function retirement(parameters: Record<string, string>, draining: string | undefined) {
  if (draining === undefined) {
    delete parameters.NativeLegacyDrainPending;
    delete parameters.WorkerAliasesReady;
    delete parameters.EventsAliasesReady;
    parameters.NativeWorkersEnabled = 'true';
    parameters.NativeWorkerAliasesReady = 'true';
  } else parameters.NativeLegacyDrainPending = draining;
}
for (const draining of ['true', 'false', undefined]) {
  test(`native-only retirement refuses first Python worker rollback while drain=${draining ?? 'removed'}`, async (t) => {
    const f = await fixture(t);
    await f.phase('prepare-workers');
    f.publish();
    await f.phase('promote-workers');
    f.serveWorkers('2');
    retirement(f.parameters, draining);
    await assert.rejects(f.phase('rollback-workers'), /Legacy rollback is unavailable after native-only retirement/);
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith('rollback.json')),
      false
    );
    assert.equal(f.probes(), 7);
    assert.equal(f.parameters.NativeWorkerAliasesReady, 'true');
    assert.equal((await readdir(f.dir)).includes('native-release.lock'), false);
  });
  test(`native-only retirement refuses first legacy HTTP rollback while drain=${draining ?? 'removed'}`, async (t) => {
    const f = await fixture(t);
    f.parameters.NativeHttpRouting = 'legacy';
    await f.phase('prepare-http');
    f.publish();
    const target = await f.phase('promote-http');
    Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
    f.parameters.NativeHttpRouting = 'native';
    retirement(f.parameters, draining);
    await assert.rejects(f.phase('rollback-http'), /Legacy rollback is unavailable after native-only retirement/);
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith('rollback.json')),
      false
    );
    assert.equal(f.parameters.NativeHttpRouting, 'native');
    assert.equal((await readdir(f.dir)).includes('native-release.lock'), false);
  });
  test(`native-only worker preparation promotion and native rollback preserve complete pins while drain=${draining ?? 'removed'}`, async (t) => {
    const f = await fixture(t);
    delete f.parameters.WorkerAliasesReady;
    delete f.parameters.EventsAliasesReady;
    f.parameters.NativeWorkersEnabled = 'true';
    f.parameters.NativeWorkerAliasesReady = 'true';
    retirement(f.parameters, draining);
    for (const name of names) {
      const old = f.configs[`${name}:1`]!;
      Object.assign(old, {
        Runtime: 'nodejs24.x',
        Handler: 'index.handler',
        Architectures: ['arm64'],
        State: 'Active',
        LastUpdateStatus: 'Successful',
        CodeSha256: `old-${name}`
      });
      (old.Environment as { Variables: Record<string, string> }).Variables.APP_VERSION = previousBuild;
    }
    const prepared = await f.phase('prepare-workers');
    assert.equal(prepared.NativeWorkerAliasesReady, undefined);
    f.publish();
    await f.phase('promote-workers');
    f.serveWorkers('2');
    const rollback = await f.phase('rollback-workers');
    assert.equal(rollback.NativeWorkerAliasesReady, 'true');
    for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
    assert.equal(rollback.NativeLegacyDrainPending, undefined);
    assert.equal(f.parameters.NativeLegacyDrainPending, draining);
    assert.equal(f.probes(), 14);
    f.serveWorkers('1');
    f.parameters.NativeWorkerAliasesReady = 'true';
    assert.deepEqual(await f.phase('rollback-workers'), rollback);
  });
  test(`native-only HTTP preparation promotion and native rollback retain private native routing while drain=${draining ?? 'removed'}`, async (t) => {
    const f = await fixture(t);
    retirement(f.parameters, draining);
    f.parameters.NativeOriginPoliciesReady = 'true';
    await f.phase('prepare-http');
    f.publish();
    const target = await f.phase('promote-http');
    Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
    const rollback = await f.phase('rollback-http');
    assert.equal(rollback.NativeHttpRouting, 'native');
    assert.equal(rollback.NativeOriginPoliciesReady, 'true');
    assert.equal(rollback.NativeAppLiveRevisionId, 'old-app');
    assert.equal(rollback.NativeMcpLiveRevisionId, 'old-mcp');
    assert.equal(rollback.NativeLegacyDrainPending, undefined);
    Object.assign(f.pins, Object.fromEntries(Object.entries(rollback).filter(([key]) => key.endsWith('RevisionId'))));
    Object.assign(f.parameters, rollback);
    assert.deepEqual(await f.phase('rollback-http'), rollback);
  });
}

for (const incomplete of ['NativeWorkersEnabled', 'NativeWorkerAliasesReady']) {
  test(`absent legacy flags alone do not infer retirement when ${incomplete} is false`, async (t) => {
    const f = await fixture(t);
    f.parameters.NativeHttpRouting = 'legacy';
    await f.phase('prepare-http');
    f.publish();
    const target = await f.phase('promote-http');
    Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));
    f.parameters.NativeHttpRouting = 'native';
    retirement(f.parameters, undefined);
    f.parameters[incomplete] = 'false';
    assert.deepEqual(await f.phase('rollback-http'), { NativeHttpRouting: 'legacy' });
  });
}
