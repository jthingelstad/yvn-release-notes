// The public pages' words, apart from how they are drawn (site.tsx): each
// page read from its Markdown in site/, the sitemap's dates, the sections
// CloudFront serves, sitemap.xml and llms.txt. No JSX, so the server's tests
// read it as it is.
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import MarkdownIt from 'markdown-it';
import { FEATURES } from './lib/features.ts';

export const ORIGIN = 'https://notes.yourversionnumber.com';
// Read from the checkout's root, where the build runs.
export const SITE_DIR = resolve('site');

export interface Page {
  /** The address, like /guide/start/. */
  path: string;
  title: string;
  description: string;
  /** The words as markup. */
  html: string;
}

/** site/faq.md is /faq/, site/guide/index.md is /guide/. */
export const pathOf = (file: string) => '/' + file.replace(/\.md$/, '/').replace(/(^|\/)index\/$/, '$1');

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: true });
// Each second-level heading gets an id from its words, so a question on the
// FAQ can be linked to: "How much does it cost?" is #how-much-does-it-cost.
markdown.core.ruler.push('heading_ids', (state) => {
  state.tokens.forEach((token, i) => {
    if (token.type !== 'heading_open' || token.tag !== 'h2') return;
    const words = state.tokens[i + 1]!.content;
    token.attrSet('id', slug(words));
  });
});
export const slug = (words: string) =>
  words
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A page from its Markdown: front matter of `title:` and `description:`
 * lines between two `---` lines, then the words. */
export function parsePage(path: string, source: string): Page {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!m) throw new Error(`${path}: no front matter`);
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`${path}: front matter line "${line}"`);
    meta[kv[1]!] = kv[2]!.trim();
  }
  const { title, description, ...rest } = meta;
  if (!title || !description || Object.keys(rest).length)
    throw new Error(`${path}: front matter is a title and a description`);
  const body = source.slice(m[0].length);
  // A recipe's own comments (# in a shell script) are no heading.
  if (/^# /m.test(body.replace(/^```[\s\S]*?^```$/gm, ''))) throw new Error(`${path}: the title is the one h1`);
  return { path, title, description, html: markdown.render(body) };
}

/** Every page in site/, in site/sitemap.json's order. */
export async function readPages(dir = SITE_DIR): Promise<Page[]> {
  const files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith('.md')).sort();
  const pages = await Promise.all(files.map(async (f) => parsePage(pathOf(f), await readFile(join(dir, f), 'utf8'))));
  const order = Object.keys(await sitemapDates(dir));
  for (const page of pages)
    if (!order.includes(page.path)) throw new Error(`${page.path}: add it to site/sitemap.json`);
  for (const path of order)
    if (path !== '/' && !pages.some((p) => p.path === path))
      throw new Error(`site/sitemap.json lists ${path}, which has no page`);
  pages.sort((a, b) => order.indexOf(a.path) - order.indexOf(b.path));
  return pages.map((page) => ({ ...page, html: fillLists(page, pages) }));
}

// Two lists drawn from lib/features.ts, the list the front page's tour
// draws: a page whose Markdown has a paragraph of `{features}` gets every
// feature there, each linked to its guide page, and one with `{guide}` the
// guide pages those link, by group, each once, leaving out any the page
// links above it.
const esc = (words: string) => words.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// A description after a colon, as the guide's own lists write them.
const lower = (words: string) => (/^[A-Z][a-z]/.test(words) ? words[0]!.toLowerCase() + words.slice(1) : words);
const LIST = /<p>\{(features|guide)\}<\/p>\n/g;
function fillLists(page: Page, pages: Page[]): string {
  return page.html.replace(LIST, (_, list: string, at: number) => {
    if (list === 'features')
      return FEATURES.map(
        (g) =>
          `<h2 id="${slug(g.head)}">${esc(g.head)}</h2>\n<ul>\n` +
          g.features
            .map((f) => `<li><strong><a href="${f.guide}">${esc(f.head)}</a></strong> ${esc(f.line)}</li>\n`)
            .join('') +
          '</ul>\n'
      ).join('');
    const seen = new Set(Array.from(page.html.slice(0, at).matchAll(/href="([^"]+)"/g), (m) => m[1]!));
    return FEATURES.map((g) => {
      const items = g.features.flatMap((f) => {
        if (seen.has(f.guide)) return [];
        seen.add(f.guide);
        const to = pages.find((p) => p.path === f.guide);
        if (!to) throw new Error(`lib/features.ts links ${f.guide}, which has no page`);
        return [`<li><a href="${to.path}">${esc(to.title)}</a>: ${esc(lower(to.description))}</li>\n`];
      });
      return items.length ? `<h3>${esc(g.head)}</h3>\n<ul>\n${items.join('')}</ul>\n` : '';
    }).join('');
  });
}

/** Each address's <lastmod>, and the hash of its words that the date holds for. */
export async function sitemapDates(dir = SITE_DIR): Promise<Record<string, { said: string; lastmod: string }>> {
  return JSON.parse(await readFile(join(dir, 'sitemap.json'), 'utf8'));
}

/** The sections CloudFront serves pages for: the first part of each address. */
export const sectionsOf = (pages: { path: string }[]) => [...new Set(pages.map((p) => p.path.split('/')[1]))].sort();

/** sitemap.xml: the front page and every page, each with its <lastmod>. */
export function sitemapXml(dates: Record<string, { lastmod: string }>): string {
  const urls = Object.entries(dates).map(
    ([path, { lastmod }]) => `  <url>\n    <loc>${ORIGIN}${path}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>\n`
  );
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.join('') +
    '</urlset>\n'
  );
}

/** What an agent may do with each scope it is granted (docs/MCP.md), in the
 * order the consent screen asks. tests-node/site.test.ts holds the names to
 * packages/backend/oauth.ts's SCOPES. */
export const SCOPES: [string, string][] = [
  [
    'notes:read',
    'read the notes, with their transcripts and photo descriptions, and the rest of the account read-only: releases, badges (while they are shown), the activity log and settings. Never the email address, the standing address or the calendar link. It can also send Jamie feedback.'
  ],
  ['media:read', 'also read the photos, recordings and files themselves.'],
  [
    'notes:write',
    'add notes at the subscriber’s request, and add to or edit the notes that same connection added. It never deletes a note.'
  ],
  [
    'media:write',
    'attach photos, recordings and PDFs to those notes, at most 4 files and 4 MB a call. Only with notes:write.'
  ],
  ['upcoming', 'list, add, change and remove Upcoming dates. Never notes.']
];

/** llms.txt: what Release Notes is, each page, how an agent connects, and
 * the API for scripts and apps. */
export function llmsTxt(pages: Page[]): string {
  return [
    '# Release Notes',
    '',
    '> A daily journal by email, from Your Version Number. Each morning’s email has your version number (your age, written like software: 5.2.113 is 52 years and 113 days), and whatever you reply becomes that day’s release notes. Free with a Weekly Thing subscription.',
    '',
    'A hobby by Jamie Thingelstad. Sign up and sign in at ' +
      ORIGIN +
      '/. Everything past the pages below is the signed-in app.',
    '',
    '## Pages',
    '',
    ...pages.map((p) => `- [${p.title}](${ORIGIN}${p.path}): ${p.description}`),
    '',
    '## Agents',
    '',
    `A subscriber can connect an agent such as Claude or ChatGPT as a remote MCP connector at ${ORIGIN}/mcp. The subscriber signs in and approves each scope; disconnecting in Settings ends it at once.`,
    '',
    ...SCOPES.map(([scope, words]) => `- \`${scope}\`: ${words}`),
    '',
    '## Scripts and apps',
    '',
    `Scripts and apps add notes through the API at ${ORIGIN}/v1, with an API token the subscriber makes in Settings. For now only Jamie can make one; tokens open to every account after that. A token adds notes in the subscriber’s own voice and never reads them. ${ORIGIN}/v1/openapi.json describes every request and needs no token, and ${ORIGIN}/guide/api/ is the guide.`,
    ''
  ].join('\n');
}
