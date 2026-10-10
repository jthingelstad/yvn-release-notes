// The city picker, driven by the keyboard.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Place } from '../lib/types.ts';
import { PlacePicker } from './placepicker.tsx';

const PLACES: Place[] = [
  { name: 'Minneapolis', region: 'Minnesota', country: 'United States', tz: 'America/Chicago' },
  { name: 'Minnetonka', region: 'Minnesota', country: 'United States', tz: 'America/Chicago' }
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function answer(places: Place[]) {
  const fetch = vi.fn(async (_url: string) => new Response(JSON.stringify({ places }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('PlacePicker', () => {
  it('searches as you type, and the arrow keys and Enter pick a place', async () => {
    const fetch = answer(PLACES);
    const onPick = vi.fn();
    const onClear = vi.fn();
    render(<PlacePicker label="City" placeholder="" onPick={onPick} onClear={onClear} />);
    const box = screen.getByRole('textbox', { name: 'City' });
    await userEvent.type(box, 'Minn');
    await screen.findAllByRole('option');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/places?q=Minn');

    expect(box.getAttribute('aria-controls')).toBe(screen.getByRole('listbox').id);
    await userEvent.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Minneapolis/ }).id);
    await userEvent.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getByRole('option', { name: /Minnetonka/ }).id);
    await userEvent.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith(PLACES[1]);
    expect(box).toHaveProperty('value', 'Minnetonka');
    await waitFor(() =>
      expect(screen.getByRole('option', { name: /Minnetonka/ }).getAttribute('aria-selected')).toBe('true')
    );
    expect(onClear).not.toHaveBeenCalled();

    // Changing the text after a pick undoes it.
    await userEvent.type(box, 'x');
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('says so when no city has that name', async () => {
    answer([]);
    render(<PlacePicker label="City" placeholder="" onPick={() => {}} />);
    await userEvent.type(screen.getByRole('textbox'), 'Zzyzx');
    expect(await screen.findByText('No city by that name. Try the nearest larger one.')).toBeTruthy();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});
