/** Every application role carries the deploy stack's function boundary
 * (ReleaseNotesFunctionBoundary in infra/github-deploy-role.yaml), and the
 * boundary holds each role's statements: a role still does exactly what its
 * own policy says, and nothing it could be given reaches past the app's own
 * names (AWS-1 in the 2026-11-08 security audit). A role statement the
 * boundary does not hold would fail live with no test of its own failing,
 * because the role tests read only infra/template.yaml. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ACCOUNT, REGION, STACK, glob, resolve, resource, resourceIn, statements, type Node } from './grants.ts';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const TEMPLATE = read('infra/template.yaml'),
  DEPLOY = read('infra/github-deploy-role.yaml'),
  BOUNDARY = `arn:aws:iam::${ACCOUNT}:policy/ReleaseNotesFunctionBoundary`,
  ROLES = [...TEMPLATE.matchAll(/\n {2}(\w+):\n {4}Type: AWS::IAM::Role\n/g)].map((m) => m[1]!);

// The deploy stack's intrinsics, in the same fictional account as grants.ts.
// Its one parameter in use has a single allowed value, the stack name.
const VARS: Record<string, string> = {
  'AWS::Partition': 'aws',
  'AWS::Region': REGION,
  'AWS::AccountId': ACCOUNT,
  ApplicationStackName: STACK
};
const sub = (node: Node): string =>
  typeof node === 'string'
    ? node
    : String((node as Record<string, Node>)['!Sub'] ?? assert.fail(JSON.stringify(node))).replace(
        /\$\{([^}]+)\}/g,
        (_, name: string) => VARS[name] ?? assert.fail(name)
      );

interface Rule {
  sid: string;
  effect: string;
  actions: string[];
  resources: string[];
  condition: Record<string, Record<string, string[]>>;
}
const policy = resourceIn(DEPLOY, 'FunctionBoundary'),
  document = policy.Properties.PolicyDocument as Record<string, Node>,
  rules: Rule[] = (document.Statement as Record<string, Node>[]).map((s) => ({
    sid: String(s.Sid),
    effect: String(s.Effect),
    actions: [s.Action!].flat().map(String),
    resources: [s.Resource!].flat().map(sub),
    condition: Object.fromEntries(
      Object.entries((s.Condition ?? {}) as Record<string, Record<string, Node>>).map(([op, keys]) => [
        op,
        Object.fromEntries(Object.entries(keys).map(([key, values]) => [key, [values].flat().map(sub)]))
      ])
    )
  }));

// A boundary pattern holds a role's pattern when it matches it as text: every
// boundary wildcard is `*`, so it also matches whatever the role's `*` or `?`
// stands for.
const holds = (pattern: string, value: string) => glob(pattern).test(value);
for (const rule of rules)
  for (const pattern of [
    ...rule.resources,
    ...Object.values(rule.condition).flatMap((keys) => Object.values(keys).flat())
  ])
    assert.ok(!pattern.includes('?'), `${rule.sid}: ${pattern}`);

/** The role statement's own conditions keep each request inside the
 * boundary statement's: for every key the boundary tests, one of the role's
 * string conditions on that key allows only values the boundary allows. */
function meets(rule: Rule, own: Record<string, Record<string, Node>>) {
  return Object.entries(rule.condition).every(([op, keys]) => {
    assert.equal(op, 'StringLike', `${rule.sid}: boundary conditions are StringLike`);
    return Object.entries(keys).every(([key, patterns]) =>
      Object.entries(own)
        .filter(([o]) => o === 'StringEquals' || o === 'StringLike')
        .flatMap(([, entries]) => Object.entries(entries).filter(([k]) => k.toLowerCase() === key.toLowerCase()))
        .some(([, values]) =>
          [values]
            .flat()
            .map(resolve)
            .every((v) => patterns.some((p) => holds(p, v)))
        )
    );
  });
}

test('every application role carries the function boundary', () => {
  assert.equal(policy.Type, 'AWS::IAM::ManagedPolicy');
  assert.equal(policy.Properties.ManagedPolicyName, 'ReleaseNotesFunctionBoundary');
  assert.ok(ROLES.length >= 9, ROLES.join(' '));
  for (const role of ROLES) assert.equal(resolve(resource(role).Properties.PermissionsBoundary ?? ''), BOUNDARY, role);
});

/** Whether the boundary lets a role statement's action on a resource
 * through, under that statement's conditions. */
function inside(action: string, arn: string, condition: Record<string, Record<string, Node>> = {}) {
  const matches = (r: Rule) =>
    r.actions.some((a) => glob(a, 'i').test(action)) && r.resources.some((p) => holds(p, arn));
  return (
    rules.some((r) => r.effect === 'Allow' && matches(r) && meets(r, condition)) &&
    !rules.some((r) => r.effect === 'Deny' && matches(r))
  );
}

test('the boundary holds every grant of every role', () => {
  const outside = ROLES.flatMap((role) =>
    statements(role).flatMap((s) =>
      s.actions.flatMap((action) =>
        s.resources.filter((arn) => !inside(action, arn, s.condition)).map((arn) => `${role}: ${action} ${arn}`)
      )
    )
  );
  assert.deepEqual(outside, []);
});

test('the boundary holds nothing past the app', () => {
  const at = (service: string, rest: string) => `arn:aws:${service}:${REGION}:${ACCOUNT}:${rest}`;
  assert.ok(inside('dynamodb:GetItem', at('dynamodb', `table/${STACK}`)));
  for (const [action, arn] of [
    ['dynamodb:GetItem', at('dynamodb', 'table/weekly-thing-librarian-LibrarianTable-1')],
    ['s3:GetObject', 'arn:aws:s3:::thingelstad-archive-123456789012/x'],
    ['secretsmanager:GetSecretValue', at('secretsmanager', 'secret:weekly-thing-librarian-runtime-abcdef')],
    ['lambda:InvokeFunction', at('lambda', 'function:elixir-collector')],
    ['logs:PutLogEvents', at('logs', 'log-group:/aws/lambda/elixir-collector:*')],
    ['iam:PassRole', `arn:aws:iam::${ACCOUNT}:role/${STACK}-WebRole-x`],
    ['iam:CreateRole', `arn:aws:iam::${ACCOUNT}:role/${STACK}-AnyRole-x`],
    ['sts:AssumeRole', `arn:aws:iam::${ACCOUNT}:role/ProjectsCloudEngineer`],
    ['ses:CreateEmailIdentity', at('ses', 'identity/thingelstad.com')],
    ['transcribe:StartTranscriptionJob', '*'],
    ['ec2:RunInstances', '*']
  ] as const)
    assert.ok(!inside(action, arn), `${action} ${arn}`);
  // Mail goes out only from the app's domain, and transcripts only to its buckets.
  const mail = at('ses', 'identity/thingelstad.com');
  assert.ok(
    inside('ses:SendRawEmail', mail, { StringLike: { 'ses:FromAddress': 'Notes <notes@yourversionnumber.com>' } })
  );
  assert.ok(!inside('ses:SendRawEmail', mail, { StringLike: { 'ses:FromAddress': 'jamie@thingelstad.com' } }));
  assert.ok(!inside('ses:SendRawEmail', mail, { StringLike: { 'ses:FromAddress': '*' } }));
  assert.ok(
    !inside('transcribe:StartTranscriptionJob', '*', { StringEquals: { 'transcribe:OutputBucketName': 'other' } })
  );
});

test("the boundary reaches only the app's own names", () => {
  // Transcription jobs are named by the app: release-notes.<id>.
  const app = (arn: string) =>
    arn.includes(`:${STACK}`) || arn.includes(`/${STACK}`) || arn.endsWith(':transcription-job/release-notes.*');
  for (const rule of rules.filter((r) => r.effect === 'Allow')) {
    for (const action of rule.actions) assert.doesNotMatch(action, /^(iam|sts|organizations|account):/i, rule.sid);
    for (const arn of rule.resources.filter((a) => !app(a))) {
      // Outside the app's names, only exact actions, and each for a reason.
      for (const action of rule.actions)
        if (!/::provider\/default$/.test(arn)) assert.doesNotMatch(action, /\*/, `${rule.sid}: ${action} on ${arn}`);
      const why: Record<string, RegExp> = {
        AppTableStreams: /^\*$/, // ListStreams has no resource
        Places: /^arn:aws:geo-(places|maps):us-east-1::provider\/default$/,
        SendMail: /:identity\/\*$/, // the From address decides, below
        Suppression: /^\*$/, // the account's suppression list
        StartTranscription: /^\*$/ // its output bucket decides, below
      };
      assert.match(arn, why[rule.sid] ?? /^$/, `${rule.sid}: ${arn}`);
    }
  }
  const only = (sid: string) => rules.find((r) => r.sid === sid)!.condition.StringLike!;
  assert.deepEqual(only('SendMail'), { 'ses:FromAddress': ['*@yourversionnumber.com', '*<*@yourversionnumber.com>'] });
  assert.deepEqual(only('StartTranscription'), { 'transcribe:OutputBucketName': [`${STACK}-*`] });
  const deny = rules.find((r) => r.sid === 'NothingAboveTheApp')!;
  assert.equal(deny.effect, 'Deny');
  assert.deepEqual(deny.actions, ['iam:*', 'sts:AssumeRole', 'organizations:*']);
  assert.deepEqual(deny.resources, ['*']);
});
