// Feedback to Jamie (packages/backend/feedback.ts): a kind, the words and up
// to three screenshots, made ready in the browser (lib/screenshots.ts). Each
// item lists Jamie's answers; a follow-up is a new item that points back.
// Nothing filed is edited or withdrawn.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent } from 'react';
import { Bar, ErrorLine, Loading, useBusy, useTitle } from '../components/common.tsx';
import { Icon } from '../components/icon.tsx';
import { api, get } from '../lib/api.ts';
import { meQuery } from '../lib/queries.ts';
import { prepare, type Ready } from '../lib/screenshots.ts';
import { zoneShortDate } from '../lib/format.ts';
import type { FeedbackView } from '../lib/types.ts';
import {
  FEEDBACK_KIND_NAMES,
  FEEDBACK_KINDS,
  FEEDBACK_STATUS_NAMES,
  FEEDBACK_TEXT_MAX
} from '../../../packages/domain/feedback.ts';

interface List {
  items: FeedbackView[];
  filed_today: number;
  per_day: number;
  screenshots_max: number;
  screenshot_bytes: number;
}
const key = ['feedback'];
const PROBLEMS: Record<string, string> = {
  'feedback-kind': 'Choose what kind of feedback this is.',
  'feedback-text': 'Say what happened, or what you would like.',
  'feedback-too-long': `Keep it under ${FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters.`,
  'feedback-follows': 'The feedback this follows is gone. Send it on its own.',
  'feedback-limit': 'That’s the most feedback for one day. Try again tomorrow.',
  'feedback-image-count': 'Attach at most three screenshots.',
  'feedback-image-type': 'Attach a PNG, JPEG or WebP screenshot.',
  'feedback-image-data': 'One of the screenshots couldn’t be read. Remove it and attach it again.',
  'feedback-image-too-big': 'One of the screenshots is too big. Crop it and attach it again.',
  'feedback-conflict': 'Couldn’t send that. Please try again.'
};

export function Feedback() {
  useTitle('Feedback');
  const list = useQuery({ queryKey: key, queryFn: () => get<List>('/api/feedback') });
  const tz = useQuery(meQuery).data?.tz ?? 'UTC';
  const [kind, setKind] = useState<FeedbackView['kind']>('bug'),
    [text, setText] = useState(''),
    [follows, setFollows] = useState<FeedbackView | null>(null),
    [shots, setShots] = useState<Ready[]>([]);
  const [problem, setProblem] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const [busy, run] = useBusy(),
    client = useQueryClient(),
    form = useRef<HTMLFormElement>(null),
    picker = useRef<HTMLInputElement>(null);
  const max = list.data?.screenshots_max ?? 3,
    left = list.data ? list.data.per_day - list.data.filed_today : 1;

  async function attach(files: FileList | null) {
    setProblem(null);
    const room = max - shots.length,
      chosen = [...(files ?? [])].slice(0, Math.max(0, room)),
      ready: Ready[] = [];
    for (const file of chosen) {
      const r = await prepare(file, list.data?.screenshot_bytes ?? 768 * 1024);
      if (r === 'open') setProblem('This browser couldn’t open that picture. Attach a PNG or JPEG screenshot.');
      else if (r === 'too-big') setProblem(PROBLEMS['feedback-image-too-big']!);
      else ready.push(r);
    }
    if ((files?.length ?? 0) > room) setProblem(PROBLEMS['feedback-image-count']!);
    setShots((s) => [...s, ...ready].slice(0, max));
    if (picker.current) picker.current.value = '';
  }
  function followUp(item: FeedbackView) {
    setFollows(item);
    setKind(item.status === 'needs_info' ? 'other' : item.kind);
    setNotice('');
    form.current?.scrollIntoView({ block: 'start' });
    form.current?.querySelector('textarea')?.focus();
  }
  const send = (event: FormEvent) => {
    event.preventDefault();
    run(async () => {
      setProblem(null);
      setNotice('');
      const answer = await api<FeedbackView>('POST', '/api/feedback', {
        kind,
        text,
        ...(follows ? { follows: follows.id } : {}),
        screenshots: shots.map((s) => ({ type: s.type, data: s.data }))
      });
      await client.invalidateQueries({ queryKey: key });
      if (!answer.ok) {
        setProblem(
          answer.status === 413
            ? PROBLEMS['feedback-image-too-big']!
            : (PROBLEMS[answer.data.error ?? ''] ?? 'Couldn’t send that. Please try again.')
        );
        return;
      }
      setText('');
      setShots([]);
      setFollows(null);
      setNotice('Sent. Jamie reads every one, and you’ll get an email when there’s an answer.');
    });
  };

  return (
    <>
      <Bar />
      <h1>Feedback</h1>
      <p className="lede">
        Something wrong, an idea or a question? Tell Jamie, who reads every one and answers here and by email.
      </p>
      <form className="roomy" ref={form} onSubmit={send} aria-label="Send feedback">
        {follows && (
          <p className="hint">
            Following up on your {FEEDBACK_KIND_NAMES[follows.kind].toLowerCase()} from{' '}
            {zoneShortDate(follows.filed_at, tz)}.{' '}
            <button className="quiet" type="button" onClick={() => setFollows(null)}>
              Send on its own instead
            </button>
          </p>
        )}
        <label>
          What kind
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value as FeedbackView['kind'])}>
            {FEEDBACK_KINDS.map((k) => (
              <option key={k} value={k}>
                {FEEDBACK_KIND_NAMES[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          What happened, or what you’d like
          <textarea name="text" required rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="hint">
          {Array.from(text).length.toLocaleString('en-US')} / {FEEDBACK_TEXT_MAX.toLocaleString('en-US')} characters
        </p>
        <fieldset className="feedback-shots">
          <legend>Screenshots</legend>
          <ul>
            {shots.map((s, i) => (
              <li key={i}>
                <img src={s.preview} alt={`Screenshot ${i + 1}`} width={96} />
                <button
                  className="quiet icon-button"
                  type="button"
                  aria-label={`Remove screenshot ${i + 1}`}
                  title="Remove"
                  onClick={() => setShots((all) => all.filter((_, j) => j !== i))}
                >
                  <Icon name="delete" />
                </button>
              </li>
            ))}
          </ul>
          {shots.length < max && (
            <label className="quiet">
              Attach a screenshot
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
                multiple
                disabled={busy}
                onChange={(e) => run(() => attach(e.target.files))}
              />
            </label>
          )}
          <p className="hint">
            Up to {max}. They’re kept privately with your account, without their location or other details, and only you
            and Jamie can see them.
          </p>
        </fieldset>
        <ErrorLine line={problem} />
        {notice && (
          <p className="hint" role="status">
            {notice}
          </p>
        )}
        <button className="go" type="submit" disabled={busy || left <= 0}>
          Send to Jamie
        </button>
        {left <= 0 && <p className="hint">{PROBLEMS['feedback-limit']}</p>}
      </form>
      <section className="section" aria-label="Your feedback">
        <h2>What you’ve sent</h2>
        {list.isPending ? (
          <Loading />
        ) : list.isError ? (
          <ErrorLine line="Couldn’t load your feedback. Please reload and try again." />
        ) : !list.data.items.length ? (
          <p className="hint">Nothing yet.</p>
        ) : (
          <ul className="feedback-list">
            {list.data.items.map((item) => (
              <Item key={item.id} item={item} tz={tz} base="/api/feedback" onFollow={() => followUp(item)} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** One item with its answers and screenshot links; the admin queue uses it too. */
export function Item({
  item,
  tz,
  base,
  onFollow,
  children
}: {
  item: FeedbackView;
  tz: string;
  base: string;
  onFollow?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <li className="feedback-item" id={`feedback-${item.id}`}>
      <p className="eyebrow">
        {FEEDBACK_KIND_NAMES[item.kind]} · {zoneShortDate(item.filed_at, tz)}
        {item.via === 'assistant' ? ` · from ${item.client || 'an assistant'}` : ''} ·{' '}
        <span className={`feedback-status feedback-${item.status}`}>{FEEDBACK_STATUS_NAMES[item.status]}</span>
      </p>
      {item.follows && (
        <p className="hint">
          Follows <a href={`#feedback-${item.follows}`}>earlier feedback</a>
        </p>
      )}
      <p className="feedback-words">{item.text}</p>
      {item.screenshots.length > 0 && (
        <p className="row">
          {item.screenshots.map((s) => (
            <a key={s.n} href={`${base}/${item.id}/screenshots/${s.n}`} target="_blank" rel="noreferrer">
              Screenshot {s.n}
            </a>
          ))}
        </p>
      )}
      {item.answers.map((a, i) => (
        <blockquote key={i} className="feedback-answer">
          <p className="eyebrow">Jamie · {zoneShortDate(a.at, tz)}</p>
          <p className="feedback-words">{a.text}</p>
        </blockquote>
      ))}
      {onFollow && (
        <button className="quiet" type="button" onClick={onFollow}>
          {item.status === 'needs_info' ? 'Answer Jamie' : 'Follow up'}
        </button>
      )}
      {children}
    </li>
  );
}
