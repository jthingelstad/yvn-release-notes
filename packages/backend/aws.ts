/** Narrow AWS SDK v3 adapters. Clients are reusable; per-request identity and
 * mutable session state belong to the caller, never to a warm global. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectTaggingCommand,
  GetObjectTaggingCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { SESv2Client, SendEmailCommand, DeleteSuppressedDestinationCommand } from '@aws-sdk/client-sesv2';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { Readable } from 'node:stream';
import { createReadStream } from 'node:fs';
import { stat, open } from 'node:fs/promises';
import { Store } from './store.ts';
import type { Invocations, Mail, Objects, ObjectWrite } from './services.ts';

export function createStore(table: string, region = 'us-east-1') {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true }
  });
  return new Store(client, table);
}
const tagSet = (tags: Record<string, string>) => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
const tagging = (tags: Record<string, string> = {}) => new URLSearchParams(tags).toString();
const writeFields = (options: ObjectWrite) => ({
  ContentType: options.type,
  ContentDisposition: options.disposition ?? 'inline',
  Tagging: tagging(options.tags),
  Metadata: options.metadata
});

export function createObjects(bucket: string, region = 'us-east-1', injected?: S3Client): Objects {
  const client = injected ?? new S3Client({ region, forcePathStyle: false });
  return {
    async get(key, options = {}) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: options.version, Range: options.range })
      );
      const maxBytes = options.maxBytes ?? 50 * 1024 * 1024;
      if ((result.ContentLength ?? 0) > maxBytes) {
        if (result.Body instanceof Readable) result.Body.destroy();
        throw new RangeError('Object exceeds read limit');
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (result.Body) {
        const stream = result.Body as AsyncIterable<Uint8Array>;
        try {
          for await (const chunk of stream) {
            size += chunk.length;
            if (size > maxBytes) throw new RangeError('Object exceeds read limit');
            chunks.push(Buffer.from(chunk));
          }
        } catch (error) {
          if (result.Body instanceof Readable) result.Body.destroy();
          throw error;
        }
      }
      return {
        body: Buffer.concat(chunks),
        size,
        type: result.ContentType ?? '',
        version: result.VersionId,
        metadata: result.Metadata ?? {}
      };
    },
    async head(key, version) {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
      return {
        size: result.ContentLength ?? 0,
        type: result.ContentType ?? '',
        version: result.VersionId,
        metadata: result.Metadata ?? {}
      };
    },
    async put(key, body, options) {
      const result = await client.send(
        new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ...writeFields(options) })
      );
      return result.VersionId;
    },
    async uploadFile(key, path, options) {
      const size = (await stat(path)).size,
        partSize = 8 * 1024 * 1024;
      if (size <= partSize) {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: createReadStream(path),
            ContentLength: size,
            ...writeFields(options)
          })
        );
        return;
      }
      const created = await client.send(
        new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ...writeFields(options) })
      );
      if (!created.UploadId) throw new Error('Missing multipart upload');
      const uploadId = created.UploadId,
        parts: Array<{ PartNumber: number; ETag: string }> = [];
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(path, 'r');
        if (Math.ceil(size / partSize) > 10000) throw new RangeError('Export exceeds multipart limit');
        let offset = 0;
        while (offset < size) {
          const body = Buffer.allocUnsafe(Math.min(partSize, size - offset));
          let filled = 0;
          while (filled < body.length) {
            const { bytesRead } = await file.read(body, filled, body.length - filled, offset + filled);
            if (!bytesRead) throw new Error('Export changed during upload');
            filled += bytesRead;
          }
          const partNumber = parts.length + 1;
          const answer = await client.send(
            new UploadPartCommand({
              Bucket: bucket,
              Key: key,
              UploadId: uploadId,
              PartNumber: partNumber,
              Body: body,
              ContentLength: body.length
            })
          );
          if (!answer.ETag) throw new Error('Missing multipart receipt');
          parts.push({ PartNumber: partNumber, ETag: answer.ETag });
          offset += body.length;
        }
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucket,
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
          })
        );
      } catch (error) {
        await client
          .send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }))
          .catch(() => undefined);
        throw error;
      } finally {
        await file?.close();
      }
    },
    async copy(source, version, target, options) {
      const encoded = `${encodeURIComponent(bucket)}/${source.split('/').map(encodeURIComponent).join('/')}`;
      await client.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: target,
          CopySource: `${encoded}?versionId=${encodeURIComponent(version)}`,
          MetadataDirective: 'REPLACE',
          TaggingDirective: 'REPLACE',
          ...writeFields(options)
        })
      );
    },
    async remove(key, version) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
    },
    async list(prefix) {
      const keys: string[] = [];
      let cursor: string | undefined;
      do {
        const result = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: cursor })
        );
        for (const object of result.Contents ?? []) if (object.Key) keys.push(object.Key);
        cursor = result.IsTruncated ? result.NextContinuationToken : undefined;
        if (result.IsTruncated && !cursor) throw new Error('Missing object continuation');
      } while (cursor);
      return keys;
    },
    async tag(key, tags) {
      await client.send(new PutObjectTaggingCommand({ Bucket: bucket, Key: key, Tagging: { TagSet: tagSet(tags) } }));
    },
    async download(key, type, seconds, options = {}) {
      return getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentType: type,
          ResponseContentDisposition: options.disposition ?? 'inline',
          ResponseCacheControl: options.cache ?? `private, max-age=${seconds}`
        }),
        { expiresIn: seconds }
      );
    },
    async tags(key, version) {
      const answer = await client.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: key, VersionId: version }));
      return Object.fromEntries(
        (answer.TagSet ?? []).filter((t) => t.Key !== undefined && t.Value !== undefined).map((t) => [t.Key!, t.Value!])
      );
    },
    async upload(key, type, size, seconds) {
      return createPresignedPost(client, {
        Bucket: bucket,
        Key: key,
        Expires: seconds,
        Fields: {
          'Content-Type': type,
          tagging: '<Tagging><TagSet><Tag><Key>outcome</Key><Value>pending</Value></Tag></TagSet></Tagging>'
        },
        Conditions: [
          ['eq', '$Content-Type', type],
          ['content-length-range', size, size],
          ['eq', '$tagging', '<Tagging><TagSet><Tag><Key>outcome</Key><Value>pending</Value></Tag></TagSet></Tagging>']
        ]
      });
    }
  };
}
export function createMail(from: string, configurationSet: string, region = 'us-east-1'): Mail {
  const client = new SESv2Client({ region });
  return {
    async send(raw, to, kind = 'account') {
      const answer = await client.send(
        new SendEmailCommand({
          FromEmailAddress: from,
          Destination: { ToAddresses: [to] },
          ConfigurationSetName: configurationSet,
          Content: { Raw: { Data: raw } },
          EmailTags: [{ Name: 'release-notes-mail', Value: kind }]
        })
      );
      return answer.MessageId ?? '';
    },
    async unsuppress(email) {
      try {
        await client.send(new DeleteSuppressedDestinationCommand({ EmailAddress: email }));
      } catch (error) {
        if (!(error instanceof Error && error.name === 'NotFoundException')) throw error;
      }
    }
  };
}
export function createInvocations(region = 'us-east-1'): Invocations {
  const client = new LambdaClient({ region });
  return {
    async invoke(name, payload, asynchronous = true) {
      const result = await client.send(
        new InvokeCommand({
          FunctionName: name,
          InvocationType: asynchronous ? 'Event' : 'RequestResponse',
          Payload: Buffer.from(JSON.stringify(payload))
        })
      );
      if (result.FunctionError) throw new Error('Worker invocation failed');
      return result.Payload?.length ? JSON.parse(Buffer.from(result.Payload).toString('utf8')) : null;
    }
  };
}

/** The Turnstile widget's secret: `TURNSTILE_SECRET_KEY` in the hand-kept
 * runtime secret (no stack resource). A secret or key that is not there yet is '' (checks record
 * `unconfigured`), looked for again after five minutes; a value is kept for
 * the container's life. Other failures throw (checks record `error`). */
export function createTurnstileSecret(
  secretId: string,
  region = 'us-east-1',
  client: Pick<SecretsManagerClient, 'send'> = new SecretsManagerClient({ region }),
  clock = () => Date.now()
): () => Promise<string> {
  let kept: { value: string; until: number } | null = null;
  return async () => {
    if (!secretId) return '';
    if (kept && clock() < kept.until) return kept.value;
    let raw: string | undefined;
    try {
      raw = (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
    } catch (error) {
      if ((error as Error)?.name !== 'ResourceNotFoundException') throw error;
    }
    let value = '';
    try {
      const parsed: unknown = JSON.parse(raw ?? '{}');
      const key = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).TURNSTILE_SECRET_KEY : '';
      value = typeof key === 'string' ? key.trim() : '';
    } catch {
      value = '';
    }
    kept = { value, until: value ? Infinity : clock() + 300_000 };
    return value;
  };
}
