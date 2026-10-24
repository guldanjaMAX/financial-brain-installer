import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeIntuit } from '../../../protocol/quickbooks-broker/testing/fake-intuit.mjs';
import { createProvider } from '../src/provider.mjs';

const now = () => Date.parse('2026-01-01T00:00:00Z');
const assertRotation = (prior, replacement) => assert.ok(prior !== replacement, 'replacement token must change');
function fixture(transport) {
  const fake = createFakeIntuit({ now });
  const provider = createProvider({ config: { ...fake.config, offline: true }, transport: transport ?? fake.fetch, now });
  return { fake, provider };
}
test('fixed provider exchange and refresh accept valid pairs and reject malformed replacements', async () => {
  for (const fault of [null, 'reject', 'malformed', 'missing_refresh', 'changed_company', 'loss_after']) {
    const { fake, provider } = fixture();
    const { callback } = await fake.grant();
    if (fault) fake.queueFault('exchange', fault);
    const result = await provider.exchange(callback.searchParams.get('code'), callback.searchParams.get('realmId'), 1);
    assert.equal(result.outcome, fault ? (fault === 'reject' ? 'provider_rejected' : 'provider_uncertain') : 'accepted');
    assert.equal(fake.snapshot().attempted.exchange, 1);
    if (!fault) {
      const replacement = await provider.refresh(result.bundle.refresh_token, result.bundle.realm_id, 2);
      assert.equal(replacement.outcome, 'accepted');
      assert.equal(replacement.bundle.token_generation, 2);
      assertRotation(replacement.bundle.refresh_token, result.bundle.refresh_token);
      assert.equal(await provider.revoke(replacement.bundle.refresh_token), 'confirmed');
    }
  }
});
test('provider exceptions and error responses cannot expose runtime credential canaries', async () => {
  const fake = createFakeIntuit({ now });
  const canary = fake.opaque('canary');
  const provider = createProvider({ config: { ...fake.config, offline: true }, now,
    transport: async () => { throw new Error(canary); } });
  const output = await provider.refresh(canary, fake.company(), 2);
  assert.equal(output.outcome, 'provider_uncertain');
  assert.ok(!JSON.stringify(output).includes(canary));
  assert.equal(await provider.revoke(canary), 'uncertain');
});
test('configuration rejects arbitrary destinations and requires an injected transport', () => {
  const { fake } = fixture();
  assert.throws(() => createProvider({ config: fake.config, now }), /configuration/);
  assert.throws(() => createProvider({ config: { ...fake.config, offline: true, tokenUrl: 'https://elsewhere.invalid/path' }, transport: fake.fetch, now }), /configuration/);
  assert.throws(() => createProvider({ config: fake.config, transport: fake.fetch, now }), /configuration/);
});
test('a failed token assertion cannot put a runtime canary in test diagnostics', () => {
  const { fake } = fixture();
  const prior = fake.opaque('canary');
  assertRotation(prior, fake.opaque('replacement'));
  let failure;
  try { assertRotation(prior, prior); } catch (error) { failure = error; }
  assert.ok(failure?.code === 'ERR_ASSERTION');
  assert.ok(!JSON.stringify(failure).includes(prior), 'assertion diagnostics must contain only a Boolean comparison');
});
