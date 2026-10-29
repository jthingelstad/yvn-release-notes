// The line under a note form when saving it earned something (docs/BADGES.md,
// "The moment you earn one"): the glyph stamps in, then what it was and the
// way to the page. A special day collected again, its badge earned in an
// earlier release, reads "Collected".
import { listed } from '../lib/format.ts';
import type { Unlocked } from '../lib/types.ts';
import { AppLink } from './common.tsx';
import { BadgeIcon } from './icon.tsx';

// `id` sets another where a page has two (Today: the note form's and
// developer mode's).
export function UnlockLine({ items, id = 'unlock' }: { items: Unlocked[]; id?: string }) {
  const first = items[0];
  return (
    <p className="unlock" id={id} role="status" hidden={!first}>
      {first && (
        <>
          {/* Keyed, so the stamp plays again for the next one. */}
          <span className="stamp-in" key={first.key}>
            <BadgeIcon id={first.id} />
          </span>
          {items.some((u) => !u.album) ? 'Unlocked' : 'Collected'}:{' '}
          {items.length === 1 ? (
            <>
              <strong>{first.name}</strong>, <span className="stamp">{first.version}</span>.
            </>
          ) : (
            <>
              <strong>{listed(items.map((u) => u.name))}</strong>.
            </>
          )}{' '}
          <AppLink href="/badges/">See your badges</AppLink>
        </>
      )}
    </p>
  );
}
