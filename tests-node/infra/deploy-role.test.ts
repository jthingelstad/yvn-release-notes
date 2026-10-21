/** The deploy identity stack (infra/github-deploy-role.yaml) keeps its posture:
 * only the production environment assumes the deploy role, change sets run as
 * the service role, live aliases are never invoked and the one delete is the
 * web app sync's. The names agree with the release scripts and tools that use
 * them. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const template = await read('infra/github-deploy-role.yaml');

/** One policy statement, from its Sid to the next statement or section. */
function statement(sid: string) {
  const found = new RegExp(`- Sid: ${sid}\\n([\\s\\S]*?)(?=\\n\\s+(?:- Sid:|#)|\\n\\S|\\n\\n|$)`).exec(template);
  assert.ok(found, sid);
  return found[1]!;
}

test('only the production environment of this repository assumes the deploy role, for STS', () => {
  const trust = /AssumeRolePolicyDocument:[\s\S]*?Policies:/.exec(
    template.slice(template.indexOf('  DeployRole:'))
  )![0];
  assert.match(trust, /Action: sts:AssumeRoleWithWebIdentity/);
  assert.match(trust, /token\.actions\.githubusercontent\.com:aud: sts\.amazonaws\.com/);
  assert.doesNotMatch(trust, /StringLike|\*/);
  const subjects = [...trust.matchAll(/^\s+- (repo:\S+)$/gm)].map((m) => m[1]);
  assert.deepEqual(subjects, [
    'repo:jthingelstad/yvn-release-notes:environment:production',
    'repo:jthingelstad@5351/yvn-release-notes@1408586441:environment:production'
  ]);
});

test('the application stack changes only through change sets that name the service role', () => {
  assert.match(statement('ChangeSetsUseTheServiceRole'), /cloudformation:RoleArn: !GetAtt CloudFormationRole\.Arn/);
  assert.match(statement('PassTheServiceRole'), /iam:PassedToService": cloudformation\.amazonaws\.com/);
  assert.match(
    statement('TagApplicationStack'),
    /Action: cloudformation:TagResource\n.*stack\/\$\{ApplicationStackName\}\/\*"$/
  );
  assert.equal(template.match(/cloudformation:CreateChangeSet/g)?.length, 1);
  assert.doesNotMatch(template, /cloudformation:(UpdateStack|CreateStack|DeleteStack|\*)/);
});

test('versions may be probed but never a live alias, $LATEST or an unqualified function', () => {
  const allow = statement('ProbePublishedVersions');
  assert.match(allow, /Effect: Allow/);
  assert.match(allow, /function:\$\{ApplicationStackName\}-\*:\*"$/);
  const deny = statement('NeverInvokeLiveAliases');
  assert.match(deny, /Effect: Deny/);
  assert.deepEqual(
    [...deny.matchAll(/function:\$\{ApplicationStackName\}-\*(:\S+)"/g)].map((m) => m[1]),
    [':live', ':$LATEST']
  );
  // An unqualified deny pattern would match every version as well.
  assert.doesNotMatch(deny, /function:\$\{ApplicationStackName\}-\*"/);
  assert.equal(template.match(/lambda:InvokeFunction/g)?.length, 2);
  assert.doesNotMatch(template, /lambda:DeleteResourcePolicy|lambda:UpdateAlias/);
});

test('the deploy role can tell a new native artifact from a forbidden one', () => {
  // HeadObject on a missing key is 404 only with ListBucket on the bucket.
  assert.match(statement('NativeArtifacts'), /s3:PutObject\]\n.*nativesourcebucket-\*\/native\/\*"$/);
  assert.match(statement('NativeArtifactsList'), /Action: s3:ListBucket\n.*nativesourcebucket-\*"$/);
  assert.doesNotMatch(statement('NativeArtifactsList'), /Condition/);
});

test('the deploy role deletes nothing but web app files, and keeps no bucket of its own', () => {
  const role = template.slice(template.indexOf('  DeployRole:'), template.indexOf('\nOutputs:'));
  assert.deepEqual(role.match(/\b[a-z0-9]+:Delete\w*/g), ['s3:DeleteObject']);
  assert.match(statement('WebBucketObjects'), /s3:DeleteObject[\s\S]*-web-\$\{AWS::AccountId\}\/\*"/);
  assert.doesNotMatch(template, /AWS::S3::Bucket|Receipts|locks\//);
});

test('role names agree with the release scripts and tools', async () => {
  const release = await read('scripts/release.sh');
  assert.match(release, /role\/ReleaseNotesCloudFormation"/);
  assert.match(release, /assumed-role\/ReleaseNotesGitHubDeploy\//);
  assert.match(await read('tools/release-identity.ts'), /ReleaseNotesGitHubDeploy/);
  assert.match(template, /RoleName: ReleaseNotesGitHubDeploy\n/);
  assert.match(template, /RoleName: ReleaseNotesCloudFormation\n/);
  assert.match(template, /AllowedValues: \[yvn-release-notes\]/);
});
