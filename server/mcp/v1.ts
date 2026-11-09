/** The public API, `/v1` (docs/API.md), on the MCP Web Function: the same
 * reader role, strong reads of the bearer, and every write handed to the
 * private capture function (workers/api-writes.ts), which checks the token
 * again in the transaction it writes. Only an API token opens it; no
 * cookie, and no MCP access token, is ever read here. Not for browsers: no
 * CORS, and any Origin but the site's is refused. */
import {
  activityId,
  activityTime,
  ACTIVITY_FAMILIES,
  familyOf,
  tokenActivityView,
  titled
} from '../../packages/domain/activity.ts';
import {
  addDays,
  iso,
  localDay,
  localMoment,
  localStart,
  validDay,
  validTimezone
} from '../../packages/domain/dates.ts';
import { placeLabel, writtenAt, type NoteRecord, type PlaceRecord } from '../../packages/domain/notes.ts';
import { isRich, RICH } from '../../packages/domain/rich.ts';
import { TAG_REFUSALS, spelling, split, storedTags, tagTotals } from '../../packages/domain/tags.ts';
import { codePointLength, pythonTrim, wellFormed } from '../../packages/domain/unicode.ts';
import { computeStreak, pauseDays } from '../../packages/domain/streak.ts';
import { remindersFor, UPCOMING_MAX, upcomingViews } from '../../packages/domain/upcoming.ts';
import { collectedOn, evaluateBadges } from '../../packages/domain/badges.ts';
import { computeVersion, lifeCount, releaseAge, sameDayBefore } from '../../packages/domain/version.ts';
import { searchTerms, searchedText } from '../../packages/domain/search.ts';
import { namedPlaceView, stayTags, stayView, tagLists } from '../../packages/domain/check-ins.ts';
import { badgeFacts } from '../../packages/backend/badges.ts';
import { everyStay, stayPage, staysAt, type CheckInReads } from '../../packages/backend/check-ins.ts';
import { segments, type Link } from '../../packages/backend/links.ts';
import { pins } from '../../packages/backend/maps.ts';
import { others } from '../../packages/backend/media.ts';
import type { OAuthRow } from '../../packages/backend/oauth.ts';
import { search, type City } from '../../packages/backend/places.ts';
import { tagRow, type TagRowStore } from '../../packages/backend/tag-row.ts';
import { stillWriting } from '../../packages/backend/views.ts';
import { dayLine, dayPlace, fahrenheit, placeOf, type Reading } from '../../packages/backend/weather.ts';
import { supportingMember } from '../../packages/backend/weekly-thing.ts';
import {
  accountId,
  checkToken,
  clientProduct,
  SCOPE_REFUSALS,
  scopesOf,
  V1_LIMITS
} from '../../packages/backend/tokens.ts';
import { failure, object } from './common.ts';
import {
  agentMailView,
  agentUpcomingView,
  editRevision,
  PAST_NOTES,
  RAW_TERMS,
  record,
  releaseDetail,
  placeView,
  releaseList,
  type MediaReader,
  type ReaderContext,
  type ReaderStore
} from './reader.ts';
import type { McpOptions } from './app.ts';

export const API_VERSION = '1.22.2';
/** What each version changed, newest first, served as the OpenAPI file's
 * `x-changes`: `/v1` only ever gains things, and a deprecation is announced
 * here with its date. The exceptions are 1.8.0, which withdrew 1.6.0's
 * `moment` before any released app sent one (Jamie, 2026-10-30), and 1.22.0,
 * which closed GET /v1/tags to tokens that neither add nor read notes (Jamie,
 * 2026-11-08, product call 9 of the security audit). A new version starts
 * with its entry. */
export const API_CHANGES: readonly { version: string; date: string; summary: string }[] = [
  {
    version: '1.22.2',
    date: '2026-11-09',
    summary:
      'POST /v1/check-ins/places, on a name already remembered, and PATCH /v1/check-ins/places/{id}/check-ins refuse tags that would take the place, or any stay there, past 20, with `invalid_request` on `tags` and nothing written, as a tags field refuses a 21st tag. Before, the tags past 20 were silently left off. No other request changed.'
  },
  {
    version: '1.22.1',
    date: '2026-11-09',
    summary:
      "Signing in: POST /oauth/register counts every new client against the one 200 an hour for everyone again, the Changelog app's too, since 1.21.5's separate count went by redirect URIs any client can claim. Each network's own limits, an IPv6 /48's among them, are unchanged. No request changed."
  },
  {
    version: '1.22.0',
    date: '2026-11-08',
    summary:
      'GET /v1/tags, the tag row, needs a token that adds or reads notes: `notes:write` or `notes:read` (`notes:all` comes with `notes:write`). A token for Upcoming or the activity log alone now gets `scope_required`, where before any token could read the recent tag names. Changelog and every app that adds notes are unchanged. This is the second exception to `/v1` only gaining things, after 1.8.0.'
  },
  {
    version: '1.21.7',
    date: '2026-11-08',
    summary:
      'POST /v1/check-ins keeps no spot or time in its 7-day Idempotency-Key receipt that the answer shows as the request sent (`lat`, `lon`, `accuracy_m`, `arrived`, `left`, `at`): a replay, which has the same request, fills them back in. So a stop at an ignored place, or one deleted since, leaves no spot or time behind. A replay answers exactly as before, and no request changed.'
  },
  {
    version: '1.21.6',
    date: '2026-11-08',
    summary:
      "POST /v1/check-ins and PATCH /v1/check-ins/{id} answer a token with neither `activity` nor `notes:all` with empty `tags` and `tag_names` when a stop took them from a remembered place, as they already hid the place's name. Tags the token sends in the PATCH show as sent. The stop keeps its tags, and a token that reads the log sees them. No request changed."
  },
  {
    version: '1.21.5',
    date: '2026-11-08',
    summary:
      "Signing in: an authorization code that comes back to POST /oauth/token after it was spent ends the connection it made, refresh token and all (RFC 6749, 4.1.2), as an app's code already did. The OAuth requests count an IPv6 /48 as well as each /64, at three times the /64's limit, and the Changelog app's registrations count apart from the 200 new clients an hour for everyone. No request changed."
  },
  {
    version: '1.21.4',
    date: '2026-11-08',
    summary:
      "GET /v1/mail-log keeps an email's `subject` only when its sender was proven to be the owner, as they already did its words: from another sender, or with failed authentication, spam or a virus, or to a replaced or stopped address, `subject` is empty, and another sender's `sender` is its From line's addresses alone. Anyone can write either. No request changed; the activity log never carried either."
  },
  {
    version: '1.21.3',
    date: '2026-11-08',
    summary:
      "POST /v1/uploads's 200 files and 2 GB a UTC day are the account's across the web, its tokens and, now, files attached to notes sent by email, since each photo is described and may be placed. No request or answer changed otherwise."
  },
  {
    version: '1.21.2',
    date: '2026-11-08',
    summary:
      "Signing in: POST /oauth/register answers invalid_client_metadata for a client_name that reads as Changelog, Claude or ChatGPT unless every redirect is that client's own (Changelog's com.yourversionnumber.changelog scheme, claude.ai or claude.com, chatgpt.com or chat.openai.com) or loopback, since the approval page leads with the name. The approval page also says where Allow sends the answer, and for a website's redirect Cancel links back with access_denied instead of going there. An app's own scheme gets access_denied straight back, as before."
  },
  {
    version: '1.21.1',
    date: '2026-11-08',
    summary:
      "POST /v1/places/here's 100 spots a UTC day are the account's across its tokens and the web's Here together, since each is a paid lookup, and its rate_limited message says so. No request or answer changed otherwise."
  },
  {
    version: '1.21.0',
    date: '2026-11-08',
    summary:
      'Tags are first-class. A tag has a name, as written, with spaces or emoji ("Road Trip", "🚗 Lake"), and a key ("road-trip") that matches every spelling; `tags` still lists keys and the new `tag_names` lists the names beside them. POST /v1/notes and PUT /v1/notes/{date}/{id} take `tags`, by name, besides the hashtags in the text. Upcoming dates take `tags`, several of them; the single `tag` keeps working and is deprecated, and its removal will be announced here with a date. Check-ins and remembered places carry tags: a new stop at a place gets the place’s, PATCH /v1/check-ins/{id} and the places routes take `tags`, a place that gains a tag answers how many `check_ins` it has, and PATCH /v1/check-ins/places/{id}/check-ins tags them for that count. GET /v1/check-ins takes `tag`. Every `tag` filter takes any spelling. GET /v1/tags/all says each tag’s `name` and counts its Upcoming dates and check-ins, and GET /v1/tags adds `pinned_names` and a `name` on each recent tag. The activity log adds `checkin.tagged`.'
  },
  {
    version: '1.20.0',
    date: '2026-11-08',
    summary:
      'A remembered place can be ignored: PATCH or POST /v1/check-ins/places takes `ignored`, and each place says it. No new stop at an ignored place is kept: POST /v1/check-ins answers 200 with `kept` false. The stops already there are hidden, not deleted, from GET /v1/check-ins, each read of one and the activity log, and come back when it is unignored. GET /v1/check-ins/places/{id} counts the check-ins at a place, hidden or not, and DELETE /v1/check-ins/places/{id}/check-ins?count= deletes them for that count. The activity log adds `checkin.ignored` and `checkin.unignored`, with the place’s id, and a `checkin.deleted` with a `place`.'
  },
  {
    version: '1.19.0',
    date: '2026-11-08',
    summary:
      'GET /v1/map/pins takes `q` and `tag` as GET /v1/search does, and keeps only the pins of the notes with every word and the tag, so an app can show what a search finds on its own map. Left out, every pin comes, as before. Each pin says its note’s `written_at`, so the notes of a day can be put in the order they were written.'
  },
  {
    version: '1.18.2',
    date: '2026-11-06',
    summary:
      'The description links two new pages: the guide in one file for agents, at /guide/api/llms.txt, and this list as a changelog with a feed, at /guide/api/changelog/. No request or answer changed.'
  },
  {
    version: '1.18.1',
    date: '2026-11-06',
    summary:
      'The API description groups its requests with tags, links the guide, and can be fetched from a page in a browser, so tools that show it can load it. No request or answer changes.'
  },
  {
    version: '1.18.0',
    date: '2026-11-06',
    summary:
      'Check-ins, the places you stop. POST /v1/check-ins sends a stop as a phone is told of it, and a later report of the same stay fills it in. GET /v1/check-ins lists them newest first with their spots and the names they show, and back-to-back stops at one place read as one. PATCH and DELETE /v1/check-ins/{id} name or delete a whole stay, and DELETE /v1/check-ins?confirm=all deletes them all. GET, POST, PATCH and DELETE /v1/check-ins/places keep the names you remember. GET /v1/activity has a new kind, `checkin`, whose `label` is the one place a row holds your own words, and never a spot. It takes no new scope.'
  },
  {
    version: '1.17.2',
    date: '2026-11-05',
    summary:
      'A file’s address takes a number of up to six digits. Since numbers no longer come round (1.17.1), a note that has had many files added and removed can pass the old limit of three, which would have read as not_found.'
  },
  {
    version: '1.17.1',
    date: '2026-11-05',
    summary:
      'A file’s number never comes round again. 1.17.0 let a later file take the number a removed last file left, so a transcript still being made for the old one could land on the new one. Two writers racing a removal could also give two files one number; now the later write reads the note again.'
  },
  {
    version: '1.17.0',
    date: '2026-11-05',
    summary:
      'Taking one file off a note. DELETE /v1/notes/{date}/{id}/media/{n} removes it with its small copy, transcript and description, with `media:write` on a note this token wrote, and `notes:all` as well on any other. The other files keep their numbers. A note with no words can’t lose its last file (text_required). A note’s activity row of kind note.files can now say `removed` rather than `added`.'
  },
  {
    version: '1.16.0',
    date: '2026-11-05',
    summary:
      'Writing as the web does. POST /v1/notes takes `markup: "rich"`, for a note whose words hold rich-text marks. PUT and DELETE /v1/notes/{date}/{id}/place set, change or remove where a note was, on a note this token wrote, or any note with `notes:all`. PUT and DELETE /v1/days/{date}/place set or remove a day’s own place, with `notes:all`. The day’s weather follows each of these, and a new note with a place on an earlier day, and never fails the write.'
  },
  {
    version: '1.15.0',
    date: '2026-11-05',
    summary:
      'Reading the archive. A new scope, `notes:read`, stands alone: it reads every note and what is made from them, and writes nothing. GET /v1/notes, GET /v1/notes/{date}/{id} and its media open to it, reaching every note. New with `notes:read` or `notes:all`: GET /v1/days (the timeline), GET /v1/days/{date}, GET /v1/search, GET /v1/on-this-day, GET /v1/releases, GET /v1/releases/{v}, GET /v1/tags/all, GET /v1/map/pins, GET /v1/badges and GET /v1/mail-log. `notes:write` alone still reads only what its token wrote.'
  },
  {
    version: '1.14.0',
    date: '2026-11-05',
    summary:
      'The complete note. A note now says its `tags`, `markup`, `parts` (its words cut into strings, links and tags), `place`, `no_place`, `edited_at`, `tz`, `late`, `author`, `client`, `from` and `attachments`. Each of its `media` says its `transcript`, `description` and whether a transcript is `writing`. `include=urls` on GET /v1/notes and GET /v1/notes/{date}/{id} puts each file’s ten-minute address in the answer. A page of GET /v1/notes stops at about a megabyte, so it may hold fewer than `limit` notes: follow `next` until it is null.'
  },
  {
    version: '1.13.0',
    date: '2026-11-01',
    summary:
      'GET /v1/me says `lived`, the weeks and days lived (both from 1), as Release Notes’ Today page and morning email set them ("Week 2,826 — Day 19,779"), for today and for each of its `days`. Changelog’s widget shows it.'
  },
  {
    version: '1.12.0',
    date: '2026-11-01',
    summary:
      'GET /v1/me says `supporting_member`: whether the account gets what Supporting Members of the Weekly Thing get, as Release Notes last looked (every nine days, and at a web sign-in). Changelog reads it to offer its other app icons.'
  },
  {
    version: '1.11.0',
    date: '2026-10-30',
    summary:
      'notes:all reaches the rest: a token with it deletes any note in the account (with its files, and an emailed note’s email, as the web’s delete does) and adds files to any note (with media:write). Without notes:all, nothing changes.'
  },
  {
    version: '1.10.0',
    date: '2026-10-30',
    summary:
      'Every note: a token with the new notes:all scope (only beside notes:write, chosen by the owner) reads any note in the account, whatever channel wrote it, lists them all by day, fetches their files, and changes their words with PUT and append, from the revision it read. Delete and adding files stay on the notes it wrote. A note now says where it came from as `source` (email, web, api, an agent or an import) and whether this token wrote it as `mine`, and GET /v1/notes takes mine=true for this token’s alone. Without notes:all, nothing changes. Fixed: an activity cursor outside the from/to days answers an empty page, not 503.'
  },
  {
    version: '1.9.0',
    date: '2026-10-30',
    summary:
      'Reading back by day: GET /v1/notes?from=&to= lists the notes this token wrote on those days, oldest first, a page at a time, up to 31 days a request (wider is range_too_wide). A note now lists its files as `media` (number, kind, type, name, size and its small copy), and GET /v1/notes/{date}/{id}/media/{n} gives a ten-minute address for one, or its small copy with ?size=thumb. GET /v1/activity takes the same from and to, days in the account’s time zone.'
  },
  {
    version: '1.8.0',
    date: '2026-10-30',
    summary:
      'Moments withdrawn: POST /v1/notes no longer takes the `moment` that 1.6.0 added, and refuses it as a field it doesn’t have (invalid_request, with field `moment`). No released app sent one, and no note kept one. A note’s read and its note.added row no longer carry it. An app that starts a note from something picked, a workout, a song or who was there, writes it into the words, with its photos as `uploads` and its spot as `place`.'
  },
  {
    version: '1.7.1',
    date: '2026-10-30',
    summary:
      'Tags in any script: a hashtag whose letters are not Latin is a tag of its own letters, lowercased (#東京 is 東京, #Москва is москва), on a note sent through /v1 as anywhere, and PUT /v1/tags/pinned takes them. Every tag that worked before is spelled as it was.'
  },
  {
    version: '1.7.0',
    date: '2026-10-30',
    summary:
      'Odd bodies: POST /v1/notes reads a form (application/x-www-form-urlencoded, as a Shortcut’s Form body sends it) as its text, date and written_at, when those are its only fields and text is one; any other form is still the words, and a multipart or media body is refused. A body may be 256 KB, room for the longest note with every character escaped. A note’s words lose control characters other than tab and newline, as from every channel, and a JSON body holding a lone surrogate escape is refused. A note’s place is kept as sent, its shape checked.'
  },
  {
    version: '1.6.0',
    date: '2026-10-30',
    summary:
      'Moments: a new note can carry a `moment`, what an app picked for it (a workout, a song or podcast, steps, a feeling, an event, people, a reflection prompt) as typed values beside its words. GET /v1/notes/{date}/{id} returns it as kept, and the note.added activity row names its kinds, never its words.'
  },
  {
    version: '1.5.0',
    date: '2026-10-30',
    summary:
      'The contract says what answers do: POST /v1/uploads and POST /v1/places/here take no Idempotency-Key, since neither keeps a receipt (a retry asks again); RateLimit headers come on a write that counts, not on a replay; and Accept: text/plain gives text, a line for each thing a list holds. Accept is read in full, so text/plain wins only where it outranks application/json. A token’s 404 and 405 answers say today’s version too, and a body naming another date or id than the path is invalid_request.'
  },
  {
    version: '1.4.0',
    date: '2026-10-30',
    summary:
      'Which account and which token: GET /v1/me gives the account’s id, the same for every token of the account and never changing, and the token’s own id; each activity row a token writes from now names it by token_id. An Idempotency-Key now holds for the account: the same key sent through another of its tokens gets the first answer, and a different request under it is idempotency_mismatch.'
  },
  {
    version: '1.3.0',
    date: '2026-10-29',
    summary:
      'Signing in: an app can get its token with OAuth (the authorization code with PKCE, for the resource /v1, with its own https or reverse-DNS callback), choosing among notes:write, media:write, upcoming and activity; the owner names the token, ticks its scopes and picks its expiry, and the answer is that token, with no refresh. The app can sign out at /oauth/revoke as well as DELETE /v1/token.'
  },
  {
    version: '1.2.0',
    date: '2026-10-29',
    summary:
      'Files and places: with the media:write scope, a signed form for each photo, recording or PDF, and files on a new note or added to one this token wrote; and a new note’s place, from the city search or from Here, which names a device’s spot and the businesses near it.'
  },
  {
    version: '1.1.0',
    date: '2026-10-29',
    summary:
      'Upcoming, with the upcoming scope: list the dates ahead, add, change and remove up to 50 at once (all or nothing, with a dry run), remove one, and read the reminders each morning carries for up to 31 days ahead, with when the email is due.'
  },
  {
    version: '1.0.0',
    date: '2026-10-29',
    summary:
      'The first version: who the token is and the days ahead, text notes, tags and pinned tags, and the activity log.'
  }
];
/** A request body's ceiling: the longest note even when every character
 * comes escaped (Python's json.dumps sends an emoji as two six-byte
 * escapes, twelve bytes), with room for the other fields (API 1.7.0). */
export const V1_BODY = 256 * 1024;
/** The fields a form-encoded POST /v1/notes may carry, read as fields only
 * when every name is one of them and `text` is among them (API 1.7.0):
 * any other form body, such as `curl -d 'my words'`, is the words. */
export const NOTE_FORM = ['text', 'date', 'written_at'] as const;
/** How many days `/v1/me` gives versions for, today first: enough for a
 * phone to show the version and fire reminders offline for two weeks. */
export const ME_DAYS = 14;
/** How far ahead `/v1/upcoming/reminders` reads: a month of mornings. */
export const REMINDER_DAYS_MAX = 31;
/** The most days one `GET /v1/notes` or `GET /v1/activity` reads (1.9.0). */
export const RANGE_DAYS_MAX = 31;
/** How long a file's signed address lasts, as MCP's downloads do. */
export const FILE_SECONDS = 600;
/** About where a page of GET /v1/notes stops (1.14.0): a note can hold 400 KB
 * and a page 100 notes. A page always holds one, and `next` goes on. */
export const NOTES_PAGE_BYTES = 1024 * 1024;

const NOTE = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})$/,
  APPEND = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})\/append$/,
  MEDIA = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})\/media$/,
  FILE = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})\/media\/([1-9]\d{0,5})$/,
  UPCOMING = /^\/v1\/upcoming\/([A-Za-z0-9_-]{1,80})$/,
  NOTE_PLACE = /^\/v1\/notes\/([^/]{1,40})\/([A-Za-z0-9_.-]{1,80})\/place$/,
  DAY = /^\/v1\/days\/([^/]{1,40})$/,
  DAY_PLACE = /^\/v1\/days\/([^/]{1,40})\/place$/,
  RELEASE = /^\/v1\/releases\/([^/]{1,12})$/,
  CHECK_INS = /^\/v1\/check-ins$/,
  CHECK_IN = /^\/v1\/check-ins\/(c-?\d{1,16}-[0-9a-f]{1,40})$/,
  CHECK_IN_PLACES = /^\/v1\/check-ins\/places$/,
  CHECK_IN_PLACE = /^\/v1\/check-ins\/places\/(p-[0-9a-f]{1,40})$/,
  CHECK_IN_PLACE_CHECK_INS = /^\/v1\/check-ins\/places\/(p-[0-9a-f]{1,40})\/check-ins$/,
  CHECK_IN_CURSOR = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z#c-?\d{1,16}-[0-9a-f]{1,40}$/;
/** Reads that reach the whole archive (1.15.0). */
const ARCHIVE = { scope: 'notes:read', also: ['notes:all'] } as const;

/** Every route: method, path, name, and the scope it needs (none: any token),
 * or any one of `scope` and `also`, with the sentence a refusal says when the
 * scope's own would mislead. */
export const V1_ROUTES: readonly {
  method: string;
  path: RegExp;
  template: string;
  name: string;
  scope: string | null;
  also?: readonly string[];
  refusal?: string;
}[] = [
  { method: 'GET', path: /^\/v1\/me$/, template: '/v1/me', name: 'me', scope: null },
  {
    method: 'GET',
    path: /^\/v1\/notes$/,
    template: '/v1/notes',
    name: 'notes',
    scope: 'notes:write',
    also: ['notes:read']
  },
  { method: 'POST', path: /^\/v1\/notes$/, template: '/v1/notes', name: 'notes.create', scope: 'notes:write' },
  {
    method: 'GET',
    path: NOTE,
    template: '/v1/notes/{date}/{id}',
    name: 'note',
    scope: 'notes:write',
    also: ['notes:read']
  },
  { method: 'PUT', path: NOTE, template: '/v1/notes/{date}/{id}', name: 'notes.edit', scope: 'notes:write' },
  { method: 'DELETE', path: NOTE, template: '/v1/notes/{date}/{id}', name: 'notes.delete', scope: 'notes:write' },
  {
    method: 'POST',
    path: APPEND,
    template: '/v1/notes/{date}/{id}/append',
    name: 'notes.append',
    scope: 'notes:write'
  },
  {
    method: 'POST',
    path: MEDIA,
    template: '/v1/notes/{date}/{id}/media',
    name: 'notes.media',
    scope: 'media:write'
  },
  {
    method: 'GET',
    path: FILE,
    template: '/v1/notes/{date}/{id}/media/{n}',
    name: 'notes.file',
    scope: 'notes:write',
    also: ['notes:read']
  },
  {
    method: 'PUT',
    path: NOTE_PLACE,
    template: '/v1/notes/{date}/{id}/place',
    name: 'notes.place',
    scope: 'notes:write'
  },
  {
    method: 'DELETE',
    path: NOTE_PLACE,
    template: '/v1/notes/{date}/{id}/place',
    name: 'notes.place.clear',
    scope: 'notes:write'
  },
  { method: 'PUT', path: DAY_PLACE, template: '/v1/days/{date}/place', name: 'days.place', scope: 'notes:all' },
  {
    method: 'DELETE',
    path: DAY_PLACE,
    template: '/v1/days/{date}/place',
    name: 'days.place.clear',
    scope: 'notes:all'
  },
  {
    method: 'DELETE',
    path: FILE,
    template: '/v1/notes/{date}/{id}/media/{n}',
    name: 'notes.media.remove',
    scope: 'media:write'
  },
  { method: 'POST', path: /^\/v1\/uploads$/, template: '/v1/uploads', name: 'uploads.start', scope: 'media:write' },
  { method: 'GET', path: /^\/v1\/places$/, template: '/v1/places', name: 'places', scope: 'notes:write' },
  {
    method: 'POST',
    path: /^\/v1\/places\/here$/,
    template: '/v1/places/here',
    name: 'places.here',
    scope: 'notes:write'
  },
  {
    method: 'GET',
    path: /^\/v1\/tags$/,
    template: '/v1/tags',
    name: 'tags',
    scope: 'notes:write',
    also: ['notes:read'],
    refusal: "This token can't read your tags. Make a token that may add or read notes."
  },
  {
    method: 'PUT',
    path: /^\/v1\/tags\/pinned$/,
    template: '/v1/tags/pinned',
    name: 'tags.pinned',
    scope: 'notes:write'
  },
  { method: 'GET', path: /^\/v1\/activity$/, template: '/v1/activity', name: 'activity', scope: 'activity' },
  { method: 'GET', path: /^\/v1\/upcoming$/, template: '/v1/upcoming', name: 'upcoming', scope: 'upcoming' },
  {
    method: 'POST',
    path: /^\/v1\/upcoming\/batch$/,
    template: '/v1/upcoming/batch',
    name: 'upcoming.batch',
    scope: 'upcoming'
  },
  {
    method: 'GET',
    path: /^\/v1\/upcoming\/reminders$/,
    template: '/v1/upcoming/reminders',
    name: 'upcoming.reminders',
    scope: 'upcoming'
  },
  { method: 'DELETE', path: UPCOMING, template: '/v1/upcoming/{id}', name: 'upcoming.delete', scope: 'upcoming' },
  { method: 'GET', path: /^\/v1\/days$/, template: '/v1/days', name: 'days', ...ARCHIVE },
  { method: 'GET', path: DAY, template: '/v1/days/{date}', name: 'day', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/search$/, template: '/v1/search', name: 'search', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/on-this-day$/, template: '/v1/on-this-day', name: 'on-this-day', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/releases$/, template: '/v1/releases', name: 'releases', ...ARCHIVE },
  { method: 'GET', path: RELEASE, template: '/v1/releases/{v}', name: 'release', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/tags\/all$/, template: '/v1/tags/all', name: 'tags.all', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/map\/pins$/, template: '/v1/map/pins', name: 'map.pins', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/badges$/, template: '/v1/badges', name: 'badges', ...ARCHIVE },
  { method: 'GET', path: /^\/v1\/mail-log$/, template: '/v1/mail-log', name: 'mail-log', ...ARCHIVE },
  { method: 'GET', path: CHECK_INS, template: '/v1/check-ins', name: 'check-ins', scope: 'activity' },
  { method: 'POST', path: CHECK_INS, template: '/v1/check-ins', name: 'check-ins.add', scope: 'notes:write' },
  { method: 'DELETE', path: CHECK_INS, template: '/v1/check-ins', name: 'check-ins.delete-all', scope: 'notes:all' },
  { method: 'PATCH', path: CHECK_IN, template: '/v1/check-ins/{id}', name: 'check-ins.name', scope: 'notes:write' },
  { method: 'DELETE', path: CHECK_IN, template: '/v1/check-ins/{id}', name: 'check-ins.delete', scope: 'notes:write' },
  {
    method: 'GET',
    path: CHECK_IN_PLACES,
    template: '/v1/check-ins/places',
    name: 'check-ins.places',
    scope: 'activity'
  },
  {
    method: 'POST',
    path: CHECK_IN_PLACES,
    template: '/v1/check-ins/places',
    name: 'check-ins.places.add',
    scope: 'notes:all'
  },
  {
    method: 'GET',
    path: CHECK_IN_PLACE,
    template: '/v1/check-ins/places/{id}',
    name: 'check-ins.places.get',
    scope: 'activity'
  },
  {
    method: 'PATCH',
    path: CHECK_IN_PLACE,
    template: '/v1/check-ins/places/{id}',
    name: 'check-ins.places.change',
    scope: 'notes:all'
  },
  {
    method: 'DELETE',
    path: CHECK_IN_PLACE_CHECK_INS,
    template: '/v1/check-ins/places/{id}/check-ins',
    name: 'check-ins.places.delete-check-ins',
    scope: 'notes:all'
  },
  {
    method: 'PATCH',
    path: CHECK_IN_PLACE_CHECK_INS,
    template: '/v1/check-ins/places/{id}/check-ins',
    name: 'check-ins.places.tag-check-ins',
    scope: 'notes:all'
  },
  {
    method: 'DELETE',
    path: CHECK_IN_PLACE,
    template: '/v1/check-ins/places/{id}',
    name: 'check-ins.places.delete',
    scope: 'notes:all'
  },
  { method: 'DELETE', path: /^\/v1\/token$/, template: '/v1/token', name: 'token.revoke', scope: null }
];

/** Every error code and its status (docs/API.md, Errors). */
export const V1_ERRORS: Record<string, number> = {
  invalid_request: 400,
  text_required: 400,
  date_out_of_range: 400,
  range_too_wide: 400,
  token_missing: 401,
  token_unknown: 401,
  token_revoked: 401,
  token_expired: 401,
  scope_required: 403,
  not_yours: 403,
  origin_refused: 403,
  not_found: 404,
  method_not_allowed: 405,
  revision_mismatch: 409,
  account_closing: 409,
  busy: 409,
  too_large: 413,
  idempotency_mismatch: 422,
  rate_limited: 429,
  unavailable: 503
};
const MESSAGES: Record<string, string> = {
  token_missing: 'Send a token as Authorization: Bearer rn_... Make one in Release Notes under Settings, API tokens.',
  token_unknown: "That isn't a token Release Notes made. Make one under Settings, API tokens.",
  token_revoked: 'This token was revoked. Make a new one under Settings, API tokens.',
  token_expired: 'This token expired. Make a new one under Settings, API tokens.',
  account_closing: 'This account is being deleted.',
  origin_refused: "/v1 isn't for browsers.",
  not_found: 'There is no such request. The API is described at /guide/api/.',
  method_not_allowed: "That method isn't used here.",
  busy: 'Try again shortly with the same Idempotency-Key.',
  too_large: `A request can be at most ${V1_BODY / 1024} KB.`,
  unavailable: 'Try again shortly with the same Idempotency-Key.'
};

type V1Store = ReaderStore & TagRowStore & CheckInReads;
type Headers = Record<string, string>;

/** Text when the Accept header prefers text/plain to JSON. Each takes the q
 * of the most specific range that names it, the higher q wins, and a tie
 * goes to the one listed first; no header, or any type alone, is JSON. */
function wantsPlain(request: Request): boolean {
  const ranges = (request.headers.get('accept') ?? '').split(',').map((part, at) => {
    const [range = '', ...params] = part.split(';').map((s) => s.trim().toLowerCase()),
      q = params.find((p) => p.startsWith('q='));
    return { range, at, q: q ? Number(q.slice(2)) : 1 };
  });
  const pick = (type: string) => {
    for (const range of [type, type.split('/')[0] + '/*', '*/*']) {
      const hit = ranges.find((r) => r.range === range);
      if (hit) return { q: Number.isFinite(hit.q) ? hit.q : 0, at: hit.at };
    }
    return { q: 0, at: Infinity };
  };
  const plain = pick('text/plain'),
    json = pick('application/json');
  return plain.q > 0 && (plain.q > json.q || (plain.q === json.q && plain.at < json.at));
}

/** One answer: JSON, or a line for a terminal that asked for text. */
function respond(status: number, body: unknown, plain: string | null, headers: Headers): Response {
  const base: Headers = { 'cache-control': 'no-store', 'api-version': API_VERSION, ...headers };
  if (status === 204) return new Response(null, { status, headers: base });
  if (plain !== null)
    return new Response(plain + '\n', { status, headers: { ...base, 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...base, 'content-type': 'application/json; charset=utf-8' }
  });
}

function refuse(code: string, asText: boolean, headers: Headers = {}, detail = '', extra: OAuthRow = {}): Response {
  const status = V1_ERRORS[code] ?? 400,
    message = detail || MESSAGES[code] || 'That request was refused.',
    more: Headers = { ...headers };
  if (status === 401) more['www-authenticate'] = 'Bearer realm="Release Notes"';
  if (typeof extra.retry_after === 'number') more['retry-after'] = String(extra.retry_after);
  const error: OAuthRow = { code, message };
  for (const k of ['field', 'revision', 'count']) if (extra[k] != null) error[k] = extra[k];
  return respond(status, { error }, asText ? message : null, more);
}

/** A form a Shortcut or `curl --data-urlencode` sends, as its fields, when
 * every name is a note's and `text` is one; null when it is the words; a
 * name sent twice, as that name. */
function noteForm(type: string, raw: string): OAuthRow | string | null {
  // Every piece names its value, so `curl -d text` is still the word.
  const pieces = raw.split('&').filter(Boolean);
  if (type !== 'application/x-www-form-urlencoded' || !pieces.every((piece) => piece.includes('='))) return null;
  const fields = [...new URLSearchParams(raw)],
    names = fields.map(([name]) => name);
  if (!names.includes('text') || !names.every((name) => (NOTE_FORM as readonly string[]).includes(name))) return null;
  const twice = names.find((name, at) => names.indexOf(name) !== at);
  return twice ?? Object.fromEntries(fields);
}

/** The body, at most V1_BODY, as UTF-8 text; null when it was over. */
async function bodyText(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > V1_BODY) return null;
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > V1_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** A token's reads a UTC day, counted in MCPMETA as MCP's own counts are. */
async function readQuota(context: ReaderContext, uid: string, tid: string): Promise<boolean> {
  const day = Math.floor(context.now / 86400),
    key = `TOKENREADS#${tid}#${day}`;
  for (let attempt = 0; attempt < 8; attempt++) {
    const old = await context.store.mcpGet(`MCPMETA#${uid}`, key),
      n = Number(old?.n ?? 0);
    if (n >= V1_LIMITS.reads) return false;
    if (
      await context.store.mcpCommit(
        [
          [
            { pk: `MCPMETA#${uid}`, sk: key, n: n + 1, expires_at: (day + 2) * 86400 },
            old ? Number(old.revision) : null
          ]
        ],
        uid
      )
    )
      return true;
  }
  throw new Error('Read count unavailable');
}

/** A place as one line: its names that are set, most local first. */
const placeLine = (names: unknown[]) => names.filter((n) => typeof n === 'string' && n).join(', ');

const until = (now: number) => (Math.floor(now / 86400) + 1) * 86400 - now;

/** A note's file as a token reads it (1.9.0): what it is, never where, and
 * the words kept about it (1.14.0). An empty transcript is one where nothing
 * could be made out, and reads as none. */
const fileView = (m: OAuthRow, transcribing: boolean): OAuthRow => {
  const thumb = object(m.thumb) && typeof m.thumb.key === 'string' ? m.thumb : null;
  return {
    n: Number(m.n),
    kind: m.kind,
    type: m.type,
    name: typeof m.name === 'string' && m.name ? m.name : null,
    size: Number(m.size) || 0,
    thumb: thumb
      ? { type: 'image/jpeg', width: Number(thumb.width) || null, height: Number(thumb.height) || null }
      : null,
    transcript: typeof m.transcript === 'string' && m.transcript ? m.transcript : null,
    description: typeof m.description === 'string' && m.description ? m.description : null,
    writing: transcribing && stillWriting(m)
  };
};

/** A note's tags as stored (docs/TAGS.md): keys and names. */
const tagsOf = (item: OAuthRow): string[] => storedTags(item).map((t) => t.key);

/** What a day says of itself, on the timeline and alone (1.15.0): its version,
 * the place set on it, the place a note with none shows, as the web's day
 * does (the day's own, then the first note's that day, then home), and its
 * weather. */
function dayHead(profile: OAuthRow, day: string, notes: OAuthRow[], own: OAuthRow | null, sky: OAuthRow | null) {
  const shared = dayPlace(own as PlaceRecord | null, notes as NoteRecord[], String(profile.tz)),
    near = shared ?? placeOf(profile),
    label = near && placeLabel({ city: near.city, region: near.region, country: near.country });
  return {
    date: day,
    version: computeVersion(String(profile.birthday), day).toString(),
    place: own ? placeView(own) : null,
    around: label ? { label, from: shared ? 'day' : 'home' } : null,
    weather: sky
      ? {
          ...Object.fromEntries(
            ['high_c', 'low_c', 'code', 'city']
              .filter((k) => Object.hasOwn(sky, k))
              .map((k) => [k, k === 'city' ? sky[k] : Number(sky[k])])
          ),
          line: dayLine(sky as Reading, fahrenheit(placeOf(profile) ?? (sky as PlaceRecord)))
        }
      : null
  };
}

/** A note as a token reads it, alone or in a day's list; `mine` when this
 * token wrote it (1.10.0); all a client needs to show it as the web does
 * (1.14.0). */
function noteView(item: OAuthRow, profile: OAuthRow, tid: string): OAuthRow {
  const [, date = '', ...rest] = String(item.sk).split('#'),
    media = (item.media as OAuthRow[] | undefined) ?? [],
    words = String(item.text ?? ''),
    rich = isRich(item as NoteRecord),
    zone = validTimezone(item.tz) ? String(item.tz) : String(profile.tz),
    at = writtenAt(item as NoteRecord),
    epoch = Date.parse(at),
    origin = object(item.origin) ? item.origin : null;
  return {
    id: rest.join('#'),
    date,
    version: String(item.version ?? computeVersion(String(profile.birthday), date).toString()),
    text: words,
    revision: editRevision(item),
    written_at: at || null,
    files: media.length,
    media: media.map((m) => fileView(m, Boolean(profile.transcribe))),
    token: item.token ?? null,
    source: String(item.source ?? 'email'),
    mine: item.source === 'api' && item.connection === tid,
    tags: tagsOf(item),
    tag_names: storedTags(item).map((t) => t.name),
    markup: rich ? RICH : null,
    parts: split(segments(words, item.links as Link[] | undefined, rich)),
    place: item.place_cleared ? null : placeView(item.place),
    no_place: Boolean(item.place_cleared),
    edited_at: item.updated_at ?? null,
    tz: zone,
    late: Number.isFinite(epoch) && localDay(Math.floor(epoch / 1000), zone) > date,
    author: item.author ?? 'user',
    client: item.client ?? null,
    from: origin ? (origin.app === 'dayone' ? 'Day One' : 'an import') : null,
    attachments: others(item as NoteRecord)
  };
}

/** `include=urls` on a note's reads (1.14.0): each file's address and its
 * small copy's in the answer, one read rather than one for each file. */
async function withUrls(view: OAuthRow, item: OAuthRow, uid: string, files: MediaReader | undefined) {
  const stored = (item.media as OAuthRow[] | undefined) ?? [],
    sign = async (key: unknown, type: string) =>
      files && typeof key === 'string' && key.startsWith(`media/${uid}/`)
        ? files.download(uid, key, type, FILE_SECONDS)
        : null;
  view.media = await Promise.all(
    (view.media as OAuthRow[]).map(async (shown, i) => {
      const m = stored[i]!,
        small = object(m.thumb) ? await sign(m.thumb.key, 'image/jpeg') : null;
      return {
        ...shown,
        url: await sign(m.key, String(m.type)),
        expires_in: FILE_SECONDS,
        ...(shown.thumb ? { thumb: { ...(shown.thumb as OAuthRow), url: small } } : {})
      };
    })
  );
  return view;
}

/** Whether a note's read asks for addresses; null when `include` is anything
 * else, so a mistyped word isn't quietly ignored. */
const includeUrls = (q: URLSearchParams): boolean | null =>
  q.get('include') === null ? false : q.get('include') === 'urls' ? true : null;
const badInclude = {
  code: 'invalid_request',
  message: 'include is urls, or left out.',
  extra: { field: 'include' }
};

type Refusal = { code: string; message: string; extra?: OAuthRow };
const isRefusal = (v: unknown): v is Refusal =>
  object(v) && typeof v.code === 'string' && typeof v.message === 'string';
/** Where a note falls in a list: its day, when it was written, and its key. */
const noteAt = (item: OAuthRow) => [
  String(item.sk).split('#')[1]!,
  writtenAt(item as NoteRecord) || '',
  String(item.sk)
];
const later = (a: string[], b: string[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
};
const oldestFirst = (x: { at: string[] }, y: { at: string[] }) => (later(x.at, y.at) ? 1 : later(y.at, x.at) ? -1 : 0);
const cursorFor = (at: string[]) => Buffer.from(JSON.stringify(at), 'utf8').toString('base64url');

/** A `tag` as each list takes it: any spelling of the tag (1.21.0; "Road
 * Trip", "#road-trip" and "road_trip" are one), as its key; null for none. */
function tagFrom(q: URLSearchParams): string | null | Refusal {
  const raw = q.get('tag');
  if (raw === null) return null;
  const tag = spelling(raw);
  return typeof tag === 'string'
    ? {
        code: 'invalid_request',
        message: 'tag is a tag, by any spelling: ' + TAG_REFUSALS[tag],
        extra: { field: 'tag' }
      }
    : tag.key;
}
/** `q` and `tag` as GET /v1/search and GET /v1/map/pins take them: at most
 * ten words or quoted phrases, and a tag by any spelling. Either may be left out. */
function soughtFrom(q: URLSearchParams): { terms: string[]; tag: string | null } | Refusal {
  const words = q.get('q') ?? '',
    tag = tagFrom(q);
  if ((words.match(RAW_TERMS) ?? []).length > 10)
    return { code: 'invalid_request', message: 'q is at most ten words or quoted phrases.', extra: { field: 'q' } };
  if (isRefusal(tag)) return tag;
  return { terms: searchTerms(words), tag };
}
/** Whether a note has every word (in its words, places, link names,
 * transcripts and descriptions, as the web finds them) and the tag. */
const finds = (note: NoteRecord, sought: { terms: string[]; tag: string | null }) =>
  sought.terms.every((t) => searchedText(note).includes(t)) &&
  (sought.tag === null || tagsOf(note).includes(sought.tag));
/** `after`: a place in a list's order, not a note, so a note deleted since
 * still lets the next page start where it was. */
function afterFrom(q: URLSearchParams, parts: number): string[] | null | Refusal {
  if (q.get('after') === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(q.get('after')!, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== parts || !parsed.every((v) => typeof v === 'string'))
      throw new Error('after');
    return parsed as string[];
  } catch {
    return { code: 'invalid_request', message: 'after is the next from an earlier answer.', extra: { field: 'after' } };
  }
}
/** `limit`, from 1 to `most`, or `fallback` when it didn't come. */
function limitFrom(q: URLSearchParams, fallback: number, most: number): number | Refusal {
  const limit = q.get('limit') === null ? fallback : Number(q.get('limit'));
  return Number.isInteger(limit) && limit >= 1 && limit <= most
    ? limit
    : { code: 'invalid_request', message: `limit is 1 to ${most}.`, extra: { field: 'limit' } };
}
/** A day the account has lived, for the requests that read one (1.15.0). */
function livedDay(value: string, field: string, birthday: string, today: string): string | Refusal {
  if (!validDay(value)) return { code: 'invalid_request', message: `${field} is a day, YYYY-MM-DD.`, extra: { field } };
  return value < birthday || value > today
    ? { code: 'date_out_of_range', message: 'Choose a day from your birthday through today.', extra: { field } }
    : value;
}
const WEATHER_CREDIT = 'Open-Meteo (CC BY 4.0), https://open-meteo.com/';

/** `from` and `to`, account-local days, both in; `to` defaults to `from`.
 * Null when neither came; a refusal when they aren't a range (1.9.0). */
function dayRange(
  q: URLSearchParams
): { first: string; last: string } | { code: string; message: string; extra?: OAuthRow } | null {
  const first = q.get('from'),
    last = q.get('to') ?? first;
  if (first === null && last === null) return null;
  if (first === null || !validDay(first))
    return { code: 'invalid_request', message: 'from is a day, YYYY-MM-DD.', extra: { field: 'from' } };
  if (last === null || !validDay(last))
    return { code: 'invalid_request', message: 'to is a day, YYYY-MM-DD.', extra: { field: 'to' } };
  if (last < first)
    return { code: 'invalid_request', message: 'to is the same day as from or later.', extra: { field: 'to' } };
  if ((Date.parse(last) - Date.parse(first)) / 86_400_000 + 1 > RANGE_DAYS_MAX)
    return {
      code: 'range_too_wide',
      message: `A request reads at most ${RANGE_DAYS_MAX} days. Ask for a longer span in pieces.`
    };
  return { first, last };
}

export async function handleV1(request: Request, options: McpOptions): Promise<Response> {
  const asText = wantsPlain(request);
  let context: ReaderContext | undefined,
    uid = 'unknown';
  try {
    context = await options.context();
    const store = context.store as V1Store,
      now = context.now,
      files = context.media,
      cities = context.geocode ?? search,
      adminUserId = context.adminUserId;
    if (request.headers.has('origin') && request.headers.get('origin') !== context.origin)
      return refuse('origin_refused', asText);
    const path = new URL(request.url).pathname,
      candidates = V1_ROUTES.filter((r) => r.path.test(path)),
      route = candidates.find((r) => r.method === request.method);
    // A request no route takes still says today's version to a good token.
    const origin = context.origin,
      versionOnly = async (): Promise<Headers> => {
        const known = await checkToken(store, origin, now, request.headers.get('authorization'));
        return known.ok
          ? {
              'release-notes-version': computeVersion(
                String(known.profile.birthday),
                localDay(now, String(known.profile.tz))
              ).toString()
            }
          : {};
      };
    if (!candidates.length) return refuse('not_found', asText, await versionOnly());
    if (!route)
      return refuse('method_not_allowed', asText, {
        ...(await versionOnly()),
        allow: [...new Set(candidates.map((r) => r.method))].join(', ')
      });
    const check = await checkToken(store, context.origin, now, request.headers.get('authorization'));
    if (!check.ok) return refuse(check.code, asText);
    const { token, profile } = check,
      tid = String(token.id),
      tz = String(profile.tz),
      today = localDay(now, tz),
      birthday = String(profile.birthday),
      version = computeVersion(birthday, today).toString(),
      headers: Headers = { 'release-notes-version': version },
      scopes = scopesOf(token),
      family = { user_id: token.user_id, id: tid, client_name: token.name, kind: 'token' },
      params = (route.path.exec(path) ?? []).slice(1);
    uid = String(token.user_id);
    if (route.scope && ![route.scope, ...(route.also ?? [])].some((s) => scopes.includes(s)))
      return refuse(
        'scope_required',
        asText,
        headers,
        route.refusal ?? SCOPE_REFUSALS[route.also ? 'notes:read' : route.scope]
      );

    // Writes go on to the capture function, which proves the token again.
    if (route.method !== 'GET') {
      let args: OAuthRow = {};
      if (route.method !== 'DELETE') {
        const raw = await bodyText(request).catch(() => undefined);
        if (raw === null) return refuse('too_large', asText, headers);
        if (raw === undefined) return refuse('invalid_request', asText, headers, 'Send the body as UTF-8.');
        const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (type === 'application/json') {
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return refuse('invalid_request', asText, headers, "The body isn't JSON.");
          }
          if (!object(parsed)) return refuse('invalid_request', asText, headers, 'The body is a JSON object.');
          if (!wellFormed(parsed))
            return refuse(
              'invalid_request',
              asText,
              headers,
              'Some text holds half a character (a lone surrogate escape); send whole characters.'
            );
          args = parsed;
        } else if (route.name !== 'notes.create')
          return refuse('invalid_request', asText, headers, 'Send a JSON body with Content-Type: application/json.');
        else if (/^(multipart|image|audio|video)\//.test(type))
          return refuse(
            'invalid_request',
            asText,
            headers,
            'Send the words as text/plain, or JSON with Content-Type: application/json; files go through POST /v1/uploads.',
            { field: 'Content-Type' }
          );
        else {
          const form = noteForm(type, raw);
          if (typeof form === 'string')
            return refuse('invalid_request', asText, headers, `Send ${form} once.`, { field: form });
          args = form ?? { text: raw };
        }
      }
      // The path names the note or date ({date}, {id}). A body may repeat
      // them, but one naming another is refused: nothing moves a note.
      const named = [...route.template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!),
        other = named.find((field, i) => field in args && args[field] !== params[i]);
      if (other)
        return refuse(
          'invalid_request',
          asText,
          headers,
          other === 'date' && route.template.startsWith('/v1/notes')
            ? 'A note keeps its day: the path names it.'
            : 'The path names what this changes.',
          { field: other }
        );
      named.forEach((field, i) => (args[field] = params[i]));
      if (route.name === 'upcoming.delete') {
        const revision = new URL(request.url).searchParams.get('revision');
        if (revision === null || !/^[1-9]\d{0,14}$/.test(revision))
          return refuse('invalid_request', asText, headers, 'Send the revision you read, as ?revision=.', {
            field: 'revision'
          });
        args.revision = Number(revision);
      }
      // Every check-in goes only when the address says so.
      if (route.name === 'check-ins.delete-all') args.confirm = new URL(request.url).searchParams.get('confirm');
      // The check-ins at a place go only for the count the owner was shown.
      if (route.name === 'check-ins.places.delete-check-ins') {
        const count = new URL(request.url).searchParams.get('count');
        if (count === null || !/^(0|[1-9]\d{0,6})$/.test(count))
          return refuse(
            'invalid_request',
            asText,
            headers,
            'Send ?count= with how many check-ins GET /v1/check-ins/places/{id} said are there.',
            { field: 'count' }
          );
        args.count = Number(count);
      }
      // A dry run reads and writes nothing, so it counts as a read.
      const dry = route.name === 'upcoming.batch' && args.dry_run === true;
      if (dry && !(await readQuota(context, uid, tid)))
        return refuse('rate_limited', asText, headers, `That's today's ${V1_LIMITS.reads} reads for this token.`, {
          retry_after: until(now)
        });
      const key = request.headers.get('idempotency-key');
      if (key !== null && !/^[\x20-\x7e]{1,128}$/.test(key.trim()))
        return refuse(
          'invalid_request',
          asText,
          headers,
          'An Idempotency-Key is 1 to 128 printable ASCII characters.',
          {
            field: 'Idempotency-Key'
          }
        );
      const captured = await options.capture({
        api: route.name,
        token: String(request.headers.get('authorization')).slice(7).trim(),
        arguments: args,
        key: key?.trim() ?? null,
        client: clientProduct(request.headers.get('user-agent'))
      });
      if (!object(captured)) throw new Error('Capture response unavailable');
      if (typeof captured.error === 'string') {
        if (!(await record(context, family, 'v1:' + route.name, captured.error)))
          options.log?.({ event: 'activity-unrecorded', kind: 'reads', user: uid });
        return refuse(captured.error, asText, headers, String(captured.message ?? ''), captured);
      }
      const status = Number(captured.status),
        body = (captured.body ?? null) as OAuthRow | null,
        limit = object(captured.limit) ? captured.limit : null,
        extra: Headers = { ...headers };
      if (dry && !(await record(context, family, 'v1:' + route.name, 'ok', tz)))
        options.log?.({ event: 'activity-unrecorded', kind: 'reads', user: uid });
      if (captured.replayed) extra['idempotent-replayed'] = 'true';
      if (limit)
        Object.assign(extra, {
          'ratelimit-limit': String(limit.limit),
          'ratelimit-remaining': String(limit.remaining),
          'ratelimit-reset': String(limit.reset)
        });
      const note = object(body?.note) ? body.note : null,
        unlocked = Array.isArray(body?.unlocked) ? (body.unlocked as OAuthRow[]) : [];
      let line: string | null = null;
      if (asText && route.name === 'upcoming.batch') {
        const n = (list: string) => (Array.isArray(body?.[list]) ? (body[list] as unknown[]).length : 0);
        line =
          `${dry ? 'Checked, nothing saved' : 'Saved'}: ${n('added')} added, ${n('changed')} changed, ${n('removed')} removed.` +
          (unlocked.length ? ` Unlocked: ${unlocked.map((u) => String(u.name)).join(', ')}.` : '');
      } else if (asText && route.name === 'uploads.start')
        line = `Upload ${String(body?.upload)}. Its form's url and fields come in the JSON answer.`;
      else if (asText && route.name === 'places.here') {
        const place = object(body?.place) ? body.place : {},
          nearby = Array.isArray(body?.nearby) ? (body.nearby as OAuthRow[]) : [];
        line =
          placeLine([place.district, place.name, place.region, place.country]) +
          '.' +
          (nearby.length ? ` Nearby: ${nearby.map((v) => String(v.name)).join(', ')}.` : '');
      } else if (asText && route.name.startsWith('check-ins'))
        line = object(body?.check_in)
          ? `Checked in at ${String(body.check_in.label)}.`
          : object(body?.place)
            ? String(body.place.name)
            : body && 'deleted' in body
              ? `Deleted ${String(body.deleted)}.`
              : '';
      else if (asText)
        line =
          route.name === 'tags.pinned'
            ? ((body?.pinned as string[] | undefined) ?? []).map((t) => '#' + t).join(' ') || 'No pinned tags.'
            : route.name === 'days.place'
              ? String((body?.place as OAuthRow | undefined)?.label ?? '')
              : note
                ? `${route.name === 'notes.create' ? 'Filed' : 'Changed'} in ${String(note.version)}.` +
                  (unlocked.length ? ` Unlocked: ${unlocked.map((u) => String(u.name)).join(', ')}.` : '')
                : '';
      return respond(status, body, line, extra);
    }

    // Reads: counted a token a day, and summed into its reads row.
    if (!(await readQuota(context, uid, tid)))
      return refuse('rate_limited', asText, headers, `That's today's ${V1_LIMITS.reads} reads for this token.`, {
        retry_after: until(now)
      });
    type Read = { status: number; body: unknown; line: string } | { code: string; message: string; extra?: OAuthRow };
    // A token reaches the notes it wrote, and every note with notes:all or
    // notes:read.
    const own = (item: OAuthRow) => item.source === 'api' && item.connection === tid,
      reaches = (item: OAuthRow) => own(item) || scopes.includes('notes:all') || scopes.includes('notes:read'),
      unreached = {
        code: 'not_yours',
        message: 'A token reads only the notes it wrote, unless it may reach all your notes.'
      },
      q = new URL(request.url).searchParams,
      // A page of notes in their order, at most `limit` and about `room`
      // bytes, always one, with where the next begins.
      page = async (
        rows: { item: OAuthRow; at: string[] }[],
        limit: number,
        urls: boolean,
        room = NOTES_PAGE_BYTES
      ) => {
        const items: OAuthRow[] = [];
        let bytes = 0;
        for (const n of rows.slice(0, limit)) {
          const plain = noteView(n.item, profile, tid),
            view = urls ? await withUrls(plain, n.item, uid, files) : plain,
            cost = Buffer.byteLength(JSON.stringify(view));
          if (items.length && bytes + cost > room) break;
          items.push(view);
          bytes += cost;
        }
        return { items, next: rows.length > items.length ? cursorFor(rows[items.length - 1]!.at) : null };
      };
    const read = async (): Promise<Read> => {
      if (route.name === 'me') {
        const [days, pauses] = await Promise.all([store.noteDays(uid), store.pauses(uid, true)]),
          have = new Set(days),
          streak = computeStreak(have, have.has(today) ? addDays(today, 1) : today, pauseDays(pauses, today)),
          paused = String(profile.pause_through ?? '') >= today && profile.pause_from ? profile.pause_through : null;
        return {
          status: 200,
          body: {
            account: accountId(uid),
            today,
            version,
            tz,
            send_time: profile.send_time ?? '06:00',
            wrote_today: have.has(today),
            streak: streak.current,
            paused_until: paused,
            status: profile.status ?? 'active',
            show_badges: profile.badges !== false,
            supporting_member: supportingMember(profile, adminUserId),
            lived: lifeCount(computeVersion(birthday, today), birthday),
            days: Array.from({ length: ME_DAYS }, (_, i) => {
              const date = addDays(today, i),
                v = computeVersion(birthday, date);
              return { date, version: v.toString(), lived: lifeCount(v, birthday) };
            }),
            token: {
              id: tid,
              name: token.name,
              scopes,
              expires_at: token.expires_at == null ? null : iso(Number(token.expires_at))
            },
            api_version: API_VERSION
          },
          line: `You're ${version} today.`
        };
      }
      if (route.name === 'tags') {
        const row = await tagRow(store, uid, profile, today);
        return {
          status: 200,
          body: row,
          line: [...row.pinned_names, ...row.recent.map((r) => r.name)].join(', ') || 'No tags yet.'
        };
      }
      if (route.name === 'note') {
        const [date, id] = params as [string, string];
        if (!validDay(date)) return { code: 'not_found', message: 'There is no note with that date and id.' };
        const item = await store.note(uid, date, id, true);
        if (!item) return { code: 'not_found', message: 'There is no note with that date and id.' };
        if (!reaches(item)) return unreached;
        const urls = includeUrls(q);
        if (urls === null) return badInclude;
        const body = noteView(item, profile, tid);
        return {
          status: 200,
          body: urls ? await withUrls(body, item, uid, files) : body,
          line: String(item.text ?? '')
        };
      }
      if (route.name === 'upcoming') {
        // As an agent's upcoming_list: a one-time date already over is left
        // out and only counted, since it still takes one of the account's.
        const all = upcomingViews(await store.upcomingEntries(uid), today),
          views = all
            .filter((v) => v.occurrence.status !== 'past')
            .toSorted((x, y) => x.occurrence.date.localeCompare(y.occurrence.date) || x.title.localeCompare(y.title))
            .map((v) => agentUpcomingView(v, true));
        return {
          status: 200,
          body: { today, entries: views, past_left_out: all.length - views.length, max_entries: UPCOMING_MAX },
          line: views.map((v) => `${String(v.next)} ${String(v.line)}`).join('\n') || 'Nothing upcoming.'
        };
      }
      if (route.name === 'notes') {
        // The notes this token reaches on some days, oldest first (1.9.0):
        // its own, or every note with notes:all, or its own with mine=true.
        const range = dayRange(q) ?? {
          code: 'invalid_request',
          message: 'from is a day, YYYY-MM-DD.',
          extra: { field: 'from' }
        };
        if ('code' in range) return range;
        const limit = limitFrom(q, 50, 100);
        if (isRefusal(limit)) return limit;
        const urls = includeUrls(q);
        if (urls === null) return badInclude;
        const only = q.get('mine');
        if (only !== null && only !== 'true' && only !== 'false')
          return { code: 'invalid_request', message: 'mine is true or false.', extra: { field: 'mine' } };
        const kept = only === 'true' ? own : reaches,
          after = afterFrom(q, 3);
        if (isRefusal(after)) return after;
        const mine = (await store.notesBetween(uid, range.first, range.last, { ConsistentRead: true }))
            .filter(kept)
            .map((item) => ({ item, at: noteAt(item) }))
            .sort(oldestFirst)
            .filter((n) => !after || later(n.at, after)),
          { items, next } = await page(mine, limit, urls);
        return {
          status: 200,
          body: { from: range.first, to: range.last, items, next },
          line: items.map((n) => `${String(n.date)} ${String(n.text).replace(/\s*\n\s*/g, ' ')}`).join('\n')
        };
      }
      if (route.name === 'days') {
        // The timeline, newest first, as the web's: a day with notes, an
        // email, a pause or a place, and today. What's on a day comes from
        // GET /v1/notes or GET /v1/days/{date}, so a page stays small.
        const limit = limitFrom(q, 30, 100);
        if (isRefusal(limit)) return limit;
        const before = q.get('before');
        if (before !== null && !validDay(before))
          return { code: 'invalid_request', message: 'before is a day, YYYY-MM-DD.', extra: { field: 'before' } };
        const [sent, have, pauses, placed] = await Promise.all([
            store.sentDays(uid),
            store.noteDays(uid),
            store.pauses(uid, true),
            store.placesBetween(uid, birthday, today)
          ]),
          emailed = new Set(sent),
          paused = pauseDays(pauses, today),
          dates = new Set([...emailed, ...have, ...paused, ...Object.keys(placed)]);
        if (before === null) dates.add(today);
        const picked = [...dates]
            .filter((d) => d >= birthday && d <= today && (before === null || d < before))
            .sort()
            .reverse(),
          shown = picked.slice(0, limit);
        if (!shown.length) return { status: 200, body: { today, tz, days: [], next: null }, line: 'No days.' };
        const first = shown.at(-1)!,
          last = shown[0]!,
          [notes, sky] = await Promise.all([
            store.notesBetween(uid, first, last, { ConsistentRead: true }),
            store.weatherBetween(uid, first, last)
          ]),
          by: Record<string, OAuthRow[]> = {};
        for (const n of notes) (by[String(n.sk).split('#')[1]!] ??= []).push(n);
        const days = shown.map((d) => ({
          ...dayHead(profile, d, by[d] ?? [], placed[d] ?? null, sky[d] ?? null),
          notes_total: (by[d] ?? []).length,
          files: (by[d] ?? []).reduce((sum, n) => sum + ((n.media as unknown[] | undefined)?.length ?? 0), 0),
          emailed: emailed.has(d),
          paused: paused.has(d)
        }));
        return {
          status: 200,
          body: {
            today,
            tz,
            days,
            next: picked.length > shown.length ? first : null,
            ...(days.some((d) => d.weather) ? { weather_credit: WEATHER_CREDIT } : {})
          },
          line: days.map((d) => `${d.date} ${d.version} ${d.notes_total} notes`).join('\n')
        };
      }
      if (route.name === 'day') {
        const date = livedDay(params[0]!, 'date', birthday, today);
        if (isRefusal(date)) return date;
        const urls = includeUrls(q);
        if (urls === null) return badInclude;
        const [notes, own, weather, pauses] = await Promise.all([
            store.notesBetween(uid, date, date, { ConsistentRead: true }),
            store.dayPlace(uid, date, true),
            store.weatherBetween(uid, date, date, true),
            store.pauses(uid, true)
          ]),
          sky = weather[date] ?? null,
          rows = notes.map((item) => ({ item, at: noteAt(item) })).sort(oldestFirst),
          { items, next } = await page(rows, Math.max(rows.length, 1), urls),
          collected = notes.length && profile.badges !== false ? collectedOn(birthday, date) : [];
        return {
          status: 200,
          body: {
            ...dayHead(profile, date, notes, own, sky),
            today: date === today,
            tz,
            paused: pauseDays(pauses, today).has(date),
            ...(collected.length ? { collected } : {}),
            notes_total: notes.length,
            notes: items,
            next,
            ...(sky ? { weather_credit: WEATHER_CREDIT } : {})
          },
          line: items.map((n) => String(n.text).replace(/\s*\n\s*/g, ' ')).join('\n')
        };
      }
      if (route.name === 'search') {
        // Every word, in the words, places, link names, transcripts and
        // descriptions, as the web and MCP search; newest first.
        const sought = soughtFrom(q);
        if (isRefusal(sought)) return sought;
        const { terms, tag } = sought;
        if (!terms.length && tag === null)
          return { code: 'invalid_request', message: 'Send q, the words to find, or a tag.', extra: { field: 'q' } };
        const first = q.get('from') === null ? birthday : livedDay(q.get('from')!, 'from', birthday, today),
          last = q.get('to') === null ? today : livedDay(q.get('to')!, 'to', birthday, today);
        if (isRefusal(first)) return first;
        if (isRefusal(last)) return last;
        if (last < first)
          return { code: 'invalid_request', message: 'to is the same day as from or later.', extra: { field: 'to' } };
        const limit = limitFrom(q, 50, 100);
        if (isRefusal(limit)) return limit;
        const urls = includeUrls(q);
        if (urls === null) return badInclude;
        const after = afterFrom(q, 3);
        if (isRefusal(after)) return after;
        const matched = (await store.notesBetween(uid, first, last, { ConsistentRead: true }))
            .filter((i) => finds(i as NoteRecord, sought))
            .map((item) => ({ item, at: noteAt(item) }))
            .sort((x, y) => oldestFirst(y, x)),
          rest = matched.filter((n) => !after || later(after, n.at)),
          { items, next } = await page(rest, limit, urls);
        return {
          status: 200,
          body: { terms, tag, from: first, to: last, total: matched.length, items, next },
          line: items.map((n) => `${String(n.date)} ${String(n.text).replace(/\s*\n\s*/g, ' ')}`).join('\n')
        };
      }
      if (route.name === 'on-this-day') {
        // The same patch of each earlier release, newest first, as the daily
        // email's. A day shows its first few notes; GET /v1/days/{date} reads
        // the rest.
        const day = q.get('date') === null ? today : livedDay(q.get('date')!, 'date', birthday, today);
        if (isRefusal(day)) return day;
        const limit = limitFrom(q, 10, 50);
        if (isRefusal(limit)) return limit;
        const urls = includeUrls(q);
        if (urls === null) return badInclude;
        const before = q.get('before');
        if (before !== null && !validDay(before))
          return { code: 'invalid_request', message: 'before is a day, YYYY-MM-DD.', extra: { field: 'before' } };
        const have = new Set(await store.noteDays(uid)),
          earlier = sameDayBefore(birthday, day).filter((d) => have.has(d) && (before === null || d < before)),
          days: OAuthRow[] = [];
        let bytes = 0,
          read = 0;
        for (const d of earlier.slice(0, limit)) {
          const notes = await store.notesBetween(uid, d, d, { ConsistentRead: true }),
            rows = notes.map((item) => ({ item, at: noteAt(item) })).sort(oldestFirst),
            { items } = await page(rows, PAST_NOTES, urls, NOTES_PAGE_BYTES / 4),
            entry = {
              date: d,
              version: computeVersion(birthday, d).toString(),
              notes_total: notes.length,
              notes: items
            },
            cost = Buffer.byteLength(JSON.stringify(entry));
          if (days.length && bytes + cost > NOTES_PAGE_BYTES) break;
          read++;
          bytes += cost;
          if (notes.length) days.push(entry);
        }
        return {
          status: 200,
          body: {
            date: day,
            version: computeVersion(birthday, day).toString(),
            days,
            next: earlier.length > read ? earlier[read - 1]! : null
          },
          line:
            days.map((d) => `${String(d.date)} ${String(d.version)} ${String(d.notes_total)} notes`).join('\n') ||
            'Nothing on this day.'
        };
      }
      if (route.name === 'releases') {
        const releases = releaseList(birthday, today, await store.noteTags(uid));
        return {
          status: 200,
          body: { today, releases },
          line: releases.map((r) => `${String(r.v)} ${String(r.notes)} notes`).join('\n')
        };
      }
      if (route.name === 'release') {
        const age = releaseAge(params[0]!);
        if (age === null || age > computeVersion(birthday, today).age)
          return { code: 'not_found', message: 'There is no such release. GET /v1/releases lists them.' };
        const [index, pauses] = await Promise.all([store.noteTags(uid), store.pauses(uid, true)]),
          release = releaseDetail(profile, today, age, index, pauses);
        return {
          status: 200,
          body: { today, release },
          line: `${String(release.v)} ${String(release.notes)} notes`
        };
      }
      if (route.name === 'tags.all') {
        // Every tag, with its notes, Upcoming dates and check-ins (1.21.0),
        // each check-in a stay as lists show it, hidden ones left out. A
        // token without the scope to read those says null for them.
        const dates = scopes.includes('upcoming'),
          stops = scopes.includes('activity'),
          [notes, upcoming, stays] = await Promise.all([
            store.noteTags(uid),
            dates ? store.upcomingEntries(uid) : [],
            stops ? everyStay(store, uid).then((all) => all.stays) : []
          ]),
          tags = tagTotals(
            notes,
            upcoming,
            stays.map((members) => ({ ...tagLists(stayTags(members)), day: members[0]!.day }))
          ).map((t) => ({ ...t, upcoming: dates ? t.upcoming : null, check_ins: stops ? t.check_ins : null }));
        return {
          status: 200,
          body: { tags },
          line:
            tags
              .map(
                (t) =>
                  `${t.name}: ${t.notes} notes` +
                  (t.upcoming === null ? '' : `, ${t.upcoming} upcoming`) +
                  (t.check_ins === null ? '' : `, ${t.check_ins} check-ins`)
              )
              .join('\n') || 'No tags yet.'
        };
      }
      if (route.name === 'map.pins') {
        // The Map's pins, a page at a time by size. A client draws its own
        // map: the base map stays the web's.
        const after = afterFrom(q, 2);
        if (isRefusal(after)) return after;
        // Words and a tag narrow the pins as GET /v1/search finds notes (1.19.0).
        const sought = soughtFrom(q);
        if (isRefusal(sought)) return sought;
        // Each says when it was written (1.19.0): ids are random, so a day's
        // pins come in no order of their own, and a client drawing the notes
        // in turn needs the time.
        const notes = (await store.allNotes(uid, true)) as NoteRecord[],
          written = new Map(notes.map((n) => [String(n.sk), writtenAt(n) || null])),
          all = pins(
            notes.filter((n) => finds(n, sought)),
            birthday
          )
            .map((pin) => ({
              pin: { ...pin, written_at: written.get(`NOTE#${pin.date}#${pin.id}`) ?? null },
              at: [pin.date, pin.id]
            }))
            .sort(oldestFirst)
            .filter((n) => !after || later(n.at, after)),
          shown: (typeof all)[number]['pin'][] = [];
        let bytes = 0;
        for (const { pin } of all) {
          const cost = Buffer.byteLength(JSON.stringify(pin));
          if (shown.length && bytes + cost > NOTES_PAGE_BYTES) break;
          shown.push(pin);
          bytes += cost;
        }
        return {
          status: 200,
          body: {
            notes: notes.length,
            pins: shown,
            next: all.length > shown.length ? cursorFor(all[shown.length - 1]!.at) : null
          },
          line: shown.map((p) => `${p.date} ${p.place}`).join('\n') || 'No places yet.'
        };
      }
      if (route.name === 'badges') {
        const head = { today, version, show_badges: profile.badges !== false };
        if (!head.show_badges) return { status: 200, body: head, line: 'Badges are turned off.' };
        const facts = await badgeFacts(store, uid, profile, today, {
            consistent: true,
            ...(context!.log ? { log: context!.log } : {})
          }),
          answer = evaluateBadges(facts, today);
        return { status: 200, body: { ...head, ...answer }, line: `${answer.earned.length} badges earned.` };
      }
      if (route.name === 'mail-log') {
        // What became of each email in the last 30 days, newest first.
        const from = activityTime(localStart(addDays(today, -29), tz)),
          entries = (await store.activityAll(uid, from)).filter((r) => r.kind === 'mail').map(agentMailView);
        return {
          status: 200,
          body: { today, tz, entries },
          line: entries.map((e) => `${String(e.received_at)} ${String(e.outcome)}`).join('\n') || 'No email in 30 days.'
        };
      }
      if (route.name === 'notes.file') {
        // One file on a note this token wrote, as a short-lived address.
        const [date, id, n] = params as [string, string, string];
        if (!validDay(date)) return { code: 'not_found', message: 'There is no note with that date and id.' };
        const item = await store.note(uid, date, id, true);
        if (!item) return { code: 'not_found', message: 'There is no note with that date and id.' };
        if (!reaches(item)) return unreached;
        const file = ((item.media as OAuthRow[] | undefined) ?? []).find((m) => Number(m.n) === Number(n));
        if (!file) return { code: 'not_found', message: 'That note has no file by that number. Read the note again.' };
        const size = q.get('size');
        if (size !== null && size !== 'thumb')
          return { code: 'invalid_request', message: 'size is thumb, or left out.', extra: { field: 'size' } };
        const thumb = object(file.thumb) ? file.thumb : null,
          key = size ? thumb?.key : file.key,
          type = size ? 'image/jpeg' : String(file.type);
        if (typeof key !== 'string')
          return { code: 'not_found', message: 'That file has no small copy. Ask without size for the file itself.' };
        if (!key.startsWith(`media/${uid}/`) || !files) throw new Error('File unavailable');
        const url = await files.download(uid, key, type, FILE_SECONDS);
        return { status: 200, body: { url, type, expires_in: FILE_SECONDS }, line: url };
      }
      if (route.name === 'places') {
        // The web's city search, for a note's place (docs/API.md, Phase 3).
        const words = pythonTrim(q.get('q') ?? '');
        if (codePointLength(words) < 2 || codePointLength(words) > 80)
          return { code: 'invalid_request', message: "q is a city's name, 2 to 80 characters.", extra: { field: 'q' } };
        let found: City[];
        try {
          found = await cities(words);
        } catch {
          return { code: 'unavailable', message: 'The city search is unavailable. Try again shortly.' };
        }
        return {
          status: 200,
          body: { places: found },
          line: found.map((c) => placeLine([c.name, c.region, c.country])).join('\n') || 'No city by that name.'
        };
      }
      if (route.name === 'check-ins') {
        // Stays newest first, by when they began. A day range is the account's
        // days, as for the activity log.
        const limit = limitFrom(q, 50, 100);
        if (isRefusal(limit)) return limit;
        const asked = q.get('before');
        if (asked !== null && !CHECK_IN_CURSOR.test(asked))
          return {
            code: 'invalid_request',
            message: 'before is the next from an earlier answer.',
            extra: { field: 'before' }
          };
        const days = dayRange(q);
        if (days && 'code' in days) return days;
        // Only the stays with a tag (1.21.0), by any spelling.
        const tag = tagFrom(q);
        if (isRefusal(tag)) return tag;
        const start = (day: string) => new Date(Date.parse(localMoment(day, '00:00', tz))).toISOString(),
          ceiling = days ? start(addDays(days.last, 1)) : undefined,
          before = asked ?? ceiling,
          { stays, next, places } = await stayPage(store, uid, {
            ...(before === undefined ? {} : { before: ceiling && before > ceiling ? ceiling : before }),
            ...(days ? { floor: start(days.first) } : {}),
            ...(tag === null ? {} : { tag }),
            limit
          }),
          items = stays.map((members) => stayView(members, places));
        return {
          status: 200,
          body: { items, next },
          line: items.map((i) => `${String(i.at)} ${String(i.label)}`).join('\n') || 'No check-ins.'
        };
      }
      if (route.name === 'check-ins.places.get') {
        // One place, and how many check-ins are there, hidden or not: what
        // "Delete existing check-ins here" asks before it deletes.
        const place = (await store.namedPlaces(uid)).find((p) => p.id === params[0]);
        if (!place)
          return {
            code: 'not_found',
            message: 'There is no remembered place with that id. GET /v1/check-ins/places lists them.'
          };
        const { stays } = await staysAt(store, uid, place.id);
        return {
          status: 200,
          body: { place: { ...namedPlaceView(place), check_ins: stays.length } },
          line: `${place.name}: ${stays.length} ${stays.length === 1 ? 'check-in' : 'check-ins'}${place.ignored ? ', ignored' : ''}.`
        };
      }
      if (route.name === 'check-ins.places') {
        const places = await store.namedPlaces(uid);
        return {
          status: 200,
          body: { places: places.map(namedPlaceView) },
          line: places.map((p) => (p.ignored ? `${p.name} (ignored)` : p.name)).join('\n') || 'No remembered places.'
        };
      }
      if (route.name === 'upcoming.reminders') {
        // The reminders each morning's email carries (remindersFor), all of
        // them, for an app to show at the moment that email is due.
        const days = q.get('days') === null ? ME_DAYS : Number(q.get('days'));
        if (!Number.isInteger(days) || days < 1 || days > REMINDER_DAYS_MAX)
          return {
            code: 'invalid_request',
            message: `days is 1 to ${REMINDER_DAYS_MAX}.`,
            extra: { field: 'days' }
          };
        const entries = await store.upcomingEntries(uid),
          sendTime = String(profile.send_time ?? '06:00'),
          through = addDays(today, days - 1),
          out = Array.from({ length: days }, (_, i) => addDays(today, i))
            .map((date) => ({ date, due: remindersFor(entries, date).due }))
            .filter((d) => d.due.length)
            .map(({ date, due }) => ({
              date,
              send_at: localMoment(date, sendTime, tz),
              reminders: due.map((r) => ({ upcoming: r.id, date: r.date, when: r.when, line: r.line }))
            }));
        return {
          status: 200,
          body: { from: today, through, days: out },
          line:
            out.flatMap((d) => d.reminders.map((r) => `${d.date} ${r.when}: ${r.line}`)).join('\n') ||
            `No reminders through ${through}.`
        };
      }
      // The activity log, trimmed of words (packages/domain/activity.ts).
      // A row's id ends in whatever made it unique, which can be a badge's
      // key (`roadmap:alpha`): any printable ASCII but the `#` between parts.
      const cursor = (field: string) => {
        const value = q.get(field);
        if (value === null) return undefined;
        if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z#[a-z.]+#[\x21\x22\x24-\x7e]{1,200}$/.test(value)) throw new Error(field);
        return value;
      };
      let before: string | undefined, after: string | undefined, lowest: string | undefined;
      try {
        before = cursor('before');
        after = cursor('after');
      } catch (error) {
        const field = (error as Error).message;
        return { code: 'invalid_request', message: `${field} is an id from an earlier answer.`, extra: { field } };
      }
      // Days in the account's zone (1.9.0), as instants the log's ids start with.
      const days = dayRange(q);
      if (days && 'code' in days) return days;
      if (days) {
        const start = (day: string) => new Date(Date.parse(localMoment(day, '00:00', tz))).toISOString(),
          lo = start(days.first),
          hi = start(addDays(days.last, 1));
        before = before === undefined || before > hi ? hi : before;
        if (after === undefined || after < lo) lowest = lo;
      }
      const kinds = q.get('kinds')
        ? q
            .get('kinds')!
            .split(',')
            .map((k) => k.trim())
        : null;
      if (kinds && kinds.some((k) => !(ACTIVITY_FAMILIES as readonly string[]).includes(k)))
        return {
          code: 'invalid_request',
          message: `kinds are some of ${ACTIVITY_FAMILIES.join(', ')}.`,
          extra: { field: 'kinds' }
        };
      const limit = q.get('limit') === null ? 50 : Number(q.get('limit'));
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return { code: 'invalid_request', message: 'limit is 1 to 100.', extra: { field: 'limit' } };
      const upcoming = scopes.includes('upcoming'),
        titles = upcoming ? new Map((await store.upcomingEntries(uid)).map((e) => [e.id, e.title])) : null,
        items: OAuthRow[] = [];
      let more = false,
        read = 0,
        from = before;
      // Bounds that do not overlap (a cursor outside the days asked) hold
      // nothing; the store's range query cannot be asked for them.
      const floor = lowest ?? after;
      scan: for (; !(floor !== undefined && from !== undefined && floor >= from);) {
        const bottom = floor,
          page = await store.activity(uid, { before: from, ...(bottom ? { from: bottom } : {}), limit: 200 });
        for (const row of page.rows) {
          const id = activityId(String(row.sk));
          if (id === after) continue;
          if (!kinds || kinds.includes(familyOf(String(row.kind)))) {
            if (items.length >= limit) {
              more = true;
              break scan;
            }
            const view = tokenActivityView(row);
            items.push(titles ? titled(view, titles) : view);
          }
          from = id;
          if (++read >= 2000) {
            more = page.more || row !== page.rows.at(-1);
            break scan;
          }
        }
        if (!page.more) break;
      }
      return {
        status: 200,
        body: { items, next: more ? from : null },
        line: items
          .map((i) => `${String(i.at)} ${String(i.kind)}${i.token ? ` via ${String(i.token)}` : ''}`)
          .join('\n')
      };
    };
    const outcome = await read();
    if (!(await record(context, family, 'v1:' + route.name, 'code' in outcome ? outcome.code : 'ok', tz)))
      options.log?.({ event: 'activity-unrecorded', kind: 'reads', user: uid });
    if ('code' in outcome) return refuse(outcome.code, asText, headers, outcome.message, outcome.extra);
    return respond(outcome.status, outcome.body, asText ? outcome.line : null, headers);
  } catch (error) {
    failure(context?.now ?? Math.floor(Date.now() / 1000), uid, options.log, error);
    return refuse('unavailable', asText);
  }
}
