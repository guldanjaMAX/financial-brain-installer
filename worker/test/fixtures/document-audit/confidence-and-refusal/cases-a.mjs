import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Cases claimed by the three confidence-docs reviews (RDC-*, R3-*, R4-*), replayed through the real /api/rag/think route.
import { row } from "./lib.mjs";
const memo = () => [row(1, { title: "Vendor review memo", text: "The review is November 13. The vendor will attend." })];
const q = "When is the vendor review?";
const ok = { supported: true, complete: true, evidence: [1], reason: "direct support" };
const no = { supported: false, complete: false, evidence: [], reason: "the draft declines and states no fact" };
export const cases = [
  { id: "A0-control-supported", q, rows: memo(), draft: "The review is November 13 [1].", verdict: ok },
  { id: "RDC-01a-bold-refusal-approved", q, rows: memo(), draft: "**I cannot answer this question.** [1]", verdict: ok },
  { id: "RDC-01b-heading-refusal-approved", q, rows: memo(), draft: "## Answer\nI cannot answer this question [1].", verdict: ok },
  { id: "R3-01-cannot-provide-approved", q, rows: memo(), draft: "I cannot provide the review date [1].", verdict: ok },
  { id: "R4-01a-cannot-disclose-approved", q, rows: memo(), draft: "I cannot disclose the review date [1].", verdict: ok },
  { id: "R4-01b-must-decline-approved", q, rows: memo(), draft: "I must decline to provide the review date [1].", verdict: ok },
  { id: "A1-refusal-draft-verifier-rejects", q, rows: memo(), draft: "I cannot determine the review date [1].", verdict: no },
  { id: "A2-canonical-refusal-while-record-states-it", q, rows: memo(), draft: "The documents do not answer the question.", verdict: ok },
  { id: "R3-02-bold-label-model-confidence", q, rows: memo(), draft: "The review is November 13 [1].\n**Confidence:** High (100%).", verdict: ok },
  { id: "R3-02b-plain-model-confidence", q, rows: memo(), draft: "The review is November 13 [1].\nConfidence: High (100%).", verdict: ok },
  { id: "R3-03-source-percentage", q: "What confidence percentage does the forecast report assign?", rows: [row(1, { title: "Forecast report", text: "The report's confidence is 95% for completion." })], draft: "The report's confidence is 95% for completion [1].", verdict: ok },
  { id: "R4-02c-source-5-percent", q: "What confidence percentage does the forecast report assign?", rows: [row(1, { title: "Forecast report", text: "The report's confidence is 5% for completion." })], draft: "The report's confidence is 5% for completion [1].", verdict: ok },
  { id: "RDC-04-fee-at-excerpt-boundary-withheld", q: "What does the renewal email say about the quoted fee?", rows: [row(1, { title: "Renewal email", source: "gmail", kind: "gmail", text: ("Background paragraph. ".repeat(40)).slice(0, 682) + "\nThe fee is USD $1,250.00, payable after signing." })], draft: "The quoted fee is $1,250.00 [1].", verdict: no },
  { id: "RDC-04b-fee-at-900-prompt-boundary", q: "What does the renewal memo state as the renewal code?", rows: [row(1, { title: "Renewal memo", text: ("Background paragraph. ".repeat(60)).slice(0, 885) + "\nRenewal code 125000 applies." })], draft: (n, all) => /Renewal code 125000/.test(all) ? "The renewal code is 125000 [1]." : "The renewal code is " + ((all.match(/Renewal code (\d+)/) || [])[1] || "not visible") + " [1].", verdict: ok },
  { id: "R3-04-fourth-record-refusal", q: "What is the monthly service tier named in the plan summary?", rows: [row(1, { title: "Background A", text: "General background about the service plan." }), row(2, { title: "Background B", text: "More background about the plan." }), row(3, { title: "Background C", text: "Plan history notes." }), row(4, { title: "Plan summary", text: "The monthly service tier is Gold." })], draft: "I cannot determine the monthly service tier [4].", verdict: { supported: true, complete: true, evidence: [4], reason: "ok" } },
];
