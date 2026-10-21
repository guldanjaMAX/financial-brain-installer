import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture, measureProduction, reachedAnswer } from './ledger-production-fixture.mjs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { ledgerStatementVocabulary, normalizeMerchantText } from '../src/lib/ledger-attribution.js';
import { selectorTemplates, unlistedViaTemplates } from './ledger-question-cases.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { originatorFormats, originatorWords, channelPrefixes } from './ledger-attribution-cases.mjs';

import { assertExactSelection, assertPossibleMatch } from './partner-r7-assertions.mjs';

const payment = name => `Did the payment from ${name} arrive in October 2026?`;
const income = name => `How much income came from ${name} in October 2026?`;
function single(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.add('receipt', 'FROM: Supplier One', null);
  return f;
}
function refusal(body, { candidateZero = false } = {}) {
  assert.equal(body.ledger.found, null);
  assert.equal(body.evidence_gate.complete, false);
  assert.doesNotMatch(body.answer, /No matching|Found a deposit/);
  if (!candidateZero) assert.doesNotMatch(body.answer, /\$0\.00/);
  if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, null);
}

test('production-shaped payer presence answers all forty arms with no wrong answers', async t => {
  const f = productionFixture(t);
  assert.equal((await reachedAnswer(f, 'Did the payment of $25.00 arrive in October 2026?')).ledger.found, true);
  const stats = await measureProduction(f);
  t.diagnostic(JSON.stringify(stats));
  assert.deepEqual([stats.answered, stats.refused, stats.wrong], [40, 0, 0]);
  assert.equal(stats.possible, 4);
});

test('exact structured and labelled sender matches are cited presence, never registration or zero', async t => {
  const f = single(t);
  for (const [payee, description, source] of [
    ['Ｓｕｐｐｌｉｅｒ One', 'Opaque processor text', 'bank_payee'],
    [null, 'WIRE FROM: Supplier One; REF: 482617039258001', 'statement_sender'],
  ]) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?', payee, description);
    for (const form of [payment, income]) {
      const body = await reachedAnswer(f, form('Supplier One'));
      assert.equal(body.ledger.found, true);
      assert.equal(body.payer_evidence[0].type, source);
      assert.ok(body.payer_evidence[0].citations.every(n => body.citations.some(c => c.n === n && c.amount_minor === 2500)));
      assert.match(body.answer, /your bank lists the payer as|statement line names.*as sender/i);
      assert.ok(!JSON.stringify(body).includes('482617039258001'));
      if (body.ledger.kind === 'merchant') {
        assert.equal(body.ledger.total_minor, 2500);
        assert.equal(body.ledger.total_is_exact, true);
      }
      refusal(await reachedAnswer(f, form('Missing Supplier')));
    }
  }
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_entities').n, 1);
  f.raw('DELETE FROM fin_transactions');
  for (const form of [payment, income]) {
    f.calls.length = 0;
    const before = f.first('SELECT total_changes() n').n;
    const body = await f.ask(form('Supplier One'));
    assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'empty-window snapshot decision reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 0);
    assert.equal(f.first('SELECT total_changes() n').n, before);
    assert.equal(f.documentCalls, 0);
    refusal(body);
    assert.match(body.answer, /found 0 exact matches; 0 deposits I couldn't attribute/i);
  }
});

test('unregistered and registered shorthand keep the assumption note and exact-name flip', async t => {
  const f = single(t);
  const suffixes = ['', 'ACH ', 'EFT ', 'WIRE ', 'ZELLE '].flatMap(channel =>
    ['deposit', 'payment', 'receipt', 'payroll', 'settlement'].map(suffix => `${channel}${suffix}`));
  const descriptions = [...suffixes.map(suffix => `Supplier One ${suffix}`),
    ...channelPrefixes.map(prefix => `${prefix} Supplier One`)];
  let assumed = 0, exactRefused = 0;
  for (const description of descriptions) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    for (const form of [payment, income]) {
      // The exact bank-field control reaches the same nonempty snapshot before
      // testing description-only authority, so a refusal cannot pass vacuously.
      f.raw("UPDATE fin_transactions SET payee='Supplier One'");
      assert.equal((await reachedAnswer(f, form('Supplier One'))).payer_evidence[0].type, 'bank_payee');
      f.raw('UPDATE fin_transactions SET payee=NULL');
      for (const registered of [false, true]) {
        if (registered)
          f.raw("INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at) VALUES ('registered','Supplier One','business','owned','owner_stated','confirmed',?)", NOW);
        const body = await reachedAnswer(f, form('Supplier One'));
        assertPossibleMatch(body, 2500);
        assert.equal(body.assumptions.length, 1);
        assert.match(body.answer, /Note:.*exact names only/);
        assert.ok(body.notes?.length);
        assert.ok(body.ledger.flip.includes('exact names only'));
        assert.ok(body.citations.some(c => c.amount_minor === 2500));
        assert.ok(!body.payer_evidence?.length, 'shorthand cannot claim confirmed payer evidence');
        if (body.ledger.kind === 'merchant') {
          assert.equal(body.ledger.total_minor, null);
          assert.equal(body.ledger.attributed_subtotal_minor, 2500);
        }
        assumed++;
        refusal(await reachedAnswer(f, form('Supplier One').replace('?', ', exact names only?')));
        exactRefused++;
        refusal(await reachedAnswer(f, form('Missing Supplier')));
        refusal(await reachedAnswer(f, 'Did the payment of $26.00 from Supplier One arrive in October 2026?'));
        f.raw('UPDATE fin_transactions SET amount_minor=0');
        const zero = await reachedAnswer(f, form('Supplier One'));
        refusal(zero, { candidateZero: true });
        assert.equal(zero.ledger.attributed_subtotal_minor ?? null, null);
        assert.equal(zero.ledger.unattributed_candidates[0].amount_minor, 0);
        assert.ok(!zero.assumptions?.length);
        f.raw('UPDATE fin_transactions SET amount_minor=2500');
        if (registered) f.raw("DELETE FROM fin_entities WHERE entity_slug='registered'");
      }
    }
  }
  assert.equal(descriptions.length, 54);
  assert.equal(assumed, 216);
  assert.equal(exactRefused, assumed);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  t.diagnostic(JSON.stringify({ shorthand: { descriptions: descriptions.length, assumed, exactRefused } }));
});

test('bare descriptions, incomplete parses, competing phrases and registered conflicts refuse', async t => {
  const f = single(t);
  assert.equal((await reachedAnswer(f, payment('Supplier One'))).ledger.found, true);
  for (const description of ['Supplier One', 'FROM: Supplier One; UNLISTED: text',
    'FROM: Supplier One; FROM: Supplier Two', 'FROM: Supplier One\0']) {
    f.raw('UPDATE fin_transactions SET description=?', description);
    refusal(await reachedAnswer(f, payment('Supplier One')));
  }
  f.raw("UPDATE fin_transactions SET description='FROM: Supplier One', payee='Supplier One'");
  f.add('second', 'FROM: Supplier Two', 'Supplier Two');
  for (const q of ['Did the Supplier One payment from Supplier Two arrive in October 2026?',
    'Did the payment from Supplier One from Supplier Two arrive in October 2026?']) refusal(await reachedAnswer(f, q));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('registered','Supplier','business','owned','owner_stated','confirmed',?)`, NOW);
  // A shorter registry entry cannot erase the exact complete bank field.
  assertExactSelection(await reachedAnswer(f, payment('Supplier One')), 2500);
});

test('query-only evidence cannot persist across questions, zero rows, amounts or account and date scopes', async t => {
  const f = single(t);
  assert.equal((await reachedAnswer(f, payment('Supplier One'))).ledger.found, true);
  // The generic listing has no requested phrase and must not inherit the
  // previous question's presence hypothesis or description cache.
  const list = await reachedAnswer(f, 'Show income by merchant in October 2026?');
  assert.equal(list.ledger.groups[0].attribution_state, 'unknown');
  refusal(await reachedAnswer(f, payment('Missing Supplier')));
  refusal(await reachedAnswer(f, 'Did the payment of $26.00 from Supplier One arrive in October 2026?'));
  f.raw('UPDATE fin_transactions SET amount_minor=0');
  for (const form of [payment, income]) {
    const body = await reachedAnswer(f, form('Supplier One'));
    assertExactSelection(body, 0);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_entities').n, 1, 'exact field evidence is not registration');
  }
  f.raw("UPDATE fin_transactions SET amount_minor=2500,posted_on='2026-09-30'");
  f.add('in-window', 'Opaque processor text', null);
  for (const form of [payment, income]) refusal(await reachedAnswer(f, form('Supplier One')));
  f.raw(`INSERT INTO fin_accounts(account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('other-account','owner','checking','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage(account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('other-account','complete','2026-01-01','2026-10-12',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.raw("UPDATE fin_transactions SET posted_on='2026-10-05',account_slug='other-account' WHERE txn_uid='receipt'");
  for (const form of [payment, income]) refusal(await reachedAnswer(f, form('Supplier One').replace(' in October', ' in account 1234 in October')));
  assert.equal((await reachedAnswer(f, payment('Supplier One').replace(' in October', ' in account 5678 in October'))).ledger.found, true);
});

test('unregistered labelled comma fields require the same company comma in the question', async t => {
  const f = single(t);
  f.raw("UPDATE fin_transactions SET description='FROM: Supplier Services, LLC; REF: 48261703'");
  assert.equal((await reachedAnswer(f, payment('Supplier Services, LLC'))).ledger.found, true);
  for (const form of [payment, income]) {
    refusal(await reachedAnswer(f, form('Supplier Services LLC')));
  }
  f.raw("UPDATE fin_transactions SET description='FROM: Supplier Services LLC,'");
  refusal(await reachedAnswer(f, payment('Supplier Services LLC')));
});

test('unregistered absent phrase refuses with bounded masked candidates and no zero', async t => {
  const f = productionFixture(t);
  assert.equal((await reachedAnswer(f, 'Did the payment of $25.00 arrive in October 2026?')).ledger.found, true);
  for (const question of ['Did the payment from Missing Supplier arrive in October 2026?',
    'How much income came from Missing Supplier in October 2026?']) {
    const body = await reachedAnswer(f, question);
    assert.equal(body.ledger.found, null);
    assert.match(body.answer, /found 0 exact matches; 40 deposits I couldn't attribute/i);
    assert.equal(body.ledger.unattributed_count, 40);
    assert.equal(body.ledger.unattributed_candidates.length, 10);
    assert.equal(body.ledger.unattributed_omitted_count, 30);
    assert.equal(body.citations.length, 10);
    assert.ok(body.ledger.unattributed_candidates.every(row => row.reason && row.posted_on && row.amount_minor > 0 && row.citation));
    assert.doesNotMatch(body.answer, /No matching|\$0\.00/);
    assert.ok(!JSON.stringify(body).includes('482617039258001'));
  }
});

test('question generator uses only owned entities, including keyword and punctuation names', async t => {
  const f = single(t), stats = { questions: 0, positive: 0, refused: 0 };
  const names = [...new Set(originatorWords)].flatMap(word => [`Supplier Unit ${word}`, `Supplier Unit, ${word}`, `${word} Supplier Unit`]);
  names.push('Supplier Services Ltd.', 'Supplier Bank, N.A.', 'Supplier & Co.');
  for (const name of names) {
    f.raw('UPDATE fin_transactions SET payee=?,description=?', name, `FROM: ${name}`);
    for (const form of selectorTemplates) for (const exact of [false, true]) {
      const question = form(name).replace('?', exact ? ', exact names only?' : '?');
      // S1 disallows a selector ending in a connector. G2 disallows an
      // unregistered comma except before a company suffix, even in a payee.
      if (/\b(?:from|by|for|in|of)$/.test(name.toLowerCase())) {
        const before = f.documentCalls, reads = f.calls.length;
        const body = await f.ask(question);
        assert.equal(f.documentCalls, before + 1, `unsupported terminal selector reached routing: ${question}`);
        assert.equal(f.calls.length, reads);
        assert.equal(body.ledger, undefined);
        stats.questions++; stats.refused++; continue;
      }
      const body = await reachedAnswer(f, question);
      if (name.includes(',') && !/, (?:LLC|LLP|LP|Inc\.?|Ltd\.?|Corp\.?|Corporation|Co\.?|Company|PLC|PC|PA|N\.A\.|S\.A\.)$/i.test(name)) {
        refusal(body); stats.questions++; stats.refused++; continue;
      }
      assert.equal(body.ledger.found, true, question);
      assert.equal(body.payer_evidence[0].type, 'bank_payee');
      if (body.ledger.kind === 'merchant') assert.equal(body.ledger.total_minor, 2500);
      stats.questions++; stats.positive++;
    }
    // The old "<aux> the payment via <name> <verb>" forms. Partner ruling 4
    // (round 7): ""Via <name>" that isn't a listed channel refuses." Partner
    // ruling 6: ""via wire from <name>" means payer <name>": the old arm for
    // the name "wire from Supplier Unit" names "Supplier Unit", whose exact
    // field this row is not, so it is never found and never certified absent.
    for (const form of unlistedViaTemplates) {
      const question = form(name), intent = classifyLedgerQuestion(question, { now: NOW });
      const named = name.match(/^wire from (.+)$/)?.[1];
      if (!named) { assert.equal(intent.kind, null, question); stats.viaRefused = (stats.viaRefused || 0) + 1; continue; }
      assert.equal(intent.counterparty, named.toLowerCase(), question);
      refusal(await reachedAnswer(f, question)); stats.wireFrom = (stats.wireFrom || 0) + 1;
    }
    refusal(await reachedAnswer(f, payment('Missing Supplier'))); stats.refused++;
  }
  assert.equal(stats.wireFrom, 45, 'one "wire from" name x 45 old via forms');
  assert.equal(stats.viaRefused, (names.length - 1) * 45);
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  assert.ok(stats.positive && stats.refused);
  t.diagnostic(JSON.stringify({ production_question_generator: stats }));
});

test('row generator uses only owned entities for all thirty formats and channel prefixes', async t => {
  const f = single(t), stats = { rows: 0, positive: 0, refused: 0, assumptions: 0 };
  const names = [...new Set(originatorWords)].flatMap(word => [`Supplier Unit ${word} Services`, `${word} Supplier Unit LLC`, `Supplier Unit Services ${word} LLC`]);
  for (const name of names) for (const [index, format] of originatorFormats.entries()) {
    const description = format.replace(/Payer One|Supplier Alias/g, name);
    f.raw('UPDATE fin_transactions SET payee=NULL,description=?', description);
    for (const form of [payment, income]) for (const exact of [false, true]) {
      const body = await reachedAnswer(f, form(name).replace('?', exact ? ', exact names only?' : '?'));
      const assumed = index >= 1 && index <= 3;
      if (normalizeMerchantText(name).split(' ').some(word => ledgerStatementVocabulary.includes(word)) || index === 0 || (assumed && exact)) { refusal(body); stats.refused++; }
      else {
        if (assumed) { assertPossibleMatch(body, 2500); assert.equal(body.assumptions.length, 1); stats.assumptions++; }
        else { assert.equal(body.ledger.found, true, `format ${index}, ${form(name)}`); assert.equal(body.payer_evidence[0].type, 'statement_sender'); }
        stats.positive++;
      }
    }
    stats.rows++;
  }
  for (const prefix of channelPrefixes) {
    f.raw('UPDATE fin_transactions SET description=?', `${prefix} Supplier Unit`);
    const body = await reachedAnswer(f, payment('Supplier Unit'));
    assertPossibleMatch(body, 2500);
    assert.equal(body.assumptions.length, 1);
    assert.match(body.answer, /Note:.*exact names only/);
    assert.ok(body.ledger.flip.includes('exact names only'));
    stats.positive++; stats.assumptions++;
    refusal(await reachedAnswer(f, payment('Supplier Unit').replace('?', ', exact names only?')));
    stats.refused++; stats.rows++;
    f.raw("UPDATE fin_transactions SET description='FROM: Supplier Unit'");
    assert.equal((await reachedAnswer(f, payment('Supplier Unit'))).ledger.found, true); stats.positive++;
  }
  assert.equal(f.first("SELECT COUNT(*) n FROM fin_entities WHERE relationship!='owned'").n, 0);
  assert.ok(stats.positive && stats.refused);
  assert.equal(stats.assumptions, channelPrefixes.length, 'ordinary query-only channel readings retain their assumptions');
  t.diagnostic(JSON.stringify({ production_row_generator: stats }));
});
