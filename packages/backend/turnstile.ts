/** Cloudflare Turnstile: is a person asking us to email this address?
 *
 * `POST /api/auth/start` mails a link and code to whatever address is typed,
 * and it is the only public request that does (the MCP connector signs in
 * through the same page). Subscription bombing is why it carries a Turnstile
 * token (2026-10-14): bots type a victim's real address into forms so our mail
 * fills their inbox, and this SES account also sends Elixir's mail, so abuse
 * here hurts both products' deliverability. The address, network and total
 * hourly limits (`auth.ts`) stay in front of the mail either way.
 *
 * Modes (`TURNSTILE_MODE`, default `DEFAULT_TURNSTILE_MODE`):
 * - `observe` checks and logs every token and never refuses anyone.
 * - `enforce` refuses only a token that is missing or that Cloudflare
 *   rejected. A Cloudflare script outage also means a missing token, so
 *   enforce is its own later decision. Cloudflare unreachable (`error`) or
 *   no secret (`unconfigured`) always goes ahead.
 * - `off` skips the check.
 *
 * One token serves one address for five minutes, three times. A token is
 * single-use at Cloudflare and the page reuses it for "send it again", so the
 * verdict is kept in the table (`TURNSTILE#<sha256 of token>`, bound to the
 * address's hash) and a repeat reuses it. A token presented for another
 * address, a fourth time or after five minutes fails.
 */
import { digest } from './auth.ts';
import type { Store } from './store.ts';

/** Widget "Release Notes sign-in" (managed, notes.yourversionnumber.com). Public. */
export const TURNSTILE_SITE_KEY = '0x4AAAAAAFW0y7cvQQshNAwH';
export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Flip to 'enforce' only once the observe numbers show people pass. */
export const DEFAULT_TURNSTILE_MODE: TurnstileMode = 'observe';
export const TOKEN_SECONDS = 300;
export const MAX_TOKEN_USES = 3;
const VERIFY_TIMEOUT_MS = 4000;

export type TurnstileMode = 'off' | 'observe' | 'enforce';
/**
 * pass / fail: Cloudflare's answer. missing: the page sent no token.
 * error: Cloudflare or the secret could not be read. unconfigured: no secret.
 */
export type TurnstileResult = 'pass' | 'fail' | 'missing' | 'error' | 'unconfigured' | 'off';

export interface TurnstileVerdict {
  result: TurnstileResult;
  mode: TurnstileMode;
  /** True when the request may go ahead. Always true outside enforce mode. */
  allowed: boolean;
  /** The verdict came from an earlier request with the same token. */
  reused: boolean;
  codes: string[];
  hostname?: string;
  action?: string;
}

export interface TurnstileConfig {
  /** `TURNSTILE_MODE`; anything else means the default. */
  mode?: string;
  /** The widget's secret, or '' while there is none. Throws when it cannot be read. */
  secret?: () => Promise<string>;
  fetch?: typeof fetch;
}

export function turnstileMode(raw?: string): TurnstileMode {
  const mode = String(raw ?? '')
    .trim()
    .toLowerCase();
  return mode === 'off' || mode === 'observe' || mode === 'enforce' ? mode : DEFAULT_TURNSTILE_MODE;
}

/** Enforce refuses only a token that is absent or that Cloudflare rejected. */
export function turnstileAllows(mode: TurnstileMode, result: TurnstileResult): boolean {
  return mode !== 'enforce' || (result !== 'fail' && result !== 'missing');
}

/** The page's `turnstile_token`; Cloudflare documents 2048 characters at most. */
export function turnstileToken(body: Record<string, unknown>): string {
  const raw = body.turnstile_token;
  return typeof raw === 'string' ? raw.trim().slice(0, 2048) : '';
}

async function siteverify(
  fetcher: typeof fetch,
  secret: string,
  token: string,
  viewer: string
): Promise<{ result: 'pass' | 'fail' | 'error'; codes: string[]; hostname?: string; action?: string }> {
  const form = new URLSearchParams({ secret, response: token });
  if (viewer) form.set('remoteip', viewer);
  try {
    const response = await fetcher(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS)
    });
    if (!response.ok) return { result: 'error', codes: [`http-${response.status}`] };
    const data = (await response.json()) as {
      success?: unknown;
      'error-codes'?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    const codes = Array.isArray(data['error-codes'])
      ? data['error-codes'].map((code) => String(code).slice(0, 40)).slice(0, 5)
      : [];
    // A rejected secret is our fault, not the visitor's.
    if (data.success !== true && codes.some((code) => code.includes('secret'))) return { result: 'error', codes };
    return {
      result: data.success === true ? 'pass' : 'fail',
      codes,
      ...(typeof data.hostname === 'string' ? { hostname: data.hostname.slice(0, 253) } : {}),
      ...(typeof data.action === 'string' ? { action: data.action.slice(0, 32) } : {})
    };
  } catch (error) {
    return { result: 'error', codes: [(error as Error)?.name || 'Error'] };
  }
}

/**
 * Check one email-sending request's token. Never throws: the verdict says
 * whether to go ahead (`allowed`) and what to log (`result`).
 */
export async function checkTurnstile(input: {
  token: string;
  email: string;
  viewer: string;
  store: Store;
  now: number;
  config?: TurnstileConfig;
}): Promise<TurnstileVerdict> {
  const config = input.config ?? {},
    mode = turnstileMode(config.mode);
  const done = (result: TurnstileResult, codes: string[] = [], reused = false, extra = {}): TurnstileVerdict => ({
    result,
    mode,
    allowed: turnstileAllows(mode, result),
    reused,
    codes,
    ...extra
  });
  if (mode === 'off') return done('off');
  if (!input.token) return done('missing');
  let secret = '';
  try {
    secret = config.secret ? await config.secret() : '';
  } catch {
    return done('error', ['secret-lookup']);
  }
  if (!secret) return done('unconfigured');

  const tokenHash = digest(input.token),
    emailHash = digest(input.email);
  try {
    const cached = await input.store.turnstileVerdict(tokenHash);
    if (cached && Number(cached.verified_at) > input.now - TOKEN_SECONDS) {
      if (cached.email_hash !== emailHash) return done('fail', ['token-other-address'], true);
      if (!(await input.store.useTurnstileVerdict(tokenHash, emailHash, MAX_TOKEN_USES)))
        return done('fail', ['token-used-up'], true);
      return done(
        cached.result === 'pass' ? 'pass' : 'fail',
        String(cached.codes ?? '')
          .split(',')
          .filter(Boolean),
        true
      );
    }
    // An expired verdict is spent: Cloudflare would answer timeout-or-duplicate.
    if (cached) return done('fail', ['token-expired'], true);
  } catch {
    // A table hiccup must not decide a sign-in; ask Cloudflare instead.
  }

  const answer = await siteverify(config.fetch ?? fetch, secret, input.token, input.viewer);
  if (answer.result !== 'error') {
    try {
      await input.store.saveTurnstileVerdict(tokenHash, {
        result: answer.result,
        email_hash: emailHash,
        codes: answer.codes.join(','),
        now: input.now,
        ttl: TOKEN_SECONDS * 2
      });
    } catch {
      // Without the verdict a "send it again" asks Cloudflare and fails as a duplicate.
    }
  }
  const { result, codes, ...extra } = answer;
  return done(result, codes, false, extra);
}
