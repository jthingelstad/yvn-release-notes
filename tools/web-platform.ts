/** Sole owner of native HTTP endpoint policies and release pin receipts.
 * Run with Node 24, AWS_PROFILE=cloud-engineer and --receipt-dir OUTSIDE the repo.
 * No data-plane reads, credential retrieval, source deletion or CloudFront edits.
 * Publish flow: prepare -> CF pinned candidate -> policy-install -> policy-verify
 * -> CF origin switch. Revert routing before policy-remove or disabling compute.
 */
import {
  LambdaWebClient,
  GetResourcePolicyCommand,
  PutResourcePolicyCommand,
  DeleteResourcePolicyCommand,
  GetWebFunctionEndpointCommand,
  type GetWebFunctionEndpointResponse
} from '@aws-sdk/client-lambda-web';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

type Kind = 'App' | 'Mcp';
type Artifact = { key: string; versionId: string; buildId: string };
type Policy = ReturnType<typeof endpointPolicy>;
type Journal = {
  schema: 1;
  owner: 'yvn-web-platform-v1';
  stackId: string;
  functionArn: string;
  endpointArn: string;
  policy: Policy;
  policyHash: string;
  revisionId?: string;
  previousRevisionId?: string;
  state: 'pending' | 'installed' | 'removing' | 'deleted';
  artifact: Artifact;
  savedAt: string;
};
export type Context = {
  stackId: string;
  stackName: string;
  distributionArn: string;
  outputs: Record<string, string>;
  parameters: Record<string, string>;
  web: LambdaWebClient;
};

/** Exact endpoint-only grant; never permits public invocation or rollback use. */
export function endpointPolicy(endpointArn: string, distributionArn: string) {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReleaseNotesCloudFrontLiveOnly',
        Effect: 'Allow',
        Principal: { Service: 'cloudfront.amazonaws.com' },
        Action: 'lambda:InvokeWebFunctionEndpoint',
        Resource: endpointArn,
        Condition: { StringEquals: { 'aws:SourceArn': distributionArn } }
      }
    ]
  };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = value as Record<string, unknown>;
    return `{${Object.keys(fields)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('Undefined policy field');
  return encoded;
}

export function policyHash(policy: unknown): string {
  return createHash('sha256').update(canonical(policy)).digest('hex');
}

export function pinnedRevision(endpoint: GetWebFunctionEndpointResponse): string {
  const weights = endpoint.revisionWeights;
  if (
    endpoint.authType !== 'IamAuth' ||
    endpoint.endpointType !== 'HomeRegion' ||
    endpoint.autoDeploymentMode !== 'Disabled' ||
    endpoint.state !== 'Active' ||
    (endpoint.updateStatus !== undefined && endpoint.updateStatus !== 'Successful') ||
    weights?.length !== 1 ||
    weights[0]?.weight !== 100 ||
    !weights[0].revisionId
  ) {
    throw new Error('Endpoint must be active, private, regional and pinned to one 100% revision');
  }
  return weights[0].revisionId;
}

export function assertOwnedPolicy(journal: Journal, policy: string, revisionId: string): void {
  if (
    journal.owner !== 'yvn-web-platform-v1' ||
    journal.schema !== 1 ||
    journal.policyHash !== policyHash(journal.policy) ||
    journal.policyHash !== policyHash(JSON.parse(policy)) ||
    (journal.state !== 'pending' && journal.revisionId !== revisionId)
  ) {
    throw new Error('Resource policy ownership or CAS revision changed; refusing to overwrite it');
  }
}

function required(fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (!value) throw new Error(`Missing stack metadata ${key}`);
  return value;
}

async function context(region: string, stackName: string): Promise<Context> {
  if (stackName !== 'yvn-release-notes') throw new Error('This release tool is scoped to yvn-release-notes');
  const identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
  if (!identity.Arn?.includes(':assumed-role/ProjectsCloudEngineer/') || !identity.Account) {
    throw new Error('Expected ProjectsCloudEngineer execution role');
  }
  const response = await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName }));
  const stack = response.Stacks?.[0];
  if (
    !stack?.StackId ||
    !['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE'].includes(stack.StackStatus ?? '')
  ) {
    throw new Error('Stack must be idle with a complete status');
  }
  const arn = stack.StackId.split(':');
  if (arn[3] !== region || arn[4] !== identity.Account) throw new Error('Stack identity/region mismatch');
  const outputs = Object.fromEntries((stack.Outputs ?? []).map((entry) => [entry.OutputKey!, entry.OutputValue!]));
  const parameters = Object.fromEntries(
    (stack.Parameters ?? []).map((entry) => [entry.ParameterKey!, entry.ParameterValue!])
  );
  return {
    stackId: stack.StackId,
    stackName,
    distributionArn: `arn:${arn[1]}:cloudfront::${identity.Account}:distribution/${required(outputs, 'WebDistributionId')}`,
    outputs,
    parameters,
    // A CAS mutation must never be blindly retried after an unknown response.
    web: new LambdaWebClient({ region, maxAttempts: 1 })
  };
}

async function endpoint(ctx: Context, kind: Kind, target: 'live' | 'rollback', requireActive = true) {
  const functionName = required(ctx.outputs, `Native${kind}FunctionName`);
  if (functionName !== `${ctx.stackName}-${kind === 'App' ? 'web' : 'mcp'}-native`) {
    throw new Error('Unexpected native function identity');
  }
  const response = await ctx.web.send(new GetWebFunctionEndpointCommand({ functionName, endpointName: target }));
  if (requireActive) pinnedRevision(response);
  if (
    response.functionArn !== required(ctx.outputs, `Native${kind}FunctionArn`) ||
    (target === 'live' &&
      (response.endpointArn !== required(ctx.outputs, `Native${kind}LiveEndpointArn`) ||
        response.domainName !== required(ctx.outputs, `Native${kind}LiveEndpointDomain`))) ||
    response.endpointName !== target ||
    response.throttleConfig?.rateLimit !== (target === 'live' ? 100 : 0)
  ) {
    throw new Error('Endpoint identity or rate configuration differs from the reviewed stack');
  }
  return response;
}

async function currentPolicy(ctx: Context, functionArn: string) {
  try {
    const response = await ctx.web.send(new GetResourcePolicyCommand({ resourceArn: functionArn }));
    if (!response.policy || !response.revisionId) throw new Error('Incomplete resource policy response');
    return { policy: response.policy, revisionId: response.revisionId };
  } catch (error) {
    if (error instanceof Error && error.name === 'ResourceNotFoundException') return undefined;
    throw error;
  }
}

function artifact(ctx: Context, kind: Kind): Artifact {
  return {
    key: required(ctx.parameters, `Native${kind}CodeKey`),
    versionId: required(ctx.parameters, `Native${kind}CodeVersion`),
    buildId: required(ctx.parameters, `Native${kind}BuildId`)
  };
}

async function save(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
}

async function journalAt(path: string): Promise<Journal | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    const journal = value as Journal;
    if (journal.schema !== 1 || journal.owner !== 'yvn-web-platform-v1') {
      throw new Error('Unrecognized policy journal');
    }
    return journal;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function checkJournal(ctx: Context, functionArn: string, endpointArn: string, journal: Journal): void {
  if (journal.stackId !== ctx.stackId || journal.functionArn !== functionArn || journal.endpointArn !== endpointArn) {
    throw new Error('Journal belongs to different stack or resources');
  }
}

export async function installPolicy(ctx: Context, kind: Kind, receiptDir: string): Promise<void> {
  const live = await endpoint(ctx, kind, 'live');
  const functionArn = live.functionArn!;
  const endpointArn = live.endpointArn!;
  const path = resolve(receiptDir, `${kind.toLowerCase()}-policy.json`);
  let journal = await journalAt(path);
  const actual = await currentPolicy(ctx, functionArn);
  const desired = endpointPolicy(endpointArn, ctx.distributionArn);
  if (journal) checkJournal(ctx, functionArn, endpointArn, journal);
  if (actual) {
    if (!journal || journal.state === 'deleted') throw new Error('Existing policy has no active owner journal');
    assertOwnedPolicy(journal, actual.policy, actual.revisionId);
    // Recover a prior unknown Put outcome only if its full desired policy matches.
    if (policyHash(desired) === policyHash(JSON.parse(actual.policy))) {
      journal = { ...journal, revisionId: actual.revisionId, state: 'installed', savedAt: new Date().toISOString() };
      await save(path, journal);
      return;
    }
  } else if (journal && !['pending', 'deleted'].includes(journal.state)) {
    throw new Error('Owned policy disappeared unexpectedly');
  }
  journal = {
    schema: 1,
    owner: 'yvn-web-platform-v1',
    stackId: ctx.stackId,
    functionArn,
    endpointArn,
    policy: desired,
    policyHash: policyHash(desired),
    previousRevisionId: actual?.revisionId,
    state: 'pending',
    artifact: artifact(ctx, kind),
    savedAt: new Date().toISOString()
  };
  // Persist intent before API submission. The initial empty policy has no CAS
  // token in this API; the sole owner, fresh private endpoint and local lock
  // bound that first write. Every subsequent mutation uses its returned token.
  await save(path, journal);
  await ctx.web.send(
    new PutResourcePolicyCommand({
      resourceArn: functionArn,
      policy: JSON.stringify(desired),
      ...(actual ? { revisionId: actual.revisionId } : {})
    })
  );
  const installed = await currentPolicy(ctx, functionArn);
  if (!installed) throw new Error('Policy installation was not confirmed');
  assertOwnedPolicy(journal, installed.policy, installed.revisionId);
  await save(path, { ...journal, state: 'installed', revisionId: installed.revisionId });
}

export async function verifyPolicy(ctx: Context, kind: Kind, receiptDir: string): Promise<void> {
  const live = await endpoint(ctx, kind, 'live');
  await endpoint(ctx, kind, 'rollback');
  const journal = await journalAt(resolve(receiptDir, `${kind.toLowerCase()}-policy.json`));
  if (!journal || journal.state !== 'installed') throw new Error('No installed owner journal');
  checkJournal(ctx, live.functionArn!, live.endpointArn!, journal);
  const actual = await currentPolicy(ctx, live.functionArn!);
  if (!actual) throw new Error('Endpoint resource policy is missing');
  assertOwnedPolicy(journal, actual.policy, actual.revisionId);
  if (policyHash(journal.policy) !== policyHash(endpointPolicy(live.endpointArn!, ctx.distributionArn))) {
    throw new Error('Policy differs from the exact distribution/live-endpoint grant');
  }
}

export async function removePolicy(ctx: Context, kind: Kind, receiptDir: string): Promise<void> {
  if (ctx.parameters.NativeHttpRouting !== 'legacy') {
    throw new Error('Restore legacy CloudFront routing before removing endpoint policies');
  }
  const live = await endpoint(ctx, kind, 'live', false);
  const path = resolve(receiptDir, `${kind.toLowerCase()}-policy.json`);
  const journal = await journalAt(path);
  if (!journal) throw new Error('No owner journal; refusing policy removal');
  checkJournal(ctx, live.functionArn!, live.endpointArn!, journal);
  const actual = await currentPolicy(ctx, live.functionArn!);
  if (!actual) {
    if (!['removing', 'deleted'].includes(journal.state)) throw new Error('Policy disappeared unexpectedly');
    await save(path, { ...journal, state: 'deleted' });
    return;
  }
  if (!['installed', 'removing'].includes(journal.state)) throw new Error('Policy must have a confirmed owner');
  assertOwnedPolicy(journal, actual.policy, actual.revisionId);
  await save(path, { ...journal, state: 'removing' });
  await ctx.web.send(
    new DeleteResourcePolicyCommand({ resourceArn: live.functionArn!, revisionId: actual.revisionId })
  );
  if (await currentPolicy(ctx, live.functionArn!)) throw new Error('Policy deletion was not confirmed');
  await save(path, { ...journal, state: 'deleted' });
}

async function prepare(ctx: Context, receiptDir: string) {
  const pins: Record<string, string> = {};
  const receipt: Record<string, unknown> = { stackId: ctx.stackId, savedAt: new Date().toISOString() };
  if (ctx.parameters.NativeWebFunctionsEnabled === 'true') {
    for (const kind of ['App', 'Mcp'] as const) {
      const live = await endpoint(ctx, kind, 'live');
      const rollback = await endpoint(ctx, kind, 'rollback');
      pins[`Native${kind}LiveRevisionId`] = pinnedRevision(live);
      pins[`Native${kind}RollbackRevisionId`] = pinnedRevision(rollback);
      receipt[kind] = {
        liveRevisionId: pinnedRevision(live),
        rollbackRevisionId: pinnedRevision(rollback),
        candidateRevisionId: required(ctx.outputs, `Native${kind}CandidateRevisionId`),
        artifact: artifact(ctx, kind)
      };
    }
  }
  await save(resolve(receiptDir, `release-${randomUUID()}.json`), { ...receipt, pins });
  return { pins, sourceBucket: required(ctx.outputs, 'NativeSourceBucketName') };
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Release tooling requires Node 24');
  const [command, ...args] = process.argv.slice(2);
  if (!['prepare', 'policy-install', 'policy-verify', 'policy-remove'].includes(command ?? '')) {
    throw new Error(
      'Usage: web-platform.ts prepare|policy-install|policy-verify|policy-remove --receipt-dir /private/path [--region us-east-1]'
    );
  }
  const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!['--receipt-dir', '--region', '--stack'].includes(key ?? '') || !value || options[key!]) {
      throw new Error('Invalid or duplicate release tool option');
    }
    options[key!] = value;
  }
  const dir = options['--receipt-dir'];
  if (!dir || !isAbsolute(dir)) throw new Error('A private absolute receipt directory is required');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const receiptDir = await realpath(dir);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const fromRepo = relative(repoRoot, receiptDir);
  if (fromRepo === '' || (!fromRepo.startsWith(`..${sep}`) && fromRepo !== '..' && !isAbsolute(fromRepo))) {
    throw new Error('Release journals must stay outside the public repository');
  }
  if (((await stat(receiptDir)).mode & 0o077) !== 0) throw new Error('Receipt directory must have mode 700');
  const lockPath = resolve(receiptDir, 'web-platform.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    await lock.writeFile(`${process.pid}\n`);
    const ctx = await context(options['--region'] ?? 'us-east-1', options['--stack'] ?? 'yvn-release-notes');
    if (command === 'prepare') {
      console.info(JSON.stringify(await prepare(ctx, receiptDir)));
    } else {
      for (const kind of ['App', 'Mcp'] as const) {
        if (command === 'policy-install') await installPolicy(ctx, kind, receiptDir);
        else if (command === 'policy-remove') await removePolicy(ctx, kind, receiptDir);
        else await verifyPolicy(ctx, kind, receiptDir);
      }
      if (command === 'policy-install') {
        for (const kind of ['App', 'Mcp'] as const) await verifyPolicy(ctx, kind, receiptDir);
      }
      console.info(
        JSON.stringify({ command, confirmed: true, NativeOriginPoliciesReady: command !== 'policy-remove' })
      );
    }
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // SDK error names, never response bodies/headers or credential chains.
    console.error(
      error instanceof Error && error.name === 'Error'
        ? error.message
        : error instanceof Error
          ? error.name
          : 'Release tool failed'
    );
    process.exitCode = 1;
  });
}
