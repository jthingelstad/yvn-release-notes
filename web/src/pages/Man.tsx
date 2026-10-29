// RTFM (docs/BADGES.md, Easter eggs): /man/, Release Notes as a Unix man
// page, RELEASE-NOTES(1), type on paper in mono. Anyone may read it, signed
// in or not; like every page but the front one it is noindex (main.tsx).
// Its clues are a comment in index.html and robots.txt and a line on the
// 404 page. Opened signed in, it posts the egg once a visit, and the answer
// may carry the unlock line; signed out it posts nothing. Every line here
// must stay true of the product (AGENTS.md).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { AppLink, Bar, useTitle } from '../components/common.tsx';
import { UnlockLine } from '../components/unlock.tsx';
import { api } from '../lib/api.ts';
import { meQuery } from '../lib/queries.ts';
import type { Unlocked } from '../lib/types.ts';

const TITLE = 'RELEASE-NOTES(1)';
const FLAGS = [
  '--reply',
  '--web',
  '--address',
  '--photos',
  '--voice-memos',
  '--places',
  '--upcoming',
  '--agents',
  '--book',
  '--export'
];

export function Man() {
  useTitle('release-notes(1)');
  const me = useQuery(meQuery);
  const account = !!me.data && !me.data.new;
  const posted = useRef(false);
  const [won, setWon] = useState<Unlocked[]>([]);
  useEffect(() => {
    if (!account || posted.current) return;
    posted.current = true;
    void api<{ unlocked?: Unlocked[] }>('POST', '/api/eggs', { egg: 'rtfm' }).then((r) => {
      if (r.ok && r.data.unlocked?.length) setWon(r.data.unlocked);
    });
  }, [account]);

  return (
    <>
      <Bar nav={false} />
      <article className="man" id="man">
        <p className="man-head" aria-hidden="true">
          <span>{TITLE}</span>
          <span>Release Notes Manual</span>
          <span>{TITLE}</span>
        </p>
        <h1 className="vh">release-notes(1), the Release Notes manual</h1>
        <UnlockLine items={won} />

        <Section name="NAME">
          <p>release-notes - a daily journal by email, one version a day</p>
        </Section>

        <Section name="SYNOPSIS">
          <p>
            <b>release-notes</b>
            {FLAGS.map((f) => (
              <span key={f}>
                {' '}
                [<b>{f}</b>]
              </span>
            ))}
          </p>
        </Section>

        <Section name="DESCRIPTION">
          <p>
            Every morning <b>release-notes</b> emails you your version number: your age as major and minor (54 is 5.4)
            and the days since your last birthday as the patch. You’re 5.4.300 today.
          </p>
          <p>
            Whatever you reply becomes the release notes for that version. Reply as often as you like: each reply is its
            own note, and together they are the day’s release notes. A note belongs to the day of the email it answers.
            Your birthday is a release, x.y.0, and it closes the release before it.
          </p>
          <p>It comes with a Weekly Thing subscription, free.</p>
        </Section>

        <Section name="OPTIONS">
          <dl>
            <Option flag="--reply">
              Reply to the morning’s email, for up to 72 hours. It files to that email’s day.
            </Option>
            <Option flag="--web">
              Write at notes.yourversionnumber.com, today or any day back to your birthday. Edit or delete any note,
              however it came in.
            </Option>
            <Option flag="--address">
              Your standing address, in Settings and the morning email’s footer: write any day, no reply needed. It
              files to the day it arrives and never expires. New address replaces it.
            </Option>
            <Option flag="--photos">
              Attach photos to a reply or a note. They are kept with the note and shown only to you.
            </Option>
            <Option flag="--voice-memos">
              Record one on the page, or send one by email. Turn on Write out what I say and they are written out too.
            </Option>
            <Option flag="--places">
              Say where a note was, or tap Here. A photo that knows where it was taken says so itself.
            </Option>
            <Option flag="--upcoming">
              Birthdays, anniversaries, trips and events, kept private. Up to three reminders come in the morning’s
              email, and a private calendar link puts them in your calendar.
            </Option>
            <Option flag="--agents">
              Connect an assistant in Settings to read your notes. Adding notes, adding files and Upcoming are each
              their own approval, and you can disconnect it at any time.
            </Option>
            <Option flag="--book">Make a PDF of any days you pick, 6 by 9 inches or US Letter.</Option>
            <Option flag="--export">
              Download everything as a zip: Markdown, JSON and every file. Or the words alone.
            </Option>
          </dl>
        </Section>

        <Section name="FILES">
          <dl>
            <Option flag="~/notes">Your notes. They are yours; export them any time.</Option>
          </dl>
        </Section>

        <Section name="SEE ALSO">
          <p>
            <a href="https://yourversionnumber.com/">yourversionnumber.com</a>(7),{' '}
            <a href="https://weekly.thingelstad.com/">weekly.thingelstad.com</a>(7)
          </p>
        </Section>

        <Section name="BUGS">
          <p>Time only moves forward. Won’t fix.</p>
        </Section>

        <p className="man-head man-foot">
          <span>Your Version Number</span>
          <span>
            <AppLink href="/">notes.yourversionnumber.com</AppLink>
          </span>
          <span>{TITLE}</span>
        </p>
      </article>
    </>
  );
}

function Section({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="man-section" aria-label={name}>
      <h2>{name}</h2>
      <div className="man-body">{children}</div>
    </section>
  );
}

function Option({ flag, children }: { flag: string; children: ReactNode }) {
  return (
    <>
      <dt>
        <b>{flag}</b>
      </dt>
      <dd>{children}</dd>
    </>
  );
}
