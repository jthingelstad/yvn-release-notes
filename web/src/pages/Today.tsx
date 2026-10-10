// Today's number, its notes, and the form to add one.
import { useQuery } from '@tanstack/react-query';
import { AppLink, Bar, Digits, Failed, Loading, useTitle } from '../components/common.tsx';
import { StreakLine } from '../components/days.tsx';
import { NoteForm } from '../components/noteform.tsx';
import { NoteList } from '../components/notelist.tsx';
import { writingOut } from '../components/notes.tsx';
import { get } from '../lib/api.ts';
import { dayName } from '../lib/format.ts';
import { useMe } from '../lib/nav.ts';
import type { Me, Today as TodayData } from '../lib/types.ts';

// A recording being written out: look again every 30 seconds, 20 times.
export const POLL = 30000;
export const pollWhileWriting = (q: { state: { data?: { notes: TodayData['notes'] }; dataUpdateCount: number } }) =>
  writingOut(q.state.data?.notes) && q.state.dataUpdateCount <= 20 ? POLL : false;

export function Today() {
  useTitle('Today');
  const today = useQuery({
    queryKey: ['today'],
    queryFn: () => get<TodayData>('/api/today'),
    refetchInterval: pollWhileWriting
  });
  // The address, for the line that stands in for an empty day.
  const me = useMe();
  const t = today.data;

  return (
    <>
      <Bar />
      {today.isPending && <Loading />}
      {today.isError && <Failed />}
      {t && (me.data || me.isError) && <Day t={t} me={me.data} />}
    </>
  );
}

function Day({ t, me }: { t: TodayData; me?: Me }) {
  const [, nm, nd] = t.next.date.split('-').map(Number);
  const on = new Date(2000, nm - 1, nd).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return (
    <div id="day">
      <p className="dateline" id="date">
        {dayName(t.date)}
      </p>
      <h1 className="vnum huge tight" id="v">
        <Digits v={t.version} named />
      </h1>
      <p className="dots" id="dots" aria-hidden="true">
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} className={i < t.dots ? 'on' : ''} />
        ))}
      </p>
      <p className="hint" id="next">
        <span className="mono">{t.next.version}</span> ships {on}.
      </p>
      <p className="hint" id="paused" hidden={!t.paused_through}>
        {t.paused_through && `Emails paused through ${dayName(t.paused_through)}. Notes still count.`}
      </p>

      <h2 className="big notes-head">Today’s release notes</h2>
      <NoteList day={t.date} notes={t.notes} tz={t.tz} version={t.version} />
      <EmptyLine t={t} me={me} />
      <NoteForm key={t.date} day={t.date} label="Add to today" placeholder="Anything about the day" submit="Add note" />

      <StreakLine s={t.streak} />
      <p className="hint">
        <AppLink href="/day/">Add notes for another day</AppLink>
      </p>
    </div>
  );
}

// No notes yet today: one quiet line where they will be. True whether or
// not today's email has gone, which this page can't tell. Someone with no
// notes at all yet also hears where the email comes from.
function EmptyLine({ t, me }: { t: TodayData; me?: Me }) {
  // Paused or stopped, no email comes today; the paused line says so.
  const hidden = t.notes.length > 0 || !!t.paused_through || me?.status === 'stopped' || !me?.email;
  return (
    <p className="hint empty-day" id="empty" hidden={hidden}>
      {!hidden && (
        <>
          Today’s email, for <span className="mono">{t.version}</span>, comes to <strong>{me!.email}</strong>. Reply to
          it, with photos or a voice memo if you like, or write here.
          {!t.streak.longest && !t.streak.current && (
            <>
              {' '}
              Add <strong>notes@yourversionnumber.com</strong> to your contacts so the emails don’t land in junk.
            </>
          )}
        </>
      )}
    </p>
  );
}
