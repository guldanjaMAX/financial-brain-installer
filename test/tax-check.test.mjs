import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTaxCheck } from '../worker/src/lib/tax-check.js';
import { TAX_CHECK_CATALOG, evaluateTaxRule } from '../worker/src/lib/tax-check-rules.js';
import { taxFixture, TAX_CASES } from './fixtures/tax-check.mjs';
import { financialCitation } from './fixtures/financial-contract.mjs';
import { financialHash, canonicalFinancialJson, sealFinancialSnapshot } from '../worker/src/lib/financial-snapshot-contract.js';
import { moneyFromDecimal } from '../worker/src/lib/financial-money.js';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../scripts/run-test-chain.mjs';

test('all tax suites are registered without changing the frozen legacy graph', () => {
  for (const path of ['test/tax-check.test.mjs', 'test/tax-pdf.test.mjs', 'test/tax-check-storage.test.mjs']) {
    assert.ok(TEST_COMMANDS.includes(`node --test ${path}`));
    assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(`node --test ${path}`));
  }
});

test('planted oracle and controls reach comparison with exact cited values', async () => {
  const statuses = new Set();
  let detected = 0, falseFindings = 0;
  for (const [rule, , , , , , expected] of TAX_CASES) {
    for (const control of [false, true]) {
      const f = await taxFixture({ rule, control });
      const before = JSON.stringify(f.tax);
      const result = await evaluateTaxCheck({ rule_id: rule, transfer: f.tax }, f.deps);
      assert.ok(result.trace.includes('compare'), `${rule}: ${result.reason}`);
      assert.equal(result.status, control ? 'no_signal' : expected, rule);
      assert.equal(result.financial_authority, false);
      assert.equal(result.source_value.amount_minor, f.tax.metrics[0].value.amount_minor);
      assert.ok(result.citations.length >= 2);
      assert.equal(result.wording, 'Possible miss, review with your preparer');
      assert.doesNotMatch(JSON.stringify(result), /you missed|you owe|you qualify|tax savings|deduct this/i);
      assert.equal(JSON.stringify(f.tax), before);
      statuses.add(result.status);
      if (!control && result.status === expected) detected++;
      if (control && result.status !== 'no_signal') falseFindings++;
    }
  }
  assert.equal(detected, 14); assert.equal(falseFindings, 0); assert.equal(statuses.size, 4);
});

for (const [books, reported, rounding, expected, difference] of [
  ['420.49', '420.00', 'whole_dollar_half_away_from_zero', 'no_signal', '49'],
  ['420.50', '420.00', 'whole_dollar_half_away_from_zero', 'discrepancy', '50'],
  ['-420.49', '-420.00', 'whole_dollar_half_away_from_zero', 'no_signal', '-49'],
  ['-420.50', '-421.00', 'whole_dollar_half_away_from_zero', 'no_signal', '50'],
  ['-420.50', '-420.00', 'whole_dollar_half_away_from_zero', 'discrepancy', '-50'],
  ['0.49', '0.00', 'whole_dollar_half_away_from_zero', 'no_signal', '49'],
  ['-0.49', '0.00', 'whole_dollar_half_away_from_zero', 'no_signal', '-49'],
  ['0.50', '0.00', 'whole_dollar_half_away_from_zero', 'discrepancy', '50'],
  ['9007199254740993.01', '9007199254740993.00', 'exact', 'discrepancy', '1'],
  ['420.00', '420.01', 'exact', 'discrepancy', '-1'],
]) test(`exact comparison ${books} / ${reported} / ${rounding}`, async () => {
  const f = await taxFixture({ rule: 'T09', books, reported, rounding });
  const result = await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps);
  assert.ok(result.trace.includes('compare'), result.reason);
  assert.equal(result.status, expected); assert.equal(result.difference.amount_minor, difference);
  assert.equal(result.transfer.comparison, result.comparison);
});

async function replaceSnapshot(f, side, change) {
  const original = side === 'source' ? f.source : f.target;
  const copy = structuredClone(original); change(copy);
  const next = await sealFinancialSnapshot(copy);
  f.snapshots.set(next.snapshot_id, next);
  if (side === 'source') {
    f.source = next; f.tax.metrics[0].citation = financialCitation(next);
    f.tax.metrics[0].value = next.rows[0].cells[0].money;
    f.tax.report_snapshot_refs[0].content_hash = next.content_hash;
  } else {
    f.target = next; f.tax.tax_line.citation = financialCitation(next);
  }
}
const perturbations = [
  ['private identifier in scope', f => { f.tax.books_run_ref = ['999', '88', '7777'].join('-'); }, 'privacy'],
  ['private account in coverage reason', f => { f.tax.coverage.reason = 'account: ' + ['1234', '5678', '9012'].join(''); }, 'privacy'],
  ['wrong filer role', f => { f.tax.tax_line.filer_role = 'recipient'; }, 'extraction'],
  ['wrong filing unit', f => { f.tax.tax_line.filing_unit_ref = 'filing_unit_02'; }, 'extraction'],
  ['one-sided identifier whitespace', f => { f.tax.tax_line.entity_ref += ' '; }, 'extraction'],
  ['wrong year', f => { f.tax.tax_line.tax_year = 2024; }, 'extraction'],
  ['wrong period', f => { f.tax.tax_line.period.end = '2025-11-30'; }, 'extraction'],
  ['wrong basis', f => { f.tax.tax_line.basis = 'cash'; }, 'extraction'],
  ['wrong jurisdiction', f => { f.tax.tax_line.jurisdiction = 'state_unreviewed'; }, 'extraction'],
  ['1065 is not a recipient K-1', f => { f.tax.tax_line.form = '1065'; }, 'mapping'],
  ['superseded return', f => { f.tax.tax_line.return_state = 'superseded'; }, 'extraction'],
  ['unconfirmed candidate', f => { f.tax.tax_line.extraction = 'candidate'; }, 'extraction'],
  ['field receipt future', f => { f.fieldReview.confirmed_at = '2027-01-01T00:00:00.000Z'; }, 'extraction'],
  ['missing source citation', f => { f.tax.metrics[0].citation.source_doc_ref = 'missing_document'; }, 'citations'],
  ['unknown rounding', f => { f.tax.tax_line.rounding = 'unknown'; }, 'mapping'],
  ['unresolved books finding', f => { f.tax.open_finding_refs.push('finding_open'); }, 'coverage'],
  ['unresolved treatment', f => { f.review.treatment = 'unresolved'; }, 'coverage'],
  ['missing map', f => { f.deps.readMapping = async () => null; }, 'mapping'],
  ['source tenant mismatch', f => replaceSnapshot(f, 'source', s => { s.scope.tenant = 'other_tenant'; }), 'citations'],
  ['return partial coverage', f => replaceSnapshot(f, 'target', s => { s.coverage.state = 'partial'; }), 'citations'],
  ['source observed at another time', f => replaceSnapshot(f, 'source', s => { s.observed_at = s.requested_at = s.provider_generated_at = '2026-10-06T15:00:00.000Z'; }), 'citations'],
  ['overlapping return root', f => replaceSnapshot(f, 'target', s => { s.lineage.kind = 'derived_record'; s.lineage.root_ids = [...f.source.lineage.root_ids]; }), 'citations'],
  ['over 16 actual roots', async f => {
    await replaceSnapshot(f, 'source', s => { s.lineage.kind = 'derived_record'; s.lineage.root_ids = Array.from({ length: 16 }, (_, i) => `root_${i}`); });
  }, 'lineage'],
  ['duplicated bridge operand', f => {
    f.tax.bridge_adjustments.push({ ...f.tax.metrics[0], mapping_ref: f.tax.mapping_version });
  }, 'citations'],
];
for (const [label, mutate, stage] of perturbations) test(`refusal with green control: ${label}`, async () => {
  const f = await taxFixture();
  assert.equal((await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps)).status, 'possible_miss');
  await mutate(f); await f.rebind();
  if (f.fieldReview) f.fieldReview.line_hash = await financialHash(canonicalFinancialJson(f.tax.tax_line));
  const result = await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps);
  assert.equal(result.status, 'not_checked', result.reason); assert.ok(result.trace.includes(stage), result.trace.join(','));
  assert.equal(result.source_value, null); assert.equal(result.citations.length, 0);
});

test('corrected operative version and a reviewed adjustment are compared once', async () => {
  const f = await taxFixture({ rule: 'T09', books: '420.00', reported: '400.00' });
  f.tax.tax_line.return_state = 'amended';
  const adjustment = structuredClone(f.source);
  adjustment.snapshot_id = 'adjustment_snapshot'; adjustment.source_document_ref = 'adjustment_document';
  adjustment.source_id = 'adjustment_source'; adjustment.source_family = 'adjustment_family';
  adjustment.lineage.root_ids = ['adjustment_document']; adjustment.lineage.source_families = ['adjustment_family'];
  adjustment.rows[0].cells[0].money = moneyFromDecimal('-20.00', 'USD');
  adjustment.rows[0].cells[0].raw_text = '-20.00';
  const sealed = await sealFinancialSnapshot(adjustment); f.snapshots.set(sealed.snapshot_id, sealed);
  f.tax.report_snapshot_refs.push({ snapshot_id: sealed.snapshot_id, content_hash: sealed.content_hash });
  f.tax.bridge_adjustments.push({ measure: 'gross_receipts', value: sealed.rows[0].cells[0].money,
    citation: financialCitation(sealed), mapping_ref: f.mapping.version });
  await f.rebind(); f.fieldReview.line_hash = await financialHash(canonicalFinancialJson(f.tax.tax_line));
  const result = await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps);
  assert.ok(result.trace.includes('compare'), result.reason); assert.equal(result.status, 'no_signal');
  assert.equal(result.source_value.amount_minor, '40000'); assert.equal(result.citations.length, 3);
});

for (const broken of ['overlap', 'fence']) test(`adjustment ${broken} cannot create a second amount`, async () => {
    const f = await taxFixture({ rule: 'T09' });
    const copy = structuredClone(f.source);
    copy.snapshot_id = 'adjustment_snapshot'; copy.source_id = 'adjustment_source'; copy.source_document_ref = 'adjustment_document';
    copy.source_family = 'adjustment_family';
    copy.lineage = { kind: 'derived_record', root_ids: ['adjustment_document'], source_families: ['adjustment_family'] };
    async function attach(snapshot) {
      const sealed = await sealFinancialSnapshot(snapshot);
      f.snapshots.set(sealed.snapshot_id, sealed);
      f.tax.report_snapshot_refs = [f.tax.report_snapshot_refs[0], { snapshot_id: sealed.snapshot_id, content_hash: sealed.content_hash }];
      f.tax.bridge_adjustments = [{ measure: 'gross_receipts', value: sealed.rows[0].cells[0].money,
        citation: financialCitation(sealed), mapping_ref: f.mapping.version }];
      await f.rebind();
    }
    await attach(copy);
    assert.equal((await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps)).status, 'discrepancy');
    if (broken === 'overlap') copy.lineage.root_ids = [...f.source.lineage.root_ids];
    else copy.coverage.mutation_check = { state: 'not_supported', method: 'unavailable', before: null, after: null };
    await attach(copy);
    const result = await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps);
    assert.equal(result.status, 'not_checked'); assert.ok(result.trace.includes('lineage'));
});

test('larger return and linked alternatives do not create missing-item allegations', async () => {
  const interest = await taxFixture({ reported: '900.00' });
  assert.equal((await evaluateTaxCheck({ rule_id: interest.rule, transfer: interest.tax }, interest.deps)).status, 'no_signal');
  for (const rule of ['T12', 'T13', 'T14', 'T15', 'T16', 'T17', 'T19', 'T22']) {
    const f = await taxFixture({ rule }); f.review.treatment = 'linked';
    const result = await evaluateTaxCheck({ rule_id: rule, transfer: f.tax }, f.deps);
    assert.ok(result.trace.includes('compare')); assert.equal(result.status, 'no_signal');
    assert.equal(result.difference, null);
  }
});

test('catalog shows all 32 families and refuses unsupported rules at the catalog gate', async () => {
  assert.equal(TAX_CHECK_CATALOG.length, 32);
  const f = await taxFixture();
  for (const rule of TAX_CHECK_CATALOG.filter(item => !item.implemented)) {
    const result = evaluateTaxRule(rule.rule_id, f.tax);
    assert.equal(result.status, 'not_checked'); assert.ok(result.trace.includes('catalog'));
  }
  assert.equal((await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps)).status, 'possible_miss');
});

test('binding, access and completeness refusals have nonempty green siblings', async () => {
  const cases = [
    ['binding', f => { f.tax.metrics[0].value.amount_minor = '1'; }, 'contract'],
    ['unconfirmed', f => { f.review.authenticated = false; }, 'confirmation'],
    ['stale receipt', f => { f.review.binding_hash = '0'.repeat(64); }, 'confirmation'],
    ['access', f => { f.state.denied = true; }, 'citations'],
    ['stale source', f => { f.state.current = false; }, 'citations'],
    ['map drift', f => { f.state.mapHead = 'map_02'; }, 'scope'],
    ['partial source', f => { f.review.source_inventory = 'partial'; }, 'coverage'],
    ['partial return', f => { f.review.return_inventory = 'search_top_k'; }, 'coverage'],
    ['unresolved correction', f => { f.review.corrections_reviewed = false; }, 'coverage'],
    ['unresolved routing', f => { f.review.allocations_reviewed = false; }, 'coverage'],
    ['unreviewed map', f => { f.mapping.reviewed = false; }, 'mapping'],
    ['stale document', f => { f.state.documentHash = 'c'.repeat(64); }, 'extraction'],
    ['forged OCR approval', f => { f.fieldReview.confirmation = 'reliable_mapped_native'; }, 'extraction'],
  ];
  for (const [label, mutate, stage] of cases) {
    const f = await taxFixture();
    assert.equal((await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps)).status, 'possible_miss');
    mutate(f);
    const result = await evaluateTaxCheck({ rule_id: f.rule, transfer: f.tax }, f.deps);
    assert.equal(result.status, 'not_checked', label);
    assert.ok(result.trace.includes(stage), `${label}: ${result.trace}`);
    assert.equal(result.source_value, null); assert.equal(result.citations.length, 0);
  }
});
