/** Metadata-only release planning with private pre-deployment receipts. The
 * only invocation is an exact content-free runtime self-test on an immutable
 * candidate version; publication/routing stays owned by CloudFormation. */
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourceCommand
} from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetAliasCommand, GetFunctionConfigurationCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { LambdaWebClient, GetWebFunctionRevisionCommand } from '@aws-sdk/client-lambda-web';
import { mkdir, realpath, stat, open, link, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile),
  region = 'us-east-1',
  stackName = 'yvn-release-notes';
const names = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'] as const;
type Snapshot = { version: string; revision: string; functionName: string; build?: string; sha?: string };
type Receipt = {
  schema: 1;
  stack: string;
  build: string;
  parameters: Record<string, string>;
  aliases?: Record<string, Snapshot>;
  pins?: Record<string, string>;
  previous?: Receipt;
  target?: Record<string, string>;
  savedAt: string;
};
function required(map: Record<string, string>, name: string) {
  const value = map[name];
  if (!value || value === 'None') throw new Error(`Missing release metadata ${name}`);
  return value;
}
export async function main(
  args = process.argv.slice(2),
  testing?: { platform: (phase: string) => Promise<{ pins: Record<string, string>; confirmed?: boolean }> }
) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Release tooling requires Node 24');
  const [command, ...rest] = args,
    options: Record<string, string> = {};
  if (!command || !/^(prepare|promote|rollback)-(http|workers)$/.test(command))
    throw new Error('Invalid native release phase');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (!key || !['--receipt-dir', '--commit'].includes(key) || !value || options[key])
      throw new Error('Invalid release option');
    options[key] = value;
  }
  const receiptDir = options['--receipt-dir'],
    build = options['--commit'];
  if (!receiptDir || !isAbsolute(receiptDir) || !build || !/^[a-f0-9]{40}$/.test(build))
    throw new Error('Private absolute receipt path and committed build required');
  await mkdir(receiptDir, { recursive: true, mode: 0o700 });
  const dir = await realpath(receiptDir),
    repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    within = relative(repo, dir);
  if (
    !within ||
    (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within)) ||
    (await stat(dir)).mode & 0o077
  )
    throw new Error('Receipts must be private and outside the repository');
  const lock = resolve(dir, 'native-release.lock');
  await mkdir(lock, { mode: 0o700 });
  try {
    const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    if (identity.Account !== '999153317627' || !identity.Arn?.includes(':assumed-role/ProjectsCloudEngineer/'))
      throw new Error('Unexpected release identity');
    const cfn = new CloudFormationClient({ region });
    const stack = (await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
    if (
      !stack?.StackId?.startsWith(`arn:aws:cloudformation:${region}:${identity.Account}:stack/${stackName}/`) ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus ?? '')
    )
      throw new Error('Release requires the idle reviewed stack');
    const parameters = Object.fromEntries((stack.Parameters ?? []).map((p) => [p.ParameterKey!, p.ParameterValue!])),
      outputs = Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
    const lambda = new LambdaClient({ region, maxAttempts: 1 }),
      web = new LambdaWebClient({ region, maxAttempts: 1 });
    const pathFor = (name: string) => resolve(dir, `${build}-${name}.json`);
    const save = async (name: string, value: Receipt) => {
      const tmp = resolve(dir, `.${randomUUID()}.tmp`);
      const file = await open(tmp, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(value, null, 2) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(tmp, pathFor(name));
      } finally {
        await rm(tmp, { force: true });
      }
    };
    const load = async (name: string) => {
      const value = JSON.parse(await readFile(pathFor(name), 'utf8')) as Receipt;
      if (value.schema !== 1 || value.stack !== stack.StackId || value.build !== build)
        throw new Error('Release receipt does not belong to this stack');
      return value;
    };
    const optional = async (name: string) => {
      try {
        return await load(name);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const platform =
      testing?.platform ??
      (async (phase: string) =>
        JSON.parse(
          (
            await run(
              process.execPath,
              ['--import', 'tsx', resolve(repo, 'tools/web-platform.ts'), phase, '--receipt-dir', dir],
              { maxBuffer: 1024 * 1024 }
            )
          ).stdout
        ) as { pins: Record<string, string>; confirmed?: boolean });
    const same = (left: Record<string, string>, right: Record<string, string>) =>
      Object.keys(left).length === Object.keys(right).length &&
      Object.entries(left).every(([key, value]) => right[key] === value);
    const aliases = async () => {
      const result: Record<string, Snapshot> = {};
      for (const name of names) {
        const arn = required(outputs, `${name}WorkerAlias`);
        if (
          !arn.startsWith(`arn:aws:lambda:${region}:${identity.Account}:function:${stackName}-`) ||
          !arn.endsWith(':live')
        )
          throw new Error('Unexpected worker alias identity');
        const functionName = arn.slice(0, -5),
          alias = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: 'live' }));
        if (
          !alias.FunctionVersion ||
          !alias.RevisionId ||
          Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length
        )
          throw new Error('Worker alias is not one immutable version');
        result[name] = { version: alias.FunctionVersion, revision: alias.RevisionId, functionName };
      }
      return result;
    };
    const unchanged = async (baseline: Record<string, Snapshot>) => {
      const current = await aliases();
      for (const name of names)
        if (
          current[name]?.version !== baseline[name]?.version ||
          current[name]?.revision !== baseline[name]?.revision ||
          current[name]?.functionName !== baseline[name]?.functionName
        )
          throw new Error('Worker alias changed since preparation');
    };
    const candidate = async (
      name: string,
      version: string,
      functionName: string,
      expectedBuild: string,
      sha?: string,
      priorVersion?: string
    ) => {
      if (!/^[1-9][0-9]*$/.test(version)) throw new Error('Candidate must be a published version');
      const config = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version })
      );
      const keys: Record<string, string[]> = {
        Sender: ['TABLE', 'BUCKET', 'FROM_ADDRESS', 'CONFIG_SET', 'INBOUND_DOMAIN'],
        Inbound: ['TABLE', 'BUCKET', 'FROM_ADDRESS', 'CONFIG_SET', 'INBOUND_DOMAIN'],
        Events: ['TABLE', 'ALARM_TOPIC'],
        Transcribe: ['TABLE', 'BUCKET'],
        Describe: ['TABLE', 'BUCKET', 'SELF', 'SECRET'],
        Export: ['TABLE', 'MAIL_BUCKET'],
        Capture: ['TABLE', 'WEB_ORIGIN']
      };
      const prior = priorVersion
        ? await lambda.send(
            new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: priorVersion })
          )
        : config;
      const expected = prior.Environment?.Variables ?? {},
        actual = config.Environment?.Variables ?? {};
      if (
        !config.Role ||
        config.Role !== prior.Role ||
        'ORIGIN_SECRET' in actual ||
        keys[name]!.some(
          (key) =>
            !actual[key] || actual[key] !== (expected[key] ?? (key === 'MAIL_BUCKET' ? expected.BUCKET : undefined))
        )
      )
        throw new Error(`Incomplete candidate ownership/environment ${name}`);
      if (
        config.Runtime !== 'nodejs24.x' ||
        config.Handler !== 'index.handler' ||
        config.Architectures?.join(',') !== 'arm64' ||
        config.State !== 'Active' ||
        (config.LastUpdateStatus && config.LastUpdateStatus !== 'Successful') ||
        config.Environment?.Variables?.APP_VERSION !== expectedBuild ||
        (sha && config.CodeSha256 !== sha)
      )
        throw new Error(`Incomplete candidate configuration ${name}`);
      const probe = await lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          Qualifier: version,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from('{"self_test":true}')
        })
      );
      const result = JSON.parse(Buffer.from(probe.Payload ?? []).toString('utf8')) as {
        ok?: boolean;
        runtime?: string;
        build?: string;
      };
      if (
        probe.FunctionError ||
        probe.StatusCode !== 200 ||
        result.ok !== true ||
        result.build !== expectedBuild ||
        !/^Node 24\.[\d.]+\/linux\/arm64$/.test(result.runtime ?? '')
      )
        throw new Error(`Runtime self-test failed ${name}`);
    };
    const httpCandidate = async (name: 'App' | 'Mcp', revisionId: string) => {
      const revision = await web.send(
        new GetWebFunctionRevisionCommand({ functionName: required(outputs, `Native${name}FunctionName`), revisionId })
      );
      const source = revision.buildConfig?.codeConfig?.s3Object,
        service = revision.serviceConfig;
      const physical = async (logical: string) =>
        required(
          {
            value:
              (await cfn.send(new DescribeStackResourceCommand({ StackName: stackName, LogicalResourceId: logical })))
                .StackResourceDetail?.PhysicalResourceId ?? ''
          },
          'value'
        );
      const role = `arn:aws:iam::${identity.Account}:role/${await physical(name === 'App' ? 'WebRole' : 'McpRole')}`;
      const expected: Record<string, string> = {
        TABLE: required(outputs, 'TableName'),
        MAIL_BUCKET: required(outputs, 'MailBucketName'),
        WEB_ORIGIN: `https://${required(parameters, 'WebDomain')}`,
        APP_VERSION: build
      };
      if (name === 'App')
        Object.assign(expected, {
          FROM_ADDRESS: required(parameters, 'FromAddress'),
          INBOUND_DOMAIN: required(parameters, 'InboundDomain'),
          CONFIG_SET: await physical('ConfigurationSet'),
          SENDER_FUNCTION: required(outputs, 'SenderWorkerAlias'),
          EXPORT_FUNCTION: required(outputs, 'ExportWorkerAlias')
        });
      else expected.CAPTURE_FUNCTION = required(outputs, 'CaptureWorkerAlias');
      if (
        revision.state !== 'Active' ||
        revision.revisionId !== revisionId ||
        revision.functionArn !== required(outputs, `Native${name}FunctionArn`) ||
        revision.buildConfig?.runtimeConfig?.runtime !== 'nodejs24.x' ||
        source?.bucket !== required(outputs, 'NativeSourceBucketName') ||
        source.key !== required(parameters, `Native${name}CodeKey`) ||
        source.versionId !== required(parameters, `Native${name}CodeVersion`) ||
        service?.executionRoleArn !== role ||
        service.timeoutSeconds !== 28 ||
        service.maxConcurrencyPerEnvironment !== Number(required(parameters, 'NativeMaxConcurrency')) ||
        'ORIGIN_SECRET' in (service.environmentVariables ?? {}) ||
        Object.entries(expected).some(([key, value]) => service?.environmentVariables?.[key] !== value)
      )
        throw new Error(`HTTP candidate configuration/source mismatch ${name}`);
    };
    const base: Receipt = { schema: 1, stack: stack.StackId, build, parameters, savedAt: new Date().toISOString() };
    let result: Record<string, string> = {};
    const kind = command.endsWith('http') ? 'http' : 'workers';
    const preparedName = `${kind}-prepared`,
      promotionName = `${kind}-promotion`,
      rollbackName = `${kind}-rollback`;
    const existingPreparation = await optional(preparedName),
      existingPromotion = await optional(promotionName);
    if (command === 'prepare-http') {
      if (existingPromotion) throw new Error('Promotion intent already exists; resume promotion or rollback');
      const { pins } = await platform('prepare');
      if (
        parameters.NativeHttpRouting === 'native' &&
        parameters.NativeAppBuildId === build &&
        parameters.NativeMcpBuildId === build &&
        ['App', 'Mcp'].every(
          (name) => pins[`Native${name}LiveRevisionId`] === outputs[`Native${name}CandidateRevisionId`]
        )
      )
        throw new Error('This HTTP build is already promoted; no earlier baseline can be recovered');
      if (existingPreparation) {
        if (!existingPreparation.pins || !same(pins, existingPreparation.pins))
          throw new Error('HTTP endpoints changed since preparation');
        result = { ...existingPreparation.pins, NativeHttpRouting: parameters.NativeHttpRouting ?? 'legacy' };
      } else {
        base.pins = pins;
        await save(preparedName, base);
        result = { ...pins, NativeHttpRouting: parameters.NativeHttpRouting ?? 'legacy' };
      }
    } else if (command === 'prepare-workers') {
      if (existingPromotion) throw new Error('Promotion intent already exists; resume promotion or rollback');
      if (parameters.WorkerAliasesReady !== 'true' || parameters.EventsAliasesReady !== 'true')
        throw new Error('Complete Python aliases must be active first');
      const current = await aliases();
      if (
        parameters.NativeWorkerAliasesReady === 'true' &&
        parameters.NativeWorkerBuildId === build &&
        names.every((name) => current[name]!.version === outputs[`${name}NativeCandidateVersion`])
      )
        throw new Error('This worker build is already promoted; no earlier baseline can be recovered');
      if (existingPreparation) {
        if (!existingPreparation.aliases) throw new Error('Missing prepared worker aliases');
        await unchanged(existingPreparation.aliases);
        base.aliases = existingPreparation.aliases;
      } else {
        base.aliases = current;
        if (parameters.NativeWorkerAliasesReady === 'true')
          for (const name of names) {
            const live = current[name]!;
            const config = await lambda.send(
              new GetFunctionConfigurationCommand({ FunctionName: live.functionName, Qualifier: live.version })
            );
            const liveBuild = config.Environment?.Variables?.APP_VERSION;
            if (
              config.Runtime !== 'nodejs24.x' ||
              !liveBuild ||
              !/^[a-f0-9]{40}$/.test(liveBuild) ||
              !config.CodeSha256
            )
              throw new Error(`Incomplete prior native release metadata ${name}`);
            live.build = liveBuild;
            live.sha = config.CodeSha256;
          }
        await unchanged(current);
        await save(preparedName, base);
      }
      for (const name of names) result[`${name}NativeLiveVersion`] = base.aliases[name]!.version;
      if ((existingPreparation ?? base).parameters.NativeWorkerAliasesReady !== 'true')
        result.NativeWorkerAliasesReady = 'false';
    } else if (command === 'promote-workers') {
      const prepared = await load(preparedName);
      if (!prepared.aliases || parameters.NativeWorkersEnabled !== 'true' || parameters.NativeWorkerBuildId !== build)
        throw new Error('Prepare and publish this exact worker build first');
      for (const name of names) result[`${name}NativeLiveVersion`] = required(outputs, `${name}NativeCandidateVersion`);
      result.NativeWorkerAliasesReady = 'true';
      result.NativeWorkersEnabled = 'true';
      if (existingPromotion && (!existingPromotion.target || !same(result, existingPromotion.target)))
        throw new Error('Published candidates differ from immutable promotion intent');
      const current = await aliases();
      const completed =
        parameters.NativeWorkerAliasesReady === 'true' &&
        names.every(
          (name) =>
            current[name]!.version === result[`${name}NativeLiveVersion`] &&
            current[name]!.functionName === prepared.aliases![name]!.functionName
        );
      if (!completed) await unchanged(prepared.aliases);
      else if (!existingPromotion) throw new Error('Candidate already serves without this release intent');
      for (const name of names)
        await candidate(
          name,
          result[`${name}NativeLiveVersion`]!,
          prepared.aliases[name]!.functionName,
          build,
          required(parameters, `${name}NodeCodeSha256`),
          prepared.aliases[name]!.version
        );
      await unchanged(completed ? current : prepared.aliases);
      if (!existingPromotion) {
        base.previous = prepared;
        base.target = result;
        await save(promotionName, base);
      }
    } else if (command === 'promote-http') {
      const prepared = await load(preparedName);
      if (
        !prepared.pins ||
        parameters.NativeWebFunctionsEnabled !== 'true' ||
        ['App', 'Mcp'].some((name) => parameters[`Native${name}BuildId`] !== build)
      )
        throw new Error('Prepare and publish this exact HTTP build first');
      if ((await platform('policy-verify')).confirmed !== true)
        throw new Error('HTTP origin policy verification was not confirmed');
      const now = (await platform('prepare')).pins;
      for (const name of ['App', 'Mcp'] as const) {
        result[`Native${name}LiveRevisionId`] = required(outputs, `Native${name}CandidateRevisionId`);
        result[`Native${name}RollbackRevisionId`] =
          prepared.pins[`Native${name}LiveRevisionId`] ??
          existingPromotion?.target?.[`Native${name}RollbackRevisionId`] ??
          required(now, `Native${name}LiveRevisionId`);
        await httpCandidate(name, result[`Native${name}LiveRevisionId`]!);
      }
      result.NativeHttpRouting = 'native';
      result.NativeOriginPoliciesReady = 'true';
      if (existingPromotion && (!existingPromotion.target || !same(result, existingPromotion.target)))
        throw new Error('Published candidates differ from immutable promotion intent');
      const targetPins = Object.fromEntries(Object.entries(result).filter(([key]) => /RevisionId$/.test(key)));
      const completed = parameters.NativeHttpRouting === 'native' && same(now, targetPins);
      if (!completed && Object.keys(prepared.pins).length && !same(now, prepared.pins))
        throw new Error('HTTP endpoints changed since preparation');
      if (completed && !existingPromotion) throw new Error('Candidate already serves without this release intent');
      if (!same(now, (await platform('prepare')).pins)) throw new Error('HTTP endpoints changed during verification');
      if (!existingPromotion) {
        base.previous = prepared;
        base.target = result;
        await save(promotionName, base);
      }
    } else {
      const promotion = await load(promotionName),
        previous = promotion.previous,
        rollback = await optional(rollbackName);
      if (!previous || previous.build !== build || !promotion.target)
        throw new Error('No recorded prior release for this build');
      if (kind === 'http') {
        if (['App', 'Mcp'].some((name) => parameters[`Native${name}BuildId`] !== build))
          throw new Error('Current HTTP build differs from rollback intent');
        result =
          previous.parameters.NativeHttpRouting !== 'native'
            ? { NativeHttpRouting: 'legacy' }
            : { ...previous.pins, NativeHttpRouting: 'native', NativeOriginPoliciesReady: 'true' };
        const current = (await platform('prepare')).pins;
        const targetPins = Object.fromEntries(
          Object.entries(promotion.target).filter(([key]) => /RevisionId$/.test(key))
        );
        const restoredPins = previous.parameters.NativeHttpRouting === 'native' ? previous.pins! : targetPins;
        const recovered =
          Object.entries(result).every(([key, value]) => parameters[key] === value) && same(current, restoredPins);
        if (!recovered && (parameters.NativeHttpRouting !== 'native' || !same(current, targetPins)))
          throw new Error('HTTP routing changed since this promotion; refusing rollback');
        if (previous.parameters.NativeHttpRouting === 'native' && (await platform('policy-verify')).confirmed !== true)
          throw new Error('HTTP origin policy verification was not confirmed');
      } else {
        if (!previous.aliases || parameters.NativeWorkerBuildId !== build)
          throw new Error('Current worker build differs from rollback intent');
        for (const name of names) result[`${name}NativeLiveVersion`] = previous.aliases[name]!.version;
        result.NativeWorkerAliasesReady = previous.parameters.NativeWorkerAliasesReady === 'true' ? 'true' : 'false';
        const current = await aliases();
        const recovered =
          parameters.NativeWorkerAliasesReady === result.NativeWorkerAliasesReady &&
          names.every(
            (name) =>
              current[name]!.version === result[`${name}NativeLiveVersion`] &&
              current[name]!.functionName === previous.aliases![name]!.functionName
          );
        if (
          !recovered &&
          (parameters.NativeWorkerAliasesReady !== 'true' ||
            names.some(
              (name) =>
                current[name]!.version !== promotion.target![`${name}NativeLiveVersion`] ||
                current[name]!.functionName !== previous.aliases![name]!.functionName
            ))
        )
          throw new Error('Worker aliases changed since this promotion; refusing rollback');
        if (previous.parameters.NativeWorkerAliasesReady === 'true')
          for (const name of names)
            await candidate(
              name,
              previous.aliases[name]!.version,
              previous.aliases[name]!.functionName,
              required({ build: previous.aliases[name]!.build ?? '' }, 'build'),
              required({ sha: previous.aliases[name]!.sha ?? '' }, 'sha')
            );
      }
      if (rollback && (!rollback.target || !same(rollback.target, result)))
        throw new Error('Rollback differs from immutable prior intent');
      if (!rollback) {
        base.previous = promotion;
        base.target = result;
        await save(rollbackName, base);
      }
    }
    console.info(JSON.stringify({ parameters: result }));
  } finally {
    await rm(lock, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? (error.name === 'Error' ? error.message : error.name) : 'Native release failed'
    );
    process.exitCode = 1;
  });
