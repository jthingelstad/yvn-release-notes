// Three things after the first sign-in: the birthday (or two, when the
// front page already has it), the city, and the send time.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BirthdayFields, emptyMdy, mdyOf, mdyValue, SendTimeSelect } from '../components/fields.tsx';
import { PlacePicker } from '../components/placepicker.tsx';
import { Bar, Digits, ErrorLine, useBusy, useFocusLater, useProblem, useTitle } from '../components/common.tsx';
import { api, get } from '../lib/api.ts';
import { browserZone, clock, longDate } from '../lib/format.ts';
import { useGo, useSignedInAs } from '../lib/nav.ts';
import { home, pendingBirthday } from '../lib/storage.ts';
import type { Place, Sample } from '../lib/types.ts';

export function Setup() {
  useTitle('Set up');
  const go = useGo();
  const signIn = useSignedInAs();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let gone = false;
    api<{ new: boolean }>('GET', '/api/me').then((me) => {
      if (gone) return;
      if (!me.ok) return go('/#sign-in');
      if (!me.data.new) return go(home(false));
      setReady(true);
    });
    return () => {
      gone = true;
    };
  }, [go]);

  return (
    <>
      <Bar nav={false} />
      {ready && <SetupForm done={() => signIn(home(false))} />}
    </>
  );
}

function SetupForm({ done }: { done: () => void }) {
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
