/** The deploy workflows keep their guarantees: credentials only in the
 * approved production job, never in the build; one release at a time, never
 * cancelled; only a green push to main deploys; workflow inputs reach shells
 * only through the environment. scripts/test-workflows.sh checks pins,
 * default permissions and checkout tokens for every workflow. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (name: string) => readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), 'utf8');
const [deploy, activate, build] = await Promise.all(['deploy.yml', 'activate.yml', 'build-release.yml'].map(read));

/** A job's block, from its two-space key to the next job or the end. */
function job(workflow: string, name: string) {
  const found = new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\s*\\n)+)`).exec(`${workflow}\n`);
  assert.ok(found, name);
  return found[1]!;
}

test('only the production job assumes the AWS role; the build has no token permissions', () => {
  for (const [workflow, releaser] of [
    [deploy, 'deploy'],
    [activate, 'activate']
  ] as const) {
    const release = job(workflow, releaser);
    assert.match(release, /\n    environment: production\n/);
    assert.match(release, /id-token: write/);
    assert.match(release, /role-to-assume: \$\{\{ secrets\.RELEASE_DEPLOY_ROLE_ARN \}\}/);
    assert.match(release, /mask-aws-account-id: true/);
    assert.match(release, /needs: \[gate, build\]/);
    assert.equal(workflow.match(/id-token: write/g)?.length, 1);
    assert.equal(workflow.match(/configure-aws-credentials@/g)?.length, 1);
    assert.doesNotMatch(release, /npm (ci|install)|build-release\.sh/);
    assert.match(job(workflow, 'build'), /permissions: \{\}\n    uses: \.\/\.github\/workflows\/build-release\.yml\n/);
  }
  assert.match(job(build, 'build'), /\n    permissions: \{\}\n/);
  assert.doesNotMatch(build, /environment:|id-token|secrets\.|configure-aws-credentials/);
  assert.match(build, /scripts\/build-release\.sh/);
});

test('releases share one concurrency group and are never cancelled', () => {
  for (const workflow of [deploy, activate])
    assert.match(workflow, /\nconcurrency:\n  group: production-deploy\n  cancel-in-progress: false\n/);
});

test('only a green push to main in this repository deploys, and only while it is main', () => {
  assert.match(
    deploy,
    /workflow_run:[^\n]*\n    workflows: \[validate\]\n    types: \[completed\]\n    branches: \[main\]/
  );
  const gate = job(deploy, 'gate');
  for (const condition of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository'
  ])
    assert.ok(gate.includes(condition), condition);
  for (const [workflow, releaser] of [
    [deploy, 'deploy'],
    [activate, 'activate']
  ] as const) {
    const release = job(workflow, releaser);
    assert.match(release, /ref: main\n\s+fetch-depth: 0\n/);
    assert.match(release, /\[\[ "\$\(git rev-parse HEAD\)" == "\$COMMIT" \]\]/);
  }
  assert.match(job(activate, 'gate'), /refs\/heads\/main/);
  assert.match(job(activate, 'gate'), /check_name=validate/);
});

test('publication publishes only changed code; activation takes one fixed phase', () => {
  assert.match(job(deploy, 'deploy'), /--native-http-phase=publish --native-worker-phase=publish --only-changed/);
  const phases = [...activate.matchAll(/^          - ([a-z]+-[a-z]+)$/gm)].map((m) => m[1]);
  assert.deepEqual(phases, ['http-activate', 'workers-activate', 'http-rollback', 'workers-rollback']);
  for (const workflow of [deploy, activate])
    assert.doesNotMatch(workflow, /--break-glass|--admin-user-id|--turnstile-mode/);
});

test('event values and inputs reach shell scripts only through the environment', () => {
  for (const workflow of [deploy, activate, build]) {
    const scripts = [...workflow.matchAll(/\n\s+run: \|\n((?:\s{10,}.*\n)+)|\n\s+run: (.*)\n/g)].map(
      (m) => m[1] ?? m[2]
    );
    assert.ok(scripts.length > 0);
    for (const script of scripts) assert.doesNotMatch(script!, /\$\{\{/);
  }
});
