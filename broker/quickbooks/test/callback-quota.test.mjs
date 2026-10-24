import test from 'node:test';
import assert from 'node:assert/strict';
import { createProbeAdapter } from '../../../protocol/quickbooks-broker/implementation-adapter.mjs';
import { createRig, BROKER, CALLBACK, queryFree } from '../../../protocol/quickbooks-broker/probes/harness.mjs';

test('malformed callbacks count against the network limit before state parsing or provider exchange', async () => {
  const control = await createRig(createProbeAdapter);
  await control.connect();
  assert.equal(control.provider.snapshot().mutated.exchange, 1);

  const target = await createRig(createProbeAdapter);
  const pending = await target.pending();
  for (let count = 0; count < 30; count++) {
    queryFree(await target.broker(new Request(BROKER + CALLBACK + '?unexpected=1', { redirect: 'manual' })));
  }
  queryFree(await target.broker(await target.consent(pending)));
  assert.equal(target.provider.snapshot().attempted.exchange, 0, 'the next callback must be refused before provider contact');
  const counters = target.inspect().brokerRows.filter(row => row.route === CALLBACK && row.subject_kind === 'network');
  assert.equal(counters.length, 1);
  assert.equal(counters[0].count, 30);
  assert.equal(target.state().connectionCommitCount, 0);
});
