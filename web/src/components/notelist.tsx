// A day's notes, each with Edit, Add files and Delete. After any of them
// the pages' data is fetched again, so every list shows the change.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { FILES, sendFiles } from '../lib/files.ts';
import { sayFor, type Line } from '../lib/say.ts';
import type { Note } from '../lib/types.ts';
import { ErrorLine, LineText, useBusy, useFocusLater, useProblem } from './common.tsx';
import { NoteBody, NoteMedia, NoteMeta } from './notes.tsx';

export function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries();
}

interface ListProps {
  day: string;
  notes: Note[];
  tz: string;
  version: string;
}

export function NoteList({ day, notes, tz, version }: ListProps) {
  return (
    <div className="notes" id="notes">
      {notes.map((n) => (
        <NoteItem key={n.id} day={day} n={n} tz={tz} version={version} />
      ))}
    </div>
  );
}

type Mode = { is: 'view' } | { is: 'edit' } | { is: 'ask' } | { is: 'files'; line: Line; done: boolean };

function NoteItem({ day, n, tz, version }: { day: string; n: Note; tz: string; version: string }) {
  const [mode, setMode] = useState<Mode>({ is: 'view' });
  const refresh = useRefresh();
  const pick = useRef<HTMLInputElement>(null);
  const path = `/api/days/${day}/notes/${encodeURIComponent(n.id)}`;

  // Photos, recordings or PDFs from this device, after the note's own.
  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    setMode({ is: 'files', line: '', done: false });
    const out = await sendFiles(files, (t) => setMode({ is: 'files', line: t, done: false }));
    const r = out.problem ? null : await api('POST', `${path}/media`, { uploads: out.sent });
    if (r && r.ok) {
      await refresh();
      setMode({ is: 'view' });
      return;
    }
    setMode({ is: 'files', line: sayFor(out.problem || r!.data), done: true });
  };

  return (
    <article className="note">
      <NoteMeta n={n} tz={tz} cls="meta" />
      {mode.is === 'edit' ? <EditForm path={path} n={n} onDone={() => setMode({ is: 'view' })} /> : <NoteBody n={n} />}
      <NoteMedia day={day} n={n} version={version} />
      <div className="actions" hidden={mode.is === 'edit'}>
        {mode.is === 'view' && (
          <>
            <button className="quiet" type="button" onClick={() => setMode({ is: 'edit' })}>
              Edit
            </button>
            <button className="quiet" type="button" onClick={() => pick.current?.click()}>
              Add files
            </button>
            <button className="quiet" type="button" onClick={() => setMode({ is: 'ask' })}>
              Delete
            </button>
          </>
        )}
        {mode.is === 'ask' && <AskDelete n={n} path={path} onKeep={() => setMode({ is: 'view' })} />}
        {mode.is === 'files' && (
          <>
            <span className="confirm" role="status">
              <LineText line={mode.line} />
            </span>
            {mode.done && (
              <button className="quiet" type="button" onClick={() => setMode({ is: 'view' })}>
                OK
              </button>
            )}
          </>
        )}
      </div>
      <input
        ref={pick}
        type="file"
        multiple
        accept={FILES}
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files || [])];
          e.currentTarget.value = '';
          addFiles(files);
        }}
      />
    </article>
  );
}

function EditForm({ path, n, onDone }: { path: string; n: Note; onDone: () => void }) {
  const [text, setText] = useState(n.text);
  const [busy, run] = useBusy();
  const problem = useProblem();
  const area = useRef<HTMLTextAreaElement>(null);
  const refresh = useRefresh();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      problem.clear();
      const r = await api('PUT', path, { text });
      if (!r.ok) return problem.show({ ...r.data, draft: 'copy' }, area.current);
      await refresh();
      onDone();
    });
  };
  return (
    <form className="edit" noValidate onSubmit={submit}>
      <textarea
        ref={area}
        name="text"
        autoFocus
        rows={Math.min(12, Math.max(3, n.text.split('\n').length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Edit this note"
      />
      <div className="row">
        <button className="go small" type="submit" disabled={busy}>
          Save
        </button>
        <button className="quiet" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorLine line={problem.line} />
    </form>
  );
}

function AskDelete({ n, path, onKeep }: { n: Note; path: string; onKeep: () => void }) {
  const files = !!(n.media && n.media.length);
  const question =
    n.source === 'email'
      ? files
        ? 'Delete this note and the email it came in, with its photos and recordings?'
        : 'Delete this note and the email it came in?'
      : files
        ? 'Delete this note, with its photos and recordings?'
        : 'Delete this note?';
  const [line, setLine] = useState<Line>(question);
  const [busy, setBusy] = useState(false);
  const yes = useRef<HTMLButtonElement>(null);
  const focusLater = useFocusLater();
  const refresh = useRefresh();
  return (
    <>
      <span className="confirm">
        <LineText line={line} />
      </span>
      <button
        ref={yes}
        className="quiet danger"
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const r = await api('DELETE', path);
          if (!r.ok && r.status !== 404) {
            setBusy(false);
            setLine(sayFor(r.data, 'That didn’t work. Try again.'));
            focusLater(() => yes.current);
            return;
          }
          await refresh();
        }}
      >
        Delete
      </button>
      <button className="quiet" type="button" onClick={onKeep}>
        Keep it
      </button>
    </>
  );
}
