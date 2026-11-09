// An app's sign-in: the owner chooses its token from what the app asked for.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppSignIn } from './Connect.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const APP = { to: 'com.yourversionnumber.changelog', to_kind: 'app' } as const;
function serve(answer: Response, sendsTo: { to: string; to_kind: 'app' | 'computer' | 'web' } = APP) {
  const fetch = vi.fn(async () => answer.clone());
  vi.stubGlobal('fetch', fetch);
  const assign = vi.fn();
  vi.stubGlobal('location', { ...window.location, assign });
  render(
    <AppSignIn
      info={{
        client_name: 'Changelog',
        scope: 'notes:write media:write activity',
        resource: '/v1',
        name: 'Changelog 2',
        ...sendsTo
      }}
      request={'r'.repeat(43)}
      email="ada@example.com"
    />
  );
  return { fetch, assign };
}
const box = (name: RegExp) => screen.getByRole<HTMLInputElement>('checkbox', { name });
const sent = (fetch: ReturnType<typeof vi.fn>) =>
  JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));

describe('AppSignIn', () => {
  it('offers only what the app asked for, ticked, and sends the token the owner chose', async () => {
    const { fetch, assign } = serve(
      new Response(JSON.stringify({ redirect: 'com.yourversionnumber.changelog:/oauth?code=c' }), { status: 200 })
    );
    expect(screen.getByRole('heading', { name: 'Changelog wants to sign in' })).toBeTruthy();
    expect(screen.getByText(/^Allowing opens the app for/).textContent).toBe(
      'Allowing opens the app for com.yourversionnumber.changelog.'
    );
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Name' }).value).toBe('Changelog 2');
    expect(box(/^Add notes/).checked).toBe(true);
    expect(box(/^Add files/).checked).toBe(true);
    expect(box(/^Read the activity log/).checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /Upcoming/ })).toBeNull();

    await userEvent.click(box(/^Add notes/));
    expect(box(/^Add files/).checked).toBe(false);
    await userEvent.click(box(/^Add notes/));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Expires' }), 'never');
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('com.yourversionnumber.changelog:/oauth?code=c'));
    expect(sent(fetch)).toEqual({
      request: 'r'.repeat(43),
      approve: true,
      name: 'Changelog 2',
      scopes: ['activity', 'notes:write'],
      expiry: 'never'
    });
  });

  it('says a taken name and keeps the request open; Cancel sends no token', async () => {
    const { fetch } = serve(new Response(JSON.stringify({ error: 'token-name-taken' }), { status: 409 }));
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(screen.getByText(/already have a token with that name/)).toBeTruthy());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({
      request: 'r'.repeat(43),
      approve: false
    });
  });

  it('Cancel goes straight back to an app', async () => {
    const back = 'com.yourversionnumber.changelog:/oauth?error=access_denied&state=s';
    const { assign } = serve(new Response(JSON.stringify({ redirect: back }), { status: 200 }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith(back));
  });

  // 2026-11-08 security audit: a website's Cancel links back instead, so
  // this domain is never a registered site's redirect.
  it("says where a website's Allow goes, and its Cancel stops here with a link back", async () => {
    const back = 'https://app.example/callback?error=access_denied&state=s';
    const { assign } = serve(new Response(JSON.stringify({ redirect: back }), { status: 200 }), {
      to: 'app.example',
      to_kind: 'web'
    });
    expect(screen.getByText(/^Allowing sends you to/).textContent).toBe('Allowing sends you to app.example.');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Nothing was shared' })).toBeTruthy());
    expect(screen.getByRole('link', { name: 'app.example' }).getAttribute('href')).toBe(back);
    expect(assign).not.toHaveBeenCalled();
  });
});
