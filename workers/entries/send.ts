import { runtimeSelfTest } from '../runtime.ts';
/** Production sender entry: reusable service clients, subscriber-local state in
 * the pure handler. Existing BUCKET/env contract and raw Event logs are kept. */
import { createStore, createObjects, createMail } from '../../packages/backend/aws.ts';
import { safeLog } from '../../packages/backend/services.ts';
import { report } from '../../packages/backend/census.ts';
import { fromHeader } from '../../packages/mail/compose.ts';
import { handler as send, type SenderServices, type SenderEvent, type LambdaContext } from '../send.ts';

let services: SenderServices | undefined;
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker configuration ${name}`);
  return value;
}
export async function handler(event: SenderEvent | null, context: LambdaContext | null) {
  if (runtimeSelfTest(event)) return runtimeSelfTest(event);
  if (!services) {
    const region = process.env.AWS_REGION ?? 'us-east-1',
      fromAddress = env('FROM_ADDRESS');
    services = {
      store: createStore(env('TABLE'), region),
      objects: createObjects(env('BUCKET'), region),
      mail: createMail(fromHeader(fromAddress), env('CONFIG_SET'), region),
      fromAddress,
      inboundDomain: env('INBOUND_DOMAIN'),
      log: safeLog,
      report
    };
  }
  return send(event, context, services);
}
