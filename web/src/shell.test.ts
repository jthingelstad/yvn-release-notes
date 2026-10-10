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
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i);
  });
});
