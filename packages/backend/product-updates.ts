/** Only the configured, email-verified operator account manages product news.
 * Writes prove its current profile and live session atomically. Scheduling
 * copies a saved draft into one date slot; subsequent editing needs cancellation.
 * Cancellation stops future reads, and cannot retract emails already accepted.
 * No subscriber content is read or written by these operations. */
import { SessionService, reject } from './sessions.ts';
import { collect, segments } from './links.ts';
import { codePointLength, pythonTrim } from '../domain/unicode.ts';
import { UPDATE_TITLE_MAX, UPDATE_TEXT_MAX, type ProductUpdate } from '../domain/product-updates.ts';
import type { Item } from './store-types.ts';
export function isAdmin(profile: Item, configured?: string): boolean {
  return Boolean(configured && profile.pk === 'USER#' + configured && !profile.mcp_deleting);
}
export async function admin(service: SessionService) {
  const account = await service.account();
  if (!isAdmin(account.profile, service.context.adminUserId)) reject(403, 'admin-only');
  return { ...account, email: String(account.profile.email) };
}
export async function updateContent(service: SessionService, value: Item, previous?: ProductUpdate) {
  if (typeof value.title !== 'string' || typeof value.text !== 'string') reject(400, 'update-text');
  const title = pythonTrim(value.title),
    text = pythonTrim(value.text.replace(/\r\n?/g, '\n'));
  if (!title || !text || /[\r\n]/.test(title)) reject(400, 'update-text');
  if (codePointLength(title) > UPDATE_TITLE_MAX || codePointLength(text) > UPDATE_TEXT_MAX)
    reject(400, 'update-too-long');
  return { title, text, links: await collect(text, { keep: previous?.links, fetch: service.context.fetchTitle }) };
}
export function updateView(update: ProductUpdate) {
  return { ...update, parts: segments(update.text, update.links) };
}
