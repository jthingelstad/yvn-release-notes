/** Public documentation is part of the API: detect missing and stale routes,
 * frontend pages, tools and generated schemas without AWS or browser startup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { ROUTES } from '../../server/app/app.ts';
import { MCP_CONTRACT, TOOLS } from '../../server/mcp/contract.ts';
const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const web = await read('docs/WEB-APP.md'),
  mcp = await read('docs/MCP.md');
test('API table documents every method/path and has no stale route', () => {
  const rows: string[] = [];
  for (const match of web.matchAll(/^\| `([A-Z/]+) (\/api\/[^`?\s]*)/gm))
    for (const method of match[1]!.split('/')) rows.push(`${method} ${match[2]}`);
  assert.equal(new Set(rows).size, rows.length, 'API table contains duplicate routes');
  assert.deepEqual(rows.sort(), ROUTES.map(([method, path]) => `${method} ${path}`).sort());
});
test('every frontend route appears in the documented Pages list', async () => {
  const source = await read('web/src/main.tsx');
  const pages = ['/', ...Array.from(source.matchAll(/page\('(\/[a-z-]+)'/g), (match) => `${match[1]}/`)];
  assert.ok(pages.length > 10);
  const listed = web.split('- **Pages**', 2)[1]?.split('\n- ', 1)[0];
  assert.ok(listed, 'missing Pages section');
  for (const page of pages) assert.ok(listed.includes('`' + page), `page missing from documentation: ${page}`);
});
test('MCP documentation and generated JSON match the complete tool contract', async () => {
  const documented = Array.from(mcp.matchAll(/^\| `((?:notes|upcoming)_[a-z_]+)` \|/gm), (match) => match[1]);
  assert.equal(new Set(documented).size, documented.length, 'MCP table contains duplicate tools');
  assert.deepEqual(documented.sort(), TOOLS.map((tool) => tool.name).sort());
  assert.deepEqual(
    JSON.parse(await read('contracts/mcp-surface.json')),
    MCP_CONTRACT,
    'regenerate the MCP contract with tools/export-mcp-contract.ts'
  );
});
test('agent guide names every operator/build tool and retained script', async () => {
  const guide = await read('AGENTS.md'),
    listed = new Set<string>();
  for (const match of guide.matchAll(/`(tools|scripts)\/\{([^}]+)\}\.(ts|mjs)`/g))
    for (const name of match[2]!.split(',')) listed.add(`${match[1]}/${name.trim()}.${match[3]}`);
  for (const directory of ['tools', 'scripts']) {
    const files = await readdir(new URL(`../../${directory}/`, import.meta.url));
    for (const file of files.filter((name) => /\.(ts|mjs|sh)$/.test(name))) {
      const path = `${directory}/${file}`;
      assert.ok(guide.includes(path) || listed.has(path), `operator/script missing from guide: ${path}`);
    }
  }
});
test('Store design documents every persisted key prefix used by archive and MCP services', async () => {
  const source = await read('packages/backend/store.ts'),
    end = source.indexOf('*/');
  assert.ok(end > 0);
  const design = source.slice(0, end);
  const bodies = [
    source.slice(end + 2),
    ...(await Promise.all(['packages/backend/oauth.ts', 'server/mcp/reader.ts', 'workers/capture.ts'].map(read)))
  ];
  const prefixes = new Set(
    bodies.flatMap((body) => Array.from(body.matchAll(/\b([A-Z][A-Z0-9]+)#/g), (match) => `${match[1]}#`))
  );
  assert.ok(prefixes.size >= 30);
  for (const prefix of prefixes)
    assert.ok(design.includes(prefix), `table prefix missing from Store design: ${prefix}`);
});
test('version golden and generator use the canonical fixture path', async () => {
  const path = 'tests-node/fixtures/versions.json';
  assert.ok(JSON.parse(await read(path)));
  assert.ok((await read('scripts/gen-version-fixtures.mjs')).includes('../' + path));
  const domain = await read('tests-node/domain/domain.test.ts');
  const reference = /new URL\((['"])([^'"]*versions\.json)\1/.exec(domain);
  assert.ok(reference, 'missing independent version golden reference');
  assert.equal(
    new URL(reference[2]!, new URL('../../tests-node/domain/domain.test.ts', import.meta.url)).href,
    new URL('../../' + path, import.meta.url).href
  );
  assert.ok(!(await read('AGENTS.md')).includes('tests/fixtures/versions.json'));
});
test('GitHub verification uses the Node 24 application and the fictional browser harness', async () => {
  const validate = await read('.github/workflows/validate.yml'),
    e2e = await read('.github/workflows/e2e.yml');
  for (const workflow of [validate, e2e]) {
    assert.match(workflow, /node-version: "24"/);
    assert.match(workflow, /npm ci --ignore-scripts/);
    assert.doesNotMatch(workflow, /setup-python|PYTHONPATH|unittest/);
  }
  assert.match(validate, /run: npm run verify/);
  assert.match(validate, /pipx run --spec cfn-lint==[0-9.]+ cfn-lint infra\/template.yaml/);
  assert.match(e2e, /run: npm run e2e/);
  assert.match(await read('e2e/playwright.config.mjs'), /node --import tsx tools\/dev-server\.ts/);
  assert.match(await read('e2e/playwright.config.mjs'), /reuseExistingServer: false/);
});
test('Logs Insights queries in the agent guide read the structured fields under message', async () => {
  const guide = await read('AGENTS.md'),
    queries = Array.from(guide.matchAll(/`([^`\n]*\bfilter [^`\n]*)`/g), (match) => match[1]!);
  assert.ok(queries.some((query) => query.includes('message.event = "turnstile"')));
  for (const query of queries)
    for (const field of query.matchAll(/(?:filter|by|,)\s+([A-Za-z_@][\w.@]*)/g))
      assert.match(field[1]!, /^(message\.|@)|^count\(/, `bare log field in Logs Insights query: ${query}`);
});
