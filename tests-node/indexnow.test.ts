/** IndexNow (tools/indexnow.ts): which addresses a release sends, the request,
 * and that a refusal or a network failure is an error release.sh can warn
 * about. A fake post stands in for the network; nothing is ever sent. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ENDPOINT, KEY, KEY_LOCATION, ORIGIN, changedUrls, payload, submit } from '../tools/indexnow.ts';
import { ORIGIN as SITE_ORIGIN } from '../web/src/site-pages.ts';
import { main } from '../tools/release-cli.ts';

const now = {
  '/': { said: 'a', lastmod: '2026-10-29' },
  '/how-it-works/': { said: 'b', lastmod: '2026-10-25' },
  '/privacy/': { said: 'c', lastmod: '2026-10-29' },
  '/guide/upcoming/': { said: 'd', lastmod: '2026-10-29' }
};
const before = {
  '/': { said: 'a0', lastmod: '2026-10-28' },
  '/how-it-works/': { said: 'b', lastmod: '2026-10-25' },
  '/privacy/': { said: 'c', lastmod: '2026-10-29' },
  '/gone/': { said: 'e', lastmod: '2026-10-20' }
};

test('the key and its file agree, on this site', async () => {
  assert.equal(ORIGIN, SITE_ORIGIN);
  assert.match(KEY, /^[a-f0-9]{32}$/);
  assert.equal(KEY_LOCATION, `${ORIGIN}/${KEY}.txt`);
  // The engines fetch it and compare: its body is exactly the key.
  assert.equal(await readFile(resolve(`web/public/${KEY}.txt`), 'utf8'), KEY);
});

test('only addresses whose words or lastmod moved, or that are new, are sent; one taken off is not', () => {
  // / has new words and a new day, /guide/upcoming/ is new, and /privacy/'s
  // words changed again on the day they last did.
  const later = { ...now, '/privacy/': { said: 'c2', lastmod: '2026-10-29' } };
  assert.deepEqual(changedUrls(before, later), [`${ORIGIN}/`, `${ORIGIN}/guide/upcoming/`, `${ORIGIN}/privacy/`]);
  assert.deepEqual(changedUrls(before, now), [`${ORIGIN}/`, `${ORIGIN}/guide/upcoming/`]);
  // The same release again sends nothing.
  assert.deepEqual(changedUrls(now, now), []);
});

test('one POST of the changed addresses, with the key and where it is; none when nothing changed', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const post = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status: 202 };
  };
  assert.match(await submit([], post), /nothing sent/);
  assert.equal(calls.length, 0);
  const urls = [`${ORIGIN}/`, `${ORIGIN}/privacy/`];
  assert.equal(await submit(urls, post), 'IndexNow: 202 for 2 pages changed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, ENDPOINT);
  assert.equal(calls[0]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    host: 'notes.yourversionnumber.com',
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls
  });
  assert.deepEqual(payload(urls).urlList, urls);
});

test('a refusal or an unreachable IndexNow is an error, for release.sh to warn about', async () => {
  for (const status of [400, 403, 422, 429, 500])
    await assert.rejects(
      submit([`${ORIGIN}/`], async () => ({ status })),
      new RegExp(`IndexNow answered ${status}`)
    );
  await assert.rejects(
    submit([`${ORIGIN}/`], async () => {
      throw new TypeError('fetch failed');
    }),
    TypeError
  );
});

test('the release tool plans without sending, and refuses a relative path', async () => {
  const sitemap = resolve('site/sitemap.json');
  assert.equal(
    await main(['indexnow-plan', '--before', sitemap, '--after', sitemap]),
    'IndexNow: no page changed, nothing would be sent'
  );
  await assert.rejects(main(['indexnow', '--before', 'site/sitemap.json', '--after', sitemap]), /absolute path/);
  await assert.rejects(main(['indexnow', '--before', sitemap, '--sitemap', sitemap]), /Invalid release option/);
});
