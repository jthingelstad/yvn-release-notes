/** Admin routes share the app's Origin gate and email-verified sessions. */
import { randomUUID } from 'node:crypto';
import { SessionService, reject } from '../../packages/backend/sessions.ts';
import { admin, updateContent, updateView } from '../../packages/backend/product-updates.ts';
import { iso, localDay, validDay } from '../../packages/domain/dates.ts';
import type { ProductUpdate } from '../../packages/domain/product-updates.ts';
import { body, json } from './requests.ts';
export async function adminRoutes(service: SessionService, pattern: string, args: string[]): Promise<Response | null> {
  if (!pattern.startsWith('/api/admin/')) return null;
  const { uid, email, profile } = await admin(service),
    ctx = service.context,
    store = ctx.store;
  const method = service.request.method,
    at = iso(ctx.now);
  if (pattern === '/api/admin/updates' && method === 'GET')
    return json({
      updates: (await store.productUpdates()).map(updateView),
      today: localDay(ctx.now, String(profile.tz))
    });
  const value = await body(service.request);
  let previous: ProductUpdate | null = null,
    next: ProductUpdate | null;
  if (pattern === '/api/admin/updates') {
    next = {
      id: randomUUID(),
      ...(await updateContent(service, value)),
      revision: 1,
      status: 'draft',
      date: null,
      created_at: at,
      updated_at: at
    };
  } else {
    previous = await store.productUpdate(args[0]!);
    if (!previous) reject(404, 'update-missing');
    if (!Number.isSafeInteger(value.revision) || value.revision !== previous.revision) reject(409, 'update-changed');
    next = { ...previous, revision: previous.revision + 1, updated_at: at };
    if (pattern.endsWith('/schedule')) {
      if (method === 'POST') {
        if (previous.status !== 'draft') reject(409, 'update-scheduled');
        if (
          typeof value.date !== 'string' ||
          !validDay(value.date) ||
          value.date < localDay(ctx.now, String(profile.tz))
        )
          reject(400, 'update-date');
        next.status = 'scheduled';
        next.date = value.date;
      } else {
        if (previous.status !== 'scheduled') reject(409, 'update-changed');
        next.status = 'draft';
        next.date = null;
      }
    } else {
      if (previous.status !== 'draft') reject(409, 'update-scheduled');
      if (method === 'DELETE') next = null;
      else Object.assign(next, await updateContent(service, value, previous));
    }
  }
  if (!(await store.saveProductUpdate(uid, email, next, previous))) reject(409, 'update-conflict');
  service.log({
    event: 'product-update',
    user: uid,
    action: method === 'DELETE' ? 'remove' : (next?.status ?? 'remove')
  });
  return json(next ? updateView(next) : { ok: true }, previous ? 200 : 201);
}
