import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { selectorTemplates } from './ledger-question-cases.mjs';
import { payerRegistry, resolveRequestedPayer, requestedPayerMentions } from '../src/lib/ledger-attribution.js';

const payment = name => `Did the payment of $25.00 from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const identity = (slug, name, alias = null) => f.raw(`INSERT INTO fin_entities
    (entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)`, slug, name, alias, NOW);
  f.add('receipt', 'Confirmed receipt', 'Payer One');
  async function ask(question) {
    f.calls.length = 0;
    const changes = f.first('SELECT total_changes() n').n;
    const body = await f.ask(question);
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), question);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
    assert.equal(f.first('SELECT total_changes() n').n, changes);
    assert.equal(f.documentCalls, 0, question);
    assert.ok(body.ledger, question);
    return body;
  }
  return { ...f, identity, ask };
}
function refused(body) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.payer_selector_ambiguous, true);
  assert.match(body.answer, /can't confirm which payer/i);
  assert.doesNotMatch(body.answer, /No matching|\$0\.00|Found a deposit/);
  if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
}

test('registered terminal abbreviations answer in both intents and exact-name modes', async t => {
  const f = setup(t); let answers = 0;
  f.identity('supplier', 'Initial Supplier', 'Supplier Alias');
  for (const full of ['Supplier Services Ltd.', 'Supplier Services Inc.', 'Supplier Services S.A.', 'Supplier Bank, N.A.', 'Supplier & Co.']) {
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', full, 'supplier');
    f.raw('UPDATE fin_transactions SET payee=?', full);
    for (const form of [payment, income]) for (const exact of [false, true]) {
      assert.equal((await f.ask(form('Supplier Alias'))).ledger.found, true);
      const body = await f.ask(form(full).replace('?', exact ? ', exact names only?' : '?'));
      assert.equal(body.ledger.found, true); assert.equal(body.evidence_gate.complete, true); answers++;
    }
  }
  assert.equal(answers, 20); t.diagnostic(JSON.stringify({ abbreviation_answers: answers }));
});

test('two payer mentions survive overlapping selector readings and internal Payment words', async t => {
  const f = setup(t); f.identity('one', 'Payer One'); f.identity('two', 'Payer Two');
  f.identity('supplier', 'Supplier Payment Services', 'Supplier Alias');
  for (const actual of ['Payer One', 'Payer Two', 'Supplier Payment Services']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    assert.equal((await f.ask(payment(actual))).ledger.found, true);
    for (const second of ['Payer Two Payment', 'Supplier Payment Services']) for (const mode of ['from', 'via']) for (const exact of [false, true]) {
      const question = `Did the Payer One payment ${mode} ${second} arrive in October 2026${exact ? ', exact names only' : ''}?`;
      if (mode === 'via') {
        // Partner answer 13: a "via" phrase after a named payer is a channel
        // phrase; outside the closed channel list it refuses at classification.
        assert.equal(classifyLedgerQuestion(question, { now: NOW }).kind, null, question);
        continue;
      }
      const body = await f.ask(question);
      refused(body);
      assert.equal(body.ledger.payer_selector_candidates.length, 2);
      assert.ok(body.ledger.payer_selector_candidates.every(label => label.startsWith('[redacted] ****')));
    }
  }
});

test('longest contained spelling wins, while unknown or uncovered clauses cannot certify absence', async t => {
  const f = setup(t); f.identity('short', 'Payer One'); f.identity('whole', 'Payer One, Bank');
  for (const actual of ['Payer One', 'Payer One, Bank']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    for (const form of [payment, income]) {
      const whole = await f.ask(form('Payer One, Bank'));
      assert.equal(whole.ledger.found, actual === 'Payer One, Bank');
      assert.equal(whole.evidence_gate.complete, true);
      for (const name of ['Unregistered Supplier', 'Payer One Reference', 'Payer One from Unregistered Supplier']) refused(await f.ask(form(name)));
    }
  }
});

test('a wholly unregistered payer refuses even with a covered confirmed receipt', async t => {
  const f = setup(t); f.identity('known', 'Payer One');
  assert.equal((await f.ask(payment('Payer One'))).ledger.found, true);
  for (const form of [payment, income]) refused(await f.ask(form('Unregistered Supplier')));
});

test('mention spans retain equal and partial overlaps, use Unicode boundaries, and refresh aliases', () => {
  const registry = payerRegistry([
    { entity_slug: 'short', legal_name: 'Payer One' },
    { entity_slug: 'whole', legal_name: 'Payer One, Bank', display_label: 'Supplier Ltd.' },
    { entity_slug: 'overlap', legal_name: 'Bank Services' },
    { entity_slug: 'duplicate', legal_name: 'Payer One, Bank' },
  ]);
  const mentions = requestedPayerMentions('Payer One, Bank Services from Payer One', registry);
  assert.deepEqual(mentions.map(m => m.label), ['payer one, bank', 'bank services', 'payer one']);
  assert.deepEqual([...mentions[0].slugs], ['whole', 'duplicate']);
  for (const suffix of ['', '.', '?', '.?']) {
    const m = requestedPayerMentions(`Supplier Ltd${suffix}`, registry);
    assert.equal(m.length, 1); assert.equal(m[0].label, 'supplier ltd.');
  }
  const positive = requestedPayerMentions('Payer One', registry);
  assert.equal(positive.length, 1);
  for (const text of ['NotPayer One', 'Payer Oneness', '甲Payer One', 'Payer One甲', 'Payer One\u0301', 'Payer One_suffix'])
    assert.equal(requestedPayerMentions(text, registry).length, 0, text);
  assert.equal(requestedPayerMentions('Supplier Ltd.', payerRegistry([{ entity_slug: 'whole', legal_name: 'Payer One, Bank' }])).length, 0);
});

const pairTemplates = [
  ...selectorTemplates.map(template => (a, b) => template(`${a} from ${b}`)),
  (a, b) => `Did the ${a} payment from ${b} arrive in October 2026?`,
];
// Partner answer 13: "via <b>" after the named payer <a> is a channel phrase.
// Outside the closed channel list it refuses at classification, so this pair
// template no longer reaches the ledger as a second payer clause.
const channelPairTemplate = (a, b) => `Did the ${a} payment via ${b} arrive in October 2026?`;

test('two-payer generator: every ordered pair, template, internal keyword and registration refuses claims', async t => {
  const f = setup(t);
  f.identity('one', 'Initial One', 'First Alias'); f.identity('two', 'Initial Two', 'Second Alias');
  const counts = { cases: 0, ambiguous: 0, unresolved: 0, answers: 0, controls: 0 };
  for (const keyword of ['Payment', 'from', 'by', 'Bank', 'Services']) {
    const names = [`Payer ${keyword} One`, `Supplier ${keyword} Two`, `${keyword} Example, Ltd.`];
    for (const first of names) for (const second of names.filter(name => name !== first)) {
      for (const registration of ['both', 'first', 'second', 'display', 'aliases']) {
        const entries = [
          { entity_slug: 'one', legal_name: registration === 'display' ? 'First Alias' : registration === 'second' ? 'Unused First' : first,
            display_label: registration === 'display' ? first : 'First Alias' },
          { entity_slug: 'two', legal_name: registration === 'display' ? 'Second Alias' : registration === 'first' ? 'Unused Second' : second,
            display_label: registration === 'display' ? second : 'Second Alias' },
        ];
        if (registration === 'aliases') for (const entry of entries) [entry.legal_name, entry.display_label] = [entry.display_label, entry.legal_name];
        for (const entry of entries) f.raw('UPDATE fin_entities SET legal_name=?,display_label=? WHERE entity_slug=?', entry.legal_name, entry.display_label, entry.entity_slug);
        for (const actual of ['First Alias', 'Second Alias']) {
          f.raw('UPDATE fin_transactions SET payee=?', actual);
          const control = await f.ask(payment(actual));
          assert.equal(control.ledger.found, true); assert.equal(control.evidence_gate.complete, true); counts.controls++;
        }
        const registry = payerRegistry(entries);
        for (const exact of [false, true]) {
          const question = channelPairTemplate(first, second).replace('?', exact ? ', exact names only?' : '?');
          assert.equal(classifyLedgerQuestion(question, { now: NOW }).kind, null, JSON.stringify({ question, registration }));
          counts.channelRefusals = (counts.channelRefusals || 0) + 1;
        }
        for (const template of pairTemplates) {
          const question = template(first, second), intent = classifyLedgerQuestion(question, { now: NOW });
          const detail = JSON.stringify({ question, registration });
          assert.ok(intent.kind, detail);
          const mentions = requestedPayerMentions(intent.payerQuestion.text, registry);
          assert.ok(mentions.length >= 1, detail);
          const resolution = resolveRequestedPayer(intent, registry);
          assert.equal(resolution.state, ['first', 'second'].includes(registration) ? 'unresolved' : 'ambiguous', detail);
          counts[resolution.state]++; counts.cases++;
          for (const actual of ['First Alias', 'Second Alias']) for (const exact of [false, true]) {
            f.raw('UPDATE fin_transactions SET payee=?', actual);
            const body = await f.ask(question.replace('?', exact ? ', exact names only?' : '?'));
            refused(body); counts.answers++;
            assert.equal(body.ledger.inflow_total_minor, 2500);
          }
        }
      }
    }
  }
  assert.equal(counts.cases, 3 * 2 * 5 * 5 * pairTemplates.length);
  assert.equal(counts.answers, counts.cases * 4);
  assert.equal(counts.channelRefusals, 3 * 2 * 5 * 5 * 2);
  assert.ok(counts.ambiguous > 0 && counts.unresolved > 0 && counts.controls > 0);
  t.diagnostic(JSON.stringify({ two_payer: counts, templates: pairTemplates.length }));
});

test('single-payer punctuation generator answers across templates, registrations and sentence endings', async t => {
  const f = setup(t); f.identity('supplier', 'Initial Supplier', 'Supplier Alias'); f.identity('short', 'Supplier');
  let answers = 0;
  for (const full of ['Supplier Services Ltd.', 'Supplier, Inc.', 'Supplier, Co.', 'Supplier Bank, N.A.', 'Supplier S.A.']) {
    for (const registration of ['legal', 'display', 'both']) {
      const legal = registration === 'display' ? 'Supplier Alias' : full;
      const display = registration === 'legal' ? 'Supplier Alias' : full;
      f.raw('UPDATE fin_entities SET legal_name=?,display_label=? WHERE entity_slug=?', legal, display, 'supplier');
      f.raw('UPDATE fin_transactions SET payee=?', full);
      for (const label of [full, full.slice(0, -1)]) for (const template of selectorTemplates) for (const exact of [false, true]) for (const punctuation of ['?', '.']) {
        const body = await f.ask(template(label).replace('?', `${exact ? ', exact names only' : ''}${punctuation}`));
        assert.equal(body.ledger.found, true); assert.equal(body.evidence_gate.complete, true);
        if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, 2500);
        answers++;
      }
    }
  }
  assert.equal(answers, 5 * 3 * 2 * selectorTemplates.length * 2 * 2);
  t.diagnostic(JSON.stringify({ single_payer_answers: answers, templates: selectorTemplates.length }));
});

test('every separate payer clause must be covered even when the known mentions share one slug', async t => {
  const f = setup(t); f.identity('one', 'Payer One', 'Payer Alias');
  const green = await f.ask('Did the Payer One payment from Payer Alias arrive in October 2026?');
  assert.equal(green.ledger.found, true); assert.equal(green.evidence_gate.complete, true);
  for (const name of ['Payer Alias, Bank', 'Bank Payer Alias', 'Unregistered Supplier']) {
    const question = `Did the Payer One payment from ${name} arrive in October 2026?`;
    refused(await f.ask(question));
  }
});

test('sentence-final name punctuation stays outside the registered spelling', async t => {
  const f = setup(t); f.identity('one', 'Supplier Ltd.');
  f.raw('UPDATE fin_transactions SET payee=?', 'Supplier Ltd.');
  for (const name of ['Supplier Ltd', 'Supplier Ltd.']) for (const end of ['?', '.', '.?']) {
    for (const prefix of ['Did the payment arrive in October 2026 from', 'How much income in October 2026 from']) {
      const body = await f.ask(`${prefix} ${name}${end}`);
      assert.equal(body.ledger.found, true); assert.equal(body.evidence_gate.complete, true);
    }
  }
});

test('partially overlapping aliases of one entity agree, and non-payer alias mentions do not change scope', async t => {
  const f = setup(t);
  f.identity('one', 'Payer One Payment', 'Payment from Payer One');
  f.raw('UPDATE fin_transactions SET payee=?', 'Payer One Payment');
  for (const alias of ['Payer One Payment', 'Payment from Payer One']) {
    const control = await f.ask(payment(alias));
    assert.equal(control.ledger.found, true); assert.equal(control.evidence_gate.complete, true);
  }
  const overlapping = await f.ask('Did the payment from Payer One Payment arrive in October 2026?');
  assert.equal(overlapping.ledger.found, true); assert.equal(overlapping.evidence_gate.complete, true);
  f.raw('UPDATE fin_entities SET display_label=? WHERE entity_slug=?', 'Bank', 'one');
  const genericAlias = await f.ask('Did the payment from Payer One Payment arrive in my bank account in October 2026?');
  assert.equal(genericAlias.ledger.found, true); assert.equal(genericAlias.evidence_gate.complete, true);
});
