import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Red-team reruns with fairer fixtures, the remaining red-team cases, and the auditor's own hard cases.
import { readFileSync } from "node:fs";
import { row, C } from "./lib.mjs";
const owner = "Owner Example";
const ok = (n = [1], reason = "direct support") => ({ supported: true, complete: true, evidence: n, reason });
// The candidate's own owner-confirmed fixture, lifted verbatim from its evidence-authority test.
const src = readFileSync(`${C}/worker/test/evidence-authority.test.mjs`, "utf8");
const a = src.indexOf("const ownerRow = ("); const b = src.indexOf("\n});", a) + 4;
const ownerRow = new Function(`${src.slice(a, b)}\nreturn ownerRow;`)();
const filler = (n) => "General recitals and background wording that does not bear on the question. ".repeat(n);
const taxHead = (t, body) => ({ authority_document_head: `[${t}]\n\n${body}` });
export const cases = [
  { id: "Q06b-lease-says-rent-unverified-date", owner, q: "What does the Maple Street lease agreement say the monthly rent is?",
    rows: [row(1, { title: "Maple Street lease agreement", reliable: false, text: "Maple Street lease agreement between the landlord and Northgate Bakery LLC. Monthly rent: $4,200.00 due on the first of each month." })],
    draft: "The Maple Street lease agreement sets monthly rent at $4,200.00, due on the first of each month [1].", verdict: ok() },
  { id: "Q06c-lease-says-rent-reliable-date", owner, q: "What does the Maple Street lease agreement say the monthly rent is?",
    rows: [row(1, { title: "Maple Street lease agreement", reliable: true, text: "Maple Street lease agreement between the landlord and Northgate Bakery LLC. Monthly rent: $4,200.00 due on the first of each month." })],
    draft: "The Maple Street lease agreement sets monthly rent at $4,200.00, due on the first of each month [1].", verdict: ok() },
  { id: "Q12b-invoice-says-paid-in-full", owner, q: "What does invoice 1047 from Harbor Supply say about payment?",
    rows: [row(1, { title: "Harbor Supply invoice 1047", daysAgo: 59, text: "Invoice 1047. From Harbor Supply to Northgate Bakery LLC. Total $860.00. PAID IN FULL on 2026-09-14." })],
    draft: "Invoice 1047 was paid in full on 2026-09-14 [1].", verdict: ok() },
  { id: "Q09b-1040-matching-head", owner, q: "How much did my 2024 tax return say I owe?",
    rows: [row(1, { title: "Owner Example 2024 tax return Form 1040", daysAgo: 200, kind: "upload", extra: { client: "Owner Example", ...taxHead("Owner Example 2024 tax return Form 1040", "Taxpayer: Owner Example. 2024 Form 1040 individual income tax return."), }, text: "Form 1040 (2024). Taxpayer: Owner Example. Amount you owe: 3,140." })],
    draft: "Your 2024 Form 1040 shows an amount you owe of 3,140 [1].", verdict: ok() },
  { id: "Q09c-partial-tax-scope-early-return", owner, q: "What ordinary business income was reported on the 2024 Form 1065?",
    rows: [row(1, { title: "Northgate Bakery LLC 2024 tax return Form 1065", daysAgo: 200, kind: "upload", extra: { client: "Northgate Bakery LLC", ...taxHead("Northgate Bakery LLC 2024 tax return Form 1065", "Taxpayer: Northgate Bakery LLC. 2024 Form 1065 partnership return.") }, text: "Form 1065 (2024). Northgate Bakery LLC. Ordinary business income: 48,200." })],
    draft: "The 2024 Form 1065 reports ordinary business income of 48,200 [1].", verdict: ok() },
  { id: "Q10b-k1-what-does-it-say", owner, q: "What does my K-1 from Ridgeline Partners say?",
    rows: [row(1, { title: "2024 Schedule K-1 Ridgeline Partners", daysAgo: 250, text: "Schedule K-1 (Form 1065) 2024. Partnership: Ridgeline Partners. Partner: Owner Example. Ordinary business income: 12,400." })],
    draft: "Your 2024 Schedule K-1 from Ridgeline Partners reports ordinary business income of 12,400 [1].", verdict: ok() },
  { id: "Q13b-signature-block-outside-excerpt", owner, q: "Who signed the Harbor Supply agreement and when?",
    rows: [row(1, { title: "Harbor Supply agreement", text: "Harbor Supply agreement between Harbor Supply and Northgate Bakery LLC for weekly deliveries. " + filler(14) + " Executed on March 3, 2025 by the general manager for Harbor Supply and by the managing member for Northgate Bakery LLC." })],
    draft: (n, all) => /Executed on March 3, 2025/.test(all) ? "It was executed on March 3, 2025 by Harbor Supply's general manager and Northgate Bakery LLC's managing member [1]." : "The agreement is between Harbor Supply and Northgate Bakery LLC [1].",
    verdict: (all) => /Executed on March 3, 2025/.test(all) ? ok() : { supported: true, complete: false, evidence: [1], reason: "the signatories and the signing date" } },
  { id: "Q14b-notice-clause-outside-excerpt", owner, q: "What's the termination notice period in the Brightline Software contract?",
    rows: [row(1, { title: "Brightline Software contract", text: "Brightline Software contract. Termination is addressed in Section 9. " + filler(14) + " Section 9: either party may end this contract with 60 days' written notice." })],
    draft: (n, all) => /60 days' written notice/.test(all) ? "Either party may end the contract with 60 days' written notice [1]." : "The documents do not answer the question.", verdict: ok() },
  { id: "Q15-operative-conflict", owner: "Taylor Example", q: "What is Taylor's current mailing address?",
    rows: [ownerRow({ id: "same-time-a", value: "100 New Avenue", supersedes: "50 Old Road" }), ownerRow({ id: "same-time-b", value: "200 Other Avenue", supersedes: "50 Old Road" })],
    draft: "Two owner-confirmed records dated 2026-09-01 disagree: one says 100 New Avenue [1] and the other says 200 Other Avenue [2].", verdict: ok([1, 2]) },
  // ---- auditor's own hard cases ----
  { id: "O01-verifier-reply-unreadable", owner, q: "When is the vendor review?",
    rows: [row(1, { title: "Vendor review memo", text: "The review is November 13. The vendor will attend." })],
    draft: "The review is November 13 [1].", verdict: "I think this looks fine." },
  { id: "O02-draft-without-citation", owner, q: "When is the vendor review?",
    rows: [row(1, { title: "Vendor review memo", text: "The review is November 13. The vendor will attend." })],
    draft: "The review is November 13.", verdict: ok() },
  { id: "O03-how-much-notice-nonmoney", owner, q: "How much notice do I have to give to cancel the Brightline contract?",
    rows: [row(1, { title: "Brightline Software contract", text: "Either party may cancel this contract with 60 days' written notice." })],
    draft: "You must give 60 days' written notice to cancel the Brightline contract [1].", verdict: ok() },
  { id: "O04-scanned-ocr-policy-number", owner, q: "What is the policy number on the insurance certificate?",
    rows: [row(1, { title: "Insurance certificate (scan)", textSource: "ocr", text: "Certificate of insurance. Policy number BX-204-7781. Insured: Northgate Bakery LLC." })],
    draft: "The policy number on the insurance certificate is BX-204-7781 [1].", verdict: ok() },
  { id: "O05-text-message-start-date", owner, q: "What did the contractor text me about the start date?",
    rows: [row(1, { title: "Contractor", source: "imessage", kind: "imessage", daysAgo: 2, text: "Contractor: we can start the patio work on Monday November 16." })],
    draft: "The contractor texted that the patio work can start on Monday November 16 [1].", verdict: ok() },
  { id: "O06-is-license-current", owner, q: "Is my business license current?",
    rows: [row(1, { title: "City business license", daysAgo: 120, text: "City business license issued to Northgate Bakery LLC. Valid through June 30, 2027." })],
    draft: "Yes. Your city business license is valid through June 30, 2027 [1].", verdict: ok() },
  { id: "O07-yesterday-email-unverified-date", owner, q: "What did the landlord email me yesterday?",
    rows: [row(1, { title: "Parking lot resurfacing", source: "gmail", kind: "gmail", daysAgo: 1, reliable: false, text: "From the landlord: the parking lot will be resurfaced on November 21, please move vehicles." })],
    draft: "The landlord emailed that the parking lot will be resurfaced on November 21 and asked you to move vehicles [1].", verdict: ok() },
  { id: "O08-two-records-disagree-on-deadline", owner, q: "When is the lease renewal deadline?",
    rows: [row(1, { title: "Maple Street lease", daysAgo: 400, text: "Renewal notice is due by March 1, 2027." }), row(2, { title: "Re: renewal timing", source: "gmail", kind: "gmail", daysAgo: 10, text: "From the landlord: I can extend the renewal deadline to April 15, 2027." })],
    draft: "The lease sets the renewal deadline at March 1, 2027 [1]; a later email from the landlord extends it to April 15, 2027 [2].", verdict: ok([1, 2]) },
  { id: "O09-clipped-number-in-excerpt", owner, q: "What cycle rating does the compressor warranty certificate state?",
    rows: [row(1, { title: "Compressor warranty certificate", text: filler(4).slice(0, 190) + " The compressor warranty certificate states a cycle rating of 1,250,000 cycles before service. " + filler(8) })],
    draft: (n, all) => `The cycle rating is ${(all.match(/cycle rating of ([\d,]+)/) || [, "not stated"])[1]} cycles [1].`, verdict: ok(), keepBody: true },
  { id: "O10-meeting-decision-control", owner, q: "What did we decide about the retainer in the Q3 sync?",
    rows: [row(1, { title: "Q3 sync", source: "meeting", kind: "zoom", text: "We agreed to defer the retainer until January." })],
    draft: "In the Q3 sync you agreed to defer the retainer until January [1].", verdict: ok() },
  { id: "O11-coverage-gap-with-clear-record", owner, q: "When is the vendor review?",
    rows: [row(1, { title: "Vendor review memo", text: "The review is November 13. The vendor will attend." })],
    draft: "The documents do not answer the question.", verdict: ok(),
    mk: { sourceRows: [{ name: "drive", kind: "google_drive", zone: null, status: "error" }] } },
];
