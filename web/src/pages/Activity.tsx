// The activity log (docs/WEB-APP.md): what happened in this account, newest
// first, a page at a time, each row one sentence. A mail row that wasn't
// filed keeps its words only when its sender was proven; "Add to" puts them
// in that day's draft, and nothing is saved until the note is.
import { useInfiniteQuery } from '@tanstack/react-query';
import { Fragment, type ReactNode, useState } from 'react';
import { AppLink, Bar, Crumb, Failed, Loading, useTitle } from '../components/common.tsx';
import { Icon, type IconName } from '../components/icon.tsx';
import { clock, count, dayName, listed, thisYearOf, zoneTime } from '../lib/format.ts';
import { activityQuery } from '../lib/queries.ts';
import { store } from '../lib/storage.ts';
import type {
  Activity as ActivityData,
  ActivityEntry,
  EventActivity,
  MailActivity,
  ReadsActivity
} from '../lib/types.ts';

export function Activity() {
  useTitle('Activity');
  const log = useInfiniteQuery(activityQuery);
  const pages = log.data?.pages || [];
  const l = pages[0];
  const entries = pages.flatMap((p) => p.entries);
  return (
    <>
      <Bar />
      <Crumb href="/you/">You</Crumb>
      <h1>Activity</h1>
      <p className="lede" id="activity-lede">
        Everything that happened in your Release Notes, newest first.
      </p>
      <details className="activity-kept" id="activity-kept">
        <summary>What’s kept here</summary>
        <ul>
          <li>Notes added, changed or deleted, and recordings written out and photos described</li>
          <li>Badges earned</li>
          <li>Each daily email and the Upcoming reminders it carried</li>
          <li>Upcoming dates, settings, sign-ins and connected assistants</li>
          <li>Each email sent to your Release Notes addresses, and what became of it</li>
          <li>Each day an assistant read your notes</li>
        </ul>
        <p className="hint">
          When an email isn’t filed because of a problem, you get an email about it too. A row never copies the words of
          a note.
        </p>
      </details>
      {log.isPending && <Loading />}
      {log.isError && !l && <Failed />}
      {l &&
        (entries.length ? (
          <div className="activity" id="activity">
            {byDay(entries, l).map(([day, rows]) => (
              <Fragment key={day}>
                <h2 className="kicker activity-day">{dayHead(day, l)}</h2>
                <ol>
                  {rows.map((e) => (
                    <Row key={e.id} e={e} l={l} />
                  ))}
                </ol>
              </Fragment>
            ))}
          </div>
        ) : (
          <p className="hint spaced" id="activity-empty">
            Nothing yet.
          </p>
        ))}
      {log.isFetchNextPageError && <Failed />}
      <button
        className="quiet"
        type="button"
        id="older"
        hidden={!log.hasNextPage}
        disabled={log.isFetchingNextPage}
        onClick={() => log.fetchNextPage()}
      >
        Older
      </button>
    </>
  );
}

const at = (e: ActivityEntry) =>
  e.kind === 'mail' ? (e as MailActivity).received_at : e.kind === 'reads' ? (e as ReadsActivity).last_at : e.at;
// The subscriber's own calendar day for an instant, as an ISO date.
const localDay = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

// Rows under the day they happened, in the order the log gives them.
function byDay(entries: ActivityEntry[], l: ActivityData): [string, ActivityEntry[]][] {
  const days: [string, ActivityEntry[]][] = [];
  for (const e of entries) {
    const day = localDay(at(e), l.tz);
    if (days.at(-1)?.[0] === day) days.at(-1)![1].push(e);
    else days.push([day, [e]]);
  }
  return days;
}

const dayHead = (day: string, l: ActivityData) =>
  day === l.today ? `Today · ${dayName(day, thisYearOf(l.today))}` : dayName(day, thisYearOf(l.today));

// One row: the time, a glyph for what kind of thing it was, then what
// happened, more about it, and the channel it came through.
function Line({
  e,
  l,
  icon,
  what,
  via,
  children
}: {
  e: ActivityEntry;
  l: ActivityData;
  icon: IconName;
  what: ReactNode;
  via?: string | null;
  children?: ReactNode;
}) {
  return (
    <>
      <span className="activity-time">{zoneTime(at(e), l.tz)}</span>
      <Icon name={icon} />
      <div>
        <p className="activity-what">{what}</p>
        {children}
        {via && <p className="meta activity-via">{via}</p>}
      </div>
    </>
  );
}

const GLYPHS: Record<string, IconName> = {
  note: 'today',
  badge: 'badges',
  upcoming: 'upcoming',
  reminder: 'upcoming',
  email: 'mail',
  transcript: 'record',
  description: 'files',
  import: 'archive',
  place: 'where',
  settings: 'settings',
  pause: 'settings',
  status: 'mail',
  signin: 'you',
  account: 'you',
  export: 'download',
  photo: 'you',
  address: 'mail',
  calendar: 'calendar',
  connection: 'assistant',
  feedback: 'feedback',
  egg: 'badges'
};

function Row({ e, l }: { e: ActivityEntry; l: ActivityData }) {
  if (e.kind === 'mail') return <MailRow e={e as MailActivity} l={l} />;
  if (e.kind === 'reads') return <ReadsRow e={e as ReadsActivity} l={l} />;
  return <EventRow e={e as EventActivity} l={l} />;
}

const SETTINGS: Record<string, string> = {
  send_time: 'Send time',
  tz: 'Time zone',
  city: 'City',
  region: 'Region',
  country: 'Country',
  transcribe: 'Transcripts',
  describe: 'Photo descriptions',
  badges: 'Badges',
  here: 'Add where I am',
  pinned_tags: 'Pinned tags'
};
const setting = (field: string, value: unknown) =>
  value === true
    ? 'on'
    : value === false
      ? 'off'
      : value == null || value === '' || (Array.isArray(value) && !value.length)
        ? 'none'
        : Array.isArray(value)
          ? value.map((t) => '#' + String(t)).join(' ')
          : field === 'send_time'
            ? clock(String(value))
            : String(value);
const SCOPES: Record<string, string> = {
  'notes:read': 'read notes',
  'media:read': 'see photos and audio',
  'notes:write': 'add notes',
  'media:write': 'add files',
  upcoming: 'keep Upcoming dates',
  activity: 'read the activity log'
};
const scopes = (s: string | undefined) =>
  listed(
    (s || '')
      .split(' ')
      .filter(Boolean)
      .map((x) => SCOPES[x] || x)
  );

// What one row says, and a line under it when there is more to say.
function said(e: EventActivity, l: ActivityData): [React.ReactNode, string?] {
  const year = thisYearOf(l.today),
    day = e.day ? <AppLink href={dayHref(e.day, l.today)}>{dayName(e.day, year)}</AppLink> : null,
    date = e.title ? `“${e.title}”` : 'a date';
  switch (e.kind) {
    case 'note.added':
      return [<>Added a note to {day}</>, e.files ? `With ${count(e.files, 'file', 'files')}.` : undefined];
    case 'note.edited':
      if (e.place === 'set') return [<>Set where a note was on {day}</>];
      if (e.place === 'removed') return [<>Cleared where a note was on {day}</>];
      return [<>Changed a note on {day}</>];
    case 'note.deleted':
      return [
        <>Deleted a note from {e.day ? dayName(e.day, year) : 'a day'}</>,
        e.files ? `It had ${count(e.files, 'file', 'files')}.` : undefined
      ];
    case 'note.files':
      return [
        <>
          Added {count(e.added || 0, 'file', 'files')} to a note on {day}
        </>
      ];
    case 'badge.earned':
      return [
        <>
          Earned <AppLink href="/badges/">{e.name}</AppLink>
        </>,
        e.day
          ? `With a note on ${dayName(e.day, year)}.`
          : e.via === 'weekly-thing'
            ? 'As a Weekly Thing Supporting Member.'
            : undefined
      ];
    case 'upcoming.added':
      return [
        <>
          Added {date} to <AppLink href="/upcoming/">Upcoming</AppLink>
        </>
      ];
    case 'upcoming.changed':
      return [
        <>
          Changed {date} in <AppLink href="/upcoming/">Upcoming</AppLink>
        </>
      ];
    case 'upcoming.removed':
      return [<>Removed {date} from Upcoming</>];
    case 'reminder':
      return [<>The daily email reminded you of {date}</>, e.when ? `${e.when}.` : undefined];
    case 'email.sent':
      return [<>Sent the daily email for {day}</>, e.version ? `Version ${e.version}.` : undefined];
    case 'transcript.added':
      return [<>Wrote out a recording on {day}</>, e.empty ? 'Nothing in it could be made out.' : undefined];
    case 'description.added':
      return [
        <>
          Described {count(e.photos || 0, 'photo', 'photos')} on {day}
        </>
      ];
    case 'import.notes':
      return [
        `Imported ${count(e.notes || 0, 'note', 'notes')}${e.app === 'dayone' ? ' from Day One' : ''}`,
        e.files ? `With ${count(e.files, 'file', 'files')}.` : undefined
      ];
    case 'place.set':
      return [<>Set where you were on {day}</>];
    case 'place.removed':
      return [<>Cleared where you were on {day}</>];
    case 'settings.changed':
      return [
        'Changed settings',
        (e.changes || [])
          .map((c) => `${SETTINGS[c.field] || c.field}: ${setting(c.field, c.from)} to ${setting(c.field, c.to)}`)
          .join('; ') + '.'
      ];
    case 'pause.set':
      return [`Paused the daily email from ${dayName(e.from!, year)} through ${dayName(e.through!, year)}`];
    case 'pause.ended':
      return [
        'Ended a pause',
        e.through ? `The last paused day was ${dayName(e.through, year)}.` : 'It ended before it began.'
      ];
    case 'status.stopped':
      return e.reason === 'bounce' || e.reason === 'complaint'
        ? [
            'The daily email stopped',
            e.reason === 'bounce'
              ? 'Your address turned it away as undeliverable. You can restart it in Settings.'
              : 'It was reported as spam. You can restart it in Settings.'
          ]
        : ['Stopped the daily email', e.reason === 'unsubscribed' ? 'With the unsubscribe link.' : undefined];
    case 'status.restarted':
      return ['Restarted the daily email'];
    case 'signin':
      return ['Signed in', e.how === 'code' ? 'With an emailed code.' : 'With an emailed link.'];
    case 'export.words':
      return [`Downloaded your notes as ${e.format === 'md' ? 'Markdown' : 'JSON'}`];
    case 'export.zip':
      return ['Started a download of everything'];
    case 'export.book':
      return [
        (e.from && e.to
          ? `Started a book of ${dayName(e.from, year)} through ${dayName(e.to, year)}`
          : 'Started a book') + (e.commentary ? ', with Claude’s commentary' : '')
      ];
    case 'photo.set':
      return ['Added your profile photo'];
    case 'photo.changed':
      return ['Changed your profile photo', 'The old one was deleted.'];
    case 'photo.removed':
      return ['Removed your profile photo', 'It was deleted.'];
    case 'address.created':
      return ['Made your standing address'];
    case 'address.replaced':
      return ['Replaced your standing address', 'The old one no longer takes email.'];
    case 'calendar.created':
      return ['Made your calendar link'];
    case 'calendar.replaced':
      return ['Replaced your calendar link', 'The old one no longer works.'];
    case 'calendar.removed':
      return ['Turned off your calendar link'];
    case 'connection.added':
      if (e.token)
        return [
          e.app ? `Signed in ${e.app} as the API token ${e.token}` : `Made the API token ${e.token}`,
          e.scopes ? `It may ${scopes(e.scopes)}.` : 'It reads your version and tags.'
        ];
      return [`Connected ${e.client}`, `It may ${scopes(e.scopes)}.`];
    case 'connection.changed':
      return [`Changed what ${e.client} may do`, `It may ${scopes(e.to)}.`];
    case 'connection.removed':
      if (e.token)
        return [
          `Revoked the API token ${e.token}`,
          e.reason === 'client' ? `${e.client ?? e.token} signed itself out.` : undefined
        ];
      return [
        `Disconnected ${e.client}`,
        e.reason === 'client'
          ? `${e.client} ended the connection itself.`
          : e.reason === 'token-reuse'
            ? 'A sign-in it had already used came back, so the connection was ended to be safe.'
            : undefined
      ];
    case 'feedback.filed':
      return [
        `Sent Jamie ${FEEDBACK_WORDS[e.feedback_kind ?? ''] ?? 'feedback'}` +
          (e.follows ? ', following up earlier feedback' : ''),
        e.screenshots ? `With ${count(e.screenshots, 'screenshot', 'screenshots')}.` : undefined
      ];
    case 'feedback.answered':
      return [
        e.status === 'needs_info'
          ? 'Jamie asked you about your feedback'
          : e.status === 'done'
            ? 'Jamie answered your feedback and marked it done'
            : 'Jamie answered your feedback',
        e.mail === 'sent' ? 'The answer was emailed to you too.' : undefined
      ];
    case 'egg.found':
      return [e.egg === 'developer' ? 'Became a developer' : e.egg === 'rtfm' ? 'Read the manual' : 'Found something'];
    case 'account.created':
      return ['Joined Release Notes'];
    default:
      return [e.kind];
  }
}

const VIA: Record<string, string> = { web: 'on the web', email: 'by email', import: 'imported', admin: 'by Jamie' };
// The line under a row naming what it came through: an API token by its name
// (docs/API.md, Voice and via), an assistant by its client, the rest by VIA.
export function channel(e: { via?: string; client?: string; token?: string }): string | null {
  if (e.via === 'token') return e.token ? `via ${e.token}` : 'through the API';
  if (e.via === 'assistant') return e.client ?? null;
  return (e.via && VIA[e.via]) || null;
}
const FEEDBACK_WORDS: Record<string, string> = {
  bug: 'a problem',
  idea: 'an idea',
  question: 'a question',
  other: 'feedback'
};

function EventRow({ e, l }: { e: EventActivity; l: ActivityData }) {
  const [what, more] = said(e, l),
    via = channel(e);
  return (
    <li className={`activity-row event ${e.kind.split('.')[0]}`}>
      <Line e={e} l={l} icon={GLYPHS[e.kind.split('.')[0]] || 'activity'} what={what} via={via}>
        {more && <p className="hint">{more}</p>}
      </Line>
    </li>
  );
}

function ReadsRow({ e, l }: { e: ReadsActivity; l: ActivityData }) {
  return (
    <li className="activity-row reads">
      <Line
        e={e}
        l={l}
        icon={e.via === 'token' ? 'api' : 'assistant'}
        what={
          e.via === 'token'
            ? `Used the API ${count(e.calls, 'time', 'times')}`
            : `Read your notes ${count(e.calls, 'time', 'times')}`
        }
        via={e.via === 'token' ? channel(e) : e.client}
      >
        {!!e.errors && <p className="hint">{count(e.errors, 'request was', 'requests were')} turned down.</p>}
      </Line>
    </li>
  );
}

export function why(e: MailActivity, email: string): string {
  switch (e.reason) {
    case 'from-mismatch':
      return `It came from another address. Release Notes takes email only from ${email}.`;
    case 'unauthenticated':
      return `It couldn’t be verified as coming from ${email}.`;
    case 'unparseable':
      return 'It couldn’t be read.';
    case 'auto-reply':
      return 'It looked like an automatic reply.';
    case 'expired':
      return 'It came after that day’s 72 hours for replies.';
    case 'empty':
      return 'It had nothing in it to keep.';
    case 'spam-or-virus':
      return 'It was marked as spam, or failed the virus scan.';
    case 'replaced':
      return 'It went to an address you have since replaced.';
    case 'stopped':
      return 'Your daily emails are stopped, so your standing address isn’t taking email.';
    case 'account-changed':
      return 'Your account changed while it was being filed.';
    case 'failed':
      return e.attempts >= 3
        ? 'Something went wrong while filing it, and three tries didn’t fix it. The problem has been reported.'
        : 'Something went wrong while filing it. It will be tried again shortly.';
    default:
      return '';
  }
}

const dayHref = (day: string, today: string) => (day === today ? '/today/' : `/day/?d=${day}`);

// Appends to that day's draft (this tab only, as the note form keeps it),
// once, ahead of the form reading it.
function draft(day: string, text: string) {
  const key = `rn-draft-${day}`,
    kept = store.get(key) || '';
  if (!kept.includes(text)) store.set(key, kept + (kept ? '\n\n' : '') + text);
}

function MailRow({ e, l }: { e: MailActivity; l: ActivityData }) {
  const [copied, setCopied] = useState(false);
  const year = thisYearOf(l.today),
    day = dayName(e.day, year);
  return (
    <li className={`activity-row mail-row ${e.outcome}`}>
      <Line
        e={e}
        l={l}
        icon="mail"
        what={
          e.outcome === 'filed' ? (
            <>
              Filed your email to <AppLink href={dayHref(e.day, l.today)}>{day}</AppLink>
            </>
          ) : e.outcome === 'failed' ? (
            'Your email isn’t filed yet'
          ) : (
            'Your email wasn’t filed'
          )
        }
        via={e.via === 'address' ? 'to your standing address' : `a reply to ${e.version}`}
      >
        {(e.subject || e.sender) && (
          <p className="hint">
            {e.sender && <>From {e.sender}. </>}
            {e.subject && <>“{e.subject}”</>}
          </p>
        )}
        {e.reason && <p className="hint">{why(e, l.email)}</p>}
        {e.text && (
          <>
            <p className="text mail-text">{e.text}</p>
            <p className="row">
              <AppLink className="quiet" href={dayHref(e.day, l.today)} onClick={() => draft(e.day, e.text!)}>
                Add to {day}
              </AppLink>{' '}
              <button
                className="quiet"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(e.text!);
                    setCopied(true);
                  } catch {
                    setCopied(false);
                  }
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </p>
          </>
        )}
      </Line>
    </li>
  );
}
