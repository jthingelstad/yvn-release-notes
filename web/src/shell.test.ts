// The page every address is served (CloudFront and the dev server answer
// any address but a file with it), and the titles the pages give it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { titleOf } from './components/common.tsx';

describe('titleOf', () => {
  it('titles a page after the product', () => {
    expect(titleOf('')).toBe('Release Notes');
    expect(titleOf('Today')).toBe('Today: Release Notes');
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

  it('offers search the front page alone', () => {
    expect(html).toContain('<link rel="canonical" href="https://notes.yourversionnumber.com/" />');
    const robots = readFileSync('web/public/robots.txt', 'utf8');
    expect(robots).toMatch(/^Sitemap: https:\/\/notes\.yourversionnumber\.com\/sitemap\.xml$/m);
    for (const path of ['/api/', '/oauth/', '/mcp', '/signin/', '/unsubscribe/'])
      expect(robots).toContain(`Disallow: ${path}\n`);
    const sitemap = readFileSync('web/public/sitemap.xml', 'utf8');
    expect(Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g), (m) => m[1])).toEqual([
      'https://notes.yourversionnumber.com/'
    ]);
  });
});
