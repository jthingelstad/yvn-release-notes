// The fifth place: what writing has earned, what happened in the account,
// and how it is set up. Signing out is here on a phone, where the rail's
// button is not.
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { AppLink, Bar, Digits, RailSignOut, useTitle } from '../components/common.tsx';
import { Icon, type IconName } from '../components/icon.tsx';
import { clock, count } from '../lib/format.ts';
import { badgesQuery, meQuery } from '../lib/queries.ts';
import type { Me } from '../lib/types.ts';

export function You() {
  useTitle('You');
  // The gate has the profile already; "Show badges" off drops the row.
  const me = useQuery(meQuery).data;
  const shown = me?.badges !== false;
  return (
    <>
      <Bar />
      <h1>You</h1>
      <p className="lede">What you’ve earned, what happened, and how it’s set up.</p>
      {me && !me.new && <Status p={me} />}
      <ul className="you-places">
        {shown && <BadgesRow />}
        <Row href="/activity/" id="you-activity" icon="activity" name="Activity">
          Every note, email, change and assistant read, newest first
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

// How many once they are counted; they are read after the page shows.
function BadgesRow() {
  const n = useQuery(badgesQuery).data?.count;
  return (
    <Row href="/badges/" id="you-badges" icon="badges" name="Badges">
      {n ? `${count(n, 'badge', 'badges')} so far` : 'What writing regularly has earned'}
    </Row>
  );
}
