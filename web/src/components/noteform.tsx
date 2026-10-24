// The form that adds a note to a day, with files from this device and
// recordings made here. What is being written is kept in this tab, by day,
// until it is saved, so a sign-out mid-note (or a reload) doesn't lose it.
// Once any files are sent, the note shows in the list at once ("Saving…")
// and the form empties; a write that fails puts it all back. "Where" is
// optional (where.tsx), and with "Add where I am" on, Today's form starts
// each note with Here. What a saved note earned shows under the form
// (unlock.tsx).
import { useQueryClient } from '@tanstack/react-query';
import { useBlocker } from '@tanstack/react-router';
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../lib/api.ts';
import { browserZone } from '../lib/format.ts';
import { FILES, sendFiles } from '../lib/files.ts';
import { addPending, dropNote } from '../lib/notecache.ts';
import { store } from '../lib/storage.ts';
import type { Place, Unlocked } from '../lib/types.ts';
import { ErrorLine, useBusy, useProblem } from './common.tsx';
import { useRefresh } from './notelist.tsx';
import { canRecord, recordClock, useRecorder } from './recorder.ts';
import { Icon } from './icon.tsx';
import { UnlockLine } from './unlock.tsx';
import { NoteWhere } from './where.tsx';
import { spans, MAX_TAG } from '../../../packages/domain/tags.ts';

interface Props {
  day: string;
  label: ReactNode;
  placeholder: string;
  submit: ReactNode;
  initialTag?: string | null;
  // "Add where I am" (Settings): start each note with Here
  here?: boolean;
}

// Give it a `key` of the day, so another day starts with that day's draft.
export function NoteForm({ day, label, placeholder, submit, initialTag, here = false }: Props) {
  const key = `rn-draft-${day}`;
  const [text, setText] = useState(() => {
    const draft = store.get(key) || '';
    // Tags travel in the fragment, never a server-visible query or request.
    // Keep an existing draft and never duplicate a hashtag already in its text.
    if (
      !initialTag ||
      initialTag.length > MAX_TAG ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(initialTag) ||
      !/[a-z]/.test(initialTag) ||
      spans(draft).some(([, , tag]) => tag === initialTag)
    )
      return draft;
    return draft + (draft ? '\n\n' : '') + '#' + initialTag;
  });
  const [chosen, setChosen] = useState<string>('');
  const [place, setPlace] = useState<Place | null>(null);
  // Each new note starts its "Where" over, Here's "Not there" included.
  const [round, setRound] = useState(0);
  const [won, setWon] = useState<Unlocked[]>([]);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const area = useRef<HTMLTextAreaElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const recordButton = useRef<HTMLButtonElement>(null);
  const refresh = useRefresh();
  const client = useQueryClient();
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
      setWon([]);
      const files = [...(pick.current?.files || []), ...(await rec.files())];
      if (!text.trim() && !files.length) return problem.show({ error: 'text' }, area.current);
      // The zone it is being written in, so its time reads as it did here.
      const body: { text: string; tz: string; uploads?: unknown; place?: Place } = { text, tz: browserZone() };
      if (place) body.place = place;
      if (files.length) {
        const out = await sendFiles(files, setChosen);
        showChosen();
        if (out.problem) {
          store.set(key, text);
          return problem.show({ ...out.problem, draft: 'kept' }, pick.current);
        }
        body.uploads = out.sent;
      }
      const pending = await addPending(client, day, text);
      store.drop(key);
      setText('');
      if (pick.current) pick.current.value = '';
      showChosen();
      rec.clear();
      setPlace(null);
      setRound((n) => n + 1);
      const r = await api<{ unlocked?: Unlocked[] }>('POST', `/api/days/${day}/notes`, body);
      if (!r.ok) {
        await dropNote(client, day, pending);
        setText(text);
        store.set(key, text);
        putBack(pick.current, files);
        showChosen();
        setPlace(place);
        return problem.show({ ...r.data, draft: 'kept' }, area.current);
      }
      setWon(r.data.unlocked || []);
      await refresh();
    });
  };

  return (
    <>
      <form id="note-form" className="note-form" noValidate onSubmit={onSubmit}>
        <label className="write-label">
          <span>{label}</span>
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
        <div className="row note-tools">
          <label className="quiet picker">
            <Icon name="files" /> Add files
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
            <Icon name="record" /> {rec.seconds === null ? 'Record' : `Stop · ${recordClock(rec.seconds)}`}
          </button>
          <NoteWhere key={round} place={place} onPick={setPlace} onProblem={show} auto={here} />
          <button className="go" type="submit" disabled={busy}>
            {submit}
          </button>
        </div>
        <ErrorLine line={problem.line} />
      </form>
      <UnlockLine items={won} />
    </>
  );
}

// The files a failed note was sent with, back in the picker (recordings made
// here come back as files), where the browser allows it.
function putBack(input: HTMLInputElement | null, files: File[]) {
  if (!input || !files.length) return;
  try {
    const all = new DataTransfer();
    for (const f of files) all.items.add(f);
    input.files = all.files;
  } catch {
    /* the browser keeps the picker's files to itself */
  }
}
