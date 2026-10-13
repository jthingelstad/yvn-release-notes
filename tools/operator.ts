/** Shared local operator plumbing. Importing tools never constructs AWS clients.
 * Real writes require an explicit --write invocation and the existing narrow
 * cloud-engineer identity; each run still needs the human operator's go. */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { QueryCommand, ScanCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { QueryCommandInput, ScanCommandInput, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createStore, createObjects } from '../packages/backend/aws.ts';
import type { Store, Item, Key } from '../packages/backend/store.ts';
import { normalEmail as normalize } from '../packages/backend/auth.ts';
export const TABLE = 'yvn-release-notes',
  ACCOUNT = '999153317627',
  BUCKET = `yvn-release-notes-mail-${ACCOUNT}`,
  REGION = 'us-east-1';
export class OperatorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorError';
  }
}
export function argumentsFor(
  args: string[],
  options: Record<string, { type: 'string' | 'boolean'; multiple?: boolean; default?: string | boolean }> = {}
) {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean' },
      write: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      ...options
    }
  });
  return { ...parsed, values: parsed.values as Record<string, string | string[] | boolean | undefined> };
}
export function writing(values: Record<string, unknown>): boolean {
  if (values.write && values['dry-run']) throw new OperatorError('Choose --write or --dry-run');
  return values.write === true;
}
export async function assertWriter(client = new STSClient({ region: REGION })): Promise<void> {
  const who = await client.send(new GetCallerIdentityCommand({}));
  if (who.Account !== ACCOUNT || !who.Arn?.includes('assumed-role/ProjectsCloudEngineer/'))
    throw new OperatorError('Refusing: not the cloud-engineer identity');
}
export async function runtime(write = false) {
  process.env.AWS_PROFILE ??= 'cloud-engineer';
  if (write) await assertWriter();
  return { store: createStore(TABLE, REGION), objects: createObjects(BUCKET, REGION) };
}
export async function subscriber(store: Store, email: string): Promise<[string, Item]> {
  const address = normalize(email);
  if (!address) throw new OperatorError('Invalid subscriber address');
  const user = await store.userForEmail(address),
    profile = user ? await store.profile(user, true) : null;
  if (!user || !profile || profile.mcp_deleting) throw new OperatorError('No subscriber with that address');
  return [user, profile];
}
export async function scan(store: Store, input: Omit<ScanCommandInput, 'TableName'>): Promise<Item[]> {
  const rows: Item[] = [];
  let cursor: Key | undefined;
  do {
    const result = await store.client.send(
      new ScanCommand({ TableName: store.tableName, ...input, ExclusiveStartKey: cursor })
    );
    rows.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
export async function query(
  store: Store,
  user: string,
  prefix: string,
  options: Partial<QueryCommandInput> = {}
): Promise<Item[]> {
  const rows: Item[] = [];
  let cursor: Key | undefined;
  do {
    const result = await store.client.send(
      new QueryCommand({
        TableName: store.tableName,
        KeyConditionExpression: 'pk = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':u': `USER#${user}`, ':p': prefix },
        ...options,
        ExclusiveStartKey: cursor
      })
    );
    rows.push(...(result.Items ?? []));
    cursor = result.LastEvaluatedKey;
  } while (cursor);
  return rows;
}
export async function guardedWrite(
  store: Store,
  user: string,
  operation: NonNullable<TransactWriteCommandInput['TransactItems']>[number]
): Promise<boolean> {
  try {
    await store.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: store.tableName,
              Key: { pk: `USER#${user}`, sk: 'PROFILE' },
              ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(mcp_deleting)'
            }
          },
          operation
        ]
      })
    );
    return true;
  } catch (error) {
    if (
      (error as Error).name === 'TransactionCanceledException' &&
      ((error as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).some(
        (r) => r.Code === 'ConditionalCheckFailed'
      )
    )
      return false;
    throw error;
  }
}
export function invoked(url: string): boolean {
  return Boolean(process.argv[1]) && url === pathToFileURL(resolve(process.argv[1]!)).href;
}
export async function launch(main: (args: string[]) => Promise<void>, args = process.argv.slice(2)) {
  try {
    await main(args);
  } catch (error) {
    process.stderr.write(`${error instanceof OperatorError ? error.message : 'Operator tool failed'}\n`);
    process.exitCode = 1;
  }
}
