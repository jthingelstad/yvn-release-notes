// One release (?v=4.5), a year of life from birthday to birthday: its days
// with notes, oldest first, in the Timeline's rows, a page at a time, under
// a head that sums up all of it. The Timeline lists every release.
import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppLink, Bar, Digits, Failed, Loading, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { ApiError } from '../lib/api.ts';
import { count, longDate } from '../lib/format.ts';
import { useGo, useQueryParam } from '../lib/nav.ts';
import { releaseQuery } from '../lib/queries.ts';

export function Release() {
  const go = useGo();
  const v = useQueryParam('v');
  const release = useInfiniteQuery(releaseQuery(v));
  const pages = release.data?.pages || [];
  const head = pages[0];
  useTitle(v ? `Release ${v}` : 'Releases');
  const gone = release.error instanceof ApiError && release.error.answer.status === 404;
  const list = useRef<HTMLDivElement>(null);
  const more = useRef<HTMLButtonElement>(null);
  // Set by a click on "Later days": how many days there were.
  const clicked = useRef<number | null>(null);

  useEffect(() => {
    if (!v || gone) go('/timeline/');
  }, [v, gone, go]);

  // Clicking disabled the button, which dropped focus: give it back, or,
  // when the last page took the button away, move to the first day it added.
  const settled = !release.isFetchingNextPage;
  useEffect(() => {
    const had = clicked.current;
    if (!settled || had === null) return;
    clicked.current = null;
    if (release.hasNextPage || release.isFetchNextPageError) return more.current?.focus();
    list.current?.querySelector('#release-days')?.children[had]?.querySelector<HTMLElement>('a.tday-head')?.focus();
  }, [settled, release.hasNextPage, release.isFetchNextPageError]);

  const days = pages.flatMap((p) => p.days);
  return (
    <>
      <Bar current="/timeline/" />
      <h1 id="release-title">
        Release{' '}
        <span className="vnum inline">
          <Digits v={v || ''} />
        </span>
      </h1>
      {head && (
        <div className="release-head" id="release-head">
          <p className="hint">
            {longDate(head.from)} to {longDate(head.through)}
            {head.current && ', and still going'}
          </p>
          <p className="release-counts" id="release-counts">
            {head.days_with_notes
              ? `${count(head.days_with_notes, 'day', 'days')} with notes, ${count(head.notes, 'note', 'notes')}.`
              : 'No notes in this release.'}
            {head.longest > 1 && ` Longest streak: ${count(head.longest, 'day', 'days')}.`}
          </p>
          {head.tags.length > 0 && (
            <ul className="tags" id="release-tags">
              {head.tags.map((t) => (
                <li key={t.tag}>
                  <AppLink className="tag" href={`/tag/?t=${encodeURIComponent(t.tag)}`}>
                    #{t.tag}
                  </AppLink>
                  <span className="hint"> {count(t.notes, 'note', 'notes')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <p className="hint spaced">
        <AppLink href="/timeline/">Every release</AppLink>
      </p>

      {v && release.isPending && <Loading />}
      {release.isError && !gone && !pages.length && <Failed />}
      <div ref={list}>
        {head ? (
          <DayList data={{ today: head.today, tz: head.tz, days }} id="release-days" />
        ) : (
          <div className="days" id="release-days" />
        )}
      </div>
      {release.isFetchNextPageError && <Failed />}
      <button
        ref={more}
        className="quiet"
        type="button"
        id="later"
        hidden={!release.hasNextPage}
        disabled={release.isFetchingNextPage}
        onClick={() => {
          clicked.current = days.length;
          release.fetchNextPage();
        }}
      >
        Later days
      </button>
    </>
  );
}
