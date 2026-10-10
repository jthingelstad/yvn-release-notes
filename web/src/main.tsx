// Release Notes: one page for the whole web app, on TanStack Router, with
// TanStack Query for what the API answers. The API is same-origin at /api;
// the one other request is the page count (lib/pagecount.ts).
//
// Every page but the front one is its own chunk, loaded on the way to it. The signed-in pages
// sit behind one gate that has the profile before any of them shows, and
// each loads its data before it shows, from the moment a link is pointed
// at, so moving between them is one step.
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
  RouterProvider
} from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { Loading } from './components/common.tsx';
import { ViewerProvider } from './components/viewer.tsx';
import { ApiError } from './lib/api.ts';
import { countPage } from './lib/pagecount.ts';
import { daysQuery, dayQuery, meQuery, pickDay, tagQuery, tagsQuery, todayQuery } from './lib/queries.ts';
import { home, store } from './lib/storage.ts';
import { Home } from './pages/Home.tsx';
import { NotFound } from './pages/NotFound.tsx';
import './styles/site.css';

declare module '@tanstack/react-query' {
  interface Register {
    // `bounce: false` keeps a failed load from sending anyone elsewhere.
    queryMeta: { bounce?: boolean };
  }
}

// Send anyone without an account where they belong: signed out to sign
// in (and back here after), signed in without a profile to setup.
function bounce(error: Error, meta?: { bounce?: boolean }) {
  if (meta?.bounce === false || !(error instanceof ApiError)) return;
  const { status, data } = error.answer;
  if (status === 401) {
    store.set('rn-back', location.pathname + location.search);
    router.navigate({ href: '/#sign-in', replace: true });
  } else if (status === 403 && data.error === 'no-account') {
    router.navigate({ href: home(true), replace: true });
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error, query) => bounce(error, query.meta) }),
  defaultOptions: {
    queries: {
      // What a pointed-at link loaded is still good when it is followed.
      staleTime: 30_000,
      // Once more after a network failure, never after the API's answer.
      retry: (count, error) => count < 1 && !(error instanceof ApiError && error.answer.status > 0)
    }
  }
});

function Root() {
  return (
    <ViewerProvider>
      <main>
        <Outlet />
      </main>
    </ViewerProvider>
  );
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: NotFound
});

const page = <T extends string>(path: T, file: () => Promise<Record<string, unknown>>, name: string) => ({
  path,
  component: lazyRouteComponent(file as () => Promise<Record<string, () => React.ReactNode>>, name)
});

// Signed out, or anyone: the front page (in the main bundle, since a first
// visit starts there), the emailed links, and setup (which checks for
// itself).
const frontRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home });
const open = [
  page('/signin', () => import('./pages/SignIn.tsx'), 'SignIn'),
  page('/setup', () => import('./pages/Setup.tsx'), 'Setup'),
  page('/unsubscribe', () => import('./pages/Unsubscribe.tsx'), 'Unsubscribe')
].map((p) => createRoute({ getParentRoute: () => rootRoute, ...p }));

// The gate: signed in, with a profile, before any page behind it shows.
// The profile is fetched once and kept; useMe follows it after. Pointing at
// a link (a preload) never sends anyone anywhere.
const signedInRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'signed-in',
  beforeLoad: async ({ context, location, preload }) => {
    try {
      const me = await context.queryClient.ensureQueryData(meQuery);
      if (me.new && !preload) throw redirect({ to: '/setup/', replace: true });
    } catch (e) {
      if (preload || !(e instanceof ApiError)) throw e;
      if (e.answer.status === 401) {
        store.set('rn-back', location.pathname + location.searchStr);
        throw redirect({ to: '/', hash: 'sign-in', replace: true });
      }
      // Anything else: the page says it couldn't load.
    }
  }
});

type Ctx = { context: { queryClient: QueryClient } };
const search = (s: unknown, k: string) => (s as Record<string, string | undefined>)[k] ?? null;

const behind = [
  createRoute({
    getParentRoute: () => signedInRoute,
    ...page('/today', () => import('./pages/Today.tsx'), 'Today'),
    loader: ({ context }: Ctx) => context.queryClient.prefetchQuery(todayQuery)
  }),
  createRoute({
    getParentRoute: () => signedInRoute,
    ...page('/timeline', () => import('./pages/Timeline.tsx'), 'Timeline'),
    loader: ({ context }: Ctx) => context.queryClient.prefetchInfiniteQuery(daysQuery)
  }),
  createRoute({
    getParentRoute: () => signedInRoute,
    ...page('/day', () => import('./pages/Day.tsx'), 'Day'),
    loaderDeps: ({ search: s }) => ({ d: search(s, 'd') }),
    loader: ({ context, deps }) => {
      const me = context.queryClient.getQueryData(meQuery.queryKey);
      if (me && !me.new) return context.queryClient.prefetchQuery(dayQuery(pickDay(deps.d, me)));
    }
  }),
  createRoute({
    getParentRoute: () => signedInRoute,
    ...page('/tag', () => import('./pages/Tag.tsx'), 'Tag'),
    loaderDeps: ({ search: s }) => ({ t: search(s, 't') }),
    loader: ({ context, deps }) => (deps.t ? context.queryClient.prefetchQuery(tagQuery(deps.t)) : undefined)
  }),
  createRoute({
    getParentRoute: () => signedInRoute,
    ...page('/search', () => import('./pages/Search.tsx'), 'Search'),
    loader: ({ context }: Ctx) => context.queryClient.prefetchQuery(tagsQuery)
  }),
  ...[
    page('/settings', () => import('./pages/Settings.tsx'), 'Settings'),
    page('/pause', () => import('./pages/Pause.tsx'), 'Pause'),
    page('/delete', () => import('./pages/Delete.tsx'), 'Delete')
  ].map((p) => createRoute({ getParentRoute: () => signedInRoute, ...p }))
];

const routeTree = rootRoute.addChildren([frontRoute, ...open, signedInRoute.addChildren(behind)]);

// Every address keeps its trailing slash (/today/), as the emails and
// bookmarks have it. The ?query is plain strings: the default reads JSON,
// which would turn the tag "2016" into a number.
const router = createRouter({
  routeTree,
  context: { queryClient },
  trailingSlash: 'always',
  // Load a page's code and data when its link is pointed at or touched.
  // Query decides what is fresh, so the router keeps nothing of its own.
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
  defaultPendingComponent: () => <Loading />,
  // Back and forward return to where the page was scrolled.
  scrollRestoration: true,
  parseSearch: (s) => Object.fromEntries(new URLSearchParams(s)),
  stringifySearch: (o) => {
    const q = new URLSearchParams(
      Object.entries(o)
        .filter((e): e is [string, string] => e[1] !== undefined && e[1] !== null)
        .map(([k, v]) => [k, String(v)])
    ).toString();
    return q ? `?${q}` : '';
  }
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

// A page count for each page shown.
router.subscribe('onResolved', ({ toLocation }) => countPage(toLocation.pathname));

// A new page says so, as a page load would: focus goes to its heading, so a
// screen reader reads it and Tab starts from the top. Not when the page has
// put focus somewhere itself, nor for a change of ?query or #hash alone.
router.subscribe('onRendered', ({ fromLocation, pathChanged }) => {
  if (!fromLocation || !pathChanged) return;
  requestAnimationFrame(() => {
    const active = document.activeElement;
    if (active && active !== document.body) return;
    const main = document.querySelector('main');
    const heading = [...(main?.querySelectorAll('h1') || [])].find((h) => !h.closest('[hidden]'));
    const target = heading || main;
    if (!target) return;
    target.tabIndex = -1;
    target.focus({ preventScroll: true });
  });
});

// A page's code from an earlier deploy is gone from the bucket: load the
// app again, once a minute at most, so a long-open tab picks up the new one.
window.addEventListener('vite:preloadError', (e) => {
  const last = Number(store.get('rn-reloaded') || 0);
  if (Date.now() - last < 60_000) return;
  e.preventDefault();
  store.set('rn-reloaded', String(Date.now()));
  location.reload();
});

createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
