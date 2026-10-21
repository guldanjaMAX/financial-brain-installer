import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { requestedSelectorCases, unlistedViaTemplates } from './ledger-question-cases.mjs';
import { payerRegistry, resolveRequestedPayer } from '../src/lib/ledger-attribution.js';

const payment = name => `Did the payment of $25.00 from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const identity = (slug, name, alias = null) => f.raw(`INSERT INTO fin_entities
    (entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)`, slug, name, alias, NOW);
  f.add('receipt', 'Confirmed receipt', 'Payer One');
  async function ask(q) {
    f.calls.length = 0;
    const before = f.calls.length, documentsBefore = f.documentCalls, changes = f.first('SELECT total_changes() n').n;
    const body = await f.ask(q);
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), q);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
    assert.equal(f.first('SELECT total_changes() n').n, changes);
    assert.equal(f.documentCalls, documentsBefore, q);
    assert.ok(body.ledger, q);
    return body;
  }
  return { ...f, identity, ask, route: f.ask };
}
function uncertain(body) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
  assert.doesNotMatch(body.answer, /No matching|\$0\.00/);
}

test('a complete registered comma name supersedes its contained spelling: both receipt arms and exact-name modes', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One', 'Short Supplier');
  f.identity('whole', 'Payer One, Bank', 'Whole Supplier');
  for (const actual of ['Payer One', 'Payer One, Bank']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    for (const form of [payment, income]) for (const exact of [false, true]) {
      const q = name => form(name).replace('?', exact ? ', exact names only?' : '?');
      const control = await f.ask(q('Whole Supplier'));
      assert.equal(control.ledger.found, actual === 'Payer One, Bank');
      assert.equal(control.evidence_gate.complete, true);
      const body = await f.ask(q('Payer One, Bank'));
      assert.equal(body.ledger.found, actual === 'Payer One, Bank');
      assert.equal(body.evidence_gate.complete, true);
      assert.equal(body.ledger.payer_selector_ambiguous, undefined);
    }
  }
});

test('amount-bearing selectors preserve numeric and generic whole names', async t => {
  const f = setup(t);
  f.identity('short', '1234', 'Short Supplier');
  f.identity('whole', '1234, Bank', 'Whole Supplier');
  for (const actual of ['1234', '1234, Bank']) {
    f.raw('UPDATE fin_transactions SET payee=?', actual);
    assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, actual === '1234, Bank');
    const body = await f.ask(payment('1234, Bank'));
    assert.equal(body.ledger.found, actual === '1234, Bank');
    assert.equal(body.evidence_gate.complete, true);
  }
});

test('an unregistered alternative whole name cannot fabricate a competing selector', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One');
  f.identity('whole', 'Payer One payment', 'Whole Supplier');
  f.raw('UPDATE fin_transactions SET payee=?', 'Payer One payment');
  const question = 'Did the payment from Payer One payment arrive in October 2026?';
  assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, true);
  assert.equal((await f.ask(question)).ledger.found, true);
  f.identity('alternative', 'Payment from Payer One');
  const body = await f.ask(question);
  uncertain(body);
  assert.equal(body.ledger.payer_selector_ambiguous, true);
  assert.equal(body.ledger.payer_selector_candidates.length, 2);
});

test('whole names, aliases of one slug, empty snapshots and disjoint selector clauses', async t => {
  const f = setup(t);
  f.identity('whole', 'Payer One, Bank', 'Payer One');
  f.raw('UPDATE fin_transactions SET payee=?', 'Payer One, Bank');
  for (const form of [payment, income]) for (const exact of [false, true]) {
    const q = form('Payer One, Bank').replace('?', exact ? ', exact names only?' : '?');
    const body = await f.ask(q);
    assert.equal(body.ledger.found, true);
    assert.equal(body.evidence_gate.complete, true);
  }
  const combined = 'Did the Payer One payment from Payer One, Bank arrive in October 2026?';
  assert.equal((await f.ask(combined)).ledger.found, true);
  f.raw('UPDATE fin_entities SET display_label=NULL WHERE entity_slug=?', 'whole');
  f.identity('short', 'Payer One', 'Short Supplier');
  uncertain(await f.ask(combined));
  f.raw('UPDATE fin_transactions SET posted_on=?', '2025-01-01');
  for (const form of [payment, income]) {
    const body = await f.ask(form('Payer One, Bank'));
    assert.equal(body.ledger.found, false);
    assert.equal(body.evidence_gate.complete, true);
    assert.equal(body.ledger.inflow_total_minor, 0, 'the unique complete name is absent from the covered empty window');
    if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, 0);
  }
});

test('selector limits and forbidden controls refuse after a positive routing control', () => {
  const green = classifyLedgerQuestion(payment('Payer One'), { now: NOW });
  assert.equal(green.kind, 'payment');
  assert.ok(green.payerReadings.length);
  for (const text of ['Payer One\0Bank', 'Payer One\u200bBank', 'Payer One' + ' Bank'.repeat(130)]) {
    const result = classifyLedgerQuestion(payment(text), { now: NOW });
    assert.equal(result.broad, true, 'money routing decision reached');
    assert.equal(result.kind, null);
  }
});

test('a selector outside the protected alphabet cannot fall back to comma truncation', async t => {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('whole','& Payer One, Bank','Whole Supplier','business','owned','owner_stated','confirmed',?)`, NOW);
  f.add('receipt', 'Confirmed receipt', '& Payer One, Bank');
  assert.equal((await f.ask(payment('Whole Supplier'))).ledger.found, true);
  const before = f.documentCalls, reads = f.calls.length;
  const body = await f.ask(payment('& Payer One, Bank'));
  assert.equal(f.documentCalls, before + 1, 'unsupported-selector routing decision reached');
  assert.equal(f.calls.length, reads, 'no truncated selector can read the ledger');
  assert.equal(body.ledger, undefined);
});

test('unknown and partly covered selectors refuse; a confirmed registered payer remains useful', async t => {
  const f = setup(t);
  f.identity('short', 'Payer One');
  assert.equal((await f.ask(payment('Payer One'))).ledger.found, true);
  for (const form of [payment, income]) {
    const absent = await f.ask(form('Unregistered Supplier'));
    uncertain(absent);
    assert.equal(absent.ledger.payer_selector_ambiguous, true);
    uncertain(await f.ask(form('Payer One Reference')));
    uncertain(await f.ask(form('Payer One,' + ' Bank'.repeat(20))));
  }
});

// Partner answer 9's closed qualifier list, and partner ruling 7 (round 7,
// verbatim): "Strip ACH there too, so the payer is "Payer One". Update the
// selector generator." A generated noun payer whose only other word is on the
// list ("ach Payer One", "Payer One wire", "Payer One, invoice"), in the slot
// before the question's own "payment", is stripped to "Payer One"; the
// complete requested name stays the competing unstripped reading.
const answerNineQualifiers = ['any', 'latest', 'last', 'recent', 'monthly', 'invoice', 'ach', 'wire'];
function strippedNounArm(arm) {
  const whole = arm.whole.toLowerCase();
  const word = whole.replace(/^payer one,? +| +payer one$/, '');
  return word !== whole && answerNineQualifiers.includes(word) && arm.question.includes(` the ${arm.whole} payment `);
}

test('generator retains complete requested names before interpreting grammar words', () => {
  let cases = 0, stripped = 0;
  for (const arm of requestedSelectorCases()) {
    const intent = classifyLedgerQuestion(arm.question, { now: NOW });
    if (/\b(?:from|by|for|in|of)$/.test(arm.whole.toLowerCase())) {
      // Receive wording has no money keyword; unsupported names keep that
      // original document routing rather than inventing a money question.
      assert.equal(intent.broad, !/^how much did (?:i|we) receive\b/i.test(arm.question), 'original routing retained');
      assert.equal(intent.kind, null, JSON.stringify(arm));
      assert.equal(intent.payerReadings, undefined, 'S1 cannot retain a terminal connector as a name');
      cases++; continue;
    }
    const entries = [
      ...(arm.registration === 'longer' ? [] : [{ entity_slug: 'short', legal_name: 'Payer One' }]),
      ...(arm.registration === 'shorter' ? [] : [{ entity_slug: 'whole', legal_name: arm.whole }]),
    ];
    if (strippedNounArm(arm)) {
      // Ruling 7: the payer is "Payer One"; the complete requested name is
      // retained as the unstripped reading, which competes at the answer.
      assert.equal(intent.kind, 'payment', JSON.stringify(arm));
      assert.equal(intent.counterparty, 'payer one', JSON.stringify(arm));
      assert.ok(intent.unstrippedReading?.payerReadings?.some(reading => reading.label === arm.whole.toLowerCase()), JSON.stringify(arm));
      const registry = payerRegistry(entries);
      const shorter = resolveRequestedPayer(intent, registry), whole = resolveRequestedPayer(intent.unstrippedReading, registry);
      if (arm.registration === 'longer') assert.equal(shorter.state, 'unresolved', JSON.stringify(arm));
      else assert.deepEqual([shorter.state, shorter.slug], ['unique', 'short'], JSON.stringify(arm));
      if (arm.registration === 'shorter') assert.equal(whole.state, 'unresolved', JSON.stringify(arm));
      else assert.deepEqual([whole.state, whole.slug], ['unique', 'whole'], JSON.stringify(arm));
      cases++; stripped++; continue;
    }
    assert.ok(intent.kind, JSON.stringify(arm));
    assert.ok(intent.payerReadings?.some(reading => reading.label === arm.whole.toLowerCase()), JSON.stringify(arm));
    const resolved = resolveRequestedPayer(intent, payerRegistry(entries));
    if (resolved.state === 'unique') assert.equal(resolved.slug, 'whole', JSON.stringify(arm));
    if (arm.registration === 'longer') assert.equal(resolved.state, 'unique', JSON.stringify(arm));
    assert.notEqual(resolved.state, 'missing', JSON.stringify(arm));
    cases++;
  }
  assert.ok(cases > 50000);
  // ach, wire and invoice x three shapes x 45 noun templates x 3 registrations.
  assert.equal(stripped, 3 * 3 * 45 * 3);
});

// The generator's old "<aux> the payment via <whole> <verb>" arms. Partner
// ruling 4 (round 7): ""Via <name>" that isn't a listed channel refuses."
// Partner ruling 6 (round 7, verbatim): "Strip the channel: "via wire from
// <name>" means payer <name>. Update the name-retention generators." The old
// arm "via wire from Payer One" (whole "wire from Payer One") was pinned as
// the complete requested name "wire from payer one"; it now names "Payer One".
test('generator: the old "via <whole>" arms refuse at classification, and "via wire from <name>" names <name>', () => {
  const counts = { refused: 0, wireFrom: 0 };
  for (const arm of requestedSelectorCases()) {
    // One arm per whole and registration; the 45 old forms are applied here.
    if (arm.question !== `did the payment from ${arm.whole} arrive in October 2026?`) continue;
    for (const template of unlistedViaTemplates) {
      const question = template(arm.whole), intent = classifyLedgerQuestion(question, { now: NOW });
      const named = arm.whole.match(/^wire from (.+)$/i)?.[1];
      if (!named || /\b(?:from|by|for|in|of)$/i.test(named)) {
        assert.equal(intent.kind, null, question);
        counts.refused++; continue;
      }
      assert.equal(intent.kind, 'payment', question);
      assert.equal(intent.counterparty, named.toLowerCase(), question);
      assert.ok(!intent.payerReadings.some(reading => /^wire\b/.test(reading.label)), `${question}: the channel is never payer text`);
      const entries = [
        ...(arm.registration === 'longer' ? [] : [{ entity_slug: 'short', legal_name: 'Payer One' }]),
        ...(arm.registration === 'shorter' ? [] : [{ entity_slug: 'whole', legal_name: arm.whole }]),
      ];
      const resolved = resolveRequestedPayer(intent, payerRegistry(entries));
      if (arm.registration === 'longer') assert.equal(resolved.state, 'unresolved', question);
      else assert.deepEqual([resolved.state, resolved.slug], ['unique', 'short'], question);
      counts.wireFrom++;
    }
  }
  // One whole, "wire from Payer One", x 45 templates x 3 registrations.
  assert.equal(counts.wireFrom, 45 * 3);
  assert.ok(counts.refused > 10000);
});

test('generated requested selectors resolve by distinct slugs, with both real receipt arms', async t => {
  const f = setup(t);
  const counts = { cases: 0, unique: 0, ambiguous: 0, unresolved: 0, missing: 0, answers: 0 };
  f.identity('short', 'Payer One', 'Short Supplier');
  f.identity('whole', 'Initial Supplier', 'Whole Supplier');
  const control = await f.ask(payment('Short Supplier'));
  assert.equal(control.ledger.found, true);
  for (const arm of requestedSelectorCases()) {
    const entries = [
      ...(arm.registration === 'longer' ? [] : [{ entity_slug: 'short', legal_name: 'Payer One' }]),
      ...(arm.registration === 'shorter' ? [] : [{ entity_slug: 'whole', legal_name: arm.whole }]),
    ];
    const intent = classifyLedgerQuestion(arm.question, { now: NOW });
    if (/\b(?:from|by|for|in|of)$/.test(arm.whole.toLowerCase())) {
      const reads = f.calls.length;
      assert.equal(intent.broad, !/^how much did (?:i|we) receive\b/i.test(arm.question), 'original routing retained');
      assert.equal(intent.kind, null, JSON.stringify(arm));
      const body = await f.route(arm.question);
      assert.equal(body.route, 'documents', 'unsupported terminal selector reaches fallback');
      assert.equal(f.calls.length, reads);
      counts.cases++; counts.unsupported = (counts.unsupported || 0) + 1; continue;
    }
    if (strippedNounArm(arm)) {
      // Ruling 7: the stripped "Payer One" and the unstripped complete name
      // compete. One registered answers for its own exact payee row only;
      // both registered are two exact entities and refuse; nothing else is
      // certified, and no absence or zero is read.
      f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'longer' ? 'Unused Short' : 'Payer One', 'short');
      f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'shorter' ? 'Unused Whole' : arm.whole, 'whole');
      for (const actual of ['Payer One', arm.whole]) for (const exact of [false, true]) {
        f.raw('UPDATE fin_transactions SET payee=?', actual);
        const body = await f.ask(arm.question.replace('?', exact ? ', exact names only?' : '?'));
        if (arm.registration !== 'both' && (arm.registration === 'shorter') === (actual === 'Payer One')) {
          assert.equal(body.ledger.found, true, JSON.stringify({ arm, actual }));
          assert.equal(body.evidence_gate.complete, true, JSON.stringify({ arm, actual }));
          assert.ok(body.citations.some(c => c.amount_minor === 2500));
        } else uncertain(body);
        counts.answers++;
      }
      counts.cases++; counts.stripped = (counts.stripped || 0) + 1; continue;
    }
    const resolved = resolveRequestedPayer(intent, payerRegistry(entries));
    counts[resolved.state]++; counts.cases++;
    if (resolved.state === 'unique') assert.equal(resolved.slug, 'whole', JSON.stringify(arm));
    if (arm.registration === 'longer') assert.equal(resolved.state, 'unique', JSON.stringify(arm));
    // Registry and row mutations are synthetic fixture setup, outside ask's
    // no-write boundary. Each query must read the nonempty current snapshot.
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'longer' ? 'Unused Short' : 'Payer One', 'short');
    f.raw('UPDATE fin_entities SET legal_name=? WHERE entity_slug=?', arm.registration === 'shorter' ? 'Unused Whole' : arm.whole, 'whole');
    for (const actual of ['Payer One', arm.whole]) for (const exact of [false, true]) {
      f.raw('UPDATE fin_transactions SET payee=?', actual);
      const body = await f.ask(arm.question.replace('?', exact ? ', exact names only?' : '?'));
      if (resolved.state !== 'unique') {
        // The registry may lack the whole name while the complete structured
        // field supplies the unique R7 exact reading. A short field still refuses.
        if (actual === arm.whole && (!arm.whole.includes(',') || /, (?:co|company)$/i.test(arm.whole))) {
          assert.equal(body.ledger.found, true, JSON.stringify(arm));
          assert.ok(body.citations.some(c => c.amount_minor === 2500));
        } else uncertain(body);
      }
      if (resolved.state === 'unique') {
        if (actual === arm.whole) assert.equal(body.ledger.found, true, JSON.stringify(arm));
        else assert.notEqual(body.ledger.found, true, JSON.stringify(arm));
      }
      counts.answers++;
    }
  }
  assert.ok(counts.unique > 0 && counts.unresolved > 0);
  assert.equal(counts.ambiguous, 0, 'contained shorter spellings yield to the complete registered name');
  assert.equal(counts.missing, 0, 'known fragments cannot certify absence for an unregistered longer selector');
  assert.equal(counts.stripped, 3 * 3 * 45 * 3, 'ruling 7 arms');
  t.diagnostic(JSON.stringify(counts));
});
