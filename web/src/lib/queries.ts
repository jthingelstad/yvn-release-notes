// What the pages load, in one place: the router's loaders fetch these
// before a page shows (and when a link is pointed at), and the pages read
// the same entries from the cache.
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { get } from './api.ts';
import { addDays } from './format.ts';
import type { DayPage, DaysPage, Me, Note, TaggedDays, Today } from './types.ts';

// A recording being written out: look again every 30 seconds, 20 times.
export const POLL = 30000;
const writing = (notes: Note[] | undefined) => !!notes?.some((n) => (n.media || []).some((m) => m.writing));
export const pollWhileWriting = (q: { state: { data?: { notes: Note[] }; dataUpdateCount: number } }) =>
  writing(q.state.data?.notes) && q.state.dataUpdateCount <= 20 ? POLL : false;

// The profile. It never sends anyone elsewhere on its own: the signed-in
// pages' gate (main.tsx) and useMe do, knowing where they are.
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => get<Me>('/api/me'),
  meta: { bounce: false }
});

export const todayQuery = queryOptions({
  queryKey: ['today'],
  queryFn: () => get<Today>('/api/today'),
  refetchInterval: pollWhileWriting
});

export const daysQuery = infiniteQueryOptions({
  queryKey: ['days'],
  queryFn: ({ pageParam }) => get<DaysPage>('/api/days' + (pageParam ? `?before=${pageParam}` : '')),
  initialPageParam: '',
  getNextPageParam: (last) => last.before || undefined
});

export const dayQuery = (day: string | null) =>
  queryOptions({
    queryKey: ['day', day],
    queryFn: () => get<DayPage>(`/api/days/${day}`),
    enabled: !!day,
    refetchInterval: pollWhileWriting
  });

export const tagQuery = (tag: string | null) =>
  queryOptions({
    queryKey: ['tag', tag],
    queryFn: () => get<TaggedDays>(`/api/tags/${encodeURIComponent(tag!)}`),
    enabled: !!tag
  });

export const tagsQuery = queryOptions({
  queryKey: ['tags'],
  queryFn: () => get<{ tags: { tag: string; days: number }[] }>('/api/tags')
});

// The day asked for (?d=), if it is one there can be notes for, else
// yesterday (or the birthday itself, on someone's first day).
export function pickDay(asked: string | null | undefined, p: Me): string {
  if (asked && asked >= p.birthday && asked <= p.today) return asked;
  const yesterday = addDays(p.today, -1);
  return yesterday < p.birthday ? p.birthday : yesterday;
}
