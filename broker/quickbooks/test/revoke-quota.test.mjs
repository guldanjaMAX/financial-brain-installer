import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeAdapter } from '../../../protocol/quickbooks-broker/implementation-adapter.mjs';
import { createRig, REVOKE } from '../../../protocol/quickbooks-broker/probes/harness.mjs';

test('revoke hourly quota also bounds reviewed no-contact refusals', async () => {
  const control = await createRig(createProbeAdapter);
  await control.connect();
  assert.equal((await control.broker(await control.signed(REVOKE))).status, 200);
  assert.equal(control.provider.snapshot().mutated.revoke, 1);

  const target = await createRig(createProbeAdapter);
  await target.connect();
  for (let index = 0; index < 3; index++) {
    target.adapter.armFault('broker.revoke.before_fence');
    const response = await target.broker(await target.signed(REVOKE));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).provider_contact, 'not_sent');
  }
  target.adapter.armFault('broker.revoke.before_fence');
  const denied = await target.broker(await target.signed(REVOKE));
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).code, 'quota_exceeded');
  assert.equal(target.provider.snapshot().attempted.revoke, 0);
});
