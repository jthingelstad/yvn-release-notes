/** Feedback, filed and answered (packages/domain/feedback.ts has the model).
 * The web page, the private capture function (an assistant's
 * notes_send_feedback) and the administrator's answers all go through here,
 * so every door files the same record with the same checks:
 *
 * - Filing checks the words, decodes and strips any screenshots
 *   (inline-images.ts), refuses past the account's daily count before any
 *   file is stored, stores the screenshots under media/<owner>/feedback/,
 *   then commits the row, the count, the item it follows and the proof
 *   together. A failed commit removes the files it stored where the caller
 *   can (the web can; the capture function, which may only add files, leaves
 *   them for the account's deletion to sweep).
 * - Answering appends one answer with the status it sets, then mails the
 *   filer once, only while their account is active, and records both in the
 *   activity log. A failed email never undoes the answer.
 *
 * Nothing here logs the words of an item or an answer, or an address. */
import { randomBytes } from 'node:crypto';
import { iso, localDay } from '../domain/dates.ts';
import {
  ANSWERS_MAX,
  FEEDBACK_A_DAY,
  SCREENSHOTS_MAX,
  newestFirst,
  type AnswerStatus,
  type FeedbackItem,
  type FeedbackKind,
  type FeedbackScreenshot
} from '../domain/feedback.ts';
import { feedbackAnswerMessage } from '../mail/compose.ts';
import { recordActivity } from './activity.ts';
import { INLINE_TYPES, type InlineImage } from './inline-images.ts';
import type { Mail, Objects } from './services.ts';
import type { Store } from './store.ts';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Log = (fields: Record<string, string | number | boolean>) => void;
export type FeedbackStore = Pick<
  Store,
  'feedbackItems' | 'feedbackItem' | 'feedbackFiled' | 'fileFeedback' | 'answerFeedback' | 'putActivity' | 'mcpProfile'
>;
export type FeedbackObjects = Pick<Objects, 'put'> & Partial<Pick<Objects, 'remove'>>;

/** Where a screenshot is kept: the owner's own media, never a public path. */
export const screenshotKey = (owner: string, id: string, n: number, type: string) =>
  `media/${owner}/feedback/${id}-${n}.${INLINE_TYPES[type] ?? 'bin'}`;
export const newFeedbackId = () => randomBytes(8).toString('hex');
/** The UTC day the daily count is kept by. */
export const feedbackDay = (now: number) => iso(now).slice(0, 10);

export interface Filing {
  kind: FeedbackKind;
  text: string;
  follows: string | null;
  screenshots: readonly InlineImage[];
  via: 'web' | 'assistant';
  client?: string | null;
  connection?: string | null;
}
export type FileOutcome =
  { ok: true; item: FeedbackItem } | { ok: false; reason: 'limit' | 'follows' | 'conflict' | 'too-many' };

/** Files one item for `owner`. `proofs` makes an agent's proofs for the item
 * (live grant and account, receipt, audit); the web's session proof is added
 * by its guarded store. */
export async function fileFeedback(
  deps: { store: FeedbackStore; objects: FeedbackObjects; now: number; log?: Log },
  owner: string,
  filing: Filing,
  proofs: ((item: FeedbackItem) => Ops) | null = null,
  id = newFeedbackId()
): Promise<FileOutcome> {
  const { store, objects, now } = deps,
    day = feedbackDay(now),
    at = iso(now);
  if (filing.screenshots.length > SCREENSHOTS_MAX) return { ok: false, reason: 'too-many' };
  if ((await store.feedbackFiled(owner, day)) >= FEEDBACK_A_DAY) return { ok: false, reason: 'limit' };
  if (filing.follows && !(await store.feedbackItem(owner, filing.follows))) return { ok: false, reason: 'follows' };
  const stored: FeedbackScreenshot[] = [];
  try {
    for (const [i, image] of filing.screenshots.entries()) {
      const n = i + 1,
        k = screenshotKey(owner, id, n, image.type);
      await objects.put(k, image.data, { type: image.type, disposition: 'inline' });
      stored.push({
        n,
        type: image.type,
        size: image.data.length,
        ...(image.width ? { width: image.width, height: image.height } : {}),
        key: k
      });
    }
    const item: FeedbackItem = {
      id,
      kind: filing.kind,
      text: filing.text,
      status: 'open',
      follows: filing.follows,
      via: filing.via,
      ...(filing.via === 'assistant' ? { client: filing.client ?? null, connection: filing.connection ?? null } : {}),
      filed_at: at,
      updated_at: at,
      revision: 1,
      answers: [],
      screenshots: stored
    } as FeedbackItem;
    if (!(await store.fileFeedback(owner, item, day, proofs ? proofs(item) : null))) {
      await forget(objects, stored);
      // Which condition failed: the count, the item followed, or the account.
      if ((await store.feedbackFiled(owner, day)) >= FEEDBACK_A_DAY) return { ok: false, reason: 'limit' };
      if (filing.follows && !(await store.feedbackItem(owner, filing.follows))) return { ok: false, reason: 'follows' };
      return { ok: false, reason: 'conflict' };
    }
    await recordActivity(
      store,
      owner,
      now,
      [
        {
          kind: 'feedback.filed',
          id,
          fields: {
            via: filing.via,
            ...(filing.via === 'assistant' && filing.client ? { client: filing.client } : {}),
            feedback: id,
            feedback_kind: filing.kind,
            ...(filing.follows ? { follows: filing.follows } : {}),
            screenshots: stored.length
          }
        }
      ],
      deps.log
    );
    deps.log?.({ event: 'feedback', user: owner, action: 'filed', via: filing.via, screenshots: stored.length });
    return { ok: true, item };
  } catch (error) {
    await forget(objects, stored);
    throw error;
  }
}
async function forget(objects: FeedbackObjects, stored: readonly FeedbackScreenshot[]) {
  if (!objects.remove) return;
  for (const s of stored)
    try {
      await objects.remove(s.key);
    } catch {
      /* The account's deletion sweeps whatever is left. */
    }
}

/** Every account's feedback, newest first, with who filed it: the
 * administrator's queue. `open` keeps only items still waiting or with a
 * question asked. */
export async function feedbackQueue(
  store: Pick<Store, 'accountStates' | 'feedbackItems'>,
  { open = false }: { open?: boolean } = {}
): Promise<{ owner: string; email: string | null; status: string | null; item: FeedbackItem }[]> {
  const queue: { owner: string; email: string | null; status: string | null; item: FeedbackItem }[] = [];
  for (const account of await store.accountStates()) {
    const items = (await store.feedbackItems(account.owner)).filter(
      (i) => !open || i.status === 'open' || i.status === 'needs_info'
    );
    for (const item of items)
      queue.push({
        owner: account.owner,
        email: account.email,
        status: account.deleting ? 'deleting' : account.status,
        item
      });
  }
  return queue.sort((a, b) => newestFirst(a.item, b.item));
}

export type AnswerOutcome =
  | { ok: true; item: FeedbackItem; mail: 'sent' | 'failed' | 'not-sent' }
  | { ok: false; reason: 'missing' | 'changed' | 'full' };

/** One answer from the administrator, then one email to the filer while
 * their account is active. */
export async function answerFeedback(
  deps: { store: FeedbackStore; mail: Mail; from: string; now: number; log?: Log },
  owner: string,
  id: string,
  revision: number,
  answer: { text: string; status: AnswerStatus },
  admin: { user: string; email: string } | null
): Promise<AnswerOutcome> {
  const { store, now } = deps,
    item = await store.feedbackItem(owner, id);
  if (!item) return { ok: false, reason: 'missing' };
  if (item.revision !== revision) return { ok: false, reason: 'changed' };
  if (item.answers.length >= ANSWERS_MAX) return { ok: false, reason: 'full' };
  const entry = { at: iso(now), text: answer.text, status: answer.status };
  if (!(await store.answerFeedback(owner, id, revision, entry, admin))) {
    const now2 = await store.feedbackItem(owner, id);
    return { ok: false, reason: now2 ? 'changed' : 'missing' };
  }
  const answered: FeedbackItem = {
    ...item,
    answers: [...item.answers, entry],
    status: answer.status,
    updated_at: entry.at,
    revision: revision + 1
  };
  const profile = await store.mcpProfile(owner);
  let mail: 'sent' | 'failed' | 'not-sent' = 'not-sent';
  if (profile && profile.status === 'active' && !profile.mcp_deleting && profile.email)
    try {
      const raw = await feedbackAnswerMessage({
        to: String(profile.email),
        fromAddr: deps.from,
        kind: item.kind,
        filed: localDay(Date.parse(item.filed_at) / 1000, String(profile.tz ?? 'UTC')),
        status: answer.status,
        answer: answer.text
      });
      await deps.mail.send(raw, String(profile.email), 'account');
      mail = 'sent';
    } catch {
      mail = 'failed';
    }
  await recordActivity(
    store,
    owner,
    now,
    [
      {
        kind: 'feedback.answered',
        id: `${id}.${answered.answers.length}`,
        fields: { via: 'admin', feedback: id, status: answer.status, mail }
      }
    ],
    deps.log
  );
  deps.log?.({ event: 'feedback', user: owner, action: 'answered', status: answer.status, mail });
  return { ok: true, item: answered, mail };
}
