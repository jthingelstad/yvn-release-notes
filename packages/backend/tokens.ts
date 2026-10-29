/** API tokens (docs/API.md, Tokens; Jamie, 2026-10-29): a named, scoped key
 * the owner makes in their email-verified web session, opening `/v1` only.
 * Only its SHA-256 is kept.
 *
 * The token itself is USER#<owner> / APITOKEN#<id> (`name`, `scope`,
 * `created_at`, `expires_at` unless it never expires, `hash`, `revoked` once
 * its client signed out), so the private capture function, which writes only
 * USER# rows, proves it in the same transaction as each write and marks it
 * revoked at a client's sign out. Its hash points at it from
 * OAUTHACCESS#<sha256> (`kind` token, `resource` <origin>/v1), which the MCP
 * bearer check never accepts, tracked under OAUTHUSER# so deleting the
 * account removes it with the agent connections. No bearer authenticates a
 * web route: only the /v1 router and the capture function read a token. */
import { randomUUID } from 'node:crypto';
import { digest, newToken } from './auth.ts';
import { live, type OAuthRow } from './oauth.ts';
import { recordActivity } from './activity.ts';
import { reject } from './sessions.ts';
import { codePointLength, pythonTrim } from '../domain/unicode.ts';
import type { Log } from './services.ts';

/** What a token may be given. `activity` is a token's alone: the OAuth
 * consent screen never offers it in v1. */
export const TOKEN_SCOPES = ['notes:write', 'media:write', 'upcoming', 'activity'] as const;
export const TOKENS_MAX = 20,
  TOKEN_NAME_MAX = 40;
/** The expiry choices, in seconds; `never` has no expiry. */
export const TOKEN_EXPIRY: Record<string, number | null> = { '90d': 90 * 86400, '1y': 365 * 86400, never: null };
export const TOKEN_FORMAT = /^rn_[A-Za-z0-9_-]{43}$/;
export const tokenKey = (id: string): string => 'APITOKEN#' + id;
/** `/v1`'s daily limits in UTC, separate from MCP's: notes made, other
 * changes and Upcoming saves per account across its tokens, reads per
 * token. */
export const V1_LIMITS = { create: 100, change: 200, upcoming: 50, reads: 2000 } as const;
/** The most Upcoming dates one `/v1` save adds, changes and removes, as for
 * an agent. */
export const V1_UPCOMING_MAX = 50;
/** What a token without the scope a request needs is told. */
export const SCOPE_REFUSALS: Record<string, string> = {
  'notes:write': "This token can't add notes. Make a token with Add notes ticked.",
  upcoming: "This token can't read or change Upcoming. Make a token with Upcoming ticked.",
  activity: "This token can't read the activity log. Make a token that may read it."
};
/** How long a `/v1` write's receipt answers a retry: a phone can be offline
 * for a weekend. */
export const V1_RECEIPT_SECONDS = 7 * 86400;

/** The product a client names first in its User-Agent ("Changelog" from
 * "Changelog/0.1 (iOS 26.1)", "curl" from "curl/8.7.1"): self-reported, so
 * it labels a note and never grants anything. */
export function clientProduct(userAgent: string | null | undefined): string | null {
  const match = /^([A-Za-z0-9._-]{1,40})(?=[/\s]|$)/.exec(String(userAgent ?? '').trim());
  return match ? match[1]! : null;
}

export interface TokenReads {
  mcpGet(pk: string, sk?: string): Promise<OAuthRow | null>;
  mcpProfile(uid: string): Promise<OAuthRow | null>;
}
export interface TokenStore extends TokenReads {
  mcpRows(pk: string): Promise<OAuthRow[]>;
  mcpCommit(changes: [OAuthRow, number | null][], uid?: string | null): Promise<boolean>;
  putActivity(user: string, rows: readonly OAuthRow[]): Promise<boolean>;
  apiTokens(uid: string): Promise<OAuthRow[]>;
  dropToken(uid: string, id: string, hash: string, now: number): Promise<boolean>;
}

const expired = (row: OAuthRow, now: number) => row.expires_at != null && Number(row.expires_at) <= now;
export const scopesOf = (row: OAuthRow): string[] =>
  String(row.scope ?? '')
    .split(/\s+/)
    .filter(Boolean);

export type TokenCheck =
  | { ok: true; token: OAuthRow; profile: OAuthRow }
  | { ok: false; code: 'token_missing' | 'token_unknown' | 'token_revoked' | 'token_expired' | 'account_closing' };

/** The token an Authorization header carries, read strongly, with its
 * account. Each refusal says which, so a client knows to sign in again. */
export async function checkToken(
  store: TokenReads,
  origin: string,
  now: number,
  authorization: string | null
): Promise<TokenCheck> {
  if (!authorization || !/^Bearer\s/i.test(authorization)) return { ok: false, code: 'token_missing' };
  const raw = authorization.slice(7).trim();
  if (!TOKEN_FORMAT.test(raw)) return { ok: false, code: 'token_unknown' };
  const pointer = await store.mcpGet('OAUTHACCESS#' + digest(raw));
  if (pointer?.revoked) return { ok: false, code: 'token_revoked' };
  if (!pointer || pointer.kind !== 'token' || pointer.resource !== origin + '/v1' || !pointer.user_id)
    return { ok: false, code: 'token_unknown' };
  if (expired(pointer, now)) return { ok: false, code: 'token_expired' };
  const uid = String(pointer.user_id),
    row = await store.mcpGet('USER#' + uid, tokenKey(String(pointer.token)));
  if (!row || row.revoked || row.hash !== digest(raw)) return { ok: false, code: 'token_revoked' };
  if (expired(row, now)) return { ok: false, code: 'token_expired' };
  const profile = await store.mcpProfile(uid);
  if (!profile) return { ok: false, code: 'token_revoked' };
  if (profile.mcp_deleting) return { ok: false, code: 'account_closing' };
  return { ok: true, token: { ...row, user_id: uid }, profile };
}

/** A token as Settings and `/v1/me` show it: never its value or hash. */
export function tokenView(row: OAuthRow, now: number, used: number | null = null): OAuthRow {
  return {
    id: row.id,
    name: row.name,
    scopes: scopesOf(row),
    created_at: Number(row.created_at),
    expires_at: row.expires_at == null ? null : Number(row.expires_at),
    expired: expired(row, now),
    last_used: used
  };
}

/** The owner's side, in their email-verified web session (account-routes). */
export class Tokens {
  constructor(readonly context: { store: TokenStore; origin: string; now: number; log?: Log }) {}
  /** Live and expired tokens, newest first. One its client revoked is
   * removed for good here, where the web may delete its pointer. */
  async list(uid: string): Promise<{ tokens: OAuthRow[] }> {
    const { store, now } = this.context,
      rows = await store.apiTokens(uid);
    for (const row of rows.filter((r) => r.revoked)) await store.dropToken(uid, String(row.id), String(row.hash), now);
    const usage = new Map<string, number>();
    for (const item of await store.mcpRows('MCPMETA#' + uid)) {
      if (!/^(USE|LOG)#/.test(String(item.sk)) || !live(item, now)) continue;
      const id = String(item.sk).startsWith('USE#') ? String(item.sk).slice(4) : String(item.connection ?? '');
      if (id) usage.set(id, Math.max(usage.get(id) ?? 0, Number(item.at)));
    }
    return {
      tokens: rows
        .filter((r) => !r.revoked)
        .sort((a, b) => Number(b.created_at) - Number(a.created_at))
        .map((r) => tokenView(r, now, usage.get(String(r.id)) ?? null))
    };
  }
  /** Makes a token and answers its value, the one time it is ever shown. */
  async make(uid: string, body: OAuthRow): Promise<OAuthRow> {
    const { store, now, origin } = this.context;
    if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'token-fields');
    const name = typeof body.name === 'string' ? pythonTrim(body.name.normalize('NFC')) : '';
    if (
      !name ||
      codePointLength(name) > TOKEN_NAME_MAX ||
      [...name].some((c) => c.codePointAt(0)! < 32 || c === '\u007f')
    )
      reject(400, 'token-name');
    const scopes = body.scopes;
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((s) => !(TOKEN_SCOPES as readonly unknown[]).includes(s))
    )
      reject(400, 'token-scopes');
    // Files ride on adding notes, as they do for an agent.
    if (scopes.includes('media:write') && !scopes.includes('notes:write')) reject(400, 'token-scopes');
    if (typeof body.expiry !== 'string' || !Object.hasOwn(TOKEN_EXPIRY, body.expiry)) reject(400, 'token-expiry');
    const current = (await store.apiTokens(uid)).filter((r) => !r.revoked && !expired(r, now));
    if (current.length >= TOKENS_MAX) reject(409, 'token-limit', { max: TOKENS_MAX });
    if (current.some((r) => String(r.name).toLowerCase() === name.toLowerCase())) reject(409, 'token-name-taken');
    const raw = 'rn_' + newToken(),
      hash = digest(raw),
      id = randomUUID().replace(/-/g, ''),
      seconds = TOKEN_EXPIRY[body.expiry]!,
      ends = seconds == null ? {} : { expires_at: now + seconds },
      scope = TOKEN_SCOPES.filter((s) => scopes.includes(s)).join(' '),
      row: OAuthRow = { pk: 'USER#' + uid, sk: tokenKey(id), id, name, scope, created_at: now, hash, ...ends },
      pointer: OAuthRow = {
        pk: 'OAUTHACCESS#' + hash,
        sk: 'STATE',
        kind: 'token',
        user_id: uid,
        token: id,
        resource: origin + '/v1',
        ...ends
      },
      tracked: OAuthRow = { pk: 'OAUTHUSER#' + uid, sk: 'ROW#' + pointer.pk, target: pointer.pk, ...ends };
    if (
      !(await store.mcpCommit(
        [
          [row, null],
          [pointer, null],
          [tracked, null]
        ],
        uid
      ))
    )
      reject(409, 'try-again');
    await recordActivity(
      store,
      uid,
      now,
      [
        {
          kind: 'connection.added',
          id,
          fields: { via: 'web', connection: id, client: name, scopes: scope, token: name }
        }
      ],
      (f) => this.context.log?.(f)
    );
    return { token: raw, ...tokenView({ ...row, revision: 1 }, now) };
  }
  /** The owner ends a token: its next request is refused. */
  async revoke(uid: string, id: string): Promise<{ ok: true }> {
    const { store, now } = this.context,
      row = await store.mcpGet('USER#' + uid, tokenKey(id));
    if (!row) reject(404, 'token-gone');
    if (!(await store.dropToken(uid, id, String(row.hash), now))) reject(409, 'try-again');
    if (!row.revoked)
      await recordActivity(
        store,
        uid,
        now,
        [
          {
            kind: 'connection.removed',
            id,
            fields: { via: 'web', connection: id, client: row.name, reason: 'owner', token: row.name }
          }
        ],
        (f) => this.context.log?.(f)
      );
    return { ok: true };
  }
}
