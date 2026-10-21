import { runtimeSelfTest } from '../runtime.ts';
/** Production SES entry: parsing, ownership checks and writes live in the pure
 * inbound handler. The SES adapter receives the named From; MIME gets raw email.
 * It also reads the inbound failed queue, and hands what it logged from there
 * on to the failed queue. */
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createStore, createObjects, createMail } from '../../packages/backend/aws.ts';
import { safeLog } from '../../packages/backend/services.ts';
import { fromHeader } from '../../packages/mail/compose.ts';
import { handler as inbound, type InboundServices } from '../inbound.ts';

let services: InboundServices | undefined;
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker configuration ${name}`);
  return value;
}
export async function handler(event: Parameters<typeof inbound>[0], context: unknown) {
  if (runtimeSelfTest(event)) return runtimeSelfTest(event);
  if (!services) {
    const region = process.env.AWS_REGION ?? 'us-east-1',
      fromAddress = env('FROM_ADDRESS'),
      failed = env('FAILED_QUEUE'),
      sqs = new SQSClient({ region });
    services = {
      store: createStore(env('TABLE'), region),
      objects: createObjects(env('BUCKET'), region),
      mail: createMail(fromHeader(fromAddress), env('CONFIG_SET'), region),
      fromAddress,
      inboundDomain: env('INBOUND_DOMAIN'),
      log: safeLog,
      forward: async (body) => {
        await sqs.send(new SendMessageCommand({ QueueUrl: failed, MessageBody: body }));
      }
    };
  }
  return inbound(event, context, services);
}
