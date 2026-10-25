// front.html: index.html with the front page drawn into #app at build time
// (vite.config.ts), served for / alone (the CloudFront function and the dev
// server). Search and link previews that run no script read the front
// page's words there; every other address keeps index.html, whose #app is
// empty, so none of them says the front page's words.
//
// The page drawn is Home itself, as it opens for someone signed out (asking
// for the birthday), with what that view hides left out: nothing typed by
// hand, so it cannot drift from the app. Nothing in it is fetched or
// personal. The app never hydrates it: createRoot (main.tsx) replaces it on
// the first render, and site.css keeps it out of sight wherever scripts run,
// so anyone running the app sees only the app, as before, signed in or out.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from '@tanstack/react-router';
import { DomUtils, parseDocument } from 'htmlparser2';
import { renderToStaticMarkup } from 'react-dom/server';
import { Home } from './pages/Home.tsx';

// The empty root index.html has, and the attribute that marks the copy.
export const EMPTY_APP = '<div id="app"></div>';
export const PRERENDERED = 'data-prerendered';

// The front page's markup: <main> as the app's root draws it, holding Home.
export function frontMarkup(): string {
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    trailingSlash: 'always'
  });
  const markup = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <RouterContextProvider router={router}>
        <main {...{ [PRERENDERED]: '' }}>
          <Home prerender />
        </main>
      </RouterContextProvider>
    </QueryClientProvider>
  );
  // What the opening view hides (the number, sign-in, the code, the error
  // lines) is left out, so a reader that ignores `hidden` reads only what
  // the page shows. Read and written raw, so React's own escaping stands.
  const raw = { decodeEntities: false, lowerCaseTags: false, lowerCaseAttributeNames: false };
  const doc = parseDocument(markup, raw);
  for (const el of DomUtils.findAll((e) => e.attribs.hidden !== undefined, doc.children)) DomUtils.removeElement(el);
  return DomUtils.getOuterHTML(doc, raw);
}

// index.html with the front page in its #app.
export function withFront(index: string): string {
  if (index.split(EMPTY_APP).length !== 2) throw new Error(`index.html must have one empty ${EMPTY_APP}`);
  return index.replace(EMPTY_APP, () => `<div id="app">${frontMarkup()}</div>`);
}
