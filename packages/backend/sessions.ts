/** Request-local email ownership/session service. Mutable identity and renewal
 * cookies are never shared between concurrent HTTP requests. */
import { Store } from './store.ts';
import type { Item, Purpose } from './store-types.ts';
import type { Objects, Mail, Invocations, Log } from './services.ts';
import { safeLog } from './services.ts';
import type { TitleFetcher } from './links.ts';
import { search, fetchJson, type JsonFetch, type City } from './places.ts';
import * as auth from './auth.ts';
import { withWebProof } from './guarded-store.ts';
import type { TurnstileConfig } from './turnstile.ts';
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly extra: Item = {}
  ) {
    super(error);
  }
}
export function reject(status: number, error: string, extra: Item = {}): never {
  throw new ApiError(status, error, extra);
}
export interface ApiContext {
  store: Store;
  now: number;
  origin: string;
  objects: Objects;
  mail: Mail;
  invocations: Invocations;
  from: string;
  inboundDomain: string;
  senderFunction: string;
  exportFunction: string;
  adminUserId?: string;
  geocode?: (q: string) => Promise<City[]>;
  weatherFetch?: JsonFetch;
  fetchTitle?: TitleFetcher;
  turnstile?: TurnstileConfig;
  log?: Log;
}
export class SessionService {
  renewedCookie: string | null = null;
  private sessionPromise?: Promise<Item | null>;
  readonly rawStore: Store;
  constructor(
    readonly context: ApiContext,
    readonly request: Request
  ) {
    this.rawStore = context.store;
  }
  log(fields: Record<string, string | number | boolean>): void {
    (this.context.log ?? safeLog)(fields);
  }
  get token(): string | null {
    return auth.cookieToken((this.request.headers.get('cookie') ?? '').split(';'));
  }
  async session(): Promise<Item | null> {
    return (this.sessionPromise ??= this.readSession());
  }
  private async readSession(): Promise<Item | null> {
    const token = this.token;
    if (!token) return null;
    const hash = auth.digest(token),
      s = await this.rawStore.getSession(hash, true);
    if (!s || Number(s.expires_at) <= this.context.now) return null;
    const profile = s.user_id ? await this.rawStore.mcpProfile(String(s.user_id)) : null;
    if (s.user_id && !profile) return null;
    const answer: Item = { ...s, hash };
    if (!profile?.mcp_deleting && this.context.now - Number(s.seen_at ?? 0) >= auth.SESSION_TOUCH) {
      const expires = auth.sessionExpiry(this.context.now);
      if (!(await this.rawStore.renewSession(hash, s.user_id ? String(s.user_id) : null, this.context.now, expires)))
        return null;
      answer.expires_at = expires;
      this.renewedCookie = auth.sessionCookie(token);
    }
    return answer;
  }
  async signedIn(): Promise<Item> {
    const s = await this.session();
    if (!s) reject(401, 'signed-out');
    return s;
  }
  async account(allowDeleting = false): Promise<{ uid: string; profile: Item; session: Item }> {
    const s = await this.signedIn();
    if (!s.user_id) reject(403, 'no-account');
    const uid = String(s.user_id),
      profile = await this.rawStore.mcpProfile(uid);
    if (!profile || (!allowDeleting && profile.mcp_deleting)) reject(403, 'no-account');
    this.context.store = withWebProof(this.rawStore, uid, String(s.hash), this.context.now, { allowDeleting });
    return { uid, profile, session: s };
  }
  async reserveMail(email: string, viewer?: string): Promise<void> {
    const hour = Math.floor(this.context.now / 3600),
      checks = [
        { name: 'address', key: 'email:' + auth.digest(auth.limitAddress(email)), limit: auth.LIMIT_PER_ADDRESS }
      ];
    if (viewer !== undefined) {
      const net = auth.network(viewer),
        wide = auth.network(viewer, 48);
      checks.push({ name: 'network', key: 'net:' + auth.digest(net), limit: auth.LIMIT_PER_NETWORK });
      if (wide !== net)
        checks.push({ name: 'network48', key: 'net48:' + auth.digest(wide), limit: auth.LIMIT_PER_NETWORK48 });
    }
    checks.push({ name: 'total', key: 'all', limit: auth.LIMIT_TOTAL });
    const result = await this.context.store.reserveMail(
      checks.map((c) => ({ key: c.key, limit: c.limit, period: hour }))
    );
    if (!result.ok) {
      const name = checks.find((c) => c.key === result.limited)?.name ?? 'total';
      this.log({ event: 'mail-limited', limit: name });
      reject(429, 'limited');
    }
  }
  async newLogin(email: string, purpose: Purpose = 'signin'): Promise<{ token: string; code: string }> {
    const token = auth.newToken(),
      code = auth.newCode();
    await this.context.store.putLogin(
      auth.digest(token),
      email,
      auth.digest(email),
      auth.digest(code),
      this.context.now,
      auth.LOGIN_TTL,
      purpose
    );
    return { token, code };
  }
  async checkCode(email: string, code: string, purpose: Purpose = 'signin'): Promise<Item> {
    const store = this.context.store,
      hash = await store.newestLogin(auth.digest(email), purpose);
    if (!hash) reject(400, 'code-expired');
    const wrong = 'codefail:' + auth.digest(email),
      day = Math.floor(this.context.now / 86400);
    if ((await store.peek(wrong, day)) >= auth.MAX_WRONG_CODES_A_DAY) {
      this.log({ event: 'code-limited' });
      reject(429, 'limited');
    }
    const spent = await store.spendAttempt(hash, this.context.now, auth.MAX_CODE_ATTEMPTS, purpose);
    if (typeof spent === 'string')
      reject(
        400,
        ({ gone: 'code-expired', used: 'code-used', attempts: 'too-many-tries' } as Record<string, string>)[spent] ??
          'code-expired'
      );
    if (!auth.same(auth.digest(code), String(spent.code_hash))) {
      await store.count(wrong, day, 86400);
      const left = auth.MAX_CODE_ATTEMPTS - Number(spent.attempts);
      reject(400, left ? 'wrong-code' : 'too-many-tries', { tries_left: left });
    }
    const login = await store.burnLogin(hash, this.context.now, purpose);
    if (!login) reject(400, 'code-used');
    return login;
  }
  async tally(name: string): Promise<void> {
    try {
      await this.context.store.tally(new Date(this.context.now * 1000).toISOString().slice(0, 7), name);
    } catch {
      this.log({ event: 'tally-failed', name });
    }
  }
  geocode(q: string): Promise<City[]> {
    return (this.context.geocode ?? search)(q);
  }
  get weatherFetch(): JsonFetch {
    return this.context.weatherFetch ?? fetchJson;
  }
}
