import test from 'node:test';
import assert from 'node:assert/strict';
import { ledgerFixture } from './ledger-review-fixture.mjs';
import { readEffectiveAccounts, readEffectiveTransactions } from '../src/lib/ledger-reader.js';

// Seed 20261107 crosses lifecycle uncertainty, both directions and owner zones.
// Pending observations are never completed activity or authority for totals.
test('generated pending observations and completed activity have separate lifecycle admission', async t => {
  const f = ledgerFixture(t);
  let seed = 20261107;
  let cases = 0;
  for (const zone of ['America/Phoenix', 'Pacific/Kiritimati'])
    for (const direction of ['inflow', 'outflow'])
      for (const closed of [null, '2026-99-99', '2026-10-06'])
        for (const day of ['2026-10-03', '2026-10-05', '2026-10-09']) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          const cents = 1 + seed % 99999;
          f.env.BRAIN_TIMEZONE = zone;
          f.raw('DELETE FROM fin_transactions');
          f.add('pending', 'Outside payer', null, { date: day, cents, direction });
          f.raw('UPDATE fin_transactions SET pending=1');
          f.add('posted', 'Outside payer', null, { date: day, cents, direction });
          for (const status of ['open', 'closed']) {
            f.raw("UPDATE fin_accounts SET status=?,opened_on='2026-10-04',closed_on=?", status, status === 'closed' ? closed : null);
            const accounts = await readEffectiveAccounts(f.env);
            assert.equal(accounts[0].members[0].status, status, 'lifecycle decision input reached');
            assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 2, 'both observation and activity exist');
            const options = { from: '2026-10-01', to: '2026-10-12' };
            const before = f.calls.length;
            const pending = await readEffectiveTransactions(f.env, accounts, { ...options, pendingOnly: true });
            assert.ok(f.calls.slice(before).some(sql => sql.includes('t.pending=1')), 'real pending SQL reached');
            assert.equal(pending.length, 1, `pending ${status}/${closed}/${day}`);
            assert.equal(pending[0].amount_minor, cents);
            assert.equal(pending[0].direction, direction);
            if (status === 'closed' && closed !== '2026-10-06') {
              await assert.rejects(readEffectiveTransactions(f.env, accounts, options), /ledger closing date unknown|Invalid time value/);
            } else {
              const before = f.calls.length;
              const posted = await readEffectiveTransactions(f.env, accounts, options);
              assert.ok(f.calls.slice(before).some(sql => sql.includes('t.pending=0')), 'completed activity SQL reached');
              assert.equal(posted.length, Number(day >= '2026-10-04' && (status === 'open' || day <= closed)));
            }
            cases++;
          }
        }
  assert.equal(cases, 72);
  console.log(`LIFECYCLE_TABLE seed=20261107 cases=${cases} green_controls=36`);
});


