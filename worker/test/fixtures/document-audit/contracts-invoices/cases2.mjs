import { fileURLToPath as auditRootPath, pathToFileURL as auditFileUrl } from "node:url";
// Round 2: controls and variants that pin each root cause. Synthetic only.
import { row } from "./harness.mjs";
import { byId as R1 } from "./cases.mjs";
const RT = "CLAUDE-REDTEAM-DOC-ANSWERS-1112.md";
const clone = (id, over) => ({ ...R1[id], ...over });
const INV2210 = "INVOICE 2210. From: Brightline Software Inc. Bill to: Northgate Bakery LLC. Invoice date 2026-10-01. Point-of-sale subscription, annual. Subtotal $4,500.00. Tax $360.00. Total $4,860.00. Payment received 2026-10-10: $2,000.00. Balance due $2,860.00. Due date 2026-10-31.";
const LEASE = "COMMERCIAL OFFICE LEASE. Landlord: Maple Street Holdings LP. Tenant: Northgate Bakery LLC. Premises: 410 Maple Street, Suite B, used as office and retail space. Term: 2024-03-01 through 2029-02-28. Base rent: $4,200 per month, due on the first of each month. Security deposit: $4,800. Section 14, Early Termination: Tenant may terminate this lease early by giving 90 days' written notice and paying two months' base rent as a termination fee.";
export const CASES = [
  clone("C01", { id: "C01-control2", src: "control for C01 (same lease, question says 'lease' not 'office lease')", q: "What does our lease say about early termination?",
    required: "Same answer as C01; shows the withhold in C01 is keyed to the two words 'office lease' in the question." }),
  clone("C03", { id: "C03b", src: `${RT} Q3 (plain 'still a vendor' draft)`, draft: "Yes, Harbor Supply is still a vendor: it confirmed it will keep delivering every Tuesday [1].",
    required: "'As of the 2026-10-02 email, likely yes', with confidence and what is missing." }),
  clone("C03", { id: "C03c", src: `${RT} Q3 (status word plus as-of date)`, draft: "As of 2026-10-02, Harbor Supply is still an active vendor: it confirmed it will keep delivering every Tuesday [1].",
    required: "Same as C03b." }),
  clone("C04", { id: "C04-control", src: "control for C04 (same notes, reliable date)", rows: [row({ id: "renewal-notes-r", title: "Maple Street lease renewal notes", category: "notes", date: "2026-11-03", reliable: 1,
      text: "Lease renewal notes for Northgate Bakery LLC and Owner Example. The landlord left a voicemail offering a three-year renewal at a 4% increase. The renewal is not signed yet; Dana wants to counter at 3%." })],
    required: "The newest record's content with its date and a confidence line." }),
  clone("C04", { id: "C04-control2", src: "control for C04 (same notes, reliable date, draft carries the as-of date)", rows: [row({ id: "renewal-notes-r", title: "Maple Street lease renewal notes", category: "notes", date: "2026-11-03", reliable: 1,
      text: "Lease renewal notes for Northgate Bakery LLC and Owner Example. The landlord left a voicemail offering a three-year renewal at a 4% increase. The renewal is not signed yet; Dana wants to counter at 3%." })],
    draft: "As of 2026-11-03, the landlord had left a voicemail offering a three-year renewal at a 4% increase, and the renewal was not signed yet [1].",
    required: "The newest record's content with its date and a confidence line." }),
  clone("C13", { id: "C13b", src: `${RT} Q13 (draft avoids 'Co.' so the sentence splitter is not involved)`, draft: "The agreement is between Northgate Bakery LLC as Buyer and Harbor Supply as Seller [1].",
    required: "The signers and date, or 'not in the excerpt read'; never 'Not covered by the documents' when the stored record holds it." }),
  clone("C15", { id: "C15b", src: `${RT} Q15 (one figure per sentence, so the money span check is not the blocker)`,
    draft: "One owner-confirmed record sets the catering package price at $1,800 [1]. Another owner-confirmed record sets it at $1,950 [2].",
    required: "Both values, each cited, Low confidence, missing: a later owner confirmation." }),
  clone("C25a", { id: "C25-control", src: "control for C25a (same clause, draft without the '(Section 6)' reference)",
    draft: "The Harbor Supply agreement says invoices unpaid 30 days after the invoice date accrue a late fee of 1.5% per month [1].", required: "Same clause, cited, confidence." }),
  clone("O08", { id: "O08-control", src: "control for O08 (draft copies the amendment sentence, no dates)", cites: [1],
    draft: "The monthly fee is changed from $900 to $1,050 [1].", required: "Same fact, cited, confidence." }),
  { id: "C06b", src: `${RT} Q6 (owner names the document and asks what it says)`, q: "What does the Maple Street lease say the monthly rent is?", rows: [row({ id: "maple-lease", title: "Maple Street Lease", text: LEASE, date: "2024-03-01" })],
    draft: "The Maple Street lease sets base rent at $4,200 per month [1].", required: "'$4,200 per month per Maple Street Lease (2024-03-01)', cited, confidence. The owner named the document and asked what it says.", search: true },
  { id: "C06c", src: `${RT} Q6 / F9 bullet 1 (document amount, record has only a file date)`, q: "What is the total on invoice 2210 from Brightline Software?", rows: [row({ id: "inv-2210-undated", title: "Brightline Software Invoice 2210", text: INV2210, date: "2026-10-03", reliable: 0, category: "invoice" })],
    draft: "Invoice 2210 from Brightline Software totals $4,860.00 [1].",
    required: "'$4,860.00 per Brightline Software Invoice 2210 (invoice date printed 2026-10-01; file date unverified)', cited, lowered confidence." },
  { id: "C21", src: `${RT} Q21 pattern (answer model unavailable) on a contract question`, q: "What does the Harbor Supply contract say about delivery days?", aiThrows: "upstream provider failure", rows: [row({ id: "harbor-deliv", title: "Harbor Supply Agreement (executed)", date: "2025-06-02",
      text: "SUPPLY AGREEMENT between Northgate Bakery LLC (Buyer) and Harbor Supply Co. (Seller), fully signed 2025-06-02. Section 3, Delivery: Seller delivers every Tuesday before 7 a.m." })],
    draft: "", required: "An answer from the record found ('delivers every Tuesday before 7 a.m.'), with a lowered confidence saying the answer model was unavailable; not an error.", search: true },
  { id: "C19b", src: `${RT} Q19 (same scanned lease through brain_think, document phrasing)`, q: "What does the signed lease agreement say the security deposit is?", rows: [row({ id: "maple-lease-scan", state: "ocr", title: "Maple Street Lease (signed scan)", text: LEASE, date: "2024-03-01" })],
    draft: "The signed lease sets the security deposit at $4,800 [1].", required: "'$4,800, read from a scan; check the original', cited, confidence below High naming the scan." },
  { id: "C18b", src: `${RT} Q18 (install day, keyword hit while meaning search is still building)`, q: "What does the Brightline contract say about price increases?",
    rows: [row({ id: "bright-price", title: "Brightline Software Agreement", date: "2025-01-15", text: "SOFTWARE SUBSCRIPTION AGREEMENT between Northgate Bakery LLC and Brightline Software Inc. Section 13. Price increases: Brightline may raise the fee by at most 5% at each renewal with 45 days' notice." })],
    readiness: { schema_version: 33, mutation_id: "m-1", mutation_submitted_at: Date.now() - 600e3, projection_status: "pending", bootstrap_epoch: 1, bootstrap_cursor: "c", bootstrap_high_water: "h", expected_vectors: 10000, pending: 6000, submitted: 100, oldest_queued_at: Date.now() - 3600e3 },
    draft: "The Brightline agreement lets Brightline raise the fee by at most 5% at each renewal with 45 days' notice [1].",
    required: "The clause, cited, with a confidence lowered for the unfinished index and that named as what is missing." },
];
export const byId = Object.fromEntries(CASES.map(c => [c.id, c]));
