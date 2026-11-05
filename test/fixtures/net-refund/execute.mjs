import { blocked } from './guards.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { NOW, reply, recount } from './cases.mjs';
const { ledgerFixture } = await import('../../../worker/test/ledger-review-fixture.mjs');
export async function execute(c, implementation = {}) {
  const { withLedgerAnswer } = implementation.withLedgerAnswer ? implementation : await import('../../../worker/src/lib/ledger-answer.js');
  const { validateLedgerIntentDecision } = await import('../../../worker/src/lib/ledger-intent.js');
  const cleanups = [], f = ledgerFixture({ after: fn => cleanups.push(fn) });
  try {
    f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
    const refuse = () => { blocked.push('PROVIDER'); throw new Error('FORBIDDEN_PROVIDER'); };
    f.env.AI = { run: refuse }; f.env.VECTORIZE = { upsert: refuse, deleteByIds: refuse, query: refuse };
    for (const r of c.rows) f.add(r.id, r.description, r.payee, { cents: r.cents, direction: r.direction, date: r.date });
    if (c.duplicate) {
      assert.throws(() => f.add('purchase', 'Posted purchase', 'Vendor Unit', { cents: 12000, direction: 'outflow' }), /UNIQUE/);
      assert.equal(f.first('SELECT COUNT(*) AS n FROM fin_transactions').n, c.rows.length);
    }
    if (c.missingAccountKind) f.raw("UPDATE fin_accounts SET account_kind='other'");
    if (c.mixedCurrency) {
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,currency,feed_mode,provenance,basis_state,recorded_at)
        VALUES ('foreign-account','owner','checking','asset','5678','EUR','manual','owner_stated','confirmed',?)`, NOW);
    }
    if (c.mixedRowCurrency) f.raw("UPDATE fin_transactions SET currency='EUR' WHERE txn_uid='refund'");
    if (c.ownTransfer) {
      f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,provenance,basis_state,recorded_at)
        VALUES ('reserve-account','owner','savings','asset','5678','Vendor Unit','manual','owner_stated','confirmed',?)`, NOW);
      f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES ('reserve-account','complete','2024-01-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
      // Bilateral direction and account masks support an owned movement, not a refund.
      f.add('owned_out', 'Transfer to savings 5678', 'Vendor Unit', { cents: 3000, direction: 'outflow' });
      f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
        VALUES ('owned_in','reserve-account','2026-10-05',3000,'inflow','Transfer from checking 1234','Transfer','owner_stated','confirmed',?)`, NOW);
    }
    const raw = { intents: structuredClone(c.intents || [reply()]) };
    if (c.malformed === 'missing_kind') delete raw.intents[0].kind;
    if (c.malformed === 'extra_field') raw.intents[0].unsupported_field = true;
    if (c.malformed === 'invalid_direction') raw.intents[0].direction = 'sideways';
    if (c.malformed === 'nonliteral') raw.intents[0].vendor_text = 'Other Unit';
    const plan = validateLedgerIntentDecision(raw, c.question, { now: Date.parse(NOW), timeZone: 'UTC' });
    const trace = { validation: 1, model: 0, document: 0, render: 0, inventory: 0, transactions: 0 };
    const response = await withLedgerAnswer({ env: f.env, question: c.question, now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        trace.model++; return { content: [{ type: 'text', text: JSON.stringify(raw) }] };
      } }, async () => { trace.document++; return Response.json({ answer: 'No amount supplied by the injected document path.', ledger: null }); });
    assert.equal(blocked.length, 0, 'STOP: forbidden adapter reached');
    const body = await response.json();
    trace.inventory = f.calls.filter(sql => /FROM fin_accounts a/.test(sql)).length;
    trace.transactions = f.calls.filter(sql => /CROSS JOIN fin_transactions/.test(sql)).length;
    trace.render = typeof body.answer === 'string' && (body.ledger !== null || body.clarification) ? 1 : 0;
    assert.equal(trace.model, 1, `${c.id}: recorded model decision reached`);
    if (!c.terminal || c.terminal !== 'router') assert.ok(plan.intents?.length, `${c.id}: nonempty validated plan`);
    if (!c.terminal) { assert.ok(trace.inventory > 0); assert.ok(trace.transactions > 0); assert.equal(trace.render, 1); }
    return { id: c.id, plan, trace, body, recounted: recount(c), sql: f.calls.map(sql => ({ transaction: /CROSS JOIN fin_transactions/.test(sql) })) };
  } finally { for (const fn of cleanups) fn(); }
}
