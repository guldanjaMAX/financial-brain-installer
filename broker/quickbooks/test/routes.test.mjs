import assert from 'node:assert/strict';
import test from 'node:test';
import { createProbeAdapter } from '../../../protocol/quickbooks-broker/implementation-adapter.mjs';
import { createRig } from '../../../protocol/quickbooks-broker/probes/harness.mjs';
import { ROUTES } from '../src/broker.mjs';

test('each route admits only its declared method, with a ready health control', async () => {
  const rig = await createRig(createProbeAdapter);
  assert.equal((await rig.broker(new Request('https://broker.invalid/health'))).status, 200);
  for (const route of Object.values(ROUTES)) {
    const method = [ROUTES.callback, ROUTES.health, ROUTES.result].includes(route) ? 'POST' : 'GET';
    assert.equal((await rig.broker(new Request('https://broker.invalid' + route, { method }))).status, 405);
  }
  assert.equal(rig.provider.snapshot().attempted.exchange, 0);
  assert.equal(rig.provider.snapshot().attempted.refresh, 0);
  assert.equal(rig.provider.snapshot().attempted.revoke, 0);
});
