// A dated break from the emails, at most 60 days, ending on its own.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { AppLink, Bar, ErrorLine, Failed, Loading, useBusy, useProblem, useTitle } from '../components/common.tsx';
import { api } from '../lib/api.ts';
import { addDays, clock, dayName, pauseLine, thisYearOf } from '../lib/format.ts';
import { useGo, useMe } from '../lib/nav.ts';
import { SAY } from '../lib/say.ts';
import type { Me } from '../lib/types.ts';

const LENGTHS = [
  ['3', '3 days'],
  ['7', '1 week'],
  ['14', '2 weeks'],
  ['until', 'Until a date I pick']
] as const;

export function Pause() {
  useTitle('Pause');
  const me = useMe();
  const p = me.data && !me.data.new ? me.data : null;
  return (
    <>
      <Bar />
      <h1>Taking a break?</h1>
      <p className="lede">We’ll stop the emails for a while and start them again on our own.</p>
      {me.isPending && <Loading />}
      {me.isError && <Failed />}
      {p && <PauseForm p={p} />}
    </>
  );
}

function PauseForm({ p }: { p: Me }) {
  const client = useQueryClient();
  const go = useGo();
  const [len, setLen] = useState('7');
  const [busy, run] = useBusy();
  const problem = useProblem();
  const resumeProblem = useProblem();
  const resume = useRef<HTMLButtonElement>(null);
  const throughInput = useRef<HTMLInputElement>(null);
  const radios = useRef<HTMLFieldSetElement>(null);

  const on = (iso: string) => dayName(iso, thisYearOf(p.today));
  const start = p.pause && p.pause.from <= p.today ? p.pause.from : p.pause_starts;
  const min = start < p.today ? p.today : start;
  const max = addDays(start, 59);
  const [through, setThrough] = useState(() => addDays(start, 13));
  const last = len === 'until' ? through : addDays(start, Number(len) - 1);
  // A typed date outside the range the API takes gets the error a submit
  // would, instead of a preview.
  const outOfRange = (iso: string) => iso < min || iso > max;
  const typedWrong = len === 'until' && !!last && outOfRange(last);

  if (p.status === 'stopped') {
    return (
      <div className="section" id="current">
        <p className="value" id="current-text">
          Your emails are stopped, so there’s nothing to pause. Start them again in settings.
        </p>
      </div>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      const field =
        len === 'until' ? throughInput.current : radios.current?.querySelector<HTMLElement>('input[name=len]:checked');
      if (len === 'until' && (!through || outOfRange(through))) return problem.show({ error: 'through' }, field);
      const r = await api('PUT', '/api/pause', len === 'until' ? { through } : { days: Number(len) });
      if (!r.ok) return problem.show(r.data, field);
      await client.invalidateQueries({ queryKey: ['me'] });
      go('/settings/');
    });
  };

  return (
    <>
      <div className="section" id="current" hidden={!p.pause}>
        <p className="value" id="current-text">
          {pauseLine(p)}
        </p>
        <button
          ref={resume}
          className="quiet"
          type="button"
          id="resume"
          onClick={async () => {
            resumeProblem.clear();
            const r = await api<Me>('DELETE', '/api/pause');
            if (r.ok) client.setQueryData(['me'], r.data);
            else resumeProblem.show(r.data, resume.current);
          }}
        >
          Start the emails again now
        </button>
        <ErrorLine line={resumeProblem.line} />
      </div>

      <form id="pause-form" className="roomy" noValidate onSubmit={submit}>
        <fieldset className="choices" ref={radios}>
          <legend id="choose">{p.pause ? 'Change it to' : 'Pause for'}</legend>
          {LENGTHS.map(([v, text]) => (
            <label key={v} className={len === v ? 'choice on' : 'choice'}>
              <input
                type="radio"
                name="len"
                value={v}
                checked={len === v}
                onChange={() => {
                  problem.clear();
                  setLen(v);
                }}
              />{' '}
              <span>{text}</span>
            </label>
          ))}
          <label className="until" hidden={len !== 'until'}>
            Last day without an email
            <input
              ref={throughInput}
              type="date"
              name="through"
              min={min}
              max={max}
              value={through}
              onChange={(e) => {
                problem.clear();
                setThrough(e.target.value);
              }}
            />
          </label>
        </fieldset>

        <div className="stack tight">
          <p className="value" id="preview">
            {last && !typedWrong && (
              <>
                No emails from <strong>{on(start < p.today ? p.today : start)}</strong> through{' '}
                <strong>{on(last)}</strong>. They start again on <strong>{on(addDays(last, 1))}</strong> at{' '}
                {clock(p.send_time)}.
              </>
            )}
          </p>
          <p className="hint">
            Paused days don’t break your streak. You can still <AppLink href="/day/">add notes for them</AppLink>.
          </p>
        </div>

        <div className="stack tight">
          <div className="row">
            <button className="go" type="submit" disabled={busy}>
              Pause emails
            </button>
            <AppLink href="/settings/">Not now</AppLink>
          </div>
          <ErrorLine line={problem.line || (typedWrong ? SAY.through : null)} />
        </div>
      </form>
    </>
  );
}
