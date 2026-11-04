import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fixture } from '../worker/test/ledger-review-fixture.mjs';
import { withLedgerAnswer } from '../worker/src/lib/ledger-answer.js';
import { prepareBankExportImport } from '../worker/src/lib/fin-import.js';
import { readEffectiveAccounts } from '../worker/src/lib/ledger-reader.js';
import { maintainAccountKind, reviewedAccountRole } from '../worker/src/lib/fin-account-kinds.js';
import { RECOVERY_DURABLE_TABLES, recoveryExportTables } from '../operations/cloudflare-recovery-adapter.mjs';
import { parseLedgerAccountKindArgs, runLedgerAccountKind } from '../operations/ledger-account-kind.mjs';
import { financialPictureInventory, assertFinancialPicturePublicReceipt } from '../worker/src/lib/financial-picture.js';
import { splitStatements } from '../brain.mjs';
import { renderFinancialPicture } from '../operations/financial-picture.mjs';
import { ledgerAccounts, ledgerCashPosition, ledgerObligations } from '../worker/src/lib/fin-d1.js';
import { cmdLedger } from '../brain.mjs';
import worker from '../worker/src/index.js';
import { renderCliCommands } from '../operations/cli-guidance.mjs';

const NOW = '2026-10-31T19:00:00.000Z';
const base = ['account-kind', 'synthetic.manifest.json', '--account', '4242'];
let network = 0, processes = 0;
globalThis.fetch = async () => { network++; throw Error('network forbidden'); };
test.before(() => {
  mock.method(Date, 'now', () => Date.parse(NOW));
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    mock.method(childProcess, name, () => { processes++; throw Error('host tool forbidden'); });
  }
  syncBuiltinESMExports();
});
test.after(() => { assert.equal(network, 0); assert.equal(processes, 0); mock.restoreAll(); syncBuiltinESMExports(); });

function seed(t) {
  const f = fixture(t); f.owner();
  f.env.STORAGE_BACKEND = 'd1';
  for (const [slug, kind, role, mask] of [['cash','checking','asset','3131'], ['debt','other','neither','4242']]) {
    f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,label,feed_mode,
      external_ref,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,'owner',?,?,?,?,'live',?,'feed','bank-feed:synthetic','confirmed',?)`,
    slug, kind, role, mask, slug, `provider-${slug}`, NOW);
    f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete','2026-09-01','2026-11-07',?,'owner_stated','confirmed',?)`, slug, NOW, NOW);
  }
  for (const [uid, amount, description, payee] of [['store',21000,'supplies','Store'],
    ['own',40000,'payment to account 4242','payment'], ['outside',40000,'payment to outside lender','Outside Lender']]) {
    f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
      VALUES (?,'cash','2026-10-12',?,'outflow',?,?,'owner_stated','confirmed',?)`, uid, amount, description, payee, NOW);
  }
  const home = join(process.env.HOME, 'cli-fixtures'); mkdirSync(home, { recursive: true });
  const dir = mkdtempSync(join(home, 'account-kind-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'fixture-admin-key'); writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  f.env.ADMIN_KEY = readFileSync(keyPath, 'utf8');
  f.requests = []; f.output = []; f.launchCalls = 0;
  f.deps = { loadManifest: () => ({ m: { brain: { domain: 'brain.invalid' }, admin_key_file: keyPath } }),
    resolveAdminKey: () => readFileSync(keyPath, 'utf8'), write: s => f.output.push(s),
    launchctl: () => { f.launchCalls++; throw Error('launch forbidden'); },
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).hostname, 'brain.invalid'); assert.equal(init.redirect, 'error');
      f.requests.push(JSON.parse(init.body));
      return worker.fetch(new Request(url, init), f.env, {});
    } };
  f.command = (args = ['--kind','loan','--preview'], account = '4242') => cmdLedger(
    ['account-kind','synthetic.manifest.json','--account', account, ...args], f.deps);
  f.review = async () => {
    const plan = await f.command();
    assert.equal(plan.accounts.length, 1, 'real account selection reached');
    assert.equal(plan.blocked, false);
    return f.command(['--kind','loan','--apply','--approve',plan.plan_hash]);
  };
  f.ask = async () => {
    const before = f.calls.length;
    const body = await (await withLedgerAnswer({ env: f.env, question: 'What are my expenses?', now: NOW,
      grantScope: { all: true }, scopePrincipalKind: 'owner' }, gap => Response.json({ answer: null, gaps: [gap] }))).json();
    assert.ok(f.calls.slice(before).some(sql => /JOIN fin_transactions/.test(sql)), 'real nonempty row decision reached');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 3);
    return body;
  };
  f.replay = (extra = {}) => {
    const plan = prepareBankExportImport({ ok: true, accounts: [{ accountKey: 'debt', accountKind: 'other',
      balanceRole: 'neither', mask: '4242', externalRef: 'provider-debt', transactions: [], ...extra }] },
    { entitySlug: 'owner', now: NOW, origin: { provenance: 'feed', sourceFeed: 'bank-feed:synthetic' } });
    assert.ok(plan.statements.length > 1, 'real importer reached');
    for (const [sql, binds] of plan.statements) f.raw(sql, ...binds);
  };
  return f;
}

test('owner review repairs the unknown-type headline through the actual CLI and authenticated route', async t => {
  const f = seed(t);
  await f.review();
  assert.equal(f.requests.length, 2);
  assert.equal((await f.ask()).ledger.expense_total_minor, 61000);
  assert.equal((await f.ask()).ledger.own_account_payments.loan_minor, 40000);
  assert.equal(f.first("SELECT account_kind FROM fin_accounts WHERE account_slug='debt'").account_kind, 'other');
  assert.ok(f.output.some(s => s.includes(renderCliCommands('brain ledger account-kind'))));
  assert.equal(f.launchCalls, 0);
});

test('unreviewed and revoked unknown types remain uncertain; the reviewed control is exact', async t => {
  const f = seed(t);
  const unknown = await f.ask();
  assert.notEqual(unknown.ledger?.complete, true);
  await f.review();
  assert.equal((await f.ask()).ledger.expense_total_minor, 61000);
  const plan = await f.command(['--revoke','--preview']);
  await f.command(['--revoke','--apply','--approve',plan.plan_hash]);
  assert.notEqual((await f.ask()).ledger?.complete, true);
});

test('provider-reset preserves the reviewed effective kind and includes the outside lender', async t => {
  const f = seed(t); await f.review();
  f.replay();
  assert.equal((await readEffectiveAccounts(f.env)).find(a => a.account_slug === 'debt').account_kind, 'loan');
  const body = await f.ask();
  assert.equal(body.ledger.expense_total_minor, 61000);
  assert.equal(body.ledger.own_account_payments.total_minor, 40000);
  assert.equal(body.ledger.row_count, 2);
});

test('general ledger inventory and cash exclusions use the same reviewed classification', async t => {
  const f = seed(t); await f.review();
  const accounts = await ledgerAccounts(f.env);
  assert.equal(accounts.unavailable,false);
  const debt = accounts.accounts.find(a => a.account_slug === 'debt');
  assert.equal(debt.account_kind,'loan'); assert.equal(debt.balance_role,'liability');
  assert.equal(debt.provider_account_kind,'other'); assert.equal(debt.account_kind_review.reviewer,'owner');
  const cash = await ledgerCashPosition(f.env);
  assert.equal(cash.excluded.find(a => a.account_slug === 'debt').reason,'money_owed_not_held');
  const stop = await f.command(['--revoke','--preview']);
  await f.command(['--revoke','--apply','--approve',stop.plan_hash]);
  assert.equal((await ledgerAccounts(f.env)).accounts.find(a => a.account_slug === 'debt').account_kind,'other');
});

test('the obligation register classification gate honors review and revocation', async t => {
  const f = seed(t);
  const before = f.calls.length;
  assert.equal((await ledgerObligations(f.env)).exposure.covers_all_obligations,false);
  assert.ok(f.calls.slice(before).some(sql => sql.includes('AS unclassified')), 'real classification gate reached');
  await f.review();
  assert.equal((await ledgerObligations(f.env)).exposure.covers_all_obligations,true);
  const stop = await f.command(['--revoke','--preview']);
  await f.command(['--revoke','--apply','--approve',stop.plan_hash]);
  assert.equal((await ledgerObligations(f.env)).exposure.covers_all_obligations,false);
});

test('a null provider mask uses an exact stored label, with no inferred mask', async t => {
  const f = seed(t);
  f.raw("UPDATE fin_accounts SET mask=NULL WHERE account_slug='debt'");
  f.raw("UPDATE fin_transactions SET description='payment to debt' WHERE txn_uid='own'");
  assert.equal((await f.ask()).answer,null);
  const plan = await f.command(['--kind','loan','--preview'],'debt');
  assert.equal(plan.accounts[0].mask,null);
  await f.command(['--kind','loan','--apply','--approve',plan.plan_hash],'debt');
  f.replay({mask:null});
  assert.equal((await f.ask()).ledger.expense_total_minor,61000);
  assert.equal(f.first("SELECT mask FROM fin_accounts WHERE account_slug='debt'").mask,null);
});

test('an untyped source also requires its own review before a repayment is proved', async t => {
  const f = seed(t);
  f.raw("UPDATE fin_accounts SET account_kind='other',balance_role='neither' WHERE account_slug='cash'");
  await f.review();
  assert.equal((await f.ask()).answer,null);
  const plan = await f.command(['--kind','checking','--preview'],'cash');
  assert.equal(plan.accounts.length,1);
  await f.command(['--kind','checking','--apply','--approve',plan.plan_hash],'cash');
  assert.equal((await f.ask()).ledger.expense_total_minor,61000);
});

test('preview is nonwriting, duplicate masks refuse and an exact row ID is the green control', async t => {
  const f = seed(t);
  const plan = await f.command();
  assert.equal(plan.accounts[0].mask, '4242');
  assert.equal(plan.accounts[0].provider_kind, 'other'); assert.equal(plan.accounts[0].provider_role, 'neither');
  assert.equal(plan.mutation_count, 0); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n, 0);
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('second-debt','owner','other','neither','4242','manual','owner_stated','confirmed',?)`, NOW);
  const duplicate = await f.command();
  assert.equal(duplicate.blocked, true); assert.equal(duplicate.accounts.length, 2);
  const before = f.requests.length;
  await assert.rejects(f.command(['--kind','loan','--apply','--approve',duplicate.plan_hash]), /blocked/);
  assert.equal(f.requests.length, before + 1); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n, 0);
  const exact = `id:${plan.accounts[0].account_id}`;
  const exactPlan = await f.command(['--kind','loan','--preview'], exact);
  assert.equal(exactPlan.accounts.length, 1); assert.equal(exactPlan.blocked, false);
  assert.equal((await f.command(['--kind','loan','--apply','--approve',exactPlan.plan_hash], exact)).complete, true);
});

test('stale approvals, lost receipts, revocation and replacements retain exact history', async t => {
  const f = seed(t), plan = await f.command();
  const generation = () => f.first('SELECT generation n FROM bank_activity_refresh_state WHERE id=1').n;
  const original = generation();
  const apply = hash => f.command(['--kind','loan','--apply','--approve',hash]);
  await assert.rejects(apply('0'.repeat(64)), /stale/);
  assert.equal(f.requests.length, 2); assert.equal(generation(), original);
  const done = await apply(plan.plan_hash);
  assert.equal(done.review.reviewer, 'owner'); assert.equal(done.review.reviewed_at, NOW);
  assert.equal(generation(), original + 1);
  assert.equal((await apply(plan.plan_hash)).mutation_count, 0);
  assert.equal(generation(), original + 1);
  const stop = await f.command(['--revoke','--preview']);
  const revoke = hash => f.command(['--revoke','--apply','--approve',hash]);
  await assert.rejects(revoke(plan.plan_hash), /stale/);
  assert.equal((await revoke(stop.plan_hash)).mutation_count, 1);
  assert.equal((await revoke(stop.plan_hash)).mutation_count, 0);
  await assert.rejects(apply(plan.plan_hash), /stale/);
  await f.review();
  await assert.rejects(revoke(stop.plan_hash), /stale/);
  const replacement = await f.command(['--kind','card','--preview']);
  const changed = await f.command(['--kind','card','--apply','--approve',replacement.plan_hash]);
  assert.equal(changed.review.kind, 'card');
  const rows = f.rows('SELECT * FROM fin_account_kind_reviews ORDER BY id');
  assert.equal(rows.length, 3); assert.equal(rows.filter(r => r.revoked_at === null).length, 1);
  assert.ok(rows.slice(0,2).every(r => r.revoked_at === NOW));
});

test('a lost response replays the exact stored approval without a second write', async t => {
  const f = seed(t), plan = await f.command(), fetchImpl = f.deps.fetchImpl;
  let lost = 0;
  f.deps.fetchImpl = async (...args) => {
    const response = await fetchImpl(...args);
    lost++; throw Error('synthetic lost receipt');
  };
  await assert.rejects(f.command(['--kind','loan','--apply','--approve',plan.plan_hash]), /synthetic lost receipt/);
  assert.equal(lost,1); assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n,1);
  f.deps.fetchImpl = fetchImpl;
  assert.equal((await f.command(['--kind','loan','--apply','--approve',plan.plan_hash])).mutation_count,0);
  assert.equal(f.first('SELECT generation n FROM bank_activity_refresh_state WHERE id=1').n,1);
  assert.equal((await f.ask()).ledger.expense_total_minor,61000);
});

test('provider identity replacement cannot inherit a reviewed type; stale review can be revoked', async t => {
  for (const [column,value] of [['external_ref','replacement'], ['source_feed','bank-feed:replacement'],
    ['entity_slug','second-owner'], ['currency','CAD'], ['mask','8787'], ['feed_mode','manual'], ['institution','Second bank']]) {
    const f = seed(t); await f.review();
    if (column === 'external_ref') f.replay({ externalRef: value });
    else f.raw(`UPDATE fin_accounts SET ${column}=? WHERE account_slug='debt'`, value);
    const row = (await readEffectiveAccounts(f.env)).find(a => a.account_slug === 'debt');
    if (row) { assert.equal(row.account_kind, 'other'); assert.equal(row.account_kind_review.state, 'stale'); }
    const stale = await f.command(['--kind','loan','--preview'], 'debt');
    assert.equal(stale.blocked, true); assert.equal(stale.accounts.length, 1);
    const before = f.requests.length;
    await assert.rejects(f.command(['--kind','loan','--apply','--approve',stale.plan_hash], 'debt'), /blocked/);
    assert.equal(f.requests.length, before + 1);
    const revoke = await f.command(['--revoke','--preview'], 'debt');
    assert.equal((await f.command(['--revoke','--apply','--approve',revoke.plan_hash], 'debt')).complete, true);
  }
});

test('R1 exact retired row revocation retains history without touching its replacement', async t => {
  const f = seed(t);
  await f.review();
  const current = await f.command(['--revoke','--preview'], 'id:2');
  assert.equal(current.accounts.length, 1, 'current exact row selection reached');
  assert.equal((await f.command(['--revoke','--apply','--approve',current.plan_hash], 'id:2')).complete, true);
  await f.review();
  f.raw('UPDATE fin_accounts SET superseded_by_id=3 WHERE id=2');
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('debt','owner','other','neither','4242','live','owner_stated','confirmed',?)`, NOW);
  await f.review();
  const history = f.rows('SELECT * FROM fin_account_kind_reviews ORDER BY id');
  const before = f.calls.length;
  const retired = await f.command(['--revoke','--preview'], 'id:2');
  assert.ok(f.calls.slice(before).some(sql => sql.includes('AS accounts') && sql.includes('AS reviews')),
    'real historical selection query reached');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews WHERE account_id=2 AND revoked_at IS NULL').n, 1);
  assert.equal(retired.accounts.length, 1, 'retired row remains reachable');
  assert.equal(retired.accounts[0].account_id, 2);
  assert.equal(retired.blocked, false);
  assert.equal((await f.command(['--revoke','--apply','--approve',retired.plan_hash], 'id:2')).mutation_count, 1);
  assert.equal((await f.command(['--revoke','--apply','--approve',retired.plan_hash], 'id:2')).mutation_count, 0);
  const after = f.rows('SELECT * FROM fin_account_kind_reviews ORDER BY id');
  assert.equal(after.length, 3);
  assert.deepEqual(after[0], history[0]);
  assert.equal(after[1].revoked_at, NOW);
  assert.deepEqual(after[2], history[2], 'replacement review is independent');
  const newReview = await f.command(['--kind','loan','--preview'], 'id:2');
  assert.equal(newReview.blocked, true);
  const requests = f.requests.length;
  await assert.rejects(f.command(['--kind','loan','--apply','--approve',newReview.plan_hash], 'id:2'), /blocked/);
  assert.equal(f.requests.length, requests + 1, 'retired creation refusal reached authenticated route');
  const other = await maintainAccountKind(f.env, { tenantId:'other-owner', selector:'id:2', revoke:true, now:NOW });
  assert.equal(other.accounts.length, 0);
  assert.equal(other.blocked, true);
});

test('R2 closure changes the approval snapshot and remains visible for historical classification', async t => {
  const f = seed(t), open = await f.command();
  assert.equal(open.accounts.length, 1, 'open account selection reached');
  f.raw("UPDATE fin_accounts SET status='closed',closed_on='2026-10-01' WHERE id=2");
  const closed = await f.command();
  assert.equal(closed.accounts.length, 1, 'closed account selection reached');
  assert.notEqual(closed.plan_hash, open.plan_hash, 'closure invalidates open-account approval');
  assert.equal(open.accounts[0].status, 'open');
  assert.equal(open.accounts[0].closed_on, null);
  assert.equal(closed.accounts[0].status, 'closed');
  assert.equal(closed.accounts[0].closed_on, '2026-10-01');
  const requests = f.requests.length;
  await assert.rejects(f.command(['--kind','loan','--apply','--approve',open.plan_hash]), /stale/);
  assert.equal(f.requests.length, requests + 1, 'stale approval reaches the real route');
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n, 0);
  f.raw("UPDATE fin_accounts SET closed_on='2026-10-02' WHERE id=2");
  const redated = await f.command();
  assert.notEqual(redated.plan_hash, closed.plan_hash, 'closure date alone is approval context');
  assert.equal(redated.accounts[0].closed_on, '2026-10-02');
  const dateRequests = f.requests.length;
  await assert.rejects(f.command(['--kind','loan','--apply','--approve',closed.plan_hash]), /stale/);
  assert.equal(f.requests.length, dateRequests + 1, 'date-only stale approval reaches the real route');
  await f.command(['--kind','loan','--apply','--approve',redated.plan_hash]);
  const body = await f.ask();
  assert.equal(body.ledger.expense_total_minor, 61000);
  assert.equal(body.ledger.own_account_payments.loan_minor, 40000,
    'closure alone does not invalidate an otherwise proved payment posted later');
  const stop = await f.command(['--revoke','--preview']);
  assert.equal((await f.command(['--revoke','--apply','--approve',stop.plan_hash])).complete, true);
});

test('retired revocation guards the selected historical review inside the write batch', async t => {
  const f = seed(t); await f.review();
  f.raw('UPDATE fin_accounts SET superseded_by_id=3 WHERE id=2');
  const plan = await f.command(['--revoke','--preview'], 'id:2');
  assert.equal(plan.accounts[0].superseded_by_id, 3);
  const batch = f.env.DB.batch;
  let reached = 0;
  f.env.DB.batch = statements => {
    reached++;
    f.raw("UPDATE fin_account_kind_reviews SET kind='card' WHERE account_id=2");
    return batch(statements);
  };
  await assert.rejects(f.command(['--revoke','--apply','--approve',plan.plan_hash], 'id:2'), /could not be verified/);
  assert.equal(reached, 1, 'historical revocation reaches the atomic guard');
  assert.equal(f.first('SELECT revoked_at FROM fin_account_kind_reviews WHERE account_id=2').revoked_at, null);
  f.env.DB.batch = batch;
  const fresh = await f.command(['--revoke','--preview'], 'id:2');
  assert.equal((await f.command(['--revoke','--apply','--approve',fresh.plan_hash], 'id:2')).complete, true);
});

test('closure and retirement races refuse new reviews atomically with a fresh closed-row control', async t => {
  for (const change of ["status='closed',closed_on='2026-10-01'", 'superseded_by_id=3']) {
    const f = seed(t), plan = await f.command(), batch = f.env.DB.batch;
    let reached = 0;
    f.env.DB.batch = statements => {
      reached++;
      f.raw(`UPDATE fin_accounts SET ${change} WHERE id=2`);
      return batch(statements);
    };
    await assert.rejects(f.command(['--kind','loan','--apply','--approve',plan.plan_hash]), /could not be verified/);
    assert.equal(reached, 1, 'new review reaches the atomic snapshot guard');
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n, 0);
    assert.equal(f.first('SELECT generation n FROM bank_activity_refresh_state WHERE id=1').n, 0);
    f.env.DB.batch = batch;
    f.raw("UPDATE fin_accounts SET superseded_by_id=NULL,status='closed',closed_on='2026-10-01' WHERE id=2");
    await f.review();
    assert.equal((await f.ask()).ledger.own_account_payments.loan_minor, 40000);
  }
});

test('R3 a kind review preserves an unresolved provider duplicate until independent linking', async t => {
  const f = seed(t);
  f.raw("UPDATE fin_transactions SET description='outside payment' WHERE txn_uid='own'");
  f.raw(`INSERT INTO fin_accounts (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at)
    VALUES ('cash-copy','owner','checking','asset','3131','manual','owner_stated','confirmed',?)`, NOW);
  f.raw(`INSERT INTO fin_account_coverage (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('cash-copy','complete','2026-09-01','2026-11-07',?,'owner_stated','confirmed',?)`, NOW, NOW);
  f.raw(`INSERT INTO fin_transactions (txn_uid,account_slug,posted_on,amount_minor,direction,description,payee,provenance,basis_state,recorded_at)
    VALUES ('store-copy','cash-copy','2026-10-12',21000,'outflow','supplies','Store','owner_stated','confirmed',?)`, NOW);
  const ask = async () => (await withLedgerAnswer({ env:f.env, question:'What are my expenses?', now:NOW,
    grantScope:{ all:true }, scopePrincipalKind:'owner' }, gap => Response.json({ answer:null,gaps:[gap] }))).json();
  assert.equal(f.first('SELECT COUNT(*) n FROM fin_transactions').n, 4, 'nonempty duplicate fixture');
  assert.equal((await ask()).gaps[0].reason, 'ledger_account_link_required');
  const plan = await f.command(['--kind','savings','--preview'], 'cash-copy');
  assert.equal(plan.accounts.length, 1);
  await f.command(['--kind','savings','--apply','--approve',plan.plan_hash], 'cash-copy');
  const before = f.calls.length;
  const accounts = await readEffectiveAccounts(f.env);
  assert.ok(f.calls.length > before, 'real account inventory reached');
  assert.equal(accounts.find(a => a.account_slug === 'cash-copy').account_kind, 'savings');
  const reviewed = await ask();
  assert.equal(reviewed.answer, null);
  assert.equal(reviewed.gaps[0].reason, 'ledger_account_link_required', 'classification cannot settle identity');
  const stop = await f.command(['--revoke','--preview'], 'cash-copy');
  await f.command(['--revoke','--apply','--approve',stop.plan_hash], 'cash-copy');
  const { maintainAccountLink } = await import('../worker/src/lib/fin-account-links.js');
  const link = await maintainAccountLink(f.env, { manualSlug:'cash-copy',liveSlug:'cash',now:NOW });
  assert.equal(link.accounts.length, 2);
  await maintainAccountLink(f.env, { manualSlug:'cash-copy',liveSlug:'cash',now:NOW,dryRun:false,approve:link.plan_hash });
  const linked = await ask();
  assert.ok(f.calls.some(sql => /JOIN fin_transactions/.test(sql)), 'linked control reaches transaction read');
  assert.equal(linked.ledger.expense_total_minor, null, 'identity approval leaves unknown classification uncertain');
  assert.equal(linked.ledger.retained_outflow_minor, 101000);
  assert.equal(linked.ledger.row_count, 3, 'independent approval suppresses the duplicate');
  await f.review();
  const classified = await ask();
  assert.equal(classified.ledger.complete, true, 'separate classification prerequisite reached');
  assert.equal(classified.ledger.expense_total_minor, 101000);
  assert.equal(classified.ledger.row_count, 3);
});

test('atomic guard and exact readback rollback a raced or corrupted review', async t => {
  for (const mode of ['identity','review','readback']) {
    const f = seed(t), plan = await f.command();
    let reached = 0; const batch = f.env.DB.batch;
    f.env.DB.batch = statements => {
      reached++;
      if (mode === 'identity') f.raw("UPDATE fin_accounts SET external_ref='replacement' WHERE account_slug='debt'");
      if (mode === 'review') f.raw(`INSERT INTO fin_account_kind_reviews
        (tenant_id,account_id,identity_json,kind,role,reviewer,source,reviewed_at,review_plan_hash)
        VALUES ('primary',2,'[]','loan','liability','owner','owner_account_kind',?,?)`, NOW, 'a'.repeat(64));
      if (mode === 'readback') statements.splice(-1,0,f.env.DB.prepare("UPDATE fin_account_kind_reviews SET kind='card'"));
      return batch(statements);
    };
    await assert.rejects(f.command(['--kind','loan','--apply','--approve',plan.plan_hash]), /could not be verified/);
    assert.equal(reached, 1);
    assert.equal(f.first('SELECT COUNT(*) n FROM fin_account_kind_reviews').n, mode === 'review' ? 1 : 0);
    assert.equal(f.first('SELECT generation n FROM bank_activity_refresh_state WHERE id=1').n, 0);
    f.env.DB.batch = batch;
    if (mode === 'review') {
      const revoke = await f.command(['--revoke','--preview']);
      await f.command(['--revoke','--apply','--approve',revoke.plan_hash]);
    }
    await f.review();
    assert.equal((await f.ask()).ledger.expense_total_minor, 61000);
  }
});

test('ledger snapshot detects review revocation between account selection and transaction read', async t => {
  const f = seed(t); await f.review();
  const batch = f.env.DB.batch; let reached = 0;
  f.env.DB.batch = statements => {
    if (statements.some(s => s.sql.includes('JOIN fin_transactions'))) {
      reached++;
      f.raw('UPDATE fin_account_kind_reviews SET revoked_at=?,revoke_plan_hash=?', NOW, 'b'.repeat(64));
    }
    return batch(statements);
  };
  const body = await f.ask();
  assert.equal(reached, 1); assert.equal(body.answer, null); assert.equal(body.gaps[0].reason, 'ledger_unavailable');
  f.env.DB.batch = batch; await f.review();
  assert.equal((await f.ask()).ledger.expense_total_minor, 61000);
});

test('revocation readback proves its exact timestamp and rolls back a corrupted close', async t => {
  const f = seed(t); await f.review();
  const plan = await f.command(['--revoke','--preview']), batch = f.env.DB.batch;
  let reached = 0;
  f.env.DB.batch = statements => {
    reached++;
    statements.splice(-1,0,f.env.DB.prepare("UPDATE fin_account_kind_reviews SET revoked_at='2026-01-01T00:00:00.000Z' WHERE revoked_at IS NOT NULL"));
    return batch(statements);
  };
  await assert.rejects(f.command(['--revoke','--apply','--approve',plan.plan_hash]), /could not be verified/);
  assert.equal(reached,1); assert.equal(f.first('SELECT revoked_at FROM fin_account_kind_reviews').revoked_at,null);
  f.env.DB.batch = batch;
  assert.equal((await f.command(['--revoke','--apply','--approve',plan.plan_hash])).review.revoked_at,NOW);
});

test('financial-picture shows provider and reviewed values with private identity references', async t => {
  const f = seed(t);
  const inventory = async () => {
    assertFinancialPicturePublicReceipt((await financialPictureInventory(f.env, { sections:['accounts'] })).body);
    const r = await worker.fetch(new Request('https://brain.invalid/api/fin/financial-picture', { method: 'POST',
      headers: { 'Content-Type':'application/json','X-Admin-Key':f.env.ADMIN_KEY },
      body: JSON.stringify({ sections:['accounts'] }) }), f.env, {});
    assert.equal(r.status, 200);
    const body = await r.json();
    const row = body.sections.accounts.records.find(a => a.masked_identity.includes('4242'));
    assert.ok(row, 'real accounts inventory reached'); return { row, body };
  };
  const before = await inventory(); assert.equal(before.row.account_kind_review, null);
  await f.review();
  const { row, body } = await inventory();
  assert.equal(row.stored_account_kind, 'other'); assert.equal(row.balance_role, 'neither');
  assert.equal(row.reviewed_account_kind, 'loan'); assert.equal(row.reviewed_balance_role, 'liability');
  assert.equal(row.effective_account_kind, 'loan'); assert.equal(row.effective_balance_role, 'liability');
  assert.equal(row.account_kind_review.state, 'current'); assert.equal(row.account_kind_review.reviewer, 'owner');
  assert.equal(row.account_kind_review.reviewed_at, NOW);
  assert.match(row.account_kind_review.bound_identity_ref, /^acct_v2_[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(body), /provider-debt|bank-feed:synthetic|identity_json/);
  assert.match(renderFinancialPicture(body), /provider other\/neither; reviewed loan\/liability \(current, owner/);
  const stop = await f.command(['--revoke','--preview']);
  await f.command(['--revoke','--apply','--approve',stop.plan_hash]);
  const revoked = (await inventory()).row;
  assert.equal(revoked.account_kind_review.state, 'revoked'); assert.equal(revoked.account_kind_review.revoked_at, NOW);
  assert.equal(revoked.effective_account_kind, 'other'); assert.equal(revoked.reviewed_account_kind, 'loan');
});

test('validation precedes credentials; authentication and bounded receipts fail closed', async t => {
  let credentials = 0;
  for (const args of [[], ['--preview','--apply'], ['--apply'], ['--kind','loan','--role','asset','--preview'],
    ['--kind','other','--preview'], ['--revoke','--kind','loan','--preview'], ['--kind','loan','--kind','card','--preview'],
    ['--kind','loan','--preview','--approve','a'.repeat(64)]]) {
    await assert.rejects(cmdLedger([...base,...args], { loadManifest: () => { credentials++; throw Error('credential path forbidden'); } }));
  }
  assert.equal(credentials, 0);
  for (const [kind,role] of [['checking','asset'],['savings','asset'],['card','liability'],['loan','liability'],['line_of_credit','liability']]) {
    assert.equal(reviewedAccountRole(kind), role);
  }
  assert.equal(reviewedAccountRole('other','asset'), 'asset'); assert.equal(reviewedAccountRole('other','liability'), 'liability');
  const f = seed(t), plan = await f.command();
  const before = f.calls.length;
  const unauth = await worker.fetch(new Request('https://brain.invalid/api/admin/fin/import-bank-export', { method:'POST',
    body: JSON.stringify(f.requests[0]), headers: { 'Content-Type':'application/json' } }), f.env, {});
  assert.equal(unauth.status, 401); assert.equal(f.calls.length, before);
  const empty = await maintainAccountKind(f.env, { tenantId:'other-owner', selector:'debt', kind:'loan', now:NOW });
  assert.equal(empty.blocked, true); assert.equal(empty.accounts.length, 0);
  const calls = f.calls.length;
  await assert.rejects(maintainAccountKind(f.env, { tenantId:'other-owner', selector:'debt', kind:'loan', now:NOW,
    dryRun:false, approve:empty.plan_hash }), /blocked/);
  assert.ok(f.calls.length > calls);
  let requests = 0;
  await assert.rejects(runLedgerAccountKind(parseLedgerAccountKindArgs([...base,'--kind','loan','--preview']), {
    manifest:{ brain:{ domain:'brain.invalid' } }, credential: () => f.env.ADMIN_KEY,
    fetchImpl: async () => { requests++; return Response.json({ ...plan, mutation_count:1 }); }, write: () => {},
  }), /Invalid account review receipt/);
  assert.equal(requests, 1);
  await f.review(); assert.equal((await f.ask()).ledger.expense_total_minor, 61000);
});

test('migration replay retains reviews and schema-58 recovery includes their durable history', async t => {
  const f = seed(t); await f.review();
  const before = f.rows('SELECT * FROM fin_account_kind_reviews');
  const sql = readFileSync(new URL('../migrations/d1/0058_fin_account_kind_reviews.sql', import.meta.url),'utf8');
  for (const statement of splitStatements(sql)) f.raw(statement);
  assert.deepEqual(f.rows('SELECT * FROM fin_account_kind_reviews'), before);
  assert.equal(f.first("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND tbl_name='fin_account_kind_reviews'").n, 0);
  assert.ok(RECOVERY_DURABLE_TABLES.includes('fin_account_kind_reviews'));
  assert.equal(recoveryExportTables([{ version:57 }]).includes('fin_account_kind_reviews'), false);
  assert.equal(recoveryExportTables([{ version:58 }]).includes('fin_account_kind_reviews'), true);
});
