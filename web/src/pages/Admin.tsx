// The operator's drafts and date slots, protected by the API on every request.
// Saving never schedules; scheduling uses the saved revision shown in preview.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Bar, ErrorLine, Loading, useBusy, useTitle } from '../components/common.tsx';
import { AdminNav } from '../components/admin-nav.tsx';
import { api, get, ApiError } from '../lib/api.ts';
import { addDays } from '../lib/format.ts';
import type { Part } from '../lib/types.ts';
import {
  UPDATE_LABEL,
  UPDATE_TITLE_MAX,
  UPDATE_TEXT_MAX,
  type ProductUpdate
} from '../../../packages/domain/product-updates.ts';

type Update = ProductUpdate & { parts: Part[] };
const key = ['product-updates'];
const PROBLEMS: Record<string, string> = {
  'admin-only': 'This page is only for the Release Notes administrator.',
  'update-text': 'Add a title and some text. Keep the title on one line.',
  'update-too-long': 'Keep the title under 121 characters and the message under 2,001 characters.',
  'update-date': 'Choose today or a future date.',
  'update-conflict':
    'That date is already scheduled, or this draft changed in another window. Reload the list and try again.',
  'update-changed': 'This draft changed in another window. Reload the list before continuing.',
  'update-scheduled': 'Cancel the schedule before editing this update.'
};
const problemFor = (error?: string) => PROBLEMS[error ?? ''] ?? 'Couldn’t save this update. Please try again.';
function Preview({ title, text, parts }: { title: string; text: string; parts?: Part[] }) {
  return (
    <section className="section update-preview" aria-label="Email section preview">
      <p className="eyebrow">{UPDATE_LABEL}</p>
      <h2>{title || 'Your update’s title'}</h2>
      <p className="update-words">
        {parts
          ? parts.map((part, i) =>
              typeof part === 'string' ? (
                part
              ) : 'url' in part ? (
                <a key={i} href={part.url}>
                  {part.label || part.site}
                </a>
              ) : (
                part.text
              )
            )
          : text || 'Your message will appear here.'}
      </p>
    </section>
  );
}
export function Admin() {
  useTitle('Product updates');
  const updates = useQuery({
    queryKey: key,
    queryFn: () => get<{ updates: Update[]; today: string }>('/api/admin/updates')
  });
  const [selected, setSelected] = useState<Update | null>(null);
  const [title, setTitle] = useState(''),
    [text, setText] = useState(''),
    [date, setDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const [busy, run] = useBusy(),
    client = useQueryClient();
  const dirty = title !== (selected?.title ?? '') || text !== (selected?.text ?? '');
  const scheduled = selected?.status === 'scheduled';
  const emailDate = date || (updates.data ? addDays(updates.data.today, 1) : '');
  function choose(update: Update | null) {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return;
    setSelected(update);
    setTitle(update?.title ?? '');
    setText(update?.text ?? '');
    setDate(update?.date ?? addDays(updates.data?.today ?? new Date().toISOString().slice(0, 10), 1));
    setProblem(null);
    setNotice('');
  }
  async function change(method: string, path: string, value: unknown, message: string) {
    setProblem(null);
    setNotice('');
    const answer = await api<Update>(method, path, value);
    await client.invalidateQueries({ queryKey: key });
    if (!answer.ok) {
      setProblem(problemFor(answer.data.error));
      return;
    }
    const update = answer.data.id ? answer.data : null;
    setSelected(update);
    setTitle(update?.title ?? '');
    setText(update?.text ?? '');
    setNotice(message);
  }
  const save = (event: FormEvent) => {
    event.preventDefault();
    run(() =>
      change(
        selected ? 'PUT' : 'POST',
        '/api/admin/updates' + (selected ? '/' + selected.id : ''),
        { title, text, ...(selected ? { revision: selected.revision } : {}) },
        'Draft saved. It will stay out of emails until you schedule it.'
      )
    );
  };
  return (
    <>
      <Bar current="/settings/" />
      <h1>Product updates</h1>
      <p className="lede">Release notes for Release Notes, in everyone’s daily email.</p>
      <AdminNav current="updates" />
      {updates.isPending ? (
        <Loading />
      ) : updates.isError ? (
        <ErrorLine
          line={
            updates.error instanceof ApiError && updates.error.answer.status === 403
              ? PROBLEMS['admin-only']!
              : 'Couldn’t load product updates. Please reload and try again.'
          }
        />
      ) : (
        <>
          <section className="section" aria-label="Saved updates">
            <div className="row">
              <h2>Drafts & scheduled updates</h2>
              <button className="quiet" type="button" disabled={busy} onClick={() => choose(null)}>
                New update
              </button>
            </div>
            {!updates.data?.updates.length && <p className="hint">No updates yet. Write the first one below.</p>}
            <ul className="update-list">
              {updates.data?.updates
                .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at))
                .map((update) => (
                  <li key={update.id}>
                    <button
                      className="quiet"
                      type="button"
                      disabled={busy}
                      aria-pressed={selected?.id === update.id}
                      onClick={() => choose(update)}
                    >
                      {update.title}
                    </button>
                    <span className="hint">{update.status === 'draft' ? 'Draft' : `Scheduled · ${update.date}`}</span>
                  </li>
                ))}
            </ul>
            <button
              className="quiet"
              type="button"
              disabled={busy}
              onClick={() => client.invalidateQueries({ queryKey: key })}
            >
              Reload list
            </button>
          </section>
          <form className="roomy" onSubmit={save}>
            <h2>{scheduled ? 'Scheduled update' : selected ? 'Edit draft' : 'New draft'}</h2>
            <label>
              Title
              <input
                name="title"
                required
                value={title}
                readOnly={scheduled}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <p className="hint">
              {Array.from(title).length} / {UPDATE_TITLE_MAX} characters
            </p>
            <label>
              Message
              <textarea
                name="message"
                required
                rows={7}
                value={text}
                readOnly={scheduled}
                onChange={(e) => setText(e.target.value)}
              />
            </label>
            <p className="hint">
              {Array.from(text).length} / {UPDATE_TEXT_MAX} characters. Plain text only; links get names when saved.
            </p>
            <Preview title={title} text={text} parts={!dirty ? selected?.parts : undefined} />
            {!scheduled && (
              <div className="row">
                <button className="go" type="submit" disabled={busy}>
                  {selected ? 'Save draft' : 'Create draft'}
                </button>
                {selected && (
                  <button
                    className="quiet danger"
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm('Delete this draft?'))
                        run(() =>
                          change(
                            'DELETE',
                            '/api/admin/updates/' + selected.id,
                            { revision: selected.revision },
                            'Draft deleted.'
                          )
                        );
                    }}
                  >
                    Delete draft
                  </button>
                )}
              </div>
            )}
          </form>
          {selected && (
            <section className="section" aria-label="Schedule update">
              <h2>{scheduled ? `Scheduled for ${selected.date}` : 'Choose its day'}</h2>
              <p className="hint">
                It appears near the top of the daily email on this date in each subscriber’s time zone. Paused and
                stopped subscribers get no email. There is no catch-up message.
              </p>
              <p className="hint">
                Scheduling for today reaches only emails still to go out. Cancellation cannot retract an email already
                sent.
              </p>
              {scheduled ? (
                <button
                  className="quiet"
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      change(
                        'DELETE',
                        '/api/admin/updates/' + selected.id + '/schedule',
                        { revision: selected.revision },
                        'Schedule cancelled. Emails already sent keep their update. You can edit this draft again.'
                      )
                    )
                  }
                >
                  Cancel schedule
                </button>
              ) : (
                <form
                  className="roomy"
                  onSubmit={(event) => {
                    event.preventDefault();
                    run(() =>
                      change(
                        'POST',
                        '/api/admin/updates/' + selected.id + '/schedule',
                        { date: emailDate, revision: selected.revision },
                        `Scheduled for ${emailDate} in each subscriber’s daily email.`
                      )
                    );
                  }}
                >
                  <label>
                    Email date
                    <input
                      type="date"
                      required
                      min={updates.data?.today}
                      value={emailDate}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </label>
                  {dirty && <p className="hint">Save your changes before scheduling.</p>}
                  <button className="go" type="submit" disabled={busy || dirty}>
                    Schedule update
                  </button>
                </form>
              )}
            </section>
          )}
          <ErrorLine line={problem} />
          <p role="status" className="hint">
            {notice}
          </p>
        </>
      )}
    </>
  );
}
