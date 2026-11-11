import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, ask, intent, raw } from './c3-calendar-scope-fixture.mjs';
import { classifyLedgerQuestion } from '../src/lib/ledger-question.js';
import { localLedgerWindow } from '../src/lib/ledger-intent.js';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

test('future month has no figure even with coverage extending into the future', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  for (const q of ['Money in January 2027?', 'Show expenses January 2027']) {
    const r = await ask(f, q, raw(intent()));
    assert.match(r.body.answer, /period has not happened yet/i);
    assert.equal(r.body.ledger, undefined);
    assert.equal(r.body.evidence_gate.complete, false);
    assert.equal(r.sql.length, 0);
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
  assert.match(r.body.answer, /period has not happened yet/i);
  assert.equal(r.sql.length, 0);
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
  assert.match(future.body.answer, /period has not happened yet/i);
  assert.equal(future.sql.length, 0);
});

test('an unavailable owner zone cannot certify an explicit future period', async t => {
  const f = setup(t);
  delete f.env.BRAIN_TIMEZONE;
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  const r = await ask(f, 'Money in January 2027?', raw(intent()));
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
});

test('a current weekend is partial and a future weekend has no figure', async t => {
  const f = setup(t);
  f.raw("UPDATE fin_account_coverage SET covered_to='2030-12-31'");
  const future = await ask(f, 'Show deposits this weekend', raw(intent('totals')));
  assert.match(future.body.answer, /period has not happened yet/i);
  assert.equal(future.sql.length, 0);
  const partial = await ask(f, 'Show deposits this weekend', raw(intent('totals')), undefined,
    { now: Date.parse('2026-11-07T12:00:00Z') });
  assert.equal(partial.body.ledger.to, '2026-11-07');
  assert.equal(partial.body.ledger.complete, false);
  assert.match(partial.body.answer, /partial.*through/i);
});

const restrictions = ['only in its latter half', 'for days 1-9 only', 'on business days only',
  'limited to its opening nine days', 'only in its first half', 'during its closing ten days',
  'on weekends only', 'except its tenth day', 'restricted to a fortnight', 'with a custom cutoff'];
for (const tail of restrictions) test(`D1 rejects the entire unread restriction: ${tail}`, async t => {
  const f = setup(t);
  f.raw("UPDATE fin_accounts SET label='Daily Cash' WHERE account_slug='main'");
  const peer = await ask(f, 'Show Daily Cash spending from October 16 to October 31', raw(intent('expense_summary', { account_hint: 'Daily Cash' })));
  assert.equal(peer.body.ledger.total_minor, 0);
  const r = await ask(f, `Show Daily Cash spending Oct 2026 ${tail}`, raw(intent('expense_summary', { account_hint: 'Daily Cash' })));
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
  assert.ok(r.body.gaps.length);
  if (!tail.startsWith('except ')) assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
});

test('D1 also closes a restriction before the calendar operand', async t => {
  const f = setup(t);
  const r = await ask(f, 'Show expenses during its closing ten days in Oct 2026', raw(intent()));
  assert.equal(r.sql.length, 0);
  assert.equal(r.body.ledger, undefined);
  assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
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
        assert.match(s, /A consumed period/);
        return s.replace(/  \/\/ A consumed period[\s\S]*?(?=  \/\/ Convert normalized offsets back)/, '');
      });
      const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
      answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
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
      } else {
        assert.equal(r.body.ledger, undefined);
        assert.equal(r.sql.length, 0);
      }
    };
    oracle(await ask(f, q, raw(intent())));
    const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
    assert.ok(bad.sql.some(s => s.includes('CROSS JOIN fin_transactions')), 'restored defect reaches real facts');
    if (name === 'D1 regression') assert.equal(bad.body.ledger.total_minor, 1700, 'the unrequested whole-month figure survives');
    else assert.equal(bad.body.evidence_gate.complete, true, 'the mutant actually certifies the requested future part');
    if (name.startsWith('future')) {
      assert.deepEqual([bad.body.ledger.from, bad.body.ledger.to], ['2027-01-01', '2027-01-31']);
      assert.equal(bad.body.ledger.lead_accounts.reduce((sum, a) => sum + a.credits_minor, 0), 0);
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

 test('opening-nine-day prefix refuses before emitting the October 10 decoy', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Show expenses from 2025-10-01 through 2025-10-09', raw(intent('expense_summary')));
  assert.equal(peer.body.ledger.total_minor, 0);
  const r = await ask(f, 'Show expenses for the opening nine days of Oct 2025', raw(intent('expense_summary')));
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
  assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
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
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
  assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
});

test('mutant killed: prefix complement ignored', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const q = 'Show expenses for the opening nine days of Oct 2025';
  const oracle = r => { assert.equal(r.body.ledger, undefined); assert.equal(r.sql.length, 0); };
  oracle(await ask(f, q, raw(intent())));
  const calendar = await scratchModule(t, 'ledger-intent-calendar.js', s => {
    const before = 'if (!financialRemainderWords.has(m[0])) unread.push(m);';
    assert.equal(s.split(before).length - 1, 1);
    return s.replace(before, 'if (m.index >= lastEnd && !financialRemainderWords.has(m[0])) unread.push(m);');
  });
  const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
  const answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
  const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
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
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
});

test('mutant killed: end restriction admitted as financial prose', async t => {
  const f = setup(t);
  f.raw('DELETE FROM fin_transactions');
  f.add('main', '2025-10-10', 9137);
  const q = 'Show expenses October 2025 only at the end';
  const oracle = r => { assert.equal(r.body.ledger, undefined); assert.equal(r.sql.length, 0); };
  oracle(await ask(f, q, raw(intent())));
  const calendar = await scratchModule(t, 'ledger-intent-calendar.js', s => {
    assert.equal(s.split('expensive goes').length - 1, 1);
    return s.replace('expensive goes', 'end expensive goes');
  });
  const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
  const answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
  const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
  assert.equal(bad.body.ledger.expense_total_minor, 9137);
  assert.throws(() => oracle(bad), assert.AssertionError);
});

test('complete financial end-up idiom retains its numeric peer', async t => {
  const f = setup(t);
  const r = await ask(f, 'What did we end up paying Store Vendor last month?', raw(intent('merchant', { vendor_text: 'Store Vendor' })));
  assert.equal(r.body.ledger.total_minor, 1700);
});

test('negated calendar interval refuses its numeric decoy and kills a restoring mutant', async t => {
  const f = setup(t);
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Could you retrieve expenses in October 2025?', raw(intent()));
  assert.equal(peer.body.ledger.total_minor ?? peer.body.ledger.expense_total_minor, 9137);
  const q = 'Could you retrieve expenses not in October 2025?';
  const oracle = r => {
    assert.equal(r.body.ledger, undefined);
    assert.equal(r.sql.length, 0);
    assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
  };
  oracle(await ask(f, q, raw(intent())));
  const calendar = await scratchModule(t, 'ledger-intent-calendar.js', s => {
    const before = 'not (?:in|during)|limited';
    assert.equal(s.split(before).length - 1, 1);
    return s.replace(before, 'limited');
  });
  const compiler = await scratchModule(t, 'ledger-intent.js', undefined, { './ledger-intent-calendar.js': calendar.href });
  const answer = await scratchModule(t, 'ledger-answer.js', undefined, { './ledger-intent.js': compiler.href });
  const bad = await ask(f, q, raw(intent()), answer.api.withLedgerAnswer);
  assert.equal(bad.body.ledger.total_minor ?? bad.body.ledger.expense_total_minor, 9137);
  assert.throws(() => oracle(bad), assert.AssertionError);
  t.diagnostic('restored guard emits 9137 cents and turns the no-figure oracle red');
});

test('direct grammar does not turn a negated month into its positive numeric peer', async t => {
  const f = setup(t);
  f.add('main', '2025-10-10', 9137);
  const peer = await ask(f, 'Show expenses October 2025', raw(intent()));
  assert.ok(peer.body.citations.some(c => c.amount_minor === 9137));
  const r = await ask(f, 'Show expenses not in October 2025', raw(intent()));
  assert.equal(r.body.ledger, undefined);
  assert.equal(r.sql.length, 0);
  assert.equal(r.documents, 0);
  assert.ok(r.body.gaps.some(g => g.scope === 'calendar'));
});
