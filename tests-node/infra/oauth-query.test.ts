/** The deployed edge code preserves OAuth values while removing the wire
 * encoding that private Web Function signature validation rejects. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const template = await readFile(new URL('../../infra/template.yaml', import.meta.url), 'utf8');
const source = /  NativeOAuthQueryFunction:[\s\S]*?      FunctionCode: \|\n((?:        .*\n|\n)+)/
  .exec(template)![1]!
  .split('\n')
  .map((line) => line.replace(/^        /, ''))
  .join('\n');
const handler = runInNewContext(source + '\nhandler') as (event: {
  request: Record<string, unknown>;
}) => Record<string, unknown>;

test('OAuth form scopes cross the edge with equivalent RFC-encoded spaces', () => {
  const request = {
    method: 'GET',
    uri: '/oauth/authorize',
    headers: { authorization: { value: 'Bearer fictional' } },
    querystring: {
      response_type: { value: 'code' },
      client_id: { value: 'fictional-client' },
      redirect_uri: { value: 'https%3A%2F%2Fexample.com%2Fcallback' },
      scope: { value: 'media%3Aread+notes%3Aread' },
      code_challenge: { value: 'fictional-pkce' },
      state: { value: 'fictional_state' }
    }
  };
  const result = handler({ request });
  assert.equal(result, request);
  assert.equal(result.uri, '/oauth/authorize');
  assert.equal(result.headers, request.headers);
  const qs = String(result.querystring);
  assert.ok(qs.includes('scope=media%3Aread%20notes%3Aread'));
  assert.equal(new URLSearchParams(qs).get('scope'), 'media:read notes:read');
  assert.equal(new URLSearchParams(qs).get('redirect_uri'), 'https://example.com/callback');
  assert.equal(new URLSearchParams(qs).get('state'), 'fictional_state');
});

test('repeated parameters, encoded literal plus and delimiters keep their meaning', () => {
  const before =
    'scope=notes%3Aread+media%3Aread&state=keep%2Bthis&state=also+this&redirect_uri=https%3A%2F%2Fexample.com%2F%3Fq%3Da%26b%3Dc';
  const result = handler({
    request: {
      querystring: {
        scope: { value: 'notes%3Aread+media%3Aread' },
        state: { value: 'keep%2Bthis', multiValue: [{ value: 'keep%2Bthis' }, { value: 'also+this' }] },
        redirect_uri: { value: 'https%3A%2F%2Fexample.com%2F%3Fq%3Da%26b%3Dc' }
      }
    }
  });
  assert.deepEqual([...new URLSearchParams(String(result.querystring))], [...new URLSearchParams(before)]);
});

test('canonical queries and queryless token requests remain untouched', () => {
  for (const querystring of [
    {},
    { scope: { value: 'notes%3Aread%20media%3Aread' } },
    { state: { value: 'literal%2Bplus' } }
  ]) {
    const request = { method: 'POST', uri: '/oauth/token', body: 'unchanged', querystring };
    assert.equal(handler({ request }).querystring, querystring);
    assert.equal(request.body, 'unchanged');
  }
});

test('normalization is associated only with OAuth and IAM/OAC protections remain', () => {
  const behaviors = template.slice(template.indexOf('        CacheBehaviors:'));
  const oauth = /- PathPattern: \/oauth\/\*[\s\S]*?(?=          - PathPattern:)/.exec(behaviors)![0];
  assert.ok(oauth.includes('EventType: viewer-request'));
  assert.ok(oauth.includes('NativeOAuthQueryFunction.FunctionMetadata.FunctionARN'));
  assert.equal(template.match(/FunctionARN: !GetAtt NativeOAuthQueryFunction/g)?.length, 1);
  assert.ok(template.includes('SigningBehavior: always-amz-auth'));
  assert.ok(template.includes('SigningProtocol: sigv4'));
  assert.ok(template.includes('AuthType: IamAuth'));
});
