/** The web distribution's access log: kept 14 days, named inside what the
 * stack's service role may make (infra/github-deploy-role.yaml), and never
 * recording the client's address or the query string. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resource, resolve, STACK } from './grants.ts';

test('the access log is kept 14 days under the stack’s own path and names', () => {
  const group = resource('WebAccessLogs').Properties;
  assert.equal(resolve(group.LogGroupName!), `/${STACK}/web-access`);
  assert.equal(String(group.RetentionInDays), '14');
  for (const name of ['WebAccessLogSource', 'WebAccessLogDestination'])
    assert.equal(resolve(resource(name).Properties.Name!), `${STACK}-web-access`, name);
  assert.match(
    JSON.stringify(resource('WebAccessLogSource').Properties.ResourceArn),
    /distribution\/\$\{WebDistribution\}/
  );
});

test('the access log records no client address and no query string', () => {
  const fields = resource('WebAccessLogDelivery').Properties.RecordFields as string[];
  assert.equal(fields.length, 14);
  for (const field of ['c-ip', 'c-ip-version', 'c-port', 'cs-uri-query', 'x-forwarded-for', 'cs(Cookie)'])
    assert.ok(!fields.includes(field), field);
});
