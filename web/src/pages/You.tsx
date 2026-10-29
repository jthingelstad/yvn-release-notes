// The fifth place: what writing has earned, what happened in the account,
// and how it is set up. Signing out is here on a phone, where the rail's
// button is not.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { AppLink, Bar, Digits, ErrorLine, RailSignOut, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { Avatar } from '../components/avatar.tsx';
import { Icon, type IconName } from '../components/icon.tsx';
import { clock, count } from '../lib/format.ts';
import { badgesQuery, meQuery } from '../lib/queries.ts';
import type { Me } from '../lib/types.ts';
import { MEMBERS_URL, subscribeWeeklyThing } from '../lib/weekly-thing.ts';

export function You() {
  useTitle('You');
  // The gate has the profile already; "Show badges" off drops the row.
  const me = useQuery(meQuery).data;
  const shown = me?.badges !== false;
  return (
    <>
      <Bar />
      <div className="you-head">
        {me?.photo && <Avatar photo={me.photo} className="avatar--you" />}
        <h1>You</h1>
      </div>
      <p className="lede">What you’ve earned, what happened, and how it’s set up.</p>
      {me && !me.new && <Status p={me} />}
      {me && !me.new && <WeeklyThingLine p={me} />}
      <ul className="you-places">
        {shown && <BadgesRow />}
        <Row href="/activity/" id="you-activity" icon="activity" name="Activity">
          Every note, email, change and assistant read, newest first
        </Row>
        <Row href="/feedback/" id="you-feedback" icon="feedback" name="Feedback">
          Tell Jamie what’s wrong, an idea or a question, and read the answers
        </Row>
        <Row href="/settings/" id="you-settings" icon="settings" name="Settings">
          Daily email, writing and search, agents, your account
        </Row>
      </ul>
      <RailSignOut className="quiet you-signout" />
    </>
  );
}

function Row({
  href,
  id,
  icon,
  name,
  children
}: {
  href: string;
  id: string;
  icon: IconName;
  name: string;
  children: ReactNode;
}) {
  return (
    <li>
      <AppLink href={href} id={id}>
        <Icon name={icon} />
        <span>
          <span className="you-name">{name}</span>
          <span className="hint">{children}</span>
        </span>
        <Icon name="next" />
      </AppLink>
    </li>
  );
}

// Where things stand, in one line: today's version, when the email comes
// (or that it is paused or stopped), and the city it is set for.
function Status({ p }: { p: Me }) {
  const email =
    p.status === 'stopped'
      ? 'emails stopped'
      : p.pause && p.pause.from <= p.today
        ? 'emails paused'
        : `email at ${clock(p.send_time)}`;
  return (
    <p className="you-status" id="you-status">
      Version{' '}
      <b>
        <Digits v={p.version} />
      </b>{' '}
      today · {email}
      {p.city && ` · ${p.city}`}
    </p>
  );
}

// Release Notes comes with the Weekly Thing. Supporting Members are thanked,
// and each year they give earns a badge (domain/giving.ts);
// an account made before the gate, or whose address has left the list,
// keeps everything and gets one quiet line offering to add it back (Jamie,
// 2026-10-25: "Keep them"). Nothing shows until the address has been
// looked up.
function WeeklyThingLine({ p }: { p: Me }) {
  const client = useQueryClient();
  const problem = useProblem();
  const [busy, run] = useBusy();
  const button = useRef<HTMLButtonElement>(null);
  if (!p.weekly_thing) return null;
  const subscribe = () =>
    run(async () => {
      problem.clear();
      const r = await subscribeWeeklyThing();
      if (!r.ok) return problem.show(r.data, button.current);
      client.setQueryData(['me'], { ...p, weekly_thing: r.data.weekly_thing });
    });
  return (
    <div className="you-weekly" id="you-weekly" data-standing={p.weekly_thing}>
      <p className="hint">
        {p.weekly_thing === 'member' ? (
          <>
            Weekly Thing Supporting Member. Thank you for giving to this year’s nonprofit: each year you give earns a{' '}
            <AppLink href="/badges/">badge</AppLink>.
          </>
        ) : p.weekly_thing === 'reader' ? (
          <>
            Free with your Weekly Thing subscription. <a href={MEMBERS_URL}>Supporting Members</a> give to a nonprofit
            every year, and each year given earns a <AppLink href="/badges/">badge</AppLink>.
          </>
        ) : p.weekly_thing === 'unconfirmed' ? (
          <>Your Weekly Thing subscription isn’t confirmed yet: look for its email.</>
        ) : (
          <>
            Release Notes comes with the Weekly Thing, and your notes stay yours either way.{' '}
            <button
              className="quiet inline"
              type="button"
              id="you-weekly-subscribe"
              ref={button}
              disabled={busy}
              onClick={subscribe}
            >
              Subscribe this address
            </button>
            , free.
          </>
        )}
      </p>
      <ErrorLine line={problem.line} />
    </div>
  );
}

// How many once they are counted; they are read after the page shows.
function BadgesRow() {
  const n = useQuery(badgesQuery).data?.count;
  return (
    <Row href="/badges/" id="you-badges" icon="badges" name="Badges">
      {n ? `${count(n, 'badge', 'badges')} so far` : 'What writing regularly has earned'}
    </Row>
  );
}
