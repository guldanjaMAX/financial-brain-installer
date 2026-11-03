import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyPresentation, moneyAccount, moneyAccounts } from '../src/lib/money-format.js';
const clock = { now: '2026-10-12T12:00:00Z', timeZone: 'America/Phoenix' };
const f = moneyPresentation(clock);
for (const [from, to, expected] of [
  ['2023-09-01', '2023-09-30', 'September 2023'],
  ['2026-09-01', '2026-09-30', 'September'],
  ['2026-01-01', '2026-10-31', 'January through October'],
  ['2024-01-01', '2026-10-31', 'January 2024 through October'],
  ['2025-12-20', '2026-01-04', 'December 20, 2025 to January 4'],
  ['2023-09-01', '2023-09-29', 'September 1 to 29, 2023'],
  ['2026-10-12', '2026-10-12', 'October 12'],
  ['2024-02-01', '2024-02-29', 'February 2024'],
  ['2026-02-29', '2026-03-01', 'dates unavailable'],
]) test(`shared calendar format: ${expected}`, () => assert.equal(f.period(from, to), expected));
test('sync uses the owner clock and includes time only on the same local day', () => {
  assert.equal(f.updated('2026-10-12T12:00:00Z'), 'last updated October 12 at 5:00 AM');
  assert.equal(f.updated('2026-10-11T12:00:00Z'), 'last updated October 11');
  assert.equal(f.updated('2025-10-12T12:00:00Z'), 'last updated October 12, 2025');
  assert.equal(f.updated('2026-10-12'), 'last updated October 12', 'a date alone never invents a sync time');
  assert.equal(f.updated(null), 'last update unavailable');
  assert.equal(f.updated('2026-10-12T12:00:00'), 'last update unavailable');
  assert.equal(f.updated('2026-02-30T12:00:00Z'), 'last update unavailable');
});
test('local midnight and year boundary use the owner calendar', () => {
  const west = moneyPresentation({ now: '2027-01-01T00:30:00Z', timeZone: 'America/Phoenix' });
  assert.equal(west.date('2026-12-31'), 'December 31');
  assert.equal(west.updated('2027-01-01T00:00:00Z'), 'last updated December 31 at 5:00 PM');
  const east = moneyPresentation({ now: '2026-12-31T23:30:00Z', timeZone: 'Asia/Tokyo' });
  assert.equal(east.date('2026-12-31'), 'December 31, 2026');
  assert.equal(east.updated('2026-12-31T23:00:00Z'), 'last updated January 1 at 8:00 AM');
  assert.equal(east.date('2027-01-01'), 'January 1', 'bank calendar days do not shift');
});
test('daylight saving time and missing zones never use the host zone', () => {
  const local = moneyPresentation({ now: '2026-11-01T08:00:00Z', timeZone: 'America/New_York' });
  assert.equal(local.updated('2026-11-01T05:30:00Z'), 'last updated November 1 at 1:30 AM');
  assert.equal(local.updated('2026-11-01T06:30:00Z'), 'last updated November 1 at 1:30 AM');
  const unknown = moneyPresentation({ now: clock.now, timeZone: 'Invalid/Zone' });
  assert.equal(unknown.updated(clock.now), 'last update unavailable');
  assert.equal(unknown.date('2026-10-12'), 'October 12, 2026');
  assert.equal(f.date('invalid'), 'date unavailable');
});
test('account wording is shared and never invents an ending', () => {
  assert.equal(moneyAccount(null), 'your account (ending unavailable)');
  assert.equal(moneyAccount({ mask: '1234' }), 'your account ending 1234');
  assert.equal(moneyAccount({ mask: ' 1234 ' }), 'your account (ending unavailable)');
  assert.equal(moneyAccount({ mask: '12345' }), 'your account (ending unavailable)');
  assert.equal(moneyAccount({ mask: '1234', label: 'Operating' }, { label: true }), 'Operating (your account ending 1234)');
  assert.equal(moneyAccounts([{ mask: '1234' }, { mask: '1234' }]), 'your account ending 1234');
  assert.equal(f.history([{ mask: '1234', covered_from: '2024-01-01', covered_to: '2026-10-31', last_synced_at: clock.now }]),
    'Your account ending 1234 has records from January 2024 through October, last updated October 12 at 5:00 AM.');
});

test('many accounts keep the refusal history short and disclose the remainder', () => {
  const accounts = Array.from({ length: 200 }, (_, index) => ({ mask: String(1000 + index),
    covered_from: '2024-01-01', covered_to: '2026-10-31', last_synced_at: clock.now }));
  const text = f.history(accounts);
  assert.ok(text.includes('199 more accounts'));
  assert.ok(text.split(/\s+/).length < 35);
  assert.equal(accounts.length, 200, 'display does not mutate the caller inventory');
});
