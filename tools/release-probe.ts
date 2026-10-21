/** What a release checks once its stack update is done: each worker's `live`
 * alias is the version the stack published, and that version answers the
 * content-free self-test (workers/runtime.ts) with this build on Node 24
 * Arm64; each live endpoint serves an active revision of this build; and the
 * API answers its health check through CloudFront. Nothing here reads or
 * writes subscriber data. A failure leaves the release serving: the fix is a
 * revert, released like any other merge. */
import { LambdaClient, GetAliasCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetWebFunctionRevisionCommand } from '@aws-sdk/client-lambda-web';
import { region } from './release-identity.ts';
import { context, liveEndpoint, required, type Context } from './web-platform.ts';

export const workers = ['Sender', 'Inbound', 'Events', 'Transcribe', 'Describe', 'Export', 'Capture'] as const;

export type ProbeDeps = {
  ctx: Context;
  lambda: Pick<LambdaClient, 'send'>;
  fetch: (url: string) => Promise<Pick<Response, 'status' | 'json'>>;
  pause: (ms: number) => Promise<void>;
};

async function worker(deps: ProbeDeps, name: (typeof workers)[number], commit: string) {
  const { ctx, lambda } = deps;
  const alias = required(ctx.outputs, `${name}WorkerAlias`),
    version = required(ctx.outputs, `${name}LiveVersion`);
  if (
    !alias.startsWith(`arn:aws:lambda:${region}:${ctx.account}:function:${ctx.stackName}-`) ||
    !alias.endsWith(':live') ||
    !/^[1-9][0-9]*$/.test(version)
  )
    throw new Error(`${name}: unexpected worker identity`);
  const functionName = alias.slice(0, -':live'.length);
  const live = await lambda.send(new GetAliasCommand({ FunctionName: functionName, Name: 'live' }));
  if (live.FunctionVersion !== version || Object.keys(live.RoutingConfig?.AdditionalVersionWeights ?? {}).length)
    throw new Error(`${name}: live is not the version this release published`);
  const answer = await lambda.send(
    new InvokeCommand({
      FunctionName: functionName,
      Qualifier: version,
      InvocationType: 'RequestResponse',
      Payload: Buffer.from('{"self_test":true}')
    })
  );
  let result: { ok?: unknown; build?: unknown; runtime?: unknown } = {};
  try {
    result = JSON.parse(Buffer.from(answer.Payload ?? []).toString('utf8')) as typeof result;
  } catch {
    // An unreadable answer fails below.
  }
  if (
    answer.FunctionError ||
    answer.StatusCode !== 200 ||
    result.ok !== true ||
    result.build !== commit ||
    typeof result.runtime !== 'string' ||
    !/^Node 24\.[\d.]+\/linux\/arm64$/.test(result.runtime)
  )
    throw new Error(`${name}: the self-test failed`);
}

async function endpoint(deps: ProbeDeps, kind: 'App' | 'Mcp', commit: string) {
  const { ctx } = deps;
  const { functionName, revision } = await liveEndpoint(ctx, kind);
  if (revision !== required(ctx.outputs, `Native${kind}LiveRevisionId`))
    throw new Error(`${kind}: live is not the revision this release built`);
  const answer = await ctx.web.send(new GetWebFunctionRevisionCommand({ functionName, revisionId: revision }));
  if (answer.state !== 'Active' || answer.description !== commit)
    throw new Error(`${kind}: the live revision is not an active one of this build`);
}

async function health(deps: ProbeDeps) {
  const url = `https://${required(deps.ctx.parameters, 'WebDomain')}/api/health`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await deps.fetch(url);
      if (response.status === 200 && ((await response.json()) as { ok?: unknown }).ok === true) return;
    } catch {
      // A network error is retried like any other failed answer.
    }
    if (attempt === 5) throw new Error('The API health check failed through CloudFront');
    await deps.pause(3000);
  }
}

export async function probe(commit: string, given: Partial<ProbeDeps> = {}) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A committed build is required');
  const deps: ProbeDeps = {
    ctx: given.ctx ?? (await context()),
    lambda: given.lambda ?? new LambdaClient({ region, maxAttempts: 1 }),
    fetch: given.fetch ?? ((url) => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) })),
    pause: given.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  };
  for (const name of workers) await worker(deps, name, commit);
  for (const kind of ['App', 'Mcp'] as const) await endpoint(deps, kind, commit);
  await health(deps);
  return { workers: workers.length, endpoints: 2, health: 'ok' };
}
