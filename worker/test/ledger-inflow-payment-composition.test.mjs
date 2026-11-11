import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

for (const kind of ['card', 'loan']) for (const paired of [false, true]) {
  test(`gross inflow retains ${paired ? 'paired' : 'unpaired'} ${kind} payment postings beside ordinary income`, async t => {
    const f = ledgerFixture(t);
    t.mock.method(globalThis, 'fetch', () => assert.fail('offline only'));
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('liability','owner',?,'liability','5678','manual','owner_stated','confirmed',?)`, kind, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('liability','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
    f.add('ordinary', 'External receipt', 'Receipt Unit', { cents: 100, direction: 'inflow', date: '2026-10-05' });
    const read = async question => {
      const before = f.calls.length, changes = f.first('SELECT total_changes() n').n;
      const body = await (await withLedgerAnswer({ env: f.env, question, now: Date.parse('2026-11-06T12:00:00Z'),
        grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('ledger route reached'))).json();
      assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real transaction reader reached');
      assert.equal(f.first('SELECT total_changes() n').n, changes, 'read-only answer');
      return body;
    };
    const question = 'How much money came in during October 2026?';
    assert.equal((await read(question)).ledger.combined_inflow_minor, 100, 'ordinary green control');
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,category,category_basis_state,provenance,basis_state,recorded_at)
      VALUES ('credit','liability','2026-10-05',50,'inflow','TRANSFER FROM ACCOUNT 1234','LOAN_PAYMENTS_CREDIT_CARD_PAYMENT','confirmed','owner_stated','confirmed',?)`, NOW);
    if (paired) f.add('payment', 'payment to account 5678', null, { cents: 50, direction: 'outflow', date: '2026-10-05' });
    const body = await read(question);
    assert.equal(body.ledger.combined_inflow_minor, 150, 'gross includes receiving payment leg');
    assert.equal(body.ledger.accounts.reduce((sum, a) => sum + a.credits_minor, 0), 150);
    assert.equal(body.ledger.lead_accounts.reduce((sum, a) => sum + a.credits_minor, 0), 100, 'ordinary alternate excludes payment credit');
    assert.equal(body.ledger.outside_inflow_minor, paired ? 100 : 150, 'only a proved pair reduces outside inflow');
    assert.equal(body.ledger.matched_own_transfers.total_minor, paired ? 50 : 0);
    assert.equal(new Set(body.citations.map(ref => ref.ref)).size, body.citations.length, 'raw and payment disclosures share each posting citation');
    // The paired card postings describe one economic payment. The loan
    // fixture's separate bank-code kinds retain their independent postings.
    const economicPair = paired && kind === 'card';
    assert.equal(body.ledger.payment_exclusions.count, paired && !economicPair ? 2 : 1, 'payment disclosure decision reached');
    assert.equal(body.ledger.payment_exclusions.total_minor, paired && !economicPair ? 100 : 50);
    if (!paired) assert.match(body.answer, /Possible own transfer.*TRANSFER FROM ACCOUNT 1234/);
    const mixed = await read('How much money came in and went out during October 2026?');
    assert.equal(mixed.ledger.accounts.reduce((sum, a) => sum + a.credits_minor, 0), paired ? 100 : 150, 'unpaired credits stay in money in and net');
    if (!paired) {
      assert.ok(mixed.ledger.possible_owned_credits?.some(row => row.amount_minor === 50 && row.included_in_total), 'retained receiving credit is explicitly disclosed');
      assert.match(mixed.answer, /Possible moves from your own accounts, retained in money in and net/);
    }
    assert.equal(mixed.ledger.accounts.reduce((sum, a) => sum + a.debits_minor, 0), 0, 'mixed expenses exclude repayment');
  });
}
