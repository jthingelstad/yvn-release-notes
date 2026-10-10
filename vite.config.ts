// The Release Notes web app: React on Vite, one app for every page. The
// build goes to dist/web, which deploy.sh syncs to the web bucket, where
// CloudFront answers every address but a file with its index.html.
// `npm run dev` serves web/ with hot reload and hands the API, and the dev
// server's stand-ins for S3 and mail, to scripts/dev_server.py (start that
// first; RN_DEV_API moves it).
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = process.env.RN_DEV_API || 'http://localhost:8790';

export default defineConfig({
  root: 'web',
  plugins: [react()],
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
