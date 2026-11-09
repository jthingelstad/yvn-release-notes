/** The receipt rule that takes replies and notes by email. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resource, type Node } from './grants.ts';

test('mail in needs TLS and is scanned before it is kept', () => {
  const props = resource('ReceiptRule').Properties.Rule as { [key: string]: Node };
  // Jamie, 2026-11-08 (product call 6): mail sent without TLS bounces.
  assert.equal(props.TlsPolicy, 'Require');
  // The template parser keeps scalars as written.
  assert.equal(props.ScanEnabled, 'true');
  assert.equal(props.Enabled, 'true');
});
