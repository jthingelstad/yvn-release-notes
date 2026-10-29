// Developer mode (docs/BADGES.md, Easter eggs): Today's number is a button
// that looks exactly like the number. Seven taps in a row (Enter and Space
// count) turn it on, kept in this browser; from the fourth, a polite live
// region under the number counts down. The panel under the number is type on
// paper, in mono: the version in hex, binary and Roman numerals, uptime since
// the birthday, how far through today's patch, and `git log --oneline` of
// the last ten days with notes, from the days the Archive already reads.
// The first turn on posts the egg; its answer may carry the unlock line, and
// a failure changes nothing. The note words shown are the owner's own, here
// on their own page, and are never logged.
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import {
  binary,
  developer,
  hex,
  noTaps,
  patchDone,
  romanVersion,
  shortHash,
  subject,
  tap,
  uptime,
  type Taps
} from '../lib/developer.ts';
import { daysQuery } from '../lib/queries.ts';
import type { Unlocked } from '../lib/types.ts';
import { Digits } from './common.tsx';
import { UnlockLine } from './unlock.tsx';

export function VersionTap({
  version,
  today,
  birthday,
  tz
}: {
  version: string;
  today: string;
  birthday?: string;
  tz: string;
}) {
  const [on, setOn] = useState(developer.get);
  const taps = useRef<Taps>(noTaps(on));
  const [say, setSay] = useState('');
  const [won, setWon] = useState<Unlocked[]>([]);
  const client = useQueryClient();

  const press = () => {
    const { next, say: line, turnedOn } = tap({ ...taps.current, on }, Date.now());
    taps.current = next;
    setSay(line);
    if (!turnedOn) return;
    setOn(true);
    developer.set(true);
    // Found: the server keeps it once and answers any unlock. Never waited on.
    void api<{ unlocked?: Unlocked[] }>('POST', '/api/eggs', { egg: 'developer' }).then((r) => {
      if (r.ok && r.data.unlocked?.length) {
        setWon(r.data.unlocked);
        void client.invalidateQueries({ queryKey: ['badges'] });
      }
    });
  };

  const leave = () => {
    developer.set(false);
    taps.current = noTaps();
    setOn(false);
    setSay('');
    setWon([]);
  };

  return (
    <>
      <h1 className="vnum huge tight" id="v">
        <button type="button" className="vnum-tap" id="v-tap" onClick={press}>
          <Digits v={version} named />
        </button>
      </h1>
      <p className="hint dev-say" id="dev-say" role="status" aria-live="polite">
        {say}
      </p>
      {on && <Panel version={version} today={today} birthday={birthday} tz={tz} onLeave={leave} />}
      <UnlockLine items={won} id="dev-unlock" />
    </>
  );
}

// Ticks once a second while shown.
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const LOG_LINES = 10;
// How many pages of days to read for ten with notes, at most.
const LOG_PAGES = 4;

function Panel({
  version,
  today,
  birthday,
  tz,
  onLeave
}: {
  version: string;
  today: string;
  birthday?: string;
  tz: string;
  onLeave: () => void;
}) {
  const now = useNow();
  const days = useInfiniteQuery(daysQuery);
  const pages = days.data?.pages ?? [];
  const withNotes = pages.flatMap((p) => p.days).filter((d) => d.notes.length > 0);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = days;
  useEffect(() => {
    if (withNotes.length < LOG_LINES && hasNextPage && !isFetchingNextPage && pages.length < LOG_PAGES)
      void fetchNextPage();
  }, [withNotes.length, hasNextPage, isFetchingNextPage, pages.length, fetchNextPage]);
  const log = withNotes.slice(0, LOG_LINES).map((d) => ({
    hash: shortHash(d.notes[0]!.id),
    version: d.version,
    words: subject(d.notes.map((n) => n.text).join(' '))
  }));

  return (
    <section className="dev-panel" id="dev-panel" aria-label="Developer mode">
      <dl className="dev-facts">
        <dt>hex</dt>
        <dd id="dev-hex">{hex(version)}</dd>
        <dt>binary</dt>
        <dd id="dev-binary">{binary(version)}</dd>
        <dt>roman</dt>
        <dd id="dev-roman">{romanVersion(version)}</dd>
        <dt>uptime</dt>
        <dd id="dev-uptime">{birthday ? `${uptime(birthday, tz, now).toLocaleString('en-US')} s` : '…'}</dd>
        <dt>patch</dt>
        <dd id="dev-patch">
          {patchDone(today, tz, now).toFixed(3)}% of {version}
        </dd>
      </dl>
      <p className="dev-prompt">$ git log --oneline</p>
      {log.length ? (
        <ol className="dev-log" id="dev-log">
          {log.map((l) => (
            <li key={l.hash + l.version}>
              <span className="dev-hash">{l.hash}</span> {l.version} {l.words}
            </li>
          ))}
        </ol>
      ) : (
        <p className="dev-log" id="dev-log">
          {days.isPending ? '…' : 'fatal: your current branch has no commits yet'}
        </p>
      )}
      <button type="button" className="quiet" id="dev-leave" onClick={onLeave}>
        Leave developer mode
      </button>
    </section>
  );
}
