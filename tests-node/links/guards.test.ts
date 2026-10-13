import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as links from '../../packages/backend/links.ts';

test('only ordinary http ports and public DNS answers can be contacted', () => {
  for (const url of [
    'ftp://example.com',
    'https://user:pw@example.com',
    'https://example.com:8443',
    'https:///x',
    'http://example.com:443',
    'http://example.com\\@localhost'
  ])
    assert.equal(links.target(url), null, url);
  for (const addresses of [
    [],
    ['127.0.0.1'],
    ['10.1.2.3'],
    ['192.168.1.1'],
    ['172.16.0.1'],
    ['169.254.169.254'],
    ['100.64.0.1'],
    ['0.0.0.0'],
    ['::1'],
    ['fe80::1%en0'],
    ['fd00::1'],
    ['::ffff:127.0.0.1'],
    ['::ffff:10.0.0.1'],
    ['224.0.0.1'],
    ['ff02::1'],
    ['93.184.216.34', '10.0.0.1']
  ])
    assert.equal(links.publicIp(addresses), null, addresses.join(','));
  assert.equal(links.publicIp(['93.184.216.34', '2606:2800:220:1::1']), '93.184.216.34');
});
test('redirect rechecks DNS and keeps the exact validated connection address', async () => {
  const contacted: string[] = [];
  const result = await links.fetchTitle('https://example.com/start', {
    resolve: async (host) => (host === 'example.com' ? ['93.184.216.34'] : ['10.0.0.1']),
    connect: async (target, ip) => {
      contacted.push(`${target.host}/${ip}`);
      return { status: 302, headers: { location: 'https://inside.example/admin' }, body: new Uint8Array() };
    }
  });
  assert.equal(result, null);
  assert.deepEqual(contacted, ['example.com/93.184.216.34']);
});
test('one wall clock deadline bounds a stalled DNS lookup or response', async () => {
  for (const dns of [true, false]) {
    let contacted = false,
      aborted = false;
    const start = performance.now();
    const result = await links.fetchTitle('https://example.com', {
      limit: 20,
      resolve: async () => (dns ? new Promise<string[]>(() => {}) : ['93.184.216.34']),
      connect: async (_t, _ip, signal) => {
        contacted = true;
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise<links.PageResponse>(() => {});
      }
    });
    assert.equal(result, null);
    assert.ok(performance.now() - start < 500);
    assert.equal(contacted, !dns);
    if (!dns) assert.equal(aborted, true);
  }
});
test('named links, retained titles, bounded fetches and rendering match the legacy shape', async () => {
  const asked: string[] = [];
  const fetch: links.TitleFetcher = (url) => {
    asked.push(url);
    return { title: 'Fetched', site: 'example.com' };
  };
  const named = await links.collect('my\n post <https://example.com/p>', {
    named: { 'https://example.com/p': 'my post' },
    fetch
  });
  assert.deepEqual(named, [{ url: 'https://example.com/p', title: 'my post', named: true }]);
  assert.deepEqual(links.segments('my\n post <https://example.com/p>.', named), [
    { url: 'https://example.com/p', label: 'my post' },
    '.'
  ]);
  await links.collect('https://example.com/a https://example.com/b https://example.com/c https://example.com/d', {
    fetch
  });
  assert.equal(asked.length, 3);
  assert.equal(
    links.plain('https://example.com/a', [{ url: 'https://example.com/a', title: 'Kept' }]),
    'Kept <https://example.com/a>'
  );
  assert.deepEqual(
    await links.collect('https://example.com/a', { keep: [{ url: 'https://example.com/a', title: 'Kept' }], fetch }),
    [{ url: 'https://example.com/a', title: 'Kept' }]
  );
});
test('page metadata preserves HTML entities, preference, charset and word truncation', () => {
  assert.deepEqual(
    links.pageMeta(
      Buffer.from('<title>Plain</title><meta property="og:title" content="A &amp; B">'),
      'text/html',
      'www.example.com'
    ),
    { title: 'A & B', site: 'example.com' }
  );
  assert.equal(
    links.pageMeta(Buffer.from('<meta charset="iso-8859-1"><title>Café</title>', 'latin1'), 'text/html', 'example.com')
      ?.title,
    'Café'
  );
  assert.equal(links.pageMeta(Buffer.from('<title> </title>'), 'text/html', 'example.com'), null);
  assert.equal(links.clean('word '.repeat(100), 200).endsWith('word…'), true);
});
