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
test('all seven production probes branch before private configuration and SDK effects', async () => {
  const run = promisify(execFile);
  const code = `
    import assert from 'node:assert/strict';
    import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
    import { S3Client } from '@aws-sdk/client-s3';
    import { SESv2Client } from '@aws-sdk/client-sesv2';
    import { SNSClient } from '@aws-sdk/client-sns';
    import { SQSClient } from '@aws-sdk/client-sqs';
    import { TranscribeClient } from '@aws-sdk/client-transcribe';
    import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
    import { GeoPlacesClient } from '@aws-sdk/client-geo-places';
    import { LambdaClient } from '@aws-sdk/client-lambda';
    const paths = ['entries/send','entries/inbound','entries/events','export','capture','transcribe','describe'];
    const entries = await Promise.all(paths.map(path => import('./workers/' + path + '.ts')));
    let effects = 0;
    for (const client of [DynamoDBClient,S3Client,SESv2Client,SNSClient,SQSClient,LambdaClient,TranscribeClient,SecretsManagerClient,GeoPlacesClient]) client.prototype.send = () => { effects++; throw new Error('Unexpected SDK effect'); };
    const original = process.env;
    const privateConfig = new Set(['AWS_REGION','TABLE','TABLE_NAME','BUCKET','MAIL_BUCKET','FROM_ADDRESS','CONFIG_SET','INBOUND_DOMAIN','ALARM_TOPIC','FAILED_QUEUE','WEB_ORIGIN','SELF','SECRET']);
    process.env = new Proxy({...original,APP_VERSION:'fictional-build'}, {get(target,key) { if(privateConfig.has(key)) throw new Error('Unexpected configuration read: ' + key); return Reflect.get(target,key); }});
    for (const entry of entries) {
      assert.ok(entry.handler.length <= 2, 'Node 24 rejects callback arity');
      const result = await entry.handler({self_test:true}, null);
      assert.deepEqual(result, {ok:true, runtime:'Node ' + process.versions.node + '/' + process.platform + '/' + process.arch, build:'fictional-build'});
    }
    assert.equal(effects,0);
    console.info('seven private-free probes passed');
  `;
  const result = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    timeout: 15000
  });
  assert.equal(result.stdout.trim(), 'seven private-free probes passed');
  assert.equal(result.stderr, '');
});
test('all seven actual worker bundles expose Node24 promise-only handlers and private-free probes', async () => {
  const run = promisify(execFile),
    cwd = fileURLToPath(new URL('../..', import.meta.url));
  await run(process.execPath, ['--import', 'tsx', 'tools/build-server.ts'], { cwd, timeout: 30000 });
  const code = `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import https from 'node:https';
    import net from 'node:net';
    let effects = 0;
    const blocked = () => { effects++; throw new Error('Unexpected network effect'); };
    http.request = blocked; https.request = blocked;
    net.Socket.prototype.connect = blocked; globalThis.fetch = blocked;
    const privateConfig = new Set(['AWS_REGION','TABLE','TABLE_NAME','BUCKET','MAIL_BUCKET','FROM_ADDRESS','CONFIG_SET','INBOUND_DOMAIN','ALARM_TOPIC','FAILED_QUEUE','WEB_ORIGIN','SELF','SECRET']);
    process.env = new Proxy({...process.env,APP_VERSION:'fictional-build'}, {get(target,key) { if(privateConfig.has(key)) throw new Error('Unexpected private configuration read: ' + key); return Reflect.get(target,key); }});
    for (const name of ['sender','inbound','events','export','capture','transcribe','describe']) {
      const entry = await import('./dist/workers/' + name + '/index.js');
      assert.ok(entry.handler.length <= 2, name + ' exposes callback handler arity');
      assert.equal(entry.handler.constructor.name,'AsyncFunction', name + ' requires a promise handler');
      const result = entry.handler({self_test:true}, {});
      assert.ok(result instanceof Promise);
      assert.deepEqual(await result, {ok:true,runtime:'Node ' + process.versions.node + '/' + process.platform + '/' + process.arch,build:'fictional-build'});
    }
    assert.equal(effects,0);
    console.info('seven bundled promise probes passed');
  `;
  const result = await run(process.execPath, ['--input-type=module', '-e', code], { cwd, timeout: 15000 });
  assert.equal(result.stdout.trim(), 'seven bundled promise probes passed');
  assert.equal(result.stderr, '');
});
