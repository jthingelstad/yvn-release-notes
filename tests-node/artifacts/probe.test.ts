/** The release probe against fictional control-plane answers: no AWS calls,
 * no subscriber data, and only the content-free self-test is ever invoked. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GetAliasCommand, InvokeCommand, type LambdaClient } from '@aws-sdk/client-lambda';
import {
  GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand,
  type LambdaWebClient
} from '@aws-sdk/client-lambda-web';
import { probe, workers, type ProbeDeps } from '../../tools/release-probe.ts';
import type { Context } from '../../tools/web-platform.ts';

const commit = 'c'.repeat(40);
const account = '123456789012';
const base = `arn:aws:lambda:us-east-1:${account}`;

function fixture() {
  const world = {
    aliasVersion: '7' as string,
    canary: false,
    selfTest: { ok: true, build: commit, runtime: 'Node 24.11.0/linux/arm64' } as Record<string, unknown>,
    functionError: false,
    served: 'rev-app',
    revisionState: 'Active',
    revisionBuild: commit,
    health: [500, 200] as number[],
    invoked: [] as { name: string; qualifier?: string; payload: string }[],
    fetched: 0,
    pauses: 0
  };
  const outputs: Record<string, string> = {};
  for (const name of workers) {
    outputs[`${name}WorkerAlias`] = `${base}:function:yvn-release-notes-${name.toLowerCase()}:live`;
    outputs[`${name}LiveVersion`] = '7';
  }
  for (const [kind, fn] of [
    ['App', 'web'],
    ['Mcp', 'mcp']
  ] as const) {
    const functionArn = `${base}:web-function/yvn-release-notes-${fn}-native`;
    Object.assign(outputs, {
      [`Native${kind}FunctionName`]: `yvn-release-notes-${fn}-native`,
      [`Native${kind}FunctionArn`]: functionArn,
      [`Native${kind}LiveEndpointArn`]: `${functionArn}/endpoint/live`,
      [`Native${kind}LiveEndpointDomain`]: `${fn}.fixture.invalid`,
      [`Native${kind}LiveRevisionId`]: `rev-${kind.toLowerCase()}`
    });
  }
  const web = {
    async send(command: unknown) {
      if (command instanceof GetWebFunctionEndpointCommand) {
        const kind = command.input.functionName!.includes('-web-') ? 'App' : 'Mcp';
        return {
          functionArn: outputs[`Native${kind}FunctionArn`],
          endpointArn: outputs[`Native${kind}LiveEndpointArn`],
          endpointName: 'live',
          endpointType: 'HomeRegion',
          domainName: outputs[`Native${kind}LiveEndpointDomain`],
          authType: 'IamAuth',
          autoDeploymentMode: 'Disabled',
          revisionWeights: [{ revisionId: kind === 'App' ? world.served : 'rev-mcp', weight: 100 }],
          state: 'Active',
          updateStatus: 'Successful',
          throttleConfig: { rateLimit: 100 }
        };
      }
      if (command instanceof GetWebFunctionRevisionCommand)
        return { state: world.revisionState, description: world.revisionBuild };
      throw new Error('Unreviewed API request');
    }
  };
  const lambda = {
    async send(command: unknown) {
      if (command instanceof GetAliasCommand) {
        assert.equal(command.input.Name, 'live');
        return {
          FunctionVersion: world.aliasVersion,
          ...(world.canary ? { RoutingConfig: { AdditionalVersionWeights: { '6': 0.1 } } } : {})
        };
      }
      if (command instanceof InvokeCommand) {
        world.invoked.push({
          name: command.input.FunctionName!,
          qualifier: command.input.Qualifier,
          payload: Buffer.from(command.input.Payload as Uint8Array).toString('utf8')
        });
        return {
          StatusCode: 200,
          ...(world.functionError ? { FunctionError: 'Unhandled' } : {}),
          Payload: Buffer.from(JSON.stringify(world.selfTest))
        };
      }
      throw new Error('Unreviewed API request');
    }
  };
  const ctx: Context = {
    account,
    stackName: 'yvn-release-notes',
    distributionArn: `arn:aws:cloudfront::${account}:distribution/FICTIONAL`,
    outputs,
    parameters: { WebDomain: 'notes.fixture.invalid' },
    web: web as unknown as LambdaWebClient
  };
  const deps: ProbeDeps = {
    ctx,
    lambda: lambda as unknown as LambdaClient,
    fetch: async (url) => {
      assert.equal(url, 'https://notes.fixture.invalid/api/health');
      world.fetched++;
      const status = world.health.shift() ?? 200;
      return { status, json: async () => ({ ok: status === 200 }) };
    },
    pause: async () => {
      world.pauses++;
    }
  };
  return { world, deps, outputs };
}

test('a finished release passes: every worker self-tests on its live version, both endpoints serve this build', async () => {
  const { world, deps } = fixture();
  assert.deepEqual(await probe(commit, deps), { workers: 7, endpoints: 2, health: 'ok' });
  assert.equal(world.invoked.length, 7);
  for (const call of world.invoked) {
    assert.equal(call.qualifier, '7');
    assert.equal(call.payload, '{"self_test":true}');
    assert.match(call.name, /:function:yvn-release-notes-[a-z]+$/);
  }
  // The health check is retried while CloudFront catches up.
  assert.equal(world.fetched, 2);
  assert.equal(world.pauses, 1);
});

test('any part that is not this build fails the probe', async () => {
  const cases: [string, (world: ReturnType<typeof fixture>['world']) => void, RegExp][] = [
    ['alias elsewhere', (w) => (w.aliasVersion = '6'), /live is not the version/],
    ['alias split', (w) => (w.canary = true), /live is not the version/],
    ['older build', (w) => (w.selfTest = { ...w.selfTest, build: 'd'.repeat(40) }), /self-test failed/],
    ['other runtime', (w) => (w.selfTest = { ...w.selfTest, runtime: 'Node 22.1.0/linux/arm64' }), /self-test/],
    ['x86', (w) => (w.selfTest = { ...w.selfTest, runtime: 'Node 24.11.0/linux/x64' }), /self-test failed/],
    ['handler error', (w) => (w.functionError = true), /self-test failed/],
    ['endpoint elsewhere', (w) => (w.served = 'rev-old'), /not the revision this release built/],
    ['revision failed', (w) => (w.revisionState = 'Failed'), /not an active one of this build/],
    ['revision of another build', (w) => (w.revisionBuild = 'd'.repeat(40)), /not an active one/],
    ['site down', (w) => (w.health = [503, 503, 503, 503, 503]), /health check failed/]
  ];
  for (const [name, change, error] of cases) {
    const { world, deps } = fixture();
    change(world);
    await assert.rejects(probe(commit, deps), error, name);
  }
});

test("a worker that is not this stack's is refused before any invocation", async () => {
  const { world, deps, outputs } = fixture();
  outputs.SenderWorkerAlias = `arn:aws:lambda:us-east-1:${account}:function:someone-else:live`;
  await assert.rejects(probe(commit, deps), /unexpected worker identity/);
  outputs.SenderWorkerAlias = `${base}:function:yvn-release-notes-sender:live`;
  outputs.SenderLiveVersion = '$LATEST';
  await assert.rejects(probe(commit, deps), /unexpected worker identity/);
  assert.equal(world.invoked.length, 0);
  await assert.rejects(probe('not-a-commit', deps), /committed build/);
});
