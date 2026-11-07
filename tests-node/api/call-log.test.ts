/** One log line a /v1 or MCP call, counts only: route or tool, outcome and the
 * client's product or agent family; never a path, an id, an account or words. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpApp, type McpOptions } from '../../server/mcp/app.ts';
import { captureNote } from '../../workers/capture.ts';
import { Tokens } from '../../packages/backend/tokens.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { agentFamily } from '../../packages/domain/clients.ts';
import { FakeObjects } from '../../packages/testing/services.ts';
import { fixture, connected, ORIGIN } from '../oauth/fixtures.ts';

function setup() {
  const logs: OAuthRow[] = [],
    ctx = { ...fixture(), objects: new FakeObjects() },
    options: McpOptions = {
      context: () => ctx,
      capture: (e) => captureNote(e, ctx, { fetchTitle: () => null, log: () => {} }),
      log: (f) => logs.push(f)
    };
  return { ctx, logs, app: createMcpApp(options) };
}

test('each /v1 call logs its route template, name, status and client product', async () => {
  const { ctx, logs, app } = setup(),
    made = (await new Tokens({ store: ctx.store, origin: ctx.origin, now: ctx.now }).make('u', {
      name: 'Private token name',
      scopes: ['notes:write', 'activity'],
      expiry: 'never'
    })) as OAuthRow & { token: string };
  const headers = { authorization: 'Bearer ' + made.token, 'user-agent': 'Changelog/0.0.8 (iOS 27.2)' };
  assert.equal((await app.request(ORIGIN + '/v1/me', { headers })).status, 200);
  await app.request(ORIGIN + '/v1/days/2026-10-07', { headers });
  await app.request(ORIGIN + '/v1/nothing-here/secret-path', { headers: { 'user-agent': 'Mozilla/5.0 (X)' } });
  await app.request(ORIGIN + '/v1/me', { headers: {} });
  const lines = logs.filter((l) => l.event === 'v1');
  assert.deepEqual(lines[0], {
    event: 'v1',
    method: 'GET',
    route: '/v1/me',
    name: 'me',
    status: 200,
    client: 'Changelog'
  });
  assert.equal(lines[1]!.route, '/v1/days/{date}');
  assert.equal(lines[1]!.name, 'day');
  assert.deepEqual(
    [lines[2]!.route, lines[2]!.name, lines[2]!.status, lines[2]!.client],
    ['unmatched', 'unmatched', 404, 'Mozilla']
  );
  assert.deepEqual([lines[3]!.status, lines[3]!.client], [401, 'unknown']);
  const encoded = JSON.stringify(lines);
  for (const secret of [made.token, 'Private token name', 'secret-path', '2026-10-07', '"u"', 'USER#'])
    assert.ok(!encoded.includes(secret), secret);
});

test('each MCP tool call logs the tool, what it came to and the agent family', async () => {
  const { ctx, logs, app } = setup(),
    a = await connected(ctx);
  const call = (name: string, args: OAuthRow = {}) =>
    app.request(ORIGIN + '/mcp', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
  await call('notes_context');
  await call('no_such_tool');
  await call('notes_get_note', { id: 'private-id-that-is-missing' });
  const lines = logs.filter((l) => l.event === 'mcp-call');
  assert.deepEqual(lines[0], { event: 'mcp-call', tool: 'notes_context', outcome: 'ok', client: 'other' });
  assert.deepEqual([lines[1]!.tool, lines[1]!.outcome], ['unknown', 'unknown_tool']);
  assert.equal(lines[2]!.tool, 'notes_get_note');
  assert.notEqual(lines[2]!.outcome, 'ok');
  assert.ok(!JSON.stringify(lines).includes('private-id-that-is-missing'));
  assert.ok(!JSON.stringify(lines).includes('no_such_tool'));
});

test('agent families come from the registered name and say nothing else', () => {
  assert.equal(agentFamily('Claude'), 'claude');
  assert.equal(agentFamily('claude.ai'), 'claude');
  assert.equal(agentFamily('ChatGPT'), 'chatgpt');
  assert.equal(agentFamily('OpenAI Connectors'), 'chatgpt');
  assert.equal(agentFamily('Codex'), 'codex');
  assert.equal(agentFamily('My own script'), 'other');
  assert.equal(agentFamily(undefined), 'other');
});

test('a tool that ran but could not be recorded logs the answer the agent got', async () => {
  const { ctx, logs, app } = setup(),
    a = await connected(ctx),
    commit = ctx.store.mcpCommit.bind(ctx.store);
  // The tool answers; recording its call in the connection's log then fails.
  ctx.store.mcpCommit = async (changes, uid) => {
    if (changes.some(([row]) => String(row.sk).startsWith('LOG#'))) throw new Error('storage down');
    return commit(changes, uid);
  };
  const response = await app.request(ORIGIN + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + a.token, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notes_context' } })
  });
  assert.ok(JSON.stringify(await response.json()).includes('temporarily_unavailable'));
  assert.deepEqual(
    logs.filter((l) => l.event === 'mcp-call'),
    [{ event: 'mcp-call', tool: 'notes_context', outcome: 'unavailable', client: 'other' }]
  );
});
