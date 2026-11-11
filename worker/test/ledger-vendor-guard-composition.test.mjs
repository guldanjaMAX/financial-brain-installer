import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

const query = 'How much did I spend at Cedarstone this month?';
const base = new URL('../src/lib/', import.meta.url);
const source = readFileSync(new URL('ledger-answer.js', base), 'utf8');
const data = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
const absolute = text => text.replace(/from (["'])(\.\/.+?)\1/g,
  (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
function setup(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('offline only'));
  f.add('confirmed', 'Card purchase', 'CEDARSTONE *TOOLS', { cents: 123, direction: 'outflow' });
  f.add('lookalike', 'Card purchase', 'CEDA *MEDIA', { cents: 9999, direction: 'outflow' });
  return f;
}
function confirmed(body, f) {
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'real reader reached');
  assert.equal(body.ledger.total_minor, 123, 'confirmed amount survives a review-only citation');
  assert.equal(body.ledger.named_selector_guard, undefined);
  assert.equal(body.ledger.possible_identity_members.length, 1);
  const member = body.ledger.possible_identity_members[0];
  assert.equal(member.payee, 'CEDA *MEDIA');
  assert.ok(body.citations.some(ref => ref.ref === member.ref), 'lookalike review evidence reached guard');
  assert.ok(body.ledger.groups.every(group => group.citations.every(n => !member.citations.includes(n))),
    'review evidence never contributes to a confirmed group');
}
test('vendor review citations survive the named-selector guard without entering totals', async t => {
  const f = setup(t);
  confirmed(await f.ask(query), f);
});
test('named-selector guard rejects laundering a possible identity into a confirmed group', async t => {
  const f = setup(t);
  confirmed(await f.ask(query), f);
  const site = '      answer += possibleIdentityLine(members);';
  assert.equal(source.split(site).length - 1, 1, 'laundering decision reached once');
  const changed = source.replace(site, site + '\n        ledger.groups[0].citations.push(members[0].citations[0]);');
  const mutant = (await import(data(absolute(changed)))).withLedgerAnswer;
  const body = await (await mutant({ env: f.env, question: query, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner' }, () => assert.fail('real ledger route'))).json();
  assert.equal(body.ledger.named_selector_guard.rejected, true, 'post-condition rejects foreign amount evidence');
  assert.equal(body.ledger.total_minor, null);
  assert.deepEqual(body.citations, []);
  confirmed(await f.ask(query), f);
});
test('empty covered vendor lookup keeps bounded absence without inventing a zero', async t => {
  const f = ledgerFixture(t);
  const body = await f.ask(query);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'empty snapshot reader reached');
  assert.equal(body.ledger.coverage.complete, true, 'covered green control');
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false);
  assert.match(body.answer, /^No charges found for Cedarstone from 2026-10-01 to 2026-10-12 on /);
  assert.doesNotMatch(body.answer, /\$/);
});
test('possible vendor alone retains bounded absence and quoted review evidence', async t => {
  const f = ledgerFixture(t);
  f.add('lookalike', 'Card purchase', 'CEDA *MEDIA', { cents: 9999, direction: 'outflow' });
  const body = await f.ask(query);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'possible identity reader reached');
  assert.equal(body.ledger.possible_identity_count, 1, 'review decision reached');
  assert.equal(body.ledger.total_minor, null);
  assert.match(body.answer, /^No charges found for Cedarstone from 2026-10-01 to 2026-10-12 on /);
  assert.ok(body.answer.includes('"CEDA *MEDIA"'));
  assert.doesNotMatch(body.answer, /\$/);
});
async function monthly(f, answerPath, question = 'Could you retrieve charges at Cedarstone month by month since September?') {
  f.env.ANTHROPIC_API_KEY = 'synthetic-unused';
  let models = 0;
  const start = f.calls.length;
  const body = await (await answerPath({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner',
    callLLM: async () => {
      models++;
      return { content: [{ type: 'text', text: JSON.stringify({ ambiguous: false, unanswered_part: null,
        intents: [{ kind: 'merchant', direction: 'outflow', vendor_text: 'Cedarstone', count: null, account_hint: null,
          amount_text: null, date_text: null, period: { type: 'none' } }] }) }] };
    } }, () => assert.fail('monthly ledger reached'))).json();
  assert.equal(models, 1, 'supported extraction reached');
  assert.ok(f.calls.slice(start).some(sql => /JOIN fin_transactions/.test(sql)), 'monthly reader reached');
  return body;
}
function monthlyConfirmed(body) {
  assert.equal(body.ledger.named_selector_guard, undefined, 'review-only citation cannot erase a proved monthly amount');
  assert.equal(body.ledger.months.length, 2, 'monthly composition reached');
  assert.deepEqual(body.ledger.months.map(month => month.total_minor), [57, 123]);
  const october = body.ledger.months[1], member = october.possible_identity_members[0];
  assert.equal(member.payee, 'CEDA *MEDIA');
  assert.ok(body.answer.includes('"CEDA *MEDIA"'));
  assert.ok(body.citations.some(ref => ref.ref === member.ref && member.citations.includes(ref.n)), 'rebased review citation retained');
  assert.ok(member.citations.every(n => !october.amount_citations.includes(n)), 'candidate never enters monthly amount evidence');
}
test('monthly vendor composition preserves quoted review evidence beside exact monthly amounts', async t => {
  const f = setup(t);
  confirmed(await f.ask(query), f);
  f.add('september', 'Card purchase', 'CEDARSTONE *TOOLS', { date: '2026-09-05', cents: 57, direction: 'outflow' });
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  monthlyConfirmed(await monthly(f, withLedgerAnswer));
});
test('monthly selector guard rejects a candidate citation laundered into amount evidence', async t => {
  const f = setup(t);
  f.add('september', 'Card purchase', 'CEDARSTONE *TOOLS', { date: '2026-09-05', cents: 57, direction: 'outflow' });
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  monthlyConfirmed(await monthly(f, withLedgerAnswer));
  const original = readFileSync(new URL('ledger-monthly.js', base), 'utf8');
  const site = 'amount_citations: amountCitations,';
  assert.equal(original.split(site).length - 1, 1, 'monthly amount decision reached once');
  const changed = original.replace(site,
    'amount_citations: [...amountCitations, ...identityMembers.flatMap(member => member.citations)],');
  const mutant = (await import(data(absolute(source.replace('"./ledger-monthly.js"', JSON.stringify(data(absolute(changed)))))))).withLedgerAnswer;
  const body = await monthly(f, mutant);
  assert.equal(body.ledger.named_selector_guard.rejected, true, 'foreign monthly amount evidence rejected');
  assert.equal(body.ledger.total_minor, null);
  assert.deepEqual(body.citations, []);
  monthlyConfirmed(await monthly(f, withLedgerAnswer));
});
test('a review-only month cannot inherit zero from an exact vendor in another month', async t => {
  const f = setup(t);
  f.add('september', 'Card purchase', 'Cedarstone', { date: '2026-09-05', cents: 57, direction: 'outflow' });
  const { withLedgerAnswer } = await import('../src/lib/ledger-answer.js');
  monthlyConfirmed(await monthly(f, withLedgerAnswer));
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='confirmed'");
  const body = await monthly(f, withLedgerAnswer);
  assert.equal(body.ledger.months.length, 2, 'both period decisions reached');
  assert.equal(body.ledger.months[0].total_minor, 57, 'other-month exact identity control');
  const october = body.ledger.months[1];
  assert.equal(october.coverage.complete, true, 'covered candidate-only month reached');
  assert.equal(october.total_minor, null, 'candidate cannot establish zero');
  assert.equal(october.subtotal_minor, null);
  assert.equal(october.available, false);
  assert.equal(october.possible_identity_members.length, 1);
  assert.deepEqual(october.amount_citations, []);
  const member = october.possible_identity_members[0];
  assert.ok(member.citations.every(n => body.citations.some(ref => ref.n === n && ref.ref === member.ref)));
  assert.ok(body.answer.includes('"CEDA *MEDIA"'));
  assert.doesNotMatch(body.answer, /October 2026: \$0\.00/);
});
for (const description of ['External receipt', 'Store refund']) test(`an exact credit cannot certify zero beside an unresolved vendor charge: ${description}`, async t => {
  const f = setup(t);
  confirmed(await f.ask(query), f);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='confirmed'");
  f.add('credit', description, 'Cedarstone', { cents: 37, direction: 'inflow', date: '2026-10-05' });
  const body = await f.ask(query);
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'mixed credit/candidate reader reached');
  assert.equal(body.ledger.total_minor, null, 'an unresolved outflow cannot become certified zero');
  assert.equal(body.ledger.possible_identity_count, 1, 'vendor identity decision reached');
  assert.equal(body.ledger.complete, false);
  assert.ok(body.answer.includes('"CEDA *MEDIA"'));
  assert.doesNotMatch(body.answer, /No spending at|\$0\.00/);
});
test('bounded possible vendor copy still discloses omitted account history without money padding', async t => {
  const f = setup(t);
  confirmed(await f.ask(query), f);
  f.raw("DELETE FROM fin_transactions WHERE txn_uid='confirmed'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('uncovered','owner','checking','asset','9876','manual','owner_stated','confirmed',?)`, NOW);
  const body = await f.ask(query);
  assert.equal(body.ledger.possible_identity_count, 1, 'identity review reached');
  assert.equal(body.ledger.match_basis, 'possible');
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.coverage.omitted_account_count, 1, 'omitted denominator reached');
  assert.match(body.answer, /No charges found for Cedarstone/);
  assert.match(body.answer, /Omitted accounts:.*9876.*does not include every requested date/);
  assert.doesNotMatch(body.answer, /\$|Want me|Partial view using/);
});
