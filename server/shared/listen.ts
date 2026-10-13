/** Ordinary Node HTTP server startup, shared by local and Lambda Web Functions. */
import { serve } from '@hono/node-server';
import type { Hono } from 'hono';

export function httpEndpoint(value = process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? '127.0.0.1:8790') {
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(value);
  if (!match) throw new Error('Invalid HTTP endpoint');
  const port = Number(match[2]);
  if (port < 1 || port > 65535) throw new Error('Invalid HTTP port');
  return { hostname: match[1]!.replace(/^\[|\]$/g, ''), port };
}

export function listen(app: Hono, value?: string) {
  return serve({ fetch: app.fetch, ...httpEndpoint(value) });
}
