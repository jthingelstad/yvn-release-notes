/** Who may release: the Mac's cloud-engineer role anywhere, and the GitHub
 * deploy role (infra/github-deploy-role.yaml) only inside GitHub Actions. */
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

export const region = 'us-east-1',
  stackName = 'yvn-release-notes',
  account = '999153317627';

export function allowedCaller(arn: string | undefined, callerAccount: string | undefined, actions: boolean) {
  return (
    callerAccount === account &&
    (arn?.includes(':assumed-role/ProjectsCloudEngineer/') === true ||
      (actions && arn?.includes(':assumed-role/ReleaseNotesGitHubDeploy/') === true))
  );
}

export async function releaseIdentity(sts: Pick<STSClient, 'send'> = new STSClient({ region })) {
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  if (!allowedCaller(identity.Arn, identity.Account, process.env.GITHUB_ACTIONS === 'true'))
    throw new Error('Unexpected release identity');
  return { account: identity.Account! };
}
