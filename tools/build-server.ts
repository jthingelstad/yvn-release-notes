/** Bundle native HTTP/worker entrypoints from the committed tree; no runtime TS loader. */
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const major = Number(process.versions.node.split('.')[0]);
if (major !== 24) throw new Error('Build requires Node 24');
await mkdir('dist/server/app', { recursive: true });
await build({
  entryPoints: ['server/app/index.ts'],
  outfile: 'dist/server/app/index.js',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  absWorkingDir: resolve('.'),
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);"
  }
});
