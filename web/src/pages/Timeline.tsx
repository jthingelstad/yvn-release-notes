// Every release so far: an index of the releases (each a year of life,
// with its own page), then the days, newest first, a page at a time.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { AppLink, Bar, Digits, Failed, Loading, useTitle } from '../components/common.tsx';
import { dayHref } from '../components/days.tsx';
import { Icon } from '../components/icon.tsx';
import { NoteBody, NoteMedia } from '../components/notes.tsx';
import { addDays, count, dateRange, dayName } from '../lib/format.ts';
import { daysQuery, releasesQuery } from '../lib/queries.ts';
import type { Day, ReleaseSummary } from '../lib/types.ts';

export function Timeline() {
  useTitle('Archive');
  const days = useInfiniteQuery(daysQuery);
  const list = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  // Set by a click on "Earlier releases": how many rows there were, and
  // whether the last was a paused run the next page might extend.
  const clicked = useRef<{ had: number; lastRun: boolean } | null>(null);

  const pages = days.data?.pages || [];
  const today = pages[0]?.today || '';
  const thisYear = Number(today.slice(0, 4));
  const rows = groupQuiet(pages.flatMap((p) => p.days));

  // Clicking disabled the button, which dropped focus. Give it back, or,
  // when the last page took the button away, move on to the first day that
  // page added (or the paused run it extended).
  const settled = !days.isFetchingNextPage;
  useEffect(() => {
    const c = clicked.current;
    if (!settled || !c) return;
    clicked.current = null;
    if (days.hasNextPage || days.isFetchNextPageError) return more.current?.focus();
    const children = list.current?.children;
    const first = (children?.[c.had] || (c.lastRun ? children?.[c.had - 1] : null)) as HTMLElement | null;
    const link = first?.querySelector<HTMLElement>('a.tday-head');
    if (link) link.focus();
    else if (first) {
      first.tabIndex = -1;
      first.focus();
    }
  }, [settled, days.hasNextPage, days.isFetchNextPageError]);

  return (
    <>
      <Bar />
      <h1>Archive</h1>
      <p className="lede">Every day, a little more of your story.</p>
      <div className="row page-actions">
        <AppLink className="quiet" href="/day/">
          <Icon name="calendar" />
          Add notes for another day
        </AppLink>
        <AppLink className="quiet" href="/tag/">
          <Icon name="tags" />
          Tags
        </AppLink>
        {/* The rail has its own "Make a book"; a phone's tabs don't. */}
        <AppLink className="quiet phone-only" href="/book/">
          <Icon name="book" />
          Make a book
        </AppLink>
      </div>
      <Releases />

      {days.isPending && <Loading />}
      {days.isError && !pages.length && <Failed />}
      <div className="days" id="days" ref={list}>
        {rows.map((row) =>
          'run' in row ? (
            <QuietRun key={row.run[0].date} run={row.run} paused={row.paused} today={today} thisYear={thisYear} />
          ) : (
            <DayRow key={row.day.date} d={row.day} today={today} thisYear={thisYear} />
          )
        )}
      </div>
      {days.isFetchNextPageError && <Failed />}
      <button
        ref={more}
        className="quiet"
        type="button"
        id="earlier"
        hidden={!days.hasNextPage}
        disabled={days.isFetchingNextPage}
        onClick={() => {
          clicked.current = { had: rows.length, lastRun: 'run' in (rows[rows.length - 1] || {}) };
          days.fetchNextPage();
        }}
      >
        Earlier releases
      </button>
      <p className="foot meta" id="weather-credit" hidden={!rows.some((r) => 'day' in r && r.day.weather)}>
        Weather from <a href="https://open-meteo.com/">Open-Meteo</a>.
      </p>
    </>
  );
}

type Row = { day: Day } | { run: Day[]; paused: boolean };

// Days in a row with no notes (and no place of their own) read as one quiet
// line, across pages too: paused ones apart from the rest. A run is newest
// first.
export function groupQuiet(days: Day[]): Row[] {
  const rows: Row[] = [];
  for (const d of days) {
    const last = rows[rows.length - 1];
    if (!d.notes.length && !d.where) {
      const paused = !!d.paused;
      if (last && 'run' in last && last.paused === paused && addDays(d.date, 1) === last.run[last.run.length - 1].date)
        last.run.push(d);
      else rows.push({ run: [d], paused });
      continue;
    }
    rows.push({ day: d });
  }
  return rows;
}

function DayRow({ d, today, thisYear }: { d: Day; today: string; thisYear: number }) {
  const href = dayHref(d.date, today);
  let body: ReactNode;
  if (!d.notes.length) {
    body = (
      <p className="hint">
        No notes. <AppLink href={href}>Add some</AppLink>
      </p>
    );
  } else {
    body = (
      <>
        {d.notes.map((n) => (
          <NoteParts key={n.id} d={d} n={n} />
        ))}
        {d.notes.every((n) => n.late) && <p className="count">Added later</p>}
      </>
    );
  }
  return (
    <section className="tday">
      <AppLink className="tday-head" href={href}>
        <span className="vnum small">
          <Digits v={d.version} named />
        </span>
        <span className="when">{(d.date === today ? 'Today, ' : '') + dayName(d.date, thisYear)}</span>
      </AppLink>
      {d.weather && <p className="meta">{d.weather}</p>}
      {d.where && <p className="meta">Where: {d.where}</p>}
      {body}
    </section>
  );
}

function NoteParts({ d, n }: { d: Day; n: Day['notes'][number] }) {
  return (
    <>
      <NoteBody n={n} />
      <NoteMedia day={d.date} n={n} version={d.version} small />
    </>
  );
}

// A quiet line for days in a row with nothing in them: their versions,
// their dates, and a way to fill them in, or that the emails were paused.
function QuietRun({ run, paused, today, thisYear }: { run: Day[]; paused: boolean; today: string; thisYear: number }) {
  const newest = run[0];
  const oldest = run[run.length - 1];
  const days = run.length;
  const when = days > 1 ? dateRange(oldest.date, newest.date, thisYear) : dayName(oldest.date, thisYear);
  return (
    <p className="quiet-run">
      <span className="run-versions">
        <Digits v={oldest.version} named />
        {days > 1 && (
          <>
            {' – '}
            <Digits v={newest.version} named />
          </>
        )}
      </span>
      {paused ? (
        <span>
          {when} · Paused, {days === 1 ? '1 day' : days + ' days'}. Your streak waited.
        </span>
      ) : (
        <>
          <span>
            {when} · {days === 1 ? 'no notes' : `${days} days without notes`} ·
          </span>
          <AppLink href={dayHref(oldest.date, today)}>Add some</AppLink>
        </>
      )}
    </p>
  );
}

// Each release with notes, and the current one, newest first: a link to
// its page and how much it has.
function Releases() {
  const releases = useQuery(releasesQuery);
  const list = releases.data?.releases || [];
  if (releases.isError && !list.length) return <Failed />;
  if (!list.length) return null;
  return (
    <nav aria-label="Releases" className="releases" id="releases">
      <p className="kicker">Releases</p>
      <ul>
        {list.map((r) => (
          <ReleaseLink key={r.v} r={r} />
        ))}
      </ul>
    </nav>
  );
}

function ReleaseLink({ r }: { r: ReleaseSummary }) {
  return (
    <li>
      <AppLink href={`/release/?v=${r.v}`} aria-current={r.current ? 'true' : undefined}>
        <span className="release-v">
          <Digits v={r.v} named />
        </span>
      </AppLink>
      <span className="hint">
        {' '}
        {[r.current && 'now', r.days && count(r.days, 'day', 'days')].filter(Boolean).join(' · ')}
      </span>
    </li>
  );
}
