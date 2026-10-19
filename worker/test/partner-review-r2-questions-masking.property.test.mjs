// Partner review round 2: seeded, deterministic property generators for
// (1) long-question faults and (2) identifier masking across output paths.
//
// Made-up data only. Every name is a role-word fixture ("Payer Taylor",
// "Vendor Alpha LLC"); every identifier is generated here and is synthetic.
// No network, no real Brain: ledger questions run on the real-SQLite review
// fixture, document questions on the acceptance fixture (fetch is denied).
//
// Each property prints its seed and a shrunk counter-example on failure.
// Override a seed with R2_SEED_<ID>=<n> (for example R2_SEED_Q1=7).
// Expected on HEAD 07420ce: R2-Q1, R2-Q2 and R2-K2 fail, each with a NEW
// root cause and a paired "-repro" test (fails) and "-control" (passes);
// R2-Q3 and R2-K1 pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture, NOW as LEDGER_NOW } from './ledger-review-fixture.mjs';
import { acceptanceFixture } from './gaps-acceptance-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { createInflowAttributor, payerRegistry } from '../src/lib/ledger-attribution.js';
import { entityFactAnswer } from '../src/lib/entity-fact-answer.js';

// ------------------------------------------------------------------ PRNG ---
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFor = (id, fallback) => Number(process.env[`R2_SEED_${id}`] || fallback);
const gen = seed => {
  const r = mulberry32(seed);
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  return { r, int, pick: list => list[Math.floor(r() * list.length)], chance: p => r() < p };
};
const now = Date.parse(LEDGER_NOW); // 2026-10-12T12:00:00Z
const lower = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim();

// ============================================================== AREA 1 =====
// Shared ledger world: one checking account ****1234 covered through
// 2026-10-12, a registered counterparty "Payer Taylor" and two outflows.
function ledgerWorld(t) {
  const f = ledgerFixture(t);
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('payer-taylor','Payer Taylor','business','counterparty','owner_stated','confirmed',?)`, LEDGER_NOW);
  f.add('d1', 'ACH CREDIT', 'Payer Taylor', { date: '2026-09-15', cents: 125000 });
  f.add('d2', 'ACH CREDIT', 'Payer Taylor', { date: '2026-10-05', cents: 40000 });
  f.add('o1', 'Vendor Alpha LLC', null, { date: '2026-09-20', cents: 30000, direction: 'outflow' });
  f.add('o2', 'Vendor Beta Supply', null, { date: '2026-09-22', cents: 12000, direction: 'outflow' });
  f.raw(`UPDATE fin_transactions SET category='Office', category_basis_state='confirmed' WHERE txn_uid='o1'`);
  return f;
}

// Answer class + every money figure the answer certifies. Documents routing
// without a ledger gap is "unsupported": the grammar is bounded by design
// (ledger-question.js:6-7) and that route makes no ledger claim.
function outcome(body) {
  if (body.route === 'documents') {
    const gaps = (body.gaps || []).filter(Boolean);
    return gaps.length ? { cls: 'ledger_refusal', sig: `refusal:${gaps[0].reason}` } : { cls: 'unsupported', sig: 'unsupported' };
  }
  if (body.code) return { cls: 'ledger_refusal', sig: `refusal:${body.code}` };
  const l = body.ledger;
  const sig = JSON.stringify([l.kind, l.from, l.to, l.found ?? null, body.evidence_gate?.complete ?? null, l.total_minor ?? null,
    (l.accounts || []).map(a => [a.account_mask, a.credits_minor ?? null, a.debits_minor ?? null, a.current_minor ?? null]),
    (l.rows || []).map(row => row.amount_minor), (body.citations || []).map(c => c.amount_minor)]);
  if (body.evidence_gate?.complete !== true) return { cls: 'ledger_refusal', sig };
  if (l.found === false || /No matching|No (?:deposits|expenses) found/.test(body.answer || '')) return { cls: 'none', sig };
  return { cls: 'answer', sig };
}

const DATE_SAME = ['in September 2026', 'during September 2026', 'for September 2026', 'over September 2026',
  'in september 2026', 'in September, 2026', 'in the month of September 2026', 'in Sept 2026', 'in September of 2026'];
const ACCT_SAME = ['', 'in my checking account', 'into my checking account', 'in my account ending 1234', 'in checking',
  'in my checking account ending in 1234', 'to my checking account ending 1234'];
const PRE = ['', 'Please, ', 'Quick question: ', 'Hey, ', 'Okay so ', 'One more thing: ', 'Can you check: ', 'I need to know, '];
const SUF = ['', ', please', ' please', ', thanks', ' for me', ', if you can', ' right now', ' exactly', ' again'];
const END = ['?', '?', '.', ''];
const cap = s => s && s[0].toUpperCase() + s.slice(1);
const sp = s => (s ? ` ${s}` : '');
// Restated payment dates: every one names 2026-10-05.
const PAY_DATE = ['on October 5, 2026', 'on October 5th, 2026', 'on 2026-10-05', 'on 10/05/2026', 'on 5 October 2026', 'on Oct 5, 2026'];
const PAY_AMOUNT = ['$400', '$400.00', '400 dollar', 'USD 400'];

// Every template keeps the same scope as its short form. Templates that put a
// date or account phrase directly after an inflow payer are generated too; the
// selector check below scopes PR-S1/PR-S2 hits out instead of avoiding them.
const Q1 = {
  totals: { short: 'How much money came in during September 2026?', templates: [
    c => `How much money came in ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, how much money came in${sp(c.acct)}`,
    c => `How much money came in${sp(c.acct)} ${c.date}`] },
  deposits: { short: 'What deposits came in during September 2026?', templates: [
    c => `What deposits came in ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, what deposits came in${sp(c.acct)}`,
    c => `Show me the deposits${sp(c.acct)} ${c.date}`] },
  largest: { short: 'What were the 3 largest expenses in September 2026?', templates: [
    c => `What were the 3 largest expenses ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, what were the three largest expenses${sp(c.acct)}`,
    c => `Show me the 3 largest expenses ${c.date}`] },
  spend: { short: 'How much did I spend at Vendor Alpha LLC in September 2026?', templates: [
    c => `How much did I spend at Vendor Alpha LLC ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, how much did I spend at Vendor Alpha LLC${sp(c.acct)}`,
    c => `What is my Vendor Alpha LLC spend ${c.date}`] },
  category: { short: 'How much did I spend on Office in September 2026?', templates: [
    c => `How much did I spend on Office ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, how much did I spend on Office${sp(c.acct)}`] },
  named_income: { short: 'How much income came from Payer Taylor in September 2026?', payer: true, templates: [
    c => `How much income came from Payer Taylor ${c.date}${sp(c.acct)}`, c => `${cap(c.date)}, how much income came from Payer Taylor${sp(c.acct)}`,
    c => `How much income came${sp(c.acct)} from Payer Taylor ${c.date}`] },
  payment: { short: 'Did the payment from Payer Taylor arrive in the last 30 days?', payer: true, templates: [
    c => `Did the payment from Payer Taylor arrive in the last 30 days${sp(c.acct)}`, c => `In the last 30 days, did the payment from Payer Taylor arrive${sp(c.acct)}`,
    c => `Did the payment from Payer Taylor arrive${sp(c.acct)} in the last 30 days`, c => `Has the payment from Payer Taylor arrived in the last 30 days`,
    c => `Did the Payer Taylor payment arrive in the last 30 days${sp(c.acct)}`, c => `Did Payer Taylor's payment arrive in the last 30 days`] },
  payment_amount: { short: 'Did the $400 payment from Payer Taylor arrive on 2026-10-05?', payer: true, templates: [
    c => `Did the ${c.amount} payment from Payer Taylor arrive ${c.payDate}${sp(c.acct)}`, c => `${cap(c.payDate.replace(/^on /, 'on '))}, did the ${c.amount} payment from Payer Taylor arrive`,
    c => `Did the payment of ${c.amount === '400 dollar' ? '400 dollars' : c.amount} from Payer Taylor arrive${sp(c.acct)} ${c.payDate}`] },
};

// Round-1 scoping. PR-S1: the payer slot keeps a trailing word after the name
// ("on" in round 1; trailing filler takes the same span rule). PR-S2: account
// and date words are swallowed into the payer and readings[0] widens scope.
const R1_FILLER = new Set('please thanks thank exactly again if you can for me right now so far'.split(' '));
const R1_SCOPE_WORDS = new Set(('on in into to during over of the my our account checking savings ending month this last ' +
  'january february march april may june july august september october november december sept').split(' '));
function round1Scope(kind, question) {
  if (!Q1[kind].payer) return null;
  const intent = classifyLedgerQuestion(question, { now });
  const selector = lower(intent.kind === 'payment' ? intent.counterparty : intent.match);
  if (!selector || selector === 'payer taylor' || !selector.includes('payer taylor')) return null;
  const extra = selector.replace('payer taylor', ' ').match(/[\p{L}\p{N}]+/gu) || [];
  if (extra.length && extra.every(w => R1_SCOPE_WORDS.has(w) || /^\d+$/.test(w))) return 'PR-S2';
  if (extra.length && extra.every(w => R1_FILLER.has(w) || R1_SCOPE_WORDS.has(w) || /^\d+$/.test(w))) return 'PR-S1';
  return null;
}

function q1Case(g) {
  const kind = g.pick(Object.keys(Q1));
  // Politeness and filler break the bounded grammar on purpose (documents
  // route), so half the cases leave each out to keep ledger comparisons dense.
  return { kind, template: g.int(0, Q1[kind].templates.length - 1), pre: g.chance(0.5) ? '' : g.pick(PRE), date: g.pick(DATE_SAME),
    acct: g.pick(ACCT_SAME), suf: g.chance(0.5) ? '' : g.pick(SUF), end: g.pick(END), payDate: g.pick(PAY_DATE), amount: g.pick(PAY_AMOUNT) };
}
const q1Text = c => c.pre + Q1[c.kind].templates[c.template](c) + c.suf + c.end;
const Q1_CANON = { template: 0, pre: '', date: 'in September 2026', acct: '', suf: '', end: '?', payDate: 'on 2026-10-05', amount: '$400' };

async function shrink(c, violates) {
  let best = c;
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const [key, value] of Object.entries(Q1_CANON)) {
      if (best[key] === value) continue;
      const candidate = { ...best, [key]: value };
      if (await violates(candidate)) { best = candidate; changed = true; }
    }
    if (!changed) break;
  }
  return best;
}

test('R2-Q1 short vs long wording: same answer class and total, never a refusal or none on the long form', async t => {
  const SEED = seedFor('Q1', 0x5eed01), CASES = 700;
  const f = ledgerWorld(t);
  const short = {};
  for (const [kind, spec] of Object.entries(Q1)) {
    short[kind] = outcome(await f.ask(spec.short));
    assert.equal(short[kind].cls, 'answer', `control: short form answers (${kind}): ${spec.short}`);
  }
  const g = gen(SEED);
  const stats = { same: 0, unsupported: 0, 'PR-S1': 0, 'PR-S2': 0, violation: 0 };
  const violations = [], scoped = {};
  const judge = async c => {
    const q = q1Text(c);
    const got = outcome(await f.ask(q));
    if (got.sig === short[c.kind].sig) return { verdict: 'same', q, got };
    if (got.cls === 'unsupported') return { verdict: 'unsupported', q, got };
    const scope = round1Scope(c.kind, q);
    return { verdict: scope || 'violation', q, got };
  };
  for (let i = 0; i < CASES; i++) {
    const c = q1Case(g);
    const result = await judge(c);
    stats[result.verdict]++;
    if (result.verdict === 'violation') violations.push({ i, c, ...result });
    else if (result.verdict.startsWith('PR-') && !scoped[result.verdict]) scoped[result.verdict] = result.q;
  }
  t.diagnostic(`R2-Q1 seed=${SEED} cases=${CASES} ${JSON.stringify(stats)} scoped-out examples ${JSON.stringify(scoped)}`);
  if (violations.length) {
    // Shrink the first violation of each distinct long-form outcome class.
    const seen = new Map();
    for (const v of violations) if (!seen.has(`${v.c.kind}:${v.got.cls}`)) seen.set(`${v.c.kind}:${v.got.cls}`, v);
    const minimal = [];
    for (const v of seen.values()) {
      const m = await shrink(v.c, async c => (await judge(c)).verdict === 'violation');
      const r = await judge(m);
      minimal.push(`case ${v.i} [${m.kind}] long=${JSON.stringify(r.q)} -> ${r.got.cls} ${r.got.sig}\n    short=${JSON.stringify(Q1[m.kind].short)} -> ${short[m.kind].sig}`);
    }
    assert.fail(`R2-Q1 seed=${SEED}: ${violations.length}/${CASES} long forms changed the answer.\n  ${minimal.join('\n  ')}`);
  }
});

// ---------------------------------------------------------- R2-Q1 repros ---
// R2-QF1: a trailing filler word after the period stays in the outflow
// merchant/category selector (ledger-question.js:121-131) and the ledger then
// certifies $0.00 with a complete evidence gate.
test('R2-QF1-repro spend-at merchant with a trailing "please" certifies $0.00 instead of $300.00', async t => {
  const f = ledgerWorld(t);
  const body = await f.ask('How much did I spend at Vendor Alpha LLC in September 2026 please?');
  assert.equal(body.ledger?.kind, 'merchant', 'ledger routing reached');
  assert.ok(!(body.ledger.total_minor === 0 && body.evidence_gate.complete === true),
    `certified zero for a merchant with a $300.00 charge: ${body.answer}`);
});
test('R2-QF1-repro spend-on category with a trailing "please" certifies $0.00 instead of $300.00', async t => {
  const f = ledgerWorld(t);
  const body = await f.ask('How much did I spend on Office in September 2026 please?');
  assert.equal(body.ledger?.kind, 'category', 'ledger routing reached');
  assert.ok(!(body.ledger.total_minor === 0 && body.evidence_gate.complete === true),
    `certified zero for a category with a $300.00 charge: ${body.answer}`);
});
test('R2-QF1-control the same merchant and category questions without the filler total $300.00', async t => {
  const f = ledgerWorld(t);
  for (const q of ['How much did I spend at Vendor Alpha LLC in September 2026?', 'How much did I spend on Office in September 2026?']) {
    const body = await f.ask(q);
    assert.equal(body.ledger.total_minor, 30000, q);
    assert.equal(body.evidence_gate.complete, true);
  }
});

// R2-QF2: an amount written in words before "payment" ("the 400 dollar
// payment", "the USD 400 payment") is captured by the noun-payment selector
// (ledger-question.js:141-144) as a second payer, so coverage fails and a
// registered, exactly matching payer is refused.
test('R2-QF2-repro "the 400 dollar payment from Payer Taylor" refuses a registered payer', async t => {
  const f = ledgerWorld(t);
  for (const q of ['Did the 400 dollar payment from Payer Taylor arrive on 2026-10-05?',
    'Did the USD 400 payment from Payer Taylor arrive on 2026-10-05?']) {
    const body = await f.ask(q);
    assert.equal(body.ledger?.kind, 'payment', 'ledger routing reached');
    assert.equal(body.ledger.payer_selector_ambiguous, undefined, `${q}\n${body.answer}`);
    assert.equal(body.ledger.found, true);
  }
});
test('R2-QF2-control "$400 payment" and "payment of 400 dollars" find the deposit', async t => {
  const f = ledgerWorld(t);
  for (const q of ['Did the $400 payment from Payer Taylor arrive on 2026-10-05?',
    'Did the payment of 400 dollars from Payer Taylor arrive on 2026-10-05?']) {
    const body = await f.ask(q);
    assert.equal(body.ledger.found, true, q);
    assert.equal(body.evidence_gate.complete, true);
  }
});

// R2-QF3: the possessive form keeps "'s" in the selector reading
// (ledger-question.js:333-347 labelPattern admits the apostrophe), so the
// registered mention "payer taylor" never covers "payer taylor's".
test('R2-QF3-repro "Did Payer Taylor\'s payment arrive" refuses a registered payer', async t => {
  const f = ledgerWorld(t);
  const body = await f.ask("Did Payer Taylor's payment arrive in the last 30 days?");
  assert.equal(body.ledger?.kind, 'payment', 'ledger routing reached');
  assert.equal(body.ledger.found, true, body.answer);
  assert.equal(body.evidence_gate.complete, true);
});
test('R2-QF3-control "Did the Payer Taylor payment arrive" finds both deposits', async t => {
  const f = ledgerWorld(t);
  const body = await f.ask('Did the Payer Taylor payment arrive in the last 30 days?');
  assert.equal(body.ledger.found, true);
  assert.deepEqual(body.citations.map(c => c.amount_minor), [125000, 40000]);
});

// ------------------------------------------------------------------ R2-Q2 --
// One search arm fails or returns nothing. Document answers are drafted by a
// mocked model that always claims an absence or a complete figure, and a
// mocked verifier that approves it; only the route's own markers can stop that
// claim from looking complete.
const Q2_NOW = Date.parse('2034-07-15T12:00:00Z');
const approveDraft = input => {
  const proposed = /PROPOSED ANSWER:\n([\s\S]*?)\n\nCITED DOCUMENTS:/.exec(input.messages.at(-1).content)?.[1] || '';
  return { supported: true, complete: true, conflicts: [],
    evidence: [...proposed.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1])), reason: 'Synthetic approval.' };
};
const ABSENCE = ['No deposits from Payer Taylor are recorded [1].', 'The records show none [1].',
  'Total received from Payer Taylor: $0.00 [1].', 'All deposits are listed; there are no others [1].'];
const doc = (id, title, text, day, extra = {}) => ({ source_type: 'gmail', source_id: id, title, content: text,
  occurred_at: day, date_reliable: true, date_source: 'email_header', text_source: 'native', text_reliable: true,
  metadata: { evidence_lineage: { version: 1, kind: 'source_record' } }, ...extra });
const CORPUS = [
  doc('m1', 'Meeting notes', 'Payer Taylor meeting: discussed the retainer deposit schedule.', '2034-06-15'),
  doc('m2', 'Meeting notes', 'Vendor Alpha LLC meeting: supply invoice reviewed.', '2034-06-11'),
  doc('c1', 'Calendar', 'Calendar: call with Payer Taylor about the deposit.', '2034-06-20'),
  doc('e1', 'Payment record', 'Payer Taylor wired USD 400.00 on 2034-06-14.', '2034-06-14'),
  doc('e2', 'Supplier note', 'Vendor Alpha LLC confirmed the order.', '2034-06-09'),
];
const Q2_QUESTIONS = [
  { q: 'What did the meeting notes say about deposits from Payer Taylor?', hint: true },
  { q: 'Which calendar entries mention Payer Taylor?', hint: true },
  { q: 'Did Payer Taylor text messages mention the deposit?', hint: true },
  { q: 'What did Payer Taylor pay in June 2034?', hint: false },
  { q: 'Did Vendor Alpha LLC confirm the order?', hint: false },
  { q: 'What deposits from Payer Taylor are recorded?', hint: false },
];
const FAULTS = {
  'base-keyword': { db: /chunks_fts MATCH(?![\s\S]*c\.category\s*=)(?![\s\S]*c\.platform\s*=)/ },
  'base-vector': { vectorFails: true },
  'hint-keyword': { db: /chunks_fts MATCH[\s\S]*c\.(?:category|platform)\s*=/, hintOnly: true },
  'hint-vector': { db: /c\.chunk_uid IN \([\s\S]*c\.(?:category|platform)\s*=/, hintOnly: true },
  'vector-empty': { vectorEmpty: true, benign: true },
  none: { benign: true },
};

async function q2World(t, draft) {
  const f = await acceptanceFixture(t, { now: Q2_NOW, verdict: approveDraft, draft });
  await f.ingest(CORPUS); await f.drain();
  const query = f.env.VECTORIZE.query.bind(f.env.VECTORIZE);
  const state = { hits: 0, vectorEmpty: false };
  f.env.VECTORIZE.query = async (...args) => state.vectorEmpty ? { matches: [] } : query(...args);
  // arm(fault) resets the hit counter; arm() with no fault disarms and keeps it.
  const arm = (fault) => {
    if (fault) state.hits = 0;
    fault ||= {};
    state.vectorEmpty = Boolean(fault.vectorEmpty);
    f.control.vectorFails = Boolean(fault.vectorFails);
    f.dbControl.failOn = fault.db ? { lastIndex: 0, test: sql => { const hit = fault.db.test(sql); if (hit) state.hits++; return hit; } } : null;
  };
  return { f, state, arm };
}

test('R2-Q2 a failed keyword or vector arm never yields an unmarked complete or absence answer', async t => {
  const SEED = seedFor('Q2', 0x5eed02), CASES = 36;
  let claim = ABSENCE[0];
  const { f, state, arm } = await q2World(t, () => claim);
  const g = gen(SEED);
  const stats = {}, violations = [];
  for (let i = 0; i < CASES; i++) {
    const question = g.pick(Q2_QUESTIONS);
    const name = g.pick(Object.keys(FAULTS).filter(k => !FAULTS[k].hintOnly || question.hint));
    const fault = FAULTS[name];
    claim = g.pick(ABSENCE);
    arm(fault);
    const result = await f.request('think', question.q);
    arm();
    const failed = !fault.benign && (fault.vectorFails ? result.counts.vector > 0 : state.hits > 0);
    const body = result.body;
    const marked = Boolean(body.degraded) &&
      (body.answer === null || (body.gaps || []).some(gap => /keyword_unavailable|vector_unavailable|retrieval/.test(gap.type)));
    const key = `${name}:${failed ? (marked ? 'marked' : 'UNMARKED') : 'no-failure'}`;
    stats[key] = (stats[key] || 0) + 1;
    if (failed && !marked) violations.push({ i, fault: name, q: question.q, claim, answer: body.answer,
      degraded: body.degraded ?? null, gaps: (body.gaps || []).map(gap => gap.type), complete: body.evidence_gate?.complete });
  }
  t.diagnostic(`R2-Q2 seed=${SEED} cases=${CASES} ${JSON.stringify(stats)}`);
  if (violations.length) {
    const minimal = violations.sort((a, b) => a.q.length - b.q.length)[0];
    assert.fail(`R2-Q2 seed=${SEED}: ${violations.length}/${CASES} failed arms left no degraded marker. Minimal: ${JSON.stringify(minimal)}`);
  }
});

// Ledger-sourced answers are a separate authority. Their completeness must not
// depend on either search arm, so a failed arm cannot have shaped them.
test('R2-Q2 ledger-answered money questions never consult either search arm', async t => {
  const SEED = seedFor('Q2L', 0x5eed12), CASES = 12;
  const { f, arm } = await q2World(t, () => ABSENCE[0]);
  const at = new Date(Q2_NOW).toISOString();
  f.raw(`INSERT INTO fin_entities (entity_slug,legal_name,display_label,kind,status,relationship,provenance,basis_state,recorded_at)
    VALUES ('owner','Synthetic owner','Synthetic owner','business','active','owned','owner_stated','confirmed',?)`, at);
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('payer-taylor','Payer Taylor','business','counterparty','owner_stated','confirmed',?)`, at);
  // Same live-feed shape as ledger-review-fixture.mjs, moved to 2034.
  f.raw(`INSERT INTO bank_feed_items (item_ref,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed','AAAAAAAAAAAAAAAAAAAAAAAA','AAAAAAAAAAAAAAAA','sandbox','2034-01-01T00:00:00.000Z',?)`, at);
  f.raw(`INSERT INTO bank_feed_backfill (item_ref,requested_days,state,queued_at,finished_at,provider_history_state)
    VALUES ('fixture-feed',730,'complete','2034-01-01T00:00:00.000Z',?,'HISTORICAL_UPDATE_COMPLETE')`, at);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('chk','owner','checking','asset','1234','live','feed','bank-feed:fixture-feed','confirmed',?)`, at);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('chk','complete','2033-01-01','2034-07-15',?,'feed','bank-feed:fixture-feed','confirmed',?)`, at, at);
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    VALUES ('t1','chk','2034-07-01',40000,'inflow','ACH CREDIT','Payer Taylor','feed','bank-feed:fixture-feed','confirmed',?)`, at);
  const g = gen(SEED);
  const questions = ['Did the payment from Payer Taylor arrive in the last 30 days?', 'How much money came in during June 2034?',
    'What deposits came in during July 2034?', 'Did the payment from Payer Quinn arrive in the last 30 days?'];
  let ledgerAnswers = 0;
  for (let i = 0; i < CASES; i++) {
    const q = g.pick(questions);
    arm(FAULTS[g.pick(['base-keyword', 'base-vector', 'none'])]);
    const result = await f.request('think', q);
    arm();
    if (!result.body.ledger) continue;
    ledgerAnswers++;
    assert.equal(result.counts.keyword + result.counts.vector, 0, `seed=${SEED} case ${i}: ledger answer consulted search: ${q}`);
  }
  t.diagnostic(`R2-Q2L seed=${SEED} cases=${CASES} ledger-answered=${ledgerAnswers}`);
  assert.ok(ledgerAnswers >= CASES / 2, 'ledger path reached');
});

// R2-QF4: supplemental source-hint lanes (meeting/calendar/iMessage) run their
// own keyword and vector queries. store-d1.js:938-1029 checks their errors
// only for integrity failures; an ordinary error leaves degraded null, so the
// answer keeps a complete gate and full confidence with no gap.
test('R2-QF4-repro a failed meeting-hint keyword query leaves no degraded marker or gap', async t => {
  const { f, state, arm } = await q2World(t, () => 'No deposits from Payer Taylor are recorded [1].');
  arm(FAULTS['hint-keyword']);
  const result = await f.request('think', 'What did the meeting notes say about deposits from Payer Taylor?');
  arm();
  assert.equal(state.hits, 1, 'the hint keyword query failed');
  assert.ok(result.body.degraded, `no degraded marker; gaps=${JSON.stringify(result.body.gaps.map(g => g.type))} ` +
    `gate=${JSON.stringify(result.body.evidence_gate)} answer=${result.body.answer}`);
});
test('R2-QF4-repro a failed meeting-hint vector hydration leaves no degraded marker or gap', async t => {
  const { f, state, arm } = await q2World(t, () => 'No deposits from Payer Taylor are recorded [1].');
  arm(FAULTS['hint-vector']);
  const result = await f.request('think', 'What did the meeting notes say about deposits from Payer Taylor?');
  arm();
  assert.equal(state.hits, 1, 'the hint vector hydration failed');
  assert.ok(result.body.degraded, `no degraded marker; gaps=${JSON.stringify(result.body.gaps.map(g => g.type))}`);
});
test('R2-QF4-control a failed base keyword query is marked degraded fts with a keyword_unavailable gap', async t => {
  const { f, state, arm } = await q2World(t, () => 'No deposits from Payer Taylor are recorded [1].');
  arm(FAULTS['base-keyword']);
  const result = await f.request('think', 'What did the meeting notes say about deposits from Payer Taylor?');
  arm();
  assert.equal(state.hits, 1);
  assert.equal(result.body.degraded, 'fts');
  assert.ok(result.body.gaps.some(gap => gap.type === 'keyword_unavailable'));
});

// ------------------------------------------------------------------ R2-Q3 --
// Budget exhaustion never becomes a definitive no. Row side: inflow
// descriptions that exhaust the statement parser (operation, length, field or
// parse limit). Question side: the 1024/512/12-start question caps.
const BUDGET = new Set(['operation-limit', 'length-limit', 'field-limit', 'parse-limit']);
const ACH_FIELDS = ['ORIG ID: 7788990011', 'DESC DATE: 261005', 'CO ENTRY DESCR: PAYMENT', 'SEC: CCD', 'TRACE NUMBER: 021000021234567',
  'EFFECTIVE DATE: 2026-10-05', 'REFERENCE: INV-2026-10-05-0001', 'MEMO: october-services', 'INDIVIDUAL ID: ABC123',
  'BENEFICIARY: Sample Holdings Group of Phoenix Arizona Family Trust Account', 'SETTLEMENT DATE: 10/05/2026', 'INVOICE: 2026-77'];
function budgetDescription(g, sender) {
  const shuffled = [...ACH_FIELDS].sort(() => g.r() - 0.5);
  const shape = g.pick(['comma', 'space', 'long', 'fields']);
  const head = `ORIG CO NAME: ${sender}`;
  if (shape === 'comma') return [head, ...shuffled.slice(0, g.int(9, 11))].join(', ');
  if (shape === 'space') return [head, ...shuffled.slice(0, g.int(9, 11))].join(' ');
  if (shape === 'long') return `${head}; BENEFICIARY: ${'Sample Holdings Group '.repeat(g.int(24, 30)).trim()}`;
  return [head, ...shuffled, 'ORIG ID: 55', 'SEC: PPD'].join('; ');
}
const parserRefusal = description => createInflowAttributor(payerRegistry([{ entity_slug: 'payer-taylor', legal_name: 'Payer Taylor' }]))(
  { id: 1, direction: 'inflow', description }).evidence.parser?.refusal ?? null;

function definitiveNo(body) {
  if (!body.ledger) return null;
  const l = body.ledger;
  if (l.found === false) return 'found:false';
  if (/No matching deposit/.test(body.answer || '')) return 'no-matching text';
  if (l.total_minor === 0 || l.lead_total_minor === 0) return 'certified zero';
  if (body.evidence_gate?.complete === true && l.found !== true) return 'complete gate without a match';
  return null;
}

test('R2-Q3 budget exhaustion never becomes a definitive no', async t => {
  const SEED = seedFor('Q3', 0x5eed03), WORLDS = 24;
  const g = gen(SEED);
  const stats = { refusals: {}, asks: 0, documents: 0, uncertain: 0, found: 0 };
  const violations = [];
  for (let w = 0; w < WORLDS; w++) {
    let description, refusal;
    for (let tries = 0; tries < 40 && !BUDGET.has(refusal); tries++) {
      description = budgetDescription(g, g.pick(['Payer Taylor', 'Payer Quinn', 'Vendor Alpha LLC']));
      refusal = parserRefusal(description);
    }
    if (!BUDGET.has(refusal)) continue;
    stats.refusals[refusal] = (stats.refusals[refusal] || 0) + 1;
    const f = ledgerFixture(t);
    f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,kind,relationship,provenance,basis_state,recorded_at)
      VALUES ('payer-taylor','Payer Taylor','business','counterparty','owner_stated','confirmed',?)`, LEDGER_NOW);
    const cents = g.pick([25000, 31500, 42000]);
    f.add('budget', description, null, { date: '2026-10-05', cents });
    if (g.chance(0.5)) f.add('other', 'ACH CREDIT', 'Fixture Payer', { date: '2026-10-03', cents: 10000 });
    const confirmedSame = g.chance(0.3);
    if (confirmedSame) f.add('same', 'ACH CREDIT', 'Payer Taylor', { date: '2026-10-02', cents: 5000 });
    const dollars = `$${cents / 100}`;
    const questions = ['Did the payment from Payer Taylor arrive in the last 30 days?', `Did the ${dollars} payment from Payer Taylor arrive on 2026-10-05?`,
      'How much income came from Payer Taylor in October 2026?', 'Did the payment from Payer Quinn arrive in the last 30 days?',
      'How much income came from Fixture Payer in October 2026?',
      // Question-side caps: many FROM clauses and padding past 512 / 1024.
      `Did the payment from Payer Taylor${' from Payer Taylor'.repeat(g.int(11, 14))} arrive in the last 30 days?`,
      `Did the payment from Payer Taylor arrive in the last 30 days${' please'.repeat(g.int(70, 140))}?`];
    for (const q of questions) {
      const body = await f.ask(q);
      stats.asks++;
      if (!body.ledger) { stats.documents++; continue; }
      if (body.ledger.found === true) stats.found++; else stats.uncertain++;
      const no = definitiveNo(body);
      if (no) violations.push({ w, refusal, description, q, no, answer: body.answer?.slice(0, 200) });
    }
  }
  t.diagnostic(`R2-Q3 seed=${SEED} worlds=${WORLDS} ${JSON.stringify(stats)}`);
  assert.ok(Object.keys(stats.refusals).length >= 2, `generator reached several budget refusals: ${JSON.stringify(stats.refusals)}`);
  if (violations.length) {
    const minimal = violations.sort((a, b) => a.description.length + a.q.length - b.description.length - b.q.length)[0];
    assert.fail(`R2-Q3 seed=${SEED}: ${violations.length} definitive no answers under budget exhaustion. Minimal: ${JSON.stringify(minimal)}`);
  }
});

// ============================================================== AREA 2 =====
// Identifiers use digits 6-9 only. Every money amount, date, mask and
// citation number in these fixtures has a 0-5 digit in every 5-digit window,
// so a 5-digit identifier window in the output can only be a leak.
const ARABIC = 0x0660, EXT_ARABIC = 0x06F0, FULL = 0xFF10;
const ID_FORMS = ['plain', 'spaced', 'dashed', 'fullwidth', 'arabic', 'ext-arabic', 'zero-width', 'iban', 'routing'];
function identifier(g, form = g.pick(ID_FORMS)) {
  const digits = n => Array.from({ length: n }, () => String(g.int(6, 9))).join('');
  const run = form === 'routing' ? digits(9) : digits(g.int(8, 19));
  const groups = (s, size) => s.match(new RegExp(`.{1,${size}}`, 'g'));
  const text = {
    plain: run, spaced: groups(run, g.pick([3, 4])).join(' '), dashed: groups(run, 4).join('-'),
    fullwidth: [...run].map(d => String.fromCodePoint(FULL + +d)).join(''),
    arabic: [...run].map(d => String.fromCodePoint(ARABIC + +d)).join(''),
    'ext-arabic': [...run].map(d => String.fromCodePoint(EXT_ARABIC + +d)).join(''),
    'zero-width': [...run].join(g.pick(['​', '‌', '⁠'])),
    iban: `GB${digits(2)} WEST ${groups(run, 4).join(' ')}`, routing: run,
  }[form];
  return { form, text, digits: normalizeDigits(text).replace(/\D/g, '') };
}
function normalizeDigits(text) {
  return String(text).normalize('NFKC')
    .replace(/[٠-٩]/g, c => String(c.codePointAt(0) - ARABIC))
    .replace(/[۰-۹]/g, c => String(c.codePointAt(0) - EXT_ARABIC))
    .replace(/[०-९]/g, c => String(c.codePointAt(0) - 0x0966));
}
// Collapse spaces, dashes and invisible separators so a regrouped echo counts.
const collapse = text => normalizeDigits(text).replace(/[\s\-‐-― ​-‍⁠﻿]+/g, '');
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(v => strings(v, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); strings(v, out); }
  return out;
}
function leaks(output, ids) {
  const texts = strings(output).map(collapse);
  for (const id of ids) for (let i = 0; i + 5 <= id.digits.length; i++) {
    const window = id.digits.slice(i, i + 5);
    const hit = texts.find(text => text.includes(window));
    if (hit) return { id: id.text, form: id.form, window, excerpt: hit.slice(Math.max(0, hit.indexOf(window) - 60), hit.indexOf(window) + 40) };
  }
  return null;
}

// ------------------------------------------------------------------ R2-K1 --
const K1_FIELDS = ['payee', 'description', 'memo', 'merchant', 'category', 'institution', 'account-label', 'payer-registry', 'question'];
const K1_QUESTIONS = ['How much money came in during September 2026?', 'What deposits came in during September 2026?',
  'What were the 3 largest expenses in September 2026?', 'What were the 3 largest deposits in September 2026?',
  'How much did I spend by merchant in September 2026?', 'What was my spending by category in September 2026?',
  'How much income came in by merchant in September 2026?', 'How much income came from Payer Taylor in September 2026?',
  'Did the payment from Payer Taylor arrive in the last 30 days?', 'Did the $1,250.00 payment arrive on 2026-09-15?',
  'What recurring charges am I paying for?', 'Show my transfers between my own accounts in September 2026',
  'What is my checking balance?', 'How much did I spend at Vendor Alpha LLC in September 2026?',
  'How much income came from Payer Quinn in September 2026?', 'How much did I spend on Office in September 2026?',
  'Did the payment from Payer Quinn arrive in the last 30 days?'];

function k1World(t, g) {
  // The institution field adds a same-mask manual record, which turns every
  // question into the account-link refusal; keep it to a minority of worlds.
  const fields = K1_FIELDS.filter(field => g.chance(field === 'institution' ? 0.2 : 0.6));
  if (!fields.length) fields.push(g.pick(K1_FIELDS));
  const ids = [], put = field => { if (!fields.includes(field)) return ''; const id = identifier(g); ids.push(id); return id.text; };
  const f = ledgerFixture(t);
  const registry = put('payer-registry');
  f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
    VALUES ('payer-taylor','Payer Taylor',?,'business','counterparty','owner_stated','confirmed',?)`, registry ? `Payer Taylor ${registry}` : null, LEDGER_NOW);
  const payee = put('payee'), memo = put('memo'), merchant = put('merchant'), description = put('description');
  f.add('d1', `ACH CREDIT${description ? ` ${description}` : ''}${memo ? ` MEMO: ${memo}` : ''}`, 'Payer Taylor', { date: '2026-09-15', cents: 125000 });
  f.add('d2', `DEPOSIT REF ${description || 'BRANCH'}`, null, { date: '2026-09-16', cents: 23000 });
  f.add('d3', 'ACH CREDIT', payee ? `Payer ${payee}` : 'Payer Quinn', { date: '2026-09-17', cents: 4500 });
  f.add('d4', registry ? `ORIG CO NAME: Payer Taylor ${registry}` : 'ORIG CO NAME: Payer Taylor', null, { date: '2026-09-18', cents: 3200 });
  f.add('o1', `POS PURCHASE Vendor Alpha LLC${merchant ? ` ${merchant}` : ''}`, null, { date: '2026-09-20', cents: 30000, direction: 'outflow' });
  for (const m of ['08', '09', '10']) f.add(`r${m}`, `STREAMING ${merchant || 'SERVICE'}`, null, { date: `2026-${m}-03`, cents: 1500, direction: 'outflow' });
  const category = put('category');
  f.raw(`UPDATE fin_transactions SET category=?, category_basis_state='proposed' WHERE txn_uid='o1'`, `Office${category ? ` ${category}` : ''}`);
  // A transfer pair names the other account by mask, so pair reasons print.
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,institution,label,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-savings','owner',?,?,'savings','asset','5678','live','feed','bank-feed:fixture-feed','confirmed',?)`,
    null, put('account-label') || 'Savings', LEDGER_NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    VALUES ('fixture-savings','complete','2024-01-01','2026-10-12',?,'feed','bank-feed:fixture-feed','confirmed',?)`, LEDGER_NOW, LEDGER_NOW);
  f.add('x1', 'TRANSFER TO SAVINGS ****5678', null, { date: '2026-09-25', cents: 50000, direction: 'outflow' });
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,source_feed,basis_state,recorded_at)
    VALUES ('x2','fixture-savings','2026-09-25',50000,'inflow','TRANSFER FROM CHECKING ****1234',NULL,'feed','bank-feed:fixture-feed','confirmed',?)`, LEDGER_NOW);
  const institution = put('institution');
  if (institution) {
    // A same-mask manual record: the account-link refusal prints institutions.
    f.raw(`UPDATE fin_accounts SET institution=? WHERE account_slug='fixture-account'`, `Example Bank ${institution}`);
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,institution,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
      VALUES ('fixture-manual','owner',?,'checking','asset','1234','manual','owner_stated','confirmed',?)`, `Example Bank ${institution}`, LEDGER_NOW);
  }
  const echo = put('question');
  return { f, ids, fields, questions: echo ? [...K1_QUESTIONS, `How much did I spend at Vendor ${echo} in September 2026?`,
    `How much income came from Payer ${echo} in September 2026?`] : K1_QUESTIONS };
}

test('R2-K1 no ledger output string carries more than 4 digits of an injected identifier', async t => {
  const SEED = seedFor('K1', 0x5eed04), WORLDS = 40;
  const g = gen(SEED);
  const stats = { asks: 0, ledger: 0, refusals: 0, forms: {}, fields: {} };
  const violations = [];
  for (let w = 0; w < WORLDS; w++) {
    const world = k1World(t, g);
    world.ids.forEach(id => { stats.forms[id.form] = (stats.forms[id.form] || 0) + 1; });
    world.fields.forEach(field => { stats.fields[field] = (stats.fields[field] || 0) + 1; });
    for (const q of world.questions) {
      const body = await world.f.ask(q);
      stats.asks++;
      if (body.ledger) stats.ledger++; else if (body.code || (body.gaps || []).some(Boolean)) stats.refusals++;
      const leak = leaks(body, world.ids);
      if (leak) violations.push({ w, fields: world.fields, q, ...leak });
    }
  }
  t.diagnostic(`R2-K1 seed=${SEED} worlds=${WORLDS} ${JSON.stringify(stats)}`);
  assert.ok(stats.ledger > stats.asks / 3, 'most questions reached a ledger answer');
  assert.ok(stats.refusals > 0, 'refusal paths reached');
  if (violations.length) {
    const minimal = violations.sort((a, b) => a.fields.length - b.fields.length || a.id.length - b.id.length)[0];
    assert.fail(`R2-K1 seed=${SEED}: ${violations.length} leaks. Minimal: ${JSON.stringify(minimal)}`);
  }
});

// ------------------------------------------------------------------ R2-K2 --
// Entity-fact answers. Phone, mobile and email values are themselves digit or
// identifier facts, so they are not injection targets. The owner-address email
// path echoing an identifier INSIDE the stated address is PR-K1 (round 1); here
// identifiers go only into the owner email's other lines, so it is still tested.
const K2_NOW = Date.parse('2026-10-12T12:00:00Z');
const K2_SUBJECTS = ['Vendor Alpha LLC', 'Payer Taylor', 'Supplier Beta Co'];
function contactCard(subject, fields) {
  const snippet = `Name: ${subject}\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
  const day = K2_NOW - 86400000;
  return { results: [{ title: 'Contact record', client: subject, snippet }],
    docs: [{ n: 1, ref: 'curated:contact', source: 'curated', source_kind: 'curated', title: 'Contact record', client: subject, snippet,
      date_reliable: true, document_date: day, ts: new Date(day).toISOString(), date_source: 'record:updated',
      text_source: 'native', text_reliable: true, lineage: { status: 'known', kind: 'source_record' }, authority: {} }] };
}
const CLEAN = { address: '12 Synthetic Road, Fixture City, AZ 85001', company: 'Example Organization', role: 'Operations Manager' };
function withIdentifier(g, field, id) {
  const label = g.pick(['', 'Account ', 'Acct ', 'Ref ']);
  const value = CLEAN[field];
  return g.pick([`${value} ${label}${id}`, `${label}${id} ${value}`]).replace(/\s+/g, ' ').trim();
}
const factQuestion = (g, subject, field) => g.pick([`What is ${subject}'s ${field}?`, `What is the ${field} of ${subject}?`,
  `What is ${subject}'s current ${field}?`, `What's the ${field} for ${subject}?`]);
// The owner path binds the Subject line to the title and the body to one
// trailing statement, so identifiers go into the Subject/title or the To
// address. Extra body lines would only make the bounded path decline.
function ownerMail({ subject = 'Address change', to = 'service@example.invalid' }, value) {
  const day = '2026-10-10';
  const snippet = `[${subject}] From: Record Owner <owner@example.invalid>\nTo: ${to}\nDate: ${day}\n` +
    `Subject: ${subject}\n\nMy mailing address is ${value}.`;
  return { results: [{ title: subject, snippet }],
    docs: [{ n: 1, ref: 'gmail:move', source_kind: 'gmail', date_source: 'email_header', date_reliable: true, ts: day,
      document_date: Date.parse(day), text_source: 'native', text_reliable: true, lineage: { status: 'known', kind: 'source_record' }, authority: {} }] };
}

test('R2-K2 entity-fact answers never echo more than 4 digits of an injected identifier', async t => {
  const SEED = seedFor('K2', 0x5eed05), CASES = 400;
  const g = gen(SEED);
  const stats = { answered: 0, declined: 0, owner: 0, ownerAnswered: 0 };
  const violations = [];
  for (let i = 0; i < CASES; i++) {
    let result, id, where;
    if (g.chance(0.25)) {
      // Owner email path: identifier outside the address value (PR-K1 scoped out).
      // An email local part must stay ASCII, so the To arm uses plain digits.
      const inTo = g.chance(0.5);
      id = identifier(g, inTo ? g.pick(['plain', 'routing']) : undefined);
      where = inTo ? 'owner-email-to' : 'owner-email-subject';
      const mail = inTo ? { to: `billing${id.text}@example.invalid` } : { subject: `Address change ref ${id.text}` };
      result = entityFactAnswer({ question: 'What is my mailing address?', owner: 'Record Owner', now: K2_NOW, ...ownerMail(mail, CLEAN.address) });
      stats.owner++;
      if (result) stats.ownerAnswered++;
    } else {
      const subject = g.pick(K2_SUBJECTS), field = g.pick(['address', 'company', 'role']);
      id = identifier(g);
      where = `card:${field}`;
      const fields = { ...CLEAN, [field]: withIdentifier(g, field, id.text) };
      result = entityFactAnswer({ question: factQuestion(g, subject, field), owner: 'Record Owner', now: K2_NOW, ...contactCard(subject, fields) });
    }
    if (result) stats.answered++; else { stats.declined++; continue; }
    const leak = leaks(result, [id]);
    if (leak) violations.push({ i, where, ...leak, answer: result.answer });
  }
  t.diagnostic(`R2-K2 seed=${SEED} cases=${CASES} ${JSON.stringify(stats)}`);
  assert.ok(stats.answered > CASES / 4, 'bounded fact path reached');
  assert.ok(stats.ownerAnswered > 0, 'owner-email path reached');
  if (violations.length) {
    const byWhere = {};
    for (const v of violations) byWhere[v.where] = (byWhere[v.where] || 0) + 1;
    const minimal = violations.sort((a, b) => a.id.length - b.id.length)[0];
    assert.fail(`R2-K2 seed=${SEED}: ${violations.length} leaks ${JSON.stringify(byWhere)}. Minimal: ${JSON.stringify(minimal)}`);
  }
});

// R2-KF1: the contact-card path (factFromCard -> safeValue) admits long digit
// runs in company, role and address values (entity-fact-answer.js:43-53) and
// renders them verbatim (entity-fact-answer.js:262). Distinct from PR-K1,
// which is the owner-email address path (ownerAddressStatement).
const FAKE_ACCOUNT = '778899667788';
test('R2-KF1-repro contact-card company, role and address echo a full account number', () => {
  for (const [field, value] of [['company', `Example Organization Account ${FAKE_ACCOUNT}`],
    ['role', `Operations Manager Ref ${FAKE_ACCOUNT}`], ['address', `12 Synthetic Road, Fixture City, AZ 85001 Acct ${FAKE_ACCOUNT}`]]) {
    const result = entityFactAnswer({ question: `What is Vendor Alpha LLC's ${field}?`, owner: 'Record Owner', now: K2_NOW,
      ...contactCard('Vendor Alpha LLC', { ...CLEAN, [field]: value }) });
    // Either decline the bounded fact (ordinary path) or mask it.
    if (result) assert.ok(!collapse(result.answer).includes('78899'), `${field} answer leaked: ${result.answer}`);
  }
});
test('R2-KF1-control the same contact card without the identifier answers each field exactly', () => {
  for (const field of ['company', 'role', 'address']) {
    const result = entityFactAnswer({ question: `What is Vendor Alpha LLC's ${field}?`, owner: 'Record Owner', now: K2_NOW,
      ...contactCard('Vendor Alpha LLC', CLEAN) });
    assert.ok(result, field);
    assert.ok(result.answer.includes(CLEAN[field]));
  }
});
