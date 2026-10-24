// One tag's days, newest first, with the notes that carry it (?t=). Every
// tag is on Search.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Bar, Crumb, Failed, Loading, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { ApiError } from '../lib/api.ts';
import { count, dateRange } from '../lib/format.ts';
import { useGo, useQueryParam } from '../lib/nav.ts';
import { tagQuery } from '../lib/queries.ts';
import type { Day } from '../lib/types.ts';

export function Tag() {
  const go = useGo();
  const tag = useQueryParam('t');
  const tagged = useQuery(tagQuery(tag));
  const d = tagged.data;
  useTitle(d ? `#${d.tag}` : 'Tags');
  const gone = tagged.error instanceof ApiError && tagged.error.answer.status === 404;

  useEffect(() => {
    if (!tag || gone) go('/search/');
  }, [tag, gone, go]);

  return (
    <>
      <Bar />
      <Crumb href="/search/">Search</Crumb>
      <p className="kicker">Tag</p>
      <h1 id="tag-title">{d ? `#${d.tag}` : 'Tags'}</h1>
      <p className="lede" id="tag-lede">
        {d && (d.days.length ? tagLede(d.days, d.today) : 'No notes have this tag now.')}
      </p>

      {tag && tagged.isPending && <Loading />}
      {tagged.isError && !gone && <Failed />}
      {d ? <DayList data={d} id="tagged" /> : <div className="days" id="tagged" />}
    </>
  );
}

// "2 notes on 2 days, October 21 to 24, 2026." The days come newest first.
function tagLede(days: Day[], today: string) {
  const notes = days.reduce((n, d) => n + d.notes.length, 0);
  const span = dateRange(days[days.length - 1].date, days[0].date, Number(today.slice(0, 4)));
  return `${count(notes, 'note', 'notes')} on ${count(days.length, 'day', 'days')}, ${span}.`;
}
