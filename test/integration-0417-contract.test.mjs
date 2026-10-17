import assert from "node:assert/strict";
import test from "node:test";
import { ledgerAccounts } from "../worker/src/lib/fin-d1.js";
import { fixture, account } from "../worker/test/fixtures/money-fix/fixture.mjs";
import * as worker from "../worker/src/lib/answer-render.js";
import * as app from "../frontend/src/lib/answer-render.js";
import { unavailableNotice as workerNotice } from "../worker/src/lib/retrieval-status.js";
import { unavailableNotice as appNotice } from "../frontend/src/lib/retrieval-status.js";
import { renderOwnerRulesSection } from "../operations/claude-workspace.mjs";

test("legacy import coverage display requires independent proof and preserves stored rows", async t => {
  const f = fixture();
  t.after(() => f.close());
  account(f);
  f.raw("UPDATE fin_account_coverage SET basis_note='Read from a bank export covering 2026-09-15 to 2026-09-15.'");
  const before = f.first("SELECT total_changes() n").n;
  const result = await ledgerAccounts(f.env);
  assert.ok(f.seen.some(sql => /FROM fin_accounts/.test(sql)), "real account projection reached");
  assert.equal(result.accounts.length, 1);
  assert.equal(result.accounts[0].coverage_status, "partial");
  assert.match(result.accounts[0].coverage_note, /unproven/);
  assert.equal(f.first("SELECT total_changes() n").n, before, "display must not rewrite coverage");
  f.raw("UPDATE fin_account_coverage SET basis_note='Independent source review completed'");
  assert.equal((await ledgerAccounts(f.env)).accounts[0].coverage_status, "complete");
});

const confidence = { percent: 80, band: "high", basis: ["checked candidate records"] };
for (const [label, response] of Object.entries({
  candidate: { answer: "The documents do not answer the question.", results: [{ title: "Synthetic record" }], confidence },
  multiple: { answer: null, results: [{}, {}], confidence },
  empty: { answer: null, results: [], confidence },
  missing: { answer: null, confidence },
  unavailable: { status: "search_unavailable", answer: null, results: [], confidence },
  partial: { status: "coverage_incomplete", answer: null, results: [{}], confidence },
  answered: { answer: "The amount is 42.", confidence },
  error: { answer: null, answer_error: "Synthetic private error" },
})) test(`Worker and app retain the same answer and confidence scope: ${label}`, () => {
  // Each surface retains its existing recovery steps for unavailable search.
  if (label === "unavailable") {
    assert.equal(worker.answerText(response), workerNotice("unknown"));
    assert.equal(app.answerText(response), appNotice("unknown"));
  } else assert.equal(worker.answerText(response), app.answerText(response));
  assert.equal(worker.confidenceText(response), app.confidenceText(response));
  assert.ok(worker.answerText(response).length > 0, "presentation decision reached");
  assert.doesNotMatch(worker.confidenceText(response), /nothing is recorded/);
  if (label === "answered") assert.equal(worker.answerText(response), response.answer);
  if (label === "candidate") assert.match(worker.answerText(response), /I found 1 record in this search/);
  if (label === "multiple") assert.match(worker.answerText(response), /I found 2 records in this search/);
  if (label === "missing") assert.equal(worker.answerText(response), "The records checked did not support an answer to this question.");
});

for (const platformName of ["darwin", "win32"]) {
  test(`owner contract preserves integrated ledger refusals and supported controls: ${platformName}`, () => {
    const text = renderOwnerRulesSection({ platformName });
    assert.match(text, /What was my profit <period>\?/);
    assert.match(text, /What was my net income <period>\?/);
    assert.match(text, /Money in minus money out, not accounting profit or cash flow/);
    assert.match(text, /cash_flow_unsupported/);
    assert.doesNotMatch(text, /`What was my cash flow <period>\?`/);
    assert.match(text, /does not currently calculate cash flow/);
    assert.match(text, /coverage_review_required/);
    assert.match(text, /bank_export_overlap_review_required/);
    assert.match(text, /merchant_selector_unsupported/);
    assert.match(text, /merchant_selector_ambiguous/);
    assert.match(text, /literal `and` and `&`/);
    assert.match(text, /Never raise a returned score/);
    assert.match(text, /confidence is unmeasured/);
    assert.doesNotMatch(text, /at (?:no more than|most) \d+% confidence/);
    assert.match(text, /kind-filter miss alone cannot establish that an account is disconnected/);
  });
}
