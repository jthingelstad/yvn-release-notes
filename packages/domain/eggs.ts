/** Easter eggs (docs/BADGES.md, Easter eggs; Jamie, 2026-10-29: "Approved:
 * build the Developer mode, Status code and RTFM easter eggs in Release
 * Notes, with the status line in the email on those mornings").
 *
 * - **Found eggs** are the two a person finds on the web: Developer mode
 *   (seven taps on Today's number) and RTFM (the man page, `/man/`). Finding
 *   one posts `POST /api/eggs`, which writes one `egg.found` activity row
 *   with `egg`, once an egg, and each earns its secret first from that row.
 * - **Status codes** are versions that read as an HTTP status: a patch from
 *   STATUS_PATCHES (the Status code collectible, earned once and in every
 *   album), and the whole version 4.0.4 (Found) or 4.1.8 (I’m a teapot),
 *   once in a lifetime. The email states the status beside the number on
 *   those mornings, whatever "Show badges" says: it is a fact about the
 *   number, not a badge.
 *
 * Agents can't find either kind: no tool posts an egg, and the public pages
 * and help never mention them (AGENTS.md, Easter eggs). */

/** The eggs `POST /api/eggs` takes; anything else is refused. */
export const EGGS = ['developer', 'rtfm'] as const;
export type Egg = (typeof EGGS)[number];
export const isEgg = (value: unknown): value is Egg => typeof value === 'string' && EGGS.includes(value as Egg);

/** The patches that are an HTTP status, with what each means. */
export const STATUS_PATCHES: Readonly<Record<number, string>> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  301: 'Moved Permanently',
  304: 'Not Modified',
  307: 'Temporary Redirect'
};

/** The two whole versions that read as a status, by badge. */
export const STATUS_VERSIONS = {
  found: { major: 4, minor: 0, patch: 4, code: 404, meaning: 'Not Found' },
  teapot: { major: 4, minor: 1, patch: 8, code: 418, meaning: 'I’m a teapot' }
} as const;

/** The status a version reads as, if any: its patch's, or the whole
 * version's (4.0.4, 4.1.8). */
export function statusOf(major: number, minor: number, patch: number): { code: number; meaning: string } | null {
  for (const s of Object.values(STATUS_VERSIONS))
    if (s.major === major && s.minor === minor && s.patch === patch) return { code: s.code, meaning: s.meaning };
  const meaning = STATUS_PATCHES[patch];
  return meaning ? { code: patch, meaning } : null;
}

/** The email's status line beside the number ("200 OK."), or null. */
export function statusLine(v: { major: number; minor: number; patch: number }): string | null {
  const s = statusOf(v.major, v.minor, v.patch);
  return s ? `${s.code} ${s.meaning}.` : null;
}
