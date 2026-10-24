// A note's "Here": the device's spot, named by the server, asked on a tap
// or, with "Add where I am", by the form itself.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Place } from '../lib/types.ts';
import { NoteWhere } from './where.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'geolocation');
});

// The browser's answer: a spot, or a refusal (code 1) or failure.
function device(at: { lat: number; lon: number } | { code: number }) {
  const getCurrentPosition = vi.fn((ok: PositionCallback, fail: PositionErrorCallback) =>
    'code' in at
      ? fail({ code: at.code } as GeolocationPositionError)
      : ok({ coords: { latitude: at.lat, longitude: at.lon, accuracy: 9 } } as GeolocationPosition)
  );
  Object.defineProperty(navigator, 'geolocation', { value: { getCurrentPosition }, configurable: true });
  return getCurrentPosition;
}
function named(name: string) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    const spot = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ name, region: 'Minnesota', country: 'United States', ...spot, from: 'device' })
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('NoteWhere', () => {
  it('asks where the device is only on a tap, and names it through the server', async () => {
    const asked = device({ lat: 44.9483, lon: -93.2817 }),
      fetch = named('Minneapolis'),
      onPick = vi.fn();
    render(<NoteWhere place={null} onPick={onPick} onProblem={vi.fn()} />);
    expect(asked).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Here/ }));
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    expect(fetch.mock.calls[0]![0]).toBe('/api/places/here');
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({ lat: 44.9483, lon: -93.2817, accuracy_m: 9 });
    expect((onPick.mock.calls[0]![0] as Place).name).toBe('Minneapolis');
  });

  it('with "Add where I am" it looks by itself, and a short walk reuses the name', async () => {
    device({ lat: 44.9485, lon: -93.2819 });
    const fetch = named('Elsewhere'),
      onPick = vi.fn();
    render(<NoteWhere place={null} onPick={onPick} onProblem={vi.fn()} auto />);
    await waitFor(() => expect(onPick).toHaveBeenCalled());
    // A few metres from the last spot named: no second request.
    expect(fetch).not.toHaveBeenCalled();
    expect(onPick.mock.calls[0]![0]).toMatchObject({ name: 'Minneapolis', lat: 44.9485, lon: -93.2819 });
  });

  it('says so when the browser refuses, and puts focus on Here', async () => {
    device({ code: 1 });
    named('Unused');
    const onProblem = vi.fn();
    render(<NoteWhere place={null} onPick={vi.fn()} onProblem={onProblem} />);
    const here = screen.getByRole('button', { name: /Here/ });
    await userEvent.click(here);
    await waitFor(() => expect(onProblem).toHaveBeenCalledWith({ error: 'location-denied' }, here));
  });

  it('shows the place, and "Not there" takes it off', async () => {
    const onPick = vi.fn();
    render(
      <NoteWhere
        place={{ name: 'Paris', region: 'Ile-de-France', lat: 48.856613, lon: 2.352222, from: 'device' }}
        onPick={onPick}
        onProblem={vi.fn()}
        auto
      />
    );
    expect(screen.getByText(/At Paris, Ile-de-France/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Not there' }));
    expect(onPick).toHaveBeenCalledWith(null);
  });
});
