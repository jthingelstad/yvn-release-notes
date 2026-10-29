// Small pieces every page uses: the bar, the version number, links, the
// lines that say something went wrong or is loading.
import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { sayFor, type Line, type Problem } from '../lib/say.ts';
import { api } from '../lib/api.ts';
import { useSignedInAs } from '../lib/nav.ts';
import { meQuery } from '../lib/queries.ts';
import { Icon, type IconName } from './icon.tsx';
import { Avatar } from './avatar.tsx';
import { BrandMark } from './brand-mark.tsx';
import { NewBadges, RailMember } from './welcome.tsx';
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
  ['/today/', 'Today', 'today'],
  ['/timeline/', 'Archive', 'archive'],
  ['/map/', 'Map', 'map'],
  ['/upcoming/', 'Upcoming', 'upcoming'],
  ['/you/', 'You', 'you'],
  // The rail's alone (Jamie, 2026-10-25: "on mobile I would put it inside
  // of Archive? On desktop I'd put it on it's own in the rail").
  ['/book/', 'Make a book', 'book']
] as const;
const RAIL_ONLY = '/book/';

// Which place a page belongs to: a tab, or '/search/' for the header's
// search (Tag marks it too), which no tab stands for. A book is its own
// place in the rail and the Archive's on a phone.
export function placeOf(path: string, rail = true) {
  return /^\/(day|release|timeline)\//.test(path) || (!rail && path.startsWith(RAIL_ONLY))
    ? '/timeline/'
    : /^\/(tag|search)\//.test(path)
      ? '/search/'
      : /^\/(badges|activity|connect|pause|delete|settings|admin|admin-users)\//.test(path)
        ? '/you/'
        : path;
}

// The You tab's glyph: the profile photo once there is one.
function YouGlyph() {
  const me = useQuery(meQuery).data;
  return <Avatar photo={me?.photo} className="avatar--nav" />;
}

// Whether the bar is the rail: wider than site.css's 760px phone layout.
// Drawn at build time for front.html, whose bar has no places, there is no
// screen to ask, so it says the rail.
const RAIL = '(min-width: 761px)';
const hasMedia = () => typeof matchMedia === 'function';
function useRail(): boolean {
  return useSyncExternalStore(
    (changed) => {
      if (!hasMedia()) return () => undefined;
      const query = matchMedia(RAIL);
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => !hasMedia() || matchMedia(RAIL).matches,
    () => true
  );
}

// The bar along the top: the name, the search, and the places for anyone
// signed in. `current` marks one of them. Signed in, it also carries what
// welcome.tsx adds: a member's mark in the rail, and new badges after it.
export function Bar({ nav = true, current, children }: { nav?: boolean; current?: string; children?: ReactNode }) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const rail = useRail();
  const here = current || placeOf(path, rail);
  return (
    <>
      <header className={nav ? 'bar bar--app' : 'bar'}>
        <Link className="brand" to={nav ? '/today/' : '/'}>
          <BrandMark />
          Release Notes
        </Link>
        {nav && (
          // An icon at the top right on a phone, a row under the name in the
          // rail; "Search notes" either way to assistive technology.
          <Link
            className="bar-search"
            to="/search/"
            title="Search"
            aria-current={here === '/search/' ? 'page' : undefined}
            activeProps={{}}
          >
            <Icon name="search" />
            <span>Search notes</span>
          </Link>
        )}
        {nav && (
          <nav className="primary-nav" aria-label="Main navigation">
            {NAV.filter(([to]) => rail || to !== RAIL_ONLY).map(([to, name, icon]) => (
              <Link key={to} to={to} aria-current={here === to ? 'page' : undefined} activeProps={{}}>
                {to === '/you/' ? <YouGlyph /> : <Icon name={icon as IconName} />}
                <span>{name}</span>
              </Link>
            ))}
          </nav>
        )}
        {nav && <RailMember />}
        {nav && <RailSignOut />}
        {children}
      </header>
      {nav && <NewBadges />}
    </>
  );
}

// The way back up, above the title of a page that sits under a tab:
// "← Archive" on a day or a release, "← You" on Settings. `phone` keeps it
// to a phone, for a page the rail has a place for (a book).
export function Crumb({ href, phone, children }: { href: string; phone?: true; children: ReactNode }) {
  return (
    <AppLink className={phone ? 'crumb phone-only' : 'crumb'} href={href}>
      <Icon name="back" />
      {children}
    </AppLink>
  );
}

// Only the signed-in rail needs Query; the public/error bar can render even
// when a failed page has no query provider available.
export function RailSignOut({ className = 'quiet rail-signout' }: { className?: string }) {
  const signOut = useSignedInAs();
  const [leaving, setLeaving] = useState(false);
  return (
    <button
      className={className}
      type="button"
      disabled={leaving}
      onClick={async () => {
        setLeaving(true);
        try {
          await api('POST', '/api/auth/signout');
          signedIn.drop();
          signOut('/#sign-in');
        } finally {
          setLeaving(false);
        }
      }}
    >
      <Icon name="out" />
      Sign out
    </button>
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
// page shows its form at once. A link to another site opens in a new tab,
// so whatever was typed here stays.
export function LineText({ line }: { line: Line }) {
  if (typeof line === 'string') return <>{line}</>;
  return (
    <>
      {line.map((part, i) =>
        typeof part === 'string' ? (
          <span key={i}>{part}</span>
        ) : /^https?:/.test(part.href) ? (
          <a key={i} href={part.href} target="_blank" rel="noopener">
            {part.text}
          </a>
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

// The front page (the one title search shows, and web/index.html's too)
// says what Release Notes is; every other page is named for itself.
export const FRONT_TITLE = 'Release Notes: a daily journal by email';
export const titleOf = (title: string) => (title ? `${title}: Release Notes` : FRONT_TITLE);

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
