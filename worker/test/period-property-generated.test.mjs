import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { validateLedgerIntentDecision } from '../src/lib/ledger-intent.js';
import { total } from '../../eval/fast-loop/money-oracle.mjs';

// Export only the existing private reader in memory: no copied implementation,
// product edits, model router, network, or oracle-derived product intent.
const answerURL = new URL('../src/lib/ledger-answer.js', import.meta.url);
const source = readFileSync(answerURL, 'utf8')
  .replace('async function withParsedLedgerAnswer(', 'export async function withParsedLedgerAnswer(')
  .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, quote, path) => `from ${quote}${new URL(path, answerURL).href}${quote}`);
const { withParsedLedgerAnswer } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const DAY = 86400000;
const day = n => new Date(n).toISOString().slice(0, 10);
const shift = (d, n) => day(Date.parse(d) + n * DAY);
const months = 'January February March April May June July August September October November December'.split(' ');
const seeds = [0x4217, 0xc0ffee, 0x95ab18, 0x427f03];
const clocks = ['2026-01-01T06:30:00Z', '2026-03-01T07:30:00Z',
  '2026-03-08T06:30:00Z', '2026-03-08T07:30:00Z',
  '2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'];
function random(seed) { return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; }; }
function ownerDay(now, timeZone) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function scenarios(today, rng) {
  const y = Number(today.slice(0, 4)), m = Math.floor(rng() * 12), year = y - 1;
  const from = day(Date.UTC(year, m, 1)), to = day(Date.UTC(year, m + 1, 0));
  const q = Math.floor(m / 3) + 1, qfrom = day(Date.UTC(year, (q - 1) * 3, 1)), qto = day(Date.UTC(year, q * 3, 0));
  const n = 1 + Math.floor(rng() * 90);
  const current = `${today.slice(0, 7)}-01`;
  const previousEnd = shift(current, -1), previousStart = `${previousEnd.slice(0, 7)}-01`;
  return [
    ...[`${months[m]} ${year}`, `${months[m].slice(0, 3)} ${year}`,
      `${months[m]} '${String(year).slice(2)}`, `${months[m]} ’${String(year).slice(2)}`,
      `${months[m].slice(0, 3)} '${String(year).slice(2)}`, `${months[m].slice(0, 3)} ’${String(year).slice(2)}`,
      `${months[m]} '${year}`, `${months[m]} ’${year}`]
      .map(text => ({ family: 'named-month', text: `in ${text}`, from, to, equivalent: `in ${months[m]} ${year}` })),
    ...[`Q${q} ${year}`, `${['first', 'second', 'third', 'fourth'][q - 1]} quarter ${year}`, `Q${q} '${String(year).slice(2)}`, `Q${q} ’${String(year).slice(2)}`]
      .map(text => ({ family: 'quarter', text: `in ${text}`, from: qfrom, to: qto, equivalent: `in Q${q} ${year}` })),
    { family: 'range', text: `from ${from} through ${to}`, from, to, equivalent: `between ${from} and ${to}` },
    { family: 'range', text: `between ${months[m]} 1, ${year} and ${months[m]} ${to.slice(8)}, ${year}`, from, to, equivalent: `from ${from} through ${to}` },
    { family: 'rolling', text: `in the last ${n} days`, from: shift(today, 1 - n), to: today, equivalent: `in the past ${n} days` },
    { family: 'since', text: `since ${months[m]} ${year}`, from, to: today, equivalent: `since ${from}` },
    { family: 'since', text: `since ${months[m].slice(0, 3)} '${String(year).slice(2)}`, from, to: today, equivalent: `since ${from}` },
    ...['January', 'Jan'].map(text => ({ family: 'since', text: `since ${text}`,
      from: `${y}-01-01`, to: today, equivalent: `since ${y}-01-01` })),
    { family: 'relative', text: 'this month', from: current, to: today, equivalent: 'month to date' },
    { family: 'relative', text: 'last month', from: previousStart, to: previousEnd, equivalent: 'previous month' },
    { family: 'relative', text: 'today', from: today, to: today, equivalent: `from ${today} through ${today}` },
    { family: 'relative', text: 'yesterday', from: shift(today, -1), to: shift(today, -1), equivalent: `since ${shift(today, -1)} until ${shift(today, -1)}` },
    { family: 'relative', text: 'last year', from: `${year}-01-01`, to: `${year}-12-31`, equivalent: `in ${year}` },
    ...['for the opening nine days of', 'for the first nine days of', 'for the initial nine days of'].map(prefix => ({ family: 'subset-prefix', text: `${prefix} October ${year}`, from: `${year}-10-01`, to: `${year}-10-09`, equivalent: `from ${year}-10-01 through ${year}-10-09`, mayRefuse: true })),
    ...['for its opening nine days only', 'for its first nine days only', 'for its initial nine days only'].map(suffix => ({ family: 'subset-suffix', text: `in October ${year} ${suffix}`, from: `${year}-10-01`, to: `${year}-10-09`, equivalent: `from ${year}-10-01 through ${year}-10-09`, mayRefuse: true })),
    ...['only at the end', 'at its end', 'only at the very end'].map(suffix => ({ family: 'end-restriction', text: `in October ${year} ${suffix}`, from: `${year}-10-31`, to: `${year}-10-31`, equivalent: `from ${year}-10-31 through ${year}-10-31`, mayRefuse: true })),
    { family: 'malformed', text: `on ${year}-02-30`, invalid: true },
    { family: 'malformed', text: 'in Q5 2025', invalid: true },
    { family: 'malformed', text: 'in the last 0 days', invalid: true },
    { family: 'future', text: `in January ${y + 1}`, invalid: true },
    { family: 'future', text: `since January ${y + 1}`, invalid: true },
  ];
}
const raw = { ambiguous: false, unanswered_part: null, intents: [{ kind: 'totals', direction: 'inflow', count: null,
  vendor_text: null, account_hint: null, amount_text: null, date_text: null, period: { type: 'none' } }] };
const questionFor = (text, prefix = 'How much money came in ') => `${prefix}${text}?`.replace(/\bin in /, 'in ');
function rootCause(c, result) {
  if (result.status === 'refused') return c.route === 'grammar'
    ? ['grammar-unsupported-period', 'worker/src/lib/ledger-question.js:68', 'Unsupported period leaves lexical residue; grammar refuses.']
    : result.reason === 'period_contradiction'
      ? ['partial-year-consumption', 'worker/src/lib/ledger-intent.js:173', 'Quoted year is left outside the parsed month/quarter; contradiction veto may refuse it.']
      : ['local-unsupported-period', 'worker/src/lib/ledger-intent.js:399', 'Local reader refuses the period.'];
  if (c.route === 'grammar') return ['future-start-admitted', 'worker/src/lib/ledger-question.js:78', 'Fixed explicit month may begin after the owner day.'];
  if (result.defaulted) return ['unconsumed-date-default', 'worker/src/lib/ledger-intent.js:776', 'Unrecognized temporal operand reaches current-month default.'];
  if (c.family === 'relative') return ['since-ignores-range-end', 'worker/src/lib/ledger-intent.js:163', 'Since prefix resolves before trailing until endpoint.'];
  return ['partial-year-consumption', 'worker/src/lib/ledger-intent.js:173', 'Month/quarter prefix resolves without consuming quoted year.'];
}

test('seeded period properties through real ledger readers; all discovered failures are minimized and grouped', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = ledgerFixture(t);
  f.raw("UPDATE fin_account_coverage SET covered_from='2020-01-01', covered_to='2030-12-31'");
  const groups = new Map(), witnesses = [];
  const stats = { cases: 0, wrong_figures: 0, ignored_dates: 0, over_refusals: 0, metamorphic: 0, answered: 0, safe_refusals: 0, shrunk: 0 };
  async function run(c, rows, text = c.text) {
    const question = questionFor(text, c.prefix);
    const context = { now: c.now, timeZone: c.timeZone };
    const decision = c.route === 'local' ? validateLedgerIntentDecision(raw, question, context) : null;
    const intent = c.route === 'grammar' ? classifyLedgerQuestion(question, context) : decision.intents?.[0];
    if (!intent?.kind) return { status: 'refused', reason: decision?.reason || 'grammar-residue' };
    f.raw('DELETE FROM fin_transactions');
    rows.forEach((r, i) => f.add(`row-${i}`, 'Recorded deposit', null, { date: r.date, cents: Number(r.cents) }));
    f.env.BRAIN_TIMEZONE = c.timeZone;
    f.raw('UPDATE bank_feed_items SET last_synced_at=?', new Date(c.now).toISOString());
    const response = await withParsedLedgerAnswer({ env: f.env, question, now: c.now,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, async () => Response.json({}), intent);
    const body = await response.json();
    const ledger = body.ledger;
    const amount = ledger?.combined_inflow_minor ?? ledger?.lead_accounts?.reduce((n, a) => n + a.credits_minor, 0)
      ?? ledger?.accounts?.reduce((n, a) => n + a.credits_minor, 0);
    if (amount == null) return { status: 'refused' };
    assert.ok(Number.isSafeInteger(amount), 'reader exposes integer cents');
    const expected = c.invalid ? null : total(rows.filter(r => r.date >= c.from && r.date <= (c.to < ownerDay(c.now, c.timeZone) ? c.to : ownerDay(c.now, c.timeZone))).map(r => r.cents));
    assert.equal(String(amount), expected, 'wrong figures are blockers, including partial evidence');
    // A coincidentally equal amount cannot hide the local parser's explicit
    // default label after a date operand was left unconsumed.
    const ignored = c.route === 'local' && intent.periodLabel === 'this month' &&
      /\bsince\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b|\bq\d|\b\d{4}\b/i.test(text);
    const periodMismatch = !c.invalid && (ledger.from !== c.from || ledger.to !== c.to);
    return { status: c.invalid || String(amount) !== expected ? 'wrong' : ignored || periodMismatch ? 'ignored' : 'correct', amount: String(amount), expected, period_mismatch: periodMismatch,
      actual_period: [ledger.from, ledger.to], defaulted: Boolean(intent.defaultedPeriod || intent.periodLabel === 'this month') };
  }
  async function shrink(c, input, targetStatus) {
    // Single-row deletion to a fixed point is 1-minimal. Nonnegative additive
    // totals then permit exhaustive cardinality-0/1 proof of a global minimum.
    let rows = input;
    for (let i = 0; i < rows.length;) {
      const candidate = rows.filter((_, j) => i !== j);
      if ((await run(c, candidate)).status === targetStatus) { rows = candidate; i = 0; } else i++;
    }
    for (const candidate of [[], ...input.map(r => [r])]) {
      if (candidate.length < rows.length && (await run(c, candidate)).status === targetStatus) rows = candidate;
    }
    for (let i = 0; i < rows.length; i++) {
      const candidate = rows.map((r, j) => j === i ? { ...r, cents: '1' } : r);
      if ((await run(c, candidate)).status === targetStatus) rows = candidate;
    }
    // Preserve the temporal operand and money-in meaning while minimizing
    // framing. A different refusal reason is a different counterexample.
    const original = await run(c, rows);
    for (const prefix of ['Inflow ', 'Money in ']) {
      const candidate = { ...c, prefix }, result = await run(candidate, rows);
      if (result.status === targetStatus && rootCause(candidate, result)[0] === rootCause(c, original)[0]) { c = candidate; break; }
    }
    assert.equal((await run(c, rows)).status, targetStatus, 'shrunk witness reproduces');
    for (let i = 0; i < rows.length; i++) assert.notEqual((await run(c, rows.filter((_, j) => i !== j))).status, targetStatus);
    return { rows, ...(await run(c, rows)), prefix: c.prefix, minimal_rows: rows.length <= 1, question: questionFor(c.text, c.prefix) };
  }
  for (const seed of seeds) for (const clock of clocks) for (const timeZone of ['America/Phoenix', 'America/New_York']) {
    const rng = random(seed ^ Date.parse(clock)), now = Date.parse(clock), today = ownerDay(now, timeZone);
    for (const scenario of scenarios(today, rng).filter(c => c.family === 'end-restriction' ? seed === 0x427f03 : c.family.startsWith('subset-') ? seed === 0x95ab18 : ![0x95ab18, 0x427f03].includes(seed))) for (const route of ['grammar', 'local']) {
      const base = { ...scenario, seed, now, timeZone, route };
      const dates = new Set([today, `${today.slice(0, 7)}-01`, shift(today, -1), `${Number(today.slice(0, 4)) - 1}-01-01`]);
      if (!base.invalid) for (const d of [base.from, base.to, shift(base.from, -1), shift(base.to, 1)]) dates.add(d);
      // Dense monthly decoys reveal a silently substituted current-year month.
      for (let month = 0; month < 12; month++) dates.add(day(Date.UTC(Number(today.slice(0, 4)), month, 1)));
      const rows = [...dates].map(date => ({ date, cents: String(1 + Math.floor(rng() * 99999)) }));
      const original = await run(base, rows);
      const equivalent = base.equivalent ? await run(base, rows, base.equivalent) : null;
      if (base.mayRefuse && base.route === 'local') assert.equal(equivalent.status, 'correct', 'answerable periods must answer: subset numeric peer');
      if (equivalent && original.status !== 'refused' && equivalent.status !== 'refused' && original.amount !== equivalent.amount) stats.metamorphic++;
      for (const text of new Set([base.text, ...(base.equivalent ? [base.equivalent] : [])])) {
      const c = { ...base, text };
      const result = await run(c, rows); stats.cases++;
      if (result.status === 'wrong' || result.status === 'ignored') {
        if (result.status === 'wrong') stats.wrong_figures++; else stats.ignored_dates++;
        stats.shrunk++;
        const witness = await shrink(c, rows, result.status);
        const [key, location, cause] = rootCause(c, result);
        witnesses.push({ ...c, ...witness, key });
        const group = groups.get(key) || { key, location, cause, count: 0, wrong_figures: 0, ignored_dates: 0, over_refusals: 0, example: { ...c, ...witness } };
        if (result.status === 'wrong') group.wrong_figures++; else group.ignored_dates++;
        group.count++; groups.set(key, group);
      } else if (result.status === 'refused') {
        if (c.invalid || c.mayRefuse) stats.safe_refusals++; else stats.over_refusals++;
        const [key, location, cause] = c.invalid || c.mayRefuse ? ['safe-refusal'] : rootCause(c, result);
        if (!c.invalid && !c.mayRefuse) {
          assert.equal((await run(c, [])).status, 'refused', 'refusal reproduces with minimal empty ledger');
          let prefix;
          for (const candidate of ['Inflow ', 'Money in ']) {
            const smaller = await run({ ...c, prefix: candidate }, []);
            if (smaller.status === 'refused' && smaller.reason === result.reason) { prefix = candidate; break; }
          }
          witnesses.push({ ...c, key, rows: [], prefix, minimal_rows: true, question: questionFor(c.text, prefix), reason: result.reason });
        }
        const group = groups.get(key) || { key, location, cause, count: 0, wrong_figures: 0, ignored_dates: 0, over_refusals: 0, example: { ...c, rows: [], question: questionFor(c.text), reason: result.reason } };
        if (!c.invalid && !c.mayRefuse) group.over_refusals++;
        group.count++; groups.set(key, group);
      } else stats.answered++;
      }
    }
  }
  const report = { ...stats, groups: [...groups.values()].filter(g => g.key !== 'safe-refusal'), witnesses };
  for (const key of ['wrong_figures', 'ignored_dates', 'over_refusals']) assert.equal(report.groups.reduce((n, g) => n + g[key], 0), stats[key], `all ${key} grouped`);
  // Only synthetic witnesses are written, under the unmodified system temp.
  writeFileSync(join(tmpdir(), 'period-property-findings.json'), JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify({ ...stats, groups: report.groups.map(({ key, count }) => ({ key, count })) }));
  assert.ok(stats.cases >= 500);
  assert.ok(stats.answered >= 1600, 'answerable periods must answer');
  assert.ok(stats.over_refusals < 766, 'refusal ceiling must hold');
  assert.ok(witnesses.every(w => w.minimal_rows), 'every failure has a globally minimal zero/one-row witness');
  assert.equal(witnesses.length, stats.wrong_figures + stats.ignored_dates + stats.over_refusals);
  assert.equal(stats.shrunk, stats.wrong_figures + stats.ignored_dates);
  assert.equal(stats.wrong_figures, 0, 'wrong figures are blockers; see system-temp period-property-findings.json');
  assert.equal(stats.ignored_dates, 0, 'explicit date text cannot silently reach a labeled default');
  assert.equal(stats.metamorphic, 0, 'equivalent spellings must agree when both answer');
});

// Oracle mutation checks use isolated test copies under system temp.
test('generated oracle kills total refusal and wrong partial cent mutants', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'brain-period-oracle-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = readFileSync(new URL(import.meta.url), 'utf8').split('// Oracle mutation checks')[0];
  for (const [name, mutation] of [
    ['total refusal', 'const body = { evidence_gate: { complete: false } };'],
    ['wrong partial cent', 'const body = await response.json(); if (body.ledger) { body.evidence_gate = { complete: false }; for (const a of body.ledger.lead_accounts || body.ledger.accounts || []) a.credits_minor += 1; if (body.ledger.combined_inflow_minor != null) body.ledger.combined_inflow_minor += 1; }'],
  ]) {
    const copy = original.replace('const body = await response.json();', mutation)
      .replace("join(tmpdir(), 'period-property-findings.json')", JSON.stringify(join(dir, name.replaceAll(' ', '-') + '-findings.json')))
      .replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, path) => 'from ' + q + new URL(path, import.meta.url).href + q)
      .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
    const path = join(dir, name.replaceAll(' ', '-') + '.mjs');
    writeFileSync(path, copy);
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const result = spawnSync(process.execPath, ['--test', path], { env, encoding: 'utf8', timeout: 120000, maxBuffer: 4000000 });
    assert.equal(result.status, 1, name + ' must turn the generated test red: ' + result.stdout.slice(-1500));
    assert.match(result.stdout, name === 'total refusal' ? /answerable periods must answer|refusal ceiling/ : /wrong.*figures/);
  }
});
