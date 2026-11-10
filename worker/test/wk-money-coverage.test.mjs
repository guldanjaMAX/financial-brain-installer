import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import worker from '../src/index.js';

for (const question of ['How much money came in during October 2026?', 'How much money went out during October 2026?', 'What were my largest expenses in October 2026?']) {
  for (const scope of ['full', 'in-progress-full', 'partial', 'absent', ...(!question.includes('went out') ? ['empty-covered'] : [])]) test(`${scope}: ${question}`, async t => {
    t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
    const allAccounts = ['full', 'in-progress-full'].includes(scope);
    const clock = scope === 'full' ? '2026-11-03T12:00:00Z' : NOW;
    t.mock.method(Date, 'now', () => Date.parse(clock));
    const f = ledgerFixture(t);
    t.mock.method(f.env.AI, 'run', () => assert.fail('model forbidden'));
    f.add('in', 'Receipt', 'Payer Unit', { cents: 1731 });
    f.add('out', 'Purchase', 'Seller Unit', { cents: 927, direction: 'outflow' });
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
      SELECT 'second','owner','checking','asset','5678','live','feed',source_feed,'confirmed',? FROM fin_accounts LIMIT 1`, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
      SELECT 'second','complete',?,'2026-10-31',?,'feed',source_feed,'confirmed',? FROM fin_accounts LIMIT 1`, allAccounts ? '2024-01-01' : '2026-10-10', NOW, NOW);
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
      SELECT 'second-out','second','2026-10-11',81000,'outflow','Purchase','Seller Other','feed',source_feed,'confirmed',? FROM fin_accounts LIMIT 1`, NOW);
    if (scope === 'absent') f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-10'");
    if (scope === 'empty-covered') f.raw("UPDATE fin_transactions SET posted_on='2026-09-05' WHERE account_slug='fixture-account'");
    f.calls.length = 0;
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
      body: JSON.stringify({ q: question }),
    }), f.env, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(f.calls.some(sql => /FROM fin_accounts a/.test(sql)), 'coverage inventory decision reached');
    assert.equal(f.first('SELECT count(*) n FROM fin_transactions').n, 3, 'nonempty negative fixture');
    t.diagnostic(JSON.stringify({ scope, coverage_reads: f.calls.filter(sql => /FROM fin_accounts a/.test(sql)).length,
      ledger_reads: f.calls.filter(sql => /JOIN fin_transactions/.test(sql)).length,
      selected_accounts: body.ledger?.accounts?.map(account => account.account_mask) || [] }));
    if (scope === 'absent') {
      assert.notEqual(body.evidence_gate?.supported, true);
      assert.ok(body.gaps.some(gap => gap.reason === 'period_outside_coverage'));
      return;
    }
    if (scope === 'empty-covered') {
      assert.equal(body.evidence_gate.supported, true);
      assert.equal(body.evidence_gate.complete, false);
      assert.equal(body.ledger.complete, false);
      assert.equal(body.ledger.coverage.covered_account_count, 1);
      assert.match(body.answer, /partial/i);
      assert.match(body.answer, /1234/);
      assert.match(body.answer, /5678/);
      assert.deepEqual(body.citations, []);
      if (body.ledger.kind === 'totals') {
        assert.equal(body.ledger.covered_inflow_subtotal_minor, 0);
        assert.match(body.answer, /\$0\.00/);
      } else assert.deepEqual(body.ledger.lead_rows, []);
      return;
    }
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'transaction snapshot reached');
    assert.equal(body.evidence_gate.supported, true);
    assert.ok(body.citations.some(ref => ref.amount_minor === (question.includes('came in') ? 1731 : allAccounts ? 81000 : 927)));
    if (scope === 'partial') {
      assert.equal(body.ledger.complete, false);
      assert.equal(body.evidence_gate.complete, false);
      assert.equal(body.ledger.coverage.covered_account_count, 1);
      assert.equal(body.ledger.coverage.candidate_account_count, 2);
      assert.deepEqual(body.ledger.coverage.excluded_accounts.map(a => a.account_mask), ['5678']);
      assert.match(body.answer, /partial/i);
      assert.match(body.answer, /5678/);
      assert.ok(!body.citations.some(ref => ref.account_mask === '5678'));
      assert.match(body.answer, /\$17\.31|\$9\.27/);
      if (body.ledger.kind === 'totals') {
        assert.deepEqual(body.ledger.accounts.map(a => [a.account_mask, a.credits_minor, a.debits_minor]), [['1234', 1731, 927]]);
      } else if (body.ledger.kind === 'expense_summary') assert.equal(body.ledger.expense_total_minor, 927);
      else assert.deepEqual(body.ledger.lead_rows.map(row => row.amount_minor), [927]);
    } else {
      assert.equal(body.evidence_gate.complete, scope === 'full');
      if (scope === 'in-progress-full') {
        assert.equal(body.ledger.complete, false);
        assert.equal(body.ledger.coverage.complete, false);
        assert.deepEqual([body.ledger.from, body.ledger.to, body.ledger.requested_to], ['2026-10-01', '2026-10-12', '2026-10-31']);
        assert.match(body.answer, /Partial period: recorded activity only through/);
      }
      assert.deepEqual(body.ledger.accounts.map(a => a.account_mask).sort(), ['1234', '5678']);
      if (body.ledger.kind === 'totals') {
        assert.equal(body.ledger.accounts.reduce((sum, a) => sum + a.credits_minor, 0), 1731);
        assert.equal(body.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), 81927);
      } else if (body.ledger.kind === 'expense_summary') assert.equal(body.ledger.expense_total_minor, 81927);
      else assert.deepEqual(body.ledger.lead_rows.map(row => row.amount_minor), [81000, 927]);
    }
  });
}
