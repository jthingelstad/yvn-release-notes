/** The backup stack (infra/backup.yaml) keeps its posture: one monthly copy of
 * the table, kept until deleted by hand, in a vault that outlives the stack,
 * made by a role the application stack's service role cannot edit and that no
 * workflow deploys. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const template = await read('infra/backup.yaml');

test('one monthly rule backs up the table alone, with no lifecycle', () => {
  assert.equal(template.match(/- RuleName:/g)?.length, 1);
  assert.match(template, /ScheduleExpression: cron\(0 4 1 \* \? \*\)\n\s+ScheduleExpressionTimezone: America\/Chicago/);
  assert.doesNotMatch(template, /^\s+(?:Lifecycle|DeleteAfterDays|MoveToColdStorageAfterDays):/m);
  const resources = /Resources:\n((?:\s+- .+\n)+)/.exec(template.slice(template.indexOf('TableSelection:')))![1]!;
  assert.deepEqual(
    resources
      .trim()
      .split('\n')
      .map((l) => l.trim()),
    ['- !Sub arn:${AWS::Partition}:dynamodb:${AWS::Region}:${AWS::AccountId}:table/${TableName}']
  );
  assert.match(
    template,
    /TableName:\n\s+Type: String\n\s+Default: yvn-release-notes\n\s+AllowedValues: \[yvn-release-notes\]/
  );
});

test('the vault outlives the stack', () => {
  assert.match(
    template,
    /Vault:\n\s+Type: AWS::Backup::BackupVault\n\s+DeletionPolicy: Retain\n\s+UpdateReplacePolicy: Retain/
  );
});

test('the application stack and its deploys cannot reach the backups', async () => {
  const role = /RoleName: (\S+)/.exec(template)![1]!;
  assert.doesNotMatch(role, /^yvn-release-notes-/);
  const deploy = await read('infra/github-deploy-role.yaml');
  assert.doesNotMatch(deploy, /backup[:-]/i);
  for (const name of await readdir(new URL('../../.github/workflows/', import.meta.url)))
    assert.doesNotMatch(
      await read(`.github/workflows/${name}`),
      /yvn-release-notes-backup|ReleaseNotesBackup|yvn-rn-backups/,
      name
    );
});
