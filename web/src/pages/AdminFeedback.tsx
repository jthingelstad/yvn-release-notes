// The administrator's feedback queue: every account's items, newest first,
// with who sent them, and one answer at a time with the status it sets. The
// API checks the administrator on every request; an answer emails the filer
// only while their account is active.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Bar, ErrorLine, Loading, useBusy, useTitle } from '../components/common.tsx';
import { AdminNav } from '../components/admin-nav.tsx';
import { api, get, ApiError } from '../lib/api.ts';
import { meQuery } from '../lib/queries.ts';
import type { FeedbackView } from '../lib/types.ts';
import { ANSWER_STATUSES, ANSWER_TEXT_MAX } from '../../../packages/domain/feedback.ts';
import { Item } from './Feedback.tsx';

type Queued = FeedbackView & { owner: string; email: string | null; account: string | null };
const key = ['admin-feedback'];
const PROBLEMS: Record<string, string> = {
  'admin-only': 'This page is only for the Release Notes administrator.',
  'feedback-text': 'Write an answer.',
  'feedback-too-long': `Keep the answer under ${ANSWER_TEXT_MAX.toLocaleString('en-US')} characters.`,
  'feedback-status': 'Choose a status.',
  'feedback-changed': 'This item changed in another window. Reload the queue and try again.',
  'feedback-full': 'This item has as many answers as it can hold.',
  'feedback-missing': 'This item is gone; its account may have been deleted.'
};
// What each answer does to the item, as the administrator picks it.
const SETS: Record<(typeof ANSWER_STATUSES)[number], string> = {
  answered: 'Answered',
  needs_info: 'Ask them something',
  done: 'Done'
};
const MAIL: Record<string, string> = {
  sent: 'Answered, and emailed.',
  'not-sent': 'Answered. No email: the account isn’t receiving email.',
  failed: 'Answered, but the email failed. The answer shows on their Feedback page.'
};

export function AdminFeedback() {
  useTitle('Feedback queue');
  const queue = useQuery({ queryKey: key, queryFn: () => get<{ items: Queued[] }>('/api/admin/feedback') });
  const tz = useQuery(meQuery).data?.tz ?? 'UTC';
  const [open, setOpen] = useState(true);
  const items = (queue.data?.items ?? []).filter((i) => !open || i.status === 'open' || i.status === 'needs_info');
  return (
    <>
      <Bar />
      <h1>Feedback</h1>
      <p className="lede">What subscribers and their assistants have sent, newest first.</p>
      <AdminNav current="feedback" />
      {queue.isPending ? (
        <Loading />
      ) : queue.isError ? (
        <ErrorLine
          line={
            queue.error instanceof ApiError && queue.error.answer.status === 403
              ? PROBLEMS['admin-only']!
              : 'Couldn’t load feedback. Please reload and try again.'
          }
        />
      ) : (
        <section className="section" aria-label="Feedback queue">
          <label className="row">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Only items waiting
          </label>
          {!items.length && <p className="hint">Nothing waiting.</p>}
          <ul className="feedback-list">
            {items.map((item) => (
              <Item key={`${item.owner}/${item.id}`} item={item} tz={tz} base={`/api/admin/feedback/${item.owner}`}>
                <p className="hint">
                  {item.email ?? 'No address'}
                  {item.account && item.account !== 'active' ? ` · ${item.account}` : ''}
                </p>
                <Answer item={item} />
              </Item>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Answer({ item }: { item: Queued }) {
  const [text, setText] = useState(''),
    [status, setStatus] = useState<(typeof ANSWER_STATUSES)[number]>('answered');
  const [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const [busy, run] = useBusy(),
    client = useQueryClient();
  const send = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      setProblem(null);
      setNotice('');
      const answer = await api<{ mail: string }>('POST', `/api/admin/feedback/${item.owner}/${item.id}/answers`, {
        text,
        status,
        revision: item.revision
      });
      await client.invalidateQueries({ queryKey: key });
      if (!answer.ok) {
        setProblem(PROBLEMS[answer.data.error ?? ''] ?? 'Couldn’t save the answer. Please try again.');
        return;
      }
      setText('');
      setNotice(MAIL[answer.data.mail] ?? 'Answered.');
    });
  };
  return (
    <form className="roomy" onSubmit={send} aria-label="Answer">
      <label>
        Answer
        <textarea required rows={4} value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <label>
        Status
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {ANSWER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {SETS[s]}
            </option>
          ))}
        </select>
      </label>
      <ErrorLine line={problem} />
      {notice && (
        <p className="hint" role="status">
          {notice}
        </p>
      )}
      <button className="go" type="submit" disabled={busy}>
        Answer and email
      </button>
    </form>
  );
}
