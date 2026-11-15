import test from 'node:test';
import { unusedReading } from './date-word-review-fixture.mjs';
import assert from 'node:assert/strict';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { localLedgerWindow } from '../src/lib/ledger-intent.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 0.4.28 date-word parsing consumes a known opening-day bound rather than showing a broader month.
function openingReading(r,year,amount=0) {
  assert.equal(r.extraction,1);assert.equal(r.documents,0);
  assert.ok(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),'bounded transaction decision reached');
  assert.deepEqual([r.body.ledger.from,r.body.ledger.to],[year+'-10-01',year+'-10-09']);
  assert.equal(r.body.ledger.total_minor??r.body.ledger.expense_total_minor,amount);
  assert.ok(!(r.body.ledger.unused_calendar_limits||[]).some(v=>/opening|first.*nine/.test(v)));
}

// 0.4.28 vague end dates either reach the calendar clarification or a disclosed full-month reading.
function endReading(r,question) {
  assert.equal(r.extraction,1,'calendar decision reached');assert.equal(r.documents,0);
  assert.equal(r.body.evidence_gate.complete,false);
  if(question.startsWith('Only')) {
    assert.ok(r.sql.some(sql=>sql.includes('CROSS JOIN fin_transactions')),'broader reading reached its rows');
    assert.equal(r.body.ledger.total_minor,9137);
    assert.deepEqual([r.body.ledger.from,r.body.ledger.to],['2025-10-01','2025-10-31']);
    assert.match(r.body.answer,/Time restriction not applied:.*no end cutoff was inferred/);
    assert.ok(r.body.gaps.some(g=>g.type==='filter_not_applied'));
  } else {
    assert.equal(r.sql.length,0,'an unresolved cutoff cannot authorize a full-period read');
    assert.equal(r.body.ledger,undefined);
    assert.ok(r.body.gaps.some(g=>g.scope==='calendar'&&g.reason==='period_contradiction'));
  }
}

test('future month is a labeled estimate even with future feed coverage', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  for (const q of ['Money in January 2027?', 'Show expenses January 2027']) {
    const r = await ask(f, q, raw(intent()));
    assert.match(r.body.answer, /Projection: about/i);
    assert.equal(r.body.ledger.projection, true);
    assert.equal(r.body.ledger.complete, false);
    assert.equal(r.body.evidence_gate.complete, false);
    assert.equal(r.body.evidence_gate?.complete ?? false, false);
  }
});

test('partial future month and quarter read only through owner today', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  f.add('main', '2026-11-02', 731, 'inflow');
  f.add('main', '2026-11-04', 99999, 'inflow');
  for (const q of ['Money in November 2026?', 'Money in Q4 2026?', 'Show deposits November 2026',
    'Show deposits Q4', 'Show deposits in 2026']) {
    const r = await ask(f, q, raw(intent('totals')));
    assert.equal(r.body.ledger.to, '2026-11-03', q);
    assert.equal(r.body.ledger.complete, false, q);
    assert.equal(r.body.ledger.coverage?.complete, false, q);
    assert.match(r.body.answer, /partial.*through/i, q);
    assert.ok(!r.body.answer.includes('999.99'), q);
  }
});

test('future admission uses the owner day across UTC midnight', async t => {
  const f = setup(t);
  f.env.BRAIN_TIMEZONE = 'America/Phoenix';
  const r = await ask(f, 'Money in January 2026?', raw(intent()), undefined,
    { now: Date.parse('2026-01-01T06:30:00Z') });
  assert.match(r.body.answer, /Projection: about/i);
  assert.equal(r.body.evidence_gate?.complete ?? false, false);
});

test('explicit day ranges and since periods retain their future boundary', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  for (const q of ['Show expenses from 2026-11-01 to 2026-11-30',
    'Show expenses between November 1 and November 30']) {
    const r = await ask(f, q, raw(intent()));
    assert.equal(r.body.ledger.to, '2026-11-03');
    assert.equal(r.body.ledger.complete, false);
    assert.match(r.body.answer, /partial.*through/i);
  }
  const future = await ask(f, 'Show expenses since January 2027', raw(intent()));
  assert.match(future.body.answer, /Projection: about/i);
  assert.equal(future.body.evidence_gate.complete, false);
});

test('an unavailable owner zone cannot certify an explicit future period', async t => {
  const f = setup(t);
  delete f.env.BRAIN_TIMEZONE;
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  const r = await ask(f, 'Money in January 2027?', raw(intent()));
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
});

test('a current weekend is partial and a future weekend is a projection', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  const future = await ask(f, 'Show deposits this weekend', raw(intent('totals')));
  assert.match(future.body.answer, /Projection: about/i);
  assert.equal(future.body.evidence_gate.complete, false);
  const partial = await ask(f, 'Show deposits this weekend', raw(intent('totals')), undefined,
    { now: Date.parse('2026-11-07T12:00:00Z') });
  assert.equal(partial.body.ledger.to, '2026-11-07');
  assert.equal(partial.body.ledger.complete, false);
  assert.match(partial.body.answer, /partial.*through/i);
});

const restrictions = ['only in its latter half', 'for days 1-9 only', 'on business days only',
  'limited to its opening nine days', 'only in its first half', 'during its closing ten days',
  'on weekends only', 'except its tenth day', 'restricted to a fortnight', 'with a custom cutoff'];
for (const tail of restrictions) test(`D1 discloses the unused restriction: ${tail}`, async t => {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Daily Cash' WHERE account_slug='main'");
  const peer = await ask(f, 'Show Daily Cash spending from October 16 to October 31', raw(intent('expense_summary', { account_hint: 'Daily Cash' })));
  assert.equal(peer.body.ledger.total_minor, 0);
  const r = await ask(f, `Show Daily Cash spending Oct 2026 ${tail}`, raw(intent('expense_summary', { account_hint: 'Daily Cash' })));
  if(tail==='limited to its opening nine days') openingReading(r,'2026');
  else unusedReading(r, 1200);
});

test('D1 also discloses a restriction before the calendar operand', async t => {
  const f = setup(t);
  const r = await ask(f, 'Show expenses during its closing ten days in Oct 2026', raw(intent()));
  unusedReading(r, 1700);
});

async function scratchModule(t, file, transform = s => s, links = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-period-mutant-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = new URL(`../src/lib/${file}`, import.meta.url);
  const source = transform(readFileSync(url, 'utf8')).replace(/from (["'])(\.\.?\/[^"']+)\1/g,
    (_, quote, path) => `from ${quote}${links[path] || new URL(path, url).href}${quote}`);
  const path = join(dir, file.replace('.js', '.mjs'));
  writeFileSync(path, source);
  const href = pathToFileURL(path).href;
  return { href, api: await import(href) };
}

for (const name of ['future month answered complete', 'partial-future window marked complete', 'D1 regression']) {
  test(`mutant killed: ${name}`, async t => {
    const f = setup(t);
    f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
    let answer;
    if (name === 'D1 regression') {
      const calendar = await scratchModule(t, 'ledger-intent-calendar.js', s => {
        const before = 'for (const m of text.matchAll(restriction)) {';
        assert.equal(s.split(before).length - 1, 1);
        return s.replace(before, 'for (const m of []) {');
      });
      const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
      answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
    } else if (name.startsWith('future')) {
      const activity = await scratchModule(t, 'ledger-activity-reading.js', s => s.replaceAll('complete: false', 'complete: true'));
      answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-activity-reading.js': activity.href });
    } else {
      const before = name.startsWith('future')
        ? "intent.kind !== 'balance' && ownerTime && intent.from > ownerTime.day"
        : 'if (intent.partialFuturePeriod)';
      answer = await scratchModule(t, 'ledger-answer.js', s => {
        assert.equal(s.split(before).length - 1, 1);
        const restored = s.replace(before, name.startsWith('future') ? 'false' : 'if (false)');
        // Restore the original fixed future window as well as its admission;
        // retaining the clamp would test a different, partial-zero defect.
        return name.startsWith('future') ? restored.replace(
          "intent.kind !== 'balance' && ownerTime && requestedTo > ownerTime.day", 'false') : restored;
      });
    }
    const q = name === 'D1 regression' ? 'Show expenses Oct 2026 only in its latter half'
      : name.startsWith('future') ? 'Money in January 2027?' : 'Money in November 2026?';
    const oracle = r => {
      if (name.startsWith('partial')) {
        assert.equal(r.body.ledger.complete, false);
        assert.equal(r.body.ledger.coverage.complete, false);
        assert.match(r.body.answer, /partial.*through/i);
      } else if (name === 'D1 regression') {
        unusedReading(r, 1700, 'latter half');
      } else {
        assert.equal(r.body.ledger.projection, true);
        assert.equal(r.body.ledger.complete, false);
        assert.equal(r.body.evidence_gate.complete, false);
        assert.match(r.body.answer, /Projection: about/);
      }
    };
    oracle(await ask(f, q, raw(intent())));
    const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
    assert.ok(bad.sql.some(s => s.includes('CROSS JOIN fin_transactions')), 'restored defect reaches real facts');
    if (name === 'D1 regression') assert.equal(bad.body.ledger.total_minor, 1700, 'the unrequested whole-month figure survives');
    else assert.equal(bad.body.evidence_gate.complete, true, 'the mutant actually certifies the requested future part');
    if (name.startsWith('future')) {
      assert.deepEqual([bad.body.ledger.from, bad.body.ledger.to], ['2027-01-01', '2027-01-31']);
      assert.equal(bad.body.ledger.total_minor, 0);
    }
    assert.throws(() => oracle(bad), assert.AssertionError, name);
  });
}

for (const [phrase, from, to] of [
  ['since 2026-01-01', '2026-01-01', '2026-11-03'],
  ['month to date', '2026-11-01', '2026-11-03'],
  ['since Jan', '2026-01-01', '2026-11-03'],
  ['since January', '2026-01-01', '2026-11-03'],
  ['previous month', '2026-10-01', '2026-10-31'],
]) test(`closed grammar alias: ${phrase}`, () => {
  const q = `How much money came in ${phrase}?`;
  const p = classifyLedgerQuestion(q, { now: Date.parse('2026-11-03T12:00:00Z'), timeZone: 'UTC' });
  assert.equal(p.kind, 'totals');
  assert.deepEqual([p.from, p.to], [from, to]);
  assert.equal(classifyLedgerQuestion(`${q.slice(0, -1)} only in its latter half?`).kind, null);
  const local = localLedgerWindow(q, '2026-11-03', true);
  assert.equal(local.invalid, undefined);
  assert.deepEqual(local.consumed.map(([a,b]) => q.slice(a,b)), [phrase]);
});

 test('opening-nine-day prefix discloses its broader reading of the October 10 decoy', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Show expenses from 2025-10-01 through 2025-10-09', raw(intent('expense_summary')));
  assert.equal(peer.body.ledger.total_minor, 0);
  const r = await ask(f, 'Show expenses for the opening nine days of Oct 2025', raw(intent('expense_summary')));
  openingReading(r,'2025');
 });

for (const q of [
  'Show expenses only on alternate days in Oct 2026',
  'For the opening nine days of Oct 2025, show expenses',
  'Show expenses in Oct 2025 for its opening nine days only',
  'Show expenses for the first nine days of Oct 2025',
]) test('complete complement and numeric control: ' + q, async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  f.add('main', '2026-10-10', 9137);
  const year = q.includes('2026') ? '2026' : '2025';
  const peer = await ask(f, 'Show expenses from ' + year + '-10-01 through ' + year + '-10-09', raw(intent()));
  assert.equal(peer.body.ledger.total_minor, 0);
  const full = await ask(f, 'Show expenses from ' + year + '-10-01 through ' + year + '-10-31', raw(intent()));
  assert.equal(full.body.ledger.total_minor ?? full.body.ledger.expense_total_minor, 9137);
  const r = await ask(f, q, raw(intent()));
  if(/opening|first nine/.test(q)) openingReading(r,year);
  else unusedReading(r,9137);
});

test('mutant killed: prefix complement ignored', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const q = 'Show expenses for the opening nine days of Oct 2025';
  const oracle = r => openingReading(r,'2025');
  oracle(await ask(f, q, raw(intent())));
  // 0.4.28 opening-day consumption lives in ledger-intent.js, before calendar leftovers.
  const answer = await scratchModule(t, 'ledger-intent.js', source => {
    const before='if (subset) {';assert.equal(source.split(before).length-1,1);
    return source.replace(before,'if (false && subset) {');
  });
  const reader = await scratchModule(t,'ledger-answer.js',undefined,{'./ledger-intent.js':answer.href});
  const bad = await ask(f, q, raw(intent()), reader.api.withLedgerAnswer);
  assert.equal(bad.body.ledger.total_minor, 9137);
  assert.throws(() => oracle(bad), assert.AssertionError);
});

for (const q of [
  'Show expenses October 2025 only at the end',
  'Only at the end of October 2025, show expenses',
  'Show expenses October 2025 at its end',
]) test('end restriction and numeric control: ' + q, async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Show expenses from 2025-10-31 through 2025-10-31', raw(intent()));
  assert.equal(peer.body.ledger.total_minor, 0);
  const full = await ask(f, 'Show expenses from 2025-10-01 through 2025-10-31', raw(intent()));
  assert.equal(full.body.ledger.total_minor ?? full.body.ledger.expense_total_minor, 9137);
  const r = await ask(f, q, raw(intent()));
  endReading(r,q);
});

test('mutant killed: end restriction admitted as financial prose', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const q = 'Show expenses October 2025 only at the end';
  const oracle = r => endReading(r,q);
  oracle(await ask(f, q, raw(intent())));
  // 0.4.28 the local named-month parser owns the end-cutoff decision.
  const compiler = await scratchModule(t,'ledger-intent.js',source=>{
    const before='if (closing) {';assert.equal(source.split(before).length-1,1);
    return source.replace(before,'if (false && closing) {');
  });
  const answer = await scratchModule(t,'ledger-answer.js',undefined,{'./ledger-intent.js':compiler.href});
  const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
  assert.equal(bad.body.ledger.expense_total_minor, 9137);
  assert.throws(() => oracle(bad), assert.AssertionError);
});

test('complete financial end-up idiom retains its numeric peer', async t => {
  const f = setup(t);
  const r = await ask(f, 'What did we end up paying Store Vendor last month?', raw(intent('merchant', { vendor_text: 'Store Vendor' })));
  assert.equal(r.body.ledger.total_minor, 1700);
});

test('negated calendar interval labels its positive-date reading and kills a restoring mutant', async t => {
  const f = setup(t);
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Could you retrieve expenses in October 2025?', raw(intent()));
  assert.equal(peer.body.ledger.total_minor ?? peer.body.ledger.expense_total_minor, 9137);
  const q = 'Could you retrieve expenses not in October 2025?';
  const oracle = r => {
    unusedReading(r, 9137, 'not in');
  };
  oracle(await ask(f, q, raw(intent())));
  const calendar = await scratchModule(t, 'ledger-intent-calendar.js', s => {
    const before = 'not (?:in|during)';
    assert.equal(s.split(before).length - 1, 1);
    return s.replace(before, 'never-match-this-clause');
  });
  const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
  const answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
  const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
  assert.equal(bad.body.ledger.total_minor ?? bad.body.ledger.expense_total_minor, 9137);
  assert.throws(() => oracle(bad), assert.AssertionError);
  t.diagnostic('restored guard emits 9137 cents and turns the disclosure oracle red');
});

test('direct grammar does not turn a negated month into its positive numeric peer', async t => {
  const f = setup(t);
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Show expenses October 2025', raw(intent()));
  assert.ok(peer.body.citations.some(c => c.amount_minor === 9137));
  const r = await ask(f, 'Show expenses not in October 2025', raw(intent()));
  unusedReading(r, 9137, 'not in');
});
