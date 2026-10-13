import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { setup, photo, audio, now, day, id } from './helpers.ts';
test('processing exact document transaction proves consent, media source, lease and quota', async () => {
  const { store: s } = setup([audio()]);
  assert.equal(
    await s.claimProcessing('transcribe', 'u', day, id, 0, String(audio().key), 'audio/mpeg', 'owner', now),
    true
  );
  const input = s.memory.calls.find((c) => c.name === 'TransactWriteCommand')!.input as InstanceType<
    typeof TransactWriteCommand
  >['input'];
  assert.deepEqual(input, {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND #opt = :yes',
          ExpressionAttributeNames: { '#opt': 'transcribe' },
          ExpressionAttributeValues: { ':yes': true }
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: `NOTE#${day}#${id}` },
          ConditionExpression:
            'attribute_exists(pk) AND media[0].n = :n AND media[0].#k = :k AND media[0].#type = :type AND attribute_not_exists(media[0].#f)',
          ExpressionAttributeNames: { '#k': 'key', '#type': 'type', '#f': 'transcript' },
          ExpressionAttributeValues: { ':n': 0, ':k': audio().key, ':type': 'audio/mpeg' }
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: {
            pk: 'USER#u',
            sk: `PROCESS#transcribe#${day}#${id}#0`,
            owner: 'owner',
            source: audio().key,
            type: 'audio/mpeg',
            expires_at: now + 30 * 86400
          },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
          ExpressionAttributeValues: { ':now': now }
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: `RATE#transcribe:u#${Math.floor(now / 86400)}`, sk: 'RATE' },
          UpdateExpression: 'ADD n :one SET expires_at = :exp',
          ConditionExpression: 'attribute_not_exists(n) OR n < :max',
          ExpressionAttributeValues: { ':one': 1, ':exp': (Math.floor(now / 86400) + 2) * 86400, ':max': 30 }
        }
      }
    ]
  });
  assert.equal(
    await s.claimProcessing('transcribe', 'u', day, id, 0, String(audio().key), 'audio/mpeg', 'other', now),
    false
  );
  assert.equal(s.memory.read({ pk: `RATE#transcribe:u#${Math.floor(now / 86400)}`, sk: 'RATE' })?.n, 1);
});
test('concurrent 31 distinct transcription reservations cap exactly at30 without partial leases', async () => {
  const { store: s } = setup(Array.from({ length: 31 }, (_, n) => audio(n)));
  const results = await Promise.all(
    Array.from({ length: 31 }, (_, n) =>
      s.claimProcessing('transcribe', 'u', day, id, n, String(audio(n).key), 'audio/mpeg', `o${n}`, now)
    )
  );
  assert.equal(results.filter(Boolean).length, 30);
  assert.equal(s.memory.all().filter((row) => String(row.sk).startsWith('PROCESS#')).length, 30);
  assert.equal(s.memory.read({ pk: `RATE#transcribe:u#${Math.floor(now / 86400)}`, sk: 'RATE' })?.n, 30);
});
test('opt-out/account deletion/media replacement immediately before claim atomically refuse', async () => {
  for (const mutation of ['optout', 'deleting', 'replacement', 'gone']) {
    const { store: s, note, profile } = setup();
    let ran = false;
    s.memory.beforeSend = (command) => {
      if (command instanceof TransactWriteCommand && !ran) {
        ran = true;
        s.seed(
          mutation === 'replacement'
            ? { ...note, media: [{ ...photo(), key: 'media/u/replaced.png' }] }
            : mutation === 'gone'
              ? { ...note, media: [] }
              : mutation === 'deleting'
                ? { ...profile, mcp_deleting: true }
                : { ...profile, describe: false }
        );
      }
    };
    assert.equal(
      await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'o', now),
      false
    );
    assert.equal(s.memory.all().filter((row) => String(row.sk).startsWith('PROCESS#')).length, 0);
  }
});
test('completion proof retains media and refuses stale source, withdrawn consent or stolen lease', async () => {
  for (const mutation of ['optout', 'deleting', 'source', 'lease']) {
    const { store: s, note, profile } = setup();
    await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'o', now);
    if (mutation === 'source') s.seed({ ...note, media: [{ ...photo(), key: 'media/u/new.png' }] });
    else if (mutation === 'lease')
      s.seed({ pk: 'USER#u', sk: `PROCESS#describe#${day}#${id}#0`, owner: 'other', source: photo().key });
    else s.seed({ ...profile, ...(mutation === 'optout' ? { describe: false } : { mcp_deleting: true }) });
    assert.equal(
      await s.finishProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'private result', 'o'),
      false
    );
    assert.equal(((await s.note('u', day, id))!.media as Record<string, unknown>[])[0]?.description, undefined);
  }
  const { store: s } = setup();
  await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'o', now);
  assert.equal(
    await s.finishProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'blue', 'o'),
    true
  );
  assert.equal(await s.processing('u', 'describe', day, id, 0), null);
  assert.deepEqual(((await s.note('u', day, id))!.media as Record<string, unknown>[])[0], {
    ...photo(),
    description: 'blue'
  });
});
test('expired lease can retry but release never deletes another owner; account-owned chain locks', async () => {
  const { store: s, profile } = setup();
  await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'old', now - 960);
  assert.equal(
    await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'new', now),
    true
  );
  assert.equal(await s.releaseProcessing('u', 'describe', day, id, 0, 'old'), false);
  assert.equal(await s.takeProcessingLock('u', 'a', now, 960), true);
  assert.equal(await s.takeProcessingLock('u', 'b', now, 960), false);
  assert.equal(await s.takeProcessingLock('u', 'a', now + 1, 960), true);
  assert.equal(await s.releaseProcessingLock('u', 'b'), false);
  s.seed({ ...profile, mcp_deleting: true });
  assert.equal(await s.takeProcessingLock('u', 'a', now + 2, 960), false);
  assert.equal(await s.releaseProcessingLock('u', 'a'), true);
});
test('thumbnail/weather/place writes cannot recreate an account after deletion barrier', async () => {
  const { store: s, profile } = setup();
  s.seed({ ...profile, mcp_deleting: true });
  assert.equal(await s.setMediaFieldGuarded('u', day, id, 0, 'thumb', { key: 'x' }, String(photo().key)), false);
  assert.equal(await s.setNotePlaceGuarded('u', day, id, { city: 'Synthetic' }), false);
  await assert.rejects(() => s.forLiveAccount('u').putWeather('u', day, { high_c: 20 }), {
    name: 'ProcessingAccountGone'
  });
  assert.equal(
    s.memory.all().some((row) => String(row.sk).startsWith('WEATHER#')),
    false
  );
});
test('completion request uses native text values and source/owner proof; list reorder never writes wrong photo', async () => {
  const { store: s } = setup();
  await s.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'o', now);
  await s.finishProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'blue', 'o');
  const input = s.memory.calls.filter((c) => c.name === 'TransactWriteCommand').at(-1)!.input as InstanceType<
    typeof TransactWriteCommand
  >['input'];
  assert.deepEqual(input.TransactItems?.[1], {
    Update: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: `NOTE#${day}#${id}` },
      UpdateExpression: 'SET media[0].#f = :text',
      ConditionExpression:
        'attribute_exists(pk) AND media[0].n = :n AND media[0].#k = :k AND media[0].#type = :type AND attribute_not_exists(media[0].#f)',
      ExpressionAttributeNames: { '#k': 'key', '#type': 'type', '#f': 'description' },
      ExpressionAttributeValues: { ':n': 0, ':k': photo().key, ':type': 'image/png', ':text': 'blue' }
    }
  });
  assert.deepEqual(input.TransactItems?.[2], {
    Delete: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: `PROCESS#describe#${day}#${id}#0` },
      ConditionExpression: 'owner = :o AND #src = :k',
      ExpressionAttributeNames: { '#src': 'source' },
      ExpressionAttributeValues: { ':o': 'o', ':k': photo().key }
    }
  });
  const r = setup([photo(), photo(1)]);
  await r.store.claimProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'o', now);
  let swapped = false;
  r.store.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && !swapped) {
      swapped = true;
      r.store.seed({ ...r.note, media: [photo(1), photo()] });
    }
  };
  assert.equal(
    await r.store.finishProcessing('describe', 'u', day, id, 0, String(photo().key), 'image/png', 'blue', 'o'),
    false
  );
  assert.equal(
    ((await r.store.note('u', day, id))!.media as Record<string, unknown>[]).some((m) => 'description' in m),
    false
  );
});
