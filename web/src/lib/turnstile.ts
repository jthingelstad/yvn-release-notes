// Cloudflare Turnstile for the one request that emails a typed address,
// POST /api/auth/start (sign-in, sign-up and "send it again"). The server
// checks the token (packages/backend/turnstile.ts); in observe mode it only
// records the answer.
//
// Cloudflare's script loads only once someone focuses or types in the email
// field, never on a plain visit. Most people see nothing (interaction-only);
// a doubtful browser gets a checkbox under the form. If the script cannot
// load, the request goes without a token and the server decides.
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

interface RenderOptions {
  sitekey: string;
  action: string;
  appearance: 'interaction-only';
  'refresh-expired': 'auto';
  callback: (token: string) => void;
  'expired-callback': () => void;
  'before-interactive-callback': () => void;
  'error-callback': () => void;
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
      reject(new Error('turnstile-unavailable'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

export interface TurnstileHandle {
  warm(): void;
  tokenFor(email: string): Promise<string>;
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
  let waiters: (() => void)[] = [];

  const settle = () => {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  };

  function warm() {
    const container = slot();
    if (widgetId !== null || unavailable || !container) return;
    widgetId = 'pending';
    load().then(
      (loaded) => {
        api = loaded;
        widgetId = loaded.render(container, {
          sitekey: SITE_KEY,
          action,
          appearance: 'interaction-only',
          'refresh-expired': 'auto',
          callback: (value) => {
            token = value;
            issuedAt = Date.now();
            uses = 0;
            boundEmail = '';
            interactive = false;
            settle();
          },
          'expired-callback': () => {
            token = '';
          },
          'before-interactive-callback': () => {
            interactive = true;
          },
          'error-callback': () => {
            token = '';
            interactive = false;
            settle();
          }
        });
      },
      () => {
        // Submit without a token; a later focus may try the script again.
        widgetId = null;
        unavailable = true;
        settle();
        window.setTimeout(() => (unavailable = false), 30000);
      }
    );
  }

  function reset() {
    token = '';
    uses = 0;
    boundEmail = '';
    if (api && widgetId !== null && widgetId !== 'pending') {
      try {
        api.reset(widgetId);
      } catch {
        // A widget that is gone renders afresh on the next warm().
      }
    }
  }

  const fresh = (email: string) =>
    !!token && uses < MAX_USES && Date.now() - issuedAt <= MAX_AGE_MS && (!boundEmail || boundEmail === email);

  // A token for this address, or '' when none came in time.
  function tokenFor(raw: string): Promise<string> {
    const email = raw.trim().toLowerCase();
    warm();
    if (token && !fresh(email)) reset();
    return new Promise((resolve) => {
      const started = Date.now();
      const finish = () => {
        if (!token) return resolve('');
        uses += 1;
        boundEmail = email;
        resolve(token);
      };
      const poll = () => {
        if (token || unavailable || widgetId === null) return finish();
        if (Date.now() - started >= (interactive ? INTERACTIVE_WAIT_MS : QUIET_WAIT_MS)) return finish();
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

  return { warm, tokenFor };
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
