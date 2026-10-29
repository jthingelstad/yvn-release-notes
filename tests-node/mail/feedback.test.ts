/** The one email an answer sends: plain text and HTML, nothing remote, the
 * answer's words escaped, and marked automatic so it draws no reply loop. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { feedbackAnswerMessage, feedbackAnswerSubject } from '../../packages/mail/compose.ts';

test('an answer email carries the answer, the next step and a link, loading nothing remote', async () => {
  const raw = await feedbackAnswerMessage({
    to: 'bea@example.com',
    fromAddr: 'notes@example.com',
    kind: 'bug',
    filed: '2026-10-28',
    status: 'needs_info',
    answer: 'Which phone was it? <script>alert(1)</script>\n\nA second paragraph.'
  });
  const message = await simpleParser(raw);
  assert.equal(message.subject, 'Jamie has a question about your feedback');
  assert.equal(message.headers.get('auto-submitted'), 'auto-generated');
  assert.match(message.text!, /Jamie answered the problem you reported on Wednesday, October 28\./);
  assert.match(message.text!, /Which phone was it\? <script>/);
  assert.match(message.text!, /\/feedback\//);
  const html = String(message.html);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /A second paragraph\./);
  // No remote image, font, stylesheet or tracking pixel.
  assert.ok(!/<img|<link|url\(|@import/i.test(html));
  assert.equal(message.attachments.length, 0);
  assert.equal(feedbackAnswerSubject('done'), 'Jamie answered your feedback');
  assert.equal(feedbackAnswerSubject('answered'), 'Jamie answered your feedback');
});
