import { describe, expect, it } from 'vitest';
import { level } from './recordwave.tsx';

describe('level', () => {
  it('is 0 for silence and anything at or below -50 dB', () => {
    expect(level(0)).toBe(0);
    expect(level(10 ** (-60 / 20))).toBe(0);
    expect(level(10 ** (-50 / 20))).toBe(0);
  });

  it('lifts a soft voice off the floor and tops out at full scale', () => {
    expect(level(10 ** (-40 / 20))).toBeCloseTo(Math.sqrt(0.2));
    expect(level(10 ** (-20 / 20))).toBeCloseTo(Math.sqrt(0.6));
    expect(level(1)).toBe(1);
    expect(level(2)).toBe(1);
  });
});
