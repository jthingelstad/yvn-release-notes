// Under today's notes, what the morning email's On this day shows: the same
// day of each earlier release. It is read after the page shows, so it never
// holds it up, and with nothing to show there is no section.
import { useQuery } from '@tanstack/react-query';
import { dayName } from '../lib/format.ts';
import { onThisDayQuery } from '../lib/queries.ts';
import { AppLink } from './common.tsx';
import { NoteBody, NoteMedia, NoteMeta } from './notes.tsx';

/** The notes a day shows here; its own page has the rest. */
const NOTES = 5;

const ago = (years: number) => (years === 1 ? 'A year ago' : `${years} years ago`);

export function OnThisDay() {
  const past = useQuery(onThisDayQuery).data;
  if (!past?.days.length) return null;
  return (
    <section className="on-this-day" aria-labelledby="past-head">
      <h2 className="big notes-head" id="past-head">
        On this day
      </h2>
      {past.days.map((d) => {
        const left = d.notes.length - NOTES;
        return (
          <article key={d.date}>
            <h3>
              <AppLink href={`/day/?d=${d.date}`}>
                {ago(d.years)} you were <span className="mono">{d.version}</span>
              </AppLink>
            </h3>
            <p className="hint">{dayName(d.date)}</p>
            {d.notes.slice(0, NOTES).map((n) => (
              <div className="note" key={n.id}>
                <NoteBody n={n} />
                <NoteMedia day={d.date} n={n} version={d.version} small />
                <NoteMeta n={n} day={d.date} tz={past.tz} cls="count" />
              </div>
            ))}
            {left > 0 && (
              <p className="hint">
                <AppLink href={`/day/?d=${d.date}`}>{left === 1 ? 'One more note' : `${left} more notes`}</AppLink>
              </p>
            )}
          </article>
        );
      })}
      {past.more.length > 0 && (
        <p className="hint">
          And{' '}
          {past.more.map((d, i) => (
            <span key={d}>
              {i > 0 && ', '}
              <AppLink href={`/day/?d=${d}`}>{d.slice(0, 4)}</AppLink>
            </span>
          ))}
          .
        </p>
      )}
    </section>
  );
}
