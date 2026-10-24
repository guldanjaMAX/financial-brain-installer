import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProductFixture, seedOwnedEntity } from "./product-contract-fixture.mjs";
import { withLedgerAnswer } from "../src/lib/ledger-answer.js";
import { classifyQuestionCoverage } from "../src/lib/retrieval-status.js";
import * as retrievalStatus from "../src/lib/retrieval-status.js";

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

test("named channels and structured source questions outrank generic money words", () => {
  const cases = [
    ["What did I pay on the receipt in Gmail?", ["gmail"]],
    ["What is my QuickBooks balance?", ["quickbooks"]],
    ["What was store revenue?", ["custom-api", "store", "shopify", "square"]],
    ["Compare the Gmail receipt with the QuickBooks balance.", ["gmail", "quickbooks"]],
    ["What is my bank balance?", ["ledger", "plaid", "bank", "bank-feed", "payment", "stripe", "square"]],
  ];
  for (const [question, expected] of cases) {
    const decision = classifyQuestionCoverage({ question, now: NOW });
    assert.deepEqual(decision.primary_sources, expected, `${question}: explicit source decision was reached`);
  }
});

test("coverage window starts preserve the exact midnight instant in three owner offsets", () => {
  assert.equal(typeof retrievalStatus.coverageWindowStart, "function");
  for (const [zone, start] of [
    ["America/Phoenix", Date.parse("2026-10-01T07:00:00.000Z")],
    ["UTC", Date.parse("2026-10-01T00:00:00.000Z")],
    ["Asia/Tokyo", Date.parse("2026-09-30T15:00:00.000Z")],
  ]) {
    const exact = retrievalStatus.coverageWindowStart({ start });
    assert.equal(exact, new Date(start).toISOString(), `${zone}: the full instant crosses the classifier boundary`);
    const decision = classifyQuestionCoverage({
      question: "What did Gmail say that day?",
      periodStart: exact,
      gaps: [gap("Gmail", "gmail", 1, "coverage_stale")
        && { ...gap("Gmail", "gmail", 1, "coverage_stale"), last_good_sync_at: new Date(start - 1).toISOString() }],
      now: NOW,
    });
    assert.equal(decision.refuse, true, `${zone}: one millisecond before local midnight is outside coverage`);
  }
  const indexSource = readFileSync(fileURLToPath(new URL("../src/index.js", import.meta.url)), "utf8");
  assert.equal(indexSource.match(/periodStart:\s*coveragePeriodStart\(explicitFrom, timeWindow\)/g)?.length, 2,
    "both raw and generated answer routes pass the explicit or inferred full instant");
});

test("coverage dates render in the owner time zone for negative, zero, and positive offsets", () => {
  for (const [timeZone, instant, expected] of [
    ["America/Phoenix", "2026-10-19T00:30:00.000Z", "Sun Oct 18"],
    ["UTC", "2026-10-19T00:30:00.000Z", "Mon Oct 19"],
    ["Asia/Tokyo", "2026-10-19T23:30:00.000Z", "Tue Oct 20"],
  ]) {
    const decision = classifyQuestionCoverage({
      question: "What did the email say?",
      gaps: [{ ...gap("Gmail", "gmail", 5, "sync_review"), last_good_sync_at: instant }],
      now: "2026-10-24T12:00:00.000Z",
      timeZone,
    });
    assert.match(decision.side_note || "", new RegExp(expected), `${timeZone}: owner-local date is rendered`);
  }
});

test("numeric and ISO clocks agree at the exact 48-hour and 14-day boundaries", () => {
  const nowMs = Date.parse("2030-01-15T12:00:00.000Z");
  const decide = (now, ageMs) => classifyQuestionCoverage({
    question: "What did Gmail say?",
    now,
    gaps: [{
      type: "coverage_stale",
      source: "Gmail",
      source_kind: "gmail",
      last_good_sync_at: new Date(nowMs - ageMs).toISOString(),
      detail: "Synthetic stale coverage",
    }],
    evidenceSources: ["gmail"],
  });
  for (const [label, ageMs, expectedClassification, prefix] of [
    ["one millisecond before 48 hours", 2 * DAY - 1, "fine", false],
    ["exactly 48 hours", 2 * DAY, "stale_but_covering", false],
    ["exactly 14 days", 14 * DAY, "stale_but_covering", false],
    ["one millisecond beyond 14 days", 14 * DAY + 1, "stale_but_covering", true],
  ]) {
    const numeric = decide(nowMs, ageMs);
    const iso = decide(new Date(nowMs).toISOString(), ageMs);
    assert.equal(numeric.classification, expectedClassification, `${label}: numeric clock reached the threshold`);
    assert.equal(Boolean(numeric.answer_prefix), prefix, `${label}: numeric prefix boundary`);
    assert.deepEqual(numeric, iso, `${label}: finite numeric and ISO clocks are equivalent`);
  }
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

test("a failed recognized ledger intent never reaches a cited document money fallback", async (t) => {
  const f = await ledgerFixture(t, { coveredTo: "2026-09-30", syncedAt: "2026-10-23T17:55:00.000Z" });
  let documentCalls = 0;
  const before = f.seen.sql.length;
  const response = await withLedgerAnswer({
    env: f.env,
    question: "What were my deposits in October 2026?",
    now: NOW,
    grantScope: { all: true },
    scopePrincipalKind: "owner",
  }, async () => {
    documentCalls++;
    return Response.json({
      answer: "The cited invoice says the amount was $120.01 [1].",
      citations: [{ n: 1, title: "Synthetic invoice" }],
      results: [{ title: "Synthetic invoice", snippet: "Invoice amount: $120.01" }],
      gaps: [],
    });
  });
  const body = await response.json();
  assert.ok(f.seen.sql.slice(before).some((sql) => /FROM fin_accounts/.test(sql)),
    "the real ledger coverage decision was reached");
  assert.equal(documentCalls, 0, "the document fallback restored mutant is killed");
  assert.equal(body.answer, null);
  assert.equal(body.citations.length, 0);
  assert.equal(body.results.length, 0);
  assert.equal(body.gaps[0]?.type, "ledger_out_of_coverage");

  let ledgerReadAttempts = 0;
  const unavailable = await (await withLedgerAnswer({
    env: { DB: { prepare() { ledgerReadAttempts++; throw new Error("synthetic unreadable ledger"); } } },
    question: "What were my deposits in October 2026?",
    now: NOW,
    grantScope: { all: true },
    scopePrincipalKind: "owner",
  }, async () => {
    documentCalls++;
    return Response.json({ answer: "The cited invoice says the amount was $120.01 [1]." });
  })).json();
  assert.ok(ledgerReadAttempts > 0, "the unavailable ledger read decision was reached");
  assert.equal(documentCalls, 0, "ledger_unavailable also stops before the document fallback");
  assert.equal(unavailable.gaps[0]?.reason, "ledger_unavailable");
  assert.equal(unavailable.coverage_classification, "catastrophic");
});

test("a recent connector attempt cannot hide a partial ledger interval", async (t) => {
  const f = await ledgerFixture(t, { coveredTo: "2026-09-30", syncedAt: "2026-10-23T17:55:00.000Z" });
  const body = await (await withLedgerAnswer({
    env: f.env,
    question: "How much money came in so far this year?",
    now: NOW,
    grantScope: { all: true },
    scopePrincipalKind: "owner",
  }, async () => { throw new Error("partial covered periods stay on the ledger path"); })).json();
  assert.equal(body.ledger?.from, "2026-01-01", "the bounded ledger calculation was reached");
  assert.equal(body.ledger?.to, "2026-09-30");
  assert.match(body.side_note || "", /Oct 1 through Oct 23 may be missing/i,
    "the recent-sync note-drop mutant is killed");
});

test("raw unified search carries a closed catastrophic classification beside real matching rows", async (t) => {
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: "America/Phoenix" } });
  t.after(() => f.close());
  f.raw(`INSERT INTO sources
    (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds,document_count)
    VALUES ('mail','gmail','ready',?,NULL,NULL,86400,1)`, NOW);
  f.raw(`INSERT INTO documents
    (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
    VALUES ('mail:receipt','mail','receipt','Synthetic receipt',?,'fixture','{}',?,'fixture',1)`,
  Date.parse(NOW), Date.parse("2026-10-10T12:00:00.000Z"));
  f.raw(`INSERT INTO chunks
    (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('mail:receipt#0','mail:receipt',0,'Synthetic Gmail receipt amount',
      'mail','Synthetic receipt',?)`, Date.parse("2026-10-10T12:00:00.000Z"));
  const response = await f.post("/api/rag/unified", { q: "What did the Gmail receipt say?" }, {
    "X-Admin-Key": f.env.ADMIN_KEY,
  });
  const body = await response.json();
  assert.ok(body.results?.length > 0, "the raw route reached matching candidate rows");
  assert.equal(body.coverage_classification, "catastrophic");
  assert.equal(body.answer_prefix, undefined);
});

test("raw contact-field requests keep upload evidence separate from the Gmail channel", async (t) => {
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: "America/Phoenix" } });
  t.after(() => f.close());
  f.raw(`INSERT INTO sources
    (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds,document_count)
    VALUES ('upload','upload','ready',?,?,?,86400,1)`, NOW, NOW, NOW);
  f.raw(`INSERT INTO sources
    (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds,document_count)
    VALUES ('mail','gmail','ready',?,NULL,NULL,86400,0)`, NOW);
  f.raw(`INSERT INTO documents
    (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
    VALUES ('upload:contact','upload','contact','Contact record',?,'fixture','{}',?,'record:updated',1)`,
  Date.parse(NOW), Date.parse("2026-10-22T12:00:00.000Z"));
  f.raw(`INSERT INTO chunks
    (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('upload:contact#0','upload:contact',0,'Name: Example Contact email: contact@example.invalid',
      'upload','Contact record',?)`, Date.parse("2026-10-22T12:00:00.000Z"));

  const fieldQuestions = [
    "What is the email address for Example Contact?",
    "  What is the email address for Example Contact?  ",
    "What's the email address for Example Contact?",
    "What’s the email address for Example Contact?",
    "Find the email address for Example Contact.",
    "Look up the email address for Example Contact.",
    "Please give me the email address for Example Contact.",
    "I need the email address for Example Contact.",
    "Give me Example Contact's email address.",
    "Find Example Contact’s email address.",
    "What are the email addresses for Example Contact?",
    "Example Contact's email?",
  ];
  const bodies = [];
  for (const q of fieldQuestions) {
    const body = await (await f.post("/api/rag/unified", { q }, {
      "X-Admin-Key": f.env.ADMIN_KEY,
    })).json();
    assert.ok(body.results?.length > 0, "the raw route reached the matching upload row");
    assert.equal(body.coverage_classification, "fine");
    assert.ok(body.gaps.some((item) => item.type === "never_synced" && item.source === "mail"),
      "the unrelated Gmail gap reached the coverage decision");
    bodies.push(body);
  }
  const stable = (body) => ({
    coverage_classification: body.coverage_classification,
    results: body.results.map((row) => [row.doc_uid, row.source, row.source_kind]),
    gaps: body.gaps.map((item) => [item.type, item.source, item.source_kind]),
  });
  for (const body of bodies.slice(1)) {
    assert.deepEqual(stable(body), stable(bodies[0]),
      "polite, imperative, and padded field requests match the clean raw-search control");
  }

  for (const q of [
    "Please show me the Gmail message from Example Contact.",
    "Find the inbox message from Example Contact.",
    "Who was the sender of the email message?",
    "Look in sent mail for Example Contact.",
    "Find the mail thread with Example Contact.",
    "Show me the message from Example Contact.",
    "Open the email thread with Example Contact.",
    "What did Gmail say about Example Contact?",
  ]) {
    const messageQuestion = await (await f.post("/api/rag/unified", { q }, {
      "X-Admin-Key": f.env.ADMIN_KEY,
    })).json();
    assert.ok(messageQuestion.results?.length > 0,
      `${q}: the explicit Gmail-message control reached the same nonempty retrieval path`);
    assert.equal(messageQuestion.coverage_classification, "catastrophic",
      `${q}: an actual email-message request still requires Gmail`);
    assert.ok(messageQuestion.gaps.some((item) => item.type === "never_synced" && item.source === "mail"));
  }
});

async function explicitFromFixture(t, { from, lastGood = Date.parse(from) - 1 }) {
  const rowTime = Date.parse(from) + 60 * 60 * 1000;
  const f = await createProductFixture({ env: { BRAIN_TIMEZONE: "UTC" } });
  t.after(() => f.close());
  f.raw(`INSERT INTO sources
    (name,kind,status,created_at,last_ingest_at,last_complete_sweep_at,expected_refresh_seconds,document_count)
    VALUES ('mail','gmail','ready',?,?,?,86400,1)`,
  new Date(lastGood).toISOString(), new Date(lastGood).toISOString(), "2026-01-01T00:00:00.000Z");
  f.raw(`INSERT INTO documents
    (doc_uid,source,source_id,title,ingested_at,content_hash,meta,document_date,date_source,date_reliable)
    VALUES ('mail:renewal','mail','renewal','Synthetic renewal',?,'fixture','{}',?,'fixture',1)`,
  rowTime, rowTime);
  f.raw(`INSERT INTO chunks
    (chunk_uid,doc_uid,chunk_ix,text,source,title,document_date)
    VALUES ('mail:renewal#0','mail:renewal',0,'Synthetic Gmail renewal record',
      'mail','Synthetic renewal',?)`, rowTime);
  return f;
}

test("explicit from instants reach both JSON classifiers at negative, zero, and positive offsets", async (t) => {
  const question = "What did Gmail say about the renewal?";
  for (const from of [
    "2026-10-01T00:00:00-07:00",
    "2026-10-01T00:00:00Z",
    "2026-10-01T00:00:00+09:00",
  ]) {
    await t.test(from, async (t) => {
      const f = await explicitFromFixture(t, { from });
      for (const route of ["unified", "think"]) {
        const body = await (await f.post(`/api/rag/${route}`, { q: question, from }, {
          "X-Admin-Key": f.env.ADMIN_KEY,
        })).json();
        assert.ok(body.results?.length > 0, `${route}: a matching stored row reached the decision point`);
        assert.equal(body.coverage_classification, "catastrophic", `${route}: explicit ${from} closes coverage`);
        if (route === "think") {
          assert.equal(body.answer, null);
          assert.equal(body.evidence_gate?.supported, false);
        }
      }
    });
  }

  await t.test("matching-row green control", async (t) => {
    const from = "2026-10-01T00:00:00-07:00";
    const f = await explicitFromFixture(t, { from, lastGood: Date.parse(from) });
    for (const route of ["unified", "think"]) {
      const body = await (await f.post(`/api/rag/${route}`, { q: question, from }, {
        "X-Admin-Key": f.env.ADMIN_KEY,
      })).json();
      assert.ok(body.results?.length > 0, `${route}: control kept the matching row`);
      assert.notEqual(body.coverage_classification, "catastrophic", `${route}: equal cutoff remains covered`);
      if (route === "think") assert.notEqual(body.evidence_gate?.reason,
        "the question's primary source does not cover the requested period",
        "think: covered control is not withheld by the period-start policy");
    }
  });
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

  const dropped = await importMutant("side_note: renderCoverageSideNote(notable, nowMs, timeZone),", "side_note: null,");
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

test("the four pure review mutants are killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const importMutant = async (from, to) => {
    assert.equal(source.includes(from), true, `mutation marker exists: ${from}`);
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString("base64")}#${randomBytes(8).toString("hex")}`);
  };

  const historyArgs = { question: "What did Gmail say?", now: NOW,
    gaps: [gap("Gmail", "gmail", null, "history_unproven")] };
  const noHistory = await importMutant('  "history_unproven",\n', "");
  assert.notDeepEqual(noHistory.classifyQuestionCoverage(historyArgs), classifyQuestionCoverage(historyArgs),
    "dropping history_unproven is observable");

  const noQuickBooks = await importMutant('if (/\\b(?:quickbooks|qbo)\\b/.test(q)) named.add("quickbooks");',
    'if (false) named.add("quickbooks");');
  assert.notDeepEqual(noQuickBooks.classifyQuestionCoverage({ question: "What is my QuickBooks balance?" }),
    classifyQuestionCoverage({ question: "What is my QuickBooks balance?" }),
    "leaving QuickBooks unmapped is observable");

  const truncated = await importMutant("return new Date(instant).toISOString();",
    "return new Date(instant).toISOString().slice(0, 10);");
  const window = { start: Date.parse("2026-09-30T15:00:00.000Z") };
  assert.notEqual(truncated.coverageWindowStart(window), retrievalStatus.coverageWindowStart(window),
    "restoring UTC date truncation is observable");

  const noPartial = await importMutant('if (gap?.type === "ledger_coverage_stale" && gap?.missing_from && gap?.requested_through) {',
    "if (false) {");
  const partialArgs = { question: "How much money came in this year?", now: NOW, timeZone: "UTC", gaps: [{
    type: "coverage_stale", source: "bank ledger", source_kind: "ledger",
    last_good_sync_at: "2026-09-29T12:00:00.000Z", detail: "older connector gap",
  }, {
    type: "ledger_coverage_stale", source: "bank ledger", source_kind: "ledger",
    last_good_sync_at: "2026-10-23T17:55:00.000Z", missing_from: "2026-10-01",
    covered_through: "2026-09-30", requested_through: "2026-10-23", detail: "fixture",
  }] };
  assert.notDeepEqual(noPartial.classifyQuestionCoverage(partialArgs), classifyQuestionCoverage(partialArgs),
    "dropping the recent-sync partial interval note is observable");
  assert.match(classifyQuestionCoverage(partialArgs).side_note || "", /Oct 1 through Oct 23/,
    "the missing interval wins when another bank-ledger gap was emitted first");
});

test("the three second-round policy mutants are killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const importMutant = async (from, to) => {
    assert.equal(source.includes(from), true, `mutation marker exists: ${from}`);
    return import(`data:text/javascript;base64,${Buffer.from(source.replace(from, to)).toString("base64")}#${randomBytes(8).toString("hex")}`);
  };

  const ledgerArgs = {
    question: "What is my bank balance?",
    questionType: "money",
    gaps: [{
      type: "ledger_not_consulted",
      reason: "no_accounts",
      source: "bank ledger",
      source_kind: "ledger",
      detail: "No authorized account coverage was available.",
    }],
    evidenceSources: ["ledger"],
    now: NOW,
  };
  const widenedReason = await importMutant(
    'no_accounts: ledgerRefusal("link_required", false,',
    'no_accounts: ledgerRefusal("link_required", true,',
  );
  assert.notDeepEqual(widenedReason.classifyQuestionCoverage(ledgerArgs), classifyQuestionCoverage(ledgerArgs),
    "widening a link refusal into a coverage outage is observable");
  assert.equal(classifyQuestionCoverage(ledgerArgs).refuse, false);
  assert.equal(widenedReason.classifyQuestionCoverage(ledgerArgs).refuse, true);

  const explicitFrom = Date.parse("2026-10-01T07:00:00.000Z");
  const ignoredExplicit = await importMutant(
    "const start = explicitFrom ?? timeWindow?.start;",
    "const start = timeWindow?.start;",
  );
  assert.equal(retrievalStatus.coveragePeriodStart(explicitFrom, null), "2026-10-01T07:00:00.000Z");
  assert.notEqual(ignoredExplicit.coveragePeriodStart(explicitFrom, null),
    retrievalStatus.coveragePeriodStart(explicitFrom, null),
    "ignoring the validated explicit from instant is observable");

  const numericNow = Date.parse("2030-01-15T12:00:00.000Z");
  const numericArgs = {
    question: "What did Gmail say?",
    now: numericNow,
    gaps: [{
      type: "coverage_stale",
      source: "Gmail",
      source_kind: "gmail",
      last_good_sync_at: new Date(numericNow - 2 * DAY).toISOString(),
      detail: "Synthetic stale coverage",
    }],
    evidenceSources: ["gmail"],
  };
  const brokenNumeric = await importMutant(
    'if (typeof value === "number") return Number.isFinite(value) ? value : null;',
    'if (typeof value === "number") return null;',
  );
  assert.notDeepEqual(brokenNumeric.classifyQuestionCoverage(numericArgs),
    classifyQuestionCoverage(numericArgs),
    "breaking finite numeric now handling is observable");
});

test("the field-name source override restored mutant is killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const fieldHint = '      (!contactFieldLookup && /\\bemail\\b/.test(q))) add("email");';
  const evidenceUnion = '  const primarySourceKinds = new Set(evidenceKinds);\n  for (const source of questionSources.sources || []) primarySourceKinds.add(source);';
  assert.equal(source.includes(fieldHint), true, "the field-versus-channel decision marker exists");
  assert.equal(source.includes(evidenceUnion), true, "the evidence-source union marker exists");
  const mutantSource = source
    .replace(fieldHint, '      /\\bemail\\b/.test(q)) add("email");')
    .replace(evidenceUnion, "  const primarySourceKinds = questionSources.sources || evidenceKinds;");
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}#${randomBytes(8).toString("hex")}`);
  const args = {
    question: "What is Example Contact's email address?",
    gaps: [{ type: "never_synced", source: "Drive", source_kind: "drive", last_good_sync_at: null }],
    evidenceSources: ["drive"],
    now: NOW,
  };
  assert.equal(classifyQuestionCoverage(args).classification, "catastrophic",
    "the fixed classifier reaches the actual evidence source");
  assert.equal(mutant.classifyQuestionCoverage(args).classification, "fine",
    "the restored field-name override loses the actual evidence source");
});

test("the untrimmed contact-question mutant is killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const routeTrim = '  const q = String(question || "").normalize("NFKC").toLowerCase().trim();';
  const helperTrim = '  const text = String(question || "").normalize("NFKC").replace(/\\s+/g, " ").trim();';
  assert.equal(source.includes(routeTrim), true, "the coverage normalization marker exists");
  assert.equal(source.includes(helperTrim), true, "the shared contact-intent normalization marker exists");
  const mutantSource = source
    .replace(routeTrim, '  const q = String(question || "").normalize("NFKC").toLowerCase();')
    .replace(helperTrim, '  const text = String(question || "").normalize("NFKC").replace(/\\s+/g, " ");');
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(mutantSource).toString("base64")}#${randomBytes(8).toString("hex")}`);
  const args = {
    question: "  What is the email address for Example Contact?  ",
    gaps: [{ type: "never_synced", source: "Gmail", source_kind: "gmail", last_good_sync_at: null }],
    evidenceSources: ["upload"],
    now: NOW,
  };
  assert.equal(classifyQuestionCoverage(args).classification, "fine");
  assert.equal(mutant.classifyQuestionCoverage(args).classification, "catastrophic",
    "without trimming, the field noun is misclassified as the Gmail channel");
});

test("the closed-prefix contact intent mutant is killed", async () => {
  const file = fileURLToPath(new URL("../src/lib/retrieval-status.js", import.meta.url));
  const source = readFileSync(file, "utf8");
  const normalizedRule = '  const contactFieldLookup = contactFieldIntent(q) !== null;';
  const closedPrefix = '  const contactFieldLookup = /^(?:what is|what\\\'s)\\b/.test(q) && contactFieldIntent(q) !== null;';
  assert.equal(source.includes(normalizedRule), true, "the normalized field-intent marker exists");
  const mutant = await import(`data:text/javascript;base64,${Buffer.from(source.replace(
    normalizedRule, closedPrefix,
  )).toString("base64")}#${randomBytes(8).toString("hex")}`);
  const args = {
    question: "Find the email address for Example Contact.",
    gaps: [{ type: "never_synced", source: "Gmail", source_kind: "gmail", last_good_sync_at: null }],
    evidenceSources: ["upload"],
    now: NOW,
  };
  assert.equal(classifyQuestionCoverage(args).classification, "fine");
  assert.equal(mutant.classifyQuestionCoverage(args).classification, "catastrophic",
    "restoring a closed leading prefix turns the field noun back into a Gmail channel request");
});
