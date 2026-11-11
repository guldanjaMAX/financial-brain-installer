import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { replay } from '../../eval/fast-loop/money-replay.mjs';
import { selectVendorFamily } from '../src/lib/ledger-analysis.js';
import { BASE_CASES, evidence } from '../../test/fixtures/fastloop-money/input.mjs';

function check(body, expected, possiblePayees) {
  assert.equal(body.ledger?.kind, 'merchant', 'vendor decision reached');
  assert.equal(body.ledger.coverage.complete, true);
  assert.equal(body.ledger.total_minor, expected, 'only confirmed vendor identity is summed');
  assert.equal(body.ledger.lead_total_minor, expected);
  assert.equal(body.ledger.if_own_transfers.total_minor, expected);
  assert.equal(body.ledger.complete, true);
  assert.equal(body.evidence_gate.complete, true);
  assert.equal(body.ledger.possible_identity_count, possiblePayees.length);
  assert.deepEqual(body.ledger.possible_identity_members.map(member => member.payee).sort(), [...possiblePayees].sort());
  assert.ok(body.ledger.included_payees.every(payee => !possiblePayees.includes(payee)));
  assert.equal(body.ledger.groups.reduce((sum, group) => sum + group.total_minor, 0), expected);
  for (const member of body.ledger.possible_identity_members) {
    assert.match(body.answer, /possible.*not included/i);
    assert.ok(body.answer.includes(`"${member.payee}"`), 'original bank text is quoted');
    assert.ok(member.citations.length > 0, 'possible member has bank-row evidence');
    for (const n of member.citations) {
      assert.ok(body.answer.includes(`[${n}]`));
      assert.equal(body.citations[n - 1].ref, member.ref);
    }
  }
}

test('B1: shorter descriptor root is a cited possible vendor, never certified spend', async t => {
  const f = ledgerFixture(t);
  f.add('confirmed', 'Card purchase', 'CEDARSTONE *TOOLS', { cents: 123, direction: 'outflow' });
  // Green control proves the covered vendor decision independently of distractors.
  const green = await f.ask('How much did I spend at Cedarstone this month?');
  assert.equal(green.ledger.total_minor, 123);
  assert.equal(green.evidence_gate.complete, true);
  f.add('distractor', 'Card purchase', 'CEDAR *MEDIA', { cents: 9900, direction: 'outflow' });
  check(await f.ask('How much did I spend at Cedarstone this month?'), 123, ['CEDAR *MEDIA']);
  assert.ok(f.calls.some(sql => /FROM fin_transactions/i.test(sql)), 'real ledger reader reached');
  assert.equal(f.documentCalls, 0);
});

test('possible identities alone refuse a total and retain quoted evidence', async t => {
  const f = ledgerFixture(t);
  const question = 'How much did I spend at Cedarstone this month?';
  const empty = await f.ask(question);
  assert.equal(empty.ledger.total_minor, null);
  assert.match(empty.answer, /^No charges found for Cedarstone /);
  assert.doesNotMatch(empty.answer, /\$/);
  assert.equal(empty.evidence_gate.complete, false);
  f.add('only-prefix', 'Card purchase', 'CEDAR *MEDIA', { cents: 9900, direction: 'outflow' });
  const body = await f.ask(question);
  assert.equal(body.ledger.kind, 'merchant');
  assert.equal(body.ledger.possible_identity_count, 1, 'identity decision reached');
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.complete, false);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.if_own_transfers.total_minor, null);
  assert.match(body.answer, /"CEDAR \*MEDIA" \[1\]/);
  assert.equal(body.citations[0].amount_minor, 9900);
});

test('possible identities never hide incomplete coverage', async t => {
  const f = ledgerFixture(t);
  const question = 'How much did I spend at Cedarstone this month?';
  f.add('confirmed', 'Card purchase', 'CEDARSTONE *TOOLS', { cents: 123, direction: 'outflow' });
  f.add('prefix', 'Card purchase', 'CEDAR *MEDIA', { cents: 9900, direction: 'outflow' });
  check(await f.ask(question), 123, ['CEDAR *MEDIA']);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-10-07'");
  const body = await f.ask(question);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger?.total_minor ?? null, null);
  assert.ok(f.calls.some(sql => /fin_account_coverage/.test(sql)), 'coverage decision reached');
});

function cases() {
  // Independent ownership labels and amounts are fixed by construction, never
  // computed with product normalization or selector functions.
  return Array.from({ length: 600 }, (_, i) => {
    const root = ['Cedarstone', 'Amberbrook', 'Silverplain'][i % 3] + String(1000 + i);
    const distractors = [root.slice(0, 5), root + 'works', 'Super' + root, 'Super' + root + 'works'];
    const snapshot = evidence();
    const prefix = ['', 'SQ * ', 'TST*', 'PAYPAL * '][i % 4];
    const confirmed = [`${prefix}${root.toUpperCase()} *TOOLS`, `${root} *CLOUD`];
    const possible = distractors.map((name, n) => `${n % 2 ? prefix : ''}${name} *MEDIA`);
    const expected = 123 + i + 463;
    snapshot.rows = [...confirmed, ...possible].map((payee, n) => ({ id: n + 1,
      uid: `identity-${i}-${n}`, account: 'cash', date: '2026-10-05', pending: 0,
      cents: String(n === 0 ? 123 + i : n === 1 ? 463 : 9900 + i + n),
      direction: 'outflow', description: 'Card purchase', payee }));
    return { ...BASE_CASES[0], id: `prefix-identity/${i}`, base: false, snapshot, expected, possible,
      question: `How much did I spend at ${root} in October 2026?`,
      clock: { now_utc: '2026-11-02T19:00:00Z', owner_time_zone: 'America/Phoenix' } };
  });
}
function run(inputs, sourceOverrides = {}) {
  const observations = [];
  for (let i = 0; i < inputs.length; i += 100) {
    const result = replay({ cases: inputs.slice(i, i + 100), snapshotFor: c => c.snapshot, sourceOverrides });
    assert.equal(result.provider_calls, 0);
    assert.equal(result.production_writes, 0);
    for (const observation of result.observations) {
      assert.equal(observation.execution_status, 'complete');
      assert.ok(observation.trace.dependencies.includes('transactions'));
      observations.push(observation);
    }
  }
  return observations;
}

test('600 prefix, suffix and substring collisions retain exact family totals', () => {
  const inputs = cases(), observations = run(inputs);
  assert.equal(observations.length, 600);
  observations.forEach((o, i) => check(o.body, inputs[i].expected, inputs[i].possible));
  console.log('prefix_property=600/600 wrong_figures=0');
});

const base = new URL('../src/lib/', import.meta.url);
const analysis = readFileSync(new URL('ledger-analysis.js', base), 'utf8');
const answer = readFileSync(new URL('ledger-answer.js', base), 'utf8');
for (const [name, file, from, to] of [
  ['prefix accepted as identity', 'ledger-analysis.js',
    'possibleIdentity.push(row); continue;', 'descriptors.push(row); continue;'],
  ['possible members summed', 'ledger-answer.js',
    'ledger.total_minor = sumMinor(matched); ledger.unsorted_minor',
    'ledger.total_minor = sumMinor([...matched, ...(namedOutflowMerchant?.possibleIdentity || [])]); ledger.unsorted_minor'],
  ['exact-root family mapping ignored', 'ledger-analysis.js', 'root === wanted', 'false'],
]) test(`kills ${name}`, () => {
  const source = file === 'ledger-analysis.js' ? analysis : answer;
  assert.equal(source.split(from).length - 1, 1, 'exactly one mutation decision point');
  const inputs = cases().slice(0, 1);
  run(inputs).forEach(o => check(o.body, inputs[0].expected, inputs[0].possible));
  const broken = run(inputs, { [file]: source.replace(from, to) });
  assert.throws(() => check(broken[0].body, inputs[0].expected, inputs[0].possible), { name: 'AssertionError' });
  run(inputs).forEach(o => check(o.body, inputs[0].expected, inputs[0].possible));
});


function aliasCases() {
  const families = [
    ['Google', 'GOOGLE', 'GOOG', 'GOOGOL'],
    ['Amazon', 'AMAZON', 'AMZN', 'AMAZONIA SHOP'],
    ['Microsoft', 'MICROSOFT', 'MSFT', 'MSFTWARE'],
    ['Apple', 'APPLE.COM/BILL', 'APL', 'APPLEWOOD'],
    ['Adobe', 'ADOBE', 'ADOBE', 'ADOBEWORKS'],
    ['Meta', 'FACEBOOK', 'FB', 'METALWORKS'],
    ['Intuit', 'QUICKBOOKS', 'INTUIT', 'INTUITIVE'],
    ['Zoom', 'ZOOM', 'ZOOM', 'ZOOMER'],
    ['Dropbox', 'DROPBOX', 'DROPBOX', 'DROPBOXER'],
    ['Shopify', 'SHOPIFY', 'SHOPIFY', 'SHOPIFYING'],
  ];
  return Array.from({ length: 600 }, (_, i) => {
    const [brand, full, alias, lookalike] = families[i % families.length];
    const snapshot = evidence();
    const prefix = ['', 'SQ * ', 'TST*', 'PAYPAL * '][Math.floor(i / 10) % 4];
    const confirmed = i % 2 ? [full, alias] : [`${prefix}${full} *TOOLS`, `${alias} *CLOUD`];
    const possible = [lookalike, `${alias}WORKS *MEDIA`, `SUPER${alias} *MEDIA`, `${brand.slice(0, 3)} *MEDIA`];
    const expected = 452 + i + 463;
    snapshot.rows = [...confirmed, ...possible].map((payee, n) => ({ id: n + 1,
      uid: `alias-${i}-${n}`, account: 'cash', date: '2026-10-05', pending: 0,
      cents: String(n === 0 ? 452 + i : n === 1 ? 463 : 9900 + i + n),
      direction: 'outflow', description: 'Card purchase', payee }));
    return { ...BASE_CASES[0], id: `alias-identity/${i}`, base: false, snapshot, expected, possible,
      question: `How much did I spend at ${brand} in October 2026?`,
      clock: { now_utc: '2026-11-02T19:00:00Z', owner_time_zone: 'America/Phoenix' } };
  });
}

test('600 alias members, lookalikes, shared prefixes and substrings have independent totals', () => {
  const inputs = aliasCases(), observations = run(inputs);
  assert.equal(observations.length, 600);
  observations.forEach((o, i) => check(o.body, inputs[i].expected, inputs[i].possible));
  console.log('alias_property=600/600 wrong_figures=0');
});

for (const [name, from, to] of [
  ['alias table ignored', 'aliases.includes(root || identity)', 'false'],
]) test(`kills ${name}`, () => {
  assert.equal(analysis.split(from).length - 1, 1, 'exactly one alias decision point');
  const inputs = aliasCases().slice(0, 1);
  run(inputs).forEach(o => check(o.body, inputs[0].expected, inputs[0].possible));
  const broken = run(inputs, { 'ledger-analysis.js': analysis.replace(from, to) });
  assert.throws(() => check(broken[0].body, inputs[0].expected, inputs[0].possible), { name: 'AssertionError' });
  run(inputs).forEach(o => check(o.body, inputs[0].expected, inputs[0].possible));
});


test('whole aliases work in both directions; literal and unlisted selectors stay protected', () => {
  const families = [
    ['Google', 'GOOG'], ['Amazon', 'AMZN', 'AMZ MKTP', 'AMZ MKTP US', 'AMZN MKTP', 'AMZN MKTP US'],
    ['Microsoft', 'MSFT'], ['Apple', 'APPLE.COM/BILL', 'APL'], ['Adobe'],
    ['Meta', 'Facebook', 'FB'], ['Intuit', 'QuickBooks', 'INTUIT QUICKBOOKS'],
    ['Zoom'], ['Dropbox'], ['Shopify'],
  ];
  for (const family of families) for (const requested of family) for (const alias of family) {
    const row = { payee: `${alias} *CLOUD`, direction: 'outflow' };
    assert.deepEqual(selectVendorFamily([row], requested).matched, [row]);
    const protectedSelection = selectVendorFamily([row], requested, { allowProductFamily: false });
    assert.equal(protectedSelection.exact.length, 0, 'protected literal decision reached');
    assert.deepEqual(protectedSelection.matched, protectedSelection.nameOnly,
      'protected selectors retain only unconfirmed name candidates');
  }
  const row = { payee: 'GOOG *CLOUD', direction: 'outflow' };
  for (const requested of ['GOOGOL', 'GOOGLE WORKSPACE', 'MY GOOGLE']) {
    const selection = selectVendorFamily([row], requested);
    assert.equal(selection.matched.length, 0);
    assert.equal(selection.possibleIdentity.length, 1, 'unlisted requested identity reviewed');
  }
});


test('kills a lookalike inserted into the reviewed alias table', async t => {
  const aliases = readFileSync(new URL('vendor-aliases.js', base), 'utf8');
  const from = "['google', 'goog']";
  assert.equal(aliases.split(from).length - 1, 1, 'exactly one alias-table mutation site');
  const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const absolute = source => source.replace(/from (["'])(\.\/.+?)\1/g,
    (_, quote, path) => `from ${quote}${new URL(path, base).href}${quote}`);
  const tableMutant = data(aliases.replace(from, "['google', 'goog', 'googol']"));
  const analysisMutant = data(absolute(analysis.replace('"./vendor-aliases.js"', JSON.stringify(tableMutant))));
  const answerMutant = data(absolute(answer.replace('"./ledger-analysis.js"', JSON.stringify(analysisMutant))));
  const mutant = (await import(answerMutant)).withLedgerAnswer;
  const f = ledgerFixture(t), question = 'How much did I spend at Google this month?';
  f.add('workspace', 'Card purchase', 'GOOGLE *WORKSPACE', { cents: 452, direction: 'outflow' });
  f.add('cloud', 'Card purchase', 'GOOG *CLOUD', { cents: 463, direction: 'outflow' });
  f.add('lookalike', 'Card purchase', 'GOOGOL', { cents: 9900, direction: 'outflow' });
  check(await f.ask(question), 915, ['GOOGOL']);
  const broken = await (await mutant({ env: f.env, question, now: Date.parse(NOW),
    grantScope: { all: true }, scopePrincipalKind: 'owner' },
    async () => Response.json({ route: 'documents' }))).json();
  assert.equal(broken.ledger.kind, 'merchant', 'mutated alias decision reached');
  assert.equal(broken.ledger.coverage.complete, true);
  assert.throws(() => check(broken, 915, ['GOOGOL']), { name: 'AssertionError' });
  assert.ok(f.calls.some(sql => /FROM fin_transactions/i.test(sql)), 'real ledger reader reached');
  check(await f.ask(question), 915, ['GOOGOL']);
});
