// The activity log (docs/WEB-APP.md): what happened in this account, newest
// first, a page at a time, each row one sentence. A mail row that wasn't
// filed keeps its words only when its sender was proven; "Add to" puts them
// in that day's draft, and nothing is saved until the note is.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AppLink, Bar, Crumb, Failed, Loading, useTitle } from '../components/common.tsx';
import { clock, count, dayName, listed, thisYearOf, zoneShortDate, zoneTime } from '../lib/format.ts';
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
        Everything that happened in your Release Notes, newest first: notes added, changed or deleted, recordings
        written out and photos described, badges earned, each daily email and the Upcoming reminders it carried,
        Upcoming dates, settings, sign-ins and connected assistants, each email sent to your Release Notes addresses and
        what became of it, and each day an assistant read your notes. When an email isn’t filed because of a problem,
        you get an email about it too.
      </p>
      {log.isPending && <Loading />}
      {log.isError && !l && <Failed />}
      {l &&
        (entries.length ? (
          <ol className="activity" id="activity">
            {entries.map((e) => (
              <Row key={e.id} e={e} l={l} />
            ))}
          </ol>
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
      <p className="hint spaced">
        <AppLink href="/settings/">Settings</AppLink>
      </p>
    </>
  );
}

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
  here: 'Add where I am'
};
const setting = (field: string, value: unknown) =>
  value === true
    ? 'on'
    : value === false
      ? 'off'
      : value == null || value === ''
        ? 'none'
        : field === 'send_time'
          ? clock(String(value))
          : String(value);
const SCOPES: Record<string, string> = {
  'notes:read': 'read notes',
  'media:read': 'see photos and audio',
  'notes:write': 'add notes',
  upcoming: 'Upcoming'
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
        e.day ? `With a note on ${dayName(e.day, year)}.` : undefined
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
      return [`Connected ${e.client}`, `It may ${scopes(e.scopes)}.`];
    case 'connection.changed':
      return [`Changed what ${e.client} may do`, `It may ${scopes(e.to)}.`];
    case 'connection.removed':
      return [
        `Disconnected ${e.client}`,
        e.reason === 'client'
          ? `${e.client} ended the connection itself.`
          : e.reason === 'token-reuse'
            ? 'A sign-in it had already used came back, so the connection was ended to be safe.'
            : undefined
      ];
    case 'account.created':
      return ['Joined Release Notes'];
    default:
      return [e.kind];
  }
}

const VIA: Record<string, string> = { web: 'On the web', email: 'By email', import: 'Import' };

function EventRow({ e, l }: { e: EventActivity; l: ActivityData }) {
  const [what, more] = said(e, l),
    via = e.via === 'assistant' ? e.client : e.via ? VIA[e.via] : null;
  return (
    <li className={`activity-row event ${e.kind.split('.')[0]}`}>
      <p className="kicker">
        {zoneShortDate(e.at, l.tz)} · {zoneTime(e.at, l.tz)}
        {via ? ` · ${via}` : ''}
      </p>
      <p className="activity-what">{what}</p>
      {more && <p className="hint">{more}</p>}
    </li>
  );
}

function ReadsRow({ e, l }: { e: ReadsActivity; l: ActivityData }) {
  return (
    <li className="activity-row reads">
      <p className="kicker">
        {zoneShortDate(e.last_at, l.tz)} · {e.client}
      </p>
      <p className="activity-what">Read your notes {count(e.calls, 'time', 'times')}</p>
      <p className="hint">
        Last at {zoneTime(e.last_at, l.tz)}
        {e.errors ? `; ${count(e.errors, 'request was', 'requests were')} turned down` : ''}.
      </p>
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
      <p className="kicker">
        {zoneShortDate(e.received_at, l.tz)} · {zoneTime(e.received_at, l.tz)} ·{' '}
        {e.via === 'address' ? 'Standing address' : `Reply to ${e.version}`}
      </p>
      <p className="activity-what mail-outcome">
        {e.outcome === 'filed' ? (
          <>
            Filed to <AppLink href={dayHref(e.day, l.today)}>{day}</AppLink>
          </>
        ) : e.outcome === 'failed' ? (
          'Not filed yet'
        ) : (
          'Not filed'
        )}
      </p>
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
    </li>
  );
}
