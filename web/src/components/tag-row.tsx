// The tag row under a note's box (docs/API.md, Tags on the phone and the
// web; Jamie, 2026-10-29: "Pinned tags are good and then also augmented with
// frequently used RECENT tags"): the pinned tags, then the ones used most in
// the last 30 days, each a tap that writes its hashtag at the end of the note
// or takes it out again, and "All tags" for every other one. "Pin tags" turns
// the row into the pins themselves, at most 12, the same on every device and
// through every API token. The note's text stays the one place a tag lives:
// the row only types it.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { tagRowQuery, tagsQuery } from '../lib/queries.ts';
import type { TagRow as Row } from '../lib/types.ts';
import { spans, togglingTag } from '../../../packages/domain/tags.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { Icon } from './icon.tsx';

// Pinning and unpinning, for the row and Search's tags. The whole list goes
// up and the answer is the new row; nothing is sent before the row is read,
// so a tap never drops the pins it hasn't seen.
export function usePins() {
  const client = useQueryClient();
  const row = useQuery(tagRowQuery);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const pinned = row.data?.pinned ?? [];
  const toggle = (tag: string, from: HTMLElement) =>
    run(async () => {
      if (!row.data) return;
      problem.clear();
      const next = pinned.includes(tag) ? pinned.filter((t) => t !== tag) : [...pinned, tag];
      const r = await api<Row>('PUT', '/api/tag-row', { pinned: next });
      if (!r.ok) return problem.show(r.data, from);
      client.setQueryData(tagRowQuery.queryKey, r.data);
    });
  return { ready: !!row.data, pinned, recent: row.data?.recent ?? [], toggle, busy, problem };
}

// One tag as a pin: pressed when pinned.
export function PinButton({ tag, pins }: { tag: string; pins: ReturnType<typeof usePins> }) {
  const on = pins.pinned.includes(tag);
  return (
    <button
      type="button"
      className="quiet"
      aria-pressed={on}
      disabled={pins.busy || !pins.ready}
      onClick={(e) => pins.toggle(tag, e.currentTarget)}
    >
      {on && <Icon name="pin" />}#{tag}
    </button>
  );
}

interface Props {
  text: string;
  onText: (next: string) => void;
  // while the note is being saved its words can't change
  disabled: boolean;
}

export function TagRow({ text, onText, disabled }: Props) {
  const pins = usePins();
  const [all, setAll] = useState(false);
  const [pinning, setPinning] = useState(false);
  const first = [...pins.pinned, ...pins.recent.map((r) => r.tag)];
  // Every tag, once asked for, or to see whether there are any at all when
  // nothing is pinned or recent.
  const every = useQuery({ ...tagsQuery, enabled: pins.ready && (all || pinning || !first.length) });
  const rest = (every.data?.tags ?? []).map((t) => t.tag).filter((t) => !first.includes(t));
  if (!pins.ready || (!first.length && !rest.length)) return null;
  const shown = all || pinning ? [...first, ...rest] : first;
  const written = new Set(spans(text).map(([, , tag]) => tag));

  return (
    <div className="tag-picks" role="group" aria-label={pinning ? 'Pin tags' : 'Tags for this note'}>
      <ul className="tags">
        {shown.map((tag) => (
          <li key={tag}>
            {pinning ? (
              <PinButton tag={tag} pins={pins} />
            ) : (
              <button
                type="button"
                className="quiet"
                aria-pressed={written.has(tag)}
                disabled={disabled}
                onClick={() => onText(togglingTag(text, tag))}
              >
                #{tag}
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
