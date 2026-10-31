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
import { MAX_FILES, MAX_UPLOAD } from '../../packages/backend/media.ts';
import { NEARBY_MAX } from '../../packages/backend/places.ts';
import { FORM_SECONDS, UPLOADS_A_DAY, UPLOAD_BYTES_A_DAY } from '../../packages/backend/uploads.ts';
import { PINS_MAX, RECENT_DAYS, RECENT_MAX } from '../../packages/backend/tag-row.ts';
import { TOKEN_SCOPES, V1_LIMITS, V1_RECEIPT_SECONDS, V1_UPCOMING_MAX } from '../../packages/backend/tokens.ts';
import { MAX_TAG } from '../../packages/domain/tags.ts';
import { UPCOMING_KINDS, UPCOMING_MAX, UPCOMING_TITLE_MAX } from '../../packages/domain/upcoming.ts';
import {
  API_CHANGES,
  API_VERSION,
  FILE_SECONDS,
  ME_DAYS,
  RANGE_DAYS_MAX,
  REMINDER_DAYS_MAX,
  V1_BODY,
  V1_ERRORS,
  V1_ROUTES
} from './v1.ts';

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
  notes: {
    operationId: 'listNotes',
    summary: 'The notes this token wrote, or with notes:all every note, on some days, oldest first',
    description:
      `From \`from\` to \`to\`, days in the account’s time zone, both in, at most ${RANGE_DAYS_MAX} days a ` +
      'request; a wider span is `range_too_wide`, so ask in pieces. Each note is as `getNote` reads it. A ' +
      'range with none is an empty list. Only this token’s notes, whatever else the days hold, unless it has ' +
      '`notes:all` (1.10.0): then every note on those days, or with `mine=true` its own alone.',
    parameters: [
      {
        name: 'from',
        in: 'query',
        required: true,
        description: 'The first day.',
        schema: { type: 'string', format: 'date' }
      },
      {
        name: 'to',
        in: 'query',
        description: 'The last day, from or later; left out, it is from.',
        schema: { type: 'string', format: 'date' }
      },
      cursor('after', 'The next page: `next` from the answer before.'),
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
      {
        name: 'mine',
        in: 'query',
        description: 'true keeps only the notes this token wrote (1.10.0).',
        schema: { type: 'string', enum: ['true', 'false'], default: 'false' }
      }
    ],
    responses: { '200': answer('NoteList', 'One line a note: its day and its words.') }
  },
  'notes.create': {
    operationId: 'createNote',
    summary: 'Add a note',
    description:
      "A note in the owner's own voice, shown with “via <token name>” on the web. Hashtags in the text are its tags, " +
      'in any script since 1.7.1. ' +
      'A `text/plain` body is the note’s text alone, and so is a form that is not a `NoteForm`; a multipart ' +
      'body is refused. With neither `date` nor `written_at`, it files to today. ' +
      'With `uploads` (and the `media:write` scope) it takes those files, and then needs no text. A `place` is a ' +
      'city from `GET /v1/places` or the `place` from `POST /v1/places/here`, sent back as it came, and kept as ' +
      'sent: its shape is checked, not the place.',
    requestBody: {
      required: true,
      content: {
        'application/json': { schema: ref('NoteCreate') },
        'text/plain': { schema: { type: 'string', maxLength: MAX_NOTE } },
        'application/x-www-form-urlencoded': { schema: ref('NoteForm') }
      }
    },
    responses: { '201': answer('NoteWritten', 'Filed in 4.5.137.', true) }
  },
  note: {
    operationId: 'getNote',
    summary: 'Read a note this token wrote, or any note with notes:all',
    description:
      'Its text and revision, so an app can pick up an edit made on the web. With `notes:all` (1.10.0), any ' +
      'note in the account, from any channel; `source` says where it was made and `mine` whether this token ' +
      'wrote it.',
    responses: { '200': answer('Note', 'The note’s text.') }
  },
  'notes.edit': {
    operationId: 'editNote',
    summary: 'Replace the text of a note this token wrote, or any note with notes:all',
    description:
      'From the revision the client read: a note changed since is a 409 `revision_mismatch` with its current ' +
      '`revision`. No history is kept.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteEdit') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.delete': {
    operationId: 'deleteNote',
    summary: 'Delete a note this token wrote',
    description: 'Only a note this token wrote, even with `notes:all`.',
    responses: { '204': { description: 'Deleted.', headers: writeHeaders() } }
  },
  'notes.append': {
    operationId: 'appendNote',
    summary: 'Add a paragraph to a note this token wrote, or any note with notes:all',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteAppend') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.media': {
    operationId: 'addNoteFiles',
    summary: 'Add files to a note this token wrote',
    description:
      'Only a note this token wrote, even with `notes:all`. ' +
      `Uploads from \`POST /v1/uploads\`, each checked against the bytes that arrived, up to ${MAX_FILES} files on ` +
      'a note in all. It counts as a change. A note takes each upload once; a write refused or lost before it ' +
      'lands leaves the uploads for a retry with the same Idempotency-Key.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteMedia') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.file': {
    operationId: 'getNoteFile',
    summary: 'An address for one file on a note this token wrote, or any note with notes:all',
    description:
      `A signed address for the file, good for ${FILE_SECONDS / 60} minutes; fetch it with no token. With ` +
      '`size=thumb`, the small JPEG copy a photo has, for a list; a file without one is `not_found`. `n` is ' +
      'the number in the note’s `media`.',
    parameters: [
      {
        name: 'size',
        in: 'query',
        description: 'thumb for the small copy; left out, the file itself.',
        schema: { type: 'string', enum: ['thumb'] }
      }
    ],
    responses: { '200': answer('NoteFile', 'The address.') }
  },
  'uploads.start': {
    operationId: 'startUpload',
    summary: 'A signed form for one file',
    description:
      `A photo, recording or PDF of up to ${MAX_UPLOAD / 1024 / 1024} MB, its exact size given. Post the file to ` +
      '`url` as `multipart/form-data`, with every one of `fields` and then the file as `file`, within ' +
      `\`expires_in\` seconds, then name the upload in a note's \`uploads\`. An account takes ${UPLOADS_A_DAY} ` +
      `files and ${UPLOAD_BYTES_A_DAY / 1024 ** 3} GB a UTC day, with the web's. It has no receipt: a retry gets a ` +
      'new form, and an unused one expires.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('UploadStart') } } },
    responses: { '201': answer('UploadForm', 'The upload’s id.') }
  },
  places: {
    operationId: 'searchPlaces',
    summary: 'Find a city by name, for a note’s place',
    description: 'The web’s city search. Send one of the answers as a note’s `place`, as it came.',
    parameters: [
      {
        name: 'q',
        in: 'query',
        required: true,
        description: 'A city’s name, like Zürich.',
        schema: { type: 'string', minLength: 2, maxLength: 80 }
      }
    ],
    responses: { '200': answer('Places', 'One line a city.') }
  },
  'places.here': {
    operationId: 'nameHere',
    summary: 'Name the spot a device is at, for a note’s place',
    description:
      'The city and neighbourhood, and the businesses Amazon Location finds within the accuracy (50 to 200 m), ' +
      `up to ${NEARBY_MAX}. Send \`place\` back as a note’s place, with \`venue\` set to one \`nearby\` name if ` +
      `the owner picks one; nothing is picked for them. An account names ${V1_LIMITS.here} spots a UTC day across ` +
      'its tokens. Nothing is kept until a note takes the place. It has no receipt: a retry asks again, and ' +
      'counts again.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('Spot') } } },
    responses: { '200': answer('Here', 'The spot’s names, then what is nearby.', true, false) }
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
    description: `Up to ${PINS_MAX} tags, normalized as note hashtags are ("#Running" is running, and since 1.7.1 "Москва" is москва), each once. The same pins show on the web and through every token.`,
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
        name: 'from',
        in: 'query',
        description: `Only rows from this day on, in the account’s time zone (1.9.0). With \`to\`, at most ${RANGE_DAYS_MAX} days.`,
        schema: { type: 'string', format: 'date' }
      },
      {
        name: 'to',
        in: 'query',
        description: 'Only rows up to the end of this day; left out, it is from.',
        schema: { type: 'string', format: 'date' }
      },
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
  upcoming: {
    operationId: 'getUpcoming',
    summary: 'The Upcoming dates ahead',
    description:
      'Every saved birthday, anniversary, trip and event, soonest first, with its next date and the line the ' +
      'email uses. A one-time date already over is left out and counted in `past_left_out`, since it still takes ' +
      `one of the account's ${UPCOMING_MAX}.`,
    responses: { '200': answer('UpcomingList', 'One line a date: its next date and its line.') }
  },
  'upcoming.batch': {
    operationId: 'saveUpcoming',
    summary: `Add, change and remove up to ${V1_UPCOMING_MAX} Upcoming dates at once`,
    description:
      'All or nothing: if any entry has a problem, nothing is saved and the error names it (`field` is like ' +
      '`change[2]`). A change replaces the saved date from the `revision` the client read; one changed since is ' +
      'a 409 `revision_mismatch`. A trip’s destination is text the city search knows, like "Paris, Texas". ' +
      'With `dry_run`, it checks everything and finds the cities but saves nothing, and counts as a read.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('UpcomingBatch') } } },
    responses: { '200': answer('UpcomingSaved', 'Saved: 2 added, 1 changed, 0 removed.', true) }
  },
  'upcoming.reminders': {
    operationId: 'getReminders',
    summary: 'The reminders each morning carries, for the days ahead',
    description:
      'Each day with a reminder due, from today: the reminders the morning email carries for dates with ' +
      '`email` on (all of them, where the email shows three), each with the email’s own `when` and `line`, and ' +
      '`send_at`, when that morning’s email is due. An app schedules them as notifications and reads again ' +
      'when it opens.',
    parameters: [
      {
        name: 'days',
        in: 'query',
        description: 'How many days from today, today included.',
        schema: { type: 'integer', minimum: 1, maximum: REMINDER_DAYS_MAX, default: ME_DAYS }
      }
    ],
    responses: { '200': answer('Reminders', 'One line a reminder: its day, when and line.') }
  },
  'upcoming.delete': {
    operationId: 'deleteUpcoming',
    summary: 'Remove one Upcoming date',
    description: 'From the revision the client read: a date changed since is a 409 `revision_mismatch`.',
    parameters: [
      {
        name: 'revision',
        in: 'query',
        required: true,
        description: 'The revision last read.',
        schema: { type: 'integer', minimum: 1 }
      }
    ],
    responses: { '204': { description: 'Removed.', headers: writeHeaders() } }
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
function writeHeaders(receipt = true): Doc {
  return {
    ...(receipt ? { 'Idempotent-Replayed': { $ref: '#/components/headers/Idempotent-Replayed' } } : {}),
    'RateLimit-Limit': { $ref: '#/components/headers/RateLimit-Limit' },
    'RateLimit-Remaining': { $ref: '#/components/headers/RateLimit-Remaining' },
    'RateLimit-Reset': { $ref: '#/components/headers/RateLimit-Reset' }
  };
}
/** An OK answer; a counted write says where it stands, and one with a
 * receipt says when the receipt answered. */
function answer(schema: string, plain: string, write = false, receipt = write): Doc {
  return {
    description: 'OK',
    ...(write ? { headers: writeHeaders(receipt) } : {}),
    content: {
      'application/json': { schema: ref(schema) },
      'text/plain': { schema: { type: 'string', description: `With Accept: text/plain: ${plain}` } }
    }
  };
}

const day = { type: 'string', format: 'date', description: 'A day in the account’s own time zone.' },
  version = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$', example: '4.5.137' },
  text = {
    type: 'string',
    minLength: 1,
    maxLength: MAX_NOTE,
    description:
      `At most ${MAX_NOTE} characters. Control characters other than tab and newline are dropped, and a lone ` +
      'surrogate escape is refused (since 1.7.0).'
  },
  noteDate = { ...day, description: 'Any day from the birthday through today. Default: the day it was written.' },
  noteWritten = {
    type: 'string',
    format: 'date-time',
    description:
      'When the words were typed, at most five minutes ahead. A note queued offline files to the day it ' +
      'was typed and is ordered by it.'
  };

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
    required: ['account', 'today', 'version', 'tz', 'days', 'token', 'api_version'],
    properties: {
      account: {
        type: 'string',
        pattern: '^acct_[0-9a-f]{32}$',
        example: 'acct_5d41402abc4b2a76b9719d911017c592',
        description:
          'The account’s id: the same for every token of the account and never changing, so a client can tell ' +
          'whose account a token opens. It means nothing anywhere else. Since 1.4.0.'
      },
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
        required: ['id', 'name', 'scopes', 'expires_at'],
        properties: {
          id: {
            type: 'string',
            pattern: '^[0-9a-f]{32}$',
            description:
              'This token’s id, which never changes and is never the token itself; activity rows it writes carry ' +
              'it as `token_id`. Since 1.4.0.'
          },
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
    description: 'Text, files or both.',
    anyOf: [{ required: ['text'] }, { required: ['uploads'] }],
    additionalProperties: false,
    properties: {
      text,
      date: noteDate,
      written_at: noteWritten,
      uploads: ref('Uploads'),
      place: ref('NotePlace')
    }
  },
  NoteForm: {
    type: 'object',
    description:
      'A form, as a Shortcut’s Form body sends it, read as these fields when every name is one of them and ' +
      '`text` is there; any other form body is the words. Since 1.7.0.',
    required: ['text'],
    additionalProperties: false,
    properties: { text, date: noteDate, written_at: noteWritten }
  },
  NoteMedia: {
    type: 'object',
    required: ['uploads'],
    additionalProperties: false,
    properties: { uploads: ref('Uploads') }
  },
  Uploads: {
    type: 'array',
    minItems: 1,
    maxItems: MAX_FILES,
    description: 'Files posted to forms from `POST /v1/uploads`, each once. Needs `media:write`.',
    items: {
      type: 'object',
      required: ['upload', 'type'],
      additionalProperties: false,
      properties: {
        upload: { type: 'string', pattern: '^[0-9a-f]{32}$', description: 'The id the form came with.' },
        type: { type: 'string', description: 'The `type` the form came with.' },
        name: { type: 'string', description: 'The file’s name, shown with it; a long one is shortened.' }
      }
    }
  },
  UploadStart: {
    type: 'object',
    required: ['type', 'size'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', maxLength: 255, description: 'The file’s name, which helps tell its type.' },
      type: { type: 'string', example: 'image/jpeg', description: 'A photo, recording or PDF’s media type.' },
      size: { type: 'integer', minimum: 1, maximum: MAX_UPLOAD, description: 'Its exact size in bytes.' }
    }
  },
  UploadForm: {
    type: 'object',
    required: ['upload', 'type', 'url', 'fields', 'expires_in'],
    properties: {
      upload: { type: 'string', pattern: '^[0-9a-f]{32}$' },
      type: { type: 'string', description: 'The type it was signed for: name the upload with it.' },
      url: { type: 'string', format: 'uri', description: 'Where to post the file.' },
      fields: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Every one goes in the form, before the file.'
      },
      expires_in: { type: 'integer', const: FORM_SECONDS, description: 'Seconds the form is good for.' }
    }
  },
  City: {
    type: 'object',
    required: ['name', 'region', 'country', 'tz', 'lat', 'lon'],
    properties: {
      name: { type: 'string' },
      region: { type: 'string' },
      country: { type: 'string' },
      tz: { type: 'string', example: 'Europe/Zurich' },
      lat: { type: 'number' },
      lon: { type: 'number' }
    }
  },
  Places: {
    type: 'object',
    required: ['places'],
    properties: { places: { type: 'array', items: ref('City') } }
  },
  Spot: {
    type: 'object',
    required: ['lat', 'lon'],
    additionalProperties: false,
    properties: {
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      accuracy_m: { type: 'number', minimum: 0, description: 'The device’s accuracy, in metres.' }
    }
  },
  DevicePlace: {
    type: 'object',
    required: ['name', 'lat', 'lon', 'from'],
    description: 'A spot, kept to six decimal places, with its names.',
    properties: {
      name: { type: 'string', description: 'The city.' },
      region: { type: 'string' },
      country: { type: 'string' },
      tz: { type: 'string' },
      district: { type: 'string', description: 'The neighbourhood, which names the note by default.' },
      venue: { type: 'string', description: 'A `nearby` name the owner picked.' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      accuracy_m: { type: 'number' },
      from: { type: 'string', const: 'device' }
    }
  },
  NotePlace: {
    description:
      'A city from `GET /v1/places`, or the `place` from `POST /v1/places/here`, kept as sent: its names, time ' +
      'zone and spot are checked for shape, and it is never looked up again.',
    anyOf: [ref('City'), ref('DevicePlace')]
  },
  Here: {
    type: 'object',
    required: ['place', 'nearby'],
    properties: {
      place: ref('DevicePlace'),
      nearby: {
        type: 'array',
        maxItems: NEARBY_MAX,
        items: {
          type: 'object',
          required: ['name', 'lat', 'lon', 'distance_m'],
          properties: {
            name: { type: 'string', example: 'Corner Coffee' },
            lat: { type: 'number' },
            lon: { type: 'number' },
            distance_m: { type: 'number' }
          }
        }
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
          files: { type: 'integer', minimum: 0, description: 'How many files the note has.' },
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
      media: { type: 'array', items: ref('NoteFileEntry'), description: 'Its files, in order (1.9.0).' },
      token: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      source: {
        type: 'string',
        description: 'Where the note was made: email, web, api and the rest (1.10.0).'
      },
      mine: { type: 'boolean', description: 'Whether this token wrote it (1.10.0).' }
    }
  },
  NoteFileEntry: {
    type: 'object',
    required: ['n', 'kind', 'type', 'name', 'size', 'thumb'],
    properties: {
      n: { type: 'integer', minimum: 1, description: 'Its number, for `getNoteFile`.' },
      kind: { type: 'string', enum: ['image', 'audio', 'file'] },
      type: { type: 'string', example: 'image/jpeg' },
      name: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      size: { type: 'integer', minimum: 0, description: 'Bytes.' },
      thumb: {
        anyOf: [
          {
            type: 'object',
            properties: {
              type: { type: 'string', const: 'image/jpeg' },
              width: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
              height: { anyOf: [{ type: 'integer' }, { type: 'null' }] }
            }
          },
          { type: 'null' }
        ],
        description: 'The small copy, when it has one: ask with size=thumb.'
      }
    }
  },
  NoteList: {
    type: 'object',
    required: ['from', 'to', 'items', 'next'],
    properties: {
      from: day,
      to: day,
      items: { type: 'array', maxItems: 100, items: ref('Note') },
      next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `after` for the next page.' }
    }
  },
  NoteFile: {
    type: 'object',
    required: ['url', 'type', 'expires_in'],
    properties: {
      url: { type: 'string', format: 'uri' },
      type: { type: 'string' },
      expires_in: { type: 'integer', const: FILE_SECONDS }
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
  UpcomingFields: {
    type: 'object',
    description: 'A date as it is saved. A change sends every field again, as it should be.',
    required: ['kind', 'title', 'date'],
    properties: {
      kind: { type: 'string', enum: [...UPCOMING_KINDS] },
      title: { type: 'string', minLength: 1, maxLength: UPCOMING_TITLE_MAX, description: 'One line.' },
      tag: { anyOf: [{ type: 'string', maxLength: MAX_TAG }, { type: 'null' }], description: 'One word, like family.' },
      date: {
        type: 'string',
        pattern: '^(?:\\d{4}-)?\\d{2}-\\d{2}$',
        description: 'MM-DD for a birthday or anniversary; YYYY-MM-DD for a trip (its first day) or an event.'
      },
      year: {
        anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
        description: 'A birthday’s or anniversary’s first year, so the line can say which one it is.'
      },
      end_date: { anyOf: [day, { type: 'null' }], description: 'A trip’s last day, on or after `date`.' },
      place: {
        anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }],
        description: 'A trip’s destination: "Zürich", or "Paris, Texas" to choose among cities of one name.'
      },
      email: { type: 'boolean', default: true, description: 'Remind in the morning email (and so in apps).' },
      reminders: {
        type: 'array',
        maxItems: 6,
        items: { type: 'integer', minimum: 0, maximum: 365 },
        description: 'Days before to remind; by default 7, 1 and 0 (a trip 14, 1 and 0).'
      }
    }
  },
  Upcoming: {
    allOf: [
      ref('UpcomingFields'),
      {
        type: 'object',
        required: ['id', 'revision', 'next', 'status', 'line'],
        properties: {
          id: { type: 'string' },
          revision: { type: 'integer', description: 'Send it back to change or remove the date.' },
          next: { ...day, description: 'Its next date, or today while a trip is on.' },
          through: { ...day, description: 'A trip’s last day this time.' },
          status: { type: 'string', enum: ['upcoming', 'today', 'ongoing', 'past'] },
          line: { type: 'string', example: 'Mom turns 7.0.0. A major release.' }
        }
      }
    ]
  },
  UpcomingList: {
    type: 'object',
    required: ['today', 'entries', 'past_left_out', 'max_entries'],
    properties: {
      today: day,
      entries: { type: 'array', items: ref('Upcoming') },
      past_left_out: { type: 'integer', minimum: 0 },
      max_entries: { type: 'integer', const: UPCOMING_MAX }
    }
  },
  UpcomingBatch: {
    type: 'object',
    additionalProperties: false,
    description: `At most ${V1_UPCOMING_MAX} entries in all, and at least one.`,
    properties: {
      add: { type: 'array', items: { ...ref('UpcomingFields') } },
      change: {
        type: 'array',
        items: {
          allOf: [
            ref('UpcomingFields'),
            {
              type: 'object',
              required: ['id', 'revision'],
              properties: { id: { type: 'string' }, revision: { type: 'integer' } }
            }
          ]
        }
      },
      remove: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'revision'],
          additionalProperties: false,
          properties: { id: { type: 'string' }, revision: { type: 'integer' } }
        }
      },
      dry_run: { type: 'boolean', default: false }
    }
  },
  UpcomingSaved: {
    type: 'object',
    required: ['dry_run', 'added', 'changed', 'removed'],
    properties: {
      dry_run: { type: 'boolean' },
      added: { type: 'array', items: ref('Upcoming'), description: 'In the order they were sent, with their ids.' },
      changed: { type: 'array', items: ref('Upcoming') },
      removed: { type: 'array', items: { type: 'string' }, description: 'The ids removed.' },
      unlocked: {
        type: 'array',
        description: 'Badges this save earned, only while Show badges is on, and never on a replay.',
        items: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } }
      }
    }
  },
  Reminders: {
    type: 'object',
    required: ['from', 'through', 'days'],
    properties: {
      from: day,
      through: day,
      days: {
        type: 'array',
        description: 'Only the days with a reminder due.',
        items: {
          type: 'object',
          required: ['date', 'send_at', 'reminders'],
          properties: {
            date: day,
            send_at: {
              type: 'string',
              format: 'date-time',
              description: 'When that morning’s email is due, with the account’s offset that day.'
            },
            reminders: {
              type: 'array',
              items: {
                type: 'object',
                required: ['upcoming', 'date', 'when', 'line'],
                properties: {
                  upcoming: { type: 'string', description: 'The date’s id.' },
                  date: { ...day, description: 'The day it falls on.' },
                  when: { type: 'string', example: 'In 7 days' },
                  line: { type: 'string', example: 'Mom turns 7.0.0. A major release.' }
                }
              }
            }
          }
        }
      }
    }
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
      'One thing that happened. Each kind keeps its own fields (note.added has `day` and `note`; a reads ' +
      'row `calls` and `tools`); `via` says through ' +
      'what, and a token’s rows name it as `token` and, from 1.4.0, by id as `token_id`.',
    properties: {
      id: { type: 'string', description: 'A cursor for `before` and `after`.' },
      at: { type: 'string', format: 'date-time' },
      kind: {
        type: 'string',
        example: 'note.added',
        description: `Its family is one of ${ACTIVITY_FAMILIES.join(', ')}.`
      },
      via: { type: 'string' },
      token: { type: 'string', description: 'The name of the token it came through.' },
      token_id: {
        type: 'string',
        pattern: '^[0-9a-f]{32}$',
        description:
          'The id of the token it came through, as `GET /v1/me` gives it. Absent on rows written before 1.4.0, ' +
          'and on rows no token wrote.'
      },
      client: { type: 'string' }
    },
    additionalProperties: true
  }
};

const header = (description: string, schema: Doc = { type: 'integer' }): Doc => ({ description, schema });
/** What each scope opens, as the sign-in's consent offers it. */
/** Writes that keep no receipt, so take no Idempotency-Key: a form makes
 * nothing until a note takes it, and Here is a lookup (workers/api-writes.ts). */
const NO_RECEIPT = new Set(['uploads.start', 'places.here']);

const SIGN_IN_SCOPES: Record<string, string> = {
  'notes:write': 'Add notes, and change or delete the notes it adds',
  'media:write': 'Add files to the notes it adds (only beside notes:write)',
  'notes:all': 'Read all your notes, from anywhere, and change their words (only beside notes:write)',
  upcoming: 'Read and change Upcoming dates and their reminders',
  activity: 'Read the activity log, without any words from it'
};

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
    if (route.template.includes('{n}'))
      parameters.push({ name: 'n', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } });
    else if (route.template.includes('{id}') && !route.template.includes('{date}'))
      parameters.push({
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' }
      });
    if (route.method !== 'GET' && !NO_RECEIPT.has(route.name))
      parameters.push({ $ref: '#/components/parameters/Idempotency-Key' });
    if (Array.isArray(operation.parameters)) parameters.push(...(operation.parameters as Doc[]));
    (paths[route.template] ??= {})[route.method.toLowerCase()] = {
      ...operation,
      ...(parameters.length ? { parameters } : {}),
      // One token either way: made in Settings, or by an app's sign-in.
      security: [{ token: route.scope ? [route.scope] : [] }, { signIn: route.scope ? [route.scope] : [] }],
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
          'An app can sign in instead, with OAuth for the resource /v1: the owner chooses the token it gets. ' +
          'Notes come from the owner, shown with “via <token name>”. With `media:write`, a note takes photos, ' +
          'recordings and PDFs, uploaded first to a signed form, and a new note can have a place. With the `upcoming` ' +
          'scope, a token keeps Upcoming dates too, and reads the reminders each morning carries. The guide is at ' +
          '/guide/api/.',
        `Bodies are JSON in UTF-8, at most ${V1_BODY / 1024} KB, which holds the longest note with every ` +
          'character escaped. With `Accept: text/plain`, any answer is ' +
          'text instead: a line, or a line for each thing a list holds, and a note’s words as they are.',
        `Every write but an upload form and Here takes an optional \`Idempotency-Key\`; its receipt answers ` +
          `the same request again for ${V1_RECEIPT_SECONDS / 86400} days, sent through any token of the account. ` +
          'A write that counts toward a limit says where it stands in `RateLimit-*`; a replay counts nothing.',
        `A day in UTC, an account may add ${V1_LIMITS.create} notes, make ${V1_LIMITS.change} other changes, ` +
          `save Upcoming ${V1_LIMITS.upcoming} times and name ${V1_LIMITS.here} spots across its tokens, and ` +
          `upload ${UPLOADS_A_DAY} files with the web's; each token may read ` +
          `${V1_LIMITS.reads.toLocaleString('en-US')} times.`
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
        },
        signIn: {
          type: 'oauth2',
          description:
            'An app signing in: register at /oauth/register (a public client, with its own https or ' +
            'reverse-DNS callback), then the authorization code with PKCE (S256) and `resource` ' +
            'https://notes.yourversionnumber.com/v1. The owner names the token, ticks its scopes from those ' +
            'asked for and picks its expiry; the answer is that API token, with no refresh token. Discovery is ' +
            'at /.well-known/oauth-protected-resource/v1.',
          flows: {
            authorizationCode: {
              authorizationUrl: 'https://notes.yourversionnumber.com/oauth/authorize',
              tokenUrl: 'https://notes.yourversionnumber.com/oauth/token',
              scopes: Object.fromEntries(TOKEN_SCOPES.map((scope) => [scope, SIGN_IN_SCOPES[scope] ?? scope]))
            }
          }
        }
      },
      parameters: {
        'Idempotency-Key': {
          name: 'Idempotency-Key',
          in: 'header',
          description:
            'Any 1 to 128 printable ASCII characters, new for each change. Sent again with the same request, ' +
            'through this token or another of the account’s, it answers the first result again; with a different ' +
            'request it is a 422.',
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
