import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simpleParser } from 'mailparser';
import { FakeStore } from '../../packages/testing/store.ts';
import { FakeMail, FakeObjects } from '../../packages/testing/services.ts';
import { handler } from '../../workers/send.ts';
import { body, htmlBody } from '../../packages/mail/compose.ts';
import { computeVersion } from '../../packages/domain/version.ts';
import { UPDATE_LABEL, type ProductUpdate } from '../../packages/domain/product-updates.ts';
import type { Item } from '../../packages/backend/store.ts';
const update: ProductUpdate = {
  id: 'news',
  title: 'Connect an agent <today>',
  text: 'A plain <script> message.\n\nConnect at https://example.com/connect.',
  links: [{ url: 'https://example.com/connect', title: 'Connect an agent', site: 'example.com' }],
  revision: 2,
  status: 'scheduled',
  date: '2026-10-14',
  created_at: '2026-10-13T12:00:00Z',
  updated_at: '2026-10-13T12:00:00Z'
};
function fixture() {
  const store = new FakeStore([
      ...['east', 'west'].map((uid) => ({
        pk: 'USER#' + uid,
        sk: 'PROFILE',
        email: uid + '@example.com',
        birthday: '1981-06-14',
        tz: uid === 'east' ? 'Pacific/Kiritimati' : 'America/Chicago',
        send_time: '06:00',
        status: 'active'
      })),
      { pk: 'PRODUCT#UPDATES', sk: 'DATE#2026-10-14', ...update }
    ]),
    mail = new FakeMail(),
    logs: Item[] = [];
  const services = {
    store,
    mail,
    objects: new FakeObjects(),
    fromAddress: 'notes@example.com',
    inboundDomain: 'in.example.com',
    clock: () => Date.parse('2026-10-13T12:00:00Z') / 1000,
    weatherFetch: async () => ({}),
    log: (f: Item) => logs.push(f)
  };
  return { store, mail, logs, services };
}
test('product update is named, escaped type on paper in HTML and plain text; ordinary email stays unchanged', () => {
  const v = computeVersion('1981-06-14', '2026-10-14');
  const html = htmlBody(v, '1981-06-14', '2026-10-14', { productUpdate: update }),
    text = body(v, '1981-06-14', { productUpdate: update });
  assert.ok(text.includes(UPDATE_LABEL));
  assert.ok(html.includes(UPDATE_LABEL));
  assert.ok(html.indexOf(UPDATE_LABEL) < html.indexOf('Reply any time today.'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Connect an agent</a>'));
  assert.ok(!/src="https?:/.test(html));
  assert.ok(!body(v, '1981-06-14').includes(UPDATE_LABEL));
});
test('scheduled snapshot follows each recipient local day, at most once with no archive/streak writes', async () => {
  const f = fixture();
  await handler({ send_now: 'east' }, null, f.services);
  await handler({ send_now: 'west' }, null, f.services);
  assert.equal(f.mail.messages.length, 2);
  const east = await simpleParser(f.mail.messages[0]!.raw),
    west = await simpleParser(f.mail.messages[1]!.raw);
  assert.ok(east.text?.includes(UPDATE_LABEL));
  assert.ok(!west.text?.includes(UPDATE_LABEL));
  assert.ok(east.html && east.html.includes(UPDATE_LABEL));
  await handler({ send_now: 'east' }, null, f.services);
  assert.equal(f.mail.messages.length, 2);
  assert.equal((await f.store.noteDays('east')).size, 0);
  assert.ok(!JSON.stringify(f.logs).includes(update.text));
  f.services.clock = () => Date.parse('2026-10-15T12:00:00Z') / 1000;
  await handler({ send_now: 'west' }, null, f.services);
  assert.ok(!(await simpleParser(f.mail.messages[2]!.raw)).text?.includes(UPDATE_LABEL));
});
test('dry run reports update id without content, mail or writes; optional read failure still sends safely', async () => {
  const f = fixture(),
    before = f.store.memory.all();
  const r = await handler({ dry_run: true, send_now: 'east' }, null, f.services);
  assert.equal((r.results as Item[])[0]!.product_update, update.id);
  assert.deepEqual(f.store.memory.all(), before);
  assert.equal(f.mail.messages.length, 0);
  assert.ok(!JSON.stringify(r).includes(update.text));
  f.store.scheduledProductUpdate = async () => {
    throw new Error('private ada@example.com');
  };
  await handler({ send_now: 'east' }, null, f.services);
  assert.equal(f.mail.messages.length, 1);
  assert.ok(f.logs.some((l) => l.event === 'product-update-error'));
  assert.ok(!JSON.stringify(f.logs).includes('@'));
});
