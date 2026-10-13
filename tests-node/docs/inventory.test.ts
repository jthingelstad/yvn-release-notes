/** Public documentation is part of the API: detect missing and stale routes,
 * frontend pages, tools and generated schemas without AWS or browser startup. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ROUTES } from '../../server/app/app.ts';
import { MCP_CONTRACT, TOOLS } from '../../server/mcp/contract.ts';
const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const web = await read('docs/WEB-APP.md'),
  mcp = await read('docs/MCP.md');
test('native API table documents every method/path and has no stale route', () => {
  const rows: string[] = [];
  for (const match of web.matchAll(/^\| `([A-Z/]+) (\/api\/[^`?\s]*)/gm))
    for (const method of match[1]!.split('/')) rows.push(`${method} ${match[2]}`);
  assert.equal(new Set(rows).size, rows.length, 'API table contains duplicate routes');
  assert.deepEqual(rows.sort(), ROUTES.map(([method, path]) => `${method} ${path}`).sort());
});
test('every native frontend route appears in the documented Pages list', async () => {
  const source = await read('web/src/main.tsx');
  const pages = ['/', ...Array.from(source.matchAll(/page\('(\/[a-z-]+)'/g), (match) => `${match[1]}/`)];
  assert.ok(pages.length > 10);
  const listed = web.split('- **Pages**', 2)[1]?.split('\n- ', 1)[0];
  assert.ok(listed, 'missing Pages section');
  for (const page of pages) assert.ok(listed.includes('`' + page), `page missing from documentation: ${page}`);
});
test('MCP documentation and generated JSON match the complete native tool contract', async () => {
  const documented = Array.from(mcp.matchAll(/^\| `(notes_[a-z_]+)` \|/gm), (match) => match[1]);
  assert.equal(new Set(documented).size, documented.length, 'MCP table contains duplicate tools');
  assert.deepEqual(documented.sort(), TOOLS.map((tool) => tool.name).sort());
  assert.deepEqual(
    JSON.parse(await read('contracts/mcp-surface.json')),
    MCP_CONTRACT,
    'regenerate the MCP contract with tools/export-mcp-contract.ts'
  );
});
