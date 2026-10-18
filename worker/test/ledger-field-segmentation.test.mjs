import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { reachedAnswer } from './ledger-production-fixture.mjs';
import { attributeInflow, payerRegistry, payerQuestionRegistry } from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

const payment = name => `Did the payment of $25.00 from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
const amountOnly = 'Did the payment of $25.00 arrive in October 2026?';
// Independent field vocabulary: each pair must remain separate regardless of
// the phrase supplied by the question or its punctuation normalization.
const senderLabels = ['FROM:', 'BY:', 'ORIG CO NAME:', 'ORIGINATOR:',
  'ORIGINATOR NAME:', 'SENDER:', 'SENDER NAME:', 'FROM', 'BY'];
function* splitFields() {
  for (const first of senderLabels) for (const second of senderLabels) {
    for (const delimiter of [', ', '; ', ' | ', '\n']) yield {
      description: `${first} Supplier One${delimiter}${second} Supplier Two`,
      phrase: `Supplier One ${second.replace(':', '')} Supplier Two`,
      delimiter,
    };
  }
}
function fixture(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('receipt', 'FROM: Supplier One', null);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_entities').n, 1);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  return f;
}
function refused(body) {
  return body.ledger.found === null && body.evidence_gate.complete === false &&
    body.ledger.total_minor == null && body.ledger.attributed_subtotal_minor == null &&
    !body.payer_evidence?.length && !body.assumptions?.length;
}

test('every sender-label pair refuses a question spanning two explicit fields', async t => {
  const f = fixture(t), failures = [], counts = { rows: 0, refusals: 0, controls: 0 };
  for (const arm of splitFields()) {
    for (const form of [payment, income]) for (const exact of [false, true]) {
      const question = form(arm.phrase).replace('?', exact ? ', exact names only?' : '?');
      f.raw('UPDATE fin_transactions SET payee=?,description=?', arm.phrase, arm.description);
      const bank = await reachedAnswer(f, question);
      assert.equal(bank.ledger.found, true, 'an exact structured field supports the complete phrase');
      assert.equal(bank.payer_evidence[0].type, 'bank_payee'); counts.controls++;
      f.raw('UPDATE fin_transactions SET payee=NULL,description=?', `FROM: ${arm.phrase}`);
      const single = await reachedAnswer(f, question);
      assert.ok(refused(single), 'unregistered grammar words refuse even in a single labelled value'); counts.controls++;
      f.raw('UPDATE fin_transactions SET description=?', arm.description);
      const amount = await reachedAnswer(f, amountOnly);
      assert.equal(amount.ledger.found, true, 'the split row still proves its actual amount'); counts.controls++;
      const body = await reachedAnswer(f, question);
      assert.equal(body.ledger.inflow_total_minor, 2500);
      assert.ok(body.citations.some(c => c.amount_minor === 2500));
      if (!refused(body)) failures.push({ ...arm, kind: body.ledger.kind, exact });
      else counts.refusals++;
    }
    counts.rows++;
  }
  assert.equal(counts.rows, 324);
  assert.equal(counts.controls, 3888);
  t.diagnostic(JSON.stringify({ field_segmentation: counts, failures: failures.length }));
  assert.deepEqual(failures, [], 'a question cannot grant authority to a name spanning separate fields');
  assert.equal(counts.refusals, 1296);
});

test('complete metadata segmentations compete with comma and space whole-name hypotheses', async t => {
  const f = fixture(t);
  for (const [label, value] of [['REF:', '123'], ['BENEFICIARY:', 'Supplier Two'],
    ['ORIG ID:', '123'], ['TRACE:', '123'], ['SEC:', 'CCD'], ['DESC DATE:', '261005']]) {
    for (const delimiter of [', ', ' ']) for (const punctuation of [false, true]) {
      const phrase = `Supplier One${punctuation ? delimiter : ' '}${label.replace(':', '')} ${value}`;
      for (const form of [payment, income]) {
        f.raw('UPDATE fin_transactions SET payee=?,description=?', phrase, 'Processor text');
        assert.equal((await reachedAnswer(f, form(phrase))).ledger.found, true);
        f.raw('UPDATE fin_transactions SET payee=NULL,description=?', `FROM: Supplier One${delimiter}${label} ${value}`);
        const body = await reachedAnswer(f, form(phrase));
        assert.equal(body.ledger.inflow_total_minor, 2500);
        assert.ok(refused(body), JSON.stringify({ label, delimiter, punctuation }));
      }
    }
  }
});

test('company commas remain usable and registered vocabulary names retain complete metadata', async t => {
  const f = fixture(t);
  for (const name of ['Supplier Services, LLC', 'Supplier, Regional, LLC',
    'Supplier REF Division', 'Supplier SENDER Division']) {
    const registered = /REF|SENDER/.test(name);
    if (registered) f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('registered',?,'business','counterparty','owner_stated','confirmed',?)", name, NOW);
    for (const prefix of senderLabels) for (const tail of ['', '; REF: 123', ', TRACE: 123']) {
      f.raw('UPDATE fin_transactions SET description=?', `${prefix} ${name}${tail}`);
      for (const form of [payment, income]) {
        const body = await reachedAnswer(f, form(name.replaceAll(',', '')));
        assert.equal(body.ledger.found, true, `${prefix} ${name}${tail}`);
        if (!registered) assert.equal(body.payer_evidence[0].type, 'statement_sender');
        else assert.equal(body.evidence_gate.complete, true);
      }
    }
    if (registered) f.raw("DELETE FROM fin_entities WHERE entity_slug='registered'");
  }
});

test('a phrase reading needs its own fully resolved parse and cannot leak rejected evidence', () => {
  const registry = payerQuestionRegistry(classifyLedgerQuestion(payment('Supplier One')), payerRegistry([]));
  const green = attributeInflow({ description: 'FROM: Supplier One; REF: 123' }, registry);
  assert.equal(green.state, 'observed');
  for (const description of ['FROM: Supplier One; SENDER: Supplier Two', 'FROM: Supplier One; UNLISTED: text']) {
    const result = attributeInflow({ description }, registry);
    assert.ok(result.evidence.parser.steps > 0, 'the parser made the refusal decision');
    assert.equal(result.state, 'unknown');
    assert.equal(result.entity_slug, null);
    assert.ok(!result.evidence.query_phrases?.length, 'unresolved parses cannot supply phrase evidence');
  }
});

test('vocabulary-bearing query shorthand refuses while registered shorthand retains its note', async t => {
  const f = fixture(t), name = 'wire from Supplier Unit LLC';
  for (const tail of ['', '; REF: 123']) for (const form of [payment, income]) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?', name, 'Processor text');
    assert.equal((await reachedAnswer(f, form(name))).ledger.found, true);
    f.raw('UPDATE fin_transactions SET payee=NULL,description=?', `${name} payment${tail}`);
    assert.ok(refused(await reachedAnswer(f, form(name))));
    f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('registered',?,'business','counterparty','owner_stated','confirmed',?)", name, NOW);
    const body = await reachedAnswer(f, form(name));
    // A suffix shorthand followed by metadata is outside the closed suffix
    // production; use a channel shorthand for the metadata-bearing control.
    if (tail) {
      assert.ok(refused(body));
      f.raw('UPDATE fin_transactions SET description=?', `ACH ${name}${tail}`);
    }
    const positive = tail ? await reachedAnswer(f, form(name)) : body;
    assert.equal(positive.ledger.found, true);
    assert.equal(positive.assumptions.length, 1);
    assert.equal(positive.ledger.inflow_total_minor, 2500);
    assert.ok(refused(await reachedAnswer(f, form(name).replace('?', ', exact names only?'))));
    f.raw("DELETE FROM fin_entities WHERE entity_slug='registered'");
  }
});

test('unknown company-comma fields cannot disappear from competing segmentations', async t => {
  const f = fixture(t), failures = [];
  let rows = 0, controls = 0, refusals = 0;
  for (const [firstName, secondName] of [['Supplier One', 'Supplier Two, LLC'],
    ['Supplier One, LLC', 'Supplier Two'], ['Supplier One, Inc.', 'Supplier Two, LLC']]) {
    for (const first of senderLabels) for (const second of senderLabels) {
      for (const delimiter of [', ', '; ', ' | ', '\n']) {
        const phrase = `${firstName} ${second.replace(':', '')} ${secondName}`.replaceAll(',', '');
        const description = `${first} ${firstName}${delimiter}${second} ${secondName}`;
        for (const form of [payment, income]) for (const exact of [false, true]) {
          const question = form(phrase).replace('?', exact ? ', exact names only?' : '?');
          f.raw('UPDATE fin_transactions SET payee=?,description=?', phrase, description);
          assert.equal((await reachedAnswer(f, question)).ledger.found, true);
          controls++;
          f.raw('UPDATE fin_transactions SET payee=NULL');
          assert.equal((await reachedAnswer(f, amountOnly)).ledger.found, true);
          controls++;
          const body = await reachedAnswer(f, question);
          assert.equal(body.ledger.inflow_total_minor, 2500);
          assert.ok(body.citations.some(c => c.amount_minor === 2500));
          if (!refused(body)) failures.push({ description, exact, kind: body.ledger.kind });
          else refusals++;
        }
        rows++;
      }
    }
  }
  t.diagnostic(JSON.stringify({ company_field_segmentation: { rows, controls, refusals }, failures: failures.length }));
  assert.equal(rows, 972);
  assert.equal(controls, 7776);
  assert.deepEqual(failures, [], 'unknown company commas still separate explicit sender fields');
  assert.equal(refusals, 3888);
});
