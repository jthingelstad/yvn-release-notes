// Every release so far, newest first, a page of days at a time.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef, type ReactNode } from 'react';
import { AppLink, Bar, Digits, Failed, Loading, useTitle } from '../components/common.tsx';
import { dayHref } from '../components/days.tsx';
import { NoteBody, NoteMedia } from '../components/notes.tsx';
import { addDays, dayName } from '../lib/format.ts';
import { daysQuery } from '../lib/queries.ts';
import type { Day } from '../lib/types.ts';

export function Timeline() {
  useTitle('Timeline');
  const days = useInfiniteQuery(daysQuery);
  const list = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  // Set by a click on "Earlier releases": how many rows there were, and
  // whether the last was a paused run the next page might extend.
  const clicked = useRef<{ had: number; lastRun: boolean } | null>(null);

  const pages = days.data?.pages || [];
  const today = pages[0]?.today || '';
  const thisYear = Number(today.slice(0, 4));
  const rows = groupPaused(pages.flatMap((p) => p.days));

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
      <h1>Every release so far.</h1>
      <p className="hint spaced">
        <AppLink href="/day/">Add notes for another day</AppLink> · <AppLink href="/tag/">Tags</AppLink>
      </p>

      {days.isPending && <Loading />}
      {days.isError && !pages.length && <Failed />}
      <div className="days" id="days" ref={list}>
        {rows.map((row) =>
          'run' in row ? (
            <PausedRun key={row.run[0].date} run={row.run} thisYear={thisYear} />
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
      <p className="foot" id="weather-credit" hidden={!rows.some((r) => 'day' in r && r.day.weather)}>
        Weather from <a href="https://open-meteo.com/">Open-Meteo</a>.
      </p>
    </>
  );
}

type Row = { day: Day } | { run: Day[] };

// Paused days with no notes read as one row, across pages too. A run is
// newest first.
export function groupPaused(days: Day[]): Row[] {
  const rows: Row[] = [];
  for (const d of days) {
    const last = rows[rows.length - 1];
    if (d.paused && !d.notes.length) {
      if (last && 'run' in last && addDays(d.date, 1) === last.run[last.run.length - 1].date) last.run.push(d);
      else rows.push({ run: [d] });
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
    let count = d.notes.length === 1 ? '1 note' : `${d.notes.length} notes`;
    if (d.notes.every((n) => n.late)) count += ', added later';
    body = (
      <>
        {d.notes.map((n) => (
          <NoteParts key={n.id} d={d} n={n} />
        ))}
        <p className="count">{count}</p>
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
      {d.weather && <p className="weather">{d.weather}</p>}
      {body}
    </section>
  );
}

function NoteParts({ d, n }: { d: Day; n: Day['notes'][number] }) {
  return (
    <>
      <NoteBody n={n} />
      <NoteMedia day={d.date} n={n} version={d.version} />
    </>
  );
}

function PausedRun({ run, thisYear }: { run: Day[]; thisYear: number }) {
  const newest = run[0];
  const oldest = run[run.length - 1];
  const days = run.length;
  const when =
    days > 1
      ? `${dayName(oldest.date, thisYear)} to ${dayName(newest.date, thisYear)}`
      : dayName(oldest.date, thisYear);
  return (
    <section className="tday">
      <p className="tday-head">
        <span className="vnum small">
          <Digits v={oldest.version} named />
        </span>
        {days > 1 && (
          <>
            <span className="when">to</span>
            <span className="vnum small">
              <Digits v={newest.version} named />
            </span>
          </>
        )}
      </p>
      <p className="hint">{when}</p>
      <p className="hint">Paused, {days === 1 ? '1 day' : days + ' days'}. Your streak waited.</p>
    </section>
  );
}
