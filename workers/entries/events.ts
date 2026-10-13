import { runtimeSelfTest } from '../runtime.ts';
/** Production SES-notification entry. Only the pure handler's scrubbed kinds
 * and internal user IDs are published; never the source SNS event or headers. */
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { createStore } from '../../packages/backend/aws.ts';
import { safeLog } from '../../packages/backend/services.ts';
import { handler as events, type EventServices } from '../events.ts';

let services: EventServices | undefined;
function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing worker configuration ${name}`);
  return value;
}
export async function handler(event: Parameters<typeof events>[0], context: unknown) {
  if (runtimeSelfTest(event)) return runtimeSelfTest(event);
  if (!services) {
    const region = process.env.AWS_REGION ?? 'us-east-1',
      topic = env('ALARM_TOPIC'),
      sns = new SNSClient({ region });
    services = {
      store: createStore(env('TABLE'), region),
      publish: async (line) => {
        await sns.send(
          new PublishCommand({
            TopicArn: topic,
            Subject: 'Release Notes mail event',
            Message: JSON.stringify(line)
          })
        );
      },
      log: safeLog
    };
  }
  return events(event, context, services);
}
