/** The `/v1` API as OpenAPI 3.1 (docs/API.md, Clients other people build),
 * served with no token at `/v1/openapi.json` and kept in
 * `contracts/api-surface.json` by tools/export-api-contract.ts. It is built
 * from the constants the API keeps (its routes, error codes, limits and
 * sizes), so a change there changes it. Beside the contract,
 * `contracts/api-versions.json` records each API_VERSION's digest: a change
 * under a version already recorded is refused, since a client reads
 * `api_version` to know what it may call. */
import { createHash } from 'node:crypto';
import { ACTIVITY_FAMILIES } from '../../packages/domain/activity.ts';
import { MAX_NOTE } from '../../packages/domain/notes.ts';
import { PINS_MAX, RECENT_DAYS, RECENT_MAX } from '../../packages/backend/tag-row.ts';
import { V1_LIMITS, V1_RECEIPT_SECONDS } from '../../packages/backend/tokens.ts';
import { API_CHANGES, API_VERSION, ME_DAYS, V1_BODY, V1_ERRORS, V1_ROUTES } from './v1.ts';

type Doc = Record<string, unknown>;

/** Each route's operation: its id, summary and what it reads and answers. */
const OPERATIONS: Record<string, Doc> = {
  me: {
    operationId: 'getMe',
    summary: `Today's version, the next ${ME_DAYS} days' versions, and this token`,
    description:
      'What a client needs to show the version and fire reminders offline, without ever working out a version ' +
      'itself. The birthday is never sent. Any token may read it.',
    responses: { '200': answer('Me', "You're 4.5.137 today.") }
  },
  'notes.create': {
    operationId: 'createNote',
    summary: 'Add a note',
    description:
      "A note in the owner's own voice, shown with “via <token name>” on the web. Hashtags in the text are its tags. " +
      'A `text/plain` body is the note’s text alone. With neither `date` nor `written_at`, it files to today.',
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: ref('NoteCreate') },
        'text/plain': { schema: { type: 'string', maxLength: MAX_NOTE } }
      }
    },
    responses: { '201': answer('NoteWritten', 'Filed in 4.5.137.', true) }
  },
  note: {
    operationId: 'getNote',
    summary: 'Read a note this token wrote',
    description: 'Its text and revision, so an app can pick up an edit made on the web.',
    responses: { '200': answer('Note', 'The note’s text.') }
  },
  'notes.edit': {
    operationId: 'editNote',
    summary: 'Replace the text of a note this token wrote',
    description:
      'From the revision the client read: a note changed since is a 409 `revision_mismatch` with its current ' +
      '`revision`. No history is kept.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteEdit') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.delete': {
    operationId: 'deleteNote',
    summary: 'Delete a note this token wrote',
    responses: { '204': { description: 'Deleted.', headers: writeHeaders() } }
  },
  'notes.append': {
    operationId: 'appendNote',
    summary: 'Add a paragraph to a note this token wrote',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteAppend') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  tags: {
    operationId: 'getTags',
    summary: 'The tag row: pinned tags, then the most used lately',
    description: `The pinned tags, then the tags used most in the last ${RECENT_DAYS} days that aren't pinned, ties broken by last use. Any token may read it.`,
    responses: { '200': answer('TagRow', '#house #work #running') }
  },
  'tags.pinned': {
    operationId: 'setPinnedTags',
    summary: 'Replace the pinned tags',
    description: `Up to ${PINS_MAX} tags, normalized as note hashtags are ("#Running" is running), each once. The same pins show on the web and through every token.`,
    requestBody: { required: true, content: { 'application/json': { schema: ref('Pins') } } },
    responses: { '200': answer('TagRow', '#house #work', true) }
  },
  activity: {
    operationId: 'getActivity',
    summary: 'The activity log, newest first, without words',
    description:
      'What came in, changed and went out. It never carries a mail subject, mail words, another sender or a ' +
      "settings value. An Upcoming row's title comes only with the `upcoming` scope.",
    parameters: [
      cursor('before', 'The next older page: `next` from the answer before.'),
      cursor('after', 'Only rows newer than this one, an `id` the client has seen.'),
      {
        name: 'kinds',
        in: 'query',
        description: 'Comma-separated families to keep.',
        schema: { type: 'string', example: 'note,mail,badge,status' }
      },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }
    ],
    responses: { '200': answer('Activity', 'One line a row: when, kind and token.') }
  },
  'token.revoke': {
    operationId: 'revokeToken',
    summary: 'Revoke this token',
    description: 'The token ends itself, as a sign-out does. Any token may.',
    responses: { '204': { description: 'Revoked.', headers: writeHeaders() } }
  }
};

function ref(name: string): Doc {
  return { $ref: `#/components/schemas/${name}` };
}
function cursor(name: string, description: string): Doc {
  return { name, in: 'query', description, schema: { type: 'string' } };
}
function writeHeaders(): Doc {
  return {
    'Idempotent-Replayed': { $ref: '#/components/headers/Idempotent-Replayed' },
    'RateLimit-Limit': { $ref: '#/components/headers/RateLimit-Limit' },
    'RateLimit-Remaining': { $ref: '#/components/headers/RateLimit-Remaining' },
    'RateLimit-Reset': { $ref: '#/components/headers/RateLimit-Reset' }
  };
}
function answer(schema: string, plain: string, write = false): Doc {
  return {
    description: 'OK',
    ...(write ? { headers: writeHeaders() } : {}),
    content: {
      'application/json': { schema: ref(schema) },
      'text/plain': { schema: { type: 'string', description: `With Accept: text/plain, one short line: ${plain}` } }
    }
  };
}

const day = { type: 'string', format: 'date', description: 'A day in the account’s own time zone.' },
  version = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$', example: '4.5.137' },
  text = { type: 'string', minLength: 1, maxLength: MAX_NOTE, description: `At most ${MAX_NOTE} characters.` };

const SCHEMAS: Record<string, Doc> = {
  Error: {
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: Object.keys(V1_ERRORS) },
          message: { type: 'string', description: 'A sentence that says what to do next.' },
          field: { type: 'string', description: 'The field or header at fault.' },
          revision: { type: 'string', description: 'With revision_mismatch: the note’s current revision.' }
        }
      }
    }
  },
  Me: {
    type: 'object',
    required: ['today', 'version', 'tz', 'days', 'token', 'api_version'],
    properties: {
      today: day,
      version,
      tz: { type: 'string', example: 'America/Chicago' },
      send_time: { type: 'string', example: '06:00', description: 'When the morning email goes, local time.' },
      wrote_today: { type: 'boolean' },
      streak: { type: 'integer', minimum: 0 },
      paused_until: { anyOf: [day, { type: 'null' }] },
      status: { type: 'string', enum: ['active', 'stopped'] },
      show_badges: { type: 'boolean' },
      days: {
        type: 'array',
        description: `${ME_DAYS} days from today; a birthday shows as a new major or minor version on its day.`,
        items: { type: 'object', required: ['date', 'version'], properties: { date: day, version } }
      },
      token: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          scopes: { type: 'array', items: { type: 'string' } },
          expires_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] }
        }
      },
      api_version: { type: 'string', example: API_VERSION }
    }
  },
  NoteCreate: {
    type: 'object',
    required: ['text'],
    additionalProperties: false,
    properties: {
      text,
      date: { ...day, description: 'Any day from the birthday through today. Default: the day it was written.' },
      written_at: {
        type: 'string',
        format: 'date-time',
        description:
          'When the words were typed, at most five minutes ahead. A note queued offline files to the day it ' +
          'was typed and is ordered by it.'
      }
    }
  },
  NoteEdit: {
    type: 'object',
    required: ['text', 'revision'],
    additionalProperties: false,
    properties: { text, revision: { type: 'string', description: 'The revision last read, unchanged.' } }
  },
  NoteAppend: { type: 'object', required: ['text'], additionalProperties: false, properties: { text } },
  NoteWritten: {
    type: 'object',
    required: ['note'],
    properties: {
      note: {
        type: 'object',
        required: ['id', 'date', 'version', 'revision', 'token'],
        properties: {
          id: { type: 'string' },
          date: day,
          version,
          revision: { type: 'string', description: 'Opaque: send it back unchanged.' },
          token: { type: 'string', description: 'The token’s name, as “via” shows it.' }
        }
      },
      unlocked: {
        type: 'array',
        description: 'Badges this note earned, only while Show badges is on, and never on a replay.',
        items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } }
      }
    }
  },
  Note: {
    type: 'object',
    required: ['id', 'date', 'version', 'text', 'revision'],
    properties: {
      id: { type: 'string' },
      date: day,
      version,
      text: { type: 'string' },
      revision: { type: 'string' },
      written_at: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
      files: { type: 'integer', minimum: 0 },
      token: { anyOf: [{ type: 'string' }, { type: 'null' }] }
    }
  },
  TagRow: {
    type: 'object',
    required: ['pinned', 'recent', 'window_days'],
    properties: {
      pinned: { type: 'array', maxItems: PINS_MAX, items: { type: 'string' } },
      recent: {
        type: 'array',
        maxItems: RECENT_MAX,
        items: {
          type: 'object',
          required: ['tag', 'count', 'last_used'],
          properties: { tag: { type: 'string' }, count: { type: 'integer' }, last_used: day }
        }
      },
      window_days: { type: 'integer', const: RECENT_DAYS }
    }
  },
  Pins: {
    type: 'object',
    required: ['pinned'],
    additionalProperties: false,
    properties: { pinned: { type: 'array', maxItems: PINS_MAX, items: { type: 'string' } } }
  },
  Activity: {
    type: 'object',
    required: ['items', 'next'],
    properties: {
      items: { type: 'array', items: ref('ActivityRow') },
      next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `before` for the next older page.' }
    }
  },
  ActivityRow: {
    type: 'object',
    required: ['id', 'at', 'kind'],
    description:
      'One thing that happened. Each kind keeps its own fields (note.added has `day` and `note`, a reads row ' +
      '`calls` and `tools`); `via` says through what, and a token’s rows name it as `token`.',
    properties: {
      id: { type: 'string', description: 'A cursor for `before` and `after`.' },
      at: { type: 'string', format: 'date-time' },
      kind: {
        type: 'string',
        example: 'note.added',
        description: `Its family is one of ${ACTIVITY_FAMILIES.join(', ')}.`
      },
      via: { type: 'string' },
      token: { type: 'string' },
      client: { type: 'string' }
    },
    additionalProperties: true
  }
};

const header = (description: string, schema: Doc = { type: 'integer' }): Doc => ({ description, schema });

/** The whole document, as served and as kept in the contract. */
export function openApi(): Doc {
  const paths: Record<string, Record<string, Doc>> = {
    '/v1/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        summary: 'This document',
        security: [],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    }
  };
  for (const route of V1_ROUTES) {
    const operation = OPERATIONS[route.name]!,
      parameters: Doc[] = [];
    if (route.template.includes('{date}'))
      parameters.push(
        { name: 'date', in: 'path', required: true, schema: day },
        { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$' } }
      );
    if (route.method !== 'GET') parameters.push({ $ref: '#/components/parameters/Idempotency-Key' });
    if (Array.isArray(operation.parameters)) parameters.push(...(operation.parameters as Doc[]));
    (paths[route.template] ??= {})[route.method.toLowerCase()] = {
      ...operation,
      ...(parameters.length ? { parameters } : {}),
      security: [{ token: route.scope ? [route.scope] : [] }],
      ...(route.scope ? { 'x-scope': route.scope } : {}),
      responses: { ...(operation.responses as Doc), default: { $ref: '#/components/responses/Error' } }
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Release Notes API',
      version: API_VERSION,
      summary: 'Add notes to Release Notes from anywhere: a terminal, a script or an app.',
      description: [
        'Make a token in Release Notes under Settings, API tokens, and send it as `Authorization: Bearer rn_...`. ' +
          'Notes come from the owner, shown with “via <token name>”. The guide is at /guide/api/.',
        `Bodies are JSON in UTF-8, at most ${V1_BODY / 1024} KB. Any answer is one short line instead with ` +
          '`Accept: text/plain`.',
        `Every write takes an optional \`Idempotency-Key\`; its receipt answers the same request again for ` +
          `${V1_RECEIPT_SECONDS / 86400} days.`,
        `A day in UTC, an account may add ${V1_LIMITS.create} notes and make ${V1_LIMITS.change} other changes ` +
          `across its tokens, and each token may read ${V1_LIMITS.reads.toLocaleString('en-US')} times.`
      ].join('\n\n'),
      'x-changes': API_CHANGES
    },
    servers: [{ url: 'https://notes.yourversionnumber.com' }],
    security: [{ token: [] }],
    paths,
    components: {
      securitySchemes: {
        token: {
          type: 'http',
          scheme: 'bearer',
          description: 'An API token: rn_ and 43 more characters, shown once when it is made.'
        }
      },
      parameters: {
        'Idempotency-Key': {
          name: 'Idempotency-Key',
          in: 'header',
          description:
            'Any 1 to 128 printable ASCII characters, new for each change. Sent again with the same request, ' +
            'it answers the first result again; with a different request it is a 422.',
          schema: { type: 'string', minLength: 1, maxLength: 128 }
        }
      },
      headers: {
        'Release-Notes-Version': header("Today's version, on every answer to a token.", { type: 'string' }),
        'API-Version': header('This API’s version.', { type: 'string' }),
        'Idempotent-Replayed': header('true when a receipt answered.', { type: 'string', const: 'true' }),
        'RateLimit-Limit': header('The day’s limit for this kind of write.'),
        'RateLimit-Remaining': header('How many are left today.'),
        'RateLimit-Reset': header('Seconds until the limit starts again, at midnight UTC.'),
        'Retry-After': header('With rate_limited: seconds to wait.')
      },
      responses: {
        Error: {
          description: Object.entries(V1_ERRORS)
            .map(([code, status]) => `${status} ${code}`)
            .join(', '),
          headers: { 'Retry-After': { $ref: '#/components/headers/Retry-After' } },
          content: {
            'application/json': { schema: ref('Error') },
            'text/plain': { schema: { type: 'string' } }
          }
        }
      },
      schemas: SCHEMAS
    }
  };
}

/** A digest of the document, for the version ledger. */
export const surfaceDigest = (): string => createHash('sha256').update(JSON.stringify(openApi())).digest('hex');
