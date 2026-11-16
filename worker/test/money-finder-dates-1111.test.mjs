import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';

// The default is a zero-violation gate. MONEY_FINDER_DISCOVERY=1 explicitly
// collects existing failures without presenting that run as a release pass.
// No model interprets dates here: the stub supplies only activity, never dates.
const day = n => new Date(n).toISOString().slice(0, 10);
const shift = (d, n) => day(Date.parse(d) + n * 86400000);
const month = (y, m) => [day(Date.UTC(y, m, 1)), day(Date.UTC(y, m + 1, 0))];
const names = 'January February March April May June July August September October November December'.split(' ');
function ownerDay(now, timeZone) {
  const fields = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now)).map(p => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function scenarios(today) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7) - 1;
  const current = month(y, m), prev = month(y, m - 1), historical = month(y - 1, 9);
  const monday = shift(today, -((new Date(`${today}T00:00Z`).getUTCDay() + 6) % 7));
  const pair = (text, from, to) => ({ text, ranges: [[from, to > today ? today : to]] });
  return [
    pair('this month', current[0], today), pair('this month so far', current[0], today),
    pair('last month', ...prev), pair('previous month', ...prev),
    pair('this year', `${y}-01-01`, today), pair('year to date', `${y}-01-01`, today),
    pair('last year', `${y - 1}-01-01`, `${y - 1}-12-31`),
    pair('today', today, today), pair('yesterday', shift(today, -1), shift(today, -1)),
    pair('this week', monday, today), pair('last week', shift(monday, -7), shift(monday, -1)),
    pair('last 7 days', shift(today, -6), today), pair('past 30 days', shift(today, -29), today),
    pair(`October ${y - 1}`, ...historical), pair(`Oct ${y - 1}`, ...historical),
    pair(`Q3 ${y - 1}`, `${y - 1}-07-01`, `${y - 1}-09-30`),
    pair(`since October ${y - 1}`, historical[0], today),
    pair(`since ${prev[0]}`, prev[0], today),
    pair(`from ${historical[0]} through ${historical[1]}`, ...historical),
    pair(`before ${current[0]}`, '2024-01-01', shift(current[0], -1)),
    pair(`since Monday`, monday, today), pair('on Monday', monday, monday),
    pair(`October ${y - 1} before the 8th`, historical[0], `${y - 1}-10-07`),
    pair(`October ${y - 1} on weekdays only`, ...historical),
    pair('last moth', ...prev), pair('this yer', `${y}-01-01`, today),
    pair('since last month', prev[0], today),
    { text: 'next month', ranges: [month(y, m + 1)] },
    pair('last quarter', month(y, Math.floor(m / 3) * 3 - 3)[0], month(y, Math.floor(m / 3) * 3 - 1)[1]),
    { text: `August ${y - 1}, September ${y - 1} and October ${y - 1}, month by month`,
      ranges: [7, 8, 9].map(m => month(y - 1, m)) },
  ];
}
const frames = [
  ['how much money came in PERIOD, by payer', 'totals'],
  ['what were my expenses PERIOD', 'expense_summary'],
  ['did i spend anything PERIOD', 'expense_summary'],
  ['how much did we pay PERIOD', 'expense_summary'],
  ['money in by payer PERIOD', 'totals'],
  ['what were my expenses PERIOD and can you list them out', 'expense_summary'],
];
const clocks = ['2026-01-01T06:30:00Z', '2026-01-01T08:30:00Z',
  '2026-03-01T06:30:00Z', '2026-03-01T08:30:00Z',
  '2026-11-01T05:30:00Z', '2026-11-01T08:30:00Z',
  '2026-12-31T23:30:00Z', '2027-01-01T06:30:00Z', '2027-01-01T08:30:00Z',
  '2028-03-01T06:30:00Z'];
const voices = ['hi, ', 'hello, ', 'hey, ', 'quick question: ', 'a quick question: ',
  'one question: ', 'I wanted to ask: ', 'I want to know: ', 'I need to know: ',
  'I am trying to check: ', 'I am checking something: ', 'can you help me check: ',
  'could you help me check: ', 'can you tell me: ', 'could you tell me: ',
  'please tell me: ', 'please check for me: ', 'for my review: ',
  'for a quick review: ', 'I have a question: '];
// Keep the supplied first five questions byte-for-byte. No private identities.
const founder = [
  ['how much money am i going to make this month assuming all paying clients pay', 'totals'],
  ['what were my expenses last month and how many of them were personal vs buisness and can you list them out', 'expense_summary'],
  ['who paid me in October', 'totals'],
  ['how much money came in this month so far, by payer', 'totals'],
  ['money in by payer for August, September and October, month by month', 'totals'],
  ['what are my top 5 vendors this year', 'largest'],
  ['did i spend anything on ads last month', 'expense_summary'],
  ['is there anything showing as pending', 'transactions'],
  ['how much did i put toward the loan', 'expense_summary'],
];
function parts(body) { return body.ledger?.parts || (body.ledger ? [body.ledger] : []); }
function amount(p, kind) {
  return kind === 'totals' ? p.combined_inflow_minor ?? p.accounts?.reduce((n, a) => n + a.credits_minor, 0)
    : p.expense_total_minor ?? p.total_minor;
}
function statedReading(body, actual, today) {
  // The packet explicitly permits a different range when the answer states
  // its reading. Accept the owner's visible best-reading line, independently
  // checking the calendar month and any noncurrent year for each endpoint.
  const line = body.answer?.split('\n').find(s => /best reading of your question:/i.test(s));
  return Boolean(line && actual.every(([a, b]) => {
    if (![a, b].every(d => line.includes(names[+d.slice(5, 7) - 1]) &&
      (d.slice(0, 4) === today?.slice(0, 4) || line.includes(d.slice(0, 4))))) return false;
    const wholeMonths = a.endsWith('-01') && shift(b, 1).endsWith('-01');
    if (wholeMonths) return true;
    if (a === b) return line.includes(`${names[+a.slice(5, 7) - 1]} ${+a.slice(8)}`);
    if (a.slice(0, 7) === b.slice(0, 7)) return new RegExp(`\\b${names[+a.slice(5, 7) - 1]} ${+a.slice(8)} (?:to|through) ${+b.slice(8)}\\b`).test(line);
    return [a, b].every(d => line.includes(`${names[+d.slice(5, 7) - 1]} ${+d.slice(8)}`));
  }));
}
function inspect(c, body, rows) {
  const p = parts(body);
  if (!p.length || !p.some(p => Number.isSafeInteger(amount(p, c.kind)))) return 'refusal';
  if (c.ranges) {
    const actual = p.map(p => [p.from, p.to]);
    if (!actual.every(([a, b]) => /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b))) return 'missing-period';
    for (const part of c.periodOnly ? [] : p) {
      const sum = rows.filter(r => r.date >= part.from && r.date <= part.to && r.direction === (c.kind === 'totals' ? 'inflow' : 'outflow')).reduce((n, r) => n + r.cents, 0);
      if (amount(part, c.kind) !== sum) {
        // All generated rows belong to account 1111. Distinguish selecting
        // another account from arithmetic over the selected account's rows.
        if (part.accounts?.length && !part.accounts.some(a => a.account_mask === '1111')) return 'requested-scope-loss';
        return 'wrong-figure';
      }
    }
    if (JSON.stringify(actual) !== JSON.stringify(c.ranges)) {
      const unused = p.flatMap(p => p.unused_calendar_limits || []);
      if ((!unused.length || !unused.every(w => body.answer?.includes(`I did not narrow it by '${w}'`))) &&
          !statedReading(body, actual, c.today)) return 'undisclosed-period';
    }
    if (/weekdays only/.test(c.question) && !p.some(p => p.unused_calendar_limits?.length)) return 'undisclosed-period';
  }
  return null;
}

test('money date finder: all violations retained with independently replayed minimal ledgers', async t => {
  const f = setup(t), violations = [], counts = {}, groups = new Map(), uniqueQuestions = new Set();
  f.raw("UPDATE fin_account_coverage SET covered_from='2024-01-01',covered_to='2029-12-31'");
  let cases = 0, answered = 0, disclosedReadings = 0;
  async function run(c, rows) {
    f.env.BRAIN_TIMEZONE = c.timeZone;
    f.raw('DELETE FROM fin_transactions');
    for (const r of rows) f.add('main', r.date, r.cents, r.direction, 'Synthetic payment', 'Test Unit');
    const reply = raw(intent(c.kind, c.kind === 'largest' ? { count: 5 } : {}));
    const result = await ask(f, c.question, reply, undefined, { now: Date.parse(c.now) });
    const issue = inspect(c, result.body, rows);
    return { issue, actual: parts(result.body).map(p => ({ from: p.from, to: p.to, minor: amount(p, c.kind) })),
      answer: result.body.answer, gaps: result.body.gaps, documents: result.documents };
  }
  async function check(c) {
    uniqueQuestions.add(c.question);
    const dates = new Set([c.today, shift(c.today, -1), `${c.today.slice(0, 7)}-01`]);
    for (const [a, b] of c.ranges || []) for (const d of [shift(a, -1), a, b, shift(b, 1)]) if (d >= '2024-01-01' && d <= c.today) dates.add(d);
    // Distinct bits make every date/direction subset total unique; equal
    // credits and debits must not conceal a wrong period or direction.
    const rows = [...dates].sort().flatMap((date, i) => ['inflow', 'outflow'].map((direction, j) => ({ date, cents: 2 ** (2 * i + j), direction })));
    const result = await run(c, rows); cases++;
    if (!result.issue) {
      answered++;
      if (c.ranges && JSON.stringify(result.actual.map(p => [p.from, p.to])) !== JSON.stringify(c.ranges)) disclosedReadings++;
      return;
    }
    counts[result.issue] = (counts[result.issue] || 0) + 1;
    const key = `${result.issue}:${c.family}:${c.kind}`;
    const relevant = sample => sample.some(r => r.direction === (c.kind === 'totals' ? 'inflow' : 'outflow') &&
      (!c.ranges || c.ranges.some(([a, b]) => r.date >= a && r.date <= b)));
    // Future questions have no completed evidence by definition. Every other
    // refusal keeps a row in the requested period and direction, when present.
    const preservesEvidence = sample => relevant(rows) ? relevant(sample) : sample.length > 0;
    // Minimize one witness per family, then independently replay it for EVERY
    // member. One-cent nonempty evidence distinguishes refusal from no data.
    let minimal = groups.get(key)?.rows;
    if (!minimal || !preservesEvidence(minimal) || (await run(c, minimal)).issue !== result.issue) {
      minimal = rows;
      for (let i = 0; i < minimal.length;) {
        const candidate = minimal.filter((_, j) => i !== j);
        if (preservesEvidence(candidate) && (await run(c, candidate)).issue === result.issue) minimal = candidate;
        else i++;
      }
      const cents = minimal.map(r => ({ ...r, cents: 1 }));
      if ((await run(c, cents)).issue === result.issue) minimal = cents;
    }
    const replay = await run(c, minimal);
    assert.equal(replay.issue, result.issue, 'each retained reproduction replays');
    for (let i = 0; i < minimal.length; i++) if (preservesEvidence(minimal.filter((_, j) => i !== j))) {
      assert.notEqual((await run(c, minimal.filter((_, j) => i !== j))).issue, result.issue, 'row-deletion minimal');
    }
    groups.set(key, { rows: minimal });
    violations.push({ ...c, issue: result.issue, rows: minimal, ...replay });
  }
  let voice = 0;
  for (const now of clocks) for (const timeZone of ['America/Phoenix', 'America/New_York']) {
    const today = ownerDay(now, timeZone);
    const prefix = voices[voice++];
    for (const scenario of scenarios(today)) for (const [frame, kind] of frames) {
      const phrase = /^(?:October|Oct |Q3|August)/.test(scenario.text) ? `during ${scenario.text}`
        : /^(?:last|past) \d+ days$/.test(scenario.text) ? `over the ${scenario.text}` : scenario.text;
      const wording = scenario.text === 'next month' ? frame.replace('came in', 'will come in')
        .replace('what were my expenses', 'what will my expenses be').replace('did i spend', 'will i spend')
        .replace('how much did we pay', 'how much will we pay') : frame;
      await check({ now, timeZone, today, kind, family: scenario.text,
        question: prefix + wording.replace('PERIOD', phrase), ranges: scenario.ranges });
    }
  }
  const founderRanges = [ [['2026-11-01', '2026-11-11']], [month(2026, 9)], [month(2026, 9)],
    [['2026-11-01', '2026-11-11']], [7, 8, 9].map(m => month(2026, m)),
    [['2026-01-01', '2026-11-11']], [month(2026, 9)] ];
  // The supplemental activity questions score dates and refusals, without
  // pretending this period oracle also certifies advertising or loan filters.
  for (const [i, [question, kind]] of founder.entries()) await check({ question, kind, family: 'founder-verbatim',
    ranges: founderRanges[i], periodOnly: i >= 5, now: '2026-11-11T12:00:00Z', timeZone: 'America/Phoenix', today: '2026-11-11' });
  const dir = mkdtempSync(join(tmpdir(), 'money-finder-dates-1111-'));
  const report = { cases, uniqueQuestions: uniqueQuestions.size, answered, disclosedReadings, violations: violations.length, counts, witnesses: violations };
  writeFileSync(join(dir, 'findings.json'), JSON.stringify(report, null, 2));
  if (process.env.MONEY_FINDER_SAVE === '1') writeFileSync(new URL('./fixtures/money-finder-dates-1111-findings.json', import.meta.url),
    JSON.stringify({ cases, uniqueQuestions: uniqueQuestions.size, answered, disclosedReadings, violations: violations.length, counts,
      witnesses: violations.map(({ answer, gaps, documents, ...w }) => w) }, null, 2) + '\n');
  t.diagnostic(`cases=${cases} unique_questions=${uniqueQuestions.size} violations=${violations.length} disclosed=${disclosedReadings} counts=${JSON.stringify(counts)} findings=${join(dir, 'findings.json')}`);
  assert.ok(cases >= 3000);
  assert.ok(uniqueQuestions.size >= 3000, 'thousands of distinct natural questions, independently of clock replay');
  assert.equal(answered + violations.length, cases);
  assert.equal(violations.length, Object.values(counts).reduce((n, v) => n + v, 0));
  assert.ok(answered > 0, 'finder actually reached money answers');
  if (process.env.MONEY_FINDER_DISCOVERY !== '1') assert.equal(violations.length, 0, 'zero-refusal / no-silent-period gate');
});

test('finder kills refusal, wrong-cent, scope-loss, silent-period and disclosure-removal mutants', () => {
  const c = { kind: 'expense_summary', question: 'expenses last month before the 8th', ranges: [['2026-10-01', '2026-10-07']] };
  const rows = [{ date: '2026-10-05', cents: 111, direction: 'outflow' }, { date: '2026-10-15', cents: 222, direction: 'outflow' }];
  const good = { ledger: { from: '2026-10-01', to: '2026-10-07', total_minor: 111 } };
  assert.equal(inspect(c, good, rows), null);
  assert.equal(inspect(c, { answer: 'Please clarify' }, rows), 'refusal');
  assert.equal(inspect(c, { ledger: { ...good.ledger, total_minor: 112 } }, rows), 'wrong-figure');
  assert.equal(inspect(c, { ledger: { ...good.ledger, total_minor: 0, accounts: [{ account_mask: '4444' }] } }, rows), 'requested-scope-loss');
  const broad = { from: '2026-10-01', to: '2026-10-31', total_minor: 333 };
  assert.equal(inspect(c, { ledger: broad }, rows), 'undisclosed-period');
  const disclosed = { ledger: { ...broad, unused_calendar_limits: ['before the 8th'] }, answer: "I did not narrow it by 'before the 8th'" };
  assert.equal(inspect(c, disclosed, rows), null);
  assert.equal(inspect(c, { ...disclosed, answer: '' }, rows), 'undisclosed-period');
  assert.equal(inspect(c, { ...good, answer: "Here's my best reading of your question: October" }, rows), null);
  assert.equal(statedReading({ answer: "Here's my best reading of your question: October" }, [['2026-10-02', '2026-10-07']], '2026-11-11'), false);
});

test('real SQLite answer agrees with the independent cents oracle', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.raw("UPDATE fin_account_coverage SET covered_to='2029-12-31'");
  const rows = [{ date: '2026-11-02', cents: 111, direction: 'inflow' }];
  f.add('main', rows[0].date, rows[0].cents, rows[0].direction, 'Synthetic payment', 'Test Unit');
  const c = { kind: 'totals', question: 'how much money came in this month so far, by payer',
    today: '2026-11-03', ranges: [['2026-11-01', '2026-11-03']] };
  let api;
  const variant = process.env.MONEY_FINDER_PRODUCT_MUTANT;
  if (variant) {
    const url = new URL('../src/lib/ledger-answer.js', import.meta.url);
    let source = readFileSync(url, 'utf8');
    const changes = {
      refusal: ['export async function withLedgerAnswer(options, next) {',
        "export async function withLedgerAnswer(options, next) { return Response.json({answer:'Please clarify'});"],
      cents: ['const combined = sumMinor(totals, account => account.credits_minor);',
        'const combined = 1 + sumMinor(totals, account => account.credits_minor);'],
    };
    assert.ok(changes[variant], 'only named local product mutants');
    const [from, to] = changes[variant];
    assert.ok(source.includes(from), 'real product mutation applied');
    source = source.replace(from, to).replace(/from (['"])(\.\.?\/[^'"]+)\1/g,
      (_, q, p) => `from ${q}${new URL(p, url).href}${q}`);
    api = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).withLedgerAnswer;
  }
  const r = await ask(f, c.question, raw(intent('totals')), api);
  assert.equal(inspect(c, r.body, rows), null, 'real money answer must satisfy the finder');
});

// Mutation runner: each isolated changed finder must actually turn a test red.
test('five isolated detector mutants each fail the detector contract', t => {
  const dir = mkdtempSync(join(tmpdir(), 'money-dates-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL(import.meta.url), 'utf8').split('// Mutation runner:')[0]
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, q, p) => `from ${q}${new URL(p, import.meta.url).href}${q}`);
  for (const [name, from, to] of [
    ['refusal', "return 'refusal'", 'return null'],
    ['wrong-cent', "return 'wrong-figure'", 'return null'],
    ['scope-selection', "return 'requested-scope-loss'", 'return null'],
    ['silent-period', "return 'undisclosed-period'", 'return null'],
    ['disclosure-removal', "body.answer?.includes(`I did not narrow it by '${w}'`)", 'true'],
  ]) {
    assert.ok(source.includes(from), `${name} mutation applied`);
    const path = join(dir, `${name}.mjs`);
    writeFileSync(path, source.replaceAll(from, to));
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=^finder kills', path],
      { env, encoding: 'utf8', timeout: 30000, maxBuffer: 100000 });
    assert.equal(r.status, 1, `${name} must turn detector contract red: ${r.stdout} ${r.stderr}`);
    assert.match(r.stdout, /AssertionError|ERR_ASSERTION|Expected values/);
  }
});

test('two real product mutants turn the SQLite answer control red', t => {
  const dir = mkdtempSync(join(tmpdir(), 'money-dates-product-mutants-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL(import.meta.url), 'utf8').split('// Mutation runner:')[0]
    .replace(/from (['"])(\.\.?\/[^'"]+)\1/g, (_, q, p) => `from ${q}${new URL(p, import.meta.url).href}${q}`)
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const path = join(dir, 'product-control.mjs');
  writeFileSync(path, source);
  for (const [variant, issue] of [['refusal', 'refusal'], ['cents', 'wrong-figure']]) {
    const env = Object.fromEntries(['SystemRoot', 'TEMP', 'TMP', 'PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    env.MONEY_FINDER_PRODUCT_MUTANT = variant;
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=^real SQLite', path],
      { env, encoding: 'utf8', timeout: 30000, maxBuffer: 200000 });
    assert.equal(r.status, 1, `${variant} must turn real answer control red: ${r.stdout} ${r.stderr}`);
    assert.ok(r.stdout.includes(issue), `${variant} reached the expected finder decision: ${r.stdout}`);
    assert.match(r.stdout, /ERR_ASSERTION|AssertionError/);
  }
});
