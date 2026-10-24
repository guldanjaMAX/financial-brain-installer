import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { classifyQuestionCoverage } from "../src/lib/retrieval-status.js";

const NOW = "2026-10-23T18:00:00.000Z";
const DAY = 86_400_000;
const at = (days, hours = 0) => new Date(Date.parse(NOW) - days * DAY - hours * 3_600_000).toISOString();
const gap = (source, sourceKind, days, type = "coverage_stale") => ({
  type,
  source,
  source_kind: sourceKind,
  last_good_sync_at: days === null ? null : at(days),
  days_since_ingest: days,
  detail: `${source} fixture gap`,
});

test.before(() => mock.method(Date, "now", () => Date.parse(NOW)));
test.after(() => mock.restoreAll());

test("money uses its ledger primary and answers before unrelated Drive and Gmail gaps", () => {
  const decision = classifyQuestionCoverage({
    question: "What payments did I get in October?",
    questionType: "money",
    periodStart: "2026-10-01",
    now: NOW,
    gaps: [gap("Drive", "drive", 60, "sync_review"), gap("Gmail", "gmail", 4, "sync_review")],
    evidenceSources: ["ledger"],
  });
  assert.equal(decision.classification, "stale_but_covering");
  assert.equal(decision.refuse, false);
  assert.match(decision.side_note || "", /^Side note:/);
  assert.match(decision.side_note, /Gmail/);
  assert.match(decision.side_note, /Oct 19/);
  assert.equal(decision.primary_sources.includes("ledger"), true, "money primary-source decision was reached");
});

test("money refuses when the bank ledger stopped before the requested period", () => {
  const decision = classifyQuestionCoverage({
    question: "What payments did I get in October?",
    questionType: "money",
    periodStart: "2026-10-01",
    now: NOW,
    gaps: [gap("bank ledger", "ledger", 23, "coverage_stale")],
    evidenceSources: ["ledger"],
  });
  assert.equal(decision.classification, "catastrophic");
  assert.equal(decision.refuse, true);
  assert.equal(decision.catastrophic_gaps.length, 1, "the primary-source cutoff was evaluated");
});

test("a six-hour Gmail pause is quiet", () => {
  const decision = classifyQuestionCoverage({
    question: "What did the email say?",
    now: NOW,
    gaps: [{ ...gap("Gmail", "gmail", 0, "sync_review"), last_good_sync_at: at(0, 6) }],
    evidenceSources: ["gmail"],
  });
  assert.equal(decision.classification, "fine");
  assert.equal(decision.refuse, false);
  assert.equal(decision.side_note, null);
  assert.equal(decision.primary_sources.includes("gmail"), true, "the email primary-source decision was reached");
});

test("a five-day Gmail pause answers with the possibly missing period", () => {
  const decision = classifyQuestionCoverage({
    question: "What did the email say about the renewal?",
    now: NOW,
    gaps: [gap("Gmail", "gmail", 5, "sync_review")],
    evidenceSources: ["gmail"],
  });
  assert.equal(decision.classification, "stale_but_covering");
  assert.equal(decision.refuse, false);
  assert.match(decision.side_note || "", /^Side note: Gmail has been paused since Sun Oct 18/);
  assert.match(decision.side_note, /after that date may be missing/);
});

test("a never-synced primary source is catastrophic, with a healthy control", () => {
  const refused = classifyQuestionCoverage({
    question: "What did the email say?",
    now: NOW,
    gaps: [gap("Gmail", "gmail", null, "never_synced")],
    evidenceSources: ["gmail"],
  });
  assert.equal(refused.refuse, true);
  assert.equal(refused.catastrophic_gaps[0]?.type, "never_synced", "the never-sync decision was reached");
  const control = classifyQuestionCoverage({
    question: "What did the email say?",
    now: NOW,
    gaps: [],
    evidenceSources: ["gmail"],
  });
  assert.deepEqual({ classification: control.classification, refuse: control.refuse, side_note: control.side_note },
    { classification: "fine", refuse: false, side_note: null });
});

async function ledgerFixture(t, { coveredTo, syncedAt }) {
  const f = await createProductFixture({ env: {
    ADMIN_KEY: randomBytes(24).toString("hex"),
    SESSION_SIGNING_KEY: randomBytes(32).toString("hex"),
    AI: { async run() { throw new Error("money must stay on the ledger path"); } },
  } });
  t.after(() => f.close());
  seedOwnedEntity(f, "owner", "Owner");
  f.raw(`INSERT INTO bank_feed_items
    (item_ref,institution_label,access_ciphertext,access_iv,environment,connected_at,last_synced_at)
    VALUES ('fixture-feed','Fixture Bank',?,?,'sandbox',?,?)`,
  randomBytes(32).toString("base64"), randomBytes(12).toString("base64"), syncedAt, syncedAt);
  f.raw(`INSERT INTO fin_accounts
    (account_slug,entity_slug,account_kind,balance_role,mask,feed_mode,provenance,source_feed,basis_state,recorded_at,institution)
    VALUES ('account','owner','checking','asset','4321','live','feed','bank-feed:fixture-feed','confirmed',?,'Fixture Bank')`, syncedAt);
  f.raw(`INSERT INTO fin_account_coverage
    (account_slug,coverage_status,covered_from,covered_to,computed_at,provenance,basis_state,recorded_at)
    VALUES ('account','complete','2026-01-01',?,?,'owner_stated','confirmed',?)`, coveredTo, syncedAt, syncedAt);
  f.raw(`INSERT INTO fin_transactions
    (txn_uid,account_slug,posted_on,amount_minor,direction,description,provenance,source_feed,basis_state,recorded_at)
    VALUES ('october-deposit','account','2026-10-10',12001,'inflow','Fixture deposit','feed','bank-feed:fixture-feed','confirmed',?)`, syncedAt);
  return f;
}

const askLedger = (f, sourceGaps = []) => withLedgerAnswer({
  env: f.env,
  question: "What were my deposits in October 2026?",
  now: NOW,
  grantScope: { all: true },
  scopePrincipalKind: "owner",
  sourceCoverage: { unavailable: false, gaps: sourceGaps },
}, async () => Response.json({ answer: null, gaps: [] })).then((response) => response.json());

test("the real ledger answers a current period and puts unrelated source pauses in side_note", async (t) => {
  const f = await ledgerFixture(t, { coveredTo: "2026-10-22", syncedAt: "2026-10-22T18:00:00.000Z" });
  const before = f.seen.sql.length;
  const body = await askLedger(f, [gap("Drive", "drive", 60, "sync_review"), gap("Gmail", "gmail", 4, "sync_review")]);
  assert.match(body.answer || "", /\$120\.01/);
  assert.match(body.side_note || "", /^Side note:/);
  assert.equal(body.gaps.some((item) => item.source === "Drive"), true);
  assert.ok(f.seen.sql.slice(before).some((sql) => /fin_transactions/.test(sql)), "the transaction decision was reached");
});

test("the real ledger refuses when its last good sync predates the requested period", async (t) => {
  const f = await ledgerFixture(t, { coveredTo: "2026-10-22", syncedAt: "2026-09-30T18:00:00.000Z" });
  const before = f.seen.sql.length;
  const body = await askLedger(f);
  assert.equal(body.answer, null);
  assert.equal(body.gaps[0]?.type, "ledger_coverage_stale");
  assert.ok(f.seen.sql.slice(before).some((sql) => /FROM fin_accounts/.test(sql)), "the account coverage decision was reached");
  assert.equal(f.seen.sql.slice(before).some((sql) => /CROSS JOIN fin_transactions/.test(sql)), false,
    "catastrophic primary coverage stops before money rows are read");
});

test("the three named coverage mutants are killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const importMutant = async (from, to) => {
    assert.equal(source.includes(from), true, `mutation marker exists: ${from}`);
    const mutated = source.replace(from, to);
    return import(`data:text/javascript;base64,${Buffer.from(mutated).toString("base64")}#${randomBytes(8).toString("hex")}`);
  };
  const unrelated = [gap("Drive", "drive", 60, "sync_review")];
  const args = { question: "What payments did I get in October?", questionType: "money",
    periodStart: "2026-10-01", now: NOW, gaps: unrelated, evidenceSources: ["ledger"] };

  const widened = await importMutant("const primary = primarySourceKinds.has(kind);", "const primary = true;");
  assert.notDeepEqual(widened.classifyQuestionCoverage(args), classifyQuestionCoverage(args),
    "widening catastrophic coverage to every incomplete source is observable");

  const dropped = await importMutant("side_note: renderCoverageSideNote(notable, nowMs),", "side_note: null,");
  const emailArgs = { question: "What did the email say?", now: NOW,
    gaps: [gap("Gmail", "gmail", 5, "sync_review")], evidenceSources: ["gmail"] };
  assert.notDeepEqual(dropped.classifyQuestionCoverage(emailArgs), classifyQuestionCoverage(emailArgs),
    "dropping the side note is observable");

  const unmapped = await importMutant('money: new Set(["ledger", "plaid", "bank", "bank-feed", "payment", "stripe", "square"]),',
    "money: new Set(),");
  const bankArgs = { ...args, gaps: [gap("bank ledger", "ledger", 23, "coverage_stale")] };
  assert.notDeepEqual(unmapped.classifyQuestionCoverage(bankArgs), classifyQuestionCoverage(bankArgs),
    "removing the money primary-source mapping is observable");
});
