// What Release Notes is, for someone who hasn't signed up: how it works, a
// made-up morning's email, what it does, why it holds up, and that it is
// free with the Weekly Thing (Jamie, 2026-10-25: "tout its features and how
// well it works. Free to use", "framed as better for Weekly Thing supporting
// members"). Type on paper like the rest: no boxes. Every claim here is
// something the product does today. Supporting Members get a badge for each
// year they give and a thank-you on their birthday (domain/giving.ts), and
// membership is never called a price.
import type { ReactNode } from 'react';
import { Digits } from './common.tsx';
import { emailDate, MADE_UP, type Morning } from '../lib/sample.ts';
import { MEMBERS_URL, WEEKLY_THING_URL } from '../lib/weekly-thing.ts';

// `morning` is the visitor's own, once they have typed a birthday
// (lib/sample.ts); until then the sample is made up.
export function Tour({ hidden, morning = MADE_UP }: { hidden: boolean; morning?: Morning }) {
  return (
    <section id="tour" className="tour" aria-labelledby="tour-head" hidden={hidden}>
      <p className="kicker">Release Notes</p>
      <h2 className="big" id="tour-head">
        The easiest journal you’ll ever keep.
      </h2>
      <p className="lede">
        Most journals wait for you to remember them. This one comes to you every morning, and your reply is the entry.
      </p>

      <ol className="tour-steps">
        <Step n="1" head="It comes every day.">
          At the time you choose, with today’s number as the subject.
        </Step>
        <Step n="2" head="You reply.">
          A line or a page, photos, a voice memo. As often as you like.
        </Step>
        <Step n="3" head="It’s kept.">
          Each reply files to its day, and the days add up to your release notes.
        </Step>
      </ol>

      <SampleEmail m={morning} />

      <h2 className="big tour-head">Everything a journal needs.</h2>
      <Group head="Write it however it comes">
        <Feature head="Reply, or write on the web.">
          Answer from any mail app, or write here, today or any day back to your birthday.
        </Feature>
        <Feature head="Photos, voice memos and PDFs.">
          Attach them to a reply or add them on the web. They stay with their day.
        </Feature>
        <Feature head="An address of your own.">Mail a note any day, no reply needed.</Feature>
        <Feature head="On your Home Screen.">Add it to your phone and it opens like an app.</Feature>
        <Feature head="Your assistant, if you like.">
          Connect Claude or ChatGPT to read your notes, and to add to them only if you allow it.
        </Feature>
      </Group>
      <Group head="See it come back">
        <Feature head="Yesterday, confirmed.">
          Each morning shows what you sent the day before, so you know it all arrived.
        </Feature>
        <Feature head="On this day.">What you wrote on this same day in every earlier release.</Feature>
        <Feature head="A birthday closes the release.">The year just ended, summed up, with a page of its own.</Feature>
        <Feature head="Streaks, counts and badges.">Quiet ones. Miss a day and nothing scolds you.</Feature>
        <Feature head="Weather and places.">
          Your days keep their weather. A note can keep exactly where it was, on your own map.
        </Feature>
        <Feature head="Upcoming.">
          Birthdays, anniversaries and trips, remembered in the morning email and in your calendar.
        </Feature>
      </Group>
      <Group head="Find it, and keep it">
        <Feature head="Tags and search.">
          #hashtags in any note, and search across every word. Turn it on, and what you said in a voice memo and what’s
          in a photo are found too.
        </Feature>
        <Feature head="Yours to take.">Export everything as a zip, files and all, or delete it, any time.</Feature>
      </Group>

      <h2 className="big tour-head">It just works.</h2>
      <ul className="tour-list">
        <Feature head="It’s only email.">Nothing to install, nothing to learn, no app to open first.</Feature>
        <Feature head="Nothing gets lost.">Every reply is kept whole, exactly as it arrived.</Feature>
        <Feature head="Late is fine.">
          A reply counts for its day for 72 hours. Later than that, a note comes back to say so.
        </Feature>
        <Feature head="Made to be used.">
          Jamie built it to keep a journal, and opened it to anyone who’d like the same.
        </Feature>
      </ul>

      <h2 className="big tour-head" id="tour-free">
        Free with the Weekly Thing.
      </h2>
      <p className="lede">
        Release Notes comes with a subscription to{' '}
        <a href={WEEKLY_THING_URL} id="tour-subscribe">
          the Weekly Thing
        </a>
        , Jamie’s weekly newsletter since 2017, and there’s nothing to pay. Sign up with the address it comes to. Not
        getting it yet? Sign up anyway, and Release Notes will offer to add you.
      </p>
      <p className="sub">
        <strong>Even better as a Supporting Member.</strong> Membership gives 100% to a nonprofit each year, and Release
        Notes marks every year you give with a badge and a thank-you in your birthday email.{' '}
        <a href={MEMBERS_URL}>About membership</a>.
      </p>
    </section>
  );
}

function Step({ n, head, children }: { n: string; head: string; children: ReactNode }) {
  return (
    <li>
      <span className="vnum" aria-hidden="true">
        {n}
      </span>
      <p>
        <strong>{head}</strong> {children}
      </p>
    </li>
  );
}

function Group({ head, children }: { head: string; children: ReactNode }) {
  return (
    <>
      <h3 className="tour-group">{head}</h3>
      <ul className="tour-list">{children}</ul>
    </>
  );
}

function Feature({ head, children }: { head: string; children: ReactNode }) {
  return (
    <li>
      <strong>{head}</strong> {children}
    </li>
  );
}

// A morning's email as the email lays it out (packages/mail/compose.ts),
// with made-up notes. With the visitor's own morning, the number, the day,
// the countdown and On this day's patches are theirs.
const PAST_NOTES = [
  'First snow. The dog refused to go out.',
  'Started the new job. Everyone remembered my name but me.'
];

function SampleEmail({ m }: { m: Morning }) {
  const V = m.version;
  return (
    <figure className="sample" id="sample" aria-labelledby="sample-cap">
      <figcaption className="kicker" id="sample-cap">
        {m.own ? 'Your morning’s email' : 'A morning’s email'}
      </figcaption>
      <p className="sample-subject">
        <span className="vh">Subject: </span>You’re <span id="sample-v">{V}</span> today
      </p>
      <p className="sample-meta">
        <strong>Release Notes</strong> · <span id="sample-day">{emailDate(m.day)}</span>
        <br />
        Minneapolis today: partly cloudy, high 61°, low 44°.
      </p>
      <p className="vnum big" aria-hidden="true">
        <Digits v={V} />
      </p>
      <p className="sample-quiet sample-next" id="sample-next">
        <span className="mono">{m.next}</span> ships {m.ships}.
      </p>
      <p>
        Reply any time today: what happened, what you made, who you saw. Whatever you send back becomes the release
        notes for {V}.
      </p>
      <p className="sample-quiet">12 days in a row, your longest yet. Reply today and {V} makes it 13.</p>
      <h3>Yesterday</h3>
      <p>
        Finally fixed the porch light. Pizza on the back steps after, until it got too cold.{' '}
        <span className="sample-tag">#home</span>
      </p>
      {m.past.length > 0 && (
        <>
          <h3>On this day</h3>
          {m.past.map((v, i) => (
            <p key={v}>
              <span className="mono">{v}</span> {PAST_NOTES[i]}
            </p>
          ))}
        </>
      )}
      <p className="hint sample-note" id="sample-note">
        {m.own
          ? 'Your number, your day and your own patches. The notes, the weather and the streak are made up: yours fill in from what you write.'
          : 'A made-up morning. Yours fills in from your own notes.'}
      </p>
    </figure>
  );
}
