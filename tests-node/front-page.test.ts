/** The build's two pages, built for real (vite.config.ts, about a second)
 * into a temporary folder: front.html, which CloudFront serves for / alone,
 * has the front page drawn into #app for readers that run no script, and
 * index.html, which every other address serves, keeps #app empty. Outside
 * #app the two are the same page: one title, canonical, description and
 * sharing card, and no robots line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

test('robots.txt and the sitemap are built as they are written', async () => {
  for (const file of ['robots.txt', 'sitemap.xml'])
    assert.equal(await readFile(join(out, file), 'utf8'), await readFile(resolve('web/public', file), 'utf8'), file);
});
