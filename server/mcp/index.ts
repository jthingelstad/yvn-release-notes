/** MCP has a separate read-only role with only the private capture invocation. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { Store } from '../../packages/backend/store.ts';
import { listen } from '../shared/listen.ts';
import { createMcpApp } from './app.ts';
import type { MediaReader } from './reader.ts';
const region = process.env.AWS_REGION ?? 'us-east-1',
  s3 = new S3Client({ region }),
  lambda = new LambdaClient({ region }),
  store = new Store(
    DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } }),
    process.env.TABLE ?? process.env.TABLE_NAME ?? ''
  );
const media: MediaReader = {
  async download(uid, key, type, seconds) {
    if (!key.startsWith(`media/${uid}/`)) throw new Error('File unavailable');
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: process.env.MAIL_BUCKET, Key: key, ResponseContentType: type }),
      { expiresIn: seconds }
    );
  },
  async bytes(uid, key, maximum) {
    if (!key.startsWith(`media/${uid}/`)) throw new Error('File unavailable');
    const { Body } = await s3.send(
      new GetObjectCommand({ Bucket: process.env.MAIL_BUCKET, Key: key, Range: `bytes=0-${maximum}` })
    );
    if (!Body) throw new Error('File unavailable');
    // A bounded range prevents downloading an unbounded original. Always consume
    // or cancel the stream so concurrent requests do not exhaust the socket pool.
    const reader = Body.transformToWebStream().getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        chunks.push(value);
        if (size > maximum) {
          await reader.cancel();
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
};
listen(
  createMcpApp({
    context: () => ({ store, media, origin: process.env.WEB_ORIGIN ?? '', now: Math.floor(Date.now() / 1000) }),
    async capture(event) {
      const response = await lambda.send(
        new InvokeCommand({
          FunctionName: process.env.CAPTURE_FUNCTION,
          InvocationType: 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(event))
        })
      );
      if (response.FunctionError || !response.Payload) throw new Error('Capture unavailable');
      return JSON.parse(Buffer.from(response.Payload).toString('utf8')) as unknown;
    }
  })
);
