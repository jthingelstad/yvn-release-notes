import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as p from '../../packages/mail/parse.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/parse.json', import.meta.url), 'utf8')) as {
  name: string;
  raw: string;
  text: string;
  attachments: p.AttachmentInfo[];
  anchors: Record<string, string>;
}[];
for (const row of fixture)
  test(`legacy MIME/body parity: ${row.name}`, async () => {
    const msg = await p.parseMessage(Buffer.from(row.raw, 'base64'));
    assert.equal(p.noteText(msg), row.text);
    assert.deepEqual(p.attachments(msg), row.attachments);
    assert.deepEqual(p.anchors(msg), row.anchors);
  });
test('header-only parse preserves duplicate original auth results and duplicate From', async () => {
  const head = await p.parseHeaders(
    Buffer.from(
      'From: Ada <ada@example.com>\r\nFrom: Other <other@example.com>\r\nAuthentication-Results: amazonses.com;\r\n dkim=pass header.d=example.com\r\nAuthentication-Results: forged.invalid; dkim=pass header.d=example.com\r\n\r\n' +
        Array.from(
          { length: 200 },
          (_, n) => `--b${n}\r\nContent-Type: multipart/mixed; boundary=b${n + 1}\r\n\r\n`
        ).join('')
    )
  );
  assert.equal(head.all('from').length, 2);
  assert.deepEqual(head.all('Authentication-Results'), [
    'amazonses.com; dkim=pass header.d=example.com',
    'forged.invalid; dkim=pass header.d=example.com'
  ]);
});
test('bounded MIME nesting is rejected after headers can be read', async () => {
  let body = 'hello';
  for (let i = 0; i < 70; i++)
    body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--\r\n`;
  const raw = Buffer.from('From: ada@example.com\r\n' + body);
  await p.parseHeaders(raw);
  await assert.rejects(() => p.parseMessage(raw), /MIME nesting/);
});
test('parser enforces bounded raw/header limits and HTML never runs scripts', async () => {
  await assert.rejects(() => p.parseHeaders(Buffer.alloc(p.MAX_HEADER_BYTES + 5, 65)), /headers too large/);
  await assert.rejects(() => p.parseMessage(Buffer.alloc(p.MAX_RAW_BYTES + 1)), /Mail too large/);
  assert.equal(
    p.htmlToText('<p>A<script>bad</script><style>bad</style> B</p><blockquote>old</blockquote><p>C</p>'),
    'A B\n\nC'
  );
  assert.equal(p.htmlToText('<a href="file:///etc/passwd">local</a>'), 'local');
});
