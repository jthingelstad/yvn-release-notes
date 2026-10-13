/** Ordinary Node HTTP server startup, shared by local and Lambda Web Functions. */
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';
import type { Server } from 'node:http';

export function httpEndpoint(value = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:8790') {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match) throw new Error('Invalid HTTP endpoint');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Invalid HTTP port');
  return { hostname: match[1]!.replace(/^\[|\]$/g, ''), port };
}

export interface ListenOptions {
  graceMs?: number;
  signals?: boolean;
  log?: (fields: { event: string; outcome: string }) => void;
}
export function listen(app: Hono, value?: string, options: ListenOptions = {}) {
  const grace = options.graceMs ?? 10_000;
  if (!Number.isFinite(grace) || grace < 0 || grace > 120_000) throw new Error('Invalid shutdown grace');
  const server = serve({ fetch: app.fetch, ...httpEndpoint(value) }) as Server;
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => {
      options.log?.({ event: 'http-shutdown', outcome: 'deadline' });
      server.closeAllConnections();
      process.exit(0);
    }, grace);
    server.close(() => {
      clearTimeout(timer);
      options.log?.({ event: 'http-shutdown', outcome: 'drained' });
      process.exit(0);
    });
  };
  server.on('request', (_request, response) => {
    response.once('finish', () => {
      // A request can become idle after close() began. Reap that connection
      // once Node has marked it idle, rather than waiting out keep-alive.
      if (closing) setImmediate(() => server.closeIdleConnections());
    });
  });
  if (options.signals !== false) {
    // Keep both handlers installed during drain: repeated signals are harmless.
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    server.once('close', () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    });
  }
  return server;
}
