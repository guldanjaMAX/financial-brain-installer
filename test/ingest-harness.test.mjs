/**
 * Ingest-pipeline harness on synthetic files (P6-10b).
 *
 * The local lane runs the shipped `brain ingest --path` command over the
 * synthetic folder in worker/test/fixtures/ingest-synthetic/, with only its
 * network, lock and OCR boundaries injected. The Drive lane runs the Drive
 * connector's own exclusion and extraction on a synthetic listing. Every
 * envelope a sync would POST is captured and handed to the Worker's own
 * admission check.
 *
 * Two kinds of test live here.
 *
 *  - Ordinary tests assert behaviour the product already promises: exclusion
 *    before any read, a complete skip report, per-page OCR on a scan, mail
 *    split per message, and envelopes the Worker admits.
 *  - `todo` tests assert behaviour the harness shows the product does NOT yet
 *    have. They run and fail visibly as TODO without failing the suite. Each
 *    one names the gap; a fix should flip it to an ordinary test.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

globalThis.fetch = async () => { throw new Error("unexpected unmocked request"); };

const {
  SYNTHETIC_FILES_ROOT,
  generatedFiles,
} = await import("../worker/test/fixtures/ingest-synthetic/build.mjs");
const {
  SYNTHETIC_DRIVE_SOURCE,
  SYNTHETIC_EXCLUDED_DRIVE_IDS,
  SYNTHETIC_LOCAL_SOURCE,
  perPageOcrStub,
  runSyntheticDriveExtraction,
  runSyntheticLocalSync,
} = await import("../worker/test/fixtures/ingest-synthetic/harness.mjs");
const { ingestEnvelopeValidationError } = await import("../worker/src/lib/ingest-envelope.js");

const posix = (value) => String(value || "").split("\\").join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Every byte the synthetic folder holds, keyed by POSIX relative path. */
function syntheticBytes() {
  const out = new Map();
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else out.set(posix(relative(SYNTHETIC_FILES_ROOT, full)), readFileSync(full));
    }
  };
  visit(SYNTHETIC_FILES_ROOT);
  for (const [rel, bytes] of generatedFiles()) out.set(rel, Buffer.from(bytes));
  return out;
}

const local = await runSyntheticLocalSync();
const byId = new Map(local.envelopes.map((envelope) => [envelope.source_id, envelope]));
const finalReceipt = local.receipts.at(-1);

/* The exact keys of a single-file local envelope, and of one mbox message. */
const LOCAL_FILE_KEYS = [
  "content", "date_reliable", "date_source", "metadata", "occurred_at", "source_id",
  "source_original_receipt", "source_type", "text_reliable", "text_source", "title", "uri",
];
const LOCAL_MESSAGE_KEYS = LOCAL_FILE_KEYS.filter((key) => key !== "source_original_receipt");

const EXPECTED_SENT = [
  "mail/2026-03-20 Lender One notice.eml",
  "mail/Payer One thread.mbox#thread-0001@example.invalid",
  "mail/Payer One thread.mbox#thread-0002@example.invalid",
  "notes/2026-03-14 Store North weekly note.md",
  "scans/Payer One remittance scan.pdf",
  "scans/Store North intake form.pdf",
  "sheets/payroll-register-2026-03.csv",
  "sheets/sales-summary-2026-03.xlsx",
  "statements/2026-03-31 Store North statement.pdf",
  "statements/Lender One lease schedule.pdf",
];

/* ------------------------------------------------------------ local lane */

test("the real local sync completes over the synthetic folder", () => {
  assert.equal(local.failure, null, String(local.failure?.stack || local.failure));
  assert.deepEqual([...byId.keys()].sort(), EXPECTED_SENT);
  assert.equal(local.result.created, EXPECTED_SENT.length);
  assert.equal(local.receipts[0].status, "indexing");
  assert.equal(finalReceipt.status, "ready");
  assert.equal(finalReceipt.walk_complete, true);
  assert.equal(finalReceipt.docs_added, EXPECTED_SENT.length);
});

test("every batch is the exact docs array sendBatches would POST, and the Worker admits each envelope", () => {
  assert.ok(local.batches.length >= 1);
  assert.deepEqual(local.batches.flat(), local.items.map((item) => item.envelope));
  assert.equal(local.admissions.length, local.envelopes.length);
  for (const answer of local.admissions) {
    assert.equal(answer.status, "created", `${answer.source_id}: ${answer.error || ""}`);
  }
  for (const envelope of local.envelopes) {
    assert.equal(ingestEnvelopeValidationError(envelope), null, envelope.source_id);
  }
});

test("envelopes have the shape a real sync produces, and receipts bind the exact original bytes", () => {
  const bytes = syntheticBytes();
  for (const envelope of local.envelopes) {
    assert.equal(envelope.source_type, SYNTHETIC_LOCAL_SOURCE);
    const message = Object.hasOwn(envelope.metadata, "family_of");
    assert.deepEqual(Object.keys(envelope).sort(), message ? LOCAL_MESSAGE_KEYS : LOCAL_FILE_KEYS,
      envelope.source_id);
    assert.equal(envelope.metadata.category, SYNTHETIC_LOCAL_SOURCE);
    assert.equal(envelope.metadata.provenance_receipt?.status, "complete", envelope.source_id);
    if (message) continue;
    const original = bytes.get(envelope.source_id);
    assert.ok(original, `no synthetic original for ${envelope.source_id}`);
    assert.equal(envelope.uri, envelope.source_id);
    assert.equal(envelope.source_original_receipt.locator_kind, "source_relative_path");
    assert.equal(envelope.source_original_receipt.original_content_sha256, sha256(original), envelope.source_id);
    assert.equal(envelope.source_original_receipt.original_byte_count, original.length, envelope.source_id);
  }
  // The filename date wins over content and is labelled as such.
  const note = byId.get("notes/2026-03-14 Store North weekly note.md");
  assert.ok(note.occurred_at.startsWith("2026-03-14"));
  assert.equal(note.date_source, "filename");
});

test("a private-prefix folder is excluded before any byte is read, and reported", () => {
  assert.ok(!local.prepared.some(({ rel }) => rel.startsWith("private-ledger")),
    "prepare() was called on an excluded file");
  assert.ok(!local.envelopes.some((envelope) => envelope.source_id.startsWith("private-ledger")));
  assert.ok(!local.envelopes.some((envelope) => /owner-only/u.test(envelope.content)));
  assert.match(local.output, /private prefixes enforced: private-/u);
  assert.match(local.output, /matched a private path prefix from the manifest\s+e\.g\. private-ledger/u);
});

test("the skip report names every file that was not indexed, with its reason", () => {
  const skipped = local.prepared
    .filter(({ result }) => result.skip)
    .map(({ rel, result }) => [rel, result.skip.reason]);
  // prepare() reports these two itself. The empty file and the private folder
  // are refused by the walk before prepare(), and the credential refusal comes
  // after it, in the sync's own gate; all five reach the report below.
  assert.deepEqual(skipped.sort(), [
    ["misc/register-export.dat", "no extractor for \".dat\" files"],
    ["scans/thin-text receipt.pdf", "only 12 characters of text, too little to answer anything"],
  ]);
  assert.ok(!local.prepared.some(({ rel }) => rel === "notes/empty placeholder.txt"));
  assert.ok(local.prepared.some(({ rel, result }) => rel === "notes/pasted settings.txt" && result.envelope));
  assert.ok(!byId.has("notes/pasted settings.txt"));
  assert.ok(local.envelopes.every((envelope) => !/sk-a{32}/u.test(envelope.content)));
  assert.match(local.output, /5 file\(s\) not indexed:/u);
  for (const reason of [
    /file is empty\s+e\.g\. notes.empty placeholder\.txt/u,
    /matched a private path prefix from the manifest/u,
    /no extractor for "\.dat" files\s+e\.g\. misc.register-export\.dat/u,
    /refused: carries openai_legacy_key\s+e\.g\. pasted settings/u,
    /only N characters of text, too little to answer anything\s+e\.g\. scans.thin-text receipt\.pdf/u,
  ]) assert.match(local.output, reason);
  assert.equal(local.result.skipped, 5);
  assert.equal(local.result.docs_excluded, 2);
  assert.equal(finalReceipt.docs_refused, 5);
  assert.match(finalReceipt.detail, /coverage_gaps=3; adjudicated_skips=2/u);
  // Refusals keep the sweep from claiming completeness.
  assert.equal(finalReceipt.complete_sweep, false);
});

test("OCR is stubbed per page and reaches only the scanned document", () => {
  assert.deepEqual(local.ocrCalls.map(({ page, totalPages, source, sourceItemId, hasImage }) =>
    [sourceItemId, page, totalPages, source, hasImage]), [
    ["scans/Payer One remittance scan.pdf", 1, 2, SYNTHETIC_LOCAL_SOURCE, true],
    ["scans/Payer One remittance scan.pdf", 2, 2, SYNTHETIC_LOCAL_SOURCE, true],
  ]);
  const scan = byId.get("scans/Payer One remittance scan.pdf");
  assert.equal(scan.text_source, "ocr");
  assert.equal(scan.text_reliable, false);
  assert.equal(scan.metadata.ocr.pages_read, 2);
  assert.equal(scan.metadata.ocr.model, "synthetic-ocr-stub");
  assert.match(scan.content, /\[\[page 2 \| OCR\]\]/u);
  const native = byId.get("statements/2026-03-31 Store North statement.pdf");
  assert.equal(native.text_source, "native");
  assert.equal(native.text_reliable, true);
  assert.match(native.content, /Closing balance 19,747\.76/u);
});

test("a scan carrying only stray form labels is indexed but labelled partial and unreliable", () => {
  const form = byId.get("scans/Store North intake form.pdf");
  assert.equal(form.text_source, "native");
  assert.equal(form.text_reliable, false);
  assert.equal(form.metadata.extraction_incomplete, true);
  assert.match(form.metadata.extraction_note, /^only \d+ characters per page, so this PDF is probably a scan/u);
  assert.match(local.output, /indexed with a caveat: only \d+ characters per page/u);
});

test("mail-shaped sources: one .eml document, and one document per mbox message", () => {
  const notice = byId.get("mail/2026-03-20 Lender One notice.eml");
  assert.match(notice.content, /^From: Lender One <lender-one@example\.invalid>/u);
  assert.match(notice.content, /Subject: Store North covenant reporting reminder/u);
  const messages = local.envelopes.filter((envelope) => envelope.metadata.archive === "mail/Payer One thread.mbox");
  assert.deepEqual(messages.map((envelope) => envelope.metadata.message_number), [1, 2]);
  for (const message of messages) {
    assert.equal(message.metadata.family_of, `${SYNTHETIC_LOCAL_SOURCE}:mail/Payer One thread.mbox`);
    assert.equal(typeof message.date_source, "string");
  }
  const plan = local.items.find((item) => item.envelope.metadata.archive)?.familyPlan;
  assert.equal(plan.family_kind, "declared");
  assert.equal(plan.expectedParts, 2);
});

test("spreadsheets with title rows still carry every figure into the envelope", () => {
  const csv = byId.get("sheets/payroll-register-2026-03.csv").content;
  for (const figure of ["1250.00", "1010.40", "980.00", "812.15"]) assert.ok(csv.includes(figure), figure);
  const xlsx = byId.get("sheets/sales-summary-2026-03.xlsx").content;
  for (const figure of ["5090.40", "4923.65", "5302.90"]) assert.ok(xlsx.includes(figure), figure);
  assert.match(xlsx, /^Sheet: Weekly \(sales-summary-2026-03\.xlsx\)/u);
});

/* ------------------------------------------------------------ drive lane */

const driveRun = await runSyntheticDriveExtraction();

test("a reviewed Drive file id is excluded before download and reported", () => {
  for (const id of SYNTHETIC_EXCLUDED_DRIVE_IDS) {
    assert.ok(!driveRun.fetchCalls.includes(id), `${id} was downloaded`);
    assert.ok(!driveRun.envelopes.some((envelope) => envelope.source_id === id));
    const skip = driveRun.skips.find((entry) => entry.id === id);
    assert.equal(skip?.reason, "excluded by reviewed file-id policy");
  }
  assert.deepEqual(driveRun.policy.excludeFileIds, [...SYNTHETIC_EXCLUDED_DRIVE_IDS]);
  assert.deepEqual(driveRun.skips.map((entry) => [entry.id, entry.code ?? null]), [
    ["drive-file-reviewed-duplicate", null],
    ["drive-file-shortcut", "shortcut_not_followed"],
    ["drive-file-photo", "non_text_media"],
  ]);
  assert.deepEqual(driveRun.fetchCalls,
    ["drive-file-license-invoice", "drive-file-remittance-scan", "drive-file-deposit-log"]);
});

test("Drive envelopes are admitted by the Worker and keep the bare file id", () => {
  assert.deepEqual(driveRun.envelopes.map((envelope) => envelope.source_id),
    ["drive-file-license-invoice", "drive-file-remittance-scan", "drive-file-deposit-log"]);
  for (const answer of driveRun.admissions) assert.equal(answer.status, "created", answer.error);
  for (const envelope of driveRun.envelopes) {
    assert.equal(envelope.source_type, SYNTHETIC_DRIVE_SOURCE);
    assert.equal(envelope.metadata.drive_id, envelope.source_id);
    assert.equal(envelope.metadata.top_folder, "Store North");
  }
  assert.deepEqual(driveRun.ocrCalls.map(({ sourceItemId, page, source }) => [sourceItemId, page, source]),
    [["drive-file-remittance-scan", 1, SYNTHETIC_DRIVE_SOURCE]]);
});

test("the harness OCR stub can be swapped for a failing one without touching the pipeline", async () => {
  const unreadable = perPageOcrStub({ pageText: () => "" });
  const run = await runSyntheticDriveExtraction({ ocr: unreadable });
  assert.equal(unreadable.calls.length, 1);
  const skip = run.skips.find((entry) => entry.id === "drive-file-remittance-scan");
  assert.match(skip?.reason || "", /OCR was attempted/u);
  assert.ok(!run.envelopes.some((envelope) => envelope.source_id === "drive-file-remittance-scan"));
});

/* ------------------------------------------------- gaps the harness found */

test("hybrid PDF: a scanned page beside a text page is not reported as complete native text", {
  todo: "extractPdf OCRs only when the whole document has no text layer; page 2 of the hybrid is dropped silently",
}, () => {
  const hybrid = byId.get("statements/Lender One lease schedule.pdf");
  const flagged = hybrid.text_reliable === false || hybrid.metadata.extraction_incomplete === true;
  const ocrd = local.ocrCalls.some((call) => call.sourceItemId === "statements/Lender One lease schedule.pdf");
  assert.ok(flagged || ocrd, "the scanned second page vanished while the envelope claims reliable native text");
});

test("thin-text scans: with OCR on, a scan carrying stray text still reaches OCR or says why not", {
  todo: "extractPdf OCRs only an empty text layer; a stray label sends a scan to the quality gate (refused) " +
    "or indexes the label alone, and OCR is never offered",
}, () => {
  const ocrd = (id) => local.ocrCalls.some((call) => call.sourceItemId === id);
  const skip = local.prepared.find(({ rel }) => rel === "scans/thin-text receipt.pdf")?.result.skip;
  assert.ok(ocrd("scans/thin-text receipt.pdf") || /scan|OCR/iu.test(skip?.reason || ""), skip?.reason);
  assert.ok(ocrd("scans/Store North intake form.pdf"), "the labelled scan was never offered to OCR");
});

test("spreadsheet title rows: data rows pair with the real header, not the title", {
  todo: "renderTableResult treats a title row as the header (xlsx) or finds no header (csv)",
}, () => {
  const xlsx = byId.get("sheets/sales-summary-2026-03.xlsx").content;
  assert.doesNotMatch(xlsx, /Store North Sales Summary: 2026-03-07/u);
  assert.match(xlsx, /Week Ending: 2026-03-07/u);
  const csv = byId.get("sheets/payroll-register-2026-03.csv").content;
  assert.match(csv, /Payee: Payee One \| Pay Date: 2026-03-13/u);
});
