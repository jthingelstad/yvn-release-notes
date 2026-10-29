/** IndexNow: after a release's web sync, tell Bing, Yandex, Seznam, Naver and
 * Yep which public pages that release changed
 * (https://www.indexnow.org/documentation). The key is public by design and
 * shared with Jamie's other sites; the engines check it at /<key>.txt, which
 * web/public/ ships with the web app (its body exactly the key).
 *
 * Which pages: each sitemap address whose entry in site/sitemap.json (the
 * file sitemap.xml is built from) differs between the release it replaces and
 * this one, new addresses included; scripts/release.sh reads both from git. An
 * entry is the page's lastmod and `said`, a hash of its words that
 * tests-node/site.test.ts pins, so a page changed twice in one day is sent
 * both times, and a release that changes only code or styles sends nothing.
 * A page taken off the site leaves the sitemap and is not sent.
 * The one network call is the POST to api.indexnow.org; scripts/release.sh
 * warns when it fails and the release stands. tools/release-cli.ts runs it
 * (`indexnow`), and `indexnow-plan` prints what would be sent and sends nothing.
 */
export const ORIGIN = 'https://notes.yourversionnumber.com';
export const KEY = '79f379d18599eeec9bebf34c9a2a5deb';
export const KEY_LOCATION = `${ORIGIN}/${KEY}.txt`;
export const ENDPOINT = 'https://api.indexnow.org/indexnow';

export type SitemapDates = Record<string, { said?: string; lastmod?: string }>;

/** Every address in `after` (this release's site/sitemap.json, which
 * sitemap.xml is built from) whose words or lastmod differ from `before`'s
 * (the replaced release's), or that `before` lacks, sorted. */
export function changedUrls(before: SitemapDates, after: SitemapDates): string[] {
  return Object.entries(after)
    .filter(([path, { said, lastmod }]) => before[path]?.said !== said || before[path]?.lastmod !== lastmod)
    .map(([path]) => ORIGIN + path)
    .sort();
}

export function payload(urlList: string[]) {
  return { host: new URL(ORIGIN).host, key: KEY, keyLocation: KEY_LOCATION, urlList };
}

export const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

type Post = (url: string, init: RequestInit) => Promise<{ status: number }>;

/** One POST of every changed address, or none when nothing changed. Returns a
 * line for the release log; throws when IndexNow refuses or cannot be reached,
 * which scripts/release.sh turns into a warning. */
export async function submit(urlList: string[], post: Post = fetch): Promise<string> {
  if (!urlList.length) return 'IndexNow: no page changed, nothing sent';
  const response = await post(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload(urlList)),
    signal: AbortSignal.timeout(20_000)
  });
  if (response.status !== 200 && response.status !== 202)
    throw new Error(`IndexNow answered ${response.status} for ${pages(urlList.length)}`);
  return `IndexNow: ${response.status} for ${pages(urlList.length)} changed`;
}
