/** The capture function's role allows every DynamoDB request its write tools
 * make. The fakes accept any request, so a missing grant (Query, for Upcoming
 * writes, 2026-10-17) only showed up live, as `temporarily_unavailable`. Each
 * tool runs against the fake table and every recorded request is held to the
 * role's statements in infra/template.yaml, action and partition key alike. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { captureNote } from '../../workers/capture.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { fixture, connected } from '../oauth/fixtures.ts';

const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const role = template.slice(template.indexOf('\n  CaptureRole:'), template.indexOf('\n  CaptureFunction:'));
const grants = [...role.matchAll(/- Effect: Allow\n\s+Action: \[([^\]]+)\]\n[\s\S]*?LeadingKeys: \[([^\]]+)\]/g)].map(
  (m) => ({
    actions: m[1]!.split(',').map((a) => a.trim()),
    keys: m[2]!.split(',').map((k) => k.trim().replace(/"/g, '').replace(/\*$/, ''))
  })
);
const allowed = (action: string, pk: string) =>
  grants.some((g) => g.actions.includes(`dynamodb:${action}`) && g.keys.some((prefix) => pk.startsWith(prefix)));

const ACTIONS: Record<string, string> = {
  GetCommand: 'GetItem',
  QueryCommand: 'Query',
  PutCommand: 'PutItem',
  UpdateCommand: 'UpdateItem',
  DeleteCommand: 'DeleteItem',
  Put: 'PutItem',
  Update: 'UpdateItem',
  Delete: 'DeleteItem',
  ConditionCheck: 'ConditionCheckItem'
};
type Input = Record<string, unknown>;
const pkOf = (input: Input) =>
  String(
    (input.Key as Input | undefined)?.pk ??
      (input.Item as Input | undefined)?.pk ??
      (input.ExpressionAttributeValues as Input | undefined)?.[':p']
  );
function requests(calls: { name: string; input: Input }[]) {
  return calls.flatMap(({ name, input }) =>
    name === 'TransactWriteCommand'
      ? (input.TransactItems as Input[]).map((op) => {
          const [kind, body] = Object.entries(op)[0]!;
          return { action: ACTIONS[kind]!, pk: pkOf(body as Input) };
        })
      : [{ action: ACTIONS[name] ?? name, pk: pkOf(input) }]
  );
}

test('the capture role grants every DynamoDB request the write tools make', async () => {
  assert.ok(grants.length >= 4);
  const ctx = fixture(),
    a = await connected(ctx, true, true, 'u', true),
    run = (tool: string, args: Input) =>
      captureNote(
        { token: a.token, tool, arguments: args },
        { ...ctx, geocode: async () => [] },
        {
          fetchTitle: () => null
        }
      );
  ctx.store.memory.calls.length = 0;
  const created = await run('notes_create', { date: '2026-10-07', text: 'Dinner', idempotency_key: 'c' });
  const shown = created.note as OAuthRow;
  assert.ok(shown, JSON.stringify(created));
  const appended = await run('notes_append', { date: shown.date, id: shown.id, text: 'Walk', idempotency_key: 'a' });
  assert.ok(appended.note, JSON.stringify(appended));
  const draft = { kind: 'anniversary', title: 'Work', date: '01-06', year: 2020, reminders: [7, 1, 0] };
  const dry = await run('upcoming_save', { entries: [draft], idempotency_key: 'd', dry_run: true });
  assert.equal(dry.dry_run, true, JSON.stringify(dry));
  const saved = await run('upcoming_save', { entries: [draft], idempotency_key: 's' });
  const entry = (saved.saved as OAuthRow[] | undefined)?.[0];
  assert.ok(entry, JSON.stringify(saved));
  const removed = await run('upcoming_delete', {
    entries: [{ id: entry.id, revision: entry.revision }],
    idempotency_key: 'r'
  });
  assert.equal(removed.removed, 1, JSON.stringify(removed));

  const made = requests(ctx.store.memory.calls as { name: string; input: Input }[]);
  assert.ok(made.some((r) => r.action === 'Query'));
  for (const request of made) assert.ok(allowed(request.action, request.pk), `${request.action} on ${request.pk}`);
});
