import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptanceFixture, addressWorld } from './gaps-acceptance-fixture.mjs';
import { mcpFixture } from './gaps-mcp-fixture.mjs';

for (const arm of ['healthy', 'retry-recovers', 'retry-fails']) test(`T5 actual MCP wrapper ${arm}`, async t => {
  const f = await acceptanceFixture(t, { delays: { vector: 100, keyword: 100 } });
  await f.ingest(addressWorld().docs); await f.drain();
  const mcp = await mcpFixture(t, f, { failFirst: arm === 'retry-recovers', failAlways: arm === 'retry-fails' });
  const result = await mcp.search();
  const retry = arm !== 'healthy';
  assert.equal(result.attempts, retry ? 2 : 1, 'fixed maximum attempts reached');
  assert.equal(result.waits, retry ? 1 : 0);
  assert.equal(result.elapsed, retry ? 2200 : 100, 'wrapper includes exactly one 2-second backoff');
  const receipt = result.response.result._meta.timing;
  assert.equal(receipt.total_ms, result.elapsed);
  assert.equal(receipt.stages.mcp_backend.calls, result.attempts);
  assert.equal(receipt.stages.mcp_retry_wait.ms, retry ? 2000 : 0);
  assert.equal(receipt.backend.length, result.attempts);
  const body = JSON.parse(result.response.result.content[0].text);
  if (arm === 'retry-fails') {
    assert.equal(body.search_status, 'search_unavailable');
    assert.match(body.note, /search could not be completed/i);
    assert.match(body.note, /does not mean your brain is empty/i);
  } else assert.ok(JSON.stringify(body).includes('change-request'), 'gold record survives actual MCP rendering');
  assert.equal(f.counts.answer + f.counts.verifier, 0);
  t.diagnostic(JSON.stringify({ arm, elapsed_ms: result.elapsed, attempts: result.attempts, source_sha256: result.source_sha256 }));
});

test('T5 actual MCP wrapper exposes a 65-second provider delay in end-to-end elapsed time', async t => {
  const f = await acceptanceFixture(t, { delays: { vector: 65000 } });
  await f.ingest(addressWorld().docs); await f.drain();
  const result = await (await mcpFixture(t, f)).search();
  assert.equal(result.attempts, 1); assert.equal(result.waits, 0);
  assert.equal(f.counts.vector, 1);
  assert.equal(result.elapsed, 65000);
  assert.equal(result.response.result._meta.timing.total_ms, result.elapsed);
  assert.equal(result.response.result._meta.timing.backend[0].total_ms, result.elapsed);
  assert.ok(result.elapsed > 3000, 'proposed search budget fails after reaching slow provider');
  assert.ok(result.response.result.content[0].text.includes('change-request'));
});
