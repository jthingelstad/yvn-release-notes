// Personal dates, from a birthday to a trip. The API calculates occurrences in
// the subscriber's zone; forms retain unsaved values after errors or conflicts.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState, type FormEvent } from 'react';
import { Bar, ErrorLine, Failed, Loading, useBusy, useFocusLater, useTitle } from '../components/common.tsx';
import { api } from '../lib/api.ts';
import { upcomingQuery } from '../lib/queries.ts';
import { dayName } from '../lib/format.ts';
import type { Place } from '../lib/types.ts';
import {
  annual,
  defaultReminders,
  UPCOMING_TITLE_MAX,
  type UpcomingKind,
  type UpcomingView
} from '../../../packages/domain/upcoming.ts';

const PlacePicker = lazy(() => import('../components/placepicker.tsx').then((m) => ({ default: m.PlacePicker })));
const NAMES: Record<UpcomingKind, string> = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  trip: 'Trip',
  event: 'One-time event'
};
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' })
);
const PROBLEMS: Record<string, string> = {
  'upcoming-title': 'Add a name or title, up to 120 characters, on one line.',
  'upcoming-date': 'Choose a valid date.',
  'upcoming-year': 'Use a valid original year and date, no later than today. You can leave the year empty.',
  'upcoming-end': 'Choose an end date on or after the start date.',
  'upcoming-place': 'Choose a destination from the city search.',
  'upcoming-reminders': 'Use up to six different numbers from 0 to 365. Zero means on the day.',
  'upcoming-changed':
    'This entry changed in another window. Reload the list and choose Edit again to use the latest version.',
  'upcoming-conflict':
    'Couldn’t save. Reload the list: this entry may have changed, or you may have reached 200 saved dates.',
  'upcoming-missing': 'This entry was removed in another window. Reload the list.'
};
const problemFor = (error?: string) => PROBLEMS[error ?? ''] ?? 'Couldn’t save this date. Please try again.';

export function Upcoming() {
  useTitle('Upcoming');
  const query = useQuery(upcomingQuery),
    client = useQueryClient();
  // undefined: closed; null: new; a saved entry: editing that revision.
  const [selected, setSelected] = useState<UpcomingView | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const [busy, run] = useBusy(),
    heading = useRef<HTMLHeadingElement>(null),
    focusLater = useFocusLater();
  const entries = query.data?.entries ?? [],
    future = entries.filter((e) => e.occurrence.status !== 'past'),
    past = entries.filter((e) => e.occurrence.status === 'past').toReversed();
  function choose(entry: UpcomingView | null) {
    setSelected(entry);
    setProblem(null);
    setNotice('');
    focusLater(() => heading.current);
  }
  async function remove(entry: UpcomingView) {
    if (!window.confirm(`Delete “${entry.title}” from Upcoming?`)) return;
    await run(async () => {
      setProblem(null);
      setNotice('');
      const answer = await api('DELETE', '/api/upcoming/' + entry.id, { revision: entry.revision });
      await client.invalidateQueries({ queryKey: upcomingQuery.queryKey });
      if (!answer.ok) return setProblem(problemFor(answer.data.error));
      if (selected?.id === entry.id) setSelected(undefined);
      setNotice('Date deleted.');
    });
  }
  function list(items: UpcomingView[]) {
    return (
      <ul className="upcoming-list">
        {items.map((entry) => (
          <li key={entry.id}>
            <div className="upcoming-copy">
              <p className="eyebrow">
                {entry.occurrence.status === 'ongoing'
                  ? 'Happening now'
                  : entry.occurrence.status === 'today'
                    ? 'Today'
                    : dayName(entry.occurrence.date, Number(query.data?.today.slice(0, 4)))}
              </p>
              <h3>{entry.title}</h3>
              <p>{entry.occurrence.line}</p>
              <p className="hint">
                {NAMES[entry.kind]}
                {annual(entry.kind) ? ' · Every year' : ''} · {entry.email ? 'In your daily email' : 'Web only'}
              </p>
            </div>
            <div className="row upcoming-actions">
              <button
                className="quiet"
                type="button"
                disabled={busy}
                aria-label={`Edit ${entry.title}`}
                onClick={() => choose(entry)}
              >
                Edit
              </button>
              <button
                className="quiet danger"
                type="button"
                disabled={busy}
                aria-label={`Delete ${entry.title}`}
                onClick={() => remove(entry)}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <>
      <Bar />
      <h1>Upcoming</h1>
      <p className="lede">People, milestones, and things to look forward to.</p>
      <p className="hint">A few personal dates in your daily email, when they’re close.</p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failed />
      ) : (
        <>
          <div className="row upcoming-toolbar">
            <button
              className="go"
              type="button"
              disabled={busy || entries.length >= (query.data?.limit ?? 200)}
              onClick={() => choose(null)}
            >
              Add a date
            </button>
            <button
              className="quiet"
              type="button"
              disabled={busy}
              onClick={() => client.invalidateQueries({ queryKey: upcomingQuery.queryKey })}
            >
              Reload list
            </button>
          </div>
          {selected !== undefined && (
            <UpcomingForm
              key={selected?.id + ':' + selected?.revision}
              entry={selected}
              today={query.data!.today}
              headingRef={heading}
              busy={busy}
              run={run}
              onCancel={() => setSelected(undefined)}
              onSaved={async () => {
                setSelected(undefined);
                await client.invalidateQueries({ queryKey: upcomingQuery.queryKey });
                setNotice('Date saved.');
              }}
            />
          )}
          <ErrorLine line={problem} />
          <p className="hint" role="status">
            {notice}
          </p>
          <section className="section wide" aria-label="Upcoming dates">
            {future.length ? (
              list(future)
            ) : (
              <p className="upcoming-empty">
                {past.length
                  ? 'Nothing ahead just yet.'
                  : 'Start with a birthday, an anniversary, a trip, or an event you’re looking forward to.'}
              </p>
            )}
          </section>
          {past.length > 0 && (
            <details className="upcoming-past">
              <summary>Past events ({past.length})</summary>
              {list(past)}
            </details>
          )}
          <p className="hint upcoming-footnote">
            These are saved plans. Write what happened in your release notes when the day comes.
          </p>
        </>
      )}
    </>
  );
}

function UpcomingForm({
  entry,
  today,
  headingRef,
  busy,
  run,
  onCancel,
  onSaved
}: {
  entry: UpcomingView | null;
  today: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<UpcomingKind>(entry?.kind ?? 'birthday'),
    [title, setTitle] = useState(entry?.title ?? ''),
    [date, setDate] = useState(entry?.date ?? today.slice(5)),
    [year, setYear] = useState(entry?.year?.toString() ?? ''),
    [end, setEnd] = useState(entry?.end_date ?? today),
    [place, setPlace] = useState<Place | null>(entry?.place ?? null),
    [email, setEmail] = useState(entry?.email ?? true),
    [reminders, setReminders] = useState((entry?.reminders ?? defaultReminders('birthday')).join(', ')),
    [picking, setPicking] = useState(false),
    [problem, setProblem] = useState<string | null>(null);
  function changeKind(next: UpcomingKind) {
    const wasAnnual = annual(kind);
    setKind(next);
    setYear('');
    setPlace(null);
    setPicking(false);
    setProblem(null);
    if (wasAnnual !== annual(next)) setDate(annual(next) ? today.slice(5) : today);
    setReminders(defaultReminders(next).join(', '));
  }
  function save(event: FormEvent) {
    event.preventDefault();
    run(async () => {
      setProblem(null);
      const tokens = reminders.split(',').map((s) => s.trim());
      if (email && tokens.some((s) => !/^\d+$/.test(s))) return setProblem(PROBLEMS['upcoming-reminders']!);
      const answer = await api(entry ? 'PUT' : 'POST', '/api/upcoming' + (entry ? '/' + entry.id : ''), {
        kind,
        title,
        date,
        year: annual(kind) && year ? Number(year) : null,
        end_date: kind === 'trip' ? end : null,
        place: annual(kind) ? null : place,
        email,
        reminders: email ? tokens.map(Number) : (entry?.reminders ?? defaultReminders(kind)),
        ...(entry ? { revision: entry.revision } : {})
      });
      if (!answer.ok) return setProblem(problemFor(answer.data.error));
      await onSaved();
    });
  }
  const [month, day] = (annual(kind) ? date : today.slice(5)).split('-');
  return (
    <form className="roomy upcoming-form" onSubmit={save} aria-labelledby="upcoming-form-heading">
      <h2 id="upcoming-form-heading" tabIndex={-1} ref={headingRef}>
        {entry ? 'Edit date' : 'Add a date'}
      </h2>
      <fieldset disabled={busy}>
        <label>
          Kind
          <select value={kind} onChange={(e) => changeKind(e.target.value as UpcomingKind)}>
            {Object.entries(NAMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {kind === 'birthday' ? 'Name' : 'Title'}
          <input name="title" required value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <p className="hint">
          {Array.from(title).length} / {UPCOMING_TITLE_MAX} characters
        </p>
        {annual(kind) ? (
          <>
            <div className="upcoming-date-fields">
              <label>
                Month
                <select
                  required
                  value={Number(month).toString()}
                  onChange={(e) => setDate(`${e.target.value.padStart(2, '0')}-${day}`)}
                >
                  {MONTHS.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Day
                <input
                  type="number"
                  min="1"
                  max="31"
                  required
                  value={Number(day) || ''}
                  onChange={(e) => setDate(`${month}-${e.target.value.padStart(2, '0')}`)}
                />
              </label>
              <label>
                {kind === 'birthday' ? 'Birth year (optional)' : 'Original year (optional)'}
                <input
                  type="number"
                  min="1"
                  max={today.slice(0, 4)}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </label>
            </div>
            <p className="hint">
              {kind === 'birthday' ? 'Add the year to see their version number.' : 'Add the year to count the years.'}{' '}
              February 29 falls on March 1 in other years.
            </p>
          </>
        ) : (
          <div className="upcoming-date-fields">
            <label>
              {kind === 'trip' ? 'Start date' : 'Date'}
              <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
            </label>
            {kind === 'trip' && (
              <label>
                End date
                <input type="date" required min={date} value={end} onChange={(e) => setEnd(e.target.value)} />
              </label>
            )}
          </div>
        )}
        {!annual(kind) && (
          <div className="stack tight">
            {place && !picking ? (
              <p>
                Destination: {place.name}
                {place.region ? ', ' + place.region : ''}.{' '}
                <button
                  className="quiet"
                  type="button"
                  onClick={() => {
                    setPlace(null);
                    setPicking(true);
                  }}
                >
                  Change destination
                </button>
              </p>
            ) : kind === 'trip' || picking ? (
              <Suspense fallback={<Loading />}>
                <PlacePicker
                  label={kind === 'trip' ? 'Destination' : 'Location (optional)'}
                  placeholder="Start typing a city"
                  onPick={(p) => {
                    setPlace(p);
                    setPicking(false);
                  }}
                  onClear={() => setPlace(null)}
                />
              </Suspense>
            ) : (
              <button className="quiet" type="button" onClick={() => setPicking(true)}>
                Add a location
              </button>
            )}
            {kind === 'event' && place && (
              <button className="quiet" type="button" onClick={() => setPlace(null)}>
                Remove location
              </button>
            )}
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
          Include in my daily email
        </label>
        {email && (
          <>
            <label>
              Remind me before (days)
              <input
                name="reminders"
                required
                value={reminders}
                onChange={(e) => setReminders(e.target.value)}
                aria-describedby="reminder-help"
              />
            </label>
            <p className="hint" id="reminder-help">
              Separate days with commas. For example, 7, 1, 0 means a week before, the day before, and on the day.
              {kind === 'trip' ? ' Zero also includes the last day of the trip.' : ''} Up to six reminders, from 0 to
              365 days before.
            </p>
          </>
        )}
        <ErrorLine line={problem} />
        <div className="row">
          <button className="go" type="submit">
            {busy ? 'Saving…' : 'Save date'}
          </button>
          <button className="quiet" type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </fieldset>
    </form>
  );
}
