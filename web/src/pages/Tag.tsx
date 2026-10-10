// One tag's days, newest first, with the notes that carry it (?t=). Every
// tag is on Search.
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { AppLink, Bar, Failed, Loading, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { ApiError, get } from '../lib/api.ts';
import { count } from '../lib/format.ts';
import { useGo, useQueryParam } from '../lib/nav.ts';
import type { TaggedDays } from '../lib/types.ts';

export function Tag() {
  const go = useGo();
  const tag = useQueryParam('t');
  const tagged = useQuery({
    queryKey: ['tag', tag],
    queryFn: () => get<TaggedDays>(`/api/tags/${encodeURIComponent(tag!)}`),
    enabled: !!tag
  });
  const d = tagged.data;
  useTitle(d ? `#${d.tag}` : 'Tags');
  const gone = tagged.error instanceof ApiError && tagged.error.answer.status === 404;

  useEffect(() => {
    if (!tag || gone) go('/search/');
  }, [tag, gone, go]);

  return (
    <>
      <Bar current="/search/" />
      <h1 id="tag-title">{d ? `#${d.tag}` : 'Tags'}</h1>
      <p className="hint spaced" id="tag-lede">
        {d && (d.days.length ? count(d.days.length, 'day', 'days') : 'No notes have this tag now.')}
      </p>
      <p className="hint spaced" id="every-tag" hidden={!d}>
        <AppLink href="/search/">Every tag, and search</AppLink>
      </p>

      {tag && tagged.isPending && <Loading />}
      {tagged.isError && !gone && <Failed />}
      {d ? <DayList data={d} id="tagged" /> : <div className="days" id="tagged" />}
    </>
  );
}
