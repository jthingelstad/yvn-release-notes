// One check-in (docs/CHECK-INS.md): where and when, a name for it once or for
// good, its real circle on a map, a note about it, and Delete. Its id travels
// in the fragment, so no address in any log says when someone stopped.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useRef, useState } from 'react';
import {
  AppLink,
  Bar,
  Crumb,
  ErrorLine,
  Failed,
  Loading,
  useBusy,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { carryPlace } from '../components/noteform.tsx';
import { SpotMap } from '../components/spot-map.tsx';
import { CHECKIN_NAME_MAX, UNNAMED_STOP } from '../../../packages/domain/check-ins.ts';
import { ApiError, api, load } from '../lib/api.ts';
import { stayLine } from '../lib/check-ins.ts';
import { dayName } from '../lib/format.ts';
import { kept } from '../lib/here.ts';
import { useHashParam } from '../lib/nav.ts';
import { checkInQuery } from '../lib/queries.ts';
import type { Place, Stay } from '../lib/types.ts';

const THIS_YEAR = new Date().getFullYear();

// What a check-in's name came from, in a line.
const NAMED_BY: Record<Stay['named_by'], string> = {
  own: 'You named this stop.',
  place: 'A place you remember. Rename or forget it in Settings.',
  district: 'The neighbourhood, until you name it.',
  none: 'Nothing named this spot.'
};

// Names for the spot, asked for only when wanted: each is a paid lookup, and
// Amazon Location is told the coordinates alone.
const spotNames = (stay: Stay) => ({
  queryKey: ['spot-names', stay.lat, stay.lon],
  queryFn: () => load<Place>('POST', '/api/places/here', { lat: stay.lat, lon: stay.lon }),
  staleTime: Infinity,
  retry: false,
  meta: { bounce: false }
});

export function CheckIn() {
  useTitle('Check-in');
  const id = useHashParam('c') ?? '';
  const found = useQuery({ ...checkInQuery(id), enabled: Boolean(id), retry: false, meta: { bounce: false } });
  const gone = !id || (found.error instanceof ApiError && found.error.answer.status === 404);
  return (
    <>
      <Bar />
      <Crumb href="/activity/#only=check-ins">Check-ins</Crumb>
      {gone ? (
        <>
          <h1>Check-in</h1>
          <p className="lede">That check-in isn’t here any more.</p>
        </>
      ) : found.isPending ? (
        <Loading />
      ) : found.data ? (
        <Stop key={found.data.check_in.id} stay={found.data.check_in} />
      ) : (
        <Failed />
      )}
    </>
  );
}

function Stop({ stay }: { stay: Stay }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [naming, setNaming] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const names = useQuery({ ...spotNames(stay), enabled: naming });
  const line = stayLine(stay, stay.time_zone);
  const named = stay.named_by === 'own' || stay.named_by === 'place';

  const changed = async (next?: Stay) => {
    if (next) client.setQueryData(['check-in', stay.id], { check_in: next });
    await Promise.all([
      client.invalidateQueries({ queryKey: ['check-ins'] }),
      client.invalidateQueries({ queryKey: ['activity'] }),
      client.invalidateQueries({ queryKey: ['named-places'] })
    ]);
  };
  // The note starts on the check-in's day, at its spot, with its name as the
  // venue, and has no link back. With no name for the spot it starts anyway:
  // Where can add one.
  const write = () =>
    run(async () => {
      const place = await client.fetchQuery(spotNames(stay)).catch(() => null);
      if (place)
        carryPlace(stay.day, {
          ...kept(place),
          ...(stay.accuracy_m ? { accuracy_m: stay.accuracy_m } : {}),
          ...(named ? { venue: stay.label } : {})
        });
      await navigate({ to: '/day/', search: { d: stay.day } });
    });
  const remove = () =>
    run(async () => {
      problem.clear();
      if (!window.confirm('Delete this check-in? It can’t be brought back.')) return;
      const r = await api('DELETE', '/api/check-ins/' + encodeURIComponent(stay.id));
      if (!r.ok) return problem.show(r.data);
      client.removeQueries({ queryKey: ['check-in', stay.id] });
      await changed();
      await navigate({ to: '/activity/', hash: 'only=check-ins' });
    });
  return (
    <>
      <h1>{stay.label === UNNAMED_STOP ? 'Unnamed stop' : stay.label}</h1>
      <p className="lede">
        {dayName(stay.day, THIS_YEAR)}
        {line && `, ${line}`}.
      </p>
      <p className="hint">{NAMED_BY[stay.named_by]}</p>
      <SpotMap stay={stay} />
      <p className="meta">
        {stay.accuracy_m ? `The circle is how sure the phone was, about ${Math.round(stay.accuracy_m)} m. ` : ''}
        <AppLink href={`/map/#c=${encodeURIComponent(stay.id)}`}>See it on the Map</AppLink>
        {stay.token ? `. Sent by ${stay.token}.` : stay.client ? `. Sent by ${stay.client}.` : '.'}
      </p>
      <p className="row">
        <button className="go" type="button" disabled={busy} onClick={write}>
          Write about this
        </button>
        {!naming && (
          <button className="quiet" type="button" onClick={() => setNaming(true)}>
            {named ? 'Change the name' : 'Name it'}
          </button>
        )}
        <button className="quiet danger" type="button" disabled={busy} onClick={remove}>
          Delete
        </button>
      </p>
      <ErrorLine line={problem.line} />
      {naming && (
        <NameForm
          stay={stay}
          nearby={names.data?.nearby?.map((v) => v.name) ?? []}
          done={() => setNaming(false)}
          changed={changed}
        />
      )}
    </>
  );
}

function NameForm({
  stay,
  nearby,
  done,
  changed
}: {
  stay: Stay;
  nearby: string[];
  done: () => void;
  changed: (next: Stay) => Promise<void>;
}) {
  const [name, setName] = useState(stay.name ?? '');
  // Off by default, so naming one stop never relabels history unasked.
  const [remember, setRemember] = useState(false);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const box = useRef<HTMLInputElement>(null);
  const send = (value: string | null, keep: boolean) =>
    run(async () => {
      problem.clear();
      const r = await api<{ check_in: Stay }>('PUT', '/api/check-ins/' + encodeURIComponent(stay.id), {
        name: value,
        revision: stay.revision,
        ...(keep ? { remember: true } : {})
      });
      if (!r.ok) return problem.show(r.data, box.current);
      await changed(r.data.check_in);
      done();
    });
  return (
    <form
      className="stack tight checkin-name"
      noValidate
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        void send(name, remember);
      }}
    >
      <label>
        Name
        <input
          ref={box}
          name="check-in-name"
          value={name}
          maxLength={CHECKIN_NAME_MAX}
          autoComplete="off"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {nearby.length > 0 && (
        <div className="row nearby" role="group" aria-label="Nearby">
          {nearby.map((venue) => (
            <button
              key={venue}
              type="button"
              className="quiet"
              aria-pressed={name === venue}
              onClick={() => setName(venue)}
            >
              {venue}
            </button>
          ))}
        </div>
      )}
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> Remember this place
      </label>
      <p className="hint">
        {remember
          ? 'Every stop within about 100 m gets this name, past and future. A name you’ve used before gains this spot.'
          : 'This stop alone gets this name.'}
      </p>
      <p className="row">
        <button className="go" type="submit" disabled={busy}>
          Save name
        </button>
        {stay.name && (
          <button className="quiet" type="button" disabled={busy} onClick={() => void send(null, false)}>
            Take the name off
          </button>
        )}
        <button className="quiet" type="button" disabled={busy} onClick={done}>
          Cancel
        </button>
      </p>
      <ErrorLine line={problem.line} />
    </form>
  );
}
