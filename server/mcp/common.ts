/** Legacy wire budgets and strict schemas shared by the reader and private writer. */
import { createHash } from 'node:crypto';
import { codePointLength } from '../../packages/domain/unicode.ts';
import type { JsonSchema } from './contract.ts';
export const MAX_CHARS = 48_000,
  MAX_MEDIA = 1_500_000;
export type Arguments = Record<string, unknown>;
export class ToolError extends Error {
  constructor(
    readonly code: string,
    readonly nextStep: string
  ) {
    super(code);
  }
}
export const object = (value: unknown): value is Arguments =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** Python's ensure_ascii encoding is part of existing cursor/fingerprint contracts.
 * Sort object keys only for capture fingerprints; reader cursors keep insertion order. */
export function asciiJson(value: unknown, sorted = false): string {
  const order = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(order)
      : object(item)
        ? Object.fromEntries((sorted ? Object.keys(item).sort() : Object.keys(item)).map((k) => [k, order(item[k])]))
        : item;
  return JSON.stringify(order(value)).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}
export const fingerprint = (value: unknown): string =>
  createHash('sha256').update(asciiJson(value, true)).digest('hex');
export function validate(arguments_: unknown, schema: JsonSchema): asserts arguments_ is Arguments {
  if (
    !object(arguments_) ||
    Object.keys(arguments_).some((k) => !Object.hasOwn(schema.properties ?? {}, k)) ||
    (schema.required ?? []).some((k) => !Object.hasOwn(arguments_, k))
  )
    throw new ToolError('invalid_arguments', "Use only the parameters in this tool's schema.");
  for (const [key, value] of Object.entries(arguments_)) {
    const spec = schema.properties![key]!;
    if (
      (spec.type === 'string' && typeof value !== 'string') ||
      (spec.type === 'integer' && !Number.isSafeInteger(value)) ||
      (spec.type === 'boolean' && typeof value !== 'boolean')
    )
      throw new ToolError('invalid_arguments', "Use the types in this tool's schema.");
    if (
      typeof value === 'string' &&
      (codePointLength(value) > (spec.maxLength ?? 10_000) ||
        codePointLength(value) < (spec.minLength ?? 0) ||
        (spec.pattern && !new RegExp('^(?:' + spec.pattern.replace(/^\^|\$$/g, '') + ')$', 'u').test(value)))
    )
      throw new ToolError('invalid_arguments', 'Check the format and length of your parameters.');
    if (typeof value === 'number' && (value < (spec.minimum ?? 0) || value > (spec.maximum ?? 1e9)))
      throw new ToolError('invalid_arguments', "Use a number within the tool's limits.");
    if (
      spec.type === 'array' &&
      (!Array.isArray(value) || value.length < (spec.minItems ?? 0) || value.length > (spec.maxItems ?? 1000))
    )
      throw new ToolError('invalid_arguments', "Use a list within the tool's limits.");
    // A list of names: each one of the schema's, once.
    const names = spec.items?.enum;
    if (
      names &&
      Array.isArray(value) &&
      (value.some((v) => typeof v !== 'string' || !names.includes(v)) ||
        (spec.uniqueItems === true && new Set(value).size !== value.length))
    )
      throw new ToolError('invalid_arguments', "Use only the values in this tool's schema, each once.");
  }
}
export type SafeLog = (fields: Record<string, unknown>) => void;
/** An activity row that was not written (packages/backend/activity.ts),
 * logged and counted as ActivityUnrecorded where no metric filter reads the
 * log as JSON. */
export const activityLog =
  (now: number, log: SafeLog = (fields) => console.log(JSON.stringify(fields))) =>
  (fields: { event: string; kind: string; user: string }): void => {
    log(fields);
    log({
      _aws: {
        Timestamp: now * 1000,
        CloudWatchMetrics: [
          { Namespace: 'ReleaseNotes', Dimensions: [[]], Metrics: [{ Name: 'ActivityUnrecorded', Unit: 'Count' }] }
        ]
      },
      ActivityUnrecorded: 1
    });
  };
/** An unexpected failure: the user id and the error's class name (an SDK
 * error's, such as AccessDeniedException), never its message. */
export function failure(
  now: number,
  uid: string,
  log: SafeLog = (fields) => console.log(JSON.stringify(fields)),
  error?: unknown
): void {
  const name = error instanceof Error ? error.name : '';
  log({
    event: 'mcp-error',
    user: uid,
    error: 'infrastructure',
    ...(/^[A-Za-z]\w{0,63}$/.test(name) ? { kind: name } : {})
  });
  log({
    _aws: {
      Timestamp: now * 1000,
      CloudWatchMetrics: [
        { Namespace: 'ReleaseNotes', Dimensions: [[]], Metrics: [{ Name: 'McpFailures', Unit: 'Count' }] }
      ]
    },
    McpFailures: 1
  });
}
