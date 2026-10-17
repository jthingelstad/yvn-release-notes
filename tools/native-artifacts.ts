/** Upload the native artifacts the build step packaged (tools/package-native.ts)
 * as immutable S3 versions and keep a receipt of exactly which versions, in the
 * receipts bucket. Each artifact is hashed again before upload, so a bundle
 * changed after the build is refused. Reads metadata only; never secret values. */
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { Manifest } from './package-native.ts';
import { createReceipt, type ReceiptStore } from './receipt-store.ts';
import { releaseIdentity, region, stackName } from './release-identity.ts';

type Kind = 'http' | 'workers';
const title = (name: string) => name[0]!.toUpperCase() + name.slice(1);
const keyFor = (kind: Kind, name: string, sha256: string) =>
  `native/${kind === 'workers' ? 'workers/' : ''}${name}/${sha256}.zip`;

export async function readManifest(directory: string, kind: Kind) {
  if (!isAbsolute(directory)) throw new Error('An absolute artifact directory is required');
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as Manifest;
  const artifacts = manifest.artifacts?.filter((artifact) => artifact.kind === kind) ?? [];
  if (
    manifest.schema !== 1 ||
    !artifacts.length ||
    artifacts.some(
      (artifact) =>
        !/^[a-z]+$/.test(artifact.name) ||
        artifact.file !== `${artifact.name}.zip` ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
  )
    throw new Error('Invalid artifact manifest');
  return artifacts;
}

/** True when any packaged artifact differs from the one the stack has published. */
export async function artifactsChanged(kind: Kind, directory: string, parameters: Record<string, string>) {
  return (await readManifest(directory, kind)).some(
    (artifact) =>
      parameters[kind === 'http' ? `Native${title(artifact.name)}CodeKey` : `${title(artifact.name)}NodeCodeKey`] !==
      keyFor(kind, artifact.name, artifact.sha256)
  );
}

export async function uploadArtifacts(kind: Kind, directory: string, commit: string, store: ReceiptStore) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A source commit is required');
  const artifacts = await readManifest(directory, kind);
  for (const artifact of artifacts) {
    const hash = createHash('sha256');
    for await (const bytes of createReadStream(resolve(directory, artifact.file))) hash.update(bytes);
    const digest = hash.digest();
    if (
      digest.toString('hex') !== artifact.sha256 ||
      digest.toString('base64') !== artifact.codeSha256 ||
      (await stat(resolve(directory, artifact.file))).size !== artifact.size
    )
      throw new Error('Artifact differs from its build manifest');
  }
  const identity = await releaseIdentity();
  const stack = (await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: stackName })))
    .Stacks?.[0];
  const bucket = stack?.Outputs?.find((o) => o.OutputKey === 'NativeSourceBucketName')?.OutputValue;
  if (
    !bucket ||
    !stack?.StackId?.startsWith(`arn:aws:cloudformation:${region}:${identity.account}:stack/${stackName}/`)
  )
    throw new Error('Missing native source bucket');
  const s3 = new S3Client({ region }),
    parameters: Record<string, string> =
      kind === 'http'
        ? { NativeWebFunctionsEnabled: 'true' }
        : { NativeWorkersEnabled: 'true', NativeWorkerBuildId: commit };
  const recorded = [];
  for (const artifact of artifacts) {
    const key = keyFor(kind, artifact.name, artifact.sha256),
      path = resolve(directory, artifact.file);
    let version: string | undefined;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (head.Metadata?.sha256 !== artifact.sha256 || head.ContentLength !== artifact.size || !head.VersionId)
        throw new Error('Existing immutable artifact does not match');
      version = head.VersionId;
    } catch (error) {
      if (!(error instanceof Error) || !['NotFound', 'NoSuchKey'].includes(error.name)) throw error;
      const added = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(path),
          ContentLength: artifact.size,
          ContentType: 'application/zip',
          ChecksumSHA256: artifact.codeSha256,
          IfNoneMatch: '*',
          Metadata: { sha256: artifact.sha256, commit },
          ServerSideEncryption: 'AES256'
        })
      );
      version = added.VersionId;
      const checked = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
      if (!version || checked.Metadata?.sha256 !== artifact.sha256 || checked.ContentLength !== artifact.size)
        throw new Error('Artifact upload was not confirmed');
    }
    const name = title(artifact.name);
    if (kind === 'http')
      Object.assign(parameters, {
        [`Native${name}CodeKey`]: key,
        [`Native${name}CodeVersion`]: version,
        [`Native${name}BuildId`]: commit
      });
    else
      Object.assign(parameters, {
        [`${name}NodeCodeKey`]: key,
        [`${name}NodeCodeVersion`]: version,
        [`${name}NodeCodeSha256`]: artifact.codeSha256
      });
    recorded.push({ kind: artifact.name, bucket, key, version, sha256: artifact.sha256, size: artifact.size });
  }
  await createReceipt(store, `artifacts-${randomUUID()}.json`, {
    schema: 1,
    stackId: stack.StackId,
    commit,
    region,
    recorded,
    savedAt: new Date().toISOString()
  });
  return { parameters };
}
