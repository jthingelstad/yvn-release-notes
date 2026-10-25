// Three things after the first sign-in: the birthday (or two, when the
// front page already has it), the city, and the send time. First, the
// address has to get the Weekly Thing (AGENTS.md, Subscribers and accounts):
// an address that doesn't is offered it, as Thingy offers it, instead of the
// form.
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { BirthdayFields, emptyMdy, mdyOf, mdyValue, SendTimeSelect } from '../components/fields.tsx';
import { PlacePicker } from '../components/placepicker.tsx';
import { Bar, Digits, ErrorLine, useBusy, useFocusLater, useProblem, useTitle } from '../components/common.tsx';
import { api, get, type Answer } from '../lib/api.ts';
import { browserZone, clock, longDate } from '../lib/format.ts';
import { useGo, useSignedInAs } from '../lib/nav.ts';
import { home, pendingBirthday, signedIn } from '../lib/storage.ts';
import type { Me, Place, Sample, WeeklyThing } from '../lib/types.ts';
import { MEMBERS_URL, subscribeWeeklyThing } from '../lib/weekly-thing.ts';

// Not on the Weekly Thing's list, or on it but not confirmed: the two that
// may not start. A lookup that failed says nothing, and sign-up goes ahead.
type Gate = Extract<WeeklyThing, 'none' | 'unconfirmed'>;
const gateOf = (w?: WeeklyThing): Gate | null => (w === 'none' || w === 'unconfirmed' ? w : null);
const GATES: Record<string, Gate> = { 'weekly-thing': 'none', 'weekly-thing-unconfirmed': 'unconfirmed' };
const readMe = () => api<Pick<Me, 'new' | 'email' | 'weekly_thing'>>('GET', '/api/me');

export function Setup() {
  useTitle('Set up');
  const go = useGo();
  const signIn = useSignedInAs();
  const [ready, setReady] = useState(false);
  const [email, setEmail] = useState('');
  const [gate, setGate] = useState<Gate | null>(null);

  // What /api/me says, as the page opens and again from "Check again":
  // the gate it shows, if any.
  const apply = useCallback(
    (me: Answer<Pick<Me, 'new' | 'email' | 'weekly_thing'>>) => {
      if (!me.ok) {
        go('/#sign-in');
        return null;
      }
      if (!me.data.new) {
        go(home(false));
        return null;
      }
      const g = gateOf(me.data.weekly_thing);
      setEmail(me.data.email);
      setGate(g);
      setReady(true);
      return g;
    },
    [go]
  );
  const look = useCallback(async () => apply(await readMe()), [apply]);

  useEffect(() => {
    let gone = false;
    readMe().then((me) => {
      if (!gone) apply(me);
    });
    return () => {
      gone = true;
    };
  }, [apply]);

  return (
    <>
      <Bar nav={false} />
      {ready && gate && <WeeklyThingGate gate={gate} email={email} look={look} seen={(w) => setGate(gateOf(w))} />}
      {ready && !gate && <SetupForm done={() => signIn(home(false))} gated={setGate} />}
    </>
  );
}

// "Would you like to be added?", as Thingy asks: one button adds this
// session's address, then Buttondown's email confirms it and "Check again"
// lets the form in. The birthday from the front page keeps waiting in this
// browser; a different address signs out and starts again from the front
// page, which still has it.
function WeeklyThingGate({
  gate,
  email,
  look,
  seen
}: {
  gate: Gate;
  email: string;
  look: () => Promise<Gate | null>;
  seen: (w: WeeklyThing) => void;
}) {
  const signOut = useSignedInAs();
  const [busy, run] = useBusy();
  const [still, setStill] = useState(false);
  const [sent, setSent] = useState(false);
  const problem = useProblem();
  const head = useRef<HTMLHeadingElement>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => head.current?.focus(), [gate]);

  const again = () =>
    run(async () => {
      setStill(false);
      problem.clear();
      // Still gated: say so, since the page itself looks the same.
      if ((await look()) === gate) setStill(true);
    });
  // Adds the address, or sends Buttondown's confirmation again when it is
  // already waiting on one.
  const subscribe = () =>
    run(async () => {
      setStill(false);
      problem.clear();
      const r = await subscribeWeeklyThing();
      if (!r.ok) return problem.show(r.data, null, root.current);
      setSent(true);
      seen(r.data.weekly_thing);
    });

  return (
    <section id="weekly-gate" data-gate={gate} ref={root}>
      {gate === 'none' ? (
        <>
          <h1 className="top" tabIndex={-1} ref={head}>
            Release Notes comes with the Weekly Thing.
          </h1>
          <p className="lede">
            It’s free for everyone who gets the Weekly Thing, Jamie’s weekly newsletter.{' '}
            <strong id="gate-email">{email}</strong> isn’t subscribed yet. Would you like to be added?
          </p>
          <div className="stack gate-steps">
            <button className="go" type="button" id="gate-subscribe" disabled={busy} onClick={subscribe}>
              Subscribe to the Weekly Thing
            </button>
            <p className="hint">Free. The Weekly Thing emails this address once to confirm, then you’re in.</p>
          </div>
        </>
      ) : (
        <>
          <h1 className="top" tabIndex={-1} ref={head}>
            Confirm your Weekly Thing subscription.
          </h1>
          <p className="lede">
            {sent ? 'Nearly there. ' : ''}
            <strong id="gate-email">{email}</strong> is signed up for the Weekly Thing but not confirmed yet. Open the
            email the Weekly Thing sent you and confirm, then check again here.
          </p>
        </>
      )}
      <ErrorLine line={problem.line} />
      <div className="stack tight gate-again">
        <button className="quiet" type="button" id="gate-again" disabled={busy} onClick={again}>
          Check again
        </button>
        <p className="hint" id="gate-still" role="status" hidden={!still}>
          {gate === 'none'
            ? 'Not on the list yet. A new subscription can take a minute to show here.'
            : 'Not confirmed yet. Look for the Weekly Thing’s email, in junk too.'}
        </p>
        {gate === 'unconfirmed' && (
          <p className="hint">
            No email?{' '}
            <button className="quiet inline" type="button" id="gate-resend" disabled={busy} onClick={subscribe}>
              Send it again
            </button>
          </p>
        )}
        <p className="hint">
          Getting the Weekly Thing at another address?{' '}
          <button
            className="quiet inline"
            type="button"
            id="gate-other"
            onClick={async () => {
              await api('POST', '/api/auth/signout');
              signedIn.drop();
              signOut('/');
            }}
          >
            Use that one
          </button>
        </p>
      </div>
      <p className="foot">
        Even better as a Supporting Member: membership gives 100% to a nonprofit each year, and Release Notes knows its
        members and says thank you. <a href={MEMBERS_URL}>About membership</a>.
      </p>
    </section>
  );
}

function SetupForm({ done, gated }: { done: () => void; gated: (g: Gate) => void }) {
  // A birthday typed on the front page arrives here: shown as a sentence,
  // with the fields one tap away.
  const [waiting] = useState(pendingBirthday.get);
  const [known, setKnown] = useState(!!waiting);
  const [birthday, setBirthday] = useState(waiting ? mdyOf(waiting) : emptyMdy);
  const [place, setPlace] = useState<Place | null>(null);
  const [sendTime, setSendTime] = useState('06:00');
  const [busy, run] = useBusy();
  const problem = useProblem();
  const focusLater = useFocusLater();
  const month = useRef<HTMLSelectElement>(null);
  const city = useRef<HTMLInputElement>(null);
  const sendSelect = useRef<HTMLSelectElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const b = mdyValue(birthday);
  const tz = place?.tz;

  // The number the birthday makes, in the picked city's time zone once
  // there is one: in the sentence for a birthday from the front page, or
  // under the fields. One the API won't number opens the fields.
  const sample = useQuery({
    queryKey: ['sample', b, tz],
    queryFn: () => get<Sample>(`/api/sample?birthday=${b}&tz=${encodeURIComponent(tz || browserZone())}`),
    enabled: !!b,
    meta: { bounce: false }
  });
  const version = b ? sample.data?.version : undefined;
  const showKnown = known && !sample.isError;

  const notRight = () => setKnown(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      if (!b) {
        notRight();
        return problem.show({ error: 'birthday' }, month.current);
      }
      if (!place) return problem.show({ error: 'place' }, city.current);
      const r = await api('PUT', '/api/me', { birthday: b, place, send_time: sendTime });
      if (!r.ok) {
        // The list changed since the page opened (or the first look failed).
        const g = GATES[r.data.error || ''];
        if (g) return gated(g);
        if (r.data.error === 'birthday') notRight();
        const field = { birthday: month.current, place: city.current, 'send-time': sendSelect.current }[
          r.data.error || ''
        ];
        return problem.show(r.data, field || button.current);
      }
      pendingBirthday.drop();
      done();
    });
  };

  return (
    <>
      <h1 id="setup-head">{showKnown ? 'Two more things.' : 'Three things, then you’re set.'}</h1>
      <div id="known" hidden={!showKnown}>
        <p className="lede">
          You’re{' '}
          <span className="vnum inline" id="known-v">
            {version && <Digits v={version} />}
          </span>{' '}
          today, born <span id="known-date">{waiting && longDate(waiting)}</span>.{' '}
          <button
            className="quiet inline"
            type="button"
            id="not-right"
            onClick={() => {
              notRight();
              focusLater(() => month.current);
            }}
          >
            Not right?
          </button>
        </p>
        <p className="hint spaced">Your birthday numbers every day you keep, so it can’t be changed later.</p>
      </div>

      <form id="setup-form" className="roomy" noValidate onSubmit={submit} onInput={problem.clear}>
        <div className="stack tight" id="birthday-stack" hidden={showKnown}>
          <BirthdayFields value={birthday} onChange={setBirthday} firstRef={month} />
          <p className="aside" id="that-makes" hidden={!version}>
            That makes you{' '}
            <span className="vnum inline" id="setup-v">
              {version && <Digits v={version} />}
            </span>{' '}
            today.
          </p>
          <p className="hint">It numbers every day you keep, so it can’t be changed later.</p>
        </div>

        <div className="stack tight place-picker">
          <PlacePicker
            label="Where you are, to the city"
            placeholder="Start typing a city"
            required
            inputRef={city}
            onPick={(p) => {
              problem.clear();
              setPlace(p);
            }}
            // The city text changed after a pick: that pick no longer holds.
            onClear={() => setPlace(null)}
          />
          <p className="aside picked" hidden={!place}>
            Time zone: <strong className="picked-tz">{place?.tz}</strong>
          </p>
          <p className="hint">
            Only the city. It sets your time zone and, later, the weather in your email. Places from{' '}
            <a href="https://open-meteo.com/">Open-Meteo</a>.
          </p>
        </div>

        <label>
          Send my email at
          <SendTimeSelect value={sendTime} onChange={setSendTime} selectRef={sendSelect} />
        </label>

        <div className="stack tight">
          <button ref={button} className="go" type="submit" disabled={busy}>
            Start my release notes
          </button>
          <ErrorLine line={problem.line} />
          {/* Sign-up sends today's email at once (web.send_first). */}
          <p className="hint" id="first-email">
            Today’s email comes as soon as you start. After that, every day at {clock(sendTime)}.
          </p>
          <p className="hint">
            It comes from <strong>notes@yourversionnumber.com</strong>. Add that to your contacts so the emails don’t
            land in junk.
          </p>
        </div>
      </form>
    </>
  );
}
