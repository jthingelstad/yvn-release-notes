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
test('badges in the email: the clause beside a special number, one line for what is new, the closed release', () => {
  const at = (patch: number) => {
      const d = new Date(Date.parse('2026-03-05T00:00:00Z') + patch * 86400000).toISOString().slice(0, 10);
      return computeVersion('1972-03-05', d);
    },
    v = at(300);
  assert.equal(c.specialLine(v), '5.4.300 is a round number.');
  assert.equal(c.specialLine(at(345)), '5.4.345 reads the same both ways.');
  assert.equal(c.specialLine(at(364)), '5.4.364 is the last patch of 5.4.');
  // Release day is the birthday line's; secrets stay secret; most days are none.
  for (const patch of [0, 42, 256, 314, 299]) assert.equal(c.specialLine(at(patch)), null, String(patch));
  assert.equal(c.newsLine([]), null);
  assert.equal(c.newsLine([{ name: 'Round number', version: '5.4.300' }]), 'New badge: Round number, 5.4.300.');
  assert.equal(
    c.newsLine(['Hotfix', 'Cold start', 'Cadence beta'].map((name) => ({ name, version: '5.4.299' }))),
    'New badges: Hotfix, Cold start and Cadence beta.'
  );
  assert.equal(
    c.newsLine(['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name, version: '5.4.299' }))),
    'New badges: A, B, C and 3 more.'
  );
  const news = [{ name: 'Don’t panic', version: '5.4.42' }],
    text = c.body(v, '1972-03-05', { badges: { news }, lifetime: { notes: 3, days: 2, photos: 0, since: 2026 } }),
    html = c.htmlBody(v, '1972-03-05', '2026-12-30', { badges: { news } });
  assert.match(text, /^You're 5\.4\.300 today\. 5\.4\.300 is a round number\.\n/);
  assert.match(
    text,
    /3 notes across 2 days since 2026\.\nNew badge: Don’t panic, 5\.4\.42\. See your badges: https:\/\/notes\.yourversionnumber\.com\/badges\/\n/
  );
  assert.match(html, /<p class="ink-2" id="special-day"[^>]*>5\.4\.300 is a round number\.<\/p>/);
  assert.match(
    html,
    /id="badge-news"[^>]*>New badge: <strong[^>]*>Don&#8217;t panic<\/strong>, <span[^>]*>5\.4\.42<\/span>\./
  );
  assert.match(
    html,
    /<a class="link" href="https:\/\/notes\.yourversionnumber\.com\/badges\/"[^>]*>See your badges<\/a>/
  );
  // Nothing new: no line. Badges off: neither line.
  assert.ok(!c.body(v, '1972-03-05', { badges: { news: [] } }).includes('New badge'));
  assert.match(c.body(v, '1972-03-05', { badges: { news: [] } }), /round number/);
  for (const off of [c.body(v, '1972-03-05', { badges: null }), c.htmlBody(v, '1972-03-05', '2026-12-30', {})]) {
    assert.ok(!off.includes('round number'));
    assert.ok(!off.includes('New badge'));
    assert.ok(!off.includes('/badges/'));
  }
  const closed = { age: 54, days: 212, notes: 260, photos: 90, longest: 30 };
  assert.equal(
    c.closedLine({
      ...closed,
      badges: {
        coverage: 'beta',
        collected: [
          { name: 'Round number', count: 2 },
          { name: 'Pi', count: 1 },
          { name: 'Palindrome', count: 1 }
        ]
      }
    }),
    '212 days with notes, 260 notes and 90 photos. Longest streak: 30 days. Coverage: beta. Collected: Round number ×2, Pi and Palindrome.'
  );
  assert.equal(c.closedLine({ ...closed, badges: { coverage: null, collected: [] } }), c.closedLine(closed));
  assert.match(
    c.closedHtml({ ...closed, badges: { coverage: 'rc', collected: [{ name: 'Pi', count: 3 }] } }),
    /Coverage: rc\. Collected: Pi &#215;3\./
  );
});

test('the closed release thanks a Supporting Member by the nonprofits given to, and says nothing otherwise', () => {
  const closed = { age: 54, days: 212, notes: 260, photos: 90, longest: 30 },
    thanks = 'During 5.4 you supported EFF and Signal as a Weekly Thing Supporting Member. Thank you.';
  const text = c.closedBody({ ...closed, giving: ['EFF', 'Signal'] });
  assert.ok(text.includes(`\n${thanks}\nSee 5.4:`), text);
  assert.ok(c.closedHtml({ ...closed, giving: ['EFF', 'Signal'] }).includes(thanks));
  for (const none of [closed, { ...closed, giving: [] }]) {
    assert.ok(!c.closedBody(none).includes('Supporting Member'));
    assert.ok(!c.closedHtml(none).includes('Supporting Member'));
  }
});

test('a release with no notes that gave closes with the thank-you alone', () => {
  const closed = { age: 54, days: 0, notes: 0, photos: 0, longest: 0, giving: ['Signal'] },
    thanks = 'During 5.4 you supported Signal as a Weekly Thing Supporting Member. Thank you.';
  assert.ok(c.closedBody(closed).startsWith(`5.4 is closed.\n${thanks}\nSee 5.4: `), c.closedBody(closed));
  const html = c.closedHtml(closed);
  assert.ok(html.includes(thanks));
  assert.ok(!html.includes('with notes'), 'no count of nothing');
});
