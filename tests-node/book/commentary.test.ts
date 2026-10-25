/** Claude's commentary in a book: what the model is sent, how its answer is
 * checked, where it is set, the streamed call through the SDK, and the
 * export worker counting, refusing and failing. Fictional subscribers and a
 * fake model only; nothing here reaches the Anthropic API. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookPlan, type BookData } from '../../packages/book/data.ts';
import { renderBook } from '../../packages/book/render.ts';
import * as commentary from '../../packages/book/commentary.ts';
import { bookKey, runBook, type ExportContext } from '../../workers/export.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import type { Item } from '../../packages/backend/store-types.ts';

const now = Date.parse('2026-10-13T12:00:00Z') / 1000;

async function subscriber(extra: Item = {}) {
  const store = new FakeStore(),
    objects = new FakeObjects();
  await store.createSubscriber('u1', 'ada@example.com', {
    birthday: '1981-06-14',
    tz: 'America/Chicago',
    status: 'active',
    weekly_thing: 'member',
    describe: true,
    ...extra
  });
  await store.putNote('u1', '2026-09-30', 'w-0', { text: 'Last of September.', source: 'web' });
  await store.putNote('u1', '2026-10-12', 'w-a', {
    text: 'Lake day.\n\nA loon, close. #lake',
    source: 'web',
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/a.jpg', size: 5, description: 'A loon' },
      { n: 2, kind: 'image', type: 'image/jpeg', key: 'media/u1/files/b.jpg', size: 5 },
      { n: 3, kind: 'audio', type: 'audio/mp4', key: 'media/u1/files/c.m4a', size: 5, transcript: 'Hello lake' }
    ]
  });
  await store.putNote('u1', '2026-10-13', 'w-b', {
    text: 'Packed the car.',
    source: 'mcp',
    author: 'assistant',
    client: 'Claude'
  });
  return { store, objects };
}
async function plan(store: FakeStore, from = '2026-09-30', to = '2026-10-13') {
  return bookPlan(
    (await store.profile('u1'))!,
    'u1',
    from,
    to,
    await store.notesBetween('u1', from, to),
    {},
    {},
    {
      made: '2026-10-13'
    }
  );
}
const answer = (value: unknown, stop = 'end_turn'): commentary.Answer => ({
  text: typeof value === 'string' ? value : JSON.stringify(value),
  stop,
  usage: { input: 1200, output: 800 }
});
const good = {
  introduction: 'Two months, one lake.\n\nYou wrote short.',
  months: [
    { month: 'September 2026', opening: 'One day of it.' },
    { month: 'October 2026', opening: 'Then the lake.' }
  ],
  days: [{ date: '2026-10-12', note: 'The loon again.' }],
  afterword: 'And then the car was packed.'
};

test('the model is sent the book’s printed words as data, and asked for its shape', async () => {
  const { store } = await subscriber(),
    data = (await plan(store)).data,
    body = commentary.request(data);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.max_tokens, 32000);
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.deepEqual(body.output_config, {
    effort: 'high',
    format: { type: 'json_schema', schema: commentary.SCHEMA }
  });
  assert.equal(body.system, commentary.SYSTEM);
  const content = String(body.messages[0]!.content),
    sent = JSON.parse(content.slice(content.indexOf('{')));
  assert.deepEqual(
    sent.months.map((m: Item) => m.month),
    ['September 2026', 'October 2026']
  );
  const lake = sent.months[1].days[0];
  assert.equal(lake.date, '2026-10-12');
  assert.deepEqual(lake.notes[0], {
    text: 'Lake day.\n\nA loon, close. #lake',
    // A description only when the subscriber turned them on; never a file.
    photos: ['A loon', 'A photo'],
    voice_memos: ['Hello lake']
  });
  assert.equal(sent.months[1].days[1].notes[0].by, 'Added by Claude');
  assert.ok(!content.includes('media/'), 'no stored key is sent');
  // With descriptions off, the model learns only that there was a photo.
  const { store: plain } = await subscriber({ describe: false }),
    quiet = JSON.parse(String(commentary.request((await plan(plain)).data).messages[0]!.content).split('\n')[1]!);
  assert.deepEqual(quiet.months[1].days[0].notes[0].photos, ['A photo', 'A photo']);
});

test('an answer is checked field by field: only plain text the book holds a place for is kept', async () => {
  const { store } = await subscriber(),
    data = (await plan(store)).data;
  const c = commentary.commentaryFrom(
    answer({
      ...good,
      introduction: 'Two months,\none lake.\u0007\n\n\n\nYou wrote short.  ',
      months: [
        ...good.months,
        { month: 'March 1999', opening: 'Not in the book.' },
        { month: 'October 2026', opening: 'Twice.' }
      ],
      days: [
        { date: '2026-10-12', note: 'The loon again.' },
        { date: '2026-10-12', note: 'Twice.' },
        { date: '2026-10-11', note: 'A day with no notes.' },
        { date: '2026-10-13', note: 'Over the cap of one in three.' }
      ]
    }),
    data
  );
  assert.deepEqual(c.introduction, ['Two months, one lake.', 'You wrote short.']);
  assert.deepEqual(
    [...c.openings],
    [
      ['September 2026', ['One day of it.']],
      ['October 2026', ['Then the lake.']]
    ]
  );
  assert.deepEqual([...c.days], [['2026-10-12', ['The loon again.']]]);
  assert.deepEqual(c.afterword, ['And then the car was packed.']);
  // Whole paragraphs, while they fit.
  assert.deepEqual(commentary.paragraphsOf(`${'a'.repeat(500)}\n\n${'b'.repeat(200)}`, 600), ['a'.repeat(500)]);
  assert.deepEqual(commentary.paragraphsOf(7, 600), []);
  // A book of one month has no month openings.
  const october = (await plan(store, '2026-10-12', '2026-10-13')).data;
  assert.equal(commentary.commentaryFrom(answer(good), october).openings.size, 0);
  // A refusal, a cut-off answer, broken JSON or no introduction is unusable.
  for (const bad of [
    answer(good, 'refusal'),
    answer(good, 'max_tokens'),
    answer('{"introduction": "cut'),
    answer([good]),
    answer({ ...good, introduction: '  ' })
  ])
    assert.throws(() => commentary.commentaryFrom(bad, data), commentary.Unusable);
});

test('commentary is set apart in the book and named in its colophon', async () => {
  const { store, objects } = await subscriber(),
    p = await plan(store),
    c = commentary.commentaryFrom(answer(good), p.data),
    data = commentary.withCommentary(p.data, c, '2026-10-13');
  assert.deepEqual(data.introduction, ['Two months, one lake.', 'You wrote short.']);
  assert.deepEqual(data.afterword, ['And then the car was packed.']);
  assert.deepEqual(data.chapters[1]!.opening, ['Then the lake.']);
  assert.deepEqual(data.chapters[1]!.days[0]!.annotation, ['The loon again.']);
  assert.equal(data.chapters[1]!.days[1]!.annotation, undefined);
  assert.equal(
    data.colophon[1],
    'The introduction, the openings of the months, the notes set beside some days and the afterword are by Claude, an AI model made by Anthropic, written from this book’s notes on Tuesday, October 13, 2026 at its maker’s request.'
  );
  assert.equal(data.colophon.length, p.data.colophon.length + 1);
  // Typst sets it all: the introduction and afterword are pages of their own.
  const read = async (key: string) => (await objects.get(key).catch(() => null))?.body ?? null,
    plain = await renderBook(p, read, { now }),
    annotated = await renderBook(p, read, { now, finish: async () => data });
  assert.equal(annotated.warnings, 0);
  assert.ok(annotated.pages >= plain.pages + 2, `${annotated.pages} pages against ${plain.pages}`);
  // And a book of one month, with no contents page, too.
  const one = await plan(store, '2026-10-12', '2026-10-13'),
    alone = commentary.withCommentary(one.data, commentary.commentaryFrom(answer(good), one.data), '2026-10-13');
  assert.equal((await renderBook(one, read, { now, finish: async () => alone })).warnings, 0);
});

/** A server-sent event stream as the Messages API sends it. */
function stream(events: [string, Item][]): Response {
  return new Response(events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' }
  });
}
test('the call streams through the SDK, and a failure leaves only its status', async () => {
  const seen: Item[] = [];
  const text = JSON.stringify(good);
  const client = commentary.opusWith('sk-ant-synthetic', 60, async (_url, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return stream([
      [
        'message_start',
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 1 }
          }
        }
      ],
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(0, 20) } }
      ],
      ['ping', { type: 'ping' }],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: text.slice(20) } }
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      [
        'message_delta',
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 800 }
        }
      ],
      ['message_stop', { type: 'message_stop' }]
    ]);
  });
  const { store } = await subscriber(),
    data = (await plan(store)).data,
    got = await client(commentary.request(data));
  assert.deepEqual(got, answer(good));
  assert.equal(seen[0]!.stream, true);
  assert.equal(seen[0]!.model, 'claude-opus-5-5');
  // An API error says its status and nothing the server said.
  const failing = commentary.opusWith('sk-ant-synthetic', 60, async () =>
    Response.json(
      { type: 'error', error: { type: 'invalid_request_error', message: 'Lake day. was too long' } },
      { status: 400 }
    )
  );
  await assert.rejects(failing(commentary.request(data)), (error: Error) => {
    assert.ok(error instanceof commentary.WriterFailed);
    assert.equal(error.status, 400);
    assert.ok(!error.message.includes('Lake'));
    return true;
  });
});

async function building(writer?: commentary.Writer, from = '2026-09-30', to = '2026-10-13') {
  const s = await subscriber(),
    logs: Item[] = [];
  await s.store.startExport('u1', 'book-a', now, now + 86400, 'BOOK', { from, to, commentary: true, release: 45 });
  const context: ExportContext = {
    ...s,
    now,
    clock: () => now,
    log: (f) => void logs.push(f),
    ...(writer ? { writer: async () => writer } : {})
  };
  return { ...s, logs, context };
}
test('the worker has Claude write while the photos are made, and counts the finished book', async () => {
  const asked: commentary.Answer[] = [];
  let sent: BookData | null = null;
  const { store, objects, logs, context } = await building(async (body) => {
    sent = JSON.parse(String(body.messages[0]!.content).split('\n')[1]!);
    asked.push(answer(good));
    return answer(good);
  });
  assert.equal(await runBook(context, 'u1', 'book-a'), 'ready');
  assert.ok(sent);
  const row = (await store.export('u1', 'BOOK'))!;
  assert.equal(row.status, 'ready');
  assert.equal(await store.commentaryMade('u1', 45), 1);
  assert.ok((await objects.head(bookKey('u1', 'book-a'))).size > 0);
  // Counts only: no word of the notes or the commentary is logged.
  assert.deepEqual(logs[0], {
    event: 'book-commentary',
    user: 'u1',
    stop: 'end_turn',
    input: 1200,
    output: 800,
    seconds: 0
  });
  assert.ok(!JSON.stringify(logs).includes('loon'));
});

test('a refused or unusable answer ends the book as Claude’s failure, uncounted and unthrown', async () => {
  const { store, objects, logs, context } = await building(async () => answer(good, 'refusal'));
  assert.equal(await runBook(context, 'u1', 'book-a'), 'unusable');
  const row = (await store.export('u1', 'BOOK'))!;
  assert.deepEqual([row.status, row.reason], ['failed', 'commentary']);
  assert.equal(await store.commentaryMade('u1', 45), 0);
  assert.ok(!objects.calls.some((c) => c.operation === 'uploadFile'));
  assert.deepEqual(logs.at(-1), { event: 'book-failed', user: 'u1', cause: 'Unusable' });
});

test('a failed call ends the book as Claude’s failure and is thrown for the alarm', async () => {
  const { store, logs, context } = await building(async () => {
    throw new commentary.WriterFailed(529);
  });
  await assert.rejects(runBook(context, 'u1', 'book-a'), commentary.WriterFailed);
  const row = (await store.export('u1', 'BOOK'))!;
  assert.deepEqual([row.status, row.reason], ['failed', 'commentary']);
  assert.equal(await store.commentaryMade('u1', 45), 0);
  assert.deepEqual(logs.at(-1), { event: 'book-failed', user: 'u1', cause: 'WriterFailed', status: 529 });
  // With no writer set up the book fails plainly.
  const unset = await building();
  await assert.rejects(runBook(unset.context, 'u1', 'book-a'), /unavailable/);
  assert.equal((await unset.store.export('u1', 'BOOK'))!.reason, undefined);
});
