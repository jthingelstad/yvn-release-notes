// The timeline's paused runs and the pages' polling.
import { describe, expect, it } from 'vitest';
import type { Day } from '../lib/types.ts';
import { groupPaused } from './Timeline.tsx';
import { POLL, pollWhileWriting } from './Today.tsx';

const day = (date: string, more: Partial<Day> = {}): Day => ({ date, version: '1.2.3', notes: [], ...more });
const note = { id: 'w-1', source: 'web' as const, text: 'hi' };

describe('groupPaused', () => {
  it('joins paused days in a row with no notes, newest first', () => {
    const rows = groupPaused([
      day('2026-10-09'),
      day('2026-10-08', { paused: true }),
      day('2026-10-07', { paused: true }),
      day('2026-10-06', { paused: true, notes: [note] }),
      day('2026-10-05', { paused: true }),
      day('2026-10-03', { paused: true })
    ]);
    expect(rows.map((r) => ('run' in r ? r.run.map((d) => d.date) : r.day.date))).toEqual([
      '2026-10-09',
      ['2026-10-08', '2026-10-07'],
      '2026-10-06',
      ['2026-10-05'],
      ['2026-10-03']
    ]);
  });
});

describe('pollWhileWriting', () => {
  const q = (writing: boolean, dataUpdateCount = 1) => ({
    state: {
      data: { notes: [{ ...note, media: [{ n: 0, kind: 'audio' as const, type: 'audio/mp4', writing }] }] },
      dataUpdateCount
    }
  });

  it('looks again while a recording is being written out, twenty times at most', () => {
    expect(pollWhileWriting(q(true))).toBe(POLL);
    expect(pollWhileWriting(q(true, 21))).toBe(false);
    expect(pollWhileWriting(q(false))).toBe(false);
    expect(pollWhileWriting({ state: { dataUpdateCount: 0 } })).toBe(false);
  });
});
