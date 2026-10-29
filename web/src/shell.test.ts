// The page every address is served (CloudFront and the dev server answer
// any address but a file with it; / has it as front.html, the front page
// drawn in), and the titles the pages give it.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FRONT_TITLE, titleOf } from './components/common.tsx';

describe('titleOf', () => {
  it('titles a page after the product', () => {
    expect(titleOf('')).toBe(FRONT_TITLE);
    expect(titleOf('Today')).toBe('Today: Release Notes');
  });
  it('gives the front page the title index.html has, for search', () => {
    expect(readFileSync('web/index.html', 'utf8')).toContain(`<title>${FRONT_TITLE}</title>`);
  });
});

describe('index.html', () => {
  const html = readFileSync('web/index.html', 'utf8');

  it('has no inline script or style, for the CSP', () => {
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    for (const tag of html.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []) {
      expect(tag).toMatch(/^<script type="module" src="\/[^"]+"><\/script>$/);
    }
  });

  it('loads nothing remote', () => {
    // The canonical link names the front page's address; it loads nothing.
    const loads = html.replace(/<link rel="canonical" href="[^"]*" \/>/, '');
    expect(loads).not.toMatch(/(src|href)="(https?:)?\/\//i);
  });

  it('offers search the front page and the public pages alone', () => {
    expect(html).toContain('<link rel="canonical" href="https://notes.yourversionnumber.com/" />');
    const robots = readFileSync('web/public/robots.txt', 'utf8');
    expect(robots).toMatch(/^Sitemap: https:\/\/notes\.yourversionnumber\.com\/sitemap\.xml$/m);
    for (const path of ['/api/', '/oauth/', '/mcp']) expect(robots).toContain(`Disallow: ${path}\n`);
    // A page blocked here could still be listed, its noindex unread.
    expect(robots).not.toMatch(/^Disallow: \/(signin|unsubscribe)/m);
    // The sitemap is built from site/sitemap.json (site.tsx): / first, then
    // the public pages, each of them a page of site/, never the app's.
    const listed = Object.keys(JSON.parse(readFileSync('site/sitemap.json', 'utf8')));
    expect(listed[0]).toBe('/');
    for (const path of listed.slice(1)) {
      expect(path).toMatch(/^\/[a-z-]+\/(?:[a-z-]+\/){0,2}$/);
      expect(existsSync(`site${path.replace(/\/$/, '')}.md`) || existsSync(`site${path}index.md`)).toBe(true);
    }
  });
});
