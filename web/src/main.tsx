// Release Notes: one page for the whole web app, on TanStack Router, with
// TanStack Query for what the API answers. The API is same-origin at /api;
// the one other request is the page count (lib/pagecount.ts).
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router';
import { createRoot } from 'react-dom/client';
import { ViewerProvider } from './components/viewer.tsx';
import { ApiError } from './lib/api.ts';
import { countPage } from './lib/pagecount.ts';
import { home, store } from './lib/storage.ts';
import { PAGES, type PagePath } from './paths.ts';
import { Day } from './pages/Day.tsx';
import { Delete } from './pages/Delete.tsx';
import { Home } from './pages/Home.tsx';
import { NotFound } from './pages/NotFound.tsx';
import { Pause } from './pages/Pause.tsx';
import { Search } from './pages/Search.tsx';
import { Settings } from './pages/Settings.tsx';
import { Setup } from './pages/Setup.tsx';
import { SignIn } from './pages/SignIn.tsx';
import { Tag } from './pages/Tag.tsx';
import { Timeline } from './pages/Timeline.tsx';
import { Today } from './pages/Today.tsx';
import { Unsubscribe } from './pages/Unsubscribe.tsx';
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

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });

const COMPONENTS: Record<PagePath, () => React.ReactNode> = {
  '/': Home,
  '/signin/': SignIn,
  '/setup/': Setup,
  '/settings/': Settings,
  '/today/': Today,
  '/timeline/': Timeline,
  '/day/': Day,
  '/pause/': Pause,
  '/delete/': Delete,
  '/tag/': Tag,
  '/search/': Search,
  '/unsubscribe/': Unsubscribe
};

const routeTree = rootRoute.addChildren(
  PAGES.map(([path]) =>
    createRoute({ getParentRoute: () => rootRoute, path: path.slice(0, -1) || '/', component: COMPONENTS[path] })
  )
);

// Every address keeps its trailing slash (/today/), as the emails and
// bookmarks have it. The ?query is plain strings: the default reads JSON,
// which would turn the tag "2016" into a number.
const router = createRouter({
  routeTree,
  trailingSlash: 'always',
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

createRoot(document.getElementById('app')!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
