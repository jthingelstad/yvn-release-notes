/** The edge code that picks the web bucket's page for an address: / alone is
 * front.html, which has the front page's words for readers that run no
 * script; every other address but a file is index.html, whose #app is empty,
 * so no other address says the front page's words. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const source = /  WebIndexFunction:[\s\S]*?      FunctionCode: \|\n((?:        .*\n|\n)+)/
  .exec(template)![1]!
  .split('\n')
  .map((line) => line.replace(/^        /, ''))
  .join('\n');
const handler = runInNewContext(source + '\nhandler') as (event: { request: { uri: string } }) => { uri: string };
const served = (uri: string) => handler({ request: { uri } }).uri;

test('/ is front.html, the one page with the front page drawn in', () => {
  assert.equal(served('/'), '/front.html');
});

test('every other address but a file is index.html, the empty app', () => {
  for (const uri of ['/signin/', '/today/', '/day/', '/settings/', '/you/', '/signin', '/a/b/c/', '//'])
    assert.equal(served(uri), '/index.html', uri);
});

test('a file is served as it is, front.html and index.html included', () => {
  for (const uri of [
    '/assets/index-abc123.js',
    '/robots.txt',
    '/sitemap.xml',
    '/manifest.webmanifest',
    '/front.html',
    '/index.html'
  ])
    assert.equal(served(uri), uri, uri);
});

test('the distribution’s root object is front.html too, whichever runs first', () => {
  const distribution = template.slice(template.indexOf('\n  WebDistribution:\n'));
  assert.match(distribution, /\n {8}DefaultRootObject: front\.html\n/);
  assert.equal(template.match(/DefaultRootObject:/g)?.length, 1);
});
