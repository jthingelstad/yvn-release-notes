import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as d from '../../packages/backend/describe.ts';
import * as worker from '../../workers/describe.ts';
import { setup, photo, seedPhoto, day, id, now, stream } from './helpers.ts';
import type { Item } from '../../packages/backend/store.ts';
import { imageSize, thumbKey } from '../../packages/backend/media.ts';
import type { NoteRecord } from '../../packages/domain/notes.ts';
test('model request is exact fixed photo+prompt; text-only answer normalizes and truncates Unicode', async () => {
  const calls: Item[] = [],
    data = d.testImage();
  assert.deepEqual(imageSize(data), [64, 64]);
  const words = await d.wordsFor(data, 'image/png', async (body) => {
    calls.push(body);
    return {
      content: [
        { type: 'thinking', thinking: 'hidden thoughts' },
        { type: 'text', text: '  A blue\n square.  ' }
      ]
    };
  });
  assert.equal(words, 'A blue square.');
  assert.deepEqual(calls, [
    {
      model: 'claude-haiku-5-5',
      max_tokens: 2000,
      output_config: { effort: 'low' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } },
            { type: 'text', text: d.PROMPT }
          ]
        }
      ]
    }
  ]);
  assert.equal(
    Array.from(
      await d.wordsFor(data, 'image/png', async () => ({ content: [{ type: 'text', text: '😀'.repeat(601) }] }))
    ).length,
    600
  );
});
test('oversized/wide image/refusal/per-image 400 empty answer; auth/rate/invalid general errors retry', async () => {
  let calls = 0;
  const model = async () => {
    calls++;
    return {};
  };
  assert.equal(await d.wordsFor(Buffer.alloc(d.MAX_BYTES + 1), 'image/png', model), '');
  const wide = d.testImage();
  wide.writeUInt32BE(8001, 16);
  assert.equal(await d.wordsFor(wide, 'image/png', model), '');
  assert.equal(calls, 0);
  assert.equal(await d.wordsFor(d.testImage(), 'image/png', async () => ({ stop_reason: 'refusal' })), '');
  assert.equal(
    await d.wordsFor(d.testImage(), 'image/png', async () => {
      throw new d.ApiError(400, 'invalid_request_error', true);
    }),
    ''
  );
  for (const error of [
    new d.ApiError(401, 'authentication_error'),
    new d.ApiError(429, 'rate_limit_error'),
    new d.ApiError(400, 'invalid_request_error')
  ])
    await assert.rejects(
      () =>
        d.wordsFor(d.testImage(), 'image/png', async () => {
          throw error;
        }),
      error
    );
});
test('waiting excludes completed, unsupported, oversize and untrusted media', () => {
  assert.deepEqual(
    d.waiting({
      media: [
        photo(),
        { ...photo(1), description: '' },
        { ...photo(2), type: 'image/heic' },
        { ...photo(3), size: d.MAX_BYTES + 1 },
        { ...photo(4), key: 'remote' }
      ]
    }),
    [photo()]
  );
});
test('HTTP model adapter uses bounded fixed origin/no redirects and scrubbed errors', async () => {
  let url = '',
    options: RequestInit | undefined;
  const fetcher = (async (u: unknown, o: RequestInit) => {
    url = String(u);
    options = o;
    return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Fixture' }] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await d.claudeWith('sk-ant-synthetic', fetcher)({ model: 'fixture' }), {
    content: [{ type: 'text', text: 'Fixture' }]
  });
  assert.equal(url, d.API);
  assert.equal(options?.redirect, 'error');
  assert.equal(options?.method, 'POST');
  assert.deepEqual(options?.headers, {
    'x-api-key': 'sk-ant-synthetic',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json'
  });
  assert.equal(options?.body, '{"model":"fixture"}');
  assert.ok(options?.signal instanceof AbortSignal);
  const rejected = d.claudeWith(
    'sk-ant-synthetic',
    (async () =>
      new Response(
        JSON.stringify({ error: { type: 'private data in malicious kind', message: 'Private IMAGE user words' } }),
        { status: 400 }
      )) as typeof fetch
  );
  await assert.rejects(
    () => rejected({}),
    (error: unknown) => {
      assert.ok(error instanceof d.ApiError);
      assert.equal(error.kind, null);
      assert.equal(error.about_image, true);
      assert.equal(String(error).includes('Private'), false);
      return true;
    }
  );
  await assert.rejects(
    () =>
      d.claudeWith(
        'synthetic',
        (async () => new Response('private malformed body', { status: 200 })) as typeof fetch
      )({}),
    { message: 'Description response invalid' }
  );
  await assert.rejects(
    () =>
      d.claudeWith(
        'synthetic',
        (async () => new Response('x'.repeat(256 * 1024 + 1), { status: 200 })) as typeof fetch
      )({}),
    { message: 'Description response invalid' }
  );
  await assert.rejects(
    () =>
      d.claudeWith('synthetic', (async () => {
        throw new Error('secret-bearing network detail');
      }) as typeof fetch)({}),
    { message: 'Description service unavailable' }
  );
});
test('secret parser is injected/lazy, accepts synthetic key and never echoes malformed plaintext', async () => {
  assert.equal(
    await d.keyFrom({ get: async () => '{"ANTHROPIC_API_KEY":"sk-ant-fixture"}' }, 'secret-id'),
    'sk-ant-fixture'
  );
  for (const raw of [
    undefined,
    '{"ANTHROPIC_API_KEY":""}',
    '{"api_key":"sk-ant-fixture"}',
    'malformed private token',
    'null',
    '[]'
  ])
    await assert.rejects(() => d.keyFrom({ get: async () => raw }, 'synthetic'), {
      name: 'NoKey',
      message: 'Description key unavailable'
    });
  const calls: Item[] = [],
    source = worker.createSecretSource({
      async send(command: { input: Item }) {
        calls.push(command.input);
        return { SecretString: '{"ANTHROPIC_API_KEY":"sk-ant-fixture"}' };
      }
    } as never);
  assert.equal(await d.keyFrom(source, 'synthetic-id'), 'sk-ant-fixture');
  assert.deepEqual(calls, [{ SecretId: 'synthetic-id' }]);
});
test('photo description commits once, missing object marks empty without model call', async () => {
  const s = setup();
  await seedPhoto(s);
  assert.equal(await d.describe(s.note, 'u', s.services), 1);
  assert.equal(await d.describe(s.note, 'u', s.services), 0);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(((await s.store.note('u', day, id))!.media as Item[])[0], {
    ...photo(),
    description: 'A blue square.'
  });
  const missing = setup();
  assert.equal(await d.describe(missing.note, 'u', missing.services), 1);
  assert.equal(missing.calls.length, 0);
  assert.equal(((await missing.store.note('u', day, id))!.media as Item[])[0]?.description, '');
  // One activity row for the pass, never the words; nothing for the pass with none.
  const rows = await s.store.activityAll('u');
  assert.deepEqual(
    rows.map((r) => [r.kind, r.day, r.note, r.photos]),
    [['description.added', day, id, 1]]
  );
  assert.doesNotMatch(JSON.stringify(rows), /blue/);
});
test('photos described before a busy lease stopped the pass still get their activity row', async () => {
  const s = setup([photo(0), photo(1)]);
  await seedPhoto(s, 0);
  await seedPhoto(s, 1);
  await s.store.claimProcessing('describe', 'u', day, id, 1, String(photo(1).key), 'image/png', 'interrupted', now);
  await assert.rejects(() => d.describe(s.note, 'u', s.services), { message: 'Description processing lease busy' });
  assert.deepEqual(
    (await s.store.activityAll('u')).map((r) => [r.kind, r.photos]),
    [['description.added', 1]]
  );
});
test('opt-out/no account/deleting account never resolves model; changed media completion rejected', async () => {
  for (const state of ['off', 'deleting', 'gone']) {
    const s = setup();
    await seedPhoto(s);
    if (state === 'gone') await s.store.deleteProfile('u', null);
    else s.store.seed({ ...s.profile, ...(state === 'off' ? { describe: false } : { mcp_deleting: true }) });
    let resolved = 0;
    s.services.model = async () => {
      resolved++;
      throw new Error('should never resolve');
    };
    assert.equal(await d.describe(s.note, 'u', s.services), 0);
    assert.equal(resolved, 0);
  }
  for (const state of ['off', 'deleting', 'replacement', 'gone']) {
    const s = setup();
    await seedPhoto(s);
    s.services.model = async () => async () => {
      if (state === 'gone') await s.store.deleteNote('u', day, id);
      else if (state === 'replacement') s.store.seed({ ...s.note, media: [{ ...photo(), key: 'media/u/new.png' }] });
      else s.store.seed({ ...s.profile, ...(state === 'off' ? { describe: false } : { mcp_deleting: true }) });
      return { content: [{ type: 'text', text: 'private result' }] };
    };
    assert.equal(await d.describe(s.note, 'u', s.services), 0);
    assert.equal(((await s.store.note('u', day, id))?.media as Item[] | undefined)?.[0]?.description, undefined);
    assert.equal(await s.store.processing('u', 'describe', day, id, 0), null);
  }
});
test('failed model keeps photo waiting and releases lease; busy interrupted lease stays retryable', async () => {
  const s = setup();
  await seedPhoto(s);
  s.services.model = async () => async () => {
    throw new d.ApiError(429, 'rate_limit_error');
  };
  await assert.rejects(() => d.describe(s.note, 'u', s.services), { name: 'ApiError' });
  assert.equal(await s.store.processing('u', 'describe', day, id, 0), null);
  await s.store.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'interrupted', now);
  await assert.rejects(() => d.describe(s.note, 'u', s.services), { message: 'Description processing lease busy' });
  s.services.clock = () => now + 960;
  s.services.model = async () => async () => ({ content: [] });
  assert.equal(await d.describe(s.note, 'u', s.services), 1);
});
test('default stream path makes thumbnails without consent, original unchanged, stale events skip finished work', async () => {
  const s = setup([photo()], { describe: false });
  await seedPhoto(s);
  const original = (await s.objects.get(String(photo().key))).body;
  await worker.runEvent({ Records: [stream(s.note)] }, {}, s.services);
  const note = await s.store.note('u', day, id),
    entry = (note!.media as Item[])[0]!;
  assert.equal(s.calls.length, 0);
  assert.equal((entry.thumb as Item).key, thumbKey(String(photo().key)));
  assert.equal(entry.description, undefined);
  assert.deepEqual((await s.objects.get(String(photo().key))).body, original);
  assert.deepEqual(await s.objects.tags(String((entry.thumb as Item).key)), { outcome: 'note' });
  const puts = s.objects.calls.filter((c) => c.operation === 'put').length;
  await worker.changed(stream(s.note), s.services);
  assert.equal(s.objects.calls.filter((c) => c.operation === 'put').length, puts);
});
test('no-key batch still thumbnails every following record; failures scrub and do not hide other thumbnail work', async () => {
  for (const failure of [new d.NoKey(), new Error('private provider failure')]) {
    const s = setup();
    await seedPhoto(s);
    s.services.model = async () => {
      throw failure;
    };
    const second = {
      ...s.note,
      sk: `NOTE#${day}#w-second`,
      media: [{ ...photo(1), key: `media/u/${day}/w-second/1.png` }]
    };
    s.store.seed(second);
    await s.objects.put(String(second.media[0]!.key), d.testImage(), { type: 'image/png' });
    const promise = worker.runEvent({ Records: [stream(s.note), stream(second)] }, {}, s.services);
    if (failure instanceof d.NoKey) await promise;
    else await assert.rejects(() => promise, { message: 'Description worker failed' });
    for (const noteId of [id, 'w-second'])
      assert.ok((((await s.store.note('u', day, noteId))!.media as Item[])[0]!.thumb as Item).key);
    assert.equal(JSON.stringify(s.logs).includes('private'), false);
  }
});
test('losing thumbnail update preserves winner fixed key and restores retained tag', async () => {
  const s = setup([photo()], { describe: false });
  await seedPhoto(s);
  let changed = false;
  s.store.memory.beforeSend = (command) => {
    if (
      command instanceof TransactWriteCommand &&
      !changed &&
      command.input.TransactItems?.some((op) => op.Update?.ExpressionAttributeNames?.['#f'] === 'thumb')
    ) {
      changed = true;
      s.store.seed({
        ...s.note,
        media: [{ ...photo(), thumb: { key: thumbKey(String(photo().key)), size: 15, width: 64, height: 64 } }]
      });
    }
  };
  await worker.changed(stream(s.note), s.services);
  assert.ok((await s.objects.get(thumbKey(String(photo().key)))).body.length);
  assert.equal(
    s.objects.calls.some((c) => c.operation === 'remove' && c.key === thumbKey(String(photo().key))),
    false
  );
  assert.deepEqual(await s.objects.tags(thumbKey(String(photo().key))), { outcome: 'note' });
});
test('deletion during thumbnail commit cleans only generated thumbnail', async () => {
  const s = setup([photo()], { describe: false });
  await seedPhoto(s);
  let changed = false;
  s.store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && !changed) {
      changed = true;
      s.store.seed({ ...s.profile, mcp_deleting: true });
    }
  };
  await worker.changed(stream(s.note), s.services);
  assert.equal((await s.objects.list('media/')).includes(thumbKey(String(photo().key))), false);
  assert.ok((await s.objects.get(String(photo().key))).body.length);
});
test('profile enable invokes qualified self once; no models on stale/false or missing profile', async () => {
  const s = setup();
  await worker.changed(stream(s.profile, { ...s.profile, describe: false }), s.services);
  assert.deepEqual(s.invocations.calls, [
    { name: 'describe:live', payload: { describe_all: 'u' }, asynchronous: true }
  ]);
  await worker.changed(stream(s.profile, s.profile), s.services);
  assert.equal(s.invocations.calls.length, 1);
});
test('backfill chain hands on near limit, other chain refuses, same chain resumes and releases USER lock', async () => {
  const s = setup();
  await seedPhoto(s);
  assert.deepEqual(await worker.describeAll('u', s.services, () => 30, 'chain'), { photos: 0, more: true });
  assert.deepEqual(s.invocations.calls[0]?.payload, { describe_all: 'u', chain: 'chain' });
  assert.deepEqual(await worker.describeAll('u', s.services, () => 900, 'other'), { photos: 0, more: false });
  assert.deepEqual(await worker.describeAll('u', s.services, () => 900, 'chain'), { photos: 1, more: false });
  assert.equal(s.store.memory.read({ pk: 'USER#u', sk: 'PROCESSLOCK#describe' }), null);
});
test('thumb backfill dry-run is entirely read-only/no model; real near-limit pass hands remaining users on', async () => {
  const s = setup([photo(), { ...photo(1), type: 'image/heic' }], { describe: false });
  const before = s.store.memory.all();
  const result = await worker.runEvent({ thumbs_all: '*', dry_run: true }, {}, s.services);
  assert.equal(result?.photos, 1);
  assert.deepEqual(result?.left, { 'image/heic': 1 });
  assert.deepEqual(s.store.memory.all(), before);
  assert.equal(s.calls.length, 0);
  assert.equal(s.objects.calls.length, 0);
  const next = await worker.thumbsAll(['u'], s.services, () => 30);
  assert.equal(next.more, true);
  assert.deepEqual(s.invocations.calls[0]?.payload, { thumbs_all: ['u'] });
});
test('photo place naming sends coordinates only, guards deletion and weather failure remains nicety', async () => {
  const s = setup([{ ...photo(), place: { lat: 40, lon: -75 } }]);
  const coordinates: number[][] = [];
  s.services.geocode = async (lat, lon) => {
    coordinates.push([lat, lon]);
    return { city: 'Synthetic City', country: 'US' };
  };
  s.services.weatherFetch = async () => {
    throw new Error('private network response');
  };
  assert.equal(await worker.placeNote(s.note as NoteRecord, 'u', s.services), 'named');
  assert.deepEqual(coordinates, [[40, -75]]);
  assert.deepEqual((await s.store.note('u', day, id))?.place, {
    city: 'Synthetic City',
    country: 'US',
    lat: 40,
    lon: -75,
    from: 'photo'
  });
  assert.equal(JSON.stringify(s.logs).includes('Synthetic City'), false);
  assert.equal(JSON.stringify(s.logs).includes('-75'), false);
  const deleted = setup([{ ...photo(), place: { lat: 40, lon: -75 } }]);
  deleted.services.geocode = async () => {
    deleted.store.seed({ ...deleted.profile, mcp_deleting: true });
    return { city: 'Synthetic City' };
  };
  assert.equal(await worker.placeNote(deleted.note, 'u', deleted.services), 'gone');
  assert.equal((await deleted.store.note('u', day, id))?.place, undefined);
});
test('synthetic model check writes nothing and logs no returned words', async () => {
  const s = setup();
  const before = s.store.memory.all();
  const result = await worker.runEvent({ check: true }, {}, s.services);
  assert.deepEqual(result, { ok: true, words: 'A blue square.' });
  assert.deepEqual(s.store.memory.all(), before);
  assert.equal(s.objects.calls.length, 0);
  assert.equal(JSON.stringify(s.logs).includes('blue square'), false);
});
test('warm worker resolves key/model once per run only when unfinished consenting photos need it', async () => {
  const s = setup([photo(0), photo(1)]);
  await seedPhoto(s, 0);
  await seedPhoto(s, 1);
  let resolutions = 0;
  const base = s.services.model;
  s.services.model = async () => {
    resolutions++;
    return base();
  };
  await worker.runEvent({ Records: [stream(s.note)] }, {}, s.services);
  assert.equal(resolutions, 1);
  assert.equal(s.calls.length, 2);
  await worker.runEvent({ Records: [stream(s.note)] }, {}, s.services);
  assert.equal(resolutions, 1);
});
test('failed describe backfill releases chain lock and retry succeeds; opt-out stops each next photo', async () => {
  const s = setup([photo(0), photo(1)]);
  await seedPhoto(s, 0);
  await seedPhoto(s, 1);
  s.services.model = async () => async () => {
    throw new d.ApiError(503, 'overloaded_error');
  };
  await assert.rejects(() => worker.describeAll('u', s.services, () => 900, 'a'));
  assert.equal(s.store.memory.read({ pk: 'USER#u', sk: 'PROCESSLOCK#describe' }), null);
  let calls = 0;
  s.services.model = async () => async () => {
    calls++;
    s.store.seed({ ...s.profile, describe: false });
    return { content: [{ type: 'text', text: 'private words' }] };
  };
  assert.deepEqual(await worker.describeAll('u', s.services, () => 900, 'a'), { photos: 0, more: false });
  assert.equal(calls, 1);
  assert.equal(
    ((await s.store.note('u', day, id))!.media as Item[]).some((m) => 'description' in m),
    false
  );
});
test('transient geocode failure leaves photos unmodeled, makes later batch thumbnails and retries scrubbed', async () => {
  const s = setup([{ ...photo(), place: { lat: 40, lon: -75 } }]);
  await seedPhoto(s);
  s.services.geocode = async () => {
    throw new Error('private location');
  };
  const second = {
    ...s.note,
    sk: `NOTE#${day}#w-second`,
    media: [{ ...photo(1), key: `media/u/${day}/w-second/1.png` }]
  };
  s.store.seed(second);
  await s.objects.put(String(second.media[0]!.key), d.testImage(), { type: 'image/png' });
  await assert.rejects(() => worker.runEvent({ Records: [stream(s.note), stream(second)] }, {}, s.services), {
    message: 'Description worker failed'
  });
  assert.equal(((await s.store.note('u', day, id))!.media as Item[])[0]?.description, undefined);
  assert.ok(((await s.store.note('u', day, 'w-second'))!.media as Item[])[0]?.thumb);
  assert.equal(JSON.stringify(s.logs).includes('private location'), false);
});
test('replacing first photo while geocoding cannot put old location on new media', async () => {
  const s = setup([{ ...photo(), place: { lat: 40, lon: -75 } }]);
  s.services.geocode = async () => {
    s.store.seed({ ...s.note, media: [{ ...photo(), key: 'media/u/new.png', place: { lat: 30, lon: -60 } }] });
    return { city: 'Old place' };
  };
  assert.equal(await worker.placeNote(s.note, 'u', s.services), 'gone');
  assert.equal((await s.store.note('u', day, id))?.place, undefined);
});
test('a failed batch logs what failed, by class and AWS validation message, never the content', async () => {
  const s = setup();
  await seedPhoto(s);
  const message = 'Invalid ConditionExpression: Attribute name is a reserved keyword; reserved keyword: owner';
  s.store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand)
      throw Object.assign(new Error(message), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });
  };
  await assert.rejects(() => worker.runEvent({ Records: [stream(s.note)] }, {}, s.services), {
    message: 'Description worker failed'
  });
  assert.deepEqual(
    s.logs.filter((l) => l.outcome === 'failed'),
    [
      {
        event: 'describe',
        outcome: 'failed',
        error: 'ValidationException',
        error_status: 400,
        error_message: message
      }
    ]
  );
  assert.equal(JSON.stringify(s.logs).includes('blue'), false);
  assert.equal(JSON.stringify(s.logs).includes('synthetic fixture'), false);
  assert.equal(await s.store.processing('u', 'describe', day, id, 0), null);
  s.store.memory.beforeSend = undefined;
  s.services.invocations = s.invocations;
  await assert.rejects(
    () =>
      worker.runEvent(
        { describe_all: 'u' },
        {},
        {
          ...s.services,
          model: async () => {
            throw new Error('private provider failure');
          }
        }
      ),
    { message: 'Description worker failed' }
  );
  assert.deepEqual(s.logs.filter((l) => l.outcome === 'failed').at(-1), {
    event: 'describe',
    outcome: 'failed',
    error: 'Error'
  });
  assert.equal(JSON.stringify(s.logs).includes('private'), false);
});
test('describe_all race: its own description write re-triggering the stream is no error and no failed batch', async () => {
  for (const edit of [false, true]) {
    const s = setup([photo(), photo(1)]);
    await seedPhoto(s);
    await seedPhoto(s, 1);
    let calls = 0,
      raced: Promise<unknown> | undefined;
    const answer = async () => ({ content: [{ type: 'text', text: 'A blue square.' }] });
    s.services.model = async () => async () => {
      // describe_all is about to describe photo 1, holding its lease, after
      // saving photo 0's description: the stream delivers that write now.
      if (++calls === 2) {
        const before = { ...s.note, media: [photo(), photo(1)] },
          after = (await s.store.note('u', day, id, true))!;
        const record = edit
          ? stream({ ...after, text: 'An edit made meanwhile' }, before)
          : stream(after as Item, before);
        raced = worker.runEvent({ Records: [record] }, {}, s.services);
        await raced;
      }
      return answer();
    };
    assert.deepEqual(await worker.describeAll('u', s.services, () => 900, 'chain'), { photos: 2, more: false });
    await raced;
    assert.equal(calls, 2);
    const media = (await s.store.note('u', day, id))!.media as Item[];
    assert.ok(media.every((m) => typeof m.description === 'string' && m.description));
    assert.equal(
      s.logs.some((l) => l.outcome === 'failed'),
      false
    );
    assert.ok(s.logs.some((l) => l.event === 'describe' && l.outcome === (edit ? 'lease-busy' : 'own-result')));
    assert.equal(await s.store.processing('u', 'describe', day, id, 1), null);
  }
});
test('a lease left by a dead describe_all lapses with its lock, then any trigger describes the photo', async () => {
  const s = setup();
  await seedPhoto(s);
  assert.ok(await s.store.takeProcessingLock('u', 'dead-chain', now, d.LOCK_FOR));
  await s.store.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'dead', now);
  assert.equal(await d.describe(s.note, 'u', s.services), 0);
  assert.ok(s.logs.some((l) => l.outcome === 'lease-busy'));
  assert.equal(((await s.store.note('u', day, id))!.media as Item[])[0]?.description, undefined);
  s.services.clock = () => now + d.LOCK_FOR;
  assert.equal(await worker.changed(stream({ ...s.note, text: 'Later edit' }, s.note), s.services), 1);
});
test('only a description or transcript added is the worker’s own write; a new photo is not', () => {
  const before = { pk: 'USER#u', sk: `NOTE#${day}#${id}`, media: [photo()] };
  assert.equal(worker.ownResultOnly({ ...before, media: [{ ...photo(), description: 'x' }] }, before), true);
  assert.equal(worker.ownResultOnly({ ...before, media: [{ ...photo(), transcript: '' }] }, before), true);
  assert.equal(worker.ownResultOnly({ ...before, media: [photo(), photo(1)] }, before), false);
  assert.equal(worker.ownResultOnly({ ...before, text: 'edit' }, before), false);
  assert.equal(worker.ownResultOnly(before, before), false);
  assert.equal(worker.ownResultOnly(before, {}), false);
});
