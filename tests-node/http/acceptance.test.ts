/** Socket-level acceptance. Only fictional in-memory services are used;
 * subprocesses never construct AWS clients or touch live data. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
const cwd = fileURLToPath(new URL('../../', import.meta.url));
async function freePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function waitMessage(child: ChildProcess, value: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Subprocess message timeout')), 5000);
    const listener = (message: unknown) => {
      if (message === value) {
        clearTimeout(timer);
        child.off('message', listener);
        resolve();
      }
    };
    child.on('message', listener);
    child.once('error', reject);
  });
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    await done;
  }
}
test(
  'local harness: 128 parallel reads and controlled owner writes retain isolation and content-free logs',
  { timeout: 20000 },
  async (t) => {
    const port = await freePort(),
      origin = `http://localhost:${port}`,
      child = spawn(
        process.execPath,
        ['--import', 'tsx', 'tools/dev-server.ts', '--port', String(port), '--fake-places', '--fake-links'],
        { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    let logs = '';
    child.stdout!.on('data', (b) => {
      logs += String(b);
    });
    child.stderr!.on('data', (b) => {
      logs += String(b);
    });
    t.after(() => stop(child));
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(origin + '/dev-runtime/');
        ready = (await r.json()).runtime === 'node24-hono';
        if (ready) break;
      } catch {}
      await delay(20);
    }
    assert.equal(ready, true);
    async function request(method: string, path: string, cookie = '', body?: unknown) {
      const r = await fetch(origin + path, {
        method,
        headers: { origin, cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      });
      assert.equal(r.headers.get('cache-control'), 'no-store');
      return r;
    }
    async function signin(email: string) {
      assert.equal((await request('POST', '/api/auth/start', '', { email })).status, 202);
      const mail = await (await fetch(origin + '/dev-mail/?to=' + encodeURIComponent(email))).text(),
        code = /type this code where you asked: ([0-9]{6})/.exec(mail)![1]!;
      const verified = await request('POST', '/api/auth/verify', '', { email, code });
      assert.equal(verified.status, 200);
      const cookie = verified.headers.get('set-cookie')!;
      assert.match(cookie, /^__Host-rn=/);
      assert.match(cookie, /Secure; HttpOnly; SameSite=Lax/);
      return cookie.split(';')[0]!;
    }
    const ada = await signin('ada@example.com'),
      bea = await signin('bea@example.com');
    assert.equal(
      (
        await request('PUT', '/api/me', bea, {
          birthday: '1990-02-28',
          send_time: '06:00',
          place: {
            name: 'Paris',
            region: 'Ile-de-France',
            country: 'France',
            tz: 'Europe/Paris',
            lat: 48.85,
            lon: 2.35
          }
        })
      ).status,
      200
    );
    const before = await Promise.all(
      [ada, bea].map(
        async (cookie) => (await (await request('GET', '/api/today', cookie)).json()).notes.length as number
      )
    );
    const created = await Promise.all(
      Array.from({ length: 32 }, async (_, i) => {
        const owner = i % 2;
        const day = (await (await request('GET', '/api/today', [ada, bea][owner]!)).json()).date;
        return request('POST', '/api/days/' + day + '/notes', [ada, bea][owner]!, {
          text: `PRIVATE-FICTIONAL-OWNER-${owner}-${i}`
        });
      })
    );
    assert.ok(created.every((r) => r.status === 201));
    await Promise.all(created.map((r) => r.arrayBuffer()));
    const started = performance.now(),
      read = await Promise.all(
        Array.from({ length: 128 }, async (_, i) => {
          const owner = i % 2,
            r = await request('GET', '/api/today', [ada, bea][owner]!),
            b = await r.json();
          assert.equal(r.status, 200);
          assert.equal(b.notes.length, before[owner]! + 16);
          assert.ok(
            b.notes
              .filter((n: { text: string }) => n.text.startsWith('PRIVATE-FICTIONAL'))
              .every((n: { text: string }) => n.text.startsWith('PRIVATE-FICTIONAL-OWNER-' + owner))
          );
          return r.status;
        })
      );
    assert.equal(read.length, 128);
    t.diagnostic(
      `128 concurrent local HTTP owner reads completed in ${Math.round(performance.now() - started)}ms; not an AWS capacity or cost benchmark.`
    );
    const bearerOnly = await fetch(origin + '/api/me', { headers: { authorization: 'Bearer ' + ada.split('=')[1] } });
    assert.equal(bearerOnly.status, 401);
    await bearerOnly.arrayBuffer();
    const unknown = await request('GET', '/api/PRIVATE-FICTIONAL-PATH?secret=PRIVATE-FICTIONAL-QUERY');
    assert.equal(unknown.status, 404);
    await unknown.arrayBuffer();
    await stop(child);
    assert.ok(!logs.includes('PRIVATE-FICTIONAL'));
    assert.ok(!logs.includes('ada@example.com'));
    assert.ok(!logs.includes('bea@example.com'));
    assert.ok(!logs.includes(ada.split('=')[1]!));
  }
);
for (const deadline of [false, true])
  test(
    deadline
      ? 'SIGTERM bounds hung requests and closes sockets'
      : 'SIGTERM stops accepting and drains active requests despite repeated signals',
    { timeout: 10000 },
    async (t) => {
      const port = await freePort(),
        origin = `http://127.0.0.1:${port}`,
        source = `import {Hono} from 'hono';import {listen} from './server/shared/listen.ts';const app=new Hono();app.get('/active',async c=>{process.send('active');${deadline ? 'await new Promise(()=>{});' : 'await new Promise(r=>setTimeout(r,200));'}return c.json({complete:true})});const server=listen(app,'127.0.0.1:${port}',{graceMs:${deadline ? 100 : 3000},log:fields=>process.send(fields.outcome)});server.on('listening',()=>process.send('ready'));`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      });
      t.after(() => stop(child));
      await waitMessage(child, 'ready');
      const active = waitMessage(child, 'active'),
        result = fetch(origin + '/active').then(async (r) => ({ status: r.status, body: await r.json() }));
      const observed = result.catch(() => null);
      await active;
      const outcome = waitMessage(child, deadline ? 'deadline' : 'drained');
      const done = once(child, 'exit');
      child.kill('SIGTERM');
      await delay(20);
      child.kill('SIGTERM');
      await outcome;
      assert.deepEqual(await done, [0, null]);
      if (deadline) assert.equal(await observed, null);
      else assert.deepEqual(await observed, { status: 200, body: { complete: true } });
      await assert.rejects(fetch(origin + '/active'));
    }
  );
