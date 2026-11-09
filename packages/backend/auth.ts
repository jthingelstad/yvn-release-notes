/** Email ownership and session primitives, independent of HTTP or AWS clients.
 * Persisted SHA-256 hashes and cookie values accept existing accounts and sessions.
 * Email code and link share one durable, single-use claim in the AuthService.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export const LOGIN_TTL = 900;
export const MAX_CODE_ATTEMPTS = 5;
export const MAX_WRONG_CODES_A_DAY = 20;
export const SESSION_IDLE = 14 * 86400;
export const SESSION_TOUCH = 86400;
export const COOKIE = '__Host-rn';
export const LIMIT_PER_ADDRESS = 5;
export const LIMIT_PER_NETWORK = 20;
export const LIMIT_PER_NETWORK48 = 60;
/** Sign-in emails an hour to addresses with no account, all together. A
 * member's mail never counts toward it, so members can always sign in. */
export const LIMIT_TOTAL = 200;
/** Sign-in emails to addresses with no account that bounce from one domain in
 * a UTC day before mail to such addresses there stops until the day turns. */
export const DOMAIN_BOUNCES_A_DAY = 5;
export const SIGNIN = 'signin';
export const DELETE = 'delete';

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** A credential row still in force: before its expiry, if it has one, and
 * not revoked. OAuth's rows and API tokens alike. */
export function live(item: Record<string, unknown> | null | undefined, now: number): item is Record<string, unknown> {
  return Boolean(item && Number(item.expires_at ?? now + 1) > now && !item.revoked);
}

export function same(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// A plain address: an RFC 5322 dot-atom in ASCII at a domain of DNS labels,
// the last with a letter in it. No quotes, comments, display names, lists or
// routes, so one string names one mailbox and counts as one.
const ATOM = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+",
  LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',
  PLAIN = new RegExp(`^${ATOM}(?:\\.${ATOM})*@(?:${LABEL}\\.)+(?=[a-z0-9-]*[a-z])${LABEL}$`);
export function normalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[\x21-\x7e]+$/.test(trimmed)) return null;
  const email = trimmed.toLowerCase(),
    at = email.lastIndexOf('@');
  return email.length <= 254 && at <= 64 && PLAIN.test(email) ? email : null;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}
export function newCode(): string {
  return randomInt(1_000_000).toString().padStart(6, '0');
}
export function validToken(raw: unknown): string | null {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null;
}
export function validCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.replace(/\s/gu, '');
  return /^[0-9]{6}$/.test(code) ? code : null;
}
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
/** An address's domain, with googlemail.com as gmail.com. */
export function mailDomain(email: string): string {
  const domain = email.slice(email.lastIndexOf('@') + 1);
  return GMAIL.has(domain) ? 'gmail.com' : domain;
}
/** The address the sign-in limit counts: without any +tag and, at Gmail,
 * without dots, since Gmail delivers every one of those to the same inbox. */
export function limitAddress(email: string): string {
  const i = email.lastIndexOf('@'),
    domain = mailDomain(email),
    local = email.slice(0, i),
    bare = local.split('+')[0] || local;
  return `${domain === 'gmail.com' ? bare.replaceAll('.', '') || bare : bare}@${domain}`;
}
/** The counter of a UTC day's sign-in bounces from an address's domain. */
export function bounceKey(email: string): string {
  return 'bounces:' + digest(mailDomain(email));
}
export function network(viewer: string, prefix = 64): string {
  try {
    const ip = ipaddr.parse(viewer);
    if (ip.kind() === 'ipv4') return ip.toString();
    const bytes = ip.toByteArray();
    for (let bit = prefix; bit < 128; bit++) bytes[Math.floor(bit / 8)]! &= ~(1 << (7 - (bit % 8)));
    return `${ipaddr.fromByteArray(bytes).toString()}/${prefix}`;
  } catch {
    return viewer;
  }
}
export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; Path=/; Max-Age=${SESSION_IDLE}; Secure; HttpOnly; SameSite=Lax`;
}
export function clearCookie(): string {
  return `${COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;
}
export function cookieToken(cookies: string[]): string | null {
  for (const cookie of cookies) {
    const i = cookie.trim().indexOf('='),
      value = cookie.trim();
    if (value.slice(0, i) === COOKIE) return validToken(value.slice(i + 1));
  }
  return null;
}
export function sessionExpiry(now: number): number {
  return now + SESSION_IDLE;
}
