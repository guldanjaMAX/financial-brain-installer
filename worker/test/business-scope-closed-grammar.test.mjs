import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, ask, base } from './business-scope-complement-fixture.mjs';
import { withLedgerAnswer, fallbackAnswer, boundary } from './business-scope-selector-loader.mjs';

const context = { now: Date.parse('2026-10-12T12:00:00Z'), timeZone: 'UTC' };
const masks = r => [...new Set((r.body.citations || []).map(c => c.account_mask))].sort();
async function green(reader, f) {
  const r = await ask(reader, f, 'business spending last month', 'expense_summary', 'business');
  assert.ok(r.reached.inventory && r.reached.facts && r.reached.disclosure, 'pure membership and money reached');
  assert.equal(r.body.ledger.total_minor, 300);
}
async function equalHead(reader, f, q, kind, hint, vendor) {
  const head = await ask(base, f, q, kind, hint, vendor);
  const got = await ask(reader, f, q, kind, hint, vendor);
  assert.ok(head.reached.provider || head.reached.inventory, 'HEAD decision reached');
  assert.ok(got.reached.provider || got.reached.inventory, 'candidate decision reached');
  assert.equal(got.text, head.text, q);
  assert.deepEqual(got.reached, head.reached);
  return got;
}
const frames =[
 ['nickname','Materials','in my Materials'],
 ['nickname','Expenses','on my Expenses'],
 ['nickname','Reserve','in my Reserve'],
 ['nickname','Everyday','on my Everyday'],
 ['nickname','Daily','with my Daily'],
 ['nickname','Income','in our Income'],
 ['role-label','Business Reserve','in my Business Reserve account'],
 ['role-label','Personal Expenses','in my Personal Expenses account'],
 ['role-label','Company Income','in the Company Income account'],
 ['role-label','Business Income','in my Business Income'],
 ['role-label','Company Expenses','in Company Expenses'],
 ['mask','Reserve','on the card ending 4421'],
 ['mask','Reserve','in the account ending 4421'],
 ['mask','Reserve','on my card last four 4421'],
 ['joint','Joint','in my joint account'],
 ['joint','Joint','in the joint account'],
 ['joint','Joint','on our joint account'],
 ['kind','Reserve','in savings'],
 ['kind','Reserve','from checking'],
 ['kind','Reserve','in my savings'],
 ['kind','Reserve','on our checking'],
 ['operating','Operating','in the operating account'],
 ['operating','Operating','from the operating account'],
 ['operating','Operating','on my operating account'],
 ['suffix','Materials','in Materials',true],
 ['suffix','Expenses','in Expenses',true],
 ['suffix','Income','in Income',true],
 ['suffix','Reserve','in Reserve',true],
 ['suffix','Materials','in my Materials',true],
 ['suffix','Expenses','on my Expenses',true],
 ['suffix','Expenses','in my Expenses account',true],
 ['suffix','Business Income','in Business Income',true],
 ['suffix','Joint','in the joint account',true],
 ['suffix','Reserve','from checking',true],
 ['nickname','Cash','on my Cash'],
 ['nickname','Payments','on my Payments'],
 ['nickname','Spending','in my Spending'],
 ['nickname','Savings','using my Savings'],
];

for (const [mode, reader] of [['default', withLedgerAnswer], ['fallback', fallbackAnswer]]) {
  test(`${mode} B1 nounless labels before and after period, all hints`, async t => {
    const f = fixture(t); await green(reader, f);
    let cases = 0;
    for (const label of ['Materials', 'Business Income']) for (const after of [false, true])
      for (const hint of [null, 'business', label]) {
        f.raw("UPDATE fin_accounts SET label=?,mask='4421' WHERE account_slug='reserve'", label);
        const q = after ? `business spending last month in ${label}` : `business spending in my ${label} last month`;
        const got = await equalHead(reader, f, q, 'expense_summary', hint);
        if (hint === label) {
          assert.ok(got.reached.facts, 'full label money decision reached');
          assert.equal(got.body.ledger.total_minor, 200); assert.deepEqual(masks(got), ['4421']);
        }
        cases++;
      }
    console.log(`${mode}_b1=${cases}/12`);
  });
  test(`${mode} all 38 review complement frames retain HEAD`, async t => {
    const f = fixture(t); await green(reader, f);
    f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
    let count = 0;
    for (const [, label, complement, after] of frames) for (const category of [false, true]) for (const hint of [null, 'business']) {
      f.raw("UPDATE fin_accounts SET label=?,mask='4421' WHERE account_slug='reserve'", label);
      const core = `business spending${category ? ' on software' : ''}`;
      const q = after ? `${core} last month ${complement}` : `${core} ${complement} last month`;
      await equalHead(reader, f, q, category ? 'category' : 'expense_summary', hint, category ? 'software' : null);
      count++;
    }
    assert.equal(frames.length, 38); console.log(`${mode}_review_frames=${count}/152`);
  });
  test(`${mode} 1200 seeded extra-token questions preserve HEAD`, async t => {
    const f = fixture(t), questions = new Set(), outputs = new Set(); await green(reader, f);
    let seed = 0x427c105;
    for (let i = 0; i < 1200; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const label = `Unit${seed.toString(16)}`;
      const extra = [label, `in my ${label}`, `from ${label}`, `at ${label}`, `ending ${1000 + i}`, `our ${label}`, `Business ${label}`, `unknown${seed}`][i % 8];
      const tokens = 'business spending last month'.split(' ');
      tokens.splice(Math.floor(i / 8) % 5, 0, extra);
      const q = tokens.join(' '); questions.add(q);
      f.raw('UPDATE fin_transactions SET amount_minor=amount_minor+1');
      const got = await equalHead(reader, f, q, 'expense_summary', i % 2 ? 'business' : null);
      assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, false, 'closed grammar reached and refused leftovers');
      outputs.add(got.text);
    }
    assert.equal(questions.size, 1200); assert.ok(outputs.size > 100, 'nonuniform populated outputs');
    console.log(`${mode}_nonpure_head_equal=1200/1200`);
  });
  test(`${mode} 300 fully consumed questions retain 300 cents`, async t => {
    const f = fixture(t), questions = new Set();
    outer: for (const lead of ['', 'what was', 'show me', 'tell me', 'please show me', 'how much did'])
      for (const owner of ['', 'my', 'our']) for (const role of ['business', 'company', 'biz'])
        for (const noun of ['', 'account', 'accounts']) for (const measure of ['spending', 'spend', 'expenses']) {
          const q = [lead, owner, role, noun, measure, 'last month'].filter(Boolean).join(' ');
          questions.add(q);
          assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, true, q);
          const got = await ask(reader, f, q, 'expense_summary', role);
          assert.ok(got.reached.inventory && got.reached.facts && got.reached.disclosure, q);
          assert.equal(got.body.ledger.total_minor, 300, q); assert.deepEqual(masks(got), ['8101', '8102']);
          if (questions.size === 300) break outer;
        }
    assert.equal(questions.size, 300); console.log(`${mode}_pure_kept=300/300`);
  });
}

test('closed grammar defaults incomplete and consumes exactly one role, measure and period', () => {
  const admit = (q, intents = []) => boundary.ledgerAccountComplementAdmission(q, intents, context);
  assert.equal(admit(null).complete, false);
  for (const q of ['business spending last month extra', 'business spending last month in Materials',
    'business spending in my Materials last month', 'business spending in my Business Income last month',
    'business spending', 'business business spending last month', 'business spending last month last month',
    'business spending in last month', 'business spending only last month']) {
    const r = admit(q); assert.equal(r.complete, false, q); assert.ok(r.remainder.length, 'leftover decision reached');
  }
  assert.equal(admit('SHOW ME, OUR BUSINESS ACCOUNTS SPENDING LAST MONTH?').complete, true);
  const category = [{ kind: 'category', match: 'software', requestedRole: 'business' }];
  assert.equal(admit('business spending on software last month', category).complete, true);
  assert.equal(admit('business spending on software last month').complete, false, 'provider category admission required');
  assert.equal(admit('business spending on software software last month', category).complete, false);
  assert.equal(admit('business spending on software in my software last month', category).complete, false);
});

test('existing period spans consume dates and combined periods without licensing residue', () => {
  const admit = q => boundary.ledgerAccountComplementAdmission(q, [], context);
  for (const period of ['from 2026-09-01 through 2026-09-30', 'last year q1', 'september 2026', 'since september 1, 2026']) {
    const q = `business spending ${period}?`;
    assert.equal(admit(q).complete, true, q);
    for (const extra of ['extra', 'in Materials', 'in my Business Income', '4421', 'after fees', 'to see', 'by payee']) {
      const rejected = admit(`${q} ${extra}`);
      assert.equal(rejected.complete, false); assert.ok(rejected.remainder.length, 'period remainder decision reached');
    }
  }
  for (const q of ["business's spending last month", 'the business spending last month', 'business spending in last month']) {
    assert.equal(admit(q).complete, false, q);
  }
});

// These exact earlier fixtures intentionally return to the ordinary reader.
const earlierPureCases = [];
for (const prefix of ['', 'show ', 'please show ', 'could you show ', 'can you retrieve ', 'please retrieve '])
  for (const owner of ['my', 'our']) for (const role of ['business', 'biz', 'company', 'personal', 'household'])
    for (const noun of ['account', 'accounts']) earlierPureCases.push([
      `${prefix}${owner} ${role} ${noun} balances`, 'balances (unsupported measure)',
    ]);
earlierPureCases.push(...[
  [
    "personal spending only last month",
    "only"
  ],
  [
    "personal spending only",
    "only; missing period"
  ],
  [
    "how much cash is in my business accounts",
    "how much cash is in; missing measure and period"
  ],
  [
    "Could you retrieve balances for my personal accounts?",
    "balances for; missing period"
  ],
  [
    "Could you retrieve balances for my business accounts?",
    "balances for; missing period"
  ],
  [
    "Could you retrieve business balances?",
    "balances; missing period"
  ],
  [
    "Could you retrieve personal balances?",
    "balances; missing period"
  ],
  [
    "Could you retrieve balances for my business?",
    "balances for; missing period"
  ],
  [
    "Show balances for the company",
    "balances for the; missing period"
  ],
  [
    "Could you retrieve balances for my biz?",
    "balances for; missing period"
  ],
  [
    "Could you retrieve spending for my household last month?",
    "spending for before role"
  ],
  [
    "How much money is in the business accounts right now?",
    "how much money is in the before role"
  ],
  [
    "Could you retrieve balances for all of my business accounts?",
    "balances for all of; missing period"
  ],
  [
    "Could you retrieve balances for each of my business accounts?",
    "balances for each of; missing period"
  ],
  [
    "Could you show my business accounts and their balances?",
    "and their balances; missing period"
  ],
  [
    "Could you total expenses in our business accounts last month?",
    "total expenses in before role"
  ],
  [
    "Could you retrieve where the business's money goes this month?",
    "where the; s money goes"
  ]
]);
for (const [mode, reader] of [['default', withLedgerAnswer], ['fallback', fallbackAnswer]]) {
  test(`${mode} every reclassified earlier pure fixture retains exact HEAD`, async t => {
    const f = fixture(t); await green(reader, f);
    for (const [q, token] of earlierPureCases) {
      const admission = boundary.ledgerAccountComplementAdmission(q, [], context);
      assert.equal(admission.complete, false, `${q}: ${token}`);
      assert.ok(admission.remainder.length, 'unconsumed-token decision reached');
      await equalHead(reader, f, q, /balanc|cash|money is in/.test(q) ? 'balance' : 'expense_summary', boundary.ledgerQuestionRoles(q)[0]);
    }
    console.log(`${mode}_pure_to_head=${earlierPureCases.length}/${earlierPureCases.length}`);
  });
}

test('every measure and standalone politeness use the same finite grammar', () => {
  for (const role of ['business', 'personal', 'company', 'household', 'biz'])
    for (const measure of ['spending', 'spend', 'expenses', 'money out', 'money in', 'income', 'deposits']) {
      const q = `please our ${role} accounts ${measure} last month`;
      assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, true, q);
      const rejected = boundary.ledgerAccountComplementAdmission(`please extra our ${role} accounts ${measure} last month`, [], context);
      assert.equal(rejected.complete, false); assert.ok(rejected.remainder.length);
    }
});

// Symbol-veto regressions from the final review.
const categoryIntents = [{ kind: 'category', match: 'software', requestedRole: 'business' }];
// Preserve the final review's exact insertion population, including its valid
// "from last month" control. Every arm must reach populated money decisions.
const inserts = [
  'OwnerUnit', 'Materials', 'Business Income', 'in', 'from', 'at', 'with',
  '123', '4421', '****4421', 'xxxx4421', '💼', '🚫', '👤', '💳',
  '©', '+', '−', '×', '∞', 'spnding', 'business', 'company', 'personal',
  'not', 'except', 'excluding', 'only', 'joint', 'and personal',
  'unrecognized', 'in my Materials', 'in my Business Income',
];
async function pureSymbol(reader, f, q = 'business spending last month') {
  const got = await ask(reader, f, q, 'expense_summary', 'business');
  assert.ok(got.reached.inventory && got.reached.facts && got.reached.disclosure, 'pure money and membership reached');
  assert.equal(got.body.ledger.total_minor, 300);
  assert.deepEqual(masks(got), ['8101', '8102']);
}
async function equalSymbolHead(reader, f, q, category = false, hint = 'business') {
  const kind = category ? 'category' : 'expense_summary', vendor = category ? 'software' : null;
  const head = await ask(base, f, q, kind, hint, vendor);
  const got = await ask(reader, f, q, kind, hint, vendor);
  assert.ok(head.reached.provider || head.reached.inventory, 'HEAD parser or inventory decision reached');
  assert.ok(got.reached.provider || got.reached.inventory, 'candidate parser or inventory decision reached');
  assert.equal(got.text, head.text, `exact HEAD bytes: ${q}`);
  assert.deepEqual(got.reached, head.reached, 'same parser, inventory and money decisions');
}
for (const [mode, reader] of [['default', withLedgerAnswer], ['role-only', fallbackAnswer]]) {
  for (const category of [false, true]) for (const emoji of ['💼', '🚫']) for (const after of [false, true]) {
    test(`${mode} review emoji category=${category} after=${after} ${emoji}`, async t => {
      const f = fixture(t);
      f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
      await pureSymbol(reader, f);
      const core = `business spending${category ? ' on software' : ''}`;
      const q = after ? `${core} last month ${emoji}` : `${core} ${emoji} last month`;
      await equalSymbolHead(reader, f, q, category);
      const admission = boundary.ledgerAccountComplementAdmission(q, category ? categoryIntents : [], context);
      assert.equal(admission.complete, false);
      assert.ok(admission.detected && admission.remainder.length, 'unconsumed-token decision reached');
    });
  }
  for (const category of [false, true]) test(`${mode} review insertion matrix category=${category}`, async t => {
    const f = fixture(t);
    f.raw("UPDATE fin_transactions SET category='software',category_basis_state='confirmed'");
    await pureSymbol(reader, f);
    const seed = category ? 'show me my business accounts spending on software last month' : 'show me my business accounts spending last month';
    const words = seed.split(' '), failures = [];
    let count = 0, controls = 0;
    for (const extra of inserts) for (let position = 0; position <= words.length; position++) for (const hint of [null, 'business']) {
      const parts = [...words]; parts.splice(position, 0, extra); const q = parts.join(' ');
      if (extra === 'from' && words[position] === 'last') {
        const got = await ask(reader, f, q, category ? 'category' : 'expense_summary', hint, category ? 'software' : null);
        assert.ok(got.reached.inventory && got.reached.facts, 'valid period decision reached');
        assert.equal(got.body.ledger.total_minor, 300, 'S5 owner scope survives role-only category fallback');
        controls++; continue;
      }
      count++;
      try {
        await equalSymbolHead(reader, f, q, category, hint);
        const admission = boundary.ledgerAccountComplementAdmission(q, category ? categoryIntents : [], context);
        assert.equal(admission.complete, false);
        assert.ok(admission.remainder.length, 'leftover decision reached');
      } catch (error) { failures.push({ q, hint, reason: error.message.split('\n')[0] }); }
    }
    assert.equal(count, category ? 724 : 592); assert.equal(controls, 2);
    console.log(JSON.stringify({ mode, category, insertion_head_equal: count - failures.length, total: count, controls, failures }));
    assert.deepEqual(failures, [], 'every insertion preserves HEAD bytes and refuses completeness');
  });
  test(`${mode} punctuation controls retain the existing grammar and HEAD behavior`, async t => {
    const f = fixture(t); await pureSymbol(reader, f);
    for (const suffix of ['?', '.', ',', "'"]) {
      const q = `business spending last month${suffix}`;
      assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, true, q);
      await pureSymbol(reader, f, q);
    }
    // This contraction is outside the closed lead grammar. Punctuation must
    // preserve its ordinary answer rather than expand the admitted language.
    await equalSymbolHead(reader, f, "what's my business spending last month?");
    console.log(`${mode}_punctuation_controls=5/5`);
  });
  test(`${mode} attached symbols, compatibility symbols and external hyphens veto purity`, async t => {
    const f = fixture(t); await pureSymbol(reader, f);
    for (const extra of ['💼', '©', '+', '™', '＇', '？', '-', '/', ':', ';', '_', '️', '‍']) {
      for (const q of [`${extra}business spending last month`, `business${extra} spending last month`,
        `business spending ${extra}last month`, `business spending last${extra} month`, `business spending last month${extra}`]) {
        await equalSymbolHead(reader, f, q);
        const admission = boundary.ledgerAccountComplementAdmission(q, [], context);
        assert.equal(admission.complete, false, q);
        assert.ok(admission.remainder.length, 'raw symbol decision reached');
      }
    }
  });
}

test('ISO date hyphens and punctuation stay admitted with symbol residue visible', () => {
  assert.equal(boundary.ledgerAccountComplementAdmission('business-spending last month', [], context).complete, true);
  for (const q of ['business spending ｌａｓｔ ｍｏｎｔｈ', 'business spending since september １, ２０２６']) {
    assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, true, 'permitted words keep compatibility normalization');
  }
  for (const period of ['from 2026-09-01 through 2026-09-30', 'since september 1, 2026']) {
    const q = `business spending ${period}?`;
    assert.equal(boundary.ledgerAccountComplementAdmission(q, [], context).complete, true, q);
    for (const extra of ['💼', '+', '©', '-']) {
      const result = boundary.ledgerAccountComplementAdmission(`${q} ${extra}`, [], context);
      assert.equal(result.complete, false);
      assert.ok(result.detected && result.remainder.includes(extra), 'period residue retained the symbol');
    }
  }
});

test('admitted category literals cannot consume symbols as category punctuation', () => {
  assert.equal(boundary.ledgerAccountComplementAdmission('business spending on software last month', categoryIntents, context).complete, true);
  for (const symbol of ['+', '💼', '©']) {
    const result = boundary.ledgerAccountComplementAdmission(`business spending on software${symbol} last month`,
      [{ ...categoryIntents[0], match: `software${symbol}` }], context);
    assert.equal(result.complete, false);
    assert.ok(result.detected && result.remainder.includes(symbol), 'category-symbol residue decision reached');
  }
});

for (const [mode, reader] of [['default', withLedgerAnswer], ['role-only', fallbackAnswer]]) {
  test(`${mode} calendar atoms cannot consume forbidden punctuation`, async t => {
    const f = fixture(t); await pureSymbol(reader, f);
    for (const q of ['business spending september ’26', 'business spending september ’2026']) {
      await equalSymbolHead(reader, f, q);
      const admission = boundary.ledgerAccountComplementAdmission(q, [], context);
      assert.equal(admission.complete, false);
      assert.ok(admission.detected && admission.remainder.includes('’'), 'calendar symbol decision reached');
    }
  });
}
