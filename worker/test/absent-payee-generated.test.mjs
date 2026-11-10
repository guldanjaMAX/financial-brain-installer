import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerFixture, NOW } from './ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../src/lib/ledger-answer.js';
import { displayFigures, total } from '../../eval/fast-loop/money-oracle.mjs';
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from '../../scripts/run-test-chain.mjs';

const seeds = [0x1106, 0x427, 0xc0ffee, 0x5eed];
function random(seed) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; }; }
const questions = v => [`How much did I spend at ${v} last month?`, `Did I ever pay ${v}?`, `What do I pay ${v} each month?`];
const locations = {
  refusal: 'worker/src/lib/ledger-question.js:496',
  absence: 'worker/src/lib/ledger-answer.js:1105',
  suggestions: 'worker/src/lib/ledger-answer.js:1106',
  figure: 'worker/src/lib/ledger-answer.js:1335',
};
// Finder contracts deliberately separate product defects from harness failures.
// Every defect must have a reproduced minimal transaction witness and a group.
export function score(c, body) {
  const text = body.answer || '', ledger = body.ledger;
  const expected = total(c.rows.filter(r => r.payee === c.vendor &&
    (c.questionIndex !== 0 || r.date >= '2026-09-01' && r.date <= '2026-09-30')).map(r => String(r.cents)));
  const issues = [];
  if (expected === '0' && (displayFigures(text).length || ledger?.total_minor != null)) issues.push('figure');
  if (!text || !ledger) return [...issues, 'refusal'];
  // No dollar figure is justified for an absent exact payee. A partial flag
  // does not make a fabricated zero or a near-name subtotal correct.
  if (expected === '0' && (!/no charges found/i.test(text) || !text.includes(c.vendor) ||
    !/1234/.test(text) || c.coverage === 'complete' && !/5678/.test(text) || !/September|2026-09/.test(text) || !/30/.test(text))) issues.push('absence');
  if (c.rows.some(r => r.payee !== c.vendor) && ledger.closest_payees?.length && !/possible matches/i.test(text)) issues.push('suggestions');
  if (ledger.complete === true && c.coverage !== 'complete' && /\$0(?:\.00)?\b/.test(text)) issues.push('figure');
  return [...new Set(issues)];
}

test('600 seeded absent-payee controls are minimized and grouped through the real SQLite ledger', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  let modelCalls = 0;
  f.env.AI = { async run() { modelCalls++; assert.fail('model forbidden'); } };
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('second-account','owner','checking','asset','5678','manual','owner_stated','confirmed',?)`, NOW);
  async function run(c) {
    f.raw('DELETE FROM fin_transactions');
    f.raw("DELETE FROM fin_account_coverage WHERE account_slug='second-account'");
    if (c.coverage !== 'no-feed') f.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('second-account','complete',?,'2026-10-12',?,'owner_stated','confirmed',?)`,
      c.coverage === 'gap' ? '2026-09-16' : '2024-01-01', NOW, NOW);
    for (const [i, r] of c.rows.entries()) f.add(`row-${i}`, r.payee, r.payee, { date: r.date, cents: r.cents, direction: 'outflow' });
    const response = await withLedgerAnswer({ env: f.env, question: questions(c.vendor)[c.questionIndex], now: Date.parse(NOW),
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, async gap => Response.json({ gaps: [gap] }));
    return response.json();
  }
  const groups = new Map(), witnesses = [];
  let cases = 0, wrong_figures = 0, over_refusals = 0;
  for (const seed of seeds) {
    const rng = random(seed);
    for (let i = 0; i < 150; i++) {
      const vendor = ['Cedar Market', 'Maple Supply', 'River Shop', 'Amber Service'][rng() % 4];
      const near = [vendor.slice(0, -1) + 'x', vendor + 'place', vendor.split(' ')[0] + ' Tools'][Math.floor(i / 9) % 3];
      const c = { seed, index: i, vendor, questionIndex: i % 3, coverage: ['complete', 'gap', 'no-feed'][Math.floor(i / 3) % 3], rows: [
        { payee: near, date: '2026-09-15', cents: 1 + rng() % 99999 },
        { payee: 'Other Store', date: '2026-09-20', cents: 1 + rng() % 99999 },
        ...(i % 2 === 0 && i % 3 === 0 ? [{ payee: vendor, date: '2026-08-15', cents: 1 + rng() % 99999 }] : []),
      ] };
      const body = await run(c), issues = score(c, body); cases++;
      if (issues.includes('figure')) wrong_figures++;
      if (issues.includes('refusal')) over_refusals++;
      for (const issue of issues) {
        // Exhaust all transaction subsets by cardinality: unlike greedy deletion,
        // this proves the minimum even for non-monotone matching decisions.
        let minimal;
        const subsets = Array.from({ length: 1 << c.rows.length }, (_, mask) => c.rows.filter((_, j) => mask & 1 << j)).sort((a,b) => a.length-b.length);
        for (const rows of subsets) if (score({ ...c, rows }, await run({ ...c, rows })).includes(issue)) { minimal = rows; break; }
        const shrunk = { ...c, rows: minimal.map(r => ({ ...r, cents: 1 })) };
        if (!score(shrunk, await run(shrunk)).includes(issue)) shrunk.rows = minimal;
        assert.ok(score(shrunk, await run(shrunk)).includes(issue), 'minimal witness reproduces');
        witnesses.push({ ...shrunk, issue });
        const g = groups.get(issue) || { issue, location: locations[issue], count: 0, example: shrunk };
        g.count++; groups.set(issue, g);
      }
    }
  }
  const report = { cases, wrong_figures, over_refusals, groups: [...groups.values()], witnesses };
  writeFileSync(join(tmpdir(), 'absent-payee-findings.json'), JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify({ cases, wrong_figures, over_refusals, groups: [...groups.values()].map(({issue,count,location}) => ({issue,count,location})) }));
  assert.equal(modelCalls, 0, 'no model router calls');
  assert.equal(globalThis.fetch.mock.callCount(), 0, 'no network calls');
  assert.equal(cases, 600);
  assert.equal(witnesses.length, [...groups.values()].reduce((n,g) => n + g.count, 0));
  assert.equal(wrong_figures, 0, 'wrong figures are blockers');
  assert.deepEqual([...groups.keys()].filter(issue => issue !== 'refusal'), [], 'absence copy and suggestions must pass');
  if (process.env.ABSENT_PAYEE_STRICT === '1') assert.equal(over_refusals, 0, 'strict mode requires supported intent forms');
  assert.ok(over_refusals <= 400, 'total refusal cannot pass the finder');
});

test('finder registration and oracle mutation controls', () => {
  const command = 'node --test worker/test/absent-payee-generated.test.mjs';
  assert.ok(TEST_COMMANDS.includes(command)); assert.ok(POST_LAUNCHER_TEST_COMMANDS.includes(command));
  const c = { vendor: 'Cedar Market', questionIndex: 0, coverage: 'gap', rows: [] };
  const good = { answer: 'No charges found for Cedar Market in September 1 through September 30, 2026 on covered account 1234.', ledger: { complete: false } };
  assert.deepEqual(score(c, good), []);
  assert.ok(score(c, { ...good, answer: good.answer + ' $0.00' }).includes('figure'));
  assert.ok(score(c, {}).includes('refusal'));
  assert.ok(score(c, { answer: '$12.00' }).includes('figure'));
  assert.ok(score(c, { ...good, ledger: { total_minor: 1 } }).includes('figure'));
  assert.ok(score({ ...c, rows: [{ payee: 'Cedar Markets', date: '2026-09-15', cents: 1200 }] },
    { ...good, answer: good.answer + ' $12.00', ledger: { closest_payees: ['Cedar Markets'] } }).includes('figure'));
  assert.ok(score(c, { ...good, answer: 'No charges found for Cedar Market.' }).includes('absence'));
});

// Isolated child copies prove the generator, shrinking, and accounting turn red
// together. Copies and outputs stay in system temp; product files never change.
test('generated finder kills total refusal, zero, near-name subtotal, and omitted-group mutants', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'absent-payee-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL(import.meta.url), 'utf8').split('// Isolated child copies')[0];
  for (const [name, from, to, reason] of [
    ['total refusal', 'return response.json();', 'await response.json(); return {};', /total refusal cannot pass the finder/],
    ['zero', 'return response.json();', 'const body = await response.json(); if(body.ledger) body.answer += " $0.00"; return body;', /wrong figures are blockers/],
    ['near-name subtotal', 'return response.json();', 'const body = await response.json(); if(body.ledger) body.answer += " $12.00"; return body;', /wrong figures are blockers/],
    ['omitted refusal group', 'g.count++; groups.set(issue, g);', 'if(issue !== "refusal") { g.count++; groups.set(issue, g); }', /400 !== 0/],
  ]) {
    assert.ok(source.includes(from));
    const copy = source.replace(from, to)
      .replace("join(tmpdir(), 'absent-payee-findings.json')", JSON.stringify(join(dir, name + '.json')))
      .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from ${q}${new URL(p, import.meta.url).href}${q}`);
    const path = join(dir, name + '.mjs'); writeFileSync(path, copy);
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const result = spawnSync(process.execPath, ['--test', path], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 4000000 });
    assert.equal(result.status, 1, name + ' must turn red');
    assert.match(result.stdout, reason, name + ' must fail its contract, not crash');
  }
});
