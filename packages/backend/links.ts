/** Links are named once at writing time. Fetches validate every DNS answer and
 * pin the socket to the checked IP, preserving TLS hostname verification.
 * One wall-clock deadline covers DNS, redirects, headers and capped body reads.
 * No arbitrary fetch or request logging belongs in this path.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import ipaddr from 'ipaddr.js';
import { Parser } from 'htmlparser2';

export const MAX_FETCHES = 3,
  TIMEOUT = 2000,
  MAX_BYTES = 256 * 1024;
export const MAX_REDIRECTS = 3,
  MAX_TITLE = 200;
export const AGENT = 'ReleaseNotes/1.0 (+https://notes.yourversionnumber.com/)';
export interface Link {
  url: string;
  title?: string;
  site?: string;
  named?: boolean;
}
export interface LinkPart {
  url: string;
  label: string;
  site?: string;
}
export interface PageMeta {
  title: string;
  site: string;
}
export type TitleFetcher = (url: string) => PageMeta | null | Promise<PageMeta | null>;

function matches(text: string) {
  const out: { start: number; end: number; url: string; bracketed: boolean }[] = [];
  for (const match of text.matchAll(/<?(https?:\/\/[^\s<>"]+)>?/giu)) {
    const whole = match[0],
      bracketed = whole.startsWith('<') && whole.endsWith('>');
    const url = bracketed ? match[1]! : match[1]!.replace(/[.,;:!?'")\]}]+$/u, '');
    const start = match.index + (whole.startsWith('<') && !bracketed ? 1 : 0);
    if (url) out.push({ start, end: bracketed ? match.index + whole.length : start + url.length, url, bracketed });
  }
  return out;
}
export function urls(text: string): string[] {
  return [...new Set(matches(text).map((m) => m.url))];
}
export function short(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/iu, '').replace(/\/+$/u, '');
}
export function clean(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim(),
    chars = Array.from(text);
  if (chars.length <= limit) return text;
  const cut = chars.slice(0, limit).join(''),
    space = cut.lastIndexOf(' ');
  return (space < 0 ? cut : cut.slice(0, space)).trimEnd() + '…';
}
function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function words(value: string): string {
  return value.split(/\s+/u).filter(Boolean).map(escaped).join('\\s+');
}
function namedIn(text: string, title: string, url: string): boolean {
  return Boolean(title) && new RegExp(`${words(title)}\\s*<${escaped(url)}>`, 'u').test(text);
}
export async function collect(
  text: string,
  options: { named?: Record<string, string>; keep?: Link[]; fetch?: TitleFetcher } = {}
): Promise<Link[]> {
  const old = new Map((options.keep ?? []).map((l) => [l.url, l])),
    out: Link[] = [];
  let fetched = 0;
  for (const url of urls(text)) {
    const title = clean(options.named?.[url] ?? '', MAX_TITLE),
      was = old.get(url);
    if (namedIn(text, title, url)) out.push({ url, title, named: true });
    else if (was && !(was.named && !namedIn(text, was.title ?? '', url))) out.push(was);
    else if (fetched++ < MAX_FETCHES) {
      try {
        const meta = await (options.fetch ?? fetchTitle)(url);
        if (meta) out.push({ url, ...meta });
      } catch {
        /* Unreachable pages do not hold a note. */
      }
    }
  }
  return out;
}
export function segments(text: string, links?: Link[] | null): (string | LinkPart)[] {
  const byUrl = new Map((links ?? []).map((l) => [l.url, l])),
    out: (string | LinkPart)[] = [];
  let pos = 0;
  for (const m of matches(text)) {
    const link = byUrl.get(m.url),
      before = text.slice(pos, m.start);
    const name =
      link?.named && link.title && m.bracketed ? new RegExp(`${words(link.title)}\\s*$`, 'u').exec(before) : null;
    if (name) out.push(before.slice(0, name.index), { url: m.url, label: link!.title! });
    else if (link?.title && !link.named) out.push(before, { url: m.url, label: link.title, site: link.site ?? '' });
    else out.push(before, { url: m.url, label: short(m.url) });
    pos = m.end;
  }
  out.push(text.slice(pos));
  return out.filter((s) => typeof s !== 'string' || s.length > 0);
}
export function plain(text: string, links?: Link[] | null): string {
  return segments(text, links)
    .map((p) => (typeof p === 'string' ? p : `${p.label} <${p.url}>`))
    .join('');
}
export function markdown(text: string, links?: Link[] | null): string {
  return segments(text, links)
    .map((p) => (typeof p === 'string' ? p : `[${p.label}](${p.url})`))
    .join('');
}

export interface Target {
  scheme: 'http:' | 'https:';
  host: string;
  port: number;
  path: string;
}
export function target(value: string): Target | null {
  try {
    // URL normalizes slash-less/ambiguous URLs; reject those before parsing.
    if (
      !/^https?:\/\/[^/]/iu.test(value) ||
      value.includes('\\') ||
      Array.from(value).some((c) => c.charCodeAt(0) <= 32)
    )
      return null;
    const u = new URL(value),
      port = u.protocol === 'https:' ? 443 : 80;
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      !u.hostname ||
      u.username ||
      u.password ||
      (u.port && Number(u.port) !== port)
    )
      return null;
    return {
      scheme: u.protocol as Target['scheme'],
      host: u.hostname.replace(/^\[|\]$/gu, ''),
      port,
      path: u.pathname + u.search
    };
  } catch {
    return null;
  }
}
export function publicIp(addresses: string[]): string | null {
  if (!addresses.length) return null;
  for (const value of addresses) {
    try {
      const ip = ipaddr.parse(value.split('%')[0]!);
      if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress()) {
        if ((ip as ipaddr.IPv6).toIPv4Address().range() !== 'unicast') return null;
      } else if (ip.range() !== 'unicast') return null;
    } catch {
      return null;
    }
  }
  return addresses[0]!.split('%')[0]!;
}
export interface PageResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Uint8Array;
}
export interface FetchOptions {
  resolve?: (host: string) => Promise<string[]>;
  connect?: (target: Target, ip: string, signal: AbortSignal) => Promise<PageResponse>;
  limit?: number;
}
export function connectPinned(t: Target, ip: string, signal: AbortSignal): Promise<PageResponse> {
  return new Promise((resolve, reject) => {
    const request = (t.scheme === 'https:' ? https : http).request(
      {
        hostname: ip,
        port: t.port,
        path: t.path,
        method: 'GET',
        // Node verifies the certificate for servername, while connecting only to ip.
        ...(isIP(t.host) ? {} : { servername: t.host }),
        signal,
        agent: false,
        headers: {
          Host: isIP(t.host) === 6 ? `[${t.host}]` : t.host,
          'User-Agent': AGENT,
          Accept: 'text/html',
          'Accept-Encoding': 'identity'
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0,
          settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          const headers = Object.fromEntries(
            Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v])
          );
          resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks, size) });
        };
        const status = response.statusCode ?? 0;
        if (status !== 200 || !(response.headers['content-type'] ?? '').toLowerCase().includes('html')) {
          finish();
          response.destroy();
          return;
        }
        response.on('data', (chunk: Buffer) => {
          const kept = chunk.subarray(0, MAX_BYTES - size);
          chunks.push(kept);
          size += kept.length;
          if (size >= MAX_BYTES) {
            finish();
            response.destroy();
          }
        });
        response.on('end', finish);
        response.on('error', reject);
      }
    );
    request.on('error', reject);
    request.end();
  });
}
export async function fetchTitle(url: string, options: FetchOptions = {}): Promise<PageMeta | null> {
  const controller = new AbortController(),
    limit = options.limit ?? TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, limit);
  });
  const fetch = async (): Promise<PageMeta | null> => {
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (controller.signal.aborted) return null;
        const t = target(url);
        if (!t) return null;
        const addresses = await (
          options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
        )(t.host);
        const ip = publicIp(addresses);
        if (!ip || controller.signal.aborted) return null;
        const response = await (options.connect ?? connectPinned)(t, ip, controller.signal);
        if (controller.signal.aborted) return null;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (!response.headers.location) return null;
          url = new URL(response.headers.location, url).href;
          continue;
        }
        const type = response.headers['content-type'] ?? '';
        if (response.status !== 200 || !type.toLowerCase().includes('html')) return null;
        return pageMeta(response.body.subarray(0, MAX_BYTES), type, t.host);
      }
    } catch {
      return null;
    }
    return null;
  };
  try {
    return await Promise.race([fetch(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
export function pageMeta(body: Uint8Array, contentType: string, host: string): PageMeta | null {
  const head = Buffer.from(body.subarray(0, 4096)).toString('ascii');
  const charset =
    /charset=["']?([\w-]+)/iu.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/iu.exec(head)?.[1] ?? 'utf-8';
  let source: string;
  try {
    source = new TextDecoder(charset).decode(body);
  } catch {
    source = new TextDecoder().decode(body);
  }
  const meta = new Map<string, string>();
  let title: string[] | null = null,
    done = false;
  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (tag === 'meta') {
          const key = (attrs.property || attrs.name || '').toLowerCase();
          if (['og:title', 'og:site_name', 'twitter:title'].includes(key) && !meta.has(key))
            meta.set(key, attrs.content ?? '');
        } else if (tag === 'title' && !done) title = [];
      },
      ontext(value) {
        if (title) title.push(value);
      },
      onclosetag(tag) {
        if (tag === 'title' && title) {
          if (!meta.has('title')) meta.set('title', title.join(''));
          title = null;
          done = true;
        }
      }
    },
    { decodeEntities: true }
  );
  parser.end(source);
  const label = clean(meta.get('og:title') || meta.get('twitter:title') || meta.get('title') || '', MAX_TITLE);
  return label
    ? { title: label, site: clean(meta.get('og:site_name') || host.toLowerCase().replace(/^www\./u, ''), 100) }
    : null;
}
