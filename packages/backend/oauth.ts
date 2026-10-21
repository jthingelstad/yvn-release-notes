/** Email-owner approved OAuth connections. Browser consent is separate from
 * public OAuth, tokens are hash-only, and family/profile proofs are durable.
 * No bearer can authenticate an application session or a general web write. */
import { createHash } from 'node:crypto';
import { digest, network, newToken, same } from './auth.ts';
import { codePointLength } from '../domain/unicode.ts';
import type { ActivityEvent } from '../domain/activity.ts';
import { recordActivity } from './activity.ts';
import { safeLog, type Log } from './services.ts';
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
export const SCOPES = ['media:read', 'notes:read', 'notes:write', 'upcoming'];
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
export function live(item: OAuthRow | null | undefined, now: number): item is OAuthRow {
  return Boolean(item && Number(item.expires_at ?? now + 1) > now && !item.revoked);
}
const row = (pk: string, fields: OAuthRow = {}): OAuthRow => ({ pk, sk: 'STATE', ...fields });
const tracked = (item: OAuthRow, uid: string): OAuthRow =>
  row(`OAUTHUSER#${uid}`, { sk: `ROW#${item.pk}`, target: item.pk, expires_at: item.expires_at });
/** Scopes an owner can add to a live connection from Settings. */
const GRANTABLE = ['upcoming'];
const scopes = (value: unknown): string[] =>
  String(value ?? '')
    .split(/\s+/)
    .filter(Boolean);
export function validRedirect(uri: unknown): uri is string {
  if (
    typeof uri !== 'string' ||
    codePointLength(uri) > 2048 ||
    [...uri].some((c) => c.codePointAt(0)! < 33) ||
    uri.includes('#') ||
    uri.includes('\\')
  )
    return false;
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
      id: String(family.id),
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
      const verifier = body.code_verifier ?? '',
        challenge = createHash('sha256').update(verifier).digest('base64url');
      if (
        !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) ||
        !same(challenge, String(item.challenge)) ||
        body.redirect_uri !== item.redirect_uri
      )
        fail('invalid_grant');
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
    if (!Object.hasOwn(body, 'approve')) return { client_name: item.client_name, scope: item.scope };
    if (
      typeof body.approve !== 'boolean' ||
      typeof (Object.hasOwn(body, 'media') ? body.media : false) !== 'boolean' ||
      typeof (Object.hasOwn(body, 'write') ? body.write : false) !== 'boolean' ||
      typeof (Object.hasOwn(body, 'upcoming') ? body.upcoming : false) !== 'boolean'
    )
      fail();
    if (body.write && !scopes(item.scope).includes('notes:write')) fail('invalid_scope');
    // Upcoming is offered on every consent screen whatever the client asked for
    // (Jamie, 2026-10-17: the connect screen "does not reference anything for
    // upcoming"): clients re-request the scopes they were first granted, and
    // the owner can add it to a live connection from Settings anyway.
    const scope =
      'notes:read' +
      (body.media && scopes(item.scope).includes('media:read') ? ' media:read' : '') +
      (body.write ? ' notes:write' : '') +
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
    const params = new URLSearchParams(body.approve ? { code } : { error: 'access_denied' });
    if (item.state) params.set('state', String(item.state));
    return {
      redirect: String(item.redirect_uri) + (String(item.redirect_uri).includes('?') ? '&' : '?') + params.toString()
    };
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
        .filter((s) => s !== 'notes:write')
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
    if (typeof scope !== 'string' || !GRANTABLE.includes(scope)) fail('invalid_scope');
    for (let attempt = 0; attempt < 5; attempt++) {
      const item = await this.context.store.mcpGet('OAUTHFAMILY#' + fid);
      if (!live(item, this.context.now) || item.user_id !== uid) fail('not_found', 404);
      const current = scopes(item.scope);
      if (current.includes(scope)) return { ok: true, scope: current.join(' ') };
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
    if (request.method === 'GET' && path === '/.well-known/oauth-authorization-server')
      return oauthResponse(200, {
        issuer: context.origin,
        authorization_endpoint: context.origin + '/oauth/authorize',
        token_endpoint: context.origin + '/oauth/token',
        registration_endpoint: context.origin + '/oauth/register',
        revocation_endpoint: context.origin + '/oauth/revoke',
        scopes_supported: SCOPES,
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
      const requested = [...new Set(scopes(b.scope ?? 'notes:read media:read notes:write upcoming'))],
        challenge = b.code_challenge ?? '',
        state = b.state ?? '';
      if (
        b.response_type !== 'code' ||
        b.resource !== service.resource ||
        b.code_challenge_method !== 'S256' ||
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        requested.some((s) => !SCOPES.includes(s)) ||
        !requested.includes('notes:read') ||
        codePointLength(state) > 1024
      )
        fail();
      const pending = newToken(),
        item = row('OAUTHPENDING#' + pending, {
          client_id: cid,
          client_name: client.client_name,
          redirect_uri: redirect,
          scope: requested.sort().join(' '),
          challenge,
          state,
          resource: service.resource,
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
          if (item && item.client_id === b.client_id)
            await service.revoke(String(item.family), String(item.user_id), 'client');
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
