/** Bundle native HTTP/worker entrypoints from the committed tree; no runtime TS loader. */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) throw new Error('Build requires Node 24');
for (const [source, folder] of [
  ['server/app/index.ts', 'dist/server/app'],
  ['server/mcp/index.ts', 'dist/server/mcp'],
  ['workers/capture.ts', 'dist/workers/capture'],
  ['workers/export.ts', 'dist/workers/export'],
  ['workers/entries/send.ts', 'dist/workers/sender'],
  ['workers/entries/inbound.ts', 'dist/workers/inbound'],
  ['workers/entries/events.ts', 'dist/workers/events']
]) {
  await mkdir(folder!, { recursive: true });
  await build({
    entryPoints: [source!],
    outfile: `${folder}/index.js`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: false,
    external: ['sharp'],
    legalComments: 'none',
    absWorkingDir: resolve('.'),
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
    }
  });
}
