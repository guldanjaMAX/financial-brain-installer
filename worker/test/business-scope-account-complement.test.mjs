import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ask, base } from './business-scope-complement-fixture.mjs';
import { withLedgerAnswer, fallbackAnswer, boundary } from './business-scope-selector-loader.mjs';

const populated = r => {
  assert.equal(r.reached.provider, 1);
  assert.ok(r.reached.inventory && r.reached.facts, 'account and money decision reached');
};
async function green(reader, f) {
  const r = await ask(reader, f, 'what did my business spend last month', 'expense_summary', 'business');
  populated(r); assert.equal(r.body.ledger.total_minor, 300);
}
for (const [mode, reader] of [['default', withLedgerAnswer], ['fallback', fallbackAnswer]]) {
  for (const label of ['Materials', 'Expenses', 'Income']) for (const category of [false, true]) for (const hint of [null, 'business']) {
    test(`${mode} B1 ${label} category=${category} hint=${hint}`, async t => {
      const f = fixture(t);
      f.raw("UPDATE fin_accounts SET label=? WHERE account_slug='reserve'", label);
      f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
      await green(reader, f);
      const q = `business spending ${category ? 'on software ' : ''}in my ${label} account last month`;
      const kind = category ? 'category' : 'expense_summary', vendor = category ? 'software' : null;
      const named = await ask(reader, f, q, kind, label, vendor);
      populated(named); assert.equal(named.body.ledger.total_minor, 200);
      const head = await ask(base, f, q, kind, hint, vendor), got = await ask(reader, f, q, kind, hint, vendor);
      populated(head); populated(got); assert.equal(head.body.ledger.total_minor, 300, 'S5 ordinary owner scope remains authoritative');
      assert.equal(got.text, head.text); assert.deepEqual(got.reached, head.reached);
    });
  }
  test(`${mode} 480 generated complements retain exact HEAD`, async t => {
    const f = fixture(t), questions = new Set(), outputs = new Set();
    await green(reader, f);
    let seed = 0x427b1;
    for (let i = 0; i < 480; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const label = i < 48 ? 'Expenses' : `Unit${seed.toString(16).replace(/[0-9a-f]/g, c => String.fromCharCode(107 + parseInt(c, 16)))}`;
      const prep = ['in', 'on', 'from', 'for'][i % 4], owner = ['my', 'our'][Math.floor(i / 4) % 2];
      const noun = ['account', 'accounts', 'card', 'checking', 'savings', 'loan'][Math.floor(i / 8) % 6];
      const form = Math.floor(i / 48) % 5;
      const complement = form === 0 ? `${prep} ${owner} ${label} ${noun}`
        : form === 1 ? `${i % 2 ? 'in' : 'on'} ${label} account`
          : form === 2 ? `ending ${8100 + i}` : form === 3 ? `last four ${8100 + i}` : `${8100 + i}`;
      const q = `business spending ${complement} last month`;
      questions.add(q);
      f.raw('UPDATE fin_transactions SET amount_minor=amount_minor+1');
      const head = await ask(base, f, q, 'expense_summary', i % 2 ? 'business' : null);
      const got = await ask(reader, f, q, 'expense_summary', i % 2 ? 'business' : null);
      assert.ok(head.reached.provider || head.reached.inventory, 'HEAD decision reached');
      assert.ok(got.reached.provider || got.reached.inventory, 'candidate decision reached');
      assert.equal(got.text, head.text, q); assert.deepEqual(got.reached, head.reached);
      const admission = boundary.ledgerAccountComplementAdmission(q, [], { now: Date.parse('2026-10-12T12:00:00Z'), timeZone: 'UTC' });
      assert.equal(admission.detected, true, 'every generated complement reaches the local veto');
      assert.ok(admission.complements.length);
      outputs.add(head.text);
    }
    assert.equal(questions.size, 480); assert.ok(outputs.size > 100, 'population has nonuniform reached outputs');
    console.log(`${mode}_complement_head_equal=480/480`);
  });
  test(`${mode} 120 bare role account controls stay pure`, async t => {
    const f = fixture(t), questions = new Set();
    for (const prefix of ['', 'show ', 'please show ', 'could you show ', 'can you retrieve ', 'please retrieve '])
      for (const owner of ['my', 'our']) for (const role of ['business', 'biz', 'company', 'personal', 'household'])
        for (const noun of ['account', 'accounts']) {
          const q = `${prefix}${owner} ${role} ${noun} spending last month`;
          questions.add(q);
          const personal = ['personal', 'household'].includes(role);
          f.raw("UPDATE fin_transactions SET amount_minor=300 WHERE account_slug='private'");
          const got = await ask(reader, f, q, 'expense_summary', role);
          assert.ok(got.reached.inventory && got.reached.facts && got.reached.disclosure, 'pure membership and money reached');
          assert.equal(got.body.ledger.total_minor, 300);
          assert.deepEqual([...new Set(got.body.citations.map(c => c.account_mask))].sort(), personal ? ['8103'] : ['8101', '8102']);
          const legacy = `${prefix}${owner} ${role} ${noun} balances`;
          const head = await ask(base, f, legacy, 'balance', role), ordinary = await ask(reader, f, legacy, 'balance', role);
          assert.equal(ordinary.text, head.text, 'balance measure is outside the closed grammar');
          assert.deepEqual(ordinary.reached, head.reached);
        }
    assert.equal(questions.size, 120); console.log(`${mode}_bare_role_pure=120/120 legacy_balance_head=120/120`);
  });
  test(`${mode} incomplete local admission vetoes purity with a populated control`, async t => {
    const f = fixture(t); await green(reader, f);
    const q = 'business spending in my account last month';
    const head = await ask(base, f, q, 'expense_summary', 'business');
    const got = await ask(reader, f, q, 'expense_summary', 'business');
    populated(head); populated(got); assert.equal(got.text, head.text);
  });
  test(`${mode} an article outside the closed role slot retains HEAD`, async t => {
    const f = fixture(t); await green(reader, f);
    const q = 'How much money is in the business accounts right now?';
    const head = await ask(base, f, q, 'balance'), got = await ask(reader, f, q, 'balance');
    populated(head); populated(got); assert.equal(got.text, head.text); assert.deepEqual(got.reached, head.reached);
  });
}

test('local account complement admission is typed and text grants no role authority', () => {
  assert.equal(typeof boundary.ledgerAccountComplementAdmission, 'function');
  for (const q of ['business spending in my Expenses account', 'business spending in my Expenses\nIncome account', 'business spending for our Unit checking', 'business spending on Unit account', 'business spending 1234']) {
    const result = boundary.ledgerAccountComplementAdmission(q, [], { now: Date.parse('2026-10-12T12:00:00Z'), timeZone: 'UTC' });
    assert.equal(result.type, 'account-complement'); assert.equal(result.complete, false); assert.equal(result.detected, true);
    assert.ok(result.complements.length, 'detector decision reached');
  }
  assert.equal(boundary.ledgerAccountComplementAdmission('business spending in my account').complete, false);
  assert.equal(boundary.ledgerAccountComplementAdmission(null).complete, false);
  for (const q of ['my business accounts spending last month', 'our personal accounts spending last month']) {
    const result = boundary.ledgerAccountComplementAdmission(q, [], { now: Date.parse('2026-10-12T12:00:00Z'), timeZone: 'UTC' });
    assert.equal(result.complete, true); assert.equal(result.detected, false);
    assert.equal(boundary.ledgerPureRole([]), null, 'text cannot authorize purity');
  }
});
