import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../../server/app/app.ts';
import { httpEndpoint } from '../../server/shared/listen.ts';

test('native endpoint handles IPv4/IPv6 and rejects malformed bind configuration', () => {
  assert.deepEqual(httpEndpoint('127.0.0.1:3000'), { hostname: '127.0.0.1', port: 3000 });
  assert.deepEqual(httpEndpoint('[::1]:3000'), { hostname: '::1', port: 3000 });
  assert.throws(() => httpEndpoint('127.0.0.1:0'));
  assert.throws(() => httpEndpoint('host:3000:3001'));
});
test('native health and unmatched paths are content-free and uncacheable', async () => {
  const app = createApp();
  const health = await app.request('/api/health');
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(health.headers.get('Cache-Control'), 'no-store');
  const missing = await app.request('/private-note-text?q=token');
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'not-found' });
});
