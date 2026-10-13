import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runtimeSelfTest } from '../../workers/runtime.ts';

test('runtime probes require exactly self_test true and report only build/runtime', () => {
  for (const value of [
    null,
    undefined,
    [],
    true,
    {},
    { self_test: false },
    { self_test: 1 },
    { self_test: true, user_id: 'fictional' },
    { self_test: true, Records: [] }
  ])
    assert.equal(runtimeSelfTest(value), null);
  const result = runtimeSelfTest({ self_test: true });
  assert.deepEqual(Object.keys(result!).sort(), ['build', 'ok', 'runtime']);
  assert.equal(result!.ok, true);
  assert.equal(result!.runtime, `Node ${process.versions.node}/${process.platform}/${process.arch}`);
  assert.equal(result!.build, process.env.APP_VERSION ?? 'unknown');
});
test('all five mail/export/capture production probes branch before private configuration and SDK effects', async () => {
  const run = promisify(execFile);
  const code = `
    import assert from 'node:assert/strict';
    import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
    import { S3Client } from '@aws-sdk/client-s3';
    import { SESv2Client } from '@aws-sdk/client-sesv2';
    import { SNSClient } from '@aws-sdk/client-sns';
    import { LambdaClient } from '@aws-sdk/client-lambda';
    const paths = ['entries/send','entries/inbound','entries/events','export','capture'];
    const entries = await Promise.all(paths.map(path => import('./workers/' + path + '.ts')));
    let effects = 0;
    for (const client of [DynamoDBClient,S3Client,SESv2Client,SNSClient,LambdaClient]) client.prototype.send = () => { effects++; throw new Error('Unexpected SDK effect'); };
    const original = process.env;
    const privateConfig = new Set(['AWS_REGION','TABLE','TABLE_NAME','BUCKET','MAIL_BUCKET','FROM_ADDRESS','CONFIG_SET','INBOUND_DOMAIN','ALARM_TOPIC','WEB_ORIGIN']);
    process.env = new Proxy({...original,APP_VERSION:'fictional-build'}, {get(target,key) { if(privateConfig.has(key)) throw new Error('Unexpected configuration read: ' + key); return Reflect.get(target,key); }});
    for (const entry of entries) {
      const result = await entry.handler({self_test:true}, null);
      assert.deepEqual(result, {ok:true, runtime:'Node ' + process.versions.node + '/' + process.platform + '/' + process.arch, build:'fictional-build'});
    }
    assert.equal(effects,0);
    console.info('five private-free probes passed');
  `;
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    timeout: 15000
  });
  assert.equal(result.stdout.trim(), 'five private-free probes passed');
  assert.equal(result.stderr, '');
});
