import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { fixture, NOW } from '../worker/test/fixtures/money-fix/fixture.mjs';
import worker from '../worker/src/index.js';
import { readBankExport } from '../worker/src/lib/bank-export.js';
import { importBankExport } from '../worker/src/lib/fin-import.js';
import { renderCliCommands } from '../operations/cli-guidance.mjs';

const path = '/api/admin/fin/import-bank-export';
globalThis.fetch = async () => { throw new Error('network forbidden'); };
test('F05 real CLI handler reaches authenticated maintenance, rejects stale approval and verifies recovery', async t => {
  const brain = await import('../brain.mjs');
  assert.equal(typeof brain.cmdLedger, 'function', 'real command handler is exported');
  const f = fixture(); t.after(f.close);
  f.env.ADMIN_KEY = randomBytes(32).toString('hex');
  f.env.STORAGE_BACKEND = 'd1';
  const data = readBankExport('Date,Description,Debit,Credit\n2026-09-15,Office supplies,12.00,\n', {
    name: 'synthetic.csv', accountHint: { accountKey: 'owner-checking', accountKind: 'checking' },
  });
  await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW });
  f.raw("UPDATE fin_transactions SET txn_uid=account_slug||':line:legacy:'||id");
  const calls = [], output = [];
  const deps = {
    loadManifest: () => ({ m: { brain: { domain: 'brain.invalid' } } }),
    resolveAdminKey: () => f.env.ADMIN_KEY,
    write: value => output.push(value),
    fetchImpl: async (url, init) => {
      calls.push({ path: new URL(url).pathname, body: JSON.parse(init.body), redirect: init.redirect });
      return worker.fetch(new Request(url, init), f.env, {});
    },
  };
  const args = ['rekey', 'synthetic.manifest.json', '--account', 'owner-checking'];
  const preview = await brain.cmdLedger([...args, '--preview'], deps);
  assert.equal(preview.candidate_count, 1);
  assert.equal(preview.mutation_count, 0);
  assert.deepEqual(calls.map(c => c.path), [path]);
  assert.equal(calls[0].redirect, 'error');
  assert.ok(output.join('\n').includes(renderCliCommands('brain ledger rekey')));
  const before = f.rows('SELECT * FROM fin_transactions');
  const invalid = await worker.fetch(new Request('https://brain.invalid' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rekey', account_slug: 'owner-checking', dry_run: false, approve: preview.plan_hash }),
  }), f.env, {});
  assert.equal(invalid.status, 401);
  await assert.rejects(brain.cmdLedger([...args, '--apply', '--approve', '0'.repeat(64)], deps), /stale|preview/i);
  assert.equal(calls.length, 2, 'stale apply reached the actual route');
  assert.deepEqual(f.rows('SELECT * FROM fin_transactions'), before);
  const done = await brain.cmdLedger([...args, '--apply', '--approve', preview.plan_hash], deps);
  assert.equal(done.mutation_count, 1); assert.equal(done.complete, true);
  assert.equal((await importBankExport(f.env, data, { entitySlug: 'owner-company', now: NOW })).imported, true);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 1);
});

test('ledger recovery commands render through the platform CLI prefix', () => {
  const windows = { platform: 'win32', nodePath: 'C:\\runtime\\node.exe', scriptPath: 'C:\\fixture\\brain.mjs', env: { PATH: '' }, existsSync: () => false };
  assert.equal(renderCliCommands('brain ledger rekey', windows), renderCliCommands('brain setup', windows).replace(/ setup$/, ' ledger rekey'));
});
