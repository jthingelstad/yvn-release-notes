// A day's notes, each with Edit, Add files and Delete. An edit shows its
// new words at once and a deleted note goes at once; a write that fails
// puts the note back as it was, saying why. After any of them the pages'
// data is fetched again, so every list shows the change.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { FILES, sendFiles } from '../lib/files.ts';
import { isPending } from '../lib/notecache.ts';
import { sayFor, type Line, type Problem } from '../lib/say.ts';
import type { Note } from '../lib/types.ts';
import { ErrorLine, LineText, useFocusLater } from './common.tsx';
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

type Mode =
  | { is: 'view' }
  | { is: 'edit'; draft?: string; problem?: Problem }
  | { is: 'saving'; text: string }
  | { is: 'ask'; line?: Line }
  | { is: 'deleting' }
  | { is: 'files'; line: Line; done: boolean };

function NoteItem({ day, n, tz, version }: { day: string; n: Note; tz: string; version: string }) {
  const [mode, setMode] = useState<Mode>({ is: 'view' });
  const refresh = useRefresh();
  const pick = useRef<HTMLInputElement>(null);
  const article = useRef<HTMLElement>(null);
  const focusLater = useFocusLater();
  const path = `/api/days/${day}/notes/${encodeURIComponent(n.id)}`;

  // Written here a moment ago and not yet saved: the words alone.
  if (isPending(n)) {
    return (
      <article className="note pending">
        <p className="meta" role="status">
          Saving…
        </p>
        <NoteBody n={n} />
      </article>
    );
  }

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

  // The new words show while they save; a failure opens the edit again,
  // with them in it.
  const save = async (text: string) => {
    setMode({ is: 'saving', text });
    const r = await api('PUT', path, { text });
    if (!r.ok) return setMode({ is: 'edit', draft: text, problem: { ...r.data, draft: 'copy' } });
    await refresh();
    setMode({ is: 'view' });
  };

  // Gone from the list at once, focus on to the next note (or the form).
  // A failure brings it back, asking again.
  const remove = async () => {
    const next =
      article.current?.nextElementSibling?.querySelector<HTMLElement>('.actions button') ||
      document.querySelector<HTMLElement>('#note-form textarea');
    setMode({ is: 'deleting' });
    focusLater(() => next);
    const r = await api('DELETE', path);
    if (r.ok || r.status === 404) return refresh();
    setMode({ is: 'ask', line: sayFor(r.data, 'That didn’t work. Try again.') });
  };

  const shown = mode.is === 'saving' ? { ...n, text: mode.text, parts: undefined } : n;
  return (
    <article className="note" ref={article} hidden={mode.is === 'deleting'}>
      <NoteMeta n={n} tz={tz} cls="meta" />
      {mode.is === 'edit' ? (
        <EditForm
          n={n}
          draft={mode.draft}
          problem={mode.problem}
          onSave={save}
          onCancel={() => setMode({ is: 'view' })}
        />
      ) : (
        <NoteBody n={shown} />
      )}
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
        {mode.is === 'saving' && (
          <span className="confirm" role="status">
            Saving…
          </span>
        )}
        {mode.is === 'ask' && (
          <AskDelete n={n} line={mode.line} onDelete={remove} onKeep={() => setMode({ is: 'view' })} />
        )}
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

function EditForm({
  n,
  draft,
  problem: failed,
  onSave,
  onCancel
}: {
  n: Note;
  draft?: string;
  problem?: Problem;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(draft ?? n.text);
  const area = useRef<HTMLTextAreaElement>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave(text);
  };
  return (
    <form className="edit" noValidate onSubmit={submit}>
      <textarea
        ref={area}
        name="text"
        autoFocus
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Edit this note"
      />
      <div className="row">
        <button className="go small" type="submit">
          Save
        </button>
        <button className="quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <ErrorLine line={failed ? sayFor(failed) : null} />
    </form>
  );
}

function AskDelete({ n, line, onDelete, onKeep }: { n: Note; line?: Line; onDelete: () => void; onKeep: () => void }) {
  const files = !!(n.media && n.media.length);
  const question =
    n.source === 'email'
      ? files
        ? 'Delete this note and the email it came in, with its photos and recordings?'
        : 'Delete this note and the email it came in?'
      : files
        ? 'Delete this note, with its photos and recordings?'
        : 'Delete this note?';
  return (
    <>
      <span className="confirm" role={line ? 'alert' : undefined}>
        <LineText line={line || question} />
      </span>
      {/* Asked again after a failure: focus on Delete, to try again. */}
      <button className="quiet danger" type="button" autoFocus={!!line} onClick={onDelete}>
        Delete
      </button>
      <button className="quiet" type="button" onClick={onKeep}>
        Keep it
      </button>
    </>
  );
}
