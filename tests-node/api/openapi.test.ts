/** The `/v1` API's own description (server/mcp/openapi.ts): it names every
 * route and error code the API has and nothing else, it is what the
 * contract keeps, its version is recorded, and anyone may read it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMcpApp } from '../../server/mcp/app.ts';
import { openApi, surfaceDigest } from '../../server/mcp/openapi.ts';
import { API_CHANGES, API_VERSION, V1_ERRORS, V1_ROUTES } from '../../server/mcp/v1.ts';

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const doc = openApi() as Doc;

test('every /v1 route is one operation with its scope, plus the description itself, and nothing else', () => {
  const operations = Object.entries(doc.paths as Doc).flatMap(([path, methods]) =>
    Object.entries(methods as Doc).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op: op as Doc }))
  );
  assert.deepEqual(
    operations.map((o) => o.key).sort(),
    [...V1_ROUTES.map((r) => `${r.method} ${r.template}`), 'GET /v1/openapi.json'].sort()
  );
  const ids = operations.map((o) => o.op.operationId);
  assert.equal(new Set(ids).size, ids.length);
  for (const route of V1_ROUTES) {
    const op = doc.paths[route.template][route.method.toLowerCase()] as Doc;
    assert.deepEqual(op.security, [{ token: route.scope ? [route.scope] : [] }], route.name);
    assert.ok(op.summary, route.name);
    assert.ok(op.responses.default, route.name);
    // Every write takes an Idempotency-Key.
    assert.equal(
      (op.parameters ?? []).some((p: Doc) => p.$ref === '#/components/parameters/Idempotency-Key'),
      route.method !== 'GET',
      route.name
    );
  }
  assert.deepEqual(doc.paths['/v1/openapi.json'].get.security, []);
});

test('its error codes are the API’s, and its version is the API’s, with what each one changed', () => {
  assert.deepEqual(doc.components.schemas.Error.properties.error.properties.code.enum, Object.keys(V1_ERRORS));
  assert.equal(doc.info.version, API_VERSION);
  // Each version says what it changed, newest first.
  assert.equal(API_CHANGES[0]!.version, API_VERSION);
  assert.equal(new Set(API_CHANGES.map((c) => c.version)).size, API_CHANGES.length);
  assert.deepEqual(doc.info['x-changes'], API_CHANGES);
});

test('contracts/api-surface.json is the description, and api-versions.json records this version', async () => {
  assert.deepEqual(
    JSON.parse(await readFile('contracts/api-surface.json', 'utf8')),
    doc,
    'regenerate it with node --import tsx tools/export-api-contract.ts'
  );
  const versions = JSON.parse(await readFile('contracts/api-versions.json', 'utf8')) as Record<string, string>;
  assert.equal(versions[API_VERSION], surfaceDigest(), 'the API changed: give API_VERSION a new version');
});

test('GET /v1/openapi.json answers anyone, reading nothing', async () => {
  const app = createMcpApp({
    context: () => {
      throw new Error('no context is read');
    },
    capture: async () => {
      throw new Error('nothing is written');
    }
  });
  const r = await app.request('https://notes.example.com/v1/openapi.json');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') ?? '', /^application\/json/);
  assert.equal(r.headers.get('api-version'), API_VERSION);
  assert.deepEqual(await r.json(), doc);
  // Any other method is the API's own refusal, and needs a context.
  assert.equal((await app.request('https://notes.example.com/v1/openapi.json', { method: 'POST' })).status, 503);
});
