/** Feedback from the operator's side (packages/backend/feedback.ts), so Claude
 * can work through the queue and answer (Jamie, 2026-10-28: "Claude could
 * work on those and post a reply to the feedback as well").
 *
 *   list [--all]                       the queue, newest first: waiting items, or every item
 *   show <owner> <id> [--screenshots DIR]
 *                                      one item in full; its screenshots saved to DIR (a new
 *                                      temporary directory when DIR is not given)
 *   answer <owner> <id> --status S --text T [--write]
 *                                      appends one answer (answered, needs_info or done) and
 *                                      emails the filer once while their account is active
 *
 * `answer` is a dry run unless --write, and every live --write needs Jamie's
 * go like any operator write (AGENTS.md, Operating). Output names accounts
 * by id, never by address; screenshots are written only to this Mac. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { answerFeedback, feedbackQueue, type FeedbackStore } from '../packages/backend/feedback.ts';
import type { BadgeStore } from '../packages/backend/badges.ts';
import { createMail } from '../packages/backend/aws.ts';
import { INLINE_TYPES } from '../packages/backend/inline-images.ts';
import { answerFields, feedbackView } from '../packages/domain/feedback.ts';
import type { Mail, Objects } from '../packages/backend/services.ts';
import type { Store } from '../packages/backend/store.ts';
import { argumentsFor, writing, invoked, launch, runtime, OperatorError, REGION, TABLE } from './operator.ts';

/** The stack's sending address and SES configuration set (infra/template.yaml). */
export const FROM = 'notes@yourversionnumber.com',
  CONFIGURATION_SET = TABLE;
const ID = /^[0-9a-f]{16}$/,
  OWNER = /^[A-Za-z0-9_-]+$/;
const USAGE =
  'tools/feedback.ts list [--all] | show <owner> <id> [--screenshots DIR] | answer <owner> <id> --status S --text T [--write]';

export async function list(store: Pick<Store, 'accountStates' | 'feedbackItems'>, all = false) {
  return (await feedbackQueue(store, { open: !all })).map((q) => ({
    owner: q.owner,
    account: q.status,
    ...feedbackView(q.item)
  }));
}

export async function show(
  store: Pick<Store, 'feedbackItem'>,
  objects: Pick<Objects, 'get'>,
  owner: string,
  id: string,
  dir: string | null
) {
  const item = await store.feedbackItem(owner, id);
  if (!item) throw new OperatorError('No such feedback');
  const saved: string[] = [];
  if (item.screenshots.length) {
    const target = dir ? resolve(dir) : await mkdtemp(join(tmpdir(), 'rn-feedback-'));
    await mkdir(target, { recursive: true });
    for (const s of item.screenshots) {
      if (!s.key.startsWith(`media/${owner}/feedback/`)) continue;
      const path = join(target, `${id}-${s.n}.${INLINE_TYPES[s.type] ?? 'bin'}`);
      await writeFile(path, (await objects.get(s.key, { maxBytes: 2 * 1024 * 1024 })).body, { mode: 0o600 });
      saved.push(path);
    }
  }
  return { owner, ...feedbackView(item), saved };
}

export async function answer(
  deps: { store: FeedbackStore & BadgeStore; mail: Mail; now: number },
  owner: string,
  id: string,
  value: { text: unknown; status: unknown },
  write: boolean
) {
  const fields = answerFields(value);
  if (typeof fields === 'string') throw new OperatorError(`Refused: ${fields}`);
  const item = await deps.store.feedbackItem(owner, id);
  if (!item) throw new OperatorError('No such feedback');
  if (!write)
    return {
      dry_run: true,
      owner,
      id,
      revision: item.revision,
      status: { from: item.status, to: fields.status },
      answers: item.answers.length + 1
    };
  const outcome = await answerFeedback(
    { store: deps.store, mail: deps.mail, from: FROM, now: deps.now, badges: deps.store },
    owner,
    id,
    item.revision,
    fields,
    null
  );
  if (!outcome.ok) throw new OperatorError(`Not answered: ${outcome.reason}`);
  return {
    dry_run: false,
    owner,
    id,
    status: outcome.item.status,
    revision: outcome.item.revision,
    mail: outcome.mail
  };
}

export async function main(args: string[]) {
  const { positionals, values } = argumentsFor(args, {
    all: { type: 'boolean', default: false },
    screenshots: { type: 'string' },
    status: { type: 'string' },
    text: { type: 'string' }
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const [command, owner, id] = positionals;
  if (command === 'list' && positionals.length === 1) {
    const { store } = await runtime(false);
    console.log(JSON.stringify(await list(store, values.all === true), null, 2));
    return;
  }
  if (!owner || !id || !OWNER.test(owner) || !ID.test(id) || positionals.length !== 3)
    throw new OperatorError('Usage: ' + USAGE);
  if (command === 'show') {
    const { store, objects } = await runtime(false);
    console.log(
      JSON.stringify(await show(store, objects, owner, id, (values.screenshots as string | undefined) ?? null), null, 2)
    );
    return;
  }
  if (command === 'answer') {
    const write = writing(values),
      { store } = await runtime(write);
    console.log(
      JSON.stringify(
        await answer(
          { store, mail: createMail(FROM, CONFIGURATION_SET, REGION), now: Date.now() / 1000 },
          owner,
          id,
          { text: values.text, status: values.status },
          write
        )
      )
    );
    return;
  }
  throw new OperatorError('Usage: ' + USAGE);
}
if (invoked(import.meta.url)) await launch(main);
