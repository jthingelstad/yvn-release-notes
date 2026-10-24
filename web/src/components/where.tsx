// Where a note or a day was (AGENTS.md, Where a note was): the city search
// (placepicker.tsx), loaded only once someone asks for it, so React Aria
// stays off Today and Day until then, and for a note "Here", the device's
// own spot (lib/here.ts). Optional everywhere.
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, type ApiData } from '../lib/api.ts';
import { canLocate, whereAmI } from '../lib/here.ts';
import type { Day, DayPage, Place, Today } from '../lib/types.ts';
import { Icon } from './icon.tsx';
import { ErrorLine, useBusy, useFocusLater, useProblem } from './common.tsx';

const PlacePicker = lazy(() => import('./placepicker.tsx').then((m) => ({ default: m.PlacePicker })));

export const placeName = (p: Place) => [p.name, p.region].filter(Boolean).join(', ');

// The note form's "Here" and "Where": the device's spot, or the search.
// Calls onPick with the place, or null when it is taken off. With `auto`
// ("Add where I am", on Today) it looks for the spot itself whenever the
// form has none, until "Not there" says otherwise (for this note: the form
// gives each new note a fresh one); problems go to the form's line, which
// takes focus only when a tap asked. A lookup still out when a place is
// picked or taken off is dropped, so a slow answer never overrides a choice.
export function NoteWhere({
  place,
  onPick,
  onProblem,
  auto = false
}: {
  place: Place | null;
  onPick: (p: Place | null) => void;
  onProblem: (p: ApiData, field?: HTMLElement | null) => void;
  auto?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [finding, setFinding] = useState(false);
  const [declined, setDeclined] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const here = useRef<HTMLButtonElement>(null);
  const asking = useRef(0);
  const focusLater = useFocusLater();

  const choose = (p: Place | null) => {
    asking.current++;
    setFinding(false);
    onPick(p);
  };
  const locate = async (asked: boolean) => {
    const mine = ++asking.current;
    setFinding(true);
    const found = await whereAmI();
    if (mine !== asking.current) return;
    setFinding(false);
    if ('place' in found) onPick(found.place);
    else onProblem(found.problem, asked ? here.current : undefined);
  };
  const looking = auto && !place && !declined && !open && canLocate();
  useEffect(() => {
    if (looking) locate(false);
    // Once for each time the form is left without a place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looking]);

  if (place)
    return (
      <p className="hint note-where" id="note-where">
        At {placeName(place)}.{' '}
        <button
          className="quiet"
          type="button"
          id="note-where-clear"
          onClick={() => {
            setDeclined(true);
            choose(null);
            focusLater(() => button.current);
          }}
        >
          Not there
        </button>
      </p>
    );
  return (
    <>
      {canLocate() && (
        <button
          ref={here}
          className="quiet"
          type="button"
          id="note-where-here"
          hidden={open}
          disabled={finding}
          onClick={() => locate(true)}
        >
          <Icon name="here" /> {finding ? 'Finding…' : 'Here'}
        </button>
      )}
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
        <Icon name="where" /> Where
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
                choose(p);
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

// A saved note's place, from its Where button: here, a city, or none.
// Calls onDone once the change is saved (the pages are read again) or
// given up; a failure stays open, saying why.
export function SavedNoteWhere({ path, has, onDone }: { path: string; has: boolean; onDone: () => void }) {
  const [busy, run] = useBusy();
  const problem = useProblem();
  const client = useQueryClient();
  const here = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const send = (place: Place | null, field?: HTMLElement | null) =>
    run(async () => {
      problem.clear();
      const r = place ? await api('PUT', `${path}/place`, { place }) : await api('DELETE', `${path}/place`);
      if (!r.ok) return problem.show(r.data, field);
      await client.invalidateQueries();
      onDone();
    });

  return (
    <div className="stack tight place-picker note-where-edit" id="note-where-edit">
      <div className="row">
        {canLocate() && (
          <button
            ref={here}
            className="quiet"
            type="button"
            disabled={busy}
            onClick={() =>
              run(async () => {
                problem.clear();
                const found = await whereAmI();
                if (!('place' in found)) return problem.show(found.problem, here.current);
                const r = await api('PUT', `${path}/place`, { place: found.place });
                if (!r.ok) return problem.show(r.data, here.current);
                await client.invalidateQueries();
                onDone();
              })
            }
          >
            <Icon name="here" /> {busy ? 'Saving…' : 'Here'}
          </button>
        )}
        {has && (
          <button className="quiet" type="button" disabled={busy} onClick={() => send(null)}>
            No place
          </button>
        )}
        <button className="quiet" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <Suspense fallback={<p className="hint">Loading…</p>}>
        <PlacePicker
          label={has ? 'Where this note was instead' : 'Where this note was'}
          placeholder="Start typing a city"
          inputRef={input}
          onPick={(p) => send(p, input.current)}
        />
      </Suspense>
      <ErrorLine line={problem.line} />
    </div>
  );
}

// The queries a place change's answer has already brought up to date.
export const answered = (key: readonly unknown[], data: unknown, day: string) =>
  (key[0] === 'day' && key[1] === day) || (key[0] === 'today' && (data as Today | undefined)?.date === day);

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
      const r = await api<Pick<Day, 'where' | 'weather'>>(
        method,
        `/api/days/${day}/place`,
        place ? { place } : undefined
      );
      if (!r.ok) return problem.show(r.data, input.current);
      setOpen(false);
      // This day from the answer, read just after the write: a refetch
      // may not see it yet. Then everything else, as a note's change
      // does: the Timeline, search and the export show it too.
      const fresh = r.data;
      client.setQueryData<DayPage>(['day', day], (d) => d && { ...d, where: fresh.where, weather: fresh.weather });
      client.setQueryData<Today>(['today'], (t) => (t?.date === day ? { ...t, where: fresh.where } : t));
      await client.invalidateQueries({ predicate: (q) => !answered(q.queryKey, q.state.data, day) });
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
