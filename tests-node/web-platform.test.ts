/** Fictional control-plane answers; no AWS calls or subscriber data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetResourcePolicyCommand,
  PutResourcePolicyCommand,
  GetWebFunctionEndpointCommand,
  type LambdaWebClient,
  type GetWebFunctionEndpointResponse
} from '@aws-sdk/client-lambda-web';
import { endpointPolicy, canonical, servedRevision, ensurePolicy, type Context } from '../tools/web-platform.ts';

const functionArn = 'arn:aws:lambda:us-east-1:123456789012:web-function/yvn-release-notes-web-native';
const endpointArn = `${functionArn}/endpoint/live`;
const distributionArn = 'arn:aws:cloudfront::123456789012:distribution/FICTIONAL';
const live = {
  functionArn,
  endpointArn,
  endpointName: 'live',
  endpointType: 'HomeRegion',
  domainName: 'fixture.invalid',
  authType: 'IamAuth',
  autoDeploymentMode: 'Disabled',
  revisionWeights: [{ revisionId: 'revision-fictional', weight: 100 }],
  regions: ['us-east-1'],
  regionalEndpoints: {},
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  state: 'Active',
  stateReason: '',
  updateStatus: 'Successful',
  throttleConfig: { rateLimit: 100 }
} satisfies GetWebFunctionEndpointResponse;

function fixture() {
  const state = { policy: undefined as string | undefined, writes: 0 };
  const missing = () => Object.assign(new Error('fictional'), { name: 'ResourceNotFoundException' });
  const web = {
    async send(command: unknown) {
      if (command instanceof GetWebFunctionEndpointCommand) {
        assert.equal(command.input.endpointName, 'live');
        return live;
      }
      if (command instanceof GetResourcePolicyCommand) {
        assert.equal(command.input.resourceArn, functionArn);
        if (!state.policy) throw missing();
        return { policy: state.policy, revisionId: 'policy-1' };
      }
      if (command instanceof PutResourcePolicyCommand) {
        assert.equal(command.input.resourceArn, functionArn);
        assert.equal(command.input.revisionId, undefined);
        state.policy = command.input.policy;
        state.writes++;
        return { policy: state.policy, revisionId: 'policy-1' };
      }
      throw new Error('Unreviewed API request');
    }
  };
  const ctx: Context = {
    account: '123456789012',
    stackName: 'yvn-release-notes',
    distributionArn,
    outputs: {
      NativeAppFunctionName: 'yvn-release-notes-web-native',
      NativeAppFunctionArn: functionArn,
      NativeAppLiveEndpointArn: endpointArn,
      NativeAppLiveEndpointDomain: 'fixture.invalid'
    },
    parameters: {},
    web: web as unknown as LambdaWebClient
  };
  return { state, ctx };
}

test('the grant is limited to one distribution and one live endpoint', () => {
  const policy = endpointPolicy(endpointArn, distributionArn);
  assert.equal(policy.Statement.length, 1);
  assert.deepEqual(policy.Statement[0]?.Principal, { Service: 'cloudfront.amazonaws.com' });
  assert.equal(policy.Statement[0]?.Action, 'lambda:InvokeWebFunctionEndpoint');
  assert.equal(policy.Statement[0]?.Resource, endpointArn);
  assert.deepEqual(policy.Statement[0]?.Condition, { StringEquals: { 'aws:SourceArn': distributionArn } });
  const reordered = JSON.parse(JSON.stringify(policy)) as Record<string, unknown>;
  assert.equal(canonical({ Statement: reordered.Statement, Version: reordered.Version }), canonical(policy));
});

test('a live endpoint serves one revision, privately, from its home region', () => {
  assert.equal(servedRevision(live), 'revision-fictional');
  for (const invalid of [
    { authType: 'ApplicationManaged' as const },
    { endpointType: 'Global' as const },
    { autoDeploymentMode: 'LatestRevision' as const },
    { state: 'Failed' as const },
    { updateStatus: 'InProgress' as const },
    { throttleConfig: { rateLimit: 0 } },
    {
      revisionWeights: [
        { revisionId: 'a', weight: 90 },
        { revisionId: 'b', weight: 10 }
      ]
    }
  ])
    assert.throws(() => servedRevision({ ...live, ...invalid } as GetWebFunctionEndpointResponse));
});

test('a missing grant is installed and read back; a present one is confirmed without a write', async () => {
  const { ctx, state } = fixture();
  assert.equal(await ensurePolicy(ctx, 'App'), 'installed');
  assert.equal(state.writes, 1);
  assert.equal(await ensurePolicy(ctx, 'App'), 'confirmed');
  assert.equal(state.writes, 1);
});

test('a grant that differs is never rewritten', async () => {
  const { ctx, state } = fixture();
  const wider = endpointPolicy(`${functionArn}/endpoint/*`, distributionArn);
  state.policy = JSON.stringify(wider);
  await assert.rejects(ensurePolicy(ctx, 'App'), /differs/);
  assert.equal(state.writes, 0);
  assert.equal(state.policy, JSON.stringify(wider));
});

test("an endpoint that is not the stack's own is refused before any policy call", async () => {
  const { ctx, state } = fixture();
  ctx.outputs.NativeAppLiveEndpointArn = `${functionArn}/endpoint/other`;
  await assert.rejects(ensurePolicy(ctx, 'App'), /differs from the stack/);
  ctx.outputs.NativeAppFunctionName = 'someone-else-web-native';
  await assert.rejects(ensurePolicy(ctx, 'App'), /Unexpected web function/);
  assert.equal(state.writes, 0);
});

test('no release step removes a policy: CloudFront reaches the functions only through these grants', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../tools/web-platform.ts', import.meta.url), 'utf8')
  );
  assert.doesNotMatch(source, /DeleteResourcePolicy/);
});
