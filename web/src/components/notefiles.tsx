// Under a note being edited, its files, each with a Remove that asks first.
// A note with no words keeps its last file: deleting the note is the way.
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { sayFor, type Line } from '../lib/say.ts';
import type { Media, Note } from '../lib/types.ts';
import { LineText } from './common.tsx';

const KIND: Record<Media['kind'], string> = { image: 'Photo', audio: 'Recording', file: 'File' };

export function NoteFiles({ n, path, onRemoved }: { n: Note; path: string; onRemoved: () => unknown }) {
  const [asking, setAsking] = useState<number | null>(null);
  const [line, setLine] = useState<Line>('');
  const files = n.media || [];
  if (!files.length) return null;
  const keeps = files.length === 1 && !(n.text || '').trim();

  const remove = async (file: Media) => {
    setLine('');
    const r = await api('DELETE', `${path}/media/${file.n}`);
    if (!r.ok && r.status !== 404) return setLine(sayFor(r.data, 'That didn’t work. Try again.'));
    setAsking(null);
    await onRemoved();
  };

  return (
    <div className="note-files">
      <ul>
        {files.map((f, i) => (
          <li key={f.n}>
            <span dir="auto">{f.name || `${KIND[f.kind] ?? 'File'} ${i + 1}`}</span>
            {asking === f.n ? (
              <>
                <span className="confirm">
                  {n.source === 'email'
                    ? 'Remove this file? It stays in the email this note came in.'
                    : 'Remove this file?'}
                </span>
                <button className="quiet danger" type="button" autoFocus onClick={() => remove(f)}>
                  Remove
                </button>
                <button className="quiet" type="button" onClick={() => setAsking(null)}>
                  Keep it
                </button>
              </>
            ) : (
              !keeps && (
                <button
                  className="quiet"
                  type="button"
                  aria-label={`Remove ${f.name || `${KIND[f.kind] ?? 'File'} ${i + 1}`}`}
                  onClick={() => setAsking(f.n)}
                >
                  Remove
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {keeps && <p className="confirm">A note with no words keeps its last file. Delete the note instead.</p>}
      {line ? (
        <p className="confirm" role="alert">
          <LineText line={line} />
        </p>
      ) : null}
    </div>
  );
}
