import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { card, mutatedModule } from './partner-r2-helpers.mjs';

const encoded = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const absolutize = (source, url) => source.replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
  (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
async function mutatedAnswer(file, before, after, answerBefore = null, answerAfter = null) {
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  const source = readFileSync(url, 'utf8');
  assert.equal(source.split(before).length, 2, 'one guard decision is disabled');
  const target = encoded(absolutize(source.replace(before, after), url));
  const answerURL = new URL('../src/lib/ledger-answer.js', import.meta.url);
  let answer = readFileSync(answerURL, 'utf8');
  if (answerBefore !== null) {
    assert.equal(answer.split(answerBefore).length, 2, 'one answer guard decision is disabled');
    answer = answer.replace(answerBefore, answerAfter);
  }
  answer = answer.replace(`"./${file}"`, JSON.stringify(target));
  return (await import(encoded(absolutize(answer, answerURL)))).withLedgerAnswer;
}
async function reached(f, question) {
  const before = f.calls.length;
  const body = await f.ask(question);
  assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)));
  assert.ok(f.first('SELECT COUNT(*) n FROM fin_transactions').n > 0);
  assert.ok(body.ledger);
  return body;
}
function fixture(t, answer) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  return ledgerFixture(t, { answer, knownPayers: false });
}

test('R4 A3 mutation restores absence and a complete payee total on a conflicting row', async t => {
  // Partner ruling 12 (round 7) added a second, independent guard: a row
  // whose bounded fields conflict is made unknown in ledger-answer.js
  // before any answer path reads it. Disabling attributeRow's conflict
  // decision alone therefore no longer restores absence (the `single` arm);
  // disabling both guards does (the `mutant` arm, as before).
  const guard = "if (!fields.get(row.id).conflict || attribution.state === 'unknown') continue;";
  const single = await mutatedAnswer('ledger-attribution.js', 'if (conflict) {', 'if (false) {');
  const mutant = await mutatedAnswer('ledger-attribution.js', 'if (conflict) {', 'if (false) {', guard, 'continue;');
  {
    const f = fixture(t, single);
    for (const [slug, name] of [['one', 'Payer One'], ['two', 'Payer Two']])
      f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
        VALUES (?,?,'business','owned','owner_stated','confirmed',?)`, slug, name, NOW);
    f.add('receipt', 'FROM: Payer Two', 'Payer One');
    assert.equal((await reached(f, 'Did the payment from Payer Two arrive in October 2026?')).ledger.found, null);
    const total = await reached(f, 'How much income came from Payer One in October 2026?');
    assert.equal(total.ledger.total_minor, null);
    assert.equal(total.evidence_gate.complete, false);
  }
  for (const answer of [withLedgerAnswer, mutant]) {
    const f = fixture(t, answer);
    for (const [slug, name] of [['one', 'Payer One'], ['two', 'Payer Two']])
      f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
        VALUES (?,?,'business','owned','owner_stated','confirmed',?)`, slug, name, NOW);
    f.add('receipt', 'FROM: Payer Two', 'Payer One');
    const absent = await reached(f, 'Did the payment from Payer Two arrive in October 2026?');
    const total = await reached(f, 'How much income came from Payer One in October 2026?');
    assert.equal(absent.ledger.found, answer === mutant ? false : null);
    assert.equal(total.ledger.total_minor, answer === mutant ? 2500 : null);
    assert.equal(total.evidence_gate.complete, answer === mutant);
    f.raw("UPDATE fin_transactions SET description='FROM: Payer One'");
    assert.equal((await reached(f, 'Did the payment from Payer One arrive in October 2026?')).ledger.found, true);
  }
});

test('R4 QF1 structural nonmatch mutation restores a complete false zero; matching controls stay exact', async t => {
  const mutant = (await mutatedModule('ledger-answer.js',
    "if (intent.match && !matched.length && (intent.direction === 'outflow' || intent.kind === 'category')) {",
    'if (false) {')).withLedgerAnswer;
  for (const answer of [withLedgerAnswer, mutant]) {
    const f = fixture(t, answer);
    f.add('expense', 'Purchase', 'Vendor One', { direction: 'outflow', date: '2026-09-15', cents: 30000 });
    f.raw("UPDATE fin_transactions SET category='Office',category_basis_state='confirmed'");
    for (const selector of ['at Vendor One', 'on Office']) {
      const prefix = `How much did I spend ${selector} in September 2026`;
      assert.equal((await reached(f, `${prefix}?`)).ledger.total_minor, 30000);
      assert.equal((await reached(f, `${prefix}, please?`)).ledger.total_minor, 30000);
      // Round 5 (R5-MONEY-3, triage decided): the payee "Vendor One" is a
      // whole-word prefix of "Vendor One unknownword", a shortened-name
      // possible match, so that selector is no longer a structural nonmatch:
      // it is never found, never a total and never complete. The structural
      // nonmatch arm uses a selector that shares no whole-word run with the
      // payee, and keeps every assertion below.
      const nonmatch = selector === 'at Vendor One' ? 'at Vendor Two' : selector;
      if (nonmatch !== selector) {
        const variant = await reached(f, `In September 2026, how much did I spend ${selector} unknownword?`);
        assert.notEqual(variant.ledger.found, true, 'a possible match is never found');
        assert.equal(variant.ledger.total_minor, null);
        assert.equal(variant.evidence_gate.complete, false);
      }
      const body = await reached(f, `In September 2026, how much did I spend ${nonmatch} unknownword?`);
      assert.equal(body.ledger.found, false, 'same selector nonmatch reaches both renderers');
      const breached = answer === mutant && selector === 'on Office';
      assert.equal(body.ledger.total_minor, breached ? 0 : null);
      assert.equal(body.evidence_gate.complete, breached);
      if (answer !== mutant) assert.equal(body.ledger.total_is_exact, false);
    }
  }
});

test('R4 KF1 the inherited single allowlist blocks all three card fields and its mutation discloses them', async () => {
  const mutant = await mutatedModule('entity-fact-answer.js', 'if (unsafeScalarFact(value, field)) return false;', 'if (false) return false;');
  for (const [field, plain] of [['address', '12 Synthetic Road'], ['company', 'Example Organization'], ['role', 'Operations Manager']]) {
    for (const answer of [entityFactAnswer, mutant.entityFactAnswer]) {
      assert.ok(card(field, plain, answer)?.answer.includes(plain), 'same card decision answers the green control');
      const value = `${plain} Account 778899667788`;
      const result = card(field, value, answer);
      if (answer === entityFactAnswer) assert.equal(result, null);
      else assert.ok(result?.answer.includes(value), 'unsafe disclosure restored');
    }
  }
});
