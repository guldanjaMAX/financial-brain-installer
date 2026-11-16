import { assertDocumentAnswer } from './helpers/document-answer-contract.mjs';
/**
 * A scanned copy that OCR read cleanly can be the proof behind an answer, and
 * every answer that uses one says so without leaving that to a model.
 *
 * Before this change an OCR'd document could be found and cited but could
 * never be the evidence an answer stood on: the authority check accepted only
 * a native text layer, so a question only a scan could answer ended in "The
 * search found candidate records, but they did not support an answer."
 *
 * "Complete" in ingest measures page COVERAGE, not accuracy: a page keeps its
 * "read" status with `[[UNREADABLE]]` marks inside it as long as a dozen
 * legible characters remain. So a scan counts only when BOTH hold:
 *
 *   1. the OCR receipt ingest stored with the document (`metadata.ocr`) shows a
 *      complete read with zero unreadable pages, and
 *   2. the chunk being relied on carries no unreadable mark.
 *
 * The rule is decided in the Worker at query time from what D1 already
 * stores, so a document OCR'd by any earlier version is judged by its own
 * receipt without re-ingest:
 *
 *   native + text_reliable       source-bound reading without a scan flag
 *   ocr passing both conditions  counts, is flagged `scanned: true`, and is labelled
 *   any other ocr read           provisional reading without scan authority
 *   ocr_partial, unknown         provisional reading without scan authority
 *
 * A scan of a requested tax filing that ends in no answer, including a clean
 * one the model found nothing in, still gets main's "found, but its text
 * could not be read reliably" disclosure rather than a plain refusal.
 *
 * The native, partial and unknown responses and both model prompts are pinned
 * by SHA-256. 0.4.28 candidates 5/6 changed the attributed-record contract;
 * these copy pins now describe reviewed build 62a55b76. The source-span,
 * amount, authority and no-refusal assertions still run before those pins.
 * Legacy test names mentioning refusal refer to a rejected draft, while the
 * owner still receives the reading required by assertDocumentAnswer().
 * Every name here is synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { authorityFor, ownerConfirmedRecord } from "../src/lib/evidence-authority.js";
// Namespace import: the receipt helpers are new, and a control run of this
// file against a build without them must still load and fail test by test.
import * as evidenceAuthority from "../src/lib/evidence-authority.js";
import { handleMcp } from "../src/lib/mcp-endpoint.js";
import { storeFor } from "../src/lib/store.js";
import { withFirstPartySourceProvenance } from "../src/lib/provenance-receipt.js";
import * as appRender from "../../frontend/src/lib/answer-render.js";
import {
  BLANK_SENTINEL, OCR_BANNER, UNREADABLE_SENTINEL, assembleOcr, pageMarker, unreadablePageMarker,
} from "../../ingest/ocr.mjs";
import { cmdAsk, splitStatements } from "../../brain.mjs";
import { renderReportHtml } from "../../report-html.mjs";

// Spelled out rather than imported, so an edit to a product constant cannot
// quietly rewrite what these tests claim to check.
const ANSWER_NOTICE =
  "Part of this answer comes from a scanned document read by OCR. Check the original for exact figures.";
const RESULTS_NOTICE =
  "Some of these results come from a scanned document read by OCR. Check the original for exact figures.";
const SCANNED_REASON = "its text was read by OCR from a scanned copy";
const COVERAGE_REFUSAL = "The search found candidate records, but they did not support an answer.";
const TAX_UNREADABLE_REASON = "the matching tax filing was not read from a reliable native text layer";
const PARTIAL_PROMPT_LABEL = "READ BY OCR FROM A SCAN, may be misread";
const SCANNED_PROMPT_LABEL = "SCANNED COPY READ BY OCR (every page read)";
const FIXED_NOW = Date.parse("2026-09-01T00:00:00.000Z");
const ADMIN_KEY = `fixture-${"k".repeat(40)}`;
const MCP_SERVER = fileURLToPath(new URL("../../components/brain-mcp.mjs", import.meta.url));

// 0.4.28 candidates 5/6 changed record attribution and confidence copy; semantic guards remain below.
const digest = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

// These tax snapshots retain the original evidence contract. Commits
// 26e615ed and 96bfc7c3 changed only the bank guidance in gaps[0].detail
// (also present in the answer prompt), plus the native answer's source notice.
const TAX_BANK_GUIDANCE = [
  "I want to make sure I get this right. I can show you balances, recent transactions, or what you spent in a set period. Which would help most?",
].join("\n");
const TAX_DOCUMENT_NOTICE = "This answer comes from your documents; I did not match it to your bank data.";
// The complete new copy is asserted before translating it back for the frozen
// evidence digests. Every other response and prompt byte remains covered.
const FROZEN_TAX_BANK_GUIDANCE = 'I can\'t answer that bank question as phrased. I can show balances, posted transactions, and spending for a specific period.\nTry: "What are my account balances?"';
const FROZEN_TAX_DOCUMENT_NOTICE = "I couldn't match this to your bank data, so this answer comes from your documents.";
function frozenTaxCopy(text, serialized = false) {
  const encode = value => serialized ? JSON.stringify(value).slice(1, -1) : value;
  for (const [current, frozen] of [[TAX_BANK_GUIDANCE, FROZEN_TAX_BANK_GUIDANCE], [TAX_DOCUMENT_NOTICE, FROZEN_TAX_DOCUMENT_NOTICE]]) {
    text = text.replaceAll(encode(current), encode(frozen));
  }
  return text;
}

function assertTaxResponseDigest(text, expected, message, documentAnswer = false) {
  const body = JSON.parse(text);
  assert.equal(body.gaps[0]?.detail,
    (documentAnswer ? `${TAX_DOCUMENT_NOTICE}\n` : "") + TAX_BANK_GUIDANCE,
    "the complete bank-guidance lines match the reviewed wording");
  assert.equal(digest(frozenTaxCopy(text, true)), expected, message);
  const assertDigest = value => assert.equal(digest(frozenTaxCopy(JSON.stringify(value), true)), expected, message);
  const missingSuggestion = structuredClone(body);
  missingSuggestion.gaps[0].detail = missingSuggestion.gaps[0].detail.replace(' Which would help most?', '');
  assert.notEqual(missingSuggestion.gaps[0].detail, body.gaps[0].detail, 'the next-step mutation was reached');
  assert.throws(() => assertDigest(missingSuggestion), { code: "ERR_ASSERTION" },
    "the same digest assertion rejects a missing next step");
  assert.ok(Object.hasOwn(body, "citations"), "the response/disclosure citation decision was reached");
  const missingCitations = structuredClone(body);
  delete missingCitations.citations;
  assert.throws(() => assertDigest(missingCitations), { code: "ERR_ASSERTION" },
    "the same digest assertion rejects a lost citation field");
}

function assertTaxPromptDigests(prompts, expected) {
  const frozenDigests = values => promptDigests(values.map(prompt => ({ ...prompt, text: frozenTaxCopy(prompt.text) })));
  assert.deepEqual(frozenDigests(prompts), expected,
    "answer prompt includes reviewed bank guidance; verifier prompt remains unchanged");
  const answer = prompts.find(prompt => prompt.pass === "answer");
  assert.ok(answer?.text.includes(TAX_BANK_GUIDANCE), "the answer model received the complete bank guidance");
  const missingSuggestion = prompts.map(prompt => prompt === answer
    ? { ...prompt, text: prompt.text.replace(TAX_BANK_GUIDANCE, TAX_BANK_GUIDANCE.replace(' Which would help most?', '')) }
    : prompt);
  assert.notEqual(missingSuggestion.find(prompt => prompt.pass === 'answer').text, answer.text, 'the prompt next-step mutation was reached');
  assert.throws(() => assert.deepEqual(frozenDigests(missingSuggestion), expected), { code: "ERR_ASSERTION" },
    "the same prompt assertion rejects a missing next step");
}

/* ------------------------------------------------------------ fixtures */

/**
 * The metadata a receipt-writing ingest stores. The D1 read path exposes a
 * row's text source only when this receipt validates against the same row, and
 * treats every other row as `unknown`, native or not. An OCR read also stores
 * its OCR receipt under `ocr`, exactly as ingest/run.mjs and the Drive
 * connector do.
 */
function storedMeta(row, { ocr = null } = {}) {
  const recorded = row.text_source !== "unknown";
  return JSON.stringify({
    evidence_lineage: { version: 1, kind: "source_record", root_ids: [] },
    provenance_receipt: {
      version: 1,
      status: recorded ? "complete" : "partial",
      reason: recorded ? "lineage_and_text_recorded" : "text_provenance_unavailable",
      root_ids: [`${row.source}:${row.source_id}`],
    },
    ...(ocr ? { ocr } : {}),
  });
}

/**
 * The OCR receipt ingest stores as `metadata.ocr` for these pages: the real
 * assembleOcr() provenance, never a hand-written copy of its shape. A page is
 * its model output, or `{ error }` for a page that could not be read.
 */
function ocrReceipt(pages) {
  const verdict = assembleOcr(
    pages.map((page, index) => (typeof page === "string"
      ? { page: index + 1, text: page }
      : { page: index + 1, ...page })),
    { totalPages: pages.length, model: "fixture-ocr-model" },
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  return verdict.provenance;
}

const TEXT_STATES = Object.freeze({
  native: { text_source: "native", text_reliable: 1 },
  ocr: { text_source: "ocr", text_reliable: 0 },
  ocr_partial: { text_source: "ocr_partial", text_reliable: 0 },
  unknown: { text_source: "unknown", text_reliable: 0 },
});

// A scan's stored text opens with the exact banner and page marker ingest
// writes, so the fixtures carry the real OCR layout rather than clean prose.
const storedText = (textSource, body) => textSource === "ocr" || textSource === "ocr_partial"
  ? `${OCR_BANNER}\n\n${pageMarker(1)}\n${body}`
  : body;

const CONTRACT_PAGE = [
  "The service contract between Example Orchard LLC and Harbor Storage remains active and renews each August.",
  "The monthly storage fee is $1,240.",
].join("\n");
// The same page with one region the model marked illegible. It keeps enough
// legible text to stay "read", so ingest records a COMPLETE read with zero
// unreadable pages: only the passage itself shows what could not be read.
const MARKED_CONTRACT_PAGE = [
  "The service contract between Example Orchard LLC and Harbor Storage remains active and renews each August.",
  "The monthly storage fee is $1,240. The late fee is [[UNREADABLE]] per month.",
].join("\n");
// Long enough that a read with a second, unreadable or blank, page still
// clears the characters-per-page floor ingest holds every read to.
const LONG_CONTRACT_PAGE = `${CONTRACT_PAGE}\n${
  "Every unit is inspected each quarter and the report is filed with this contract. ".repeat(2).trim()}`;

/**
 * A stored contract chunk. An `ocr` row carries the complete-read receipt
 * ingest writes for its page unless the test passes another receipt, or null
 * for a scan stored with no OCR receipt at all.
 */
function contractRow(state, { id = state, page = CONTRACT_PAGE, receipt } = {}) {
  const { text_source, text_reliable } = TEXT_STATES[state];
  const row = {
    chunk_uid: `drive:storage-contract-${id}#0`,
    doc_uid: `drive:storage-contract-${id}`,
    source: "drive",
    source_kind: "drive",
    source_id: `storage-contract-${id}`,
    title: "Harbor Storage service contract",
    client: "Harbor Storage",
    category: "contract",
    document_date: Date.parse("2026-08-03T00:00:00.000Z"),
    date_source: "document_date",
    date_reliable: 1,
    text_source,
    text_reliable,
    text: storedText(text_source, page),
  };
  const ocr = receipt !== undefined ? receipt : state === "ocr" ? ocrReceipt([page]) : null;
  return { ...row, authority_meta: storedMeta(row, { ocr }) };
}

const TAX_TITLE = "Example Orchard LLC 2023 tax return Form 1065";
const TAX_PAGE = [
  "Taxpayer: Example Orchard LLC",
  "Form 1065 U.S. Return of Partnership Income, tax year 2023",
  "Ordinary business income (loss): $48,210",
].join("\n");
// The figure asked about is legible; another line on the same page is not.
const MARKED_TAX_PAGE = `${TAX_PAGE}\nGuaranteed payments to partners: $[[UNREADABLE]]`;

function taxReturnRow(state, { id = state, page = TAX_PAGE, receipt } = {}) {
  const { text_source, text_reliable } = TEXT_STATES[state];
  const chunk = `[${TAX_TITLE}]\n\n${storedText(text_source, page)}`;
  const row = {
    chunk_uid: `drive:orchard-1065-${id}#0`,
    doc_uid: `drive:orchard-1065-${id}`,
    source: "drive",
    source_kind: "drive",
    source_id: `orchard-1065-${id}`,
    title: TAX_TITLE,
    client: "Example Orchard LLC",
    category: "tax",
    document_date: Date.parse("2024-03-15T00:00:00.000Z"),
    date_source: "document_date",
    date_reliable: 1,
    text_source,
    text_reliable,
    authority_document_head: chunk,
    text: chunk,
  };
  const ocr = receipt !== undefined ? receipt : state === "ocr" ? ocrReceipt([page]) : null;
  return { ...row, authority_meta: storedMeta(row, { ocr }) };
}

// Three scans the stored column calls a complete read (`text_source` ocr) that
// still cannot be proof, each failing one half of the rule.
const markedContract = () => contractRow("ocr", { id: "ocr-marked", page: MARKED_CONTRACT_PAGE });
// Current ingest stores any read with an unreadable page as ocr_partial, so
// this row, whose column says otherwise, can only come from a receipt and a
// column that disagree. The receipt is still the real one ingest writes.
const unreadablePageContract = () => contractRow("ocr", {
  id: "ocr-unreadable-page",
  page: LONG_CONTRACT_PAGE,
  receipt: ocrReceipt([LONG_CONTRACT_PAGE, { error: "the model returned nothing for this page" }]),
});
// The shape of an owner-uploaded image: OCR text with no OCR receipt at all.
const receiptlessContract = () => contractRow("ocr", { id: "ocr-no-receipt", receipt: null });

// A registered source whose history is not yet proven complete: the ordinary
// state of a young Brain, and the one that turns a refusal into the
// "found candidate records" notice the owner actually reads.
const HISTORY_UNPROVEN = [{
  name: "drive", kind: "drive", zone: null, status: "ready",
  last_ingest_at: "2026-08-31T00:00:00.000Z", last_complete_sweep_at: null,
  expected_refresh_seconds: null, stale_reason: null, document_count: 12,
  indexing_started_at: null, registered: 1,
}];

const Q_STATUS = "Is the Harbor Storage service contract still active?";
const A_STATUS = "The Harbor Storage service contract is still active [1].";
const Q_GENERAL = "What monthly fee does the Harbor Storage service contract set?";
const A_GENERAL = "The Harbor Storage service contract sets a monthly storage fee of $1,240 [1].";
const Q_TAX = "What ordinary business income did Example Orchard LLC's 2023 Form 1065 report?";
const A_TAX = "Example Orchard LLC's 2023 Form 1065 reported ordinary business income of $48,210 [1].";
const Q_SEARCH = "Harbor Storage service contract";

/**
 * The Worker's real fetch handler over a fake D1, Vectorize and Workers AI.
 * Both model passes are deliberately overconfident, so every refusal below is
 * the deterministic evidence rule and never a model's judgement.
 */
function brainEnv({
  rows, coverageRows = [], answer = "", evidence = [1], verdict = null, inventoryFails = false, prompts = [],
} = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      exec: async () => {},
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => {
            // The document-level tax inventory probe failing leaves its
            // coverage unverified, as a D1 outage does.
            if (inventoryFails && /unchunked-tax-document-candidates/.test(sql)) {
              throw new Error("fixture inventory outage");
            }
            if (/FROM chunks_fts/.test(sql)) return { results: rows.map((row) => ({ ...row })) };
            if (/SELECT s\.name, s\.kind, s\.zone, s\.status/.test(sql) && /FROM sources s/.test(sql)) {
              return { results: coverageRows.map((row) => ({ ...row })) };
            }
            return { results: [] };
          },
          first: async () => {
            if (/vector_projection_mutation_id AS mutation_id/.test(sql)) {
              return {
                schema_version: 33, mutation_id: null, mutation_submitted_at: null,
                projection_status: "verified", bootstrap_epoch: 0, bootstrap_cursor: null,
                bootstrap_high_water: null, expected_vectors: 0, pending: 0, submitted: 0,
                oldest_queued_at: null,
              };
            }
            if (/SUM\(est_cost_usd_micros\)/.test(sql)) return { m: 0 };
            return null;
          },
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
      batch: async () => [],
    },
    VECTORIZE: {
      query: async () => ({ matches: [] }),
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
    AI: {
      run: async (model, input) => {
        if (String(model).includes("bge-")) return { data: [[0.1, 0.2, 0.3]] };
        const system = String(input?.messages?.[0]?.content || "");
        const user = String(input?.messages?.[1]?.content || "");
        if (/verify a proposed answer/.test(system)) {
          prompts.push({ pass: "verifier", system, text: user });
          return {
            response: verdict || { supported: true, complete: true, evidence, reason: "the cited record states it" },
            usage: {},
          };
        }
        prompts.push({ pass: "answer", system, text: user });
        return { response: answer, usage: {} };
      },
    },
  };
}

/** One private POST to a read route, with the clock pinned so gaps are stable. */
async function route(path, env, q, limit = 5) {
  const realNow = Date.now;
  Date.now = () => FIXED_NOW;
  try {
    const response = await worker.fetch(new Request(`https://brain.invalid${path}`, {
      method: "POST",
      headers: { "X-Admin-Key": "k", "Content-Type": "application/json" },
      body: JSON.stringify({ q, limit }),
    }), env, { waitUntil() {} });
    assert.equal(response.status, 200);
    const body = JSON.parse(await response.text());
    // Query timing carries a random request id and real elapsed durations.
    // Keep this feature regression byte-pinned without treating unrelated
    // content-free diagnostics as part of the evidence response contract.
    delete body.timing;
    return { text: JSON.stringify(body), body };
  } finally {
    Date.now = realNow;
  }
}

const think = (options, q) => route("/api/rag/think", brainEnv(options), q);
const unified = (options, q) => route("/api/rag/unified", brainEnv(options), q);

const scannedGapOf = (body) => (body.gaps || []).find((gap) => gap?.type === "scanned_evidence");

/** Digest of each model pass's complete prompt, system and user message together. */
const promptDigests = (prompts) => Object.fromEntries(
  prompts.map((prompt) => [prompt.pass, digest(`${prompt.system}\u0000${prompt.text}`)]),
);

/** A response with no trace of the new flag, gap or evidence-gate receipt. */
function assertNoScannedTrace(text) {
  assert.equal(text.includes('"scanned"'), false, "no row or citation may carry the scanned flag");
  assert.equal(text.includes("scanned_evidence"), false, "no scanned gap or gate receipt may appear");
  assert.equal(text.includes(SCANNED_REASON), false, "no authority reason may claim a scanned basis");
}

/* ------------------------------------------------------------ the rule */

test("a complete OCR read is reliable evidence, and its authority says it was read off a scan", () => {
  const authority = authorityFor(contractRow("ocr"), { query: Q_STATUS, claimText: A_STATUS, current: true });
  assert.equal(authority.eligible, true);
  assert.equal(authority.authoritative, true, "a complete read can now be the proof behind a current claim");
  assert.equal(authority.scanned, true, "the authority object carries the scanned flag");
  assert.equal(authority.reason, `a recorded direct source artifact (contract); ${SCANNED_REASON}`);

  const undated = authorityFor({ ...contractRow("ocr"), date_reliable: 0 }, {
    query: Q_STATUS, claimText: A_STATUS, current: true,
  });
  assert.equal(undated.authoritative, false, "a scan earns no exemption from the as-of date rule");
  assert.equal(undated.scanned, true);
  assert.equal(undated.reason,
    `a recorded direct source artifact (contract); ${SCANNED_REASON}; it has no reliable as-of date for a current claim`);

  const carried = authorityFor({ ...contractRow("ocr"), authority }, {
    query: Q_STATUS, claimText: A_STATUS, current: true,
  });
  assert.equal(carried.reason, authority.reason, "a carried scanned reason is not labelled twice");
});

test("a partial OCR read and an unknown text source stay excluded, byte for byte", () => {
  const options = { query: Q_STATUS, claimText: A_STATUS, current: true };
  const excluded = {
    tier: "T1",
    rank: 1,
    name: "primary",
    reason: "a recorded direct source artifact (contract); its text was not obtained from a reliable native text layer",
    claim: "transaction_status",
    eligible: true,
    authoritative: false,
    current: true,
    owner_confirmed: false,
    operative: false,
  };
  assert.deepEqual(authorityFor(contractRow("ocr_partial"), options), excluded);
  assert.deepEqual(authorityFor(contractRow("unknown"), options), excluded);
  for (const textSource of [undefined, null, "", "fabricated", "ocr_unverified"]) {
    assert.deepEqual(authorityFor({ ...contractRow("native"), text_source: textSource }, options), excluded,
      `text_source ${JSON.stringify(textSource)} must remain unreliable`);
  }
});

test("native authority is unchanged, including a native layer ingest marked unreliable", () => {
  const options = { query: Q_STATUS, claimText: A_STATUS, current: true };
  assert.deepEqual(authorityFor(contractRow("native"), options), {
    tier: "T1",
    rank: 1,
    name: "primary",
    reason: "a recorded direct source artifact (contract)",
    claim: "transaction_status",
    eligible: true,
    authoritative: true,
    current: true,
    owner_confirmed: false,
    operative: false,
  });
  for (const textReliable of [0, false, "0", null, undefined]) {
    const authority = authorityFor({ ...contractRow("native"), text_reliable: textReliable }, options);
    assert.equal(authority.authoritative, false);
    assert.equal(authority.reason,
      "a recorded direct source artifact (contract); its text was not obtained from a reliable native text layer");
    assert.equal(Object.hasOwn(authority, "scanned"), false);
  }
});

test("an owner confirmation still requires the Worker's own native text", () => {
  const day = "2026-09-01";
  const confirmation = {
    source: "curated",
    source_id: `owner-confirmed/${day}/confirmation-1`,
    title: `Confirmed by the owner, ${day}`,
    category: "owner-confirmed",
    client: "Example Orchard LLC",
    document_date: Date.parse(`${day}T12:00:00.000Z`),
    date_source: "owner_confirmation",
    date_reliable: 1,
    text_source: "native",
    text_reliable: 1,
    authority_meta: JSON.stringify({
      authority: "T1", operative: true, subject: "Example Orchard LLC", client_name: "Example Orchard LLC",
    }),
    text: [
      `# Confirmed by the owner, ${day}`,
      "",
      "Subject: Example Orchard LLC",
      "",
      "## Mailing address",
      "Operative value: 100 New Avenue",
      `As of: ${day}, confirmed by the owner`,
      "Supersedes: 50 Old Road",
    ].join("\n"),
  };
  assert.equal(ownerConfirmedRecord(confirmation).valid, true);
  for (const state of ["ocr", "ocr_partial", "unknown"]) {
    assert.equal(ownerConfirmedRecord({ ...confirmation, ...TEXT_STATES[state] }).valid, false,
      `an ${state} record can never be the owner's operative confirmation`);
  }
});

/* ----------------------------------------------------- the answer route */

test("a question only a scan can answer is now answered where main refused it", async () => {
  const prompts = [];
  const { body } = await think({
    rows: [contractRow("ocr")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);

  assertDocumentAnswer(body, {expected: A_STATUS});
  assert.equal(body.status, undefined);
  assert.equal(body.notice, undefined);
  assert.equal(JSON.stringify(body).includes(COVERAGE_REFUSAL), false);
  assert.equal(body.evidence_gate?.supported, true);
  assert.deepEqual(body.evidence_gate?.evidence, [1]);
  assert.deepEqual(body.evidence_gate?.scanned_evidence, [1], "the evidence gate records which approval was a scan");

  assert.equal(body.citations.length, 1);
  assert.equal(body.citations[0].scanned, true, "the citation carries the scanned flag");
  assert.equal(body.citations[0].text_source, "ocr", "stored extraction provenance is not rewritten");
  assert.equal(body.citations[0].text_reliable, false, "stored extraction provenance is not rewritten");
  assert.equal(body.citations[0].authority?.scanned, true);
  assert.equal(body.citations[0].authority?.authoritative, true);
  assert.match(body.citations[0].authority?.reason || "", new RegExp(`; ${SCANNED_REASON}$`));
  assert.equal(body.results[0].scanned, true, "the numbered result carries the scanned flag");
  assert.equal(body.evidence_authority?.scanned, true);

  assert.deepEqual(scannedGapOf(body), { type: "scanned_evidence", count: 1, total: 1, detail: ANSWER_NOTICE });
  assert.equal(body.gaps.some((gap) => gap.type === "history_unproven"), true,
    "the coverage gap still travels beside the answer");
  assert.ok(body.confidence?.basis?.some((line) => /read by OCR from a scanned image/.test(line)),
    "the confidence basis keeps pricing the OCR reading step");

  const answerPrompt = prompts.find((prompt) => prompt.pass === "answer")?.text || "";
  assert.ok(answerPrompt.includes(SCANNED_PROMPT_LABEL), "the answer model is told it is reading a scanned copy");
  assert.equal(answerPrompt.includes(PARTIAL_PROMPT_LABEL), false);
  const verifierPrompt = prompts.find((prompt) => prompt.pass === "verifier")?.text || "";
  assert.ok(verifierPrompt.includes(SCANNED_PROMPT_LABEL), "the verifier sees the same label");
});

test("the native twin of that document answers exactly as main did", async () => {
  const prompts = [];
  const { text, body } = await think({
    rows: [contractRow("native")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assertDocumentAnswer(body, {expected: A_STATUS});
  assertNoScannedTrace(text);
  assert.equal(prompts.some((prompt) => /SCANNED|OCR/.test(prompt.text)), false,
    "a native-only prompt says nothing about scans");
  assert.equal(digest(text), "df656cc159084f266957075198da8d9131679ea95a0927459ccabf2c0ebab92c", "native /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "6588f5845976ec0d03acafbf8b0a0b7453575644a202d8b42a6bc53b49b698c9",
    verifier: "cddeccdf8e06e204f543f8002e600657f3515135125d40f029522a3ac97c12c1",
  }, "both model prompts are byte-identical to main");
});

test("a partial OCR read keeps the merged refusal contract, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({
    rows: [contractRow("ocr_partial")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.ok(body.confidence.basis.some(reason => /check|incomplete|read/i.test(reason)));
  assert.equal(body.evidence_gate?.reason, "non-authoritative current-status evidence requires an exact as-of date");
  assertNoScannedTrace(text);
  const answerPrompt = prompts.find((prompt) => prompt.pass === "answer")?.text || "";
  assert.ok(answerPrompt.includes(PARTIAL_PROMPT_LABEL), "the partial label is unchanged");
  assert.equal(answerPrompt.includes(SCANNED_PROMPT_LABEL), false);
  assert.equal(digest(text), "03a84da1aa1b8c13f8b79a6858105385d2c950faeb6473767db92feef9201d9b", "partial /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "7588127b7d9657bb81326aa4693e76f4722805b633bcab497f30a328cde72ab8",
    verifier: "30c4523d950fdf6818c641090991a36e8c7c095ad96c9fad9aba85365bb4e905",
  }, "both model prompts are byte-identical to main");
});

test("an unknown text source keeps the merged refusal contract, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({
    rows: [contractRow("unknown")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.ok(body.confidence.basis.some(reason => /check|incomplete|read/i.test(reason)));
  assertNoScannedTrace(text);
  assert.equal(digest(text), "df64a2ec071229a016d0057c08f8b7ad8612a5272394fa0700cedbacf15878d9", "unknown /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "d6e516e072c0457b18a01e7d5349512d200fcff38d2800160e89164c86ec1d9d",
    verifier: "a6437ae9f2bc32ebcec9233f565a4c44852253553b2b4574438ea9c8135f1224",
  }, "both model prompts are byte-identical to main");
});

test("any answer resting on a scan carries the notice and every flag, deterministically", async () => {
  const { body } = await think({ rows: [contractRow("ocr")], answer: A_GENERAL }, Q_GENERAL);
  assertDocumentAnswer(body, {expected: A_GENERAL});
  assert.deepEqual(scannedGapOf(body), { type: "scanned_evidence", count: 1, total: 1, detail: ANSWER_NOTICE });
  assert.equal(body.citations[0].scanned, true);
  assert.equal(body.citations[0].authority?.scanned, true);
  assert.deepEqual(body.evidence_gate?.scanned_evidence, [1]);

  // A scanned copy beside a native one: the notice counts only the scan, and
  // only the scan's citation carries the flag.
  const mixed = await think({
    rows: [contractRow("ocr"), contractRow("native")],
    answer: "The monthly storage fee is $1,240 [1], and both copies of the contract state it [2].",
    evidence: [1, 2],
  }, Q_GENERAL);
  assert.ok(mixed.body.answer, JSON.stringify(mixed.body.evidence_gate));
  assert.deepEqual(scannedGapOf(mixed.body), { type: "scanned_evidence", count: 1, total: 2, detail: ANSWER_NOTICE });
  const scannedNumbers = mixed.body.citations.filter((citation) => citation.scanned === true).map((c) => c.n);
  assert.equal(scannedNumbers.length, 1);
  assert.deepEqual(mixed.body.evidence_gate?.scanned_evidence, scannedNumbers);
  const nativeCitation = mixed.body.citations.find((citation) => citation.text_source === "native");
  assert.equal(Object.hasOwn(nativeCitation || {}, "scanned"), false);

  // The notice follows the APPROVED evidence. When the existing citation check
  // refuses the draft, nothing rests on the scan and no notice is attached.
  const refused = await think({
    rows: [contractRow("ocr"), contractRow("native")],
    answer: "The monthly storage fee is $1,240 [1], and both copies of the contract state it [2].",
    evidence: [1],
  }, Q_GENERAL);
  assertDocumentAnswer(refused.body, {provisional:true, empty:!refused.body.results?.length});
  assert.equal(scannedGapOf(refused.body), undefined, "a refusal carries no scanned notice");
  assert.equal(refused.body.evidence_gate?.scanned_evidence, undefined);
});

/* ------------------------------------------------------------- tax path */

test("a complete OCR read of the exact filing can answer a tax question, labelled", async () => {
  const { body } = await think({ rows: [taxReturnRow("ocr")], answer: A_TAX }, Q_TAX);
  assertDocumentAnswer(body, {expected: A_TAX});
  assert.equal(body.status, undefined);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), false,
    "a complete read is readable tax evidence");
  assert.deepEqual(scannedGapOf(body), { type: "scanned_evidence", count: 1, total: 1, detail: ANSWER_NOTICE });
  assert.equal(body.citations[0].scanned, true);
  assert.equal(body.citations[0].authority?.tax_scope?.matched, true,
    "the OCR banner does not stop the labelled taxpayer header from matching");
  assert.deepEqual(body.evidence_gate?.scanned_evidence, [1]);
});

test("a partial OCR read of the exact filing keeps the merged unreadable refusal, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("ocr_partial")], answer: A_TAX, prompts }, Q_TAX);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.equal(body.evidence_gate?.reason, TAX_UNREADABLE_REASON);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), true);
  assert.match(body.confidence_text, /read|reliable/);
  assertNoScannedTrace(text);
  assertTaxResponseDigest(text, "652530f1f0f335c5d9ce21d2f0286a6956f6f53381780c5724f3e69bab31bb1c", "partial tax /think response bytes");
  assertTaxPromptDigests(prompts, {
    answer: "756dbc484b8fb1f0a215faeb4780c35786437b943c0e75b735a66f8acf7fc4f1",
    verifier: "7d75ca0fcdf0da27ff0714e2f55386ecf8d394f2f61620cb15ceaaa46f7c0d39",
  });
});

test("an unknown text source for the exact filing keeps the merged unreadable refusal, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("unknown")], answer: A_TAX, prompts }, Q_TAX);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.evidence_gate?.reason, TAX_UNREADABLE_REASON);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), true);
  assertNoScannedTrace(text);
  assertTaxResponseDigest(text, "76429821fd8a96145ec03d7aeb3f71faa80ffabbbb0f78c36678a15b1a82ca91", "unknown tax /think response bytes");
  assertTaxPromptDigests(prompts, {
    answer: "d01117aa25aa2249fefe37a8d9e0c45f9dc65755a07c0e3b3f9f1dbca52c6cdb",
    verifier: "cf16528b762e7ab2322ad00f6cedfe3a7abddcdfefae9208dd35b0d570d40e3a",
  });
});

test("the native filing keeps its answer and evidence with the reviewed bank guidance", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("native")], answer: A_TAX, prompts }, Q_TAX);
  assertDocumentAnswer(body, {expected: A_TAX});
  assertNoScannedTrace(text);
  assertTaxResponseDigest(text, "71307e6d8bd347b6ad10449f4e877e65f4c647d5bdc4ea6257327bfb3fe65c66", "native tax /think response bytes", true);
  assertTaxPromptDigests(prompts, {
    answer: "de3a6c996b808c0df09d07df04d1de2274a7243edc9e0eacf58a216c4e1ff8ae",
    verifier: "507a8a602ae3149ec567e93f8cb871614f43f9a6620d746709f3d86e8b56540a",
  });
});

/* -------------------------------------------------------- ranked search */

test("ranked search flags a complete OCR read and carries the results notice", async () => {
  const { body } = await unified({ rows: [contractRow("ocr"), contractRow("native")] }, Q_SEARCH);
  const scanned = body.results.find((row) => row.text_source === "ocr");
  const native = body.results.find((row) => row.text_source === "native");
  assert.equal(scanned?.scanned, true);
  assert.equal(scanned?.authority?.scanned, true);
  assert.equal(Object.hasOwn(native || {}, "scanned"), false);
  assert.deepEqual(scannedGapOf(body), { type: "scanned_evidence", count: 1, total: 2, detail: RESULTS_NOTICE });
});

test("native and partial ranked search responses are unchanged, byte for byte", async () => {
  const native = await unified({ rows: [contractRow("native")] }, Q_SEARCH);
  assertNoScannedTrace(native.text);
  assert.equal(Object.hasOwn(native.body, "gaps"), false, "a healthy native search still has no gaps field");
  assert.equal(digest(native.text), "2b54a61b7bc310bc0ed59a6ddd61088568ba0c796d67b73626ab472d163e0ef0", "native /unified response bytes");

  const partial = await unified({ rows: [contractRow("ocr_partial")] }, Q_SEARCH);
  assertNoScannedTrace(partial.text);
  assert.equal(digest(partial.text), "6aa21f82790670cdf999a4da1c85409d092b90bb8c410212ffb46004d2888270", "partial /unified response bytes");
});

/* ------------------------------------------ every surface that shows it */

async function mcpCall(tool, args, deps) {
  const response = await handleMcp({}, new Request("https://brain.invalid/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }), new URL("https://brain.invalid/mcp"), deps);
  return (await response.json()).result;
}

// Preserve the frozen pre-offer hashes for every original byte. Only the
// new final invitation and the CLI's outer blank lines are projected here.
function beforeFinalInvitation(text, cli = false) {
  const suffix = "\nWant to check the original record?";
  assert.ok(text.includes("How to check:"), 'the owner answer retains a concrete check');
  assert.equal(text.split("How to check:").length - 1, 1, "one concrete check appears");
  const facts = text;
  return cli ? `\n${facts}\n` : facts;
}

async function askCli(body) {
  const sandbox = mkdtempSync(join(tmpdir(), "brain-scanned-ask-"));
  const printed = [];
  const originalLog = console.log;
  try {
    const manifest = join(sandbox, "brain.manifest.json");
    writeFileSync(manifest, JSON.stringify({
      client: { slug: "fixture" },
      brain: { domain: "fixture.example", worker_name: "fixture-brain" },
      infrastructure: { cloudflare: { account_id: "not-needed-with-a-domain" } },
    }));
    console.log = (...args) => printed.push(args.join(" "));
    await cmdAsk(manifest, {
      ask: async () => Q_GENERAL,
      adminKey: ADMIN_KEY,
      http: async () => new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
  } finally {
    console.log = originalLog;
    rmSync(sandbox, { recursive: true, force: true });
  }
  return printed.join("\n");
}

/** Serve one canned /think body to the real local MCP server, then read its reply. */
async function localMcpThink(body) {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const child = spawn(process.execPath, [MCP_SERVER], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        BRAIN_URL: `http://127.0.0.1:${port}`,
        BRAIN_NAME: "fixture-brain",
        BRAIN_KEY: ADMIN_KEY,
        BRAIN_CONFIG: "",
        BRAIN_MANIFEST: "",
      },
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "brain_think", arguments: { q: Q_GENERAL } },
    })}\n`);
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, "the local MCP server exited non-zero");
    const reply = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((m) => m.id === 1);
    assert.ok(reply && !reply.result?.isError, stdout);
    return JSON.parse(reply.result.content[0].text);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const scannedGeneral = () => think({ rows: [contractRow("ocr")], answer: A_GENERAL }, Q_GENERAL);
const nativeGeneral = () => think({ rows: [contractRow("native")], answer: A_GENERAL }, Q_GENERAL);

test("the remote MCP ask tool states the notice and marks the scanned citation", async () => {
  const { body } = await scannedGeneral();
  const result = await mcpCall("ask", { question: Q_GENERAL }, { think: async () => body });
  const text = result.content[0].text;
  assert.ok(text.includes(ANSWER_NOTICE), text);
  assert.match(text, /^\[1\] Harbor Storage service contract \(scanned\) · drive · connector drive · 2026-08-03 · OCR text, verify key details/m);
});

test("the remote MCP search tool keeps the scanned flag on the result", async () => {
  const { body } = await unified({ rows: [contractRow("ocr")] }, Q_SEARCH);
  const result = await mcpCall("search", { query: Q_SEARCH }, { search: async () => body });
  const searched = JSON.parse(result.content[0].text);
  assert.equal(searched.results[0].scanned, true);
  assert.equal(searched.results[0].text_source, "ocr");
});

test("the remote MCP native answer keeps its original facts and final invitation", async () => {
  const { body } = await nativeGeneral();
  const result = await mcpCall("ask", { question: Q_GENERAL }, { think: async () => body });
  const text = result.content[0].text;
  assert.equal(text.includes("(scanned)"), false);
  assert.equal(text.includes(ANSWER_NOTICE), false);
  assert.equal(digest(beforeFinalInvitation(text)), "88d75cd273cb701b8f9fa3f9ca0efc9f77eb56b6662b71fa172e221281df41f8", "native MCP ask text");
});

test("brain ask prints the notice and marks the scanned citation", async () => {
  const { body } = await scannedGeneral();
  const printed = (await askCli(body)).replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(printed.includes(ANSWER_NOTICE), printed);
  assert.match(printed, /\[1\] Harbor Storage service contract \(scanned\) \(drive; 2026-08-03; OCR text, verify key details; reference drive:storage-contract-ocr\)/);
});

test("brain ask native output keeps its original facts and final invitation", async () => {
  const { body } = await nativeGeneral();
  const printed = await askCli(body);
  assert.equal(printed.includes("(scanned)"), false);
  assert.equal(printed.includes(ANSWER_NOTICE), false);
  assert.equal(digest(beforeFinalInvitation(printed, true)), "7494a92e7b6d5528eb3801495df38bf3f846a94ec1067c31417af87dcaf56c01", "native brain ask output");
});

test("the local MCP server carries the flag and the gap, and tells the assistant to relay it", async () => {
  const { body } = await scannedGeneral();
  const out = await localMcpThink(body);
  // Retired exact-draft expectation (R1 migrated its two route twins): the
  // unadmitted paraphrase is never the answer; the local server relays the
  // Worker's attributed reading unchanged.
  assertDocumentAnswer(body, {expected: A_GENERAL});
  assert.equal(out.answer, body.answer);
  assert.equal(out.citations[0].scanned, true);
  assert.deepEqual(out.gaps.find((gap) => gap.type === "scanned_evidence")?.detail, ANSWER_NOTICE);
  assert.ok(String(out.note).startsWith(ANSWER_NOTICE), String(out.note));
  assert.match(String(out.note), /scanned copy/);

  const native = await localMcpThink((await nativeGeneral()).body);
  assert.equal(native.note, undefined, "a clean native answer still carries no note");
});

test("the verification report marks the scanned citation and states the notice", async () => {
  const { body } = await scannedGeneral();
  const html = renderReportHtml({
    manifest: { client: { display_name: "Example Orchard LLC" } },
    acceptance: {
      counts: { pass: 1, fail: 0, warn: 0, skip: 0 }, passed: true, stoppedAtTier: null,
      results: [{ tier: 1, name: "health responds", status: "pass", detail: "fixture" }],
    },
    seedAnswers: [{
      question: Q_GENERAL,
      answer: body.answer,
      citations: body.citations,
      gaps: body.gaps,
      resultCount: body.results.length,
    }],
    expectedToFail: [],
    corpus: { rows: [] },
    base: "https://fixture.example",
    generatedAt: new Date("2026-09-01T00:00:00Z"),
  });
  assert.ok(html.includes("Harbor Storage service contract (scanned)"), "the citation is marked");
  assert.ok(html.includes(ANSWER_NOTICE), "the notice is stated beside the answer");
});

test("the owner app uses the same notice and citation mark", () => {
  assert.equal(appRender.SCANNED_ANSWER_NOTICE, ANSWER_NOTICE);
  assert.equal(appRender.SCANNED_CITATION_MARK, "(scanned)");
  assert.equal(typeof appRender.scannedEvidenceNotice, "function");
  assert.equal(appRender.scannedEvidenceNotice({
    answer: A_GENERAL, citations: [{ n: 1, title: "Scan", scanned: true }],
    gaps: [{ type: "scanned_evidence", count: 1, total: 1, detail: ANSWER_NOTICE }],
  }), ANSWER_NOTICE);
  assert.equal(appRender.scannedEvidenceNotice({
    answer: A_GENERAL, citations: [{ n: 1, title: "Native", text_source: "native" }], gaps: [],
  }), null);
});

/* ------------------------ the stored OCR receipt and the relied-on passage */

const REFUSAL = "The documents do not answer the question.";
const TAX_UNREADABLE_NOTICE =
  "The requested tax filing was found, but its text could not be read reliably. This is not proof that the filing omits the answer. Unlock the file or provide a readable copy before treating the result as complete.";
const PAGE_UNREADABLE = { error: "the model returned nothing for this page" };

// Unchanged prompt and surface digests were captured on main 60afb222. Tax
// response and answer-prompt digests also include the reviewed bank guidance
// from 26e615ed and 96bfc7c3. Every OCR read that does not count must still
// reach the same evidence decision under the merged refusal contract.
const PINNED = Object.freeze({
  markedStatus: {
    response: "2b142d5bb4964079404d75c22662e434458277281f1b76c66a5c9e7292ec4ce9",
    prompts: {
      answer: "c6fc7e2e79a4d8509e6faabea4fc535a140af478fa7aabc151d1b6fa0ea8d1d4",
      verifier: "631a48944a40c808369ca433b96a186f4724b8f38bd80f46f0b477d324b0412d",
    },
  },
  unreadablePageStatus: {
    response: "5ecb8a8a6d7bae123ca4455d5786ebc4e3f7bfbd126152147fb3d96057ae311c",
    prompts: {
      answer: "8cbe633bcde222bc392569f3a89949f3e56dfc2ecd260e507d30506521493d7d",
      verifier: "03f461e94c229661becb9eeb8fc5510849ea030f15cf1f0fcc67e8f3333afb47",
    },
  },
  receiptlessStatus: {
    response: "604fd6e1bb06cc46d520c220c04772a5b0550718a7974c2d5d84951e72c0128a",
    prompts: {
      answer: "7588127b7d9657bb81326aa4693e76f4722805b633bcab497f30a328cde72ab8",
      verifier: "30c4523d950fdf6818c641090991a36e8c7c095ad96c9fad9aba85365bb4e905",
    },
  },
  markedTax: {
    response: "16ae56a416e1c65bcafa0a8b5dff9e2920932b35ae059c6e0b008dae62d22dcf",
    prompts: {
      answer: "b93923d2de678cb316b4e719d907392396f3849eac45d1718656d35653eef020",
      verifier: "4e9230a6238f2df060796817cab05d66f9eacbd6d8adf0fc24758770c13c777e",
    },
  },
  markedUnified: "7f5294d3070b689c476d54c9f3a600fb947371871efebd56287b63b807d79ac1",
  markedGeneral: "8209b35b33b78e8f08ddcd90a9b083120b5ac1d821a5f6df5963215037ce5e6c",
  markedGeneralMcpAsk: "d74342d52d33c9bb097f69a1eaf87247181ae628a2d7df9f4d5dc19e4003afbf",
  markedGeneralCli: "6efe57421dafdba2e0bfbb4cfee19ae7fdc7f6647fdaffb6b4b1aa16374066d1",
  scannedTaxModelRefusal: "16fb4ceadb752dd8bf5797a3203e0aaab23792f9744fd519e0264e242fa02fab",
  markedTaxGateRefusal: "9e85b5ee396e6e630c71f817653396b3bf0dcd8be1151038757fbb00c2882c28",
  scannedTaxGateRefusal: "820439ebf8ed4e92d161fc46e82f0d02ce23d3c30ccfa2a9ba9b6920f8d96c33",
});

/** The fields that carry a refusal's disclosure, in response order. */
const disclosureOf = (body) => JSON.stringify({
  status: body.status ?? null,
  notice: body.notice ?? null,
  answer: body.answer ?? null,
  evidence_gate: body.evidence_gate ?? null,
  gaps: body.gaps ?? null,
  confidence: body.confidence ?? null,
  evidence_authority: body.evidence_authority ?? null,
  citations: body.citations ?? null,
});

test("the Worker's unreadable mark is the sentinel ingest tells the model to write", () => {
  assert.equal(evidenceAuthority.OCR_UNREADABLE_MARK, UNREADABLE_SENTINEL);
  const marked = evidenceAuthority.hasUnreadableMark;
  assert.equal(typeof marked, "function");
  for (const text of [
    UNREADABLE_SENTINEL,
    `Total due: $4${UNREADABLE_SENTINEL}0`,
    "the late fee is [[unreadable]]",
    "[[ UNREADABLE ]]",
    unreadablePageMarker(2, "the model returned nothing for this page"),
  ]) {
    assert.equal(marked(text), true, text);
  }
  for (const text of [OCR_BANNER, pageMarker(1), BLANK_SENTINEL, CONTRACT_PAGE, "", null, undefined, 42]) {
    assert.equal(marked(text), false, String(text));
  }
});

test("a stored OCR receipt counts only as a complete read with no unreadable page", () => {
  const complete = evidenceAuthority.completeOcrRead;
  assert.equal(typeof complete, "function");
  const clean = ocrReceipt([CONTRACT_PAGE]);
  assert.equal(complete({ ocr: clean }), true);

  // Coverage, not legibility: a page with a marked region is still a complete
  // read with zero unreadable pages. Only the passage check can catch it.
  const marked = ocrReceipt([MARKED_CONTRACT_PAGE]);
  assert.equal(marked.text_source, "ocr");
  assert.equal(marked.pages_unreadable, 0);
  assert.equal(marked.per_page[0].unreadable_marks, 1);
  assert.ok(marked.confidence < 1, "the mark docks confidence, which is not a gate");
  assert.equal(complete({ ocr: marked }), true);

  // A blank page is not a failure.
  assert.equal(complete({ ocr: ocrReceipt([LONG_CONTRACT_PAGE, BLANK_SENTINEL]) }), true);

  const withUnreadablePage = ocrReceipt([LONG_CONTRACT_PAGE, PAGE_UNREADABLE]);
  assert.equal(withUnreadablePage.pages_unreadable, 1);
  assert.equal(complete({ ocr: withUnreadablePage }), false);
  assert.equal(complete({ ocr: { ...clean, pages_unreadable: 1 } }), false,
    "an unreadable page decides even when everything else claims a complete read");

  // A read stopped at the configured page limit (ingest/formats.mjs ocrPdf).
  const capped = { ...clean, text_source: "ocr_partial", pages_total: 3, pages_omitted: 2 };
  assert.equal(complete({ ocr: capped }), false);
  assert.equal(complete({ ocr: { ...clean, pages_total: 3 } }), false, "every page must be accounted for");
  // D1 merges metadata as a JSON merge patch, so a later complete read of the
  // same file leaves an earlier run's pages_omitted behind; the counts decide.
  assert.equal(complete({ ocr: { ...clean, pages_omitted: 2 } }), true);

  for (const receipt of [
    { ...clean, pages_unreadable: undefined },
    { ...clean, pages_unreadable: "0" },
    { ...clean, text_source: "ocr_partial" },
    { ...clean, per_page: undefined },
    { ...clean, per_page: [] },
    { ...clean, per_page: [{ ...clean.per_page[0], status: "unreadable" }] },
    { ...clean, pages_read: 0, pages_blank: 1 },
  ]) {
    assert.equal(complete({ ocr: receipt }), false, JSON.stringify(receipt));
  }
  for (const metadata of [null, undefined, {}, { ocr: null }, { ocr: [] }, { ocr: "complete" }]) {
    assert.equal(complete(metadata), false, JSON.stringify(metadata));
  }
});

test("a public row carries retrieval's verdict as scanned: true, and its passage is checked again", async () => {
  // A row exactly as retrieval returns it, stored metadata stripped: what a
  // citation, the tax and current-status checks, and `brain check` re-read.
  const { body } = await unified({ rows: [contractRow("ocr")] }, Q_SEARCH);
  const publicRow = body.results[0];
  assert.equal(Object.hasOwn(publicRow, "authority_meta"), false);
  assert.equal(publicRow.scanned, true);
  const options = { query: Q_STATUS, claimText: A_STATUS, current: true };

  const flagged = authorityFor(publicRow, options);
  assert.equal(flagged.authoritative, true);
  assert.equal(flagged.scanned, true);

  const { scanned: _verdict, ...unflaggedRow } = publicRow;
  const unflagged = authorityFor(unflaggedRow, options);
  assert.equal(unflagged.authoritative, false, "an ocr row without retrieval's verdict is not proof");
  assert.equal(Object.hasOwn(unflagged, "scanned"), false);

  const markedPassage = authorityFor({ ...publicRow, snippet: storedText("ocr", MARKED_CONTRACT_PAGE) }, options);
  assert.equal(markedPassage.authoritative, false, "a flag never vouches for a marked passage");

  const forgedStored = await unified({ rows: [{ ...receiptlessContract(), scanned: true }] }, Q_SEARCH);
  assert.equal(forgedStored.body.results.length, 1, "the forged stored flag reached D1 row assembly");
  assert.ok(forgedStored.body.results[0].authority, "the forged row reached the authority decision");
  assert.equal(Object.hasOwn(forgedStored.body.results[0], "scanned"), false,
    "D1 strips a stored scanned value and emits only its own receipt-backed verdict");

  // A stored row is judged by its own receipt, whatever flag it carries.
  assert.equal(authorityFor({ ...receiptlessContract(), scanned: true }, options).authoritative, false);
  assert.equal(authorityFor({ ...markedContract(), scanned: true }, options).authoritative, false);
});

test("a scanned row that cannot count carries main's excluded authority, byte for byte", () => {
  const options = { query: Q_STATUS, claimText: A_STATUS, current: true };
  const excluded = {
    tier: "T1",
    rank: 1,
    name: "primary",
    reason: "a recorded direct source artifact (contract); its text was not obtained from a reliable native text layer",
    claim: "transaction_status",
    eligible: true,
    authoritative: false,
    current: true,
    owner_confirmed: false,
    operative: false,
  };
  assert.deepEqual(authorityFor(markedContract(), options), excluded);
  assert.deepEqual(authorityFor(unreadablePageContract(), options), excluded);
  assert.deepEqual(authorityFor(receiptlessContract(), options), excluded);
});

/** Main's refusal for a current-status question, pinned to main's own bytes. */
async function assertMergedRefusal(row, pinned, what) {
  const prompts = [];
  const { text, body } = await think({
    rows: [row], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.ok(body.confidence.basis.some(reason => /check|incomplete|read/i.test(reason)));
  assert.equal(body.evidence_gate?.reason, "non-authoritative current-status evidence requires an exact as-of date");
  assertNoScannedTrace(text);
  const answerPrompt = prompts.find((prompt) => prompt.pass === "answer")?.text || "";
  assert.ok(answerPrompt.includes(PARTIAL_PROMPT_LABEL), "the model gets main's OCR warning");
  assert.equal(answerPrompt.includes(SCANNED_PROMPT_LABEL), false);
  assert.equal(digest(text), pinned.response, `${what} /think response bytes`);
  assert.deepEqual(promptDigests(prompts), pinned.prompts, "both model prompts are byte-identical to main");
}

test("a scan whose cited chunk carries an unreadable mark keeps the merged refusal, byte for byte", async () => {
  const row = markedContract();
  // The decision point: the stored receipt passes, so only the passage decides.
  const receipt = JSON.parse(row.authority_meta).ocr;
  assert.equal(receipt.text_source, "ocr");
  assert.equal(receipt.pages_unreadable, 0);
  assert.ok(row.text.includes("[[UNREADABLE]]"));
  await assertMergedRefusal(row, PINNED.markedStatus, "marked chunk");
});

test("a document whose receipt records an unreadable page keeps the merged refusal, byte for byte", async () => {
  const row = unreadablePageContract();
  // The decision point: the passage is clean, so only the receipt decides.
  assert.equal(row.text.includes("[[UNREADABLE]]"), false);
  assert.equal(JSON.parse(row.authority_meta).ocr.pages_unreadable, 1);
  await assertMergedRefusal(row, PINNED.unreadablePageStatus, "unreadable page");
});

test("a scan stored with no OCR receipt keeps the merged refusal, byte for byte", async () => {
  const row = receiptlessContract();
  assert.equal(row.text.includes("[[UNREADABLE]]"), false);
  assert.equal(Object.hasOwn(JSON.parse(row.authority_meta), "ocr"), false);
  await assertMergedRefusal(row, PINNED.receiptlessStatus, "no receipt");
});

test("a scanned filing whose cited chunk carries an unreadable mark keeps the merged tax refusal, byte for byte", async () => {
  const row = taxReturnRow("ocr", { id: "ocr-marked", page: MARKED_TAX_PAGE });
  assert.equal(JSON.parse(row.authority_meta).ocr.pages_unreadable, 0);
  assert.ok(row.text.includes("[[UNREADABLE]]"));
  const prompts = [];
  const { text, body } = await think({ rows: [row], answer: A_TAX, prompts }, Q_TAX);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.equal(body.evidence_gate?.reason, TAX_UNREADABLE_REASON);
  assert.equal(body.gaps[0]?.reason, "ledger_wording_unsupported");
  assert.equal(body.gaps[1]?.type, "tax_evidence_unreadable");
  assert.ok(body.confidence.basis.some(reason => /read|unavailable|check/i.test(reason)));
  assertNoScannedTrace(text);
  assertTaxResponseDigest(text, PINNED.markedTax.response, "marked tax /think response bytes");
  assertTaxPromptDigests(prompts, PINNED.markedTax.prompts);
  assertTaxResponseDigest(disclosureOf(body), PINNED.markedTaxGateRefusal,
    "the evidence-gate disclosure retains the reviewed wording");

  const modelRefusal = await think({ rows: [row], answer: REFUSAL }, Q_TAX);
  // 0.4.28 a rejected model draft still yields a source-bound owner reading before the disclosure pin.
  assertDocumentAnswer(modelRefusal.body, {provisional:true, empty:!modelRefusal.body.results?.length});
  assertTaxResponseDigest(disclosureOf(modelRefusal.body), "6f6144d0b3711d988122ff65b28506f2b021831ecae9c15aba7c0832fd666917",
    "the model-refusal disclosure retains the reviewed wording");
});

test("a clean scan of the filing that the model finds nothing in still gets the found-but-unreadable disclosure", async () => {
  const { body } = await think({ rows: [taxReturnRow("ocr")], answer: REFUSAL }, Q_TAX);
  // The scan did count as readable, so this refusal is the model's verdict.
  assert.equal(body.results[0]?.scanned, true);
  assert.equal(body.evidence_gate?.reason, "answer model found no direct support");
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.ok(body.confidence.basis.some(reason => /read|unavailable|check/i.test(reason)));
  assert.equal(body.gaps[0]?.reason, "ledger_wording_unsupported");
  assert.equal(body.gaps[1]?.type, "tax_evidence_unreadable");
  assert.equal(scannedGapOf(body), undefined, "a refusal rests on nothing");
  assert.ok(body.confidence.percent < 90, "the source reading is scored without certifying absence");
  assertTaxResponseDigest(disclosureOf(body), PINNED.scannedTaxModelRefusal, "the disclosure retains the reviewed wording, field for field");
});

test("a clean scan of the filing whose draft the evidence gate refuses gets the same disclosure", async () => {
  const { body } = await think({
    rows: [taxReturnRow("ocr")],
    answer: A_TAX,
    verdict: { supported: false, complete: false, evidence: [], reason: "the cited line does not state that figure" },
  }, Q_TAX);
  assert.equal(body.results[0]?.scanned, true);
  assert.equal(body.evidence_gate?.supported, false);
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.ok(body.confidence.basis.some(reason => /read|unavailable|check/i.test(reason)));
  assert.equal(body.gaps[0]?.reason, "ledger_wording_unsupported");
  assert.equal(body.gaps[1]?.type, "tax_evidence_unreadable");
  assert.equal(scannedGapOf(body), undefined);
  assertTaxResponseDigest(disclosureOf(body), PINNED.scannedTaxGateRefusal, "the disclosure retains the reviewed wording, field for field");
});

test("with the filing inventory unverified, a clean scan that ends in no answer still gets main's unreadable-filing disclosure", async () => {
  // The injected inventory outage is real: an answer from the same scan keeps
  // the inventory gap beside it.
  const answered = await think({ rows: [taxReturnRow("ocr")], answer: A_TAX, inventoryFails: true }, Q_TAX);
  assertDocumentAnswer(answered.body, {expected: A_TAX});
  assert.equal(answered.body.gaps.some((gap) => gap.type === "tax_document_inventory_unverified"), true);

  const { body } = await think({ rows: [taxReturnRow("ocr")], answer: REFUSAL, inventoryFails: true }, Q_TAX);
  assert.equal(body.results[0]?.scanned, true);
  assert.equal(body.evidence_gate?.reason, "answer model found no direct support");
  assertDocumentAnswer(body, {provisional:true, empty:!body.results?.length});
  assert.equal(body.status, undefined);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_document_inventory_unverified"), false,
    "as on main, the unreadable-filing gap takes the inventory gap's place");
  assert.equal(body.gaps.filter((gap) => gap.type === "tax_evidence_unreadable").length, 1);
  assert.ok(body.confidence.basis.some(reason => /read|unavailable|check/i.test(reason)));
  // Main pins the same bytes as with a verified inventory: there, too, the
  // unreadable-filing gap takes the inventory gap's place.
  assertTaxResponseDigest(disclosureOf(body), PINNED.scannedTaxModelRefusal, "the disclosure retains the reviewed wording, field for field");
});

test("ranked search treats a scan with a marked chunk exactly as main", async () => {
  const { text, body } = await unified({ rows: [markedContract()] }, Q_SEARCH);
  assert.equal(body.results[0]?.text_source, "ocr");
  assertNoScannedTrace(text);
  assert.equal(Object.hasOwn(body, "gaps"), false, "a healthy search with no counted scan has no gaps field");
  assert.equal(digest(text), PINNED.markedUnified, "marked /unified response bytes");
});

function reportFor(body) {
  return renderReportHtml({
    manifest: { client: { display_name: "Example Orchard LLC" } },
    acceptance: {
      counts: { pass: 1, fail: 0, warn: 0, skip: 0 }, passed: true, stoppedAtTier: null,
      results: [{ tier: 1, name: "health responds", status: "pass", detail: "fixture" }],
    },
    seedAnswers: [{
      question: Q_GENERAL,
      answer: body.answer,
      citations: body.citations,
      gaps: body.gaps,
      resultCount: body.results.length,
    }],
    expectedToFail: [],
    corpus: { rows: [] },
    base: "https://fixture.example",
    generatedAt: new Date("2026-09-01T00:00:00Z"),
  });
}

test("an answer citing a scan that is not proof keeps main's OCR label on every surface", async () => {
  const { text, body } = await think({ rows: [markedContract()], answer: A_GENERAL }, Q_GENERAL);
  // A general claim needs no authority, so main answers this too, from the
  // scan as a citation and never as proof.
  assertDocumentAnswer(body, {expected: A_GENERAL});
  assert.equal(body.citations[0]?.text_source, "ocr");
  assertNoScannedTrace(text);
  assert.equal(digest(text), PINNED.markedGeneral, "the /think response is byte for byte main's");

  const mcp = (await mcpCall("ask", { question: Q_GENERAL }, { think: async () => body })).content[0].text;
  assert.equal(mcp.includes("(scanned)"), false);
  assert.equal(mcp.includes(ANSWER_NOTICE), false);
  assert.match(mcp, /OCR text, verify key details/);
  assert.equal(digest(beforeFinalInvitation(mcp)), PINNED.markedGeneralMcpAsk, "original remote MCP facts match the frozen bytes");

  const printed = await askCli(body);
  assert.equal(printed.includes("(scanned)"), false);
  assert.equal(printed.includes(ANSWER_NOTICE), false);
  assert.match(printed, /OCR text, verify key details/);
  assert.equal(digest(beforeFinalInvitation(printed, true)), PINNED.markedGeneralCli, "original CLI facts match the frozen bytes");

  const html = reportFor(body);
  assert.equal(html.includes("(scanned)"), false);
  assert.equal(html.includes(ANSWER_NOTICE), false);
  assert.ok(html.includes("OCR text, verify key details"));

  assert.equal(appRender.citationIsScanned(body.citations[0]), false);
  assert.equal(appRender.scannedEvidenceNotice(body), null);

  const local = await localMcpThink(body);
  assert.equal(local.note, undefined, "the local MCP server adds no scanned relay note");
  assert.equal(Object.hasOwn(local.citations[0], "scanned"), false);
});

/* ------------------- end to end: real ingest, real SQL, real retrieval */

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "migrations", "d1");

/**
 * The Worker store over node:sqlite with every shipped D1 migration applied,
 * built the way test/ocr.test.mjs builds it. D1 hands a RETURNING write its
 * rows and counts trigger writes in meta.changes; this does the same.
 */
function sqliteStore(extra = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    for (const statement of splitStatements(readFileSync(join(MIGRATIONS, file), "utf-8"))) sqlite.exec(statement);
  }
  sqlite.exec(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'scanned-evidence-fixture', '0.0.0', 17, 0, '2026-01-01T00:00:00Z', 'test')`,
  );
  const write = (sql, params) => {
    if (!/\bRETURNING\b/i.test(sql)) {
      return { results: [], meta: { changes: Number(sqlite.prepare(sql).run(...params).changes || 0) } };
    }
    const before = sqlite.prepare("SELECT total_changes() AS n").get().n;
    const results = sqlite.prepare(sql).all(...params);
    return { results, meta: { changes: sqlite.prepare("SELECT total_changes() AS n").get().n - before } };
  };
  const prepare = (sql) => {
    const shape = (params = []) => ({
      bind: (...next) => shape(next),
      all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
      first: async () => sqlite.prepare(sql).get(...params) ?? null,
      run: async () => write(sql, params),
      _sql: sql,
      _params: params,
    });
    return shape();
  };
  const env = {
    STORAGE: "d1",
    DB: {
      prepare,
      batch: async (statements) => {
        sqlite.exec("BEGIN");
        try {
          const out = statements.map((statement) => write(statement._sql, statement._params));
          sqlite.exec("COMMIT");
          return out;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    },
    ...extra,
  };
  return { sqlite, env, store: storeFor(env) };
}

/**
 * The envelope a connector sends for an OCR'd file: the real assembleOcr()
 * text and provenance, promoted and stored the way connectors/google-drive.mjs
 * does it, with the receipt under metadata.ocr.
 */
function scannedEnvelope(sourceId, pages, { title = "Harbor Storage service contract", receipt = true } = {}) {
  const verdict = assembleOcr(
    pages.map((page, index) => (typeof page === "string"
      ? { page: index + 1, text: page }
      : { page: index + 1, ...page })),
    { totalPages: pages.length, model: "fixture-ocr-model" },
  );
  assert.equal(verdict.ok, true, JSON.stringify(verdict));
  const { text_source: textSource, text_reliable: textReliable } = verdict.provenance;
  return withFirstPartySourceProvenance({
    source_type: "drive",
    source_id: sourceId,
    title,
    content: verdict.text,
    text_source: textSource,
    text_reliable: textReliable,
    metadata: {
      extracted_as: "pdf",
      extraction_note: verdict.note,
      ...(receipt ? { ocr: verdict.provenance } : {}),
    },
  }, { textSource, textReliable });
}

test("end to end: the receipt ingest writes reaches retrieval, and only a clean passage counts", async () => {
  const { sqlite, store, env } = sqliteStore();
  await store.ingest(env, scannedEnvelope("scan-clean", [CONTRACT_PAGE]));
  await store.ingest(env, scannedEnvelope("scan-marked", [MARKED_CONTRACT_PAGE]));
  await store.ingest(env, scannedEnvelope("scan-unreadable-page", [LONG_CONTRACT_PAGE, PAGE_UNREADABLE]));
  // Distinct bytes: retrieval collapses identical copies from one source.
  await store.ingest(env, scannedEnvelope("scan-no-receipt", [`${CONTRACT_PAGE}\nFiled copy.`], { receipt: false }));
  await store.ingest(env, withFirstPartySourceProvenance({
    source_type: "drive", source_id: "native-copy", title: "Harbor Storage service contract",
    content: CONTRACT_PAGE, text_source: "native", text_reliable: true, metadata: { extracted_as: "pdf" },
  }, { textSource: "native", textReliable: true }));

  // The field names this rule reads are the ones ingest actually stored.
  const stored = Object.fromEntries(sqlite.prepare("SELECT source_id, text_source, meta FROM documents").all()
    .map((row) => [row.source_id, { text_source: row.text_source, ocr: JSON.parse(row.meta).ocr }]));
  assert.deepEqual(
    Object.fromEntries(Object.entries(stored).map(([id, row]) => [id, [row.text_source, row.ocr?.pages_unreadable]])),
    {
      "scan-clean": ["ocr", 0],
      "scan-marked": ["ocr", 0],
      "scan-unreadable-page": ["ocr_partial", 1],
      "scan-no-receipt": ["ocr", undefined],
      "native-copy": ["native", undefined],
    },
  );
  assert.equal(stored["scan-marked"].ocr.per_page[0].unreadable_marks, 1);

  const found = await store.search(env, { query: "Harbor Storage monthly storage fee", limit: 10 });
  const byRef = Object.fromEntries(found.results.map((row) => [row.ref_key, row]));
  assert.deepEqual(Object.keys(byRef).sort(),
    ["native-copy", "scan-clean", "scan-marked", "scan-no-receipt", "scan-unreadable-page"]);

  const clean = byRef["scan-clean"];
  assert.equal(clean.text_source, "ocr");
  assert.equal(clean.scanned, true, "a clean scan is flagged from its stored receipt");
  assert.equal(clean.authority?.scanned, true);
  assert.equal(clean.authority?.authoritative, true);

  assert.ok(byRef["scan-marked"].snippet.includes("[[UNREADABLE]]"));
  for (const ref of ["scan-marked", "scan-unreadable-page", "scan-no-receipt"]) {
    assert.equal(Object.hasOwn(byRef[ref], "scanned"), false, `${ref} is not flagged`);
    assert.equal(Object.hasOwn(byRef[ref].authority || {}, "scanned"), false, `${ref} authority is not a scan basis`);
    assert.equal(byRef[ref].authority?.authoritative, false, `${ref} is not proof`);
  }
  assert.equal(byRef["native-copy"].authority?.authoritative, true);
  assert.equal(Object.hasOwn(byRef["native-copy"], "scanned"), false);
  for (const row of found.results) {
    assert.equal(Object.hasOwn(row, evidenceAuthority.UNREADABLE_SOURCE_CHUNK || "_unreadable_source_chunk"), false,
      "no internal field reaches the public row");
  }
});

test("end to end: an excerpt cut from a marked chunk is judged by the whole chunk", async () => {
  // Two chunks per document. Keyword search finds the fee in chunk 0; the
  // semantic index returns chunk 1, and retrieval shows a bounded excerpt of
  // each. In the marked copy the mark sits in chunk 1 beyond its excerpt.
  // Sized with the real chunker: two 900-character chunks, the fee in chunk
  // 0, and the mark 651 characters into chunk 1, past its 400-character
  // excerpt. The query words appear in chunk 1 only through its title header.
  const clauses = (tag, count) => Array.from({ length: count }, (_, index) =>
    `Clause ${tag}${index + 1} covers inspection access and insurance for each unit.`).join(" ");
  const pageOne = `The monthly storage fee is $1,240, due on the first day of each month. ${clauses("a", 6)}`;
  const pageTwo = (mark) => `${clauses("b", 13)} Signed copy retained by the operator${mark}.`;
  const vectorIds = [];
  const { sqlite, store, env } = sqliteStore({
    CHUNK_SIZE: "900",
    CHUNK_OVERLAP: "0",
    AI: { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) },
    VECTORIZE: {
      query: async () => ({ matches: vectorIds.map((id) => ({ id, score: 0.9 })) }),
      describe: async () => ({ vectorCount: 0, processedUpToMutation: null }),
    },
  });
  await store.ingest(env, scannedEnvelope("composed-clean", [pageOne, pageTwo("")]));
  await store.ingest(env, scannedEnvelope("composed-marked", [pageOne, pageTwo(" [[UNREADABLE]]")]));
  vectorIds.push("drive:composed-clean#1", "drive:composed-marked#1");

  const chunks = Object.fromEntries(sqlite.prepare("SELECT chunk_uid, text FROM chunks").all()
    .map((row) => [row.chunk_uid, row.text]));
  assert.equal(Object.keys(chunks).filter((id) => id.startsWith("drive:composed-marked#")).length, 2);
  assert.equal(chunks["drive:composed-marked#0"].includes("[[UNREADABLE]]"), false);
  assert.ok(chunks["drive:composed-marked#1"].includes("[[UNREADABLE]]"));
  assert.ok(chunks["drive:composed-marked#0"].includes("monthly storage fee"));

  const found = await store.search(env, { query: "monthly storage fee", limit: 10 });
  const byRef = Object.fromEntries(found.results.map((row) => [row.ref_key, row]));
  for (const ref of ["composed-clean", "composed-marked"]) {
    // The decision point: both documents were composed from two excerpts, and
    // the mark is not in what a reader sees.
    assert.match(byRef[ref]?.snippet || "", /Semantic excerpt from the same document/, ref);
    assert.equal(byRef[ref].snippet.includes("[[UNREADABLE]]"), ref === "composed-marked", ref);
  }
  assert.equal(byRef["composed-clean"].scanned, true, "composition alone does not cost a clean scan its flag");
  assert.equal(Object.hasOwn(byRef["composed-marked"], "scanned"), false,
    "the mark in the whole chunk counts even though the excerpt hides it");
  assert.equal(byRef["composed-marked"].authority?.authoritative, false);
});
