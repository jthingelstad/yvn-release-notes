/** Email-owner approved OAuth connections. Browser consent is separate from
 * public OAuth, tokens are hash-only, and family/profile proofs are durable.
 * No bearer can authenticate an application session or a general web write.
 *
 * Two resources (docs/API.md, Phase 5). `/mcp` is an agent's connection:
 * an hour-long access token and a rotating refresh token. `/v1` is an app's
 * sign-in: the consent chooses an API token (tokens.ts) as Settings makes
 * one, and spending the code makes it, once, with no refresh, so an app,
 * its share extension and its shortcuts all hold the same one key. */
import { createHash } from 'node:crypto';
import { digest, live, network, newToken, same } from './auth.ts';
import { codePointLength } from '../domain/unicode.ts';
import type { ActivityEvent } from '../domain/activity.ts';
import { again, recordActivity } from './activity.ts';
import { safeLog, type Log } from './services.ts';
import { TOKEN_EXPIRY, TOKEN_SCOPES, tokenFields, tokenId, Tokens, type TokenStore } from './tokens.ts';
import { ApiError } from './sessions.ts';
export type OAuthRow = Record<string, unknown>;
export type OAuthChange = [OAuthRow, number | null];
export interface OAuthStore {
  mcpGet(pk: string, sk?: string): Promise<OAuthRow | null>;
  mcpRows(pk: string): Promise<OAuthRow[]>;
  mcpProfile(uid: string): Promise<OAuthRow | null>;
  mcpCommit(changes: OAuthChange[], uid?: string | null): Promise<boolean>;
  mcpBlock(uid: string): Promise<void>;
  deleteKeys(keys: { pk: string; sk: string }[]): Promise<void>;
  count(key: string, period: number, span?: number): Promise<number>;
  putActivity(user: string, rows: readonly OAuthRow[]): Promise<boolean>;
}
export interface OAuthContext {
  store: OAuthStore;
  origin: string;
  now: number;
  log?: Log;
}
export const SCOPES = ['media:read', 'media:write', 'notes:read', 'notes:write', 'upcoming'];
/** What an app signing in may ask for: a token's scopes. */
export const APP_SCOPES: readonly string[] = TOKEN_SCOPES;
/** An app's sign-in code lives five minutes, as an agent's does. */
const CODE_SECONDS = 300;
export const ACCESS_SECONDS = 3600,
  REFRESH_SECONDS = 30 * 86400;
export class OAuthError extends Error {
  constructor(
    readonly error = 'invalid_request',
    readonly status = 400
  ) {
    super(error);
  }
}
function fail(error = 'invalid_request', status = 400): never {
  throw new OAuthError(error, status);
}
export { live };
const row = (pk: string, fields: OAuthRow = {}): OAuthRow => ({ pk, sk: 'STATE', ...fields });
const tracked = (item: OAuthRow, uid: string): OAuthRow =>
  row(`OAUTHUSER#${uid}`, { sk: `ROW#${item.pk}`, target: item.pk, expires_at: item.expires_at });
/** Scopes an owner can add to a live connection from Settings, and what each
 * needs the connection to have already: files ride on adding notes. */
const GRANTABLE: Record<string, string | null> = { upcoming: null, 'media:write': 'notes:write' };
/** What "Turn off adding" takes away: adding notes, and files with it. */
const ADDING = ['notes:write', 'media:write'];
const scopes = (value: unknown): string[] =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean);
/** The code's PKCE verifier and redirect, as the client gave them. */
function proved(item: OAuthRow, body: Record<string, string>): boolean {
  const verifier = body.code_verifier ?? '',
    challenge = createHash('sha256').update(verifier).digest('base64url');
  return (
    /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) &&
    same(challenge, String(item.challenge)) &&
    body.redirect_uri === item.redirect_uri
  );
}
/** Where the browser goes after consent: the client's redirect, with the
 * answer and its state. */
function back(item: OAuthRow, answer: Record<string, string>): { redirect: string } {
  const params = new URLSearchParams(answer);
  if (item.state) params.set('state', String(item.state));
  return {
    redirect: String(item.redirect_uri) + (String(item.redirect_uri).includes('?') ? '&' : '?') + params.toString()
  };
}
export function validRedirect(uri: unknown): uri is string {
  if (
    typeof uri !== 'string' ||
    codePointLength(uri) > 2048 ||
    [...uri].some((c) => c.codePointAt(0)! < 33) ||
    uri.includes('#') ||
    uri.includes('\\')
  )
    return false;
  // A native app's own scheme (RFC 8252, 7.1): reverse DNS, so it has a dot,
  // like com.yourversionnumber.changelog:/oauth. No web scheme has one.
  if (/^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:\//i.test(uri)) return true;
  try {
    const u = new URL(uri);
    // The URL parser canonicalizes integers/dot forms; only explicit loopback
    // spellings accepted by the original registration contract may use HTTP.
    const authority = uri.match(/^https?:\/\/([^/?]+)/i)?.[1] ?? '';
    const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(authority);
    return Boolean(
      authority &&
      u.hostname &&
      !u.username &&
      !u.password &&
      (u.protocol === 'https:' || (u.protocol === 'http:' && loopback))
    );
  } catch {
    return false;
  }
}

export class OAuthService {
  constructor(readonly context: OAuthContext) {}
  get resource(): string {
    return this.context.origin + '/mcp';
  }
  /** The API's resource, which an app signs in to. */
  get appResource(): string {
    return this.context.origin + '/v1';
  }
  /** An app's sign-in makes an API token, which only the web's store can. */
  private tokens(): Tokens {
    const store = this.context.store as OAuthStore & Partial<TokenStore>;
    if (typeof store.apiTokens !== 'function' || typeof store.dropToken !== 'function')
      fail('temporarily_unavailable', 503);
    return new Tokens({ ...this.context, store: store as OAuthStore & TokenStore });
  }
  private async familyFor(item: OAuthRow): Promise<OAuthRow | null> {
    const { store, now } = this.context;
    const family = await store.mcpGet(`OAUTHFAMILY#${item.family ?? ''}`);
    const profile = await store.mcpProfile(String(item.user_id ?? ''));
    if (
      !live(family, now) ||
      !profile ||
      profile.mcp_deleting ||
      family.user_id !== item.user_id ||
      family.resource !== this.resource
    )
      return null;
    return family;
  }
  async bearer(token: string): Promise<OAuthRow | null> {
    const item = await this.context.store.mcpGet('OAUTHACCESS#' + digest(token));
    if (!live(item, this.context.now) || item.resource !== this.resource) return null;
    const family = await this.familyFor(item);
    return family && family.version === item.version ? family : null;
  }
  /** A connection change in the owner's activity log, after it is made. */
  private async record(uid: string, kind: string, family: OAuthRow, fields: OAuthRow): Promise<void> {
    const event: ActivityEvent = {
      kind,
      // A connection is added and ended once, and changed any number of times.
      id: kind === 'connection.changed' ? again(String(family.id)) : String(family.id),
      fields: { ...fields, connection: family.id, client: family.client_name }
    };
    await recordActivity(this.context.store, uid, this.context.now, [event], this.context.log ?? safeLog);
  }
  /** Ends a connection: the owner disconnected it, its client revoked its own
   * token, or a used refresh token came back (token-reuse). */
  async revoke(fid: string, uid: string, reason: 'owner' | 'client' | 'token-reuse'): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.context.store.mcpGet('OAUTHFAMILY#' + fid);
      if (!item || item.user_id !== uid || item.revoked) return;
      if (await this.context.store.mcpCommit([[{ ...item, revoked: true }, Number(item.revision)]], uid))
        return this.record(uid, 'connection.removed', item, { ...(reason === 'owner' ? { via: 'web' } : {}), reason });
    }
    fail('temporarily_unavailable', 503);
  }
  private issueRows(family: OAuthRow): { answer: OAuthRow; changes: OAuthChange[] } {
    const access = newToken(),
      refresh = newToken();
    const common = {
      user_id: family.user_id,
      family: family.id,
      scope: family.scope,
      resource: family.resource,
      version: family.version,
      client_id: family.client_id
    };
    const a = row('OAUTHACCESS#' + digest(access), { ...common, expires_at: this.context.now + ACCESS_SECONDS });
    const r = row('OAUTHREFRESH#' + digest(refresh), { ...common, expires_at: this.context.now + REFRESH_SECONDS });
    const changes: OAuthChange[] = [a, tracked(a, String(family.user_id)), r, tracked(r, String(family.user_id))].map(
      (i) => [i, null]
    );
    return {
      answer: {
        access_token: access,
        token_type: 'Bearer',
        expires_in: ACCESS_SECONDS,
        refresh_token: refresh,
        scope: family.scope
      },
      changes
    };
  }
  async exchange(body: Record<string, string>): Promise<OAuthRow> {
    const { store, now } = this.context;
    if (body.resource === this.appResource) return this.signedIn(body);
    if (body.resource !== this.resource) fail('invalid_target');
    const kind = body.grant_type;
    const prefix =
      kind === 'authorization_code'
        ? 'OAUTHCODE#'
        : kind === 'refresh_token'
          ? 'OAUTHREFRESH#'
          : fail('unsupported_grant_type');
    const item = await store.mcpGet(
      prefix + digest(body[kind === 'authorization_code' ? 'code' : 'refresh_token'] ?? '')
    );
    if (!item || item.client_id !== body.client_id) fail('invalid_grant');
    if (item.used) {
      if (kind === 'refresh_token') await this.revoke(String(item.family), String(item.user_id), 'token-reuse');
      fail('invalid_grant');
    }
    const family = await this.familyFor(item);
    if (!live(item, now) || !family) fail('invalid_grant');
    if (kind === 'authorization_code') {
      if (!proved(item, body)) fail('invalid_grant');
    } else if (item.version !== family.version) {
      await this.revoke(String(item.family), String(item.user_id), 'token-reuse');
      fail('invalid_grant');
    }
    if (body.scope && body.scope !== family.scope) fail('invalid_scope');
    const updated = { ...family, version: Number(family.version) + 1, expires_at: now + REFRESH_SECONDS };
    const { answer, changes } = this.issueRows(updated),
      index = tracked(updated, String(item.user_id));
    const previous = await store.mcpGet(String(index.pk), String(index.sk));
    changes.push(
      [{ ...item, used: true }, Number(item.revision)],
      [updated, Number(family.revision)],
      [index, previous ? Number(previous.revision) : null]
    );
    if (!(await store.mcpCommit(changes, String(item.user_id)))) {
      if (kind === 'refresh_token') await this.revoke(String(item.family), String(item.user_id), 'token-reuse');
      fail('invalid_grant');
    }
    return answer;
  }
  /** Caller supplies an email-session-proved owner, never a bearer principal. */
  async authorize(uid: string, body: OAuthRow): Promise<OAuthRow> {
    const { store, now } = this.context,
      pending = body.request;
    const item =
      typeof pending === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pending)
        ? await store.mcpGet('OAUTHPENDING#' + pending)
        : null;
    if (!live(item, now) || item.used) fail('request_expired');
    if (item.resource === this.appResource) return this.signIn(uid, item, body);
    if (!Object.hasOwn(body, 'approve')) return { client_name: item.client_name, scope: item.scope };
    if (
      typeof body.approve !== 'boolean' ||
      typeof (Object.hasOwn(body, 'media') ? body.media : false) !== 'boolean' ||
      typeof (Object.hasOwn(body, 'write') ? body.write : false) !== 'boolean' ||
      typeof (Object.hasOwn(body, 'upcoming') ? body.upcoming : false) !== 'boolean' ||
      typeof (Object.hasOwn(body, 'files') ? body.files : false) !== 'boolean'
    )
      fail();
    if (body.write && !scopes(item.scope).includes('notes:write')) fail('invalid_scope');
    // Adding files (media:write, Jamie 2026-10-28: "the mcp interface doesn't
    // allow an agent to add an image or attachment") is offered with adding
    // notes, whatever else the client asked for, as Upcoming is, and only
    // ever granted with it.
    if (body.files && !body.write) fail('invalid_scope');
    // Upcoming is offered on every consent screen whatever the client asked for
    // (Jamie, 2026-10-17: the connect screen "does not reference anything for
    // upcoming"): clients re-request the scopes they were first granted, and
    // the owner can add it to a live connection from Settings anyway.
    const scope =
      'notes:read' +
      (body.media && scopes(item.scope).includes('media:read') ? ' media:read' : '') +
      (body.write ? ' notes:write' : '') +
      (body.files ? ' media:write' : '') +
      (body.upcoming ? ' upcoming' : '');
    const code = newToken(),
      fid = newToken();
    const family = row('OAUTHFAMILY#' + fid, {
      id: fid,
      user_id: uid,
      client_id: item.client_id,
      client_name: item.client_name,
      scope,
      resource: item.resource,
      version: 0,
      created_at: now,
      expires_at: now + REFRESH_SECONDS
    });
    const codeRow = row('OAUTHCODE#' + digest(code), {
      user_id: uid,
      family: fid,
      client_id: item.client_id,
      redirect_uri: item.redirect_uri,
      challenge: item.challenge,
      expires_at: now + 300
    });
    const changes: OAuthChange[] = [[{ ...item, used: true }, Number(item.revision)]];
    if (body.approve)
      changes.push(
        ...[family, tracked(family, uid), codeRow, tracked(codeRow, uid)].map((i) => [i, null] as OAuthChange)
      );
    if (!(await store.mcpCommit(changes, uid))) fail('request_expired');
    if (body.approve) await this.record(uid, 'connection.added', family, { via: 'web', scopes: scope });
    return back(item, body.approve ? { code } : { error: 'access_denied' });
  }
  /** An app's sign-in, in the owner's email-verified session: asked, it
   * answers the app's name, what it asked for and a name for its token;
   * approved, the token the owner chose (tokenFields: a name, the scopes
   * ticked from those asked for, an expiry) goes in a code, and nothing is
   * granted until the app spends it. */
  private async signIn(uid: string, item: OAuthRow, body: OAuthRow): Promise<OAuthRow> {
    const { store, now } = this.context,
      tokens = this.tokens();
    if (!Object.hasOwn(body, 'approve'))
      return {
        client_name: item.client_name,
        scope: item.scope,
        resource: '/v1',
        name: await tokens.nameFor(uid, item.client_name)
      };
    if (typeof body.approve !== 'boolean') fail();
    const code = newToken(),
      changes: OAuthChange[] = [[{ ...item, used: true }, Number(item.revision)]];
    if (body.approve) {
      const fields = tokenFields(body);
      if (scopes(fields.scope).some((s) => !scopes(item.scope).includes(s))) fail('invalid_scope');
      await tokens.room(uid, fields.name);
      const codeRow = row('OAUTHCODE#' + digest(code), {
        user_id: uid,
        client_id: item.client_id,
        client_name: item.client_name,
        redirect_uri: item.redirect_uri,
        challenge: item.challenge,
        resource: item.resource,
        name: fields.name,
        scope: fields.scope,
        expiry: fields.expiry,
        expires_at: now + CODE_SECONDS
      });
      changes.push([codeRow, null], [tracked(codeRow, uid), null]);
    }
    if (!(await store.mcpCommit(changes, uid))) fail('request_expired');
    return back(item, body.approve ? { code } : { error: 'access_denied' });
  }
  /** An app spends its code: the token is made in the same transaction that
   * marks the code used, and answered once. A code that comes back a second
   * time may have been stolen, so the token it made ends (RFC 6749, 4.1.2). */
  private async signedIn(body: Record<string, string>): Promise<OAuthRow> {
    const { store, now } = this.context;
    if (body.grant_type !== 'authorization_code') fail('unsupported_grant_type');
    const item = await store.mcpGet('OAUTHCODE#' + digest(body.code ?? ''));
    if (!item || item.client_id !== body.client_id || item.resource !== this.appResource) fail('invalid_grant');
    const uid = String(item.user_id),
      tokens = this.tokens();
    if (item.used) {
      if (item.token) await tokens.revoke(uid, String(item.token), 'token-reuse').catch(() => undefined);
      fail('invalid_grant');
    }
    if (!live(item, now) || !proved(item, body)) fail('invalid_grant');
    if (body.scope && body.scope !== item.scope) fail('invalid_scope');
    const profile = await store.mcpProfile(uid);
    if (!profile || profile.mcp_deleting) fail('invalid_grant');
    const fields = { name: String(item.name), scope: String(item.scope), expiry: String(item.expiry) };
    // Another token may have taken the name, or the last place, since.
    await tokens.room(uid, fields.name).catch(() => fail('invalid_grant'));
    const id = tokenId(),
      made = await tokens.issue(uid, fields, {
        id,
        client_id: String(item.client_id),
        app: String(item.client_name ?? ''),
        also: [[{ ...item, used: true, token: id }, Number(item.revision)]]
      });
    if (!made) fail('invalid_grant');
    const seconds = TOKEN_EXPIRY[fields.expiry];
    return {
      access_token: made.token,
      token_type: 'Bearer',
      scope: fields.scope,
      ...(seconds == null ? {} : { expires_in: seconds })
    };
  }
  /** An app's own sign out at /oauth/revoke, as `DELETE /v1/token` is. A
   * token already gone is signed out; any other failure is a 503, so the app
   * tries again rather than believing a token that still works has ended. */
  async signOut(pointer: OAuthRow): Promise<void> {
    if (pointer.revoked) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.tokens().revoke(String(pointer.user_id), String(pointer.token), 'client');
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return;
        if (!(error instanceof ApiError && error.error === 'try-again')) break;
      }
    }
    fail('temporarily_unavailable', 503);
  }
  async disconnect(uid: string, fid: string, writeOnly = false): Promise<{ ok: true }> {
    if (!writeOnly) {
      await this.revoke(fid, uid, 'owner');
      return { ok: true };
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.context.store.mcpGet('OAUTHFAMILY#' + fid);
      if (!live(item, this.context.now) || item.user_id !== uid || !scopes(item.scope).includes('notes:write'))
        return { ok: true };
      const to = scopes(item.scope)
        .filter((s) => !ADDING.includes(s))
        .join(' ');
      if (await this.context.store.mcpCommit([[{ ...item, scope: to }, Number(item.revision)]], uid)) {
        await this.record(uid, 'connection.changed', item, { via: 'web', from: item.scope, to });
        return { ok: true };
      }
    }
    return fail('temporarily_unavailable', 503);
  }
  /** Widen a live connection in place (Jamie, 2026-10-17: the new Upcoming
   * permission without "disconnecting and reconnecting"). The owner's
   * email-verified session is the consent, as it is on /connect/; the family
   * row is the live grant, so the existing token sees it on its next request. */
  async grant(uid: string, fid: string, scope: unknown): Promise<{ ok: true; scope: string }> {
    if (typeof scope !== 'string' || !Object.hasOwn(GRANTABLE, scope)) fail('invalid_scope');
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.context.store.mcpGet('OAUTHFAMILY#' + fid);
      if (!live(item, this.context.now) || item.user_id !== uid) fail('not_found', 404);
      const current = scopes(item.scope),
        needs = GRANTABLE[scope];
      if (current.includes(scope)) return { ok: true, scope: current.join(' ') };
      if (needs && !current.includes(needs)) fail('invalid_scope');
      const next = [...current, scope];
      if (await this.context.store.mcpCommit([[{ ...item, scope: next.join(' ') }, Number(item.revision)]], uid)) {
        await this.record(uid, 'connection.changed', item, { via: 'web', from: item.scope, to: next.join(' ') });
        return { ok: true, scope: next.join(' ') };
      }
    }
    return fail('temporarily_unavailable', 503);
  }
  async connections(uid: string): Promise<OAuthRow> {
    const { store, now } = this.context,
      refs = await store.mcpRows('OAUTHUSER#' + uid);
    const families = await Promise.all(
      refs.filter((i) => String(i.target).startsWith('OAUTHFAMILY#')).map((i) => store.mcpGet(String(i.target)))
    );
    const usage = new Map<string, number>();
    for (const item of await store.mcpRows('MCPMETA#' + uid)) {
      // Last use comes from USE# and LOG#; the daily reads rows keep ISO times.
      if (!/^(USE|LOG)#/.test(String(item.sk))) continue;
      const connection = String(item.sk).startsWith('USE#') ? String(item.sk).slice(4) : String(item.connection ?? '');
      if (connection && live(item, now)) usage.set(connection, Math.max(usage.get(connection) ?? 0, Number(item.at)));
    }
    return {
      connections: families
        .filter((f): f is OAuthRow => live(f, now))
        .map((f) => ({
          id: f.id,
          client_name: f.client_name,
          scope: f.scope,
          created_at: Number(f.created_at),
          last_used: usage.get(String(f.id)) ?? null
        }))
    };
  }
  async activity(uid: string): Promise<OAuthRow> {
    const rows = await this.context.store.mcpRows('MCPMETA#' + uid);
    return {
      activity: rows
        .filter((i) => String(i.sk).startsWith('LOG#') && live(i, this.context.now))
        .sort((a, b) => String(b.sk).localeCompare(String(a.sk)))
        .slice(0, 50)
        .map((i) => ({
          at: Number(i.at),
          ...Object.fromEntries(
            ['tool', 'outcome', 'connection', 'client', 'date', 'note_id']
              .filter((k) => Object.hasOwn(i, k))
              .map((k) => [k, i[k]])
          )
        }))
    };
  }
  async deleteUser(uid: string): Promise<void> {
    const store = this.context.store;
    await store.mcpBlock(uid);
    const refs = await store.mcpRows('OAUTHUSER#' + uid),
      metadata = await store.mcpRows('MCPMETA#' + uid);
    await store.deleteKeys([
      ...refs.map((i) => ({ pk: String(i.target), sk: 'STATE' })),
      ...[...refs, ...metadata].map((i) => ({ pk: String(i.pk), sk: String(i.sk) }))
    ]);
  }
  async limited(viewer: string, kind: string, ceiling: number): Promise<void> {
    if (
      (await this.context.store.count(
        `oauth:${kind}:${digest(network(viewer))}`,
        Math.floor(this.context.now / 3600),
        3600
      )) > ceiling
    )
      fail('rate_limited', 429);
  }
}

export const oauthResponse = (status: number, body: unknown, headers: HeadersInit = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...Object.fromEntries(new Headers(headers))
    }
  });
async function boundedText(request: Request, maximum: number): Promise<string> {
  if (Number(request.headers.get('content-length') ?? 0) > maximum) fail();
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > maximum) {
        await reader.cancel();
        fail();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return fail();
  }
}

/** HTTP only. Origin authentication is provided by CloudFront OAC;
 * viewer comes from trusted edge metadata, never an untrusted forwarded IP. */
export async function publicOAuth(
  context: OAuthContext,
  request: Request,
  options: { viewer: string }
): Promise<Response> {
  const service = new OAuthService(context),
    path = new URL(request.url).pathname;
  try {
    if (
      request.method === 'GET' &&
      ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(path)
    )
      return oauthResponse(200, {
        resource: service.resource,
        authorization_servers: [context.origin],
        scopes_supported: SCOPES,
        bearer_methods_supported: ['header']
      });
    if (request.method === 'GET' && path === '/.well-known/oauth-protected-resource/v1')
      return oauthResponse(200, {
        resource: service.appResource,
        authorization_servers: [context.origin],
        scopes_supported: APP_SCOPES,
        bearer_methods_supported: ['header']
      });
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server')
      return oauthResponse(200, {
        issuer: context.origin,
        authorization_endpoint: context.origin + '/oauth/authorize',
        token_endpoint: context.origin + '/oauth/token',
        registration_endpoint: context.origin + '/oauth/register',
        revocation_endpoint: context.origin + '/oauth/revoke',
        scopes_supported: [...new Set([...SCOPES, ...APP_SCOPES])].sort(),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none']
      });
    if (request.method === 'POST' && path === '/oauth/register') {
      await service.limited(options.viewer, 'register', 20);
      if ((await context.store.count('oauth:register:total', Math.floor(context.now / 3600), 3600)) > 200)
        fail('rate_limited', 429);
      let b: OAuthRow;
      try {
        b = JSON.parse((await boundedText(request, 64 * 1024)) || '{}') as OAuthRow;
      } catch (error) {
        if (error instanceof SyntaxError) fail();
        throw error;
      }
      if (!b || Array.isArray(b) || typeof b !== 'object') fail();
      const uris = b.redirect_uris,
        grants = b.grant_types ?? ['authorization_code', 'refresh_token'],
        responses = b.response_types ?? ['code'];
      if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5 || !uris.every(validRedirect))
        fail('invalid_redirect_uri');
      if (
        (b.token_endpoint_auth_method ?? 'none') !== 'none' ||
        !Array.isArray(grants) ||
        !grants.length ||
        !grants.every((g) => g === 'authorization_code' || g === 'refresh_token') ||
        !grants.includes('authorization_code') ||
        JSON.stringify(responses) !== JSON.stringify(['code'])
      )
        fail('invalid_client_metadata');
      const name = b.client_name ?? 'Agent';
      if (typeof name !== 'string' || codePointLength(name) > 100 || [...name].some((c) => c.codePointAt(0)! < 32))
        fail('invalid_client_metadata');
      const cid = newToken(),
        client = row('OAUTHCLIENT#' + cid, {
          client_id: cid,
          client_name: name,
          redirect_uris: uris,
          expires_at: context.now + 365 * 86400
        });
      if (!(await context.store.mcpCommit([[client, null]]))) fail('temporarily_unavailable', 503);
      return oauthResponse(201, {
        client_id: cid,
        client_name: name,
        redirect_uris: uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      });
    }
    if (request.method === 'GET' && path === '/oauth/authorize') {
      await service.limited(options.viewer, 'authorize', 60);
      const b = Object.fromEntries(new URL(request.url).searchParams),
        cid = b.client_id ?? '',
        redirect = b.redirect_uri ?? '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(cid)) fail('invalid_client');
      const client = await context.store.mcpGet('OAUTHCLIENT#' + cid);
      if (!live(client, context.now) || !(client.redirect_uris as string[]).includes(redirect)) fail('invalid_client');
      // An app signing in to /v1 asks for a token's scopes; an agent's
      // connection to /mcp always reads.
      const app = b.resource === service.appResource,
        requested = [
          ...new Set(scopes(b.scope ?? (app ? 'notes:write' : 'notes:read media:read notes:write upcoming')))
        ],
        challenge = b.code_challenge ?? '',
        state = b.state ?? '';
      if (
        b.response_type !== 'code' ||
        (b.resource !== service.resource && !app) ||
        b.code_challenge_method !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        requested.some((s) => !(app ? APP_SCOPES : SCOPES).includes(s)) ||
        (app
          ? !requested.length || (requested.includes('media:write') && !requested.includes('notes:write'))
          : !requested.includes('notes:read')) ||
        codePointLength(state) > 1024
      )
        fail();
      const pending = newToken(),
        item = row('OAUTHPENDING#' + pending, {
          client_id: cid,
          client_name: client.client_name,
          redirect_uri: redirect,
          scope: app ? APP_SCOPES.filter((s) => requested.includes(s)).join(' ') : requested.sort().join(' '),
          challenge,
          state,
          resource: app ? service.appResource : service.resource,
          expires_at: context.now + 600
        });
      if (!(await context.store.mcpCommit([[item, null]]))) fail('temporarily_unavailable', 503);
      return oauthResponse(303, '', { location: context.origin + '/connect/#request=' + pending });
    }
    if (request.method === 'POST' && ['/oauth/token', '/oauth/revoke'].includes(path)) {
      await service.limited(options.viewer, 'token', 120);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') fail();
      const pairs = new URLSearchParams(await boundedText(request, 8192)),
        b: Record<string, string> = {};
      for (const [key, value] of pairs) {
        if (Object.hasOwn(b, key)) fail();
        Object.defineProperty(b, key, { value, enumerable: true });
      }
      if (path === '/oauth/revoke') {
        for (const prefix of ['OAUTHACCESS#', 'OAUTHREFRESH#']) {
          const item = await context.store.mcpGet(prefix + digest(b.token ?? ''));
          // An API token made in Settings has no client_id: it is revoked
          // only through /v1 or Settings, never here. One an app signed in
          // for names its client, which may end it as its sign out.
          if (!item || !b.client_id || item.client_id !== b.client_id) continue;
          if (item.kind === 'token') await service.signOut(item);
          else await service.revoke(String(item.family), String(item.user_id), 'client');
        }
        return oauthResponse(200, {});
      }
      return oauthResponse(200, await service.exchange(b));
    }
    return oauthResponse(404, { error: 'not_found' });
  } catch (error) {
    if (error instanceof OAuthError) return oauthResponse(error.status, { error: error.error });
    throw error;
  }
}
