// The activity log (docs/WEB-APP.md): what happened in this account, newest
// first, a page at a time. A mail row that wasn't filed keeps its words only
// when its sender was proven; "Add to" puts them in that day's draft, and
// nothing is saved until the note is.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AppLink, Bar, Failed, Loading, useTitle } from '../components/common.tsx';
import { count, dayName, thisYearOf, zoneShortDate, zoneTime } from '../lib/format.ts';
import { activityQuery } from '../lib/queries.ts';
import { store } from '../lib/storage.ts';
import type { Activity as ActivityData, ActivityEntry, MailActivity, ReadsActivity } from '../lib/types.ts';

export function Activity() {
  useTitle('Activity');
  const log = useInfiniteQuery(activityQuery);
  const pages = log.data?.pages || [];
  const l = pages[0];
  const entries = pages.flatMap((p) => p.entries);
  return (
    <>
      <Bar current="/settings/" />
      <h1>Activity</h1>
      <p className="lede" id="activity-lede">
        What happened in your Release Notes, newest first: each email sent to your Release Notes addresses and what
        became of it, and each day a connected assistant read your notes. When an email isn’t filed because of a
        problem, you get an email about it too.
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
  return e.kind === 'mail' ? <MailRow e={e} l={l} /> : <ReadsRow e={e} l={l} />;
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
