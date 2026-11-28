// The sign-in page's words when Cloudflare Turnstile, enforced, refuses the
// email (POST /api/auth/start answers 403 `turnstile`): on "Send me a link"
// and on "send it again" alike, the page says SAY.turnstile.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAY } from '../lib/say.ts';

vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof import('@tanstack/react-router')>()),
  useLocation: () => '',
  useNavigate: () => () => undefined,
  useRouterState: () => '/',
  Link: ({ children }: { children?: ReactNode }) => <a href="/">{children}</a>
}));
vi.mock('../lib/nav.ts', () => ({ useGo: () => () => undefined, useSignedInAs: () => () => undefined }));
vi.mock('../lib/turnstile.ts', () => ({
  useTurnstile: () => ({
    slotRef: () => undefined,
    turnstile: { warm: () => undefined, fieldsFor: async () => ({ turnstile_token: 'token' }) }
  })
}));

const { Home } = await import('./Home.tsx');

const REFUSED = 'We couldn’t confirm you’re not a bot. Reload the page and try again.';

function serve() {
  const fetch = vi.fn(async (path: string) =>
    path === '/api/auth/start'
      ? new Response(JSON.stringify({ error: 'turnstile' }), { status: 403 })
      : new Response(JSON.stringify({ error: 'signed-out' }), { status: 401 })
  );
  vi.stubGlobal('fetch', fetch);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Home />
    </QueryClientProvider>
  );
  return fetch;
}
const started = (fetch: ReturnType<typeof serve>) => fetch.mock.calls.filter(([path]) => path === '/api/auth/start');

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('Home, refused by Turnstile', () => {
  it('is the one sentence every site shows', () => {
    expect(SAY.turnstile).toBe(REFUSED);
  });

  it('says it under the email form when "Send me a link" is refused', async () => {
    history.replaceState(null, '', '/#sign-in');
    const fetch = serve();
    await userEvent.type(await screen.findByRole('textbox', { name: 'Your email' }), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send me a link' }));
    await waitFor(() => expect(started(fetch)).toHaveLength(1));
    const form = document.getElementById('start-form')!;
    await waitFor(() => expect(form.querySelector('[role=alert]')?.textContent).toBe(REFUSED));
    expect(form.hidden).toBe(false);
    expect(document.getElementById('check')!.hidden).toBe(true);
  });

  it('says it under the code form when "send it again" is refused', async () => {
    sessionStorage.setItem('rn-email', 'ada@example.com');
    const fetch = serve();
    await waitFor(() => expect(document.getElementById('check')!.hidden).toBe(false));
    await userEvent.click(screen.getByRole('link', { name: 'send it again' }));
    await waitFor(() => expect(started(fetch)).toHaveLength(1));
    const form = document.getElementById('code-form')!;
    await waitFor(() => expect(form.querySelector('[role=alert]')?.textContent).toBe(REFUSED));
    expect(document.getElementById('resent')!.hidden).toBe(true);
  });
});
