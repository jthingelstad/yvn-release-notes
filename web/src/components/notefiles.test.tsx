import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Note } from '../lib/types.ts';
import { NoteFiles } from './notefiles.tsx';

const note = (over: Partial<Note>): Note =>
  ({
    id: 'w',
    text: 'Lake day',
    source: 'web',
    media: [
      { n: 1, kind: 'image', type: 'image/jpeg', name: 'lake.jpg' },
      { n: 2, kind: 'file', type: 'application/pdf', name: 'map.pdf' }
    ],
    ...over
  }) as unknown as Note;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NoteFiles', () => {
  it('asks first, then removes that file and refreshes', async () => {
    const fetcher = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetcher);
    const onRemoved = vi.fn();
    render(<NoteFiles n={note({})} path="/api/days/2026-10-13/notes/w" onRemoved={onRemoved} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove map.pdf' }));
    expect(fetcher).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toContain('/api/days/2026-10-13/notes/w/media/2');
    expect(init?.method).toBe('DELETE');
  });

  it('says an emailed file stays in the email, and Keep it asks no more', async () => {
    render(<NoteFiles n={note({ source: 'email' })} path="/p" onRemoved={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove lake.jpg' }));
    expect(screen.getByText(/stays in the email/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByText(/stays in the email/)).toBeNull();
  });

  it('offers no Remove for the last file of a note with no words', () => {
    render(
      <NoteFiles
        n={note({ text: '', media: [{ n: 1, kind: 'image', type: 'image/jpeg', name: 'lake.jpg' }] } as Partial<Note>)}
        path="/p"
        onRemoved={() => undefined}
      />
    );
    expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
    expect(screen.getByText(/Delete the note instead/)).toBeTruthy();
  });

  it('shows nothing for a note with no files', () => {
    const { container } = render(<NoteFiles n={note({ media: [] })} path="/p" onRemoved={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
