import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { parseHeaders } from '../../packages/mail/parse.ts';
import * as c from '../../packages/mail/compose.ts';
import * as a from '../../packages/mail/auth.ts';
import { computeVersion } from '../../packages/domain/version.ts';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/compose.json', import.meta.url), 'utf8')) as {
  cases: { name: string; birthday: string; day: string; options: c.BodyOptions; body: string; html: string }[];
  helpers: Record<string, string>;
};
for (const row of fixture.cases)
  test(`legacy email rendering parity: ${row.name}`, () => {
    const v = computeVersion(row.birthday, row.day);
    assert.equal(c.body(v, row.birthday, row.options), row.body);
    assert.equal(c.htmlBody(v, row.birthday, row.day, row.options), row.html);
    assert.ok(Array.from(row.html).every((c) => c.codePointAt(0)! <= 127));
    assert.ok(!/<(?:script|link|iframe)\b|box-shadow|background-image|<img[^>]+src="https?:/i.test(row.html));
  });
test('account and late-reply rendering matches legacy copy exactly', () => {
  const h = fixture.helpers;
  assert.equal(c.lateText('5.4.222', '2026-10-13'), h.lateText);
  assert.equal(c.lateHtml('5.4.222', '2026-10-13'), h.lateHtml);
  assert.equal(a.signinText('https://notes.example.com/?t=fictional', '493027'), h.signinText);
  assert.equal(a.signinHtml('https://notes.example.com/?t=fictional', '493027'), h.signinHtml);
  assert.equal(a.deleteText('493027'), h.deleteText);
  assert.equal(a.deleteHtml('493027'), h.deleteHtml);
});
test('120-bit reply tokens are exactly 24 lowercase base32 characters', () => {
  const tokens = new Set(Array.from({ length: 200 }, c.newToken));
  assert.equal(tokens.size, 200);
  for (const token of tokens) assert.match(token, /^[a-z2-7]{24}$/);
});
test('MIME carries related inline thumbnails, no URLs; named sender and unsubscribe', async () => {
  const row = fixture.cases[1]!,
    raw = await c.buildMessage({
      to: 'ada@example.com',
      fromAddr: 'notes@example.com',
      inboundDomain: 'in.example.com',
      v: computeVersion(row.birthday, row.day),
      birthday: row.birthday,
      day: row.day,
      ...row.options,
      token: 'a'.repeat(24),
      inbox: 'b'.repeat(24),
      images: {
        'one@example.com': Buffer.from('fictional-jpeg'),
        'two@example.com': Buffer.from('fictional-jpeg'),
        'old@example.com': Buffer.from('fictional-jpeg')
      }
    }),
    parsed = await simpleParser(raw, { keepCidLinks: true });
  assert.equal(parsed.from?.value[0]?.name, 'Release Notes');
  assert.equal(parsed.replyTo?.value[0]?.address, `n-${'a'.repeat(24)}@in.example.com`);
  assert.equal((await parseHeaders(raw)).get('list-unsubscribe-post'), 'List-Unsubscribe=One-Click');
  assert.equal(parsed.attachments.length, 3);
  assert.match(raw.toString(), /multipart\/related/);
  for (const photo of parsed.attachments) {
    assert.equal(photo.contentType, 'image/jpeg');
    assert.equal(photo.contentDisposition, 'inline');
    assert.equal(photo.related, true);
  }
  assert.match(String(parsed.html), /cid:one@example.com/);
  assert.match(parsed.text!, /Write any day, no reply needed: b{24}@in.example.com/);
});
test('late MIME is automatic, optionally threaded, and account messages have no unsubscribe', async () => {
  const raw = await c.lateMessage({
      to: 'ada@example.com',
      fromAddr: 'notes@example.com',
      version: '5.4.222',
      day: '2026-10-13',
      inReplyTo: '<reply@example.com>'
    }),
    msg = await simpleParser(raw);
  assert.equal(msg.headers.get('auto-submitted'), 'auto-replied');
  assert.equal(msg.inReplyTo, '<reply@example.com>');
  assert.equal(msg.headers.has('list-unsubscribe'), false);
  assert.equal(c.messageId('<ok@example.com>'), '<ok@example.com>');
  for (const invalid of ['x', '<a>\r\nBcc: leak@example.com', '<a><b>', '<' + 'a'.repeat(251) + '>'])
    assert.equal(c.messageId(invalid), null);
  for (const bytes of [
    await a.signinMessage({
      to: 'ada@example.com',
      fromAddr: 'notes@example.com',
      link: 'https://notes.example.com/?t=fictional',
      code: '493027'
    }),
    await a.deleteMessage({ to: 'ada@example.com', fromAddr: 'notes@example.com', code: '493027' })
  ]) {
    const parsed = await simpleParser(bytes);
    assert.equal(parsed.headers.has('list-unsubscribe'), false);
    assert.match(parsed.subject!, /493027/);
  }
});
test('safe HTML/link rendering and code-point/sentence budgets', () => {
  assert.equal(c.asciiHtml('🌲<"&'), '&#127794;&lt;&quot;&amp;');
  assert.deepEqual(c.pastText('😀 one two three', 7), ['😀 one', true]);
  assert.deepEqual(c.pastText('a'.repeat(100), 12), ['', true]);
  assert.equal(c.pastMore(false, { audio: 1 }), 'Hear the recording');
  assert.equal(c.pastMore(true, { image: 1, audio: 1 }), 'Read the rest, with the photo and a recording');
  assert.deepEqual(
    c.unshown({ image: 2, audio: 1 }, [
      { cid: 'a', alt: 'Photo', width: 2, height: 2 },
      { cid: 'b', alt: 'Photo', width: 2, height: 2 }
    ]),
    { image: 0, audio: 1 }
  );
});
