/** Runtime boundaries shared by HTTP and event workers. Inputs are private;
 * implementations never log mail, object keys, coordinates or payloads. */
export interface StoredObject {
  body: Buffer;
  size: number;
  type: string;
  version?: string;
  metadata: Record<string, string>;
}
export interface ObjectHead extends Omit<StoredObject, 'body'> {}
export interface ObjectWrite {
  type: string;
  disposition?: string;
  tags?: Record<string, string>;
  metadata?: Record<string, string>;
}
export interface Objects {
  get(key: string, options?: { version?: string; range?: string; maxBytes?: number }): Promise<StoredObject>;
  head(key: string, version?: string): Promise<ObjectHead>;
  put(key: string, body: Buffer, options: ObjectWrite): Promise<string | undefined>;
  uploadFile(key: string, path: string, options: ObjectWrite): Promise<void>;
  copy(source: string, version: string, target: string, options: ObjectWrite): Promise<void>;
  remove(key: string, version?: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  tag(key: string, tags: Record<string, string>): Promise<void>;
  tags(key: string, version?: string): Promise<Record<string, string>>;
  download(
    key: string,
    type: string,
    seconds: number,
    options?: { disposition?: string; cache?: string }
  ): Promise<string>;
  upload(
    key: string,
    type: string,
    size: number,
    seconds: number
  ): Promise<{ url: string; fields: Record<string, string> }>;
}
export interface Mail {
  send(raw: Buffer, to: string, kind?: 'daily' | 'account'): Promise<string>;
  unsuppress(email: string): Promise<void>;
}
export interface Invocations {
  invoke(name: string, payload: unknown, asynchronous?: boolean): Promise<unknown>;
}
export type Log = (fields: Record<string, string | number | boolean>) => void;
export const safeLog: Log = (fields) => process.stdout.write(`${JSON.stringify(fields)}\n`);
const LABEL = /^[A-Za-z0-9_.:-]{1,80}$/;
/** What failed, never what it was working on: the error's class and code, an
 * AWS status and transaction cancellation codes. A message is kept only for an
 * AWS ValidationException, which describes the request's shape (it named the
 * bare reserved word `owner` on 2026-10-16); any other message may carry
 * content or a provider's words and is dropped. */
export function errorFields(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { error: typeof error };
  const e = error as Error & {
    code?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    CancellationReasons?: { Code?: unknown }[];
  };
  const out: Record<string, string | number> = { error: LABEL.test(e.name) ? e.name : 'Error' };
  if ((typeof e.code === 'string' || typeof e.code === 'number') && LABEL.test(String(e.code)))
    out.error_code = String(e.code);
  if (e.$metadata && typeof e.$metadata === 'object') {
    if (typeof e.$metadata.httpStatusCode === 'number') out.error_status = e.$metadata.httpStatusCode;
    if (e.name === 'ValidationException') out.error_message = e.message.slice(0, 300);
  }
  if (Array.isArray(e.CancellationReasons))
    out.error_reasons = e.CancellationReasons.map((r) =>
      typeof r?.Code === 'string' && LABEL.test(r.Code) ? r.Code : '?'
    ).join(',');
  return out;
}
export function missing(error: unknown): boolean {
  return error instanceof Error && ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes(error.name);
}
