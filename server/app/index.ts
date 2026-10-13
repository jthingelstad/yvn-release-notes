import { fromHeader } from '../../packages/mail/compose.ts';
import { createApp } from './app.ts';
import { listen } from '../shared/listen.ts';
import { createStore, createObjects, createMail, createInvocations } from '../../packages/backend/aws.ts';
const region = process.env.AWS_REGION ?? 'us-east-1',
  store = createStore(process.env.TABLE ?? '', region),
  objects = createObjects(process.env.MAIL_BUCKET ?? '', region),
  mail = createMail(fromHeader(process.env.FROM_ADDRESS ?? ''), process.env.CONFIG_SET ?? '', region),
  invocations = createInvocations(region);
listen(
  createApp({
    context: () => ({
      log: (fields) => console.info(fields),
      store,
      objects,
      mail,
      invocations,
      origin: process.env.WEB_ORIGIN ?? '',
      now: Math.floor(Date.now() / 1000),
      from: process.env.FROM_ADDRESS ?? '',
      inboundDomain: process.env.INBOUND_DOMAIN ?? '',
      senderFunction: process.env.SENDER_FUNCTION ?? '',
      exportFunction: process.env.EXPORT_FUNCTION ?? '',
      adminUserId: process.env.ADMIN_USER_ID ?? ''
    })
  })
);
