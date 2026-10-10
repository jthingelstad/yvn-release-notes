// Days in a list, and the streak line.
import { dayName, thisYearOf } from '../lib/format.ts';
import type { Day, Streak } from '../lib/types.ts';
import { AppLink, Digits } from './common.tsx';
import { NoteBody, NoteMedia, NoteMeta } from './notes.tsx';

export const dayHref = (date: string, today: string) => (date === today ? '/today/' : `/day/?d=${date}`);

// Days newest first, each with its number and its notes, for a tag or a
// search (`mark` shows what the search found).
export function DayList({
  data,
  mark,
  id
}: {
  data: { today: string; tz: string; days: Day[] };
  mark?: RegExp | null;
  id: string;
}) {
  const thisYear = thisYearOf(data.today);
  return (
    <div className="days" id={id}>
      {data.days.map((d) => (
        <section className="tday" key={d.date}>
          <AppLink className="tday-head" href={dayHref(d.date, data.today)}>
            <span className="vnum small">
              <Digits v={d.version} named />
            </span>
            <span className="when">{dayName(d.date, thisYear)}</span>
          </AppLink>
          {d.notes.map((n) => (
            <NoteParts key={n.id} day={d} n={n} tz={data.tz} mark={mark} />
          ))}
        </section>
      ))}
    </div>
  );
}

function NoteParts({ day, n, tz, mark }: { day: Day; n: Day['notes'][number]; tz: string; mark?: RegExp | null }) {
  return (
    <>
      <NoteBody n={n} mark={mark} />
      <NoteMedia day={day.date} n={n} version={day.version} mark={mark} />
      <NoteMeta n={n} tz={tz} cls="count" />
    </>
  );
}

const days = (n: number) => (n === 1 ? '1 day' : `${n} days`);

export function StreakLine({ s }: { s: Streak }) {
  let head: string;
  let tail = '';
  if (!s.current) {
    head = 'Every note starts a streak.';
    if (s.longest) tail = `Your longest is ${days(s.longest)}.`;
  } else if (s.current >= s.longest && s.current > 1 && s.today) {
    head = `${days(s.current)} in a row, your longest yet.`;
  } else {
    head = `${days(s.current)} in a row.`;
    if (s.longest > s.current) tail = `Your longest is ${days(s.longest)}.`;
    if (!s.today) tail = (tail ? tail + ' ' : '') + `A note today makes it ${s.current + 1}.`;
  }
  return (
    <p className="streak" id="streak">
      <strong>{head}</strong>
      {tail && (
        <>
          {' '}
          <span className="aside">{tail}</span>
        </>
      )}
    </p>
  );
}
