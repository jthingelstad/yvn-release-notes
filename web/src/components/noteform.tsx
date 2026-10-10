// The form that adds a note to a day, with files from this device and
// recordings made here. What is being written is kept in this tab, by day,
// until it is saved, so a sign-out mid-note (or a reload) doesn't lose it.
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { browserZone } from '../lib/format.ts';
import { FILES, sendFiles } from '../lib/files.ts';
import { store } from '../lib/storage.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { useRefresh } from './notelist.tsx';
import { canRecord, recordClock, useRecorder } from './recorder.ts';

interface Props {
  day: string;
  label: ReactNode;
  placeholder: string;
  submit: ReactNode;
}

// Give it a `key` of the day, so another day starts with that day's draft.
export function NoteForm({ day, label, placeholder, submit }: Props) {
  const key = `rn-draft-${day}`;
  const [text, setText] = useState(() => store.get(key) || '');
  const [chosen, setChosen] = useState<string>('');
  const [busy, run] = useBusy();
  const problem = useProblem();
  const area = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const refresh = useRefresh();
  const { show } = problem;
  const refused = useCallback(() => show({ error: 'microphone' }, recordButton.current), [show]);
  const rec = useRecorder(refused);

  // Leaving for another page here would drop a recording not yet saved.
  useBlocker({
    shouldBlockFn: () => rec.unsaved() && !window.confirm('Your recording isn’t saved yet. Leave without it?'),
    enableBeforeUnload: false
  });

  const showChosen = () => {
    const names = [...(pick.current?.files || [])].map((f) => f.name);
    setChosen(names.length ? `With ${names.join(', ')}` : '');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      const files = [...(pick.current?.files || []), ...(await rec.files())];
      if (!text.trim() && !files.length) return problem.show({ error: 'text' }, area.current);
      // The zone it is being written in, so its time reads as it did here.
      const body: { text: string; tz: string; uploads?: unknown } = { text, tz: browserZone() };
      if (files.length) {
        const out = await sendFiles(files, setChosen);
        showChosen();
        if (out.problem) {
          store.set(key, text);
          return problem.show({ ...out.problem, draft: 'kept' }, pick.current);
        }
        body.uploads = out.sent;
      }
      const r = await api('POST', `/api/days/${day}/notes`, body);
      if (!r.ok) {
        store.set(key, text);
        return problem.show({ ...r.data, draft: 'kept' }, area.current);
      }
      store.drop(key);
      setText('');
      if (pick.current) pick.current.value = '';
      showChosen();
      rec.clear();
      await refresh();
    });
  };

  return (
    <form id="note-form" className="note-form" noValidate onSubmit={onSubmit}>
      <label>
        {label}
        <textarea
          ref={area}
          name="text"
          rows={3}
          placeholder={placeholder}
          value={text}
          onChange={(e) => {
            problem.clear();
            setText(e.target.value);
            if (e.target.value.trim()) store.set(key, e.target.value);
            else store.drop(key);
          }}
        />
      </label>
      <p className="hint chosen" role="status" hidden={!chosen}>
        {chosen}
      </p>
      <div className="recordings">
        {rec.kept.map((r) => (
          <div className="recording" key={r.url}>
            <audio controls src={r.url} aria-label={r.file.name} />
            <button className="quiet" type="button" onClick={() => rec.remove(r)}>
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="row">
        <button className="go" type="submit" disabled={busy}>
          {submit}
        </button>
        <label className="quiet picker">
          Add files
          <input
            ref={pick}
            type="file"
            name="files"
            multiple
            accept={FILES}
            onChange={() => {
              problem.clear();
              showChosen();
            }}
          />
        </label>
        <button
          ref={recordButton}
          className="quiet record"
          type="button"
          aria-pressed={rec.seconds !== null}
          hidden={!canRecord()}
          onClick={() => {
            problem.clear();
            rec.toggle();
          }}
        >
          {rec.seconds === null ? 'Record' : `Stop · ${recordClock(rec.seconds)}`}
        </button>
      </div>
      <ErrorLine line={problem.line} />
    </form>
  );
}
