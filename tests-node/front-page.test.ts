/** The build's two pages, built for real (vite.config.ts, about a second)
 * into a temporary folder: front.html, which CloudFront serves for / alone,
 * has the front page drawn into #app for readers that run no script, and
 * index.html, which every other address serves, keeps #app empty. Outside
 * #app the two are the same page: one title, canonical, description and
 * sharing card, and no robots line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DomUtils, parseDocument } from 'htmlparser2';
import { build } from 'vite';

const out = await mkdtemp(join(tmpdir(), 'yvn-front-page-'));
test.after(() => rm(out, { recursive: true, force: true }));
await build({
  configFile: resolve('vite.config.ts'),
  logLevel: 'error',
  build: { outDir: out, emptyOutDir: true }
});
const front = await readFile(join(out, 'front.html'), 'utf8'),
  index = await readFile(join(out, 'index.html'), 'utf8');

const OPEN = '<div id="app">',
  EMPTY = '<div id="app"></div>';
/** What the page holds outside #app, and inside it. */
function parts(html: string) {
  const start = html.indexOf(OPEN),
    end = html.lastIndexOf('</div>', html.indexOf('</body>'));
  assert.ok(start > 0 && end >= start + OPEN.length && html.indexOf(OPEN, start + 1) < 0);
  return { outside: html.slice(0, start) + html.slice(end), app: html.slice(start + OPEN.length, end) };
}

/** Words the front page says, as Home says them. */
const WORDS = [
  '<h1>What’s your version number?</h1>',
  'Your age, written like software',
  'Show me my number',
  'The easiest journal you’ll ever keep.',
  'Free with the Weekly Thing.',
  'A hobby by <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>'
];

test('front.html, served for /, has the front page in #app', () => {
  const { app } = parts(front);
  assert.match(app, /^<main data-prerendered>[\s\S]*<\/main>$/);
  for (const words of WORDS) assert.ok(app.includes(words), words);
});

test('index.html, served for every other address, has an empty #app and none of the front page’s words', () => {
  assert.ok(index.includes(EMPTY));
  assert.equal(parts(index).app, '');
  // Its head has the front page's description, as every address's has.
  const body = index.slice(index.indexOf('<body>'));
  assert.ok(!body.includes('data-prerendered'));
  for (const words of [...WORDS, 'What’s your version number', 'The easiest journal'])
    assert.ok(!body.includes(words), words);
});

test('outside #app the two pages are the same, canonical, sharing card and title included', () => {
  assert.equal(parts(front).outside, parts(index).outside);
  const { outside } = parts(front);
  for (const line of [
    '<title>Release Notes: a daily journal by email</title>',
    '<link rel="canonical" href="https://notes.yourversionnumber.com/" />',
    '<meta property="og:url" content="https://notes.yourversionnumber.com/" />',
    '<meta property="og:title" content="Release Notes" />',
    '<meta property="og:image" content="https://notes.yourversionnumber.com/brand/release-notes-paper-512.png" />'
  ])
    assert.ok(outside.includes(line), line);
  // The front page stays indexable; main.tsx marks every other page noindex.
  assert.doesNotMatch(front, /<meta[^>]*name="robots"/);
});

test('the drawn front page has no script, no inline style and nothing the open page hides', () => {
  const { app } = parts(front);
  assert.doesNotMatch(app, /<script|<style|\sstyle=|\shidden[\s>=]/i);
  // Nothing fetched or personal: no image loads, and every link is a plain one.
  assert.doesNotMatch(app, /<img|<iframe|\ssrc=/i);
  for (const [, href] of app.matchAll(/\shref="([^"]*)"/g))
    assert.match(
      href!,
      /^(\/|\/#sign-in|https:\/\/(www\.thingelstad\.com|weekly\.thingelstad\.com|yourversionnumber\.com)\/)/
    );
});

test('robots.txt is built as it is written', async () => {
  assert.equal(
    await readFile(join(out, 'robots.txt'), 'utf8'),
    await readFile(resolve('web/public/robots.txt'), 'utf8')
  );
});

/** What the front page says to search: its title, its description and the
 * words drawn into #app, as text. Markup, styles and the build's file names
 * can change without it. */
function said(html: string) {
  const doc = parseDocument(html);
  const title = DomUtils.textContent(DomUtils.findOne((e) => e.name === 'title', doc.children)!);
  const description = DomUtils.findOne((e) => e.name === 'meta' && e.attribs.name === 'description', doc.children)!
    .attribs.content;
  const app = DomUtils.textContent(parseDocument(parts(html).app).children);
  return [title, description, app].map((text) => text!.replace(/\s+/g, ' ').trim()).join('\n');
}

/** The front page's words when they last changed, and the day that reached
 * the site, are site/sitemap.json's entry for / (as each public page's are
 * its own; tests-node/site.test.ts). sitemap.xml gives that day as / 's
 * <lastmod>, which search reads only while it stays true. */
test('the sitemap’s <lastmod> for / is the day the front page’s words last changed', async () => {
  const FRONT_PAGE = JSON.parse(await readFile(resolve('site/sitemap.json'), 'utf8'))['/'];
  const sitemap = await readFile(join(out, 'sitemap.xml'), 'utf8');
  assert.match(
    sitemap,
    new RegExp(
      `<url>\\n    <loc>https://notes\\.yourversionnumber\\.com/</loc>\\n    <lastmod>${FRONT_PAGE.lastmod}</lastmod>`
    )
  );
  assert.match(FRONT_PAGE.lastmod, /^\d{4}-\d{2}-\d{2}$/);
  const hash = createHash('sha256').update(said(front)).digest('hex');
  assert.equal(
    hash,
    FRONT_PAGE.said,
    'The front page says something new. Set "said" for / in site/sitemap.json to the hash above and its ' +
      '"lastmod" to the day (US Central) this change reaches the site.'
  );
});
