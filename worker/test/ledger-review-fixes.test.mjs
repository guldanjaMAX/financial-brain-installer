import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { recordedIntent } from './fixtures/ledger-intent-cases.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { answerText } from '../src/lib/answer-render.js';
import { answerText as appAnswerText } from '../../frontend/src/lib/answer-render.js';
import { plainRouterLimitation } from '../src/lib/ledger-wording.js';
import { createProductFixture } from './product-contract-fixture.mjs';

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
});

async function documentOfferPair(t) {
  t.mock.method(Date, 'now', () => Date.parse('2026-10-11T12:00:00Z'));
  let drafts = 0, verifiers = 0, retrievals = 0;
  let claim = 'Card ending 4242 charged USD 120.00 [1].';
  const f = await createProductFixture({ env: { AI: { async run(model, input) {
    if (model.includes('bge-')) return { data: [[0.1, 0.2, 0.3]] };
    if (String(input.messages?.[0]?.content).includes('verify a proposed answer')) {
      verifiers++;
      return { response: { supported: true, complete: true, evidence: [1], reason: 'fixture approval' } };
    }
    drafts++;
    return { response: claim };
  } } } });
  t.after(() => f.close());
  f.raw("INSERT INTO sources(name,kind,status,created_at) VALUES ('records','bank','ready','2026-10-10')");
  const ingest = await f.post('/api/admin/brain/ingest/batch', { docs: [{
    source_type: 'records', source_id: 'record-one', title: 'Card statement',
    content: 'Card ending 4242 charged USD 120.00 on 2026-10-10.',
    occurred_at: '2026-10-10', date_reliable: true, date_source: 'fixture:record_date',
    text_source: 'native', text_reliable: true,
    metadata: { evidence_lineage: { version: 1, kind: 'source_record' } },
  }] }, { 'X-Admin-Key': f.env.ADMIN_KEY });
  assert.equal(ingest.status, 200);
  assert.equal((await ingest.json()).results[0].status, 'created');
  f.env.VECTORIZE.query = async () => {
    retrievals++;
    return { matches: f.rows('SELECT chunk_uid AS id FROM chunks') };
  };
  const ask = async () => {
    const response = await f.post('/api/rag/think', {
      q: 'What did card ending 4242 charge in the last 60 days?',
    }, { 'X-Admin-Key': f.env.ADMIN_KEY });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.results.length > 0, 'retrieval reached the stored synthetic record');
    assert.ok(body.gaps.some(gap => gap.type === 'ledger_not_consulted'), 'bank limitation decision reached');
    assert.equal(body.ledger, undefined, 'the document renderer branch is exercised');
    assert.equal(body.clarification, undefined);
    assert.equal(body.evidence_gate.supported, true);
    assert.equal(body.citations.length, 1, 'the supported figure retains its citation');
    assert.ok(body.answer.includes(claim));
    return body;
  };
  const green = await ask();
  assert.equal(green.answer, claim);
  assert.equal(green.evidence_gate.complete, true);
  assert.equal(green.gaps.some(gap => gap.type === 'money_veto'), false);
  claim += ' Other payments are unconfirmed.';
  const partial = await ask();
  assert.equal(drafts, 2, 'both arms reached the real draft path');
  assert.equal(verifiers, 2, 'both arms reached the real verification path');
  assert.equal(retrievals, 2, 'both arms reached semantic retrieval');
  assert.equal(partial.evidence_gate.complete, false);
  assert.ok(partial.gaps.some(gap => gap.type === 'money_veto' && gap.rule === 'incomplete_claim'),
    'the independent money limitation decision reached');
  return { green, partial };
}

function documentOfferContract(body, render, expected) {
  const text = render(body);
  assert.match(text, /Card ending 4242 charged USD 120\.00 \[1\]\./);
  assert.ok(text.includes('This answer comes from your documents; I did not match it to your bank data.'));
  assert.ok(text.includes('I want to make sure I get this right. I can show you balances, recent transactions, or what you spent in a set period.'));
  if (!body.evidence_gate.complete) {
    assert.ok(text.includes('Other payments are unconfirmed.'));
    assert.ok(text.includes('some money details are still unconfirmed'));
    assert.ok(text.includes('Some payment details are still unknown in the records checked.'));
  }
  assert.deepEqual(offers(text), [expected], 'one final document offer');
  assert.ok(text.endsWith(expected), 'the invitation follows every fact and qualification');
  return text;
}

test('R3-01 partial document answers retain one final repair offer on both surfaces', async t => {
  const { green, partial } = await documentOfferPair(t);
  for (const [surface, render] of [['worker', answerText], ['app', appAnswerText]]) {
    await t.test(surface, () => {
      documentOfferContract(green, render, 'Which would help most?');
      documentOfferContract(partial, render, 'Want to check the original record?');
      documentOfferContract({ ...partial, answer: `Which would help most?\n${partial.answer}` },
        render, 'Want to check the original record?');
      documentOfferContract({ ...partial,
        answer: `${partial.answer}\nWhich would help most?\nWant to check the original record?` },
      render, 'Want to check the original record?');
    });
  }
});

test('R3-01 restoring document gap appending fails the same contract and keeps its green control', async t => {
  const { green, partial } = await documentOfferPair(t);
  const sources = [new URL('../src/lib/answer-render.js', import.meta.url),
    new URL('../../frontend/src/lib/answer-render.js', import.meta.url)];
  for (const [index, url] of sources.entries()) {
    const render = [answerText, appAnswerText][index];
    const source = readFileSync(url, 'utf8');
    const site = 'const composed = separateOffers(r.answer);';
    assert.equal(source.split(site).length - 1, 1, 'one restoring document decision point');
    const restored = source.replace(site, [
      'if (!r.ledger && !r.clarification) {',
      '  const extra = explanation.split("\\n").filter(line => line && !r.answer.includes(line)).join("\\n");',
      '  return extra ? `${r.answer}\\n\\n${extra}` : r.answer;',
      '}',
      site,
    ].join('\n')).replace(/from (["'])(\.\/.+?)\1/g,
      (_, quote, path) => `from ${quote}${new URL(path, url).href}${quote}`);
    assert.notEqual(restored, source, 'the restoring branch was inserted');
    const mutant = (await import(`data:text/javascript;base64,${Buffer.from(restored).toString('base64')}`)).answerText;
    for (const control of [render, mutant]) documentOfferContract(green, control, 'Which would help most?');
    documentOfferContract(partial, render, 'Want to check the original record?');
    assert.deepEqual(offers(mutant(partial)), ['Which would help most?', 'Want to check the original record?'],
      'the restored branch reached the duplicate-offer decision');
    assert.throws(() => documentOfferContract(partial, mutant, 'Want to check the original record?'), error => {
      assert.ok(error instanceof assert.AssertionError);
      assert.equal(error.message.split('\n')[0], 'one final document offer');
      return true;
    });
  }
});

function fixture(t) {
  const f = ledgerFixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.add('selected', 'Store Unit', 'Store Unit', { cents: 5432, direction: 'outflow' });
  f.add('other', 'Other Unit', 'Other Unit', { cents: 1000, direction: 'outflow' });
  f.add('previous', 'Other Unit', 'Other Unit', { date: '2026-09-07', cents: 2000, direction: 'outflow' });
  f.raw("UPDATE fin_transactions SET category='Materials',category_basis_state='confirmed' WHERE txn_uid='selected'");
  return f;
}

async function ask(f, question, intents, fields = {}, answer = withLedgerAnswer) {
  let extraction = 0, fallback = 0;
  const before = f.calls.length;
  const response = await answer({ env: f.env, question, now: NOW,
    grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      extraction++;
      return { content: [{ type: 'text', text: JSON.stringify({ intents, ...fields }) }] };
    },
  }, async () => {
    fallback++;
    return Response.json({ answer: null, gaps: [] });
  });
  return { body: await response.json(), extraction, fallback, reads: f.calls.length - before };
}

const remainderQuestion = "This month's spending: materials versus everything else?";
const remainderIntents = () => [recordedIntent('category', { vendor_text: 'materials' })];

async function withheldRemainder(f, answer = withLedgerAnswer) {
  const result = await ask(f, remainderQuestion, remainderIntents(), {}, answer);
  assert.equal(result.extraction, 1, 'the exact request reached extraction');
  assert.ok(result.reads > 0, 'the real reader ran');
  assert.equal(result.fallback, 0);
  assert.equal(result.body.ledger.classification_complete, false, 'the account review decision ran');
  assert.equal(result.body.ledger.total_minor, null, 'the expense total was withheld');
  assert.equal(result.body.ledger.remainder, undefined, 'a withheld total must not yield a numeric remainder');
  assert.doesNotMatch(result.body.answer, /all other recorded ordinary spending:/);
  assert.match(result.body.answer, /account types.*have not been confirmed/);
  return result;
}

test('RANGE-01 unknown expense classification withholds remainder arithmetic', async t => {
  const f = fixture(t);
  const green = await ask(f, remainderQuestion, remainderIntents());
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.deepEqual(green.body.ledger.remainder, { selector: 'materials', selected_minor: 5432, remainder_minor: 1000 });
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither'");
  await withheldRemainder(f);
});

test('RANGE-01 a category with a withheld total cannot display a zero expense figure', async t => {
  const f = fixture(t);
  // Keep this account-type probe independent of unknown category membership.
  f.raw("UPDATE fin_transactions SET category='Other',category_basis_state='confirmed' WHERE txn_uid='other'");
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE direction='outflow' AND posted_on LIKE '2026-10-%' AND category IS NULL").n, 0);
  const question = 'Could you retrieve expenses for materials this month?';
  const intents = [recordedIntent('merchant', { direction: 'outflow', vendor_text: 'materials' })];
  const green = await ask(f, question, intents);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.body.ledger.total_minor, 5432);
  assert.match(green.body.answer, /Category 'materials': \$54\.32/);
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither'");
  const bad = await ask(f, question, intents);
  assert.equal(bad.extraction, 1);
  assert.ok(bad.reads > 0);
  assert.equal(bad.body.ledger.category_selector, 'materials', 'the category decision ran');
  assert.equal(bad.body.ledger.total_minor, null);
  assert.equal(bad.body.ledger.classification_complete, false);
  assert.doesNotMatch(bad.body.answer, /Category 'materials': \$0\.00/);
  assert.match(bad.body.answer, /account types.*have not been confirmed/);
});

test('RANGE-02 a missing balance cannot acquire a claim that balances are shown', async t => {
  const f = fixture(t);
  const question = 'Could you retrieve bank balances and what does that balance mean?';
  const intents = [recordedIntent('balance')];
  const fields = { ambiguous: false, unanswered_part: 'what does that balance mean' };
  const green = await ask(f, question, intents, fields);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.body.ledger.kind, 'balance');
  assert.equal(green.body.ledger.accounts.length, 1, 'the same request can show a real balance');
  assert.equal(green.body.citations.length, 1);
  assert.match(green.body.answer, /\$0\.00 as of October 12;/);
  f.raw('DELETE FROM fin_balance_snapshots');
  const bad = await ask(f, question, intents, fields);
  assert.equal(bad.extraction, 1);
  assert.ok(bad.reads > 0, 'the missing balance reached the real reader');
  assert.equal(bad.fallback, 0);
  assert.equal(bad.body.ledger, null);
  assert.deepEqual(bad.body.citations, []);
  assert.equal(bad.body.gaps[0].reason, 'balance_unavailable', 'the refusal decision ran');
  assert.doesNotMatch(bad.body.answer, /Here are the recorded balances;/);
  assert.match(bad.body.answer, /I can help review what a recorded balance means, but bank transactions alone do not establish that meaning\./);
  assert.equal(offers(bad.body.answer).length, 1);
  assert.ok(bad.body.answer.endsWith('Want help refreshing the bank connection?'));
  assert.equal(bad.body.clarification.question, 'Want help refreshing the bank connection?');
});

const offers = text => text.match(/\b(?:Want[^?]*\?|Which[^?]*\?|If you tell me[^\n]*)/g) || [];

function finalOffer(body, expected = offers(body.answer)[0]) {
  for (const render of [value => value.answer, answerText, appAnswerText]) {
    const text = render(body);
    assert.deepEqual(offers(text), [expected], 'final text has the selected offer exactly once');
    assert.ok(text.endsWith(expected), 'the selected offer follows all facts and limitations');
  }
}

test('RANGE-03 a composed answer ends with one offer', async t => {
  const f = fixture(t);
  const green = await f.ask('What are my account balances?');
  assert.equal(green.ledger.kind, 'balance');
  assert.equal(offers(green.answer).length, 1);
  const composed = await ask(f, 'Could you retrieve bank balances?', [recordedIntent('balance')]);
  assert.equal(composed.extraction, 1);
  assert.ok(composed.reads > 0);
  assert.equal(composed.body.ledger.kind, 'balance');
  assert.equal(offers(composed.body.answer).length, 1, 'the fully composed answer must have one next-step offer');
  assert.equal(composed.body.clarification.question, 'Want to choose the dates or account that would help most?');
  assert.ok(composed.body.answer.endsWith(composed.body.clarification.question));
});

test('RANGE-01 the unguarded subtraction mutant fails the same contract with a green control', async t => {
  const base = new URL('../src/lib/', import.meta.url);
  const source = readFileSync(new URL('ledger-answer.js', base), 'utf8');
  const guarded = 'if (intent.remainderSelector && result.ledger.classification_uncertain === false && Number.isSafeInteger(result.ledger.total_minor)) {';
  assert.equal(source.split(guarded).length - 1, 1, 'one restoring subtraction decision point');
  const changed = source.replace(guarded, 'if (intent.remainderSelector) {').replace(/from (["'])(\.\/.+?)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
  const mutant = (await import(`data:text/javascript;base64,${Buffer.from(changed).toString('base64')}`)).withLedgerAnswer;
  const f = fixture(t);
  for (const answer of [withLedgerAnswer, mutant]) {
    const green = await ask(f, remainderQuestion, remainderIntents(), {}, answer);
    assert.equal(green.extraction, 1);
    assert.ok(green.reads > 0);
    assert.deepEqual(green.body.ledger.remainder, { selector: 'materials', selected_minor: 5432, remainder_minor: 1000 });
  }
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither'");
  await withheldRemainder(f);
  await assert.rejects(() => withheldRemainder(f, mutant), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.message.split('\n')[0], 'a withheld total must not yield a numeric remainder');
    assert.equal(error.actual.remainder_minor, -5432);
    return true;
  });
});

test('RANGE-01 a legitimate partition retains its partial coverage disclosure', async t => {
  const f = fixture(t);
  const green = await ask(f, remainderQuestion, remainderIntents());
  assert.deepEqual(green.body.ledger.remainder, { selector: 'materials', selected_minor: 5432, remainder_minor: 1000 });
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('uncovered','owner','savings','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  const partial = await ask(f, remainderQuestion, remainderIntents());
  assert.equal(partial.extraction, 1);
  assert.ok(partial.reads > 0);
  assert.equal(partial.body.ledger.coverage.omitted_account_count, 1, 'the coverage exclusion decision ran');
  assert.equal(partial.body.ledger.complete, false);
  assert.equal(partial.body.ledger.classification_uncertain, false);
  assert.deepEqual(partial.body.ledger.remainder, green.body.ledger.remainder);
  assert.match(partial.body.answer, /partial view using 1 of 2 accounts/);
  assert.match(partial.body.answer, /all other recorded ordinary spending: \$10\.00/);
  assert.equal(offers(partial.body.answer).length, 1);
});

test('RANGE-01 safe integer subtotals still require confirmed account roles before deriving figures', async t => {
  const f = fixture(t);
  // The category control needs complete membership before account-role checks.
  f.raw("UPDATE fin_transactions SET category='Other',category_basis_state='confirmed' WHERE txn_uid='other'");
  assert.equal(f.first("SELECT count(*) n FROM fin_transactions WHERE direction='outflow' AND posted_on LIKE '2026-10-%' AND category IS NULL").n, 0);
  f.add('refund', 'REFUND settlement', 'Outside Unit', { cents: 500 });
  const cases = [
    [remainderQuestion, remainderIntents(), 'remainder', /all other recorded ordinary spending:/],
    ["Could you retrieve this month's spending after refunds?",
      [recordedIntent('merchant', { direction: 'outflow', vendor_text: 'refunds' })],
      'net_expense_minor', /Ordinary expenses less inflows/],
    ['Could you retrieve expenses for materials this month?',
      [recordedIntent('merchant', { direction: 'outflow', vendor_text: 'materials' })],
      null, /Category 'materials':/],
  ];
  for (const [question, intents, key, sentence] of cases) {
    const green = await ask(f, question, intents);
    assert.equal(green.extraction, 1);
    assert.ok(green.reads > 0);
    assert.equal(green.body.ledger.classification_uncertain, false);
    assert.match(green.body.answer, sentence);
    if (key) assert.notEqual(green.body.ledger[key], undefined);
  }
  f.raw("UPDATE fin_accounts SET balance_role='liability'");
  for (const [question, intents, key, sentence] of cases) {
    const bad = await ask(f, question, intents);
    assert.equal(bad.extraction, 1);
    assert.ok(bad.reads > 0);
    assert.equal(bad.fallback, 0);
    assert.equal(bad.body.ledger.classification_uncertain, true, 'the account-role decision ran');
    assert.ok(Number.isSafeInteger(bad.body.ledger.total_minor), 'integer availability alone cannot authorize a figure');
    if (key) assert.equal(bad.body.ledger[key], undefined);
    assert.doesNotMatch(bad.body.answer, sentence);
    assert.match(bad.body.answer, /account types.*have not been confirmed/);
  }
});

test('RANGE-02 every limitation helper is result-neutral and has one offer', () => {
  const expected = {
    balance_meaning: 'I can help review what a recorded balance means, but bank transactions alone do not establish that meaning.',
    custom_grouping: 'I can help review recorded bank categories, but a custom grouping has not been added.',
    extra_part: 'I can help review completed bank transactions, but the extra part is still unanswered.',
    reading_unavailable: 'I can help check the bank connection, but the records needed to confirm a figure are unavailable.',
  };
  for (const [reason, text] of Object.entries(expected)) {
    const result = plainRouterLimitation(reason);
    assert.equal(result, `${text}\nWant me to show your account balances?`);
    assert.doesNotMatch(result, /Here (?:are|is)|I found/);
    assert.equal(offers(result).length, 1);
  }
  assert.equal(plainRouterLimitation('unknown'), plainRouterLimitation('reading_unavailable'));
});

test('RANGE-03 multiple readings keep facts and limitations before one clarification offer', async t => {
  const f = fixture(t);
  const green = await ask(f, 'Could you retrieve bank balances?', [recordedIntent('balance')]);
  assert.equal(green.body.ledger.kind, 'balance');
  assert.ok(green.reads > 0);
  const result = await ask(f, 'Could you compare expenses this month against last month?', [
    recordedIntent('expense_summary'), recordedIntent('expense_summary', { period: { type: 'last_month' } }),
  ]);
  assert.equal(result.extraction, 1);
  assert.ok(result.reads > 0);
  assert.equal(result.body.ledger.kind, 'multi', 'both readings reached composition');
  assert.equal(result.body.ledger.parts.length, 2);
  assert.deepEqual(result.body.ledger.comparison, { figures_minor: [6432, 2000], difference_minor: 4432 });
  assert.match(result.body.answer, /pending activity is not included/);
  assert.equal(offers(result.body.answer).length, 1);
  assert.ok(result.body.answer.endsWith('Want to choose the dates or account that would help most?'));
});

test('R2 offer selection also covers direct expense answers', async t => {
  const f = fixture(t);
  const question = 'What did I spend this month?';
  const start = f.calls.length;
  const green = await f.ask(question);
  assert.ok(f.calls.length > start);
  assert.equal(green.ledger.kind, 'expense_summary');
  assert.equal(green.ledger.total_minor, 6432);
  assert.equal(offers(green.answer).length, 1);
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither'");
  const before = f.calls.length;
  const bad = await f.ask(question);
  assert.ok(f.calls.length > before, 'the real reader ran');
  assert.equal(bad.ledger.classification_complete, false, 'the classification decision ran');
  assert.equal(bad.ledger.total_minor, null);
  assert.equal(offers(bad.answer).length, 1, 'direct answer has exactly one offer');
  assert.match(bad.answer, /account types.*have not been confirmed/);
  assert.match(bad.answer, /pending activity is not included/);
  assert.equal(bad.citations.length, green.citations.length, 'classification keeps every evidence reference');
  finalOffer(green);
  finalOffer(bad);
});

test('R2 empty exact payment does not acquire a successful match claim', async t => {
  const f = fixture(t);
  f.add('payout', 'Receipt Unit', 'Receipt Unit', { cents: 7654 });
  const question = 'Could you retrieve a likely payout of $76.54 after fees this month?';
  const intents = [recordedIntent('totals', { direction: 'inflow', amount_text: '$76.54' })];
  const green = await ask(f, question, intents);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.body.ledger.kind, 'payment');
  assert.equal(green.body.ledger.found, true);
  assert.equal(green.body.citations.length, 1);
  assert.match(green.body.answer, /Found a deposit of \$76\.54/);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='payout'");
  const bad = await ask(f, question, intents);
  assert.equal(bad.extraction, 1);
  assert.ok(bad.reads > 0, 'the exact-payment reader ran');
  assert.equal(bad.fallback, 0);
  assert.equal(bad.body.ledger.kind, 'payment');
  assert.equal(bad.body.ledger.found, false, 'the no-match decision ran');
  assert.deepEqual(bad.body.citations, []);
  assert.match(bad.body.answer, /found no matching completed deposit/);
  t.diagnostic(JSON.stringify({ found: bad.body.ledger.found,
    claim: bad.body.answer.split('\n').find(line => line.startsWith('Here are exact')) }));
  assert.doesNotMatch(bad.body.answer, /Here are exact-amount matches/);
  for (const result of [green, bad]) {
    assert.match(result.body.answer, /This lookup checks exact amounts only; payouts changed by fees are not inferred\./);
    assert.match(result.body.answer, /pending activity is not included/);
    finalOffer(result.body);
  }
});

test('R2 rendered clarification does not restore removed gap offers', async t => {
  const f = fixture(t);
  const question = 'Could you retrieve recent transactions this month?';
  const intents = [recordedIntent('transactions', { direction: 'both', count: 5 })];
  const green = await ask(f, question, intents);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.body.ledger.kind, 'transactions');
  assert.equal(offers(answerText(green.body)).length, 1);
  assert.equal(offers(appAnswerText(green.body)).length, 1);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-03'");
  const bad = await ask(f, question, intents);
  assert.equal(bad.extraction, 1);
  assert.ok(bad.reads > 0, 'the partial-coverage reader ran');
  assert.equal(bad.fallback, 0);
  assert.equal(bad.body.ledger.partial_reason, 'ledger_partial_coverage', 'coverage decision ran');
  assert.ok(bad.body.gaps.some(gap => gap.reason === 'ledger_partial_coverage'));
  assert.equal(offers(bad.body.answer).length, 1, 'server composer has one offer');
  const rendered = answerText(bad.body);
  t.diagnostic(JSON.stringify({ serverOffers: offers(bad.body.answer), renderedOffers: offers(rendered) }));
  const counts = [offers(rendered).length, offers(appAnswerText(bad.body)).length];
  t.diagnostic(JSON.stringify({ workerAndAppOfferCounts: counts }));
  assert.deepEqual(counts, [1, 1], 'both renderers must preserve the single selected offer');
  for (const result of [green, bad]) finalOffer(result.body, result.body.clarification.question);
  for (const render of [answerText, appAnswerText]) {
    assert.match(render(bad.body), /some days may be missing, so the list or ranking may be incomplete/);
    assert.match(render(bad.body), /I found 2 completed transactions; this is a partial list that may not include your latest 5 transactions because the saved bank history may be incomplete\./);
    assert.match(render(bad.body), /\[1\]/);
    assert.match(render(bad.body), /\[2\]/);
  }
});

test('R2 empty transaction list cannot claim completed transactions are presented', async t => {
  const f = fixture(t);
  const question = 'Could you retrieve recent transactions this month?';
  const intents = [recordedIntent('transactions', { direction: 'both', count: 5 })];
  const green = await ask(f, question, intents);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.body.ledger.kind, 'transactions');
  assert.equal(green.body.ledger.rows.length, 2);
  assert.equal(green.body.citations.length, 2);
  assert.match(green.body.answer, /Newest 2 transactions/);
  f.raw('DELETE FROM fin_transactions');
  const bad = await ask(f, question, intents);
  assert.equal(bad.extraction, 1);
  assert.ok(bad.reads > 0, 'the transaction reader ran');
  assert.equal(bad.fallback, 0);
  assert.equal(bad.body.ledger.rows.length, 0, 'the empty-list decision ran');
  assert.deepEqual(bad.body.citations, []);
  assert.match(bad.body.answer, /no readable transactions were found/);
  t.diagnostic(JSON.stringify({ rows: bad.body.ledger.rows.length,
    claim: bad.body.answer.split('\n').find(line => line.startsWith('Here are the completed')) }));
  assert.doesNotMatch(bad.body.answer, /Here are the completed transactions on record/);
  for (const result of [green, bad]) {
    assert.match(result.body.answer, /This reading covers completed transactions only; pending activity is not included\./);
    finalOffer(result.body);
  }
});

for (const [question, intent, fact, obsolete] of [
  ['Could you retrieve Store Unit spending this month, including refunds separately?',
    recordedIntent('merchant', { direction: 'outflow', vendor_text: 'Store Unit' }),
    'Store refunds are not split out in this view.', 'Here is the recorded spending;'],
  ['Could you retrieve Store Unit spending after refunds this month?',
    recordedIntent('merchant', { direction: 'outflow', vendor_text: 'Store Unit' }),
    "I cannot confirm spending after refunds because these records do not show which deposits are refunds from this business. The amounts below are before subtracting refunds.",
    'Here is the recorded spending before refunds;'],
  ['Could you retrieve expenses this month by payee?', recordedIntent('expense_summary'),
    'A payee breakdown is not available in this view.', 'Here is the category summary;'],
  ['Could you retrieve software recurring charges?', recordedIntent('recurring', { vendor_text: 'software' }),
    'This recurring-charge reading has not been narrowed by category.', 'Here is the recurring list'],
]) test(`R2 adjacent notices stay neutral for populated and empty readings: ${intent.kind}/${intent.vendor_text || 'all'}`, async t => {
  const f = fixture(t);
  for (const [id, date] of [['repeat-a', '2026-08-07'], ['repeat-b', '2026-09-07'], ['repeat-c', '2026-10-07']]) {
    f.add(id, 'Software Unit', 'Software Unit', { date, cents: 800, direction: 'outflow' });
  }
  const green = await ask(f, question, [intent]);
  assert.equal(green.extraction, 1);
  assert.ok(green.reads > 0);
  assert.equal(green.fallback, 0);
  assert.ok(green.body.citations.length > 0, 'populated reading has real evidence');
  f.raw('DELETE FROM fin_transactions');
  const empty = await ask(f, question, [intent]);
  assert.equal(empty.extraction, 1);
  assert.ok(empty.reads > 0, 'empty reading reached the real reader');
  assert.equal(empty.fallback, 0);
  assert.equal(empty.body.ledger.kind, green.body.ledger.kind, 'the same reader decision ran');
  assert.deepEqual(empty.body.citations, []);
  for (const { body } of [green, empty]) {
    assert.ok(body.answer.includes(fact), 'the complete factual limitation is retained');
    assert.equal(body.answer.includes(obsolete), false);
    finalOffer(body);
  }
});

for (const [question, kind, fact] of [
  ['How much money came in in October 2026?', 'totals',
    'Income is still unconfirmed; a deposit can be a transfer or another kind of credit, and the bank label alone does not prove its source.'],
  ['Show income by merchant in October 2026?', 'merchant',
    'Bank payee names may not identify who paid, so the sender of every deposit is still unconfirmed.'],
]) test(`R2 direct ${kind} notices preserve qualifications on an empty reading`, async t => {
  const f = fixture(t);
  f.add('receipt', 'Receipt Unit', 'Receipt Unit', { cents: 7654 });
  const before = f.calls.length;
  const green = await f.ask(question);
  assert.ok(f.calls.length > before);
  assert.equal(green.ledger.kind, kind);
  assert.ok(green.citations.length > 0);
  f.raw('DELETE FROM fin_transactions');
  const emptyStart = f.calls.length;
  const empty = await f.ask(question);
  assert.ok(f.calls.length > emptyStart, 'the empty reader decision ran');
  assert.equal(empty.ledger.kind, kind);
  assert.deepEqual(empty.citations, []);
  assert.equal(empty.ledger.income_established ?? empty.ledger.attribution_incomplete,
    kind === 'totals' ? false : true, 'the income limitation decision ran');
  for (const body of [green, empty]) {
    assert.ok(body.answer.includes(fact));
    assert.doesNotMatch(body.answer, /Here are the deposits I found|Here are the names from your bank/);
    finalOffer(body);
  }
});

test('R2 a transfer notice describes the check when no pairs are found', async t => {
  const f = fixture(t);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('reserve','owner','savings','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('reserve','complete','2026-10-01','2026-10-31',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.add('move-out', 'TRANSFER TO ACCOUNT 5678', null, { cents: 2500, direction: 'outflow' });
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
    VALUES ('move-in','reserve','2026-10-05',2500,'inflow','TRANSFER FROM ACCOUNT 1234','owner_stated','confirmed',?)`, NOW);
  const question = 'Show my own-account transfers in October 2026?';
  const before = f.calls.length;
  const green = await f.ask(question);
  assert.ok(f.calls.length > before);
  assert.equal(green.ledger.kind, 'transfers');
  assert.equal(green.ledger.found, true);
  assert.equal(green.citations.length, 2);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid IN ('move-out','move-in')");
  const emptyStart = f.calls.length;
  const empty = await f.ask(question);
  assert.ok(f.calls.length > emptyStart, 'the transfer reader ran');
  assert.equal(empty.ledger.found, false, 'the no-pair decision ran');
  assert.deepEqual(empty.ledger.transfers, []);
  assert.deepEqual(empty.citations, []);
  for (const body of [green, empty]) {
    assert.match(body.answer, /This reading checks possible moves with enough account details to review; matching amounts alone do not confirm transfers, and no matches does not prove none occurred\./);
    assert.doesNotMatch(body.answer, /Here are possible moves/);
    finalOffer(body);
  }
});
