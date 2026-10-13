/** Raw MIME remains the source of truth. Headers are parsed independently,
 * before sender proof. Retain the MIME tree: mixed text fragments are joined
 * in order; alternatives prefer plain text. Charset/filename decoding uses
 * MailParser, with all HTML conversion and remote/resource access disabled. */
import { simpleParser, type EmailAddress, type StructuredHeader } from 'mailparser';
import { Parser } from 'htmlparser2';
import { pythonTrim, pythonRstrip, codePointLength } from '../domain/unicode.ts';

export const MAX_RAW_BYTES = 40 * 1024 * 1024;
export const MAX_HEADER_BYTES = 256 * 1024;
export const MAX_MIME_DEPTH = 64;
export const MAX_MIME_PARTS = 1000;
export interface MailHeaders {
  values: Map<string, string[]>;
  from: EmailAddress[];
  get(name: string): string | undefined;
  all(name: string): string[];
}
export interface MimePart {
  type: string;
  disposition: string;
  filename: string;
  content: Buffer;
  text: string;
  parts: MimePart[];
}
export interface AttachmentInfo {
  content_type: string;
  filename: string;
  size: number;
  refused?: boolean;
}
const options = {
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipTextLinks: true,
  skipImageLinks: true,
  keepCidLinks: true,
  keepDeliveryStatus: true
};
function split(raw: Buffer): [Buffer, Buffer] {
  // Scan only the bounded header section. A hostile body is never parsed here.
  const end = /\r?\n\r?\n|\r\r/.exec(raw.subarray(0, MAX_HEADER_BYTES + 4).toString('latin1'));
  if (!end && raw.length > MAX_HEADER_BYTES) throw new RangeError('Mail headers too large');
  return end ? [raw.subarray(0, end.index), raw.subarray(end.index + end[0].length)] : [raw, Buffer.alloc(0)];
}
export async function parseHeaders(raw: Buffer): Promise<MailHeaders> {
  const [head] = split(raw),
    values = new Map<string, string[]>();
  for (const line of head
    .toString('latin1')
    .replace(/\r\n?|\n/g, '\n')
    .replace(/\n[ \t]+/g, ' ')
    .split('\n')) {
    const match = /^([^:\s]+):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!.toLowerCase(),
      list = values.get(name) ?? [];
    list.push(match[2]!);
    values.set(name, list);
  }
  const parsed = await simpleParser(Buffer.concat([head, Buffer.from('\r\n\r\n')]), options);
  return {
    values,
    from: parsed.from?.value ?? [],
    get: (name) => values.get(name.toLowerCase())?.[0],
    all: (name) => values.get(name.toLowerCase()) ?? []
  };
}
export async function addresses(value: readonly string[]): Promise<string[]> {
  if (!value.length) return [];
  if (value.some((line) => /[\r\n]/.test(line))) return [];
  const head = await parseHeaders(Buffer.from(`From: ${value.join(', ')}\r\n\r\n`));
  function flatten(parts: EmailAddress[]): string[] {
    return parts.flatMap((a) => (a.group ? flatten(a.group) : [a.address?.toLowerCase() ?? '']));
  }
  return flatten(head.from);
}
export async function parseMessage(raw: Buffer): Promise<MimePart> {
  if (raw.length > MAX_RAW_BYTES) throw new RangeError('Mail too large');
  let count = 0;
  async function part(bytes: Buffer, depth: number): Promise<MimePart> {
    if (depth > MAX_MIME_DEPTH || ++count > MAX_MIME_PARTS) throw new RangeError('MIME nesting or part limit');
    const [head, body] = split(bytes),
      parsed = await simpleParser(Buffer.concat([head, Buffer.from('\r\n\r\n')]), options);
    const c = parsed.headers.get('content-type') as StructuredHeader | undefined;
    const d = parsed.headers.get('content-disposition') as StructuredHeader | undefined;
    const type = c?.value.toLowerCase() ?? 'text/plain',
      disposition = d?.value.toLowerCase() ?? '';
    const node: MimePart = {
      type,
      disposition,
      filename: d?.params.filename ?? c?.params.name ?? '',
      content: Buffer.alloc(0),
      text: '',
      parts: []
    };
    const boundary = c?.params.boundary;
    if (type.startsWith('multipart/') && boundary) {
      // Byte scanning avoids retaining a copy of the whole body at each
      // nesting level (a large, deeply nested MIME body could otherwise OOM).
      if (boundary.length > 200) throw new RangeError('MIME boundary too long');
      const marker = Buffer.from('--' + boundary, 'latin1');
      let position = 0,
        start: number | undefined;
      while (position < body.length) {
        const index = body.indexOf(marker, position);
        if (index < 0) break;
        position = index + marker.length;
        if (index > 0 && body[index - 1] !== 10) continue;
        const closed = body[position] === 45 && body[position + 1] === 45;
        if (closed) position += 2;
        while (body[position] === 32 || body[position] === 9) position++;
        let after = position;
        if (body[after] === 13) after++;
        if (body[after] === 10) after++;
        else if (after !== body.length) continue;
        if (start !== undefined) {
          let finish = index;
          if (finish > 0 && body[finish - 1] === 10) {
            finish--;
            if (finish > 0 && body[finish - 1] === 13) finish--;
          }
          node.parts.push(await part(body.subarray(start, finish), depth + 1));
        }
        if (closed) {
          start = undefined;
          break;
        }
        start = after;
        position = after;
      }
      if (start !== undefined && start < body.length) node.parts.push(await part(body.subarray(start), depth + 1));
      return node;
    }
    // Decode each leaf independently, preserving alternative/mixed semantics.
    const leaf = await simpleParser(bytes, options);
    const attachment = leaf.attachments[0];
    if (attachment) {
      node.content = Buffer.from(attachment.content);
      node.filename = attachment.filename ?? node.filename;
      if (type.startsWith('text/')) {
        try {
          node.text = new TextDecoder(c?.params.charset ?? 'utf-8').decode(node.content);
        } catch {
          node.text = node.content.toString('utf8');
        }
      }
    } else {
      node.text = type === 'text/html' ? leaf.html || '' : (leaf.text ?? '');
      // Unknown charsets are explicitly UTF-8 replacement, as in the legacy parser.
      if (c?.params.charset) {
        try {
          new TextDecoder(c.params.charset);
        } catch {
          node.text = decodePayload(body, String(parsed.headers.get('content-transfer-encoding') ?? '')).toString(
            'utf8'
          );
        }
      }
      node.content = decodePayload(body, String(parsed.headers.get('content-transfer-encoding') ?? ''));
    }
    return node;
  }
  return part(raw, 0);
}
function decodePayload(body: Buffer, encoding: string): Buffer {
  if (encoding.toLowerCase() === 'base64') return Buffer.from(body.toString('ascii'), 'base64');
  if (encoding.toLowerCase() === 'quoted-printable') {
    const raw = body
      .toString('latin1')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(raw, 'latin1');
  }
  return body;
}
const blocks = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'hr']);
const skipTags = new Set(['script', 'style', 'head', 'title', 'blockquote']);
function html(html: string): { out: string; anchors: Record<string, string> } {
  const out: string[] = [],
    stack: [string, boolean][] = [],
    open: [number, string][] = [],
    anchors: Record<string, string> = {};
  let skipped = 0;
  const parser = new Parser(
    {
      onopentag(tag, attrs) {
        if (tag === 'a' && !skipped) open.push([out.length, pythonTrim(attrs.href ?? '')]);
        if (['br', 'hr', 'img', 'meta', 'link', 'input'].includes(tag)) {
          if (!skipped && blocks.has(tag)) out.push('\n');
          return;
        }
        const skip =
          skipTags.has(tag) ||
          (attrs.class ?? '').includes('gmail_quote') ||
          (attrs.class ?? '').includes('yahoo_quoted') ||
          ['divRplyFwdMsg', 'appendonsend'].includes(attrs.id ?? '');
        stack.push([tag, skip]);
        if (skip) skipped++;
        else if (!skipped && blocks.has(tag)) out.push('\n');
      },
      onclosetag(tag) {
        if (tag === 'a' && open.length && !skipped) {
          const [start, href] = open.pop()!,
            words = pythonTrim(
              out
                .slice(start)
                .join('')
                .replace(/\u00a0/g, ' ')
                .replace(/\s+/g, ' ')
            );
          if (/^https?:\/\//i.test(href) && words && !/^https?:\/\//i.test(words)) {
            anchors[href] ??= words;
            out.push(` <${href}>`);
          }
        }
        // HTMLParser ignores the closing event for void tags; htmlparser2 emits it.
        if (['br', 'hr', 'img', 'meta', 'link', 'input'].includes(tag)) return;
        while (stack.length) {
          const [was, skip] = stack.pop()!;
          if (skip) skipped--;
          if (was === tag) break;
        }
        if (!skipped && blocks.has(tag)) out.push('\n');
      },
      ontext(text) {
        if (!skipped) out.push(text);
      }
    },
    { decodeEntities: true, recognizeSelfClosing: true }
  );
  parser.end(html);
  return { out: out.join(''), anchors };
}
export function htmlToText(source: string): string {
  return pythonTrim(
    html(source)
      .out.replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => pythonTrim(line.replace(/[ \t]+/g, ' ')))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  );
}
export function bodyText(part: MimePart): string {
  function text(p: MimePart): string {
    if (p.parts.length) {
      if (p.type === 'multipart/alternative')
        return text(p.parts.find((s) => s.type === 'text/plain' && s.disposition !== 'attachment') ?? p.parts.at(-1)!);
      return p.parts
        .map(text)
        .filter((t) => pythonTrim(t))
        .map((t) => t.replace(/^\n+|\n+$/g, ''))
        .join('\n');
    }
    if (p.disposition === 'attachment') return '';
    return p.type === 'text/plain' ? p.text : p.type === 'text/html' ? htmlToText(p.text) : '';
  }
  return pythonTrim(text(part));
}
export function stripReply(text: string): string {
  let lines = text.replace(/\r\n|\r/g, '\n').split('\n'),
    cut = lines.length;
  for (const [i, line] of lines.entries()) {
    const s = pythonTrim(line);
    if (
      s.startsWith('>') ||
      /^(-{2,}\s*Original Message\s*-{2,}|_{10,}|-{10,})$/i.test(s) ||
      (/^\*?From:\*?\s/i.test(s) &&
        lines.slice(i + 1, i + 4).some((l) => /^\*?(Sent|Date|To|Subject):\*?\s/i.test(pythonTrim(l))))
    ) {
      cut = i;
      break;
    }
    if (/^On\b.+/i.test(s)) {
      let joined = '';
      for (const next of lines.slice(i, i + 4)) {
        joined = pythonTrim(`${joined} ${pythonTrim(next)}`);
        if (/\bwrote:\s*$/i.test(joined)) break;
      }
      if (/\bwrote:\s*$/i.test(joined) && codePointLength(joined) < 400) {
        cut = i;
        break;
      }
    }
  }
  lines = lines.slice(0, cut);
  const sig = lines.findIndex((l) => l === '-- ' || l === '--');
  if (sig >= 0) lines = lines.slice(0, sig);
  const mobile =
    /^(Sent from my [\p{L}\p{N}_][\p{L}\p{N}_ ]*|Sent from (Fastmail|Gmail|Mail|Outlook|Yahoo Mail)\b.*|Get Outlook for [\p{L}\p{N}_]+.*|Sent via .+)$/iu;
  while (lines.length && (!pythonTrim(lines.at(-1)!) || mobile.test(pythonTrim(lines.at(-1)!)))) lines.pop();
  while (lines.length && !pythonTrim(lines[0]!)) lines.shift();
  return lines.map(pythonRstrip).join('\n');
}
export const noteText = (part: MimePart): string => stripReply(bodyText(part));
export function leaves(part: MimePart): MimePart[] {
  return part.parts.length ? part.parts.flatMap(leaves) : [part];
}
export function anchors(part: MimePart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of leaves(part))
    if (p.type === 'text/html' && p.disposition !== 'attachment')
      for (const [url, words] of Object.entries(html(p.text).anchors)) out[url] ??= words;
  return out;
}
export function attachments(part: MimePart): AttachmentInfo[] {
  return leaves(part)
    .filter((p) => p.disposition === 'attachment' || !p.type.startsWith('text/'))
    .map((p) => ({ content_type: p.type, filename: p.filename, size: p.content.length }));
}
