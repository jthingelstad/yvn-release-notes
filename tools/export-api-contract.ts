/** Export the public `/v1` API description (server/mcp/openapi.ts) to
 * contracts/api-surface.json. Beside it, api-versions.json records each
 * API_VERSION's digest: a changed surface under a version already recorded
 * is refused, since clients read `api_version` to know what they may call. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { openApi, surfaceDigest } from '../server/mcp/openapi.ts';
import { API_VERSION } from '../server/mcp/v1.ts';
const out = resolve(process.argv[2] ?? 'contracts/api-surface.json'),
  ledger = join(dirname(out), 'api-versions.json');
const versions = JSON.parse(await readFile(ledger, 'utf8').catch(() => '{}')) as Record<string, string>,
  digest = surfaceDigest();
if (versions[API_VERSION] && versions[API_VERSION] !== digest) {
  console.error(`The API changed under ${API_VERSION}: give API_VERSION a new version (server/mcp/v1.ts).`);
  process.exit(1);
}
versions[API_VERSION] = digest;
await writeFile(out, JSON.stringify(openApi(), null, 2) + '\n', 'utf8');
await writeFile(ledger, JSON.stringify(versions, null, 2) + '\n', 'utf8');
