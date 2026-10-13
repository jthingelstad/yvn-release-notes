/** Export the public deterministic tool contract without AWS clients or secrets. */
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MCP_CONTRACT } from '../server/mcp/contract.ts';
const out = resolve(process.argv[2] ?? 'contracts/mcp-surface.json');
await writeFile(out, JSON.stringify(MCP_CONTRACT, null, 2) + '\n', 'utf8');
