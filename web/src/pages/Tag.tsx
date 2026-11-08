// One tag (?t=, any spelling: "Road Trip" is road-trip) with everything that
// carries it (Jamie's call 5, 2026-11-08): its notes, newest day first, its
// Upcoming dates and its check-ins. Every tag is on Search.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppLink, Bar, Crumb, Failed, Loading, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { ApiError } from '../lib/api.ts';
import { checkInHref, stayLine, stopName } from '../lib/check-ins.ts';
import { count, dateRange, dayName, shortDay } from '../lib/format.ts';
import { useGo, useQueryParam, useStillAt } from '../lib/nav.ts';
import { tagQuery } from '../lib/queries.ts';
import type { TaggedDays } from '../lib/types.ts';

export function Tag() {
  const go = useGo();
  const tag = useQueryParam('t');
  const here = useStillAt('/tag/');
  const tagged = useQuery(tagQuery(tag));
  const d = tagged.data;
  const name = d ? d.name || d.tag : 'Tags';
  useTitle(name);
  const gone = tagged.error instanceof ApiError && tagged.error.answer.status === 404;
  const year = d ? Number(d.today.slice(0, 4)) : 0;

  useEffect(() => {
    if (here && (!tag || gone)) go('/search/');
  }, [here, tag, gone, go]);

  return (
    <>
      <Bar />
      <Crumb href="/search/">Search</Crumb>
      <p className="kicker">Tag</p>
      <h1 id="tag-title" dir="auto">
        {name}
      </h1>
      <p className="lede" id="tag-lede">
        {d && tagLede(d)}
      </p>

      {tag && tagged.isPending && <Loading />}
      {tagged.isError && !gone && <Failed />}

      {!!d?.upcoming.length && (
        <section id="tag-upcoming" aria-labelledby="tag-upcoming-h">
          <h2 id="tag-upcoming-h">Upcoming</h2>
          <ul className="tag-things">
            {d.upcoming.map((u) => (
              <li key={u.id}>
                <AppLink href={`/upcoming/#tag=${encodeURIComponent(d.tag)}`}>{u.occurrence.line || u.title}</AppLink>
                <span className="meta">
                  {' '}
                  <time dateTime={u.occurrence.date}>{shortDay(u.occurrence.date, year)}</time>
                  {u.occurrence.end_date && u.occurrence.end_date !== u.occurrence.date && (
                    <>
                      {' '}
                      – <time dateTime={u.occurrence.end_date}>{shortDay(u.occurrence.end_date, year)}</time>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!d?.check_ins.length && (
        <section id="tag-check-ins" aria-labelledby="tag-check-ins-h">
          <h2 id="tag-check-ins-h">Check-ins</h2>
          <ul className="tag-things">
            {d.check_ins.map((s) => (
              <li key={s.id}>
                <AppLink href={checkInHref(s.id)}>{stopName(s.label)}</AppLink>
                <span className="meta">
                  {' '}
                  {[dayName(s.day, year), stayLine(s, s.time_zone)].filter(Boolean).join(', ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!!d?.days.length && (d.upcoming.length > 0 || d.check_ins.length > 0) && <h2 id="tag-notes-h">Notes</h2>}
      {d ? <DayList data={d} id="tagged" /> : <div className="days" id="tagged" />}
    </>
  );
}

// "2 notes on 2 days, October 21 to 24, 2026. 1 Upcoming date and 3
// check-ins." The days come newest first.
function tagLede(d: TaggedDays) {
  const lines: string[] = [];
  if (d.days.length) {
    const notes = d.days.reduce((n, day) => n + day.notes.length, 0);
    const span = dateRange(d.days[d.days.length - 1].date, d.days[0].date, Number(d.today.slice(0, 4)));
    lines.push(`${count(notes, 'note', 'notes')} on ${count(d.days.length, 'day', 'days')}, ${span}.`);
  }
  const others = [
    d.upcoming.length ? count(d.upcoming.length, 'Upcoming date', 'Upcoming dates') : '',
    d.check_ins.length ? count(d.check_ins.length, 'check-in', 'check-ins') : ''
  ].filter(Boolean);
  if (others.length) lines.push(others.join(' and ') + '.');
  return lines.length ? lines.join(' ') : 'Nothing has this tag now.';
}
