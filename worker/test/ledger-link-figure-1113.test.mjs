import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, account, transaction, NOW } from './fixtures/money-fix/fixture.mjs';
import { maintainAccountLink } from '../src/lib/fin-account-links.js';
import worker from '../src/index.js';

test('owner answer retains an observed source figure when same-account approval is missing', async t => {
  t.mock.method(Date, 'now', () => Date.parse(NOW));
  t.mock.method(globalThis, 'fetch', () => assert.fail('network forbidden'));
  const f = fixture();
  t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual' });
  account(f);
  transaction(f, { uid: 'manual-credit', slug: 'manual-account' });
  transaction(f);
  f.env.ADMIN_KEY = randomBytes(32).toString('hex');
  f.env.STORAGE_BACKEND = 'd1';
  const args = { manualSlug: 'manual-account', liveSlug: 'live-account', now: NOW };
  const maintain = async unlink => {
    const options = { ...args, unlink };
    const plan = await maintainAccountLink(f.env, options);
    assert.equal(plan.blocked, false);
    return maintainAccountLink(f.env, { ...options, dryRun: false, approve: plan.plan_hash });
  };
  const ask = async () => {
    const response = await worker.fetch(new Request('https://brain.invalid/api/rag/think', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
      body: JSON.stringify({ q: 'How much money came in September 2026?' }),
    }), f.env, {});
    assert.equal(response.status, 200);
    return response.json();
  };
  await maintain(false);
  const green = await ask();
  assert.equal(green.ledger.accounts[0].credits_minor, 123450);
  assert.match(green.answer, /1,234\.50/);
  await maintain(true);
  const start = f.seen.length;
  const actual = await ask();
  assert.ok(f.seen.slice(start).some(sql => sql.includes('FROM fin_accounts')), 'same-account review decision reached');
  assert.equal(actual.code, 'ledger_account_link_required');
  assert.equal(actual.confidence.percent, 0);
  assert.match(actual.answer, /^\$1,234\.50/);
  assert.match(actual.answer, /possible duplicate|may be counted twice/i);
  assert.doesNotMatch(actual.answer, /withheld|cannot|can't/i);
  assert.match(actual.confidence_text, /Confidence: Low \(0%\).*Why:.*Missing:/s);
  assert.equal(actual.ledger.source_readings.length, 2);
  assert.deepEqual(actual.ledger.source_readings.map(row => row.amount_minor), [123450, 123450]);
  assert.equal(actual.ledger.complete, false);
  assert.match(actual.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  assert.match(actual.answer, /1,234\.50/, 'founder ANSWERED requires an observed source figure, with the possible duplicate explained');
});
