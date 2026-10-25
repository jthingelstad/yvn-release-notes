/** Bundle the HTTP/worker entrypoints and the release tools (dist/release,
 * run by scripts/release.sh) from the committed tree; no runtime TS loader.
 * Sharp and Typst stay external (native, packaged by tools/package-native.ts);
 * the export worker gets the book's template and fonts beside its bundle. */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
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
  ['workers/entries/events.ts', 'dist/workers/events'],
  ['workers/transcribe.ts', 'dist/workers/transcribe'],
  ['workers/describe.ts', 'dist/workers/describe'],
  ['tools/release-cli.ts', 'dist/release']
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
    external: ['sharp', '@myriaddreamin/typst-ts-node-compiler'],
    legalComments: 'none',
    absWorkingDir: resolve('.'),
    banner: {
      js:
        "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" +
        // libheif (the book's HEIC decoder) is CommonJS and names its folder.
        (folder === 'dist/workers/export' ? ' const __dirname = import.meta.dirname;' : '')
    }
  });
}
await rm('dist/workers/export/assets', { recursive: true, force: true });
await cp('packages/book/assets', 'dist/workers/export/assets', { recursive: true });
