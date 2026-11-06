// The API reference page (/guide/api/reference/), drawn from
// contracts/api-surface.json, the same description /v1/openapi.json serves, so
// the page can't say anything the API doesn't. Markdown, so it goes the way the
// other pages go. No JSX: the server's tests read it as it is.
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const anchor = (words: string) =>
  words
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
// A table's cell is one line, and a bar in it would end the cell.
const cell = (words: unknown) =>
  String(words ?? '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\|/g, '\\|');
const nameOf = (ref: string) => ref.split('/').at(-1)!;
const linkTo = (ref: string) => `[${nameOf(ref)}](#${anchor(nameOf(ref))})`;

/** What a value is, in a few words, with a link for a named object. */
function typeOf(schema: Doc | undefined): string {
  if (!schema) return 'any';
  if (schema.$ref) return linkTo(schema.$ref);
  for (const list of ['anyOf', 'oneOf']) {
    if (!schema[list]) continue;
    const kinds = (schema[list] as Doc[]).filter((s) => s.type !== 'null').map(typeOf),
      nullable = (schema[list] as Doc[]).some((s) => s.type === 'null');
    return [...new Set(kinds)].join(' or ') + (nullable ? ' or null' : '');
  }
  if (schema.const !== undefined) return '`' + String(schema.const) + '`';
  if (schema.enum) return (schema.enum as unknown[]).map((v) => '`' + String(v) + '`').join(', ');
  if (Array.isArray(schema.type)) {
    const kinds = (schema.type as string[]).filter((t) => t !== 'null').map((type) => typeOf({ ...schema, type })),
      nullable = (schema.type as string[]).includes('null');
    return kinds.join(' or ') + (nullable ? ' or null' : '');
  }
  if (schema.type === 'array') return 'list of ' + typeOf(schema.items);
  if (schema.format === 'date-time') return 'time';
  if (schema.format === 'date') return 'day';
  return String(schema.type ?? 'any');
}

/** What it must be, beyond its type: a length, a range or a pattern's absence. */
function bounds(schema: Doc | undefined): string {
  if (!schema) return '';
  const said: string[] = [];
  if (schema.maxLength !== undefined) said.push(`up to ${schema.maxLength} characters`);
  if (schema.maxItems !== undefined) said.push(`up to ${schema.maxItems}`);
  if (schema.minimum !== undefined && schema.maximum !== undefined) said.push(`${schema.minimum} to ${schema.maximum}`);
  else if (schema.maximum !== undefined) said.push(`at most ${schema.maximum}`);
  else if (schema.minimum !== undefined) said.push(`at least ${schema.minimum}`);
  if (schema.default !== undefined) said.push(`${String(schema.default)} if left out`);
  return said.length ? ` (${said.join(', ')})` : '';
}

/** An object made of others (`allOf`), as the one object it reads as. */
function composed(schema: Doc, schemas: Record<string, Doc>): Doc {
  if (!schema.allOf) return schema;
  const parts = (schema.allOf as Doc[]).map((part) =>
    composed(part.$ref ? schemas[nameOf(part.$ref as string)]! : part, schemas)
  );
  return {
    ...schema,
    required: [...(schema.required ?? []), ...parts.flatMap((part) => (part.required ?? []) as string[])],
    properties: Object.assign({}, ...parts.map((part) => part.properties), schema.properties)
  };
}

function fields(schema: Doc): string {
  const required = new Set<string>(schema.required ?? []),
    rows = Object.entries((schema.properties ?? {}) as Record<string, Doc>).map(
      ([name, field]) =>
        `| \`${name}\`${required.has(name) ? ' (required)' : ''} | ${cell(typeOf(field) + bounds(field))} | ${cell(field.description)} |`
    );
  return rows.length ? `| Field | Type | What it is |\n| --- | --- | --- |\n${rows.join('\n')}\n` : '';
}

/** What a request needs, in a sentence. */
export function needs(operation: Doc): string {
  const security = operation.security as Doc[] | undefined;
  if (security && !security.length) return 'No token.';
  const scopes = [...new Set((security ?? []).flatMap((s) => Object.values(s).flat() as string[]))];
  return scopes.length ? 'Needs ' + scopes.map((s) => `\`${s}\``).join(' or ') + '.' : 'Any token.';
}

function parameters(operation: Doc, components: Doc): string {
  const rows = ((operation.parameters ?? []) as Doc[]).map((p) => {
    const it = p.$ref ? (components.parameters[nameOf(p.$ref)] as Doc) : p;
    return `| \`${it.name}\`${it.required ? ' (required)' : ''} | ${it.in} | ${cell(typeOf(it.schema) + bounds(it.schema))} | ${cell(it.description)} |`;
  });
  return rows.length
    ? `| Parameter | Where | Type | What it is |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`
    : '';
}

function body(operation: Doc): string {
  const content = operation.requestBody?.content as Record<string, Doc> | undefined;
  if (!content) return '';
  const kinds = Object.entries(content).map(([type, { schema }]) => `\`${type}\`: ${typeOf(schema as Doc)}`);
  return `Send ${kinds.join('; or ')}.\n`;
}

function answers(operation: Doc): string {
  const rows = Object.entries((operation.responses ?? {}) as Record<string, Doc>)
    .filter(([status]) => status !== 'default')
    .map(([status, answer]) => {
      const json = answer.content?.['application/json']?.schema as Doc | undefined;
      return `\`${status}\`${json ? ' ' + typeOf(json) : ''}`;
    });
  return rows.length ? `Answers ${rows.join(', ')}.\n` : '';
}

/** Everything, in the order the description's tags give, with a list of the
 * requests up top and the objects they name at the foot. */
/** Every request in the description, as `GET /v1/me` and its operation. */
export const operationsOf = (spec: Doc) =>
  Object.entries(spec.paths as Record<string, Doc>).flatMap(([path, methods]) =>
    METHODS.flatMap((method) =>
      methods[method] ? [{ key: `${method.toUpperCase()} ${path}`, op: methods[method] as Doc }] : []
    )
  );

export function referenceMarkdown(spec: Doc): string {
  const operations = operationsOf(spec);
  const parts: string[] = [];
  for (const tag of spec.tags as Doc[]) {
    const ours = operations.filter((o) => (o.op.tags as string[]).includes(tag.name));
    parts.push(`## ${tag.name}\n\n${tag.description}\n`);
    parts.push(
      '| Request | What it does |\n| --- | --- |\n' +
        ours.map((o) => `| [\`${o.key}\`](#${anchor(o.key)}) | ${cell(o.op.summary)} |`).join('\n') +
        '\n'
    );
    for (const { key, op } of ours)
      parts.push(
        [
          `### \`${key}\``,
          `**${op.summary}.** ${op.description ?? ''}`.trim(),
          needs(op),
          parameters(op, spec.components),
          body(op),
          answers(op)
        ]
          .filter(Boolean)
          .join('\n\n')
      );
  }
  parts.push('## Objects\n\nWhat the requests above send and answer.\n');
  for (const [name, schema] of Object.entries(spec.components.schemas as Record<string, Doc>)) {
    const whole = composed(schema, spec.components.schemas),
      shape = whole.properties ? fields(whole) : `It is ${typeOf(whole)}.\n`;
    parts.push([`### ${name}`, schema.description ?? '', shape].filter(Boolean).join('\n\n'));
  }
  return parts.join('\n\n') + '\n';
}
