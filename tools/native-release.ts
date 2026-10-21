/** Metadata-only release planning with private pre-deployment receipts in the
 * receipts bucket (tools/receipt-store.ts), run through tools/release-cli.ts
 * under the deploy lock. The only invocation is an exact content-free runtime
 * self-test on an immutable candidate version; publication/routing stays owned
 * by CloudFormation. */
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourceCommand
} from '@aws-sdk/client-cloudformation';
import { LambdaClient, GetAliasCommand, GetFunctionConfigurationCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { LambdaWebClient, GetWebFunctionRevisionCommand } from '@aws-sdk/client-lambda-web';
import { createReceipt, readReceipt, type ReceiptStore } from './receipt-store.ts';
import { releaseIdentity, region, stackName } from './release-identity.ts';
import { runPlatform } from './web-platform.ts';
type Platform = (phase: 'prepare' | 'policy-verify') => Promise<{ pins: Record<string, string>; confirmed?: boolean }>;
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
/** The CloudFormation parameters for one phase; the caller holds the deploy lock. */
export async function main(args: string[], deps: { store: ReceiptStore; platform?: Platform }) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Release tooling requires Node 24');
  const [command, flag, build, ...extra] = args;
  if (!command || !/^(prepare|promote|rollback)-(http|workers)$/.test(command))
    throw new Error('Invalid native release phase');
  if (flag !== '--commit' || !build || !/^[a-f0-9]{40}$/.test(build) || extra.length)
    throw new Error('A committed build is required');
  const { store } = deps;
  const identity = { Account: (await releaseIdentity()).account };
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
  const receiptName = (name: string) => `${build}-${name}.json`;
  const save = (name: string, value: Receipt) => createReceipt(store, receiptName(name), value);
  const optional = async (name: string) => {
    const value = await readReceipt<Receipt>(store, receiptName(name));
    if (value && (value.schema !== 1 || value.stack !== stack.StackId || value.build !== build))
      throw new Error('Release receipt does not belong to this stack');
    return value;
  };
  const load = async (name: string) => {
    const value = await optional(name);
    if (!value) throw new Error('Missing release receipt');
    return value;
  };
  const platform: Platform = deps.platform ?? ((phase) => runPlatform(phase, store));
  // A phase's parameters are pins and versions only. Intents recorded by the
  // tooling before 2026-10-20 also carry stack flags since retired, which a
  // comparison leaves out.
  const pinned = (target: Record<string, string>) =>
    Object.fromEntries(Object.entries(target).filter(([key]) => /(RevisionId|NativeLiveVersion)$/.test(key)));
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
      ? await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: priorVersion }))
      : config;
    const expected = { ...prior.Environment?.Variables },
      actual = config.Environment?.Variables ?? {};
    // The describer reads the secret the stack names (RuntimeSecretName), so
    // a promotion may move it off the live version's; a rollback may not.
    if (priorVersion && name === 'Describe' && parameters.RuntimeSecretName)
      expected.SECRET = parameters.RuntimeSecretName;
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
      (name === 'App' && (service.environmentVariables?.ADMIN_USER_ID ?? '') !== (parameters.AdminUserId ?? '')) ||
      (name === 'App' && (service.environmentVariables?.TURNSTILE_MODE ?? '') !== (parameters.TurnstileMode ?? '')) ||
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
      result = { ...existingPreparation.pins };
    } else {
      base.pins = pins;
      await save(preparedName, base);
      result = { ...pins };
    }
  } else if (command === 'prepare-workers') {
    if (existingPromotion) throw new Error('Promotion intent already exists; resume promotion or rollback');
    const current = await aliases();
    if (
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
      // The serving versions' own build and code hash, so a rollback can
      // verify exactly what it restores.
      for (const name of names) {
        const live = current[name]!;
        const config = await lambda.send(
          new GetFunctionConfigurationCommand({ FunctionName: live.functionName, Qualifier: live.version })
        );
        const liveBuild = config.Environment?.Variables?.APP_VERSION;
        if (config.Runtime !== 'nodejs24.x' || !liveBuild || !/^[a-f0-9]{40}$/.test(liveBuild) || !config.CodeSha256)
          throw new Error(`Incomplete prior release metadata ${name}`);
        live.build = liveBuild;
        live.sha = config.CodeSha256;
      }
      await unchanged(current);
      await save(preparedName, base);
    }
    for (const name of names) result[`${name}NativeLiveVersion`] = base.aliases[name]!.version;
  } else if (command === 'promote-workers') {
    const prepared = await load(preparedName);
    if (!prepared.aliases || parameters.NativeWorkerBuildId !== build)
      throw new Error('Prepare and publish this exact worker build first');
    for (const name of names) result[`${name}NativeLiveVersion`] = required(outputs, `${name}NativeCandidateVersion`);
    if (existingPromotion && (!existingPromotion.target || !same(result, pinned(existingPromotion.target))))
      throw new Error('Published candidates differ from immutable promotion intent');
    const current = await aliases();
    const completed = names.every(
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
    if (!prepared.pins || ['App', 'Mcp'].some((name) => parameters[`Native${name}BuildId`] !== build))
      throw new Error('Prepare and publish this exact HTTP build first');
    if ((await platform('policy-verify')).confirmed !== true)
      throw new Error('HTTP origin policy verification was not confirmed');
    const now = (await platform('prepare')).pins;
    for (const name of ['App', 'Mcp'] as const) {
      result[`Native${name}LiveRevisionId`] = required(outputs, `Native${name}CandidateRevisionId`);
      result[`Native${name}RollbackRevisionId`] = required(prepared.pins, `Native${name}LiveRevisionId`);
      await httpCandidate(name, result[`Native${name}LiveRevisionId`]!);
    }
    if (existingPromotion && (!existingPromotion.target || !same(result, pinned(existingPromotion.target))))
      throw new Error('Published candidates differ from immutable promotion intent');
    const completed = same(now, result);
    if (!completed && !same(now, prepared.pins)) throw new Error('HTTP endpoints changed since preparation');
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
      if (!['App', 'Mcp'].every((name) => previous.pins?.[`Native${name}LiveRevisionId`]))
        throw new Error('The recorded baseline has no serving revisions to restore');
      result = { ...previous.pins! };
      const current = (await platform('prepare')).pins;
      const recovered =
        Object.entries(result).every(([key, value]) => parameters[key] === value) && same(current, result);
      if (!recovered && !same(current, pinned(promotion.target)))
        throw new Error('HTTP routing changed since this promotion; refusing rollback');
      if ((await platform('policy-verify')).confirmed !== true)
        throw new Error('HTTP origin policy verification was not confirmed');
    } else {
      if (!previous.aliases || parameters.NativeWorkerBuildId !== build)
        throw new Error('Current worker build differs from rollback intent');
      for (const name of names) result[`${name}NativeLiveVersion`] = previous.aliases[name]!.version;
      const current = await aliases();
      const recovered = names.every(
        (name) =>
          current[name]!.version === result[`${name}NativeLiveVersion`] &&
          current[name]!.functionName === previous.aliases![name]!.functionName
      );
      if (
        !recovered &&
        names.some(
          (name) =>
            current[name]!.version !== promotion.target![`${name}NativeLiveVersion`] ||
            current[name]!.functionName !== previous.aliases![name]!.functionName
        )
      )
        throw new Error('Worker aliases changed since this promotion; refusing rollback');
      for (const name of names)
        await candidate(
          name,
          previous.aliases[name]!.version,
          previous.aliases[name]!.functionName,
          required({ build: previous.aliases[name]!.build ?? '' }, 'build'),
          required({ sha: previous.aliases[name]!.sha ?? '' }, 'sha')
        );
    }
    if (rollback && (!rollback.target || !same(pinned(rollback.target), result)))
      throw new Error('Rollback differs from immutable prior intent');
    if (!rollback) {
      base.previous = promotion;
      base.target = result;
      await save(rollbackName, base);
    }
  }
  return { parameters: result };
}
