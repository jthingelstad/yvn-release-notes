import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handler as describe } from '../../workers/describe.ts';
import { handler as transcribe } from '../../workers/transcribe.ts';
import { handler as exporter } from '../../workers/export.ts';
test('candidate runtime self tests need no environment/client/secret/data and exercise real thumbnail codec', async () => {
  // The export worker's self test typesets a one-day book with a PNG and a HEIC.
  for (const handler of [describe, transcribe, exporter]) {
    const result = (await handler({ self_test: true })) as { ok?: boolean; runtime?: string; build?: unknown } | null;
    assert.equal(result?.ok, true);
    assert.equal(result?.runtime, `Node ${process.versions.node}/${process.platform}/${process.arch}`);
    assert.equal(typeof result?.build, 'string');
  }
});
