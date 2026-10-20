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

  it('shows the slot only while Cloudflare asks, and collapses it once answered', async () => {
    const s = standIn();
    const slot = document.createElement('div');
    const t = attachTurnstile(() => slot, 'signin', s.load);
    expect(slot.dataset.turnstile).toBeUndefined();
    t.warm();
    await Promise.resolve();
    expect(slot.dataset.turnstile).toBe('quiet');
    s.renders[0]!['before-interactive-callback']();
    expect(slot.dataset.turnstile).toBe('asking');
    s.renders[0]!.callback('tok-1');
    expect(slot.dataset.turnstile).toBe('quiet');
    s.renders[0]!['before-interactive-callback']();
    s.renders[0]!['error-callback']();
    expect(slot.dataset.turnstile).toBe('quiet');
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

  it('says why a request goes without a token, and how long it waited', async () => {
    const blocked = attachTurnstile(
      () => document.createElement('div'),
      'signin',
      async () => {
        throw new Error('turnstile-blocked');
      }
    );
    expect(await blocked.fieldsFor('ada@example.com')).toMatchObject({
      turnstile_token: '',
      turnstile_reason: 'script-blocked'
    });

    const empty = attachTurnstile(
      () => document.createElement('div'),
      'signin',
      async () => {
        throw new Error('turnstile-unavailable');
      }
    );
    expect((await empty.fieldsFor('ada@example.com')).turnstile_reason).toBe('script-empty');

    const noSlot = attachTurnstile(() => null, 'signin', standIn().load);
    expect((await noSlot.fieldsFor('ada@example.com')).turnstile_reason).toBe('no-slot');

    vi.useFakeTimers();
    const erroring = standIn();
    const e = attachTurnstile(() => document.createElement('div'), 'signin', erroring.load);
    const failing = e.fieldsFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(0);
    erroring.renders[0]!['error-callback']('110200');
    await vi.advanceTimersByTimeAsync(5300);
    expect((await failing).turnstile_reason).toBe('error:110200');

    const neverLoads = attachTurnstile(
      () => document.createElement('div'),
      'signin',
      () => new Promise<TurnstileApi>(() => {})
    );
    const loading = neverLoads.fieldsFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(5300);
    expect(await loading).toMatchObject({ turnstile_token: '', turnstile_reason: 'loading-timeout' });
    expect((await loading).turnstile_wait_ms).toBeGreaterThanOrEqual(5000);

    const silent = standIn();
    const quiet = attachTurnstile(() => document.createElement('div'), 'signin', silent.load);
    const solving = quiet.fieldsFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(5300);
    expect((await solving).turnstile_reason).toBe('solving-timeout');

    const asking = standIn();
    const checkbox = attachTurnstile(() => document.createElement('div'), 'signin', asking.load);
    const shown = checkbox.fieldsFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(0);
    asking.renders[0]!['before-interactive-callback']();
    await vi.advanceTimersByTimeAsync(120300);
    expect((await shown).turnstile_reason).toBe('interactive-timeout');
  });

  it('sends no reason with a token, and forgets an error once a token comes', async () => {
    vi.useFakeTimers();
    const s = standIn();
    const t = attachTurnstile(() => document.createElement('div'), 'signin', s.load);
    const waiting = t.fieldsFor('ada@example.com');
    await vi.advanceTimersByTimeAsync(0);
    s.renders[0]!['error-callback']('300030');
    await vi.advanceTimersByTimeAsync(1000);
    s.renders[0]!.callback('tok-retried');
    const fields = await waiting;
    expect(fields).toMatchObject({ turnstile_token: 'tok-retried' });
    expect(fields).not.toHaveProperty('turnstile_reason');
    expect(fields.turnstile_wait_ms).toBeGreaterThanOrEqual(1000);
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
