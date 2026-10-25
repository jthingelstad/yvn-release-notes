// front.html's front page (prerender.tsx): Home as it opens for someone
// signed out, drawn without a browser, and only into index.html's one empty
// #app. tests-node/front-page.test.ts checks the built pages themselves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EMPTY_APP, frontMarkup, withFront } from './prerender.tsx';

describe('frontMarkup', () => {
  const markup = frontMarkup();

  it('is the front page as it opens: the question, the birthday form, the tour and the foot', () => {
    expect(markup).toMatch(/^<main data-prerendered><header class="bar">/);
    for (const words of [
      '<h1>What’s your version number?</h1>',
      '<form id="birthday-form"',
      'Show me my number',
      '<section id="tour"',
      'The easiest journal you’ll ever keep.',
      '<p class="foot" id="home-foot">'
    ])
      expect(markup).toContain(words);
  });

  it('leaves out what that view hides, and has no script or inline style for the CSP', () => {
    expect(markup).not.toMatch(/\shidden[\s>=]/);
    expect(markup).not.toMatch(/<script|<style|\sstyle=/i);
  });

  it('says the same each time it is drawn: nothing in it is dated or personal', () => {
    expect(frontMarkup()).toBe(markup);
  });
});

describe('withFront', () => {
  const index = readFileSync('web/index.html', 'utf8');

  it('fills index.html’s one empty #app and changes nothing else', () => {
    expect(index.split(EMPTY_APP)).toHaveLength(2);
    const front = withFront(index),
      [before, after] = index.split(EMPTY_APP);
    expect(front.startsWith(before! + '<div id="app"><main data-prerendered>')).toBe(true);
    expect(front.endsWith('</main></div>' + after!)).toBe(true);
  });

  it('refuses a page whose #app is missing, filled or doubled', () => {
    for (const page of [
      index.replace(EMPTY_APP, ''),
      index.replace(EMPTY_APP, '<div id="app">x</div>'),
      index.replace(EMPTY_APP, EMPTY_APP + EMPTY_APP)
    ])
      expect(() => withFront(page)).toThrow(/one empty/);
  });
});
