// Badges (docs/BADGES.md): what writing regularly has earned, each stamped
// with the version it came true on. This release first, since it renews
// every birthday, then the tracks, everything collected, and what is still
// to find. Never a miss: no special day that went by without a note, no
// count out of a total, no tier that can no longer be reached.
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Bar, Crumb, Failed, Loading, useTitle } from '../components/common.tsx';
import { BadgeIcon } from '../components/icon.tsx';
import { count, dayName, shortDay, thisYearOf } from '../lib/format.ts';
import { badgesQuery } from '../lib/queries.ts';
import { MEMBERS_URL } from '../lib/weekly-thing.ts';
import type { Badges as BadgesData } from '../lib/types.ts';
import type { AlbumDay, Track } from '../../../packages/domain/badges.ts';

export function Badges() {
  useTitle('Badges');
  const badges = useQuery(badgesQuery);
  const b = badges.data;
  return (
    <>
      <Bar />
      <Crumb href="/you/">You</Crumb>
      <h1>Badges</h1>
      {badges.isPending && <Loading />}
      {badges.isError && !b && <Failed />}
      {b && <Shelf b={b} />}
    </>
  );
}

function Shelf({ b }: { b: BadgesData }) {
  const latest = b.earned[0];
  const thisYear = thisYearOf(b.today);
  const r = b.release;
  const shown = b.earned.filter((e) => e.shelf !== 'track');
  return (
    <>
      <p className="lede" id="badges-lede">
        {latest ? (
          <>
            {count(b.count, 'badge', 'badges')}, each stamped with the version you earned it on. Latest:{' '}
            <strong>{latest.name}</strong>, <Stamp v={latest.version} />.
          </>
        ) : (
          <>Each badge is stamped with the version you earn it on. Your first note earns one.</>
        )}
      </p>

      <section className="b-section" aria-labelledby="release-head">
        <p className="kicker">This release · {r.v}</p>
        <h2 className="big" id="release-head">
          Coming up
        </h2>
        <p className="release-line" id="coverage">
          {count(r.days, 'day', 'days')} with notes in {r.v} so far
          {r.level && <>, coverage {r.level}</>}.{' '}
          {r.next ? (
            <>
              {upper(r.next.level)} at {r.next.at} days: {r.next.more} more.
            </>
          ) : (
            <>
              Coverage starts fresh with {r.following.v} on {dayName(r.following.date, thisYear)}.
            </>
          )}
        </p>
        {r.ahead.length > 0 && <Album days={r.ahead} thisYear={thisYear} label="Ahead" id="ahead" />}
        {r.collected.length > 0 && (
          <Album days={r.collected} thisYear={thisYear} label={`Collected in ${r.v}`} id="album" stamped />
        )}
        <p className="meta spaced">Some special days are secret. You find them by writing on them.</p>
      </section>

      <section className="b-section" aria-labelledby="tracks-head">
        <h2 className="big" id="tracks-head">
          Tracks
        </h2>
        <div className="tracks" id="tracks">
          {b.tracks.map((t) => (
            <TrackRow key={t.id} t={t} />
          ))}
        </div>
      </section>

      <section className="b-section" aria-labelledby="collected-head">
        <h2 className="big" id="collected-head">
          Collected
        </h2>
        {shown.length ? (
          <ul className="badges" id="collected">
            {shown.map((e) => (
              <li className="badge" key={e.key}>
                <Glyph id={e.id} />
                <span className="name">
                  {e.name} <Stamp v={e.version} />
                </span>
                <p>{e.line}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint">Nothing yet. Your first note earns Hello, world.</p>
        )}
      </section>

      {b.missing.length > 0 && (
        <section className="b-section" aria-labelledby="missing-head">
          <h2 className="big" id="missing-head">
            Still to find
          </h2>
          <ul className="badges" id="missing">
            {b.missing.map((m, i) => (
              <li className="badge locked" key={m.id || `secret-${i}`}>
                <Glyph id={m.id} locked />
                <span className="name">{m.name || 'Secret'}</span>
                <p>
                  {m.hint}
                  {m.shelf === 'giving' && (
                    <>
                      {' '}
                      <a href={MEMBERS_URL}>About membership</a>.
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

// A badge's glyph on a disc: filled once earned, an outline until then.
function Glyph({ id, locked = false }: { id?: string; locked?: boolean }) {
  return (
    <span className={locked ? 'glyph locked' : 'glyph'}>
      <BadgeIcon id={id} />
    </span>
  );
}

// A version a badge is stamped with.
function Stamp({ v }: { v: string }) {
  return <span className="stamp">{v}</span>;
}

function Album({
  days,
  thisYear,
  label,
  id,
  stamped = false
}: {
  days: AlbumDay[];
  thisYear: number;
  label: string;
  id: string;
  stamped?: boolean;
}) {
  return (
    <>
      <h3 className="kicker album-head" id={`${id}-head`}>
        {label}
      </h3>
      <ul className="ahead" id={id} aria-labelledby={`${id}-head`}>
        {days.map((d) => (
          <li key={d.day} className={stamped ? 'on' : undefined}>
            <span className="v">{d.version}</span>
            <span className="when">{shortDay(d.day, thisYear)}</span>
            <span className="what">{d.names.join(', ')}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

// "rc" stays as release engineering writes it; the rest start a sentence.
const upper = (level: string) => (/^[a-z]{3,}$/.test(level) ? level[0]!.toUpperCase() + level.slice(1) : level);

function TrackRow({ t }: { t: Track }) {
  let best: ReactNode, now: ReactNode;
  const since = t.since && (
    <>
      , {t.level} since <Stamp v={t.since.version} />
    </>
  );
  const next = t.next ? ` ${upper(t.next.level)} at ${t.next.at.toLocaleString('en-US')}.` : '';
  if (t.id === 'delivery') {
    best = t.best ? (
      <>
        Best: <strong>{count(t.best, 'day', 'days')} in a row</strong>
        {since}.
      </>
    ) : (
      'Days in a row with a note.'
    );
    now = `Now ${t.now}.${next}`;
  } else if (t.id === 'cadence') {
    best = (
      <>
        Weeks with notes on four days or more.
        {t.best > 0 && (
          <>
            {' '}
            Best: <strong>{count(t.best, 'week', 'weeks')}</strong>
            {since}.
          </>
        )}
      </>
    );
    now = `Now ${t.now}.${next}`;
  } else if (t.id === 'patches') {
    best = (
      <>
        <strong>{count(t.best, 'day', 'days')}</strong> with notes{since}.
      </>
    );
    now = t.next ? `${upper(t.next.level)} at ${t.next.at.toLocaleString('en-US')}: ${t.next.at - t.best} to go.` : '';
  } else {
    best = t.best ? (
      <>
        Best: <strong>{t.release}</strong>, with notes on {t.best}% of its days{since}.
      </>
    ) : (
      'Days with notes, as a share of one release.'
    );
    now = 'Each release earns its own.';
  }
  return (
    <div className="track" id={`track-${t.id}`}>
      <Glyph id={t.id} locked={!t.tier} />
      <p className="track-head">
        <span className="track-name">{t.name}</span>
        <span className="tiers" role="img" aria-label={`${t.tier} of 5 tiers`}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={i < t.tier ? 'on' : ''} />
          ))}
        </span>
        {t.level && <span className="tier">{t.level}</span>}
      </p>
      <p>{best}</p>
      {now && <p>{now}</p>}
    </div>
  );
}
