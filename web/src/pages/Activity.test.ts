// The line under an activity row names what it came through.
import { describe, expect, it } from 'vitest';
import { channel } from './Activity.tsx';

describe('channel', () => {
  it('names an API token, never its client', () => {
    expect(channel({ via: 'token', token: 'Changelog on my iPhone', client: 'Changelog' })).toBe(
      'via Changelog on my iPhone'
    );
    expect(channel({ via: 'token' })).toBe('through the API');
  });
  it('names an assistant by its client and the rest by channel', () => {
    expect(channel({ via: 'assistant', client: 'Claude' })).toBe('Claude');
    expect(channel({ via: 'web' })).toBe('on the web');
    expect(channel({ via: 'email' })).toBe('by email');
    expect(channel({ via: 'weekly-thing' })).toBeNull();
    expect(channel({})).toBeNull();
  });
});
