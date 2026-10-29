// The profile photo: what the page draws, and how it is made and sent.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { photoSrc, removePhoto, setPhoto, square } from '../lib/photo.ts';
import { sayFor } from '../lib/say.ts';
import { Avatar } from './avatar.tsx';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Avatar', () => {
  it('shows the photo through the API, never a bucket address', () => {
    const { container } = render(<Avatar photo={{ at: '2026-10-28T12:00:00Z' }} className="avatar--nav" />);
    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/me/photo?v=2026-10-28T12%3A00%3A00Z');
    expect(img?.getAttribute('alt')).toBe('');
    expect(img?.className).toBe('avatar avatar--nav');
  });

  it('falls back to the you glyph with no photo, or when it fails to load', () => {
    const none = render(<Avatar />).container;
    expect(none.querySelector('img')).toBeNull();
    expect(none.querySelector('svg')).not.toBeNull();
    cleanup();
    const { container, rerender } = render(<Avatar photo={{ at: 'a' }} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    // A new photo is tried again.
    rerender(<Avatar photo={{ at: 'b' }} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(photoSrc({ at: 'b' }));
  });
});

describe('making the photo', () => {
  it('cuts the largest centred square', () => {
    expect(square(4032, 3024)).toEqual({ sx: 504, sy: 0, side: 3024 });
    expect(square(600, 900)).toEqual({ sx: 0, sy: 150, side: 600 });
    expect(square(512, 512)).toEqual({ sx: 0, sy: 0, side: 512 });
  });

  it('asks for a JPEG or PNG when the browser cannot open the picture (HEIC off Safari)', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('undecodable')))
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const out = await setPhoto(
      new File([new Uint8Array([1, 2, 3])], 'IMG_0001.HEIC', { type: 'image/heic' }),
      () => {}
    );
    expect(out).toEqual({ problem: { error: 'photo-decode' } });
    expect(sayFor({ error: 'photo-decode' })).toBe('This browser can’t open that picture. Try a JPEG or PNG.');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('says each refusal the API gives', () => {
    for (const error of ['photo-type', 'photo-too-big', 'photo-size', 'photo-metadata', 'photo', 'try-again'])
      expect(sayFor({ error })).not.toBe(sayFor({ error: 'no-such-error' }));
    expect(sayFor({ error: 'upload', file: 'The photo' })).toBe('The photo didn’t finish sending. Try again.');
  });

  it('removes through the API and hands back the profile', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ email: 'a@example.com' }), { status: 200 }))
    );
    vi.stubGlobal('fetch', fetch);
    expect(await removePhoto()).toEqual({ me: { email: 'a@example.com' } });
    expect(fetch).toHaveBeenCalledWith('/api/me/photo', expect.objectContaining({ method: 'DELETE' }));
  });
});
