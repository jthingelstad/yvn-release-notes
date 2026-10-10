// A note shown before the API has it: added to the day's cached page at
// once, as "Saving…", and taken out again if the write fails. The fetch
// after the write brings the real one.
import type { QueryClient } from '@tanstack/react-query';
import { browserZone } from './format.ts';
import type { Note } from './types.ts';

type DayData = { date: string; notes: Note[] };

const isDay = (data: unknown, day: string): data is DayData =>
  !!data && typeof data === 'object' && (data as DayData).date === day && Array.isArray((data as DayData).notes);

export const PENDING = 'pending-';
export const isPending = (n: Note) => n.id.startsWith(PENDING);

// Today's page and the day's own page both hold the day.
async function patch(client: QueryClient, day: string, change: (notes: Note[]) => Note[]) {
  const predicate = (q: { state: { data: unknown } }) => isDay(q.state.data, day);
  // A fetch already under way would put back what was there before.
  await client.cancelQueries({ predicate });
  client.setQueriesData<DayData>({ predicate }, (d) => (d && isDay(d, day) ? { ...d, notes: change(d.notes) } : d));
}

export async function addPending(client: QueryClient, day: string, text: string): Promise<string> {
  const id = PENDING + Date.now();
  const note: Note = { id, source: 'web', text, at: new Date().toISOString(), tz: browserZone() };
  await patch(client, day, (notes) => [...notes, note]);
  return id;
}

export const dropNote = (client: QueryClient, day: string, id: string) =>
  patch(client, day, (notes) => notes.filter((n) => n.id !== id));
