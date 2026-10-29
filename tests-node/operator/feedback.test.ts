/** tools/feedback.ts on the fake table: the queue by account id, screenshots
 * saved to a local directory, and an answer that is a dry run until --write. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeMail, FakeObjects } from '../../packages/testing/services.ts';
import { answer, list, show } from '../../tools/feedback.ts';

const now = Date.parse('2026-10-28T15:00:00Z') / 1000;
function fixture() {
  const store = new FakeStore([
    { pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com', tz: 'UTC', birthday: '1981-06-14', status: 'active' },
    {
      pk: 'USER#u',
      sk: 'FEEDBACK#0123456789abcdef',
      id: '0123456789abcdef',
      kind: 'bug',
      text: 'Broken',
      status: 'open',
      via: 'assistant',
      client: 'Assistant',
      filed_at: '2026-10-28T12:00:00.000Z',
      updated_at: '2026-10-28T12:00:00.000Z',
      revision: 1,
      answers: [],
      screenshots: [{ n: 1, type: 'image/png', size: 4, key: 'media/u/feedback/0123456789abcdef-1.png' }]
    },
    {
      pk: 'USER#u',
      sk: 'FEEDBACK#fedcba9876543210',
      id: 'fedcba9876543210',
      kind: 'idea',
      text: 'Done already',
      status: 'done',
      via: 'web',
      filed_at: '2026-10-27T12:00:00.000Z',
      revision: 2
    }
  ]);
  return { store, objects: new FakeObjects(), mail: new FakeMail() };
}

test('the queue names accounts by id only, waiting items unless --all', async () => {
  const f = fixture();
  const waiting = await list(f.store);
  assert.deepEqual(
    waiting.map((i: Record<string, unknown>) => [i.owner, i.id, i.account]),
    [['u', '0123456789abcdef', 'active']]
  );
  assert.equal((await list(f.store, true)).length, 2);
  assert.ok(!JSON.stringify(await list(f.store, true)).includes('@'));
  assert.ok(!JSON.stringify(waiting).includes('media/'));
});

test('show saves screenshots to a private local file and never prints their keys', async () => {
  const f = fixture();
  await f.objects.put('media/u/feedback/0123456789abcdef-1.png', Buffer.from('png!'), { type: 'image/png' });
  const dir = await mkdtemp(join(tmpdir(), 'rn-feedback-test-'));
  const shown = await show(f.store, f.objects, 'u', '0123456789abcdef', dir);
  assert.deepEqual(shown.saved, [join(dir, '0123456789abcdef-1.png')]);
  assert.equal(await readFile(shown.saved[0]!, 'utf8'), 'png!');
  assert.equal((await stat(shown.saved[0]!)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify({ ...shown, saved: [] }).includes('media/'));
  await assert.rejects(show(f.store, f.objects, 'u', '1111111111111111', dir), /No such feedback/);
});

test('an answer is a dry run until --write, then appends once and emails the active filer', async () => {
  const f = fixture(),
    deps = { store: f.store, mail: f.mail, now };
  const dry = await answer(deps, 'u', '0123456789abcdef', { text: 'Fixed', status: 'done' }, false);
  assert.deepEqual(dry, {
    dry_run: true,
    owner: 'u',
    id: '0123456789abcdef',
    revision: 1,
    status: { from: 'open', to: 'done' },
    answers: 1
  });
  assert.equal(f.mail.messages.length, 0);
  assert.equal((await f.store.feedbackItem('u', '0123456789abcdef'))!.answers.length, 0);
  await assert.rejects(answer(deps, 'u', '0123456789abcdef', { text: 'x', status: 'open' }, true), /status/);
  const done = await answer(deps, 'u', '0123456789abcdef', { text: 'Fixed', status: 'done' }, true);
  assert.deepEqual(done, {
    dry_run: false,
    owner: 'u',
    id: '0123456789abcdef',
    status: 'done',
    revision: 2,
    mail: 'sent'
  });
  assert.equal(f.mail.messages.length, 1);
  assert.equal((await f.store.feedbackItem('u', '0123456789abcdef'))!.answers[0]!.text, 'Fixed');
});
