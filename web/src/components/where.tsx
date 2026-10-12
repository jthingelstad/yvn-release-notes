// Where a note or a day was (AGENTS.md, Where a note was): the city search
// (placepicker.tsx), loaded only once someone asks for it, so React Aria
// stays off Today and Day until then. Optional everywhere.
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { Place } from '../lib/types.ts';
import { ErrorLine, useBusy, useFocusLater, useProblem } from './common.tsx';

const PlacePicker = lazy(() => import('./placepicker.tsx').then((m) => ({ default: m.PlacePicker })));

export const placeName = (p: Place) => [p.name, p.region].filter(Boolean).join(', ');

// The note form's "Where": a button, then the search. Calls onPick with
// the place, or null when it is taken off.
export function NoteWhere({ place, onPick }: { place: Place | null; onPick: (p: Place | null) => void }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const focusLater = useFocusLater();
  if (place)
    return (
      <p className="hint note-where" id="note-where">
        At {placeName(place)}.{' '}
        <button
          className="quiet"
          type="button"
          id="note-where-clear"
          onClick={() => {
            onPick(null);
            focusLater(() => button.current);
          }}
        >
          Not there
        </button>
      </p>
    );
  return (
    <>
      <button
        ref={button}
        className="quiet"
        type="button"
        id="note-where-open"
        hidden={open}
        onClick={() => {
          setOpen(true);
          focusLater(() => input.current);
        }}
      >
        Where
      </button>
      {open && (
        <div className="stack tight place-picker" id="note-where-picker">
          <Suspense fallback={<p className="hint">Loading…</p>}>
            <PlacePicker
              label="Where (optional)"
              placeholder="Start typing a city"
              inputRef={input}
              onPick={(p) => {
                setOpen(false);
                onPick(p);
              }}
            />
          </Suspense>
          <button className="quiet" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </>
  );
}

// A day's own place, with or without a note: set, change or clear it.
// Its weather follows (for a past day), so the day is read again after.
export function DayWhere({ day, where }: { day: string; where?: string }) {
  const [open, setOpen] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const client = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const focusLater = useFocusLater();

  const send = (method: 'PUT' | 'DELETE', place?: Place) =>
    run(async () => {
      problem.clear();
      const r = await api(method, `/api/days/${day}/place`, place ? { place } : undefined);
      if (!r.ok) return problem.show(r.data, input.current);
      setOpen(false);
      // Everything, as a note's change does: the Timeline, search and
      // the export show the day's place or its weather too.
      await client.invalidateQueries();
    });

  return (
    <div className="day-where" id="day-where">
      <p className="hint">
        {where ? (
          <>
            <span id="where">Where: {where}</span>{' '}
            <button
              className="quiet"
              type="button"
              id="day-where-change"
              hidden={open}
              onClick={() => {
                setOpen(true);
                focusLater(() => input.current);
              }}
            >
              Change
            </button>{' '}
            <button className="quiet" type="button" id="day-where-clear" disabled={busy} onClick={() => send('DELETE')}>
              Clear
            </button>
          </>
        ) : (
          <button
            className="quiet"
            type="button"
            id="day-where-open"
            hidden={open}
            onClick={() => {
              setOpen(true);
              focusLater(() => input.current);
            }}
          >
            Where was this day?
          </button>
        )}
      </p>
      {open && (
        <div className="stack tight place-picker" id="day-where-picker">
          <Suspense fallback={<p className="hint">Loading…</p>}>
            <PlacePicker
              label="Where this day was"
              placeholder="Start typing a city"
              inputRef={input}
              onPick={(p) => send('PUT', p)}
            />
          </Suspense>
          <button className="quiet" type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      )}
      <ErrorLine line={problem.line} />
    </div>
  );
}
