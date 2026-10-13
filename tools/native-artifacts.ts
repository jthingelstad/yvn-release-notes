/** Upload immutable native HTTP artifacts and retain an exact source-version
 * receipt outside the public repo. Reads metadata only; never secret values. */
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile, stat, realpath } from 'node:fs/promises';
import { resolve, isAbsolute, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { packageHttp } from './package-native.ts';
export async function main(args = process.argv.slice(2)) {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Artifacts require Node 24');
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--build-dir', '--receipt-dir', '--commit'].includes(args[i] ?? '') || !args[i + 1] || options[args[i]!])
      throw new Error('Invalid artifact option');
    options[args[i]!] = args[i + 1]!;
  }
  const build = options['--build-dir'],
    receipt = options['--receipt-dir'],
    commit = options['--commit'];
  if (!build || !receipt || !isAbsolute(build) || !isAbsolute(receipt) || !commit || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error('Absolute build/receipt paths and a source commit are required');
  await mkdir(receipt, { recursive: true, mode: 0o700 });
  const dir = await realpath(receipt),
    repo = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    within = relative(repo, dir);
  if (
    within === '' ||
    (!within.startsWith(`..${sep}`) && within !== '..' && !isAbsolute(within)) ||
    ((await stat(dir)).mode & 0o077) !== 0
  )
    throw new Error('Receipts require a private directory outside the repository');
  const region = 'us-east-1',
    sts = new STSClient({ region });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (identity.Account !== '999153317627' || !identity.Arn?.includes(':assumed-role/ProjectsCloudEngineer/'))
    throw new Error('Unexpected release identity');
  const stack = (
    await new CloudFormationClient({ region }).send(new DescribeStacksCommand({ StackName: 'yvn-release-notes' }))
  ).Stacks?.[0];
  const bucket = stack?.Outputs?.find((o) => o.OutputKey === 'NativeSourceBucketName')?.OutputValue;
  if (
    !bucket ||
    !stack?.StackId?.startsWith(`arn:aws:cloudformation:${region}:${identity.Account}:stack/yvn-release-notes/`)
  )
    throw new Error('Missing native source bucket');
  const s3 = new S3Client({ region }),
    artifacts = await packageHttp(build, resolve(build, 'dist/artifacts')),
    parameters: Record<string, string> = { NativeWebFunctionsEnabled: 'true' };
  const recorded = [];
  for (const artifact of artifacts) {
    const key = `native/${artifact.kind}/${artifact.sha256}.zip`,
      size = (await stat(artifact.path)).size;
    let version: string | undefined;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (head.Metadata?.sha256 !== artifact.sha256 || head.ContentLength !== size || !head.VersionId)
        throw new Error('Existing immutable artifact does not match');
      version = head.VersionId;
    } catch (error) {
      if (!(error instanceof Error) || !['NotFound', 'NoSuchKey'].includes(error.name)) throw error;
      const added = await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: createReadStream(artifact.path),
          ContentLength: size,
          ContentType: 'application/zip',
          ChecksumSHA256: artifact.codeSha256,
          IfNoneMatch: '*',
          Metadata: { sha256: artifact.sha256, commit },
          ServerSideEncryption: 'AES256'
        })
      );
      version = added.VersionId;
      const checked = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, VersionId: version }));
      if (!version || checked.Metadata?.sha256 !== artifact.sha256 || checked.ContentLength !== size)
        throw new Error('Artifact upload was not confirmed');
    }
    const name = artifact.kind === 'app' ? 'App' : 'Mcp';
    Object.assign(parameters, {
      [`Native${name}CodeKey`]: key,
      [`Native${name}CodeVersion`]: version,
      [`Native${name}BuildId`]: commit
    });
    recorded.push({ kind: artifact.kind, bucket, key, version, sha256: artifact.sha256, size });
  }
  await writeFile(
    resolve(dir, `artifacts-${randomUUID()}.json`),
    JSON.stringify(
      { schema: 1, stackId: stack.StackId, commit, region, recorded, savedAt: new Date().toISOString() },
      null,
      2
    ) + '\n',
    { mode: 0o600, flag: 'wx' }
  );
  console.info(JSON.stringify({ parameters }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : 'Artifact release failed');
    process.exitCode = 1;
  });
