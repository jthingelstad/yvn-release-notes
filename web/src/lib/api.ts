// The API is same-origin at /api. Every call answers { status, ok, data }
// and never throws: a network failure is status 0 with error 'network'.
import { signedIn } from './storage.ts';

export interface ApiData {
  error?: string;
  [k: string]: unknown;
}

export interface Answer<T = ApiData> {
  status: number;
  ok: boolean;
  data: T & ApiData;
}

export async function api<T = ApiData>(method: string, path: string, body?: unknown): Promise<Answer<T>> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    return { status: 0, ok: false, data: { error: 'network' } as T & ApiData };
  }
  let data = {} as T & ApiData;
  try {
    data = await res.json();
  } catch {
    /* an empty or non-JSON answer */
  }
  if (path === '/api/me' && method === 'GET') {
    if (res.ok) signedIn.set();
    else if (res.status === 401) signedIn.drop();
  }
  return { status: res.status, ok: res.ok, data };
}

// For TanStack Query: the answer's data, or an ApiError carrying the answer,
// so a page can tell signed out (401) from no account yet (403 no-account)
// from a failure.
export class ApiError extends Error {
  constructor(readonly answer: Answer) {
    super(answer.data.error || `HTTP ${answer.status}`);
  }
}

export async function load<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await api<T>(method, path, body);
  if (!r.ok) throw new ApiError(r as Answer);
  return r.data;
}

export const get = <T>(path: string) => load<T>('GET', path);
