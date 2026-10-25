// One release (?v=4.5), a year of life from birthday to birthday: its days
// with notes, oldest first, in the Timeline's rows, a page at a time, under
// a head that sums up all of it, and the releases either side. The Timeline
// lists every release.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { AppLink, Bar, Crumb, Digits, Failed, Loading, useTitle } from '../components/common.tsx';
import { DayList } from '../components/days.tsx';
import { Icon } from '../components/icon.tsx';
import { ApiError } from '../lib/api.ts';
import { count, listed, longDate } from '../lib/format.ts';
import { useGo, useQueryParam } from '../lib/nav.ts';
import { releaseQuery, releasesQuery } from '../lib/queries.ts';
import type { ReleasePage } from '../lib/types.ts';
import { givingLine } from '../../../packages/domain/giving.ts';

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
      <Bar />
      <Crumb href="/timeline/">Archive</Crumb>
      <p className="kicker">{head?.current ? 'Release · now' : 'Release'}</p>
      <h1 id="release-title">
        <span className="vh">Release </span>
        <Digits v={v || ''} />
      </h1>
      {head && (
        <div className="release-head" id="release-head">
          <p className="lede">
            {longDate(head.from)} to {longDate(head.through)}
            {head.current ? ', and still going.' : '.'}
          </p>
          {head.days_with_notes ? (
            <ul className="figures" id="release-counts">
              <Figure n={head.days_with_notes} one="day with notes" many="days with notes" />
              <Figure n={head.notes} one="note" many="notes" />
              {head.longest > 1 && <Figure n={head.longest} one="day, longest streak" many="days, longest streak" />}
            </ul>
          ) : (
            <p className="release-counts" id="release-counts">
              No notes in this release.
            </p>
          )}
          <ReleaseBadges b={head.badges} current={head.current} />
          {head.giving && head.giving.length > 0 && (
            <p className="meta release-giving" id="release-giving">
              {givingLine(head.v, head.giving)}
            </p>
          )}
          {head.tags.length > 0 && (
            <div className="tag-row">
              <p className="kicker" id="release-tags-k">
                Tags
              </p>
              <ul className="tags" id="release-tags" aria-labelledby="release-tags-k">
                {head.tags.map((t) => (
                  <li key={t.tag}>
                    <AppLink className="tag" href={`/tag/?t=${encodeURIComponent(t.tag)}`}>
                      #{t.tag}
                    </AppLink>
                    <span className="hint"> {count(t.notes, 'note', 'notes')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

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
      {head && !release.hasNextPage && <OtherReleases v={head.v} />}
    </>
  );
}

function Figure({ n, one, many }: { n: number; one: string; many: string }) {
  return (
    <li className="fig">
      <b>{n.toLocaleString('en-US')}</b> <span>{n === 1 ? one : many}</span>
    </li>
  );
}

// The release before this one and the one after, from the Timeline's list
// (newest first), where there are such.
function OtherReleases({ v }: { v: string }) {
  const releases = useQuery(releasesQuery);
  const list = releases.data?.releases || [];
  const at = list.findIndex((r) => r.v === v);
  if (at < 0) return null;
  const before = list[at + 1];
  const after = list[at - 1];
  if (!before && !after) return null;
  return (
    <nav aria-label="Other releases" className="row other-releases">
      {before && (
        <AppLink className="quiet" href={`/release/?v=${before.v}`} rel="prev">
          <Icon name="prev" />
          <span>
            Release <Digits v={before.v} />
          </span>
        </AppLink>
      )}
      {after && (
        <AppLink className="quiet" href={`/release/?v=${after.v}`} rel="next">
          <span>
            Release <Digits v={after.v} />
          </span>
          <Icon name="next" />
        </AppLink>
      )}
    </nav>
  );
}

// What the release earned (docs/BADGES.md): its coverage tier and the
// special days collected. Nothing when it has neither, never a miss.
function ReleaseBadges({ b, current }: { b: ReleasePage['badges']; current: boolean }) {
  if (!b || (!b.coverage && !b.collected.length)) return null;
  return (
    <p className="meta release-badges" id="release-badges">
      {b.coverage && `Coverage${current ? ' so far' : ''}: ${b.coverage}. `}
      {b.collected.length > 0 && (
        <>
          Collected:{' '}
          <AppLink href="/badges/">
            {listed(b.collected.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)))}
          </AppLink>
          .
        </>
      )}
    </p>
  );
}
