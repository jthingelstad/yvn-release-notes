// The Release Notes web app: React on Vite, one app for every page. The
// build goes to dist/web, which deploy.sh syncs to the web bucket.
// `npm run dev` serves web/ with hot reload and hands the API, and the dev
// server's stand-ins for S3 and mail, to scripts/dev_server.py (start that
// first; RN_DEV_API moves it).
import react from '@vitejs/plugin-react';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { PAGES, titleOf } from './web/src/paths.ts';

const OUT = fileURLToPath(new URL('dist/web/', import.meta.url));

// The built index.html again in each page's folder (today/index.html),
// since the bucket is a static host: /today/ is that file, and the app
// takes it from there. Each copy carries its page's title and, past the
// front page, asks search engines to leave it out.
function pageFolders(): Plugin {
  return {
    name: 'page-folders',
    apply: 'build',
    closeBundle() {
      const html = readFileSync(OUT + 'index.html', 'utf8');
      for (const [path, title] of PAGES) {
        if (path === '/') continue;
        const description = /<meta\s+name="description"[^>]*>/;
        const titled = /<title>[^<]*<\/title>/;
        if (!description.test(html) || !titled.test(html)) throw new Error('index.html lost its title or description');
        const page = html
          .replace(description, '<meta name="robots" content="noindex" />')
          .replace(titled, `<title>${titleOf(title)}</title>`);
        mkdirSync(OUT + path.slice(1), { recursive: true });
        writeFileSync(OUT + path.slice(1) + 'index.html', page);
      }
    }
  };
}

const api = process.env.RN_DEV_API || 'http://localhost:8790';

export default defineConfig({
  root: 'web',
  plugins: [react(), pageFolders()],
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
