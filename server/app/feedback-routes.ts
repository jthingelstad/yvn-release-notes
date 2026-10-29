/** Feedback on the web (packages/backend/feedback.ts): a signed-in owner files
 * and reads their own; the configured administrator reads every account's
 * and answers. Screenshots are shown by short signed links only. */
import { reject, type SessionService } from '../../packages/backend/sessions.ts';
import { admin } from '../../packages/backend/product-updates.ts';
import { answerFeedback, feedbackDay, feedbackQueue, fileFeedback } from '../../packages/backend/feedback.ts';
import { InlineImageError, inlineImages, INLINE_IMAGE_BYTES } from '../../packages/backend/inline-images.ts';
import {
  answerFields,
  feedbackFields,
  feedbackView,
  newestFirst,
  FEEDBACK_A_DAY,
  SCREENSHOTS_MAX,
  type FeedbackItem
} from '../../packages/domain/feedback.ts';
import { body, json } from './requests.ts';

/** A filing's body: the words and up to three screenshots in base64. */
export const MAX_FEEDBACK_BODY = SCREENSHOTS_MAX * Math.ceil((INLINE_IMAGE_BYTES * 4) / 3) + 64 * 1024;
const ID = /^[0-9a-f]{16}$/;
const REFUSALS: Record<string, [number, string]> = {
  kind: [400, 'feedback-kind'],
  text: [400, 'feedback-text'],
  'too-long': [400, 'feedback-too-long'],
  follows: [400, 'feedback-follows'],
  status: [400, 'feedback-status']
};

async function screenshotLink(service: SessionService, item: FeedbackItem | null, n: string): Promise<Response> {
  const shot = item?.screenshots.find((s) => s.n === Number(n));
  if (!item || !shot) reject(404, 'not-found');
  const url = await service.context.objects.download(shot.key, shot.type, 900, {
    disposition: 'inline',
    cache: 'private, max-age=600'
  });
  return json({}, 302, { location: url, 'cache-control': 'private, max-age=300' });
}

export async function feedbackRoutes(
  service: SessionService,
  pattern: string,
  args: string[]
): Promise<Response | null> {
  if (pattern.startsWith('/api/admin/feedback')) return adminFeedback(service, pattern, args);
  if (!pattern.startsWith('/api/feedback')) return null;
  const { uid, profile: p } = await service.account(),
    ctx = service.context,
    store = ctx.store;
  if (pattern === '/api/feedback/{id}/screenshots/{n}') {
    if (!ID.test(args[0]!)) reject(404, 'not-found');
    return screenshotLink(service, await store.feedbackItem(uid, args[0]!), args[1]!);
  }
  if (service.request.method === 'GET')
    return json({
      items: (await store.feedbackItems(uid)).sort(newestFirst).map(feedbackView),
      filed_today: await store.feedbackFiled(uid, feedbackDay(ctx.now)),
      per_day: FEEDBACK_A_DAY,
      screenshots_max: SCREENSHOTS_MAX,
      screenshot_bytes: INLINE_IMAGE_BYTES
    });
  const value = await body(service.request, MAX_FEEDBACK_BODY),
    fields = feedbackFields(value);
  if (typeof fields === 'string') reject(...REFUSALS[fields]!);
  let screenshots;
  try {
    screenshots = inlineImages(value.screenshots, { max: SCREENSHOTS_MAX });
  } catch (error) {
    if (!(error instanceof InlineImageError)) throw error;
    reject(400, 'feedback-' + error.reason, error.index >= 0 ? { index: error.index } : {});
  }
  // The Feedback page shows the unlock line for Issue opened.
  const outcome = await fileFeedback(
    {
      store,
      objects: ctx.objects,
      now: ctx.now,
      log: (f) => service.log(f),
      badges: { store, profile: p, seen: true }
    },
    uid,
    { ...fields, screenshots, via: 'web' }
  );
  if (!outcome.ok) {
    if (outcome.reason === 'limit') reject(429, 'feedback-limit');
    if (outcome.reason === 'follows') reject(400, 'feedback-follows');
    if (outcome.reason === 'too-many') reject(400, 'feedback-image-count');
    reject(409, 'feedback-conflict');
  }
  const view = feedbackView(outcome.item);
  return json(outcome.unlocked.length ? { ...view, unlocked: outcome.unlocked } : view, 201);
}

async function adminFeedback(service: SessionService, pattern: string, args: string[]): Promise<Response> {
  const { uid, email } = await admin(service),
    ctx = service.context,
    store = ctx.store;
  if (pattern === '/api/admin/feedback')
    return json({
      items: (await feedbackQueue(store)).map((q) => ({
        owner: q.owner,
        email: q.email,
        account: q.status,
        ...feedbackView(q.item)
      }))
    });
  const [owner, id, n] = args as [string, string, string];
  if (!ID.test(id)) reject(404, 'not-found');
  if (pattern.endsWith('/screenshots/{n}')) return screenshotLink(service, await store.feedbackItem(owner, id), n);
  const value = await body(service.request),
    fields = answerFields(value);
  if (typeof fields === 'string') reject(...REFUSALS[fields]!);
  if (!Number.isSafeInteger(value.revision)) reject(409, 'feedback-changed');
  const outcome = await answerFeedback(
    { store, mail: ctx.mail, from: ctx.from, now: ctx.now, log: (f) => service.log(f), badges: store },
    owner,
    id,
    Number(value.revision),
    fields,
    { user: uid, email }
  );
  if (!outcome.ok) {
    if (outcome.reason === 'missing') reject(404, 'feedback-missing');
    if (outcome.reason === 'full') reject(409, 'feedback-full');
    reject(409, 'feedback-changed');
  }
  return json({ item: { owner, ...feedbackView(outcome.item) }, mail: outcome.mail }, 201);
}
