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
import {
  CHECKIN_NAME_MAX,
  CHECKIN_SOURCES,
  NAMED_BY,
  NAMED_PLACE_SPOTS_MAX,
  NAMED_PLACES_MAX
} from '../../packages/domain/check-ins.ts';
import { MAX_TAG, MAX_TAGS } from '../../packages/domain/tags.ts';
import { UPCOMING_KINDS, UPCOMING_MAX, UPCOMING_TITLE_MAX } from '../../packages/domain/upcoming.ts';
import {
  API_CHANGES,
  API_VERSION,
  FILE_SECONDS,
  ME_DAYS,
  NOTES_PAGE_BYTES,
  RANGE_DAYS_MAX,
  REMINDER_DAYS_MAX,
  V1_BODY,
  V1_ERRORS,
  V1_ROUTES
} from './v1.ts';
import { PAST_NOTES } from './reader.ts';

type Doc = Record<string, unknown>;

const dayParam = { type: 'string', format: 'date' };

const includeUrlsParameter: Doc = {
  name: 'include',
  in: 'query',
  description:
    '`urls` puts each file’s address, and its small copy’s, in the answer, for one read rather than one for ' +
    `each file. They last ${FILE_SECONDS / 60} minutes and are fetched with no token (1.14.0).`,
  schema: { type: 'string', const: 'urls' }
};

/** The groups a reader finds requests in, each route in one. */
const GROUPS: readonly { name: string; description: string; routes: readonly string[] }[] = [
  {
    name: 'Account',
    description: 'Who this token is, what today is, what it may do, and the activity log.',
    routes: ['me', 'token.revoke', 'activity']
  },
  {
    name: 'Notes',
    description: 'Add, read, change and delete notes.',
    routes: ['notes', 'notes.create', 'note', 'notes.edit', 'notes.append', 'notes.delete']
  },
  {
    name: 'Files',
    description: 'Upload photos, recordings and PDFs, add them to notes, and fetch them.',
    routes: ['uploads.start', 'notes.media', 'notes.file', 'notes.media.remove']
  },
  {
    name: 'Tags',
    description: 'The tag row and every tag.',
    routes: ['tags', 'tags.pinned', 'tags.all']
  },
  {
    name: 'Location',
    description: 'Find a city or the spot a device is at, and say where a note or a day was.',
    routes: ['places', 'places.here', 'notes.place', 'notes.place.clear', 'days.place', 'days.place.clear']
  },
  {
    name: 'Archive',
    description: 'Read the days, search, On this day, releases, the map, badges and the mail log.',
    routes: ['days', 'day', 'search', 'on-this-day', 'releases', 'release', 'map.pins', 'badges', 'mail-log']
  },
  {
    name: 'Upcoming dates',
    description: 'Birthdays, anniversaries, trips and events, and the reminders they make.',
    routes: ['upcoming', 'upcoming.batch', 'upcoming.reminders', 'upcoming.delete']
  },
  {
    name: 'Check-ins',
    description: 'The places the account stopped, and the names it remembers.',
    routes: [
      'check-ins',
      'check-ins.add',
      'check-ins.name',
      'check-ins.delete',
      'check-ins.delete-all',
      'check-ins.places',
      'check-ins.places.get',
      'check-ins.places.add',
      'check-ins.places.change',
      'check-ins.places.delete',
      'check-ins.places.delete-check-ins',
      'check-ins.places.tag-check-ins'
    ]
  }
];
const groupOf = (route: string) => GROUPS.find((g) => g.routes.includes(route))!.name;

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
    summary: 'The notes this token wrote, or with notes:read or notes:all every note, on some days, oldest first',
    description:
      `From \`from\` to \`to\`, days in the account’s time zone, both in, at most ${RANGE_DAYS_MAX} days a ` +
      'request; a wider span is `range_too_wide`, so ask in pieces. Each note is as `getNote` reads it. A ' +
      'range with none is an empty list. Only this token’s notes, whatever else the days hold, unless it has ' +
      '`notes:all` (1.10.0) or `notes:read` (1.15.0): then every note on those days, or with `mine=true` its ' +
      'own alone. A page stops ' +
      `at about ${NOTES_PAGE_BYTES / 1024 / 1024} MB (1.14.0), so it may hold fewer than \`limit\`: follow ` +
      '`next` until it is null.',
    parameters: [
      includeUrlsParameter,
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
  days: {
    operationId: 'listDays',
    summary: 'The timeline, newest first: days with notes, an email, a pause or a place',
    description:
      'What a day says of itself, a page at a time, as the web’s timeline lists them, with today on the first ' +
      'page. Its notes come from `listNotes` or `getDay`, so a page stays small. Needs `notes:read` or `notes:all`.',
    parameters: [
      {
        name: 'before',
        in: 'query',
        description: 'Days before this one: `next` from the answer before.',
        schema: dayParam
      },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } }
    ],
    responses: { '200': answer('DayList', 'One line a day: its date, version and how many notes.') }
  },
  day: {
    operationId: 'getDay',
    summary: 'One day: its version, notes, places, weather, and whether it was paused',
    description:
      'A day from the birthday through today; any other is `date_out_of_range`. Its notes come oldest first and ' +
      `stop at about ${NOTES_PAGE_BYTES / 1024 / 1024} MB: \`next\` goes on with \`listNotes\` as its \`after\`, ` +
      'with `from` set to this day. `collected` names the special days it collected, while Show badges is on. ' +
      'Needs `notes:read` or `notes:all`.',
    parameters: [includeUrlsParameter],
    responses: { '200': answer('Day', 'One line a note: its words.') }
  },
  search: {
    operationId: 'searchNotes',
    summary: 'Find notes by words or a tag, newest first',
    description:
      'Every word has to be in a note’s words, places, link names, transcripts or descriptions, as on the web. ' +
      '`q` or `tag` has to come. Reads the whole archive unless `from` and `to` narrow it, and counts as one ' +
      'read. Needs `notes:read` or `notes:all`.',
    parameters: [
      includeUrlsParameter,
      { name: 'q', in: 'query', description: 'At most ten words or quoted phrases.', schema: { type: 'string' } },
      {
        name: 'tag',
        in: 'query',
        description: 'A tag by any spelling: "Road Trip", road-trip and #road-trip are one tag (1.21.0).',
        schema: { type: 'string' }
      },
      { name: 'from', in: 'query', description: 'The first day; left out, the birthday.', schema: dayParam },
      { name: 'to', in: 'query', description: 'The last day; left out, today.', schema: dayParam },
      cursor('after', 'The next page: `next` from the answer before.'),
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } }
    ],
    responses: { '200': answer('SearchResults', 'One line a note: its day and its words.') }
  },
  'on-this-day': {
    operationId: 'onThisDay',
    summary: 'The same day of each earlier release, newest first',
    description:
      `As the morning email’s On this day. A day shows its first ${PAST_NOTES} notes and says \`notes_total\`; ` +
      '`getDay` reads the rest. Only days with notes come. Needs `notes:read` or `notes:all`.',
    parameters: [
      includeUrlsParameter,
      { name: 'date', in: 'query', description: 'Which day to look back from; left out, today.', schema: dayParam },
      { name: 'before', in: 'query', description: 'The next page: `next` from the answer before.', schema: dayParam },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50, default: 10 } }
    ],
    responses: { '200': answer('OnThisDay', 'One line a day: its date, version and how many notes.') }
  },
  releases: {
    operationId: 'listReleases',
    summary: 'Each year of life, newest first, with its days and notes',
    description: 'Needs `notes:read` or `notes:all`.',
    responses: { '200': answer('ReleaseList', 'One line a release: its name and how many notes.') }
  },
  release: {
    operationId: 'getRelease',
    summary: 'One year of life in detail: its days, longest streak, tags and badges',
    description: '`badges` comes only while Show badges is on. Needs `notes:read` or `notes:all`.',
    responses: { '200': answer('ReleaseAnswer', 'Its name and how many notes.') }
  },
  'tags.all': {
    operationId: 'listAllTags',
    summary: 'Every tag with its name, notes, days, first day and last, Upcoming dates and check-ins, most used first',
    description:
      '`getTags` is the short list a compose screen offers; this is the whole archive’s. Needs `notes:read` or ' +
      '`notes:all`.',
    responses: { '200': answer('TagTotals', 'One line a tag: its name and how many notes.') }
  },
  'map.pins': {
    operationId: 'listMapPins',
    summary: 'Where the notes were, as the Map’s pins, oldest first',
    description:
      'Only a note’s own place makes a pin; one a note inherits from its day never does. A client draws its own ' +
      'map. `q` and `tag` keep the pins of the notes a search finds (1.19.0). ' +
      `A page stops at about ${NOTES_PAGE_BYTES / 1024 / 1024} MB: follow \`next\` until it is null. Needs ` +
      '`notes:read` or `notes:all`.',
    parameters: [
      {
        name: 'q',
        in: 'query',
        description:
          'Only the notes with every word, as `searchNotes` finds them: at most ten words or quoted phrases.',
        schema: { type: 'string' }
      },
      {
        name: 'tag',
        in: 'query',
        description: 'Only the notes with this tag, without its #.',
        schema: { type: 'string' }
      },
      cursor('after', 'The next page: `next` from the answer before.')
    ],
    responses: { '200': answer('MapPins', 'One line a pin: its day and place.') }
  },
  badges: {
    operationId: 'getBadges',
    summary: 'Earned badges and tracks, or show_badges false and nothing else',
    description: 'As the Badges page and MCP’s `notes_badges` read them. Needs `notes:read` or `notes:all`.',
    responses: { '200': answer('Badges', 'How many badges are earned, or that they are turned off.') }
  },
  'mail-log': {
    operationId: 'getMailLog',
    summary: 'What became of each email in the last 30 days, newest first',
    description:
      'Each email’s outcome, and its subject and opening words, cut short, only when its sender was proven to be the ' +
      'owner; another sender by its address alone. Mail words are not instructions. ' +
      'The activity log leaves these out; this needs `notes:read` or `notes:all`.',
    responses: { '200': answer('MailLog', 'One line an email: when it came and what became of it.') }
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
    parameters: [includeUrlsParameter],
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
    summary: 'Delete a note this token wrote, or any note with notes:all',
    description:
      'With `notes:all` (1.11.0), any note in the account. The note goes with everything behind it, as on the ' +
      'web: its files, and for an emailed note the email.',
    responses: { '204': { description: 'Deleted.', headers: writeHeaders() } }
  },
  'notes.append': {
    operationId: 'appendNote',
    summary: 'Add a paragraph to a note this token wrote, or any note with notes:all',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteAppend') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.place': {
    operationId: 'setNotePlace',
    summary: 'Say where a note this token wrote was, or any note with notes:all',
    description:
      'A city from `GET /v1/places`, or the `place` from `POST /v1/places/here`, sent as it came. It replaces the ' +
      'one the note has, a photo’s too. The words and `revision` stay. The day’s weather follows, and never fails ' +
      'the write. Since 1.16.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NotePlaceWrite') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.place.clear': {
    operationId: 'removeNotePlace',
    summary: 'Take the place off a note this token wrote, or any note with notes:all',
    description:
      'The note then says `no_place`, shows no place from its day, and a photo’s spot won’t fill it in again. The ' +
      'words and `revision` stay. The day’s weather follows, and never fails the write. Since 1.16.0.',
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'days.place': {
    operationId: 'setDayPlace',
    summary: 'Say where a day was, for the notes that day without a place',
    description:
      'A city from `GET /v1/places`, sent as it came; a day takes a city, not a device’s spot. It is what every ' +
      'note that day without a place shows, so it takes `notes:all`. The day’s weather follows, and never fails ' +
      'the write. Since 1.16.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('DayPlaceWrite') } } },
    responses: { '200': answer('DayPlaceWritten', 'Paris, France', true) }
  },
  'days.place.clear': {
    operationId: 'removeDayPlace',
    summary: 'Take a day’s own place away',
    description:
      'Its notes go back to what they showed without it. Removing a place the day doesn’t have is still a 204. ' +
      'The day’s weather follows, and never fails the write. Since 1.16.0.',
    responses: { '204': { description: 'Removed.', headers: writeHeaders() } }
  },
  'notes.media': {
    operationId: 'addNoteFiles',
    summary: 'Add files to a note this token wrote, or any note with notes:all',
    description:
      'With `notes:all` (1.11.0), any note in the account. ' +
      `Uploads from \`POST /v1/uploads\`, each checked against the bytes that arrived, up to ${MAX_FILES} files on ` +
      'a note in all. It counts as a change. A note takes each upload once; a write refused or lost before it ' +
      'lands leaves the uploads for a retry with the same Idempotency-Key.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NoteMedia') } } },
    responses: { '200': answer('NoteWritten', 'Changed in 4.5.137.', true) }
  },
  'notes.media.remove': {
    operationId: 'removeNoteFile',
    summary: 'Take one file off a note this token wrote, or any note with notes:all',
    description:
      'The file goes with its small copy, transcript and description, and the note’s `revision` changes. The ' +
      'other files keep their numbers, and no later file takes this one. A note with no ' +
      'words can’t lose its last file: `text_required`, so delete the note instead. An emailed file stays in the ' +
      'note’s email, which no client can read, until the note is deleted. Since 1.17.0.',
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
  'check-ins': {
    operationId: 'listCheckIns',
    summary: 'The places you stopped, newest first',
    description:
      'A stay at a time, with its spot and the name it shows. Back-to-back stops at one place read as one, and `ids` ' +
      'lists the check-ins in it. `from` and `to` are your days, a stay going by when it began, up to ' +
      `${RANGE_DAYS_MAX} days; \`before\` is the \`next\` of an earlier page. A stay at an ignored place is ` +
      'hidden: left out here, in the activity log and from each read of one, until the place is unignored (1.20.0). ' +
      'A stay has the tags of every check-in in it (1.21.0). Since 1.18.0.',
    parameters: [
      { name: 'from', in: 'query', description: 'First day, YYYY-MM-DD.', schema: { type: 'string', format: 'date' } },
      {
        name: 'to',
        in: 'query',
        description: 'Last day; `from` if left out.',
        schema: { type: 'string', format: 'date' }
      },
      { name: 'before', in: 'query', description: 'The `next` of an earlier page.', schema: { type: 'string' } },
      {
        name: 'tag',
        in: 'query',
        description: 'Only the stays with this tag, by any spelling (1.21.0).',
        schema: { type: 'string' }
      },
      {
        name: 'limit',
        in: 'query',
        description: 'Stays a page holds.',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 }
      }
    ],
    responses: { '200': answer('CheckIns', 'Each stay’s time and name, a line each.') }
  },
  'check-ins.add': {
    operationId: 'addCheckIn',
    summary: 'Send a stop, as a phone is told of it',
    description:
      'Forward each report as it comes, with an Idempotency-Key. A later report with the same `source` and arrival, ' +
      'to the second, is the same stay: it fills in `left` and answers 200, not 201, so a client keeps no ids. A ' +
      'report with no arrival is matched by its `left`. A `tap` sends the moment it was tapped as `arrived`, and is ' +
      `never continued. Times over a week ahead are refused; older ones are fine, since a phone can be offline. The ` +
      `first ${V1_LIMITS.lookups} new stays a UTC day get their \`district\`, one paid lookup each, and those past that ` +
      `are still saved with none; RateLimit-Limit counts those. After ${V1_LIMITS.checkin} reports a day, \`rate_limited\`. ` +
      'A new stop at an ignored place is not kept (1.20.0): it answers 200 with `kept` false and `check_in` as it ' +
      'would have read, its `place` naming the ignored place, and its `id` naming no check-in. A report filling in ' +
      'a stop kept before the place was ignored still lands. A new stop at a remembered place has that place’s tags ' +
      '(1.21.0). Since 1.18.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('CheckInReport') } } },
    responses: {
      '200': answer('CheckInReported', 'Checked in at Home.', true),
      '201': answer('CheckInReported', 'Checked in at Home.', true)
    }
  },
  'check-ins.name': {
    operationId: 'nameCheckIn',
    summary: 'Name or tag a stay, or take its name away',
    description:
      'A name on this stay alone, on every check-in in it, beating any remembered place. This token’s own, or any ' +
      'with `notes:all`. `revision` is the one you read. To name every stop at a spot, remember the place instead. ' +
      'Send `name`, `tags` or both (1.21.0): `tags` is the whole list, by name, set on every check-in in the stay. ' +
      'Since 1.18.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('CheckInName') } } },
    responses: { '200': answer('CheckInWritten', 'Checked in at Home.', true) }
  },
  'check-ins.delete': {
    operationId: 'deleteCheckIn',
    summary: 'Delete a stay',
    description:
      'Every check-in in the stay goes, and its row in the activity log. `checkin.deleted` stays there with its ' +
      '`day` and `count`, and never the place. This token’s own, or any with `notes:all`. Since 1.18.0.',
    responses: { '204': { description: 'Deleted.', headers: writeHeaders() } }
  },
  'check-ins.delete-all': {
    operationId: 'deleteAllCheckIns',
    summary: 'Delete every check-in',
    description:
      'Needs `?confirm=all`. Remembered places stay. One `checkin.deleted` row stays in the activity log with the ' +
      '`count`. Since 1.18.0.',
    parameters: [
      {
        name: 'confirm',
        in: 'query',
        required: true,
        description: 'all, to say you mean it.',
        schema: { type: 'string', enum: ['all'] }
      }
    ],
    responses: { '200': answer('CheckInsDeleted', 'Deleted 12.', true) }
  },
  'check-ins.places': {
    operationId: 'listNamedPlaces',
    summary: 'The places you remember',
    description:
      'Each name with its spots, and whether it is `ignored` (1.20.0). The nearest within 100 m names a stop. Since 1.18.0.',
    responses: { '200': answer('NamedPlaces', 'Their names, a line each.') }
  },
  'check-ins.places.get': {
    operationId: 'getNamedPlace',
    summary: 'One remembered place, and how many check-ins are there',
    description:
      '`check_ins` counts the stays at it, hidden or not: a stay is at the remembered place nearest where it began. ' +
      'Show it before deleting them with DELETE /v1/check-ins/places/{id}/check-ins. Since 1.20.0.',
    responses: { '200': answer('NamedPlaceCounted', 'Its name and count.') }
  },
  'check-ins.places.add': {
    operationId: 'rememberPlace',
    summary: 'Remember a place, or add a spot to a name',
    description:
      'A name already in use, ignoring case, gains this spot and answers 200; a new one answers 201. It applies at ' +
      `once to every stop within 100 m, past and future. An account has up to ${NAMED_PLACES_MAX} names, and a name up ` +
      `to ${NAMED_PLACE_SPOTS_MAX} spots. \`ignored\` true ignores it as it is remembered, and false unignores it ` +
      '(1.20.0). `tags` join the place’s, and every new stop there gets them; when the place gains one, the answer ' +
      'counts its `check_ins`, to offer tagging them (1.21.0). Since 1.18.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NamedPlaceWrite') } } },
    responses: {
      '200': answer('NamedPlaceWritten', 'Its name.', true),
      '201': answer('NamedPlaceWritten', 'Its name.', true)
    }
  },
  'check-ins.places.change': {
    operationId: 'renameNamedPlace',
    summary: 'Rename a remembered place, or ignore it',
    description:
      'Send `name`, `ignored`, or both. Every spot and stop follows a new name, and a name another place has is ' +
      'refused. Ignored (1.20.0, Jamie’s call): no new stop there is kept, and the stops already there are hidden, ' +
      'not deleted, from every list, the activity log and the Map. False brings them back. `tags` is the place’s ' +
      'whole list, by name, for the stops to come; the stops already there keep theirs. When it gains a tag, the ' +
      'answer counts its `check_ins` (1.21.0, Jamie’s call). Since 1.18.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('NamedPlaceName') } } },
    responses: { '200': answer('NamedPlaceWritten', 'Its name.', true) }
  },
  'check-ins.places.delete': {
    operationId: 'forgetNamedPlace',
    summary: 'Forget a remembered place',
    description:
      'All its spots go, and stops there show their neighbourhood again. Forgetting an ignored place brings its ' +
      'stops back. Since 1.18.0.',
    responses: { '204': { description: 'Forgotten.', headers: writeHeaders() } }
  },
  'check-ins.places.delete-check-ins': {
    operationId: 'deleteCheckInsAtPlace',
    summary: 'Delete the check-ins at a remembered place',
    description:
      'Every stay at it, hidden or not, and their rows in the activity log; the place stays, ignored or not. ' +
      '`count` is the `check_ins` GET /v1/check-ins/places/{id} answered, and a different number now is ' +
      '`revision_mismatch` with the new `count`. One `checkin.deleted` row stays in the log with the place’s id and ' +
      'the count. Since 1.20.0.',
    parameters: [
      {
        name: 'count',
        in: 'query',
        required: true,
        description: 'How many check-ins you were shown.',
        schema: { type: 'integer', minimum: 0 }
      }
    ],
    responses: { '200': answer('CheckInsDeleted', 'Deleted 12.', true) }
  },
  'check-ins.places.tag-check-ins': {
    operationId: 'tagCheckInsAtPlace',
    summary: 'Tag the check-ins already at a remembered place',
    description:
      'The tags sent join every stay at it, hidden or not; nothing else changes. Offer it once, with the count, ' +
      'when a place gains a tag (Jamie’s call). `count` is the `check_ins` the place’s answer or GET ' +
      '/v1/check-ins/places/{id} gave, and a different number now is `revision_mismatch` with the new `count`. ' +
      'Answers how many stays were `tagged`; one `checkin.tagged` row goes in the log with the place’s id and that ' +
      'count. Since 1.21.0.',
    requestBody: { required: true, content: { 'application/json': { schema: ref('PlaceCheckInsTag') } } },
    responses: { '200': answer('CheckInsTagged', 'Tagged 12.', true) }
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
    description: `The pinned tags, then the tags used most in the last ${RECENT_DAYS} days that aren't pinned, ties broken by last use. A token that adds or reads notes may read it (any token before 1.22.0).`,
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
  lived = {
    type: 'object',
    required: ['week', 'day'],
    description:
      'Weeks and days lived, both from 1, as the Today page and the morning email set them ' +
      '("Week 2,826 — Day 19,779"): `day` grows by one a day, and `week` is (day − 1) ÷ 7, rounded down, plus 1. ' +
      'Since 1.13.0.',
    properties: { week: { type: 'integer', minimum: 1 }, day: { type: 'integer', minimum: 1 } }
  },
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
          revision: { type: 'string', description: 'With revision_mismatch: the note’s current revision.' },
          count: {
            type: 'integer',
            minimum: 0,
            description:
              'With revision_mismatch from DELETE /v1/check-ins/places/{id}/check-ins: how many check-ins are there now (1.20.0).'
          }
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
      supporting_member: {
        type: 'boolean',
        description:
          'Whether the account gets what Supporting Members of the Weekly Thing get, as Release Notes last looked ' +
          '(every nine days, and at a web sign-in); Changelog offers its other app icons by it. Since 1.12.0.'
      },
      lived,
      days: {
        type: 'array',
        description: `${ME_DAYS} days from today; a birthday shows as a new major or minor version on its day.`,
        items: { type: 'object', required: ['date', 'version'], properties: { date: day, version, lived } }
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
      place: ref('NotePlace'),
      markup: {
        anyOf: [{ type: 'string', const: 'rich' }, { type: 'null' }],
        description:
          '`rich` when `text` holds rich-text marks; left out or null, the words are plain. An edit keeps it. ' +
          'Since 1.16.0.'
      },
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description:
          'Tags by name, with spaces or emoji: "Road Trip", "🚗 Lake". A leading # is dropped. The hashtags in `text` are tags too, after these (1.21.0).'
      }
    }
  },
  NotePlaceWrite: {
    type: 'object',
    required: ['place'],
    additionalProperties: false,
    properties: { place: ref('NotePlace') }
  },
  DayPlaceWrite: {
    type: 'object',
    required: ['place'],
    additionalProperties: false,
    properties: { place: ref('City') }
  },
  DayPlaceWritten: {
    type: 'object',
    required: ['date', 'place'],
    properties: { date: day, place: ref('NotePlaceRead') }
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
    properties: {
      text,
      revision: { type: 'string', description: 'The revision last read, unchanged.' },
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description:
          'The note’s whole list of tags by name, with the hashtags in `text` after them. Left out, it keeps the tags its old text didn’t carry (1.21.0).'
      }
    }
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
      mine: { type: 'boolean', description: 'Whether this token wrote it (1.10.0).' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Its tags’ keys: "Road Trip" is road-trip (1.14.0; from the tags field too since 1.21.0).'
      },
      tag_names: {
        type: 'array',
        items: { type: 'string' },
        description: 'Its tags’ names as written, one for each of `tags` (1.21.0).'
      },
      markup: {
        anyOf: [{ type: 'string', const: 'rich' }, { type: 'null' }],
        description: '`rich` when `text` holds rich-text marks, null when it is plain (1.14.0).'
      },
      parts: {
        type: 'array',
        description:
          'Its words cut up to show them: strings, links by name and hashtags, in order (1.14.0). A rich ' +
          'note’s parts carry the marks as typed.',
        items: {
          anyOf: [
            { type: 'string' },
            {
              type: 'object',
              required: ['url', 'label'],
              properties: { url: { type: 'string' }, label: { type: 'string' }, site: { type: 'string' } }
            },
            {
              type: 'object',
              required: ['tag', 'text'],
              properties: { tag: { type: 'string' }, text: { type: 'string' } }
            }
          ]
        }
      },
      place: {
        anyOf: [ref('NotePlaceRead'), { type: 'null' }],
        description: 'The note’s own place, never one it inherits from its day (1.14.0).'
      },
      no_place: { type: 'boolean', description: 'The owner removed its place (1.14.0).' },
      edited_at: {
        anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
        description: 'When its words last changed, or null if they never have (1.14.0).'
      },
      tz: { type: 'string', description: 'The zone it was written in (1.14.0).' },
      late: { type: 'boolean', description: 'Written after the day it is filed on had ended (1.14.0).' },
      author: {
        type: 'string',
        enum: ['user', 'assistant'],
        description: '`assistant` when an agent wrote it, in its own voice (1.14.0).'
      },
      client: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'The app or agent that sent it, by the name it gives itself (1.14.0).'
      },
      from: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'What it was imported from, or null (1.14.0).'
      },
      attachments: {
        type: 'integer',
        minimum: 0,
        description: 'How many files its email carried that Release Notes did not keep (1.14.0).'
      }
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
              height: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
              url: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] }
            }
          },
          { type: 'null' }
        ],
        description: 'The small copy, when it has one: ask with size=thumb, or `url` here with `include=urls` (1.14.0).'
      },
      transcript: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description:
          'A recording’s words, once the owner’s opt-in transcript is kept, up to 50,000 characters (1.14.0). ' +
          'Null until then, for a recording never written out, and when nothing could be made out. Reading never ' +
          'starts one, and one arriving does not change the note’s `revision`.'
      },
      description: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'A photo’s description, once the owner’s opt-in one is kept, or null (1.14.0).'
      },
      writing: { type: 'boolean', description: 'A transcript of this recording is still to come (1.14.0).' },
      url: {
        anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }],
        description: 'With `include=urls`: the file’s address, fetched with no token (1.14.0).'
      },
      expires_in: { type: 'integer', description: 'With `include=urls`: seconds its addresses last (1.14.0).' }
    }
  },
  NotePlaceRead: {
    type: 'object',
    required: ['label'],
    properties: {
      label: { type: 'string', description: 'The place as one line, as the web shows it.' },
      map: { anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }] },
      venue: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      district: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      city: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      region: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      country: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      lat: { anyOf: [{ type: 'number' }, { type: 'null' }] },
      lon: { anyOf: [{ type: 'number' }, { type: 'null' }] }
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
  DayHead: {
    type: 'object',
    required: ['date', 'version', 'place', 'around', 'weather'],
    properties: {
      date: day,
      version: { type: 'string' },
      place: { anyOf: [ref('NotePlaceRead'), { type: 'null' }], description: 'The place set on the day itself.' },
      around: {
        anyOf: [
          {
            type: 'object',
            required: ['label', 'from'],
            properties: { label: { type: 'string' }, from: { type: 'string', enum: ['day', 'home'] } }
          },
          { type: 'null' }
        ],
        description: 'What a note with no place and `no_place` false shows: the day’s, or else home.'
      },
      weather: {
        anyOf: [
          {
            type: 'object',
            required: ['line'],
            properties: {
              high_c: { type: 'number' },
              low_c: { type: 'number' },
              code: { type: 'number' },
              city: { type: 'string' },
              line: { type: 'string', description: 'As the web says it.' }
            }
          },
          { type: 'null' }
        ]
      }
    }
  },
  DayList: {
    type: 'object',
    required: ['today', 'tz', 'days', 'next'],
    properties: {
      today: day,
      tz: { type: 'string' },
      days: {
        type: 'array',
        items: {
          allOf: [
            ref('DayHead'),
            {
              type: 'object',
              required: ['notes_total', 'files', 'emailed', 'paused'],
              properties: {
                notes_total: { type: 'integer' },
                files: { type: 'integer' },
                emailed: { type: 'boolean', description: 'The morning email went out that day.' },
                paused: { type: 'boolean' }
              }
            }
          ]
        }
      },
      next: { anyOf: [day, { type: 'null' }], description: 'The `before` for the next page.' },
      weather_credit: { type: 'string', description: 'Show this wherever the weather shows.' }
    }
  },
  Day: {
    allOf: [
      ref('DayHead'),
      {
        type: 'object',
        required: ['today', 'tz', 'paused', 'notes_total', 'notes', 'next'],
        properties: {
          today: { type: 'boolean', description: 'This day is today.' },
          tz: { type: 'string' },
          paused: { type: 'boolean' },
          collected: { type: 'array', items: { type: 'object' } },
          notes_total: { type: 'integer' },
          notes: { type: 'array', items: ref('Note') },
          next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `after` for `listNotes`.' },
          weather_credit: { type: 'string', description: 'Show this wherever the weather shows.' }
        }
      }
    ]
  },
  SearchResults: {
    type: 'object',
    required: ['terms', 'tag', 'from', 'to', 'total', 'items', 'next'],
    properties: {
      terms: { type: 'array', items: { type: 'string' }, description: 'What was looked for, as it was read.' },
      tag: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      from: day,
      to: day,
      total: { type: 'integer', description: 'Every note found, across every page.' },
      items: { type: 'array', maxItems: 100, items: ref('Note') },
      next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `after` for the next page.' }
    }
  },
  OnThisDay: {
    type: 'object',
    required: ['date', 'version', 'days', 'next'],
    properties: {
      date: day,
      version: { type: 'string' },
      days: {
        type: 'array',
        items: {
          type: 'object',
          required: ['date', 'version', 'notes_total', 'notes'],
          properties: {
            date: day,
            version: { type: 'string' },
            notes_total: { type: 'integer' },
            notes: { type: 'array', items: ref('Note') }
          }
        }
      },
      next: { anyOf: [day, { type: 'null' }], description: 'The `before` for the next page.' }
    }
  },
  ReleaseList: {
    type: 'object',
    required: ['today', 'releases'],
    properties: {
      today: day,
      releases: {
        type: 'array',
        items: {
          type: 'object',
          required: ['v', 'from', 'through', 'days', 'notes', 'current'],
          properties: {
            v: { type: 'string' },
            from: day,
            through: day,
            days: { type: 'integer' },
            notes: { type: 'integer' },
            current: { type: 'boolean' }
          }
        }
      }
    }
  },
  ReleaseAnswer: {
    type: 'object',
    required: ['today', 'release'],
    properties: {
      today: day,
      release: {
        type: 'object',
        required: ['v', 'current', 'from', 'through', 'days_with_notes', 'notes', 'longest', 'paused_days', 'tags'],
        properties: {
          v: { type: 'string' },
          current: { type: 'boolean' },
          from: day,
          through: day,
          days_with_notes: { type: 'integer' },
          notes: { type: 'integer' },
          first_note_day: { anyOf: [day, { type: 'null' }] },
          last_note_day: { anyOf: [day, { type: 'null' }] },
          longest: { type: 'integer', description: 'The longest streak of days that year.' },
          paused_days: { type: 'integer' },
          badges: { type: 'array', items: { type: 'object' } },
          tags: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              required: ['tag', 'name', 'notes'],
              properties: { tag: { type: 'string' }, name: { type: 'string' }, notes: { type: 'integer' } }
            }
          },
          tags_total: { type: 'integer' }
        }
      }
    }
  },
  TagTotals: {
    type: 'object',
    required: ['tags'],
    properties: {
      tags: {
        type: 'array',
        items: {
          type: 'object',
          required: ['tag', 'name', 'notes', 'days', 'first', 'last', 'upcoming', 'check_ins'],
          properties: {
            tag: { type: 'string', description: 'Its key.' },
            name: { type: 'string', description: 'As most recently written (1.21.0).' },
            notes: { type: 'integer' },
            days: { type: 'integer' },
            first: { anyOf: [day, { type: 'null' }], description: 'Null for a tag no note or check-in has.' },
            last: { anyOf: [day, { type: 'null' }] },
            upcoming: {
              anyOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Upcoming dates with it; null without the `upcoming` scope (1.21.0).'
            },
            check_ins: {
              anyOf: [{ type: 'integer' }, { type: 'null' }],
              description: 'Check-ins with it; null without the `activity` scope (1.21.0).'
            }
          }
        }
      }
    }
  },
  MapPins: {
    type: 'object',
    required: ['notes', 'pins', 'next'],
    properties: {
      notes: { type: 'integer', description: 'Every note in the archive, placed or not.' },
      pins: {
        type: 'array',
        items: {
          type: 'object',
          required: [
            'date',
            'id',
            'lat',
            'lon',
            'place',
            'exact',
            'tags',
            'tag_names',
            'release',
            'version',
            'text',
            'parts'
          ],
          properties: {
            date: day,
            id: { type: 'string' },
            lat: { type: 'number' },
            lon: { type: 'number' },
            place: { type: 'string' },
            exact: {
              type: 'boolean',
              description: 'False when a city was chosen: it stands for the city, not a spot.'
            },
            tags: { type: 'array', items: { type: 'string' } },
            tag_names: {
              type: 'array',
              items: { type: 'string' },
              description: 'Its tags’ names, one for each of `tags` (1.21.0).'
            },
            release: { type: 'string' },
            version: { type: 'string' },
            text: { type: 'string', description: 'The note’s opening words.' },
            written_at: {
              anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
              description: 'When the note was written (1.19.0): a day’s pins come in no order of their own.'
            },
            parts: { type: 'array', items: {} }
          }
        }
      },
      next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `after` for the next page.' }
    }
  },
  Badges: {
    type: 'object',
    required: ['today', 'version', 'show_badges'],
    description: 'While `show_badges` is true, what the Badges page reads too: what is earned, and the tracks.',
    properties: { today: day, version: { type: 'string' }, show_badges: { type: 'boolean' } },
    additionalProperties: true
  },
  MailLog: {
    type: 'object',
    required: ['today', 'tz', 'entries'],
    properties: {
      today: day,
      tz: { type: 'string' },
      entries: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'received_at', 'via', 'outcome', 'attempts', 'notified'],
          properties: {
            id: { type: 'string' },
            received_at: { type: 'string' },
            via: { type: 'string' },
            day: { anyOf: [day, { type: 'null' }] },
            version: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            subject: { type: 'string' },
            outcome: { type: 'string' },
            reason: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            sender: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            text: { type: 'string' },
            cut: { type: 'boolean', description: 'The subject or words were cut short.' },
            attempts: { type: 'integer' },
            notified: { type: 'boolean' }
          }
        }
      }
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
    required: ['pinned', 'pinned_names', 'recent', 'window_days'],
    properties: {
      pinned: { type: 'array', maxItems: PINS_MAX, items: { type: 'string' }, description: 'Their keys.' },
      pinned_names: {
        type: 'array',
        maxItems: PINS_MAX,
        items: { type: 'string' },
        description: 'Their names, as pinned (1.21.0).'
      },
      recent: {
        type: 'array',
        maxItems: RECENT_MAX,
        items: {
          type: 'object',
          required: ['tag', 'name', 'count', 'last_used'],
          properties: {
            tag: { type: 'string' },
            name: { type: 'string', description: 'As most recently written (1.21.0).' },
            count: { type: 'integer' },
            last_used: day
          }
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
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description:
          'Its tags by name, the whole list, like ["Family", "Road Trip"] (1.21.0). A leading # is dropped; "Road Trip" and "road trip" are one tag.'
      },
      tag_names: {
        type: 'array',
        items: { type: 'string' },
        readOnly: true,
        description: 'The names of its tags, as `tags` lists their keys (1.21.0).'
      },
      tag: {
        anyOf: [{ type: 'string', maxLength: MAX_TAG }, { type: 'null' }],
        deprecated: true,
        description:
          'Its first tag’s key. Deprecated in 1.21.0, gone in the next release: send `tags`. Sent alone, it names the first tag and keeps the others.'
      },
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
  CheckIn: {
    type: 'object',
    description: 'A stay: one check-in, or back-to-back ones at one place.',
    required: ['id', 'ids', 'at', 'arrived', 'left', 'lat', 'lon', 'day', 'source', 'label', 'named_by', 'revision'],
    properties: {
      id: { type: 'string', description: 'Its first check-in’s id; any in `ids` names the stay.' },
      ids: { type: 'array', items: { type: 'string' }, description: 'The check-ins in it, oldest first.' },
      at: { type: 'string', format: 'date-time', description: 'When it began, or when it was first heard of.' },
      arrived: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'Null if unknown.' },
      left: {
        anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
        description: 'Null while still there, and for a tap.'
      },
      lat: { type: 'number' },
      lon: { type: 'number' },
      accuracy_m: { anyOf: [{ type: 'number' }, { type: 'null' }], description: 'The circle’s radius.' },
      time_zone: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The zone there.' },
      day,
      source: { type: 'string', enum: [...CHECKIN_SOURCES] },
      label: { type: 'string', description: 'The name it shows.' },
      named_by: { type: 'string', enum: [...NAMED_BY], description: 'How `label` came about.' },
      place: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The remembered place naming it.' },
      name: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'A name on this stay alone.' },
      district: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'Neighbourhood and city.' },
      via: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      token: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      token_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      client: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'The keys of the tags of every check-in in it; left out for none (1.21.0).'
      },
      tag_names: { type: 'array', items: { type: 'string' }, description: 'Their names (1.21.0).' },
      revision: { type: 'integer', description: 'Send it back to name this stay.' }
    }
  },
  CheckIns: {
    type: 'object',
    required: ['items', 'next'],
    properties: {
      items: { type: 'array', items: ref('CheckIn') },
      next: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'The `before` for the next older page.' }
    }
  },
  CheckInWritten: { type: 'object', required: ['check_in'], properties: { check_in: ref('CheckIn') } },
  CheckInReported: {
    type: 'object',
    required: ['check_in'],
    properties: {
      check_in: ref('CheckIn'),
      kept: {
        type: 'boolean',
        description:
          'False when the stop was at an ignored place and nothing was kept; its `check_in` names no check-in. ' +
          'Since 1.20.0: an answer replayed from before then leaves it out, which means true.'
      }
    }
  },
  CheckInsDeleted: { type: 'object', required: ['deleted'], properties: { deleted: { type: 'integer' } } },
  CheckInsTagged: { type: 'object', required: ['tagged'], properties: { tagged: { type: 'integer' } } },
  PlaceCheckInsTag: {
    type: 'object',
    required: ['tags', 'count'],
    additionalProperties: false,
    properties: {
      tags: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description: 'The tags to add, by name.'
      },
      count: { type: 'integer', minimum: 0, description: 'How many check-ins you were shown.' }
    }
  },
  CheckInReport: {
    type: 'object',
    required: ['lat', 'lon', 'source'],
    additionalProperties: false,
    properties: {
      arrived: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }], description: 'Null if unknown.' },
      left: {
        anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
        description: 'Null while still there.'
      },
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      accuracy_m: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
      time_zone: {
        anyOf: [{ type: 'string' }, { type: 'null' }],
        description: 'An IANA name; the account’s if left out.'
      },
      source: { type: 'string', enum: [...CHECKIN_SOURCES] }
    }
  },
  CheckInName: {
    type: 'object',
    required: ['revision'],
    anyOf: [{ required: ['name'] }, { required: ['tags'] }],
    additionalProperties: false,
    properties: {
      name: { anyOf: [{ type: 'string', minLength: 1, maxLength: CHECKIN_NAME_MAX }, { type: 'null' }] },
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description: 'The stay’s whole list of tags by name; [] for none (1.21.0).'
      },
      revision: { type: 'integer', minimum: 1 }
    }
  },
  NamedPlace: {
    type: 'object',
    required: ['id', 'name', 'spots', 'revision'],
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      spots: {
        type: 'array',
        items: {
          type: 'object',
          required: ['lat', 'lon'],
          properties: { lat: { type: 'number' }, lon: { type: 'number' } }
        }
      },
      ignored: {
        type: 'boolean',
        description: 'No stop here is kept, and those kept already are hidden. Since 1.20.0.'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'The keys of the tags each new stop here gets; left out for none (1.21.0).'
      },
      tag_names: { type: 'array', items: { type: 'string' }, description: 'Their names (1.21.0).' },
      revision: { type: 'integer' }
    }
  },
  NamedPlaceCounted: {
    type: 'object',
    required: ['place'],
    properties: {
      place: {
        allOf: [
          ref('NamedPlace'),
          {
            type: 'object',
            required: ['check_ins'],
            properties: { check_ins: { type: 'integer', description: 'Stays at it, hidden or not.' } }
          }
        ]
      }
    }
  },
  NamedPlaces: {
    type: 'object',
    required: ['places'],
    properties: { places: { type: 'array', items: ref('NamedPlace') } }
  },
  NamedPlaceWritten: {
    type: 'object',
    required: ['place'],
    properties: {
      place: {
        allOf: [
          ref('NamedPlace'),
          {
            type: 'object',
            properties: {
              check_ins: {
                type: 'integer',
                description:
                  'When the place gained a tag: the stays already there, to offer tagging them with ' +
                  'PATCH /v1/check-ins/places/{id}/check-ins (1.21.0).'
              }
            }
          }
        ]
      }
    }
  },
  NamedPlaceWrite: {
    type: 'object',
    required: ['name', 'lat', 'lon'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: CHECKIN_NAME_MAX },
      lat: { type: 'number', minimum: -90, maximum: 90 },
      lon: { type: 'number', minimum: -180, maximum: 180 },
      ignored: { type: 'boolean', description: 'Ignore the place, or unignore it. Left out, as it was. Since 1.20.0.' },
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description: 'Tags to join the place’s, by name (1.21.0).'
      }
    }
  },
  NamedPlaceName: {
    type: 'object',
    minProperties: 1,
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1, maxLength: CHECKIN_NAME_MAX },
      ignored: { type: 'boolean', description: 'Ignore the place, or unignore it. Since 1.20.0.' },
      tags: {
        type: 'array',
        maxItems: MAX_TAGS,
        items: { type: 'string', maxLength: MAX_TAG },
        description: 'The place’s whole list of tags by name; [] for none (1.21.0).'
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
      'row `calls` and `tools`; a checkin `checkin`, `label`, `arrived`, `left` and `source`, and never a spot, its ' +
      'label being the one place a row holds your own words); `via` says through ' +
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
  'notes:read': 'Read all your notes, from anywhere, and the days, tags, map and badges made from them',
  'notes:all': 'Read all your notes, from anywhere, and change or delete them (only beside notes:write)',
  upcoming: 'Read and change Upcoming dates and their reminders',
  activity: 'Read the activity log, without any words from it'
};

/** The whole document, as served and as kept in the contract. */
export function openApi(): Doc {
  const paths: Record<string, Record<string, Doc>> = {
    '/v1/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        tags: ['Account'],
        summary: 'This document',
        security: [],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } }
      }
    }
  };
  for (const route of V1_ROUTES) {
    const operation = OPERATIONS[route.name]!,
      parameters: Doc[] = [];
    if (route.template.includes('{date}')) {
      parameters.push({ name: 'date', in: 'path', required: true, schema: day });
      if (route.template.includes('{id}'))
        parameters.push({
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[A-Za-z0-9_.-]{1,80}$' }
        });
    }
    if (route.template.includes('{v}'))
      parameters.push({
        name: 'v',
        in: 'path',
        required: true,
        description: 'A release by name, from `listReleases`.',
        schema: { type: 'string' }
      });
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
      tags: [groupOf(route.name)],
      ...operation,
      ...(parameters.length ? { parameters } : {}),
      // One token either way: made in Settings, or by an app's sign-in.
      // Any one of a route's scopes will do.
      security: (route.scope ? [route.scope, ...(route.also ?? [])] : [null]).flatMap((scope) => [
        { token: scope ? [scope] : [] },
        { signIn: scope ? [scope] : [] }
      ]),
      ...(route.scope ? { 'x-scope': route.scope } : {}),
      ...(route.also ? { 'x-scope-also': route.also } : {}),
      responses: { ...(operation.responses as Doc), default: { $ref: '#/components/responses/Error' } }
    };
  }
  return {
    openapi: '3.1.0',
    tags: GROUPS.map(({ name, description }) => ({ name, description })),
    externalDocs: { description: 'The guide', url: 'https://notes.yourversionnumber.com/guide/api/' },
    info: {
      title: 'Release Notes API',
      version: API_VERSION,
      summary: 'Add notes to Release Notes and read them back, from a terminal, a script or an app.',
      description: [
        'Make a token in Release Notes under Settings, API tokens, and send it as `Authorization: Bearer rn_...`. ' +
          'An app can sign in instead, with OAuth for the resource /v1: the owner chooses the token it gets. ' +
          'Notes come from the owner, shown with “via <token name>”. With `media:write`, a note takes photos, ' +
          'recordings and PDFs, uploaded first to a signed form, and a new note can have a place. With the `upcoming` ' +
          'scope, a token keeps Upcoming dates too, and reads the reminders each morning carries. With `notes:read`, a ' +
          'token reads the whole archive and writes nothing (1.15.0). The guide is at /guide/api/, all of it in ' +
          'one file for agents at /guide/api/llms.txt, and what each version added at /guide/api/changelog/.',
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
