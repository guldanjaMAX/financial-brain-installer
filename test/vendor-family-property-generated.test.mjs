import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { replay } from '../eval/fast-loop/money-replay.mjs';
import { total, displayFigures } from '../eval/fast-loop/money-oracle.mjs';
import { BASE_CASES, evidence } from './fixtures/fastloop-money/input.mjs';

// Fixed seeds exercise identity independently of generator ownership labels.
const seeds = [1104, 426, 20261102];
const products = ['Cloud', 'Workspace', 'Media', 'Tools'];
function generate() {
  return seeds.flatMap(seed => {
    let state = seed;
    const next = n => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) % n);
    return Array.from({ length: 200 }, (_, index) => {
      const brand = ['Vendorwave', 'Cedarstone', 'North Meadow', 'Aster'][next(4)];
      const style = index % 5;
      const snapshot = evidence();
      Object.assign(snapshot.accounts[2], { kind: 'card', role: 'liability', label: 'Purchase card' });
      const rows = [];
      const add = (payee, family, extra = {}) => rows.push({ id: rows.length + 1,
        uid: `generated-${rows.length + 1}`, account: next(2) ? 'cash' : 'debt',
        date: index % 2 ? '2026-10-05' : '2026-09-05', cents: String(1 + next(99999)), direction: 'outflow',
        description: 'Card purchase', pending: 0, payee, family, ...extra });
      for (let p = 0, count = 1 + index % 4; p < count; p++) {
        let payee = `${brand} ${products[p]}`;
        if (style === 1) payee = `PROCESSOR * ${payee}`;
        if (style === 2) payee = `${payee.toUpperCase()} #${next(100)} Mesa`;
        if (style === 3 && p === 0) payee = brand;
        add(payee, true);
      }
      // Ownership is generator metadata; it is never inferred by product code.
      add(style === 4 ? `${brand} Cafe` : `Other ${brand.split(' ').at(-1)} Cafe`, false);
      add(rows[0].payee, true, { direction: 'inflow', description: 'Refund' });
      add(rows[0].payee, true, { date: index % 2 ? '2026-09-30' : '2026-08-31' });
      add(rows[0].payee, true, { date: index % 2 ? '2026-11-01' : '2026-10-01' });
      const period = index % 2 ? { from: '2026-10-01', to: '2026-10-31', phrase: 'in October 2026' }
        : { from: '2026-09-01', to: '2026-09-30', phrase: 'in September 2026' };
      snapshot.rows = rows;
      return { ...BASE_CASES[0], id: `generated/${seed}/${index}`, base: false,
        family: 'generated-vendor', brand, style, snapshot,
        clock: { now_utc: '2026-11-02T19:00:00Z', owner_time_zone: 'America/Phoenix' },
        period: { rule: 'explicit inclusive date window', from: period.from, to: period.to },
        question: `How much did I spend at ${brand} ${period.phrase}?` };
    });
  });
}
function run(cases, sourceOverrides = {}) {
  const observations = [];
  for (let i = 0; i < cases.length; i += 100) {
    const result = replay({ cases: cases.slice(i, i + 100), snapshotFor: c => c.snapshot, sourceOverrides });
    assert.equal(result.provider_calls, 0);
    assert.equal(result.production_writes, 0);
    observations.push(...result.observations);
  }
  return observations;
}
function review(c, o) {
  assert.equal(o.execution_status, 'complete');
  assert.equal(o.body.ledger?.kind, 'merchant', c.id);
  assert.ok(o.trace.dependencies.includes('transactions'));
  const l = o.body.ledger;
  assert.deepEqual([l.from, l.to], [c.period.from, c.period.to]);
  const eligible = c.snapshot.rows.filter(r => r.direction === 'outflow' && !r.pending &&
    r.date >= c.period.from && r.date <= c.period.to);
  const clean = payee => payee.toLowerCase().replace(/^processor\s*\*\s*/, '').replace(/[^\p{L}\p{N}&]+/gu, ' ').trim();
  const exact = eligible.filter(r => clean(r.payee) === clean(c.brand));
  const names = eligible.filter(r => clean(r.payee).startsWith(clean(c.brand) + ' '));
  const expected = total(exact.map(r => r.cents));
  const mentions = eligible.filter(r => !exact.includes(r) && !names.includes(r) &&
    (` ${clean(r.payee || r.description)} `).includes(` ${clean(c.brand)} `));
  const complete = l.complete === true && o.body.evidence_gate.complete === true;
  const wrong = complete && (names.length > 0 || String(l.total_minor) !== expected);
  const included = l.included_payees || [];
  const namedPartial = !complete && names.length > 0 && names.every(r => o.body.answer.toLowerCase().includes(r.payee.toLowerCase()));
  if (names.length) {
    assert.equal(l.complete, false, 'name-match subtotal marked complete');
    assert.equal(o.body.evidence_gate.complete, false);
    assert.equal(l.total_minor, null);
    const exactExpected = expected === '0' && mentions.length ? 'null' : expected;
    assert.equal(String(l.exact_subtotal_minor), exactExpected, 'prefix member counted as certified');
    if (exactExpected === 'null') {
      assert.equal(l.attribution_incomplete, true);
      assert.doesNotMatch(o.body.answer, /\$0\.00|No spending|No charges/i);
    }
    assert.equal(String(l.name_match_subtotal_minor), total(names.map(r => r.cents)));
    assert.equal(l.if_own_transfers.total_minor, null);
    assert.equal(l.if_own_transfers.complete, false);
    for (const payee of new Set([...exact, ...names].map(r => r.payee))) {
      const group = l.groups.find(g => g.merchant === payee);
      assert.ok(group, 'each displayed payee has its own amount');
      assert.equal(String(group.total_minor), total(eligible.filter(r => r.payee === payee).map(r => r.cents)));
      assert.equal(total(group.citations.map(n => String(o.body.citations[n - 1].amount_minor))), String(group.total_minor));
    }
    assert.match(o.body.answer, /matched by name.*not confirmed/i);
    assert.match(o.body.answer, /same company\?/i);
    assert.ok(!o.body.receipt && !l.receipt);
  } else if (exact.length) {
    assert.equal(l.name_match_subtotal_minor, undefined, 'exact payee demoted to name-match');
    assert.equal(String(l.total_minor ?? l.exact_subtotal_minor), expected);
  }
  const refusal = eligible.some(r => r.family) && !complete && !namedPartial;
  if (complete) assert.equal(displayFigures(o.body.answer)[0]?.cents, String(l.total_minor));
  return { reason: wrong ? 'wrong-certified-total' : refusal ? 'refusal' : null, wrong, refusal, expected,
    actual: l.total_minor ?? null, complete, included };
}

const signature = (c, o) => {
  const l = o.body.ledger;
  return JSON.stringify([l.complete, l.total_minor, l.exact_subtotal_minor, l.family_subtotal_minor,
    l.partial_subtotal_minor, l.name_match_subtotal_minor, l.match_basis,
    l.groups?.map(g => [g.total_minor, g.count]), o.body.citations.map(r => r.ref)]);
};
function rename(c) {
  // Brand identity is opaque: renaming may cross the product's length guard.
  const replacement = 'Silverplain';
  const change = s => s.replaceAll(c.brand, replacement).replaceAll(c.brand.toUpperCase(), replacement.toUpperCase());
  return { ...c, id: `${c.id}/rename`, brand: replacement, question: change(c.question),
    snapshot: { ...c.snapshot, rows: c.snapshot.rows.map(r => ({ ...r, payee: change(r.payee) })) } };
}
function unrelated(c) {
  return { ...c, id: `${c.id}/unrelated`, snapshot: { ...c.snapshot, rows: [...c.snapshot.rows,
    { ...c.snapshot.rows[0], id: 999, uid: 'unrelated', payee: 'Unrelated Market', family: false }] } };
}

const transforms = { rename, unrelated };

// A number is not a boundary after which arbitrary business words disappear.
// Include the review's one-cent witness and fresh bidirectional siblings, each
// paired with an identical-selector control whose complete amount is known.
function numberedCases() {
  return [7193, 88817, 20261105].flatMap(seed =>
    ['Quartzfin', `Amberbrook${seed}`, `West Orchard${seed}`, `Ibis${seed}`].flatMap(brand =>
      ['Bakery', 'Bistro', 'Repair Works', 'North Harbor'].flatMap((word, i) => {
        const numbered = `${brand} #${i + 1} ${word}`;
        const make = (selector, payees, amounts, exact, names) => {
          const snapshot = evidence();
          snapshot.rows = payees.map((payee, n) => ({ id: n + 1, uid: `numbered-${n}`,
            account: 'cash', date: '2026-10-05', cents: String(amounts[n]),
            direction: 'outflow', description: 'Card purchase', pending: 0, payee }));
          return { ...BASE_CASES[0], id: `numbered/${seed}/${numbered}/${selector}/${payees.join('|')}`, base: false,
            snapshot, brand: selector, expectedExact: exact, expectedNames: names,
            question: `How much did I spend at ${selector} in October 2026?` };
        };
        return [make(numbered, [brand], [1], null, null),
          make(brand, [brand, numbered], [101, 203], 101, 203),
          make(numbered, [numbered], [101], 101, null),
          make(brand, [brand], [101], 101, null)];
      })));
}
function checkNumbered(c, o) {
  assert.equal(o.execution_status, 'complete');
  const l = o.body.ledger;
  if (c.expectedExact === null) {
    assert.equal(l.total_minor, null, c.id);
    assert.equal(l.complete, false, c.id);
    assert.equal(o.body.evidence_gate.complete, false);
  } else if (c.expectedNames !== null) {
    assert.equal(l.exact_subtotal_minor, c.expectedExact, c.id);
    assert.equal(l.name_match_subtotal_minor, c.expectedNames, c.id);
    assert.equal(l.total_minor, null);
    assert.equal(l.complete, false);
    assert.equal(o.body.evidence_gate.complete, false);
    assert.match(o.body.answer, /matched by name.*not confirmed/i);
    assert.ok(!o.body.receipt && !l.receipt);
  } else {
    assert.equal(l.total_minor, c.expectedExact, c.id);
    assert.equal(l.complete, true, c.id);
    assert.equal(o.body.evidence_gate.complete, true);
  }
}
for (const direction of ['requested-numbered', 'payee-numbered', 'exact-controls'])
test(`numbered business identities: ${direction}`, () => {
  const cases = numberedCases().filter(c => direction === 'requested-numbered' ? c.expectedExact === null
    : direction === 'payee-numbered' ? c.expectedNames !== null : c.expectedExact !== null && c.expectedNames === null);
  const observations = run(cases);
  cases.forEach((c, i) => checkNumbered(c, observations[i]));
  console.log(`numbered_cases=${cases.length} wrong_figures=0`);
});

const analysis = readFileSync(new URL('../worker/src/lib/ledger-analysis.js', import.meta.url), 'utf8');
for (const [name, from, to, direction] of [
  ['requested identity shortened', 'const wanted = normalizeMerchantText(query);',
    "const wanted = normalizeMerchantText(query.replace(/\\s*#\\d+.*$/, ''));", 'requested'],
  ['words after number erased', '.replace(/\\s+#\\d+$/u,',
    '.replace(/\\s*#\\d+(?:\\s+[\\p{L} .-]+)?$/u,', 'payee'],
]) test(`kills ${name}`, () => {
  assert.equal(analysis.split(from).length - 1, 1);
  const cases = numberedCases().filter(c => direction === 'requested' ? c.expectedExact === null : c.expectedNames !== null).slice(0, 4);
  run(cases).forEach((o, i) => checkNumbered(cases[i], o));
  const broken = run(cases, { 'ledger-analysis.js': analysis.replace(from, to) });
  assert.throws(() => broken.forEach((o, i) => checkNumbered(cases[i], o)), { name: 'AssertionError' });
});
test('600 seeded ledgers certify exact identity and disclose name-only amounts', () => {
  const cases = generate(), observations = run(cases);
  let wrong = 0, refusals = 0;
  for (const [name, transform] of [['original', c => c], ...Object.entries(transforms)]) {
    const variants = cases.map(transform), altered = name === 'original' ? observations : run(variants);
    variants.forEach((c, i) => {
      const result = review(c, altered[i]); wrong += Number(result.wrong); refusals += Number(result.refusal);
      if (name !== 'original') assert.equal(signature(cases[i], observations[i]), signature(c, altered[i]), name);
    });
  }
  console.log('cases=1800 wrong_figures=' + wrong + ' refusals=' + refusals + ' metamorphic_checks=1200');
  assert.equal(wrong, 0); assert.ok(refusals <= 540);
});
