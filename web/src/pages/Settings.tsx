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
  useBusy,
  useFocusLater,
  useProblem,
  useTitle
} from '../components/common.tsx';
import { Connections } from '../components/connections.tsx';
import { SendTimeSelect, ZipExport } from '../components/fields.tsx';
import { PlacePicker } from '../components/placepicker.tsx';
import { SettingsGroup } from '../components/settings-group.tsx';
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
  const p = me.data;

  return (
    <>
      <Bar />
      <div className="settings-page">
        <div className="settings-heading">
          <h1>Settings</h1>
          {p && (
            <p className="hint" data-field="email">
              {p.email}
            </p>
          )}
          <p className="hint">Changes save as you go.</p>
        </div>
        {me.isPending && <Loading />}
        {me.isError && <Failed />}
        {p && !p.new && <Account p={p} />}
        {p?.admin && (
          <p className="section">
            <AppLink href="/admin/">Administration</AppLink>
          </p>
        )}

        {(!p || p.new) && <SignOut />}

        <p className="foot">
          Release Notes is a hobby project by <a href="https://www.thingelstad.com/">Jamie Thingelstad</a>, who runs it
          and can read what’s stored. No ads, nothing sold. Page counts by Tinylytics, without cookies.
        </p>
      </div>
    </>
  );
}

function SignOut() {
  const signOut = useSignedInAs();
  return (
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
    </button>
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

// The standing address (AGENTS.md, Who can write): a note or a photo by
// email any day, no reply needed. "New address" replaces it, and the old
// one files nothing from then on.
function Inbox({ p }: { p: Me }) {
  const client = useQueryClient();
  const problem = useProblem();
  const [busy, run] = useBusy();
  const [copied, setCopied] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);

  const copy = async () => {
    problem.clear();
    try {
      await navigator.clipboard.writeText(p.inbox || '');
      setCopied(true);
    } catch {
      problem.show('Couldn’t copy it. Select the address and copy it from there.', copyButton.current);
    }
  };

  const replace = () =>
    run(async () => {
      problem.clear();
      setCopied(false);
      if (p.inbox && !window.confirm('Your current address will stop taking notes. Make a new one?')) return;
      const r = await api<{ inbox: string }>('POST', '/api/me/inbox');
      if (!r.ok) return problem.show(r.data, newButton.current);
      client.setQueryData(['me'], { ...p, inbox: r.data.inbox });
    });

  return (
    <section className="section" id="inbox">
      <h3>Write by email, any day</h3>
      <p className="value mono" data-field="inbox" hidden={!p.inbox}>
        {p.inbox}
      </p>
      <p className="hint">
        Send a note or a photo here whenever you like, no reply needed. It goes in for the day it arrives, from{' '}
        {p.email} only. Keep it to yourself: anyone could use it to send you mail.
      </p>
      <div className="row">
        <button ref={copyButton} className="quiet" type="button" id="inbox-copy" hidden={!p.inbox} onClick={copy}>
          Copy
        </button>
        <button ref={newButton} className="quiet" type="button" id="inbox-new" disabled={busy} onClick={replace}>
          {p.inbox ? 'New address' : 'Make my address'}
        </button>
      </div>
      <p className="aside saved" id="inbox-copied" role="status" hidden={!copied}>
        Copied.
      </p>
      <ErrorLine line={problem.line} />
    </section>
  );
}

function Account({ p }: { p: Me }) {
  const client = useQueryClient();
  const save = useSave();
  const time = useSetting(p.send_time);
  const transcribe = useSetting(!!p.transcribe);
  const describe = useSetting(!!p.describe);
  const badges = useSetting(p.badges !== false);
  const here = useSetting(p.here !== false);
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
      <SettingsGroup id="daily-email" title="Daily email" description={status} defaultOpen>
        <div className="settings-daily-fields">
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
            <h3>Your city</h3>
            <p className="value">
              <span data-field="city">{p.city}</span>{' '}
              <span className="settings-timezone hint" data-field="tz">
                {p.tz}
              </span>
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
        </div>
        <p className="hint settings-weather">
          Your city sets the time zone and daily weather. Weather from <a href="https://open-meteo.com/">Open-Meteo</a>,
          which receives the city, never your notes.
        </p>
        <section className="section">
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
        <section className="section">
          <p className="hint">
            <AppLink href="/activity/" id="activity-link">
              Activity
            </AppLink>
            : what happened in your account, including what became of each email you sent in.
          </p>
        </section>
      </SettingsGroup>
      <SettingsGroup
        id="writing-settings"
        title="Writing & search"
        description="Your email address, where you are, recordings, photos and badges"
      >
        <Inbox p={p} />
        <section className="section">
          <h3>Where you are</h3>
          <label className="check">
            <input
              type="checkbox"
              id="here"
              checked={here.value}
              onChange={(e) => here.change(e.target.checked, { here: e.target.checked }, e.target)}
            />{' '}
            Add where I am
          </label>
          <p className="hint">
            A note you write on Today starts with where you are, as your browser tells it. The spot is kept exactly,
            with the city’s name, so its map shows where you were; the city alone names your day. To name the city, the
            spot is sent to Amazon Location and nothing else. Any note can say “Not there” before it’s saved, or change
            its place after.
          </p>
          <p className="aside saved" id="here-saved" role="status" hidden={!here.saved}>
            Saved.
          </p>
          <ErrorLine line={here.problem.line} />
        </section>
        <section className="section">
          <h3>Recordings</h3>
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
          <h3>Photos</h3>
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
          <h3>Badges</h3>
          <label className="check">
            <input
              type="checkbox"
              id="show-badges"
              checked={badges.value}
              onChange={async (e) => {
                await badges.change(e.target.checked, { badges: e.target.checked }, e.target);
                // Pages already read keep their badge lines until read again.
                await client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
              }}
            />{' '}
            Show badges
          </label>
          <p className="hint">
            Badges mark what your writing adds up to: firsts, runs of days, special version numbers. Off, they leave
            your emails and pages. Nothing is lost, and turning them back on shows everything earned in the meantime.
          </p>
          <p className="aside saved" id="badges-saved" role="status" hidden={!badges.saved}>
            Saved.
          </p>
          <ErrorLine line={badges.problem.line} />
        </section>
        <p className="hint settings-link-privacy">
          When a note has a link, we visit the page once, as the note is saved, to keep its title. Nothing else is
          fetched.
        </p>
      </SettingsGroup>
      <Connections />
      <SettingsGroup id="account-settings" title="Your account" description="Birthday, export, sign out or delete">
        <section className="section">
          <h3>Birthday</h3>
          <p className="value" data-field="birthday">
            {longDate(p.birthday)}
          </p>
          <p className="hint">Set for good, because changing it would renumber every day you’ve kept.</p>
        </section>
        <section className="section wide" id="your-data">
          <h3>Keep a copy</h3>
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
        </section>
        <section className="section settings-account-actions">
          <SignOut />
          <AppLink className="quiet danger" href="/delete/" id="delete-link">
            Delete my account
          </AppLink>
          <p className="hint" id="delete-hint">
            We’ll offer the export first, then email a code to confirm. Deleting removes every note, its photos and
            recordings, and the original emails behind them.
          </p>
        </section>
      </SettingsGroup>
    </div>
  );
}
