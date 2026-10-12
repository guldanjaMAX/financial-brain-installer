// A quiet Microsoft day certifies only when every enabled workload was walked.
// Malformed drive discovery (a 200 with no drive identity or no value array)
// must withhold the provider-check proof instead of silently skipping files.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { syncMicrosoftGraph } from '../connectors/microsoft-graph.mjs';
import { runProviderConnector } from '../connectors/provider-runtime.mjs';
import { providerNoChangeCheckAt } from '../worker/src/lib/source-receipt.js';
import { sourceInventory } from '../worker/src/lib/store-d1.js';
import worker from '../worker/src/index.js';
import { createProductFixture } from '../worker/test/product-contract-fixture.mjs';

const NOW = '2026-10-10T12:00:00.000Z';
test.before(() => mock.method(Date, 'now', () => Date.parse(NOW)));
test.after(() => mock.restoreAll());
const boundary = { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/fixture-terminal' };

async function run(t, { discovery = { id: 'drive-one' }, site = false, drivePages = [boundary] } = {}) {
  const f = await createProductFixture(); t.after(f.close);
  f.env.ADMIN_KEY = randomBytes(32).toString('hex');
  const calls = { access: 0, mail: 0, discovery: 0, files: 0, saves: 0, receipts: 0 };
  let saved = null, failure = null;
  const receipts = [];
  try {
    await runProviderConnector({
      provider: 'microsoft', source: 'microsoft', now: () => new Date(NOW),
      resolveAccess: async () => { calls.access++; return { accessToken: randomBytes(12).toString('hex') }; },
      loadState: async () => ({ cursor: null }),
      saveState: async state => { calls.saves++; saved = state; },
      listStoredFamilies: async () => new Set(),
      sendBatch: async () => assert.fail('empty fixture has no documents to deliver'),
      postReceipt: async (_base, _key, receipt) => {
        calls.receipts++; receipts.push(receipt);
        const response = await worker.fetch(new Request('https://brain.invalid/api/admin/brain/source-receipt', {
          method: 'POST', headers: { 'X-Admin-Key': f.env.ADMIN_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(receipt),
        }), f.env, {});
        assert.equal(response.status, 200);
      },
      sync: options => syncMicrosoftGraph({ ...options, now: () => Date.parse(NOW),
        includeCalendar: false, includePersonalDrive: !site, siteIds: site ? ['site-one'] : [],
        fetchImpl: async value => {
          const url = new URL(value);
          if (url.pathname.includes('/messages/delta')) { calls.mail++; return Response.json(boundary); }
          if (url.pathname === '/v1.0/me/drive' || url.pathname.includes('/sites/')) { calls.discovery++; return Response.json(discovery); }
          calls.files++;
          assert.ok(drivePages.length > 0, 'a drive request consumes a distinct fixture response');
          const { status = 200, ...page } = drivePages.shift();
          return Response.json(page, { status });
        },
      }),
    });
  } catch (error) { failure = error; }
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  const receipt = inventory.rows.find(row => row.name === 'microsoft' || row.source === 'microsoft')?.receipt ?? inventory.rows[0].receipt;
  return { calls, saved, failure, receipts, checkAt: providerNoChangeCheckAt('microsoft', receipt.latest_run) };
}

for (const site of [false, true]) test(`green control walks and saves mail and ${site ? 'site' : 'personal'} files`, async t => {
  const f = await run(t, site ? { site: true, discovery: { value: [{ id: 'drive-one' }] } } : {});
  assert.equal(f.failure, null);
  assert.deepEqual(f.calls, { access: 1, mail: 1, discovery: 1, files: 1, saves: 1, receipts: 2 });
  assert.equal(Object.keys(f.saved.cursor.drives).length, 1);
  assert.equal(f.checkAt, NOW, 'a fully walked quiet day certifies');
});

for (const [title, options] of [
  ['personal drive discovery lacks its required identity', { discovery: {} }],
  ['site drive discovery lacks its required value array', { site: true, discovery: {} }],
  ['site drive discovery lists a drive with no identity', { site: true, discovery: { value: [{}] } }],
]) {
  test(`discovery defect: ${title} must not certify a quiet run`, async t => {
    const f = await run(t, options);
    assert.equal(f.calls.discovery, 1, 'enabled file discovery decision was reached');
    assert.equal(f.calls.mail, 1, 'another workload completed');
    assert.equal(f.calls.files, 0, 'no file delta walk ran');
    assert.notEqual(f.receipts.at(-1).provider_check_complete, true, 'no boundary proof is published');
    assert.equal(f.checkAt, null, 'missing file inventory cannot certify upstream silence');
  });
}

for (const [label, drivePages] of [
  ['incomplete file page', [{ value: [], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/fixture-next' }, { value: [] }]],
  ['expired file cursor', [{ status: 410 }]],
  ['file provider failure', [{ status: 403 }]],
]) {
  test(`${label} cannot certify a completed mail walk`, async t => {
    const f = await run(t, { drivePages });
    assert.equal(f.calls.discovery, 1);
    assert.ok(f.calls.files > 0, 'file failure decision was reached');
    assert.ok(f.failure);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.checkAt, null);
  });
}
