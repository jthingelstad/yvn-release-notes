// The tag row under a note's box (docs/API.md, Tags on the phone and the
// web; Jamie, 2026-10-29: "Pinned tags are good and then also augmented with
// frequently used RECENT tags"): the pinned tags, then the ones used most in
// the last 30 days, each by its name as last written, a tap that adds it to
// the note's tags or takes it off again, and "All tags" for every other one.
// "Pin tags" turns the row into the pins themselves, at most 12, the same on
// every device and through every API token, kept by name (2026-11-08).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { tagRowQuery, tagsQuery } from '../lib/queries.ts';
import { named, type Tag } from '../lib/tags.ts';
import type { TagRow as Row } from '../lib/types.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { Icon } from './icon.tsx';

// Pinning and unpinning, for the row and Search's tags. The whole list goes
// up, by name, and the answer is the new row; nothing is sent before the row
// is read, so a tap never drops the pins it hasn't seen.
export function usePins() {
  const client = useQueryClient();
  const row = useQuery(tagRowQuery);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const pinned = named(row.data?.pinned, row.data?.pinned_names);
  const toggle = (tag: Tag, from: HTMLElement) =>
    run(async () => {
      if (!row.data) return;
      problem.clear();
      const next = pinned.some((t) => t.key === tag.key) ? pinned.filter((t) => t.key !== tag.key) : [...pinned, tag];
      const r = await api<Row>('PUT', '/api/tag-row', { pinned: next.map((t) => t.name) });
      if (!r.ok) return problem.show(r.data, from);
      client.setQueryData(tagRowQuery.queryKey, r.data);
    });
  const recent: Tag[] = (row.data?.recent ?? []).map((r) => ({ key: r.tag, name: r.name || r.tag }));
  return { ready: !!row.data, pinned, recent, toggle, busy, problem };
}

// The names a tags field offers as one is typed: the pinned and recent ones,
// and every tag once Search or the row has read them all (never read for this).
export function useTagNames(): string[] {
  const pins = usePins();
  const every = useQuery({ ...tagsQuery, enabled: false });
  return [
    ...new Set([...pins.pinned, ...pins.recent].map((t) => t.name).concat((every.data?.tags ?? []).map((t) => t.name)))
  ];
}

// One tag as a pin: pressed when pinned.
export function PinButton({ tag, pins }: { tag: Tag; pins: ReturnType<typeof usePins> }) {
  const on = pins.pinned.some((t) => t.key === tag.key);
  return (
    <button
      type="button"
      className="quiet"
      aria-pressed={on}
      disabled={pins.busy || !pins.ready}
      onClick={(e) => pins.toggle(tag, e.currentTarget)}
    >
      {on && <Icon name="pin" />}
      <span dir="auto">{tag.name}</span>
    </button>
  );
}

interface Props {
  // the note's tags now, from its field and its #words
  chips: readonly Tag[];
  onToggle: (tag: Tag) => void;
  // while the note is being saved its tags can't change
  disabled: boolean;
}

export function TagRow({ chips, onToggle, disabled }: Props) {
  const pins = usePins();
  const [all, setAll] = useState(false);
  const [pinning, setPinning] = useState(false);
  const first = [...pins.pinned, ...pins.recent];
  // Every tag, once asked for, or to see whether there are any at all when
  // nothing is pinned or recent.
  const every = useQuery({ ...tagsQuery, enabled: pins.ready && (all || pinning || !first.length) });
  const rest = (every.data?.tags ?? [])
    .map((t) => ({ key: t.tag, name: t.name || t.tag }))
    .filter((t) => !first.some((f) => f.key === t.key));
  if (!pins.ready || (!first.length && !rest.length)) return null;
  const shown = all || pinning ? [...first, ...rest] : first;
  const on = new Set(chips.map((t) => t.key));

  return (
    <div className="tag-picks" role="group" aria-label={pinning ? 'Pin tags' : 'Your tags'}>
      <ul className="tags">
        {shown.map((tag) => (
          <li key={tag.key}>
            {pinning ? (
              <PinButton tag={tag} pins={pins} />
            ) : (
              <button
                type="button"
                className="quiet"
                aria-pressed={on.has(tag.key)}
                disabled={disabled}
                onClick={() => onToggle(tag)}
              >
                <span dir="auto">{tag.name}</span>
              </button>
            )}
          </li>
        ))}
      </ul>
      {/* Until every tag has been read, there may be more. */}
      {(!every.data || !!rest.length) && !pinning && (
        <button type="button" className="quiet more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Fewer tags' : 'All tags'}
        </button>
      )}
      <button
        type="button"
        className="quiet more"
        onClick={() => {
          pins.problem.clear();
          setPinning(!pinning);
        }}
      >
        <Icon name="pin" /> {pinning ? 'Done pinning' : 'Pin tags'}
      </button>
      {/* Only while there is one: the note's own error line is the form's. */}
      {pins.problem.line && <ErrorLine line={pins.problem.line} />}
    </div>
  );
}
