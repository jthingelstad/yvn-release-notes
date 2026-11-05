import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnThisDay } from './onthisday.tsx';

// A plain link: the router's own isn't what these check.
vi.mock('./common.tsx', async (load) => ({
  ...(await load<typeof import('./common.tsx')>()),
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>
}));

const note = (id: string, text: string) => ({ id, source: 'web', text });
const answer = (body: unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    )
  );
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <OnThisDay />
    </QueryClientProvider>
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OnThisDay', () => {
  it('shows each earlier day, how long ago, and the years beyond them', async () => {
    answer({
      days: [
        { date: '2025-10-13', version: '44.2.1', years: 1, notes: [note('a', 'First snow')] },
        { date: '2024-10-13', version: '43.2.1', years: 2, notes: [note('b', 'New job')] }
      ],
      more: ['2019-10-13'],
      tz: 'America/Chicago'
    });
    show();
    expect(await screen.findByText('First snow')).toBeTruthy();
    expect(screen.getByText('On this day')).toBeTruthy();
    expect(screen.getByText(/A year ago you were/)).toBeTruthy();
    expect(screen.getByText(/2 years ago you were/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '2019' }).getAttribute('href')).toContain('2019-10-13');
  });

  it('shows five notes of a day and says how many more', async () => {
    answer({
      days: [
        {
          date: '2025-10-13',
          version: '44.2.1',
          years: 1,
          notes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => note(id, `Note ${id}`))
        }
      ],
      more: [],
      tz: 'America/Chicago'
    });
    show();
    expect(await screen.findByText('Note e')).toBeTruthy();
    expect(screen.queryByText('Note f')).toBeNull();
    expect(screen.getByRole('link', { name: '2 more notes' })).toBeTruthy();
  });

  it('says who wrote a note an agent added', async () => {
    answer({
      days: [
        {
          date: '2025-10-13',
          version: '44.2.1',
          years: 1,
          notes: [{ id: 'a', source: 'agent', author: 'assistant', client: 'Claude', text: 'From an agent' }]
        }
      ],
      more: [],
      tz: 'America/Chicago'
    });
    show();
    expect(await screen.findByText('From an agent')).toBeTruthy();
    expect(screen.getByText(/added by Claude/)).toBeTruthy();
  });

  it('is no section at all with nothing to show', async () => {
    answer({ days: [], more: [], tz: 'America/Chicago' });
    const { container } = show();
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('section')).toBeNull();
  });
});
