// Protocol units and the injected broker probes all belong in the offline graph.
import '../protocol/quickbooks-broker/testing/protocol.test.mjs';
import '../protocol/quickbooks-broker/testing/schema.test.mjs';
import '../protocol/quickbooks-broker/testing/state-machine.test.mjs';
import '../protocol/quickbooks-broker/testing/fake-intuit.test.mjs';
import '../protocol/quickbooks-broker/probes/harness.unit.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS, parseTestCommand } from '../scripts/run-test-chain.mjs';

const foundationFiles = [
  'broker/quickbooks/test/provider.test.mjs',
  'broker/quickbooks/test/crypto.test.mjs',
  'broker/quickbooks/test/store.test.mjs',
  'broker/quickbooks/test/boundary.test.mjs',
  'broker/quickbooks/test/broker-security.test.mjs',
  'broker/quickbooks/test/callback-quota.test.mjs',
  'broker/quickbooks/test/revoke-quota.test.mjs',
  'broker/quickbooks/test/routes.test.mjs',
  'protocol/quickbooks-broker/testing/broker-privacy.test.mjs',
  'protocol/quickbooks-broker/probes/broker.e2e.probe.mjs',
  'test/qbo-broker-protocol.test.mjs',
];
const foundationCommand = `node --test ${foundationFiles.join(' ')}`;
function assertFoundationCoverage(commands, additions) {
  assert.equal(commands.filter(command => command === foundationCommand).length, 1);
  assert.equal(additions.filter(command => command === foundationCommand).length, 1);
  for (const file of foundationFiles) {
    const scheduled = commands.flatMap(command => parseTestCommand(command).args);
    assert.equal(scheduled.filter(arg => arg === file).length, 1);
  }
}

test('eleven-file offline foundation command is covered in both test graphs', () => {
  assertFoundationCoverage(TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(!pkg.files.some(path => /^(broker|protocol|partner-reports|test)(\/|$)/.test(path)));
});

test('broker graph module admission permits only the exact test folders', () => {
  assert.deepEqual(parseTestCommand(foundationCommand).args, ['--test', ...foundationFiles]);
  for (const path of [
    'broker/quickbooks/src/broker.mjs', 'broker/other/test/example.test.mjs',
    'protocol/quickbooks-broker/implementation-adapter.mjs',
    'protocol/other/testing/example.test.mjs',
    'broker/quickbooks/test/../src/broker.mjs',
    'protocol/quickbooks-broker/testing/../implementation-adapter.mjs',
  ]) assert.throws(() => parseTestCommand(`node --test ${path}`), /unsupported test module/);
});

test('mutant BROKER_GRAPH_OMITTED is killed by positive coverage', () => {
  assertFoundationCoverage(TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS);
  const omit = commands => commands.map(command => command === foundationCommand
    ? 'node --test test/qbo-broker-protocol.test.mjs' : command);
  assert.throws(() => assertFoundationCoverage(omit(TEST_COMMANDS), POST_LAUNCHER_TEST_COMMANDS));
  assert.throws(() => assertFoundationCoverage(TEST_COMMANDS, omit(POST_LAUNCHER_TEST_COMMANDS)));
});
