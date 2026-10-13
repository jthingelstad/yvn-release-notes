/** Ordinary web mutations prove the live email session and account in the
 * same DynamoDB transaction. A wrapper preserves Store's native request shapes
 * and merges proofs for keys already being changed (DynamoDB forbids duplicates).
 * Account deletion uses its original store after blocking the account. */
import { GetCommand, TransactWriteCommand, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { Store } from './store.ts';
import type { DocumentSender, DocumentResult, StoreCommand } from './store-types.ts';
type Ops = NonNullable<TransactWriteCommandInput['TransactItems']>;
type Operation = Ops[number];
export function withWebProof(
  store: Store,
  uid: string,
  hash: string,
  now: number,
  options: { allowDeleting?: boolean } = {}
): Store {
  const profile = { pk: 'USER#' + uid, sk: 'PROFILE' },
    session = { pk: 'SESSION#' + hash, sk: 'SESSION' };
  const sender: DocumentSender = {
    async send(command: StoreCommand): Promise<DocumentResult> {
      const name = command.constructor.name,
        input = command.input;
      if (!['PutCommand', 'UpdateCommand', 'DeleteCommand', 'TransactWriteCommand', 'BatchWriteCommand'].includes(name))
        return store.client.send(command);
      if (name === 'BatchWriteCommand') throw new Error('Batch writes require explicit deletion authority');
      let operations: Ops;
      let mergedProof = false;
      if (command instanceof TransactWriteCommand) operations = structuredClone(command.input.TransactItems ?? []);
      else {
        const fields = { ...input };
        delete (fields as Record<string, unknown>).ReturnValues;
        operations = [{ [name.replace('Command', '')]: fields } as Operation];
      }
      for (const [key, proof, names, values] of [
        [
          profile,
          options.allowDeleting
            ? 'attribute_exists(pk)'
            : 'attribute_exists(pk) AND attribute_not_exists(#webDeleting)',
          options.allowDeleting ? {} : { '#webDeleting': 'mcp_deleting' },
          {}
        ],
        [
          session,
          'attribute_exists(pk) AND #webUser = :webUser AND #webExpires > :webNow',
          { '#webUser': 'user_id', '#webExpires': 'expires_at' },
          { ':webUser': uid, ':webNow': now }
        ]
      ] as const) {
        const found = operations.find((op) => {
          const entry = op.Put ?? op.Update ?? op.Delete ?? op.ConditionCheck;
          const target = entry && ('Key' in entry ? entry.Key : entry.Item);
          return target?.pk === key.pk && target.sk === key.sk;
        });
        if (found) {
          mergedProof = true;
          const entry = found.Put ?? found.Update ?? found.Delete ?? found.ConditionCheck!;
          entry.ConditionExpression = entry.ConditionExpression
            ? `(${entry.ConditionExpression}) AND (${proof})`
            : proof;
          if (Object.keys(names).length)
            entry.ExpressionAttributeNames = { ...entry.ExpressionAttributeNames, ...names };
          if (Object.keys(values).length)
            entry.ExpressionAttributeValues = { ...entry.ExpressionAttributeValues, ...values };
        } else
          operations.push({
            ConditionCheck: {
              TableName: store.tableName,
              Key: key,
              ConditionExpression: proof,
              ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
              ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {})
            }
          });
      }
      try {
        await store.client.send(new TransactWriteCommand({ TransactItems: operations }));
      } catch (error) {
        // Store's conditional single-item methods expect their original error
        // kind (e.g. a full upload counter returns false). Translate only an
        // independently refused primary operation with both web proofs intact.
        // Merged proofs, unknown outcomes and real transactions remain errors.
        const reasons =
          error instanceof Error && error.name === 'TransactionCanceledException'
            ? (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons
            : undefined;
        if (
          name !== 'TransactWriteCommand' &&
          !mergedProof &&
          reasons?.length === operations.length &&
          reasons[0]?.Code === 'ConditionalCheckFailed' &&
          reasons.slice(1).every((reason) => reason.Code === 'None')
        )
          throw Object.assign(new Error('Conditional check failed', { cause: error }), {
            name: 'ConditionalCheckFailedException'
          });
        throw error;
      }
      if (
        name === 'UpdateCommand' &&
        'ReturnValues' in input &&
        input.ReturnValues &&
        input.ReturnValues !== 'NONE' &&
        'Key' in input
      ) {
        const got = await store.client.send(
          new GetCommand({ TableName: store.tableName, Key: input.Key, ConsistentRead: true })
        );
        return { Attributes: got.Item };
      }
      return {};
    }
  };
  return new Store(sender, store.tableName);
}
