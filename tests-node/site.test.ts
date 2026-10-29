/** The public pages (site/, drawn by web/src/site.tsx), built for real into a
 * temporary folder as the release builds them: each page is its own
 * indexable document under the app's CSP, the sitemap's dates hold for the
 * words they were set for, every link goes somewhere, every number is the
 * product's own, and nothing names an Easter egg or a secret badge. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DomUtils, parseDocument } from 'htmlparser2';
import { build } from 'vite';
import { MAX_PAUSE_DAYS } from '../packages/backend/accounts.ts';
import { LOGIN_TTL, SESSION_IDLE } from '../packages/backend/auth.ts';
import { SCOPES as GRANTED } from '../packages/backend/oauth.ts';
import { COMMENTARY_PER_RELEASE, PAGE_SIZES } from '../packages/book/limits.ts';
import { BADGES } from '../packages/domain/badges.ts';
import { SCREENSHOTS_MAX } from '../packages/domain/feedback.ts';
import { MAX_NOTE } from '../packages/domain/notes.ts';
import { UPCOMING_SHOWN } from '../packages/domain/upcoming.ts';
import { DOTS, PHOTOS_AN_EMAIL, PHOTOS_A_DAY } from '../packages/mail/compose.ts';
import { MAX_INLINE_BYTES, MAX_INLINE_FILES } from '../server/mcp/files.ts';
import { ORIGIN, SCOPES, readPages, sitemapDates } from '../web/src/site-pages.ts';
import { LATE_NOTICES_A_DAY, REPLY_WINDOW } from '../workers/inbound.ts';

const out = await mkdtemp(join(tmpdir(), 'yvn-site-'));
test.after(() => rm(out, { recursive: true, force: true }));
await build({
  configFile: resolve('vite.config.ts'),
  logLevel: 'error',
  build: { outDir: out, emptyOutDir: true }
});
const pages = await readPages(),
  dates = await sitemapDates(),
  html = new Map(
    await Promise.all(
      pages.map(async (p) => [p.path, await readFile(join(out, p.path, 'index.html'), 'utf8')] as const)
    )
  ),
  front = await readFile(join(out, 'front.html'), 'utf8'),
  llms = await readFile(join(out, 'llms.txt'), 'utf8'),
  sitemap = await readFile(join(out, 'sitemap.xml'), 'utf8');

const docOf = (page: string) => parseDocument(page);
const one = (page: string, test: (e: { name: string; attribs: Record<string, string> }) => boolean) =>
  DomUtils.findOne(test, docOf(page).children);
/** The page's article, the words between the bar and the foot. */
const article = (page: string) => one(page, (e) => e.name === 'article')!;
const text = (node: Parameters<typeof DomUtils.textContent>[0]) =>
  DomUtils.textContent(node).replace(/\s+/g, ' ').trim();
/** The front page's drawn words, which the tour and the foot say. */
const frontApp = front.slice(front.indexOf('<div id="app">'), front.lastIndexOf('</div>', front.indexOf('</body>')));

/** What a page says to search: its title, its description and its words. */
function said(page: string) {
  const title = text(one(page, (e) => e.name === 'title')!),
    description = one(page, (e) => e.name === 'meta' && e.attribs.name === 'description')!.attribs.content!;
  return [title, description, text(article(page))].join('\n');
}

test('site/ has the pages phases 1 and 4 promised, and site/sitemap.json lists / and each of them', () => {
  assert.deepEqual(
    pages.map((p) => p.path),
    [
      '/how-it-works/',
      '/guide/',
      '/guide/start/',
      '/guide/the-email/',
      '/guide/replying/',
      '/faq/',
      '/privacy/',
      '/changelog/'
    ]
  );
  assert.deepEqual(Object.keys(dates), ['/', ...pages.map((p) => p.path)]);
});

test('each page’s <lastmod> is the day its words last changed, pinned to a hash of them', () => {
  for (const { path } of pages) {
    const hash = createHash('sha256')
      .update(said(html.get(path)!))
      .digest('hex');
    assert.equal(
      hash,
      dates[path]!.said,
      `${path} says something new. Set its "said" in site/sitemap.json to the hash above and its "lastmod" to ` +
        'the day (US Central) this change reaches the site.'
    );
    assert.match(dates[path]!.lastmod, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('sitemap.xml lists / and every page, in order, each with its pinned <lastmod> and nothing else', () => {
  const urls = Array.from(
    sitemap.matchAll(/<url>\n {4}<loc>([^<]+)<\/loc>\n {4}<lastmod>([^<]+)<\/lastmod>\n {2}<\/url>/g),
    (m) => [m[1], m[2]]
  );
  assert.deepEqual(
    urls,
    Object.entries(dates).map(([path, { lastmod }]) => [ORIGIN + path, lastmod])
  );
  assert.equal(sitemap.match(/<url>/g)?.length, urls.length);
});

test('each page is its own document: its own canonical and sharing card, indexable, one h1', () => {
  for (const [path, page] of html) {
    const url = ORIGIN + path;
    assert.ok(page.includes(`<link rel="canonical" href="${url}"/>`), path);
    assert.ok(page.includes(`<meta property="og:url" content="${url}"/>`), path);
    assert.doesNotMatch(page, /<meta[^>]*name="robots"/, path);
    assert.equal(page.match(/<h1[\s>]/g)?.length, 1, path);
    assert.ok(text(one(page, (e) => e.name === 'title')!).endsWith(': Release Notes'), path);
  }
  assert.equal(new Set(pages.map((p) => p.title)).size, pages.length, 'each page has its own title');
});

test('the pages stay inside the CSP: their own files only, no inline script or style, never the app’s script', async () => {
  const assets = await readdir(join(out, 'assets'));
  for (const [path, page] of html) {
    assert.doesNotMatch(page, /<style|\sstyle=|\son[a-z]+=/i, path);
    const scripts = Array.from(page.matchAll(/<script([^>]*)>([^<]*)<\/script>/g));
    assert.equal(scripts.length, 1, path);
    const [, attrs, inline] = scripts[0]!;
    assert.equal(inline, '', path);
    assert.match(attrs!, /^ src="\/assets\/count-[0-9a-f]{10}\.js" defer=""$/, path);
    assert.doesNotMatch(page, /type="module"|modulepreload/, path);
    for (const [, src] of page.matchAll(/\s(?:src|href)="(\/assets\/[^"]+)"/g))
      assert.ok(assets.includes(src!.slice('/assets/'.length)), `${path}: ${src}`);
    // Nothing loads from elsewhere: every off-site address is a plain link.
    for (const [, tag, url] of page.matchAll(/<(\w+)[^>]*\s(?:src|href)="(https?:[^"]*)"/g))
      assert.ok(
        tag === 'a' || (tag === 'link' && page.includes(`<link rel="canonical" href="${url}"`)),
        `${path}: ${tag} ${url}`
      );
  }
});

test('the count script counts the page as the app does, and nothing else', async () => {
  const name = /\/assets\/(count-[0-9a-f]{10}\.js)/.exec(html.get('/faq/')!)![1]!,
    code = await readFile(join(out, 'assets', name), 'utf8');
  assert.match(code, /https:\/\/tinylytics\.app\/collector\//);
  assert.match(code, /credentials:"omit"/);
  assert.match(code, /location\.pathname/);
  assert.doesNotMatch(code, /document\.cookie|location\.search\b(?!\)\.get\("tiny_ignore"\))/);
});

/** Every address the app answers: main.tsx's pages. */
const routes = async () => {
  const source = await readFile(resolve('web/src/main.tsx'), 'utf8');
  return new Set(['/', ...Array.from(source.matchAll(/page\('(\/[a-z-]+)'/g), (m) => `${m[1]}/`)]);
};

test('every internal link goes to a built page or file, or to a page of the app', async () => {
  const app = await routes(),
    sources: [string, string[]][] = [
      ...[...html].map(
        ([path, page]) => [path, Array.from(page.matchAll(/\shref="([^"]*)"/g), (m) => m[1]!)] as [string, string[]]
      ),
      ['front.html', Array.from(frontApp.matchAll(/\shref="([^"]*)"/g), (m) => m[1]!)],
      [
        'llms.txt',
        Array.from(llms.matchAll(/https:\/\/notes\.yourversionnumber\.com(?:[^\s)`]*[^\s)`.,])?/g), (m) => m[0])
      ]
    ];
  let checked = 0;
  for (const [from, hrefs] of sources)
    for (const href of hrefs) {
      const local = href.startsWith(ORIGIN) ? href.slice(ORIGIN.length) || '/' : href;
      if (!local.startsWith('/')) continue;
      checked++;
      const path = local.replace(/[?#].*$/, '');
      if (path === '/mcp') continue; // the MCP endpoint, which llms.txt names for agents
      const built = /\.[a-z0-9]+$/.test(path) ? existsSync(join(out, path)) : existsSync(join(out, path, 'index.html'));
      assert.ok(built || app.has(path), `${from} links ${href}, which is no page`);
      if (path.startsWith('/guide/')) assert.ok(built, `${from} links ${href}, a guide page not written yet`);
    }
  assert.ok(checked > 40);
});

test('the front page’s foot links each public page', () => {
  for (const { path } of pages.filter((p) => !p.path.startsWith('/guide/') || p.path === '/guide/'))
    assert.ok(frontApp.includes(`href="${path}"`), path);
});

/** Each number the pages and llms.txt say, as the phrase that says it, made
 * from the constant the product keeps it in. */
async function checkedPhrases() {
  const template = await readFile(resolve('infra/template.yaml'), 'utf8'),
    versions = Number(/- Id: expire-old-versions\n(?: {12}.*\n)*? {14}NoncurrentDays: (\d+)\n/.exec(template)![1]);
  return [
    `${REPLY_WINDOW / 3600} hours`,
    `up to ${LATE_NOTICES_A_DAY} of those a day`,
    `${MAX_NOTE.toLocaleString('en-US')} characters`,
    `${LOGIN_TTL / 60} minutes`,
    `${SESSION_IDLE / 86400} days from your last visit`,
    `${DOTS} dots`,
    `up to ${PHOTOS_A_DAY} for a day and ${PHOTOS_AN_EMAIL} in all`,
    `up to ${UPCOMING_SHOWN} at a time`,
    `up to ${COMMENTARY_PER_RELEASE} books a release`,
    `${PAGE_SIZES[0].replace('x', ' by ')} inches`,
    `up to ${SCREENSHOTS_MAX} screenshots`,
    `1 to ${MAX_PAUSE_DAYS} days`,
    `within ${versions} days`,
    `at most ${MAX_INLINE_FILES} files and ${MAX_INLINE_BYTES / 1024 / 1024} MB a call`
  ];
}

test('every number on the pages and in llms.txt is the product’s own', async () => {
  const phrases = await checkedPhrases(),
    used = new Set<string>();
  for (const [from, words] of [
    ...[...html].map(([path, page]) => [path, said(page)] as const),
    ['llms.txt', llms] as const
  ]) {
    let left = words;
    // A worked example: 5.2.113 is 52 years and 113 days, said beside it.
    for (const [phrase, years, days] of left.matchAll(/(\d+) years and (\d+) days/g)) {
      const version = `${Math.floor(Number(years) / 10)}.${Number(years) % 10}.${days}`;
      assert.ok(left.includes(version), `${from}: "${phrase}" is said without ${version}`);
      left = left.replace(phrase, '');
    }
    // Membership's one figure, said as the front page's tour says it.
    if (left.includes('100% to a nonprofit')) {
      assert.ok(frontApp.includes('100% to a nonprofit'), `${from}: the tour no longer says 100%`);
      left = left.replaceAll('100% to a nonprofit', '');
    }
    for (const phrase of phrases)
      if (left.includes(phrase)) {
        used.add(phrase);
        left = left.replaceAll(phrase, '');
      }
    // The changelog's dates: each release's day, and the launch's.
    if (from === '/changelog/') left = left.replace(/\b(?:October|November|December) \d{1,2}(?:, 2026)?\b/g, '');
    left = left
      .replace(/\b\d+\.\d+\.\d+\b/g, '') // versions, which are examples
      .replace(/#[a-z][a-z0-9-]*/g, ''); // a hashtag's example
    const stray = /[^\n]{0,40}\d[^\n]{0,40}/.exec(left);
    assert.equal(stray, null, `${from} says a number no constant checks: "${stray?.[0]}"`);
  }
  // Each phrase is said somewhere, so none is left to drift.
  assert.deepEqual(
    phrases.filter((p) => !used.has(p)),
    []
  );
});

test('llms.txt names each page and the MCP address, and each scope the server grants', () => {
  assert.match(llms, /^# Release Notes\n\n> /);
  for (const page of pages)
    assert.ok(llms.includes(`- [${page.title}](${ORIGIN}${page.path}): ${page.description}`), page.path);
  assert.ok(llms.includes(`${ORIGIN}/mcp`));
  assert.deepEqual(SCOPES.map(([scope]) => scope).sort(), [...GRANTED].sort());
  for (const [scope] of SCOPES) assert.ok(llms.includes(`- \`${scope}\`: `), scope);
});

test('no page, front-page tour or llms.txt names an Easter egg or a secret badge', () => {
  const secret = BADGES.filter((b) => b.secret).map((b) => b.name);
  assert.ok(secret.length >= 5);
  const banned = [
    /\/man\b/,
    /RTFM/i,
    /developer mode/i,
    /teapot/i,
    /status code/i,
    /\b(tap|click|press)\w* (\w+ ){0,3}(times|in a row)\b/i,
    ...secret.map((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[’']/g, "['’]")}\\b`))
  ];
  for (const [from, words] of [
    ...[...html].map(([path, page]) => [path, page] as const),
    ['front.html', frontApp] as const,
    ['llms.txt', llms] as const
  ])
    for (const pattern of banned) assert.doesNotMatch(words, pattern, `${from}: ${pattern}`);
});
