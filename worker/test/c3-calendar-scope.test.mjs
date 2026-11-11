import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { validateLedgerIntentDecision } from '../src/lib/ledger-intent.js';
import { sharedLedgerMonthYear } from '../src/lib/ledger-intent-calendar.js';
import { ledgerScopePlan } from '../src/lib/ledger-intent-scope.js';

import { setup, ask, intent, raw, context } from './c3-calendar-scope-fixture.mjs';

const calendarCases = [
  ['Could you compare spending oct vs sept?', intent(), ['2026-10-01','2026-10-31'], ['2026-09-01','2026-09-30']],
  ['Compare expenses in Oct. against Sep.', intent(), ['2026-10-01','2026-10-31'], ['2026-09-01','2026-09-30']],
  ['Spending for sept versus oct please?', intent(), ['2026-09-01','2026-09-30'], ['2026-10-01','2026-10-31']],
  ['Show expenses for Aug compared with Sept', intent(), ['2026-08-01','2026-08-31'], ['2026-09-01','2026-09-30']],
  ['Compare money in this q vs last q', intent('totals'), ['2026-10-01','2026-11-03'], ['2026-07-01','2026-09-30']],
  ['Money in current q against previous q?', intent('totals'), ['2026-10-01','2026-11-03'], ['2026-07-01','2026-09-30']],
  ['Compare expenses Q3 vs Q2', intent(), ['2026-07-01','2026-09-30'], ['2026-04-01','2026-06-30']],
  ['Please compare expenses October versus September', intent(), ['2026-10-01','2026-10-31'], ['2026-09-01','2026-09-30']],
];
test('C3 local calendar operands reach the reader in question order', async t => {
  const f = setup(t);
  for (const [q, value, first, second] of calendarCases) {
    const reply = raw({ ...value, period: { type: 'year', year: 2020 } }, { ...value, period: { type: 'year', year: 2021 } });
    const plan = validateLedgerIntentDecision(reply, q, context);
    assert.equal(plan.outcome, 'ready', `${q}: ${plan.reason}`);
    assert.equal(plan.intents.length, 2, 'nonempty operand plan');
    assert.deepEqual(plan.intents.map(i => [i.from,i.to]), [first,second]);
    const r = await ask(f,q,reply);
    assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.deepEqual(r.body.ledger.parts.map(p => [p.from,p.to]), [first,second]);
  }
});
test('C3 combined months retain both requested windows and scopes', async t => {
  const f = setup(t);
  for (const q of ['Could you retrieve Store Unit spending for sept and oct?', 'Show expenses for Sep plus Oct']) {
    const scoped = q.includes('Store Unit') ? { account_hint: 'Store Unit' } : {};
    const r = await ask(f,q,raw(intent('expense_summary',scoped),intent('expense_summary',scoped)));
    assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]), [['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']]);
  }
});
test('C3 incomplete comparison preserves both sides without arithmetic or document fallback', async t => {
  const f = setup(t), q = 'Compare money in this quarter versus last quarter';
  const reply = raw(intent('totals'),intent('totals'));
  const green = await ask(f,q,reply);
  assert.equal(green.body.ledger.comparison.difference_minor,3000);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01'");
  const r = await ask(f,q,reply);
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0,'coverage decision reached');
  assert.equal(r.documents,0); assert.equal(r.body.ledger.parts.length,2);
  assert.equal(r.body.ledger.comparison,undefined); assert.match(r.body.answer,/difference.*(?:complete|coverage)/i);
  assert.equal(r.body.ledger.parts[1].complete,false);
  assert.match(r.body.answer,/2026|November|July/);
});
test('C3 partition preserves three disjoint confirmed entity selections', async t => {
  const f = setup(t);
  for (const q of ['Split last month spending Store Unit vs Supply Unit vs personal',
    'Break down expenses last month by Store Unit, Supply Unit and personal',
    'Split spending for Store Unit versus Supply Unit versus personal last month']) {
    const r = await ask(f,q,raw(intent()));
    assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.equal(r.body.ledger.parts.length,3);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[1200,300,200]);
    assert.equal(r.body.ledger.partition.complete,true);
    assert.equal(r.body.ledger.comparison,undefined);
  }
});

async function entityOwnershipContract(t, api = withLedgerAnswer) {
  const f = setup(t);
  for (const [label, identity] of [['Business Reserve Entity', 'entity'], ['Business Checking', 'entity'], ['Business Checking', 'account']]) {
    f.raw('UPDATE fin_entities SET display_label=? WHERE entity_slug=?', identity === 'entity' ? label : 'Store Unit', 'store');
    f.raw('UPDATE fin_accounts SET label=? WHERE account_slug=?', identity === 'account' ? label : 'Operating', 'main');
    const split = await ask(f, `Split expenses last month ${label} vs Supply Unit vs personal`, raw(intent()), api);
    assert.equal(split.documents, 0);
    assert.ok(split.body.ledger?.parts, 'the confirmed entity partition reaches its readers');
    assert.deepEqual(split.body.ledger.parts.map(p => p.expense_total_minor), [1200, 300, 200]);
    assert.deepEqual(split.body.ledger.parts[0].accounts.map(a => a.account_mask).sort(), identity === 'entity' ? ['1111', '2222'] : ['1111']);
    const scoped = intent('expense_summary', { account_hint: label });
    const months = await ask(f, `Could you retrieve ${label} spending for sept and oct?`, raw(scoped, scoped), api);
    assert.equal(months.documents, 0);
    assert.ok(months.body.ledger?.parts, 'the same entity stays selected across both months');
    assert.deepEqual(months.body.ledger.parts.map(p => p.expense_total_minor), [700, 1200]);
    assert.ok(months.body.citations.length);
    assert.ok(months.body.citations.every(c => ['1111', '2222'].includes(c.account_mask)));
  }
}

test('S5 exact entity labels containing ownership words retain the S4 scope', entityOwnershipContract);

test('S5 restoring exact entity scope losses is killed', async t => {
  await entityOwnershipContract(t);
  const preflight = await mutantModule('s5-entity-preflight', 'ledger-intent-scope.js', [[
    'const entities = inventory.filter(a => a.members.every(m => key(m.entity_label) === wanted));',
    'const entities = [];',
  ]]);
  const lostEntity = await mutantModule('s5-entity-preflight-answer', 'ledger-answer.js', [], { './ledger-intent-scope.js': preflight.href });
  await assert.rejects(() => entityOwnershipContract(t, lostEntity.api.withLedgerAnswer), assert.AssertionError);
  const repeatedNickname = await mutantModule('s5-entity-renarrow', 'ledger-answer.js', [[
    'if (ownershipScope.residual && !intent.scopePlan)', 'if (ownershipScope.residual)',
  ]]);
  await assert.rejects(() => entityOwnershipContract(t, repeatedNickname.api.withLedgerAnswer), assert.AssertionError);
  const droppedLiteral = await mutantModule('s5-literal-before-type', 'ledger-intent-scope.js', [[
    'const exact = exactScopeIdentity(ownership.accounts, wanted);', 'const exact = null;',
  ]]);
  const literalAnswer = await mutantModule('s5-literal-before-type-answer', 'ledger-answer.js', [], { './ledger-intent-scope.js': droppedLiteral.href });
  await assert.rejects(() => entityOwnershipContract(t, literalAnswer.api.withLedgerAnswer), assert.AssertionError);
});

async function outsideOwnershipIdentityContract(t, api = withLedgerAnswer) {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Business Checking',entity_slug='owner' WHERE account_slug='main'");
  const scoped = intent('expense_summary', { account_hint: 'Business Checking' });
  const r = await ask(f, 'Could you retrieve Business Checking spending for sept and oct?', raw(scoped, scoped), api);
  assert.equal(r.documents, 0);
  assert.equal(r.body.ledger, null, 'a known literal outside ownership cannot become a generic role total');
  assert.deepEqual(r.body.citations, []);
  assert.equal(r.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')), false);
}
test('S5 known type-word identity outside ownership refuses a generic fallback', outsideOwnershipIdentityContract);
test('S5 restoring outside-ownership type-word widening is killed', async t => {
  await outsideOwnershipIdentityContract(t);
  const scope = await mutantModule('s5-outside-type-word', 'ledger-intent-scope.js', [[
    'if (!ownership.residual && exactScopeIdentity(inventory, wanted)) return [];',
    'if (false) return [];',
  ]]);
  const answer = await mutantModule('s5-outside-type-word-answer', 'ledger-answer.js', [], { './ledger-intent-scope.js': scope.href });
  await assert.rejects(() => outsideOwnershipIdentityContract(t, answer.api.withLedgerAnswer), assert.AssertionError);
});

test('C3 transfer endpoints filter pairs after whole-inventory matching', async t => {
  const f = setup(t);
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  f.add('reserve','2026-10-21',400,'outflow','Transfer to 1111',null);
  f.add('main','2026-10-21',400,'inflow','Transfer from 2222',null);
  f.add('main','2026-10-22',900,'outflow','Transfer to 4444',null);
  f.add('personal','2026-10-22',900,'inflow','Transfer from 1111',null);
  for (const [q,total] of [
    ['Show transfers between checking and savings last month',1000],
    ['Transfers from checking to savings last month',600],
    ['Transfers from savings to checking last month',400],
    ['Show transfers from Store Unit to personal last month',900],
    ["Show transfers from Store Unit to personal in '25",0],
  ]) {
    const r = await ask(f,q,raw(intent('transfers')));
    assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.equal(r.body.ledger.total_minor,total,q);
    assert.ok(r.body.ledger.transfer_scope,'explicit endpoint evidence');
    assert.equal(r.body.ledger.transfer_scope.confirmed_total_minor,total,'reciprocal owned endpoints certify only the selected outgoing total');
  }
});

export { setup, ask, intent, raw, context, calendarCases };

test('C3 controls preserve full dates, owner-year boundaries and literal selectors', async t => {
  const f = setup(t);
  for (const [q,reply,from,to] of [
    ['Could you retrieve expenses in October 2026',raw(intent()),'2026-10-01','2026-10-31'],
    ['Could you retrieve expenses last month',raw(intent()),'2026-10-01','2026-10-31'],
    ['Could you retrieve spending on Oct 10',raw(intent('expense_summary',{date_text:'Oct 10'})),'2026-10-10','2026-10-10'],
    ['Could you retrieve expenses since Monday',raw(intent()),'2026-11-02','2026-11-03'],
  ]) {
    const r = await ask(f,q,reply); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.deepEqual([r.body.ledger.from,r.body.ledger.to],[from,to]);
  }
  for (const [q,from,to] of [
    ['Compare expenses Dec 2025 versus Jan 2026','2025-12-01','2026-01-31'],
    ['Compare money in this q versus last q','2026-01-01','2025-12-31'],
  ]) {
    const value = q.includes('money in') ? intent('totals') : intent();
    const ctx = q.includes('money in') ? { now: Date.parse('2026-01-15T12:00:00Z'),timeZone:'UTC' } : context;
    const d = validateLedgerIntentDecision(raw(value,value),q,ctx);
    assert.equal(d.outcome,'ready'); assert.equal(d.intents.length,2);
    assert.equal(d.intents[0].from,from); assert.equal(d.intents[1].to,to);
  }
  const q = 'Compare spending at October Shop this month versus last month';
  const d = validateLedgerIntentDecision(raw(intent('merchant',{vendor_text:'October Shop'}),intent('merchant',{vendor_text:'October Shop'})),q,context);
  assert.equal(d.outcome,'ready'); assert.equal(d.intents[0].from,'2026-11-01','payee month is not a calendar operand');
});
test('C3 unsafe dates and dropped operands refuse at the calendar decision', async t => {
  const f = setup(t);
  for (const q of ['Compare expenses ju versus oct','Compare expenses Dec versus Oct','Compare expenses Feb 30 versus Oct',
    'Could you retrieve spending Sep and Oct and Nov', 'Could you compare expenses Q5 versus Q2']) {
    const reply = raw(intent(),intent());
    const d = validateLedgerIntentDecision(reply,q,context);
    assert.notEqual(d.outcome,'ready',q); assert.equal(d.intents.length,0);
    const r = await ask(f,q,reply);
    assert.equal(r.extraction,1,'calendar validation reached through extractor');
    assert.equal(r.sql.length,0,'unsafe dates never reach facts');
    assert.equal(r.body.ledger,undefined);
  }
});
test('C3 unresolved, overlapping and fourth scopes cannot become broad totals', async t => {
  const f = setup(t);
  const green = await ask(f,'Split expenses last month Store Unit vs Supply Unit vs personal',raw(intent()));
  assert.equal(green.body.ledger.parts.length,3,'green nonempty plan');
  for (const q of ['Split expenses last month Unknown Unit vs Supply Unit vs personal',
    'Split expenses last month business vs Store Unit vs personal',
    'Transfers from checking to checking last month', 'Transfers from Unknown Unit to personal last month']) {
    const r = await ask(f,q,raw(intent(q.startsWith('Transfers')?'transfers':'expense_summary')));
    assert.equal(r.extraction,1); assert.ok(r.sql.length > 0,'scope resolution reached inventory');
    assert.equal(r.documents,0); assert.equal(r.body.ledger.kind,'scope_refused');
    assert.equal(r.body.ledger.total_minor,undefined); assert.equal(r.body.ledger.comparison,undefined);
    assert.equal(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),false,'scope refusal precedes facts');
  }
  const fourth = await ask(f,'Split expenses last month Store Unit vs Supply Unit vs personal vs Other Unit',raw(intent()));
  assert.equal(fourth.extraction,1,'bounded scope validation reached');
  assert.equal(fourth.sql.length,0); assert.equal(fourth.body.ledger,undefined);
});
test('C3 incompatible monetary measures never produce a difference', async t => {
  const f = setup(t);
  const green = await ask(f,'Compare money in this quarter versus last quarter',raw(intent('totals'),intent('totals')));
  assert.equal(green.body.ledger.comparison.difference_minor,3000);
  const q = 'Compare money in at Client Unit this quarter versus spending at Store Vendor last quarter';
  const r = await ask(f,q,raw(intent('merchant',{direction:'inflow',vendor_text:'Client Unit'}),intent('merchant',{vendor_text:'Store Vendor'})));
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0,'both measure reads reached');
  assert.equal(r.documents,0); assert.equal(r.body.ledger.parts.length,2);
  assert.equal(r.body.ledger.comparison,undefined);
});
test('C3 existing task and authorization controls do not acquire ledger authority', async t => {
  const f = setup(t);
  for (const [q,expectedCalls] of [['Explain the bank policy for last month',0], ['Rewrite our expenses question for October',1], ['What color is the savings logo',1]]) {
    const r = await ask(f,q,raw(intent()));
    assert.equal(r.extraction,expectedCalls,'existing outer-task decision reached'); assert.equal(r.documents,1); assert.equal(r.sql.length,0);
  }
  const restricted = await ask(f,'Compare expenses Oct vs Sept',raw(intent(),intent()),withLedgerAnswer,{grantScope:{all:false}});
  assert.equal(restricted.documents,1); assert.equal(restricted.extraction,0); assert.equal(restricted.sql.length,0);
});

test('C3 combined month scopes and a single model core retain exact account membership', async t => {
  const f = setup(t), q = 'Could you retrieve Store Unit spending for sept and oct?';
  for (const reply of [raw(intent('expense_summary',{account_hint:'Store Unit'}),intent('expense_summary',{account_hint:'Store Unit'})),
    raw(intent('expense_summary',{account_hint:'Store Unit'}))]) {
    const r = await ask(f,q,reply);
    assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.equal(r.body.ledger.parts.length,2);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.accounts.length),[2,2]);
  }
});
test('C3 explicit plans retain the outer-task refusal', async t => {
  const f = setup(t);
  for (const [q,value] of [
    ['Rewrite this: split expenses last month Store Unit vs Supply Unit vs personal',intent()],
    ['Explain transfers from checking to savings last month',intent('transfers')],
  ]) {
    const r = await ask(f,q,raw(value));
    assert.equal(r.extraction,1,'task decision reached'); assert.equal(r.documents,1);
    assert.equal(r.sql.length,0,'outer tasks cannot use a local scope plan');
  }
});

test('C3 invalid standalone calendar literals cannot default to this month', async t => {
  const f = setup(t);
  const green = await ask(f,'Could you retrieve expenses in Oct',raw(intent()));
  assert.equal(green.body.ledger.total_minor,1700); assert.ok(green.sql.length > 0);
  for (const q of ['Could you retrieve expenses Feb 30','Could you retrieve expenses in Ju','Could you retrieve expenses Q5']) {
    const r = await ask(f,q,raw(intent()));
    assert.equal(r.extraction,1,'calendar resolution reached');
    assert.equal(r.sql.length,0,'invalid operand never becomes a default window');
    assert.equal(r.body.ledger,undefined);
  }
});

test('C3 duplicate account nicknames cannot widen a transfer endpoint', async t => {
  const f = setup(t), q = 'Transfers from Operating to Reserve last month';
  const green = await ask(f,q,raw(intent('transfers')));
  assert.equal(green.documents,0); assert.ok(green.body.ledger.transfer_scope);
  f.raw("UPDATE fin_accounts SET label='Reserve' WHERE account_slug='supply-main'");
  const r = await ask(f,q,raw(intent('transfers')));
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0,'nonempty inventory examined');
  assert.equal(r.body.ledger.kind,'scope_refused'); assert.equal(r.body.ledger.total_minor,undefined);
  assert.equal(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),false);
});

test('C3 comparison evidence states coverage for each side and a closed refusal reason', async t => {
  const f = setup(t), q = 'Compare expenses Oct vs Sept', reply = raw(intent(),intent());
  const green = await ask(f,q,reply);
  assert.equal(green.body.ledger.comparison.difference_minor,1000);
  for (const p of green.body.ledger.parts) {
    assert.equal(p.operand_coverage.complete,true);
    assert.equal(p.operand_coverage.accounts.length,4);
    assert.equal(p.operand_coverage.accounts[0].covered_from,'2024-01-01');
  }
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01' WHERE account_slug='personal'");
  const r = await ask(f,q,reply);
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0);
  assert.equal(r.body.ledger.comparison,undefined);
  assert.equal(r.body.ledger.comparison_unavailable.reason,'operand_incomplete');
  assert.equal(r.body.ledger.parts[1].operand_coverage.complete,false);
});

// Restoring mutants run from scratch module copies. Product files stay intact.
async function mutantModule(label, file, replacements, links = {}) {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const dir = new URL('../../lane-evidence/0427-c3/mutants/',import.meta.url);
  mkdirSync(dir,{recursive:true});
  const sourceURL = new URL(`../src/lib/${file}`,import.meta.url);
  let source = readFileSync(sourceURL,'utf8');
  for (const [before,after] of replacements) {
    assert.ok(source.includes(before),`mutant decision exists: ${label}`);
    source = source.replace(before,after);
  }
  source = source.replace(/from (["'])(\.\/[^"']+)\1/g,(_,quote,path)=>`from ${quote}${links[path] || new URL(`../src/lib/${path.slice(2)}`,import.meta.url).href}${quote}`);
  const target = new URL(`${label}.mjs`,dir);
  writeFileSync(target,source);
  return { api: await import(target.href), href: target.href };
}
test('C3 restoring calendar, scope, transfer and fallback defects breaks green contracts', async t => {
  const f = setup(t);
  const oldCalendar = await mutantModule('calendar','ledger-intent.js',[
    ['expandLedgerCalendarWords(question.toLowerCase())','question.toLowerCase()'],
  ]);
  const q = 'Compare expenses Oct vs Sept';
  const validReply = raw(intent(),intent());
  assert.equal(validateLedgerIntentDecision(validReply,q,context).intents.length,2);
  const wrongYear = raw(intent('expense_summary',{period:{type:'year',year:2020}}),intent('expense_summary',{period:{type:'year',year:2021}}));
  assert.equal(oldCalendar.api.validateLedgerIntentDecision(wrongYear,q,context).outcome,'fallback');
  const oldScope = await mutantModule('scope','ledger-intent.js',[
    ['const scopePlan = ledgerScopePlan(question);','const scopePlan = null;'],
  ]);
  const split = 'Split expenses last month Store Unit vs Supply Unit vs personal';
  assert.equal(validateLedgerIntentDecision(raw(intent()),split,context).intents.length,3);
  assert.notEqual(oldScope.api.validateLedgerIntentDecision(raw(intent()),split,context).intents.length,3);
  const oldTransfer = await mutantModule('transfer','ledger-answer.js',[
    ["if (intent.scopePlan?.type !== 'transfer') return true;","return true;"],
  ]);
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  f.add('main','2026-10-21',900,'outflow','Transfer to 4444',null);
  f.add('personal','2026-10-21',900,'inflow','Transfer from 1111',null);
  const transferQ = 'Transfers from checking to savings last month';
  const fixed = await ask(f,transferQ,raw(intent('transfers')));
  const restored = await ask(f,transferQ,raw(intent('transfers')),oldTransfer.api.withLedgerAnswer);
  assert.ok(fixed.sql.length > 0 && restored.sql.length > 0,'both pair filters reached');
  assert.equal(fixed.body.ledger.total_minor,600); assert.notEqual(restored.body.ledger.total_minor,600);
  const oldFallback = await mutantModule('fallback','ledger-answer.js',[
    ['if (!part.ledger && !hasForecast && !part.ownership_scope_empty && !coverageRefusal && !decision.comparison && !decision.scopePlan)', 'if (!part.ledger && !hasForecast)'],
  ]);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-01'");
  const comparisonQ = 'Compare money in this quarter versus last quarter';
  const good = await ask(f,comparisonQ,raw(intent('totals'),intent('totals')));
  const bad = await ask(f,comparisonQ,raw(intent('totals'),intent('totals')),oldFallback.api.withLedgerAnswer);
  assert.equal(good.body.ledger.parts.length,2); assert.equal(good.documents,0);
  assert.ok(bad.sql.length > 0,'restored coverage refusal reached'); assert.equal(bad.documents,1);
});
test('C3 a restoring measure guard mutant cannot subtract different directions', async t => {
  const f = setup(t);
  const q = 'Compare money in for Supplies this quarter versus spending for Supplies last quarter';
  const reply = raw(intent('category',{direction:'inflow',vendor_text:'Supplies'}),intent('category',{vendor_text:'Supplies'}));
  const r = await ask(f,q,reply);
  assert.equal(r.documents,0); assert.equal(r.body.ledger.parts.length,2);
  assert.ok(r.body.ledger.parts.every(p=>Number.isSafeInteger(p.total_minor)),'both exact measure figures reached');
  assert.equal(r.body.ledger.comparison,undefined);
  assert.equal(r.body.ledger.comparison_unavailable.reason,'measure_mismatch');
  const mutant = await mutantModule('measure','ledger-answer.js',[
    ['if (compatible && figures.every(Number.isSafeInteger))','if (figures.every(Number.isSafeInteger))'],
  ]);
  const bad = await ask(f,q,reply,mutant.api.withLedgerAnswer);
  assert.ok(bad.sql.length > 0); assert.ok(bad.body.ledger.comparison,'restored mismatch produces prohibited arithmetic');
});
test('C3 inventory changes between scoped operands fail closed', async t => {
  const f = setup(t), q = 'Split expenses last month Store Unit vs Supply Unit vs personal';
  const green = await ask(f,q,raw(intent()));
  assert.equal(green.body.ledger.partition.complete,true);
  const prepare = f.env.DB.prepare;
  let inventoryReads = 0;
  f.env.DB.prepare = sql => {
    if (sql.includes('FROM fin_accounts a') && ++inventoryReads === 4) f.raw("UPDATE fin_accounts SET label='Changed' WHERE account_slug='main'");
    return prepare(sql);
  };
  const r = await ask(f,q,raw(intent()));
  assert.ok(inventoryReads >= 4,'preflight and subsequent operand inventory checks reached');
  assert.equal(r.documents,0); assert.equal(r.body.ledger.parts.length,3);
  assert.equal(r.body.ledger.partition.complete,false); assert.ok(r.body.ledger.parts.some(p=>p.reason==='ledger_unavailable'));
  assert.equal(r.body.ledger.comparison,undefined);
});

test('C3 calendar suffixes do not rewrite numeric endpoint labels', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Reserve 2025' WHERE account_slug='reserve'");
  f.raw("UPDATE fin_accounts SET label='Reserve' WHERE account_slug='supply-main'");
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const r = await ask(f,'Transfers from Operating to Reserve 2025 last month',raw(intent('transfers')));
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0);
  assert.equal(r.documents,0); assert.equal(r.body.ledger.total_minor,600);
  assert.equal(r.body.ledger.transfer_scope.destination,'Reserve 2025');
});

test('C3 endpoint label normalization applies to both sides of identity matching', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Reserve Account' WHERE account_slug='reserve'");
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const r = await ask(f,'Transfers from Operating to Reserve Account last month',raw(intent('transfers')));
  assert.equal(r.extraction,1); assert.ok(r.sql.length > 0,'identity decision reached');
  assert.equal(r.body.ledger.total_minor,600);
});

for (const kind of ['person', 'household']) test(`C3 personal scope requires its recorded ${kind} role despite the display label`, async t => {
  const f = setup(t), q = 'Transfers from Store Unit to personal last month';
  f.raw("UPDATE fin_accounts SET label='Personal Checking' WHERE account_slug='personal'");
  f.raw("UPDATE fin_entities SET kind=? WHERE entity_slug='owner'", kind);
  f.add('main','2026-10-20',900,'outflow','Transfer to 4444',null);
  f.add('personal','2026-10-20',900,'inflow','Transfer from 1111',null);
  const green = await ask(f,q,raw(intent('transfers')));
  assert.equal(green.extraction,1); assert.ok(green.sql.length > 0);
  assert.equal(green.body.ledger.total_minor,900,'nonempty transfer decision reached');
  assert.equal(green.body.ledger.transfer_scope.confirmed_total_minor,900);
  f.raw("UPDATE fin_entities SET kind='business' WHERE entity_slug='owner'");
  const refused = await ask(f,q,raw(intent('transfers')));
  assert.equal(refused.extraction,1); assert.ok(refused.sql.length > 0,'recorded role decision reached');
  assert.equal(refused.documents,0); assert.equal(refused.body.ledger.kind,'scope_refused');
  assert.equal(refused.body.ledger.reason,'scope_unresolved');
  assert.equal(refused.body.evidence_gate.complete,false);
  assert.equal(refused.sql.some(sql => sql.includes('CROSS JOIN fin_transactions')),false);
  assert.deepEqual(refused.body.citations,[]);
});

// Every row changes only the model's omitted scope field against its green peer.
const inheritedScopes = [
  ['Could you retrieve Store Unit spending for sept and oct?', 'Store Unit', [700,1200]],
  ['Show Store Unit expenses Sep plus Oct', 'Store Unit', [700,1200]],
  ['Compare Store Unit expenses September versus October', 'Store Unit', [700,1200]],
  ['Store Unit spending Sept against Oct please', 'Store Unit', [700,1200]],
  ['Store Unit expenses in Sep compared with Oct', 'Store Unit', [700,1200]],
  ['Compare Store Unit spending this q vs last q', 'Store Unit', [1200,700]],
  ['Retrieve Supply Unit expenses Sept and Oct', 'Supply Unit', [0,300]],
  ['Compare personal spending September versus October', 'personal', [0,200]],
];
for (const [index,[q,scope,amounts]] of inheritedScopes.entries()) test(`C3 R2 shared scope row ${index}`, async t => {
  const f = setup(t);
  const scoped = intent('expense_summary',{account_hint:scope});
  for (const reply of [raw(scoped,scoped), ...([0,1,6].includes(index) ? [raw(scoped)] : [])]) {
    const green = await ask(f,q,reply);
    assert.equal(green.extraction,1); assert.equal(green.documents,0); assert.ok(green.sql.length > 0);
    assert.deepEqual(green.body.ledger.parts.map(p=>p.expense_total_minor),amounts);
  }
  for (const omitted of [0,1]) {
    const values = [scoped,scoped]; values[omitted] = intent();
    const r = await ask(f,q,raw(...values));
    assert.equal(r.extraction,1,'scope binding reached'); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),amounts);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.accounts.length),scope === 'Store Unit' ? [2,2] : [1,1]);
    assert.equal(r.body.ledger.comparison.difference_minor,amounts[0]-amounts[1]);
  }
});

const mixedScopeRequests = [
  ['Show spending in Sept and ', 'transfers from checking to savings last month', 'transfers',600],
  ['Show deposits in August plus ', 'transfers from checking to savings last month', 'transfers',600],
  ['Show spending last quarter; ', 'transfers from checking to savings last month', 'transfers',600],
  ['Retrieve balances then ', 'transfers between checking and savings last month', 'transfers',600],
  ['Retrieve spending also ', 'transfers from checking to savings last month', 'transfers',600],
  ['Show spending in Sep or ', 'transfers from checking to savings last month', 'transfers',600],
  ['Show spending in Sept ', 'transfers from checking to savings last month', 'transfers',600],
  ['Show spending last month and ', 'split expenses last month Store Unit vs Supply Unit vs personal', 'expense_summary',null],
];
for (const [index,[prefix,operation,kind,total]] of mixedScopeRequests.entries()) test(`C3 R2 explicit scope clause row ${index}`, async t => {
  const f = setup(t);
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const reply = raw(intent(kind,{period:{type:'last_month'}}));
  const green = await ask(f,`Show ${operation}`,reply);
  assert.equal(green.extraction,1); assert.equal(green.documents,0); assert.ok(green.sql.length > 0);
  if (total !== null) {
    assert.equal(green.body.ledger.total_minor,total);
    assert.equal(green.body.ledger.from,'2026-10-01');
    assert.equal(green.body.ledger.transfer_scope.confirmed_total_minor,total);
  } else assert.equal(green.body.ledger.parts.length,3);
  const plan = ledgerScopePlan(prefix+operation);
  assert.equal((prefix+operation).slice(...plan.span),operation,'nonempty bounded operation span reached');
  assert.equal(validateLedgerIntentDecision(reply,prefix+operation,context).reason,'two_part_unsplittable');
  const refused = await ask(f,prefix+operation,reply);
  assert.equal(refused.extraction,1,'bounded scope decision reached');
  assert.equal(refused.sql.length,0,'incomplete operation plan refuses before inventory or facts');
  assert.equal(refused.body.ledger,undefined);
});

for (const [index,prefix] of ['Show forecast and ', 'Show recurring plus ', 'Show totals then ', 'Project yields and ', 'Show debt also '].entries()) test(`C3 R2 unknown remainder row ${index}`, async t => {
  const f = setup(t), operation = 'transfers from checking to savings last month';
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const reply = raw(intent('transfers',{period:{type:'last_month'}}));
  const green = await ask(f,`Show ${operation}`,reply);
  assert.equal(green.body.ledger.total_minor,600); assert.ok(green.sql.length > 0);
  const plan = ledgerScopePlan(prefix+operation);
  assert.equal((prefix+operation).slice(...plan.span),operation,'unknown remainder still reaches bounded plan');
  assert.equal(validateLedgerIntentDecision(reply,prefix+operation,context).reason,'two_part_unsplittable');
  const r = await ask(f,prefix+operation,reply);
  assert.equal(r.extraction,1,'residual text decision reached');
  assert.equal(r.sql.length,0); assert.equal(r.body.ledger,undefined);
});

for (const [index,[q,first,second]] of [
  ['Compare Store Unit spending Sept versus Supply Unit spending Oct','Store Unit','Supply Unit'],
  ['Compare Store Unit spending Sept versus spending Oct','Store Unit','Store Unit'],
  ['Compare Supply Unit expenses Sept versus expenses Oct','Supply Unit','Supply Unit'],
].entries()) test(`C3 R2 independent operand scope row ${index}`, async t => {
  const f = setup(t);
  const green = await ask(f,q,raw(intent('expense_summary',{account_hint:first}),intent('expense_summary',{account_hint:second})));
  assert.equal(green.extraction,1); assert.equal(green.documents,0); assert.ok(green.sql.length > 0);
  assert.equal(green.body.ledger.parts.length,2); assert.ok(green.body.ledger.comparison);
  const refused = await ask(f,q,raw(intent('expense_summary',{account_hint:first}),intent()));
  assert.equal(refused.extraction,1);
  // An omitted literal may now fail the complete calendar complement before inventory.
  if (refused.body.ledger) {
    assert.equal(refused.body.ledger.kind,'scope_refused');
    assert.equal(refused.body.ledger.total_minor,undefined); assert.equal(refused.body.ledger.comparison,undefined);
  } else assert.ok(refused.body.gaps.some(g => g.scope === 'calendar'));
  assert.equal(refused.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),false);
});
for (const [index,scope] of ['Store Unit','Supply Unit'].entries()) test(`C3 R2 all omitted scope fields row ${index}`, async t => {
  const f = setup(t), q = `Compare ${scope} expenses Sept versus Oct`;
  const green = await ask(f,q,raw(intent('expense_summary',{account_hint:scope}),intent('expense_summary',{account_hint:scope})));
  assert.equal(green.body.ledger.parts.length,2); assert.ok(green.sql.length > 0);
  const r = await ask(f,q,raw(intent(),intent()));
  assert.equal(r.extraction,1); assert.equal(r.sql.length,0);
  assert.equal(r.body.ledger,undefined); assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
  assert.equal(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),false);
});
test('C3 R2 explicit whole-owner operands retain complete inventory', async t => {
  const f = setup(t);
  for (const [q,reply,amounts,counts] of [
    ['Compare expenses Sept versus Oct',raw(intent(),intent()),[700,1700],[4,4]],
    ['Compare Store Unit spending Sept versus all accounts spending Oct',raw(intent('expense_summary',{account_hint:'Store Unit'}),intent()),[700,1700],[2,4]],
    ['Compare all accounts spending Sept versus Store Unit spending Oct',raw(intent(),intent('expense_summary',{account_hint:'Store Unit'})),[700,1200],[4,2]],
  ]) {
    const r = await ask(f,q,reply); assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),amounts);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.accounts.length),counts);
  }
});

test('C3 R2 restoring nullable inventory authority breaks the scoped green contract', async t => {
  const f = setup(t), q = inheritedScopes[0][0], reply = raw(intent('expense_summary',{account_hint:'Store Unit'}),intent());
  const fixed = await ask(f,q,reply);
  assert.deepEqual(fixed.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  const scope = await mutantModule('r2-null-owner','ledger-intent-scope.js',[
    ["if (shared) return shared;",'if (false) return shared;'],
    ["const selections = literals.map(literal =>",'const selections = literals.map(literal => literal === null ? inventory :'],
  ]);
  const compiler = await mutantModule('r2-null-owner-intent','ledger-intent.js',[],{'./ledger-intent-scope.js':scope.href});
  const reader = await mutantModule('r2-null-owner-answer','ledger-answer.js',[],{'./ledger-intent.js':compiler.href,'./ledger-intent-scope.js':scope.href});
  const bad = await ask(f,q,reply,reader.api.withLedgerAnswer);
  assert.equal(bad.extraction,1); assert.ok(bad.sql.length > 0);
  assert.deepEqual(bad.body.ledger.parts.map(p=>p.expense_total_minor),[700,1700]);
  assert.equal(bad.body.ledger.comparison.difference_minor,-1000);
});
test('C3 R2 restoring pattern-based activation is contained by complete calendar complements', async t => {
  const f = setup(t), q = 'Compare Store Unit expenses Sept versus Oct', reply = raw(intent(),intent());
  const green = await ask(f,q,reply);
  assert.equal(green.body.ledger,undefined); assert.equal(green.sql.length,0); assert.ok(green.body.gaps.some(g => g.scope === 'calendar'));
  const compiler = await mutantModule('r2-pattern-activation','ledger-intent.js',[
    ['(comparison || result.some(intent => intent.modelAccountScope))',
     'result.some(intent => intent.modelAccountScope)'],
  ]);
  const reader = await mutantModule('r2-pattern-answer','ledger-answer.js',[["(decision?.scopePlan || decision?.operandClauses)", 'decision?.scopePlan']],{'./ledger-intent.js':compiler.href});
  const bad = await ask(f,q,reply,reader.api.withLedgerAnswer);
  assert.equal(bad.extraction,1); assert.equal(bad.sql.length,0);
  assert.equal(bad.body.ledger,undefined); assert.ok(bad.body.gaps.some(g => g.scope === 'calendar'));
});
test('C3 R2 explicit plan clause bypass is contained by calendar residue', async t => {
  const f = setup(t), q = mixedScopeRequests[0][0]+mixedScopeRequests[0][1], reply = raw(intent('transfers',{period:{type:'last_month'}}));
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const green = await ask(f,'Show transfers from checking to savings last month',reply);
  assert.equal(green.body.ledger.total_minor,600); assert.ok(green.sql.length > 0);
  const fixed = await ask(f,q,reply); assert.equal(fixed.extraction,1); assert.equal(fixed.sql.length,0);
  const compiler = await mutantModule('r2-clause-bypass','ledger-intent.js',[
    ['const baseClauses = ledgerClauseDecision(',"const baseClauses = scopePlan ? { outcome: 'ready', clauses: raw.intents.map(() => coreQuestion) } : ledgerClauseDecision("],
  ]);
  const reader = await mutantModule('r2-clause-answer','ledger-answer.js',[],{'./ledger-intent.js':compiler.href});
  const bad = await ask(f,q,reply,reader.api.withLedgerAnswer);
  assert.equal(bad.extraction,1); assert.equal(bad.sql.length,0);
  assert.equal(bad.body.ledger,undefined);
  assert.ok(bad.body.gaps.some(g=>g.scope==='calendar'));
  assert.match(bad.body.answer,/Unread calendar words:/);
});
test('C3 R2 restoring open residual acceptance drops an unknown request', async t => {
  const f = setup(t), q = 'Show forecast and transfers from checking to savings last month', reply = raw(intent('transfers',{period:{type:'last_month'}}));
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const green = await ask(f,'Show transfers from checking to savings last month',reply);
  assert.equal(green.body.ledger.total_minor,600); assert.ok(green.sql.length > 0);
  const fixed = await ask(f,q,reply); assert.equal(fixed.extraction,1); assert.equal(fixed.sql.length,0);
  const contract = await mutantModule('r2-open-residue','ledger-intent-contract.js',[
    ['!wrapper.every(word => requestWrapperWords.has(word)) ||','false ||'],
  ]);
  const compiler = await mutantModule('r2-open-residue-intent','ledger-intent.js',[],{'./ledger-intent-contract.js':contract.href});
  const reader = await mutantModule('r2-open-residue-answer','ledger-answer.js',[],{'./ledger-intent.js':compiler.href});
  const bad = await ask(f,q,reply,reader.api.withLedgerAnswer);
  assert.equal(bad.extraction,1); assert.ok(bad.sql.length > 0);
  assert.equal(bad.body.ledger.total_minor,600,'mutant silently drops the independent forecast request');
});

for (const [index,label] of ['October Unit','Reserve 2025'].entries()) test(`C3 R2 inherited labels cannot donate calendar text row ${index}`, async t => {
  const f = setup(t);
  f.raw('UPDATE fin_entities SET display_label=? WHERE entity_slug=?',label,'store');
  const q = `Compare ${label} expenses Sept versus Oct`, scoped = intent('expense_summary',{account_hint:label});
  const green = await ask(f,q,raw(scoped,scoped));
  assert.deepEqual(green.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  for (const reply of [raw(intent(),scoped),raw(scoped,intent())]) {
    const r = await ask(f,q,reply);
    assert.equal(r.extraction,1); assert.ok(r.sql.length > 0); assert.equal(r.documents,0);
    assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to]),[['2026-09-01','2026-09-30'],['2026-10-01','2026-10-31']]);
    assert.deepEqual(r.body.ledger.parts.map(p=>p.expense_total_minor),[700,1200]);
  }
});
for (const [index,countText] of ['four','4'].entries()) test(`C3 R2 scope wrapper count binds to its own operation row ${index}`, async t => {
  const f = setup(t), q = `Could you retrieve ${countText} transfers from checking to savings last month`;
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Transfer from 1111',null);
  const green = await ask(f,q,raw(intent('transfers',{count:4})));
  assert.equal(green.extraction,1); assert.ok(green.sql.length > 0); assert.equal(green.body.ledger.total_minor,600);
  const r = await ask(f,q,raw(intent('transfers',{count:3})));
  assert.equal(r.extraction,1,'count and wrapper decision reached');
  assert.equal(r.sql.length,0); assert.equal(r.body.ledger,undefined);
});

test('shared trailing year refuses before figures with explicit-year controls', async t => {
  const f = setup(t);
  f.add('main','2025-09-10',1111); f.add('main','2025-10-10',2222);
  for (const [label, years, amounts, refuse = false, twoIntents = false] of [
    ['September and October 2025',[2025,2025],[1111,2222],true],
    ['Sep plus Oct 2025',[2025,2025],[1111,2222],true],
    ["September and October '25",[2025,2025],[1111,2222],true],
    ['Sep plus Oct \u201925',[2025,2025],[1111,2222],true],
    ["September and October   '25",[2025,2025],[1111,2222],true],
    ['September and October   2025',[2025,2025],[1111,2222],true],
    ['September, and October 2025',[2025,2025],[1111,2222],true],
    ['September and September 2025',[2025,2025],[1111,1111],true,true],
    ['September versus October 2025',[2025,2025],[1111,2222],true],
    ['September vs October 2025',[2025,2025],[1111,2222],true],
    ["September against October '25",[2025,2025],[1111,2222],true],
    ['September compared with October 2025',[2025,2025],[1111,2222],true],
    ['September compared to October 2025',[2025,2025],[1111,2222],true],
    ['September this year versus October 2025',[2026,2025],[700,2222]],
    ['September 2026, and October 2025',[2026,2025],[700,2222]],
    ['September 2026 versus October 2025',[2026,2025],[700,2222]],
    ['September 2026 and October 2025',[2026,2025],[700,2222]],
    ['September 2025 and October 2025',[2025,2025],[1111,2222]],
    ["September '26 and October '25",[2026,2025],[700,2222]],
    ['Sep \u201925 plus Oct \u201925',[2025,2025],[1111,2222]],
    ['September and October',[2026,2026],[700,1200]],
  ]) {
    const question = `Show Operating spending in ${label}?`;
    const value = intent('expense_summary',{account_hint:'Operating'});
    const reply = twoIntents || /versus|\bvs\b|against|compared|, and/.test(label) ? raw(value,{...value}) : raw(value);
    const r = await ask(f,question,reply);
    if (refuse) {
      assert.equal(r.body.ledger,undefined,'shared year refuses before figures');
      assert.equal(r.sql.length,0,'ambiguous year refuses before ledger reads');
      assert.equal((r.body.citations || []).length,0);
      assert.doesNotMatch(r.body.answer || '',/\$\s*\d/);
      assert.equal(validateLedgerIntentDecision(reply,question,context).reason,'period_contradiction');
      continue;
    }
    assert.ok(r.body.ledger,label);
    assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to,p.expense_total_minor]),
      years.map((y,i)=>[`${y}-${i?'10':'09'}-01`,`${y}-${i?'10-31':'09-30'}`,amounts[i]]));
  }
});

// Fixed-seed generated scope table: every refusal has an exact numeric peer.
const relativeYearSeed = 0x6b42e193;
let relativeYearState = relativeYearSeed;
const relativeYearPick = values => {
  relativeYearState = (Math.imul(relativeYearState,1664525)+1013904223) >>> 0;
  return values[relativeYearState % values.length];
};
for (const relative of ['last','previous','prior','this','current','next']) {
  for (const count of [1,2]) for (let row=0; row<3; row++) {
    const connector = relativeYearPick(count === 1 ? ['and','plus'] : ['and','plus','versus','against']);
    const prefix = relativeYearPick(['','of ','of the ']);
    const months = relativeYearPick([['September','October'],['Sep','Oct'],['Sept.','Oct.']]);
    const suffix = `${prefix}${relative} ${['year','yr','calendar year'][row]}`;
    test(`shared relative year seed ${relativeYearSeed} ${relative}/${count}/${row}`, async t => {
      const f = setup(t);
      f.add('main','2025-09-10',1137); f.add('main','2025-10-10',2283);
      const value = intent('expense_summary',{account_hint:'Operating'});
      const reply = count === 1 ? raw(value) : raw(value,{...value});
      const question = `Show Operating spending in ${months[0]} ${connector} ${months[1]} ${suffix}?`;
      const r = await ask(f,question,reply);
      assert.equal(r.extraction,1,'real extraction boundary reached');
      assert.equal(sharedLedgerMonthYear(question),true,'normalized shared-year authority recognized');
      assert.equal(validateLedgerIntentDecision(reply,question,context).reason,'period_contradiction','shared-year decision reached');
      assert.equal(r.body.ledger,undefined,'no mixed-year figures');
      assert.equal(r.sql.length,0,'refusal precedes financial reads');
      assert.equal((r.body.citations || []).length,0);
      assert.doesNotMatch(r.body.answer || '',/\$\s*\d/);
      const greenQuestion = `Show Operating spending in ${months[0]} 2025 ${connector} ${months[1]} 2025?`;
      const green = await ask(f,greenQuestion,reply);
      assert.equal(green.extraction,1); assert.equal(green.documents,0); assert.ok(green.sql.length>0);
      assert.deepEqual(green.body.ledger.parts.map(p=>[p.from,p.to,p.expense_total_minor]),
        [['2025-09-01','2025-09-30',1137],['2025-10-01','2025-10-31',2283]]);
      assert.equal(green.body.ledger.comparison.difference_minor,-1146);
    });
  }
}

test('shared relative year primary regression and explicit first-year controls', async t => {
  const f = setup(t);
  f.add('main','2025-09-10',1137); f.add('main','2025-10-10',2283);
  const value = intent('expense_summary',{account_hint:'Operating'});
  for (const suffix of ['last year','of last year','of the previous year','last   year','last calendar year','last yr','of the previous yrs','last calendar yr']) {
    for (const reply of [raw(value),raw(value,{...value})]) {
      const q = `Show Operating spending in September and October ${suffix}?`;
      const r = await ask(f,q,reply);
      assert.equal(r.extraction,1);
      assert.equal(validateLedgerIntentDecision(reply,q,context).reason,'period_contradiction');
      assert.equal(r.sql.length,0); assert.equal(r.body.ledger,undefined);
    }
  }
  for (const relative of ['last','previous','prior','this','current','next']) {
    const q = `Show Operating spending in September 2026 and October ${relative} year?`;
    assert.equal(sharedLedgerMonthYear(q),false,'explicit first year reaches independent operand guards');
    const firstRelative = `Show Operating spending in September ${relative} year and October 2025?`;
    assert.equal(sharedLedgerMonthYear(firstRelative),false,'relative first year is independently authoritative');
    const firstResult = await ask(f,firstRelative,raw(value,{...value}));
    assert.equal(firstResult.extraction,1);
    if (['prior','next'].includes(relative)) {
      assert.equal(firstResult.body.ledger,undefined); assert.equal(firstResult.sql.length,0);
    } else {
      const year = ['last','previous'].includes(relative) ? 2025 : 2026;
      assert.ok(firstResult.sql.length>0);
      assert.deepEqual(firstResult.body.ledger.parts.map(p=>[p.from,p.to,p.expense_total_minor]),
        [[`${year}-09-01`,`${year}-09-30`,year===2025?1137:700],['2025-10-01','2025-10-31',2283]]);
    }
    const r = await ask(f,q,raw(value,{...value}));
    assert.equal(r.extraction,1);
    if (['prior','next'].includes(relative)) {
      assert.equal(r.body.ledger,undefined); assert.equal(r.sql.length,0);
    } else {
      assert.ok(r.sql.length>0); assert.equal(r.documents,0);
      const year = ['last','previous'].includes(relative) ? 2025 : 2026;
      assert.deepEqual(r.body.ledger.parts.map(p=>[p.from,p.to,p.expense_total_minor]),
        [['2026-09-01','2026-09-30',700],[`${year}-10-01`,`${year}-10-31`,year===2025?2283:1200]]);
    }
  }
});

// Endpoint filtering does not upgrade an equal-amount advisory match into an
// identified transfer; the reciprocal source evidence remains mandatory.
test('C3 endpoint scope keeps advisory equal-amount pairs visible and uncounted', async t => {
  const f = setup(t);
  f.add('main','2026-10-20',600,'outflow','Transfer to 2222',null);
  f.add('reserve','2026-10-20',600,'inflow','Customer invoice payment',null);
  const r = await ask(f,'Transfers from checking to savings last month',raw(intent('transfers')));
  assert.equal(r.extraction,1); assert.equal(r.documents,0); assert.ok(r.sql.length > 0);
  assert.equal(r.body.ledger.total_minor,0);
  assert.equal(r.body.ledger.transfer_scope.confirmed_total_minor,0);
  assert.equal(r.body.ledger.transfers.length,1);
  assert.equal(r.body.ledger.transfers[0].counted,false);
  assert.equal(r.body.ledger.transfers[0].excluded_from_totals,true);
  assert.match(r.body.answer,/possible transfer, not counted/);
});
