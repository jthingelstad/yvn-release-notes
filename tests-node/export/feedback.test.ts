/** Feedback in the export: the words and answers, screenshots by their place
 * in the zip, and never a stored key. Fictional rows only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, feedbackFiles, filePaths, markdown } from '../../packages/backend/export.ts';

const rows = [
  { pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com', birthday: '1981-06-14', tz: 'America/Chicago' },
  {
    pk: 'USER#u',
    sk: 'FEEDBACK#0123456789abcdef',
    id: '0123456789abcdef',
    kind: 'bug',
    text: 'The map is blank',
    status: 'answered',
    follows: null,
    via: 'web',
    filed_at: '2026-10-28T12:00:00.000Z',
    updated_at: '2026-10-28T13:00:00.000Z',
    revision: 2,
    answers: [{ at: '2026-10-28T13:00:00.000Z', text: 'Fixed it.\nThanks.', status: 'answered' }],
    screenshots: [
      { n: 1, type: 'image/png', size: 10, width: 2, height: 3, key: 'media/u/feedback/0123456789abcdef-1.png' }
    ]
  },
  // Another account's key is never filed into this zip.
  {
    pk: 'USER#u',
    sk: 'FEEDBACK#fedcba9876543210',
    id: 'fedcba9876543210',
    kind: 'idea',
    text: 'Second',
    status: 'open',
    via: 'assistant',
    client: 'Assistant',
    filed_at: '2026-10-27T12:00:00.000Z',
    screenshots: [{ n: 1, type: 'image/jpeg', size: 10, key: 'media/other/feedback/x-1.jpg' }]
  }
];

test('the export files screenshots by day and item, and lists feedback oldest first with answers', () => {
  const files = filePaths(rows, 'u');
  assert.deepEqual(files[feedbackFiles('0123456789abcdef')], [
    {
      path: 'files/2026-10-28-feedback-0123456789abcdef-1.png',
      kind: 'image',
      type: 'image/png',
      key: 'media/u/feedback/0123456789abcdef-1.png'
    }
  ]);
  assert.equal(files[feedbackFiles('fedcba9876543210')], undefined);
  const data = build(rows, '2026-10-29T00:00:00Z', files);
  assert.deepEqual(
    data.feedback!.map((f) => f.id),
    ['fedcba9876543210', '0123456789abcdef']
  );
  assert.ok(!JSON.stringify(data.feedback).includes('media/'));
  assert.equal(
    (data.feedback![1]!.screenshots as { path?: string }[])[0]!.path,
    'files/2026-10-28-feedback-0123456789abcdef-1.png'
  );
  const md = markdown(data);
  assert.match(md, /## Feedback/);
  assert.match(md, /The map is blank/);
  assert.match(md, /!\[Screenshot 1\]\(files\/2026-10-28-feedback-0123456789abcdef-1\.png\)/);
  // Answers are quoted, escaped as every exported word is.
  assert.ok(md.includes('> Fixed it\\.\n> Thanks\\.'));
  // An account with no feedback has no section.
  assert.equal(build(rows.slice(0, 1), '2026-10-29T00:00:00Z').feedback, undefined);
  assert.doesNotMatch(markdown(build(rows.slice(0, 1), '2026-10-29T00:00:00Z')), /## Feedback/);
});
