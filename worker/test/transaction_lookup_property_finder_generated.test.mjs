import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { formatMinor, displayFigures } from '../../eval/fast-loop/money-oracle.mjs';

// Finder receipts are synthetic. Gold is selected with integer cents from the
// generated input, never from a product parser, reader or answer.
const SEEDS = [1105, 5241, 23613, 427];
function rng(seed) { return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }; }
export function generateCases() {
  return SEEDS.flatMap(seed => {
    const next = rng(seed);
    return Array.from({ length: 160 }, (_, i) => {
      const shape = i % 8, cents = String(100 + next() % 99900);
      const vendor = ['Vendor Unit', 'Supplier Unit', 'Store Unit', 'Service Unit'][next() % 4];
      const row = (id, extra = {}) => ({ id, cents, account: 'fixture-account', pending: false,
        date: '2026-10-05', payee: vendor, description: vendor, ...extra });
      const rows = [row('near', { cents: String(BigInt(cents) + 1n) }),
        row('wrong-account', { account: 'other-account' }), row('pending', { pending: true }),
        row('other-vendor', { payee: 'Different Unit', description: 'Different Unit' })];
      if (![1, 2, 3].includes(shape)) rows.push(row('exact', { description: shape === 4 ? `CARD * ${vendor.toUpperCase()} ONLINE` : vendor }));
      if (shape === 5 || shape === 7) rows.push(row('latest', { date: '2026-10-09', cents: shape === 7 ? String(BigInt(cents) + 27n) : cents }));
      if (shape === 6) rows.push(row('descriptor', { payee: null, description: `PAYMENT TO ${vendor}` }));
      return { id: `${seed}-${i}`, shape, cents, vendor, last: shape === 7, rows };
    });
  });
}
function gold(c) {
  const hits = c.rows.filter(r => !r.pending && r.account === 'fixture-account' &&
    r.payee === c.vendor && (c.last || BigInt(r.cents) === BigInt(c.cents)));
  return c.last ? hits.filter(r => r.date === hits.map(r => r.date).sort().at(-1)) : hits;
}
test('seeded single transaction finder: independent exact cents, receipt and absence properties', async t => {
  const f = ledgerFixture(t);
  f.env.RERANK_MODEL = 'claude-haiku-4-5-20251001';
  f.env.ANTHROPIC_API_KEY = randomBytes(24).toString('hex');
  f.raw("UPDATE fin_accounts SET mask='5241'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at)
    SELECT 'other-account',entity_slug,account_kind,balance_role,'7788',feed_mode,provenance,source_feed,basis_state,recorded_at FROM fin_accounts`);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at)
    SELECT 'other-account',coverage_status,covered_from,covered_to,computed_at,provenance,source_feed,basis_state,recorded_at FROM fin_account_coverage`);
  t.mock.method(globalThis, 'fetch', () => assert.fail('finder must stay offline'));
  const stats = { cases: 0, ledger: 0, documents: 0, refusals: 0, extractor: 0, wrong_figures: 0, over_refusals: 0, groups: {} };
  async function evaluate(c, count = false, answer = withLedgerAnswer) {
    f.raw('DELETE FROM fin_transactions');
    const ids = new Map();
    for (const r of c.rows) {
      f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,pending,provenance,source_feed,basis_state,recorded_at)
        VALUES (?,?,?,?,'outflow',?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`,
      r.id, r.account, r.date, Number(r.cents), r.description, r.payee, Number(r.pending), NOW);
      ids.set(r.id, f.first('SELECT id FROM fin_transactions WHERE txn_uid=?', r.id).id);
    }
    const question = c.last ? `When did I last pay ${c.vendor} in the account ending 5241 in October 2026?`
      : `Could you retrieve the ${formatMinor(c.cents)} payment to ${c.vendor} in the account ending 5241 in October 2026?`;
    const reply = { intents: [{ kind: 'payment', direction: 'outflow', count: null,
      vendor_text: c.vendor, account_hint: 'account ending 5241', amount_text: c.last ? null : formatMinor(c.cents),
      date_text: null, period: { type: 'between', from: '2026-10-01', to: '2026-10-31' } }] };
    let documents = 0, extractor = 0;
    const body = await (await answer({ env: f.env, question, now: NOW, timeZone: 'UTC',
      grantScope: { all: true }, scopePrincipalKind: 'owner', callLLM: async () => {
        extractor++; return { content: [{ type: 'text', text: JSON.stringify(reply) }] };
      } }, async () => { documents++; return Response.json({ route: 'documents' }); })).json();
    const expected = gold(c), refs = body.citations || [];
    // Null preserves uncertainty about payment outside the searched scope.
    // Only this exact empty-window receipt supports bounded absence; a
    // possible candidate or an unproved amount still counts as a refusal.
    const boundedAbsence = !expected.length && body.ledger?.kind === 'payment' &&
      body.ledger.found === null && body.ledger.match_basis === 'none' &&
      body.ledger.complete === false && body.ledger.total_minor === null &&
      body.ledger.attribution_incomplete === false && body.ledger.accounts?.length === 1 &&
      body.ledger.accounts[0].account_mask === '5241' && body.ledger.accounts[0].covered_to === '2026-10-31' &&
      body.ledger.amount_minor === Number(c.cents) &&
      body.ledger.from === '2026-10-01' && body.ledger.to === '2026-10-12' &&
      body.ledger.requested_to === '2026-10-31' && body.ledger.partial_reason === 'period_in_progress' &&
      body.ledger.amount_candidates?.length === 0 && refs.length === 0;
    const refused = !body.ledger || body.ledger.found === null && !boundedAbsence;
    if (count) { stats.cases++; stats.extractor += extractor; stats.documents += documents;
      if (body.ledger) stats.ledger++; if (refused) { stats.refusals++; stats.over_refusals++; } }
    if (refused) return 'refusal';
    if (c.tie && !new RegExp(`${expected.length} payments.*October 9`).test(body.answer)) return 'tie-summary';
    if (!boundedAbsence && body.ledger.found !== (expected.length > 0)) return 'presence';
    const wanted = expected.map(r => `ledger:transaction:${ids.get(r.id)}`).sort();
    if (JSON.stringify(refs.map(r => r.ref).sort()) !== JSON.stringify(wanted)) return c.last ? 'latest-row' : 'exact-receipt';
    if (refs.some(ref => ref.account_mask !== '5241' || !expected.some(r =>
      `ledger:transaction:${ids.get(r.id)}` === ref.ref && BigInt(r.cents) === BigInt(ref.amount_minor)))) return 'wrong-figure';
    if (expected.length && displayFigures(body.answer).some(x => !expected.some(r => BigInt(r.cents) === BigInt(x.cents)))) return 'wrong-figure';
    if (!expected.length && (!body.answer.includes('5241') || !body.answer.includes('October 1') ||
      !body.answer.includes('October 12') || body.ledger.to !== '2026-10-12' ||
      body.ledger.requested_to !== '2026-10-31')) return 'absence-scope';
    return null;
  }
  for (const c of generateCases()) {
    const failure = await evaluate(c, true);
    if (!failure) continue;
    stats.wrong_figures++;
    // Greedy deletion to a 1-minimal witness: every retained row is necessary
    // to reproduce this root cause. Revisit after each successful reduction.
    let small = { ...c, rows: [...c.rows] }, changed = true;
    while (changed) { changed = false;
      for (let i = 0; i < small.rows.length; i++) {
        const candidate = { ...small, rows: small.rows.filter((_, j) => i !== j) };
        if (await evaluate(candidate) === failure) { small = candidate; changed = true; break; }
      }
    }
    // Reduce magnitude and vocabulary too, preserving the relative cents and
    // date ordering that distinguish the two receipts.
    const reduced = { ...small, cents: '1', vendor: 'Vendor Unit', rows: small.rows.map(r => ({ ...r,
      cents: String(BigInt(r.cents) - BigInt(small.cents) + 1n),
      date: r.date === '2026-10-09' ? '2026-10-02' : '2026-10-01',
      payee: r.payee === small.vendor ? 'Vendor Unit' : r.payee,
      description: r.description.replaceAll(small.vendor, 'Vendor Unit'),
    })) };
    if (reduced.rows.every(r => BigInt(r.cents) >= 0n) && await evaluate(reduced) === failure) small = reduced;
    for (let i = 0; i < small.rows.length; i++) assert.notEqual(
      await evaluate({ ...small, rows: small.rows.filter((_, j) => i !== j) }), failure,
      'every shrunk witness must be irreducible by row deletion');
    const group = stats.groups[failure] ||= { count: 0, witness: { id: c.id, shape: c.shape, cents: small.cents, rows: small.rows } };
    group.count++;
    assert.ok(small.rows.length <= c.rows.length);
  }
  console.log('TRANSACTION_FINDER ' + JSON.stringify(stats));
  assert.equal(stats.cases, 640);
  assert.ok(stats.extractor > 0, 'injected extractor must actually run');
  assert.equal(stats.ledger, 640);
  assert.equal(stats.documents, 0);
  assert.equal(stats.over_refusals, 0);
  const latest = generateCases().find(c => c.last);
  const tied = { ...latest, tie: true, rows: [...latest.rows,
    { ...latest.rows.find(r => r.id === 'latest'), id: 'tie', cents: '73' },
    { ...latest.rows.find(r => r.id === 'pending'), id: 'later-pending', date: '2026-10-11', cents: '991' }] };
  await t.test('same-day payments retain every amount and receipt', async () => assert.equal(await evaluate(tied), null));
  await t.test('pending alone cannot establish last paid', async () =>
    assert.equal(await evaluate({ ...latest, rows: latest.rows.filter(r => r.pending) }), null));
  console.log('LATEST_PAYMENT tie_cases=1');
  assert.equal(stats.wrong_figures, 0);

  // Isolated module graphs exercise real decisions without changing working files.
  const base = new URL('../src/lib/', import.meta.url);
  const data = s => `data:text/javascript;base64,${Buffer.from(s).toString('base64')}`;
  const absolute = s => s.replace(/from (["'])(\.\/.+?)\1/g,
    (_, q, path) => `from ${q}${new URL(path, base).href}${q}`);
  async function mutant(file, before, after) {
    const sources = Object.fromEntries(['ledger-answer.js', 'ledger-intent.js', 'ledger-reader.js'].map(name =>
      [name, readFileSync(new URL(name, base), 'utf8')]));
    assert.equal(sources[file].split(before).length - 1, 1);
    sources[file] = sources[file].replace(before, after);
    for (const name of ['ledger-intent.js', 'ledger-reader.js']) sources['ledger-answer.js'] =
      sources['ledger-answer.js'].replace(`"./${name}"`, `'${data(absolute(sources[name]))}'`);
    return (await import(data(absolute(sources['ledger-answer.js'])))).withLedgerAnswer;
  }
  const mutations = [
    ['exact cents', 'ledger-answer.js', 'intent.amountMinor !== null && row.amount_minor !== intent.amountMinor', 'intent.amountMinor !== null && false', generateCases()[0]],
    ['posted reader', 'ledger-reader.js', 't.pending=${pendingOnly ? 1 : 0}', 't.pending=1', generateCases()[0]],
    ['oldest row chosen', 'ledger-answer.js', 'row.posted_on > day', 'row.posted_on < day', latest],
    ['pending counted as last', 'ledger-reader.js', 't.pending=${pendingOnly ? 1 : 0}', 't.pending IN (0,1)', tied],
    ['tie collapsed to one', 'ledger-answer.js', 'matched.filter(row => row.posted_on === newest)', 'matched.filter(row => row.posted_on === newest).slice(0, 1)', tied],
  ];
  for (const [label, file, before, after, c] of mutations) await t.test(`kills ${label}`, async () => {
    const changed = await mutant(file, before, after);
    assert.notEqual(await evaluate(c, false, changed), null, 'same independent receipt contract must fail');
  });
});
