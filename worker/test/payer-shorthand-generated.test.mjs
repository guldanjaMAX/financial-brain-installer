import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { total, formatMinor } from '../../eval/fast-loop/money-oracle.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';

// Expose the existing private reader in memory, as the period finder does.
// No model, copied product implementation, or product-derived gold is used.
const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
const source = readFileSync(url, 'utf8').replace('async function withParsedLedgerAnswer(', 'export async function withParsedLedgerAnswer(')
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, url).href}${q}`);
const { withParsedLedgerAnswer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const locations = {
  'shorthand-positive-without-note': 'worker/src/lib/ledger-analysis.js:58; worker/src/lib/ledger-answer.js:676',
  'near-miss-not-offered': 'worker/src/lib/ledger-answer.js:617,649,678',
  'amount-absence-wording': 'worker/src/lib/ledger-answer.js:678',
  'question-over-refusal': 'worker/src/lib/ledger-question.js:496',
  'answer-over-refusal': 'worker/src/lib/ledger-answer.js:641',
  'shorthand-absence': 'worker/src/lib/ledger-answer.js:681',
  'wrong-figure': 'worker/src/lib/ledger-answer.js:676',
  'missing-row-identity': 'worker/src/lib/ledger-answer.js:676',
};
const seeds = [0x1106, 0xc0ffee, 0x427, 0x51eed];
function random(seed) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }
const now = Date.parse('2026-10-12T12:00:00Z');
const shift = n => `2026-09-${String(15 + n).padStart(2, '0')}`;

// Pure contract classifier is shared by the finder and deliberately bad-answer
// probes. Figures in uncertainty explanations are evidence, not payer totals.
function violations(c, rows, body) {
  const out = [], l = body.ledger, text = body.answer || '';
  if (!l) return ['question-over-refusal'];
  const exact = rows.filter(r => c.kind !== 'amount' || r.cents === c.amount);
  const positive = l.found === true || l.match_count > 0 || l.total_minor > 0;
  if (c.kind === 'amount') {
    if (positive !== Boolean(exact.length)) out.push('wrong-figure');
    if (positive && exact.some(r => !(body.citations || []).some(x => x.posted_on === r.date && String(x.amount_minor) === r.cents && x.account_mask === '1234'))) out.push('missing-row-identity');
    if (!exact.length && !/no (?:row|matching (?:deposit|transaction)).*(?:amount)/i.test(text)) out.push('amount-absence-wording');
    for (const r of rows.filter(r => r.cents !== c.amount && BigInt(r.cents) - BigInt(c.amount) <= 100n && BigInt(c.amount) - BigInt(r.cents) <= 100n)) {
      if (!text.includes(formatMinor(r.cents)) || !/possible|near|different amount/i.test(text)) { out.push('near-miss-not-offered'); break; }
    }
  } else {
    const gold = total(rows.filter(r => r.payer === c.payer).map(r => r.cents));
    // Annual income includes citations for uncertain deposits as review evidence.
    // Only the group's attributed citations support the payer's subtotal.
    const refs = l.groups?.flatMap(g => g.citations || []);
    const matchedCitations = refs ? (body.citations || []).filter(x => refs.includes(x.n)) : body.citations || [];
    if (!positive && BigInt(gold) > 0n && rows.some(r => r.payer === c.payer && !r.shorthand)) out.push('answer-over-refusal');
    if (positive && total(matchedCitations.map(x => String(x.amount_minor))) !== gold) out.push('wrong-figure');
    if (positive && matchedCitations.some(x => !rows.some(r => r.payer === c.payer && String(x.amount_minor) === r.cents))) out.push('wrong-figure');
    if ((l.total_minor ?? l.attributed_subtotal_minor) != null && String(l.total_minor ?? l.attributed_subtotal_minor) !== gold) out.push('wrong-figure');
    if (rows.some(r => r.shorthand) && (l.found === false || l.total_minor === 0)) out.push('shorthand-absence');
    if (positive && rows.some(r => r.shorthand) && !rows.filter(r => r.shorthand).every(r => text.includes(r.text) && /assum|may be|might be|possibly|unconfirmed/i.test(text))) out.push('shorthand-positive-without-note');
  }
  return [...new Set(out)];
}

test('seeded payer shorthand finder: every failure has a reproducible minimal row witness', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t), groups = new Map(), witnesses = [];
  const stats = { cases: 0, wrong_figures: 0, groups: 0, over_refusals: 0, answered: 0 };
  async function run(c, rows, grammar = false) {
    f.raw('DELETE FROM fin_transactions');
    rows.forEach((r, i) => f.add(`generated-${i}`, r.text, r.shorthand ? null : r.payer, { date: r.date, cents: Number(r.cents) }));
    const parsed = grammar ? classifyLedgerQuestion(c.question, { now, timeZone: 'UTC' }) : structuredClone(c.intent);
    if (!parsed?.kind) return {};
    return (await withParsedLedgerAnswer({ env: f.env, question: c.question, now, grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => Response.json({}), parsed)).json();
  }
  for (const seed of seeds) {
    const rng = random(seed);
    for (let i = 0; i < 160; i++) {
      const payer = ['Acme', 'Northwind', 'Cedar', 'Harbor'][rng() % 4];
      const amount = String(10000 + rng() % 900000), delta = 1 + rng() % 100;
      const mode = i % 8, kind = mode >= 5 ? 'amount' : mode === 4 && Math.floor(i / 8) % 2 ? 'year' : i % 2 ? 'year' : 'month';
      const text = [payer.toUpperCase() + ' PAYMENT', 'ACH CREDIT ' + payer.toUpperCase() + ' CO', payer.slice(0, 3).toUpperCase(), 'PROCESSOR CREDIT', payer][mode % 5];
      const shorthand = mode < 4;
      const rows = [{ text, payer, shorthand, date: shift((rng() % 7) - 3), cents: mode === 6 ? String(BigInt(amount) + BigInt(delta)) : amount },
        { text: 'Birch', payer: 'Birch', shorthand: false, date: shift(0), cents: mode === 7 || mode === 4 ? amount : String(BigInt(amount) - BigInt(delta)) }];
      const question = kind === 'amount' ? `Did a payment of ${formatMinor(amount)} come in around 2026-09-15?` : kind === 'month' ? `Did ${payer} pay me in September 2026?` : `How much did ${payer} send me this year?`;
      const c = { seed, i, kind, payer, amount, question, intent: { broad: true, timeZone: 'UTC', mask: null, accountKind: null, kind: 'payment', direction: 'inflow', counterpartyWords: kind === 'amount' ? [] : [payer.toLowerCase()], amountMinor: kind === 'amount' ? Number(amount) : null, from: kind === 'year' ? '2026-01-01' : kind === 'amount' ? '2026-09-08' : '2026-09-01', to: kind === 'year' ? '2026-10-12' : kind === 'amount' ? '2026-09-22' : '2026-09-30', ...(kind === 'amount' ? { nearDate: '2026-09-15' } : {}) } };
      if (kind === 'year') c.intent = { ...c.intent, kind: 'merchant', match: payer, matchType: 'merchant' };
      if (kind === 'amount') c.intent = classifyLedgerQuestion(question, { now, timeZone: 'UTC' });
      const body = await run(c, rows), errors = violations(c, rows, body);
      stats.cases++; if (body.ledger) stats.answered++;
      // Also exercise the grammar on the owner's literal wording. The explicit
      // payment intent above isolates answer behavior when grammar refuses.
      const grammarBody = await run(c, rows, true);
      if (!grammarBody.ledger) { errors.push('question-over-refusal'); stats.over_refusals++; }
      if (errors.includes('answer-over-refusal')) stats.over_refusals++;
      if (errors.some(e => ['wrong-figure', 'shorthand-positive-without-note', 'shorthand-absence'].includes(e))) stats.wrong_figures++;
      for (const key of new Set(errors)) {
        let minimal = rows;
        const reproduces = async candidate => key === 'question-over-refusal' ? !(await run(c, candidate, true)).ledger : violations(c, candidate, await run(c, candidate)).includes(key);
        // Exhaust all subsets (at most two rows), then minimize positive cents.
        for (const candidate of [[], [rows[0]], [rows[1]], rows]) if (await reproduces(candidate)) { minimal = candidate; break; }
        const penny = minimal.map(r => ({ ...r, cents: '1' }));
        if (await reproduces(penny)) minimal = penny;
        if (key === 'near-miss-not-offered') {
          const adjacent = minimal.map(r => ({ ...r, cents: String(BigInt(c.amount) + 1n), date: shift(0) }));
          if (await reproduces(adjacent)) minimal = adjacent;
        }
        assert.ok(await reproduces(minimal), JSON.stringify({key, c, minimal, body: await run(c, minimal)}));
        for (let j = 0; j < minimal.length; j++) assert.equal(await reproduces(minimal.filter((_, k) => k !== j)), false, key + ' witness must be row-minimal');
        witnesses.push({ key, seed, case: i, question, rows: minimal });
        const g = groups.get(key) || { key, location: locations[key], count: 0, example: witnesses.at(-1) };
        g.count++; groups.set(key, g);
      }
    }
  }
  stats.groups = groups.size;
  const report = { ...stats, groups: [...groups.values()], witnesses };
  writeFileSync(join(tmpdir(), 'payer-shorthand-findings.json'), JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify({ ...stats, groups: report.groups.map(({ key, count }) => ({ key, count })) }));
  assert.equal(stats.cases, 640);
  assert.equal(witnesses.length, [...groups.values()].reduce((n, g) => n + g.count, 0));
  assert.equal(stats.answered, 640, 'total refusal mutant must fail');
  assert.equal(groups.get('answer-over-refusal')?.count || 0, 0, 'explicit payer positives must answer');
  assert.equal(groups.get('wrong-figure')?.count || 0, 0, 'wrong arithmetic or row membership');
  assert.equal(groups.get('shorthand-absence')?.count || 0, 0, 'shorthand cannot prove absence');
  // Finder inventory is intentionally reviewable even when the product is red.
  // Strict mode is the repair gate; discovered unsafe figures remain blockers.
  if (process.env.PAYER_STRICT === '1') assert.equal(witnesses.length, 0, 'payer contract failures');
});

test('contract probes kill wrong-cent, shorthand absence, missing note, near-match and refusal mutants', () => {
  const row = { payer: 'Acme', text: 'ACME PAYMENT', shorthand: true, date: shift(0), cents: '12345' };
  const payer = { kind: 'month', payer: 'Acme' };
  for (const [body, key] of [
    [{ ledger: { found: true, total_minor: 12346 } }, 'wrong-figure'],
    [{ ledger: { found: false } }, 'shorthand-absence'],
    [{ ledger: { found: true }, answer: 'Found ACME PAYMENT' }, 'shorthand-positive-without-note'],
    [{}, 'question-over-refusal'],
  ]) assert.ok(violations(payer, [row], body).includes(key), key);
  assert.ok(violations({ kind: 'amount', amount: '12344' }, [row], { ledger: { found: true }, answer: 'Found $123.45' }).includes('wrong-figure'));
  assert.deepEqual(violations(payer, [row], { ledger: { found: true }, citations: [{ amount_minor: 12345 }], answer: 'Assuming ACME PAYMENT is Acme.' }), []);
});




// Isolated generated-run mutations; never touch product files or Git.
test('generated run kills wrong-cent and total-refusal mutations', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'payer-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = readFileSync(new URL(import.meta.url), 'utf8').split('// Isolated generated-run mutations')[0];
  for (const [name, mutation, expected] of [
    ['wrong-cent', 'if (result.ledger) result.ledger.total_minor = 1;', /wrong arithmetic or row membership/],
    ['total-refusal', 'return {};', /total refusal mutant must fail/],
  ]) {
    let copy = original.replace('return (await withParsedLedgerAnswer', 'const result = await (await withParsedLedgerAnswer')
      .replace('parsed)).json();', `parsed)).json(); ${mutation} return result;`)
      .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, import.meta.url).href}${q}`)
      .replaceAll('import.meta.url', JSON.stringify(import.meta.url))
      .replace("'payer-shorthand-findings.json'", JSON.stringify(name + '-findings.json'));
    const path = join(dir, name + '.mjs'); writeFileSync(path, copy);
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const r = spawnSync(process.execPath, ['--test', path], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 4000000 });
    assert.equal(r.status, 1, name + ' must turn generated run red');
    assert.match(r.stdout + r.stderr, expected);
  }
});
