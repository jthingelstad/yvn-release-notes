// Subscribe's address on Apple devices and on Android.
import { describe, expect, it } from 'vitest';
import { subscribeHref } from './calendar.ts';

const FEED = 'https://notes.example.com/api/calendar/abc123.ics';
const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

describe('subscribeHref', () => {
  it('is the webcal: address where Calendar takes it', () => {
    expect(subscribeHref(FEED, IPHONE)).toBe('webcal://notes.example.com/api/calendar/abc123.ics');
  });
  it('is none on Android, where no tap can subscribe', () => {
    expect(subscribeHref(FEED, PIXEL)).toBeNull();
  });
});
