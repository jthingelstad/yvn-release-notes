/** Fictional control-plane receipts; no AWS calls or subscriber data. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GetResourcePolicyCommand,
  PutResourcePolicyCommand,
  GetWebFunctionEndpointCommand,
  type LambdaWebClient,
  type GetWebFunctionEndpointResponse
} from '@aws-sdk/client-lambda-web';
import {
  endpointPolicy,
  pinnedRevision,
  policyHash,
  installPolicy,
  verifyPolicy,
  platformCommands,
  type Context
} from '../tools/web-platform.ts';
import { MemoryReceiptStore, readReceipt } from '../tools/receipt-store.ts';

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
  const state = {
    policy: undefined as string | undefined,
    revisionId: 'policy-1',
    writes: 0,
    losePutResponse: false
  };
  const missing = () => Object.assign(new Error('fictional'), { name: 'ResourceNotFoundException' });
  const web = {
    async send(command: unknown) {
      if (command instanceof GetWebFunctionEndpointCommand) {
        return command.input.endpointName === 'live'
          ? live
          : {
              ...live,
              endpointName: 'rollback',
              endpointArn: `${functionArn}/endpoint/rollback`,
              throttleConfig: { rateLimit: 0 }
            };
      }
      if (command instanceof GetResourcePolicyCommand) {
        assert.equal(command.input.resourceArn, functionArn);
        if (!state.policy) throw missing();
        return { policy: state.policy, revisionId: state.revisionId };
      }
      if (command instanceof PutResourcePolicyCommand) {
        assert.equal(command.input.resourceArn, functionArn);
        if (state.policy) assert.equal(command.input.revisionId, state.revisionId);
        else assert.equal(command.input.revisionId, undefined);
        state.policy = command.input.policy;
        state.writes++;
        state.revisionId = `policy-${state.writes}`;
        if (state.losePutResponse) throw Object.assign(new Error('fictional'), { name: 'TimeoutError' });
        return { policy: state.policy, revisionId: state.revisionId };
      }
      throw new Error('Unreviewed API request');
    }
  };
  const ctx: Context = {
    stackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/yvn-release-notes/fictional',
    stackName: 'yvn-release-notes',
    distributionArn,
    outputs: {
      NativeAppFunctionName: 'yvn-release-notes-web-native',
      NativeAppFunctionArn: functionArn,
      NativeAppLiveEndpointArn: endpointArn,
      NativeAppLiveEndpointDomain: 'fixture.invalid'
    },
    parameters: {
      NativeAppCodeKey: `native/app/${'0'.repeat(64)}.zip`,
      NativeAppCodeVersion: 'fictional-object-version',
      NativeAppBuildId: '0'.repeat(40)
    },
    web: web as unknown as LambdaWebClient
  };
  return { state, ctx };
}

async function withReceipt(run: (store: MemoryReceiptStore) => Promise<void>) {
  await run(new MemoryReceiptStore());
}
const journal = async (store: MemoryReceiptStore) =>
  (await readReceipt<{ state: string; revisionId: string }>(store, 'app-policy.json'))!;

test('exact grant is limited to one distribution and one live endpoint', () => {
  const policy = endpointPolicy(endpointArn, distributionArn);
  assert.equal(policy.Statement.length, 1);
  assert.deepEqual(policy.Statement[0]?.Principal, { Service: 'cloudfront.amazonaws.com' });
  assert.equal(policy.Statement[0]?.Action, 'lambda:InvokeWebFunctionEndpoint');
  assert.equal(policy.Statement[0]?.Resource, endpointArn);
  assert.deepEqual(policy.Statement[0]?.Condition, { StringEquals: { 'aws:SourceArn': distributionArn } });
  assert.equal(policyHash(policy), policyHash(JSON.parse(JSON.stringify(policy))));
});

test('release pin refuses public/latest/in-progress/canary endpoints', () => {
  assert.equal(pinnedRevision(live), 'revision-fictional');
  for (const invalid of [
    { authType: 'ApplicationManaged' as const },
    { autoDeploymentMode: 'LatestRevision' as const },
    { state: 'Failed' as const },
    { updateStatus: 'InProgress' as const },
    {
      revisionWeights: [
        { revisionId: 'a', weight: 90 },
        { revisionId: 'b', weight: 10 }
      ]
    }
  ])
    assert.throws(() => pinnedRevision({ ...live, ...invalid }));
});

test('install readback, no-op repeat and verify lifecycle', async () => {
  await withReceipt(async (store) => {
    const { ctx, state } = fixture();
    await installPolicy(ctx, 'App', store);
    const installed = await journal(store);
    assert.equal(installed.state, 'installed');
    assert.equal(installed.revisionId, state.revisionId);
    await installPolicy(ctx, 'App', store);
    assert.equal(state.writes, 1);
    await verifyPolicy(ctx, 'App', store);
    assert.equal((await journal(store)).state, 'installed');
  });
});

test('no platform step removes a policy: CloudFront reaches the functions only through these grants', () => {
  assert.deepEqual([...platformCommands], ['prepare', 'policy-install', 'policy-verify']);
});

test('existing unowned or concurrently changed policy is never overwritten', async () => {
  await withReceipt(async (store) => {
    const { ctx, state } = fixture();
    state.policy = JSON.stringify(endpointPolicy(endpointArn, distributionArn));
    await assert.rejects(installPolicy(ctx, 'App', store), /no active owner journal/);
    state.policy = undefined;
    await installPolicy(ctx, 'App', store);
    state.revisionId = 'concurrent-revision';
    await assert.rejects(installPolicy(ctx, 'App', store), /CAS revision changed/);
    await assert.rejects(verifyPolicy(ctx, 'App', store), /CAS revision changed/);
    assert.equal(state.writes, 1);
  });
});

test('unknown Put outcome is recovered from saved intent and exact readback without another Put', async () => {
  await withReceipt(async (store) => {
    const { ctx, state } = fixture();
    state.losePutResponse = true;
    await assert.rejects(installPolicy(ctx, 'App', store));
    assert.equal((await journal(store)).state, 'pending');
    await installPolicy(ctx, 'App', store);
    assert.equal(state.writes, 1);
    await verifyPolicy(ctx, 'App', store);
  });
});
