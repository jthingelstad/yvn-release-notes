// Any day from the birthday to today (?d=, yesterday when none), its notes
// and the form to add one.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AppLink, Bar, Digits, Failed, Loading, useTitle, WeatherCredit } from '../components/common.tsx';
import { NoteForm } from '../components/noteform.tsx';
import { NoteList } from '../components/notelist.tsx';
import { addDays, dayName, shortDay, thisYearOf } from '../lib/format.ts';
import { useMe, useQueryParam } from '../lib/nav.ts';
import { dayQuery, pickDay } from '../lib/queries.ts';
import type { Me } from '../lib/types.ts';

export function Day() {
  useTitle('Another day');
  const me = useMe();
  const asked = useQueryParam('d');
  const p = me.data && !me.data.new ? me.data : null;
  const current = p ? pickDay(asked, p) : null;
  // The day on show stays while the next one loads.
  const day = useQuery({ ...dayQuery(current), placeholderData: keepPreviousData });
  const d = day.data;

  return (
    <>
      <Bar />
      <DayPicker p={p} current={current} />
      {(me.isPending || day.isPending) && !me.isError && <Loading />}
      {(me.isError || day.isError) && <Failed />}
      {p && d && (
        <div id="day">
          <p className="dateline" id="date">
            {dayName(d.date, thisYearOf(p.today))}
          </p>
          <h1 className="vnum big tight" id="v">
            <Digits v={d.version} named />
          </h1>
          <p className="weather" id="weather" hidden={!d.weather}>
            {d.weather}
          </p>
          <NoteList day={d.date} notes={d.notes} tz={d.tz} version={d.version} />
          <p className="hint" id="none" hidden={d.notes.length > 0}>
            No notes for this release yet.
          </p>
          <NoteForm
            key={d.date}
            day={d.date}
            label={
              <>
                Release notes for{' '}
                <span className="vnum inline" id="for-v">
                  <Digits v={d.version} />
                </span>
              </>
            }
            placeholder="What happened that day"
            submit={
              <>
                Save to <span id="save-v">{d.version}</span>
              </>
            }
          />
          <Nearby p={p} current={d.date} />
        </div>
      )}

      <p className="foot">
        Any day from your birthday to today. Days before you signed up count too, all the way back to{' '}
        <span className="mono">0.0.0</span>. A day you fill in later counts toward your streak.
        <span id="weather-credit" hidden={!d?.weather}>
          <WeatherCredit />
        </span>
      </p>
    </>
  );
}

function DayPicker({ p, current }: { p: Me | null; current: string | null }) {
  const navigate = useNavigate();
  return (
    <label className="pick-day">
      Which day?
      <input
        type="date"
        name="day"
        id="pick"
        min={p?.birthday}
        max={p?.today}
        value={current || ''}
        onChange={(e) => {
          const v = e.target.value;
          if (!p || !v || v < p.birthday || v > p.today) return;
          navigate({ to: '/day/', search: { d: v } });
        }}
      />
    </label>
  );
}

// The days either side, by date (their versions aren't known here), from
// the birthday to today.
function Nearby({ p, current }: { p: Me; current: string }) {
  const thisYear = thisYearOf(p.today);
  const prev = addDays(current, -1);
  const next = addDays(current, 1);
  const href = (iso: string) => (iso === p.today ? '/today/' : `/day/?d=${iso}`);
  const hasPrev = prev >= p.birthday;
  const hasNext = next <= p.today;
  return (
    <nav className="hint nearby" id="nearby" aria-label="Nearby days" hidden={!hasPrev && !hasNext}>
      {hasPrev && (
        <AppLink href={href(prev)} rel="prev">
          ← {shortDay(prev, thisYear)}
        </AppLink>
      )}
      {hasPrev && hasNext && ' · '}
      {hasNext && (
        <AppLink href={href(next)} rel="next">
          {shortDay(next, thisYear)} →
        </AppLink>
      )}
    </nav>
  );
}
