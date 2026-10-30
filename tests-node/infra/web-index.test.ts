/** The edge code that picks the web bucket's page for an address: / alone is
 * front.html, which has the front page's words for readers that run no
 * script; a public page (site/, web/src/site.tsx) is its own index.html, one
 * address each; every other address but a file is index.html, whose #app is
 * empty, so no other address says the front page's words. The same code runs
 * on the way back, and makes an address under a public section that is none
 * of its pages a 404: the way back sees the address as the way in rewrote it,
 * so the way in marks the request. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { readPages, sectionsOf } from '../../web/src/site-pages.ts';

const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const source = /  WebIndexFunction:[\s\S]*?      FunctionCode: \|\n((?:        .*\n|\n)+)/
  .exec(template)![1]!
  .split('\n')
  .map((line) => line.replace(/^        /, ''))
  .join('\n');
type Headers = Record<string, { value: string }>;
type Request = { uri: string; headers: Headers };
type Response = { statusCode: number; statusDescription: string; headers: Headers };
const handler = runInNewContext(source + '\nhandler') as (event: {
  context: { eventType: 'viewer-request' | 'viewer-response' };
  request: Request;
  response?: Response;
}) => Request | Response;
const asked = (uri: string, headers: Headers = {}) =>
  handler({ context: { eventType: 'viewer-request' }, request: { uri, headers: { ...headers } } });
const served = (uri: string) => {
  const out = asked(uri);
  assert.ok('uri' in out, `${uri} is served, not redirected`);
  return out.uri;
};
// The status the viewer gets for the bucket's answer to an address. The way
// back is handed the request as the way in left it, rewritten address and
// all (what the live distribution does: on 2026-10-30 an unmarked
// /guide/repyling/ came back a 200, its address seen as /index.html).
const status = (uri: string, statusCode = 200, headers: Headers = {}) => {
  const request = asked(uri, headers);
  if (!('uri' in request)) return request.statusCode;
  const out = handler({
    context: { eventType: 'viewer-response' },
    request,
    response: { statusCode, statusDescription: 'OK', headers: { 'content-type': { value: 'text/html' } } }
  }) as Response;
  return out.statusCode;
};
// Its own realm's arrays and objects, made this one's to compare.
const PUBLIC = [...(runInNewContext(source + '\nPUBLIC') as string[])];
const PAGES = [...(runInNewContext(source + '\nPAGES') as string[])];

test('/ is front.html, the one page with the front page drawn in', () => {
  assert.equal(served('/'), '/front.html');
});

test('every other address but a file is index.html, the empty app', () => {
  for (const uri of [
    '/signin/',
    '/today/',
    '/day/',
    '/settings/',
    '/you/',
    '/signin',
    '/a/b/c/',
    '//',
    // Only the sections there are pages for: these are still the app's.
    '/feature/',
    '/changelogs/',
    '/faqs/',
    '/guides/',
    '/privacy-policy',
    '/a/guide/'
  ])
    assert.equal(served(uri), '/index.html', uri);
});

test('a public page is its own index.html, PAGES the pages site/ has and PUBLIC their folders', async () => {
  const pages = await readPages();
  assert.deepEqual(
    PAGES,
    pages.map((p) => p.path).sort(),
    'PAGES in WebIndexFunction lists each page of site/, in order: add a new page there too'
  );
  assert.deepEqual(
    PUBLIC,
    sectionsOf(pages).map((s) => `/${s}/`),
    'PUBLIC in WebIndexFunction lists each section of site/'
  );
  for (const { path } of pages) {
    assert.equal(served(path), path + 'index.html', path);
    assert.equal(status(path), 200, path);
  }
});

test('an address under a section that is none of its pages is the app’s Not found, as a 404', () => {
  for (const uri of [
    '/guide/not-yet/',
    '/guide/not-yet',
    '/guide/api/nope/',
    '/guide/api/clients/more/',
    '/features/nope/',
    '/faq/x',
    '/guide//',
    '/changelog/0.0.1/'
  ]) {
    assert.equal(served(uri), '/index.html', uri);
    assert.equal(status(uri), 404, uri);
  }
  // Only a 200 becomes one: a revalidation or an error stays as it was.
  assert.equal(status('/guide/not-yet/', 304), 304);
  assert.equal(status('/guide/not-yet/', 503), 503);
  // The answer for the address as rewritten is never one: a file, or the app.
  for (const uri of ['/index.html', '/guide/start/index.html', '/assets/index-abc123.js', '/guide/x.png'])
    assert.equal(status(uri), 200, uri);
});

test('the app’s own addresses, and any outside a section, keep their 200', () => {
  for (const uri of ['/', '/signin/', '/today/', '/day/', '/man/', '/nope', '/feature/', '/guides/', '/a/guide/'])
    assert.equal(status(uri), 200, uri);
});

test('only the way in marks an address missing, never the viewer', () => {
  const mark = (uri: string, headers: Headers = {}) => (asked(uri, headers) as Request).headers['x-rn-missing'];
  assert.deepEqual({ ...mark('/guide/repyling/') }, { value: '1' });
  for (const uri of ['/', '/today/', '/guide/start/', '/assets/index-abc123.js'])
    assert.equal(mark(uri, { 'x-rn-missing': { value: '1' } }), undefined, uri);
  assert.equal(status('/today/', 200, { 'x-rn-missing': { value: '1' } }), 200);
  // The way back alone, its address the rewritten one: the mark decides.
  const back = (headers: Headers) =>
    (
      handler({
        context: { eventType: 'viewer-response' },
        request: { uri: '/index.html', headers },
        response: { statusCode: 200, statusDescription: 'OK', headers: {} }
      }) as Response
    ).statusCode;
  assert.equal(back({ 'x-rn-missing': { value: '1' } }), 404);
  assert.equal(back({}), 200);
});

test('the function runs both ways on the web bucket’s behaviour, and nowhere else', () => {
  const distribution = template.slice(template.indexOf('\n  WebDistribution:\n'));
  const associations = /\n {8}DefaultCacheBehavior:\n[\s\S]*?\n {10}FunctionAssociations:\n((?: {12}.*\n)+)/.exec(
    distribution
  )![1]!;
  assert.equal(
    associations,
    [
      '            - EventType: viewer-request',
      '              FunctionARN: !GetAtt WebIndexFunction.FunctionMetadata.FunctionARN',
      '            - EventType: viewer-response',
      '              FunctionARN: !GetAtt WebIndexFunction.FunctionMetadata.FunctionARN',
      ''
    ].join('\n')
  );
  assert.equal(template.match(/WebIndexFunction\.FunctionMetadata\.FunctionARN/g)?.length, 2);
});

test('a public page without its final slash is sent to the address with it, for good', async () => {
  for (const { path } of await readPages()) {
    const uri = path.slice(0, -1),
      out = JSON.parse(JSON.stringify(asked(uri)));
    assert.deepEqual(
      out,
      { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: path } } },
      uri
    );
  }
});

test('a file is served as it is, front.html and index.html included', () => {
  for (const uri of [
    '/assets/index-abc123.js',
    '/robots.txt',
    '/sitemap.xml',
    '/manifest.webmanifest',
    '/front.html',
    '/index.html',
    '/llms.txt',
    '/guide/index.html',
    '/faq/index.html'
  ])
    assert.equal(served(uri), uri, uri);
});

test('the distribution’s root object is front.html too, whichever runs first', () => {
  const distribution = template.slice(template.indexOf('\n  WebDistribution:\n'));
  assert.match(distribution, /\n {8}DefaultRootObject: front\.html\n/);
  assert.equal(template.match(/DefaultRootObject:/g)?.length, 1);
});

test('robots.txt and sitemap.xml get a CSP that lets the browser’s own viewer style them, and nothing else', () => {
  const behaviors = template.slice(template.indexOf('        CacheBehaviors:\n'));
  for (const path of ['/robots.txt', '/sitemap.xml']) {
    const behavior = new RegExp(`- PathPattern: ${path.replace('.', '\\.')}\\n((?: {12}.*\\n)+)`).exec(behaviors)?.[1];
    assert.ok(behavior, path);
    assert.match(behavior, /TargetOriginId: web\n/);
    assert.match(behavior, /CachePolicyId: !Ref WebCachePolicy\n/);
    assert.match(behavior, /ResponseHeadersPolicyId: !Ref PlainFilesHeadersPolicy\n/);
  }
  const policy = /\n {2}PlainFilesHeadersPolicy:\n((?: {4}.*\n|\n)+?)\n {2}\S/.exec(template)![1]!;
  const csp = /ContentSecurityPolicy: "([^"]+)"/.exec(policy)![1]!;
  // Chrome's XML viewer styles inline and draws its fold arrows as data: images.
  assert.equal(
    csp,
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  for (const header of [
    'ContentTypeOptions:',
    'FrameOption: DENY',
    'ReferrerPolicy: same-origin',
    'AccessControlMaxAgeSec: 63072000'
  ])
    assert.ok(policy.includes(header), header);
});
