// Cloudflare Turnstile for the one request that emails a typed address,
// POST /api/auth/start (sign-in, sign-up and "send it again"). The server
// checks the token (packages/backend/turnstile.ts); in observe mode it only
// records the answer.
//
// Cloudflare's script loads only once someone focuses or types in the email
// field, never on a plain visit. Most people see nothing (interaction-only);
// a doubtful browser gets a checkbox under the form. If the script cannot
// load, the request goes without a token and the server decides. A request
// without a token says why (`turnstile_reason`), and every request says how
// long it waited (`turnstile_wait_ms`), so the observe numbers can tell a
// content blocker from a slow answer before anyone enforces. The slot is
// shown only while Cloudflare is asking (`data-turnstile="asking"`); once it
// has answered, the box collapses ("quiet") rather than leave "Success!"
// sitting on the next step.
//
// Cloudflare's error-callback is not the end. Most of its errors are worth
// another try (its error-code table; one real sign-in was lost to 600010,
// 2026-10-30), but its own retry comes eight seconds later, after the five
// second wait. So the widget renders with `retry: 'never'`, and an error worth
// retrying resets it a second later, at most twice in a row; a request waiting
// keeps its usual wait (five seconds, or two minutes while a checkbox shows)
// and, if that runs out, goes without a token, the last error as its reason.
// Returning true tells Cloudflare the error was handled (no console warning).
//
// A token is single-use at Cloudflare, but the server keeps its verdict for
// five minutes and three uses, bound to the address it came with, so one
// token covers the first email and a resend. A new address, a fourth use or
// an old token gets a fresh one.
import { useState } from 'react';

// Widget "Release Notes sign-in"; the site key is public.
export const SITE_KEY = '0x4AAAAAAFW0y7cvQQshNAwH';
export const SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=releaseNotesTurnstileLoaded';
const QUIET_WAIT_MS = 5000;
const INTERACTIVE_WAIT_MS = 120000;
const MAX_USES = 3;
const MAX_AGE_MS = 270000;
const RETRY_AFTER_MS = 1000;
const MAX_RETRIES = 2;

// Cloudflare's error codes that a retry cannot mend: a bad, unknown or
// disabled site key, a domain the widget does not list, a wrong clock
// (troubleshooting/client-side-errors/error-codes). Every other code is tried
// again.
const FINAL_ERRORS = /^(1101(00|10)|110200|200100|4000(20|21|70))$/;
export const retryable = (code: string) => !FINAL_ERRORS.test(code);

interface RenderOptions {
  sitekey: string;
  action: string;
  appearance: 'interaction-only';
  'refresh-expired': 'auto';
  retry: 'never';
  callback: (token: string) => void;
  'expired-callback': () => void;
  'before-interactive-callback': () => void;
  'error-callback': (code?: string) => boolean;
}
export interface TurnstileApi {
  render(container: HTMLElement, options: RenderOptions): string;
  reset(id: string): void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
    releaseNotesTurnstileLoaded?: () => void;
  }
}

let loading: Promise<TurnstileApi> | null = null;

// Checked by shape: an element with id "turnstile" would also be
// window.turnstile (named access), so never give the slot that id.
const loaded = () => (typeof window.turnstile?.render === 'function' ? window.turnstile : null);

function loadScript(): Promise<TurnstileApi> {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const ready = loaded();
    if (ready) return resolve(ready);
    window.releaseNotesTurnstileLoaded = () => {
      const api = loaded();
      if (api) resolve(api);
      else reject(new Error('turnstile-unavailable'));
    };
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onerror = () => {
      loading = null; // the next visit to the field tries again
      reject(new Error('turnstile-blocked'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Why a request went without a token: `no-slot` (nowhere to render),
 * `script-blocked` (the script did not load: a content blocker or the
 * network), `script-empty` (it loaded without the API), `error:<code>`
 * (Cloudflare's error-callback), `loading-timeout` / `solving-timeout` (five
 * seconds passed before the script loaded / before it answered) and
 * `interactive-timeout` (two minutes on a visible challenge); `no-widget`
 * when none of those applies.
 */
export type TurnstileReason = string;

export interface TurnstileFields {
  turnstile_token: string;
  turnstile_wait_ms: number;
  turnstile_reason?: TurnstileReason;
}

export interface TurnstileHandle {
  warm(): void;
  tokenFor(email: string): Promise<string>;
  /** The sign-in request's Turnstile fields for this address. */
  fieldsFor(email: string): Promise<TurnstileFields>;
}

export function attachTurnstile(
  slot: () => HTMLElement | null,
  action: string,
  load: () => Promise<TurnstileApi> = loadScript
): TurnstileHandle {
  let api: TurnstileApi | null = null;
  let widgetId: string | null = null;
  let token = '';
  let issuedAt = 0;
  let uses = 0;
  let boundEmail = '';
  let interactive = false;
  let unavailable = false;
  // The latest failure, kept for the request that waited on it.
  let failure: TurnstileReason = '';
  let lastReason: TurnstileReason = '';
  let lastWaitMs = 0;
  let waiters: (() => void)[] = [];
  // Resets since the last token, and the one waiting to happen.
  let retries = 0;
  let retryTimer: number | undefined;

  const settle = () => {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  };

  function warm() {
    const container = slot();
    if (widgetId !== null || unavailable) return;
    if (!container) {
      failure = 'no-slot';
      return;
    }
    widgetId = 'pending';
    failure = '';
    const showing = (asking: boolean) => (container.dataset.turnstile = asking ? 'asking' : 'quiet');
    showing(false);
    load().then(
      (loaded) => {
        api = loaded;
        widgetId = loaded.render(container, {
          sitekey: SITE_KEY,
          action,
          appearance: 'interaction-only',
          'refresh-expired': 'auto',
          retry: 'never',
          callback: (value) => {
            token = value;
            failure = '';
            retries = 0;
            issuedAt = Date.now();
            uses = 0;
            boundEmail = '';
            interactive = false;
            showing(false);
            settle();
          },
          'expired-callback': () => {
            token = '';
          },
          'before-interactive-callback': () => {
            interactive = true;
            showing(true);
          },
          'error-callback': (code) => {
            token = '';
            const clean =
              String(code ?? '')
                .replace(/[^a-z0-9]/gi, '')
                .slice(0, 12) || 'unknown';
            failure = `error:${clean}`;
            interactive = false;
            showing(false);
            if (retryable(clean) && retries < MAX_RETRIES) {
              retries += 1;
              retryLater();
            }
            settle();
            return true;
          }
        });
      },
      (error: unknown) => {
        // Submit without a token; a later focus may try the script again.
        failure = (error as Error)?.message === 'turnstile-blocked' ? 'script-blocked' : 'script-empty';
        widgetId = null;
        unavailable = true;
        settle();
        window.setTimeout(() => (unavailable = false), 30000);
      }
    );
  }

  function resetWidget() {
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    if (api && widgetId !== null && widgetId !== 'pending') {
      try {
        api.reset(widgetId);
      } catch {
        // A widget that is gone renders afresh on the next warm().
      }
    }
  }

  // Cloudflare's own retry, sooner: the failure stays the reason until a
  // token comes.
  function retryLater() {
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(resetWidget, RETRY_AFTER_MS);
  }

  function reset() {
    token = '';
    failure = '';
    uses = 0;
    boundEmail = '';
    resetWidget();
  }

  const fresh = (email: string) =>
    !!token && uses < MAX_USES && Date.now() - issuedAt <= MAX_AGE_MS && (!boundEmail || boundEmail === email);

  // A token for this address, or '' when none came in time.
  function tokenFor(raw: string): Promise<string> {
    const email = raw.trim().toLowerCase();
    warm();
    if (token && !fresh(email)) reset();
    // An error left over from earlier, with its retries spent or not worth
    // one: this request gets one more try, inside its own wait.
    else if (!token && failure.startsWith('error:') && retryTimer === undefined) {
      retries = MAX_RETRIES;
      resetWidget();
    }
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = (timedOut = false) => {
        lastWaitMs = Date.now() - started;
        if (!token) {
          // An error Cloudflare reported says more than the wait that followed it.
          lastReason =
            failure ||
            (timedOut
              ? interactive
                ? 'interactive-timeout'
                : widgetId === 'pending'
                  ? 'loading-timeout'
                  : 'solving-timeout'
              : 'no-widget');
          return resolve('');
        }
        lastReason = '';
        uses += 1;
        boundEmail = email;
        resolve(token);
      };
      const poll = () => {
        if (token || unavailable || widgetId === null) return finish();
        if (Date.now() - started >= (interactive ? INTERACTIVE_WAIT_MS : QUIET_WAIT_MS)) return finish(true);
        const wake = () => {
          window.clearTimeout(timer);
          poll();
        };
        const timer = window.setTimeout(() => {
          waiters = waiters.filter((w) => w !== wake);
          poll();
        }, 250);
        waiters.push(wake);
      };
      poll();
    });
  }

  async function fieldsFor(email: string): Promise<TurnstileFields> {
    const token = await tokenFor(email);
    return {
      turnstile_token: token,
      turnstile_wait_ms: lastWaitMs,
      ...(lastReason ? { turnstile_reason: lastReason } : {})
    };
  }

  return { warm, tokenFor, fieldsFor };
}

// One widget per component, rendered into the element given to `slotRef`
// (a callback ref, so nothing is read during render).
export function useTurnstile(action: string) {
  const [state] = useState(() => {
    let slot: HTMLDivElement | null = null;
    return {
      slotRef: (node: HTMLDivElement | null) => {
        slot = node;
      },
      turnstile: attachTurnstile(() => slot, action)
    };
  });
  return state;
}
