/** Upload the code zips the build packaged (tools/package-native.ts) to the
 * stack's source bucket, each named by its SHA-256, and return the template
 * parameters that name them (AppCode, SenderCode, ...). A key is written once
 * (If-None-Match) and never changed, so a revert finds its code still there.
 * Each zip is hashed again first, so a bundle changed after the build is
 * refused. Reads metadata only; never secret values. */
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Manifest } from './package-native.ts';
import { releaseIdentity, region, stackName } from './release-identity.ts';

type Artifact = Manifest['artifacts'][number];
const title = (name: string) => name[0]!.toUpperCase() + name.slice(1);
/** The template parameter that names an artifact's code. */
export const codeParameter = (artifact: Pick<Artifact, 'name'>) => `${title(artifact.name)}Code`;
export const keyFor = (artifact: Pick<Artifact, 'kind' | 'name' | 'sha256'>) =>
  `native/${artifact.kind === 'workers' ? 'workers/' : ''}${artifact.name}/${artifact.sha256}.zip`;

export async function readManifest(directory: string) {
  if (!isAbsolute(directory)) throw new Error('An absolute artifact directory is required');
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8')) as Manifest;
  const artifacts = manifest.artifacts ?? [];
  if (
    manifest.schema !== 1 ||
    !artifacts.some((artifact) => artifact.kind === 'http') ||
    !artifacts.some((artifact) => artifact.kind === 'workers') ||
    new Set(artifacts.map((artifact) => artifact.name)).size !== artifacts.length ||
    artifacts.some(
      (artifact) =>
        !['http', 'workers'].includes(artifact.kind) ||
        !/^[a-z]+$/.test(artifact.name) ||
        artifact.file !== `${artifact.name}.zip` ||
        !/^[a-f0-9]{64}$/.test(artifact.sha256)
    )
  )
    throw new Error('Invalid artifact manifest');
  return artifacts;
}

export async function uploadArtifacts(directory: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('A source commit is required');
  const artifacts = await readManifest(directory);
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
    parameters: Record<string, string> = {};
  for (const artifact of artifacts) {
    const key = keyFor(artifact);
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (head.Metadata?.sha256 !== artifact.sha256 || head.ContentLength !== artifact.size)
        throw new Error('Existing artifact does not match');
    } catch (error) {
      if (!(error instanceof Error) || !['NotFound', 'NoSuchKey'].includes(error.name)) throw error;
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(resolve(directory, artifact.file)),
          ContentLength: artifact.size,
          ContentType: 'application/zip',
          ChecksumSHA256: artifact.codeSha256,
          IfNoneMatch: '*',
          Metadata: { sha256: artifact.sha256, commit },
          ServerSideEncryption: 'AES256'
        })
      );
      const checked = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (checked.Metadata?.sha256 !== artifact.sha256 || checked.ContentLength !== artifact.size)
        throw new Error('Artifact upload was not confirmed');
    }
    parameters[codeParameter(artifact)] = artifact.sha256;
  }
  return { parameters };
}
