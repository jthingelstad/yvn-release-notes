import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { simpleParser } from 'mailparser';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail } from '../../packages/testing/services.ts';
import * as media from '../../packages/backend/media.ts';
import { Subscriber, type Item } from '../../packages/backend/store.ts';
import * as sender from '../../workers/send.ts';
import * as inbound from '../../workers/inbound.ts';
import * as events from '../../workers/events.ts';
import { parseHeaders } from '../../packages/mail/parse.ts';
import { noticeText } from '../../packages/mail/compose.ts';
import { computeVersion } from '../../packages/domain/version.ts';
const now = Date.parse('2026-10-13T11:00:00Z') / 1000,
  token = 'a'.repeat(24),
  standingToken = 'b'.repeat(24),
  day = '2026-10-13';
const profile: Item = {
  pk: 'USER#u',
  sk: 'PROFILE',
  email: 'ada@example.com',
  birthday: '1972-03-05',
  tz: 'America/Chicago',
  status: 'active',
  send_time: '06:00'
};
function setup(extra: Item = {}) {
  const store = new FakeStore([
      { ...profile, ...extra },
      { pk: 'EMAIL#ada@example.com', sk: 'EMAIL', user_id: 'u' }
    ]),
    mail = new FakeMail(),
    objects = new FakeObjects(),
    logs: Item[] = [];
  return {
    store,
    mail,
    objects,
    logs,
    services: {
      store,
      mail,
      objects,
      fromAddress: 'notes@example.com',
      inboundDomain: 'in.example.com',
      clock: () => now,
      log: (fields: Record<string, string | number | boolean>) => {
        logs.push(fields);
      }
    }
  };
}
function note(day: string, id = 'n', text = 'A synthetic note', extra: Item = {}): Item {
  return { pk: 'USER#u', sk: `NOTE#${day}#${id}`, text, source: 'email', written_at: `${day}T10:00:00Z`, ...extra };
}
function ses(
  opts: { date?: string; recipient?: string; from?: string; subject?: string; verdict?: inbound.SesReceipt } = {}
) {
  return {
    mail: {
      messageId: 'synthetic-id',
      timestamp: opts.date ?? '2026-10-13T12:00:00Z',
      commonHeaders: { from: [opts.from ?? 'Ada <ada@example.com>'], subject: opts.subject ?? 'Re: today' }
    },
    receipt: {
      recipients: [opts.recipient ?? `n-${token}@in.example.com`],
      spamVerdict: { status: 'PASS' },
      virusVerdict: { status: 'PASS' },
      dmarcVerdict: { status: 'PASS' },
      dkimVerdict: { status: 'PASS' },
      ...opts.verdict
    }
  };
}
async function replyFixture(
  raw = 'From: Ada <ada@example.com>\r\nMessage-ID: <reply@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nI made a little thing. #made'
) {
  const f = setup();
  f.store.seed({
    pk: `TOKEN#${token}`,
    sk: 'TOKEN',
    user_id: 'u',
    date: '2026-10-11',
    version: '5.4.220',
    sent_at: now - 2 * 86400
  });
  await f.objects.put('raw/synthetic-id', Buffer.from(raw), { type: 'message/rfc822' });
  f.objects.calls.length = 0;
  return f;
}
test('due windows use local wall time, cap at midnight, and refuse sent/future day', () => {
  const sub = Subscriber.fromItem(profile);
  for (const [at, due] of [
    ['2026-10-13T10:59:59Z', false],
    ['2026-10-13T11:00:00Z', true],
    ['2026-10-13T13:59:59Z', true],
    ['2026-10-13T14:00:00Z', false]
  ] as const)
    assert.equal(sender.isDue(sub, sender.localNow(Date.parse(at) / 1000, sub.tz)), due);
  sub.last_sent_date = day;
  assert.equal(sender.isDue(sub, sender.localNow(now, sub.tz)), false);
  sub.last_sent_date = '2026-10-14';
  assert.equal(sender.isDue(sub, sender.localNow(now, sub.tz)), false);
  sub.last_sent_date = null;
  sub.send_time = '23:45';
  assert.equal(sender.isDue(sub, sender.localNow(Date.parse('2026-10-14T04:59:59Z') / 1000, sub.tz)), true);
  assert.equal(sender.isDue(sub, sender.localNow(Date.parse('2026-10-14T05:00:00Z') / 1000, sub.tz)), false);
});
test('DST spring skip and fall repeated hour retain one local-day send', () => {
  const sub = Subscriber.fromItem({ ...profile, send_time: '01:30' });
  for (const at of ['2026-11-01T06:45:00Z', '2026-11-01T07:45:00Z'])
    assert.equal(sender.isDue(sub, sender.localNow(Date.parse(at) / 1000, sub.tz)), true);
  assert.equal(sender.isDue(sub, sender.localNow(Date.parse('2026-03-08T08:15:00Z') / 1000, sub.tz)), true);
  assert.equal(sender.localNow(now, 'Pacific/Kiritimati').day, '2026-10-14');
});
test('dry-run reports content-free history and performs no SDK mutation or mail send', async () => {
  const f = setup();
  f.store.seed(note('2026-10-12'));
  f.store.seed(note('2025-10-13', 'old'));
  const before = f.store.memory.all();
  const report = await sender.handler({ dry_run: true, now: '2026-10-13T11:00:00Z' }, null, f.services);
  assert.equal((report.results as Item[])[0]?.notes, 2);
  assert.equal((report.results as Item[])[0]?.yesterday, '2026-10-12');
  assert.deepEqual(f.store.memory.all(), before);
  assert.equal(f.mail.messages.length, 0);
  assert.ok(
    !f.store.memory.calls.some((c) =>
      ['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWriteCommand'].includes(c.name)
    )
  );
  assert.ok(!JSON.stringify(report).includes('synthetic note'));
});
test('real sends cannot override now; send_now refuses inactive/missing and paused subscribers', async () => {
  const f = setup();
  await assert.rejects(() => sender.handler({ now: '2026-10-13' }, null, f.services), /dry runs only/);
  await assert.rejects(() => sender.handler({ send_now: 'missing' }, null, f.services), /active subscriber/);
  await f.store.stop('u', 'unsubscribed', '2026-10-13T10:00:00Z');
  await assert.rejects(() => sender.handler({ send_now: 'u' }, null, f.services), /active subscriber/);
  const paused = setup({ pause_from: day, pause_through: day });
  assert.equal(
    ((await sender.handler({ send_now: 'u' }, null, paused.services)).results as Item[])[0]?.outcome,
    'paused'
  );
  assert.equal(paused.mail.messages.length, 0);
});
test('concurrent sender claims produce one email and stable day token; repeats do not resend', async () => {
  const f = setup();
  const [a, b] = await Promise.all([sender.handler({}, null, f.services), sender.handler({}, null, f.services)]);
  assert.equal(f.mail.messages.length, 1);
  assert.equal(f.mail.messages[0]?.kind, 'daily');
  assert.equal((await f.store.profile('u'))?.last_sent_date, day);
  const outcomes = [...(a.results as Item[]), ...(b.results as Item[])].map((r) => r.outcome).sort();
  assert.deepEqual(outcomes, ['already-claimed', 'sent']);
  const saved = f.store.memory.read({ pk: 'USER#u', sk: `DAY#${day}` });
  assert.match(String(saved?.token), /^[a-z2-7]{24}$/);
  assert.equal(saved?.ses_message_id, 'm-1');
  await sender.handler({}, null, f.services);
  assert.equal(f.mail.messages.length, 1);
  const message = await simpleParser(f.mail.messages[0]!.raw);
  assert.match(message.text!, /Welcome to Release Notes/);
  assert.match(message.text!, /Write any day, no reply needed/);
  assert.ok(!JSON.stringify(f.logs).includes('@'));
});
test('pre-send failure conditionally releases day and removes orphaned reply token', async () => {
  const f = setup({ last_sent_date: '2026-10-12' });
  f.mail.fail = true;
  await assert.rejects(() => sender.handler({}, null, f.services), /1 send/);
  assert.equal((await f.store.profile('u'))?.last_sent_date, '2026-10-12');
  assert.equal(f.store.memory.read({ pk: 'USER#u', sk: `DAY#${day}` }), null);
  assert.equal(f.store.memory.all().filter((i) => String(i.pk).startsWith('TOKEN#')).length, 0);
  f.mail.fail = false;
  await sender.handler({}, null, f.services);
  assert.equal(f.mail.messages.length, 1);
});
for (const phase of ['before-day', 'ses-delivery'] as const)
  test(`deletion during ${phase} cannot resurrect sender tokens or USER rows`, async () => {
    const f = setup(),
      entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>();
    if (phase === 'before-day') {
      const create = f.store.putDay.bind(f.store);
      f.store.putDay = async (...args) => {
        entered.resolve();
        await resume.promise;
        return create(...args);
      };
    } else {
      const send = f.mail.send.bind(f.mail);
      f.mail.send = async (...args) => {
        entered.resolve();
        await resume.promise;
        return send(...args);
      };
    }
    const running = sender.handler({}, null, f.services);
    await entered.promise;
    await f.store.mcpBlock('u');
    await f.store.deleteKeys(f.store.memory.all().map((row) => ({ pk: String(row.pk), sk: String(row.sk) })));
    resume.resolve();
    const report = await running;
    assert.equal((report.results as Item[])[0]?.outcome, 'account-changed');
    assert.deepEqual(f.store.memory.all(), []);
    assert.equal(f.mail.messages.length, Number(phase === 'ses-delivery'));
    assert.ok(!JSON.stringify(f.logs).includes('@'));
  });
test('stale sender cleanup preserves a newer day token and its reservation', async () => {
  const f = setup(),
    entered = Promise.withResolvers<void>(),
    resume = Promise.withResolvers<void>();
  const send = f.mail.send.bind(f.mail);
  f.mail.send = async (...args) => {
    entered.resolve();
    await resume.promise;
    return send(...args);
  };
  const running = sender.handler({}, null, f.services);
  await entered.promise;
  const pending = f.store.memory.read({ pk: 'USER#u', sk: `DAY#${day}` })!;
  f.store.seed({ ...pending, token: 'newer', ses_message_id: 'winner' });
  f.store.seed({ pk: 'TOKEN#newer', sk: 'TOKEN', user_id: 'u' });
  resume.resolve();
  assert.equal(((await running).results as Item[])[0]?.outcome, 'account-changed');
  assert.equal((await f.store.profile('u'))?.last_sent_date, day);
  assert.equal(f.store.memory.read({ pk: 'USER#u', sk: `DAY#${day}` })?.ses_message_id, 'winner');
  assert.ok(await f.store.getToken('newer'));
  assert.equal(await f.store.getToken(String(pending.token)), null);
});
test('one failed subscriber does not prevent other mail; time reserve stops claiming', async () => {
  const f = setup();
  f.store.seed({ ...profile, pk: 'USER#v', email: 'second@example.com' });
  const send = f.mail.send.bind(f.mail);
  f.services.mail = {
    ...f.mail,
    send: async (raw, to, kind) => {
      if (to === 'ada@example.com') throw Object.assign(new Error('private content'), { name: 'ServiceFailure' });
      return send(raw, to, kind);
    },
    unsuppress: f.mail.unsuppress.bind(f.mail)
  };
  await assert.rejects(() => sender.handler({}, null, f.services), /1 send/);
  assert.equal(f.mail.messages.length, 1);
  assert.equal(f.mail.messages[0]?.to, 'second@example.com');
  assert.ok(!JSON.stringify(f.logs).includes('private content'));
  const timed = setup();
  await sender.handler({}, { getRemainingTimeInMillis: () => 19000 }, timed.services);
  assert.equal(timed.mail.messages.length, 0);
  assert.equal((await timed.store.profile('u'))?.last_sent_date, undefined);
});
test('weather sharing/cache and first failure budget prevent one timeout per recipient', async () => {
  let calls = 0,
    timer = 0;
  const fetcher = sender.oneRun(
    async () => {
      calls++;
      return { x: 1 };
    },
    30,
    () => timer
  );
  await Promise.all([fetcher('x'), fetcher('x')]);
  assert.equal(calls, 1);
  let errors = 0;
  const broken = sender.oneRun(async () => {
    errors++;
    throw new Error('offline');
  });
  await assert.rejects(() => broken('a'));
  await assert.rejects(() => broken('b'));
  assert.equal(errors, 1);
  const budget = sender.oneRun(
    async () => {
      timer = 31;
      return {};
    },
    30,
    () => timer
  );
  timer = 0;
  await budget('a');
  await assert.rejects(() => budget('b'));
});
test('history preserves assistant provenance, tags from words, written order and place distinction', async () => {
  const f = setup();
  f.store.seed(
    note('2026-10-12', 'z', 'Owner words #mine', {
      written_at: '2026-10-12T01:00:00Z',
      place: { city: 'Example', lat: 1, lon: 2 }
    })
  );
  f.store.seed(
    note('2026-10-12', 'a', 'Agent words', {
      source: 'agent',
      author: 'assistant',
      client: 'helper #not-a-tag',
      written_at: '2026-10-12T02:00:00Z',
      place: { city: 'Example', from: 'home' }
    })
  );
  const sub = (await f.store.getSubscriber('u'))!,
    [, , y] = await sender.readHistory(f.services, sub, day);
  assert.match(y!.text, /Owner words[\s\S]*Added by helper #not-a-tag:\nAgent words/);
  assert.deepEqual(y!.tags, ['mine']);
  // A note's spot links our map on that note; home's city is not mapped.
  assert.deepEqual(y!.places, [
    ['Example', 'https://notes.yourversionnumber.com/map/#d=2026-10-12&n=z'],
    ['Example', null]
  ]);
});
test("the day's own place links our map on that day, and a spot shared by notes shows once", () => {
  const at = { city: 'Paris', label: 'Corner Café', lat: 48.856613, lon: 2.352222 };
  assert.deepEqual(
    sender.placesOf(
      [
        { sk: 'NOTE#2026-10-12#w-2', written_at: '2026-10-12T02:00:00Z', place: at },
        { sk: 'NOTE#2026-10-12#<m#1@example.com>', written_at: '2026-10-12T01:00:00Z', place: at }
      ],
      { city: 'Paris', lat: 48.85, lon: 2.35, from: 'chosen' },
      '2026-10-12'
    ),
    [
      ['Paris', 'https://notes.yourversionnumber.com/map/#d=2026-10-12&ll=48.85%2C2.35'],
      ['Corner Café, Paris', 'https://notes.yourversionnumber.com/map/#d=2026-10-12&n=%3Cm%231%40example.com%3E']
    ]
  );
});
test('on birthday closed release counts imported notes, paused gaps and photos', async () => {
  const f = setup({ birthday: '1972-10-13' });
  f.store.seed(note('2026-10-09', 'one', '', { source: 'dayone', media: [{ kind: 'image' }] }));
  f.store.seed(note('2026-10-11', 'two'));
  f.store.seed(note('2026-10-11', 'three'));
  await f.store.putPause('u', '2026-10-10', '2026-10-10', 'now');
  const sub = (await f.store.getSubscriber('u'))!,
    closed = await sender.readClosed(f.services, sub, day, await f.store.noteIndex('u'));
  assert.deepEqual(closed, {
    age: 53,
    days: 2,
    notes: 3,
    photos: 1,
    longest: 2,
    badges: { coverage: null, collected: [] }
  });
  sub.badges = false;
  assert.ok(!('badges' in (await sender.readClosed(f.services, sub, day, await f.store.noteIndex('u')))!));
});
test('the email names new badges once, beside a special day; a failed read or "Show badges" off sends without', async () => {
  // 2026-10-13 is 4.4.300 for this Ada; yesterday's reply earned the firsts.
  const reply = note('2026-10-12', 'r1', 'A synthetic reply', {
      subject: 'Re: today',
      written_at: '2026-10-12T22:00:00Z'
    }),
    f = setup({ birthday: '1981-12-17' });
  f.store.seed(reply);
  await f.store.addSeenBadges('u', ['hello'], 'before');
  const dry = ((await sender.handler({ dry_run: true }, null, f.services)).results as Item[])[0]!;
  assert.deepEqual([dry.badges, dry.special_day], [2, true]);
  await sender.handler({}, null, f.services);
  const sent = await simpleParser(f.mail.messages[0]!.raw);
  assert.match(sent.text!, /^You're 4\.4\.300 today\. 4\.4\.300 is a round number\.$/m);
  assert.match(
    sent.text!,
    /^New badges: ACK and Commit message\. See your badges: https:\/\/notes\.yourversionnumber\.com\/badges\/$/m
  );
  assert.ok(!sent.text!.includes('Hello, world'), 'seen before');
  assert.match(String(sent.html), /id="badge-news"/);
  assert.deepEqual(await f.store.seenBadges('u'), new Set(['hello', 'ack', 'commit']));
  // Told once: the next morning has nothing new and no special day.
  const next = Date.parse('2026-10-14T11:00:00Z') / 1000,
    later = (
      (await sender.handler({ dry_run: true, now: new Date(next * 1000).toISOString() }, null, f.services))
        .results as Item[]
    )[0]!;
  assert.deepEqual([later.version, later.badges, later.special_day], ['4.4.301', 0, false]);

  // A failed read: the email goes, with the clause and without the line.
  const g = setup({ birthday: '1981-12-17' });
  g.store.seed(reply);
  g.store.seenBadges = async () => {
    throw Object.assign(new Error('private'), { name: 'ProvisionedThroughputExceededException' });
  };
  await sender.handler({}, null, g.services);
  const failed = await simpleParser(g.mail.messages[0]!.raw);
  assert.match(failed.text!, /4\.4\.300 is a round number\./);
  assert.ok(!failed.text!.includes('New badge'));
  assert.equal(g.store.memory.read({ pk: 'USER#u', sk: 'BADGES' }), null);
  assert.deepEqual(
    g.logs.filter((l) => l.event === 'badges-error'),
    [{ event: 'badges-error', user: 'u', date: day, error: 'ProvisionedThroughputExceededException' }]
  );

  // "Show badges" off: neither line, nothing read or kept.
  const h = setup({ birthday: '1981-12-17', badges: false });
  h.store.seed(reply);
  await sender.handler({}, null, h.services);
  const off = await simpleParser(h.mail.messages[0]!.raw);
  for (const text of [off.text!, String(off.html)]) {
    assert.ok(!text.includes('round number'));
    assert.ok(!text.includes('New badge'));
  }
  assert.equal(h.store.memory.read({ pk: 'USER#u', sk: 'BADGES' }), null);
  assert.ok(!JSON.stringify([f.logs, g.logs, h.logs]).includes('synthetic'));

  // Turned off after the badges were read but before the send claimed the
  // day: the fresh profile wins, so neither line goes and nothing is seen.
  const k = setup({ birthday: '1981-12-17' });
  k.store.seed(reply);
  const claim = k.store.claimDay.bind(k.store);
  k.store.claimDay = async (...args: Parameters<typeof claim>) => {
    await k.store.updateProfile('u', { badges: false });
    return claim(...args);
  };
  await sender.handler({}, null, k.services);
  const late = await simpleParser(k.mail.messages[0]!.raw);
  for (const text of [late.text!, String(late.html)]) {
    assert.ok(!text.includes('round number'));
    assert.ok(!text.includes('New badge'));
  }
  assert.equal(k.store.memory.read({ pk: 'USER#u', sk: 'BADGES' }), null);
});
test('photo ordering, caps, stale size protection and opt-in-only alt text', async () => {
  const f = setup(),
    sub = (await f.store.getSubscriber('u'))!,
    media = Array.from({ length: 9 }, (_, i) => ({
      kind: 'image',
      description: 'private description',
      thumb: { key: `media/u/${i}.thumb.jpg`, size: 30, width: 640, height: 480 }
    }));
  assert.equal(sender.thumbsOf(sub, [{ media }])[0]?.alt, 'Photo');
  sub.describe = true;
  assert.equal(sender.thumbsOf(sub, [{ media }])[0]?.alt, 'private description');
  for (let i = 0; i < 9; i++) await f.objects.put(`media/u/${i}.thumb.jpg`, Buffer.alloc(30), { type: 'image/jpeg' });
  const y = {
      day: '2026-10-12',
      text: '',
      tags: [],
      thumbs: sender.thumbsOf(sub, [{ media }]),
      photos: [],
      others: 0,
      places: []
    },
    past = {
      shown: [{ day: '2025-10-13', text: '', tags: [], thumbs: sender.thumbsOf(sub, [{ media }]), photos: [] }],
      more: []
    };
  const [shownY, shownP, images] = await sender.withPhotos(f.services, sub, day, y, past);
  assert.equal(shownY?.photos.length, 4);
  assert.equal(shownP?.shown[0]?.photos.length, 2);
  assert.equal(Object.keys(images).length, 6);
  f.objects.calls.length = 0;
  await f.objects.put('media/u/too-big.thumb.jpg', Buffer.alloc(sender.WEATHER_BUDGET * 20000), { type: 'image/jpeg' });
  y.thumbs = [{ key: 'media/u/too-big.thumb.jpg', size: 1, width: 640, height: 480, alt: 'Photo' }];
  assert.equal(Object.keys((await sender.withPhotos(f.services, sub, day, y, null))[2]).length, 0);
});
test('photo NoSuchKey skips one; other read error strips all photos and preserves send', async () => {
  const f = setup(),
    sub = (await f.store.getSubscriber('u'))!,
    thumbs = [
      { key: 'media/u/missing.thumb.jpg', size: 2, width: 2, height: 2, alt: 'Photo' },
      { key: 'media/u/okay.thumb.jpg', size: 2, width: 2, height: 2, alt: 'Photo' }
    ];
  await f.objects.put('media/u/okay.thumb.jpg', Buffer.alloc(2), { type: 'image/jpeg' });
  const y = { day: '2026-10-12', text: '', tags: [], thumbs, photos: [], others: 0, places: [] };
  assert.equal((await sender.withPhotos(f.services, sub, day, y, null))[0]?.photos.length, 1);
  f.objects.get = async () => {
    throw new Error('private media failure');
  };
  assert.equal((await sender.withPhotos(f.services, sub, day, y, null))[0]?.photos.length, 0);
  assert.ok(!JSON.stringify(f.logs).includes('private media failure'));
});
test('inbound reply stays on original day, truncates by code point and retry is one note', async () => {
  const f = await replyFixture();
  assert.equal(await inbound.process(ses(), f.services), 'note');
  assert.equal(await inbound.process(ses(), f.services), 'note');
  const notes = await f.store.dayNotes('u', '2026-10-11');
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.version, '5.4.220');
  assert.equal(notes[0]?.parser_version, 3);
  assert.deepEqual(notes[0]?.tags, ['made']);
  assert.equal(f.objects.versions.get('raw/synthetic-id')?.at(-1)?.tags.outcome, 'note');
  assert.equal(f.logs.at(-1)?.duplicate, true);
  assert.ok(!JSON.stringify(f.logs).includes('little thing'));
});
for (const [name, verdict, reason] of [
  ['spam', { spamVerdict: { status: 'FAIL' } }, 'spam-or-virus'],
  ['virus scan failure', { virusVerdict: { status: 'PROCESSING_FAILED' } }, 'spam-or-virus'],
  ['DMARC failure', { dmarcVerdict: { status: 'FAIL' } }, 'unauthenticated']
] as const)
  test(`inbound rejects ${name}`, async () => {
    const f = await replyFixture();
    assert.equal(await inbound.process(ses({ verdict }), f.services), 'ignored');
    assert.equal(f.logs.find((l) => l.event === 'inbound')?.reason, reason);
    // Only the owner hears of an unverified reply, never the sender; spam is silent.
    assert.deepEqual(
      f.mail.messages.map((m) => m.to),
      reason === 'unauthenticated' ? ['ada@example.com'] : []
    );
    if (reason === 'spam-or-virus')
      assert.equal(
        f.objects.calls.some((c) => c.operation === 'get'),
        false
      );
  });
for (const raw of [
  'From: forged@example.com\r\n\r\nwords',
  'From: ada@example.com\r\nFrom: other@example.com\r\n\r\nwords',
  'From: ada@example.com, other@example.com\r\n\r\nwords'
])
  test('inbound raw one-From proof rejects mismatch/duplicates', async () => {
    const f = await replyFixture(raw);
    await inbound.process(ses(), f.services);
    assert.equal(f.logs.find((l) => l.event === 'inbound')?.reason, 'from-mismatch');
    assert.deepEqual(
      f.mail.messages.map((m) => m.to),
      ['ada@example.com']
    );
    assert.match(String((await mailLog(f))[0]!.sender), /example\.com/);
  });
for (const header of [
  'Auto-Submitted: auto-replied',
  'X-Autoreply: yes',
  'X-Autorespond: yes',
  'Precedence: bulk',
  'Precedence: junk'
])
  test(`automatic reply ignored: ${header}`, async () => {
    const f = await replyFixture('From: ada@example.com\r\n' + header + '\r\n\r\nwords');
    await inbound.process(ses(), f.services);
    assert.equal(f.logs.at(-1)?.reason, 'auto-reply');
  });
test('DKIM fallback only uses first SES header, aligned domain, explicit GRAY; forged local parts do not align', async () => {
  const okay = await parseHeaders(
      Buffer.from(
        'From: ada@example.com\r\nAuthentication-Results: amazonses.com; dkim=pass (nested(comment)) header.d=mail.example.com\r\n\r\n'
      )
    ),
    receipt = { dmarcVerdict: { status: 'GRAY' }, dkimVerdict: { status: 'PASS' } };
  assert.equal(inbound.authenticated(receipt, okay, 'ada@example.com'), true);
  const forged = await parseHeaders(
    Buffer.from(
      'From: ada@example.com\r\nAuthentication-Results: amazonses.com; dkim=pass header.i=example.com@evil.invalid\r\nAuthentication-Results: amazonses.com; dkim=pass header.d=example.com\r\n\r\n'
    )
  );
  assert.equal(inbound.authenticated(receipt, forged, 'ada@example.com'), false);
  for (const status of ['FAIL', 'PROCESSING_FAILED', undefined])
    assert.equal(
      inbound.authenticated({ dmarcVerdict: { status }, dkimVerdict: { status: 'PASS' } }, okay, 'ada@example.com'),
      false
    );
  assert.deepEqual(
    inbound.dkimDomains(
      'amazonses.com; dkim=pass header.d="example.com"; dkim=pass header.d=evil.invalid header.i=@example.com'
    ),
    ['evil.invalid']
  );
});
test('72-hour boundary accepted, later reply sends one threaded account notice and retains ignored raw mail', async () => {
  const f = await replyFixture();
  const cutoff = now - 2 * 86400 + inbound.REPLY_WINDOW;
  await inbound.process(ses({ date: new Date(cutoff * 1000).toISOString() }), f.services);
  assert.equal((await f.store.dayNotes('u', '2026-10-11')).length, 1);
  const g = await replyFixture();
  const expired = ses({ date: new Date((cutoff + 1) * 1000).toISOString() });
  await inbound.process(expired, g.services);
  await inbound.process(expired, g.services);
  assert.equal(g.mail.messages.length, 1);
  assert.equal(g.mail.messages[0]?.kind, 'account');
  const parsed = await simpleParser(g.mail.messages[0]!.raw);
  assert.equal(parsed.inReplyTo, '<reply@example.com>');
  assert.equal(parsed.headers.get('auto-submitted'), 'auto-replied');
  assert.equal(g.objects.versions.get('raw/synthetic-id')?.at(-1)?.tags.outcome, 'ignored');
  assert.equal((await g.store.allNotes('u')).length, 0);
  assert.ok(!JSON.stringify(g.logs).includes(token));
});
test('expired forged or automatic mail never receives backscatter; stopped account gets no notice', async () => {
  for (const [raw, extra, notices] of [
    // A forged sender is the owner's to know about, never the sender's.
    ['From: forged@example.com\r\n\r\nwords', {}, ['ada@example.com']],
    ['From: ada@example.com\r\nAuto-Submitted: auto-replied\r\n\r\nwords', {}, []],
    ['From: ada@example.com\r\n\r\nwords', { status: 'stopped' }, []]
  ] as const) {
    const f = await replyFixture(raw);
    if (extra.status) await f.store.stop('u', 'bounce', 'now');
    await inbound.process(ses({ date: '2026-10-20T12:00:00Z' }), f.services);
    assert.deepEqual(
      f.mail.messages.map((m) => m.to),
      notices
    );
    for (const m of f.mail.messages) assert.ok(!m.raw.toString().includes('forged@'));
  }
});
test('late notice failure is ignored without retrying inbound or exposing error message', async () => {
  const f = await replyFixture();
  f.mail.fail = true;
  assert.equal(await inbound.process(ses({ date: '2026-10-20T12:00:00Z' }), f.services), 'ignored');
  assert.ok(f.logs.some((l) => l.event === 'late-notice' && l.outcome === 'failed'));
});
test('standing address uses received local day/version and ignores subject; replaced or stopped files nothing', async () => {
  const f = await replyFixture();
  await f.store.setInbox('u', standingToken, 'now');
  const receipt = ses({
    recipient: `${standingToken}@in.example.com`,
    date: '2026-10-14T02:00:00Z',
    subject: 'Ignore this subject'
  });
  assert.equal(await inbound.process(receipt, f.services), 'note');
  const n = (await f.store.dayNotes('u', day))[0]!;
  assert.equal(n.version, String(computeVersion('1972-03-05', day)));
  assert.equal('subject' in n, false);
  assert.equal(f.logs.at(-1)?.via, 'address');
  await f.store.setInbox('u', 'c'.repeat(24), 'later', standingToken);
  assert.equal(await inbound.process(receipt, f.services), 'ignored');
  await f.store.stop('u', 'unsubscribed', 'now');
  const current = ses({ recipient: `${'c'.repeat(24)}@in.example.com` });
  assert.equal(await inbound.process(current, f.services), 'ignored');
  assert.equal(f.mail.messages.length, 0);
});
test('unknown token/recipient, empty body, and authenticated hostile nesting are ignored', async () => {
  const f = await replyFixture('From: ada@example.com\r\n\r\n');
  await inbound.process(ses({ recipient: 'wrong@in.example.com' }), f.services);
  assert.equal(f.logs.at(-1)?.reason, 'no-token');
  await inbound.process(ses({ recipient: `n-${'c'.repeat(24)}@in.example.com` }), f.services);
  assert.equal(f.logs.at(-1)?.reason, 'unknown-token');
  await inbound.process(ses(), f.services);
  assert.equal(f.logs.at(-1)?.reason, 'empty');
  let body = 'words';
  for (let i = 0; i < 70; i++)
    body = `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n${body}\r\n--b${i}--`;
  await f.objects.put('raw/synthetic-id', Buffer.from('From: ada@example.com\r\n' + body), { type: 'message/rfc822' });
  await inbound.process(ses(), f.services);
  assert.equal(f.logs.at(-1)?.reason, 'unparseable');
});
test('unsupported attachments still file raw-only notes; refused media remains listed', async () => {
  const raw =
      'From: ada@example.com\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/zip\r\nContent-Disposition: attachment; filename=p.zip\r\n\r\nPK-test\r\n--b\r\nContent-Type: image/jpeg\r\nContent-Disposition: attachment; filename=bad.jpg\r\n\r\nnot an image\r\n--b--',
    f = await replyFixture(raw);
  await inbound.process(ses(), f.services);
  const n = (await f.store.dayNotes('u', '2026-10-11'))[0]!;
  assert.equal(n.text, '');
  assert.equal((n.attachments as Item[]).length, 2);
  assert.equal((n.attachments as Item[])[1]?.refused, true);
  assert.equal(n.media, undefined);
});
test('a PDF attached to a reply is kept on its note, with its name, like a web upload', async () => {
  const raw =
      'From: ada@example.com\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nThe menu\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=menu.pdf\r\n\r\n%PDF-test\r\n--b--',
    f = await replyFixture(raw);
  await inbound.process(ses(), f.services);
  const n = (await f.store.dayNotes('u', '2026-10-11'))[0]!;
  assert.equal(n.text, 'The menu');
  assert.deepEqual(n.media, [
    {
      n: 1,
      kind: 'file',
      type: 'application/pdf',
      size: 9,
      key: 'media/u/2026-10-11/synthetic-id/1.pdf',
      name: 'menu.pdf'
    }
  ]);
  assert.equal(media.others(n as never), 0);
});
test('media storage failure retries before note commit, stable copies produce one kept note', async () => {
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1200)]).toString('base64'),
    raw = `From: ada@example.com\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename=memo.mp3\r\nContent-Transfer-Encoding: base64\r\n\r\n${audio}`,
    f = await replyFixture(raw),
    put = f.objects.put.bind(f.objects);
  f.objects.put = async () => {
    throw new Error('copy failed');
  };
  await assert.rejects(() => inbound.process(ses(), f.services), /copy failed/);
  assert.equal((await f.store.allNotes('u')).length, 0);
  f.objects.put = put;
  await inbound.process(ses(), f.services);
  await inbound.process(ses(), f.services);
  const n = (await f.store.allNotes('u'))[0]!;
  assert.equal((n.media as Item[])[0]?.key, 'media/u/2026-10-11/synthetic-id/1.mp3');
  assert.equal((await f.store.allNotes('u')).length, 1);
});
const mailLog = async (f: { store: FakeStore }) => (await f.store.activityAll('u')).filter((r) => r.kind === 'mail');
function message(id: string, opts: Parameters<typeof ses>[0] = {}) {
  const e = ses(opts);
  return { ...e, mail: { ...e.mail, messageId: id } };
}
test('activity: a filed reply is one mail row with its day and no words, kept for good; a retry keeps it one row', async () => {
  const f = await replyFixture();
  await inbound.process(ses(), f.services);
  await inbound.process(ses(), f.services);
  const rows = await mailLog(f);
  assert.equal(rows.length, 1);
  const r = rows[0]!;
  assert.equal(r.sk, 'ACTIVITY#2026-10-13T12:00:00.000Z#mail#synthetic-id');
  assert.deepEqual([r.kind, r.at, r.message], ['mail', '2026-10-13T12:00:00.000Z', 'synthetic-id']);
  assert.deepEqual(
    [r.outcome, r.day, r.version, r.via, r.subject],
    ['filed', '2026-10-11', '5.4.220', 'reply', 'Re: today']
  );
  for (const k of ['text', 'reason', 'sender', 'notified_at', 'expires_at']) assert.ok(!(k in r), k);
  assert.equal(f.mail.messages.length, 0);
});
test('activity: a filed reply adds a row for each badge it earned, once, never with "Show badges" off', async () => {
  const f = await replyFixture();
  await inbound.process(ses(), f.services);
  await inbound.process(ses(), f.services);
  const rows = (await f.store.activityAll('u')).filter((r) => r.kind === 'badge.earned');
  // The first note, a reply, a hashtag, and a note for a day already past.
  assert.deepEqual(
    rows.map((r) => r.key),
    ['tag', 'hotfix', 'hello', 'commit', 'ack']
  );
  for (const r of rows)
    assert.deepEqual([r.via, r.day, r.note, r.at], ['email', '2026-10-11', 'synthetic-id', '2026-10-13T12:00:00.000Z']);
  // Not marked seen: the next email tells of it.
  assert.deepEqual(await f.store.seenBadges('u'), new Set());
  const off = await replyFixture();
  await off.store.updateProfile('u', { badges: false });
  await inbound.process(ses(), off.services);
  assert.deepEqual(
    (await off.store.activityAll('u')).map((r) => r.kind),
    ['mail']
  );
  // A failed badge read files the note all the same.
  const failed = await replyFixture();
  failed.store.pauses = async () => {
    throw Object.assign(new Error('private'), { name: 'ProvisionedThroughputExceededException' });
  };
  assert.equal(await inbound.process(ses(), failed.services), 'note');
  assert.deepEqual(
    failed.logs.filter((l) => l.event === 'badges-error'),
    [{ event: 'badges-error', user: 'u', date: '2026-10-11', error: 'ProvisionedThroughputExceededException' }]
  );
  assert.deepEqual(
    (await failed.store.activityAll('u')).map((r) => r.kind),
    ['mail']
  );
});
test('activity: a reply whose file fails to tag once filed keeps its badges through the retry', async () => {
  const audio = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(1200)]).toString('base64'),
    raw = `From: ada@example.com\r\nContent-Type: audio/mpeg\r\nContent-Disposition: attachment; filename=memo.mp3\r\nContent-Transfer-Encoding: base64\r\n\r\n${audio}`,
    earned = async (f: { store: FakeStore }) =>
      (await f.store.activityAll('u')).filter((r) => r.kind === 'badge.earned').map((r) => r.key);
  const clean = await replyFixture(raw);
  await inbound.process(ses(), clean.services);
  const want = await earned(clean);
  assert.ok(want.includes('hello'));
  const f = await replyFixture(raw),
    tag = f.objects.tag.bind(f.objects);
  f.objects.tag = async (key, tags) => {
    if (key.startsWith('media/')) throw new Error('tag failed');
    return tag(key, tags);
  };
  await assert.rejects(() => inbound.process(ses(), f.services), /tag failed/);
  assert.equal((await f.store.allNotes('u')).length, 1);
  f.objects.tag = tag;
  await inbound.process(ses(), f.services);
  assert.deepEqual(await earned(f), want);
});
test('mail log: another sender shows who, never the words, and the owner hears once', async () => {
  const f = await replyFixture(),
    other = ses({ from: 'Someone <someone@example.net>' });
  await inbound.process(other, f.services);
  await inbound.process(other, f.services);
  assert.equal(
    f.objects.calls.some((c) => c.operation === 'get'),
    false
  );
  const [r] = await mailLog(f);
  assert.deepEqual([r!.outcome, r!.reason, r!.sender], ['not-filed', 'from-mismatch', 'someone@example.net']);
  assert.ok(!('text' in r!));
  assert.ok(r!.notified_at);
  assert.equal(f.mail.messages.length, 1);
  assert.equal(f.mail.messages[0]!.to, 'ada@example.com');
  const parsed = await simpleParser(f.mail.messages[0]!.raw);
  assert.equal(parsed.subject, "An email wasn't added to your notes");
  assert.equal(parsed.headers.get('auto-submitted'), 'auto-generated');
  assert.match(parsed.text!, /takes email only from ada@example\.com/);
  assert.match(parsed.text!, /https:\/\/notes\.yourversionnumber\.com\/activity\//);
  assert.ok(!f.mail.messages[0]!.raw.toString().includes('someone@'));
  assert.ok(!JSON.stringify(f.logs).includes('someone@'));
});
test('mail notices cap at three a day; a stopped subscriber gets none', async () => {
  const f = await replyFixture();
  for (let i = 0; i < 5; i++) {
    await f.objects.put(`raw/m${i}`, Buffer.from('From: x@example.net\r\n\r\nwords'), { type: 'message/rfc822' });
    await inbound.process(message(`m${i}`, { from: 'x@example.net' }), f.services);
  }
  assert.equal(f.mail.messages.length, 3);
  assert.equal((await mailLog(f)).length, 5);
  assert.ok(f.logs.some((l) => l.event === 'mail-notice' && l.why === 'limited'));
  const g = await replyFixture();
  await g.store.stop('u', 'bounce', 'now');
  await inbound.process(ses({ from: 'x@example.net' }), g.services);
  assert.equal(g.mail.messages.length, 0);
  assert.equal((await mailLog(g)).length, 1);
});
test("mail log keeps a late reply's words for its owner; spam has no words and no notice", async () => {
  const f = await replyFixture();
  await inbound.process(ses({ date: '2026-10-20T12:00:00Z' }), f.services);
  const [late] = await mailLog(f);
  assert.deepEqual([late!.reason, late!.day, late!.text], ['expired', '2026-10-11', 'I made a little thing. #made']);
  assert.equal(f.mail.messages.length, 1, 'the late notice alone');
  const g = await replyFixture();
  await inbound.process(ses({ verdict: { spamVerdict: { status: 'FAIL' } } }), g.services);
  const [spam] = await mailLog(g);
  assert.equal(spam!.reason, 'spam-or-virus');
  assert.ok(!('text' in spam!));
  assert.equal(g.mail.messages.length, 0);
});
test('a reply that keeps failing is a failed row; the last try tells the owner once; a later success files it', async () => {
  const f = await replyFixture(),
    put = f.store.putInboundNote.bind(f.store);
  f.store.putInboundNote = async () => {
    throw new Error('table unavailable');
  };
  for (let i = 0; i < inbound.ATTEMPTS; i++)
    await assert.rejects(() => inbound.process(ses(), f.services), /table unavailable/);
  let [r] = await mailLog(f);
  assert.deepEqual(
    [r!.outcome, r!.reason, r!.attempts, r!.text],
    ['failed', 'failed', 3, 'I made a little thing. #made']
  );
  assert.equal(f.mail.messages.length, 1);
  assert.match((await simpleParser(f.mail.messages[0]!.raw)).text!, /three tries.*\n\nIts words are kept/s);
  await assert.rejects(() => inbound.process(ses(), f.services));
  assert.equal(f.mail.messages.length, 1);
  f.store.putInboundNote = put;
  assert.equal(await inbound.process(ses(), f.services), 'note');
  [r] = await mailLog(f);
  assert.equal(r!.outcome, 'filed');
  for (const k of ['reason', 'text']) assert.ok(!(k in r!), k);
  assert.ok(!JSON.stringify(f.logs).includes('little thing'));
});
test('a mail row needs a live account and a mail activity key', async () => {
  const f = setup(),
    sk = 'ACTIVITY#2026-10-13T12:00:00.000Z#mail#x';
  await f.store.deleteKeys([{ pk: 'USER#u', sk: 'PROFILE' }]);
  assert.equal(await f.store.recordMail('u', sk, { outcome: 'filed' }), false);
  assert.equal(await f.store.mailEntry('u', sk), null);
  for (const wrong of ['NOTE#x', 'MAILLOG#x', 'ACTIVITY#2026-10-13T12:00:00.000Z#note.added#x'])
    await assert.rejects(() => f.store.recordMail('u', wrong, {}), RangeError);
});
/** Lambda's failure record for an SES event inbound gave up on, as the
 * inbound failed queue holds it. */
function gaveUpRecord(event = ses(), tries = 3) {
  return JSON.stringify({
    version: '1.0',
    timestamp: '2026-10-13T12:05:00.000Z',
    requestContext: {
      requestId: 'r',
      functionArn: 'f:live',
      condition: 'RetriesExhausted',
      approximateInvokeCount: tries
    },
    requestPayload: { Records: [{ eventSource: 'aws:ses', eventVersion: '1.0', ses: event }] },
    responseContext: { statusCode: 200, executedVersion: '7', functionError: 'Unhandled' },
    responsePayload: { errorType: 'Sandbox.Timedout', errorMessage: 'Task timed out after 60.00 seconds' }
  });
}
function forwarding(f: Awaited<ReturnType<typeof replyFixture>>) {
  const forwarded: string[] = [];
  return { forwarded, services: { ...f.services, forward: async (body: string) => void forwarded.push(body) } };
}
test('a reply that timed out on every try gets its failed row and one notice from the failure record, then goes on', async () => {
  const f = await replyFixture(),
    { forwarded, services } = forwarding(f),
    body = gaveUpRecord();
  await inbound.handler({ Records: [{ body }] }, null, services);
  const [r] = await mailLog(f);
  assert.deepEqual(
    [r!.outcome, r!.reason, r!.attempts, r!.day, r!.via, r!.subject],
    ['failed', 'failed', 3, '2026-10-11', 'reply', 'Re: today']
  );
  assert.ok(!('text' in r!));
  assert.equal(f.mail.messages.length, 1);
  const text = (await simpleParser(f.mail.messages[0]!.raw)).text!;
  assert.match(text, /three tries/);
  assert.doesNotMatch(text, /Its words are kept/);
  assert.deepEqual(forwarded, [body]);
  // Read twice from the queue: still one row, one notice, handed on again.
  await inbound.handler({ Records: [{ body }] }, null, services);
  assert.equal((await mailLog(f)).length, 1);
  assert.equal(f.mail.messages.length, 1);
  assert.deepEqual(forwarded, [body, body]);
  assert.ok(!JSON.stringify(f.logs).match(/ada@|Re: today|little thing/));
});
test('a failure record after caught failures, or for a message since filed, changes nothing and sends nothing more', async () => {
  const f = await replyFixture(),
    { forwarded, services } = forwarding(f),
    put = f.store.putInboundNote.bind(f.store);
  f.store.putInboundNote = async () => {
    throw new Error('table unavailable');
  };
  for (let i = 0; i < inbound.ATTEMPTS; i++)
    await assert.rejects(() => inbound.process(ses(), services), /table unavailable/);
  const [caught] = await mailLog(f);
  await inbound.handler({ Records: [{ body: gaveUpRecord() }] }, null, services);
  assert.deepEqual(await mailLog(f), [caught]);
  assert.equal(caught!.text, 'I made a little thing. #made');
  assert.equal(f.mail.messages.length, 1);
  // Filed on a replay: a late record leaves it filed.
  f.store.putInboundNote = put;
  assert.equal(await inbound.process(ses(), services), 'note');
  await inbound.handler({ Records: [{ body: gaveUpRecord() }] }, null, services);
  assert.equal((await mailLog(f))[0]!.outcome, 'filed');
  assert.equal(f.mail.messages.length, 1);
  assert.equal(forwarded.length, 2);
});
test('a failure record whose row cannot be written stays on the queue, and the next read logs it', async () => {
  const f = await replyFixture(),
    { forwarded, services } = forwarding(f),
    record = f.store.recordMail.bind(f.store),
    body = gaveUpRecord();
  f.store.recordMail = async () => {
    throw Object.assign(new Error('private'), { name: 'ProvisionedThroughputExceededException' });
  };
  await assert.rejects(() => inbound.handler({ Records: [{ body }] }, null, services));
  assert.deepEqual(forwarded, []);
  assert.deepEqual(await mailLog(f), []);
  assert.equal(f.mail.messages.length, 0);
  assert.ok(f.logs.some((l) => l.event === 'mail-log' && l.error === 'ProvisionedThroughputExceededException'));
  f.store.recordMail = record;
  await inbound.handler({ Records: [{ body }] }, null, services);
  assert.deepEqual(
    (await mailLog(f)).map((r) => [r.outcome, r.attempts]),
    [['failed', 3]]
  );
  assert.equal(f.mail.messages.length, 1);
  assert.deepEqual(forwarded, [body]);
});
test('a failure record for no one, a stopped owner or no record at all is still handed on; without a queue it stays', async () => {
  const f = await replyFixture(),
    { forwarded, services } = forwarding(f),
    stranger = gaveUpRecord(ses({ recipient: `n-${'c'.repeat(24)}@in.example.com` }));
  await inbound.handler({ Records: [{ body: stranger }, { body: 'not json' }] }, null, services);
  assert.deepEqual(forwarded, [stranger, 'not json']);
  assert.deepEqual(await mailLog(f), []);
  await f.store.stop('u', 'bounce', 'now');
  await inbound.handler({ Records: [{ body: gaveUpRecord(ses(), 5) }] }, null, services);
  const [r] = await mailLog(f);
  assert.deepEqual([r!.outcome, r!.attempts], ['failed', 5]);
  assert.equal(f.mail.messages.length, 0);
  await assert.rejects(
    () => inbound.handler({ Records: [{ body: gaveUpRecord() }] }, null, f.services),
    /failed queue/
  );
});
test('notices say when and why; ATTEMPTS is the inbound alias retries plus one, ending in the failed queue', async () => {
  for (const reason of ['from-mismatch', 'unauthenticated', 'unparseable', 'failed'] as const) {
    const text = noticeText({
      to: 'ada@example.com',
      reason,
      received: '2026-10-13T19:05:00Z',
      tz: 'America/Chicago',
      kept: false
    });
    assert.match(text, /^An email to your Release Notes address on Tuesday, October 13 at 2:05/);
    assert.match(text, /\/activity\/\n$/);
  }
  const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8'),
    config = /\n {2}InboundAliasInvokeConfig:\n([\s\S]*?)\n\n/.exec(template)![1]!;
  assert.match(config, /FunctionName: !Ref InboundFunction\n\s+Qualifier: live/);
  assert.equal(Number(/MaximumRetryAttempts: (\d)/.exec(config)![1]) + 1, inbound.ATTEMPTS);
  assert.match(config, /OnFailure:\n\s+Destination: !GetAtt InboundFailedQueue\.Arn/);
  // Inbound reads that queue itself, then on to the failed queue, or there unread.
  const source = /\n {2}InboundFailedSource:\n([\s\S]*?)\n\n/.exec(template)![1]!,
    queue = /\n {2}InboundFailedQueue:\n([\s\S]*?)\n\n/.exec(template)![1]!;
  assert.match(source, /FunctionName: !Ref InboundAlias\n\s+EventSourceArn: !GetAtt InboundFailedQueue\.Arn/);
  assert.match(queue, /deadLetterTargetArn: !GetAtt FailedQueue\.Arn/);
  assert.match(template, /FAILED_QUEUE: !Ref FailedQueue/);
});
test('body and subject truncate by Unicode code point without splitting emoji', async () => {
  const f = await replyFixture(
    'From: ada@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + '🌲'.repeat(20001)
  );
  await inbound.process(ses({ subject: '🌲'.repeat(301) }), f.services);
  const n = (await f.store.allNotes('u'))[0]!;
  assert.equal(Array.from(String(n.text)).length, 20000);
  assert.equal(Array.from(String(n.subject)).length, 300);
});
function bounce(kind = 'Bounce'): Item {
  return {
    eventType: kind,
    mail: {
      headers: [
        { name: 'List-Unsubscribe', value: 'secret token' },
        { name: 'Subject', value: 'secret code' }
      ]
    },
    bounce: {
      bounceType: 'Permanent',
      bounceSubType: 'General',
      bouncedRecipients: [{ emailAddress: 'ada@example.com' }]
    },
    complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'ada@example.com' }] }
  };
}
function sns(msg: Item, id = 'sns-1') {
  return { Records: [{ Sns: { Message: JSON.stringify(msg), MessageId: id } }] };
}
test('SNS concurrent duplicate hard bounce stops/tallies once, retained receipt survives restart', async () => {
  const f = setup(),
    lines: Item[] = [],
    s = {
      ...f.services,
      publish: async (line: Item) => {
        lines.push(line);
      }
    };
  await Promise.all([events.handler(sns(bounce()), null, s), events.handler(sns(bounce()), null, s)]);
  assert.equal((await f.store.profile('u'))?.status, 'stopped');
  assert.equal(f.store.memory.read({ pk: 'TALLY#2026-10', sk: 'TALLY' })?.bounces, 1);
  await f.store.updateProfile('u', { status: 'active' });
  await events.handler(sns(bounce()), null, s);
  assert.equal((await f.store.profile('u'))?.status, 'active');
  // One activity row for the stop, by its reason; nothing of the notification.
  const stops = await f.store.activityAll('u');
  assert.deepEqual(
    stops.map((r) => [r.kind, r.via, r.reason]),
    [['status.stopped', 'email', 'bounce']]
  );
  assert.deepEqual(Object.keys(stops[0]!).sort(), ['at', 'kind', 'pk', 'reason', 'sk', 'via']);
  const receipt = f.store.memory.all().find((i) => String(i.sk).startsWith('MAILEVENT#'))!;
  assert.equal(receipt.pk, 'USER#u');
  assert.equal(receipt.expires_at, now + 30 * 86400);
  assert.deepEqual(Object.keys(receipt).sort(), ['expires_at', 'pk', 'sk']);
  assert.ok(!JSON.stringify(lines).includes('ada@'));
  assert.ok(!JSON.stringify(lines).includes('secret'));
});
test('complaints stop; transient bounce and routine delay do not; unknown mail yields scrubbed line', async () => {
  const f = setup(),
    lines: Item[] = [],
    s = {
      ...f.services,
      publish: async (line: Item) => {
        lines.push(line);
      }
    };
  await events.handler(sns({ ...bounce(), bounce: { bounceType: 'Transient' } }, 'soft'), null, s);
  assert.equal((await f.store.profile('u'))?.status, 'active');
  await events.handler(sns(bounce('DeliveryDelay'), 'delay'), null, s);
  assert.equal(lines.length, 1);
  await events.handler(sns(bounce('Complaint'), 'complaint'), null, s);
  assert.equal((await f.store.profile('u'))?.stopped_reason, 'complaint');
  assert.equal(f.store.memory.read({ pk: 'TALLY#2026-10', sk: 'TALLY' })?.complaints, 1);
  assert.deepEqual(
    (await f.store.activityAll('u')).map((r) => [r.kind, r.reason]),
    [['status.stopped', 'complaint']]
  );
  assert.deepEqual(events.notice({ eventType: 'Reject', reject: { reason: 'ada@example.com subject secret' } }, []), {
    source: 'yvn-release-notes',
    event: 'Reject',
    mail: 'account',
    reason: null
  });
});
test('SNS failure retries safely, missing message ID refuses non-deduplicated account mutation', async () => {
  const f = setup();
  let publishes = 0;
  const s = {
    ...f.services,
    publish: async () => {
      if (++publishes === 1) throw new Error('publish failed');
    }
  };
  await assert.rejects(() => events.handler(sns(bounce()), null, s));
  await events.handler(sns(bounce()), null, s);
  assert.equal(f.store.memory.read({ pk: 'TALLY#2026-10', sk: 'TALLY' })?.bounces, 1);
  await assert.rejects(
    () => events.handler({ Records: [{ Sns: { Message: JSON.stringify(bounce()) } }] }, null, s),
    /MessageId required/
  );
  assert.equal(f.store.memory.read({ pk: 'TALLY#2026-10', sk: 'TALLY' })?.bounces, 1);
});
test('events skip unparseable records and no-account addresses without private logging', async () => {
  const f = setup(),
    lines: Item[] = [],
    s = {
      ...f.services,
      publish: async (line: Item) => {
        lines.push(line);
      }
    };
  await events.handler({ Records: [{ Sns: { Message: 'invalid' } }, {}] }, null, s);
  assert.equal(lines.length, 0);
  await events.handler(
    sns({
      ...bounce(),
      bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'unknown@example.com' }] }
    }),
    null,
    s
  );
  assert.equal(lines[0]?.users instanceof Array, true);
  assert.ok(!JSON.stringify(f.logs).includes('@'));
});

test('the closed release names what a Supporting Member gave to while it ran', async () => {
  const f = setup({ birthday: '1972-10-13', giving: { 2026: { first: '2026-01-06', last: '2026-10-01' } } });
  f.store.seed(note('2026-10-11', 'one'));
  const sub = (await f.store.getSubscriber('u'))!;
  assert.deepEqual((await sender.readClosed(f.services, sub, day, await f.store.noteIndex('u')))!.giving, ['Signal']);
  sub.giving = null;
  assert.ok(!('giving' in (await sender.readClosed(f.services, sub, day, await f.store.noteIndex('u')))!));
});

test('a release with no notes closes with the thank-you when it gave, and quietly when not', async () => {
  const f = setup({ birthday: '1972-10-13', giving: { 2026: { first: '2026-01-06', last: '2026-10-01' } } });
  const sub = (await f.store.getSubscriber('u'))!;
  const closed = (await sender.readClosed(f.services, sub, day, []))!;
  assert.deepEqual([closed.days, closed.notes, closed.photos, closed.giving], [0, 0, 0, ['Signal']]);
  sub.giving = null;
  assert.equal(await sender.readClosed(f.services, sub, day, []), null);
});

test('after the email, a standing that is due is looked at again; a member records the year and its badge', async () => {
  const asked: string[] = [],
    f = setup(),
    weeklyThing = {
      standing: async (email: string) => {
        asked.push(email);
        return 'member' as const;
      },
      subscribe: async () => ({ outcome: 'added' as const })
    };
  let clock = now;
  const services = { ...f.services, weeklyThing, clock: () => clock };
  await sender.handler({}, { getRemainingTimeInMillis: () => 60000 }, services);
  assert.equal(f.mail.messages.length, 1);
  assert.deepEqual(asked, ['ada@example.com'], 'never asked before the gate: due at once');
  const p = (await f.store.profile('u'))!;
  assert.equal(p.weekly_thing, 'member');
  assert.deepEqual(p.giving, { 2026: { first: day, last: day } });
  const rows = (await f.store.activityAll('u')).filter((r) => r.kind === 'badge.earned');
  assert.deepEqual(
    rows.map((r) => [r.badge, r.name, r.via, r.version, r.day ?? null]),
    [['giving-2026', 'Supported Signal', 'weekly-thing', String(computeVersion('1972-03-05', day)), null]]
  );
  assert.ok(!JSON.stringify(f.logs).includes('@'), 'the address is never logged');

  // The next morning tells it once, and does not ask again within nine days.
  clock = now + 86_400;
  await sender.handler({}, { getRemainingTimeInMillis: () => 60000 }, services);
  assert.equal(asked.length, 1);
  assert.ok(String(f.mail.messages[1]!.raw).includes('New badge: Supported Signal'));
});

test('after the email, Jamie’s own plus address is never looked up', async () => {
  const asked: string[] = [],
    f = setup({ email: 'jamie+example@thingelstad.com' }),
    weeklyThing = {
      standing: async (email: string) => {
        asked.push(email);
        return 'none' as const;
      },
      subscribe: async () => ({ outcome: 'added' as const })
    };
  await sender.handler({}, { getRemainingTimeInMillis: () => 60000 }, { ...f.services, weeklyThing });
  assert.equal(f.mail.messages.length, 1);
  assert.deepEqual(asked, []);
  assert.ok(!('weekly_thing' in (await f.store.profile('u'))!));
});

test('a failed giving write after the email leaves the standing due, so the next email asks again', async () => {
  const f = setup(),
    weeklyThing = { standing: async () => 'member' as const, subscribe: async () => ({ outcome: 'added' as const }) };
  f.store.widenGiving = async () => {
    throw Object.assign(new Error('refused'), { name: 'TransactionCanceledException' });
  };
  await sender.handler({}, { getRemainingTimeInMillis: () => 60000 }, { ...f.services, weeklyThing });
  const p = (await f.store.profile('u'))!;
  assert.ok(!('weekly_thing_at' in p) && !('giving' in p));
  assert.ok(f.logs.some((l) => l.event === 'weekly-thing-error' && l.error === 'TransactionCanceledException'));
  assert.equal((await f.store.activityAll('u')).filter((r) => r.kind === 'badge.earned').length, 0);
});

test('a failed standing lookup after the email is logged and changes nothing', async () => {
  const f = setup(),
    weeklyThing = {
      standing: async () => {
        throw new Error('Fictional ada@example.com');
      },
      subscribe: async () => ({ outcome: 'added' as const })
    };
  const result = await sender.handler({}, { getRemainingTimeInMillis: () => 60000 }, { ...f.services, weeklyThing });
  assert.equal((result.results as Item[])[0]!.outcome, 'sent');
  assert.ok(!('weekly_thing' in (await f.store.profile('u'))!));
  assert.ok(f.logs.some((l) => l.event === 'weekly-thing-error'));
  assert.ok(!JSON.stringify(f.logs).includes('@'));
});
