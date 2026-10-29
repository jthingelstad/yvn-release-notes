/** Exact DynamoDB shapes for API tokens and their writes (docs/API.md): the
 * token list, the owner's revoke with its 30-day pointer, a client's own
 * revoke, the token proof, a token's note added, changed and deleted, the
 * pinned tags and the recent tags' read. The fake table runs the same
 * requests in tests-node/api/v1.test.ts; these pin what goes to AWS. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, TOKEN_TOMBSTONE_SECONDS } from '../../packages/backend/store.ts';
import { FakeStore } from '../../packages/testing/store.ts';
import type { Item, StoreCommand } from '../../packages/backend/store-types.ts';

function recorder() {
  const commands: StoreCommand[] = [],
    store = new Store(
      {
        send: async (c) => {
          commands.push(c);
          return {};
        }
      },
      'T'
    );
  return { commands, store, only: () => commands.map((c) => [c.constructor.name, c.input]) };
}
const token = { id: 'a', user_id: 'u', revision: 2, name: 'Changelog', scope: 'notes:write activity' },
  profileProof = {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'PROFILE' },
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
    }
  },
  tokenProof = {
    ConditionCheck: {
      TableName: 'T',
      Key: { pk: 'USER#u', sk: 'APITOKEN#a' },
      ConditionExpression:
        '#r = :revision AND attribute_not_exists(revoked) AND ' +
        '(attribute_not_exists(expires_at) OR expires_at > :now) AND contains(#s, :scope)',
      ExpressionAttributeNames: { '#r': 'revision', '#s': 'scope' },
      ExpressionAttributeValues: { ':revision': 2, ':now': 100, ':scope': 'notes:write' }
    }
  },
  receipt = { pk: 'USER#u', sk: 'CAPTURE#a#h', request_hash: 'hash', result: '{}', expires_at: 2000 },
  audit = { pk: 'MCPMETA#u', sk: 'LOG#001', tool: 'v1.notes.create', connection: 'a', expires_at: 4000 },
  rate = { pk: 'MCPMETA#u', sk: 'WRITERATE#v1-create#1', n: 2, revision: 2, expires_at: 8000 },
  previous = { ...rate, n: 1, revision: 1 },
  receipts = (prior: Item | null) => [
    {
      Put: {
        TableName: 'T',
        Item: receipt,
        ConditionExpression: 'attribute_not_exists(pk) OR expires_at <= :now',
        ExpressionAttributeValues: { ':now': 100 }
      }
    },
    { Put: { TableName: 'T', Item: audit, ConditionExpression: 'attribute_not_exists(pk)' } },
    {
      Put: {
        TableName: 'T',
        Item: rate,
        ...(prior
          ? {
              ConditionExpression: '#r = :r',
              ExpressionAttributeNames: { '#r': 'revision' },
              ExpressionAttributeValues: { ':r': prior.revision }
            }
          : { ConditionExpression: 'attribute_not_exists(pk)' })
      }
    }
  ],
  note = {
    pk: 'USER#u',
    sk: 'NOTE#2026-10-29#t-n',
    text: 'Coffee #walks',
    tags: ['walks'],
    links: [],
    source: 'api',
    connection: 'a',
    token: 'Changelog',
    revision: 'r1'
  };

test('the token list is one strong query of the account’s APITOKEN rows', async () => {
  const { store, only } = recorder();
  await store.apiTokens('u');
  assert.deepEqual(only(), [
    [
      'QueryCommand',
      {
        TableName: 'T',
        KeyConditionExpression: 'pk = :p AND begins_with(sk, :t)',
        ExpressionAttributeValues: { ':p': 'USER#u', ':t': 'APITOKEN#' },
        ConsistentRead: true
      }
    ]
  ]);
});

test('the owner’s revoke drops the row and keeps the pointer and its ownership row 30 days, revoked', async () => {
  const { store, only } = recorder(),
    end = 100 + TOKEN_TOMBSTONE_SECONDS;
  assert.equal(TOKEN_TOMBSTONE_SECONDS, 2_592_000);
  assert.equal(await store.dropToken('u', 'a', 'h', 100), true);
  assert.deepEqual(only(), [
    [
      'TransactWriteCommand',
      {
        TransactItems: [
          { Delete: { TableName: 'T', Key: { pk: 'USER#u', sk: 'APITOKEN#a' } } },
          {
            Update: {
              TableName: 'T',
              Key: { pk: 'OAUTHACCESS#h', sk: 'STATE' },
              UpdateExpression: 'SET revoked = :yes, expires_at = :end',
              ExpressionAttributeValues: { ':yes': true, ':end': end }
            }
          },
          {
            Update: {
              TableName: 'T',
              Key: { pk: 'OAUTHUSER#u', sk: 'ROW#OAUTHACCESS#h' },
              UpdateExpression: 'SET target = :target, expires_at = :end',
              ExpressionAttributeValues: { ':target': 'OAUTHACCESS#h', ':end': end }
            }
          }
        ]
      }
    ]
  ]);
});

test('a client’s own revoke proves the live account and the token revision it read', async () => {
  const { store, only } = recorder();
  assert.equal(await store.revokeToken(token), true);
  assert.deepEqual(only(), [
    [
      'TransactWriteCommand',
      {
        TransactItems: [
          profileProof,
          {
            Update: {
              TableName: 'T',
              Key: { pk: 'USER#u', sk: 'APITOKEN#a' },
              UpdateExpression: 'SET revoked = :yes, #r = :next',
              ConditionExpression: '#r = :revision AND attribute_not_exists(revoked)',
              ExpressionAttributeNames: { '#r': 'revision' },
              ExpressionAttributeValues: { ':yes': true, ':revision': 2, ':next': 3 }
            }
          }
        ]
      }
    ]
  ]);
});

test('the token proof names its revision, expiry and every scope it needs', () => {
  const { store } = recorder();
  assert.deepEqual(store.tokenProof(token, 100, 'notes:write'), [tokenProof]);
  assert.deepEqual(store.tokenProof(token, 100, ['notes:write', 'activity']), [
    {
      ConditionCheck: {
        ...tokenProof.ConditionCheck,
        ConditionExpression: tokenProof.ConditionCheck.ConditionExpression + ' AND contains(#s, :also0)',
        ExpressionAttributeValues: { ...tokenProof.ConditionCheck.ExpressionAttributeValues, ':also0': 'activity' }
      }
    }
  ]);
});

test('a token’s new note: account, token, note, receipt, audit and count in one transaction', async () => {
  const { store, only } = recorder();
  assert.equal(await store.apiNoteCommit(note, null, receipt, audit, rate, null, token, 100), true);
  assert.deepEqual(only(), [
    [
      'TransactWriteCommand',
      {
        TransactItems: [
          profileProof,
          tokenProof,
          { Put: { TableName: 'T', Item: note, ConditionExpression: 'attribute_not_exists(pk)' } },
          ...receipts(null)
        ]
      }
    ]
  ]);
});

test('a token’s change goes only to its own note, from the words and revision it read', async () => {
  const changed = { ...note, text: 'Coffee #walks, then more', updated_at: 200, revision: 'r3' };
  for (const edited of [null, 150]) {
    const { store, only } = recorder(),
      old = { ...note, revision: 'r2', ...(edited ? { updated_at: edited } : {}) };
    assert.equal(await store.apiNoteCommit(changed, old, receipt, audit, rate, previous, token, 100), true);
    assert.deepEqual(only(), [
      [
        'TransactWriteCommand',
        {
          TransactItems: [
            profileProof,
            tokenProof,
            {
              Update: {
                TableName: 'T',
                Key: { pk: 'USER#u', sk: 'NOTE#2026-10-29#t-n' },
                UpdateExpression: 'SET #t = :text, tags = :tags, links = :links, updated_at = :updated_at, #r = :next',
                ConditionExpression:
                  '#src = :api AND #c = :token AND #t = :old AND #r = :revision AND ' +
                  (edited ? 'updated_at = :edited' : 'attribute_not_exists(updated_at)'),
                ExpressionAttributeNames: { '#t': 'text', '#r': 'revision', '#c': 'connection', '#src': 'source' },
                ExpressionAttributeValues: {
                  ':api': 'api',
                  ':token': 'a',
                  ':old': 'Coffee #walks',
                  ':revision': 'r2',
                  ':text': 'Coffee #walks, then more',
                  ':tags': ['walks'],
                  ':links': [],
                  ':updated_at': 200,
                  ':next': 'r3',
                  ...(edited ? { ':edited': 150 } : {})
                }
              }
            },
            ...receipts(previous)
          ]
        }
      ]
    ]);
  }
});

test('a token deletes only its own note, at the revision it read, with the same proofs', async () => {
  const { store, only } = recorder();
  assert.equal(await store.apiNoteDelete(note, receipt, audit, rate, previous, token, 100), true);
  assert.deepEqual(only(), [
    [
      'TransactWriteCommand',
      {
        TransactItems: [
          profileProof,
          tokenProof,
          {
            Delete: {
              TableName: 'T',
              Key: { pk: 'USER#u', sk: 'NOTE#2026-10-29#t-n' },
              ConditionExpression: '#src = :api AND #c = :token AND #r = :revision',
              ExpressionAttributeNames: { '#r': 'revision', '#c': 'connection', '#src': 'source' },
              ExpressionAttributeValues: { ':api': 'api', ':token': 'a', ':revision': 'r1' }
            }
          },
          ...receipts(previous)
        ]
      }
    ]
  ]);
});

test('pinned tags are set from the list read, first or replacing, with any proofs after', async () => {
  const { store, only } = recorder(),
    pins = (condition: string, values: Item) => ({
      Update: {
        TableName: 'T',
        Key: { pk: 'USER#u', sk: 'PROFILE' },
        UpdateExpression: 'SET pinned_tags = :pins',
        ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting) AND ' + condition,
        ExpressionAttributeValues: values
      }
    });
  assert.equal(await store.setPins('u', ['walks'], null), true);
  assert.equal(await store.setPins('u', ['walks', 'cabin'], ['walks'], [tokenProof]), true);
  assert.deepEqual(only(), [
    ['TransactWriteCommand', { TransactItems: [pins('attribute_not_exists(pinned_tags)', { ':pins': ['walks'] })] }],
    [
      'TransactWriteCommand',
      {
        TransactItems: [pins('pinned_tags = :old', { ':pins': ['walks', 'cabin'], ':old': ['walks'] }), tokenProof]
      }
    ]
  ]);
});

test('the recent tags read only the tags and times of the window’s notes', async () => {
  const { store, only } = recorder();
  await store.tagsBetween('u', '2026-09-30', '2026-10-29');
  assert.deepEqual(only(), [
    [
      'QueryCommand',
      {
        TableName: 'T',
        ProjectionExpression: 'sk, #g, written_at, received_at',
        ExpressionAttributeNames: { '#g': 'tags' },
        KeyConditionExpression: 'pk = :u AND sk BETWEEN :a AND :b',
        ExpressionAttributeValues: { ':u': 'USER#u', ':a': 'NOTE#2026-09-30#', ':b': 'NOTE#2026-10-29$' }
      }
    ]
  ]);
});

test('the fake table refuses a token proof for a revoked, expired, changed or narrower token', async () => {
  const row = { pk: 'USER#u', sk: 'APITOKEN#a', ...token, expires_at: 1000 };
  for (const [mutation, seeded] of [
    ['live', row],
    ['revoked', { ...row, revoked: true }],
    ['expired', { ...row, expires_at: 100 }],
    ['revision', { ...row, revision: 3 }],
    ['scope', { ...row, scope: 'activity' }],
    ['gone', null]
  ] as const) {
    const s = new FakeStore([{ pk: 'USER#u', sk: 'PROFILE', email: 'ada@example.com' }], 'T');
    if (seeded) s.seed(seeded);
    assert.equal(
      await s.apiNoteCommit(note, null, receipt, audit, rate, null, token, 100),
      mutation === 'live',
      mutation
    );
    assert.equal((await s.allNotes('u')).length, mutation === 'live' ? 1 : 0, mutation);
  }
});
