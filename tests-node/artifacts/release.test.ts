/** The release phases against a fictional stack whose serving versions are
 * all earlier Node builds. No AWS calls, credentials or subscriber data. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STSClient } from '@aws-sdk/client-sts';
import { CloudFormationClient } from '@aws-sdk/client-cloudformation';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { LambdaWebClient } from '@aws-sdk/client-lambda-web';
import { main } from '../../tools/native-release.ts';
import { MemoryReceiptStore, readReceipt, writeReceipt } from '../../tools/receipt-store.ts';
type Fields = Record<string, unknown>;
const names = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'];
const build = 'a'.repeat(40),
  previousBuild = 'b'.repeat(40),
  account = '999153317627';
const stackId = `arn:aws:cloudformation:us-east-1:${account}:stack/yvn-release-notes/fictional-stack`;
async function fixture(t: TestContext) {
  const store = new MemoryReceiptStore();
  const parameters: Record<string, string> = {
    NativeWorkerBuildId: previousBuild,
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
    const node = { Role: role, Runtime: 'nodejs24.x', Handler: 'index.handler', Architectures: ['arm64'] };
    const ready = { State: 'Active', LastUpdateStatus: 'Successful' };
    configs[`${name}:1`] = {
      ...node,
      ...ready,
      CodeSha256: `old-${name}`,
      Environment: { Variables: { ...envs[name], APP_VERSION: previousBuild } }
    };
    configs[`${name}:2`] = {
      ...node,
      ...ready,
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
    return (await main([command, '--commit', build], { store, platform })).parameters;
  };
  const publish = () => {
    parameters.NativeWorkerBuildId = build;
    parameters.NativeAppBuildId = build;
    parameters.NativeMcpBuildId = build;
  };
  const serveWorkers = (version: string) => {
    for (const name of names) current[name] = { version, revision: `serving-${version}` };
  };
  return {
    store,
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
const pinKeys = ['App', 'Mcp'].flatMap((name) => [`Native${name}LiveRevisionId`, `Native${name}RollbackRevisionId`]);
const versionKeys = names.map((name) => `${name}NativeLiveVersion`);
const retired = [
  'NativeWorkersEnabled',
  'NativeWorkerAliasesReady',
  'NativeWebFunctionsEnabled',
  'NativeHttpRouting',
  'NativeOriginPoliciesReady'
];
const servePins = (f: Awaited<ReturnType<typeof fixture>>, target: Record<string, string>) =>
  Object.assign(f.pins, Object.fromEntries(Object.entries(target).filter(([key]) => key.endsWith('RevisionId'))));

test('worker promotion intents survive unknown CFN outcomes, completed retries and exact rollback', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  const receipt = (name: string) => f.store.objects.get(`${build}-${name}.json`);
  const before = receipt('workers-prepared');
  assert.ok(before);
  await f.phase('prepare-workers');
  assert.deepEqual(receipt('workers-prepared'), before);
  f.publish();
  const target = await f.phase('promote-workers');
  const promotion = receipt('workers-promotion');
  assert.ok(promotion);
  f.status('UPDATE_IN_PROGRESS');
  await assert.rejects(f.phase('promote-workers'), /idle reviewed stack/);
  f.status('UPDATE_COMPLETE');
  f.serveWorkers('2');
  assert.deepEqual(await f.phase('promote-workers'), target);
  assert.deepEqual(receipt('workers-promotion'), promotion);
  assert.deepEqual(receipt('workers-prepared'), before);
  await assert.rejects(f.phase('prepare-workers'), /Promotion intent already exists/);
  const rollback = await f.phase('rollback-workers');
  assert.deepEqual(Object.keys(rollback).sort(), [...versionKeys].sort());
  for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
  f.serveWorkers('1');
  assert.deepEqual(await f.phase('rollback-workers'), rollback);
  // Seven self-tests per promotion and per rollback, the retries included.
  assert.equal(f.probes(), 28);
});
test('worker preparation records each serving version build and code hash', async (t) => {
  const f = await fixture(t);
  f.configs['Export:1']!.Runtime = 'python3.13';
  await assert.rejects(f.phase('prepare-workers'), /Incomplete prior release metadata Export/);
  f.configs['Export:1']!.Runtime = 'nodejs24.x';
  delete (f.configs['Export:1']!.Environment as { Variables: Record<string, string> }).Variables.APP_VERSION;
  await assert.rejects(f.phase('prepare-workers'), /Incomplete prior release metadata Export/);
  assert.equal(f.store.names().length, 0);
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
    f.store.names().some((name) => name.endsWith('promotion.json')),
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
    f.store.names().some((name) => name.endsWith('rollback.json')),
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
  servePins(f, target);
  const prepared = f.store.objects.get(`${build}-http-prepared.json`);
  assert.ok(prepared);
  assert.deepEqual(await f.phase('promote-http'), target);
  assert.deepEqual(f.store.objects.get(`${build}-http-prepared.json`), prepared);
  const rollback = await f.phase('rollback-http');
  assert.equal(rollback.NativeAppLiveRevisionId, 'old-app');
  assert.equal(rollback.NativeMcpLiveRevisionId, 'old-mcp');
  assert.deepEqual(Object.keys(rollback).sort(), [...pinKeys].sort());
  servePins(f, rollback);
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
    f.store.names().some((name) => name.endsWith('promotion.json')),
    false
  );
});
test('HTTP rollback refuses unrelated pins and a different currently published build', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-http');
  f.publish();
  servePins(f, await f.phase('promote-http'));
  f.parameters.NativeMcpBuildId = previousBuild;
  await assert.rejects(f.phase('rollback-http'), /Current HTTP build differs/);
  f.parameters.NativeMcpBuildId = build;
  f.pins.NativeAppLiveRevisionId = 'unrelated-app';
  await assert.rejects(f.phase('rollback-http'), /routing changed since this promotion/);
});
test('worker rollback verifies the actual prior build and hash after an earlier rollback left newer stack metadata', async (t) => {
  const f = await fixture(t);
  f.parameters.NativeWorkerBuildId = 'c'.repeat(40);
  for (const name of names) f.parameters[`${name}NodeCodeSha256`] = `stale-latest-${name}`;
  await f.phase('prepare-workers');
  f.publish();
  for (const name of names) f.parameters[`${name}NodeCodeSha256`] = `hash-${name}`;
  await f.phase('promote-workers');
  f.serveWorkers('2');
  f.configs['Inbound:1']!.CodeSha256 = 'replaced-code';
  await assert.rejects(f.phase('rollback-workers'), /Incomplete candidate configuration Inbound/);
  f.configs['Inbound:1']!.CodeSha256 = 'old-Inbound';
  const rollback = await f.phase('rollback-workers');
  for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
  assert.equal(f.probes(), 7 + 1 + 7);
});
test('automatic CloudFormation rollback to the exact recorded baseline is a safe resumable no-op', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-workers');
  f.publish();
  await f.phase('promote-workers');
  f.status('UPDATE_ROLLBACK_COMPLETE');
  const rollback = await f.phase('rollback-workers');
  for (const name of names) assert.equal(rollback[`${name}NativeLiveVersion`], '1');
  assert.deepEqual(await f.phase('rollback-workers'), rollback);
});
test('every phase emits only pins and versions the template declares, never a retired stack flag', async (t) => {
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
  const block = template.slice(template.indexOf('\nParameters:\n'), template.indexOf('\nConditions:\n'));
  const declared = new Set([...block.matchAll(/^ {2}([A-Za-z0-9]+):$/gm)].map((m) => m[1]!));
  for (const name of retired) assert.ok(!declared.has(name), `${name} is still a template parameter`);
  const f = await fixture(t);
  const emitted: Record<string, string[]> = {};
  const run = async (phase: string) => {
    const parameters = await f.phase(phase);
    emitted[phase] = Object.keys(parameters).sort();
    return parameters;
  };
  await run('prepare-http');
  await run('prepare-workers');
  f.publish();
  servePins(f, await run('promote-http'));
  await run('promote-workers');
  f.serveWorkers('2');
  await run('rollback-http');
  await run('rollback-workers');
  for (const phase of ['prepare-http', 'promote-http', 'rollback-http'])
    assert.deepEqual(emitted[phase], [...pinKeys].sort(), phase);
  for (const phase of ['prepare-workers', 'promote-workers', 'rollback-workers'])
    assert.deepEqual(emitted[phase], [...versionKeys].sort(), phase);
  for (const key of Object.values(emitted).flat()) assert.ok(declared.has(key), `${key} is not a template parameter`);
});
test('intents recorded with the retired stack flags still resume and roll back', async (t) => {
  const f = await fixture(t);
  // Receipts written before 2026-10-20 carry the flags in their targets.
  const age = async (name: string, flags: Record<string, string>) => {
    const receipt = (await readReceipt<{ target: Record<string, string> }>(f.store, `${build}-${name}.json`))!;
    await writeReceipt(f.store, `${build}-${name}.json`, { ...receipt, target: { ...receipt.target, ...flags } });
  };
  await f.phase('prepare-http');
  await f.phase('prepare-workers');
  f.publish();
  const http = await f.phase('promote-http');
  const workers = await f.phase('promote-workers');
  await age('http-promotion', { NativeHttpRouting: 'native', NativeOriginPoliciesReady: 'true' });
  await age('workers-promotion', { NativeWorkersEnabled: 'true', NativeWorkerAliasesReady: 'true' });
  servePins(f, http);
  f.serveWorkers('2');
  assert.deepEqual(await f.phase('promote-http'), http);
  assert.deepEqual(await f.phase('promote-workers'), workers);
  const httpRollback = await f.phase('rollback-http');
  const workerRollback = await f.phase('rollback-workers');
  await age('http-rollback', { NativeHttpRouting: 'native', NativeOriginPoliciesReady: 'true' });
  await age('workers-rollback', { NativeWorkerAliasesReady: 'true' });
  assert.deepEqual(await f.phase('rollback-http'), httpRollback);
  assert.deepEqual(await f.phase('rollback-workers'), workerRollback);
  for (const key of [...Object.keys(httpRollback), ...Object.keys(workerRollback)]) assert.ok(!retired.includes(key));
});
test('a baseline recorded without serving revisions or build metadata is refused before any rollback intent', async (t) => {
  const f = await fixture(t);
  await f.phase('prepare-http');
  await f.phase('prepare-workers');
  f.publish();
  servePins(f, await f.phase('promote-http'));
  await f.phase('promote-workers');
  f.serveWorkers('2');
  // The shape of the first adoption's receipts: no private endpoints yet, and
  // Python worker versions with no recorded build or code hash.
  const strip = async (name: string, change: (previous: Record<string, unknown>) => void) => {
    const receipt = (await readReceipt<{ previous: Record<string, unknown> }>(f.store, `${build}-${name}.json`))!;
    change(receipt.previous);
    await writeReceipt(f.store, `${build}-${name}.json`, receipt);
  };
  await strip('http-promotion', (previous) => {
    previous.pins = {};
  });
  await strip('workers-promotion', (previous) => {
    for (const alias of Object.values(previous.aliases as Record<string, Record<string, string>>)) {
      delete alias.build;
      delete alias.sha;
    }
  });
  const probes = f.probes();
  await assert.rejects(f.phase('rollback-http'), /no serving revisions to restore/);
  await assert.rejects(f.phase('rollback-workers'), /Missing release metadata build/);
  assert.equal(f.probes(), probes);
  assert.equal(
    f.store.names().some((name) => name.endsWith('rollback.json')),
    false
  );
});
