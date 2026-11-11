import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';

test('transfer totals require reciprocal evidence and complete account labels', async t => {
  const f = fixture(); t.after(() => f.close());
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  for (const [slug, kind, label] of [['source', 'checking', 'Daily reserve'], ['target', 'savings', 'Later reserve']]) {
    account(f, { slug, mode: 'manual', mask: slug === 'source' ? '1101' : '1102' });
    f.raw('UPDATE fin_accounts SET label=?, account_kind=? WHERE account_slug=?', label, kind, slug);
  }
  async function answer(question) {
    const raw = { ambiguous: false, unanswered_part: null, intents: [{ kind: 'transfers', direction: null, count: null,
      vendor_text: null, account_hint: null, amount_text: null, date_text: null, period: { type: 'last_month' } }] };
    f.env.ANTHROPIC_API_KEY = 'synthetic-test-placeholder';
    return (await withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
      callLLM: async () => ({ content: [{ type: 'text', text: JSON.stringify(raw) }] }) }, async () => Response.json({}))).json();
  }
  transaction(f, { uid: 'out', slug: 'source', direction: 'outflow', amount: 123 });
  transaction(f, { uid: 'in', slug: 'target', direction: 'inflow', amount: 123, day: '2026-09-18' });
  f.raw("UPDATE fin_transactions SET description='Transfer to Later reserve' WHERE txn_uid='out'");
  f.raw("UPDATE fin_transactions SET description='Customer invoice payment' WHERE txn_uid='in'");
  const advisory = await answer('Show transfers last month');
  assert.equal(advisory.ledger.total_minor, 0);
  assert.match(advisory.answer, /possible transfers, not counted/i);
  assert.equal(advisory.ledger.transfers[0].excluded_from_totals, true);
  f.raw("UPDATE fin_transactions SET description='Transfer from Daily reserve' WHERE txn_uid='in'");
  for (const verb of ['move', 'moved', 'transfer']) {
    const body = await answer(`How much did I ${verb} from Daily reserve to Later reserve last month?`);
    assert.equal(body.ledger?.total_minor, 123, verb + JSON.stringify(body));
    assert.equal(body.ledger.transfer_scope.confirmed_total_minor, 123);
  }
  const shortened = await answer('How much did I move from Daily to Later last month?');
  assert.equal(shortened.ledger?.total_minor, undefined, 'partial labels cannot grant scope');
  assert.equal((await answer('How much did I move from my Daily reserve account to my Later reserve account last month?')).ledger?.total_minor, 123);
  assert.equal((await answer('How much did I move from Daily reserve to Later reserve last month before September 10?')).ledger?.total_minor, undefined, 'direction masking must preserve calendar restrictions');
  f.raw("UPDATE fin_transactions SET posted_on='2026-09-19' WHERE txn_uid='in'");
  assert.equal((await answer('Show transfers last month')).ledger.total_minor, 0, 'four days is outside the pairing window');
});


