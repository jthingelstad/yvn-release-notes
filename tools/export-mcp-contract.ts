/** Export the public deterministic tool contract without AWS clients or secrets.
 * Beside it, mcp-versions.json records each server_version's tools digest:
 * changed tools under a version already recorded are refused, since clients
 * that cached that version's tools/list would never learn of the change. */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { MCP_CONTRACT, VERSION, toolsDigest } from '../server/mcp/contract.ts';
const out = resolve(process.argv[2] ?? 'contracts/mcp-surface.json'),
  ledger = join(dirname(out), 'mcp-versions.json');
const versions = JSON.parse(await readFile(ledger, 'utf8').catch(() => '{}')) as Record<string, string>,
  digest = toolsDigest();
if (versions[VERSION] && versions[VERSION] !== digest) {
  console.error(`The tools changed under server_version ${VERSION}: give it a new version and a changes entry.`);
  process.exit(1);
}
if (MCP_CONTRACT.changes[0]?.version !== VERSION) {
  console.error(`Add a changes entry for server_version ${VERSION}, newest first.`);
  process.exit(1);
}
versions[VERSION] = digest;
await writeFile(out, JSON.stringify(MCP_CONTRACT, null, 2) + '\n', 'utf8');
await writeFile(ledger, JSON.stringify(versions, null, 2) + '\n', 'utf8');
