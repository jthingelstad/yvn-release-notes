// The sign-in page's Turnstile handle, with a stand-in for Cloudflare's script.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachTurnstile, SITE_KEY, type TurnstileApi } from './turnstile.ts';

type Options = Parameters<TurnstileApi['render']>[1];

function standIn() {
  const renders: Options[] = [];
  const api: TurnstileApi = {
    render: (_el, options) => {
      renders.push(options);
      return `w${renders.length}`;
    },
    reset: vi.fn()
  };
  return { api, renders, load: vi.fn(async () => api) };
}

afterEach(() => vi.useRealTimers());

describe('attachTurnstile', () => {
  it('renders nothing until warmed, then explicitly, interaction-only, with the widget key', async () => {
    const s = standIn();
    const slot = document.createElement('div');
    const t = attachTurnstile(() => slot, 'signin', s.load);
    expect(s.load).not.toHaveBeenCalled();
    t.warm();
    t.warm();
    await Promise.resolve();
    expect(s.load).toHaveBeenCalledTimes(1);
    expect(s.renders).toHaveLength(1);
    expect(s.renders[0]).toMatchObject({ sitekey: SITE_KEY, action: 'signin', appearance: 'interaction-only' });
  });

  it('hands one token to the same address up to three times, then asks for a fresh one', async () => {
    const s = standIn();
    const t = attachTurnstile(() => document.createElement('div'), 'signin', s.load);
    t.warm();
    await Promise.resolve();
    s.renders[0]!.callback('tok-1');
    expect(await t.tokenFor('Ada@Example.com')).toBe('tok-1');
    expect(await t.tokenFor('ada@example.com')).toBe('tok-1');
    expect(await t.tokenFor('ada@example.com')).toBe('tok-1');
    vi.useFakeTimers();
    const fourth = t.tokenFor('ada@example.com');
    expect(s.api.reset).toHaveBeenCalledWith('w1');
    s.renders[0]!.callback('tok-2');
    expect(await fourth).toBe('tok-2');
  });

  it('a different address gets a fresh token', async () => {
    const s = standIn();
    const t = attachTurnstile(() => document.createElement('div'), 'signin', s.load);
    t.warm();
    await Promise.resolve();
    s.renders[0]!.callback('tok-1');
    expect(await t.tokenFor('ada@example.com')).toBe('tok-1');
    vi.useFakeTimers();
    const other = t.tokenFor('bea@example.com');
    expect(s.api.reset).toHaveBeenCalledTimes(1);
    s.renders[0]!.callback('tok-3');
    expect(await other).toBe('tok-3');
  });

  it('submits without a token when the script cannot load, or nothing comes in five seconds', async () => {
    const failed = attachTurnstile(
      () => document.createElement('div'),
      'signin',
      async () => {
        throw new Error('blocked');
      }
    );
    expect(await failed.tokenFor('ada@example.com')).toBe('');

    vi.useFakeTimers();
    const s = standIn();
    const quiet = attachTurnstile(() => document.createElement('div'), 'signin', s.load);
    const waiting = quiet.tokenFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(5300);
    expect(await waiting).toBe('');
  });

  it('waits for a person working through a visible challenge', async () => {
    vi.useFakeTimers();
    const s = standIn();
    const t = attachTurnstile(() => document.createElement('div'), 'signin', s.load);
    const waiting = t.tokenFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(0);
    s.renders[0]!['before-interactive-callback']();
    await vi.advanceTimersByTimeAsync(30000);
    s.renders[0]!.callback('tok-after-checkbox');
    expect(await waiting).toBe('tok-after-checkbox');
  });
});
