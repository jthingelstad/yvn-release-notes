import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail } from '../../packages/testing/services.ts';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import * as inbound from '../../workers/inbound.ts';
import type { Item } from '../../packages/backend/store.ts';
const profile = {
    pk: 'USER#u',
    sk: 'PROFILE',
    email: 'ada@example.com',
    status: 'active',
    birthday: '1972-03-05',
    tz: 'America/Chicago'
  },
  now = Date.parse('2026-10-13T12:00:00Z') / 1000,
  at = '2026-10-13T12:00:00Z';
const setup = () => new FakeStore([profile], 'T');
const lastTransaction = (s: FakeStore) =>
  s.memory.calls.filter((c) => c.name === 'TransactWriteCommand').at(-1)!.input as InstanceType<
    typeof TransactWriteCommand
  >['input'];
test('sender day/token creation and message completion use exact live-account transactions', async () => {
  const s = setup(),
    day = '2026-10-13';
  assert.equal(await s.putDay('u', day, '5.4.222', 't', at), true);
  assert.deepEqual(lastTransaction(s), {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression:
            'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND (attribute_not_exists(#status) OR #status = :active)',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':active': 'active' }
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'TOKEN#t', sk: 'TOKEN', user_id: 'u', date: day, version: '5.4.222', sent_at: now },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'USER#u', sk: `DAY#${day}`, version: '5.4.222', token: 't', sent_at: at },
          ConditionExpression: 'attribute_not_exists(pk)'
        }
      }
    ]
  });
  assert.equal(await s.setDayMessageId('u', day, 'ses', 't'), true);
  assert.deepEqual(lastTransaction(s), {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: `DAY#${day}` },
          UpdateExpression: 'SET ses_message_id = :m',
          ConditionExpression: 'attribute_exists(pk) AND #token = :token',
          ExpressionAttributeNames: { '#token': 'token' },
          ExpressionAttributeValues: { ':m': 'ses', ':token': 't' }
        }
      }
    ]
  });
  s.seed({ ...profile, last_sent_date: day });
  await s.releaseDay('u', day, null, 't');
  assert.deepEqual(lastTransaction(s), {
    TransactItems: [
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'REMOVE last_sent_date',
          ConditionExpression: 'last_sent_date = :d',
          ExpressionAttributeValues: { ':d': day }
        }
      },
      {
        ConditionCheck: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: `DAY#${day}` },
          ConditionExpression: 'attribute_not_exists(pk) OR #token = :token',
          ExpressionAttributeNames: { '#token': 'token' },
          ExpressionAttributeValues: { ':token': 't' }
        }
      }
    ]
  });
});
test('sender transactions refuse stopped/deleting/missing accounts and cannot recreate absent days', async () => {
  for (const state of ['stopped', 'deleting', 'missing']) {
    const s = setup();
    if (state === 'stopped') s.seed({ ...profile, status: 'stopped' });
    if (state === 'deleting') await s.mcpBlock('u');
    if (state === 'missing') await s.deleteKeys([{ pk: 'USER#u', sk: 'PROFILE' }]);
    assert.equal(await s.putDay('u', '2026-10-13', '5.4.222', 't', at), false);
    assert.equal(await s.getToken('t'), null);
    assert.equal(s.memory.read({ pk: 'USER#u', sk: 'DAY#2026-10-13' }), null);
  }
  const s = setup();
  assert.equal(await s.setDayMessageId('u', '2026-10-13', 'ses', 't'), false);
  assert.equal(s.memory.read({ pk: 'USER#u', sk: 'DAY#2026-10-13' }), null);
  await s.putDay('u', '2026-10-13', '5.4.222', 't', at);
  await s.mcpBlock('u');
  assert.equal(await s.setDayMessageId('u', '2026-10-13', 'ses', 't'), false);
  assert.equal(s.memory.read({ pk: 'USER#u', sk: 'DAY#2026-10-13' })?.ses_message_id, undefined);
});
test('SNS exact native SDK transaction combines receipt, profile barrier and monthly ADD', async () => {
  const s = setup();
  assert.equal(await s.applyMailEvent('u', 'digest', 'bounce', at, now), 'applied');
  assert.deepEqual(lastTransaction(s), {
    TransactItems: [
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'USER#u', sk: 'PROFILE' },
          UpdateExpression: 'SET #s = :s, stopped_reason = :r, stopped_at = :at',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':s': 'stopped', ':r': 'bounce', ':at': at }
        }
      },
      {
        Update: {
          TableName: 'T',
          Key: { pk: 'TALLY#2026-10', sk: 'TALLY' },
          UpdateExpression: 'ADD #n :one',
          ExpressionAttributeNames: { '#n': 'bounces' },
          ExpressionAttributeValues: { ':one': 1 }
        }
      },
      {
        Put: {
          TableName: 'T',
          Item: { pk: 'USER#u', sk: 'MAILEVENT#digest', expires_at: now + 30 * 86400 },
          ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
          ExpressionAttributeValues: { ':now': now }
        }
      }
    ]
  });
});
test('SNS proof refuses missing/deleting profile without tally or receipt; expired receipts can refresh', async () => {
  for (const missing of [false, true]) {
    const s = missing ? new FakeStore([], 'T') : setup();
    if (!missing) await s.mcpBlock('u');
    assert.equal(await s.applyMailEvent('u', 'digest', 'complaint', at, now), 'gone');
    assert.equal(
      s.memory.all().some((i) => String(i.pk).startsWith('TALLY#') || String(i.sk).startsWith('MAILEVENT#')),
      false
    );
  }
  const s = setup();
  s.seed({ pk: 'USER#u', sk: 'MAILEVENT#digest', expires_at: now });
  assert.equal(await s.applyMailEvent('u', 'digest', 'complaint', at, now), 'applied');
  assert.equal(s.memory.read({ pk: 'TALLY#2026-10', sk: 'TALLY' })?.complaints, 1);
});
test('SNS transient transaction conflict retries; unknown service failure is surfaced', async () => {
  const s = setup();
  let attempts = 0;
  s.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand && ++attempts === 1)
      throw Object.assign(new Error('conflict'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'TransactionConflict' }]
      });
  };
  assert.equal(await s.applyMailEvent('u', 'digest', 'bounce', at, now), 'applied');
  assert.equal(attempts, 2);
  s.memory.beforeSend = () => {
    throw Object.assign(new Error('private'), { name: 'InternalServerError' });
  };
  await assert.rejects(() => s.applyMailEvent('u', 'other', 'bounce', at, now), { name: 'InternalServerError' });
});
test('late notice exact SDK transaction atomically proves active account, token owner and capped counter', async () => {
  const s = setup();
  s.seed({ pk: 'TOKEN#t', sk: 'TOKEN', user_id: 'u' });
  assert.equal(await s.reserveLateNotice('u', 't', at, now), 'reserved');
  const transaction = lastTransaction(s),
    items = transaction.TransactItems!;
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression: 'attribute_exists(pk) AND #s = :s AND attribute_not_exists(mcp_deleting)',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'active' }
    }
  });
  assert.equal(
    items[1]!.Update!.ConditionExpression,
    'attribute_exists(pk) AND user_id = :u AND attribute_not_exists(late_notice_at)'
  );
  assert.deepEqual(items[2], {
    Update: {
      TableName: 'T',
      Key: { pk: `RATE#latenotice:u#${Math.floor(now / 86400)}`, sk: 'RATE' },
      UpdateExpression: 'SET expires_at = :expiry ADD #n :one',
      ConditionExpression: 'attribute_not_exists(#n) OR #n < :limit',
      ExpressionAttributeNames: { '#n': 'n' },
      ExpressionAttributeValues: { ':one': 1, ':limit': 3, ':expiry': (Math.floor(now / 86400) + 2) * 86400 }
    }
  });
});
test('parallel expired replies reserve at most three per account/day, and limited tokens stay unused', async () => {
  const s = setup();
  for (let i = 0; i < 12; i++) s.seed({ pk: `TOKEN#t${i}`, sk: 'TOKEN', user_id: 'u' });
  const outcomes = await Promise.all(Array.from({ length: 12 }, (_, i) => s.reserveLateNotice('u', `t${i}`, at, now)));
  assert.equal(outcomes.filter((v) => v === 'reserved').length, 3);
  assert.equal(outcomes.filter((v) => v === 'limited').length, 9);
  assert.equal(s.memory.all().filter((i) => String(i.pk).startsWith('TOKEN#') && i.late_notice_at).length, 3);
  assert.equal(await s.peek('latenotice:u', Math.floor(now / 86400)), 3);
  assert.equal(await s.reserveLateNotice('u', 't3', at, now + 86400), 'reserved');
});
test('duplicate token, wrong owner, stopped/deleting/missing accounts consume no late counter', async () => {
  const s = setup();
  s.seed({ pk: 'TOKEN#t', sk: 'TOKEN', user_id: 'u' });
  assert.equal(await s.reserveLateNotice('u', 't', at, now), 'reserved');
  assert.equal(await s.reserveLateNotice('u', 't', at, now), 'already-sent');
  assert.equal(await s.peek('latenotice:u', Math.floor(now / 86400)), 1);
  for (const state of ['stopped', 'deleting', 'missing']) {
    const f = setup();
    f.seed({ pk: 'TOKEN#t', sk: 'TOKEN', user_id: 'u' });
    if (state === 'stopped') await f.stop('u', 'bounce', at);
    else if (state === 'deleting') await f.mcpBlock('u');
    else await f.deleteKeys([{ pk: 'USER#u', sk: 'PROFILE' }]);
    assert.equal(await f.reserveLateNotice('u', 't', at, now), 'stopped');
    assert.equal(await f.peek('latenotice:u', Math.floor(now / 86400)), 0);
    assert.equal((await f.getToken('t'))?.late_notice_at, undefined);
  }
  const wrong = setup();
  wrong.seed({ pk: 'TOKEN#t', sk: 'TOKEN', user_id: 'v' });
  assert.equal(await wrong.reserveLateNotice('u', 't', at, now), 'already-sent');
  assert.equal(await wrong.peek('latenotice:u', Math.floor(now / 86400)), 0);
});
test('guarded inbound write atomically checks current standing and profile barrier, then put-if-absent', async () => {
  const s = setup();
  await s.setInbox('u', 'current', at);
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'message', { text: 'Synthetic' }, 'current'), 'stored');
  const operations = lastTransaction(s).TransactItems!;
  assert.deepEqual(operations[0], {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression:
        'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND inbox = :token AND #status = :active',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':token': 'current', ':active': 'active' }
    }
  });
  assert.equal(operations[1]!.Put!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'message', { text: 'changed' }, 'current'), 'duplicate');
  assert.equal((await s.note('u', '2026-10-13', 'message'))?.text, 'Synthetic');
  await s.setInbox('u', 'new', at, 'current');
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'late', { text: 'Synthetic' }, 'current'), 'refused');
  await s.stop('u', 'bounce', at);
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'late', { text: 'Synthetic' }, 'new'), 'refused');
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'reply', { text: 'Synthetic' }), 'stored');
  await s.mcpBlock('u');
  assert.equal(await s.putInboundNote('u', '2026-10-13', 'during-delete', { text: 'Synthetic' }), 'refused');
});
async function rawAudioFixture() {
  const store = setup(),
    objects = new FakeObjects(),
    mail = new FakeMail(),
    logs: Item[] = [],
    token = 'a'.repeat(24);
  await store.setInbox('u', token, at);
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1200)]).toString('base64');
  await objects.put(
    'raw/message',
    Buffer.from(
      `From: ada@example.com\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename=voice.mp3\r\nContent-Transfer-Encoding: base64\r\n\r\n${audio}`
    ),
    { type: 'message/rfc822' }
  );
  return {
    store,
    objects,
    mail,
    logs,
    token,
    services: {
      store,
      objects,
      mail,
      fromAddress: 'notes@example.com',
      inboundDomain: 'in.example.com',
      log: (fields: Record<string, string | number | boolean>) => {
        logs.push(fields);
      }
    },
    ses: {
      mail: { messageId: 'message', timestamp: at, commonHeaders: { from: ['ada@example.com'] } },
      receipt: { recipients: [`${token}@in.example.com`], dmarcVerdict: { status: 'PASS' } }
    }
  };
}
test('account deletion races media upload: guard refuses, pending copies removed, raw remains intact', async () => {
  const f = await rawAudioFixture(),
    put = f.objects.put.bind(f.objects);
  f.objects.put = async (key, body, options) => {
    const version = await put(key, body, options);
    if (key.startsWith('media/')) {
      assert.equal(options.tags?.outcome, 'pending');
      await f.store.mcpBlock('u');
    }
    return version;
  };
  assert.equal(await inbound.process(f.ses, f.services), 'ignored');
  assert.equal((await f.store.allNotes('u')).length, 0);
  assert.deepEqual(await f.objects.list('media/u/'), []);
  assert.equal((await f.objects.get('raw/message')).body.length > 0, true);
  assert.equal(f.logs.at(-1)?.reason, 'account-changed');
});
test('address replacement races media upload: guard refuses and cleanup failure retries with pending lifecycle fallback', async () => {
  const f = await rawAudioFixture(),
    put = f.objects.put.bind(f.objects);
  f.objects.put = async (key, body, options) => {
    const version = await put(key, body, options);
    if (key.startsWith('media/')) await f.store.setInbox('u', 'b'.repeat(24), at, f.token);
    return version;
  };
  f.objects.remove = async () => {
    throw new Error('Cleanup unavailable');
  };
  await assert.rejects(() => inbound.process(f.ses, f.services), /staged-media cleanup failed/);
  assert.equal((await f.store.allNotes('u')).length, 0);
  const pending = await f.objects.list('media/u/');
  assert.equal(pending.length, 1);
  assert.equal(f.objects.versions.get(pending[0]!)?.at(-1)?.tags.outcome, 'pending');
  assert.equal(f.objects.versions.get('raw/message')?.at(-1)?.tags.outcome, undefined);
});
test('successful inbound media promoted only after note transaction; duplicate retries preserve owner edits', async () => {
  const f = await rawAudioFixture(),
    tag = f.objects.tag.bind(f.objects);
  f.objects.tag = async (key, tags) => {
    if (key.startsWith('media/')) {
      assert.equal(tags.outcome, 'note');
      assert.equal((await f.store.allNotes('u')).length, 1);
    }
    return tag(key, tags);
  };
  await inbound.process(f.ses, f.services);
  const n = (await f.store.allNotes('u'))[0]!;
  await f.store.updateNote('u', '2026-10-13', 'message', 'Owner edit', at);
  await inbound.process(f.ses, f.services);
  assert.equal((await f.store.note('u', '2026-10-13', 'message'))?.text, 'Owner edit');
  assert.equal((n.media as Item[]).length, 1);
  assert.equal(f.objects.versions.get(String((n.media as Item[])[0]!.key))?.at(-1)?.tags.outcome, 'note');
});
test('atomic session create writes row and USER index with live profile proof; verified email-only has no account index', async () => {
  const s = setup();
  assert.equal(await s.createSession('h', { user_id: 'u', now: 10, expires: 100 }), true);
  const items = lastTransaction(s).TransactItems!;
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
    }
  });
  assert.equal(items[1]!.Put!.ConditionExpression, 'attribute_not_exists(pk)');
  assert.deepEqual(items[2]!.Put!.Item, { pk: 'USER#u', sk: 'SESSION#h', expires_at: 100 });
  assert.equal(await s.createSession('verified', { email: 'new@example.com', now: 10, expires: 100 }), true);
  assert.equal(lastTransaction(s).TransactItems!.length, 1);
  assert.equal(await s.createSession('h', { user_id: 'u', now: 20, expires: 200 }), false);
  assert.equal((await s.getSession('h'))?.expires_at, 100);
});
test('session renewal has strict expiration and expected-owner proof; refused renewal cannot overwrite/delete existing session', async () => {
  const s = setup();
  await s.createSession('h', { user_id: 'u', now: 10, expires: 100 });
  assert.equal(await s.renewSession('h', 'v', 20, 200), false);
  assert.equal(await s.renewSession('h', null, 20, 200), false);
  assert.equal(await s.renewSession('h', 'u', 100, 200), false);
  assert.equal(await s.renewSession('h', 'u', 99, 200), true);
  assert.equal((await s.getSession('h'))?.expires_at, 200);
  assert.equal(s.memory.read({ pk: 'USER#u', sk: 'SESSION#h' })?.expires_at, 200);
  await s.mcpBlock('u');
  assert.equal(await s.renewSession('h', 'u', 120, 300), false);
  assert.equal((await s.getSession('h'))?.expires_at, 200);
  assert.equal(await s.createSession('new', { user_id: 'u', now: 120, expires: 300 }), false);
  assert.equal(await s.getSession('new'), null);
});
test('claim verified session proves email, expiry and account; removes email atomically and indexes every browser session', async () => {
  const s = setup();
  await s.createSession('h', { email: 'ada@example.com', now: 10, expires: 100 });
  assert.equal(await s.claimVerifiedSession('h', 'u', 'wrong@example.com', 20, 200), false);
  assert.equal(await s.claimVerifiedSession('h', 'u', 'ada@example.com', 100, 200), false);
  assert.equal(await s.claimVerifiedSession('h', 'u', 'ada@example.com', 20, 200), true);
  assert.equal((await s.getSession('h'))?.email, undefined);
  assert.equal((await s.getSession('h'))?.user_id, 'u');
  assert.equal(s.memory.read({ pk: 'USER#u', sk: 'SESSION#h' })?.expires_at, 200);
  assert.equal(await s.claimVerifiedSession('h', 'u', 'ada@example.com', 21, 201), true);
  await s.mcpBlock('u');
  assert.equal(await s.claimVerifiedSession('h', 'u', 'ada@example.com', 22, 202), false);
  assert.equal((await s.getSession('h'))?.expires_at, 201);
});
test('profile removed at session transaction boundary causes no session or index resurrection', async () => {
  const s = setup();
  const entries = [...s.memory.items.entries()];
  s.memory.beforeSend = (command) => {
    if (command instanceof TransactWriteCommand)
      for (const [key, item] of entries) if (item.sk === 'PROFILE') s.memory.items.delete(key);
  };
  assert.equal(await s.createSession('h', { user_id: 'u', now: 10, expires: 100 }), false);
  assert.equal(await s.getSession('h'), null);
  assert.equal(
    s.memory.all().some((i) => i.sk === 'SESSION#h'),
    false
  );
});
test('sender claim refuses current stopped/deleting/missing accounts and accepts legacy active default', async () => {
  for (const state of ['stopped', 'deleting', 'missing']) {
    const s = setup();
    if (state === 'stopped') await s.stop('u', 'bounce', at);
    else if (state === 'deleting') await s.mcpBlock('u');
    else await s.deleteKeys([{ pk: 'USER#u', sk: 'PROFILE' }]);
    assert.equal(await s.claimDay('u', '2026-10-13'), false);
    assert.equal((await s.profile('u'))?.last_sent_date, undefined);
  }
  const s = new FakeStore([{ pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com' }]);
  assert.equal(await s.claimDay('u', '2026-10-13'), true);
});
test('previously filed raw mail is never downgraded when a duplicate retry meets changed standing proof', async () => {
  const f = await rawAudioFixture();
  await inbound.process(f.ses, f.services);
  const put = f.objects.put.bind(f.objects);
  f.objects.put = async (key, body, options) => {
    const version = await put(key, body, options);
    if (key.startsWith('media/')) await f.store.setInbox('u', 'b'.repeat(24), at, f.token);
    return version;
  };
  assert.equal(await inbound.process(f.ses, f.services), 'ignored');
  assert.equal((await f.store.allNotes('u')).length, 1);
  assert.equal((await f.objects.list('media/u/')).length, 1);
  assert.equal(f.objects.versions.get('raw/message')?.at(-1)?.tags.outcome, 'note');
});
test('export finish atomically checks live profile and current building ID; deletion/superseding builds cannot publish ready', async () => {
  for (const state of ['live', 'deleting', 'missing', 'superseded']) {
    const s = setup();
    await s.startExport('u', 'build', 10, 100);
    if (state === 'deleting') await s.mcpBlock('u');
    else if (state === 'missing') await s.deleteKeys([{ pk: 'USER#u', sk: 'PROFILE' }]);
    else if (state === 'superseded') await s.startExport('u', 'new', 10, 100);
    assert.equal(
      await s.finishExportGuarded('u', 'build', { status: 'ready', key: 'exports/u/build.zip' }),
      state === 'live'
    );
    const txn = lastTransaction(s);
    assert.equal(txn.TransactItems!.length, 2);
    assert.equal(
      txn.TransactItems![0]!.ConditionCheck!.ConditionExpression,
      'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
    );
    assert.equal(txn.TransactItems![1]!.Update!.ConditionExpression, '#id = :id AND #s = :b');
    assert.equal((await s.export('u'))?.status, state === 'live' ? 'ready' : 'building');
  }
});
