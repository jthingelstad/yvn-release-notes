/** Private JSON/Markdown and asynchronous zip HTTP workflow. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from './sessions.ts';
import { build, markdown } from './export.ts';
import { iso } from '../domain/dates.ts';
import { json } from '../../server/app/requests.ts';
import { eventId, recordActivity } from './activity.ts';
import { BUILDS_A_DAY } from '../book/limits.ts';
export async function exportRoutes(
  service: SessionService,
  pattern: string,
  query: URLSearchParams
): Promise<Response | null> {
  if (!pattern.startsWith('/api/export')) return null;
  // A download is a plain link, and the session cookie is SameSite=Lax, so
  // another site's link would start one and log a false export. The browser
  // names who started it: only this site, or the person typing or opening a
  // bookmark (none). An old browser that sends nothing goes ahead (2026-11-08,
  // SIGNIN-6).
  const site = service.request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') reject(403, 'origin');
  const { uid } = await service.account(),
    ctx = service.context,
    store = ctx.store;
  if (pattern === '/api/export') {
    const format = query.get('format') ?? 'json';
    if (format !== 'json' && format !== 'md') reject(400, 'format');
    const data = build(await store.exportItems(uid), iso(ctx.now)),
      name = `release-notes-${iso(ctx.now).slice(0, 10)}.${format}`;
    await recordActivity(store, uid, ctx.now, [{ kind: 'export.words', id: eventId(), fields: { format } }], (f) =>
      service.log(f)
    );
    return json(format === 'md' ? markdown(data) : JSON.stringify(data, null, 2) + '\n', 200, {
      'content-type': format === 'md' ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${name}"`
    });
  }
  const found = await store.export(uid),
    status =
      !found || Number(found.expires_at ?? 0) <= ctx.now
        ? 'none'
        : found.status === 'building' && ctx.now - Number(found.started_at) > 960
          ? 'failed'
          : found.status;
  if (pattern.endsWith('/file')) {
    if (status !== 'ready' || !String(found?.export_key ?? '').startsWith(`exports/${uid}/`)) reject(404, 'export');
    return json({}, 302, {
      location: await ctx.objects.download(String(found!.export_key), 'application/zip', 300, {
        disposition: `attachment; filename="release-notes-${iso(Number(found!.finished_at)).slice(0, 10)}.zip"`
      })
    });
  }
  if (service.request.method === 'POST') {
    if (status === 'building') return json({ status }, 202);
    // A count, on the plain table: the export's own start proves the session.
    if ((await service.rawStore.countBuild(uid, ctx.now)) > BUILDS_A_DAY) reject(429, 'build-limit');
    if (found?.export_key && String(found.export_key).startsWith(`exports/${uid}/`))
      await ctx.objects.remove(String(found.export_key));
    const id = randomUUID().replace(/-/g, '');
    await store.startExport(uid, id, ctx.now, ctx.now + 86400);
    try {
      await ctx.invocations.invoke(ctx.exportFunction, { user_id: uid, id }, true);
    } catch {
      await store.finishExport(uid, id, { status: 'failed', finished_at: ctx.now });
      reject(502, 'export-failed');
    }
    await recordActivity(store, uid, ctx.now, [{ kind: 'export.zip', id }], (f) => service.log(f));
    return json({ status: 'building' }, 202);
  }
  return json(
    status === 'ready'
      ? {
          status,
          size: Number(found!.size),
          files: Number(found!.files ?? 0),
          built_at: iso(Number(found!.finished_at)),
          until: iso(Number(found!.expires_at))
        }
      : { status }
  );
}
