// Settings for check-ins (docs/CHECK-INS.md): the places remembered, to rename,
// tag, ignore and forget, with their check-ins to delete, and deleting every
// check-in. Shown once there is either.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import { count } from '../lib/format.ts';
import { checkInsQuery, namedPlacesQuery } from '../lib/queries.ts';
import { named, tagLine, type Tag } from '../lib/tags.ts';
import type { NamedPlace } from '../lib/types.ts';
import { CHECKIN_NAME_MAX } from '../../../packages/domain/check-ins.ts';
import { mergeTags } from '../../../packages/domain/tags.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { SettingsGroup } from './settings-group.tsx';
import { TagField } from './tag-field.tsx';
import { useTagNames } from './tag-row.tsx';

export function CheckInSettings() {
  const client = useQueryClient();
  const stays = useQuery(checkInsQuery).data?.stays;
  const places = useQuery(namedPlacesQuery).data?.places;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, run] = useBusy();
  const problem = useProblem();
  if (!stays || !places || (!stays.length && !places.length)) return null;
  const changed = () =>
    Promise.all(
      ['check-ins', 'check-in', 'named-places', 'activity'].map((key) => client.invalidateQueries({ queryKey: [key] }))
    );
  const forget = (place: NamedPlace) =>
    run(async () => {
      problem.clear();
      const back = place.ignored ? ' The check-ins hidden there show again.' : '';
      if (!window.confirm(`Forget ${place.name}? Its stops go back to the names they had.${back}`)) return;
      const r = await api('DELETE', '/api/check-ins/places/' + encodeURIComponent(place.id));
      if (!r.ok) return problem.show(r.data);
      await changed();
    });
  // Ignore this location (Jamie, 2026-11-08): no new stop there is kept, and
  // those already there are hidden until it's unchecked.
  const ignore = (place: NamedPlace, ignored: boolean) =>
    run(async () => {
      problem.clear();
      const r = await api('PUT', '/api/check-ins/places/' + encodeURIComponent(place.id), { ignored });
      if (!r.ok) return problem.show(r.data);
      await changed();
    });
  // Delete existing check-ins here: counted first, hidden ones too, and gone
  // only for the count shown.
  const removeHere = (place: NamedPlace) =>
    run(async () => {
      problem.clear();
      const at = '/api/check-ins/places/' + encodeURIComponent(place.id),
        read = await api<{ place: NamedPlace & { check_ins: number } }>('GET', at);
      if (!read.ok) return problem.show(read.data);
      const n = read.data.place.check_ins;
      if (!n) return window.alert(`There are no check-ins at ${place.name}.`);
      const those = count(n, 'check-in', 'check-ins');
      if (
        !window.confirm(`Delete ${those} at ${place.name}? They can’t be brought back. ${place.name} stays remembered.`)
      )
        return;
      const r = await api('DELETE', at + '/check-ins', { count: n });
      if (!r.ok) return problem.show(r.data);
      await changed();
    });
  const removeAll = () =>
    run(async () => {
      problem.clear();
      const those = count(stays.length, 'check-in', 'check-ins'),
        hidden = places.some((place) => place.ignored) ? ' Those hidden at places you ignore go too.' : '';
      if (!window.confirm(`Delete ${those}? They can’t be brought back.${hidden} The places you remember stay.`))
        return;
      const r = await api('DELETE', '/api/check-ins', { confirm: 'all' });
      if (!r.ok) return problem.show(r.data);
      await changed();
    });
  return (
    <SettingsGroup
      id="check-ins"
      title="Check-ins"
      description={`${count(stays.length, 'check-in', 'check-ins')}, ${count(places.length, 'place', 'places')} remembered`}
    >
      <p className="hint">
        The places you stop, kept until you delete them. The <a href="/guide/check-ins/">guide</a> says how they work.
      </p>
      {places.map((place) =>
        renaming === place.id ? (
          <Rename key={place.id} place={place} done={() => setRenaming(null)} changed={changed} />
        ) : (
          <div className="section" key={place.id}>
            <h3>{place.name}</h3>
            <p className="hint">
              {count(place.spots.length, 'spot', 'spots')}
              {place.ignored ? ', ignored' : ''}
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={place.ignored}
                disabled={busy}
                onChange={(e) => ignore(place, e.target.checked)}
              />{' '}
              Ignore this location
            </label>
            <PlaceTags place={place} changed={changed} />
            <p className="hint">
              {place.ignored
                ? 'No new check-ins are kept here, and the ones already here are hidden. Uncheck it to bring them back.'
                : 'Stop keeping check-ins here, and hide the ones already here. Nothing is deleted.'}
            </p>
            <p className="row">
              <button className="quiet" type="button" disabled={busy} onClick={() => setRenaming(place.id)}>
                Rename {place.name}
              </button>
              <button className="quiet" type="button" disabled={busy} onClick={() => forget(place)}>
                Forget {place.name}
              </button>
              <button className="quiet danger" type="button" disabled={busy} onClick={() => removeHere(place)}>
                Delete existing check-ins here
              </button>
            </p>
          </div>
        )
      )}
      {stays.length > 0 && (
        <section className="section" id="check-ins-delete">
          <button className="quiet danger" type="button" disabled={busy} onClick={removeAll}>
            Delete all check-ins
          </button>
          <p className="hint">Every stop goes. The places you remember stay, for the next time you stop there.</p>
        </section>
      )}
      <ErrorLine line={problem.line} />
    </SettingsGroup>
  );
}

// A remembered place's tags (Jamie's call 6, 2026-11-08), saved as each is
// added or taken off: each new check-in there gets them. A tag added offers,
// once, to tag the check-ins already there too, for the count it shows; one
// taken off leaves them as they are.
function PlaceTags({ place, changed }: { place: NamedPlace; changed: () => Promise<unknown> }) {
  const client = useQueryClient();
  const [busy, run] = useBusy();
  const problem = useProblem();
  const offer = useTagNames();
  // The tags gained and not yet put on the check-ins already there, and how
  // many those are.
  const [ask, setAsk] = useState<{ tags: Tag[]; count: number; again?: boolean } | null>(null);
  const [said, setSaid] = useState('');
  const tags = named(place.tags, place.tag_names);
  const at = '/api/check-ins/places/' + encodeURIComponent(place.id);
  const send = (next: Tag[]) =>
    run(async () => {
      problem.clear();
      setSaid('');
      const r = await api<{ place: NamedPlace & { check_ins?: number } }>('PUT', at, {
        tags: next.map((t) => t.name)
      });
      if (!r.ok) return problem.show(r.data);
      const { check_ins: there, ...saved } = r.data.place;
      client.setQueryData(namedPlacesQuery.queryKey, (old) =>
        old ? { places: old.places.map((p) => (p.id === saved.id ? saved : p)) } : old
      );
      const gained = next.filter((t) => !tags.some((h) => h.key === t.key)),
        still = (ask?.tags ?? []).filter((t) => next.some((n) => n.key === t.key)),
        asking = mergeTags(still, gained);
      setAsk(asking.length && (there ?? ask?.count) ? { tags: asking, count: there ?? ask!.count } : null);
      await changed();
    });
  const tagThem = () =>
    run(async () => {
      if (!ask) return;
      problem.clear();
      const r = await api<{ tagged?: number; count?: number }>('PATCH', at + '/check-ins', {
        tags: ask.tags.map((t) => t.name),
        count: ask.count
      });
      // More or fewer there than were counted: ask again, with how many now.
      if (!r.ok && r.data.error === 'check-in-count' && typeof r.data.count === 'number') {
        if (!r.data.count) {
          setAsk(null);
          return setSaid(`There are no check-ins at ${place.name} now.`);
        }
        return setAsk({ ...ask, count: r.data.count, again: true });
      }
      if (!r.ok) return problem.show(r.data);
      const n = r.data.tagged ?? 0;
      setAsk(null);
      setSaid(
        n
          ? `Tagged ${count(n, 'check-in', 'check-ins')} at ${place.name}.`
          : `The check-ins at ${place.name} had ${ask.tags.length === 1 ? 'that tag' : 'those tags'} already.`
      );
      await changed();
    });
  const question = !ask
    ? ''
    : ask.again
      ? `The check-ins here changed: there ${ask.count === 1 ? 'is 1' : `are ${ask.count}`} now. Tag ${ask.count === 1 ? 'it' : 'them'} with ${tagLine(ask.tags)} too?`
      : `Tag ${ask.count === 1 ? 'its check-in' : `its ${ask.count} check-ins`} with ${tagLine(ask.tags)} too?`;
  return (
    <div className="place-tags">
      <TagField
        label={`Tags for ${place.name}`}
        tags={tags}
        offer={offer}
        busy={busy}
        onAdd={(t) => send([...tags, t])}
        onRemove={(t) => send(tags.filter((x) => x.key !== t.key))}
        hint="Each new check-in here gets these. Taking one off leaves the check-ins already here as they are."
      />
      <p className="hint" role="status">
        {ask ? question : said}
      </p>
      {ask && (
        <p className="row">
          <button className="go small" type="button" disabled={busy} onClick={tagThem}>
            Tag them
          </button>
          <button className="quiet" type="button" disabled={busy} onClick={() => setAsk(null)}>
            Not now
          </button>
        </p>
      )}
      <ErrorLine line={problem.line} />
    </div>
  );
}

function Rename({ place, done, changed }: { place: NamedPlace; done: () => void; changed: () => Promise<unknown> }) {
  const [name, setName] = useState(place.name);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const box = useRef<HTMLInputElement>(null);
  return (
    <form
      className="section stack tight"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void run(async () => {
          problem.clear();
          const r = await api('PUT', '/api/check-ins/places/' + encodeURIComponent(place.id), { name });
          if (!r.ok) return problem.show(r.data, box.current);
          await changed();
          done();
        });
      }}
    >
      <label>
        Name
        <input
          ref={box}
          name="place-name"
          value={name}
          maxLength={CHECKIN_NAME_MAX}
          autoComplete="off"
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <p className="row">
        <button className="go" type="submit" disabled={busy}>
          Save name
        </button>
        <button className="quiet" type="button" disabled={busy} onClick={done}>
          Cancel
        </button>
      </p>
      <ErrorLine line={problem.line} />
    </form>
  );
}
