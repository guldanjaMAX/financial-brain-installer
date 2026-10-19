// Partner review round 2: seeded, deterministic property generators for payer
// attribution. Every name, amount and description is made up and uses role
// words only. No Math.random, no network, no external dependencies.
//
// Promises under test (worker/src/lib/ledger-attribution.js):
// - attributeInflow(row, registry) decides deposit attribution for every path.
// - A payer is present only on an exact bank payee or a labelled sender field;
//   anything else is unknown, never absent.
// - No "no deposit", $0 or complete total without proof.
// - Shorthand readings answer with a starred assumption, never absence.
//
// Each property prints its seed, case counts and the minimal (shrunk)
// counter-example per violation class on failure. Round-1 root causes are
// filtered out of the generators; each filter names its round-1 id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeInflow, payerRegistry, payerQuestionRegistry, normalizeMerchantText }
  from '../src/lib/ledger-attribution.js';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';

const now = Date.parse(NOW);
const norm = normalizeMerchantText;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) and helpers.
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
function makeRng(seed) {
  const next = mulberry32(seed);
  const rng = {
    next,
    int: n => Math.floor(next() * n),
    pick: list => list[Math.floor(next() * list.length)],
    chance: p => next() < p,
    shuffle: list => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
      return out;
    },
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Role-word vocabulary. Never first+last person names.
const ROLES = ['Payer', 'Vendor', 'Client', 'Tenant', 'Buyer', 'Seller', 'Partner', 'Supplier', 'Contractor', 'Customer', 'Lender', 'Broker'];
const TAGS = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Taylor', 'North', 'Harbor', 'Summit', 'River', 'Cedar'];
const MIDS = ['Holdings', 'Group', 'Services', 'Trading', 'Works'];
const LEGAL = ['LLC', 'Inc', 'Co', 'Corp', 'LP', 'Ltd'];
const OWNER_ENTITIES = [
  { slug: 'owner-holdings', legal: 'Owner Holdings LLC', display: 'Owner Holdings' },
  { slug: 'owner-ventures', legal: 'Owner Ventures Inc', display: null },
];

function companyName(rng, { mid = rng.chance(0.3), legal = rng.chance(0.5), roles = ROLES } = {}) {
  const words = [rng.pick(roles), rng.pick(TAGS)];
  if (mid) words.push(rng.pick(MIDS));
  if (legal) words.push(rng.pick(LEGAL));
  return words.join(' ');
}
function nearMiss(rng, name) {
  const w = name.split(' ');
  const options = [
    () => (w.length > 2 ? w.slice(0, -1).join(' ') : null),
    () => `${name} ${rng.pick(LEGAL)}`,
    () => `${rng.pick(TAGS)} ${name}`,
    () => [rng.pick(ROLES.filter(r => r !== w[0])), ...w.slice(1)].join(' '),
    () => [w[0], rng.pick(TAGS.filter(x => x !== w[1])), ...w.slice(2)].join(' '),
    () => `${name} ${rng.pick(MIDS)}`,
    () => [w[1], w[0], ...w.slice(2)].join(' '),
  ];
  for (let i = 0; i < 20; i++) {
    const value = rng.pick(options)();
    if (value && norm(value) !== norm(name)) return value;
  }
  return `${name} ${MIDS[0]}`;
}
const recase = (rng, text) => rng.pick([s => s, s => s.toUpperCase(), s => s.toLowerCase()])(text);

// Statement grammar pieces. Labels and metadata follow the closed grammar.
const SENDER_LABELS = ['From:', 'FROM:', 'from', 'From', 'Orig Co Name:', 'ORIG CO NAME:', 'Originator:', 'Originator Name:', 'Sender:', 'Sender Name:', 'By'];
const COLON_SENDER_LABELS = SENDER_LABELS.filter(label => label.includes(':'));
const PREFIXES = ['ACH Credit', 'ACH', 'Wire Transfer', 'Zelle', 'Deposit', 'Payment', 'EFT Deposit'];
const SUFFIX_WORDS = ['Deposit', 'Payment', 'ACH Payment', 'Payroll', 'Wire Receipt'];
// PR-M1: "Co Entry Descr"/"Entry Descr" make a name's last word ambiguous
// with a label; those labels are left out of every pool below.
// PR-M4: abbreviated "Ind ID"/"Ind Name" labels are left out.
const META = [
  ['Orig ID', ': ', '1234567'], ['ORIG ID', ': ', '99812'], ['Trace', '#: ', '555123'], ['Trace Number', ': ', '021000021'],
  ['Ref', ': ', 'INV-1001'], ['REF', ' #: ', '7788'], ['SEC', ': ', 'CCD'], ['SEC', ': ', 'PPD'], ['Memo', ': ', 'Oct'],
  ['Desc Date', ': ', '261005'], ['Eff Date', ': ', '2026-10-05'], ['Entry Date', ': ', '10/05/2026'], ['Company ID', ': ', '1112223'],
];
const metaText = ([label, glue, value]) => `${label}${glue}${value}`;
const SEPARATORS = ['; ', ', ', ' ', '\n'];
// PR-G5: line breaks are only ever placed BETWEEN fields, never at an edge.

function senderField(form, name, label, prefix, suffix) {
  if (form === 'labelled') return `${label} ${name}`;
  if (form === 'prefix') return `${prefix} ${name}`;
  // A channel word before a sender label still labels the sender.
  if (form === 'channel-labelled') return `${prefix} ${label} ${name}`;
  if (form === 'suffix') return `${name} ${suffix}`;
  return name; // bare
}
function joinFields(fields, separators) {
  let out = fields[0];
  for (let i = 1; i < fields.length; i++) out += separators[(i - 1) % separators.length] + fields[i];
  return out;
}

// ---------------------------------------------------------------------------
// End-to-end harness: one sqlite fixture per property, reset per case.
function harness(t) {
  const f = ledgerFixture(t, { knownPayers: false });
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  let asks = 0;
  return {
    get asks() { return asks; },
    async ask({ entities, rows, question }) {
      f.raw('DELETE FROM fin_transactions');
      f.raw("DELETE FROM fin_entities WHERE entity_slug <> 'owner'");
      for (const e of entities) f.raw(`INSERT INTO fin_entities(entity_slug,legal_name,display_label,kind,relationship,provenance,basis_state,recorded_at)
        VALUES (?,?,?,'business','owned','owner_stated','confirmed',?)`, e.slug, e.legal, e.display ?? null, NOW);
      rows.forEach((row, i) => f.add(`r${i}`, row.description ?? null, row.payee ?? null, { cents: row.cents ?? 2500 }));
      const uidById = new Map(f.rows('SELECT id, txn_uid FROM fin_transactions').map(r => [`ledger:transaction:${r.id}`, Number(r.txn_uid.slice(1))]));
      asks++;
      const body = await f.ask(question);
      return observe(body, uidById);
    },
  };
}

// Reduce an answer body to the claims these properties care about.
function observe(body, uidById) {
  const ledger = body.ledger;
  if (!ledger) return { routed: 'documents', body };
  const unattributed = new Set(ledger.unattributed_citations || []);
  const matched = (body.citations || []).filter(c => !unattributed.has(c.n)).map(c => uidById.get(c.ref));
  const complete = body.evidence_gate?.complete !== false;
  const absence = complete && (ledger.found === false || ledger.total_minor === 0 || ledger.lead_total_minor === 0);
  return { routed: 'ledger', kind: ledger.kind, found: ledger.found, complete, absence, matched,
    total: ledger.total_minor ?? null, assumptions: body.assumptions || [], ledger, answer: body.answer };
}

const show = value => JSON.stringify(value, (k, v) => (typeof v === 'symbol' ? String(v) : v));

// Collect violations by class, shrink the first per class, and report.
async function runProperty(t, { id, seed, cases, generate, check, shrink = () => [], minimums = {} }) {
  const rng = makeRng(seed);
  const classes = new Map(), counters = {};
  const count = key => { counters[key] = (counters[key] || 0) + 1; };
  for (let index = 0; index < cases; index++) {
    const input = generate(rng, index);
    const found = await check(input, count);
    for (const violation of found) {
      if (!classes.has(violation.kind)) classes.set(violation.kind, { index, input, violation, hits: 0 });
      classes.get(violation.kind).hits++;
    }
  }
  const report = [];
  for (const [kind, entry] of classes) {
    // Greedy shrink: keep any simpler input that still shows the same class.
    let best = entry.input, bestViolation = entry.violation;
    for (let round = 0, progress = true; progress && round < 50; round++) {
      progress = false;
      for (const candidate of shrink(best)) {
        const again = (await check(candidate, () => {})).find(v => v.kind === kind);
        if (again) { best = candidate; bestViolation = again; progress = true; break; }
      }
    }
    report.push(`[${id} seed=0x${seed.toString(16)} case=${entry.index} hits=${entry.hits}] ${kind}\n  minimal input: ${show(best)}\n  observed: ${show(bestViolation.detail)}`);
  }
  t.diagnostic(`${id} seed=0x${seed.toString(16)} cases=${cases} counters=${show(counters)}`);
  // Coverage guards keep a property from passing vacuously.
  for (const [key, min] of Object.entries(minimums))
    if ((counters[key] || 0) < min) report.push(`[${id}] generator coverage: ${key}=${counters[key] || 0} < ${min}`);
  assert.deepEqual(report, [], `\n${report.join('\n')}`);
}

const QUESTIONS = {
  income: name => `How much income from ${name} in October 2026?`,
  receive: name => `How much did I receive from ${name} in October 2026?`,
  payment: name => `Did a payment from ${name} arrive in the last 30 days?`,
  noun: name => `Did the ${name} payment arrive in the last 30 days?`,
  show: name => `Show me income from ${name} in October 2026`,
};

// ---------------------------------------------------------------------------
// R2-A1 Unregistered payers. Random role-word companies in labelled and
// unlabelled positions; the requested name is never registered.
// Property: a row is reported present only when its exact payee or a labelled
// sender equals the requested name (shorthand only with a starred
// assumption); absence and complete totals are never claimed.
const A1 = { seed: 0xA1A1_2026, cases: 220 };

function genA1(rng) {
  const requested = companyName(rng);
  const rows = [];
  for (let i = 0, n = 1 + rng.int(3); i < n; i++) {
    const exact = rng.chance(0.45);
    // PR-G2: no mid-name commas are generated, so a comma can never be dropped.
    const name = exact ? recase(rng, requested) : nearMiss(rng, requested);
    const where = rng.pick(['payee', 'labelled', 'labelled', 'channel-labelled', 'bare', 'prefix', 'suffix']);
    if (where === 'payee') { rows.push({ payee: name, description: null, where, name, cents: 1000 << i }); continue; }
    const metas = rng.shuffle(META).slice(0, rng.int(3)).map(metaText);
    // Space-joined lines stay short; PR-G1/PR-S3 budget refusals are unknown anyway.
    const separator = rng.pick(['; ', '; ', '\n', ', ', ' ']);
    const description = joinFields([senderField(where, name, rng.pick(SENDER_LABELS), rng.pick(PREFIXES), rng.pick(SUFFIX_WORDS)), ...metas], [separator]);
    rows.push({ payee: null, description, where, name, cents: 1000 << i });
  }
  // PR-S1/PR-S2: the name is the last payer word; no date or account words follow it.
  const question = QUESTIONS[rng.pick(['income', 'receive', 'payment', 'noun', 'show'])](recase(rng, requested));
  return { requested, question, rows, entities: OWNER_ENTITIES };
}

function shrinkRows(input) {
  const out = [];
  if (input.rows.length > 1) for (let i = 0; i < input.rows.length; i++)
    out.push({ ...input, rows: input.rows.filter((_, j) => j !== i) });
  return out;
}

test('R2-A1 unregistered payer is present only on an exact payee or labelled sender, and never absent', async t => {
  const h = harness(t);
  await runProperty(t, { id: 'R2-A1', ...A1, generate: genA1, shrink: shrinkRows,
    minimums: { ledger: 150, present: 25, notPresent: 60 },
    async check(input, count) {
      const out = await h.ask(input);
      if (out.routed !== 'ledger') { count('documents'); return []; }
      count('ledger');
      const violations = [];
      const wanted = norm(input.requested);
      for (const uid of out.matched) {
        const row = input.rows[uid];
        const exact = norm(row.name) === wanted && ['payee', 'labelled', 'channel-labelled'].includes(row.where);
        const shorthand = norm(row.name) === wanted && ['prefix', 'suffix'].includes(row.where);
        if (!exact && !(shorthand && out.assumptions.length))
          violations.push({ kind: 'present without an exact payee or labelled sender', detail: { row, found: out.found, answer: out.answer } });
      }
      count(out.found === true ? 'present' : 'notPresent');
      if (out.absence) violations.push({ kind: 'absence claimed for an unregistered payer', detail: { found: out.found, total: out.total, answer: out.answer } });
      if (out.kind === 'merchant' && out.total !== null && out.complete)
        violations.push({ kind: 'complete total for an unregistered payer', detail: { total: out.total, answer: out.answer } });
      return violations;
    } });
});

// ---------------------------------------------------------------------------
// R2-A2 Aliases. One registered entity with a legal name and display label
// (some legal names carry a comma or a terminal period), and an unregistered
// outside payer that CONTAINS the display label.
// Property: every alias asks gets the same attribution (found, total,
// matched rows, completeness), and the outside payer's row is never matched.
const A2 = { seed: 0xA2A2_2026, cases: 120 };

function genA2(rng) {
  const base = `${rng.pick(ROLES)} ${rng.pick(TAGS)}`;
  const legalTail = rng.pick([' LLC', ', LLC', ' Inc.', ', Inc.', ' Inc', ' Holdings LLC', ' Group, Inc.', ' L.L.C.', ' & Co', ' Co.']);
  const legal = base + legalTail;
  const display = base;
  const outside = rng.pick([`${display} ${rng.pick(['Supply Co', 'Services LLC', 'West Inc', 'Trading'])}`, `${rng.pick(['North', 'Summit', 'River'])} ${display}`]);
  const aliasForm = rng.pick(['payee-legal', 'payee-display', 'labelled-legal', 'labelled-display', 'suffix-display', 'prefix-legal']);
  const [where, which] = aliasForm.split('-');
  const aliasName = recase(rng, which === 'legal' ? legal : display);
  const rowE = where === 'payee' ? { payee: aliasName, description: null }
    : { payee: null, description: joinFields([senderField(where, aliasName, rng.pick(COLON_SENDER_LABELS), rng.pick(PREFIXES), rng.pick(SUFFIX_WORDS)), metaText(rng.pick(META))], ['; ']) };
  const rowO = rng.chance(0.5) ? { payee: outside, description: null }
    : { payee: null, description: `${rng.pick(COLON_SENDER_LABELS)} ${outside}` };
  const rows = rng.shuffle([{ ...rowE, role: 'entity', where, cents: 1000 }, { ...rowO, role: 'outside', cents: 2000 }]);
  const template = rng.pick(['income', 'receive', 'payment']);
  const asks = [legal, display, legal.toUpperCase(), display.toLowerCase()];
  if (legal.endsWith('.')) asks.push(legal.slice(0, -1));
  // PR-M2: a registered comma name asked WITHOUT its comma refuses; not asked here.
  return { entity: { slug: 'target-entity', legal, display }, outside, rows, template, asks };
}

test('R2-A2 every alias of a registered entity gets the same attribution, and a containing outside payer is never matched', async t => {
  const h = harness(t);
  await runProperty(t, { id: 'R2-A2', ...A2, generate: genA2,
    shrink: input => input.asks.length > 2 ? input.asks.slice(2).map(a => ({ ...input, asks: input.asks.filter(x => x !== a) })) : [],
    minimums: { aliasSetsCompared: 100, entityMatched: 60, exactNamesOnlyAsked: 200 },
    async check(input, count) {
      const violations = [], signatures = [];
      for (const alias of input.asks) {
        const out = await h.ask({ entities: [input.entity, ...OWNER_ENTITIES], rows: input.rows, question: QUESTIONS[input.template](alias) });
        if (out.routed !== 'ledger') { signatures.push({ alias, routed: out.routed }); continue; }
        const matchedRoles = out.matched.map(uid => input.rows[uid].role).sort();
        if (matchedRoles.includes('outside'))
          violations.push({ kind: 'outside payer containing an alias matched', detail: { alias, matchedRoles, answer: out.answer } });
        if (out.absence) violations.push({ kind: 'absence claimed while the entity row exists', detail: { alias, answer: out.answer } });
        if (matchedRoles.includes('entity')) count('entityMatched');
        const shorthand = input.rows.find(r => r.role === 'entity' && ['prefix', 'suffix'].includes(r.where));
        if (shorthand && matchedRoles.includes('entity') && !out.assumptions.length)
          violations.push({ kind: 'shorthand match without a starred assumption', detail: { alias, answer: out.answer } });
        // The exact-names-only flip drops shorthand but must never turn it into absence.
        const exact = await h.ask({ entities: [input.entity, ...OWNER_ENTITIES], rows: input.rows,
          question: QUESTIONS[input.template](alias).replace(/\?$/, ', exact names only?') });
        if (exact.routed === 'ledger') {
          count('exactNamesOnlyAsked');
          const exactRoles = exact.matched.map(uid => input.rows[uid].role);
          if (shorthand && exactRoles.includes('entity'))
            violations.push({ kind: 'exact names only still matches shorthand', detail: { alias, answer: exact.answer } });
          if (exact.absence) violations.push({ kind: 'exact names only claims absence', detail: { alias, answer: exact.answer } });
        }
        signatures.push({ alias, found: out.found, total: out.total, complete: out.complete, matchedRoles });
      }
      count('aliasSetsCompared');
      const key = s => show({ ...s, alias: undefined });
      if (new Set(signatures.map(key)).size > 1)
        violations.push({ kind: 'aliases disagree', detail: signatures });
      return violations;
    } });
});

// ---------------------------------------------------------------------------
// R2-A3 Conflicting sender fields: two labelled senders that disagree, or a
// bank payee that disagrees with a labelled sender.
// Property: attributeInflow is unknown (never silently one of them), and an
// end-to-end ask for either name neither matches that row nor claims absence.
const A3 = { seed: 0xA3A3_2026, cases: 160 };
const A3_REGISTERED = [
  { slug: 'payer-alpha', legal: 'Payer Alpha LLC', display: 'Payer Alpha' },
  { slug: 'vendor-beta', legal: 'Vendor Beta Inc', display: null },
];

function genA3(rng) {
  const pool = ['Payer Alpha LLC', 'Payer Alpha', 'Vendor Beta Inc', 'Owner Holdings LLC', companyName(rng, { roles: ['Client', 'Tenant', 'Buyer'] })];
  const x = rng.pick(pool);
  let y = rng.pick(pool);
  const sameEntity = (a, b) => {
    const slug = n => [...A3_REGISTERED, ...OWNER_ENTITIES].find(e => [e.legal, e.display].filter(Boolean).map(norm).includes(norm(n)))?.slug;
    return norm(a) === norm(b) || (slug(a) && slug(a) === slug(b));
  };
  // About one case in ten is a same-entity control (two aliases agree).
  if (rng.chance(0.1)) y = { 'Payer Alpha LLC': 'Payer Alpha', 'Payer Alpha': 'Payer Alpha LLC', 'Owner Holdings LLC': 'Owner Holdings' }[x] ?? x;
  else for (let i = 0; i < 10 && sameEntity(x, y); i++) y = rng.pick(pool);
  const conflict = !sameEntity(x, y);
  const shape = rng.pick(['two-labelled', 'two-labelled', 'payee-vs-labelled', 'shorthand-vs-labelled']);
  const metas = rng.shuffle(META).slice(0, rng.int(3)).map(metaText);
  const separator = rng.pick(['; ', '\n', ', ', ' ']);
  let row;
  if (shape === 'two-labelled') {
    const fields = [`${rng.pick(COLON_SENDER_LABELS)} ${x}`, ...metas];
    fields.splice(1 + rng.int(fields.length), 0, `${rng.pick(COLON_SENDER_LABELS)} ${y}`);
    row = { payee: null, description: joinFields(fields, [separator]) };
  } else if (shape === 'shorthand-vs-labelled') {
    const shorthand = rng.chance(0.5) ? `${rng.pick(PREFIXES)} ${x}` : `${x} ${rng.pick(SUFFIX_WORDS)}`;
    row = { payee: null, description: joinFields([shorthand, ...metas, `${rng.pick(COLON_SENDER_LABELS)} ${y}`], [separator]) };
  } else {
    row = { payee: x, description: joinFields([`${rng.pick(SENDER_LABELS)} ${y}`, ...metas], [separator]) };
  }
  return { shape, conflict, x, y, row, ask: rng.chance(0.5) ? x : y, template: rng.pick(['income', 'payment']) };
}

test('R2-A3 conflicting payee and sender fields are unknown, never one of them silently', async t => {
  const h = harness(t);
  const registry = payerRegistry([...A3_REGISTERED, ...OWNER_ENTITIES].flatMap(e => [{ entity_slug: e.slug, legal_name: e.legal, display_label: e.display }]));
  await runProperty(t, { id: 'R2-A3', ...A3, generate: genA3,
    shrink: input => input.row.description?.includes('; ') || input.row.description?.includes('\n') || input.row.description?.includes(', ')
      ? [{ ...input, row: { ...input.row, description: input.row.description.split(/; |\n|, /).filter(f => /^(?:from|orig co name|originator|sender|by)\b/i.test(f)).join('; ') } }]
        .filter(c => c.row.description !== input.row.description && c.row.description) : [],
    minimums: { conflicts: 100, controls: 5, 'shape:two-labelled': 40, 'shape:payee-vs-labelled': 20, 'shape:shorthand-vs-labelled': 20 },
    async check(input, count) {
      const violations = [];
      if (!input.conflict) {
        count('controls');
        if (attributeInflow(input.row, registry).state === 'confirmed') count('controlsConfirmed');
        return [];
      }
      count('conflicts'); count(`shape:${input.shape}`);
      const decided = attributeInflow(input.row, registry);
      if (decided.state !== 'unknown')
        violations.push({ kind: `${input.shape}: attributeInflow picks one side`, detail: { state: decided.state, slug: decided.entity_slug, source: decided.evidence.source } });
      const out = await h.ask({ entities: [...A3_REGISTERED, ...OWNER_ENTITIES], rows: [{ ...input.row, cents: 1000 }], question: QUESTIONS[input.template](input.ask) });
      if (out.routed === 'ledger') {
        if (out.matched.length) violations.push({ kind: `${input.shape}: conflicting row reported present`, detail: { ask: input.ask, answer: out.answer } });
        if (out.absence) violations.push({ kind: `${input.shape}: absence claimed over a conflicting row`, detail: { ask: input.ask, found: out.found, total: out.total, answer: out.answer } });
      }
      return violations;
    } });
});

// ---------------------------------------------------------------------------
// R2-A4 Two-payer questions: "from A or B", "from A and B", "from A & B".
// Rows carry distinct power-of-two amounts so any double count is visible.
// Property: every printed figure equals the sum of distinct matched rows, no
// row from a third payer is matched, and absence is never claimed.
const A4 = { seed: 0xA4A4_2026, cases: 160 };

function genA4(rng) {
  let a = companyName(rng, { legal: rng.chance(0.4) }), b = companyName(rng, { legal: rng.chance(0.4) });
  for (let i = 0; i < 10 && (norm(b).includes(norm(a)) || norm(a).includes(norm(b))); i++) b = companyName(rng);
  const mode = rng.pick(['both', 'a-only', 'none', 'aliases', 'conjoined']);
  const entities = [...OWNER_ENTITIES];
  if (mode === 'aliases') { b = a.split(' ').slice(0, 2).join(' '); a = `${b} Holdings LLC`; entities.push({ slug: 'ab', legal: a, display: b }); }
  if (mode === 'both' || mode === 'a-only') entities.push({ slug: 'a', legal: a, display: null });
  if (mode === 'both') entities.push({ slug: 'b', legal: b, display: null });
  const c = companyName(rng, { roles: ['Lender', 'Broker'] });
  const joiner = rng.pick(['or', 'and', '&']);
  // Control: ONE registered company whose legal name itself joins two words.
  const ab = `${a} ${joiner} ${b}`;
  if (mode === 'conjoined') entities.push({ slug: 'ab', legal: ab, display: null });
  const rowFor = (name, role, i) => {
    const where = rng.pick(['payee', 'labelled', 'labelled', 'suffix']);
    const cents = 1000 * (1 << i);
    if (where === 'payee') return { payee: name, description: null, role, where, cents };
    return { payee: null, description: joinFields([senderField(where, name, rng.pick(COLON_SENDER_LABELS), 'ACH Credit', rng.pick(SUFFIX_WORDS)), metaText(rng.pick(META))], ['; ']), role, where, cents };
  };
  const roles = rng.shuffle(['a', 'b', 'c', 'owner', ...(rng.chance(0.4) ? ['a'] : []), ...(mode === 'conjoined' ? ['ab', 'ab'] : [])]);
  const rows = roles.map((role, i) => rowFor({ a, b, c, ab, owner: 'Owner Holdings LLC' }[role], role, i));
  const template = rng.pick(['income', 'receive', 'payment', 'noun', 'amount']);
  const question = template === 'noun' ? `Did the ${a} payment from ${b} arrive in the last 30 days?`
    : template === 'amount' ? `Did a $${(rows[0].cents / 100).toFixed(2)} payment from ${ab} arrive in the last 30 days?`
      : QUESTIONS[template](ab);
  return { mode, a, b, entities, rows, allowed: mode === 'conjoined' && template !== 'noun' ? ['ab'] : ['a', 'b'], question };
}

test('R2-A4 two-payer questions never double-count a row and never claim absence for either payer', async t => {
  const h = harness(t);
  await runProperty(t, { id: 'R2-A4', ...A4, generate: genA4,
    shrink: input => input.rows.length > 1 ? input.rows.map((_, i) => ({ ...input, rows: input.rows.filter((__, j) => j !== i) })) : [],
    minimums: { ledger: 80, withMatches: 10 },
    async check(input, count) {
      const out = await h.ask(input);
      if (out.routed !== 'ledger') { count('documents'); return []; }
      count('ledger'); count(`found:${out.found}`); if (out.matched.length) count('withMatches');
      const violations = [];
      const matchedRows = out.matched.map(uid => input.rows[uid]);
      if (new Set(out.matched).size !== out.matched.length)
        violations.push({ kind: 'a row is cited twice as matched', detail: { matched: out.matched, answer: out.answer } });
      const distinctSum = [...new Set(out.matched)].reduce((sum, uid) => sum + input.rows[uid].cents, 0);
      const figures = { total_minor: out.ledger.total_minor, lead_total_minor: out.ledger.lead_total_minor,
        attributed_subtotal_minor: out.ledger.attributed_subtotal_minor,
        groups_sum: out.ledger.groups ? out.ledger.groups.reduce((s, g) => s + (g.total_minor ?? 0), 0) : undefined };
      for (const [name, value] of Object.entries(figures))
        if (Number.isInteger(value) && value !== distinctSum && !(name === 'lead_total_minor'))
          violations.push({ kind: `figure ${name} is not the sum of distinct matched rows`, detail: { value, distinctSum, answer: out.answer } });
      if (Number.isInteger(out.ledger.total_minor) && out.ledger.total_minor > out.ledger.inflow_total_minor)
        violations.push({ kind: 'payer total exceeds all inflows', detail: { total: out.ledger.total_minor, inflow: out.ledger.inflow_total_minor } });
      if (matchedRows.some(row => !input.allowed.includes(row.role)))
        violations.push({ kind: 'a third payer row is matched', detail: { roles: matchedRows.map(r => r.role), answer: out.answer } });
      if (out.absence) violations.push({ kind: 'absence claimed for a two-payer question', detail: { found: out.found, total: out.total, answer: out.answer } });
      return violations;
    } });
});

// ---------------------------------------------------------------------------
// R2-A5 Metamorphic: permute field order, change separators among "; ",
// ", ", " " and newline, and change label case.
// Property: across all variants of one statement line, attribution is stable
// or degrades to unknown. It never decides two different payers, and never
// decides a payer other than the generated sender.
const A5 = { seed: 0xA5A5_2026, cases: 400, variants: 12 };
const A5_REGISTERED = [
  { entity_slug: 'payer-alpha', legal_name: 'Payer Alpha LLC', display_label: 'Payer Alpha' },
  { entity_slug: 'vendor-beta', legal_name: 'Vendor Beta, Inc.', display_label: 'Vendor Beta' },
  { entity_slug: 'owner-holdings', legal_name: 'Owner Holdings LLC', display_label: 'Owner Holdings' },
];
const caseLabel = (rng, label) => rng.pick([s => s, s => s.toUpperCase(), s => s.toLowerCase(),
  s => s.toLowerCase().replace(/\b\p{L}/gu, ch => ch.toUpperCase())])(label);

function genA5(rng) {
  const phrase = companyName(rng, { roles: ['Client', 'Tenant', 'Buyer', 'Seller'], legal: false });
  const stranger = companyName(rng, { roles: ['Lender', 'Broker'] });
  const sender = rng.pick(['Payer Alpha LLC', 'Payer Alpha', 'Vendor Beta, Inc.', 'Vendor Beta', 'Owner Holdings', phrase, stranger]);
  const form = rng.pick(['labelled', 'labelled', 'labelled', 'prefix', 'suffix', 'bare']);
  const label = rng.pick(SENDER_LABELS), prefix = rng.pick(PREFIXES), suffix = rng.pick(SUFFIX_WORDS);
  const metas = rng.shuffle(META).slice(0, rng.int(4));
  const twin = { 'Payer Alpha LLC': 'Payer Alpha', 'Payer Alpha': 'Payer Alpha LLC', 'Vendor Beta, Inc.': 'Vendor Beta', 'Vendor Beta': 'Vendor Beta, Inc.' }[sender];
  // A second labelled field naming the SAME entity by another alias agrees.
  const alias = twin && form === 'labelled' && rng.chance(0.3) ? `${rng.pick(COLON_SENDER_LABELS)} ${twin}` : null;
  return { phrase, alias, sender, form, label, prefix, suffix, metas, variantSeed: rng.int(0x7fffffff) };
}

function renderA5(input, { order, separators, labelCase, nameCase = s => s }) {
  const sender = senderField(input.form, nameCase(input.sender), labelCase(input.label), labelCase(input.prefix), labelCase(input.suffix));
  const fields = [sender, ...input.metas.map(([l, g, v]) => `${labelCase(l)}${g}${v}`),
    ...(input.alias ? [input.alias.replace(/^[^:]+/, labelCase)] : [])];
  return joinFields(order.map(i => fields[i]), separators);
}

test('R2-A5 permuting fields, separators and label case never flips the attribution', async t => {
  const registry = payerRegistry(A5_REGISTERED);
  await runProperty(t, { id: 'R2-A5', ...A5, generate: genA5,
    shrink: input => input.metas.map((_, i) => ({ ...input, metas: input.metas.filter((__, j) => j !== i) })),
    minimums: { decidedVariants: 1500, degradedVariants: 200 },
    async check(input, count) {
      const intent = classifyLedgerQuestion(QUESTIONS.income(input.phrase), { now });
      const scoped = payerQuestionRegistry(intent, registry);
      const rng = makeRng(input.variantSeed);
      const expectedSlug = A5_REGISTERED.find(e => [e.legal_name, e.display_label].map(norm).includes(norm(input.sender)))?.entity_slug
        ?? (norm(input.sender) === norm(input.phrase) ? `phrase:${norm(input.phrase)}` : null);
      const n = 1 + input.metas.length + (input.alias ? 1 : 0);
      const variants = [{ order: [...Array(n).keys()], separators: ['; '], labelCase: s => s, name: 'canonical' }];
      for (let i = 0; i < A5.variants; i++) {
        const order = rng.chance(0.5) ? [0, ...rng.shuffle([...Array(n).keys()].slice(1))] : rng.shuffle([...Array(n).keys()]);
        const separators = Array.from({ length: Math.max(1, n - 1) }, () => rng.pick(SEPARATORS));
        const mode = rng.int(4);
        const nameMode = rng.int(3);
        variants.push({ order, separators, labelCase: s => (mode === 0 ? s : mode === 1 ? s.toUpperCase() : mode === 2 ? s.toLowerCase() : caseLabel(rng, s)),
          nameCase: s => (nameMode === 0 ? s : nameMode === 1 ? s.toUpperCase() : s.toLowerCase()), name: `v${i}` });
      }
      const decisions = [];
      for (const variant of variants) {
        const description = renderA5(input, variant);
        const decided = attributeInflow({ description }, scoped);
        const slug = decided.entity_slug === null ? null : typeof decided.entity_slug === 'symbol' ? `phrase:${decided.entity_slug.description}` : decided.entity_slug;
        count(slug ? 'decidedVariants' : 'degradedVariants');
        decisions.push({ description, state: decided.state, slug, refusal: decided.evidence.parser?.refusal ?? null });
      }
      const violations = [];
      const slugs = new Set(decisions.filter(d => d.slug).map(d => d.slug));
      if (slugs.size > 1) violations.push({ kind: 'variants decide different payers (A<->B flip)', detail: decisions.filter(d => d.slug) });
      const wrong = decisions.filter(d => d.slug && d.slug !== expectedSlug);
      if (wrong.length) violations.push({ kind: 'a variant decides a payer other than the generated sender', detail: { expectedSlug, wrong } });
      return violations;
    } });
});

// ---------------------------------------------------------------------------
// R2-A3 regression repros (NEW, not a round-1 root cause). attributeRow()
// returns the payee decision as soon as row.payee is set
// (ledger-attribution.js:405) and never reads the description, so a labelled
// sender that names a different payer is silently discarded. The payee side
// becomes "confirmed", which (a) certifies absence for the labelled payer and
// (b) books the deposit as complete income for the payee entity.
const REPRO_ENTITIES = [
  { slug: 'payer-alpha', legal: 'Payer Alpha LLC', display: null },
  { slug: 'vendor-beta', legal: 'Vendor Beta Inc', display: null },
];
const reproRegistry = () => payerRegistry(REPRO_ENTITIES.map(e => ({ entity_slug: e.slug, legal_name: e.legal, display_label: e.display })));
const CONFLICT_ROW = { payee: 'Vendor Beta Inc', description: 'Orig Co Name: Payer Alpha LLC; SEC: CCD', cents: 2500 };

test('R2-A3-repro a payee that disagrees with a labelled sender is decided as the payee', () => {
  const decided = attributeInflow(CONFLICT_ROW, reproRegistry());
  assert.equal(decided.state, 'unknown', `got ${decided.state} ${decided.entity_slug} from ${decided.evidence.source}`);
});

test('R2-A3-repro the labelled payer is reported absent and the payee gets a complete total', async t => {
  const h = harness(t);
  const problems = [];
  const absent = await h.ask({ entities: REPRO_ENTITIES, rows: [CONFLICT_ROW], question: QUESTIONS.payment('Payer Alpha LLC') });
  if (absent.absence) problems.push(`labelled sender reported absent: ${absent.answer}`);
  const zero = await h.ask({ entities: REPRO_ENTITIES, rows: [CONFLICT_ROW], question: QUESTIONS.income('Payer Alpha LLC') });
  if (zero.absence) problems.push(`complete $0 for the labelled sender: total=${zero.total} complete=${zero.complete}`);
  const income = await h.ask({ entities: REPRO_ENTITIES, rows: [CONFLICT_ROW], question: QUESTIONS.income('Vendor Beta Inc') });
  if (income.complete && income.total === 2500) problems.push(`complete payee total over a conflicting sender: total=${income.total}`);
  assert.deepEqual(problems, []);
});

test('R2-A3-repro control: agreeing payee and sender confirm, and the sender alone is found', async t => {
  const agree = { payee: 'Payer Alpha LLC', description: 'Orig Co Name: Payer Alpha LLC; SEC: CCD', cents: 2500 };
  const decided = attributeInflow(agree, reproRegistry());
  assert.equal(decided.state, 'confirmed');
  assert.equal(decided.entity_slug, 'payer-alpha');
  const h = harness(t);
  const senderOnly = await h.ask({ entities: REPRO_ENTITIES, rows: [{ ...CONFLICT_ROW, payee: null }], question: QUESTIONS.payment('Payer Alpha LLC') });
  assert.equal(senderOnly.found, true);
  assert.equal(senderOnly.complete, true);
  const both = await h.ask({ entities: REPRO_ENTITIES, rows: [agree], question: QUESTIONS.income('Payer Alpha LLC') });
  assert.equal(both.total, 2500);
  assert.equal(both.complete, true);
});
