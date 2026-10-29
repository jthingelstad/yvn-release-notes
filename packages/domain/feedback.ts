/** Feedback (Jamie, 2026-10-28: "a way users could submit feedback of a type,
 * and then Claude could work on those and post a reply to the feedback as
 * well"), on the model of Elixir's: one store with a kind, from every door
 * (the web page and an assistant), signed in only; one administrator's
 * queue, and only the administrator answers. An item is never edited or
 * withdrawn: a correction or an answer to a question is a new item that
 * follows it (`follows`). The filer sets no severity. Answers are append-only:
 * each is its own entry with the status it set, and the filer is mailed once
 * per answer.
 *
 * Rows live at USER#<owner> / FEEDBACK#<id> (packages/backend/store.ts): the
 * owner's own data, in the export and gone with the account. Screenshots
 * (Jamie, 2026-10-28: "a user or agent submitting feedback can attach a
 * screenshot") are private files under media/<owner>/feedback/, shown by
 * signed links only; a view never carries their keys. */
import { codePointLength, pythonTrim } from './unicode.ts';

export const FEEDBACK_KINDS = ['bug', 'idea', 'question', 'other'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
/** open until answered; needs_info asks the filer a question, answered by a
 * follow-up item; done closes it. */
export const FEEDBACK_STATUSES = ['open', 'answered', 'needs_info', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const ANSWER_STATUSES = ['answered', 'needs_info', 'done'] as const;
export type AnswerStatus = (typeof ANSWER_STATUSES)[number];
export const FEEDBACK_TEXT_MAX = 4000,
  ANSWER_TEXT_MAX = 4000,
  /** Items an account files a UTC day, from every door together. */
  FEEDBACK_A_DAY = 10,
  /** Answers one item can hold. */
  ANSWERS_MAX = 20,
  SCREENSHOTS_MAX = 3;
export const FEEDBACK_KIND_NAMES: Record<FeedbackKind, string> = {
  bug: 'Something’s wrong',
  idea: 'An idea',
  question: 'A question',
  other: 'Something else'
};
export const FEEDBACK_STATUS_NAMES: Record<FeedbackStatus, string> = {
  open: 'Waiting for Jamie',
  answered: 'Answered',
  needs_info: 'Jamie asked you something',
  done: 'Done'
};

export interface FeedbackScreenshot {
  n: number;
  type: string;
  size: number;
  width?: number;
  height?: number;
  key: string;
}
export interface FeedbackAnswer {
  at: string;
  text: string;
  status: AnswerStatus;
}
export interface FeedbackItem {
  id: string;
  kind: FeedbackKind;
  text: string;
  status: FeedbackStatus;
  follows: string | null;
  via: 'web' | 'assistant';
  client?: string | null;
  filed_at: string;
  updated_at: string;
  revision: number;
  answers: FeedbackAnswer[];
  screenshots: FeedbackScreenshot[];
}

export const feedbackKey = (id: string) => `FEEDBACK#${id}`;
/** A UTC day's filing count, from every door. */
export const feedbackRateKey = (day: string) => `FEEDBACKRATE#${day}`;

/** What a filer sends, checked: a kind, the words (trimmed, at most
 * FEEDBACK_TEXT_MAX code points) and the item it follows, if any. Null for
 * a field that is wrong, with the field's name. */
export function feedbackFields(
  value: Record<string, unknown>
): { kind: FeedbackKind; text: string; follows: string | null } | string {
  if (!FEEDBACK_KINDS.includes(value.kind as FeedbackKind)) return 'kind';
  if (typeof value.text !== 'string') return 'text';
  const text = pythonTrim(value.text.replace(/\r\n?/g, '\n'));
  if (!text) return 'text';
  if (codePointLength(text) > FEEDBACK_TEXT_MAX) return 'too-long';
  const follows = value.follows ?? null;
  if (follows !== null && (typeof follows !== 'string' || !/^[0-9a-f]{16}$/.test(follows))) return 'follows';
  return { kind: value.kind as FeedbackKind, text, follows };
}
/** An administrator's answer, checked the same way. */
export function answerFields(value: Record<string, unknown>): { text: string; status: AnswerStatus } | string {
  if (!ANSWER_STATUSES.includes(value.status as AnswerStatus)) return 'status';
  if (typeof value.text !== 'string') return 'text';
  const text = pythonTrim(value.text.replace(/\r\n?/g, '\n'));
  if (!text) return 'text';
  if (codePointLength(text) > ANSWER_TEXT_MAX) return 'too-long';
  return { text, status: value.status as AnswerStatus };
}

/** A stored row as an item. */
export function feedbackItem(row: Record<string, unknown>): FeedbackItem {
  return {
    id: String(row.id),
    kind: row.kind as FeedbackKind,
    text: String(row.text ?? ''),
    status: (row.status as FeedbackStatus) ?? 'open',
    follows: typeof row.follows === 'string' ? row.follows : null,
    via: row.via === 'assistant' ? 'assistant' : 'web',
    client: typeof row.client === 'string' ? row.client : null,
    filed_at: String(row.filed_at),
    updated_at: String(row.updated_at ?? row.filed_at),
    revision: Number(row.revision ?? 1),
    answers: Array.isArray(row.answers) ? (row.answers as FeedbackAnswer[]) : [],
    screenshots: Array.isArray(row.screenshots) ? (row.screenshots as FeedbackScreenshot[]) : []
  };
}
/** An item as its owner, the administrator and an assistant see it: no
 * table keys and no file keys, the screenshots by number. */
export function feedbackView(item: FeedbackItem): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    status: item.status,
    follows: item.follows,
    via: item.via,
    client: item.client ?? null,
    filed_at: item.filed_at,
    updated_at: item.updated_at,
    revision: item.revision,
    answers: item.answers.map((a) => ({ at: a.at, text: a.text, status: a.status })),
    screenshots: item.screenshots.map((s) => ({
      n: s.n,
      type: s.type,
      size: s.size,
      ...(s.width ? { width: s.width, height: s.height } : {})
    }))
  };
}
/** Newest first. */
export const newestFirst = (a: FeedbackItem, b: FeedbackItem) =>
  a.filed_at < b.filed_at ? 1 : a.filed_at > b.filed_at ? -1 : a.id < b.id ? 1 : -1;
