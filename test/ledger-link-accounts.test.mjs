import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture, account, transaction, NOW } from '../worker/test/fixtures/money-fix/fixture.mjs';
import { maintainAccountLink } from '../worker/src/lib/fin-account-links.js';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import worker from '../worker/src/index.js';
import { cmdLedger } from '../brain.mjs';
import { parseLedgerLinkArgs, runLedgerLink } from '../operations/ledger-rekey.mjs';
import { renderCliCommands } from '../operations/cli-guidance.mjs';
import { ApiError, ownerError } from '../frontend/src/lib/api.ts';

import { RECOVERY_DURABLE_TABLES, recoveryExportTables } from '../operations/cloudflare-recovery-adapter.mjs';

const path = '/api/admin/fin/import-bank-export';
const base = ['link-accounts', 'synthetic.manifest.json', '--manual', 'manual-account', '--live', 'live-account'];
let network = 0, processes = 0;
globalThis.fetch = async () => { network++; throw new Error('network forbidden'); };
test.before(() => {
  mock.method(Date, 'now', () => Date.parse(NOW));
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    mock.method(childProcess, name, () => { processes++; throw new Error('host tool forbidden'); });
  }
  syncBuiltinESMExports();
});
test.after(() => { assert.equal(network, 0); assert.equal(processes, 0); mock.restoreAll(); syncBuiltinESMExports(); });
function setup(t) {
  const f = fixture(); t.after(f.close);
  account(f, { slug: 'manual-account', mode: 'manual' }); account(f);
  transaction(f, { uid: 'manual-credit', slug: 'manual-account' }); transaction(f);
  return f;
}
const args = { manualSlug: 'manual-account', liveSlug: 'live-account', now: NOW };
const preview = f => maintainAccountLink(f.env, args);
const apply = (f, plan, extra = {}) => maintainAccountLink(f.env, { ...args, dryRun: false, approve: plan.plan_hash, ...extra });
const ask = f => withLedgerAnswer({ env: f.env, question: 'How much money came in September 2026?',
  grantScope: { all: true }, scopePrincipalKind: 'owner', now: NOW },
async () => { throw new Error('identity refusal must not draft from documents'); }).then(r => r.json());

test('R03 actual CLI: bounded refusal, preview, authentication, approval, replay, unlink and history', async t => {
  const f = setup(t);
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'ledger-link-'))); t.after(() => rmSync(home, { recursive: true, force: true }));
  const keyPath = join(home, 'fixture-admin-key');
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  f.env.ADMIN_KEY = readFileSync(keyPath, 'utf8'); f.env.STORAGE_BACKEND = 'd1';
  const calls = [], output = []; let lose = false, launchCalls = 0;
  const deps = { loadManifest: () => ({ m: { brain: { domain: 'brain.invalid' }, admin_key_file: keyPath } }),
    resolveAdminKey: () => readFileSync(keyPath, 'utf8'), write: s => output.push(s),
    launchctl: () => { launchCalls++; throw new Error('launch forbidden'); },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, 'brain.invalid'); assert.equal(init.redirect, 'error');
      calls.push(JSON.parse(init.body));
      const response = await worker.fetch(new Request(url, init), f.env, {});
      if (lose) { lose = false; throw new Error('lost receipt'); }
      return response;
    } };
  const original = f.rows('SELECT * FROM fin_transactions'), accounts = f.rows('SELECT * FROM fin_accounts');
  const refusal = await ask(f);
  assert.equal(refusal.answer, null); assert.equal(refusal.gaps.length, 1);
  assert.equal(refusal.gaps[0].reason, 'ledger_account_link_required');
  // Institution text can contain an account identifier; slugs are arbitrary
  // owner strings too. Guidance retains masks/kinds and uses CLI placeholders.
  assert.match(refusal.gaps[0].detail, /\[redacted\] \*{4}kOne.*4321.*checking/);
  // The Worker and the owner app cannot know the installer's shell, so their
  // guidance names the subcommand; only CLI output is rendered per platform.
  assert.ok(refusal.gaps[0].detail.includes(renderCliCommands('brain ledger link-accounts <manifest> --manual <manual-account> --live <live-account> --preview', { platform: 'linux' })));
  assert.ok(ownerError(new ApiError(409, { code: refusal.code })).message.includes('ledger link-accounts'));
  const think = () => worker.fetch(new Request('https://brain.invalid/api/rag/think', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': f.env.ADMIN_KEY },
    body: JSON.stringify({ q: 'How much money came in September 2026?' }) }), f.env, {}).then(r => r.json());
  const routeRefusal = await think();
  assert.equal(routeRefusal.answer, null); assert.equal(routeRefusal.gaps.length, 1);
  assert.equal(routeRefusal.code, 'ledger_account_link_required');
  const plan = await cmdLedger([...base, '--preview'], deps);
  assert.equal(plan.accounts.length, 2); assert.equal(plan.mutation_count, 0); assert.equal(plan.blocked, false);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 0);
  assert.ok(output.some(s => s.includes(renderCliCommands('brain ledger link-accounts'))));
  await assert.rejects(cmdLedger([...base, '--apply', '--approve', '0'.repeat(64)], deps), /stale/);
  assert.equal(calls.length, 2); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 0);
  const unauth = await worker.fetch(new Request('https://brain.invalid' + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(calls[1]) }), f.env, {});
  assert.equal(unauth.status, 401);
  lose = true;
  await assert.rejects(cmdLedger([...base, '--apply', '--approve', plan.plan_hash], deps), /lost receipt/);
  const replay = await cmdLedger([...base, '--apply', '--approve', plan.plan_hash], deps);
  assert.equal(replay.complete, true); assert.equal(replay.mutation_count, 0);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 1);
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450, 'approved precedence never doubles to 246900');
  assert.equal((await think()).ledger.accounts[0].credits_minor, 123450, 'the authenticated Think route uses the same approved mapping');
  const stop = await cmdLedger([...base, '--unlink', '--preview'], deps);
  await assert.rejects(cmdLedger([...base, '--unlink', '--apply', '--approve', plan.plan_hash], deps), /stale/);
  assert.equal((await cmdLedger([...base, '--unlink', '--apply', '--approve', stop.plan_hash], deps)).mutation_count, 1);
  assert.equal((await cmdLedger([...base, '--unlink', '--apply', '--approve', stop.plan_hash], deps)).mutation_count, 0);
  await assert.rejects(cmdLedger([...base, '--apply', '--approve', plan.plan_hash], deps), /stale/);
  assert.equal((await ask(f)).code, 'ledger_account_link_required');
  assert.deepEqual(f.rows('SELECT * FROM fin_transactions'), original);
  assert.deepEqual(f.rows('SELECT * FROM fin_accounts'), accounts);
  assert.ok(f.first('SELECT unlinked_at FROM fin_account_links').unlinked_at);
  const again = await cmdLedger([...base, '--preview'], deps);
  assert.equal((await cmdLedger([...base, '--apply', '--approve', again.plan_hash], deps)).mutation_count, 1);
  await assert.rejects(cmdLedger([...base, '--unlink', '--apply', '--approve', stop.plan_hash], deps), /stale/);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 2);
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  assert.equal(launchCalls, 0);
});

test('R03 approvals bind exact identity and tenant; blocked candidates never write', async t => {
  const f = setup(t);
  const plan = await preview(f); assert.equal(plan.blocked, false);
  f.raw("UPDATE fin_accounts SET external_ref='changed-reference' WHERE account_slug='manual-account'");
  const before = f.seen.length;
  await assert.rejects(apply(f, plan), /stale/);
  assert.ok(f.seen.length > before); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 0);
  const fresh = await preview(f); await apply(f, fresh);
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  const otherTenant = await maintainAccountLink(f.env, { ...args, tenantId: 'other-owner' });
  assert.equal(otherTenant.blocked, true); assert.equal(otherTenant.accounts.length, 0);
  await assert.rejects(maintainAccountLink(f.env, { ...args, tenantId: 'other-owner', dryRun: false, approve: otherTenant.plan_hash }), /blocked/);
  f.raw("UPDATE fin_accounts SET external_ref='replacement-reference' WHERE account_slug='manual-account'");
  assert.equal((await ask(f)).code, 'ledger_account_link_required');
  assert.equal((await preview(f)).blocked, true);
  const stop = await maintainAccountLink(f.env, { ...args, unlink: true });
  await apply(f, stop, { unlink: true });
  const repair = await preview(f); await apply(f, repair);
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  account(f, { slug: 'other-manual', mode: 'manual' });
  const competing = await maintainAccountLink(f.env, { ...args, manualSlug: 'other-manual' });
  assert.equal(competing.blocked, true);
  const decisions = f.seen.length;
  await assert.rejects(maintainAccountLink(f.env, { ...args, manualSlug: 'other-manual', dryRun: false, approve: competing.plan_hash }), /blocked/);
  assert.ok(f.seen.length > decisions);
  assert.equal((await ask(f)).code, 'ledger_account_link_required', 'a third colliding account stays unresolved');
});

test('R03 transaction guards catch concurrent account/link changes and rollback failed readback', async t => {
  for (const mutation of ['identity', 'readback']) {
    const f = setup(t), plan = await preview(f); let reached = 0;
    const batch = f.env.DB.batch;
    f.env.DB.batch = statements => {
      reached++;
      if (mutation === 'identity') f.raw("UPDATE fin_accounts SET institution='Changed bank' WHERE account_slug='manual-account'");
      else statements.splice(-1, 0, f.env.DB.prepare("UPDATE fin_account_links SET identity_json='[]'"));
      return batch(statements);
    };
    await assert.rejects(apply(f, plan), /malformed JSON/);
    assert.equal(reached, 1); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links').n, 0);
    f.env.DB.batch = batch;
    await apply(f, await preview(f));
    assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  }
});

test('R03 linked coverage still refuses unknown intervals and the reader snapshots link removal', async t => {
  const f = setup(t); await apply(f, await preview(f));
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  f.raw("UPDATE fin_account_coverage SET coverage_status='missing' WHERE account_slug='live-account'");
  const question = 'How much money came in September 2026?';
  const fallback = async () => new Response('{"answer":null,"gaps":[]}');
  const read = () => withLedgerAnswer({ env: f.env, question, now: NOW, grantScope: { all: true }, scopePrincipalKind: 'owner' }, fallback).then(r => r.json());
  const before = f.seen.length;
  assert.equal((await read()).gaps[0].reason, 'period_outside_coverage'); assert.ok(f.seen.length > before);
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete'");
  let raced = 0; const batch = f.env.DB.batch;
  f.env.DB.batch = statements => {
    if (statements.some(s => s.sql.includes('JOIN fin_transactions'))) {
      raced++;
      f.raw('UPDATE fin_account_links SET unlinked_at=?,unlink_plan_hash=?', NOW, 'f'.repeat(64));
    }
    return batch(statements);
  };
  assert.equal((await read()).gaps[0].reason, 'ledger_unavailable'); assert.equal(raced, 1);
});

test('R03 command validation precedes credentials and rejects invalid completion receipts', async () => {
  assert.equal(parseLedgerLinkArgs([...base, '--preview']).dryRun, true);
  let credentials = 0;
  for (const argv of [[...base], [...base, '--preview', '--apply'], [...base, '--apply'],
    [...base, '--preview', '--approve', 'a'.repeat(64)], [...base, '--preview', '--manual', 'other'],
    ['link-accounts', 'fixture', '--manual', ' manual-account', '--live', 'live-account', '--preview']]) {
    await assert.rejects(cmdLedger(argv, { loadManifest: () => { credentials++; throw new Error('unexpected credential path'); } }));
  }
  assert.equal(credentials, 0);
  let calls = 0;
  await assert.rejects(runLedgerLink(parseLedgerLinkArgs([...base, '--preview']), { manifest: { brain: { domain: 'brain.invalid' } },
    credential: () => randomBytes(32).toString('hex'), write: () => {}, fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ complete: true, mutation_count: 1 }));
    } }), /Invalid account link receipt/);
  assert.equal(calls, 1);
});

test('R03 approved links belong to the schema-55 durable recovery contract only', () => {
  assert.ok(RECOVERY_DURABLE_TABLES.includes('fin_accounts'));
  assert.ok(RECOVERY_DURABLE_TABLES.includes('fin_account_links'));
  const before = recoveryExportTables([{ version: 54 }]);
  const after = recoveryExportTables([{ version: 55 }]);
  assert.ok(before.includes('fin_accounts'));
  assert.ok(!before.includes('fin_account_links'));
  assert.ok(after.includes('fin_account_links'));
});

test('R03 role changes cannot bypass an active approval in the reverse direction', async t => {
  const f = setup(t); await apply(f, await preview(f));
  assert.equal((await ask(f)).ledger.accounts[0].credits_minor, 123450);
  f.raw("UPDATE fin_accounts SET feed_mode=CASE WHEN feed_mode='manual' THEN 'live' ELSE 'manual' END");
  const reversed = { manualSlug: 'live-account', liveSlug: 'manual-account', now: NOW };
  const plan = await maintainAccountLink(f.env, reversed);
  assert.equal(plan.blocked, true);
  const before = f.seen.length;
  await assert.rejects(maintainAccountLink(f.env, { ...reversed, dryRun: false, approve: plan.plan_hash }), /blocked/);
  assert.ok(f.seen.length > before);
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_links WHERE unlinked_at IS NULL').n, 1);
  assert.equal((await ask(f)).code, 'ledger_account_link_required');
});

test('R03 migration creates no triggers and replays without losing approval history', async t => {
  const f = setup(t); await apply(f, await preview(f));
  const before = f.rows('SELECT * FROM fin_account_links');
  f.sqlite.exec(readFileSync(new URL('../migrations/d1/0055_fin_account_links.sql', import.meta.url), 'utf8'));
  assert.deepEqual(f.rows('SELECT * FROM fin_account_links'), before);
  assert.equal(f.first("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='fin_account_links'").n, 0);
  const query = f.queries.find(q => q.sql.startsWith('SELECT (SELECT json_group_array'));
  assert.ok(query, 'approval snapshot SQL was reached');
  const plan = f.rows('EXPLAIN QUERY PLAN '+query.sql, ...query.binds).map(r => r.detail);
  assert.ok(plan.some(r => r.includes('ux_fin_account_links_manual')));
  assert.ok(plan.some(r => r.includes('ux_fin_account_links_live')));
  assert.ok(plan.some(r => r.includes('idx_fin_account_links_pair')));
  assert.ok(!plan.some(r => /SCAN fin_account_links/.test(r)), 'history lookup stays bounded by indexed endpoints');
});
