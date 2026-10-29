// Making a token: Add files comes only with Add notes.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiTokens } from './api-tokens.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function serve() {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? new Response(JSON.stringify({ name: 'Terminal', token: 'rn_example' }), { status: 201 })
      : new Response(JSON.stringify({ tokens: [] }), { status: 200 })
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ApiTokens />
    </QueryClientProvider>
  );
  return fetch;
}
const box = (name: RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name, hidden: true });

describe('ApiTokens', () => {
  it('offers Add files only beside Add notes, and unticking Add notes takes it away', async () => {
    const fetch = serve();
    await waitFor(() => expect(screen.getByText('None yet')).toBeTruthy());
    const notes = box(/^Add notes/),
      files = box(/^Add files/);
    expect(notes.checked).toBe(true);
    expect(files.disabled).toBe(false);
    await userEvent.click(files);
    expect(files.checked).toBe(true);

    await userEvent.click(notes);
    expect(notes.checked).toBe(false);
    expect(files.checked).toBe(false);
    expect(files.disabled).toBe(true);

    await userEvent.click(notes);
    await userEvent.click(files);
    await userEvent.type(screen.getByRole('textbox', { name: 'Name', hidden: true }), 'Terminal');
    await userEvent.click(screen.getByRole('button', { name: 'Make token', hidden: true }));
    await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
    const [, made] = fetch.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(String(made!.body)).scopes).toEqual(['notes:write', 'media:write']);
  });
});
