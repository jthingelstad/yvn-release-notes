/** Each function role, held to the AWS requests its code makes. The fakes
 * accept any request, so a grant the template lacked showed up only live (#3,
 * #104, #122, #125, #127). A Recorder wraps the fakes a test hands a worker or
 * server, notes each request as IAM authorizes it (action, resource ARN and
 * condition keys) and asks the function's role in infra/template.yaml, read
 * with a fictional account, whether a statement allows it. The function's own
 * environment names its role, bucket, configuration set and invoke targets. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { FakeStore } from '../../packages/testing/store.ts';
import type { Invocations, Mail, Objects } from '../../packages/backend/services.ts';
import { fromHeader } from '../../packages/mail/compose.ts';

export const REGION = 'us-east-1',
  ACCOUNT = '123456789012',
  STACK = 'yvn-release-notes';
const TEMPLATE = readFileSync(new URL('../../infra/template.yaml', import.meta.url), 'utf8');

// A YAML subset, enough for the template: block maps and lists, flow lists and
// maps, block scalars (skipped), quoted, plain and CloudFormation-tagged scalars.
export type Node = string | Node[] | { [key: string]: Node };
type Line = { indent: number; text: string };
const KEY = /^("[^"]*"|'[^']*'|[^\s"'!{[#-]\S*?):(?:\s+(.*))?$/,
  ITEM = /^-(\s|$)/;
const opened = (text: string) => {
  let depth = 0,
    quoted = false;
  for (const c of text)
    if (c === '"') quoted = !quoted;
    else if (!quoted) depth += '[{'.includes(c) ? 1 : ']}'.includes(c) ? -1 : 0;
  return depth > 0;
};
function lines(text: string): Line[] {
  const out: Line[] = [];
  let block = -1;
  for (const raw of text.split('\n')) {
    const text = raw.trim(),
      indent = raw.length - raw.trimStart().length;
    if (block >= 0 && (!text || indent > block)) continue;
    block = -1;
    if (!text || text.startsWith('#')) continue;
    const last = out.at(-1);
    if (last && opened(last.text)) last.text += ' ' + text;
    else out.push({ indent, text });
    if (/:\s+[|>][-+]?$/.test(text)) block = indent;
  }
  return out;
}
const unquote = (s: string) =>
  s.startsWith('"') ? (JSON.parse(s) as string) : s.startsWith("'") ? s.slice(1, -1).replaceAll("''", "'") : s;
function split(text: string): string[] {
  const out: string[] = [];
  let depth = 0,
    quote = '',
    start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) quote = c === quote ? '' : quote;
    else if (c === '"' || c === "'") quote = c;
    else if ('[{'.includes(c)) depth++;
    else if (']}'.includes(c)) depth--;
    else if (c === ',' && !depth) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, text.slice(start)].map((s) => s.trim()).filter(Boolean);
}
function scalar(text: string): Node {
  const tagged = /^(![A-Za-z]+)(?:\s+(.*))?$/.exec(text);
  if (tagged) return { [tagged[1]!]: scalar(tagged[2] ?? '') };
  if (text.startsWith('[')) return split(text.slice(1, -1)).map(scalar);
  if (text.startsWith('{'))
    return Object.fromEntries(
      split(text.slice(1, -1)).map((entry) => {
        const [, key, value] = KEY.exec(entry) ?? assert.fail(entry);
        return [unquote(key!), scalar(value ?? '')];
      })
    );
  return unquote(text);
}
function parse(ls: Line[], at: number, indent: number): [Node, number] {
  if (ITEM.test(ls[at]!.text)) {
    const list: Node[] = [];
    while (at < ls.length && ls[at]!.indent === indent && ITEM.test(ls[at]!.text)) {
      const rest = ls[at]!.text.slice(1).trim();
      if (!KEY.test(rest)) {
        list.push(scalar(rest));
        at++;
        continue;
      }
      ls[at] = { indent: indent + 2, text: rest };
      const [value, next] = parse(ls, at, indent + 2);
      list.push(value);
      at = next;
    }
    return [list, at];
  }
  const map: Record<string, Node> = {};
  while (at < ls.length && ls[at]!.indent === indent && !ITEM.test(ls[at]!.text)) {
    const [, key, rest] = KEY.exec(ls[at]!.text) ?? assert.fail(ls[at]!.text),
      next = ls[at + 1];
    if (rest) [map[unquote(key!)], at] = [scalar(rest), at + 1];
    else if (next && (next.indent > indent || (next.indent === indent && ITEM.test(next.text))))
      [map[unquote(key!)], at] = parse(ls, at + 1, next.indent);
    else [map[unquote(key!)], at] = ['', at + 1];
  }
  return [map, at];
}
/** One entry of a top-level section (Parameters, Resources), parsed. */
function entry(section: string, name: string): Record<string, Node> {
  const body = TEMPLATE.slice(TEMPLATE.indexOf(`\n${section}:\n`) + 1),
    text = body.slice(0, body.slice(1).search(/\n\S/) + 1),
    start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `${section} has no ${name}`);
  const rest = text.slice(start + 1),
    end = rest.slice(1).search(/\n {2}[A-Za-z]/),
    [parsed] = parse(lines(end < 0 ? rest : rest.slice(0, end + 1)), 0, 2);
  return (parsed as Record<string, Record<string, Node>>)[name]!;
}
export const resource = (name: string) =>
  entry('Resources', name) as { Type: string; Properties: Record<string, Node> };
const RESOURCES = [
  ...TEMPLATE.slice(TEMPLATE.indexOf('\nResources:\n')).matchAll(/\n {2}(\w+):\n {4}Type: (\S+)/g)
].map((m) => [m[1]!, m[2]!] as const);

// Intrinsics, resolved as CloudFormation would in a fictional account.
const PSEUDO: Record<string, string> = {
  'AWS::Region': REGION,
  'AWS::AccountId': ACCOUNT,
  'AWS::Partition': 'aws',
  'AWS::StackName': STACK,
  'AWS::NoValue': ''
};
function ref(name: string): string {
  if (name in PSEUDO) return PSEUDO[name]!;
  if (/^\n {2}\w+:\n {4}Type: String\n/.test(TEMPLATE.slice(TEMPLATE.indexOf(`\n  ${name}:\n`))))
    return String(entry('Parameters', name).Default ?? `<${name}>`);
  const { Type, Properties: p } = resource(name);
  switch (Type) {
    case 'AWS::Lambda::Function':
      return resolve(p.FunctionName!);
    case 'AWS::Lambda::Alias':
      return `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${resolve(p.FunctionName!)}:${resolve(p.Name!)}`;
    case 'AWS::DynamoDB::Table':
      return resolve(p.TableName!);
    case 'AWS::S3::Bucket':
      return resolve(p.BucketName!);
    case 'AWS::SES::ConfigurationSet':
      return resolve(p.Name!);
    case 'AWS::SNS::Topic':
      return `arn:aws:sns:${REGION}:${ACCOUNT}:${resolve(p.TopicName!)}`;
    case 'AWS::Logs::LogGroup':
      return resolve(p.LogGroupName!);
  }
  return assert.fail(`no Ref for ${Type}`);
}
function attribute(name: string, attr: string): string {
  const { Type, Properties: p } = resource(name);
  switch (`${Type}.${attr}`) {
    case 'AWS::DynamoDB::Table.Arn':
      return `arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${ref(name)}`;
    case 'AWS::DynamoDB::Table.StreamArn':
      return `${attribute(name, 'Arn')}/stream/2026-10-01T00:00:00.000`;
    case 'AWS::S3::Bucket.Arn':
      return `arn:aws:s3:::${ref(name)}`;
    case 'AWS::SQS::Queue.Arn':
      return `arn:aws:sqs:${REGION}:${ACCOUNT}:${resolve(p.QueueName!)}`;
    case 'AWS::Logs::LogGroup.Arn':
      return `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${ref(name)}:*`;
  }
  return assert.fail(`no GetAtt for ${Type}.${attr}`);
}
export function resolve(node: Node): string {
  if (typeof node === 'string') return node;
  const [[tag, arg]] = Object.entries(node) as [[string, Node]];
  if (tag === '!Ref') return ref(String(arg));
  if (tag === '!GetAtt') return attribute(...(String(arg).split('.') as [string, string]));
  if (tag === '!Sub')
    return String(arg).replace(/\$\{([^}]+)\}/g, (_, v: string) =>
      v.includes('.') ? attribute(...(v.split('.') as [string, string])) : ref(v)
    );
  if (tag === '!If') return resolve((arg as Node[])[1]!);
  return assert.fail(`no ${tag}`);
}

// IAM evaluation: every role statement here is an Allow.
export interface Statement {
  actions: string[];
  resources: string[];
  condition: Record<string, Record<string, Node>>;
}
export interface Request {
  action: string;
  resource: string;
  context?: Record<string, string | string[]>;
  via: string;
}
export function statements(role: string): Statement[] {
  const { Type, Properties } = resource(role);
  assert.equal(Type, 'AWS::IAM::Role');
  return (Properties.Policies as { PolicyDocument: { Statement: Record<string, Node>[] } }[])
    .flatMap((p) => p.PolicyDocument.Statement)
    .map((s) => {
      assert.equal(s.Effect, 'Allow', `${role} statements are modelled as Allow only`);
      return {
        actions: [s.Action!].flat().map(String),
        resources: [s.Resource!].flat().map(resolve),
        condition: (s.Condition ?? {}) as Statement['condition']
      };
    });
}
const glob = (pattern: string, flags = '') =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
    flags
  );
function holds(condition: Statement['condition'], context: Request['context'] = {}): boolean {
  const known = new Map(Object.entries(context).map(([k, v]) => [k.toLowerCase(), [v].flat()]));
  return Object.entries(condition).every(([operator, entries]) =>
    Object.entries(entries).every(([key, expected]) => {
      const [, set, op] = /^(?:(ForAllValues|ForAnyValue):)?(\w+)$/.exec(operator)!,
        wanted = [expected].flat().map(resolve),
        got = known.get(key.toLowerCase()),
        test = (v: string) =>
          wanted.some((w) =>
            op === 'StringLike' ? glob(w).test(v) : op === 'StringEquals' ? v === w : assert.fail(`${operator}?`)
          );
      return set === 'ForAllValues'
        ? (got ?? []).every(test)
        : set === 'ForAnyValue'
          ? (got ?? []).some(test)
          : got?.length === 1 && test(got[0]!);
    })
  );
}
export const grants = (s: Statement, r: Request) =>
  s.actions.some((a) => glob(a, 'i').test(r.action)) &&
  s.resources.some((p) => glob(p).test(r.resource)) &&
  holds(s.condition, r.context);
export const describe = (r: Request) =>
  `${r.via}: ${r.action} ${r.resource}${r.context ? ' ' + JSON.stringify(r.context) : ''}`;

// DynamoDB requests, from the fake table's SDK command log.
type Input = Record<string, unknown>;
const TABLE = attribute('Table', 'Arn'),
  ITEMS: Record<string, string> = {
    GetCommand: 'GetItem',
    PutCommand: 'PutItem',
    UpdateCommand: 'UpdateItem',
    DeleteCommand: 'DeleteItem',
    Put: 'PutItem',
    Update: 'UpdateItem',
    Delete: 'DeleteItem',
    ConditionCheck: 'ConditionCheckItem'
  };
const named = (input: Input, name: string) =>
  (input.ExpressionAttributeNames as Record<string, string> | undefined)?.[name] ?? name;
function attributes(input: Input): Record<string, string[]> {
  const projection = input.ProjectionExpression as string | undefined;
  return projection
    ? { 'dynamodb:Attributes': projection.split(',').map((p) => named(input, p.trim().split(/[.[]/)[0]!)) }
    : {};
}
function partition(input: Input): string {
  const key = (input.Key ?? input.Item) as Input | undefined;
  if (key) return String(key.pk);
  const [, name, value] = /(#?\w+) = (:\w+)/.exec(String(input.KeyConditionExpression)) ?? assert.fail('no key');
  assert.equal(named(input, name!), 'pk');
  return String((input.ExpressionAttributeValues as Input)[value!]);
}
export function dynamo(calls: { name: string; input: Input }[]): Request[] {
  return calls.flatMap(({ name, input }): Request[] => {
    const at = (action: string, context: Request['context'], via = name) => ({
      action: `dynamodb:${action}`,
      resource: TABLE,
      context,
      via
    });
    if (name in ITEMS) return [at(ITEMS[name]!, { 'dynamodb:LeadingKeys': [partition(input)], ...attributes(input) })];
    if (name === 'TransactWriteCommand')
      return (input.TransactItems as Input[]).map((op) => {
        const [kind, body] = Object.entries(op)[0] as [string, Input];
        return at(ITEMS[kind]!, { 'dynamodb:LeadingKeys': [partition(body)] }, `${name} ${kind}`);
      });
    if (name === 'BatchWriteCommand')
      return [
        at('BatchWriteItem', {
          'dynamodb:LeadingKeys': Object.values(input.RequestItems as Record<string, Input[]>)
            .flat()
            .map((r) =>
              String(
                ((r.DeleteRequest ?? r.PutRequest) as Input & { Key?: Input; Item?: Input }).Key?.pk ??
                  ((r.PutRequest as Input)?.Item as Input)?.pk
              )
            )
        })
      ];
    const select: Record<string, string> = input.Select ? { 'dynamodb:Select': String(input.Select) } : {};
    if (name === 'QueryCommand')
      return [at('Query', { 'dynamodb:LeadingKeys': [partition(input)], ...select, ...attributes(input) })];
    if (name === 'ScanCommand') return [at('Scan', { ...select, ...attributes(input) })];
    return assert.fail(`no IAM action for ${name}`);
  });
}

/** One function's view of AWS: its role and environment from the template,
 * and the requests its code made through the wrapped fakes. */
export class Recorder {
  readonly role: string;
  readonly env: Record<string, string>;
  readonly requests: Request[] = [];
  private readonly watched: [FakeStore, number][] = [];
  constructor(fn: string) {
    const { Type, Properties: p } = resource(fn),
      web = Type === 'AWS::Lambda::WebFunctionRevision',
      config = (web ? p.ServiceConfig : p) as Record<string, Node>,
      vars = (web ? config.EnvironmentVariables : (config.Environment as Record<string, Node>).Variables) as Record<
        string,
        Node
      >;
    this.role = String((config[web ? 'ExecutionRoleArn' : 'Role'] as Record<string, string>)['!GetAtt']).split('.')[0]!;
    this.env = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, resolve(v)]));
    this.platform(resolve(p.FunctionName!), config);
  }
  /** What Lambda itself does as the role: the function's log stream, its
   * dead-letter queue, and each event source mapping's stream reads and
   * failure destination. */
  private platform(name: string, config: Record<string, Node>) {
    const logs = (config.LoggingConfig ?? (config.TelemetryConfig as Record<string, Node>)?.LoggingConfig) as
        Record<string, Node> | undefined,
      group = resolve(logs?.LogGroup ?? assert.fail(`${name} names no log group`)),
      send = (via: string, target: Node) => {
        const arn = resolve(target);
        assert.match(arn, /^arn:aws:sqs:/, `${via} goes to a queue`);
        this.add(via, 'sqs:SendMessage', arn);
      };
    for (const action of ['logs:CreateLogStream', 'logs:PutLogEvents'])
      this.add(
        'Lambda logs',
        action,
        `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:${group}:log-stream:2026/10/20/[live]0`
      );
    const dead = (config.DeadLetterConfig as Record<string, Node> | undefined)?.TargetArn;
    if (dead) send('dead letters', dead);
    for (const [id, type] of RESOURCES) {
      if (type !== 'AWS::Lambda::EventSourceMapping' && type !== 'AWS::Lambda::EventInvokeConfig') continue;
      const { Properties: m } = resource(id),
        target = resolve(m.FunctionName!)
          .replace(/^arn:aws:lambda:[^:]+:\d+:function:/, '')
          .split(':')[0];
      if (target !== name) continue;
      const failure = ((m.DestinationConfig as Record<string, Record<string, Node>> | undefined)?.OnFailure ?? {})
        .Destination;
      if (failure) send(`${id} failures`, failure);
      if (type === 'AWS::Lambda::EventInvokeConfig') continue;
      const source = resolve(m.EventSourceArn!);
      assert.match(source, /^arn:aws:dynamodb:.*\/stream\//, `${id} reads a table stream`);
      for (const action of ['DescribeStream', 'GetRecords', 'GetShardIterator'])
        this.add(id, `dynamodb:${action}`, source);
      this.add(id, 'dynamodb:ListStreams', '*');
    }
  }
  add(via: string, action: string, resource: string, context?: Request['context']) {
    this.requests.push({ via, action, resource, ...(context ? { context } : {}) });
  }
  /** The table's requests from here on are this function's. */
  watch<T extends FakeStore>(store: T): T {
    this.watched.push([store, store.memory.calls.length]);
    return store;
  }
  /** Runs another function's code (an invoked worker) on a watched table; its
   * requests go to that function's recorder, not this one. */
  async aside<T>(store: FakeStore, other: Recorder | null, run: () => Promise<T>): Promise<T> {
    const before = store.memory.calls.length;
    try {
      return await run();
    } finally {
      const moved = store.memory.calls.splice(before);
      other?.requests.push(...dynamo(moved));
    }
  }
  objects(inner: Objects): Objects {
    const bucket = `arn:aws:s3:::${this.env.BUCKET ?? this.env.MAIL_BUCKET ?? assert.fail('no bucket')}`,
      s3 = (via: string, key: string, ...actions: string[]) =>
        actions.forEach((a) => this.add(`objects.${via}`, `s3:${a}`, `${bucket}/${key}`)),
      tagged = (tags?: Record<string, string>) => (tags && Object.keys(tags).length ? ['PutObjectTagging'] : []);
    return {
      get: (key, options = {}) => (
        s3('get', key, options.version ? 'GetObjectVersion' : 'GetObject'),
        inner.get(key, options)
      ),
      head: (key, version) => (s3('head', key, version ? 'GetObjectVersion' : 'GetObject'), inner.head(key, version)),
      put: (key, body, options) => (
        s3('put', key, 'PutObject', ...tagged(options.tags)),
        inner.put(key, body, options)
      ),
      // Over 8 MiB the zip goes in parts, and a failed part aborts the upload.
      uploadFile: (key, path, options) => (
        s3('uploadFile', key, 'PutObject', 'AbortMultipartUpload', ...tagged(options.tags)),
        inner.uploadFile(key, path, options)
      ),
      // CopyObject names the source version; tags are replaced, never copied.
      copy: (source, version, target, options) => (
        s3('copy', source, 'GetObjectVersion'),
        s3('copy', target, 'PutObject', ...tagged(options.tags)),
        inner.copy(source, version, target, options)
      ),
      remove: (key, version) => (
        s3('remove', key, version ? 'DeleteObjectVersion' : 'DeleteObject'),
        inner.remove(key, version)
      ),
      list: (prefix) => (
        this.add('objects.list', 's3:ListBucket', bucket, { 's3:prefix': prefix }),
        inner.list(prefix)
      ),
      tag: (key, tags) => (s3('tag', key, 'PutObjectTagging'), inner.tag(key, tags)),
      tags: (key, version) => (
        s3('tags', key, version ? 'GetObjectVersionTagging' : 'GetObjectTagging'),
        inner.tags(key, version)
      ),
      // A signed link or form acts as the role that signed it.
      download: (key, type, seconds, options) => (
        s3('download', key, 'GetObject'),
        inner.download(key, type, seconds, options)
      ),
      upload: (key, type, size, seconds) => (
        s3('upload', key, 'PutObject', 'PutObjectTagging'),
        inner.upload(key, type, size, seconds)
      )
    };
  }
  /** SESv2 SendEmail with Content.Raw is authorized as ses:SendEmail and
   * ses:SendRawEmail, on the sending identity, any recipient that is itself an
   * identity, and the configuration set, as the From the entry composes. */
  mail(inner: Mail): Mail {
    const from = this.env.FROM_ADDRESS ?? assert.fail('no FROM_ADDRESS'),
      ses = `arn:aws:ses:${REGION}:${ACCOUNT}`;
    return {
      send: (raw, to, kind) => {
        for (const action of ['ses:SendEmail', 'ses:SendRawEmail'])
          for (const resource of [
            `${ses}:identity/${from.split('@')[1]}`,
            `${ses}:identity/${to}`,
            `${ses}:configuration-set/${this.env.CONFIG_SET ?? assert.fail('no CONFIG_SET')}`
          ])
            this.add('mail.send', action, resource, { 'ses:FromAddress': fromHeader(from) });
        return inner.send(raw, to, kind);
      },
      unsuppress: (email) => (
        this.add('mail.unsuppress', 'ses:DeleteSuppressedDestination', '*'),
        inner.unsuppress(email)
      )
    };
  }
  invocations(inner: Invocations): Invocations {
    return {
      invoke: (name, payload, asynchronous) => {
        this.add('invoke', 'lambda:InvokeFunction', functionArn(name));
        return inner.invoke(name, payload, asynchronous);
      }
    };
  }
  /** Each statement action and resource that no request so far used: the
   * reverse check, that the role holds nothing its code does not ask for. */
  unused(): string[] {
    const all = [...this.requests, ...this.watched.flatMap(([store, from]) => dynamo(store.memory.calls.slice(from)))];
    return statements(this.role).flatMap((s) =>
      s.actions.flatMap((action) =>
        s.resources
          .filter((resource) => !all.some((r) => grants({ ...s, actions: [action], resources: [resource] }, r)))
          .map((resource) => `${action} ${resource}`)
      )
    );
  }
  /** Every request so far, after asserting the role grants each one. */
  granted(): Request[] {
    const all = [...this.requests, ...this.watched.flatMap(([store, from]) => dynamo(store.memory.calls.slice(from)))],
      rules = statements(this.role),
      denied = new Set(all.filter((r) => !rules.some((s) => grants(s, r))).map(describe));
    assert.deepEqual([...denied], [], `${this.role} does not grant what its code requests`);
    return all;
  }
}
export const functionArn = (name: string) =>
  name.startsWith('arn:') ? name : `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
