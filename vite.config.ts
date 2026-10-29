// The Release Notes web app: React on Vite, one app for every page. The
// build goes to dist/web, which deploy.sh syncs to the web bucket, where
// CloudFront answers / with front.html, the public pages (site/) with their
// own index.html, and every other address but a file with index.html. `npm run dev` serves web/ with hot reload and hands the
// API, and the dev server's stand-ins for S3 and mail, to
// tools/dev-server.ts (start that first; RN_DEV_API moves it).
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runnerImport, type Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const api = process.env.RN_DEV_API || 'http://localhost:8790';

// Which build this is, shown at the foot of Settings (web/src/lib/build.ts):
// the commit, which scripts/build-release.sh passes in (it builds from a git
// archive, with no .git), else the checkout's own, and when it was built.
function buildCommit(): string {
  if (process.env.RN_BUILD_COMMIT) return process.env.RN_BUILD_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}
const build = { commit: buildCommit(), at: new Date().toISOString() };

// After the build, front.html: the built index.html with the front page
// drawn in by the app's own components (web/src/prerender.tsx). Then the
// public pages, sitemap.xml and llms.txt, from site/ (web/src/site.tsx).
function frontPage(): Plugin {
  let root = '',
    outDir = '';
  return {
    name: 'release-notes-front-page',
    apply: 'build',
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const { module } = await runnerImport<typeof import('./web/src/prerender.tsx')>(
        resolve(root, 'src/prerender.tsx'),
        { configFile: false, root, logLevel: 'error' }
      );
      const index = await readFile(resolve(outDir, 'index.html'), 'utf8');
      await writeFile(resolve(outDir, 'front.html'), module.withFront(index));
      const site = await runnerImport<typeof import('./web/src/site.tsx')>(resolve(root, 'src/site.tsx'), {
        configFile: false,
        root,
        logLevel: 'error'
      });
      await site.module.writeSite(outDir, index);
    }
  };
}

export default defineConfig({
  root: 'web',
  plugins: [react(), frontPage()],
  define: { __BUILD__: JSON.stringify(build) },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    // Nothing inlined as a data: URI: the CSP's font-src is 'self' only.
    assetsInlineLimit: 0
  },
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/dev-upload', '/dev-media', '/dev-mail'].map((p) => [p, api]))
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.{ts,tsx}']
  }
});
