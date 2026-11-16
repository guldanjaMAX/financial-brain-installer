import { ownerConfidenceLine } from '../../../worker/src/lib/confidence.js';
import { describe, expect, it } from "vitest";
import { answerText, confidenceText } from "./answer-render.js";
import * as worker from "../../../worker/src/lib/answer-render.js";

const contractAnswer = [
  "$120.00 spent in October 2026 [1].",
  "Covers account ending 4321, October 1 through October 31, 2026.",
  "Possible missing or double-counted amount: $20.00 may be an own-account payment.",
  "Likely spending, because the payment has not been independently matched.",
  "How to check: compare the original statement and the receiving account.",
].join("\n");

describe("completed answer contracts", () => {
  for (const kind of ["document", "ledger"]) {
    for (const status of ["ok", "coverage_incomplete", "search_unavailable", "answer_withheld"]) {
      it(`preserves the five-part ${kind} answer with ${status} metadata`, () => {
        const response = {
          answer: contractAnswer, answer_contract: { version: 1, kind }, status,
          notice: "Legacy status notice.", next_action: null,
        };
        const rendered = answerText(response);
        expect(rendered.length, "the real answer renderer ran").toBeGreaterThan(0);
        expect(rendered).toBe(contractAnswer);
        expect(rendered).toBe(worker.answerText(response));
      });
    }
  }

  it("keeps a ledger contract ahead of legacy recurring-list repair", () => {
    const response = {
      answer: contractAnswer, answer_contract: { version: 1, kind: "ledger" },
      ledger: { set_aside_recurring: [{ payee: "Fixture payment", cadence: "monthly",
        dates: ["2026-10-01"], amount_minor: 2000, citations: [1] }] },
    };
    expect(answerText(response)).toBe(contractAnswer);
    expect(answerText(response)).toBe(worker.answerText(response));
  });

  it("keeps the older answer and coverage controls when no contract is present", () => {
    const response = { answer: contractAnswer };
    expect(answerText(response)).toBe(`${contractAnswer}\nWant to check the original record?`);
    expect(answerText(response)).toBe(worker.answerText(response));
    const incomplete = { ...response, status: "coverage_incomplete", notice: "Legacy status notice." };
    expect(answerText(incomplete)).toContain(incomplete.notice);
    expect(answerText(incomplete)).toMatch(/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    expect(answerText(incomplete)).not.toContain('$120.00');
  });

  it.each(["", "   ", null])("does not treat an empty contract answer (%j) as completed", answer => {
    const response = { answer, answer_contract: { version: 1, kind: "document" },
      status: "coverage_incomplete", notice: "Legacy status notice.", next_action: null };
    expect(answerText(response).length, "fallback renderer reached").toBeGreaterThan(0);
    expect(answerText(response)).toContain(response.notice);
    expect(answerText(response)).toMatch(/Coverage:.*Missing or counted twice:.*Estimates:.*How to check:/s);
    expect(answerText(response)).toBe(worker.answerText(response));
  });
});

describe("owner confidence lines", () => {
  it.each([
    { percent: 0, word: "Low" }, { percent: 69, word: "Low" },
    { percent: 70, word: "Medium" }, { percent: 89, word: "Medium" },
    { percent: 90, word: "High" }, { percent: 100, word: "High" },
  ])("renders $percent% as $word from the score, with its exact gaps", ({ percent, word }) => {
    const response = { confidence: { percent, band: "untrusted label",
      basis: ["Statement read.", "$20.00 payment remains unmatched."],
      missing: ["Receiving account statement.", "Independent payment match."] } };
    const rendered = ownerConfidenceLine(response.confidence);
    expect(rendered).toBe(`Confidence: ${word} (${percent}%). Why: Statement read; $20.00 payment remains unmatched. Missing: Receiving account statement; Independent payment match.`);
    expect(confidenceText(response)).toBe(worker.confidenceText(response));
    expect(confidenceText(response)).toContain(`Confidence: Low (${Math.min(20, percent)}%)`);
    expect(response.confidence.percent).toBe(percent);
  });

  it.each(["coverage_incomplete", "search_unavailable", "answer_withheld"])(
    "caps legacy confidence with the computed reading for %s", status => {
      const response = { status, confidence: { percent: 10, band: "High",
        reasons: ["The search did not complete."], missing: ["A complete source search."] } };
      expect(confidenceText(response)).toMatch(/^Confidence: Low \(10%\).*Why:.*Missing:/s);
      expect(confidenceText(response)).toContain("0 source records read");
      expect(confidenceText(response)).toContain("completed search");
      expect(confidenceText(response)).toBe(worker.confidenceText(response));
    },
  );

  it("uses explicit assessment and coverage defaults for older confidence objects", () => {
    const response = { answer: 'The recorded reading is provisional.', confidence: { percent: 0 } };
    expect(confidenceText(response)).toBe("Confidence: Low (0%). Why: No confidence assessment was returned. Missing: Independent verification and complete relevant source coverage.");
    expect(confidenceText(response)).toBe(worker.confidenceText(response));
  });

  it.each([undefined, "coverage_incomplete", "search_unavailable", "answer_withheld"])(
    "prints a computed Low score when %s has no score", status => {
      const response = { status };
      expect(confidenceText(response)).toBe(worker.confidenceText(response));
      expect(confidenceText(response)).toMatch(/^Confidence: Low \(\d+%\).*Why:.*Missing:/s);
    },
  );
});
