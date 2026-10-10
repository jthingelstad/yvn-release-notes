// Small pieces every page uses: the bar, the version number, links, the
// lines that say something went wrong or is loading.
import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { sayFor, type Line, type Problem } from '../lib/say.ts';
import { signedIn, store } from '../lib/storage.ts';

// A same-site address as a router link: path, ?query and #hash.
export function splitHref(href: string) {
  const u = new URL(href, 'http://x');
  return {
    to: u.pathname,
    search: Object.fromEntries(u.searchParams) as Record<string, string>,
    hash: u.hash.slice(1) || undefined
  };
}

export function AppLink({
  href,
  children,
  ...rest
}: { href: string; children: ReactNode; ref?: React.Ref<HTMLAnchorElement> } & Omit<
  React.AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
>) {
  const { to, search, hash } = splitHref(href);
  return (
    <Link to={to} search={search} hash={hash} {...rest}>
      {children}
    </Link>
  );
}

const NAV = [
  ['/today/', 'Today'],
  ['/timeline/', 'Timeline'],
  ['/search/', 'Search'],
  ['/settings/', 'Settings']
] as const;

// The bar along the top: the name, and the four places for anyone signed in.
// `current` marks one of them (Tag marks Search).
export function Bar({ nav = true, current, children }: { nav?: boolean; current?: string; children?: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const here = current || path;
  return (
    <header className="bar">
      <Link className="brand" to="/">
        Release Notes
      </Link>
      {nav &&
        NAV.map(([to, name]) => (
          <Link key={to} to={to} aria-current={here === to ? 'page' : undefined} activeProps={{}}>
            {name}
          </Link>
        ))}
      {children}
    </header>
  );
}

// Cobalt digits, tangerine dots. A number standing on its own says
// "Version" to a screen reader, in text only it hears; one inside a
// sentence ("That makes you 5.4.279 today") reads as it is.
export function Digits({ v, named = false }: { v: string; named?: boolean }) {
  return (
    <>
      {named && <span className="vh">Version </span>}
      {v.split('.').map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="dot">.</span>}
          {part}
        </Fragment>
      ))}
    </>
  );
}

// Text, or strings and links, as one line. A link marked `back` comes back
// here after signing in again, with the signed-in hint dropped so the home
// page shows its form at once.
export function LineText({ line }: { line: Line }) {
  if (typeof line === 'string') return <>{line}</>;
  return (
    <>
      {line.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : (
          <AppLink
            key={i}
            href={part.href}
            onClick={
              part.back
                ? () => {
                    store.set('rn-back', location.pathname + location.search);
                    signedIn.drop();
                  }
                : undefined
            }
          >
            {part.text}
          </AppLink>
        )
      )}
    </>
  );
}

export function ErrorLine({ line }: { line: Line | null }) {
  return (
    <p className="error" role="alert" hidden={!line}>
      {line && <LineText line={line} />}
    </p>
  );
}

// Focus moved once what was just changed is on the page (an element may
// only now stop being hidden): focusLater(() => ref.current).
export function useFocusLater() {
  const [asked, setAsked] = useState<{ el: () => HTMLElement | null | undefined } | null>(null);
  useEffect(() => {
    const el = asked?.el();
    if (el && !el.closest('[hidden]')) el.focus();
  }, [asked]);
  return useCallback((el: () => HTMLElement | null | undefined) => setAsked({ el }), []);
}

// An error line and how to show one: show(problem, field) says it, then
// puts focus back where the person was (the submit button is disabled while
// busy, which drops focus). The field defaults to the first in `root`.
export function useProblem() {
  const [line, setLine] = useState<Line | null>(null);
  const focusLater = useFocusLater();
  const show = useCallback(
    (p: Problem | Line, field?: HTMLElement | null, root?: HTMLElement | null) => {
      setLine(typeof p === 'string' || Array.isArray(p) ? p : sayFor(p));
      // After the busy button is given back, so a button can take focus too.
      focusLater(
        () =>
          field ||
          root?.querySelector<HTMLElement>(
            'input:not([type=radio]):not([type=hidden]):not([disabled]), textarea, select'
          ) ||
          root?.querySelector<HTMLElement>('button[type=submit]') ||
          root?.querySelector<HTMLElement>('button')
      );
    },
    [focusLater]
  );
  const clear = useCallback(() => setLine(null), []);
  return { line, show, clear };
}

// Busy while fn runs, once at a time (an autofilled code can submit twice).
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);
  return [busy, run] as const;
}

// A quiet "Loading…", shown only if the answer takes longer than `wait` ms
// (a cold API start).
export function Loading({ text = 'Loading…', wait = 300 }: { text?: string; wait?: number }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShown(true), wait);
    return () => clearTimeout(t);
  }, [wait]);
  if (!shown) return null;
  return (
    <p className="hint loading" role="status">
      {text}
    </p>
  );
}

export function Failed() {
  return (
    <p className="hint loading failed" role="status">
      Couldn’t load this just now. Reload to try again.
    </p>
  );
}

export const titleOf = (title: string) => (title ? `${title}: Release Notes` : 'Release Notes');

export function useTitle(title: string | null) {
  useEffect(() => {
    if (title !== null) document.title = titleOf(title);
  }, [title]);
}

// Release Notes' own credit line for the weather.
export function WeatherCredit({ lead = ' ' }: { lead?: string }) {
  return (
    <>
      {lead}Weather from <a href="https://open-meteo.com/">Open-Meteo</a>.
    </>
  );
}
