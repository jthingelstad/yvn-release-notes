// The profile, each change saved at once, and the way out: export, sign
// out, delete.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import {
  AppLink,
  Bar,
  ErrorLine,
  Failed,
  Loading,
  useFocusLater,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { SendTimeSelect, ZipExport } from '../components/fields.tsx';
import { PlacePicker } from '../components/placepicker.tsx';
import { api } from '../lib/api.ts';
import { clock, longDate, pauseLine } from '../lib/format.ts';
import { useMe, useSignedInAs } from '../lib/nav.ts';
import { signedIn } from '../lib/storage.ts';
import type { Me } from '../lib/types.ts';

const STOPPED: Record<string, string> = {
  unsubscribed: 'Stopped, because you unsubscribed.',
  bounce: 'Stopped, because an email to this address bounced.',
  complaint: 'Stopped, because an email was marked as spam.'
};

export function Settings() {
  useTitle('Settings');
  const me = useMe();
  const signOut = useSignedInAs();
  const p = me.data;

  return (
    <>
      <Bar />
      <h1>Settings</h1>
      {me.isPending && <Loading />}
      {me.isError && <Failed />}
      {p && !p.new && <Account p={p} />}

      <section className="section wide">
        <button
          className="quiet"
          type="button"
          id="signout"
          // Signing out does not depend on loading the profile.
          onClick={async () => {
            await api('POST', '/api/auth/signout');
            signedIn.drop();
            signOut('/#sign-in');
          }}
        >
          Sign out
        </button>{' '}
        <AppLink className="quiet danger" href="/delete/" id="delete-link" hidden={!p}>
          Delete my account
        </AppLink>
        <p className="hint" id="delete-hint" hidden={!p}>
          We’ll offer the export first, then email a code to confirm. Deleting removes every note, its photos and
          recordings, and the original emails behind them.
        </p>
      </section>

      <p className="foot">
        Release Notes is a hobby project by <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>, who runs it
        and can read what’s stored. No ads, nothing sold. Page counts by Tinylytics, without cookies.
      </p>
    </>
  );
}

// Each change saves at once; a failure shows in that section's error line,
// with focus back on the field.
function useSave() {
  const client = useQueryClient();
  return async (change: Record<string, unknown>, problem: ReturnType<typeof useProblem>, field: HTMLElement | null) => {
    problem.clear();
    const r = await api<Me>('PUT', '/api/me', change);
    if (r.ok) client.setQueryData(['me'], r.data);
    else problem.show(r.data, field);
    return r.ok;
  };
}

// A setting shown as stored, or as just changed while it saves.
function useSetting<T>(stored: T) {
  const [pending, setPending] = useState<{ v: T } | null>(null);
  const [saved, setSaved] = useState(false);
  const problem = useProblem();
  const save = useSave();
  const change = async (v: T, body: Record<string, unknown>, field: HTMLElement | null) => {
    setPending({ v });
    setSaved(false);
    const ok = await save(body, problem, field);
    setSaved(ok);
    setPending(null); // back to what is stored
  };
  return { value: pending ? pending.v : stored, saved, problem, change };
}

function Account({ p }: { p: Me }) {
  const client = useQueryClient();
  const save = useSave();
  const time = useSetting(p.send_time);
  const transcribe = useSetting(!!p.transcribe);
  const describe = useSetting(!!p.describe);
  const cityProblem = useProblem();
  const emailsProblem = useProblem();
  const focusLater = useFocusLater();
  const [picking, setPicking] = useState(false);
  const [pickerKey, setPickerKey] = useState(0);
  const cityInput = useRef<HTMLInputElement>(null);
  const changeCity = useRef<HTMLButtonElement>(null);
  const restart = useRef<HTMLButtonElement>(null);
  const resume = useRef<HTMLButtonElement>(null);

  const stopped = p.status === 'stopped';
  const status = stopped
    ? STOPPED[p.stopped_reason || ''] || 'Stopped.'
    : p.pause
      ? pauseLine(p)
      : `Arriving every day at ${clock(p.send_time)}.`;

  const closePicker = () => {
    setPickerKey((k) => k + 1);
    cityProblem.clear();
    setPicking(false);
    focusLater(() => changeCity.current);
  };

  return (
    <div id="account">
      <section className="section">
        <h2>Your email</h2>
        <p className="value" data-field="email">
          {p.email}
        </p>
      </section>

      <section className="section">
        <label>
          Send my email at
          <SendTimeSelect
            id="send-time"
            value={time.value}
            onChange={(v) => time.change(v, { send_time: v }, document.getElementById('send-time'))}
          />
        </label>
        <p className="aside saved" id="send-time-saved" role="status" hidden={!time.saved}>
          Saved.
        </p>
        <ErrorLine line={time.problem.line} />
      </section>

      <section className="section">
        <h2>Where you are</h2>
        <p className="value">
          <span data-field="city">{p.city}</span>{' '}
          <span className="aside">
            · <span data-field="tz">{p.tz}</span>
          </span>
        </p>
        <p className="hint">
          Each day’s weather here is kept with your notes, and your daily email carries the forecast. Weather from{' '}
          <a href="https://open-meteo.com/">Open-Meteo</a>, which is told the city, never your notes.
        </p>
        <button
          ref={changeCity}
          className="quiet"
          type="button"
          id="change-city"
          hidden={picking}
          onClick={() => {
            setPicking(true);
            focusLater(() => cityInput.current);
          }}
        >
          Change city
        </button>
        <div className="stack tight place-picker" id="city-picker" hidden={!picking}>
          <PlacePicker
            key={pickerKey}
            label="New city"
            placeholder="Start typing a city"
            inputRef={cityInput}
            onPick={async (place) => {
              if (await save({ place }, cityProblem, cityInput.current)) closePicker();
            }}
          />
          <ErrorLine line={cityProblem.line} />
          <button className="quiet" type="button" id="cancel-city" onClick={closePicker}>
            Cancel
          </button>
          <p className="hint">
            Places from <a href="https://open-meteo.com/">Open-Meteo</a>.
          </p>
        </div>
      </section>

      <section className="section">
        <h2>Recordings</h2>
        <label className="check">
          <input
            type="checkbox"
            id="transcribe"
            checked={transcribe.value}
            onChange={(e) => transcribe.change(e.target.checked, { transcribe: e.target.checked }, e.target)}
          />{' '}
          Write out what I say
        </label>
        <p className="hint">
          Your recordings get turned into text that shows up underneath them, so you can skim them and search them.
          They’re sent off to be transcribed to do it. Turning this on writes out the ones you already have, too.
        </p>
        <p className="aside saved" id="transcribe-saved" role="status" hidden={!transcribe.saved}>
          Saved.
        </p>
        <ErrorLine line={transcribe.problem.line} />
      </section>

      <section className="section">
        <h2>Photos</h2>
        <label className="check">
          <input
            type="checkbox"
            id="describe"
            checked={describe.value}
            onChange={(e) => describe.change(e.target.checked, { describe: e.target.checked }, e.target)}
          />{' '}
          Describe my photos
        </label>
        <p className="hint">
          Each photo gets a sentence or two about what’s in it, so searching for “canoe” finds the canoe. You only see
          it in search results. They’re sent off to an AI to be described. Turning this on does the ones you already
          have, too.
        </p>
        <p className="aside saved" id="describe-saved" role="status" hidden={!describe.saved}>
          Saved.
        </p>
        <ErrorLine line={describe.problem.line} />
      </section>

      <section className="section">
        <h2>Birthday</h2>
        <p className="value" data-field="birthday">
          {longDate(p.birthday)}
        </p>
        <p className="hint">Set for good, because changing it would renumber every day you’ve kept.</p>
      </section>

      <section className="section">
        <h2>Emails</h2>
        <p className="value" id="email-status">
          {status}
        </p>
        <button
          ref={restart}
          className="quiet"
          type="button"
          id="restart"
          hidden={!stopped}
          onClick={() => save({ status: 'active' }, emailsProblem, restart.current)}
        >
          Start them again
        </button>
        <AppLink className="quiet" href="/pause/" id="pause-link" hidden={stopped}>
          {p.pause ? 'Change the pause' : 'Pause the emails'}
        </AppLink>{' '}
        <button
          ref={resume}
          className="quiet"
          type="button"
          id="resume"
          hidden={stopped || !p.pause}
          onClick={async () => {
            emailsProblem.clear();
            const r = await api<Me>('DELETE', '/api/pause');
            if (r.ok) client.setQueryData(['me'], r.data);
            else emailsProblem.show(r.data, resume.current);
          }}
        >
          Start them again now
        </button>
        <ErrorLine line={emailsProblem.line} />
      </section>

      <section className="section wide" id="your-data">
        <h2 className="big">Your data</h2>
        <p className="hint">
          Every note you’ve kept, with its day and version, every photo and recording, and your settings, in one zip.
          Yours to keep.
        </p>
        <ZipExport />
        <p className="hint">
          Or the words alone:{' '}
          <a href="/api/export?format=md" download>
            Markdown
          </a>{' '}
          or{' '}
          <a href="/api/export?format=json" download>
            JSON
          </a>
          .
        </p>
        <p className="hint">
          When a note has a link, we visit the page once, as the note is saved, to keep its title. Nothing else is
          fetched.
        </p>
      </section>
    </div>
  );
}
