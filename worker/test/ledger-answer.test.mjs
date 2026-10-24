import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { classifyLedgerQuestion } from "../src/lib/ledger-question.js";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { readEffectiveAccounts, readEffectiveBalances, readEffectiveTransactions } from "../src/lib/ledger-reader.js";
import * as retrievalStatus from "../src/lib/retrieval-status.js";

import { linkAccounts } from "./fixtures/money-fix/fixture.mjs";

const NOW = "2026-10-11T12:00:00.000Z";
const stamp = "2026-10-11T10:00:00.000Z";
test.before(() => mock.method(Date, "now", () => Date.parse(NOW)));
test.after(() => mock.restoreAll());
const fallback = async () => new Response(JSON.stringify({ answer: null, citations: [], gaps: [] }));
const direct = (f, question, extra = {}) => withLedgerAnswer({ env: f.env, question,
  grantScope: { all: true }, scopePrincipalKind: "owner", now: NOW, ...extra }, fallback).then(r => r.json());

async function importLedgerAnswerMutant(from, to) {
  const url = new URL("../src/lib/ledger-answer.js", import.meta.url);
  const original = readFileSync(url, "utf8");
  assert.equal(original.includes(from), true, `mutation marker exists: ${from.slice(0, 80)}`);
  const source = original.replace(from, to).replace(/from "(\.\/[^\"]+)"/g,
    (_match, specifier) => `from "${new URL(specifier, url).href}"`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${randomBytes(8).toString("hex")}`);
}

async function fixtureFor(t) {
  const fixture = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"),
    SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    RAG_PROXY_KEY: randomBytes(24).toString("hex"),
    AI: { async run(model) {
      if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
      return { response: "The documents do not answer the question." };
    } },
  } });
  t.after(() => fixture.close());
  seedOwnedEntity(fixture, "owner-company", "Owner Company");
  fixture.raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed','Fixture Bank',?,?,'sandbox',?,?)`,
  randomBytes(32).toString("base64"), randomBytes(12).toString("base64"), stamp, stamp);
  for (const [slug, mode, start, end] of [
    ["manual-account", "manual", "2026-08-01", "2026-09-30"],
    ["live-account", "live", "2026-09-01", "2026-10-11"],
  ]) {
    fixture.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at,institution)
      VALUES (?,'owner-company','checking','asset','4321',?,'feed','bank-feed:fixture-feed','confirmed',?,'Fixture Bank')`, slug, mode, stamp);
    fixture.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES (?,'complete',?,?,?,'owner_stated','confirmed',?)`, slug, start, end, stamp, stamp);
  }
  const add = (id, account, date, cents, direction = "inflow", description = "Fixture payer deposit") => fixture.raw(
    `INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,source_feed,basis_state,recorded_at)
      VALUES (?,?,?,?,?,?,'feed','bank-feed:fixture-feed','confirmed',?)`, id, account, date, cents, direction, description, stamp);
  add("older-manual", "manual-account", "2026-08-31", 1100);
  add("duplicate-manual", "manual-account", "2026-09-15", 12001);
  add("live-deposit", "live-account", "2026-09-15", 12001);
  add("live-debit", "live-account", "2026-09-16", 2300, "outflow", "Fixture transfer");
  fixture.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,source_feed,basis_state,recorded_at)
    VALUES ('live-account','2026-10-11',98765,98000,'feed','bank-feed:fixture-feed','confirmed',?)`, stamp);
  fixture.ask = (q, extra = {}, headers = { "X-Admin-Key": fixture.env.ADMIN_KEY }) =>
    fixture.post("/api/rag/think", { q, ...extra }, headers);
  fixture.add = add;
  await linkAccounts(fixture);
  return fixture;
}

test("Think reads the latest balance directly, with ledger citation and no model call", async (t) => {
  const f = await fixtureFor(t);
  let modelCalls = 0;
  f.env.AI.run = async () => { modelCalls++; throw new Error("model must not draft money"); };
  const response = await f.ask("What is my current balance?");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.answer || "", /987\.65/);
  assert.match(body.answer, /2026-10-11/);
  assert.equal(body.citations[0].source_kind, "ledger");
  assert.equal(body.citations[0].last_synced_at, stamp);
  assert.equal(body.citations[0].account_mask, "4321");
  assert.equal(modelCalls, 0);
});

test("current-balance answers apply the 48-hour and 14-day source-freshness boundaries", async (t) => {
  const cases = [
    ["fresh control", 60 * 60 * 1000, false, false],
    ["just under 48 hours", 2 * 86400000 - 1, false, false],
    ["exactly 48 hours", 2 * 86400000, true, false],
    ["exactly 14 days", 14 * 86400000, true, false],
    ["over 14 days", 14 * 86400000 + 1, true, true],
  ];
  for (const [label, age, sideNote, prefix] of cases) {
    await t.test(label, async (t) => {
      const f = await fixtureFor(t);
      const observed = new Date(Date.parse(NOW) - age).toISOString();
      f.raw("UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref='fixture-feed'", observed);
      f.raw("UPDATE fin_balance_snapshots SET as_of_date=? WHERE account_slug='live-account'", observed.slice(0, 10));
      const before = f.seen.sql.filter((sql) => /JOIN fin_balance_snapshots/.test(sql)).length;
      const body = await (await f.ask("What is my current balance?")).json();
      assert.ok(f.seen.sql.filter((sql) => /JOIN fin_balance_snapshots/.test(sql)).length > before,
        "the real /think balance decision read the selected snapshot");
      assert.equal(body.ledger?.kind, "balance");
      assert.equal(Boolean(body.side_note), sideNote);
      assert.equal(/^As of \d{4}-\d{2}-\d{2},/.test(body.answer || ""), prefix);
      if (sideNote) assert.match(body.side_note, /bank ledger has not refreshed since/i);
    });
  }
});

test("restoring the current-balance freshness skip is observable", async (t) => {
  const mutant = await importLedgerAnswerMutant(
    "  const observations = [...liveObservations, ...(Array.isArray(balances)",
    "  const observations = [...[], ...(Array.isArray(balances)",
  );
  const f = await fixtureFor(t);
  const observed = new Date(Date.parse(NOW) - 5 * 86400000).toISOString();
  f.raw("UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref='fixture-feed'", observed);
  f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
    VALUES ('manual-account','2026-10-11',54321,54000,'owner_stated','confirmed',?)`,
  "2026-10-11T11:00:00.000Z");
  const args = { env: f.env, question: "What is my current balance?", now: NOW,
    grantScope: { all: true }, scopePrincipalKind: "owner" };
  const skipped = await (await mutant.withLedgerAnswer(args, fallback)).json();
  const fixed = await (await withLedgerAnswer(args, fallback)).json();
  assert.equal(skipped.ledger?.kind, "balance", "the selected-row-only mutant still reached the balance branch");
  assert.match(skipped.answer || "", /\$543\.21/, "the mutant selected the same manual amount");
  assert.equal(skipped.side_note, undefined);
  assert.match(fixed.side_note || "", /bank ledger has not refreshed since/i,
    "the current-balance freshness skip restored mutant is killed");
});

test("a live ledger without a completed sync refuses balances and transactions", async (t) => {
  for (const [label, question, decisionRead, forbiddenMoneyRead] of [
    ["balance", "What is my current balance?", /JOIN fin_balance_snapshots/, null],
    ["transactions", "How much money came in September 2026?", /FROM fin_accounts/, /CROSS JOIN fin_transactions/],
  ]) {
    await t.test(label, async (t) => {
      const refusedFixture = await fixtureFor(t);
      refusedFixture.raw("UPDATE bank_feed_items SET last_synced_at=NULL WHERE item_ref='fixture-feed'");
      const before = refusedFixture.seen.sql.length;
      const refused = await direct(refusedFixture, question);
      const refusalReads = refusedFixture.seen.sql.slice(before);
      assert.ok(refusalReads.some((sql) => decisionRead.test(sql)),
        `${label}: the real ledger decision read was reached`);
      if (forbiddenMoneyRead) assert.equal(refusalReads.some((sql) => forbiddenMoneyRead.test(sql)), false,
        `${label}: no transaction amount was read after the missing-sync decision`);
      assert.equal(refused.answer, null);
      assert.equal(refused.coverage_classification, "catastrophic");
      assert.equal(refused.gaps[0]?.reason, "live_feed_never_synced");

      const freshFixture = await fixtureFor(t);
      const fresh = await direct(freshFixture, question);
      assert.ok(fresh.answer, `${label}: the fresh-live control differs only in last_synced_at`);
      assert.equal(fresh.evidence_gate?.supported, true);
    });
  }

  await t.test("manual date-only control", async (t) => {
    const f = await createProductFixture({ env: { BRAIN_TIMEZONE: "America/Phoenix" } });
    t.after(() => f.close());
    seedOwnedEntity(f, "owner", "Owner");
    f.raw(`INSERT INTO fin_accounts
      (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
      VALUES ('manual','owner','checking','asset','4321','manual','owner_stated','confirmed',?,'Fixture Bank')`,
    "2026-09-30T12:00:00.000Z");
    f.raw(`INSERT INTO fin_account_coverage
      (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
      VALUES ('manual','complete','2026-09-01','2026-09-30',?,'owner_stated','confirmed',?)`,
    "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
    f.raw(`INSERT INTO fin_balance_snapshots
      (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
      VALUES ('manual','2026-09-30',98765,98000,'owner_stated','confirmed',?)`,
    "2026-09-30T12:00:00.000Z");
    f.raw(`INSERT INTO fin_transactions
      (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
      VALUES ('deposit','manual','2026-09-15',12001,'inflow','Fixture deposit','owner_stated','confirmed',?)`,
    "2026-09-30T12:00:00.000Z");
    const balance = await direct(f, "What is my current balance?", { now: "2026-10-01T12:00:00.000Z" });
    const transactions = await direct(f, "How much money came in September 2026?", { now: "2026-10-01T12:00:00.000Z" });
    assert.equal(balance.ledger?.kind, "balance", "the manual selected balance remains eligible without a sync timestamp");
    assert.equal(transactions.ledger?.kind, "totals", "manual covered rows remain eligible without a sync timestamp");
    assert.match(balance.answer || "", /\$987\.65/);
    assert.match(transactions.answer || "", /\$120\.01/);
  });
});

test("a selected manual balance cannot hide a never-synced live member in its approved pair", async (t) => {
  const addNewerManualBalance = (f) => f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
    VALUES ('manual-account','2026-10-11',54321,54000,'owner_stated','confirmed',?)`,
  "2026-10-11T11:00:00.000Z");

  const refusedFixture = await fixtureFor(t);
  addNewerManualBalance(refusedFixture);
  refusedFixture.raw("UPDATE bank_feed_items SET last_synced_at=NULL WHERE item_ref='fixture-feed'");
  const refusedAccounts = await readEffectiveAccounts(refusedFixture.env);
  const selectedManual = await readEffectiveBalances(refusedFixture.env, refusedAccounts);
  assert.equal(selectedManual.length, 1, "the real balance reader returned a decision row");
  assert.equal(selectedManual[0].source_account_slug, "manual-account",
    "the newer manual snapshot won inside the approved pair");
  const before = refusedFixture.seen.sql.length;
  const refused = await direct(refusedFixture, "What is my current balance?");
  const refusalReads = refusedFixture.seen.sql.slice(before);
  assert.ok(refusalReads.some((sql) => /JOIN fin_balance_snapshots/.test(sql)),
    "the real linked-pair balance decision was reached");
  assert.equal(refused.answer, null);
  assert.equal(refused.coverage_classification, "catastrophic");
  assert.equal(refused.gaps[0]?.reason, "live_feed_never_synced");
  assert.doesNotMatch(JSON.stringify(refused), /543\.21/,
    "the selected manual amount was not returned after the live-member refusal");

  const freshFixture = await fixtureFor(t);
  addNewerManualBalance(freshFixture);
  const freshAccounts = await readEffectiveAccounts(freshFixture.env);
  const freshSelected = await readEffectiveBalances(freshFixture.env, freshAccounts);
  assert.equal(freshSelected[0]?.source_account_slug, "manual-account",
    "the green control selects the same manual snapshot");
  const fresh = await direct(freshFixture, "What is my current balance?");
  assert.equal(fresh.ledger?.kind, "balance",
    "a completed live sync keeps the otherwise identical approved pair eligible");
  assert.match(fresh.answer || "", /\$543\.21/);
  assert.equal(fresh.evidence_gate?.supported, true);
});

test("a selected manual balance retains every approved live member's freshness", async (t) => {
  const cases = [
    ["fresh control", 60 * 60 * 1000, false, false],
    ["just under 48 hours", 2 * 86400000 - 1, false, false],
    ["exactly 48 hours", 2 * 86400000, true, false],
    ["five days", 5 * 86400000, true, false],
    ["exactly 14 days", 14 * 86400000, true, false],
    ["just over 14 days", 14 * 86400000 + 1, true, true],
    ["twenty days", 20 * 86400000, true, true],
    ["sixty days", 60 * 86400000, true, true],
  ];
  for (const [label, age, sideNote, prefix] of cases) {
    await t.test(label, async (t) => {
      const f = await fixtureFor(t);
      f.raw(`INSERT INTO fin_balance_snapshots
        (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
        VALUES ('manual-account','2026-10-11',54321,54000,'owner_stated','confirmed',?)`,
      "2026-10-11T11:00:00.000Z");
      const observed = new Date(Date.parse(NOW) - age).toISOString();
      f.raw("UPDATE bank_feed_items SET last_synced_at=? WHERE item_ref='fixture-feed'", observed);
      const accounts = await readEffectiveAccounts(f.env);
      const selected = await readEffectiveBalances(f.env, accounts);
      assert.equal(selected[0]?.source_account_slug, "manual-account",
        `${label}: the newer manual observation supplied the amount`);
      const before = f.seen.sql.filter((sql) => /JOIN fin_balance_snapshots/.test(sql)).length;
      const body = await direct(f, "What is my current balance?");
      assert.ok(f.seen.sql.filter((sql) => /JOIN fin_balance_snapshots/.test(sql)).length > before,
        `${label}: the real balance decision was reached`);
      assert.equal(body.ledger?.kind, "balance");
      assert.match(body.answer || "", /\$543\.21/);
      assert.equal(Boolean(body.side_note), sideNote, `${label}: live-member note boundary`);
      assert.equal(/^As of \d{4}-\d{2}-\d{2},/.test(body.answer || ""), prefix,
        `${label}: live-member prefix boundary`);
      if (sideNote) assert.match(body.side_note, /bank ledger has not refreshed since/i);
    });
  }
});

test("the missing live-sync refusal guard mutant is killed", async (t) => {
  const mutant = await importLedgerAnswerMutant(
    "  if (neverSyncedLive.length) {",
    "  if (false && neverSyncedLive.length) {",
  );
  const f = await fixtureFor(t);
  f.raw("UPDATE bank_feed_items SET last_synced_at=NULL WHERE item_ref='fixture-feed'");
  const args = { env: f.env, question: "What is my current balance?", now: NOW,
    grantScope: { all: true }, scopePrincipalKind: "owner" };
  const fixed = await (await withLedgerAnswer(args, fallback)).json();
  const unguarded = await (await mutant.withLedgerAnswer(args, fallback)).json();
  assert.equal(fixed.gaps[0]?.reason, "live_feed_never_synced");
  assert.equal(unguarded.ledger?.kind, "balance", "the guard-drop mutant returns the selected live amount");
  assert.notDeepEqual(unguarded, fixed, "the missing live-sync guard is observable");
});

test("the selected-balance-only live-sync mutant is killed", async (t) => {
  const accountInventoryScan = `  const neverSyncedLive = accounts.flatMap((account) => account.members || [account])
    .filter((member) => member.feed_mode === "live" && instant(member.last_synced_at) === null);`;
  const selectedRowsScan = `  const neverSyncedLive = balances === null
    ? accounts.filter((account) => account.feed_mode === "live" && instant(account.last_synced_at) === null)
    : balances.filter((row) => Number(row?.source_is_live) === 1 && instant(row?.last_synced_at) === null);`;
  const mutant = await importLedgerAnswerMutant(accountInventoryScan, selectedRowsScan);
  const f = await fixtureFor(t);
  f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
    VALUES ('manual-account','2026-10-11',54321,54000,'owner_stated','confirmed',?)`,
  "2026-10-11T11:00:00.000Z");
  f.raw("UPDATE bank_feed_items SET last_synced_at=NULL WHERE item_ref='fixture-feed'");
  const args = { env: f.env, question: "What is my current balance?", now: NOW,
    grantScope: { all: true }, scopePrincipalKind: "owner" };
  const fixed = await (await withLedgerAnswer(args, fallback)).json();
  const selectedOnly = await (await mutant.withLedgerAnswer(args, fallback)).json();
  assert.equal(fixed.gaps[0]?.reason, "live_feed_never_synced");
  assert.equal(selectedOnly.ledger?.kind, "balance",
    "the selected-row-only mutant returned the manual snapshot");
  assert.match(selectedOnly.answer || "", /\$543\.21/);
  assert.notDeepEqual(selectedOnly, fixed, "the selected-balance-only live-sync mutant is observable");
});

test("manual ledger coverage keeps its date-only boundary in negative, zero and positive owner offsets", async (t) => {
  for (const timeZone of ["America/Phoenix", "UTC", "Asia/Tokyo"]) {
    await t.test(timeZone, async (t) => {
      const f = await createProductFixture({ env: { BRAIN_TIMEZONE: timeZone } });
      t.after(() => f.close());
      seedOwnedEntity(f, "owner", "Owner");
      f.raw(`INSERT INTO fin_accounts
        (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
        VALUES ('manual','owner','checking','asset','4321','manual','owner_stated','confirmed',?,'Fixture Bank')`,
      "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_account_coverage
        (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES ('manual','complete','2026-01-01','2026-09-30',?,'owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_balance_snapshots
        (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
        VALUES ('manual','2026-09-30',98765,98000,'owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_transactions
        (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
        VALUES ('deposit','manual','2026-09-15',12001,'inflow','Fixture deposit','owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z");
      const body = await direct(f, "How much money came in September 2026?", {
        now: "2026-10-20T12:00:00.000Z",
      });
      assert.equal(body.ledger?.kind, "totals", "the manual-account coverage fallback was reached");
      assert.match(body.answer || "", /^As of 2026-09-30,/,
        `${timeZone}: the prefix retains the ledger calendar day`);
      assert.match(body.side_note || "", /since Wed Sep 30/,
        `${timeZone}: the side note retains the ledger calendar day`);
      assert.doesNotMatch(`${body.answer}\n${body.side_note}`, /Oct 1/,
        `${timeZone}: the boundary never shifts to the next day`);
      if (timeZone === "Asia/Tokyo") {
        const mutant = await importLedgerAnswerMutant(
          '    const day = /^\\d{4}-\\d{2}-\\d{2}$/.test(account.covered_to || "") ? account.covered_to : null;\n    const observed = coverageCalendarDayEnd(day, timeZone);\n    return observed === null ? null : { instant: observed, value: new Date(observed).toISOString(), calendarDay: day };',
          '    const observed = instant(account.covered_to ? `${account.covered_to}T23:59:59.999Z` : null);\n    return observed === null ? null : { instant: observed, value: new Date(observed).toISOString(), calendarDay: null };',
        );
        const shifted = await (await mutant.withLedgerAnswer({ env: f.env,
          question: "How much money came in September 2026?", now: "2026-10-20T12:00:00.000Z",
          grantScope: { all: true }, scopePrincipalKind: "owner" }, fallback)).json();
        assert.equal(shifted.ledger?.kind, "totals", "the date-shift mutant reached the manual ledger branch");
        assert.match(shifted.answer || "", /^As of 2026-10-01,/,
          "restoring the UTC end-of-day conversion shifts the positive-offset control");
        assert.notEqual(shifted.answer, body.answer, "the date-only boundary shifted by one day mutant is killed");
      }
    });
  }
});

test("manual date-only freshness starts at owner-local end of day", async (t) => {
  const thresholdCases = [
    ["before 48 hours", 2 * 86400000 - 1, false, false],
    ["at 48 hours", 2 * 86400000, true, false],
    ["after 48 hours", 2 * 86400000 + 1, true, false],
    ["before 14 days", 14 * 86400000 - 1, true, false],
    ["at 14 days", 14 * 86400000, true, false],
    ["after 14 days", 14 * 86400000 + 1, true, true],
  ];
  for (const [timeZone, dayEnd] of [
    ["America/Phoenix", Date.parse("2026-10-01T06:59:59.999Z")],
    ["UTC", Date.parse("2026-09-30T23:59:59.999Z")],
    ["Asia/Tokyo", Date.parse("2026-09-30T14:59:59.999Z")],
  ]) {
    await t.test(timeZone, async (t) => {
      const f = await createProductFixture({ env: { BRAIN_TIMEZONE: timeZone } });
      t.after(() => f.close());
      seedOwnedEntity(f, "owner", "Owner");
      f.raw(`INSERT INTO fin_accounts
        (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
        VALUES ('manual','owner','checking','asset','4321','manual','owner_stated','confirmed',?,'Fixture Bank')`,
      "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_account_coverage
        (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
        VALUES ('manual','complete','2026-09-01','2026-09-30',?,'owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_balance_snapshots
        (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
        VALUES ('manual','2026-09-30',98765,98000,'owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z");
      f.raw(`INSERT INTO fin_transactions
        (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,basis_state,recorded_at)
        VALUES ('deposit','manual','2026-09-15',12001,'inflow','Fixture deposit','owner_stated','confirmed',?)`,
      "2026-09-30T12:00:00.000Z");

      for (const [label, age, sideNote, prefix] of thresholdCases) {
        const now = new Date(dayEnd + age).toISOString();
        for (const [route, question] of [
          ["balance", "What is my current balance?"],
          ["transactions", "How much money came in September 2026?"],
        ]) {
          const body = await direct(f, question, { now });
          assert.ok(body.ledger, `${timeZone} ${route} ${label}: the manual ledger decision was reached`);
          assert.equal(Boolean(body.side_note), sideNote, `${timeZone} ${route} ${label}: side-note boundary`);
          assert.equal(/^As of 2026-09-30,/.test(body.answer || ""), prefix,
            `${timeZone} ${route} ${label}: as-of boundary`);
        }
      }
    });
  }
});

test("the UTC-midnight date-only freshness mutant is killed", async (t) => {
  const mutant = await importLedgerAnswerMutant(
    "    const observed = coverageCalendarDayEnd(day, timeZone);",
    "    const observed = instant(day);",
  );
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: "America/Phoenix" } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,basis_state,recorded_at,institution)
    VALUES ('manual','owner','checking','asset','4321','manual','owner_stated','confirmed',?,'Fixture Bank')`,
  "2026-09-30T12:00:00.000Z");
  f.raw(`INSERT INTO fin_account_coverage
    (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('manual','complete','2026-09-01','2026-09-30',?,'owner_stated','confirmed',?)`,
  "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z");
  f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,available_minor,provenance,basis_state,recorded_at)
    VALUES ('manual','2026-09-30',98765,98000,'owner_stated','confirmed',?)`,
  "2026-09-30T12:00:00.000Z");
  const args = { env: f.env, question: "What is my current balance?", now: "2026-10-02T01:00:00.000Z",
    grantScope: { all: true }, scopePrincipalKind: "owner" };
  const fixed = await (await withLedgerAnswer(args, fallback)).json();
  const utcMidnight = await (await mutant.withLedgerAnswer(args, fallback)).json();
  assert.equal(fixed.side_note, undefined, "the owner-local day ended less than 48 hours ago");
  assert.match(utcMidnight.side_note || "", /Side note:/,
    "the UTC-midnight mutant crosses the 48-hour boundary early");
});

test("Think totals exclude the manual twin inside live coverage", async (t) => {
  const f = await fixtureFor(t);
  const before = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
  const body = await (await f.ask("How much money came in and went out in September 2026?")).json();
  assert.equal(body.ledger?.accounts.length, 1);
  assert.equal(body.ledger.accounts[0].credits_minor, 12001);
  assert.equal(body.ledger.accounts[0].debits_minor, 2300);
  assert.match(body.answer, /no rows were removed as transfers/);
  assert.ok(f.seen.sql.some(sql => /fin_transactions/.test(sql)), "transaction decision was reached");
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, before);
});

test("Think payment matches exact cents and returns bounded absence", async (t) => {
  const f = await fixtureFor(t);
  const found = await (await f.ask("Did the payment of $120.01 arrive on September 15, 2026?")).json();
  assert.equal(found.ledger?.found, true);
  const absent = await (await f.ask("Did the payment of $120.02 arrive on September 15, 2026?")).json();
  assert.equal(absent.ledger?.found, false);
  assert.match(absent.answer, /no matching deposit/i);
  assert.match(absent.answer, /2026-09-08.*2026-09-22/);
  assert.match(absent.answer, /covers through.*2026-10-11/);
  assert.ok(f.seen.sql.filter(sql => /fin_transactions/.test(sql)).length >= 2);
});

test("reader preserves manual rows outside both live-window edges and records each supplier", async (t) => {
  const f = await fixtureFor(t);
  f.add("later-manual", "manual-account", "2026-10-12", 700);
  f.add("first-manual", "manual-account", "2026-09-01", 800);
  f.add("last-manual", "manual-account", "2026-10-11", 900);
  const accounts = await readEffectiveAccounts(f.env);
  assert.equal(accounts.length, 1);
  const rows = await readEffectiveTransactions(f.env, accounts, { from: "2026-08-01", to: "2026-10-31" });
  assert.deepEqual(rows.map(r => [r.posted_on, r.amount_minor, r.source_account_slug]), [
    ["2026-08-31", 1100, "manual-account"], ["2026-09-15", 12001, "live-account"],
    ["2026-09-16", 2300, "live-account"], ["2026-10-12", 700, "manual-account"],
  ]);
  const older = await direct(f, "How much money came in August 2026?");
  assert.equal(older.ledger.accounts[0].credits_minor, 1100);
  assert.equal(older.citations[0].supplied_by, "manual");
});

test("all period shapes use an injected UTC calendar and covered zero periods stay explicit", async (t) => {
  const f = await fixtureFor(t);
  for (const [q, from, to, credits] of [
    ["How much money came in last month?", "2026-09-01", "2026-09-30", 12001],
    ["How much money went out last 10 days?", "2026-10-02", "2026-10-11", 0],
    ["How much money came in so far this year?", "2026-01-01", "2026-10-11", null],
  ]) {
    const intent = classifyLedgerQuestion(q, { now: NOW });
    assert.equal(intent.from, from); assert.equal(intent.to, to);
    const body = await direct(f, q);
    if (credits === null) {
      assert.equal(body.gaps[0].type, "ledger_out_of_coverage");
      assert.equal(body.gaps[0].accounts[0].covered_to, "2026-10-11");
    } else {
      assert.equal(body.ledger.accounts[0].credits_minor, credits);
      assert.equal(body.ledger.includes_own_transfers, true);
    }
  }
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-01-01' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in so far this year?")).ledger.accounts[0].credits_minor, 13101);
});

test("payment edges are inclusive, optional mask and counterparty are exact, and defaults are 30 days", async (t) => {
  const f = await fixtureFor(t);
  for (const [id, date] of [["before", "2026-09-07"], ["start", "2026-09-08"], ["end", "2026-09-22"], ["after", "2026-09-23"]]) {
    f.add(id, "live-account", date, 5011, "inflow", "Fixture payer deposit");
  }
  const body = await direct(f, "Did the payment of $50.11 from Fixture payer arrive on 2026-09-15 in account 4321?");
  assert.equal(body.ledger.found, true);
  assert.deepEqual(body.citations.map(c => c.posted_on), ["2026-09-08", "2026-09-22"]);
  const wrongPayer = await direct(f, "Did the payment of $50.11 from Different payer arrive on 2026-09-15?");
  // Every in-scope inflow remains visible; an amount filter cannot prove payer absence.
  assert.equal(wrongPayer.ledger.found, null);
  assert.equal(wrongPayer.ledger.inflow_count, 3);
  assert.deepEqual(wrongPayer.citations.map(c => c.posted_on), ["2026-09-22", "2026-09-15", "2026-09-08"]);
  const wrongMask = await direct(f, "Did the payment of $50.11 arrive on 2026-09-15 in account 9999?");
  assert.equal(wrongMask.gaps[0].reason, "no_accounts");
  assert.equal((await direct(f, "Did the payment of $120.01 arrive?")).ledger.found, true);
  assert.deepEqual([classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).from,
    classifyLedgerQuestion("Did the payment of $120.01 arrive?", { now: NOW }).to], ["2026-09-12", "2026-10-11"]);
  assert.equal((await direct(f, "Did the payment of $120.00 arrive?")).ledger.found, false);
});

test("ambiguous and missing accounts, missing balances, unreadable and partial coverage fall through", async (t) => {
  const f = await fixtureFor(t);
  const control = await direct(f, "What is my balance?");
  assert.equal(control.ledger.kind, "balance");
  f.raw("UPDATE fin_balance_snapshots SET basis_state='unparsed',unparsed_reason='fixture',current_minor=NULL,available_minor=NULL");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "balance_unavailable");
  f.raw("UPDATE fin_account_coverage SET coverage_status='partial' WHERE account_slug='live-account'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].type, "ledger_out_of_coverage");
  f.raw("UPDATE fin_account_coverage SET coverage_status='complete'");
  f.raw("UPDATE fin_transactions SET basis_state='unparsed',unparsed_reason='fixture',amount_minor=NULL,direction=NULL WHERE txn_uid='live-deposit'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].reason, "unreadable_transactions");
  f.raw("UPDATE fin_accounts SET feed_mode='live' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "ledger_account_link_required");
  f.raw("UPDATE fin_accounts SET superseded_by_id=999");
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "no_accounts");
  assert.ok(f.seen.sql.some(sql => /fin_balance_snapshots/.test(sql)));
  assert.ok(f.seen.sql.some(sql => /fin_transactions/.test(sql)));
});

test("proxy, grant, excluded owner and filtered owner hard-refuse without ledger or document retrieval", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await (await f.ask("What is my balance?")).json()).ledger.kind, "balance");
  const start = f.seen.sql.length;
  const proxy = await (await f.ask("What is my balance?", {}, { "X-Admin-Key": f.env.RAG_PROXY_KEY })).json();
  assert.equal(proxy.gaps[0].reason, "retrieval_scope_restricted");
  assert.equal(proxy.coverage_classification, "fine");
  assert.equal(proxy.status, "answer_withheld");
  assert.equal(proxy.ledger_refusal_class, "unsupported_request");
  assert.equal(proxy.answer, null);
  assert.deepEqual(proxy.results, []);
  assert.deepEqual(proxy.citations, []);
  assert.equal(f.seen.sql.slice(start).some(sql => /FROM fin_accounts/.test(sql)), false);
  for (const scope of [
    { scopePrincipalKind: "grant" }, { grantScope: { all: true, exclude: ["medical"] } },
    { access: { documentIds: ["fixture-doc"] } }, { filters: { source: "drive" } },
    { entityScope: { applied: true } }, { grantScope: null },
  ]) {
    const before = f.seen.sql.length;
    const response = await direct(f, "What is my balance?", scope);
    assert.equal(response.gaps[0].reason, "retrieval_scope_restricted");
    assert.equal(response.gaps[0].accounts.length, 0);
    assert.equal(response.coverage_classification, "fine");
    assert.equal(response.status, "answer_withheld");
    assert.equal(response.ledger_refusal_class, "unsupported_request");
    assert.equal(response.answer, null);
    assert.deepEqual(response.results, []);
    assert.deepEqual(response.citations, []);
    assert.equal(f.seen.sql.length, before);
  }
});

test("ordinary non-money Think response is byte-identical with and without a populated ledger", async (t) => {
  t.mock.method(performance, "now", () => 0);
  t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");
  const f = await fixtureFor(t);
  const start = f.seen.sql.length;
  const populated = await (await f.ask("Where is the meeting agenda?")).text();
  assert.ok(f.seen.sql.length > start, "the normal retrieval decision was reached");
  assert.equal(f.seen.sql.slice(start).some(sql => /FROM fin_accounts/.test(sql)), false);
  f.raw("DELETE FROM fin_transactions"); f.raw("DELETE FROM fin_accounts");
  const empty = await (await f.ask("Where is the meeting agenda?")).text();
  assert.equal(populated, empty);
  const expected = new Response('{"answer":"control", "gaps":[]}');
  const actual = await withLedgerAnswer({ env: f.env, question: "Where is the meeting agenda?" }, async () => expected);
  assert.equal(actual, expected);
});

test("an unreadable ledger refuses before dated documents can answer", async (t) => {
  const f = await fixtureFor(t);
  const q = "How much money came in September 2026?";
  f.raw("UPDATE fin_transactions SET basis_state='proposed' WHERE txn_uid='live-deposit'");
  f.raw(`INSERT INTO documents (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
    VALUES ('fixture:money','upload','money','Money expenses',?,'fixture','{}',?,'content',1)`, Date.parse("2026-01-01T00:00:00Z"), Date.parse("2026-01-01T00:00:00Z"));
  f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('fixture:money#0','fixture:money',0,'Money expenses historical record','upload','Money expenses',?)`, Date.parse("2026-01-01T00:00:00Z"));
  const body = await (await f.ask(q)).json();
  assert.equal(body.gaps[0].type, "ledger_not_consulted");
  assert.equal(body.gaps[0].reason, "unreadable_transactions");
  assert.equal(body.gaps[0].accounts[0].last_synced_at, stamp);
  assert.equal(body.coverage_classification, "catastrophic");
  assert.equal(body.answer, null);
  assert.deepEqual(body.citations, []);
  assert.deepEqual(body.results, [], "document retrieval did not answer the recognized ledger question");
  assert.equal(body.evidence_gate.supported, false, "the ledger refusal decision point was reached");
  assert.match(body.notice, /transactions cannot be read safely/);
});

test("every recognized ledger failure keeps its cause, remedy, and no-fallback boundary", async (t) => {
  const expected = [
    ["retrieval_scope_restricted", "unsupported_request", false],
    ["unsupported_question", "unsupported_request", false],
    ["no_accounts", "link_required", false],
    ["live_feed_never_synced", "coverage_outage", true],
    ["ledger_account_link_required", "link_required", false],
    ["ambiguous_account", "ambiguous_selector", false],
    ["unsupported_currency", "unsupported_request", false],
    ["period_outside_coverage", "coverage_outage", true],
    ["cash_flow_unsupported", "unsupported_request", false],
    ["balance_unavailable", "coverage_outage", true],
    ["coverage_review_required", "coverage_outage", true],
    ["merchant_selector_unsupported", "ambiguous_selector", false],
    ["bank_export_overlap_review_required", "coverage_outage", true],
    ["unreadable_transactions", "coverage_outage", true],
    ["merchant_selector_ambiguous", "ambiguous_selector", false],
    ["ledger_unavailable", "coverage_outage", true],
  ];
  const expectedByReason = new Map(expected.map((row) => [row[0], row]));
  const citedDocumentFallback = (calls) => async () => {
    calls.count++;
    return Response.json({
      answer: "The dated statement says the balance was $987.65 [1].",
      citations: [{ n: 1, title: "Synthetic dated statement" }],
      results: [{ title: "Synthetic dated statement", snippet: "Balance: $987.65" }],
      gaps: [],
    });
  };
  const run = async (label, question, mutate = async () => {}, extra = {}) => {
    await t.test(label, async (t) => {
      const f = await fixtureFor(t);
      await mutate(f);
      f.raw(`INSERT INTO documents
        (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
        VALUES ('fixture:cited-money','upload','cited-money','Synthetic dated statement',?,'fixture','{}',?,'content',1)`,
      Date.parse("2026-10-01T00:00:00.000Z"), Date.parse("2026-10-01T00:00:00.000Z"));
      f.raw(`INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
        VALUES ('fixture:cited-money#0','fixture:cited-money',0,
          'The dated statement says the balance was $987.65.','upload','Synthetic dated statement',?)`,
      Date.parse("2026-10-01T00:00:00.000Z"));
      assert.match(f.sqlite.prepare("SELECT text FROM chunks WHERE chunk_uid='fixture:cited-money#0'").get().text,
        /\$987\.65/, `${label}: the cited document money fixture was present`);
      const calls = { count: 0 };
      const before = f.seen.sql.length;
      const body = await (await withLedgerAnswer({
        env: f.env,
        question,
        grantScope: { all: true },
        scopePrincipalKind: "owner",
        now: NOW,
        ...extra,
      }, citedDocumentFallback(calls))).json();
      assert.equal(body.gaps?.[0]?.reason, label, `${label}: the named refusal decision was reached`);
      assert.equal(calls.count, 0, `${label}: cited document fallback stayed unreachable`);
      assert.equal(body.answer, null);
      assert.deepEqual(body.citations, []);
      assert.deepEqual(body.results, []);
      const [, causeClass, catastrophic] = expectedByReason.get(label);
      assert.equal(body.ledger_refusal_class, causeClass, `${label}: cause class`);
      assert.equal(body.coverage_classification, catastrophic ? "catastrophic" : "fine",
        `${label}: only coverage outages are catastrophic`);
      assert.equal(body.status, catastrophic ? "coverage_incomplete" : "answer_withheld",
        `${label}: public status preserves the semantic boundary`);
      const codedReasons = new Set([
        "retrieval_scope_restricted", "unsupported_question", "no_accounts", "ledger_account_link_required",
        "ambiguous_account", "unsupported_currency", "cash_flow_unsupported", "coverage_review_required",
        "merchant_selector_unsupported", "bank_export_overlap_review_required", "merchant_selector_ambiguous",
      ]);
      assert.equal(body.code, codedReasons.has(label) ? label : undefined,
        `${label}: support codes preserve their established boundary`);
      assert.match(body.notice || "", /\S/, `${label}: owner wording is present`);
      assert.match(body.next_action || "", /^Next: /, `${label}: reason-specific next action is present`);
      assert.equal(body.evidence_gate?.supported, false);
      assert.ok(f.seen.sql.length >= before, `${label}: the real ledger wrapper completed its decision path`);
    });
  };

  await run("retrieval_scope_restricted", "What is my current balance?", async () => {}, {
    filters: { source: "upload" },
  });
  await run("unsupported_question", "How much money came in September 2026?", async () => {}, {
    ledgerEligible: false,
  });
  await run("no_accounts", "What is my current balance?", async (f) => {
    f.env.BANK_FEED_TENANT = "fixture-with-no-accounts";
  });
  await run("live_feed_never_synced", "What is my current balance?", async (f) => {
    f.raw("UPDATE bank_feed_items SET last_synced_at=NULL WHERE item_ref='fixture-feed'");
  });
  await run("ledger_account_link_required", "What is my current balance?", async (f) => {
    f.raw("UPDATE fin_accounts SET feed_mode='live' WHERE account_slug='manual-account'");
  });
  await run("ambiguous_account", "What is my balance for account 4321?", async (f) => {
    await linkAccounts(f, "manual-account", "live-account", true);
    f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='manual-account'");
  });
  await run("unsupported_currency", "What is my current balance?", async (f) => {
    f.raw("UPDATE fin_account_links SET unlinked_at=?", stamp);
    f.raw("UPDATE fin_accounts SET superseded_by_id=999 WHERE account_slug='manual-account'");
    f.raw("UPDATE fin_accounts SET currency='EUR' WHERE account_slug='live-account'");
  });
  await run("period_outside_coverage", "How much money came in September 2026?", async (f) => {
    f.raw("UPDATE fin_account_coverage SET coverage_status='partial'");
  });
  await run("cash_flow_unsupported", "What was my cash flow in September 2026?");
  await run("balance_unavailable", "What is my current balance?", async (f) => {
    f.raw("DELETE FROM fin_balance_snapshots");
  });
  await run("coverage_review_required", "How much money came in September 2026?", async (f) => {
    f.raw("UPDATE fin_account_coverage SET basis_note='Read from a bank export covering a synthetic interval'");
  });
  await run("merchant_selector_unsupported", "How much did I spend at unknown merchant in September 2026?");
  await run("bank_export_overlap_review_required", "What deposits came in during September 2026?", async (f) => {
    f.add("duplicate-live", "live-account", "2026-09-15", 12001);
    f.raw(`UPDATE fin_transactions
      SET provenance='extracted',source_doc_uid=txn_uid,
          external_id=CASE WHEN txn_uid='live-deposit' THEN 'synthetic-external-id' ELSE NULL END
      WHERE txn_uid IN ('live-deposit','duplicate-live')`);
  });
  await run("unreadable_transactions", "How much money came in September 2026?", async (f) => {
    f.raw("UPDATE fin_transactions SET basis_state='unparsed',unparsed_reason='fixture',amount_minor=NULL,direction=NULL WHERE txn_uid='live-deposit'");
  });
  await run("merchant_selector_ambiguous", "How much did I spend at Tools & Supply in September 2026?", async (f) => {
    f.raw("UPDATE fin_transactions SET description='Tools and Supply',payee='Tools and Supply' WHERE txn_uid='live-debit'");
  });
  await run("ledger_unavailable", "What is my current balance?", async (f) => {
    f.control.failOn = /FROM fin_accounts/;
  });

  assert.deepEqual(
    [...(retrievalStatus.LEDGER_REFUSAL_REASONS || [])],
    expected.map((row) => row[0]),
    "the shared inventory names every reason produced by the ledger answer path",
  );
  assert.equal(new Set(expected.map((row) => row[0])).size, expected.length,
    "the refusal table covers every reason once");
  assert.equal(new Set(expected.map(([reason]) => retrievalStatus.LEDGER_REFUSAL_POLICIES[reason]?.next_action)).size,
    expected.length, "every ledger reason has distinct owner next-action wording");

  await t.test("green readable ledger control", async (t) => {
    const f = await fixtureFor(t);
    const calls = { count: 0 };
    const body = await (await withLedgerAnswer({
      env: f.env,
      question: "What is my current balance?",
      grantScope: { all: true },
      scopePrincipalKind: "owner",
      now: NOW,
    }, citedDocumentFallback(calls))).json();
    assert.equal(body.ledger?.kind, "balance", "the readable scoped ledger branch was reached");
    assert.match(body.answer || "", /\$987\.65/);
    assert.equal(body.evidence_gate?.supported, true);
    assert.equal(calls.count, 0);
  });
});

test("the uniform-catastrophic ledger refusal mutant is killed", async (t) => {
  const mutant = await importLedgerAnswerMutant(
    "  const catastrophic = policy?.catastrophic === true;",
    "  const catastrophic = true;",
  );
  const f = await fixtureFor(t);
  const args = { env: f.env, question: "What was my cash flow in September 2026?", now: NOW,
    grantScope: { all: true }, scopePrincipalKind: "owner" };
  const fixed = await (await withLedgerAnswer(args, fallback)).json();
  const widened = await (await mutant.withLedgerAnswer(args, fallback)).json();
  assert.equal(fixed.gaps[0]?.reason, "cash_flow_unsupported", "the capability refusal was reached");
  assert.equal(fixed.coverage_classification, "fine");
  assert.equal(widened.coverage_classification, "catastrophic",
    "restoring the uniform coverage label is observable");
  assert.notDeepEqual(widened, fixed, "the uniform-catastrophic refusal mutant is killed");
});

test("pending, removed and superseded transactions never count; descriptions redact account numbers", async (t) => {
  const f = await fixtureFor(t);
  for (const id of ["pending", "removed", "superseded"]) f.add(id, "live-account", "2026-09-15", 12001);
  f.raw("UPDATE fin_transactions SET pending=1 WHERE txn_uid='pending'");
  f.raw("UPDATE fin_transactions SET removed_at=?,removal_reason='fixture' WHERE txn_uid='removed'", stamp);
  f.raw("UPDATE fin_transactions SET superseded_by_id=999 WHERE txn_uid='superseded'");
  const number = Array.from({ length: 12 }, (_, i) => i % 10).join("");
  f.raw("UPDATE fin_transactions SET description=? WHERE txn_uid='live-deposit'", `Deposit account ${number}`);
  const body = await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?");
  assert.equal(body.citations.length, 1);
  assert.ok(!JSON.stringify(body).includes(number));
  assert.match(body.answer, /redacted/);
});

test("mutation controls kill dedup exclusion and exact amount comparison in real SQLite", async (t) => {
  const f = await fixtureFor(t);
  const accounts = await readEffectiveAccounts(f.env);
  const source = readFileSync(new URL("../src/lib/ledger-reader.js", import.meta.url), "utf8");
  assert.ok(source.includes("NOT (t.posted_on BETWEEN"));
  assert.ok(source.includes("t.amount_minor = ?5"));
  const mutations = [
    ["dedup", sql => sql.replace("NOT (t.posted_on BETWEEN", "(t.posted_on BETWEEN"), null, 24002],
    ["amount", sql => sql.replace("t.amount_minor = ?5", "t.amount_minor <> ?5"), 12002, 12001],
  ];
  for (const [name, mutate, amountMinor, expected] of mutations) {
    let changed = 0;
    const mutant = { DB: { batch: f.env.DB.batch, prepare(sql) {
      const altered = mutate(sql); if (altered !== sql) changed++;
      return f.env.DB.prepare(altered);
    } } };
    const options = { from: "2026-09-01", to: "2026-09-30", amountMinor };
    const control = await readEffectiveTransactions(f.env, accounts, options);
    const rows = await readEffectiveTransactions(mutant, accounts, options);
    const credits = list => list.filter(r => r.direction === "inflow").reduce((sum, r) => sum + r.amount_minor, 0);
    assert.equal(changed, 1, `${name} mutation reached its decision`);
    assert.equal(credits(control), amountMinor === null ? 12001 : 0);
    assert.equal(credits(rows), expected);
    assert.notEqual(credits(rows), credits(control));
  }
});

test("classifier refuses unsupported qualifiers instead of widening money questions", () => {
  assert.equal(classifyLedgerQuestion("What's my balance?", { now: NOW }).kind, "balance");
  assert.equal(classifyLedgerQuestion("Did the payment of $120.01 arrive on 15 September 2026?", { now: NOW }).from, "2026-09-08");
  for (const question of [
    "How much money came in September 2026 and October 2026?",
    "How much money came in September 2026 at Fixture Bank?",
    "How much money came in September 2026 in the payroll account?",
    "How much money came in September 2026 from Fixture payer?",
    "Did the payment of $120.01 arrive in September?",
    "Did the payment of $120.01 arrive at Fixture Bank on 2026-09-15?",
    "Did the payment of $120.01 arrive before 2026-09-15?",
    "Did the payment of $120.012 arrive on 2026-09-15?",
    "Did the payment of $120.01 and $120.02 arrive on 2026-09-15?",
    "What is the balance for account 123456789?",
  ]) {
    const intent = classifyLedgerQuestion(question, { now: NOW });
    assert.equal(intent.broad, true);
    assert.equal(intent.kind, null, question);
  }
});

test("all twin members must be confirmed and the configured tenant must be used", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "What is my balance?")).ledger.kind, "balance");
  f.raw("UPDATE fin_accounts SET basis_state='proposed' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in September 2026?")).gaps[0].reason, "ledger_account_link_required");
  f.env.BANK_FEED_TENANT = "second-owner";
  assert.equal((await direct(f, "What is my balance?")).gaps[0].reason, "no_accounts");
});

test("latest snapshot wins across twins, and different kinds and entities do not merge", async (t) => {
  const f = await fixtureFor(t);
  f.raw(`INSERT INTO fin_balance_snapshots
    (account_slug,as_of_date,current_minor,provenance,basis_state,recorded_at)
    VALUES ('manual-account','2026-10-12',65432,'owner_stated','confirmed','2026-10-12T12:00:00Z')`);
  const body = await direct(f, "What are my current balances?");
  assert.equal(body.ledger.accounts.length, 1);
  assert.equal(body.ledger.accounts[0].current_minor, 65432);
  assert.equal(body.citations[0].supplied_by, "manual");
  await linkAccounts(f, "manual-account", "live-account", true);
  f.raw("UPDATE fin_accounts SET account_kind='savings' WHERE account_slug='manual-account'");
  assert.equal((await readEffectiveAccounts(f.env)).length, 2);
  assert.equal((await direct(f, "What is my balance for account 4321?")).gaps[0].reason, "ambiguous_account");
  assert.equal((await direct(f, "What is my checking balance for account 4321?")).ledger.accounts[0].current_minor, 98765);
  seedOwnedEntity(f, "second-company", "Second Company");
  f.raw("UPDATE fin_accounts SET account_kind='checking',entity_slug='second-company' WHERE account_slug='manual-account'");
  assert.equal((await readEffectiveAccounts(f.env)).length, 2);
});

test("coverage holes and failed reads cannot become a zero total", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "How much money came in August 2026?")).ledger.accounts[0].credits_minor, 1100);
  f.raw("UPDATE fin_account_coverage SET covered_to='2026-08-20' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in August 2026?")).gaps[0].type, "ledger_out_of_coverage");
  f.control.failOn = /FROM fin_accounts/;
  const before = f.seen.sql.length;
  const unavailable = await direct(f, "What is my balance?");
  assert.equal(unavailable.gaps[0].reason, "ledger_unavailable");
  assert.ok(f.seen.sql.length > before, "failed database decision was reached");
  f.control.failOn = null;
  assert.equal((await direct(f, "What is my balance?")).ledger.kind, "balance");
});

test("explicit deposit amount does not hide a posted row with an unknown date", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?")).ledger.found, true);
  f.add("undated", "live-account", null, 8000);
  assert.equal((await direct(f, "Did the payment of $120.01 arrive on 2026-09-15?")).gaps[0].reason, "unreadable_transactions");
});

test("a concurrent coverage change cannot mix old twin precedence with new rows", async (t) => {
  const f = await fixtureFor(t);
  assert.equal((await direct(f, "How much money came in September 2026?")).ledger.accounts[0].credits_minor, 12001);
  let changed = 0;
  const prepare = f.env.DB.prepare;
  f.env.DB.prepare = sql => {
    if (/FROM json_each\(\?1\) m CROSS JOIN fin_transactions/.test(sql) && !changed++) {
      f.raw("UPDATE fin_account_coverage SET covered_from='2026-09-16' WHERE account_slug='live-account'");
    }
    return prepare(sql);
  };
  const body = await direct(f, "How much money came in September 2026?");
  assert.equal(changed, 1);
  assert.equal(body.gaps[0]?.reason, "ledger_unavailable");
  assert.equal(body.answer, null);
});

test("short numeric masks use the same exact twin rule and malformed coverage cannot certify a period", async (t) => {
  const f = await fixtureFor(t);
  await linkAccounts(f, "manual-account", "live-account", true);
  f.raw("UPDATE fin_accounts SET mask='321'");
  await linkAccounts(f);
  assert.equal((await readEffectiveAccounts(f.env)).length, 1);
  assert.equal((await direct(f, "How much money came in September 2026 for account 321?")).ledger.accounts[0].credits_minor, 12001);
  assert.equal((await direct(f, "How much money came in August 2026?")).ledger.accounts[0].credits_minor, 1100);
  f.raw("UPDATE fin_account_coverage SET covered_from='2026-00-01' WHERE account_slug='manual-account'");
  assert.equal((await direct(f, "How much money came in August 2026?")).gaps[0].type, "ledger_out_of_coverage");
});

// Keep the production-shaped probe in this registered suite so the full chain runs it.
import { ledgerFixture } from "./ledger-review-fixture.mjs";
import { reachedAnswer, productionFixture, measureProduction } from "./ledger-production-fixture.mjs";
for (const label of ["Zelle", "ACH", "ACH Credit", "Deposit", "Transfer", "Wire", "Mobile Deposit", "Unknown", "Online Transfer",
  "Bank", "PayPal", "Venmo", "Unknown Merchant", "Zelle Payment", "None"]) {
  test(`generic bank label cannot prove a different payer: ${label}`, async t => {
    const f = ledgerFixture(t);
    for (const [description, payee] of [["Settlement", label], [`Transfer from ${label}`, null]]) {
      f.raw("DELETE FROM fin_transactions");
      f.add("unknown", description, payee);
      const unknown = [];
      for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
      f.raw("UPDATE fin_transactions SET payee='Payer One'");
      for (const question of [payerPayment, payerIncome]) {
        const control = await reachedAnswer(f, question);
        assert.equal(control.ledger.found, true);
        assert.equal(control.evidence_gate.complete, control.ledger.kind === "payment");
      }
      for (const body of unknown) {
        assert.equal(body.ledger.found, null);
        assert.equal(body.evidence_gate.complete, false);
        assert.equal(body.ledger.inflow_count, 1);
      }
    }
  });
}

for (const description of ["Deposit for invoice from Payer Two", "Deposit memo by Payer Two", "Deposit invoice from Payer Two", "Deposit processed by Payer Two",
  "Payer One memo from Payer Two"]) {
  test(`incidental sender clause is unknown: ${description}`, async t => {
    const f = ledgerFixture(t);
    f.add("unknown", description, null);
    const unknown = [];
    for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
    f.raw("UPDATE fin_transactions SET description='Transfer from Payer Two for invoice from Payer One'");
    for (const question of [payerPayment, payerIncome]) {
      const control = await reachedAnswer(f, question);
      assert.equal(control.ledger.found, null);
      assert.equal(control.evidence_gate.complete, false);
    }
    for (const body of unknown) {
      assert.equal(body.ledger.found, null);
      assert.equal(body.evidence_gate.complete, false);
    }
    f.raw("UPDATE fin_transactions SET payee='Payer One'");
    for (const question of [payerPayment, payerIncome]) {
      const positive = await reachedAnswer(f, question);
      assert.equal(positive.ledger.found, true, "structured payer discriminates every memo arm");
    }
  });
}

test("partial sender identity cannot certify zero income", async t => {
  const f = ledgerFixture(t);
  f.add("partial", "WIRE FROM Payer One BENEFICIARY Operating Company", null);
  assert.equal((await reachedAnswer(f, payerPayment)).ledger.found, true, "existing payment prefix control");
  const income = await reachedAnswer(f, payerIncome);
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer One REF 48261703'");
  assert.equal((await reachedAnswer(f, payerIncome)).ledger.attributed_subtotal_minor, 2500, "bounded exact sender control");
  assert.equal(income.ledger.found, null, "partial identity is unknown for an exact income total");
  assert.equal(income.ledger.total_minor, null);
  assert.equal(income.ledger.if_own_transfers.total_minor, null, "a conditional view also cannot certify zero");
  assert.equal(income.evidence_gate.complete, false);
  f.raw("UPDATE fin_transactions SET description='WIRE FROM Payer Oneplus'");
  for (const question of [payerPayment, payerIncome]) {
    const different = await reachedAnswer(f, question);
    assert.equal(different.ledger.found, null, "partial words cannot prove presence or absence");
    assert.equal(different.evidence_gate.complete, false);
  }
});

test("uncertain deposits omit descriptions and bank labels throughout JSON", async t => {
  const f = ledgerFixture(t);
  const identifiers = ["AB12CD34EF56", "482.617.039.258.001", "482617039258001"];
  for (const [i, identifier] of identifiers.entries()) f.add(`unknown-${i}`, `Deposit TRACE: ${identifier}`, null);
  const unknown = [];
  for (const question of [payerPayment, payerIncome]) unknown.push(await reachedAnswer(f, question));
  f.raw("UPDATE fin_transactions SET payee='Payer One'");
  const control = await reachedAnswer(f, payerIncome);
  assert.equal(control.evidence_gate.complete, false);
  assert.equal(control.ledger.attributed_subtotal_minor, 7500);
  for (const body of unknown) {
    assert.equal(body.ledger.inflows.length, 3);
    for (const deposit of body.ledger.inflows) {
      assert.equal(deposit.description, undefined);
      assert.equal(deposit.payee, undefined);
      assert.equal(deposit.posted_on, "2026-10-05");
      assert.equal(deposit.amount_minor, 2500);
      assert.equal(deposit.account_mask, "1234");
    }
    for (const identifier of identifiers) assert.ok(!JSON.stringify(body).includes(identifier));
    assert.ok(!JSON.stringify(body).includes("Deposit TRACE"));
  }
  for (const identifier of identifiers) {
    f.raw("UPDATE fin_transactions SET payee=?", `Payer One TRACE: ${identifier}`);
    const body = await reachedAnswer(f, payerIncome);
    assert.equal(body.ledger.found, null, "partly matching bank label reached uncertainty");
    assert.equal(body.ledger.inflows[0].payee, undefined);
    assert.ok(!JSON.stringify(body).includes(identifier));
  }
});

test("income groups keep bank labels and exact bank totals with a payer warning", async t => {
  const f = ledgerFixture(t);
  f.add("known", "Settlement", "Payer One", { cents: 1729 });
  for (let i = 0; i < 12; i++) f.add(`unknown-${i}`, "Deposit", null);
  const body = await reachedAnswer(f, "How much income came by merchant in October 2026?");
  assert.equal(body.ledger.total_minor, 31729);
  assert.equal(body.ledger.groups.find(g => g.merchant === "payer one").total_minor, 1729, "named group decision reached");
  f.raw("UPDATE fin_transactions SET payee='Payer Two' WHERE payee IS NULL");
  const control = await reachedAnswer(f, "How much income came by merchant in October 2026?");
  assert.equal(control.evidence_gate.complete, false);
  assert.equal(control.ledger.total_minor, 31729);
  assert.equal(control.ledger.groups.length, 2);
  assert.equal(body.evidence_gate.complete, false);
  assert.equal(body.ledger.inflows, undefined, "bank grouping keeps its base shape");
  assert.equal(body.ledger.groups.find(g => g.merchant === "deposit").total_minor, 30000);
  const named = body.ledger.groups.find(g => g.merchant === "payer one");
  assert.equal(named.total_minor, 1729);
  assert.equal(named.complete, false);
  assert.match(body.answer, /Labels come from your bank and may not identify who paid\./);
});

test("named payer production matrix never certifies an unknown deposit as absent", async t => {
  const stats = await measureProduction(productionFixture(t));
  t.diagnostic(JSON.stringify(stats));
  assert.equal(stats.wrong, 0);
  assert.ok(stats.answered >= 34, "preserve the previously correct answers");
  assert.equal(stats.answered + stats.refused, 40);
});

const payerPayment = "Did the payment from Payer One arrive in October 2026?";
const payerIncome = "How much income came from Payer One in October 2026?";
for (const description of [
  "ORIG CO NAME: Payer One", "WIRE TRANSFER ORIGINATOR NAME: Payer One",
  "WIRE ORIGINATOR: Payer One; BENEFICIARY: Operating Company",
  "WIRE FROM: Payer One; REF: 48261703", "ORIGINATOR NAME: Payer One",
  "SENDER: Payer One", "Deposit", "", "Unrecognized bank narration",
]) test(`unattributed deposit cannot certify absence or zero: ${description || "empty"}`, async t => {
  const f = ledgerFixture(t);
  f.add("uncertain", description, null);
  for (const question of [payerPayment, payerIncome]) {
    const body = await reachedAnswer(f, question);
    // Existing positive parsing is intentionally unchanged by this hotfix.
    if (description === "WIRE FROM: Payer One; REF: 48261703") {
      assert.equal(body.ledger.found, true);
      assert.equal(body.citations[0].amount_minor, 2500);
      continue;
    }
    assert.equal(body.ledger.found, null);
    assert.equal(body.evidence_gate.complete, false);
    assert.doesNotMatch(body.answer, /No matching deposit|\$0\.00/);
    assert.match(body.answer, /can't confirm/i);
    assert.match(body.answer, /2026-10-05/);
    assert.match(body.answer, /covered through|covers through/);
    assert.equal(body.ledger.inflow_count, 1);
    assert.equal(body.ledger.inflows[0].amount_minor, 2500);
    if (body.ledger.kind === "merchant") assert.equal(body.ledger.total_minor, null);
  }
  f.raw("UPDATE fin_transactions SET payee='Payer One'");
  for (const question of [payerPayment, payerIncome]) {
    const control = await reachedAnswer(f, question);
    assert.equal(control.ledger.found, true, "structured payee restores the answer");
    assert.equal(control.evidence_gate.complete, control.ledger.kind === "payment");
  }
});

test("different sender labels and amounts cannot prove absence; period and direction still bind", async t => {
  const f = ledgerFixture(t);
  f.add("structured", "Settlement", "Payer Two");
  f.add("extracted", "Transfer from Payer Three for Payer One invoice", null);
  f.add("outside", "Deposit", null, { date: "2026-09-30" });
  f.add("outflow", "Deposit", null, { direction: "outflow" });
  for (const question of [payerPayment, payerIncome]) {
    const control = await reachedAnswer(f, question);
    assert.equal(control.ledger.found, null);
    assert.equal(control.evidence_gate.complete, false);
    assert.equal(control.ledger.total_minor, null);
  }
  f.add("unknown", "Deposit", null, { cents: 3900 });
  const bounded = await reachedAnswer(f, "Did the payment of $25 from Payer One arrive in October 2026?");
  assert.equal(bounded.ledger.found, null, "an amount filter cannot prove an empty inflow window");
  const uncertain = await reachedAnswer(f, payerPayment);
  assert.equal(uncertain.ledger.found, null);
  assert.equal(uncertain.ledger.inflow_count, 3);
  f.add("matched", "Settlement", "Payer One");
  const positive = await reachedAnswer(f, payerPayment);
  assert.equal(positive.ledger.found, true, "a confirmed receipt still proves presence");
});

test("income keeps only an incomplete attributed subtotal and caps masked uncertain receipts at ten", async t => {
  const f = ledgerFixture(t);
  f.add("matched", "Settlement", "Payer One", { cents: 1729 });
  const control = await reachedAnswer(f, payerIncome);
  assert.equal(control.ledger.total_minor, null);
  assert.equal(control.ledger.attributed_subtotal_minor, 1729);
  for (let i = 0; i < 12; i++) f.add(`unknown-${i}`, "Deposit 482617039258001", null, { cents: 2500 + i });
  const body = await reachedAnswer(f, payerIncome);
  assert.equal(body.ledger.found, true);
  assert.equal(body.ledger.total_minor, null);
  assert.equal(body.ledger.attributed_subtotal_minor, 1729);
  assert.equal(body.evidence_gate.complete, false);
  assert.match(body.answer, /at least.*\$17\.29.*subtotal.*not complete/i);
  assert.doesNotMatch(body.answer, /Total income|482617039258001/);
  assert.equal(body.ledger.inflow_count, 13);
  assert.equal(body.ledger.inflows.length, 10);
  assert.equal(body.citations.length, 10);
  for (const row of body.ledger.inflows) {
    assert.equal(row.posted_on, "2026-10-05");
    assert.equal(row.description, undefined, "uncertain receipts never expose descriptions");
    assert.equal(row.account_mask, "1234");
    assert.ok(body.citations.some(c => c.n === row.n && c.amount_minor === row.amount_minor));
  }
  assert.doesNotMatch(JSON.stringify(body), /482617039258001|Deposit \[redacted\]/);
  const payment = await reachedAnswer(f, "Did the payment from Absent Payer arrive in October 2026?");
  assert.equal(payment.ledger.found, null);
  assert.equal(payment.ledger.inflows.length, 10);
  assert.equal(payment.ledger.inflow_count, 13);
  assert.doesNotMatch(JSON.stringify(payment), /482617039258001/);
});

// Registered here so the ordinary test chain executes both review rounds.
import "./ledger-conservative.test.mjs";
