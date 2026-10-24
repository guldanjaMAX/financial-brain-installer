// Only passing offline units belong in the ordinary test graph. The separate
// E2E probe file remains an explicit focused gate for the separate foundation.
import '../protocol/quickbooks-broker/testing/protocol.test.mjs';
import '../protocol/quickbooks-broker/testing/schema.test.mjs';
import '../protocol/quickbooks-broker/testing/state-machine.test.mjs';
import '../protocol/quickbooks-broker/testing/fake-intuit.test.mjs';
import '../protocol/quickbooks-broker/probes/harness.unit.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TEST_COMMANDS } from '../scripts/run-test-chain.mjs';

test('green protocol wrapper is registered and E2E remains explicit-only', () => {
  assert.ok(TEST_COMMANDS.includes('node --test test/qbo-broker-protocol.test.mjs'));
  assert.ok(TEST_COMMANDS.every(command => !command.includes('broker.e2e.probe')));
  const wrapper = readFileSync(new URL('./qbo-broker-protocol.test.mjs', import.meta.url), 'utf8');
  assert.ok(!/^import\s+['"][^'"]*broker\.e2e\.probe/m.test(wrapper));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.files.some(path => /^(protocol|partner-reports|test)(\/|$)/.test(path)));
});
