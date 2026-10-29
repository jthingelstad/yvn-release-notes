/** The public API, `/v1` (docs/API.md), on the MCP Web Function: the same
 * reader role, strong reads of the bearer, and every write handed to the
 * private capture function (workers/api-writes.ts), which checks the token
 * again in the transaction it writes. Only an API token opens it; no
 * cookie, and no MCP access token, is ever read here. Not for browsers: no
 * CORS, and any Origin but the site's is refused. */
import { activityId, ACTIVITY_FAMILIES, familyOf, tokenActivityView, titled } from '../../packages/domain/activity.ts';
import { addDays, iso, localDay, validDay } from '../../packages/domain/dates.ts';
import { writtenAt, type NoteRecord } from '../../packages/domain/notes.ts';
import { computeStreak, pauseDays } from '../../packages/domain/streak.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { tagRow, type TagRowStore } from '../../packages/backend/tag-row.ts';
import { checkToken, clientProduct, scopesOf, V1_LIMITS } from '../../packages/backend/tokens.ts';
import { failure, object } from './common.ts';
import { editRevision, record, type ReaderContext, type ReaderStore } from './reader.ts';
import type { McpOptions } from './app.ts';

export const API_VERSION = '1.0.0';
/** What each version changed, newest first, served as the OpenAPI file's
 * `x-changes`: `/v1` only ever gains things, and a deprecation is announced
 * here with its date. A new version starts with its entry. */
export const API_CHANGES: readonly { version: string; date: string; summary: string }[] = [
  {
    version: '1.0.0',
    date: '2026-10-29',
    summary:
      'The first version: who the token is and the days ahead, text notes, tags and pinned tags, and the activity log.'
  }
];
/** A request body's ceiling, which a 20,000-character note fits well within. */
export const V1_BODY = 128 * 1024;
/** How many days `/v1/me` gives versions for, today first: enough for a
 * phone to show the version and fire reminders offline for two weeks. */
export const ME_DAYS = 14;

const NOTE = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})$/,
  APPEND = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})\/append$/;

/** Every route: method, path, name, and the scope it needs (none: any token). */
export const V1_ROUTES: readonly {
  method: string;
  path: RegExp;
  template: string;
  name: string;
  scope: string | null;
}[] = [
  { method: 'GET', path: /^\/v1\/me$/, template: '/v1/me', name: 'me', scope: null },
  { method: 'POST', path: /^\/v1\/notes$/, template: '/v1/notes', name: 'notes.create', scope: 'notes:write' },
  { method: 'GET', path: NOTE, template: '/v1/notes/{date}/{id}', name: 'note', scope: 'notes:write' },
  { method: 'PUT', path: NOTE, template: '/v1/notes/{date}/{id}', name: 'notes.edit', scope: 'notes:write' },
  { method: 'DELETE', path: NOTE, template: '/v1/notes/{date}/{id}', name: 'notes.delete', scope: 'notes:write' },
  {
    method: 'POST',
    path: APPEND,
    template: '/v1/notes/{date}/{id}/append',
    name: 'notes.append',
    scope: 'notes:write'
  },
  { method: 'GET', path: /^\/v1\/tags$/, template: '/v1/tags', name: 'tags', scope: null },
  {
    method: 'PUT',
    path: /^\/v1\/tags\/pinned$/,
    template: '/v1/tags/pinned',
    name: 'tags.pinned',
    scope: 'notes:write'
  },
  { method: 'GET', path: /^\/v1\/activity$/, template: '/v1/activity', name: 'activity', scope: 'activity' },
  { method: 'DELETE', path: /^\/v1\/token$/, template: '/v1/token', name: 'token.revoke', scope: null }
];

/** Every error code and its status (docs/API.md, Errors). */
export const V1_ERRORS: Record<string, number> = {
  invalid_request: 400,
  text_required: 400,
  date_out_of_range: 400,
  token_missing: 401,
  token_unknown: 401,
  token_revoked: 401,
  token_expired: 401,
  scope_required: 403,
  not_yours: 403,
  origin_refused: 403,
  not_found: 404,
  method_not_allowed: 405,
  revision_mismatch: 409,
  account_closing: 409,
  busy: 409,
  too_large: 413,
  idempotency_mismatch: 422,
  rate_limited: 429,
  unavailable: 503
};
const MESSAGES: Record<string, string> = {
  token_missing: 'Send a token as Authorization: Bearer rn_... Make one in Release Notes under Settings, API tokens.',
  token_unknown: "That isn't a token Release Notes made. Make one under Settings, API tokens.",
  token_revoked: 'This token was revoked. Make a new one under Settings, API tokens.',
  token_expired: 'This token expired. Make a new one under Settings, API tokens.',
  account_closing: 'This account is being deleted.',
  origin_refused: "/v1 isn't for browsers.",
  not_found: 'There is no such request. The API is described at /guide/api/.',
  method_not_allowed: "That method isn't used here.",
  busy: 'Try again shortly with the same Idempotency-Key.',
  too_large: 'A request can be at most 128 KB.',
  unavailable: 'Try again shortly with the same Idempotency-Key.'
};
const SCOPE_MESSAGES: Record<string, string> = {
  'notes:write': "This token can't add notes. Make a token with Add notes ticked.",
  activity: "This token can't read the activity log. Make a token that may read it."
};

type V1Store = ReaderStore & TagRowStore;
type Headers = Record<string, string>;

function wantsPlain(request: Request): boolean {
  return (request.headers.get('accept') ?? '').split(',')[0]!.trim().toLowerCase().startsWith('text/plain');
}

/** One answer: JSON, or a line for a terminal that asked for text. */
function respond(status: number, body: unknown, plain: string | null, headers: Headers): Response {
  const base: Headers = { 'cache-control': 'no-store', 'api-version': API_VERSION, ...headers };
  if (status === 204) return new Response(null, { status, headers: base });
  if (plain !== null)
    return new Response(plain + '\n', { status, headers: { ...base, 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...base, 'content-type': 'application/json; charset=utf-8' }
  });
}

function refuse(code: string, asText: boolean, headers: Headers = {}, detail = '', extra: OAuthRow = {}): Response {
  const status = V1_ERRORS[code] ?? 400,
    message = detail || MESSAGES[code] || 'That request was refused.',
    more: Headers = { ...headers };
  if (status === 401) more['www-authenticate'] = 'Bearer realm="Release Notes"';
  if (typeof extra.retry_after === 'number') more['retry-after'] = String(extra.retry_after);
  const error: OAuthRow = { code, message };
  for (const k of ['field', 'revision']) if (extra[k] != null) error[k] = extra[k];
  return respond(status, { error }, asText ? message : null, more);
}

/** The body, at most 128 KB, as UTF-8 text; null when it was over. */
async function bodyText(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > V1_BODY) return null;
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > V1_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** A token's reads a UTC day, counted in MCPMETA as MCP's own counts are. */
async function readQuota(context: ReaderContext, uid: string, tid: string): Promise<boolean> {
  const day = Math.floor(context.now / 86400),
    key = `TOKENREADS#${tid}#${day}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const old = await context.store.mcpGet(`MCPMETA#${uid}`, key),
      n = Number(old?.n ?? 0);
    if (n >= V1_LIMITS.reads) return false;
    if (
      await context.store.mcpCommit(
        [
          [
            { pk: `MCPMETA#${uid}`, sk: key, n: n + 1, expires_at: (day + 2) * 86400 },
            old ? Number(old.revision) : null
          ]
        ],
        uid
      )
    )
      return true;
  }
  throw new Error('Read count unavailable');
}

const until = (now: number) => (Math.floor(now / 86400) + 1) * 86400 - now;

export async function handleV1(request: Request, options: McpOptions): Promise<Response> {
  const asText = wantsPlain(request);
  let context: ReaderContext | undefined,
    uid = 'unknown';
  try {
    context = await options.context();
    const store = context.store as V1Store,
      now = context.now;
    if (request.headers.has('origin') && request.headers.get('origin') !== context.origin)
      return refuse('origin_refused', asText);
    const path = new URL(request.url).pathname,
      candidates = V1_ROUTES.filter((r) => r.path.test(path)),
      route = candidates.find((r) => r.method === request.method);
    if (!candidates.length) return refuse('not_found', asText);
    if (!route)
      return refuse('method_not_allowed', asText, { allow: [...new Set(candidates.map((r) => r.method))].join(', ') });
    const check = await checkToken(store, context.origin, now, request.headers.get('authorization'));
    if (!check.ok) return refuse(check.code, asText);
    const { token, profile } = check,
      tid = String(token.id),
      tz = String(profile.tz),
      today = localDay(now, tz),
      birthday = String(profile.birthday),
      version = computeVersion(birthday, today).toString(),
      headers: Headers = { 'release-notes-version': version },
      scopes = scopesOf(token),
      family = { user_id: token.user_id, id: tid, client_name: token.name, kind: 'token' },
      params = (route.path.exec(path) ?? []).slice(1);
    uid = String(token.user_id);
    if (route.scope && !scopes.includes(route.scope))
      return refuse('scope_required', asText, headers, SCOPE_MESSAGES[route.scope]);

    // Writes go on to the capture function, which proves the token again.
    if (route.method !== 'GET') {
      let args: OAuthRow = {};
      if (route.name !== 'notes.delete' && route.name !== 'token.revoke') {
        const raw = await bodyText(request).catch(() => undefined);
        if (raw === null) return refuse('too_large', asText, headers);
        if (raw === undefined) return refuse('invalid_request', asText, headers, 'Send the body as UTF-8.');
        const json =
          (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
        if (json) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return refuse('invalid_request', asText, headers, "The body isn't JSON.");
          }
          if (!object(parsed)) return refuse('invalid_request', asText, headers, 'The body is a JSON object.');
          args = parsed;
        } else if (route.name === 'notes.create') args = { text: raw };
        else return refuse('invalid_request', asText, headers, 'Send a JSON body with Content-Type: application/json.');
      }
      if (params.length) Object.assign(args, { date: params[0], id: params[1] });
      const key = request.headers.get('idempotency-key');
      if (key !== null && !/^[\x20-\x7e]{1,128}$/.test(key.trim()))
        return refuse(
          'invalid_request',
          asText,
          headers,
          'An Idempotency-Key is 1 to 128 printable ASCII characters.',
          {
            field: 'Idempotency-Key'
          }
        );
      const captured = await options.capture({
        api: route.name,
        token: String(request.headers.get('authorization')).slice(7).trim(),
        arguments: args,
        key: key?.trim() ?? null,
        client: clientProduct(request.headers.get('user-agent'))
      });
      if (!object(captured)) throw new Error('Capture response unavailable');
      if (typeof captured.error === 'string') {
        if (!(await record(context, family, 'v1:' + route.name, captured.error)))
          options.log?.({ event: 'activity-unrecorded', kind: 'reads', user: uid });
        return refuse(captured.error, asText, headers, String(captured.message ?? ''), captured);
      }
      const status = Number(captured.status),
        body = (captured.body ?? null) as OAuthRow | null,
        limit = object(captured.limit) ? captured.limit : null,
        extra: Headers = { ...headers };
      if (captured.replayed) extra['idempotent-replayed'] = 'true';
      if (limit)
        Object.assign(extra, {
          'ratelimit-limit': String(limit.limit),
          'ratelimit-remaining': String(limit.remaining),
          'ratelimit-reset': String(limit.reset)
        });
      const note = object(body?.note) ? body.note : null,
        unlocked = Array.isArray(body?.unlocked) ? (body.unlocked as OAuthRow[]) : [];
      let line: string | null = null;
      if (asText)
        line =
          route.name === 'tags.pinned'
            ? ((body?.pinned as string[] | undefined) ?? []).map((t) => '#' + t).join(' ') || 'No pinned tags.'
            : note
              ? `${route.name === 'notes.create' ? 'Filed' : 'Changed'} in ${String(note.version)}.` +
                (unlocked.length ? ` Unlocked: ${unlocked.map((u) => String(u.name)).join(', ')}.` : '')
              : '';
      return respond(status, body, line, extra);
    }

    // Reads: counted a token a day, and summed into its reads row.
    if (!(await readQuota(context, uid, tid)))
      return refuse('rate_limited', asText, headers, `That's today's ${V1_LIMITS.reads} reads for this token.`, {
        retry_after: until(now)
      });
    type Read = { status: number; body: unknown; line: string } | { code: string; message: string; extra?: OAuthRow };
    const read = async (): Promise<Read> => {
      if (route.name === 'me') {
        const [days, pauses] = await Promise.all([store.noteDays(uid), store.pauses(uid, true)]),
          have = new Set(days),
          streak = computeStreak(have, have.has(today) ? addDays(today, 1) : today, pauseDays(pauses, today)),
          paused = String(profile.pause_through ?? '') >= today && profile.pause_from ? profile.pause_through : null;
        return {
          status: 200,
          body: {
            today,
            version,
            tz,
            send_time: profile.send_time ?? '06:00',
            wrote_today: have.has(today),
            streak: streak.current,
            paused_until: paused,
            status: profile.status ?? 'active',
            show_badges: profile.badges !== false,
            days: Array.from({ length: ME_DAYS }, (_, i) => {
              const date = addDays(today, i);
              return { date, version: computeVersion(birthday, date).toString() };
            }),
            token: {
              name: token.name,
              scopes,
              expires_at: token.expires_at == null ? null : iso(Number(token.expires_at))
            },
            api_version: API_VERSION
          },
          line: `You're ${version} today.`
        };
      }
      if (route.name === 'tags') {
        const row = await tagRow(store, uid, profile, today);
        return {
          status: 200,
          body: row,
          line: [...row.pinned.map((t) => '#' + t), ...row.recent.map((r) => '#' + r.tag)].join(' ') || 'No tags yet.'
        };
      }
      if (route.name === 'note') {
        const [date, id] = params as [string, string];
        if (!validDay(date)) return { code: 'not_found', message: 'There is no note with that date and id.' };
        const item = await store.note(uid, date, id, true);
        if (!item) return { code: 'not_found', message: 'There is no note with that date and id.' };
        if (item.source !== 'api' || item.connection !== tid)
          return { code: 'not_yours', message: 'A token reads only the notes it wrote.' };
        return {
          status: 200,
          body: {
            id,
            date,
            version: String(item.version ?? computeVersion(birthday, date).toString()),
            text: String(item.text ?? ''),
            revision: editRevision(item),
            written_at: writtenAt(item as NoteRecord) || null,
            files: ((item.media as OAuthRow[] | undefined) ?? []).length,
            token: item.token ?? null
          },
          line: String(item.text ?? '')
        };
      }
      // The activity log, trimmed of words (packages/domain/activity.ts).
      const url = new URL(request.url),
        q = url.searchParams,
        cursor = (field: string) => {
          const value = q.get(field);
          if (value === null) return undefined;
          if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[a-z.]+#[A-Za-z0-9_.-]{1,120}$/.test(value)) throw new Error(field);
          return value;
        };
      let before: string | undefined, after: string | undefined;
      try {
        before = cursor('before');
        after = cursor('after');
      } catch (error) {
        const field = (error as Error).message;
        return { code: 'invalid_request', message: `${field} is an id from an earlier answer.`, extra: { field } };
      }
      const kinds = q.get('kinds')
        ? q
            .get('kinds')!
            .split(',')
            .map((k) => k.trim())
        : null;
      if (kinds && kinds.some((k) => !(ACTIVITY_FAMILIES as readonly string[]).includes(k)))
        return {
          code: 'invalid_request',
          message: `kinds are some of ${ACTIVITY_FAMILIES.join(', ')}.`,
          extra: { field: 'kinds' }
        };
      const limit = q.get('limit') === null ? 50 : Number(q.get('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return { code: 'invalid_request', message: 'limit is 1 to 100.', extra: { field: 'limit' } };
      const upcoming = scopes.includes('upcoming'),
        titles = upcoming ? new Map((await store.upcomingEntries(uid)).map((e) => [e.id, e.title])) : null,
        items: OAuthRow[] = [];
      let more = false,
        read = 0,
        from = before;
      scan: for (;;) {
        const page = await store.activity(uid, { before: from, ...(after ? { from: after } : {}), limit: 200 });
        for (const row of page.rows) {
          const id = activityId(String(row.sk));
          if (id === after) continue;
          if (!kinds || kinds.includes(familyOf(String(row.kind)))) {
            if (items.length >= limit) {
              more = true;
              break scan;
            }
            const view = tokenActivityView(row);
            items.push(titles ? titled(view, titles) : view);
          }
          from = id;
          if (++read >= 2000) {
            more = page.more || row !== page.rows.at(-1);
            break scan;
          }
        }
        if (!page.more) break;
      }
      return {
        status: 200,
        body: { items, next: more ? from : null },
        line: items
          .map((i) => `${String(i.at)} ${String(i.kind)}${i.token ? ` via ${String(i.token)}` : ''}`)
          .join('\n')
      };
    };
    const outcome = await read();
    if (!(await record(context, family, 'v1:' + route.name, 'code' in outcome ? outcome.code : 'ok', tz)))
      options.log?.({ event: 'activity-unrecorded', kind: 'reads', user: uid });
    if ('code' in outcome) return refuse(outcome.code, asText, headers, outcome.message, outcome.extra);
    return respond(outcome.status, outcome.body, asText ? outcome.line : null, headers);
  } catch (error) {
    failure(context?.now ?? Math.floor(Date.now() / 1000), uid, options.log, error);
    return refuse('unavailable', asText);
  }
}
