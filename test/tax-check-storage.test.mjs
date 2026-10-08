import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createTaxCheckStore } from '../worker/src/lib/tax-check-document.js';
import { taxFixture, TAX_TIME } from './fixtures/tax-check.mjs';

async function harness() {
  const fixture = await taxFixture();
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/d1/0051_financial_evidence.sql', import.meta.url), 'utf8'));
  const calls = [];
  const fault = { drop: false, lost: false, denied: false };
  const store = createTaxCheckStore({ ...fixture.deps,
    authorizeRun: async () => { calls.push('authorize'); return !fault.denied; },
    db: { prepare(sql) { return { bind(...values) { return {
      first: async () => { calls.push('read'); return db.prepare(sql).get(...values) ?? null; },
      run: async () => { calls.push('write'); if (!fault.drop) db.prepare(sql).run(...values);
        if (fault.lost) { fault.lost = false; throw new Error('fixture_lost_response'); } return { success: true }; },
    }; } }; } },
  });
  const request = { scope: fixture.tax.scope, tax_year: 2025, filing_unit_ref: fixture.tax.filing_unit_ref,
    jurisdiction: 'US_federal', observed_at: TAX_TIME, implementation_sha: 'a'.repeat(40),
    entries: [{ rule_id: fixture.rule, transfer: fixture.tax }] };
  return { fixture, db, calls, fault, store, request };
}

test('stored document has deterministic cited money, complete rule denominator and exact retry readback', async () => {
  const h = await harness();
  try {
    const result = await h.store.publish(h.request);
    assert.equal(result.document.title, 'Tax check 2025');
    assert.match(result.document.text, /Possible miss, review with your preparer/);
    assert.match(result.document.text, /USD 420\.00 \[1\]/);
    assert.match(result.document.text, /USD 0\.00 \[2\]/);
    assert.equal(result.results.length, 32);
    assert.equal(result.counts.checked, 1); assert.equal(result.counts.not_checked, 31);
    assert.equal(result.citations.length, 2);
    const again = await h.store.publish(h.request);
    assert.deepEqual(again, result);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 1);
    assert.ok(h.calls.filter(call => call === 'read').length >= 2);
    const read = await h.store.read({ tenant: h.request.scope.tenant, run_ref: result.run_ref });
    assert.deepEqual(read, result);
  } finally { h.db.close(); }
});

test('dropped writes, denied reads and stale confirmations refuse after reaching the relevant gate', async () => {
  const h = await harness();
  try {
    h.fault.drop = true;
    await assert.rejects(h.store.publish(h.request), { code: 'tax_check_readback' });
    assert.ok(h.calls.includes('write')); assert.ok(h.calls.includes('read'));
    h.fault.drop = false;
    const good = await h.store.publish(h.request);
    h.fault.denied = true;
    await assert.rejects(h.store.read({ tenant: h.request.scope.tenant, run_ref: good.run_ref }), { code: 'tax_check_access' });
    assert.ok(h.calls.includes('authorize'));
    h.fault.denied = false;
    h.fixture.review.authenticated = false;
    await assert.rejects(h.store.read({ tenant: h.request.scope.tenant, run_ref: good.run_ref }), { code: 'tax_check_stale' });
    assert.ok(h.fixture.calls.includes('review'));
    h.fixture.review.authenticated = true;
    assert.equal((await h.store.read({ tenant: h.request.scope.tenant, run_ref: good.run_ref })).run_ref, good.run_ref);
  } finally { h.db.close(); }
});

test('lost response retries preserve one immutable run', async () => {
  const h = await harness();
  try {
    h.fault.lost = true;
    await assert.rejects(h.store.publish(h.request), { code: 'tax_check_storage' });
    assert.ok(h.calls.includes('write'));
    const result = await h.store.publish(h.request);
    assert.equal(result.counts.checked, 1);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 1);
  } finally { h.db.close(); }
});

test('private free text cannot enter the immutable run envelope', async () => {
  const h = await harness();
  try {
    assert.equal((await h.store.publish(h.request)).counts.checked, 1);
    await assert.rejects(h.store.publish({ ...h.request, note: ['999', '88', '7777'].join('-') }), { code: 'tax_check_request' });
    assert.ok(h.calls.includes('authorize'));
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 1);
  } finally { h.db.close(); }
});

test('later reviewed runs supersede in publication order even at the same source observation time', async () => {
  const h = await harness();
  try {
    let prior = await h.store.publish(h.request);
    for (let index = 1; index <= 4; index++) {
      h.fixture.review.inventory_revision = `inventory_${index + 1}`;
      const next = await h.store.publish(h.request);
      assert.notEqual(next.run_ref, prior.run_ref);
      await assert.rejects(h.store.read({ tenant: h.request.scope.tenant, run_ref: prior.run_ref }), { code: 'tax_check_superseded' });
      assert.ok(h.calls.includes('read'));
      assert.equal((await h.store.read({ tenant: h.request.scope.tenant, run_ref: next.run_ref })).current, true);
      prior = next;
    }
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 5);
  } finally { h.db.close(); }
});

test('concurrent publication fences one generation and a retry appends the next', async () => {
  const h = await harness();
  try {
    const requests = [h.request, { ...h.request, implementation_sha: 'b'.repeat(40) }];
    const attempts = await Promise.allSettled(requests.map(request => h.store.publish(request)));
    assert.equal(attempts.filter(item => item.status === 'fulfilled').length, 1);
    const failed = attempts.findIndex(item => item.status === 'rejected');
    assert.equal(attempts[failed].reason.code, 'tax_check_readback');
    assert.equal(h.calls.filter(item => item === 'write').length, 2);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 1);
    const retry = await h.store.publish(requests[failed]);
    assert.equal(retry.current, true);
    assert.equal(h.db.prepare('SELECT count(*) AS n FROM financial_run_events').get().n, 2);
  } finally { h.db.close(); }
});
