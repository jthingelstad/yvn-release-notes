// What a signed-in page's bar adds (docs/BADGES.md, "Welcome back"):
// badges earned and not yet told, at the top of the first page of a visit,
// and in the rail a Supporting Member's mark above Sign out.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api.ts';
import { meQuery, newBadgesQuery } from '../lib/queries.ts';
import { AppLink } from './common.tsx';
import { BadgeIcon } from './icon.tsx';
import type { NewBadges as Untold } from '../lib/types.ts';
import { NONPROFITS } from '../../../packages/domain/giving.ts';

// At most this many named, the rest a count.
const SHOWN = 3;
// The answers this tab has marked told, so a page drawn again posts nothing.
// By answer, not badge: signing out clears the cache, so the next account
// in this tab gets an answer of its own, and marks its own.
const told = new WeakSet<Untold>();

// Jamie, 2026-10-25: "when you come to the website and there is a badge
// since your last visit that should get special attention!" Shown once:
// it is marked seen as it shows, so the email doesn't tell it again, and it
// stays from page to page until it is closed or its page is opened, or
// "Show badges" is turned off (read once a visit, so the profile says when).
export function NewBadges() {
  const client = useQueryClient();
  const q = useQuery(newBadgesQuery);
  const shown = useQuery(meQuery).data?.badges !== false;
  const answer = q.data;
  const news = shown ? (answer?.badges ?? []) : [];
  useEffect(() => {
    if (!answer?.keys.length || told.has(answer)) return;
    told.add(answer);
    // A failed write only means hearing of it again next visit.
    void api('POST', '/api/badges/seen', { keys: answer.keys }).catch(() => undefined);
  }, [answer]);
  if (!news.length) return null;
  const close = () => client.setQueryData(newBadgesQuery.queryKey, { badges: [], keys: [] });
  const more = news.length - SHOWN;
  return (
    <div
      className="welcome"
      id="welcome-badges"
      role="status"
      aria-label={news.length === 1 ? 'New badge' : 'New badges'}
    >
      <p className="kicker">New since your last visit</p>
      <ul className="welcome-list">
        {news.slice(0, SHOWN).map((b) => (
          <li key={b.key}>
            <span className="stamp-in">
              <BadgeIcon id={b.id} />
            </span>
            <span>
              <strong>{b.name}</strong>, <span className="stamp">{b.version}</span>
              <span className="welcome-why">{b.line}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="welcome-links">
        {more > 0 && <>And {more} more. </>}
        <AppLink href="/badges/" onClick={close}>
          See your badges
        </AppLink>
        <button className="quiet" type="button" onClick={close}>
          Close
        </button>
      </p>
    </div>
  );
}

// A Supporting Member's mark in the rail (Jamie, 2026-10-25: "a permanent
// ribbon or affect of some sort in the left hand rail ... floating above
// Logout that says 'Supporting Member'"), naming where this year's
// membership goes. The rail's alone: a phone's bar has no room for it.
export function RailMember() {
  const me = useQuery(meQuery).data;
  if (!me || me.new || me.weekly_thing !== 'member') return null;
  const to = NONPROFITS[Number(me.today.slice(0, 4))];
  return (
    <AppLink className="rail-member" href="/badges/" id="rail-member">
      <BadgeIcon id="giving" />
      <span>
        Supporting Member
        {to && <span className="rail-member-to">Giving to {to.short}</span>}
      </span>
    </AppLink>
  );
}
