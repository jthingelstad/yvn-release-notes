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
export const LIMIT_TOTAL = 200;
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

export function normalEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  return Array.from(email).length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(email) ? email : null;
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
export function limitAddress(email: string): string {
  const i = email.lastIndexOf('@'),
    local = email.slice(0, i);
  return `${local.split('+')[0] || local}@${email.slice(i + 1)}`;
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
