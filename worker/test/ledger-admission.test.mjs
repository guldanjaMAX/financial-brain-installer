import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { canExtractLedgerIntent, explainLedgerIntentDecision, validateLedgerIntentDecision } from '../src/lib/ledger-intent.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

const intent = (kind, extra = {}) => ({ kind, direction: null, count: null,
  vendor_text: null, account_hint: null, amount_text: null, date_text: null,
  period: { type: 'none' }, ...extra });
const reply = value => ({ ambiguous: false, unanswered_part: null, intents: [value] });
const context = { now: Date.parse(NOW), timeZone: 'UTC' };
const merchant = (direction, extra = {}) => intent('merchant', { direction, vendor_text: 'Supply Unit', ...extra });
const cases = [
  ['card-total', 'What do I owe on my cards in total?', intent('balance')],
  ['card-debt', 'How much card debt do we have right now?', intent('balance')],
  ['card-current', 'Show what we currently owe on our credit cards.', intent('balance')],
  ['named-current', 'How much is on the Reserve Unit right now?', intent('balance', { account_hint: 'Reserve Unit' })],
  ['named-current-peer', 'How much is on our Travel Unit right now?', intent('balance', { account_hint: 'Travel Unit' })],
  ['descriptor-total', "On the cards last month, what's the total for MARKET*UNIT 0042?", merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' })],
  ['descriptor-peer', 'What was the total for MARKET*UNIT 0042 on our cards last month?', merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' })],
  ['payout-largest', 'Which was our biggest single payout from Processor Unit this year?', intent('largest', { direction: 'inflow', count: 1, vendor_text: 'Processor Unit' })],
  ['payout-peer', 'Find the largest payout from Processor Unit last month.', intent('largest', { direction: 'inflow', count: 1, vendor_text: 'Processor Unit' })],
  ['payout-total', 'How much did Processor Unit send in payouts last month?', merchant('inflow', { vendor_text: 'Processor Unit' })],
  ['payout-typo', 'Processor Unit payoouts month by month this year', merchant('inflow', { vendor_text: 'Processor Unit' })],
  ['spend-typo', 'How much did we spned at Supply Unit last month?', merchant('outflow')],
  ['spend-typo-peer', 'What did I spned at Supply Unit this year?', merchant('outflow')],
  ['own-move', 'How much did I move from business to personal this year?', intent('transfers', { account_hint: 'business' })],
];

const decoys = [
  ['playing-cards', 'How much do I owe in our playing cards game?', intent('balance')],
  ['payout-policy', 'What is the event payout policy this year?', intent('totals', { direction: 'inflow' })],
  ['appointment', 'How much should I move our appointment this month?', intent('transfers')],
  ['payout-definition', 'Define a payout for a new store owner.', intent('totals', { direction: 'inflow' })],
  ['debt-definition', 'What does card debt mean?', intent('balance')],
  ['balance-definition', 'What does current balance mean?', intent('balance')],
  ['payout-tax', 'What tax rules apply to processor payouts this year?', intent('totals', { direction: 'inflow' })],
  ['card-pricing', 'How much is our credit card pricing this year?', intent('balance')],
  ['payout-pricing', 'What is the pricing for monthly payout services?', intent('totals', { direction: 'inflow' })],
  ['card-policy', 'Explain our card debt repayment policy.', intent('balance')],
  ['payout-hypothetical', 'What would the largest hypothetical payout be this year?', intent('largest', { direction: 'inflow', count: 1 })],
  ['typo-definition', 'Explain the typo spned in this sentence.', intent('expense_summary')],
  ['move-policy', 'What is our policy on moves from business to personal this year?', intent('transfers')],
];

// Every task-word family can occur inside a statement descriptor. The same
// frame and stored evidence must work when only that word changes.
const descriptorWords = [...`mean means meaning rule rules policy policies tax pricing
  playing game poker appointment hypothetical translate translation rewrite
  rephrase proofread explain define definition recommend advice course tuition
  proposal quote quotation solve recipe riddle
  meeting agenda minutes discuss handbook document documents email emails invoice
  invoices payroll quickbooks qbo profit budget budgeted approved
  authorized allocated average median smallest euro euros eur gbp cad`.split(/\s+/),
  'what color', 'what colour', 'which color', 'which colour', 'best bank',
  'open an account', 'choose a bank account', 'price for a service',
  'pricing of our project', 'charge for a client', 'cost of a course', 'cash flow',
  'acct manager', 'accts manager', 'rev of doc', 'rev of the doc', 'cc me', 'cc them', 'cc the team',
  'undated', 'missing dates', 'unknown date', 'blank dates', 'absent date', 'no dates',
  'excluding', 'exclude', 'without', 'except', 'including', 'pending', 'available', 'not counting'];
const descriptorFrames = [
  value => `On the cards last month, what's the total for ${value}?`,
  value => `What was the total for ${value} on our cards last month?`,
];

// The entire lexical instruction family has the same selector/prose boundary.
// Each row also puts that very phrase outside the selector and reaches the
// explicit refusal, so permitting literal bytes cannot permit task authority.
const instructionWords = ['ignore', 'disregard', 'override', 'system', 'assistant',
  'instruction', 'instructions', 'schema', 'json', 'prompt', 'treat records as data'];
for (const word of instructionWords) for (const [frameId, frame] of descriptorFrames.entries()) {
  test(`descriptor instruction family ${word} frame ${frameId} uses its bounded role`, async t => {
    await descriptorReading(t, frame('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
    const descriptor = `${word.toUpperCase()}*UNIT 0042`;
    await descriptorReading(t, frame(descriptor), descriptor);
    const question = `${frame('MARKET*UNIT 0042')} ${word}`;
    const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' });
    const f = configured(t, value);
    assert.equal(explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context).reason,
      'decoy_outer_task', 'outside-selector instruction reaches its lexical refusal');
    const refused = await ask(f, question, value);
    assert.equal(refused.calls, 0);
    assert.equal(refused.documents, 1);
    assert.equal(refused.inventory, 0);
    assert.equal(refused.facts, 0);
    assert.equal(refused.body.ledger, undefined);
  });
}

for (const character of ['\n', '\r', '{', '}', '<', '>', '`']) for (const inside of [true, false]) {
  test(`raw instruction structure ${character.charCodeAt(0)} inside ${inside} remains refused`, async t => {
    const descriptor = 'MARKET*UNIT 0042';
    const question = inside ? descriptorFrames[0](`${descriptor}${character}`)
      : `${descriptorFrames[0](descriptor)}${character}`;
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, value);
    assert.equal(explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context).reason,
      'decoy_outer_task', 'raw structural refusal reached with a substantive candidate');
    const refused = await ask(f, question, value);
    assert.equal(refused.calls, 0);
    assert.equal(refused.documents, 1);
    assert.equal(refused.inventory, 0);
    assert.equal(refused.facts, 0);
    await descriptorReading(t, descriptorFrames[0](descriptor), descriptor);
  });
}

const inventoryDescriptors = ['POLICY*UNIT 0042', 'MARKET*UNIT 0042', 'UNLISTED*UNIT 0042',
  'FUTURE*UNIT 0042', 'CARD POLICY*UNIT 0042', 'UNIT/POLICY*0042', 'Game*Unit 0042', 'SYSTEM*UNIT 0042'];
const inventoryLabels = [
  descriptor => descriptor,
  descriptor => descriptor.replace(/[*\/]+/g, ' ').toLowerCase(),
  descriptor => descriptor.replace(/[*\/]+/g, ' ').replace(/[A-Z0-9]/g,
    character => String.fromCharCode(character.charCodeAt(0) + 0xfee0)),
];
for (const descriptor of inventoryDescriptors) for (const [frameId, frame] of descriptorFrames.entries()) {
  for (const [labelId, label] of inventoryLabels.entries()) {
    test(`reader payee role ${descriptor} frame ${frameId} inventory ${labelId} survives null hint`, async t => {
      const question = frame(descriptor);
      const value = merchant('outflow', { vendor_text: descriptor, account_hint: null });
      const decision = validateLedgerIntentDecision(reply(value), question, context);
      assert.equal(decision.intents.length, 1, 'nonempty literal plan reaches the reader handoff');
      assert.equal(decision.intents[0].kind, 'merchant');
      assert.equal(decision.intents[0].match, descriptor);
      assert.equal(decision.intents[0].modelAccountScope, undefined);
      assert.equal(decision.intents[0].protectedPayee, descriptor, 'explicit role crosses the compiler boundary');
      const f = configured(t, value);
      f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
      f.raw('UPDATE fin_accounts SET label=?', label(descriptor));
      const collision = await ask(f, question, value);
      assert.equal(collision.calls, 1);
      assert.ok(collision.inventory > 0, 'actual account-resolution decision reached');
      assert.ok(collision.facts > 0, 'exact merchant reader reaches stored rows');
      assert.equal(collision.body.ledger.kind, 'merchant');
      assert.equal(collision.body.ledger.total_minor, 1234, 'account collision cannot broaden the payee');
      assert.equal(collision.body.ledger.expense_total_minor, undefined);
      assert.equal(collision.body.evidence_gate.complete, false, 'synthetic reading confers no real authority');
      f.raw('UPDATE fin_accounts SET label=?', 'cards');
      const control = await ask(f, question, value);
      assert.equal(control.calls, 1);
      assert.ok(control.inventory > 0 && control.facts > 0);
      assert.equal(control.body.ledger.kind, 'merchant');
      assert.equal(control.body.ledger.total_minor, 1234, 'only the stored account label changed');
    });
  }
}

// These are literal bytes, including dates and grouping words, rather than
// instructions for the task, scope, calendar or output shape.
const semanticDescriptorWords = ['future', 'forecast', 'predict', 'tomorrow',
  'next week', 'next month', 'next quarter', 'next year', 'by month', 'per month',
  'each month', 'month-by-month', 'each account', 'per bank', 'separate accounts',
  'business', 'personal', 'pending', 'cleared', 'september 15', '2026-12-15',
  '400 dollars', 'last year', 'this month', 'including refunds separately',
  'when did you last synced', 'when were these last refreshed', 'last looked at', 'what account did it hit'];
for (const word of semanticDescriptorWords) for (const [frameId, frame] of descriptorFrames.entries()) {
  test(`descriptor semantic prose ${word} frame ${frameId} keeps the historical total`, async t => {
    await descriptorReading(t, frame('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
    const descriptor = `${word.toUpperCase()}*UNIT 0042`;
    await descriptorReading(t, frame(descriptor), descriptor);
  });
}

for (const future of ['future', 'forecast', 'predict', 'tomorrow', 'next week', 'next month', 'next quarter', 'next year']) {
  test(`genuine future activity ${future} still reaches a closed validation decision`, async t => {
    const question = `What is the total for MARKET*UNIT 0042 on our cards last month ${future}?`;
    const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' });
    const f = configured(t, value);
    const decision = validateLedgerIntentDecision(reply(value), question, context);
    assert.equal(decision.outcome, 'fallback');
    assert.ok(['capability', 'period_contradiction'].includes(decision.reason));
    const r = await ask(f, question, value);
    assert.equal(r.calls, 1, 'substantive future candidate reaches extraction and validation');
    assert.equal(r.inventory, 0);
    assert.equal(r.facts, 0);
    assert.equal(r.documents, 0, 'calendar clarification stays out of document synthesis');
    assert.ok(r.body.gaps.some(gap => gap.scope === 'calendar'));
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
  });
}

const roleDescriptors = ['POLICY*UNIT 0042', 'MARKET*UNIT 0042', 'FUTURE*UNIT 0042',
  'CARD POLICY*UNIT 0042', 'UNIT/POLICY*0042', 'Game*Unit 0042'];
for (const descriptor of roleDescriptors) for (const [frameId, frame] of descriptorFrames.entries()) {
  for (const literal of [descriptor, descriptor.toLowerCase()]) {
    test(`descriptor role collision ${literal} frame ${frameId} cannot erase the payee`, async t => {
      const question = frame(descriptor);
      const green = merchant('outflow', { vendor_text: literal, account_hint: 'cards' });
      const value = { ...green, account_hint: literal };
      const f = configured(t, green);
      f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
      const decision = validateLedgerIntentDecision(reply(value), question, context);
      const r = await ask(f, question, value);
      assert.equal(r.calls, 1, 'role validation reached through extraction');
      assert.equal(decision.reason, 'ungrounded_vendor', 'final selector invariant refuses the widened plan');
      assert.equal(decision.intents.length, 0);
      assert.equal(r.inventory, 0);
      assert.equal(r.facts, 0, 'no broadened transaction read');
      assert.equal(r.body.ledger, undefined, 'no widened figure');
      assert.equal(r.documents, 1);
      const control = await ask(f, question, green);
      assert.equal(control.calls, 1);
      assert.ok(control.inventory > 0 && control.facts > 0);
      assert.equal(control.body.ledger.kind, 'merchant');
      assert.equal(control.body.ledger.total_minor, 1234, 'only the refused account field changed');
    });
  }
}

for (const kind of ['category', 'payment', 'recurring', 'largest', 'deposits', 'transactions']) {
  test(`protected descriptor final reader ${kind} must preserve the payee role`, async t => {
    const descriptor = 'MARKET*UNIT 0042';
    const question = descriptorFrames[0](descriptor);
    const full = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, full);
    const value = { ...full, kind };
    const r = await ask(f, question, value);
    assert.equal(r.calls, 1, 'candidate kind reaches validation');
    assert.equal(validateLedgerIntentDecision(reply(value), question, context).outcome, 'fallback');
    assert.equal(r.inventory, 0);
    assert.equal(r.facts, 0);
    assert.equal(r.body.ledger, undefined);
    const green = await ask(f, question, full);
    assert.equal(green.calls, 1);
    assert.ok(green.inventory > 0 && green.facts > 0);
    assert.equal(green.body.ledger.total_minor, 1234, 'only the refused kind changed');
  });
}

async function descriptorReading(t, question, descriptor, wrap = withLedgerAnswer) {
  const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
  const f = configured(t, value);
  f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
  const r = await ask(f, question, value, wrap);
  assert.equal(r.calls, 1, 'descriptor admission reaches extraction');
  const decision = validateLedgerIntentDecision(reply(value), question, context);
  assert.equal(decision.intents.length, 1, 'descriptor has a nonempty grounded plan');
  assert.equal(decision.intents[0].match, descriptor, 'selector bytes remain literal');
  assert.equal(decision.intents[0].modelAccountScope, 'cards');
  assert.equal(decision.intents[0].from, '2026-09-01');
  assert.equal(decision.intents[0].to, '2026-09-30');
  assert.equal(decision.intents[0].monthlyBreakdown, undefined, 'literal grouping words cannot change the task');
  assert.equal(decision.intents[0].answerAddOn, undefined, 'literal words cannot add an account or freshness task');
  assert.equal(decision.intents[0].postedQualification, undefined, 'literal status words cannot qualify the task');
  assert.ok(r.inventory > 0 && r.facts > 0, 'account and transaction decisions reach real SQL');
  assert.equal(r.documents, 0);
  assert.equal(r.body.ledger.kind, 'merchant');
  assert.equal(r.body.ledger.total_minor, 1234, 'exact stored descriptor amount');
  return r;
}

for (const word of descriptorWords) for (const [frameId, frame] of descriptorFrames.entries()) {
  test(`descriptor task-word ${word} frame ${frameId} retains its literal role`, async t => {
    await descriptorReading(t, frame('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
    const descriptor = `${word.toUpperCase()}*UNIT 0042`;
    await descriptorReading(t, frame(descriptor), descriptor);
  });
}

for (const descriptor of ['Game*Unit 0042', 'game*unit 0042', 'UNIT*GAME 0042',
  'GAME * UNIT 0042', 'UNIT/GAME*0042', 'UNIT.GAME*0042', 'GAME*UNIT-0042',
  "GAME*OWNER'S UNIT 0042", 'GAME*UNIT & CO 0042', 'GAME*UNIT AND CO 0042']) {
  test(`descriptor punctuation ${descriptor} retains its literal role`, async t => {
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
    await descriptorReading(t, descriptorFrames[0](descriptor), descriptor);
  });
}

for (const [left, right] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’']]) {
  for (const [frameId, frame] of descriptorFrames.entries()) {
    test(`descriptor delimiter ${left}${right} frame ${frameId} preserves the enclosed literal`, async t => {
      await descriptorReading(t, frame('MARKET*UNIT 0042'), 'MARKET*UNIT 0042');
      await descriptorReading(t, frame(`${left}MARKET*UNIT 0042${right}`), 'MARKET*UNIT 0042');
      await descriptorReading(t, frame(`${left}GAME*UNIT 0042${right}`), 'GAME*UNIT 0042');
    });
  }
}

for (const phrase of ['playing cards game', 'poker rules', 'card pricing policy']) {
  test(`unmarked document topic ${phrase} is not a protected descriptor`, async t => {
    const question = descriptorFrames[0](phrase);
    const value = merchant('outflow', { vendor_text: phrase, account_hint: 'cards' });
    const f = configured(t, value);
    f.raw("UPDATE fin_transactions SET payee=? WHERE txn_uid='purchase'", phrase);
    const decision = explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context);
    assert.equal(decision.outcome, 'fallback', 'task decision reached with a substantive candidate');
    const r = await ask(f, question, value);
    assert.equal(r.documents, 1);
    assert.equal(r.inventory, 0);
    assert.equal(r.facts, 0);
    await descriptorReading(t, descriptorFrames[0](`${phrase}*UNIT 0042`), `${phrase}*UNIT 0042`);
  });
}

for (const vendor_text of [null, 'POLICY', 'UNIT 0042']) {
  test(`protected descriptor refuses a dropped or shortened selector ${vendor_text}`, async t => {
    const descriptor = 'POLICY*UNIT 0042';
    const question = descriptorFrames[0](descriptor);
    const full = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, full);
    f.raw("UPDATE fin_transactions SET payee=? WHERE txn_uid='purchase'", descriptor);
    for (const [index, payee] of ['POLICY', 'UNIT 0042'].entries()) {
      f.add(`short-${index}`, payee, payee, { date: '2026-09-05', cents: 9999, direction: 'outflow' });
    }
    const value = { ...full, vendor_text };
    const r = await ask(f, question, value);
    assert.equal(r.calls, 1, 'literal decision reached extraction with a substantive candidate');
    assert.equal(validateLedgerIntentDecision(reply(value), question, context).reason, 'ungrounded_vendor');
    assert.equal(r.inventory, 0);
    assert.equal(r.facts, 0);
    assert.equal(r.documents, 1);
    const green = await ask(f, question, full);
    assert.equal(green.calls, 1);
    assert.ok(green.inventory > 0 && green.facts > 0);
    assert.equal(green.body.ledger.total_minor, 1234);
  });
}

test.beforeEach(t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  t.mock.method(Date, 'now', () => context.now);
});

function configured(t, value) {
  const f = ledgerFixture(t);
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.raw("UPDATE fin_accounts SET label=?, account_kind='card', balance_role='liability'", value.account_hint || 'Reserve Unit');
  f.raw('UPDATE fin_balance_snapshots SET current_minor=4321');
  f.add('purchase', 'MARKET*UNIT 0042', 'MARKET*UNIT 0042', { date: '2026-09-05', cents: 1234, direction: 'outflow' });
  f.add('supplies', 'Supply Unit', 'Supply Unit', { date: '2026-09-06', cents: 2100, direction: 'outflow' });
  f.add('payout', 'Processor Unit', 'Processor Unit', { date: '2026-09-07', cents: 9200, direction: 'inflow' });
  f.add('payout-peer', 'Processor Unit', 'Processor Unit', { date: '2026-09-08', cents: 4000, direction: 'inflow' });
  f.calls.length = 0;
  return f;
}

async function ask(f, question, value, wrap = withLedgerAnswer) {
  f.calls.length = 0;
  let calls = 0, documents = 0;
  const result = await wrap({ env: f.env, question, ...context, now: f.now || context.now, grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async (_env, request) => {
      calls++;
      assert.equal(request.messages[0].content, question, 'question bytes reach extraction unchanged');
      return { content: [{ type: 'text', text: JSON.stringify(reply(value)) }] };
    } }, async () => {
    documents++;
    return Response.json({ route: 'documents', marker: 'retained document response' });
  });
  return { body: await result.json(), calls, documents,
    inventory: f.calls.filter(sql => /FROM fin_accounts/.test(sql)).length,
    facts: f.calls.filter(sql => /CROSS JOIN fin_transactions/.test(sql)).length,
    snapshots: f.calls.filter(sql => /JOIN fin_balance_snapshots b ON/.test(sql)).length };
}

for (const [id, question, value] of cases) {
  test(`bounded admission ${id} reaches the real extractor and retains literal selectors`, async t => {
    const f = configured(t, value);
    const r = await ask(f, question, value);
    assert.equal(r.calls, 1, 'admission must reach extraction');
    const decision = validateLedgerIntentDecision(reply(value), question, context);
    assert.ok(decision.intents.length > 0, 'controlled reading is a nonempty plan');
    const plan = decision.intents[0];
    if (value.vendor_text) assert.equal(plan.match, value.vendor_text);
    if (value.account_hint) assert.equal(plan.modelAccountScope, value.account_hint);
    assert.ok(r.inventory > 0, 'account decision reached real SQL');
    assert.equal(r.documents, 0);
    if (id === 'own-move') {
      // This fixture has no personal endpoint. A directed movement must not
      // silently fall back to a business-only or whole-owner transfer list.
      assert.equal(r.body.ledger.kind, 'scope_refused');
      assert.equal(r.facts, 0);
      return;
    }
    assert.equal(r.body.ledger.kind, value.kind);
    if (value.kind === 'balance') {
      assert.ok(r.snapshots > 0);
      assert.equal(r.body.ledger.accounts[0].current_minor, 4321);
      assert.equal(r.facts, 1, 'bounded pending lookup accompanies the balance snapshot');
      assert.equal(r.body.ledger.total_minor, undefined, 'no invented card-debt aggregate');
    } else {
      assert.ok(r.facts > 0, 'chosen activity reader reached stored rows');
      if (value.kind === 'merchant' && !plan.monthlyBreakdown) {
        if (value.direction === 'inflow') {
          assert.equal(r.body.ledger.attributed_subtotal_minor, 13200);
          assert.equal(r.body.ledger.total_minor, null, 'payer labels cannot prove a complete payout total');
          assert.equal(r.body.ledger.complete, false);
        } else assert.equal(r.body.ledger.total_minor, value.vendor_text === 'Supply Unit' ? 2100 : 1234);
      }
      if (value.kind === 'largest') assert.equal(r.body.ledger.rows[0].amount_minor, 9200);
    }
  });
}

for (const [id, question, value] of decoys) {
  test(`document task ${id} retains its response despite a supplied money label`, async t => {
    const f = configured(t, value);
    assert.equal(reply(value).intents.length, 1, 'negative arm supplies a substantive candidate');
    const diagnostic = explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context);
    assert.equal(diagnostic.outcome, 'fallback', 'explicit task/admission decision reached');
    assert.ok(['gate_refused', 'decoy_outer_task', 'capability'].includes(diagnostic.reason));
    const r = await ask(f, question, value);
    assert.equal(r.documents, 1);
    assert.equal(r.body.route, 'documents');
    assert.equal(r.body.marker, 'retained document response');
    assert.equal(r.body.ledger, undefined);
    assert.equal(r.inventory, 0);
    assert.equal(r.facts, 0);
    const green = await ask(f, 'What are my current balances?', intent('balance'));
    assert.equal(green.calls, 0);
    assert.equal(green.body.ledger.kind, 'balance');
    assert.ok(green.inventory > 0);
  });
}

test('unknown literal descriptor reaches populated payees but never becomes a zero total', async t => {
  const value = merchant('outflow', { vendor_text: 'UNKNOWN*UNIT', account_hint: 'cards' });
  const f = configured(t, value);
  const r = await ask(f, "On the cards last month, what's the total for UNKNOWN*UNIT?", value);
  assert.equal(r.calls, 1);
  assert.ok(r.inventory > 0 && r.facts > 0);
  assert.equal(r.body.ledger.match_basis, 'none');
  assert.equal(r.body.ledger.total_minor, null);
  assert.equal(f.rows('SELECT * FROM fin_transactions').length, 4, 'matcher has populated evidence');
  const green = await ask(f, cases[5][1], cases[5][2]);
  assert.equal(green.body.ledger.total_minor, 1234);
});

test('existing grammar routes retain their zero-extraction behavior', async t => {
  const f = configured(t, intent('balance'));
  for (const [question, kind] of [['What are my current balances?', 'balance'], ['How much did I spend last month?', 'expense_summary']]) {
    const r = await ask(f, question, intent(kind));
    assert.equal(r.calls, 0);
    assert.equal(r.documents, 0);
    assert.equal(r.body.ledger.kind, kind);
    assert.ok(r.inventory > 0);
  }
});

function mixedCards(t, value, reverse = false) {
  const f = configured(t, value);
  f.raw("UPDATE fin_accounts SET label='cards'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,label,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('operating-account','owner','Operating Unit','checking','asset','7890','live','feed','bank-feed:fixture-feed','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('operating-account','complete','2024-01-01','2026-10-31',?,'feed','bank-feed:fixture-feed','confirmed',?)`, NOW, NOW);
  f.add('checking-purchase', 'MARKET*UNIT 0042', 'MARKET*UNIT 0042', { date: '2026-09-09', cents: 9000, direction: 'outflow' });
  f.raw("UPDATE fin_transactions SET account_slug='operating-account' WHERE txn_uid='checking-purchase'");
  f.raw("UPDATE fin_accounts SET institution=CASE WHEN account_slug='fixture-account' THEN 'Reserve Bank Unit' ELSE 'Operating Bank Unit' END");
  if (reverse) f.raw('PRAGMA reverse_unordered_selects=ON');
  f.selectedReads = [];
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql);
    const bind = statement.bind;
    statement.bind = (...params) => {
      if (/CROSS JOIN fin_transactions/.test(sql)) f.selectedReads.push(params);
      return bind(...params);
    };
    return statement;
  };
  return f;
}

function confirmCardRole(f, slug, role) {
  // Positive role fixtures need the same confirmed join as a real account;
  // a feed label alone cannot establish personal ownership.
  const entity = role === 'personal' ? 'confirmed-person' : 'owner';
  if (role === 'personal') f.raw(`INSERT OR IGNORE INTO fin_entities
    (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('confirmed-person','Synthetic person','person','owned','owner_stated','confirmed',?)`, NOW);
  f.raw('UPDATE fin_accounts SET entity_slug=? WHERE account_slug=?', entity, slug);
}

async function cardOwnershipContract(t, wrap = withLedgerAnswer) {
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
  const f = mixedCards(t, value);
  f.raw(`INSERT INTO fin_entities (entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('personal-owner','Synthetic person','person','owned','owner_stated','confirmed',?)`, NOW);
  f.raw("UPDATE fin_accounts SET entity_slug='personal-owner',label='Reserve Unit' WHERE account_slug='fixture-account'");
  f.raw("UPDATE fin_accounts SET label='personal Travel Unit',account_kind='card',balance_role='liability' WHERE account_slug='operating-account'");
  for (const hint of [null, 'cards', 'personal']) {
    const r = await ask(f, "On our personal cards last month, what's the total for MARKET*UNIT 0042?", { ...value, account_hint: hint }, wrap);
    assert.ok(r.facts > 0);
    assert.equal(r.body.ledger.total_minor, 1234);
    assert.deepEqual(r.body.ledger.accounts.map(a => a.account_mask), ['1234']);
    assert.ok(r.body.citations.every(c => c.account_mask === '1234'));
  }
}

test('S5 question card ownership survives nullable hints and misleading labels', cardOwnershipContract);

test('S5 restoring label-based question ownership is killed', async t => {
  await cardOwnershipContract(t);
  const { wrap } = await descriptorMutant(t, 's5-label-owner', [['ledger-answer.js',
    'accounts = accounts.filter(account => roleScope.accounts.includes(account));',
    'accounts = accountsForSelector(accounts, cardRoles[0], true);']]);
  await assert.rejects(() => cardOwnershipContract(t, wrap), assert.AssertionError);
});

test('R4-01 null provider account hint preserves the question card restriction', async t => {
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
  const f = mixedCards(t, value);
  const question = "On the cards last month, what's the total for MARKET*UNIT 0042?";
  assert.equal(validateLedgerIntentDecision(reply(value), question, context).intents.length, 1);
  const green = await ask(f, question, { ...value, account_hint: 'cards' });
  assert.equal(green.body.ledger.total_minor, 1234, 'numeric provider-hint peer');
  const actual = await ask(f, question, value);
  assert.equal(actual.calls, 1);
  assert.ok(actual.inventory > 0 && actual.facts > 0, 'nonempty SQLite reader reached');
  assert.equal(actual.body.ledger.total_minor, 1234);
  assert.equal(actual.body.ledger.lead_total_minor, 1234);
  assert.equal(actual.body.ledger.complete, true);
  assert.equal(actual.body.ledger.from, '2026-09-01');
  assert.equal(actual.body.ledger.to, '2026-09-30');
  assert.ok(JSON.stringify(f.selectedReads).includes('fixture-account'));
  assert.deepEqual(actual.body.ledger.accounts.map(a => a.account_mask), ['1234']);
  assert.deepEqual(actual.body.ledger.accounts.map(a => f.first('SELECT account_slug FROM fin_accounts WHERE mask=?', a.account_mask).account_slug), ['fixture-account']);
  const purchase = f.first("SELECT id FROM fin_transactions WHERE txn_uid='purchase'");
  assert.deepEqual(actual.body.citations.map(c => c.ref), [`ledger:transaction:${purchase.id}`]);
  assert.match(actual.body.answer, /12\.34/);
});

const scopeParaphrases = [
  "On my cards last month, what is the total for MARKET*UNIT 0042?",
  'On our credit cards last month, show me the total for MARKET*UNIT 0042.',
  'What was the total for MARKET*UNIT 0042 on the cards last month?',
  'Show the total for MARKET*UNIT 0042 on my debit cards last month.',
  'On the business cards last month, what was the total for MARKET*UNIT 0042?',
  'On our personal cards last month, show the total for MARKET*UNIT 0042.',
  'What is the total for MARKET*UNIT 0042 on our credit cards this year?',
  'Show me the total for MARKET*UNIT 0042 on the cards this quarter.',
  'On my credit cards this year, show the total for MARKET*UNIT 0042.',
  'What was the total for MARKET*UNIT 0042 on our cards last quarter?',
];
test('question business card role survives an omitted provider scope', async t => {
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
  const f = mixedCards(t, value);
  confirmCardRole(f, 'operating-account', 'personal');
  f.raw("UPDATE fin_accounts SET label='business Reserve Unit' WHERE account_slug='fixture-account'");
  f.raw("UPDATE fin_accounts SET label='personal Travel Unit',account_kind='card',balance_role='liability' WHERE account_slug='operating-account'");
  const r = await ask(f, "On our business cards last month, what's the total for MARKET*UNIT 0042?", value);
  assert.ok(r.inventory > 0 && r.facts > 0);
  assert.equal(r.body.ledger.total_minor, 1234);
});
for (const role of ['business', 'personal']) for (const kind of ['credit', 'debit']) {
  for (const reversed of [true, false]) for (const suffix of [false, true]) {
    const modifiers = reversed ? `${kind} ${role}` : `${role} ${kind}`;
    test(`REVIEW-01 ${modifiers} suffix=${suffix} preserves role independently of provider scope`, async t => {
      const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
      const f = mixedCards(t, value, reversed);
      confirmCardRole(f, 'fixture-account', role);
      confirmCardRole(f, 'operating-account', role === 'personal' ? 'business' : 'personal');
      f.raw('UPDATE fin_accounts SET label=? WHERE account_slug=?', `${role} Reserve Unit`, 'fixture-account');
      f.raw("UPDATE fin_accounts SET label=?,account_kind='card',balance_role='liability' WHERE account_slug='operating-account'",
        `${role === 'business' ? 'personal' : 'business'} Travel Unit`);
      const question = suffix
        ? `What is the total for MARKET*UNIT 0042 on our ${modifiers} cards last month?`
        : `On our ${modifiers} cards last month, what's the total for MARKET*UNIT 0042?`;
      assert.equal(validateLedgerIntentDecision(reply(value), question, context).intents.length, 1);
      // Explicit role is the numeric green peer for each nullable/generic hint.
      for (const hint of [role, 'cards', null]) {
        const r = await ask(f, question, { ...value, account_hint: hint });
        assert.equal(r.calls, 1);
        assert.ok(r.inventory > 0 && r.facts > 0, 'populated inventory and transaction reader reached');
        assert.equal(r.body.ledger.total_minor, 1234);
        assert.equal(r.body.ledger.lead_total_minor, 1234);
        assert.equal(r.body.ledger.complete, true);
        assert.equal(r.body.ledger.from, '2026-09-01');
        assert.equal(r.body.ledger.to, '2026-09-30');
        assert.deepEqual(r.body.ledger.accounts.map(a => a.account_mask), ['1234']);
        const purchase = f.first("SELECT id FROM fin_transactions WHERE txn_uid='purchase'");
        assert.deepEqual(r.body.citations.map(c => c.ref), [`ledger:transaction:${purchase.id}`]);
        assert.match(r.body.answer, /12\.34/);
      }
    });
  }
}

const roleScopeNeighbors = [
  ...['checking', 'savings', 'loan', 'line_of_credit', 'investment', 'retirement', 'merchant', 'point_of_sale', 'escrow', 'other'].map(kind => ({ kind })),
  { activity: 'pending' }, { activity: 'refund' },
  { activity: 'card payment' }, { activity: 'loan payment' }, { activity: 'own account transfer' },
  { now: '2026-11-01T00:30:00Z', zone: 'UTC', month: '10', from: '2026-10-01', to: '2026-10-31' },
  { now: '2026-11-01T00:30:00Z', zone: 'America/Phoenix', month: '09', from: '2026-09-01', to: '2026-09-30' },
];
for (const [index, row] of roleScopeNeighbors.entries()) {
  test(`REVIEW-01 role scope neighbor ${JSON.stringify(row)} has a numeric peer`, async t => {
    const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
    const f = mixedCards(t, value, index % 2 === 0);
    f.raw("UPDATE fin_accounts SET label='business Reserve Unit' WHERE account_slug='fixture-account'");
    f.raw("UPDATE fin_accounts SET label='business Operating Unit',account_kind=?,balance_role=? WHERE account_slug='operating-account'",
      row.kind || 'checking', ['loan', 'line_of_credit'].includes(row.kind) ? 'liability' : 'asset');
    if (row.activity) {
      f.add('activity-peer', 'MARKET*UNIT 0042', 'MARKET*UNIT 0042', {
        date: '2026-09-05', cents: 7301, direction: row.activity === 'refund' ? 'inflow' : 'outflow',
      });
      if (row.activity === 'pending') f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='activity-peer'");
      if (['card payment', 'loan payment', 'own account transfer'].includes(row.activity)) {
        f.raw("UPDATE fin_transactions SET account_slug='operating-account',description=? WHERE txn_uid='activity-peer'", row.activity);
      }
    }
    if (row.now) {
      f.now = Date.parse(row.now);
      f.env.BRAIN_TIMEZONE = row.zone;
      f.raw("UPDATE fin_transactions SET posted_on=replace(posted_on,'2026-09',?)", `2026-${row.month}`);
    }
    for (const modifiers of ['business credit', 'credit business']) {
      const r = await ask(f, `On our ${modifiers} cards last month, what's the total for MARKET*UNIT 0042?`, { ...value, account_hint: 'cards' });
      assert.equal(r.calls, 1);
      assert.ok(r.inventory > 0 && r.facts > 0);
      assert.equal(r.body.ledger.total_minor, 1234);
      assert.equal(r.body.ledger.complete, true);
      assert.equal(r.body.ledger.from, row.from || '2026-09-01');
      assert.equal(r.body.ledger.to, row.to || '2026-09-30');
      assert.deepEqual(r.body.ledger.accounts.map(a => a.account_mask), ['1234']);
    }
  });
}

for (const modifiers of ['credit business', 'debit personal', 'business personal']) {
  test(`REVIEW-01 unproven ${modifiers} scope withholds figures after inventory`, async t => {
    const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
    const f = mixedCards(t, value);
    f.raw("UPDATE fin_entities SET kind='trust'");
    f.raw("UPDATE fin_accounts SET account_kind='card',balance_role='liability' WHERE account_slug='operating-account'");
    const question = `On our ${modifiers} cards last month, what's the total for MARKET*UNIT 0042?`;
    assert.equal(validateLedgerIntentDecision(reply(value), question, context).intents.length, 1);
    for (const hint of [null, 'cards']) {
      const r = await ask(f, question, { ...value, account_hint: hint });
      assert.equal(r.calls, 1);
      assert.ok(r.inventory > 0);
      assert.equal(r.facts, 0, 'unproven scope must stop before the activity reader');
      assert.equal(r.body.ledger, null);
      assert.ok(r.body.gaps.some(gap => gap.reason === 'no_accounts'));
      const green = await ask(f, "On our cards last month, what's the total for MARKET*UNIT 0042?", value);
      assert.ok(green.facts > 0);
      assert.equal(green.body.ledger.total_minor, 10234, 'unrestricted cards numeric peer');
    }
  });
}

test('REVIEW-01 restoring positional role recovery leaks a figure and kills the invariant', async t => {
  const before = "const cardRoles = ledgerDescriptorTotal(question)?.cardRoles || [];";
  const after = "const cardRoles = [ledgerDescriptorTotal(question)?.prose.match(/\\b(?:my|our|the) (business|personal)\\b/i)?.[1]].filter(Boolean);";
  const { wrap } = await descriptorMutant(t, 'positional-card-role', [['ledger-answer.js', before, after]]);
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' });
  const f = mixedCards(t, value);
  confirmCardRole(f, 'operating-account', 'personal');
  f.raw("UPDATE fin_accounts SET label='business Reserve Unit' WHERE account_slug='fixture-account'");
  f.raw("UPDATE fin_accounts SET label='personal Travel Unit',account_kind='card',balance_role='liability' WHERE account_slug='operating-account'");
  const question = "On our credit business cards last month, what's the total for MARKET*UNIT 0042?";
  assert.equal((await ask(f, question, value)).body.ledger.total_minor, 1234);
  const leaked = await ask(f, question, value, wrap);
  assert.ok(leaked.inventory > 0 && leaked.facts > 0);
  assert.deepEqual(leaked.body.ledger.accounts.map(a => a.account_mask).sort(), ['1234', '7890']);
  assert.equal(leaked.body.ledger.total_minor, 10234);
  assert.throws(() => assert.equal(leaked.body.ledger.total_minor, 1234), 'restored positional filter turns the numeric invariant red');
  const green = await ask(f, question.replace('credit business', 'business credit'), value, wrap);
  assert.equal(green.body.ledger.total_minor, 1234, 'mutant has a nonuniform green control');
});

test('unresolved question card role refuses after inventory with a numeric peer', async t => {
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
  const f = mixedCards(t, value);
  f.raw("UPDATE fin_entities SET kind='trust'");
  const question = "On our business cards last month, what's the total for MARKET*UNIT 0042?";
  const plan = validateLedgerIntentDecision(reply(value), question, context);
  assert.equal(plan.intents.length, 1);
  const refused = await ask(f, question, value);
  assert.equal(refused.calls, 1);
  assert.ok(refused.inventory > 0);
  assert.equal(refused.facts, 0);
  assert.equal(refused.body.ledger, null);
  f.raw("UPDATE fin_entities SET kind='business'");
  f.raw("UPDATE fin_accounts SET label='business Reserve Unit' WHERE account_slug='fixture-account'");
  const green = await ask(f, question, value);
  assert.ok(green.inventory > 0 && green.facts > 0);
  assert.equal(green.body.ledger.total_minor, 1234);
});
for (const [index, question] of scopeParaphrases.entries()) {
  test(`mixed account paraphrase ${index + 1} RIGHT with independent minor-unit oracle`, async t => {
    const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
    const f = mixedCards(t, value, index % 2 === 0);
    f.now = Date.parse(index % 2 ? '2026-10-14T12:00:00.000Z' : NOW);
    // Change amounts and labels independently of the classifier and SQL order.
    const expected = 1501 + index * 37;
    f.raw("UPDATE fin_transactions SET amount_minor=? WHERE txn_uid='purchase'", expected);
    if (/this quarter/.test(question)) f.raw("UPDATE fin_transactions SET posted_on=replace(posted_on,'2026-09','2026-10')");
    const role = /business/.test(question) ? 'business ' : /personal/.test(question) ? 'personal ' : '';
    if (role.trim()) confirmCardRole(f, 'fixture-account', role.trim());
    f.raw('UPDATE fin_accounts SET label=? WHERE account_slug=?', role + (index % 2 ? 'Travel Unit' : 'Reserve Unit'), 'fixture-account');
    for (const hint of [null, 'cards']) {
      const r = await ask(f, question, { ...value, account_hint: hint });
      assert.equal(r.calls, 1);
      assert.ok(r.inventory > 0 && r.facts > 0);
      assert.equal(r.body.ledger.total_minor, expected);
      assert.equal(r.body.ledger.lead_total_minor, expected);
      assert.equal(r.body.ledger.complete, true);
    }
    assert.ok(JSON.stringify(f.selectedReads).includes('fixture-account'));
    assert.deepEqual((await ask(f, question, value)).body.ledger.accounts.map(a => a.account_mask), ['1234']);
  });
}

test('mutant removing final question card restriction exposes the 10234 leak', async t => {
  const site = "if (ledgerDescriptorTotal(question)) accounts = accounts.filter(a =>\n        a.account_kind === 'card' && a.members.every(m => m.account_kind === 'card'));";
  const { wrap } = await descriptorMutant(t, 'question-card-scope', [['ledger-answer.js', site, '/* restriction removed */']]);
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042' });
  const f = mixedCards(t, value);
  const question = "On the cards last month, what's the total for MARKET*UNIT 0042?";
  const intact = await ask(f, question, value);
  assert.equal(intact.body.ledger.total_minor, 1234);
  const leaked = await ask(f, question, value, wrap);
  assert.ok(leaked.inventory > 0 && leaked.facts > 0);
  assert.ok(JSON.stringify(f.selectedReads).includes('operating-account'));
  assert.equal(leaked.body.ledger.total_minor, 10234);
  assert.throws(() => assert.equal(leaked.body.ledger.total_minor, 1234), 'the intact invariant kills this mutant');
  const peer = await ask(f, question, { ...value, account_hint: 'cards' }, wrap);
  assert.equal(peer.body.ledger.total_minor, 1234);
});

async function descriptorMutant(t, id, edits) {
  const paths = ['ledger-intent-contract.js', 'ledger-intent.js', 'ledger-answer.js'];
  const sources = new Map(paths.map(name => [name, readFileSync(new URL(`../src/lib/${name}`, import.meta.url), 'utf8')]));
  for (const [file, before, after] of edits) {
    const source = sources.get(file);
    assert.equal(source.split(before).length - 1, 1, 'one restoring mutation site');
    sources.set(file, source.replace(before, after));
  }
  for (const [file, before, after] of [
    ['ledger-intent.js', "from './ledger-intent-contract.js'", `from './ledger-intent-contract.js?descriptor-${id}'`],
    ['ledger-answer.js', 'from "./ledger-intent.js"', `from "./ledger-intent.js?descriptor-${id}"`],
    ['ledger-answer.js', 'from "./ledger-intent-contract.js"', `from "./ledger-intent-contract.js?descriptor-${id}"`],
  ]) {
    assert.equal(sources.get(file).split(before).length - 1, 1, 'one mutant dependency');
    sources.set(file, sources.get(file).replace(before, after));
  }
  const loads = new Map(paths.map(name => [new URL(`../src/lib/${name}?descriptor-${id}`, import.meta.url).href, 0]));
  const hook = registerHooks({ load(target, options, next) {
    if (!loads.has(target)) return next(target, options);
    loads.set(target, loads.get(target) + 1);
    const name = paths.find(name => target === new URL(`../src/lib/${name}?descriptor-${id}`, import.meta.url).href);
    return { format: 'module', source: sources.get(name), shortCircuit: true };
  } });
  t.after(() => hook.deregister());
  const wrap = (await import(new URL(`../src/lib/ledger-answer.js?descriptor-${id}`, import.meta.url))).withLedgerAnswer;
  const api = await import(new URL(`../src/lib/ledger-intent.js?descriptor-${id}`, import.meta.url));
  assert.deepEqual([...loads.values()], [1, 1, 1], 'every mutated dependency actually loaded once');
  return { wrap, api };
}

const finalDescriptorInvariant = "if (descriptorTotal && (result.length !== 1 || result.some(intent =>\n      intent.kind !== 'merchant' || typeof intent.match !== 'string' ||\n      intent.match.toLowerCase() !== descriptorTotal.descriptor.toLowerCase()))) return fallbackDecision('ungrounded_vendor');";
const readerRoleSite = 'const protectedPayee = ledgerDescriptorTotal(question)?.descriptor;';
const readerDescriptorInvariant = "if (protectedPayee && (intent.protectedPayee !== protectedPayee ||\n            intent.kind !== 'merchant' || typeof intent.match !== 'string' ||\n            intent.match.toLowerCase() !== protectedPayee.toLowerCase())) throw new Error('protected payee unavailable');";

const handoffCorruptions = [
  ['missing match', 'delete intent.match;'],
  ['null match', 'intent.match = null;'],
  ['nonstring match', 'intent.match = 42;'],
  ['short match', "intent.match = 'POLICY';"],
  ['different match', "intent.match = 'Supply Unit';"],
  ['changed kind', "intent.kind = 'expense_summary'; delete intent.match;"],
  ['missing role', 'delete intent.protectedPayee;'],
  ['changed role', "intent.protectedPayee = 'UNIT 0042';"],
];
for (const [id, corruption] of handoffCorruptions) {
  test(`reader final payee invariant refuses ${id} after actual inventory with a green control`, async t => {
    const { wrap } = await descriptorMutant(t, `corrupt-${id.replaceAll(' ', '-')}`, [
      ['ledger-answer.js', 'accounts = inventory;', `accounts = inventory;
      if (accountsForSelector(inventory, intent.match).length) { ${corruption} }`],
    ]);
    const descriptor = 'POLICY*UNIT 0042';
    const question = descriptorFrames[0](descriptor);
    const value = merchant('outflow', { vendor_text: descriptor });
    const plan = validateLedgerIntentDecision(reply(value), question, context);
    assert.equal(plan.intents.length, 1, 'valid nonempty plan precedes handoff corruption');
    assert.equal(plan.intents[0].match, descriptor);
    const f = configured(t, value);
    f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
    f.raw('UPDATE fin_accounts SET label=?', 'Policy Unit 0042');
    const refused = await ask(f, question, value, wrap);
    assert.equal(refused.calls, 1);
    assert.ok(refused.inventory > 0, 'the corrupting decision requires actual matching inventory');
    assert.equal(refused.facts, 0, 'no transaction read after a lost or changed protected predicate');
    assert.equal(refused.body.ledger, null, 'no broadened figure');
    f.raw('UPDATE fin_accounts SET label=?', 'cards');
    const green = await ask(f, question, value, wrap);
    assert.ok(green.inventory > 0 && green.facts > 0);
    assert.equal(green.body.ledger.total_minor, 1234, 'only the colliding inventory label changed');
  });
}

test('mutant restore raw lexical instruction rejection loses the whole descriptor family with controls', async t => {
  const { wrap, api } = await descriptorMutant(t, 'raw-instruction', [
    ['ledger-intent.js', 'if (injection(question, ledgerTaskProse(question)))', 'if (injection(question))'],
  ]);
  for (const word of instructionWords) {
    const descriptor = `${word.toUpperCase()}*UNIT 0042`;
    const question = descriptorFrames[0](descriptor);
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, value);
    assert.equal(api.explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context).reason,
      'decoy_outer_task', 'mutant reaches raw lexical rejection');
    const lost = await ask(f, question, value, wrap);
    assert.equal(lost.calls, 0);
    assert.equal(lost.inventory, 0);
    assert.equal(lost.documents, 1);
    await descriptorReading(t, question, descriptor);
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042', wrap);
  }
});

for (const patternActivation of [false, true]) {
  test(`mutant reader ${patternActivation ? 'restore pattern-based activation' : 'drop default payee protection'} restores account broadening with controls`, async t => {
    const { wrap, api } = await descriptorMutant(t, `reader-role-${patternActivation}`, [
      ['ledger-answer.js', readerRoleSite, patternActivation
        ? "const protectedPayee = /\\b(?:policy|game)\\b/i.test(question) ? ledgerDescriptorTotal(question)?.descriptor : null;"
        : 'const protectedPayee = null;'],
    ]);
    for (const descriptor of ['MARKET*UNIT 0042', 'UNLISTED*UNIT 0042', 'FUTURE*UNIT 0042']) {
      const question = descriptorFrames[0](descriptor);
      const value = merchant('outflow', { vendor_text: descriptor });
      const plan = api.validateLedgerIntentDecision(reply(value), question, context);
      assert.equal(plan.intents.length, 1);
      assert.equal(plan.intents[0].match, descriptor);
      assert.equal(plan.intents[0].protectedPayee, descriptor, 'mutant still receives the complete protected plan');
      const f = configured(t, value);
      f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
      f.raw('UPDATE fin_accounts SET label=?', descriptor.replace('*', ' '));
      const current = await ask(f, question, value);
      assert.ok(current.inventory > 0 && current.facts > 0);
      assert.equal(current.body.ledger.total_minor, 1234);
      const broadened = await ask(f, question, value, wrap);
      assert.ok(broadened.inventory > 0 && broadened.facts > 0, 'mutant reaches the widened transaction reader');
      assert.equal(broadened.body.ledger.expense_total_minor, 3334);
      f.raw('UPDATE fin_accounts SET label=?', 'cards');
      const green = await ask(f, question, value, wrap);
      assert.ok(green.inventory > 0 && green.facts > 0);
      assert.equal(green.body.ledger.total_minor, 1234, 'only the colliding account label changed');
    }
    if (patternActivation) {
      const descriptor = 'POLICY*UNIT 0042';
      const value = merchant('outflow', { vendor_text: descriptor });
      const f = configured(t, value);
      f.raw('UPDATE fin_accounts SET label=?', 'Policy Unit 0042');
      f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
      const named = await ask(f, descriptorFrames[0](descriptor), value, wrap);
      assert.ok(named.inventory > 0 && named.facts > 0);
      assert.equal(named.body.ledger.total_minor, 1234, 'pattern mutant still preserves its named example');
    }
  });
}

test('mutant restore account aliasing alone reaches the final closed reader invariant', async t => {
  const { wrap } = await descriptorMutant(t, 'alias-only', [
    ['ledger-answer.js', "if (protectedPayee || !intent.interpretation", 'if (!intent.interpretation'],
  ]);
  const descriptor = 'POLICY*UNIT 0042';
  const value = merchant('outflow', { vendor_text: descriptor });
  const f = configured(t, value);
  f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
  f.raw('UPDATE fin_accounts SET label=?', 'Policy Unit 0042');
  const refused = await ask(f, descriptorFrames[0](descriptor), value, wrap);
  assert.ok(refused.inventory > 0);
  assert.equal(refused.facts, 0, 'the last invariant catches the restored alias rewrite');
  assert.equal(refused.body.ledger, null);
  f.raw('UPDATE fin_accounts SET label=?', 'cards');
  const green = await ask(f, descriptorFrames[0](descriptor), value, wrap);
  assert.ok(green.inventory > 0 && green.facts > 0);
  assert.equal(green.body.ledger.total_minor, 1234, 'only the colliding account label changed');
});

test('mutant remove final reader invariant exposes a forced widened plan with a green control', async t => {
  const { wrap } = await descriptorMutant(t, 'reader-postcondition', [
    ['ledger-answer.js', readerDescriptorInvariant, ''],
    ['ledger-answer.js', 'accounts = inventory;', `accounts = inventory;
      if (accountsForSelector(inventory, intent.match).length) { intent.kind = 'expense_summary'; delete intent.match; }`],
  ]);
  const descriptor = 'POLICY*UNIT 0042';
  const value = merchant('outflow', { vendor_text: descriptor });
  const f = configured(t, value);
  f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
  f.raw('UPDATE fin_accounts SET label=?', 'Policy Unit 0042');
  const unsafe = await ask(f, descriptorFrames[0](descriptor), value, wrap);
  assert.ok(unsafe.inventory > 0 && unsafe.facts > 0);
  assert.equal(unsafe.body.ledger.expense_total_minor, 3334);
  f.raw('UPDATE fin_accounts SET label=?', 'cards');
  const green = await ask(f, descriptorFrames[0](descriptor), value, wrap);
  assert.ok(green.inventory > 0 && green.facts > 0);
  assert.equal(green.body.ledger.total_minor, 1234, 'only the colliding inventory label changed');
});

test('mutant restore descriptor follow-up parsing adds a freshness task with a neutral control', async t => {
  const { wrap, api } = await descriptorMutant(t, 'follow-up', [
    ['ledger-intent.js', 'const taskQuestion = ledgerTaskProse(question);', 'const taskQuestion = question;'],
  ]);
  for (const word of ['WHEN DID YOU LAST SYNCED', 'WHEN WERE THESE LAST REFRESHED', 'LAST LOOKED AT']) {
    const descriptor = `${word}*UNIT 0042`;
    const question = descriptorFrames[0](descriptor);
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const plan = api.validateLedgerIntentDecision(reply(value), question, context);
    assert.equal(plan.intents.length, 1);
    assert.equal(plan.intents[0].answerAddOn, 'freshness', 'mutant assigns task authority to selector words');
    const f = configured(t, value);
    f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
    const r = await ask(f, question, value, wrap);
    assert.equal(r.calls, 1);
    assert.ok(r.inventory > 0 && r.facts > 0);
    assert.equal(r.body.ledger.total_minor, 1234);
    await descriptorReading(t, question, descriptor);
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042', wrap);
  }
});

test('mutant restore literal-bearing semantic clauses loses future descriptors with a neutral control', async t => {
  const { wrap, api } = await descriptorMutant(t, 'semantic-clause', [
    ['ledger-intent.js', 'const taskClause = clause => descriptorTotal?.prose || clause;', 'const taskClause = clause => clause;'],
  ]);
  for (const word of ['FUTURE', 'FORECAST', 'PREDICT', 'TOMORROW', 'NEXT WEEK', 'NEXT MONTH', 'NEXT QUARTER', 'NEXT YEAR']) {
    const descriptor = `${word}*UNIT 0042`;
    const question = descriptorFrames[0](descriptor);
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, value);
    const r = await ask(f, question, value, wrap);
    assert.equal(r.calls, 1);
    assert.equal(api.validateLedgerIntentDecision(reply(value), question, context).reason, 'capability');
    assert.equal(r.inventory, 0);
    assert.equal(r.documents, 1);
    await descriptorReading(t, question, descriptor);
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042', wrap);
  }
});

for (const patternActivation of [false, true]) {
  test(`mutant ${patternActivation ? 'restore pattern-based activation' : 'drop final payee invariant'} admits a widened figure with a green control`, async t => {
    const { wrap, api } = await descriptorMutant(t, `final-binding-${patternActivation}`, [
      ['ledger-intent.js', finalDescriptorInvariant, patternActivation
        ? finalDescriptorInvariant.replace('descriptorTotal &&', 'descriptorTotal && /\\b(?:policy|game)\\b/i.test(descriptorTotal.descriptor) &&') : ''],
      // Restore the unsafe path across both defenses, retaining the original
      // exact broadened-figure assertion rather than weakening it to refusal.
      ['ledger-answer.js', readerRoleSite, 'const protectedPayee = null;'],
    ]);
    for (const descriptor of ['MARKET*UNIT 0042', 'UNLISTED*UNIT 0042', 'FUTURE*UNIT 0042']) {
      const question = descriptorFrames[0](descriptor);
      const full = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
      const value = { ...full, account_hint: descriptor };
      const f = configured(t, full);
      f.raw("UPDATE fin_transactions SET payee=?, description=? WHERE txn_uid='purchase'", descriptor, descriptor);
      const before = await ask(f, question, value);
      assert.equal(before.calls, 1);
      assert.equal(validateLedgerIntentDecision(reply(value), question, context).reason, 'ungrounded_vendor');
      assert.equal(before.inventory, 0);
      assert.equal(before.facts, 0);
      const plan = api.validateLedgerIntentDecision(reply(value), question, context);
      assert.equal(plan.intents.length, 1, 'mutant reaches the final executable plan');
      assert.equal(plan.intents[0].kind, 'expense_summary');
      assert.equal(plan.intents[0].match, undefined);
      const mutant = await ask(f, question, value, wrap);
      assert.equal(mutant.calls, 1);
      assert.ok(mutant.inventory > 0 && mutant.facts > 0);
      assert.equal(mutant.body.ledger.expense_total_minor, 3334, 'mutant reads both unequal outflows');
      const green = await ask(f, question, full, wrap);
      assert.equal(green.calls, 1);
      assert.ok(green.inventory > 0 && green.facts > 0);
      assert.equal(green.body.ledger.total_minor, 1234, 'only the account field changes');
    }
    if (patternActivation) {
      const descriptor = 'POLICY*UNIT 0042';
      const value = merchant('outflow', { vendor_text: descriptor, account_hint: descriptor });
      assert.equal(api.validateLedgerIntentDecision(reply(value), descriptorFrames[0](descriptor), context).reason,
        'ungrounded_vendor', 'pattern mutant still guards a named example but loses its siblings');
    }
  });
}

test('mutant restore whole-question task rejection loses descriptors but retains a neutral control', async t => {
  const { wrap, api } = await descriptorMutant(t, 'whole-question', [
    ['ledger-intent-contract.js', 'export function ledgerDescriptorTotal(question) {',
      'export function ledgerDescriptorTotal(question) { return null;'],
  ]);
  for (const [word, extractorCalls] of [['GAME', 0], ['EXPLAIN', 0], ['TAX', 0], ['POLICY', 0],
    ['CC ME', 0], ['ACCTS MANAGER', 0], ['REV OF THE DOC', 0], ['UNDATED', 1], ['EXCLUDING', 1]]) {
    const descriptor = `${word}*UNIT 0042`;
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const f = configured(t, value);
    const r = await ask(f, descriptorFrames[0](descriptor), value, wrap);
    assert.equal(r.calls, extractorCalls, 'restored rejection reaches its admission or post-extraction decision');
    assert.equal(r.documents, 1);
    assert.equal(r.inventory, 0);
    await descriptorReading(t, descriptorFrames[0](descriptor), descriptor);
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042', wrap);
  }
  for (const [, question, value] of decoys.slice(0, 10)) {
    assert.equal(api.explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context).outcome, 'fallback');
    const f = configured(t, value);
    const r = await ask(f, question, value, wrap);
    assert.equal(r.documents, 1);
    assert.equal(r.facts, 0);
  }
  const value = merchant('outflow', { vendor_text: 'MARKET*UNIT 0042', account_hint: 'cards' });
  const question = descriptorFrames[0](value.vendor_text) + ' {';
  assert.equal(api.explainLedgerIntentDecision(question, JSON.stringify(reply(value)), context).reason, 'decoy_outer_task');
  const rejected = await ask(configured(t, value), question, value, wrap);
  assert.equal(rejected.documents, 1);
  assert.equal(rejected.facts, 0);
});

test('mutant remove explicit descriptor marker reads document topics and retains a descriptor control', async t => {
  const { wrap } = await descriptorMutant(t, 'marker', [
    ['ledger-intent-contract.js', "if (!match || !match.groups.descriptor.includes('*')) return null;", 'if (!match) return null;'],
  ]);
  for (const phrase of ['playing cards game', 'poker rules', 'card pricing policy']) {
    const value = merchant('outflow', { vendor_text: phrase, account_hint: 'cards' });
    const f = configured(t, value);
    f.raw("UPDATE fin_transactions SET payee=? WHERE txn_uid='purchase'", phrase);
    const question = descriptorFrames[0](phrase);
    const before = await ask(f, question, value);
    assert.equal(before.documents, 1);
    assert.equal(before.inventory, 0);
    const mutant = await ask(f, question, value, wrap);
    assert.equal(mutant.calls, 1, 'mutant reaches the formerly refused decision');
    assert.ok(mutant.inventory > 0 && mutant.facts > 0);
    assert.equal(mutant.body.ledger.total_minor, 1234);
    await descriptorReading(t, descriptorFrames[0](`${phrase}*UNIT 0042`), `${phrase}*UNIT 0042`, wrap);
  }
});

test('mutant drop complete descriptor binding reads a truncated payee and retains the full control', async t => {
  const { wrap } = await descriptorMutant(t, 'binding', [
    ['ledger-intent.js', "if (descriptorTotal && !raw.intents.every(value => typeof value.vendor_text === 'string' &&\n      value.vendor_text.toLowerCase() === descriptorTotal.descriptor.toLowerCase())) return fallbackDecision('ungrounded_vendor');", ''],
    ['ledger-intent.js', finalDescriptorInvariant, ''],
    ['ledger-answer.js', readerRoleSite, 'const protectedPayee = null;'],
  ]);
  const descriptor = 'POLICY*UNIT 0042';
  const full = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
  const f = configured(t, full);
  f.raw("UPDATE fin_transactions SET payee=? WHERE txn_uid='purchase'", descriptor);
  f.add('short', 'POLICY', 'POLICY', { date: '2026-09-05', cents: 9999, direction: 'outflow' });
  const short = { ...full, vendor_text: 'POLICY' };
  const question = descriptorFrames[0](descriptor);
  const before = await ask(f, question, short);
  assert.equal(before.calls, 1);
  assert.equal(before.inventory, 0);
  const mutant = await ask(f, question, short, wrap);
  assert.ok(mutant.inventory > 0 && mutant.facts > 0);
  assert.equal(mutant.body.ledger.total_minor, null, 'a shortened selector cannot certify a name match');
  assert.equal(mutant.body.ledger.exact_subtotal_minor, 9999);
  assert.equal(mutant.body.ledger.name_match_subtotal_minor, 1234);
  assert.equal(mutant.body.ledger.complete, false);
  const green = await ask(f, question, full, wrap);
  assert.equal(green.body.ledger.total_minor, 1234);
});

test('mutant reinterpret descriptor as account loses the explicit account hint with a neutral control', async t => {
  const { wrap, api } = await descriptorMutant(t, 'account', [
    ['ledger-intent.js', ' && !descriptorTotal ? value.vendor_text : value.account_hint;', ' ? value.vendor_text : value.account_hint;'],
  ]);
  for (const descriptor of ['OPEN AN ACCOUNT*UNIT 0042', 'CHOOSE A BANK ACCOUNT*UNIT 0042', 'CARD POLICY*UNIT 0042']) {
    const value = merchant('outflow', { vendor_text: descriptor, account_hint: 'cards' });
    const question = descriptorFrames[0](descriptor);
    const decision = api.validateLedgerIntentDecision(reply(value), question, context);
    assert.equal(decision.intents.length, 1, 'mutant reaches a substantive scope plan');
    assert.equal(decision.intents[0].modelAccountScope, descriptor, 'mutant demonstrably loses cards scope');
    assert.equal(validateLedgerIntentDecision(reply(value), question, context).intents[0].modelAccountScope, 'cards');
    await descriptorReading(t, question, descriptor);
    await descriptorReading(t, descriptorFrames[0]('MARKET*UNIT 0042'), 'MARKET*UNIT 0042', wrap);
  }
});

test('restoring only the old admission gate loses the new routes and retains a green control', async t => {
  const url = new URL('../src/lib/ledger-intent.js', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const site = 'cue.test(question) || boundedLedgerMoneyCue(question) ||';
  assert.equal(source.split(site).length - 1, 1, 'one admission restoration site');
  // A distinct wrapper URL gets a fresh intent dependency with the restored gate.
  const wrapperUrl = new URL('../src/lib/ledger-answer.js', import.meta.url);
  const originalWrapper = readFileSync(wrapperUrl, 'utf8');
  const dependency = 'from "./ledger-intent.js"';
  assert.equal(originalWrapper.split(dependency).length - 1, 1, 'one intent dependency');
  const wrapperSource = originalWrapper.replace(dependency, 'from "./ledger-intent.js?old-admission"');
  let restoredLoads = 0;
  const second = registerHooks({ load(target, options, next) {
    if (target === `${url.href}?old-admission`) {
      restoredLoads++;
      return { format: 'module', source: source.replace(site, 'cue.test(question) ||'), shortCircuit: true };
    }
    if (target === `${wrapperUrl.href}?old-admission`) return { format: 'module', source: wrapperSource, shortCircuit: true };
    return next(target, options);
  } });
  t.after(() => second.deregister());
  const restored = (await import(`${wrapperUrl.href}?old-admission`)).withLedgerAnswer;
  assert.equal(restoredLoads, 1, 'restored admission module actually loaded');
  for (const [id, question, value] of cases) {
    const f = configured(t, value);
    const mutant = await ask(f, question, value, restored);
    if (id === 'card-current') {
      assert.equal(mutant.calls, 1, 'existing credit vocabulary still enters extraction');
      const current = await ask(f, question, value);
      assert.deepEqual(current.body, mutant.body);
      continue;
    }
    assert.equal(mutant.calls, 0);
    assert.equal(mutant.documents, 1);
    assert.equal(mutant.inventory, 0);
    assert.equal(canExtractLedgerIntent(question), true, 'current gate remains active outside the mutant');
  }
  const f = configured(t, intent('balance'));
  const green = await ask(f, 'What are my current balances?', intent('balance'), restored);
  assert.equal(green.body.ledger.kind, 'balance');
  assert.ok(green.inventory > 0);
  for (const [, question, value] of decoys) {
    const f = configured(t, value);
    const before = await ask(f, question, value, restored);
    const after = await ask(f, question, value);
    assert.deepEqual(after.body, before.body, 'complete document response stays unchanged');
    assert.equal(after.calls, before.calls, 'document controls gain no extraction attempts');
  }
});
