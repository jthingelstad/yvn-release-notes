import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler as describe } from '../../workers/describe.ts';
import { handler as transcribe } from '../../workers/transcribe.ts';
test('candidate runtime self tests need no environment/client/secret/data and exercise real thumbnail codec', async () => {
  for (const handler of [describe, transcribe]) {
    const result = await handler({ self_test: true });
    assert.equal(result?.ok, true);
    assert.equal(result?.runtime, `Node ${process.versions.node}/${process.platform}/${process.arch}`);
    assert.equal(typeof result?.build, 'string');
  }
});
