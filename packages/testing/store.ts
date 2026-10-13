/** SDK-shaped DynamoDB fake: evaluates the expressions used by Store, fails on
 * unsupported syntax, projects fields, paginates before filters, and commits
 * transactions atomically. No AWS clients, credentials or network are created.
 */
import { isDeepStrictEqual } from 'node:util';
import { Store } from '../backend/store.ts';
import type { DocumentResult, DocumentSender, Item, Key, StoreCommand } from '../backend/store-types.ts';

type Input = {
  TableName?: string;
  Key?: Key;
  Item?: Item;
  ConditionExpression?: string;
  UpdateExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Item;
  ReturnValues?: string;
  KeyConditionExpression?: string;
  FilterExpression?: string;
  ProjectionExpression?: string;
  ExclusiveStartKey?: Key;
  Limit?: number;
  ScanIndexForward?: boolean;
  TransactItems?: Record<string, Input>[];
  RequestItems?: Record<string, { DeleteRequest?: { Key: Key }; PutRequest?: { Item: Item } }[]>;
};
const clone = <T>(v: T): T => structuredClone(v);
const id = (key: Key) => JSON.stringify([key.pk, key.sk]);
function error(name: string, message = name) {
  return Object.assign(new Error(message), { name });
}
function pathParts(path: string, names: Record<string, string>) {
  return path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => names[p] ?? p);
}
function getPath(item: Item, path: string, names: Record<string, string>): unknown {
  let got: unknown = item;
  for (const p of pathParts(path, names)) {
    if (got == null || typeof got !== 'object') return undefined;
    got = (got as Item)[p];
  }
  return got;
}
function setPath(item: Item, path: string, value: unknown, names: Record<string, string>, project = false) {
  const parts = pathParts(path, names);
  let at: Item = item;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (at[p] == null) {
      if (!project) throw error('ValidationException', 'Missing document parent');
      at[p] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
    }
    if (typeof at[p] !== 'object') throw error('ValidationException', 'Invalid document path');
    at = at[p] as Item;
  }
  const last = parts.at(-1)!;
  if (value === undefined) delete at[last];
  else at[last] = clone(value);
}
function splitTop(text: string, delimiter = ','): string[] {
  const out: string[] = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') depth--;
    if (!depth && text[i] === delimiter) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}
class Expression {
  tokens: string[];
  at = 0;
  item: Item;
  names: Record<string, string>;
  values: Item;
  constructor(text: string, item: Item, input: Input) {
    this.tokens =
      text.match(/(?::[\w]+|[#A-Za-z_][\w]*(?:\[\d+\])?(?:\.[#A-Za-z_][\w]*(?:\[\d+\])?)*)|<=|>=|<>|[=<>(),+-]|\d+/g) ??
      [];
    if (this.tokens.join('').replace(/\s/g, '') !== text.replace(/\s/g, ''))
      throw error('ValidationException', `Unsupported expression ${text}`);
    this.item = item;
    this.names = input.ExpressionAttributeNames ?? {};
    this.values = input.ExpressionAttributeValues ?? {};
  }
  peek() {
    return this.tokens[this.at];
  }
  take() {
    const t = this.tokens[this.at++];
    if (t === undefined) throw error('ValidationException', 'Unexpected expression end');
    return t;
  }
  expect(t: string) {
    if (this.take() !== t) throw error('ValidationException', `Expected ${t}`);
  }
  value(): unknown {
    const t = this.take();
    if (t.startsWith(':')) {
      if (!Object.hasOwn(this.values, t)) throw error('ValidationException', 'Missing expression value');
      return this.values[t];
    }
    if (this.peek() === '(') {
      this.take();
      const args: unknown[] = [];
      if (['attribute_exists', 'attribute_not_exists'].includes(t)) {
        const path = this.take();
        args.push(getPath(this.item, path, this.names));
      } else {
        args.push(this.value());
        while (this.peek() === ',') {
          this.take();
          args.push(this.value());
        }
      }
      this.expect(')');
      switch (t) {
        case 'attribute_exists':
          return args[0] !== undefined;
        case 'attribute_not_exists':
          return args[0] === undefined;
        case 'begins_with':
          return typeof args[0] === 'string' && args[0].startsWith(String(args[1]));
        case 'contains':
          return typeof args[0] === 'string'
            ? args[0].includes(String(args[1]))
            : args[0] instanceof Set
              ? args[0].has(args[1])
              : Array.isArray(args[0]) && args[0].some((v) => isDeepStrictEqual(v, args[1]));
        case 'size':
          return typeof args[0] === 'string' || Array.isArray(args[0])
            ? args[0].length
            : args[0] instanceof Set
              ? args[0].size
              : undefined;
        case 'if_not_exists':
          return args[0] === undefined ? args[1] : args[0];
        case 'list_append':
          if (!Array.isArray(args[0]) || !Array.isArray(args[1]))
            throw error('ValidationException', 'list_append requires lists');
          return [...args[0], ...args[1]];
        default:
          throw error('ValidationException', `Unsupported function ${t}`);
      }
    }
    if (/^\d+$/.test(t)) return Number(t);
    return getPath(this.item, t, this.names);
  }
  atom(): boolean {
    if (this.peek() === '(') {
      this.take();
      const result = this.or();
      this.expect(')');
      return result;
    }
    const left = this.value();
    const op = this.peek();
    if (op === 'BETWEEN') {
      this.take();
      const a = this.value();
      this.expect('AND');
      const b = this.value();
      return (
        left !== undefined &&
        a !== undefined &&
        b !== undefined &&
        (left as string) >= (a as string) &&
        (left as string) <= (b as string)
      );
    }
    if (op && ['=', '<>', '<', '>', '<=', '>='].includes(op)) {
      this.take();
      const right = this.value();
      if (left === undefined || right === undefined) return false;
      switch (op) {
        case '=':
          return isDeepStrictEqual(left, right);
        case '<>':
          return !isDeepStrictEqual(left, right);
        case '<':
          return (left as number) < (right as number);
        case '>':
          return (left as number) > (right as number);
        case '<=':
          return (left as number) <= (right as number);
        case '>=':
          return (left as number) >= (right as number);
      }
    }
    if (typeof left !== 'boolean') throw error('ValidationException', 'Expected predicate');
    return left;
  }
  and(): boolean {
    let result = this.atom();
    while (this.peek() === 'AND') {
      this.take();
      const next = this.atom();
      result = result && next;
    }
    return result;
  }
  or(): boolean {
    let result = this.and();
    while (this.peek() === 'OR') {
      this.take();
      const next = this.and();
      result = result || next;
    }
    return result;
  }
  condition(): boolean {
    const result = this.or();
    if (this.peek()) throw error('ValidationException', 'Unused expression tokens');
    return result;
  }
  evaluate(): unknown {
    let result = this.value();
    if (['+', '-'].includes(this.peek() ?? '')) {
      const op = this.take();
      const rhs = this.value();
      result = op === '+' ? Number(result) + Number(rhs) : Number(result) - Number(rhs);
    }
    if (this.peek()) throw error('ValidationException', 'Unused value tokens');
    return result;
  }
}
function condition(input: Input, item: Item) {
  return !input.ConditionExpression || new Expression(input.ConditionExpression, item, input).condition();
}
function project(item: Item, input: Input): Item {
  if (!input.ProjectionExpression) return clone(item);
  const out: Item = {};
  const names = input.ExpressionAttributeNames ?? {};
  for (const path of splitTop(input.ProjectionExpression)) {
    const value = getPath(item, path, names);
    if (value !== undefined) setPath(out, path, value, names, true);
  }
  return out;
}
function update(item: Item, input: Input): { item: Item; changed: Item } {
  const next = clone(item),
    changed: Item = {};
  const names = input.ExpressionAttributeNames ?? {};
  const expr = input.UpdateExpression ?? '';
  const sections = [...expr.matchAll(/\b(SET|ADD|REMOVE|DELETE)\b/g)];
  if (!sections.length) throw error('ValidationException', 'Missing update expression');
  for (let i = 0; i < sections.length; i++) {
    const section = sections[i]!;
    const text = expr.slice(section.index! + section[0].length, sections[i + 1]?.index ?? expr.length).trim();
    for (const part of splitTop(text)) {
      if (section[0] === 'REMOVE') {
        setPath(next, part, undefined, names);
        continue;
      }
      if (section[0] === 'SET') {
        const at = part.indexOf('=');
        if (at < 0) throw error('ValidationException', 'Malformed SET');
        const path = part.slice(0, at).trim(),
          val = new Expression(part.slice(at + 1).trim(), item, input).evaluate();
        setPath(next, path, val, names);
        setPath(changed, path, val, names, true);
      } else {
        const m = /^(\S+)\s+(.+)$/.exec(part);
        if (!m) throw error('ValidationException', 'Malformed ADD/DELETE');
        const path = m[1]!,
          val = new Expression(m[2]!, item, input).evaluate(),
          old = getPath(item, path, names);
        let result: unknown;
        if (val instanceof Set) {
          result = new Set(old as Iterable<unknown> | undefined);
          for (const v of val) {
            if (section[0] === 'DELETE') (result as Set<unknown>).delete(v);
            else (result as Set<unknown>).add(v);
          }
        } else if (section[0] === 'ADD' && typeof val === 'number') result = Number(old ?? 0) + val;
        else throw error('ValidationException', 'Unsupported ADD/DELETE value');
        setPath(next, path, result, names);
        setPath(changed, path, result, names, true);
      }
    }
  }
  return { item: next, changed };
}

export class InMemoryDocumentClient implements DocumentSender {
  readonly items = new Map<string, Item>();
  readonly calls: { name: string; input: Input }[] = [];
  pageSize: number;
  beforeSend?: (command: StoreCommand, client: InMemoryDocumentClient) => void;
  constructor(items: Item[] = [], pageSize = 25) {
    this.pageSize = pageSize;
    items.forEach((i) => this.seed(i));
  }
  seed(item: Item) {
    this.items.set(id({ pk: String(item.pk), sk: String(item.sk) }), clone(item));
  }
  read(key: Key): Item | null {
    return clone(this.items.get(id(key)) ?? null);
  }
  all(): Item[] {
    return [...this.items.values()].map(clone);
  }
  private mutation(name: string, input: Input, table = this.items): DocumentResult {
    const key = input.Key ?? { pk: String(input.Item?.pk), sk: String(input.Item?.sk) };
    const old = table.get(id(key)) ?? {};
    if (!condition(input, old)) throw error('ConditionalCheckFailedException');
    if (name === 'ConditionCheck') return {};
    if (name === 'PutCommand') {
      table.set(id(key), clone(input.Item!));
      return {};
    }
    if (name === 'DeleteCommand') {
      table.delete(id(key));
      return input.ReturnValues === 'ALL_OLD' && Object.keys(old).length ? { Attributes: clone(old) } : {};
    }
    const result = update(Object.keys(old).length ? old : key, input);
    table.set(id(key), result.item);
    return input.ReturnValues === 'ALL_NEW'
      ? { Attributes: clone(result.item) }
      : input.ReturnValues === 'UPDATED_NEW'
        ? { Attributes: clone(result.changed) }
        : {};
  }
  async send(command: StoreCommand): Promise<DocumentResult> {
    this.beforeSend?.(command, this);
    const input = command.input as Input,
      name = command.constructor.name;
    this.calls.push({ name, input: clone(input) });
    if (name === 'GetCommand') {
      const item = this.items.get(id(input.Key!));
      return item ? { Item: project(item, input) } : {};
    }
    if (['PutCommand', 'DeleteCommand', 'UpdateCommand'].includes(name)) return this.mutation(name, input);
    if (name === 'TransactWriteCommand') {
      if (!input.TransactItems?.length || input.TransactItems.length > 100)
        throw error('ValidationException', 'Invalid transaction size');
      const seen = new Set<string>();
      const rs = input.TransactItems.map((op) => {
        const [type, request] = Object.entries(op)[0]!;
        const key = request.Key ?? { pk: String(request.Item?.pk), sk: String(request.Item?.sk) };
        const k = id(key);
        if (seen.has(k)) throw error('ValidationException', 'Duplicate transaction item');
        seen.add(k);
        return { Code: condition(request, this.items.get(k) ?? {}) ? 'None' : 'ConditionalCheckFailed', type, request };
      });
      if (rs.some((r) => r.Code !== 'None'))
        throw Object.assign(error('TransactionCanceledException'), {
          CancellationReasons: rs.map(({ Code }) => ({ Code }))
        });
      const table = clone(this.items);
      for (const r of rs) this.mutation(r.type === 'ConditionCheck' ? r.type : `${r.type}Command`, r.request, table);
      this.items.clear();
      table.forEach((v, k) => this.items.set(k, v));
      return {};
    }
    if (name === 'BatchWriteCommand') {
      for (const requests of Object.values(input.RequestItems ?? {})) {
        if (requests.length > 25) throw error('ValidationException');
        for (const request of requests)
          if (request.DeleteRequest) this.items.delete(id(request.DeleteRequest.Key));
          else if (request.PutRequest) this.seed(request.PutRequest.Item);
      }
      return {};
    }
    if (name === 'ScanCommand' || name === 'QueryCommand') {
      let items = this.all().sort((a, b) =>
        String(a.pk) < String(b.pk)
          ? -1
          : String(a.pk) > String(b.pk)
            ? 1
            : String(a.sk) < String(b.sk)
              ? -1
              : String(a.sk) > String(b.sk)
                ? 1
                : 0
      );
      if (name === 'QueryCommand') {
        if (!input.KeyConditionExpression) throw error('ValidationException', 'Missing query condition');
        items = items.filter((item) => new Expression(input.KeyConditionExpression!, item, input).condition());
        if (input.ScanIndexForward === false) items.reverse();
      }
      if (input.ExclusiveStartKey) {
        const index = items.findIndex(
          (i) => i.pk === input.ExclusiveStartKey!.pk && i.sk === input.ExclusiveStartKey!.sk
        );
        if (index >= 0) items = items.slice(index + 1);
      }
      const count = input.Limit ?? this.pageSize;
      const page = items.slice(0, count);
      const last = page.at(-1);
      const LastEvaluatedKey = items.length > count && last ? { pk: String(last.pk), sk: String(last.sk) } : undefined;
      const filtered = input.FilterExpression
        ? page.filter((item) => new Expression(input.FilterExpression!, item, input).condition())
        : page;
      return { Items: filtered.map((i) => project(i, input)), ...(LastEvaluatedKey ? { LastEvaluatedKey } : {}) };
    }
    throw error('ValidationException', `Unsupported command ${name}`);
  }
}
export class FakeStore extends Store {
  readonly memory: InMemoryDocumentClient;
  constructor(items: Item[] = [], tableName = 'release-notes-test', pageSize = 25) {
    const client = new InMemoryDocumentClient(items, pageSize);
    super(client, tableName);
    this.memory = client;
  }
  seed(item: Item) {
    this.memory.seed(item);
  }
}
