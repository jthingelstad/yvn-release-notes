/** Native HTTP application foundation. Production routes are enabled only after parity gates. */
import { Hono } from 'hono';

export function createApp() {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.notFound((c) => c.json({ error: 'not-found' }, 404));
  app.onError((_error, c) => c.json({ error: 'temporarily-unavailable' }, 503));
  return app;
}
