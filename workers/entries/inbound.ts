/** Production SES entry: parsing, ownership checks and writes live in the pure
 * inbound handler. The SES adapter receives the named From; MIME gets raw email. */
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
  if (!services) {
    const region = process.env.AWS_REGION ?? 'us-east-1',
      fromAddress = env('FROM_ADDRESS');
    services = {
      store: createStore(env('TABLE'), region),
      objects: createObjects(env('BUCKET'), region),
      mail: createMail(fromHeader(fromAddress), env('CONFIG_SET'), region),
      fromAddress,
      inboundDomain: env('INBOUND_DOMAIN'),
      log: safeLog
    };
  }
  return inbound(event, context, services);
}
