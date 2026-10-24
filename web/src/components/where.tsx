// Where a note or a day was (AGENTS.md, Where a note was): the city search
// (placepicker.tsx), loaded only once someone asks for it, so React Aria
// stays off Today and Day until then, and for a note "Here", the device's
// own spot (lib/here.ts). Optional everywhere.
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api, type ApiData } from '../lib/api.ts';
import { canLocate, kept, whereAmI } from '../lib/here.ts';
import type { Day, DayPage, Place, Today } from '../lib/types.ts';
import { Icon } from './icon.tsx';
import { ErrorLine, useBusy, useFocusLater, useProblem } from './common.tsx';

const PlacePicker = lazy(() => import('./placepicker.tsx').then((m) => ({ default: m.PlacePicker })));

// "Caribou Coffee, Minneapolis", "Downtown West, Minneapolis" or
// "Minneapolis, Minnesota", as the server labels a note's place.
export const placeName = (p: Place) => {
  const near = p.venue || p.district;
  return near ? `${near}, ${p.name}` : [p.name, p.region].filter(Boolean).join(', ');
};

// "Were you at": the businesses Here found near, one tap to name the note
// by one (and again to go back to the neighbourhood). Never chosen for it.
function Nearby({ place, onPick, busy }: { place: Place; onPick: (p: Place) => void; busy?: boolean }) {
  if (!place.nearby?.length) return null;
  return (
    <div className="row nearby" role="group" aria-labelledby="nearby-label">
      <span className="hint" id="nearby-label">
        Were you at
      </span>
      {place.nearby.map((v) => (
        <button
          key={v.name}
          className="quiet"
          type="button"
          disabled={busy}
          aria-pressed={place.venue === v.name}
          onClick={() => onPick(place.venue === v.name ? { ...place, venue: undefined } : { ...place, venue: v.name })}
        >
          {v.name}
        </button>
      ))}
    </div>
  );
}

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
    // "Add where I am" is on unless turned off, so a browser that was told
    // no stays quiet until Here is tapped: no complaint on every visit.
    else if (asked || found.problem.error !== 'location-denied')
      onProblem(found.problem, asked ? here.current : undefined);
  };
  const looking = auto && !place && !declined && !open && canLocate();
  useEffect(() => {
    if (looking) locate(false);
    // Once for each time the form is left without a place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looking]);

  if (place)
    return (
      <>
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
        <Nearby place={place} onPick={choose} />
      </>
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
// given up; a failure stays open, saying why. Here saves at once, then
// stays to offer what was near, until Done.
export function SavedNoteWhere({ path, has, onDone }: { path: string; has: boolean; onDone: () => void }) {
  const [busy, run] = useBusy();
  const problem = useProblem();
  const client = useQueryClient();
  const [found, setFound] = useState<Place | null>(null);
  const here = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef<HTMLButtonElement>(null);
  const focusLater = useFocusLater();

  const put = async (place: Place, field?: HTMLElement | null) => {
    const r = await api('PUT', `${path}/place`, { place: kept(place) });
    if (!r.ok) problem.show(r.data, field);
    else await client.invalidateQueries();
    return r.ok;
  };
  const send = (place: Place | null, field?: HTMLElement | null) =>
    run(async () => {
      problem.clear();
      if (place) {
        if (!(await put(place, field))) return;
      } else {
        const r = await api('DELETE', `${path}/place`);
        if (!r.ok) return problem.show(r.data, field);
        await client.invalidateQueries();
      }
      onDone();
    });

  if (found)
    return (
      <div className="stack tight place-picker note-where-edit" id="note-where-edit">
        <p className="hint">At {placeName(found)}.</p>
        <Nearby
          place={found}
          busy={busy}
          onPick={(p) =>
            run(async () => {
              problem.clear();
              if (await put(p, done.current)) setFound(p);
            })
          }
        />
        <button ref={done} className="quiet" type="button" onClick={onDone}>
          Done
        </button>
        <ErrorLine line={problem.line} />
      </div>
    );
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
                const at = await whereAmI();
                if (!('place' in at)) return problem.show(at.problem, here.current);
                if (!(await put(at.place, here.current))) return;
                if (!at.place.nearby?.length) return onDone();
                setFound(at.place);
                focusLater(() => done.current);
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
