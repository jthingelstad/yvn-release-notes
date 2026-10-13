/** Metadata-only release planning with private pre-deployment receipts. The
 * only invocation is an exact content-free runtime self-test on an immutable
 * candidate version; publication/routing stays owned by CloudFormation. */
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetAliasCommand, GetFunctionConfigurationCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { LambdaWebClient, GetWebFunctionRevisionCommand } from '@aws-sdk/client-lambda-web';
import { mkdir, realpath, stat, writeFile, rename, readFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile),
  region = 'us-east-1',
  stackName = 'yvn-release-notes';
const names = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'] as const;
type Snapshot = { version: string; revision: string; functionName: string };
type Receipt = {
  schema: 1;
  stack: string;
  build: string;
  parameters: Record<string, string>;
  aliases?: Record<string, Snapshot>;
  pins?: Record<string, string>;
  previous?: Receipt;
  savedAt: string;
};
function required(map: Record<string, string>, name: string) {
  const value = map[name];
  if (!value || value === 'None') throw new Error(`Missing release metadata ${name}`);
  return value;
}
export async function main(args = process.argv.slice(2)) {
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
    const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName })))
      .Stacks?.[0];
    if (
      !stack?.StackId?.startsWith(`arn:aws:cloudformation:${region}:${identity.Account}:stack/${stackName}/`) ||
      !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus ?? '')
    )
      throw new Error('Release requires the idle reviewed stack');
    const parameters = Object.fromEntries((stack.Parameters ?? []).map((p) => [p.ParameterKey!, p.ParameterValue!])),
      outputs = Object.fromEntries((stack.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
    const lambda = new LambdaClient({ region, maxAttempts: 1 }),
      web = new LambdaWebClient({ region, maxAttempts: 1 });
    const save = async (name: string, value: Receipt) => {
      const tmp = resolve(dir, `.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await rename(tmp, resolve(dir, name));
    };
    const load = async (name: string) => {
      const value = JSON.parse(await readFile(resolve(dir, name), 'utf8')) as Receipt;
      if (value.schema !== 1 || value.stack !== stack.StackId)
        throw new Error('Release receipt does not belong to this stack');
      return value;
    };
    const platform = async (phase: string) =>
      JSON.parse(
        (
          await run(
            process.execPath,
            ['--import', 'tsx', resolve(repo, 'tools/web-platform.ts'), phase, '--receipt-dir', dir],
            { maxBuffer: 1024 * 1024 }
          )
        ).stdout
      ) as { pins: Record<string, string>; confirmed?: boolean };
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
      sha?: string
    ) => {
      if (!/^[1-9][0-9]*$/.test(version)) throw new Error('Candidate must be a published version');
      const config = await lambda.send(
        new GetFunctionConfigurationCommand({ FunctionName: functionName, Qualifier: version })
      );
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
    const base: Receipt = { schema: 1, stack: stack.StackId, build, parameters, savedAt: new Date().toISOString() };
    let result: Record<string, string> = {};
    if (command === 'prepare-http') {
      const { pins } = await platform('prepare');
      base.pins = pins;
      await save('http-prepared.json', base);
      result = pins;
    } else if (command === 'prepare-workers') {
      if (parameters.WorkerAliasesReady !== 'true' || parameters.EventsAliasesReady !== 'true')
        throw new Error('Complete Python aliases must be active first');
      base.aliases = await aliases();
      await save('workers-prepared.json', base);
      for (const name of names) result[`${name}NativeLiveVersion`] = base.aliases[name]!.version;
      // Preparation pins Python versions but does not select them through the native branch.
      if (parameters.NativeWorkerAliasesReady !== 'true') result.NativeWorkerAliasesReady = 'false';
    } else if (command === 'promote-workers') {
      const prepared = await load('workers-prepared.json');
      if (
        prepared.build !== build ||
        !prepared.aliases ||
        parameters.NativeWorkersEnabled !== 'true' ||
        parameters.NativeWorkerBuildId !== build
      )
        throw new Error('Prepare and publish this exact worker build first');
      await unchanged(prepared.aliases);
      for (const name of names) {
        const version = required(outputs, `${name}NativeCandidateVersion`);
        await candidate(
          name,
          version,
          prepared.aliases[name]!.functionName,
          build,
          required(parameters, `${name}NodeCodeSha256`)
        );
        result[`${name}NativeLiveVersion`] = version;
      }
      await unchanged(prepared.aliases);
      result.NativeWorkerAliasesReady = 'true';
      result.NativeWorkersEnabled = 'true';
      base.previous = prepared;
      await save('workers-promotion.json', base);
    } else if (command === 'promote-http') {
      const prepared = await load('http-prepared.json');
      if (prepared.build !== build || parameters.NativeWebFunctionsEnabled !== 'true')
        throw new Error('Prepare and publish this exact HTTP build first');
      await platform('policy-verify');
      const now = (await platform('prepare')).pins;
      if (Object.keys(prepared.pins ?? {}).length && JSON.stringify(now) !== JSON.stringify(prepared.pins))
        throw new Error('HTTP endpoints changed since preparation');
      for (const name of ['App', 'Mcp']) {
        const revisionId = required(outputs, `Native${name}CandidateRevisionId`),
          revision = await web.send(
            new GetWebFunctionRevisionCommand({
              functionName: required(outputs, `Native${name}FunctionName`),
              revisionId
            })
          );
        if (
          revision.state !== 'Active' ||
          revision.revisionId !== revisionId ||
          required(parameters, `Native${name}BuildId`) !== build
        )
          throw new Error('HTTP candidate is not active for this build');
        result[`Native${name}LiveRevisionId`] = revisionId;
        result[`Native${name}RollbackRevisionId`] = now[`Native${name}LiveRevisionId`]!;
      }
      result.NativeHttpRouting = 'native';
      result.NativeOriginPoliciesReady = 'true';
      base.previous = prepared;
      await save('http-promotion.json', base);
    } else if (command === 'rollback-http') {
      const promotion = await load('http-promotion.json'),
        previous = promotion.previous;
      if (!previous) throw new Error('No recorded prior HTTP release');
      if (previous.parameters.NativeHttpRouting !== 'native') result.NativeHttpRouting = 'legacy';
      else {
        result = { ...previous.pins, NativeHttpRouting: 'native', NativeOriginPoliciesReady: 'true' };
        await platform('policy-verify');
      }
      await save(`http-rollback-${randomUUID()}.json`, base);
    } else {
      const promotion = await load('workers-promotion.json'),
        previous = promotion.previous;
      if (!previous?.aliases) throw new Error('No recorded prior worker release');
      for (const name of names) {
        const version = previous.aliases[name]!.version;
        if (previous.parameters.NativeWorkerAliasesReady === 'true')
          await candidate(
            name,
            version,
            previous.aliases[name]!.functionName,
            required(previous.parameters, 'NativeWorkerBuildId')
          );
        result[`${name}NativeLiveVersion`] = version;
      }
      result.NativeWorkerAliasesReady = previous.parameters.NativeWorkerAliasesReady === 'true' ? 'true' : 'false';
      await save(`workers-rollback-${randomUUID()}.json`, base);
    }
    console.info(JSON.stringify({ parameters: result }));
  } finally {
    await rm(lock, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Native release failed');
    process.exitCode = 1;
  });
