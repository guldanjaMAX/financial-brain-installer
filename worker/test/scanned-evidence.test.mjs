/**
 * A complete OCR read of a scanned copy can be the proof behind an answer, and
 * every answer that uses one says so without leaving that to a model.
 *
 * Before this change an OCR'd document could be found and cited but could
 * never be the evidence an answer stood on: the authority check accepted only
 * a native text layer, so a question only a scan could answer ended in "The
 * search found candidate records, but they did not support an answer."
 *
 * The rule is decided in the Worker at query time from the stored
 * `text_source`, so a document OCR'd by any earlier version qualifies without
 * re-ingest:
 *
 *   native + text_reliable   unchanged, byte for byte
 *   ocr (a complete read)    counts, is flagged `scanned: true`, and is labelled
 *   ocr_partial, unknown     still excluded, exactly as before
 *
 * "Unchanged" is measured, not asserted: the native, partial and unknown
 * responses, and both model prompts that produced them, are pinned by SHA-256
 * digests captured on main 5351d09 before the change. Every name here is
 * synthetic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import worker from "../src/index.js";
import { authorityFor, ownerConfirmedRecord } from "../src/lib/evidence-authority.js";
import { handleMcp } from "../src/lib/mcp-endpoint.js";
import * as appRender from "../../frontend/src/lib/answer-render.js";
import { OCR_BANNER, pageMarker } from "../../ingest/ocr.mjs";
import { cmdAsk } from "../../brain.mjs";
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

const digest = (text) => createHash("sha256").update(String(text), "utf8").digest("hex");

/* ------------------------------------------------------------ fixtures */

/**
 * The metadata a receipt-writing ingest stores. The D1 read path exposes a
 * row's text source only when this receipt validates against the same row, and
 * treats every other row as `unknown`, native or not.
 */
function storedMeta(row) {
  const recorded = row.text_source !== "unknown";
  return JSON.stringify({
    evidence_lineage: { version: 1, kind: "source_record", root_ids: [] },
    provenance_receipt: {
      version: 1,
      status: recorded ? "complete" : "partial",
      reason: recorded ? "lineage_and_text_recorded" : "text_provenance_unavailable",
      root_ids: [`${row.source}:${row.source_id}`],
    },
  });
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

function contractRow(state) {
  const { text_source, text_reliable } = TEXT_STATES[state];
  const row = {
    chunk_uid: `drive:storage-contract-${state}#0`,
    doc_uid: `drive:storage-contract-${state}`,
    source: "drive",
    source_kind: "drive",
    source_id: `storage-contract-${state}`,
    title: "Harbor Storage service contract",
    client: "Harbor Storage",
    category: "contract",
    document_date: Date.parse("2026-08-03T00:00:00.000Z"),
    date_source: "document_date",
    date_reliable: 1,
    text_source,
    text_reliable,
    text: storedText(text_source, [
      "The service contract between Example Orchard LLC and Harbor Storage remains active and renews each August.",
      "The monthly storage fee is $1,240.",
    ].join("\n")),
  };
  return { ...row, authority_meta: storedMeta(row) };
}

const TAX_TITLE = "Example Orchard LLC 2023 tax return Form 1065";
function taxReturnRow(state) {
  const { text_source, text_reliable } = TEXT_STATES[state];
  const page = [
    "Taxpayer: Example Orchard LLC",
    "Form 1065 U.S. Return of Partnership Income, tax year 2023",
    "Ordinary business income (loss): $48,210",
  ].join("\n");
  const chunk = `[${TAX_TITLE}]\n\n${storedText(text_source, page)}`;
  const row = {
    chunk_uid: `drive:orchard-1065-${state}#0`,
    doc_uid: `drive:orchard-1065-${state}`,
    source: "drive",
    source_kind: "drive",
    source_id: `orchard-1065-${state}`,
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
  return { ...row, authority_meta: storedMeta(row) };
}

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
function brainEnv({ rows, coverageRows = [], answer = "", evidence = [1], prompts = [] } = {}) {
  return {
    STORAGE: "d1",
    ADMIN_KEY: "k",
    DB: {
      exec: async () => {},
      prepare(sql) {
        return {
          bind() { return this; },
          all: async () => {
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
            response: { supported: true, complete: true, evidence, reason: "the cited record states it" },
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
    const text = await response.text();
    return { text, body: JSON.parse(text) };
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

  assert.equal(body.answer, A_STATUS,
    `main answered ${JSON.stringify(body.notice)} with gate reason ${JSON.stringify(body.evidence_gate?.reason)}`);
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
  assert.equal(body.answer, A_STATUS);
  assertNoScannedTrace(text);
  assert.equal(prompts.some((prompt) => /SCANNED|OCR/.test(prompt.text)), false,
    "a native-only prompt says nothing about scans");
  assert.equal(digest(text), "cd30c070e542098632e10e20c7708bce789ef7d7ac61e0b56c5fcb40a4f9baa7", "native /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "7660484083672f3a7d7c58a809b0f477667c3a60d1fa74192968fc3c7618978e",
    verifier: "39475734db1d56118f7ec429f542536c837fbdd871be0040a2f62dd51c9616a7",
  }, "both model prompts are byte-identical to main");
});

test("a partial OCR read still ends in main's refusal, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({
    rows: [contractRow("ocr_partial")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assert.equal(body.answer, null);
  assert.equal(body.status, "coverage_incomplete");
  assert.ok(String(body.notice).startsWith(COVERAGE_REFUSAL), String(body.notice));
  assert.equal(body.evidence_gate?.reason, "non-authoritative current-status evidence requires an exact as-of date");
  assertNoScannedTrace(text);
  const answerPrompt = prompts.find((prompt) => prompt.pass === "answer")?.text || "";
  assert.ok(answerPrompt.includes(PARTIAL_PROMPT_LABEL), "the partial label is unchanged");
  assert.equal(answerPrompt.includes(SCANNED_PROMPT_LABEL), false);
  assert.equal(digest(text), "51e9be2cb9baeeca8f85e80d508a6aa65ef5081a34495716f4981739dccb9602", "partial /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "ed9471553eb26ff601b43f52bf5cde313cf7a81615b93c850f3ba3d1a1ed560f",
    verifier: "64317c857977dce5cee0ef308508f734c66881fcf7d148495f634c46921f644d",
  }, "both model prompts are byte-identical to main");
});

test("an unknown text source still ends in main's refusal, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({
    rows: [contractRow("unknown")], coverageRows: HISTORY_UNPROVEN, answer: A_STATUS, prompts,
  }, Q_STATUS);
  assert.equal(body.answer, null);
  assert.ok(String(body.notice).startsWith(COVERAGE_REFUSAL), String(body.notice));
  assertNoScannedTrace(text);
  assert.equal(digest(text), "93c92fc7bdf0483e1bba95df43faadcccbf17e9baef2ed553bfcdf20af1ae1d3", "unknown /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "f4c9fbebb917b9211191e6b3318f7f499d4be6a65b7a96a8a970f0d9af8e29b5",
    verifier: "558f5cfafaa46a0c98e05684e73a96702d96966fbf35942ba2f3d4b6b8a0dcef",
  }, "both model prompts are byte-identical to main");
});

test("any answer resting on a scan carries the notice and every flag, deterministically", async () => {
  const { body } = await think({ rows: [contractRow("ocr")], answer: A_GENERAL }, Q_GENERAL);
  assert.equal(body.answer, A_GENERAL);
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
  assert.equal(refused.body.answer, null);
  assert.equal(scannedGapOf(refused.body), undefined, "a refusal carries no scanned notice");
  assert.equal(refused.body.evidence_gate?.scanned_evidence, undefined);
});

/* ------------------------------------------------------------- tax path */

test("a complete OCR read of the exact filing can answer a tax question, labelled", async () => {
  const { body } = await think({ rows: [taxReturnRow("ocr")], answer: A_TAX }, Q_TAX);
  assert.equal(body.answer, A_TAX,
    `main refused with ${JSON.stringify(body.evidence_gate?.reason)} and ${JSON.stringify(body.notice)}`);
  assert.equal(body.status, undefined);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), false,
    "a complete read is readable tax evidence");
  assert.deepEqual(scannedGapOf(body), { type: "scanned_evidence", count: 1, total: 1, detail: ANSWER_NOTICE });
  assert.equal(body.citations[0].scanned, true);
  assert.equal(body.citations[0].authority?.tax_scope?.matched, true,
    "the OCR banner does not stop the labelled taxpayer header from matching");
  assert.deepEqual(body.evidence_gate?.scanned_evidence, [1]);
});

test("a partial OCR read of the exact filing is still unreadable, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("ocr_partial")], answer: A_TAX, prompts }, Q_TAX);
  assert.equal(body.answer, null);
  assert.equal(body.status, "coverage_incomplete");
  assert.equal(body.evidence_gate?.reason, TAX_UNREADABLE_REASON);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), true);
  assert.match(body.notice || "", /could not be read reliably/);
  assertNoScannedTrace(text);
  assert.equal(digest(text), "491cb0c9c4defd770c0707660551625b2ab7d266860673413be295e12488e057", "partial tax /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "fa4106da4ed79de19b0f75d79e6f38ff118da5767c0e530b5ff67aaf902b16bd",
    verifier: "c60b5cab469ca06b8455fc55b37dceb67a9354985ea7f1c8b9615e22100f7350",
  }, "both model prompts are byte-identical to main");
});

test("an unknown text source for the exact filing is still unreadable, byte for byte", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("unknown")], answer: A_TAX, prompts }, Q_TAX);
  assert.equal(body.answer, null);
  assert.equal(body.evidence_gate?.reason, TAX_UNREADABLE_REASON);
  assert.equal(body.gaps.some((gap) => gap.type === "tax_evidence_unreadable"), true);
  assertNoScannedTrace(text);
  assert.equal(digest(text), "af564e0e5155bd91c4693506b955d25ab339bc0d62a2adccd3461ff61be9e819", "unknown tax /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "8d2d138ee0a6f50e5d2bcc0b3a19d25ce805c67b3b06627b168a9dc6fdbae4a2",
    verifier: "c2ca796bc0bba10492eb84444288c6197fbcf7d971f97c6ec04d1348ad8f985d",
  }, "both model prompts are byte-identical to main");
});

test("the native filing answers the tax question exactly as main did", async () => {
  const prompts = [];
  const { text, body } = await think({ rows: [taxReturnRow("native")], answer: A_TAX, prompts }, Q_TAX);
  assert.equal(body.answer, A_TAX);
  assertNoScannedTrace(text);
  assert.equal(digest(text), "3e89cc9b966e910a787d09dce2781d3cbfa19073707dd208d7512512e2991d3e", "native tax /think response bytes");
  assert.deepEqual(promptDigests(prompts), {
    answer: "f37516680d8251a7e3443953da0bacd6f1d3d81ff08778ebeb127bb3a989942e",
    verifier: "dd63e00575a922757d08c4a353585903a6e51dbb77acc46bc25abc0c03c77ffc",
  }, "both model prompts are byte-identical to main");
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
  assert.equal(digest(native.text), "4f664d9e97590ed52ceec3e294b2e5bc2ea52b26ce165697f1eea25bcd0b7746", "native /unified response bytes");

  const partial = await unified({ rows: [contractRow("ocr_partial")] }, Q_SEARCH);
  assertNoScannedTrace(partial.text);
  assert.equal(digest(partial.text), "a1b19256cd59239697d732727737b2d7d4bc51377c83e9d3e43a746a81d617db", "partial /unified response bytes");
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

test("the remote MCP ask text for a native answer is unchanged", async () => {
  const { body } = await nativeGeneral();
  const result = await mcpCall("ask", { question: Q_GENERAL }, { think: async () => body });
  const text = result.content[0].text;
  assert.equal(text.includes("(scanned)"), false);
  assert.equal(text.includes(ANSWER_NOTICE), false);
  assert.equal(digest(text), "47d84cb79320c885ebd987a76b471f76b51e7ee8bf9f81de27793da939cede02", "native MCP ask text");
});

test("brain ask prints the notice and marks the scanned citation", async () => {
  const { body } = await scannedGeneral();
  const printed = (await askCli(body)).replace(/\x1b\[[0-9;]*m/g, "");
  assert.ok(printed.includes(ANSWER_NOTICE), printed);
  assert.match(printed, /\[1\] Harbor Storage service contract \(scanned\) \(drive; 2026-08-03; OCR text, verify key details; reference drive:storage-contract-ocr\)/);
});

test("brain ask output for a native answer is unchanged", async () => {
  const { body } = await nativeGeneral();
  const printed = await askCli(body);
  assert.equal(printed.includes("(scanned)"), false);
  assert.equal(printed.includes(ANSWER_NOTICE), false);
  assert.equal(digest(printed), "d7476245cd3c19c3392311e1bfaf828bd166fcd5aa025d4cfcbc02abb9cf4bf0", "native brain ask output");
});

test("the local MCP server carries the flag and the gap, and tells the assistant to relay it", async () => {
  const { body } = await scannedGeneral();
  const out = await localMcpThink(body);
  assert.equal(out.answer, A_GENERAL);
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
