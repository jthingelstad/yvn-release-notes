// Today's number as a button: seven taps, by pointer or keyboard, turn on
// developer mode, which posts the egg once and stays in this browser.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { developer } from '../lib/developer.ts';
import { VersionTap } from './developer.tsx';

const calls: string[] = [];
beforeEach(() => {
  calls.length = 0;
  developer.set(false);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      calls.push(path);
      const body = path === '/api/eggs' ? { ok: true } : { days: [], before: '' };
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  developer.set(false);
});

// happy-dom spaces the digits' spans apart when it names the button.
const NAMED = /^Version 5 ?\. ?4 ?\. ?300$/;

const draw = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <VersionTap version="5.4.300" today="2026-12-30" birthday="1972-03-05" tz="America/Chicago" />
    </QueryClientProvider>
  );

describe('VersionTap', () => {
  it('is a button named by the version', () => {
    draw();
    expect(screen.getByRole('button', { name: NAMED })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Developer mode' })).toBeNull();
  });
  it('turns on at the seventh tap, Enter and Space included, and posts the egg once', async () => {
    const user = userEvent.setup();
    draw();
    const number = screen.getByRole('button', { name: NAMED });
    for (let i = 0; i < 3; i++) await user.click(number);
    expect(screen.getByRole('status').textContent).toBe('');
    await user.click(number);
    expect(screen.getByRole('status').textContent).toBe('3 taps from being a developer.');
    number.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(screen.getByRole('status').textContent).toBe('1 tap from being a developer.');
    await user.click(number);
    expect(screen.getByRole('status').textContent).toBe('You are now a developer.');
    const panel = await screen.findByRole('region', { name: 'Developer mode' });
    expect(panel.querySelector('#dev-roman')!.textContent).toBe('V.IV.CCC');
    expect(panel.querySelector('#dev-hex')!.textContent).toBe('5.4.12c');
    expect(developer.get()).toBe(true);
    await user.click(number);
    expect(screen.getByRole('status').textContent).toBe('No need, you are already a developer.');
    expect(calls.filter((p) => p === '/api/eggs')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Leave developer mode' }));
    expect(developer.get()).toBe(false);
    expect(screen.queryByRole('region', { name: 'Developer mode' })).toBeNull();
  });
});
