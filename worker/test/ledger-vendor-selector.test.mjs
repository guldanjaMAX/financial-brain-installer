import { absenceLintText } from './fixtures/plain-copy-expectations.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { reachedAnswer } from './ledger-production-fixture.mjs';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { cases, snapshotFor } from '../../eval/fast-loop/vendor-family-cases.mjs';
import { reviewVendorFamily } from '../../eval/fast-loop/vendor-family-key.mjs';
import { MONEY_JARGON } from './fixtures/plain-copy-expectations.mjs';
import { selectVendorFamily } from '../src/lib/ledger-analysis.js';

test('terminal store decoration never shortens the requested identity', () => {
  for (const brand of ['Quartzfin', 'Ibis', 'West Orchard']) {
    const row = payee => ({ payee, direction: 'outflow', amount_minor: 1 });
    assert.equal(selectVendorFamily([row(brand)], `${brand} #23`).matched.length, 0);
    assert.equal(selectVendorFamily([row(`${brand} #23`)], `${brand} #23`).exact.length, 1);
    assert.equal(selectVendorFamily([row(`${brand} #24`)], `${brand} #23`).matched.length, 0);
    assert.equal(selectVendorFamily([row(`${brand} #23`)], brand).exact.length, 1);
  }
});

function checkAbbreviations(select) {
  for (const [brand, abbreviation, certified] of [['Amazon', 'AMZN', 1], ['Google', 'GOOG', 1],
    ['Copperhaven', 'CPHV', 0], ['Amberbrook', 'ABRK', 0]]) {
    const row = payee => ({ payee, direction: 'outflow', amount_minor: 1 });
    assert.equal(select([row(`${abbreviation} * Cloud`)], brand).matched.length, certified);
    assert.equal(select([row(`${brand} * Cloud`)], brand).family.length, 1);
    assert.equal(select([row(brand)], brand).exact.length, 1);
  }
}
test('only reviewed generic abbreviations certify family identity', () => {
  checkAbbreviations(selectVendorFamily);
});
test('kills unlisted abbreviation privilege', async () => {
  checkAbbreviations(selectVendorFamily);
  const source = readFileSync(new URL('../src/lib/ledger-analysis.js', import.meta.url), 'utf8');
  const from = "identity.startsWith(wanted + ' ')";
  assert.equal(source.split(from).length - 1, 1);
  const broken = source.replace(from, `(${from} || (wanted === 'copperhaven' && /^cphv /i.test(identity)))`);
  const mutant = await import('data:text/javascript;base64,' + Buffer.from(broken.replace('./vendor-aliases.js', new URL('../src/lib/vendor-aliases.js', import.meta.url).href)).toString('base64'));
  assert.throws(() => checkAbbreviations(mutant.selectVendorFamily), { name: 'AssertionError' });
});

for (const brand of ['Vendorwave', 'Cloud', 'North-Star Media']) test(`${brand}: exact and name amounts stay separate`, async t => {
  const f = ledgerFixture(t);
  f.add('exact', 'Card purchase', brand, { cents: 1001, direction: 'outflow', date: '2026-09-05' });
  const question = `How much did I spend at ${brand} in September 2026?`;
  const exact = await reachedAnswer(f, question);
  assert.equal(exact.ledger.total_minor, 1001);
  assert.equal(exact.ledger.complete, true, 'exact payee demoted to name-match');
  f.add('prefix', 'Card purchase', `${brand} Cafe`, { cents: 2002, direction: 'outflow', date: '2026-09-05' });
  const mixed = await reachedAnswer(f, question);
  assert.equal(mixed.ledger.exact_subtotal_minor, 1001, 'prefix member counted as certified');
  assert.equal(mixed.ledger.name_match_subtotal_minor, 2002);
  assert.equal(mixed.ledger.total_minor, null);
  assert.equal(mixed.ledger.complete, false, 'name-match subtotal marked complete');
  assert.equal(mixed.evidence_gate.complete, false);
  assert.match(mixed.answer, /matched by name, not confirmed/i);
  assert.match(mixed.answer, /same company\?/i);
  assert.ok(!mixed.receipt && !mixed.ledger.receipt);
});

test('exact descriptor cleanup preserves certification without erasing product suffixes', async t => {
  const f = ledgerFixture(t);
  for (const [i, name] of ['Vendorwave', 'PROCESSOR * VENDORWAVE', 'Vendorwave #23'].entries())
    f.add(`exact-${i}`, 'Card purchase', name, { cents: 100, direction: 'outflow', date: '2026-09-05' });
  const body = await reachedAnswer(f, 'How much did I spend at Vendorwave in September 2026?');
  assert.equal(body.ledger.total_minor, 300);
  assert.equal(body.evidence_gate.complete, true);
});

test('description-only amounts remain unconfirmed and uncited', async t => {
  const f = ledgerFixture(t);
  f.add('text', 'VENDORWAVE *CLOUD', null, { cents: 9900, direction: 'outflow', date: '2026-09-05' });
  const body = await reachedAnswer(f, 'How much did I spend at Vendorwave in September 2026?');
  assert.equal(body.ledger.match_basis, 'possible');
  assert.equal(body.ledger.complete, false);
  assert.equal(body.citations.length, 0);
  assert.doesNotMatch(body.answer, /\$\d/);
});

test('independent family matrix covers product-only, mixed, refund, own movement and missing dates', () => {
  const run = replay({ cases, snapshotFor });
  assert.equal(run.observations.length, 15);
  for (const o of run.observations) {
    reviewVendorFamily(o);
    assert.doesNotMatch(absenceLintText(o.body.answer), MONEY_JARGON);
  }
});

const sources = Object.fromEntries(['ledger-analysis.js', 'ledger-answer.js'].map(name =>
  [name, readFileSync(new URL('../src/lib/' + name, import.meta.url), 'utf8')]));
const mutants = [
  ['prefix member counted as certified', 'ledger-analysis.js', '{ family.push(row); continue; }', '{ exact.push(row); continue; }', 'exact-family'],
  ['name-match subtotal marked complete', 'ledger-answer.js', 'ledger.match_basis = "name_match";\n        ledger.complete = false;', 'ledger.match_basis = "name_match";\n        ledger.complete = true;', 'products'],
  ['exact payee demoted to name-match', 'ledger-analysis.js', 'exact.push(row); continue;', 'family.push(row); continue;', 'exact'],
];
for (const [name, file, from, to, key] of mutants) test(`kills ${name}`, () => {
  assert.equal(sources[file].split(from).length - 1, 1, 'mutation reached exactly once');
  const selected = cases.filter(c => c.id.endsWith('/' + key));
  const green = replay({ cases: selected, snapshotFor });
  green.observations.forEach(o => reviewVendorFamily(o));
  const broken = replay({ cases: selected, snapshotFor, sourceOverrides: { [file]: sources[file].replace(from, to) } });
  assert.equal(broken.observations[0].execution_status, 'complete');
  assert.throws(() => reviewVendorFamily(broken.observations[0]), { name: 'AssertionError' });
});

test('current-month exact payee remains a partial observed slice', async t => {
  const f = ledgerFixture(t);
  f.add('partial-exact', 'Card purchase', 'Vendorwave', { cents: 1001, direction: 'outflow' });
  const body = await reachedAnswer(f, 'How much did I spend at Vendorwave in October 2026?');
  assert.deepEqual([body.ledger.from, body.ledger.to], ['2026-10-01', '2026-10-12']);
  assert.equal(body.ledger.requested_to, '2026-10-31');
  assert.equal(body.ledger.total_minor, 1001);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /^Partial period: recorded activity only through October 12\./);
});
