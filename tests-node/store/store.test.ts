import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { FakeStore, InMemoryDocumentClient } from '../../packages/testing/store.ts';
import { Store, Subscriber } from '../../packages/backend/store.ts';
import type { Item, DocumentSender } from '../../packages/backend/store-types.ts';
const profile = {
  pk: 'USER#u',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1981-06-14',
  tz: 'America/Chicago',
  status: 'active'
};
const note = {
  pk: 'USER#u',
  sk: 'NOTE#2026-10-13#a-note',
  text: 'First',
  source: 'agent',
  author: 'assistant',
  connection: 'f',
  client_id: 'c',
  revision: 1,
  written_at: '2026-10-13T12:00:00Z'
};
const day = '2026-10-13';
function setup(pageSize = 25) {
  return new FakeStore([profile], 'T', pageSize);
}
function cancelled(codes: string[]) {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code }))
  });
}
function captureFixture() {
  const s = setup();
  const family = {
    pk: 'OAUTHFAMILY#f',
    sk: 'STATE',
    id: 'f',
    user_id: 'u',
    revision: 1,
    scope: 'notes:read notes:write',
    expires_at: 1000
  };
  s.seed(family);
  const receipt = { pk: 'USER#u', sk: 'CAPTURE#f#h', request_hash: 'hash', result: '{}', expires_at: 2000 };
  const audit = { pk: 'MCPMETA#u', sk: 'LOG#001', tool: 'notes_create', connection: 'f', expires_at: 4000 };
  const rate = { pk: 'MCPMETA#u', sk: 'WRITERATE#notes_create#1', n: 1, revision: 1, expires_at: 8000 };
  return { s, family, receipt, audit, rate };
}

test('production document client satisfies injection interface without typed AttributeValues', () => {
  const client = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: 'us-east-1', credentials: { accessKeyId: 'fake', secretAccessKey: 'fake' } })
  );
  const sender: DocumentSender = client;
  assert.equal(new Store(sender, 'T').tableName, 'T');
  client.destroy();
});
test('subscriber defaults, calendar dates, pause boundaries and home place', () => {
  const sub = Subscriber.fromItem({
    ...profile,
    pause_from: day,
    pause_through: '2026-10-15',
    city: 'Minneapolis',
    lat: 44.9,
    lon: -93.2
  });
  assert.equal(sub.birthday, '1981-06-14');
  assert.equal(sub.send_time, '06:00');
  assert.equal(sub.pausedOn(day), true);
  assert.equal(sub.pausedOn('2026-10-16'), false);
  assert.equal(sub.place?.lat, 44.9);
});
test('account creation atomic and native-valued; collision cannot orphan a profile', async () => {
  const s = new FakeStore([], 'T');
  assert.equal(
    await s.createSubscriber('u', 'ada@example.com', {
      birthday: '1981-06-14',
      tz: 'UTC',
      status: 'active',
      lat: 44.75
    }),
    true
  );
  assert.equal(await s.createSubscriber('other', 'ada@example.com', {}), false);
  assert.equal(await s.profile('other'), null);
  assert.equal(await s.userForEmail('ada@example.com'), 'u');
  assert.deepEqual(s.memory.calls[0]!.input.TransactItems?.[0], {
    Put: {
      TableName: 'T',
      Item: { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' },
      ConditionExpression: 'attribute_not_exists(pk)'
    }
  });
});
test('only expected transaction failures are converted to false', async () => {
  const s = new Store(
    {
      send: async () => {
        throw cancelled(['ValidationError']);
      }
    },
    'T'
  );
  await assert.rejects(s.createSubscriber('u', 'ada@example.com', {}), { name: 'TransactionCanceledException' });
  await assert.rejects(s.mcpCommit([[{ pk: 'x', sk: 'STATE' }, null]]), { name: 'TransactionCanceledException' });
  assert.equal(
    await new Store(
      {
        send: async () => {
          throw cancelled(['TransactionConflict']);
        }
      },
      'T'
    ).mcpCommit([[{ pk: 'x', sk: 'STATE' }, null]]),
    false
  );
  await assert.rejects(
    new Store(
      {
        send: async () => {
          throw cancelled([]);
        }
      },
      'T'
    ).mcpCommit([[{ pk: 'x', sk: 'STATE' }, null]])
  );
});
test('scan pagination projects private fields away including nested media', async () => {
  const s = setup(1);
  s.seed({
    ...note,
    media: [{ kind: 'image', key: 'private', description: 'private' }],
    raw_key: 'private',
    tags: ['one']
  });
  s.seed({ pk: 'OTHER#x', sk: 'PROFILE', email: 'private' });
  s.seed({ pk: 'USER#v', sk: 'PROFILE', status: 'stopped' });
  assert.equal((await s.activeSubscribers()).length, 1);
  assert.deepEqual(await s.userIds(), ['u', 'v']);
  const rows = await s.censusItems();
  assert.equal(rows.length, 3);
  assert.equal(JSON.stringify(rows).includes('private'), false);
  assert.equal(JSON.stringify(rows).includes('ada@example'), false);
  assert.deepEqual(rows.find((i) => i.sk === note.sk)?.media, [{ kind: 'image' }]);
  assert.deepEqual(await s.noteIndex('u'), [[day, 1]]);
  assert.deepEqual(await s.noteTags('u'), [{ sk: note.sk, tags: ['one'] }]);
});
test('concurrent send claims have one winner, release is conditionally owned', async () => {
  const s = setup();
  const winners = await Promise.all(Array.from({ length: 20 }, () => s.claimDay('u', day)));
  assert.equal(winners.filter(Boolean).length, 1);
  assert.equal(await s.claimDay('missing', day), false);
  await s.releaseDay('u', day, null);
  assert.equal(await s.claimDay('u', day), true);
  await s.releaseDay('u', day, '2026-10-12');
  assert.equal((await s.profile('u'))?.last_sent_date, '2026-10-12');
  await assert.rejects(s.releaseDay('u', day, null), { name: 'ConditionalCheckFailedException' });
});
test('send claim request retains exact condition', async () => {
  const s = setup();
  await s.claimDay('u', day);
  assert.deepEqual(s.memory.calls[0], {
    name: 'UpdateCommand',
    input: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      UpdateExpression: 'SET last_sent_date = :d',
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#status) OR #status = :active) AND (attribute_not_exists(last_sent_date) OR last_sent_date < :d)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':d': day, ':active': 'active' }
    }
  });
});
test('day token retains epoch sent_at, conditional cleanup preserves newer day', async () => {
  const s = setup();
  assert.equal(await s.putDay('u', day, '4.5.121', 'first', '2026-10-13T12:00:00Z'), true);
  assert.equal((await s.getToken('first'))?.sent_at, 1791892800);
  assert.equal(await s.putDay('u', day, '4.5.121', 'second', '2026-10-13T12:05:00Z'), false);
  assert.equal(await s.getToken('second'), null);
  s.seed({ pk: 'USER#u', sk: `DAY#${day}`, token: 'second' });
  s.seed({ pk: 'TOKEN#second', sk: 'TOKEN', user_id: 'u' });
  await s.dropDay('u', day, 'first');
  assert.equal(await s.getToken('first'), null);
  assert.equal((await s.userItems('u')).find((i) => i.sk === `DAY#${day}`)?.token, 'second');
  assert.equal(await s.setDayMessageId('u', day, 'ses-id', 'first'), false);
  assert.equal(await s.setDayMessageId('u', day, 'ses-id', 'second'), true);
  assert.deepEqual(await s.sentDays('u'), new Set([day]));
  assert.equal(await s.claimLateNotice('second', 'now'), true);
  assert.equal(await s.claimLateNotice('second', 'again'), false);
  assert.equal(await s.claimLateNotice('missing', 'now'), false);
});
test('standing address replacement atomically removes old and fails closed for races', async () => {
  const s = setup();
  assert.equal(await s.setInbox('u', 'a', 'now'), true);
  assert.equal(await s.setInbox('u', 'b', 'now'), false);
  assert.equal(await s.getInbox('b'), null);
  assert.equal(await s.setInbox('u', 'b', 'now', 'a'), true);
  assert.equal(await s.getInbox('a'), null);
  assert.equal(await s.deleteProfile('u', 'a'), false);
  assert.equal(await s.deleteProfile('u', 'b'), true);
  assert.equal(await s.setInbox('u', 'c', 'now', 'b'), false);
  assert.equal(await s.getInbox('c'), null);
});
test('notes order by writing time across pages, range includes last day, duplicate ids are no-op', async () => {
  const s = setup(1);
  assert.equal(
    await s.putNote('u', day, 'z', { text: 'earlier', received_at: '2026-10-13T10:00:00Z', tags: ['trip'] }),
    true
  );
  assert.equal(await s.putNote('u', day, 'a', { text: 'later', written_at: '2026-10-13T11:00:00Z' }), true);
  assert.equal(await s.putNote('u', day, 'a', { text: 'different' }), false);
  await s.putNote('u', '2026-10-14', 'b', { text: 'tomorrow' });
  assert.deepEqual(
    (await s.dayNotes('u', day)).map((i) => i.text),
    ['earlier', 'later']
  );
  assert.equal((await s.notesBetween('u', day, '2026-10-14')).length, 3);
  assert.equal((await s.taggedNotes('u', 'trip')).length, 1);
  assert.deepEqual(await s.noteDays('u'), new Set([day, '2026-10-14']));
  assert.deepEqual(await s.noteIds('u'), new Set(['a', 'z', 'b']));
});
test('edits remove stale links and tags, missing note is not recreated', async () => {
  const s = setup();
  s.seed(note);
  const edited = await s.updateNote('u', day, 'a-note', 'New', 'at', [{ url: 'https://example.com' }], ['tag']);
  assert.equal(edited?.text, 'New');
  const cleared = await s.updateNote('u', day, 'a-note', 'Clear', 'at2');
  assert.equal(Object.hasOwn(cleared!, 'tags'), false);
  assert.equal(Object.hasOwn(cleared!, 'links'), false);
  assert.equal(await s.updateNote('u', day, 'missing', 'words', 'at'), null);
  assert.equal((await s.deleteNote('u', day, 'a-note'))?.text, 'Clear');
  assert.equal(await s.deleteNote('u', day, 'a-note'), null);
});
test('media appends claim prior size and fields update the right list entry only', async () => {
  const s = setup();
  s.seed(note);
  assert.ok(await s.addMedia('u', day, 'a-note', [{ n: 1, kind: 'image' }], 0, 'at'));
  assert.equal(await s.addMedia('u', day, 'a-note', [{ n: 2 }], 0, 'at'), null);
  assert.ok(await s.addMedia('u', day, 'a-note', [{ n: 2, kind: 'audio' }], 1, 'at'));
  assert.equal(await s.setMediaField('u', day, 'a-note', 1, 'thumb', { key: 'thumbnail', size: 100 }), true);
  assert.equal(await s.setMediaText('u', day, 'a-note', 2, 'transcript', 'Spoken'), true);
  assert.equal(await s.setMediaText('u', day, 'a-note', 4, 'transcript', 'missing'), false);
  assert.deepEqual((await s.note('u', day, 'a-note'))?.media, [
    { n: 1, kind: 'image', thumb: { key: 'thumbnail', size: 100 } },
    { n: 2, kind: 'audio', transcript: 'Spoken' }
  ]);
});
test('media disappeared between read and update fails its n guard', async () => {
  const s = setup();
  s.seed({ ...note, media: [{ n: 1 }] });
  s.memory.beforeSend = (command) => {
    if (command.constructor.name === 'UpdateCommand') {
      s.seed({ ...note, media: [{ n: 2 }] });
    }
  };
  assert.equal(await s.setMediaText('u', day, 'a-note', 1, 'description', 'not assigned'), false);
  assert.deepEqual((await s.note('u', day, 'a-note'))?.media, [{ n: 2 }]);
});
test('profile updates preserve unknown fields, refuse missing accounts, pauses retain history', async () => {
  const s = setup();
  await s.updateProfile('u', { custom: 1, pause_from: day });
  await s.updateProfile('u', { send_time: '07:00' }, ['pause_from']);
  assert.equal((await s.profile('u'))?.custom, 1);
  await assert.rejects(s.updateProfile('missing', { custom: 1 }));
  await s.putPause('u', day, '2026-10-20', 'now');
  assert.equal((await s.getSubscriber('u'))?.pausedOn(day), true);
  await s.endPause('u', day, '2026-10-15');
  assert.deepEqual(await s.pauses('u'), [[day, '2026-10-15']]);
  assert.equal((await s.getSubscriber('u'))?.pausedOn(day), false);
  await s.endPause('u', day, null);
  assert.deepEqual(await s.pauses('u'), []);
  await s.stop('u', 'bounce', 'now');
  assert.equal((await s.profile('u'))?.status, 'stopped');
});
test('import ledger uses DynamoDB string sets and repeated ids are unioned', async () => {
  const s = setup();
  assert.deepEqual(await s.imported('u', 'IMPORT#dayone#journal'), new Set());
  await s.addImported('u', 'IMPORT#dayone#journal', ['a', 'b'], 'now');
  await s.addImported('u', 'IMPORT#dayone#journal', ['b', 'c'], 'later');
  assert.deepEqual(await s.imported('u', 'IMPORT#dayone#journal'), new Set(['a', 'b', 'c']));
  assert.ok(
    s.memory.calls.find((c) => c.name === 'UpdateCommand')?.input.ExpressionAttributeValues?.[':i'] instanceof Set
  );
});
test('weather first write, replacement, conditional rename and deletion retain newer location', async () => {
  const s = setup();
  const fields = { lat: 44.75, lon: -93.1, city: 'Old', region: '', country: 'US', high_c: 20.3 };
  assert.equal(await s.putWeather('u', day, fields), true);
  assert.equal(await s.putWeather('u', day, { lat: 1 }), false);
  assert.equal(await s.renameWeather('u', day, fields, { city: 'New' }), true);
  assert.equal(await s.renameWeather('u', day, fields, { city: 'Wrong' }), false);
  await s.replaceWeather('u', day, { ...fields, lat: 2 });
  assert.equal(await s.dropWeather('u', day, fields), false);
  assert.equal((await s.weatherBetween('u', day, day, true))[day]?.lat, 2);
  assert.equal(await s.dropWeather('u', day, { ...fields, lat: 2 }), true);
});
test('day and note places preserve precedence and refuse absent/existing notes', async () => {
  const s = setup();
  s.seed(note);
  await s.setDayPlace('u', day, { city: 'Day', lat: 2.3, lon: 4.5 });
  assert.equal((await s.dayPlace('u', day, true))?.city, 'Day');
  assert.equal((await s.placesBetween('u', day, day))[day]?.lat, 2.3);
  assert.equal(await s.setNotePlace('u', day, 'a-note', { city: 'Note' }), true);
  assert.equal(await s.setNotePlace('u', day, 'a-note', { city: 'Different' }), false);
  assert.equal(await s.setNotePlace('u', day, 'missing', { city: 'Different' }), false);
  await s.clearDayPlace('u', day);
  assert.equal(await s.dayPlace('u', day), null);
});
test('zip builds finish only their own current building item', async () => {
  const s = setup();
  await s.startExport('u', 'first', 1, 100);
  await s.startExport('u', 'second', 2, 101);
  assert.equal(await s.finishExport('u', 'first', { status: 'ready' }), false);
  assert.equal(await s.finishExport('u', 'second', { status: 'ready', size: 99 }), true);
  assert.equal(await s.finishExport('u', 'second', { status: 'failed' }), false);
  assert.equal((await s.export('u'))?.size, 99);
});
test('login purpose isolation, newest-code indexing and legacy signin compatibility', async () => {
  const s = setup();
  await s.putLogin('s', 'ada@example.com', 'eh', 'ch', 10, 50);
  await s.putLogin('d', 'ada@example.com', 'eh', 'ch2', 10, 50, 'delete');
  assert.equal(await s.newestLogin('eh'), 's');
  assert.equal(await s.newestLogin('eh', 'delete'), 'd');
  assert.equal((await s.loginKeys('eh')).length, 4);
  assert.equal(await s.burnLogin('d', 20), null);
  assert.equal(await s.burnLogin('s', 20, 'delete'), null);
  assert.equal((await s.burnLogin('d', 20, 'delete'))?.purpose, 'delete');
  assert.equal(await s.burnLogin('d', 20, 'delete'), null);
  s.seed({ pk: 'LOGIN#legacy', sk: 'LOGIN', attempts: 0, expires_at: 60 });
  assert.ok(await s.burnLogin('legacy', 20));
});
test('code attempts stop on expiry, used code and correct purpose', async () => {
  const s = setup();
  await s.putLogin('s', 'ada@example.com', 'eh', 'ch', 10, 50);
  assert.equal(((await s.spendAttempt('s', 20, 1)) as Item).attempts, 1);
  assert.equal(await s.spendAttempt('s', 20, 1), 'attempts');
  assert.equal(await s.spendAttempt('s', 20, 1, 'delete'), 'gone');
  assert.equal(await s.spendAttempt('s', 60, 1), 'gone');
  await s.burnLogin('s', 20);
  assert.equal(await s.spendAttempt('s', 20, 1), 'used');
});
test('period counters, atomic upload ceilings, lock ownership and monthly tally', async () => {
  const s = setup();
  assert.equal(await s.count('wrong:u', 2, 86400), 1);
  assert.equal(await s.peek('wrong:u', 2), 1);
  assert.equal(s.memory.read({ pk: 'RATE#wrong:u#2', sk: 'RATE' })?.expires_at, 345600);
  assert.equal(await s.countUpload('u', 2, 100, 2, 150), true);
  assert.equal(await s.countUpload('u', 2, 100, 2, 150), false);
  assert.equal(await s.countUpload('u', 2, 50, 2, 150), true);
  assert.equal(await s.countUpload('u', 2, 1, 2, 150), false);
  assert.equal(await s.takeLock('job', 'a', 10, 10), true);
  assert.equal(await s.takeLock('job', 'b', 11, 10), false);
  await s.releaseLock('job', 'b', 12);
  assert.equal(await s.takeLock('job', 'b', 13, 10), false);
  await s.releaseLock('job', 'a', 13);
  assert.equal(await s.takeLock('job', 'b', 13, 10), true);
  await s.tally('2026-10', 'signups');
  await s.tally('2026-10', 'signups');
  assert.deepEqual(await s.tallies(), { '2026-10': { signups: 2 } });
});
test('atomic mail counters cannot overshoot under concurrent requests and denial consumes nothing', async () => {
  const s = setup();
  const counters = [
    { key: 'email:hash', period: 1, limit: 3 },
    { key: 'network:hash', period: 1, limit: 5 },
    { key: 'total', period: 1, limit: 10 }
  ];
  const results = await Promise.all(Array.from({ length: 30 }, () => s.reserveMail(counters)));
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(await s.peek('total', 1), 3);
  assert.equal(await s.peek('network:hash', 1), 3);
  assert.equal(results.find((r) => !r.ok)?.limited, 'email:hash');
  assert.equal(
    (
      await s.reserveMail([
        { key: 'other', period: 1, limit: 1 },
        { key: 'total', period: 1, limit: 3 }
      ])
    ).ok,
    false
  );
  assert.equal(await s.peek('other', 1), 0);
  await assert.rejects(s.reserveMail([counters[0]!, counters[0]!]));
});
test('reservation retries conflicts but never hides service/schema failures', async () => {
  let calls = 0;
  const s = new Store(
    {
      send: async () => {
        if (!calls++) throw cancelled(['TransactionConflict']);
        return {};
      }
    },
    'T'
  );
  assert.deepEqual(await s.reserveMail([{ key: 'a', period: 1, limit: 2 }]), { ok: true });
  assert.equal(calls, 2);
  await assert.rejects(
    new Store(
      {
        send: async () => {
          throw cancelled(['ValidationError']);
        }
      },
      'T'
    ).reserveMail([{ key: 'a', period: 1, limit: 2 }])
  );
});
test('sessions are indexed for deletion and touch/claim cannot recreate deleted sessions', async () => {
  const s = setup();
  await s.putSession('signup', { email: 'ada@example.com', now: 1, expires: 100 });
  assert.equal((await s.userItems('u')).length, 1);
  await s.claimSession('signup', 'u', 100);
  assert.equal(Object.hasOwn((await s.getSession('signup'))!, 'email'), false);
  await s.touchSession('signup', 10, 200, 'u');
  assert.equal((await s.userItems('u')).find((i) => i.sk === 'SESSION#signup')?.expires_at, 200);
  await s.putSession('other', { user_id: 'u', now: 10, expires: 200 });
  assert.equal((await s.getSession('other'))?.user_id, 'u');
  await s.deleteSession('signup');
  await assert.rejects(s.touchSession('signup', 20, 300, 'u'));
  await assert.rejects(s.claimSession('signup', 'u', 300));
});
test('MCP reads are strong, compare-and-swap and deletion barrier are atomic', async () => {
  const s = setup(1);
  const row = { pk: 'OAUTHFAMILY#f', sk: 'STATE', expires_at: 100 };
  assert.equal(await s.mcpCommit([[row, null]], 'u'), true);
  assert.equal(await s.mcpCommit([[row, null]], 'u'), false);
  assert.equal(await s.mcpCommit([[{ ...row, scope: 'read' }, 1]], 'u'), true);
  assert.equal((await s.mcpGet(row.pk))?.revision, 2);
  assert.equal((await s.mcpRows(row.pk)).length, 1);
  assert.equal((await s.mcpProfile('u'))?.email, 'ada@example.com');
  assert.ok(
    s.memory.calls
      .filter((c) => ['GetCommand', 'QueryCommand'].includes(c.name))
      .every((c) => (c.input as Item).ConsistentRead === true)
  );
  await s.mcpBlock('u');
  assert.equal(await s.mcpCommit([[{ pk: 'OAUTHACCESS#new', sk: 'STATE' }, null]], 'u'), false);
  assert.equal(await s.mcpGet('OAUTHACCESS#new'), null);
});
test('capture exact request proves owner, live scope, receipt, quota and audit in one transaction', async () => {
  const { s, family, receipt, audit, rate } = captureFixture();
  assert.equal(await s.captureCommit(note, null, receipt, audit, rate, null, family, 100), true);
  const ops = s.memory.calls[0]!.input.TransactItems!;
  assert.equal(ops.length, 6);
  assert.deepEqual(ops[0], {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
    }
  });
  assert.deepEqual(ops[1]?.ConditionCheck?.ExpressionAttributeValues, {
    ':revision': 1,
    ':now': 100,
    ':write': 'notes:write'
  });
  assert.deepEqual(ops[2]?.Put?.Item, note);
  assert.equal(ops[3]?.Put?.ConditionExpression, 'attribute_not_exists(pk) OR expires_at <= :now');
  assert.equal(ops[4]?.Put?.Item?.request_hash, undefined);
  assert.equal(ops[5]?.Put?.Item?.n, 1);
  assert.equal(
    await s.captureCommit(
      { ...note, sk: note.sk + 'second' },
      null,
      receipt,
      { ...audit, sk: 'LOG#002' },
      { ...rate, n: 2, revision: 2 },
      rate,
      family,
      100
    ),
    false
  );
  assert.equal((await s.allNotes('u')).length, 1);
  assert.equal((await s.mcpGet(String(rate.pk), String(rate.sk)))?.n, 1);
});
test('capture revoked/deleting/expired/removed-scope/current-revision conflicts write no note or receipts', async () => {
  for (const mutation of ['revoked', 'deleting', 'expired', 'scope', 'revision', 'missing']) {
    const { s, family, receipt, audit, rate } = captureFixture();
    if (mutation === 'deleting') await s.mcpBlock('u');
    else if (mutation === 'missing') await s.deleteProfile('u', null);
    else
      s.seed({
        ...family,
        ...(mutation === 'revoked'
          ? { revoked: true }
          : mutation === 'expired'
            ? { expires_at: 100 }
            : mutation === 'scope'
              ? { scope: 'notes:read' }
              : { revision: 2 })
      });
    assert.equal(await s.captureCommit(note, null, receipt, audit, rate, null, family, 100), false, mutation);
    assert.equal((await s.allNotes('u')).length, 0);
    assert.equal(await s.mcpGet('USER#u', String(receipt.sk)), null);
    assert.equal((await s.mcpRows('MCPMETA#u')).length, 0);
  }
});
test('capture append keeps owner files and unknown fields; owner edits and connection mismatch refuse stale append', async () => {
  const { s, family, receipt, audit, rate } = captureFixture();
  const old = {
    ...note,
    media: [{ n: 1, kind: 'image', thumb: { size: 20 } }],
    place: { city: 'Paris' },
    custom: 'retained'
  };
  s.seed(old);
  const appended = { ...note, text: 'First\n\nNext', tags: ['next'], links: [], updated_at: 'now', revision: 2 };
  assert.equal(await s.captureCommit(appended, old, receipt, audit, rate, null, family, 100), true);
  const actual = await s.note('u', day, 'a-note');
  assert.deepEqual(actual?.media, old.media);
  assert.deepEqual(actual?.place, old.place);
  assert.equal(actual?.custom, 'retained');
  const request = s.memory.calls[0]!.input.TransactItems![2]!.Update!;
  assert.equal(
    request.UpdateExpression,
    'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next'
  );
  assert.equal(request.ExpressionAttributeValues?.[':old'], 'First');
  assert.ok(request.ConditionExpression?.includes('#c = :connection'));
  assert.equal(
    await s.captureCommit(
      appended,
      old,
      { ...receipt, sk: 'CAPTURE#new' },
      { ...audit, sk: 'LOG#new' },
      { ...rate, n: 2, revision: 2 },
      rate,
      family,
      100
    ),
    false
  );
  s.seed({ ...old, connection: 'someone-else' });
  assert.equal(
    await s.captureCommit(
      appended,
      old,
      { ...receipt, sk: 'CAPTURE#new' },
      { ...audit, sk: 'LOG#new' },
      { ...rate, n: 2, revision: 2 },
      rate,
      family,
      100
    ),
    false
  );
});
test('capture media-only race preserves newly attached files', async () => {
  const { s, family, receipt, audit, rate } = captureFixture();
  s.seed(note);
  s.memory.beforeSend = (command) => {
    if (command.constructor.name === 'TransactWriteCommand') s.seed({ ...note, media: [{ n: 1, kind: 'file' }] });
  };
  assert.equal(
    await s.captureCommit(
      { ...note, text: 'Next', tags: [], links: [], updated_at: 'now', revision: 2 },
      note,
      receipt,
      audit,
      rate,
      null,
      family,
      100
    ),
    true
  );
  assert.deepEqual((await s.note('u', day, 'a-note'))?.media, [{ n: 1, kind: 'file' }]);
});
test('expired capture receipts may be atomically replaced, unexpired receipts cannot', async () => {
  const { s, family, receipt, audit, rate } = captureFixture();
  s.seed({ ...receipt, expires_at: 100 });
  assert.equal(await s.captureCommit(note, null, receipt, audit, rate, null, family, 100), true);
  assert.equal((await s.mcpGet('USER#u', String(receipt.sk)))?.expires_at, 2000);
});
test('fake rejects unsupported conditions and rolls back schema failures inside transaction', async () => {
  const client = new InMemoryDocumentClient([profile]);
  await assert.rejects(
    client.send(
      new UpdateCommand({
        TableName: 'T',
        Key: { pk: 'USER#u', sk: 'PROFILE' },
        UpdateExpression: 'SET x = :x',
        ConditionExpression: 'not_supported(pk)',
        ExpressionAttributeValues: { ':x': 1 }
      })
    ),
    { name: 'ValidationException' }
  );
  await assert.rejects(
    client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: 'T', Item: { pk: 'new', sk: 'STATE' } } },
          {
            Update: {
              TableName: 'T',
              Key: { pk: 'USER#u', sk: 'PROFILE' },
              UpdateExpression: 'SET nonexistent.child = :x',
              ExpressionAttributeValues: { ':x': 1 }
            }
          }
        ]
      })
    ),
    { name: 'ValidationException' }
  );
  assert.equal(client.read({ pk: 'new', sk: 'STATE' }), null);
});
test('batch deletion splits requests at 25 and resends unprocessed keys', async () => {
  const s = setup();
  const keys = Array.from({ length: 55 }, (_, n) => ({ pk: 'USER#u', sk: `SESSION#${n}` }));
  keys.forEach((k) => s.seed(k));
  await s.deleteKeys(keys);
  assert.equal((await s.userItems('u')).length, 1);
  assert.equal(s.memory.calls.filter((c) => c.name === 'BatchWriteCommand').length, 3);
  let calls = 0;
  const retry = new Store(
    {
      send: async (command) => {
        const req = command.input as {
          RequestItems: Record<string, { DeleteRequest: { Key: { pk: string; sk: string } } }[]>;
        };
        calls++;
        return calls === 1 ? { UnprocessedItems: req.RequestItems } : {};
      }
    },
    'T'
  );
  await retry.deleteKeys(keys.slice(0, 1));
  assert.equal(calls, 2);
});

test('session claim and indexed renewal send exact native SDK requests', async () => {
  const s = setup();
  await s.putSession('h', { email: 'ada@example.com', now: 1, expires: 100 });
  s.memory.calls.length = 0;
  await s.claimSession('h', 'u', 100);
  assert.deepEqual(s.memory.calls, [
    {
      name: 'UpdateCommand',
      input: {
        TableName: 'T',
        Key: { pk: 'SESSION#h', sk: 'SESSION' },
        UpdateExpression: 'SET user_id = :u REMOVE email',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':u': 'u' }
      }
    },
    { name: 'PutCommand', input: { TableName: 'T', Item: { pk: 'USER#u', sk: 'SESSION#h', expires_at: 100 } } }
  ]);
  s.memory.calls.length = 0;
  await s.touchSession('h', 2, 200, 'u');
  assert.deepEqual(s.memory.calls[0], {
    name: 'UpdateCommand',
    input: {
      TableName: 'T',
      Key: { pk: 'SESSION#h', sk: 'SESSION' },
      UpdateExpression: 'SET seen_at = :now, expires_at = :exp',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':now': 2, ':exp': 200 }
    }
  });
});
test('thumbnail field write uses bounded media index and exact file-number guard', async () => {
  const s = setup();
  s.seed({ ...note, media: [{ n: 7, kind: 'image' }] });
  const thumb = { key: 'media/u/photo/7.thumb.jpg', size: 50, width: 10, height: 20 };
  await s.setMediaField('u', day, 'a-note', 7, 'thumb', thumb);
  assert.deepEqual(s.memory.calls[1], {
    name: 'UpdateCommand',
    input: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: note.sk },
      UpdateExpression: 'SET media[0].#f = :t',
      ConditionExpression: 'attribute_exists(pk) AND media[0].n = :n',
      ExpressionAttributeNames: { '#f': 'thumb' },
      ExpressionAttributeValues: { ':t': thumb, ':n': 7 }
    }
  });
});
