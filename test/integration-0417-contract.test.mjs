import { assertOwnerEvidence } from './helpers/owner-evidence-contract.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { ledgerAccounts } from "../worker/src/lib/fin-d1.js";
import { fixture, account } from "../worker/test/fixtures/money-fix/fixture.mjs";
import * as worker from "../worker/src/lib/answer-render.js";
import * as app from "../frontend/src/lib/answer-render.js";
import { unavailableNotice as workerNotice } from "../worker/src/lib/retrieval-status.js";
import { unavailableNotice as appNotice } from "../frontend/src/lib/retrieval-status.js";
import { renderOwnerRulesSection } from "../operations/claude-workspace.mjs";
import { ownerConfidenceLine } from "../worker/src/lib/confidence.js";
import { legacyDocumentResponse } from "../worker/src/lib/document-answer-reading.js";

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

test("Worker and app render only reviewed refusal next actions with older-Worker fallbacks", () => {
  const workerCoverage = 'Next: say "check my Brain" to see which source is still loading, then ask again.';
  const appCoverage = "Next: open Brain status to see which source is still loading, then ask again.";
  assert.equal(worker.nextActionText({ status: "coverage_incomplete", answer: null }), workerCoverage);
  assert.equal(app.nextActionText({ status: "coverage_incomplete", answer: null }), appCoverage);
  assert.equal(worker.nextActionText({ answer: null, results: [] }),
    "Next: ask again with a name, date or exact phrase the record would contain.");
  assert.equal(app.nextActionText({ answer: null, results: [] }),
    "Next: ask again with a name, date or exact phrase the record would contain.");
  assert.equal(worker.nextActionText({
    status: "answer_withheld", answer: null, results: [{}],
    evidence_gate: { supported: false },
  }), "Next: ask about one record at a time, naming its title or date.");
  assert.equal(worker.nextActionText({
    status: "coverage_incomplete", answer: null,
    next_action: "unreviewed remote instruction",
  }), null);
  assert.equal(worker.nextActionText({ answer: "A cited answer [1].", results: [{}] }), null);
  assert.equal(app.nextActionText({ answer: "A cited answer [1].", results: [{}] }), null);
});

const confidence = { percent: 80, band: "high", basis: ["checked candidate records"] };
for (const [label, response] of Object.entries({
  candidate: { answer: "The documents do not answer the question.", results: [{ title: "Synthetic record" }], confidence },
  multiple: { answer: null, results: [{}, {}], confidence },
  empty: { answer: null, results: [], confidence },
  missing: { answer: null, confidence },
  unavailable: { status: "search_unavailable", answer: null, results: [], confidence },
  partial: { status: "coverage_incomplete", answer: null, results: [{}], confidence },
  withheld: {
    status: "answer_withheld",
    notice: "The answer was withheld because it did not pass the money evidence check.",
    answer: null,
    results: [{}],
    confidence,
  },
  answered: { answer: "The amount is 42.", confidence },
  error: { answer: null, answer_error: "Synthetic private error" },
})) test(`Worker and app retain the same answer and confidence scope: ${label}`, () => {
  // 0.4.28 rebuilds incomplete legacy replies from their returned records.
  assert.equal(worker.answerText(response), app.answerText(response));
  const expected = { candidate:30, multiple:30, empty:20, missing:20, unavailable:10, partial:10, withheld:10, answered:80 };
  if (response.confidence) {
    assert.match(worker.confidenceText(response), new RegExp(`^Confidence: ${expected[label]>=70?'Medium':'Low'} \\(${expected[label]}%\\)\\. Why: .+\\. Missing: .+\\.$`));
    assert.ok(expected[label] <= response.confidence.percent, 'the returned score can only be lowered');
  } else assert.equal(worker.confidenceText(response), app.confidenceText(response));
  assert.ok(worker.answerText(response).length > 0, "presentation decision reached");
  assert.doesNotMatch(worker.confidenceText(response), /nothing is recorded/);
  if (label === "answered") assert.equal(worker.answerText(response), `${response.answer}\nWant to check the original record?`);
  if (label === "candidate") assert.match(worker.answerText(response), /I found 1 record in this search/);
  if (label === "multiple") assert.match(worker.answerText(response), /I found 2 records in this search/);
  if (label === "missing") assert.equal(worker.answerText(response), "I can help narrow the search, but the records checked did not support an answer.\nWant to try a more specific detail?");
  if (label === "withheld") {
    assert.match(worker.answerText(response), /Coverage: Read 0 of 1.*Missing or counted twice:.*Estimates:.*How to check:/s);
    assert.doesNotMatch(worker.answerText(response), /answer was withheld/);
    assert.match(worker.answerText(response), /evidence check is incomplete/i);
    assert.match(worker.confidenceText(response), /evidence check did not verify the answer/i);
  }
});

for (const platformName of ["darwin", "win32"]) {
  test(`owner contract preserves integrated ledger refusals and supported controls: ${platformName}`, () => {
    const text = renderOwnerRulesSection({ platformName });
    assert.match(text, /brain_money_guide, then go straight to brain_money_query/);
    assert.match(text, /Money in minus money out is not automatically accounting profit or cash flow/);
    assert.doesNotMatch(text, /cash_flow_unsupported|Template menu/);
    assert.match(text, /Never add up search snippets/);
    assert.match(text, /zero bank rows, say so first/);
    assert.match(text, /source and date/);
    assert.match(text, /coverage for account and date limits/);
    assert.match(text, /Card and loan payments need separate treatment/);
    assert.match(text, /Unknown mappings stay unassigned/);
    assert.match(text, /Bank categories are hints, not rules/);
    assert.match(text, /Never raise a returned score/);
    assert.match(text, /keep the internal zero ceiling and explain the missing evidence assessment in plain words/);
    assert.match(text, /Never add confidence labels or percentages to owner answers/);
    assert.doesNotMatch(text, /at (?:no more than|most) \d+% confidence/);
    assert.match(text, /Do not infer business ownership or an account kind from a memo/);
  });
}


test("a legacy veto preserves the readable figure and can only lower upstream confidence", () => {
  for (const percent of [5, 25, 80]) {
    const response = { status: "answer_withheld", answer: null,
      notice: "The answer was withheld because it did not pass the money evidence check.",
      confidence: { percent }, evidence_gate: { complete: false, supported: false },
      results: [{ n: 1, title: "Synthetic record", snippet: "The recorded fee is $42.",
        read_complete: true, text_reliable: true, text_source: "native" }] };
    const body = legacyDocumentResponse(response);
    assert.match(body.answer, /\$42/, "the returned readable record reached the final reading");
    assert.doesNotMatch(body.answer, /withheld|I cannot|I can't/i);
    assert.doesNotMatch(body.notice, /withheld/i);
    assert.ok(body.confidence.percent <= percent && body.confidence.percent < 90);
    assert.ok(body.confidence.reasons.some(reason => /evidence check/.test(reason)));
    assert.ok(body.confidence.missing.length);
    assert.equal(body.answer_contract.kind, "document");
    assert.match(body.answer, /Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
  }
});


test('owner evidence oracle rejects exposed scores and lost gaps beside a populated control', () => {
  const confidence = { percent: 69, basis: ['Recorded account ends in 1234.'], missing: ['The October statement.'] };
  const control = 'USD 12.00 in October 2026. Recorded account ends in 1234; Still needed: The October statement; this answer may be incomplete.';
  assertOwnerEvidence(control, confidence);
  for (const mutant of [control + '\nConfidence: Low (69%)', control.replace('The October statement', ''), control.replace('Recorded account ends in 1234', '')]) {
    assert.throws(() => assertOwnerEvidence(mutant, confidence), assert.AssertionError,
      'the same populated oracle catches a score or any lost evidence detail');
  }
});
