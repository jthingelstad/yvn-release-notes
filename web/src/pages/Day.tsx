// Any day from the birthday to today (?d=, yesterday when none): its notes
// first, then the form to add one.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState, type RefObject } from 'react';
import {
  AppLink,
  Bar,
  Crumb,
  Digits,
  Failed,
  Loading,
  useFocusLater,
  useTitle,
  WeatherCredit
} from '../components/common.tsx';
import { Icon } from '../components/icon.tsx';
import { NoteForm } from '../components/noteform.tsx';
import { NoteList } from '../components/notelist.tsx';
import { DayWhere } from '../components/where.tsx';
import { addDays, dayName, listed, shortDay, thisYearOf } from '../lib/format.ts';
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
      <Crumb href="/timeline/">Archive</Crumb>
      {(me.isPending || day.isPending) && !me.isError && <Loading />}
      {(me.isError || day.isError) && <Failed />}
      {p && d && (
        <div id="day">
          <DayNav p={p} current={d.date} />
          <h1 className="vnum huge tight" id="v">
            <Digits v={d.version} named />
          </h1>
          <p className="weather" id="weather" hidden={!d.weather}>
            {d.weather}
          </p>
          <DayWhere key={d.date} day={d.date} where={d.where} />
          <section className="saved-notes" aria-labelledby="notes-head" hidden={!d.notes.length}>
            <h2 className="big notes-head" id="notes-head">
              Notes
            </h2>
            <NoteList day={d.date} notes={d.notes} tz={d.tz} version={d.version} />
            {d.collected && (
              <p className="hint collected-here" id="collected-here">
                Collected here: <AppLink href="/badges/">{listed(d.collected)}</AppLink>.
              </p>
            )}
          </section>
          <p className="hint" id="none" hidden={d.notes.length > 0}>
            No notes for this release yet.
          </p>
          <section className="writing" aria-labelledby="add-head">
            <h2 className="big notes-head" id="add-head">
              Add to{' '}
              <span className="vnum inline" id="for-v">
                <Digits v={d.version} />
              </span>
            </h2>
            <NoteForm
              key={d.date}
              day={d.date}
              label={`Add to ${d.version}`}
              placeholder="What happened that day"
              submit="Save note"
            />
          </section>
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

// The day's date between the days either side (by date: their versions
// aren't known here), from the birthday to today, and a calendar to pick
// any other.
function DayNav({ p, current }: { p: Me; current: string }) {
  const thisYear = thisYearOf(p.today);
  const prev = addDays(current, -1);
  const next = addDays(current, 1);
  const href = (iso: string) => (iso === p.today ? '/today/' : `/day/?d=${iso}`);
  const [picking, setPicking] = useState(false);
  const focusLater = useFocusLater();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="day-nav" id="nearby">
        {prev >= p.birthday ? (
          <AppLink
            className="quiet icon-button"
            href={href(prev)}
            rel="prev"
            aria-label={`The day before, ${shortDay(prev, thisYear)}`}
            title={shortDay(prev, thisYear)}
          >
            <Icon name="prev" />
          </AppLink>
        ) : (
          <span className="icon-gap" />
        )}
        <p className="dateline" id="date">
          {dayName(current, thisYear)}
        </p>
        {next <= p.today && (
          <AppLink
            className="quiet icon-button"
            href={href(next)}
            rel="next"
            aria-label={`The day after, ${shortDay(next, thisYear)}`}
            title={shortDay(next, thisYear)}
          >
            <Icon name="next" />
          </AppLink>
        )}
        <button
          className="quiet icon-button pick-toggle"
          type="button"
          aria-label="Pick a day"
          title="Pick a day"
          aria-expanded={picking}
          aria-controls="pick-day"
          onClick={() => {
            setPicking(!picking);
            focusLater(() => input.current);
          }}
        >
          <Icon name="calendar" />
        </button>
      </div>
      <DayPicker p={p} current={current} hidden={!picking} input={input} />
    </>
  );
}

function DayPicker({
  p,
  current,
  hidden,
  input
}: {
  p: Me;
  current: string;
  hidden: boolean;
  input: RefObject<HTMLInputElement | null>;
}) {
  const navigate = useNavigate();
  return (
    <label className="pick-day" id="pick-day" hidden={hidden}>
      Which day?
      <input
        ref={input}
        type="date"
        name="day"
        id="pick"
        min={p.birthday}
        max={p.today}
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          if (!v || v < p.birthday || v > p.today) return;
          navigate({ to: '/day/', search: { d: v } });
        }}
      />
    </label>
  );
}
