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
export function missing(error: unknown): boolean {
  return error instanceof Error && ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes(error.name);
}
