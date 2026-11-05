import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import * as product from "../src/lib/simplefin-bank-feed.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import * as reader from "../src/lib/ledger-reader.js";
import { scoreAnswer, moneyBook, oracleFor } from "./fixtures/simplefin-parity.mjs";

const sourceUrl = new URL("../src/lib/simplefin-bank-feed.js", import.meta.url);
const day = (date, offset = 0) => new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000).toISOString().slice(0, 10);
const epoch = value => Date.parse(value) / 1000;
const now = date => `${date}T12:00:00.000Z`;
let ambientCalls = 0;
const mutants = [];
const copies = [];
const ambientFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async () => { ambientCalls++; throw new Error("unexpected network"); }; });
test.after(() => {
  globalThis.fetch = ambientFetch; assert.equal(ambientCalls, 0);
  if (process.env.R1_MUTANTS_RECEIPT) writeFileSync(process.env.R1_MUTANTS_RECEIPT, JSON.stringify({ mutants, copies }, null, 2));
});

async function moduleCopy(t, source, label, origin = sourceUrl) {
  const originalSha = createHash("sha256").update(source).digest("hex");
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "simplefin-recovery-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  source = source.replace(/from "(\.{1,2}\/[^\"]+)"/g, (_, dependency) => `from ${JSON.stringify(new URL(dependency, origin).href)}`);
  const path = join(directory, `${label}.mjs`);
  writeFileSync(path, source);
  copies.push({ label, input_sha256: originalSha, copied_sha256: createHash("sha256").update(source).digest("hex") });
  return import(pathToFileURL(path).href);
}

async function fixture(t, { sf = product, start = "2026-11-01", end = "2026-11-04", rows = [] } = {}) {
  const f = await createProductFixture({ env: { BANK_FEED_PROVIDER: "simplefin", BANK_FEED_ENV: "production",
    BANK_FEED_WRAPPING_KEY_V2: `v2.${"A".repeat(43)}`, BRAIN_TIMEZONE: "UTC" } });
  t.after(() => f.close());
  seedOwnedEntity(f, "store", "Store");
  const access = new URL("https://bridge.example.invalid/simplefin/recovery");
  access.username = "fixture-user"; access.password = "fixture-pass";
  const claimed = await sf.claimSimpleFinAccess(f.env, { requestId: "recovery-claim-request-0001",
    setupToken: btoa("https://bridge.example.invalid/claim/recovery"), now: now(end),
    fetchImpl: async () => new Response(access.href) });
  // Initial schedule only. Recovery tests never edit a persisted cursor.
  f.raw("UPDATE simplefin_connections SET backfill_start=?,backfill_next=?,backfill_end=?,next_pull_at=?",
    start, start, end, now(end));
  const calls = [];
  const pull = async (date, { fail = false, partial = false, omit = false, unread = false, using = sf,
    maxRequestsPerItem = 1, responseRows = rows, beforeResponse = async () => {} } = {}) => {
    const result = await using.runSimpleFinMaintenance(f.env, { now: now(date), maxRequestsPerItem,
      fetchImpl: async request => {
        const url = new URL(request.url);
        const from = Number(url.searchParams.get("start-date")), to = Number(url.searchParams.get("end-date"));
        calls.push({ date, from, to, fail, partial, omit, unread });
        if (fail) throw new Error("synthetic dispatched failure");
        const response = Response.json({ errlist: partial ? ["temporary history gap"] : [], accounts: omit ? [] : [{
          id: "operating", name: "Business Checking", currency: "USD", balance: "20.00", "balance-date": epoch(now(date)),
          transactions: responseRows.filter(row => row.pending === true || (row.posted >= from && row.posted < to))
            .map(row => ({ ...row, ...(unread ? { amount: "unread" } : {}) })),
        }] });
        await beforeResponse({ from, to });
        return response;
      } });
    return result;
  };
  const assign = async () => {
    for (const row of f.rows("SELECT account_ref FROM simplefin_account_assignments")) await sf.assignSimpleFinAccountEntity(f.env, {
      request_id: `assign-${row.account_ref}`, account_ref: row.account_ref, entity_slug: "store",
    }, { now: now(end) });
  };
  return { f, calls, pull, assign, item: claimed.body.item_ref };
}

async function payment(f, date, amount = "123.45") {
  const before = f.seen.sql.length;
  const body = await (await withLedgerAnswer({ env: f.env,
    question: `Did a payment of $${amount} arrive around ${date}?`, now: now(day(date, 10)),
    grantScope: { all: true }, scopePrincipalKind: "owner" }, async gap => Response.json({ answer: null, gaps: [gap] }))).json();
  assert.ok(f.seen.sql.length > before, "payment coverage decision reached real ledger reads");
  return body;
}

async function boundaryReplay(t, sf = product, boundary = "2025-02-02") {
  const expected = [
    { id: "before", posted: epoch(`${boundary}T23:59:58Z`), amount: "1.00" },
    { id: "edge", posted: epoch(`${boundary}T23:59:59Z`), amount: "123.45" },
    { id: "next", posted: epoch(`${day(boundary, 1)}T00:00:00Z`), amount: "2.00" },
  ];
  const end = day(boundary, 8);
  const r = await fixture(t, { sf, start: day(boundary, -89), end, rows: expected });
  await r.pull(end); await r.assign(); await r.pull(day(end, 1));
  assert.equal(r.calls.length, 2, "both adjacent provider requests reached");
  const active = r.f.rows("SELECT external_id FROM fin_transactions WHERE removed_at IS NULL ORDER BY external_id").map(row => row.external_id);
  assert.ok(active.includes("before"), "23:59:58 green control was fetched");
  assert.deepEqual(active, ["before", "edge", "next"], "exclusive endpoint preserves every boundary event");
  const reply = await payment(r.f, boundary);
  assert.equal(reply.ledger?.found, true, "boundary payment is affirmatively proved");
  assert.equal(reply.ledger.amount_minor, 12345);
}

for (const boundary of ["2025-02-02", "2024-02-29", "2025-12-31", "2026-03-08"]) {
  test(`exclusive full-day history at ${boundary}`, t => boundaryReplay(t, product, boundary));
}

async function recoveryReplay(t, sf = product, fault = "fail") {
  const r = await fixture(t, { sf, start: "2026-10-01", rows: [
    { id: "october", posted: epoch("2026-10-16T12:00:00Z"), amount: "123.45" },
    { id: "current", posted: epoch("2026-11-04T12:00:00Z"), amount: "1.00" },
  ] });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "uninterrupted initial control");
  await r.pull("2026-11-05", { [fault]: true });
  assert.equal(r.calls.length, 2, "failed decision reached provider transport");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial");
  const gap = await payment(r.f, "2026-10-16");
  assert.notEqual(gap.ledger?.found, false, "unproved gap cannot assert a negative payment");
  await r.pull("2026-11-06");
  await r.pull("2026-11-07");
  assert.equal(r.calls.length, 4, "later successful daily requests reached transport");
  assert.equal(r.calls[2].from, r.calls[1].from, "oldest failed interval is durably retried");
  assert.equal(r.calls[2].to, r.calls[1].to, "retry preserves the failed interval endpoint");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "proved history recovers without cursor edits");
  assert.equal((await payment(r.f, "2026-10-16")).ledger?.found, true);
  return r;
}

for (const fault of ["fail", "partial", "unread"]) test(`daily schedule recovers after ${fault}`, t => recoveryReplay(t, product, fault));

async function delayedRecovery(t, sf = product, { days = 3, fault = "fail", legacy = false } = {}) {
  const r = await fixture(t, { sf, start: legacy ? "2025-10-01" : "2026-10-01", rows: [
    { id: "october", posted: epoch("2026-10-16T12:00:00Z"), amount: "123.45" },
    { id: "missed-day", posted: epoch("2026-11-06T12:00:00Z"), amount: "123.45" },
  ] });
  // Green control differs only in the response fault or old receipt revision.
  for (let i = 0; i < 8; i++) {
    await r.pull("2026-11-04", { maxRequestsPerItem: 3 }); await r.assign();
    if (r.f.first("SELECT backfill_next>backfill_end AS done FROM simplefin_connections").done) break;
    r.f.raw("UPDATE simplefin_connections SET next_pull_at=?", now("2026-11-04"));
  }
  assert.equal((await payment(r.f, "2026-10-16")).ledger?.found, true, "historical green payment is independently proved");
  if (legacy) r.f.raw("UPDATE simplefin_sync_windows SET revision='legacy',staging_revision='legacy'");
  const before = r.calls.length;
  for (let i = 0; i < days; i++) await r.pull(day("2026-11-05", i), legacy ? {} : { [fault]: true });
  assert.equal(r.calls.length, before + days, "every failed or legacy-repair dispatch was reached");
  for (let i = days; i < days + 8; i++) await r.pull(day("2026-11-05", i), { maxRequestsPerItem: 3 });
  const recoveryCalls = r.calls.slice(before);
  assert.ok(recoveryCalls.some(c => !c.fail && !c.partial && !c.unread && c.from <= epoch("2026-11-06T12:00:00Z") && c.to > epoch("2026-11-06T12:00:00Z")), "outstanding history includes the elapsed unrequested day");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE external_id='missed-day' AND removed_at IS NULL").n, 1,
    "delayed event is eventually imported exactly once");
  assert.equal((await payment(r.f, "2026-10-16")).ledger?.found, true, "October payment recovers after the delayed catch-up");
  assert.ok(r.f.rows("SELECT requests_today FROM simplefin_connections").every(c => c.requests_today <= 24));
  return r;
}
for (const fault of ["fail", "partial", "unread", "none"]) for (const days of [0, 3, 8, 95]) {
  test(`outstanding history recovers ${days}-day ${fault} with a green payment control`, t => delayedRecovery(t, product, { days, fault }));
}
test("outstanding history catches up after many legacy-window repairs", t => delayedRecovery(t, product, { days: 5, legacy: true }));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function overlapReplay(t, sf = product, { reverse = true, overlapDays = 1, phase = "transport" } = {}) {
  const stable = { id: "stable", posted: epoch("2026-11-04T12:00:00Z"), amount: "1.00" };
  const newer = { id: "posted-new", posted: epoch("2026-11-05T12:00:00Z"), amount: "123.45" };
  const rows = [stable];
  const r = await fixture(t, { sf, start: "2026-10-01", rows });
  await r.pull("2026-11-04"); await r.assign();
  const aSelected = deferred(), bSelected = deferred(), aReserved = deferred(), bReserved = deferred(), aResponse = deferred(), deliverA = deferred(), aDecision = deferred();
  const originalPrepare = r.f.DB.prepare;
  const originalBatch = r.f.DB.batch, databaseErrors = [];
  let delayedDecisions = 0;
  r.f.DB.batch = async statements => {
    const pattern = { ledger: /INSERT (?:OR IGNORE )?INTO fin_transactions/,
      withdrawal: /SET removed_at=\?,removal_reason='Absent from verified/,
      promotion: /SET state='promoted',promoted_at=/ }[phase];
    if (reverse && pattern && statements[0].params?.some(value => typeof value === "string" && value.startsWith(`${product.POSTED_HISTORY_REVISION}~2026-11-05:`)) &&
        statements.some(statement => pattern.test(statement.sql))) {
      delayedDecisions++; aDecision.resolve(); await deliverA.promise;
    }
    try { return await originalBatch(statements); }
    catch (error) { databaseErrors.push({ error: error.message, guard: statements[0].sql.match(/AS (\w+guard)/)?.[1],
      windows: r.f.rows("SELECT window_start,window_end,revision,staging_revision FROM simplefin_sync_windows") }); throw error; }
  };
  let selections = 0, reservations = 0;
  if (reverse) r.f.DB.prepare = sql => {
    const wrap = statement => {
      const bound = statement.bind;
      statement.bind = (...args) => wrap(bound(...args));
      if (/SELECT window_start,window_end FROM simplefin_sync_windows/.test(sql)) {
        const first = statement.first;
        statement.first = async () => {
          const result = await first();
          const n = ++selections;
          if (n === 1) { aSelected.resolve(); await bSelected.promise; }
          else if (n === 2) bSelected.resolve();
          return result;
        };
      }
      if (/UPDATE simplefin_connections SET\s+requests_today=/.test(sql)) for (const method of ["run", "first"]) {
        const execute = statement[method];
        statement[method] = async () => {
          reservations++;
          const n = statement.params[3] === now("2026-11-05") ? 1 : 2;
          if (n === 2) await aReserved.promise;
          const result = await execute();
          if (n === 1) { aReserved.resolve(); await bReserved.promise; }
          else {
            bReserved.resolve();
            if (phase !== "transport") await aDecision.promise;
          }
          return result;
        };
      }
      return statement;
    };
    return wrap(originalPrepare(sql));
  };
  const a = r.pull("2026-11-05", { beforeResponse: async () => { aResponse.resolve(); if (reverse && phase === "transport") await deliverA.promise; } });
  if (reverse) await aSelected.promise; else await a;
  // Change only the snapshot contents and delivery order. Both use real pulls.
  const b = r.pull(day("2026-11-05", overlapDays), {
    responseRows: [stable, newer],
    beforeResponse: async () => { await aResponse.promise; },
  });
  await aResponse.promise;
  rows.push(newer);
  const bResult = await b;
  deliverA.resolve();
  const aResult = await a;
  r.f.DB.prepare = originalPrepare;
  assert.equal(bResult.items[0]?.ok, true, `newer promotion succeeds: ${JSON.stringify(databaseErrors)}`);
  const calls = r.calls.slice(1);
  assert.equal(calls.length, 2, "both overlapping provider requests were dispatched");
  assert.ok(calls[0].from < calls[1].to && calls[1].from < calls[0].to, "requests overlap");
  assert.notDeepEqual([calls[0].from, calls[0].to], [calls[1].from, calls[1].to], "distinct window keys reached");
  assert.ok(r.f.seen.sql.some(sql => /Absent from verified SimpleFIN posted history/.test(sql)), "reconciliation write decision was reached");
  assert.equal(r.f.first("SELECT amount_minor FROM fin_transactions WHERE external_id='stable' AND removed_at IS NULL").amount_minor, 100, "stable positive control survives");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE external_id='posted-new' AND removed_at IS NULL").n, 1, "older overlap cannot withdraw newer posted money");
  assert.equal(r.f.first("SELECT sum(amount_minor) AS cents FROM fin_transactions WHERE removed_at IS NULL").cents, 12445, "independent inflow cents oracle");
  const reply = await (await withLedgerAnswer({ env: r.f.env, question: "How much money came in this month?",
    now: now("2026-11-06"), grantScope: { all: true }, scopePrincipalKind: "owner" }, async gap => Response.json({ answer: null, gaps: [gap] }))).json();
  if (reply.ledger?.total_minor !== undefined) assert.equal(reply.ledger.total_minor, 12445, "no proved answer may lose newer money");
  if (reverse) {
    if (phase !== "transport") assert.equal(delayedDecisions, 1, "the precise fenced ledger/withdrawal/promotion batch was reached");
    assert.equal(aResult.items[0].ok, false, "stale response reaches the ordered refusal decision");
    assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial", "conflicting snapshots keep coverage unproved");
    await r.pull("2026-11-08");
    await r.pull("2026-11-09");
    assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "exact stale-window retry recovers coverage");
    assert.equal((await payment(r.f, "2026-10-16", "0.01")).ledger?.found, false, "historical negative answer recovers after the exact retry");
  }
  return r;
}
for (const overlapDays of [1, 2]) for (const reverse of [false, true]) {
  test(`overlapping observation order delay=${reverse} days=${overlapDays}`, t => overlapReplay(t, product, { reverse, overlapDays }));
}
for (const phase of ["ledger", "withdrawal", "promotion"]) for (const reverse of [false, true]) {
  test(`overlapping observation fence at ${phase} delay=${reverse}`, t => overlapReplay(t, product, { phase, reverse }));
}
async function latestPositiveReplay(t, sf = product, removed = true) {
  const r = await fixture(t, { sf, start: "2026-10-01", rows: [{ id: "observed", posted: epoch("2026-10-16T12:00:00Z"), amount: "123.45" }] });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal((await payment(r.f, "2026-10-16")).ledger?.found, true, "same positive evidence green control");
  if (removed) r.f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='Absent from verified SimpleFIN posted history'", now("2026-11-05"));
  r.f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
  const before = r.f.seen.sql.length;
  await sf.promoteSimpleFinWindows(r.f.env, { itemRef: r.item, now: now("2026-11-05") });
  assert.ok(r.f.seen.sql.slice(before).some(sql => /AS coverage_guard/.test(sql)), "publication decision reached for each evidence arm");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, removed ? "partial" : "complete", "removed positive evidence cannot disappear from completeness admission");
}
for (const removed of [false, true]) test(`latest positive evidence checks removed=${removed}`, t => latestPositiveReplay(t, product, removed));
for (const absent of [false, true]) test(`newer absence supersedes older positive=${absent}`, async t => {
  const rows = [{ id: "posted", posted: epoch("2026-11-03T12:00:00Z"), amount: "123.45" }];
  const r = await fixture(t, { start: "2026-10-01", rows });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 1, "positive green control reached import");
  await r.pull("2026-11-05", { responseRows: absent ? [] : rows });
  assert.equal(r.calls.length, 2, "both overlapping complete observations reached reconciliation");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "legitimate latest snapshot is provable");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, absent ? 0 : 1);
});

async function sameClockReplay(t, sf = product, { reverse = true, delayedClaim = false } = {}) {
  const stable = { id: "stable", posted: epoch("2026-11-04T12:00:00Z"), amount: "1.00" };
  const newer = { id: "posted-new", posted: epoch("2026-11-05T12:00:00Z"), amount: "123.45" };
  const r = await fixture(t, { sf, start: "2026-10-01", rows: [stable] });
  await r.pull("2026-11-04"); await r.assign();
  const reached = deferred(), release = deferred();
  const prepare = r.f.DB.prepare;
  let reservations = 0;
  if (delayedClaim) r.f.DB.prepare = sql => {
    const wrap = statement => {
      const bind = statement.bind;
      statement.bind = (...values) => wrap(bind(...values));
      if (/UPDATE simplefin_connections SET\s+requests_today=/.test(sql)) {
        const first = statement.first;
        statement.first = async () => {
          const result = await first();
          if (++reservations === 1) { reached.resolve(); await release.promise; }
          return result;
        };
      }
      return statement;
    };
    return wrap(prepare(sql));
  };
  const a = r.pull("2026-11-05", { beforeResponse: async () => { reached.resolve(); if (reverse) await release.promise; } });
  await reached.promise;
  if (!reverse) {
    await a;
    r.f.raw("UPDATE simplefin_connections SET next_pull_at=?", now("2026-11-05"));
  }
  const b = await r.pull("2026-11-05", { responseRows: [stable, newer] });
  release.resolve();
  const old = await a;
  r.f.DB.prepare = prepare;
  assert.equal(b.items[0]?.ok, true, "same-clock newer observation promotes");
  assert.equal(r.f.first("SELECT sum(amount_minor) AS cents FROM fin_transactions WHERE removed_at IS NULL").cents, 12445, "same-clock ordinal preserves the independent cents oracle");
  assert.equal(r.calls.length, delayedClaim ? 2 : 3, "provider dispatch and claim decisions are distinguished");
  if (reverse) assert.equal(old.items[0]?.ok, false, "older revision is refused at the claim or write decision");
}
for (const reverse of [false, true]) test(`same-clock same-window response order delay=${reverse}`, t => sameClockReplay(t, product, { reverse }));
test("same-clock late claim cannot replace a newer window revision", t => sameClockReplay(t, product, { delayedClaim: true }));
test("daily green schedule and absent-account gap stay distinguishable", async t => {
  for (const omit of [false, true]) {
    const r = await fixture(t, { start: "2026-11-01" });
    await r.pull("2026-11-04"); await r.assign();
    await r.pull("2026-11-05", { omit });
    await r.pull("2026-11-08");
    assert.equal(r.calls.length, 3, "every gap/control request reached the provider");
    const coverage = r.f.first("SELECT * FROM fin_account_coverage");
    assert.equal(coverage.coverage_status, "complete");
    assert.equal(coverage.covered_from, omit ? "2026-11-06" : "2026-11-01", "an absent-account gap is never bridged");
    if (omit) assert.notEqual((await payment(r.f, "2026-11-05")).ledger?.found, false, "uncovered date cannot acquire a negative answer");
  }
});

async function legacyModule(t) {
  if (process.env.SIMPLEFIN_BASE_SOURCE) return moduleCopy(t, readFileSync(process.env.SIMPLEFIN_BASE_SOURCE, "utf8"), "pinned-base");
  // Reproduce the shipped staging contract in ordinary CI without requiring
  // Git history. The lane also runs this replay with the exact pinned module.
  let source = readFileSync(sourceUrl, "utf8").replace("if (transaction.pending === true) continue;", "");
  source = source.replace(/const revision = `\$\{POSTED_HISTORY_REVISION\}[^;]+;/, 'const revision = crypto.randomUUID();');
  source = source.replace('AND substr(revision,1,?)=?', 'AND (? IS NOT NULL OR ? IS NOT NULL)');
  source = source.replace('`${addDays(window.end, 1)}T00:00:00Z`', '`${window.end}T23:59:59Z`');
  return moduleCopy(t, source, "legacy-contract");
}

async function upgradeReplay(t, sf = product, pending = true, ids = ["hold-a", "settled-a"]) {
  const base = await legacyModule(t);
  const rows = [{ id: ids[0], posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00", pending },
    { id: "genuine", posted: epoch("2026-11-03T12:00:01Z"), amount: "-10.00", pending: false }];
  const r = await fixture(t, { sf: base, start: "2026-10-01", rows });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE pending=0 AND basis_state='confirmed'").n, 2,
    "shipped product promoted pending and genuine posted rows on the retained database");
  await sf.promoteSimpleFinWindows(r.f.env, { itemRef: r.item, now: now("2026-11-04") });
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial", "unversioned posted history cannot certify coverage");
  // Provider still reports the pending row on the first upgraded pull.
  await r.pull("2026-11-05", { using: sf });
  assert.equal(r.calls[1].from, r.calls[0].from, "old boundary window is re-fetched, not trusted");
  if (pending) rows.splice(0, 1, { id: ids[1], posted: epoch("2026-11-04T12:00:00Z"), amount: "-10.00", pending: false });
  await r.pull("2026-11-06", { using: sf });
  const active = r.f.rows("SELECT external_id,amount_minor FROM fin_transactions WHERE removed_at IS NULL ORDER BY external_id");
  assert.deepEqual(active.map(row => row.external_id).sort(), [pending ? ids[1] : ids[0], "genuine"].sort(), "only independently posted events remain active");
  assert.equal(active.reduce((n, row) => n + row.amount_minor, 0), 2000, "single settled purchase plus unchanged genuine row");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions").n, pending ? 3 : 2, "retired history is preserved");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete");
}
for (const [pending, ids] of [[true, ["hold-a", "settled-a"]], [true, ["opaque-19", "opaque-2"]], [false, ["unchanged", "unused"]]]) {
  test(`retained database upgrade pending=${pending} id=${ids[0]}`, t => upgradeReplay(t, product, pending, ids));
}
test("upgrade re-fetches the legacy exclusive-end gap before an affirmative payment answer", async t => {
  const base = await legacyModule(t);
  const r = await fixture(t, { sf: base, start: "2024-11-05", end: "2025-02-10", rows: [
    { id: "before", posted: epoch("2025-02-02T23:59:58Z"), amount: "1.00" },
    { id: "edge", posted: epoch("2025-02-02T23:59:59Z"), amount: "123.45" },
    { id: "next", posted: epoch("2025-02-03T00:00:00Z"), amount: "2.00" },
  ] });
  await r.pull("2025-02-10"); await r.assign();
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE external_id='before'").n, 1, "legacy green boundary row reached");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE external_id='edge'").n, 0, "legacy endpoint omitted the final second");
  await product.promoteSimpleFinWindows(r.f.env, { itemRef: r.item, now: now("2025-02-10") });
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial");
  await r.pull("2025-02-11", { using: product });
  await r.pull("2025-02-12", { using: product });
  assert.equal(r.calls.length, 3, "old request, exact repair and following request were dispatched");
  assert.equal(r.calls[1].from, r.calls[0].from);
  assert.equal(r.calls[1].to, epoch("2025-02-03T00:00:00Z"));
  assert.deepEqual(r.f.rows("SELECT external_id FROM fin_transactions WHERE removed_at IS NULL ORDER BY external_id").map(row => row.external_id), ["before", "edge", "next"]);
  assert.equal((await payment(r.f, "2025-02-02")).ledger?.found, true);
});

for (const fault of ["fail", "partial", "unread", "omit"]) test(`upgrade preserves old rows on ${fault} instead of inferring a withdrawal`, async t => {
  const base = await legacyModule(t);
  const rows = [{ id: "opaque", posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00", pending: true },
    { id: "genuine", posted: epoch("2026-11-03T12:00:01Z"), amount: "-10.00", pending: false }];
  const r = await fixture(t, { sf: base, start: "2026-10-01", rows });
  await r.pull("2026-11-04"); await r.assign();
  await r.pull("2026-11-05", { using: product, [fault]: true });
  assert.equal(r.calls.length, 2, "refusal reached the replacement response");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 2, "incomplete evidence cannot retire history");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial");
  await r.pull("2026-11-06", { using: product });
  if (fault !== "omit") {
    assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 1, "same complete-response green control reconciles exactly");
    assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete");
  } else assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial", "a real absent-account gap stays unproved");
});
test("clean posted install controls the upgrade oracle", async t => {
  const r = await fixture(t, { rows: [{ id: "posted", posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00" }] });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.f.rows("SELECT external_id,amount_minor FROM fin_transactions WHERE removed_at IS NULL").map(row => [row.external_id, row.amount_minor]), [["posted", 1000]]);
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete");
});

async function pendingStateReplay(t, sf = product, pending = "true") {
  const rows = [{ id: "opaque", posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00", pending }];
  const r = await fixture(t, { sf, rows });
  const refused = await r.pull("2026-11-04");
  assert.equal(r.calls.length, 1, "unknown pending state reached the real provider response");
  assert.equal(refused.items[0].ok, false, "unknown pending evidence cannot be asserted posted");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions").n, 0);
  rows[0].pending = false;
  await r.pull("2026-11-05"); await r.assign();
  assert.equal(r.calls.length, 2, "same window is retried with only the pending field corrected");
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 1);
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete");
}
for (const pending of ["true", 1, null, {}]) test(`unknown pending state ${JSON.stringify(pending)} fails closed`, t => pendingStateReplay(t, product, pending));

test("legacy epoch-zero pending history stays visible and partial beyond a proved recovery interval", async t => {
  const base = await legacyModule(t);
  const r = await fixture(t, { sf: base, rows: [
    { id: "opaque", posted: 0, amount: "-10.00", pending: true },
    { id: "genuine", posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00", pending: false },
  ] });
  await r.pull("2026-11-04"); await r.assign();
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE posted_on='1970-01-01'").n, 1, "actual legacy corruption reached promotion");
  await r.pull("2026-11-05", { using: product });
  assert.equal(r.calls.length, 2);
  assert.equal(r.f.first("SELECT count(*) AS n FROM fin_transactions WHERE removed_at IS NULL").n, 2, "out-of-bound history is retained for explicit recovery");
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "partial", "unexplained active history cannot acquire complete coverage");
  const green = await fixture(t, { rows: [{ id: "genuine", posted: epoch("2026-11-03T12:00:00Z"), amount: "-10.00", pending: false }] });
  await green.pull("2026-11-04"); await green.assign();
  assert.equal(green.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "same posted evidence without unexplained legacy row is complete");
});

for (const [field, value] of [["state", "staged"], ["staging_revision", "racing-response"], ["errlist_json", '["gap"]']]) {
  test(`reader refuses a retained complete receipt with unresolved ${field}`, async t => {
    const r = await fixture(t, { start: "2026-10-01" });
    await r.pull("2026-11-04"); await r.assign();
    assert.equal((await payment(r.f, "2026-10-16")).ledger?.found, false, "same covered-empty green control");
    r.f.raw(`UPDATE simplefin_sync_windows SET ${field}=?`, value);
    assert.notEqual((await payment(r.f, "2026-10-16")).ledger?.found, false, "incomplete receipt reached read admission");
  });
}

for (const revision of ["unversioned-receipt", "legacy", "posted-history-999:unknown"]) test(`reader refuses retained complete coverage from ${revision}`, async t => {
  const r = await fixture(t, { start: "2026-10-01" });
  await r.pull("2026-11-04"); await r.assign();
  const green = await payment(r.f, "2026-10-16");
  assert.equal(green.ledger?.found, false, "modern complete empty-history green control reaches a certified negative");
  r.f.raw("UPDATE simplefin_sync_windows SET revision=?,staging_revision=?", revision, revision);
  assert.equal(r.f.first("SELECT coverage_status FROM fin_account_coverage").coverage_status, "complete", "retained old completeness is present before maintenance");
  const before = r.f.seen.sql.length;
  const refused = await payment(r.f, "2026-10-16");
  assert.notEqual(refused.ledger?.found, false, "old evidence cannot authorize a negative before its first maintenance");
  assert.ok(r.f.seen.sql.slice(before).every(sql => !/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)), "read admission performs no repair writes");
});

for (const ledger of [undefined, { kind: "merchant", total_minor: 100 }, { kind: "refunds", total_minor: 0 }]) {
  test(`refund scorer refuses fabricated totals with ${ledger?.kind || "unstructured"} evidence`, () => {
    const book = moneyBook(), oracle = oracleFor(book);
    for (const text of ["Refunds total $1.00", "Refunds total 1 dollar", "Refunds total zero dollars"]) {
      const bad = scoreAnswer("refunds", { answer: text, ledger }, book, oracle);
      const good = scoreAnswer("refunds", { answer: null, gaps: [{ reason: "refund identity unproved" }] }, book, oracle);
      assert.equal(bad.decision, "refunds", "fabricated answer reached refund scoring decision");
      assert.equal(good.decision, "refunds", "green refusal reached the same decision");
      assert.equal(bad.score, "WRONG"); assert.equal(good.score, "honest-refusal");
    }
  });
}

test("new parity fixture sources contain no complete authenticated URL literal", () => {
  for (const path of [new URL("./simplefin-parity-guards.test.mjs", import.meta.url), new URL("./fixtures/simplefin-parity.mjs", import.meta.url)]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /new Response\(/, "runtime provider response control remains present");
    assert.doesNotMatch(source, /https:\/\/[^\s/"'`]+:[^\s/"'`]+@/, "assemble synthetic URL credentials at runtime");
  }
});

for (const [id, before, after, replay, failure] of [
  ["restore-moving-window-only-progress", 'const start = next < addDays(end, -2) ? next : addDays(end, -2);', 'const start = addDays(end, -2);', delayedRecovery, /outstanding history/],
  ["remove-overlapping-observation-fence", 'function observationFence() {', 'function observationFence() { return "1";', overlapReplay, /older overlap cannot withdraw/],
  ["hide-removed-positive-evidence", 'WHERE s.tenant_id=fin_account_coverage.tenant_id AND s.item_ref=? AND x.account_ref=?', 'WHERE 0 AND s.tenant_id=fin_account_coverage.tenant_id AND s.item_ref=? AND x.account_ref=?', latestPositiveReplay, /removed positive evidence/],
  ["allow-late-lower-order-claim", 'WHERE excluded.staging_revision>simplefin_sync_windows.staging_revision', 'WHERE 1', (t, sf) => sameClockReplay(t, sf, { delayedClaim: true }), /independent cents oracle/],
  ["restore-last-second-endpoint", '`${addDays(window.end, 1)}T00:00:00Z`', '`${window.end}T23:59:59Z`', boundaryReplay, /exclusive endpoint/],
  ["abandon-failed-daily-window", 'if (retry) return', 'if (false && retry) return', recoveryReplay, /oldest failed interval/],
  ["trust-unversioned-history", 'export const POSTED_HISTORY_REVISION = SIMPLEFIN_POSTED_HISTORY_REVISION;', 'export const POSTED_HISTORY_REVISION = "";', upgradeReplay, /unversioned posted history/],
  ["skip-posted-reconciliation", 'if (!unread && window.errlist_json === "[]"', 'if (false && !unread && window.errlist_json === "[]"', upgradeReplay, /only independently posted events/],
  ["accept-unknown-pending-state", 'if (Object.hasOwn(transaction, "pending")', 'if (false && Object.hasOwn(transaction, "pending")', pendingStateReplay, /unknown pending evidence/],
]) test(`recovery oracle kills ${id}`, async t => {
  await replay(t, product);
  const original = readFileSync(sourceUrl, "utf8");
  assert.equal(original.split(before).length, 2, "mutation reaches exactly one live product decision");
  const source = original.replace(before, after);
  const mutant = await moduleCopy(t, source, id);
  await assert.rejects(replay(t, mutant), failure, "same oracle turns red while green product control passed");
  mutants.push({ id, killed: true, original_sha256: createHash("sha256").update(original).digest("hex"),
    mutant_sha256: createHash("sha256").update(source).digest("hex") });
});

test("refund oracle kills restore-pattern-based-activation", async t => {
  const origin = new URL("./fixtures/simplefin-parity.mjs", import.meta.url);
  const original = readFileSync(origin, "utf8");
  const before = 'if (group === "refunds") return';
  assert.equal(original.split(before).length, 2);
  const source = original.replace(before, 'if (group === "refunds" && /^Refunds total \\$/i.test(body.answer || "")) return');
  const mutant = await moduleCopy(t, source, "pattern-refund", origin);
  const book = moneyBook(), oracle = oracleFor(book);
  const fabricated = { answer: "Refunds total zero dollars" }, refused = { answer: null };
  assert.equal(scoreAnswer("refunds", fabricated, book, oracle).score, "WRONG");
  assert.equal(scoreAnswer("refunds", refused, book, oracle).score, "honest-refusal");
  assert.equal(mutant.scoreAnswer("refunds", refused, book, oracle).score, "honest-refusal", "green genuine refusal still passes");
  assert.notEqual(mutant.scoreAnswer("refunds", fabricated, book, oracle).score, "WRONG", "pattern mutant bypasses the asserted-figure decision");
  mutants.push({ id: "restore-pattern-based-refund-activation", killed: true,
    original_sha256: createHash("sha256").update(original).digest("hex"), mutant_sha256: createHash("sha256").update(source).digest("hex") });
});

test("reader oracle kills trust-retained-coverage-before-maintenance", async t => {
  const origin = new URL("../src/lib/ledger-reader.js", import.meta.url);
  const original = readFileSync(origin, "utf8");
  const before = 'OR EXISTS (SELECT 1 FROM simplefin_account_assignments x';
  assert.equal(original.split(before).length, 2);
  const source = original.replace(before, 'OR 0 AND EXISTS (SELECT 1 FROM simplefin_account_assignments x');
  const mutant = await moduleCopy(t, source, "legacy-read-admission", origin);
  const r = await fixture(t, { start: "2026-10-01" });
  await r.pull("2026-11-04"); await r.assign();
  const covered = async module => module.effectivePeriodCovered((await module.readEffectiveAccounts(r.f.env))[0], "2026-10-01", "2026-10-31");
  assert.equal(await covered(reader), true);
  assert.equal(await covered(mutant), true, "modern green control passes both products");
  r.f.raw("UPDATE simplefin_sync_windows SET revision='legacy',staging_revision='legacy'");
  assert.equal(await covered(reader), false, "old receipts reach the closed read decision");
  assert.equal(await covered(mutant), true, "mutant incorrectly trusts old completeness");
  mutants.push({ id: "trust-retained-coverage-before-maintenance", killed: true,
    original_sha256: createHash("sha256").update(original).digest("hex"), mutant_sha256: createHash("sha256").update(source).digest("hex") });
});

test("fixture scanner kills reintroduce-authenticated-url-literal", () => {
  const pattern = /https:\/\/[^\s/"'`]+:[^\s/"'`]+@/;
  for (const origin of [new URL("./fixtures/simplefin-parity.mjs", import.meta.url), new URL("./simplefin-parity-guards.test.mjs", import.meta.url)]) {
    const original = readFileSync(origin, "utf8");
    assert.doesNotMatch(original, pattern, "green source has no complete authenticated literal");
    const url = new URL("https://bridge.example.invalid/simplefin/fixture");
    url.username = "fixture-user"; url.password = "fixture-pass";
    assert.equal(original.split("new Response(access.href)").length, 2, "same runtime response decision reached");
    const source = original.replace("new Response(access.href)", `new Response(${JSON.stringify(url.href)})`);
    assert.throws(() => assert.doesNotMatch(source, pattern), assert.AssertionError, "same scanner rejects the avoidable literal");
  }
  mutants.push({ id: "reintroduce-authenticated-url-literal", killed: true });
});
