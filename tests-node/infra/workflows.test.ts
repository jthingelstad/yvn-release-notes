/** The deploy workflow keeps its guarantees: credentials only in the
 * production job, never in the build; one release at a time, never
 * cancelled; only a green push to main (or main's green tip, by hand)
 * releases; workflow inputs reach shells only through the environment. The
 * browser tests run by themselves for web/ and e2e/ changes and stay out of
 * the merge gate. scripts/test-workflows.sh checks pins, default permissions
 * and checkout tokens for every workflow. */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';

const directory = new URL('../../.github/workflows/', import.meta.url);
const read = (name: string) => readFile(new URL(name, directory), 'utf8');
const [deploy, e2e, validate] = await Promise.all(['deploy.yml', 'e2e.yml', 'validate.yml'].map(read));

/** A job's block, from its two-space key to the next job or the end. */
function job(workflow: string, name: string) {
  const found = new RegExp(`\\n  ${name}:\\n((?:    .*\\n|\\s*\\n)+)`).exec(`${workflow}\n`);
  assert.ok(found, name);
  return found[1]!;
}

test('one workflow releases', async () => {
  assert.deepEqual((await readdir(directory)).sort(), ['deploy.yml', 'e2e.yml', 'validate.yml']);
});

test('only the production job assumes the AWS role; the build has no token permissions', () => {
  const release = job(deploy, 'deploy');
  assert.match(release, /\n    environment: production\n/);
  assert.match(release, /\n    permissions:\n      contents: read\n      id-token: write\n    steps:/);
  assert.match(release, /role-to-assume: \$\{\{ secrets\.RELEASE_DEPLOY_ROLE_ARN \}\}/);
  assert.match(release, /mask-aws-account-id: true/);
  assert.match(release, /needs: \[gate, build\]/);
  assert.equal(deploy.match(/id-token: write/g)?.length, 1);
  assert.equal(deploy.match(/configure-aws-credentials@/g)?.length, 1);
  assert.doesNotMatch(release, /npm (ci|install)|build-release\.sh/);
  const build = job(deploy, 'build');
  assert.match(build, /\n    permissions: \{\}\n/);
  assert.doesNotMatch(build, /environment:|id-token|secrets\.|configure-aws-credentials/);
  assert.match(build, /scripts\/build-release\.sh/);
});

test('releases share one concurrency group and are never cancelled', () => {
  assert.match(deploy, /\nconcurrency:\n  group: production-deploy\n  cancel-in-progress: false\n/);
});

test('only a green push to main in this repository releases, and only while it is main', () => {
  assert.match(
    deploy,
    /workflow_run:[^\n]*\n    workflows: \[validate\]\n    types: \[completed\]\n    branches: \[main\]\n  workflow_dispatch:\n\n/
  );
  const gate = job(deploy, 'gate');
  for (const condition of [
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.head_branch == 'main'",
    'github.event.workflow_run.head_repository.full_name == github.repository'
  ])
    assert.ok(gate.includes(condition), condition);
  // By hand: main only, and only a commit whose own validate run passed.
  assert.match(gate, /\[\[ "\$REF" == refs\/heads\/main \]\]/);
  assert.match(gate, /check_name=validate/);
  assert.match(gate, /\.app\.slug == "github-actions"/);
  const release = job(deploy, 'deploy');
  assert.match(release, /ref: main\n/);
  assert.match(release, /\[\[ "\$\(git rev-parse HEAD\)" == "\$COMMIT" \]\]/);
});

test("a release is one run of scripts/release.sh, with none of the Mac's settings", () => {
  const release = job(deploy, 'deploy');
  assert.equal(release.match(/scripts\/release\.sh/g)?.length, 1);
  assert.match(release, /run: scripts\/release\.sh --bundle "\$RUNNER_TEMP\/bundle" --commit "\$COMMIT"\n/);
  assert.doesNotMatch(deploy, /--break-glass|--admin-user-id|--turnstile-mode/);
});

test('event values and inputs reach shell scripts only through the environment', () => {
  for (const workflow of [deploy, e2e]) {
    const scripts = [...workflow.matchAll(/\n\s+run: \|\n((?:\s{10,}.*\n)+)|\n\s+run: (.*)\n/g)].map(
      (m) => m[1] ?? m[2]
    );
    assert.ok(scripts.length > 0);
    for (const script of scripts) assert.doesNotMatch(script!, /\$\{\{/);
  }
});

test('browser tests run for web/ and e2e/ changes, the e2e label or by hand, outside the merge gate', () => {
  assert.match(
    e2e,
    /\non:\n  workflow_dispatch:\n  pull_request:\n    types: \[opened, synchronize, reopened, labeled\]\n/
  );
  // A trigger path filter would also stop the label runs on other pull requests.
  assert.doesNotMatch(e2e, /\n\s+paths(-ignore)?:/);
  const changes = job(e2e, 'changes');
  assert.match(changes, /\n    permissions:\n      pull-requests: read\n    outputs:/);
  assert.match(changes, /grep -qE '\^\(web\|e2e\)\/'/);
  const browser = job(e2e, 'e2e');
  assert.match(browser, /\n    permissions:\n      contents: read\n/);
  for (const condition of [
    '!cancelled()',
    "github.event_name == 'workflow_dispatch'",
    "contains(github.event.pull_request.labels.*.name, 'e2e')",
    "needs.changes.outputs.web == 'true'"
  ])
    assert.ok(browser.includes(condition), condition);
  assert.doesNotMatch(validate, /npm run e2e|playwright/);
  assert.doesNotMatch(deploy, /workflows: \[[^\]]*e2e/);
});
