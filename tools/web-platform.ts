/** Sole owner of native HTTP endpoint policies and release pin receipts.
 * Runs through tools/release-cli.ts, under the deploy lock, with its policy
 * journals and receipts in the private receipts bucket (tools/receipt-store.ts).
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
import { createHash, randomUUID } from 'node:crypto';
import { createReceipt, readReceipt, writeReceipt, type ReceiptStore } from './receipt-store.ts';
import { releaseIdentity } from './release-identity.ts';

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
  const identity = { Account: (await releaseIdentity()).account };
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

const journalName = (kind: Kind) => `${kind.toLowerCase()}-policy.json`;

async function journalAt(store: ReceiptStore, kind: Kind): Promise<Journal | undefined> {
  const journal = await readReceipt<Journal>(store, journalName(kind));
  if (journal && (journal.schema !== 1 || journal.owner !== 'yvn-web-platform-v1')) {
    throw new Error('Unrecognized policy journal');
  }
  return journal;
}

function checkJournal(ctx: Context, functionArn: string, endpointArn: string, journal: Journal): void {
  if (journal.stackId !== ctx.stackId || journal.functionArn !== functionArn || journal.endpointArn !== endpointArn) {
    throw new Error('Journal belongs to different stack or resources');
  }
}

export async function installPolicy(ctx: Context, kind: Kind, store: ReceiptStore): Promise<void> {
  const live = await endpoint(ctx, kind, 'live');
  const functionArn = live.functionArn!;
  const endpointArn = live.endpointArn!;
  const save = (value: Journal) => writeReceipt(store, journalName(kind), value);
  let journal = await journalAt(store, kind);
  const actual = await currentPolicy(ctx, functionArn);
  const desired = endpointPolicy(endpointArn, ctx.distributionArn);
  if (journal) checkJournal(ctx, functionArn, endpointArn, journal);
  if (actual) {
    if (!journal || journal.state === 'deleted') throw new Error('Existing policy has no active owner journal');
    assertOwnedPolicy(journal, actual.policy, actual.revisionId);
    // Recover a prior unknown Put outcome only if its full desired policy matches.
    if (policyHash(desired) === policyHash(JSON.parse(actual.policy))) {
      journal = { ...journal, revisionId: actual.revisionId, state: 'installed', savedAt: new Date().toISOString() };
      await save(journal);
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
  // token in this API; the sole owner, fresh private endpoint and deploy lock
  // bound that first write. Every subsequent mutation uses its returned token.
  await save(journal);
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
  await save({ ...journal, state: 'installed', revisionId: installed.revisionId });
}

export async function verifyPolicy(ctx: Context, kind: Kind, store: ReceiptStore): Promise<void> {
  const live = await endpoint(ctx, kind, 'live');
  await endpoint(ctx, kind, 'rollback');
  const journal = await journalAt(store, kind);
  if (!journal || journal.state !== 'installed') throw new Error('No installed owner journal');
  checkJournal(ctx, live.functionArn!, live.endpointArn!, journal);
  const actual = await currentPolicy(ctx, live.functionArn!);
  if (!actual) throw new Error('Endpoint resource policy is missing');
  assertOwnedPolicy(journal, actual.policy, actual.revisionId);
  if (policyHash(journal.policy) !== policyHash(endpointPolicy(live.endpointArn!, ctx.distributionArn))) {
    throw new Error('Policy differs from the exact distribution/live-endpoint grant');
  }
}

export async function removePolicy(ctx: Context, kind: Kind, store: ReceiptStore): Promise<void> {
  if (ctx.parameters.NativeHttpRouting !== 'legacy') {
    throw new Error('Restore legacy CloudFront routing before removing endpoint policies');
  }
  const live = await endpoint(ctx, kind, 'live', false);
  const save = (value: Journal) => writeReceipt(store, journalName(kind), value);
  const journal = await journalAt(store, kind);
  if (!journal) throw new Error('No owner journal; refusing policy removal');
  checkJournal(ctx, live.functionArn!, live.endpointArn!, journal);
  const actual = await currentPolicy(ctx, live.functionArn!);
  if (!actual) {
    if (!['removing', 'deleted'].includes(journal.state)) throw new Error('Policy disappeared unexpectedly');
    await save({ ...journal, state: 'deleted' });
    return;
  }
  if (!['installed', 'removing'].includes(journal.state)) throw new Error('Policy must have a confirmed owner');
  assertOwnedPolicy(journal, actual.policy, actual.revisionId);
  await save({ ...journal, state: 'removing' });
  await ctx.web.send(
    new DeleteResourcePolicyCommand({ resourceArn: live.functionArn!, revisionId: actual.revisionId })
  );
  if (await currentPolicy(ctx, live.functionArn!)) throw new Error('Policy deletion was not confirmed');
  await save({ ...journal, state: 'deleted' });
}

async function prepare(ctx: Context, store: ReceiptStore) {
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
  required(ctx.outputs, 'NativeSourceBucketName');
  await createReceipt(store, `release-${randomUUID()}.json`, { ...receipt, pins });
  return pins;
}

export type PlatformCommand = 'prepare' | 'policy-install' | 'policy-verify' | 'policy-remove';
export const platformCommands: readonly PlatformCommand[] = [
  'prepare',
  'policy-install',
  'policy-verify',
  'policy-remove'
];

/** One platform step against the live stack; the caller holds the deploy lock. */
export async function runPlatform(
  command: PlatformCommand,
  store: ReceiptStore
): Promise<{ pins: Record<string, string>; confirmed?: boolean }> {
  const ctx = await context('us-east-1', 'yvn-release-notes');
  if (command === 'prepare') return { pins: await prepare(ctx, store) };
  for (const kind of ['App', 'Mcp'] as const) {
    if (command === 'policy-install') await installPolicy(ctx, kind, store);
    else if (command === 'policy-remove') await removePolicy(ctx, kind, store);
    else await verifyPolicy(ctx, kind, store);
  }
  if (command === 'policy-install') {
    for (const kind of ['App', 'Mcp'] as const) await verifyPolicy(ctx, kind, store);
  }
  return { pins: {}, confirmed: true };
}
