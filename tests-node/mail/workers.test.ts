import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeObjects, FakeMail } from '../../packages/testing/services.ts';
import { Subscriber, type Item } from '../../packages/backend/store.ts';
import * as sender from '../../workers/send.ts';
import * as inbound from '../../workers/inbound.ts';
import * as events from '../../workers/events.ts';
import { parseHeaders } from '../../packages/mail/parse.ts';
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
  assert.equal(y!.places.length, 2);
  assert.equal(y!.places[1]?.[1], null);
});
test('on birthday closed release counts imported notes, paused gaps and photos', async () => {
  const f = setup({ birthday: '1972-10-13' });
  f.store.seed(note('2026-10-09', 'one', '', { source: 'dayone', media: [{ kind: 'image' }] }));
  f.store.seed(note('2026-10-11', 'two'));
  f.store.seed(note('2026-10-11', 'three'));
  await f.store.putPause('u', '2026-10-10', '2026-10-10', 'now');
  const sub = (await f.store.getSubscriber('u'))!,
    closed = await sender.readClosed(f.services, sub, day, await f.store.noteIndex('u'));
  assert.deepEqual(closed, { age: 53, days: 2, notes: 3, photos: 1, longest: 2 });
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
    assert.equal(f.logs.at(-1)?.reason, reason);
    assert.equal(f.mail.messages.length, 0);
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
    assert.equal(f.logs.at(-1)?.reason, 'from-mismatch');
    assert.equal(f.mail.messages.length, 0);
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
  for (const [raw, extra] of [
    ['From: forged@example.com\r\n\r\nwords', {}],
    ['From: ada@example.com\r\nAuto-Submitted: auto-replied\r\n\r\nwords', {}],
    ['From: ada@example.com\r\n\r\nwords', { status: 'stopped' }]
  ] as const) {
    const f = await replyFixture(raw);
    if (extra.status) await f.store.stop('u', 'bounce', 'now');
    await inbound.process(ses({ date: '2026-10-20T12:00:00Z' }), f.services);
    assert.equal(f.mail.messages.length, 0);
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
      'From: ada@example.com\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename=p.pdf\r\n\r\n%PDF-test\r\n--b\r\nContent-Type: image/jpeg\r\nContent-Disposition: attachment; filename=bad.jpg\r\n\r\nnot an image\r\n--b--',
    f = await replyFixture(raw);
  await inbound.process(ses(), f.services);
  const n = (await f.store.dayNotes('u', '2026-10-11'))[0]!;
  assert.equal(n.text, '');
  assert.equal((n.attachments as Item[]).length, 2);
  assert.equal((n.attachments as Item[])[1]?.refused, true);
  assert.equal(n.media, undefined);
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
