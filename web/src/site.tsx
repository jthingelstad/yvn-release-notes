// The public pages: How it works, the guide, the FAQ, Privacy and the
// changelog. Each is a Markdown file in site/ that opens with its title and description as front
// matter; site/faq.md is /faq/ and site/guide/index.md is /guide/. After the
// app's build (vite.config.ts) this draws each into plain HTML at
// dist/web/<path>/index.html: one Markdown library (markdown-it, a dev
// dependency, with raw HTML off) makes the words into markup, and a React
// shell drawn by renderToStaticMarkup puts them under the front page's bar,
// in its stylesheet and type, above its foot. The app's script never loads
// on them; the one script is a small count file built from lib/pagecount.ts,
// which sends Tinylytics the path, as the app does. CloudFront serves them
// for the sections WebIndexFunction lists (infra/template.yaml), which
// tests-node/infra/web-index.test.ts holds to the folders here.
//
// The same pages (read in site-pages.ts) make sitemap.xml, with each page's <lastmod> from
// site/sitemap.json (which also sets their order; tests-node/site.test.ts
// pins each date to a hash of the page's words), and llms.txt.
//
// Kept small on purpose. If the docs outgrow it (search in the guide, many
// authors, versioned pages), the path is Astro, not more code here.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { BrandMark } from './components/brand-mark.tsx';
import { titleOf } from './components/common.tsx';
import { Icon } from './components/icon.tsx';
import { SiteLinks } from './components/site-links.tsx';
import { ORIGIN, llmsTxt, readPages, sitemapDates, sitemapXml, SITE_DIR, type Page } from './site-pages.ts';

const SRC_DIR = resolve('web/src');

/** A page as a whole HTML document. `styles` are the app's stylesheets, as the
 * built index.html links them; `count` the count script's address. */
export function pageHtml(page: Page, styles: string[], count: string | null): string {
  const url = ORIGIN + page.path,
    title = titleOf(page.title),
    guide = page.path.startsWith('/guide/') && page.path !== '/guide/';
  const shell =
    '<!doctype html>\n' +
    renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
          <title>{title}</title>
          <meta name="description" content={page.description} />
          <link rel="canonical" href={url} />
          <meta property="og:type" content="website" />
          <meta property="og:site_name" content="Your Version Number" />
          <meta property="og:title" content={title} />
          <meta property="og:description" content={page.description} />
          <meta property="og:url" content={url} />
          <meta property="og:image" content={`${ORIGIN}/brand/release-notes-paper-512.png`} />
          <meta property="og:image:alt" content="The Release Notes mark: a blue V and an orange dot over two lines" />
          <meta name="twitter:card" content="summary" />
          <link rel="icon" href="/icons/icon-16.png" sizes="16x16" type="image/png" />
          <link rel="icon" href="/icons/icon-32.png" sizes="32x32" type="image/png" />
          <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
          <meta name="theme-color" content="#fffbf2" media="(prefers-color-scheme: light)" />
          <meta name="theme-color" content="#14163a" media="(prefers-color-scheme: dark)" />
          {styles.map((href) => (
            <link key={href} rel="stylesheet" href={href} />
          ))}
          {count && <script src={count} defer />}
        </head>
        <body>
          <main className="site">
            <header className="bar">
              <a className="brand" href="/">
                <BrandMark />
                Release Notes
              </a>
              <a href="/">Open Release Notes</a>
            </header>
            <article className="doc">
              {guide && (
                <a className="doc-crumb" href="/guide/">
                  <Icon name="back" />
                  Guide
                </a>
              )}
              <h1>{page.title}</h1>
              <p className="lede">{page.description}</p>
              <div className="doc-body" />
            </article>
            <p className="foot">
              A hobby by <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>, free with the{' '}
              <a href="https://weekly.thingelstad.com/">Weekly Thing</a>. From{' '}
              <a href="https://yourversionnumber.com/">Your Version Number</a>.
            </p>
            <SiteLinks current={page.path} />
          </main>
        </body>
      </html>
    ) +
    '\n';
  // The words go in as markdown-it made them, from the repo's own Markdown
  // with raw HTML off, into the one empty place the shell leaves for them.
  const [before, after, ...more] = shell.split(BODY);
  if (after === undefined || more.length) throw new Error(`${page.path}: the shell has no one place for the words`);
  return `${before}<div class="doc-body">${page.html}</div>${after}`;
}

const BODY = '<div class="doc-body"></div>';

/** Writes every page, the count script, sitemap.xml and llms.txt into the
 * build, beside index.html, whose stylesheets the pages share. */
export async function writeSite(outDir: string, index: string, dir = SITE_DIR): Promise<void> {
  const styles = Array.from(index.matchAll(/<link rel="stylesheet"[^>]*href="([^"]+)"/g), (m) => m[1]!);
  if (!styles.length) throw new Error('index.html links no stylesheet');
  const count = await countScript(outDir);
  const pages = await readPages(dir);
  for (const page of pages) {
    const file = join(outDir, page.path, 'index.html');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, pageHtml(page, styles, count));
  }
  await writeFile(join(outDir, 'sitemap.xml'), sitemapXml(await sitemapDates(dir)));
  await writeFile(join(outDir, 'llms.txt'), llmsTxt(pages));
}

// The page count, bundled on its own from lib/pagecount.ts and named by its
// content like the app's files, so it is cached for good.
async function countScript(outDir: string): Promise<string> {
  const out = await build({
    stdin: {
      contents: "import { countPage } from './lib/pagecount.ts';\ncountPage(location.pathname);\n",
      resolveDir: SRC_DIR,
      loader: 'ts'
    },
    bundle: true,
    minify: true,
    format: 'iife',
    target: 'es2022',
    write: false
  });
  const code = out.outputFiles[0]!.contents;
  const name = `assets/count-${createHash('sha256').update(code).digest('hex').slice(0, 10)}.js`;
  await mkdir(join(outDir, 'assets'), { recursive: true });
  await writeFile(join(outDir, name), code);
  return '/' + relative(outDir, join(outDir, name));
}
