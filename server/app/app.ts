/** Native HTTP application: centrally protected writes and request-local sessions. */
import { Hono } from 'hono';
import { SessionService, ApiError, type ApiContext } from '../../packages/backend/sessions.ts';
import { OAuthError, publicOAuth } from '../../packages/backend/oauth.ts';
import { accountRoutes } from './account-routes.ts';
import { archiveRoutes } from './archive-routes.ts';
import { noteRoutes } from './note-routes.ts';
import { adminRoutes } from './admin-routes.ts';
import { upcomingRoutes } from './upcoming-routes.ts';
import { exportRoutes } from '../../packages/backend/exports.ts';
import { errorFields } from '../../packages/backend/services.ts';
import { json, trustedViewer } from './requests.ts';
export interface AppOptions {
  context?: () => ApiContext | Promise<ApiContext>;
  viewer?: (request: Request) => string;
}
export const ROUTES: [string, string][] = [
  ['GET', '/api/health'],
  ['GET', '/api/sample'],
  ['POST', '/api/auth/start'],
  ['POST', '/api/auth/verify'],
  ['POST', '/api/auth/signout'],
  ['GET', '/api/me'],
  ['PUT', '/api/me'],
  ['DELETE', '/api/me'],
  ['POST', '/api/me/delete-code'],
  ['POST', '/api/me/inbox'],
  ['GET', '/api/places'],
  ['GET', '/api/export'],
  ['GET', '/api/export/zip'],
  ['POST', '/api/export/zip'],
  ['GET', '/api/export/zip/file'],
  ['GET', '/api/today'],
  ['GET', '/api/upcoming'],
  ['POST', '/api/upcoming'],
  ['POST', '/api/upcoming/batch'],
  ['PUT', '/api/upcoming/{id}'],
  ['DELETE', '/api/upcoming/{id}'],
  ['POST', '/api/calendar'],
  ['DELETE', '/api/calendar'],
  ['GET', '/api/calendar/{token}.ics'],
  ['GET', '/api/days'],
  ['GET', '/api/days/{date}'],
  ['GET', '/api/releases'],
  ['GET', '/api/releases/{v}'],
  ['POST', '/api/days/{date}/notes'],
  ['PUT', '/api/days/{date}/notes/{id}'],
  ['DELETE', '/api/days/{date}/notes/{id}'],
  ['PUT', '/api/days/{date}/place'],
  ['DELETE', '/api/days/{date}/place'],
  ['GET', '/api/days/{date}/notes/{id}/media/{n}'],
  ['POST', '/api/days/{date}/notes/{id}/media'],
  ['POST', '/api/uploads'],
  ['GET', '/api/tags'],
  ['GET', '/api/tags/{tag}'],
  ['POST', '/api/search'],
  ['PUT', '/api/pause'],
  ['DELETE', '/api/pause'],
  ['GET', '/api/unsubscribe'],
  ['POST', '/api/unsubscribe'],
  ['POST', '/api/mcp/authorize'],
  ['GET', '/api/mcp/connections'],
  ['DELETE', '/api/mcp/connections/{id}'],
  ['GET', '/api/mcp/activity'],
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/updates'],
  ['POST', '/api/admin/updates'],
  ['PUT', '/api/admin/updates/{id}'],
  ['DELETE', '/api/admin/updates/{id}'],
  ['POST', '/api/admin/updates/{id}/schedule'],
  ['DELETE', '/api/admin/updates/{id}/schedule']
];
const compiled = ROUTES.map(([method, path]) => ({
  method,
  path,
  re: new RegExp(
    '^' +
      path
        .replace('{date}', '([0-9]{4}-[0-9]{2}-[0-9]{2})')
        .replace('{id}', '([A-Za-z0-9_-]{1,80})')
        .replace('{n}', '([1-9][0-9]?)')
        .replace('{v}', '([0-9]{1,3}\\.[0-9])')
        .replace('{tag}', '([a-z0-9]{1,50}(?:-[a-z0-9]{1,49})*)')
        .replace('{token}.ics', '([a-z2-7]{24})\\.ics') +
      '$'
  )
}));
export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();
  app.all('*', async (c) => {
    // HEAD is answered as GET with the body dropped: the routes see a GET request.
    const head = c.req.raw.method === 'HEAD',
      req = head ? new Request(c.req.raw, { method: 'GET' }) : c.req.raw,
      url = new URL(req.url),
      matched = compiled.find((r) => r.method === req.method && r.re.test(url.pathname)),
      isOAuth = url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/oauth-');
    let service: SessionService | undefined, response: Response;
    try {
      if (!options.context) {
        response = matched?.path === '/api/health' ? json({ ok: true }) : json({ error: 'not-found' }, 404);
      } else {
        const ctx = { ...(await options.context()) };
        service = new SessionService(ctx, req);
        if (isOAuth) response = await publicOAuth(ctx, req, { viewer: (options.viewer ?? trustedViewer)(req) });
        else if (!matched) response = json({ error: 'not-found' }, 404);
        else if (
          req.method !== 'GET' &&
          matched.path !== '/api/unsubscribe' &&
          req.headers.get('origin') !== ctx.origin
        )
          response = json({ error: 'origin' }, 403);
        else {
          const args = matched.re.exec(url.pathname)!.slice(1),
            viewer = (options.viewer ?? trustedViewer)(req);
          response =
            (await accountRoutes(service, matched.path, args, url.searchParams, viewer)) ??
            (await archiveRoutes(service, matched.path, args, url.searchParams)) ??
            (await noteRoutes(service, matched.path, args)) ??
            (await adminRoutes(service, matched.path, args)) ??
            (await upcomingRoutes(service, matched.path, args)) ??
            (await exportRoutes(service, matched.path, url.searchParams)) ??
            json({ error: 'not-found' }, 404);
        }
      }
    } catch (error) {
      if (error instanceof ApiError) response = json({ error: error.error, ...error.extra }, error.status);
      else if (error instanceof OAuthError) response = json({ error: error.error }, error.status);
      else {
        service?.log({ event: 'web-error', ...errorFields(error) });
        response = json({ error: 'temporarily-unavailable' }, 503);
      }
    }
    if (service?.renewedCookie && !response.headers.has('set-cookie'))
      response.headers.append('set-cookie', service.renewedCookie);
    response.headers.set('cache-control', 'no-store');
    service?.log({
      event: 'web',
      method: c.req.raw.method,
      path: isOAuth ? 'oauth' : (matched?.path ?? 'unmatched'),
      status: response.status
    });
    if (head) {
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  });
  return app;
}
