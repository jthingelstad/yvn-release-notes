// Personal dates, from a birthday to a trip. The API calculates occurrences in
// the subscriber's zone; forms retain unsaved values after errors or conflicts.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Icon } from '../components/icon.tsx';
import { lazy, Suspense, useRef, useState, type FormEvent } from 'react';
import {
  AppLink,
  Bar,
  ErrorLine,
  Failed,
  Loading,
  useBusy,
  useFocusLater,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { useHashParam } from '../lib/nav.ts';
import { MAX_TAG } from '../../../packages/domain/tags.ts';
import { api } from '../lib/api.ts';
import { subscribeHref } from '../lib/calendar.ts';
import { upcomingQuery } from '../lib/queries.ts';
import { NAMES, PROBLEMS, problemFor } from '../lib/upcoming.ts';
import { shortDay } from '../lib/format.ts';
import type { Place, Unlocked } from '../lib/types.ts';
import { UnlockLine } from '../components/unlock.tsx';
import {
  annual,
  defaultReminders,
  upcomingMatches,
  upcomingSearchText,
  UPCOMING_TITLE_MAX,
  type UpcomingKind,
  type UpcomingView
} from '../../../packages/domain/upcoming.ts';
import { MAX_QUERY, searchTerms } from '../../../packages/domain/search.ts';

const PlacePicker = lazy(() => import('../components/placepicker.tsx').then((m) => ({ default: m.PlacePicker })));
const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(2000, i, 1).toLocaleDateString('en-US', { month: 'long' })
);

export function Upcoming() {
  useTitle('Upcoming');
  const query = useQuery(upcomingQuery),
    client = useQueryClient();
  const navigate = useNavigate();
  // The filters live in the fragment, which no server sees, so a reload keeps them.
  const kindFilter = useHashParam('kind') ?? '',
    tagFilter = useHashParam('tag') ?? '',
    searchFilter = useHashParam('q') ?? '',
    terms = searchTerms(searchFilter),
    filtering = Boolean(kindFilter || tagFilter || terms.length);
  // undefined: closed; null: new; a saved entry: editing that revision.
  const [selected, setSelected] = useState<UpcomingView | null | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState(''),
    // What a date added earned (the Roadmap), under the notice.
    [won, setWon] = useState<Unlocked[]>([]);
  const [busy, run] = useBusy(),
    heading = useRef<HTMLHeadingElement>(null),
    focusLater = useFocusLater();
  const entries = (query.data?.entries ?? []).toSorted(
      (a, b) => a.occurrence.date.localeCompare(b.occurrence.date) || a.title.localeCompare(b.title)
    ),
    tags = [...new Set(entries.flatMap((e) => (e.tag ? [e.tag] : [])))].toSorted(),
    filtered = entries.filter(
      (e) =>
        (!kindFilter || e.kind === kindFilter) &&
        (!tagFilter || (tagFilter === '-' ? !e.tag : e.tag === tagFilter)) &&
        (!terms.length || upcomingMatches(upcomingSearchText(e, NAMES[e.kind]), terms))
    ),
    future = filtered.filter((e) => e.occurrence.status !== 'past'),
    past = filtered.filter((e) => e.occurrence.status === 'past');
  function filter(kind: string, tag: string, q = searchFilter) {
    const hash = new URLSearchParams();
    if (kind) hash.set('kind', kind);
    if (tag) hash.set('tag', tag);
    if (q) hash.set('q', q);
    navigate({ to: '/upcoming/', hash: hash.toString(), replace: true });
  }
  function choose(entry: UpcomingView | null) {
    setSelected(entry);
    setProblem(null);
    setNotice('');
    setWon([]);
    focusLater(() => heading.current);
  }
  async function remove(entry: UpcomingView) {
    if (!window.confirm(`Delete “${entry.title}” from Upcoming?`)) return;
    await run(async () => {
      setProblem(null);
      setNotice('');
      setWon([]);
      const answer = await api('DELETE', '/api/upcoming/' + entry.id, { revision: entry.revision });
      await client.invalidateQueries({ queryKey: upcomingQuery.queryKey });
      if (!answer.ok) return setProblem(problemFor(answer.data.error));
      if (selected?.id === entry.id) setSelected(undefined);
      setNotice('Date deleted.');
    });
  }
  // Each date as a row: when, what (its kind, tag and whether the email
  // carries it beneath), and Edit, with Delete inside it. A table still, for
  // assistive technology, with its roles said outright: laid out as rows,
  // Chrome would otherwise drop them.
  function list(items: UpcomingView[], label: string) {
    const year = Number(query.data?.today.slice(0, 4));
    return (
      <table className="upcoming-rows" role="table" aria-label={label}>
        <thead className="vh" role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Date
            </th>
            <th scope="col" role="columnheader">
              Event
            </th>
            <th scope="col" role="columnheader">
              Actions
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {items.map((entry) => (
            <tr key={entry.id} role="row">
              <td className="upcoming-when" role="cell">
                <time dateTime={entry.occurrence.date}>{shortDay(entry.occurrence.date, year)}</time>
                {entry.occurrence.end_date && entry.occurrence.end_date !== entry.occurrence.date && (
                  <>
                    {' '}
                    – <time dateTime={entry.occurrence.end_date}>{shortDay(entry.occurrence.end_date, year)}</time>
                  </>
                )}
                {(entry.occurrence.status === 'ongoing' || entry.occurrence.status === 'today') && (
                  <span className="upcoming-now">
                    {entry.occurrence.status === 'ongoing' ? 'Happening now' : 'Today'}
                  </span>
                )}
              </td>
              <th scope="row" className="upcoming-what" role="rowheader">
                <span className="upcoming-line">{entry.occurrence.line}</span>
                <span className="meta">
                  {[
                    NAMES[entry.kind] + (annual(entry.kind) ? ', every year' : ''),
                    entry.tag && '#' + entry.tag,
                    entry.email ? 'daily email' : 'web only'
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </th>
              <td role="cell">
                <div className="upcoming-actions">
                  {entry.tag && (
                    <AppLink
                      className="quiet icon-button"
                      href={`/today/#tag=${encodeURIComponent(entry.tag)}`}
                      aria-label={`Write a note tagged #${entry.tag} for ${entry.title}`}
                      title={`Write a note tagged #${entry.tag}`}
                    >
                      <Icon name="write" />
                    </AppLink>
                  )}
                  <button
                    className="quiet icon-button"
                    type="button"
                    disabled={busy}
                    aria-label={`Edit ${entry.title}`}
                    title="Edit"
                    onClick={() => choose(entry)}
                  >
                    <Icon name="edit" />
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <>
      <Bar />
      <h1>Upcoming</h1>
      <p className="lede">
        People, milestones and things to look forward to. When one is close, your daily email says so.
      </p>
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
            <AppLink className="quiet" href="/upcoming-text/">
              <Icon name="text" />
              Edit as text
            </AppLink>
            <button
              className="quiet icon-button upcoming-reload"
              type="button"
              disabled={busy}
              aria-label="Reload list"
              title="Reload list"
              onClick={() => client.invalidateQueries({ queryKey: upcomingQuery.queryKey })}
            >
              <Icon name="reload" />
            </button>
          </div>
          {selected !== undefined && (
            <UpcomingForm
              key={selected?.id + ':' + selected?.revision}
              entry={selected}
              initialKind={Object.hasOwn(NAMES, kindFilter) ? (kindFilter as UpcomingKind) : 'birthday'}
              initialTag={tagFilter === '-' ? '' : tagFilter}
              tags={tags}
              today={query.data!.today}
              headingRef={heading}
              busy={busy}
              run={run}
              onCancel={() => setSelected(undefined)}
              onDelete={selected ? () => remove(selected) : undefined}
              onSaved={async (unlocked) => {
                setSelected(undefined);
                await client.invalidateQueries({ queryKey: upcomingQuery.queryKey });
                setNotice('Date saved.');
                setWon(unlocked);
              }}
            />
          )}
          <ErrorLine line={problem} />
          <p className="hint" role="status">
            {notice}
          </p>
          <UnlockLine items={won} />
          <section className="section wide" aria-label="Upcoming dates">
            {entries.length > 0 && (
              <>
                <div className="upcoming-filters">
                  <label>
                    Kind
                    <select
                      aria-label="Filter by kind"
                      value={kindFilter}
                      onChange={(e) => filter(e.target.value, tagFilter)}
                    >
                      <option value="">All kinds</option>
                      {Object.entries(NAMES).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Tag
                    <select
                      aria-label="Filter by tag"
                      value={tagFilter}
                      onChange={(e) => filter(kindFilter, e.target.value)}
                    >
                      <option value="">All tags</option>
                      <option value="-">No tag</option>
                      {tags.map((tag) => (
                        <option key={tag} value={tag}>
                          #{tag}
                        </option>
                      ))}
                      {tagFilter && tagFilter !== '-' && !tags.includes(tagFilter) && (
                        <option value={tagFilter}>#{tagFilter}</option>
                      )}
                    </select>
                  </label>
                  <label className="upcoming-search">
                    Words
                    <input
                      aria-label="Words in your dates"
                      type="search"
                      name="q"
                      maxLength={MAX_QUERY}
                      autoComplete="off"
                      enterKeyHint="search"
                      placeholder={'paris, "big day"'}
                      value={searchFilter}
                      onChange={(e) => filter(kindFilter, tagFilter, e.target.value)}
                    />
                  </label>
                  {filtering && (
                    <button className="quiet" type="button" onClick={() => filter('', '', '')}>
                      Clear filters
                    </button>
                  )}
                </div>
                <p className="meta upcoming-count" role="status">
                  Showing {filtered.length} of {entries.length} saved dates.
                  {past.length > 0 && (past.length === 1 ? ' One is past.' : ` ${past.length} are past.`)}
                </p>
              </>
            )}
            {future.length ? (
              list(future, 'Upcoming events')
            ) : (
              <p className="upcoming-empty">
                {filtering && !filtered.length
                  ? 'No dates match these filters.'
                  : entries.some((e) => e.occurrence.status === 'past')
                    ? 'Nothing ahead just yet.'
                    : 'Start with a birthday, an anniversary, a trip, or an event you’re looking forward to.'}
              </p>
            )}
          </section>
          {past.length > 0 && (
            <details className="upcoming-past">
              <summary>Past dates ({past.length})</summary>
              {list(past, 'Past dates')}
            </details>
          )}
          <CalendarLink calendar={query.data!.calendar} busy={busy} run={run} />
          <p className="meta upcoming-footnote">
            These are saved plans. Write what happened in your release notes when the day comes.
          </p>
        </>
      )}
    </>
  );
}

// The private calendar link (AGENTS.md, Upcoming): these dates as a calendar
// subscription the calendar app keeps fresh itself. The link alone opens it,
// so "New link" replaces it and "Remove" ends it; the old one answers nothing.
function CalendarLink({
  calendar,
  busy,
  run
}: {
  calendar: string | null;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const client = useQueryClient();
  const problem = useProblem();
  const [copied, setCopied] = useState(false);
  const copyButton = useRef<HTMLButtonElement>(null),
    newButton = useRef<HTMLButtonElement>(null),
    removeButton = useRef<HTMLButtonElement>(null);
  const subscribe = calendar && subscribeHref(calendar);
  const keep = (next: string | null) =>
    client.setQueryData(upcomingQuery.queryKey, (old) => old && { ...old, calendar: next });
  const copy = async () => {
    problem.clear();
    try {
      await navigator.clipboard.writeText(calendar || '');
      setCopied(true);
    } catch {
      problem.show('Couldn’t copy it. Select the link and copy it from there.', copyButton.current);
    }
  };
  const make = () =>
    run(async () => {
      problem.clear();
      setCopied(false);
      if (calendar && !window.confirm('Calendars using the current link will stop updating. Make a new one?')) return;
      const r = await api<{ calendar: string }>('POST', '/api/calendar');
      if (!r.ok) return problem.show(r.data, newButton.current);
      keep(r.data.calendar);
    });
  const remove = () =>
    run(async () => {
      problem.clear();
      setCopied(false);
      if (!window.confirm('Calendars using this link will stop updating. Remove it?')) return;
      const r = await api('DELETE', '/api/calendar');
      if (!r.ok) return problem.show(r.data, removeButton.current);
      keep(null);
    });
  return (
    <section className="section upcoming-calendar" id="calendar" aria-labelledby="calendar-heading">
      <h2 className="big" id="calendar-heading">
        In your calendar
      </h2>
      <p className="hint">
        Subscribe from your calendar app and it keeps these dates current: each birthday with the version it turns,
        every anniversary, trip and event. It sets no alarms: reminders come in your daily email, and in an app if you
        turn them on there.
      </p>
      {calendar && (
        <p className="value mono" data-field="calendar">
          {calendar}
        </p>
      )}
      <div className="row calendar-actions">
        {subscribe && (
          <a className="quiet" href={subscribe} id="calendar-subscribe">
            Subscribe
          </a>
        )}
        <button ref={copyButton} className="quiet" type="button" id="calendar-copy" hidden={!calendar} onClick={copy}>
          Copy link
        </button>
        <button ref={newButton} className="quiet" type="button" id="calendar-new" disabled={busy} onClick={make}>
          {calendar ? 'New link' : 'Make a calendar link'}
        </button>
        <button
          ref={removeButton}
          className="quiet danger"
          type="button"
          id="calendar-remove"
          hidden={!calendar}
          disabled={busy}
          onClick={remove}
        >
          Remove link
        </button>
      </div>
      <p className="aside saved" id="calendar-copied" role="status" hidden={!copied}>
        Copied.
      </p>
      <p className="meta" hidden={!calendar}>
        {subscribe
          ? 'On an iPhone, iPad or Mac, Subscribe opens Calendar. Elsewhere, add a calendar from a URL.'
          : 'Google Calendar’s Android app can’t add a calendar from a link. On a computer, open Google Calendar on the web, choose Other calendars, then From URL, and paste this link; the dates then show on your phone.'}{' '}
        Anyone with the link can read these dates.
      </p>
      <ErrorLine line={problem.line} />
    </section>
  );
}

function UpcomingForm({
  entry,
  initialKind,
  initialTag,
  tags,
  today,
  headingRef,
  busy,
  run,
  onCancel,
  onDelete,
  onSaved
}: {
  entry: UpcomingView | null;
  initialKind: UpcomingKind;
  initialTag: string;
  tags: string[];
  today: string;
  headingRef: React.Ref<HTMLHeadingElement>;
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  onCancel: () => void;
  /** A saved date's Delete, at the form's foot. */
  onDelete?: () => void;
  /** Saved, with what it earned. */
  onSaved: (unlocked: Unlocked[]) => Promise<void>;
}) {
  const [kind, setKind] = useState<UpcomingKind>(entry?.kind ?? initialKind),
    [title, setTitle] = useState(entry?.title ?? ''),
    [tag, setTag] = useState(entry ? (entry.tag ?? '') : initialTag),
    [date, setDate] = useState(entry?.date ?? (annual(initialKind) ? today.slice(5) : today)),
    [year, setYear] = useState(entry?.year?.toString() ?? ''),
    [end, setEnd] = useState(entry?.end_date ?? today),
    [place, setPlace] = useState<Place | null>(entry?.place ?? null),
    [email, setEmail] = useState(entry?.email ?? true),
    [reminders, setReminders] = useState((entry?.reminders ?? defaultReminders(initialKind)).join(', ')),
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
        tag,
        date,
        year: annual(kind) && year ? Number(year) : null,
        end_date: kind === 'trip' ? end : null,
        place: annual(kind) ? null : place,
        email,
        reminders: email ? tokens.map(Number) : (entry?.reminders ?? defaultReminders(kind)),
        ...(entry ? { revision: entry.revision } : {})
      });
      if (!answer.ok) return setProblem(problemFor(answer.data.error));
      await onSaved((answer.data as { unlocked?: Unlocked[] }).unlocked ?? []);
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
        <label>
          Tag (optional)
          <input
            name="tag"
            value={tag}
            maxLength={MAX_TAG + 1}
            list="upcoming-tags"
            aria-describedby="upcoming-tag-help"
            placeholder="#family"
            onChange={(e) => setTag(e.target.value)}
          />
        </label>
        <datalist id="upcoming-tags">
          {tags.map((tag) => (
            <option key={tag} value={'#' + tag} />
          ))}
        </datalist>
        <p className="hint" id="upcoming-tag-help">
          One tag to group related dates, like #family. Write a note from a tagged date to start today’s draft with that
          hashtag.
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
          {entry && onDelete && (
            <button
              className="quiet danger upcoming-delete"
              type="button"
              aria-label={`Delete ${entry.title}`}
              onClick={onDelete}
            >
              <Icon name="delete" />
              Delete
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
