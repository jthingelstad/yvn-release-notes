// The pages: one route and one built copy of index.html each
// (vite.config.ts), and the shell that loads only its own files.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGES, titleOf } from './paths.ts';

describe('PAGES', () => {
  it('lists each page once, as a folder', () => {
    const paths = PAGES.map(([p]) => p);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of paths) expect(p).toMatch(/^\/([a-z]+\/)?$/);
  });

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
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
  });
});
