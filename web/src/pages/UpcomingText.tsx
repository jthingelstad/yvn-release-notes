// Every Upcoming date as a line of text (AGENTS.md, Upcoming: "a lot of
// clicking"). Preview parses here, pairs lines with saved dates, and asks the
// API for a dry run; Apply sends the same batch, which commits all or nothing.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { AppLink, Bar, Crumb, Failed, Loading, useBusy, useFocusLater, useTitle } from '../components/common.tsx';
import { api } from '../lib/api.ts';
import { upcomingQuery } from '../lib/queries.ts';
import { NAMES, problemFor } from '../lib/upcoming.ts';
import { UnlockLine } from '../components/unlock.tsx';
import type { Unlocked } from '../lib/types.ts';
import type { UpcomingEntry } from '../../../packages/domain/upcoming.ts';
import {
  batchFor,
  parseUpcomingText,
  planUpcomingText,
  upcomingLine,
  upcomingText,
  type TextPlan,
  type TextProblem
} from '../../../packages/domain/upcoming-text.ts';

type Batch = ReturnType<typeof batchFor>;
interface Preview {
  batch: Batch;
  counts: { add: number; change: number; remove: number };
  plan: { add: UpcomingEntry[]; change: { before: UpcomingEntry; after: UpcomingEntry }[]; remove: string[] };
  removed: UpcomingEntry[];
}
const counted = (c: Preview['counts']) => `add ${c.add}, change ${c.change}, remove ${c.remove}`;

/** Which line a server problem is about, from the list and index it names. */
function lineOf(plan: TextPlan, data: Record<string, unknown>): string {
  const i = typeof data.index === 'number' ? data.index : -1;
  if (data.list === 'add') return plan.add[i] ? ` (line ${plan.add[i].line})` : '';
  if (data.list === 'change') return plan.change[i] ? ` (line ${plan.change[i].line.line})` : '';
  if (data.list === 'remove') return plan.remove[i] ? ` (removing “${plan.remove[i].title}”)` : '';
  return '';
}

export function UpcomingText() {
  useTitle('Edit Upcoming as text');
  const query = useQuery(upcomingQuery),
    client = useQueryClient(),
    [busy, run] = useBusy(),
    focusLater = useFocusLater(),
    [text, setText] = useState<string | null>(null),
    [problems, setProblems] = useState<TextProblem[]>([]),
    [preview, setPreview] = useState<Preview | null>(null),
    [notice, setNotice] = useState(''),
    // What the dates added earned (the Roadmap), under the notice.
    [won, setWon] = useState<Unlocked[]>([]),
    heading = useRef<HTMLHeadingElement>(null),
    entries = query.data?.entries ?? [],
    shown = text ?? upcomingText(entries);

  function edit(next: string) {
    setText(next);
    setPreview(null);
    setProblems([]);
    setNotice('');
    setWon([]);
  }
  async function check() {
    const parsed = parseUpcomingText(shown);
    setPreview(null);
    setNotice('');
    if (parsed.problems.length) return setProblems(parsed.problems);
    const plan = planUpcomingText(parsed.lines, entries),
      batch = batchFor(plan);
    if (!batch.add.length && !batch.change.length && !batch.remove.length) {
      setProblems([]);
      return setNotice('No changes.');
    }
    await run(async () => {
      const answer = await api<{ add: number; change: number; remove: number; plan: Preview['plan'] }>(
        'POST',
        '/api/upcoming/batch',
        { ...batch, dry_run: true }
      );
      if (!answer.ok)
        return setProblems([{ line: 0, problem: problemFor(answer.data.error) + lineOf(plan, answer.data) }]);
      setProblems([]);
      setPreview({
        batch,
        counts: { add: answer.data.add, change: answer.data.change, remove: answer.data.remove },
        plan: answer.data.plan,
        removed: plan.remove
      });
      focusLater(() => heading.current);
    });
  }
  async function apply() {
    if (!preview) return;
    await run(async () => {
      setWon([]);
      const answer = await api<{ add: number; change: number; remove: number; unlocked?: Unlocked[] }>(
        'POST',
        '/api/upcoming/batch',
        preview.batch
      );
      await client.invalidateQueries({ queryKey: upcomingQuery.queryKey });
      if (!answer.ok) {
        setPreview(null);
        return setProblems([{ line: 0, problem: problemFor(answer.data.error) }]);
      }
      setPreview(null);
      setText(null);
      setNotice(`Applied: ${counted(answer.data)}.`);
      setWon(answer.data.unlocked ?? []);
    });
  }
  return (
    <>
      <Bar current="/upcoming/" />
      <Crumb href="/upcoming/">Upcoming</Crumb>
      <h1>Edit Upcoming as text</h1>
      <p className="lede">One date per line. Change, add or delete lines, then preview.</p>
      <p className="hint">
        Start a line with the kind and the date, then the name. Add <code>#tag</code>,{' '}
        <code>@City, Region, Country</code> for a trip, <code>email:off</code> or <code>remind:30,7,0</code> anywhere
        after the name. Deleting a line removes that date. <AppLink href="/upcoming/">Back to Upcoming</AppLink>.
      </p>
      {query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <Failed />
      ) : (
        <section className="upcoming-text">
          <label>
            Upcoming dates as text
            <textarea
              value={shown}
              onChange={(e) => edit(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              rows={Math.min(40, Math.max(12, shown.split('\n').length + 2))}
            />
          </label>
          <div className="row upcoming-toolbar">
            <button className="go" type="button" disabled={busy} onClick={check}>
              Preview changes
            </button>
            <button
              className="quiet"
              type="button"
              disabled={busy}
              onClick={() => {
                setText(null);
                setPreview(null);
                setProblems([]);
                setNotice('Reset to the saved dates.');
              }}
            >
              Start over
            </button>
          </div>
          {problems.length > 0 && (
            <ul className="error upcoming-problems" role="alert">
              {problems.map((p, i) => (
                <li key={i}>{p.line ? `Line ${p.line}: ${p.problem}` : p.problem}</li>
              ))}
            </ul>
          )}
          {notice && (
            <p className="hint" role="status">
              {notice}
            </p>
          )}
          <UnlockLine items={won} />
          {preview && (
            <section className="section upcoming-plan" aria-labelledby="plan-heading">
              <h2 id="plan-heading" ref={heading} tabIndex={-1}>
                Preview: {counted(preview.counts)}
              </h2>
              {preview.plan.add.length > 0 && (
                <>
                  <h3>Add</h3>
                  <ul className="mono-list">
                    {preview.plan.add.map((e, i) => (
                      <li key={i}>{upcomingLine(e)}</li>
                    ))}
                  </ul>
                </>
              )}
              {preview.plan.change.length > 0 && (
                <>
                  <h3>Change</h3>
                  <ul className="mono-list">
                    {preview.plan.change.map((c, i) => (
                      <li key={i}>
                        <del>{upcomingLine(c.before)}</del>
                        <ins>{upcomingLine(c.after)}</ins>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {preview.removed.length > 0 && (
                <>
                  <h3>Remove</h3>
                  <ul className="mono-list">
                    {preview.removed.map((e) => (
                      <li key={e.id}>
                        {NAMES[e.kind]}: {upcomingLine(e)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="row">
                <button className="go" type="button" disabled={busy} onClick={apply}>
                  Apply: {counted(preview.counts)}
                </button>
              </div>
            </section>
          )}
        </section>
      )}
    </>
  );
}
