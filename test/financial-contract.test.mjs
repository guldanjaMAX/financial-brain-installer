import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinancialContract, sealFinancialSnapshot, normalizeFinancialReportCell } from '../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromDecimal, sumMoney, moneyToSafeInteger } from '../worker/src/lib/financial-money.js';
import { verifyFinancialAnswerPlan } from '../worker/src/lib/financial-answer-plan.js';
import { financialFixtures, invalidFinancialFixtures, financialTaxComparison, financialReportFixture, financialCitation } from './fixtures/financial-contract.mjs';

test('closed versioned cross-lane contracts have positive and reached negative controls', async () => {
  const valid = await financialFixtures();
  for (const [kind, value] of Object.entries(valid.contracts)) {
    assert.equal(validateFinancialContract(kind, value).ok, true, kind);
    const changed = structuredClone(value);
    changed.unreviewed_field = true;
    const result = validateFinancialContract(kind, changed);
    assert.ok(result.checked > 0, kind);
    assert.equal(result.ok, false, kind);
    assert.equal(result.errors[0].code, 'closed_object', kind);
  }
  for (const { kind, value, code } of await invalidFinancialFixtures()) {
    const result = validateFinancialContract(kind, value);
    assert.ok(result.checked > 0, code);
    assert.equal(result.ok, false, code);
    assert.ok(result.errors.some(error => error.code === code), JSON.stringify(result));
  }
});

test('exact decimal money, precision, currency, negative zero and safe storage boundaries', () => {
  assert.equal(moneyFromDecimal('0.10', 'USD').amount_minor, '10');
  assert.equal(sumMoney([moneyFromDecimal('0.10', 'USD'), moneyFromDecimal('0.20', 'USD')]).amount_minor, '30');
  assert.equal(moneyFromDecimal('-0.00', 'USD').decimal, '-0.00');
  assert.equal(moneyFromDecimal('-0.00', 'USD').amount_minor, '0');
  assert.equal(moneyFromDecimal('12', 'JPY').amount_minor, '12');
  assert.equal(moneyFromDecimal('1.001', 'KWD').amount_minor, '1001');
  assert.equal(moneyFromDecimal('-0.001', 'USD').precision, 'unrepresentable');
  assert.equal(moneyFromDecimal('-0.001', 'USD').amount_minor, null);
  for (const input of [0.1, '1e2', '1,000.00', '(12.00)', ' 12.00']) {
    assert.throws(() => moneyFromDecimal(input, 'USD'), { code: 'money_decimal' });
  }
  assert.throws(() => moneyFromDecimal('1', 'ZZZ'), { code: 'money_currency' });
  assert.throws(() => sumMoney([moneyFromDecimal('1', 'USD'), moneyFromDecimal('1', 'EUR')]), { code: 'mixed_currency' });
  assert.throws(() => sumMoney([moneyFromDecimal('0.001', 'USD')]), { code: 'money_precision' });
  assert.throws(() => sumMoney([]), { code: 'empty_sum' });
  assert.equal(moneyToSafeInteger(moneyFromDecimal('1', 'USD')), 100);
  assert.throws(() => moneyToSafeInteger(moneyFromDecimal('90071992547409.92', 'USD')), { code: 'money_overflow' });
});

test('answer proof recomputes every claim from exact authorized snapshot coordinates', async () => {
  const { snapshot, answer } = await financialFixtures();
  const calls = [];
  const resolve = async citation => { calls.push(citation); return snapshot; };
  const good = await verifyFinancialAnswerPlan(answer, { resolveSnapshot: resolve });
  assert.equal(good.ok, true);
  assert.match(good.text, /USD 3700\.00/);
  assert.ok(calls.length > 0);
  const bad = structuredClone(answer);
  bad.claims[0].value = moneyFromDecimal('3700.01', 'USD');
  const wrong = await verifyFinancialAnswerPlan(bad, { resolveSnapshot: resolve });
  assert.equal(wrong.ok, false);
  assert.ok(wrong.trace.includes('arithmetic'));
  assert.equal(wrong.reason, 'claim_mismatch');
  assert.equal(wrong.text, undefined);
  const partial = structuredClone(snapshot);
  partial.coverage.state = 'partial';
  partial.coverage.reason = 'missing_page';
  const sealedPartial = await sealFinancialSnapshot(partial);
  const limited = structuredClone(answer);
  limited.claims[0].operands[0].content_hash = sealedPartial.content_hash;
  const refused = await verifyFinancialAnswerPlan(limited, { resolveSnapshot: async () => sealedPartial });
  assert.equal(refused.ok, false);
  assert.ok(refused.trace.includes('coverage'));
  assert.equal(refused.reason, 'coverage_incomplete');
  limited.claims[0].qualification = 'partial_individual_fact';
  assert.equal((await verifyFinancialAnswerPlan(limited, { resolveSnapshot: async () => sealedPartial })).ok, true);
});

test('complete R1 cannot omit echoed reporting scope or detail cells', async () => {
  const { snapshot } = await financialFixtures();
  assert.equal(validateFinancialContract('snapshot', snapshot).ok, true);
  const missingEcho = structuredClone(snapshot);
  missingEcho.scope.report_parameters = missingEcho.scope.report_parameters.filter(parameter => parameter.name !== 'basis');
  missingEcho.coverage.parameters = missingEcho.scope.report_parameters;
  const result = validateFinancialContract('snapshot', missingEcho);
  assert.ok(result.checked > 0);
  assert.ok(result.errors.some(error => error.code === 'report_scope_unproved'));
  const missingCell = structuredClone(snapshot);
  missingCell.rows[0].cells = [];
  const cellResult = validateFinancialContract('snapshot', missingCell);
  assert.ok(cellResult.checked > 0);
  assert.ok(cellResult.errors.some(error => error.code === 'row_cells_missing'));
});

test('normalization preserves blanks, nonmoney and explicitly reviewed parentheses', () => {
  const input = { column_key: 'amount', raw_path: '/Rows/0/0', raw_text: '12.00', kind: 'money', state: 'value', role: 'asset', currency: 'USD' };
  assert.equal(normalizeFinancialReportCell(input).money.amount_minor, '1200');
  assert.throws(() => normalizeFinancialReportCell({ ...input, raw_text: '(12.00)' }), { code: 'money_decimal' });
  const negative = normalizeFinancialReportCell({ ...input, raw_text: '(12.00)', format: 'accounting_parentheses' });
  assert.equal(negative.money.amount_minor, '-1200'); assert.equal(negative.raw_text, '(12.00)');
  assert.equal(normalizeFinancialReportCell({ ...input, raw_text: '', state: 'blank' }).money, null);
  assert.throws(() => normalizeFinancialReportCell({ ...input, state: 'blank' }), { code: 'blank_value' });
  assert.equal(normalizeFinancialReportCell({ ...input, kind: 'percentage', raw_text: '12.00' }).money, null);
  assert.equal(normalizeFinancialReportCell({ ...input, kind: 'text', raw_text: '12.00' }).text, '12.00');
});

test('T1 supports only exact reviewed scope and signed, explicit rounding', async () => {
  const good = await financialTaxComparison();
  assert.equal(validateFinancialContract('tax', good).ok, true);
  for (const [name, mutate] of [
    ['period', v => { v.tax_line.period.end = '2025-02-28'; }],
    ['basis', v => { v.tax_line.basis = 'cash'; }],
    ['filing unit', v => { v.tax_line.filing_unit_ref = 'filing_unit_02'; }],
    ['filer role', v => { v.tax_line.filer_role = 'recipient'; }],
    ['form state', v => { v.tax_line.return_state = 'superseded'; }],
    ['authority', v => { v.confirmation = null; }],
    ['precision', v => { v.tax_line.rounding = 'unknown'; }],
  ]) {
    const bad = structuredClone(good); mutate(bad);
    const result = validateFinancialContract('tax', bad);
    assert.ok(result.checked > 0, name); assert.equal(result.ok, false, name);
  }
  for (const [books, reported, comparison] of [
    ['3700.49', '3700.00', 'consistent_with_reported_precision'],
    ['3700.50', '3700.00', 'candidate'],
    ['-3700.49', '-3700.00', 'consistent_with_reported_precision'],
    ['-3700.50', '-3700.00', 'candidate'],
  ]) {
    const rounded = await financialTaxComparison({ books, reported, comparison, rounding: 'whole_dollar_half_away_from_zero' });
    assert.equal(validateFinancialContract('tax', rounded).ok, true, books);
    rounded.comparison = comparison === 'candidate' ? 'consistent_with_reported_precision' : 'candidate';
    const result = validateFinancialContract('tax', rounded);
    assert.ok(result.checked > 0); assert.equal(result.ok, false, books);
  }
});

test('R1 row denominators, duplicate labels, 17+ records and currency exponents stay explicit', async () => {
  for (const count of [0, 1, 17, 1001]) {
    const { snapshot } = await financialReportFixture({ count, duplicateLabels: true });
    assert.equal(validateFinancialContract('snapshot', snapshot).ok, true);
    assert.equal(snapshot.rows[0].cells[0].money.amount_minor, String(count * 100));
    assert.equal(snapshot.coverage.received_rows, count + 1);
    assert.equal(snapshot.lineage.root_ids.length, 1);
    if (count > 1) {
      assert.equal(snapshot.rows[1].label, snapshot.rows[2].label);
      assert.notEqual(snapshot.rows[1].group_ref.id, snapshot.rows[2].group_ref.id);
    }
    const truncated = structuredClone(snapshot); truncated.rows.pop();
    const result = validateFinancialContract('snapshot', truncated);
    assert.ok(result.checked > 0); assert.equal(result.ok, false);
  }
  for (const [currency, expected] of [['JPY', '17'], ['KWD', '17000']]) {
    const { snapshot } = await financialReportFixture({ currency });
    assert.equal(snapshot.rows[0].cells[0].money.amount_minor, expected);
    assert.equal(validateFinancialContract('snapshot', snapshot).ok, true);
  }
});

test('bounded sums prove their entire additive set and refuse subtotal double counting', async () => {
  const { snapshot } = await financialReportFixture({ count: 2 });
  const { answer } = await financialFixtures();
  answer.claims[0].operation = 'sum';
  answer.claims[0].operands = snapshot.rows.slice(1).map(row => financialCitation(snapshot, row));
  answer.claims[0].additive_set_ref = financialCitation(snapshot);
  answer.claims[0].value = moneyFromDecimal('2.00', 'USD');
  const resolveSnapshot = async () => snapshot;
  assert.equal((await verifyFinancialAnswerPlan(answer, { resolveSnapshot })).ok, true);
  for (const mutate of [
    value => { value.claims[0].operands.pop(); },
    value => { value.claims[0].operands.push(financialCitation(snapshot)); },
    value => { value.claims[0].operands.push(value.claims[0].operands[0]); },
    value => { value.claims[0].operands[0].row_path = '/Rows/unknown'; },
    value => { value.scope.basis = 'cash'; },
  ]) {
    const bad = structuredClone(answer); mutate(bad);
    const result = await verifyFinancialAnswerPlan(bad, { resolveSnapshot });
    assert.ok(result.trace.includes('access')); assert.equal(result.ok, false);
  }
});

test('B1 cannot label a measured discrepancy clear or invent an absent-side citation', async () => {
  const { finding } = await financialFixtures();
  assert.equal(validateFinancialContract('finding', finding).ok, true);
  const discrepancy = structuredClone(finding);
  discrepancy.left.value = moneyFromDecimal('3700.01', 'USD');
  discrepancy.difference = moneyFromDecimal('0.01', 'USD');
  const result = validateFinancialContract('finding', discrepancy);
  assert.ok(result.checked > 0); assert.equal(result.ok, false);
  discrepancy.status = 'finding'; discrepancy.outcome = 'candidate'; discrepancy.severity = 'major';
  assert.equal(validateFinancialContract('finding', discrepancy).ok, true);
  const absent = structuredClone(finding); absent.right.state = 'absent';
  const absenceResult = validateFinancialContract('finding', absent);
  assert.ok(absenceResult.checked > 0); assert.equal(absenceResult.ok, false);
});

test('unknown scope and fabricated no-data totals cannot become monetary answers', async () => {
  const { answer } = await financialFixtures();
  assert.equal(validateFinancialContract('answer', answer).ok, true);
  answer.scope.entity_ref = null;
  const result = validateFinancialContract('answer', answer);
  assert.ok(result.checked > 0); assert.equal(result.ok, false);
  const { snapshot } = await financialReportFixture({ count: 0 });
  assert.equal(validateFinancialContract('snapshot', snapshot).ok, true);
  snapshot.rows[0].cells[0].money = moneyFromDecimal('1.00', 'USD');
  const noData = validateFinancialContract('snapshot', snapshot);
  assert.ok(noData.checked > 0); assert.equal(noData.ok, false);
});

test('complete coverage binds individual page identities, hashes and measured counts', async () => {
  const { contracts: { coverage } } = await financialFixtures();
  assert.equal(validateFinancialContract('coverage', coverage).ok, true);
  const duplicate = structuredClone(coverage);
  duplicate.pages = [structuredClone(coverage.pages[0]), structuredClone(coverage.pages[0])];
  duplicate.expected_pages = duplicate.received_pages = 2;
  duplicate.expected_rows = duplicate.received_rows = 2;
  duplicate.byte_count *= 2;
  const result = validateFinancialContract('coverage', duplicate);
  assert.ok(result.checked > 0); assert.equal(result.ok, false);
  for (const mutate of [
    value => { value.pages[0].row_count++; },
    value => { value.pages[0].byte_count++; },
    value => { value.pages[0].parse_state = 'failed'; },
  ]) {
    const bad = structuredClone(coverage); mutate(bad);
    const refused = validateFinancialContract('coverage', bad);
    assert.ok(refused.checked > 0); assert.equal(refused.ok, false);
  }
});

test('a normalized money cell cannot disagree with its retained decimal display', async () => {
  const { snapshot } = await financialFixtures();
  assert.equal(validateFinancialContract('snapshot', snapshot).ok, true);
  snapshot.rows[0].cells[0].raw_text = '3700.01';
  const result = validateFinancialContract('snapshot', snapshot);
  assert.ok(result.checked > 0);
  assert.ok(result.errors.some(error => error.code === 'cell_decimal_mismatch'));
});
