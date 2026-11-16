import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Prompt-compliant money drafts, an engineered excerpt cut, and a clean zero-result control.
import { row, NOW } from "./lib.mjs";
const owner = "Owner Example";
const ok = (n = [1], reason = "direct support") => ({ supported: true, complete: true, evidence: n, reason, conflicts: [] });
const day = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString().slice(0, 10);
const lease = "Maple Street lease agreement between the landlord and Northgate Bakery LLC. Monthly rent: $4,200.00 due on the first of each month.";
const contract = "Harbor Supply contract with Northgate Bakery LLC. Late payment: a fee of 1.5% per month applies to balances unpaid after 30 days.";
const invoice = "Invoice 1047. From Harbor Supply to Northgate Bakery LLC. Total $860.00. PAID IN FULL on 2026-09-14.";
const filler = (n) => "General recitals and background wording that does not bear on the question. ".repeat(n);
const lead = "compressor rating per the maker sheet, measured under standard load and normal temperature, with regular service at the stated interval and approved parts fitted by a certified technician, is ".padEnd(193, " ").slice(0, 192) + " ";
export const cases = [
  { id: "Q06d-lease-rent-reliable-date-mandated-form", owner, q: "What does the Maple Street lease agreement say the monthly rent is?",
    rows: [row(1, { title: "Maple Street lease agreement", daysAgo: 3, text: lease })],
    draft: `As of ${day(3)}, the record states "${lease}" [1]. Current status is unknown.`, verdict: ok() },
  { id: "Q06e-lease-rent-unverified-date-mandated-form", owner, q: "What does the Maple Street lease agreement say the monthly rent is?",
    rows: [row(1, { title: "Maple Street lease agreement", daysAgo: 3, reliable: false, text: lease })],
    draft: `As of ${day(3)}, the record states "${lease}" [1]. Current status is unknown.`, verdict: ok() },
  { id: "Q25b-late-fees-mandated-form", owner, q: "What does the Harbor Supply contract say about late payment fees?",
    rows: [row(1, { title: "Harbor Supply contract", daysAgo: 3, text: contract })],
    draft: `As of ${day(3)}, the record states "${contract}" [1]. Current status is unknown.`, verdict: ok() },
  { id: "Q12c-invoice-paid-mandated-form", owner, q: "What does invoice 1047 from Harbor Supply say about payment?",
    rows: [row(1, { title: "Harbor Supply invoice 1047", daysAgo: 59, text: invoice })],
    draft: `As of ${day(59)}, the record states "${invoice}" [1]. Current status is unknown.`, verdict: ok() },
  { id: "O09b-number-cut-at-excerpt-edge", owner, q: "What is the compressor rating?",
    rows: [row(1, { title: "Warranty certificate", text: filler(4) + lead + "1,250,000 cycles before service. " + filler(6) })],
    draft: (n, all) => { const m = all.match(/technician, is ([\d,]+)(…)?/); return `The rating is ${m ? m[1].replace(/,$/, "") : "not stated"} cycles [1].`; }, verdict: ok(), keepBody: true },
  { id: "O12-zero-results-plain-document-question", owner, q: "Do we have a signed NDA with Brightline Software?", rows: [] },
];
