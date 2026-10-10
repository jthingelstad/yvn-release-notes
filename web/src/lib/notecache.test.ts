import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { addPending, dropNote, isPending } from './notecache.ts';
import type { Note } from './types.ts';

const note: Note = { id: 'w-1', source: 'web', text: 'kept' };

describe('a note shown before the API has it', () => {
  it('joins the day on every page that holds it, and only that day', async () => {
    const client = new QueryClient();
    client.setQueryData(['today'], { date: '2026-10-09', notes: [note] });
    client.setQueryData(['day', '2026-10-09'], { date: '2026-10-09', notes: [] });
    client.setQueryData(['day', '2026-10-08'], { date: '2026-10-08', notes: [] });
    client.setQueryData(['days'], { pages: [], pageParams: [] });

    const id = await addPending(client, '2026-10-09', 'just written');
    const today = client.getQueryData<{ notes: Note[] }>(['today'])!;
    expect(today.notes.map((n) => n.text)).toEqual(['kept', 'just written']);
    expect(isPending(today.notes[1])).toBe(true);
    expect(client.getQueryData<{ notes: Note[] }>(['day', '2026-10-09'])!.notes).toHaveLength(1);
    expect(client.getQueryData<{ notes: Note[] }>(['day', '2026-10-08'])!.notes).toHaveLength(0);
    expect(client.getQueryData(['days'])).toEqual({ pages: [], pageParams: [] });

    await dropNote(client, '2026-10-09', id);
    expect(client.getQueryData<{ notes: Note[] }>(['today'])!.notes).toEqual([note]);
    expect(client.getQueryData<{ notes: Note[] }>(['day', '2026-10-09'])!.notes).toEqual([]);
  });
});
