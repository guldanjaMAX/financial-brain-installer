/**
 * OCR for scanned PDFs.
 *
 * The four questions this file has to answer, because each one is a way the
 * feature can look finished and not be:
 *
 *   1. Does a scan that reads cleanly actually get indexed?
 *   2. Does a scan that reads BADLY get refused, in the product's own voice,
 *      rather than indexed as a plausible guess?
 *   3. Is a PDF that already has a text layer kept away from the model
 *      entirely? Needless spend on someone else's account is its own defect.
 *   4. Does the OCR mark survive all the way into a stored document and out
 *      into a citation? A flag that dies in transit is not a flag.
 *
 * Every model call here is a stub. Nothing in this file reaches the network,
 * and no real person, client or document appears in it.
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { extractPdf, MIN_CHARS_PER_PAGE } from "../ingest/formats.mjs";
import { extract } from "../ingest/extract.mjs";
import {
  assembleOcr, judgePage, ocrConfidence, estimateOcrCost, describeOcrCost,
  OCR_BANNER, BLANK_SENTINEL, UNREADABLE_SENTINEL, MAX_UNREADABLE_SHARE, OCR_PRICE,
} from "../ingest/ocr.mjs";
import { renderPdfPageImages } from "../ingest/page-image.mjs";
import { scanPdf, textPdf, blankPdf } from "./fixtures/scan-pdf.mjs";
import {
  cmdIngestRemote,
  credentialRefusalOf,
  splitStatements,
  drivePolicyFingerprint,
  ocrPolicy,
  makeOcrCallback,
  ocrRetryReportLines,
  workerBindings,
} from "../brain.mjs";
import * as googleDrive from "../connectors/google-drive.mjs";
import { storeFor } from "../worker/src/lib/store.js";
import { computeAnswerConfidence } from "../worker/src/lib/confidence.js";
import { callLLM, visionMessages, workersAiRate } from "../worker/src/lib/core.js";
import { DEFAULT_OCR_MODEL, handleOcr } from "../worker/src/lib/ocr.js";
import { OCR_PREFLIGHT_DEFAULT_MODEL } from "../operations/ocr-preflight.mjs";

let fail = 0, ran = 0;
const check = (n, c, d = "") => {
  ran++;
  console.log((c ? "PASS  " : "FAIL  ") + n + (c ? "" : "  " + String(d).slice(0, 300)));
  if (!c) fail++;
};

const HERE = dirname(fileURLToPath(import.meta.url));

function ocrRouteDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0002_llm_call_log.sql",
    "0047_ocr_page_idempotency.sql",
    "0048_ocr_page_acknowledgement.sql",
    "0049_ocr_page_retry_budget.sql",
  ]) {
    for (const statement of splitStatements(readFileSync(join(HERE, "..", "migrations", "d1", file), "utf8"))) {
      sqlite.exec(statement);
    }
  }
  const db = {
    sqlite,
    exec: async (sql) => { sqlite.exec(sql); },
    prepare: (sql) => {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        first: async () => sqlite.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
        run: async () => {
          const result = sqlite.prepare(sql).run(...params);
          return { results: [], meta: { changes: Number(result.changes || 0) } };
        },
      });
      return shape();
    },
  };
  return db;
}

async function probeDriveOcrHttpFailure({ status, label }) {
  const root = mkdtempSync(join(tmpdir(), `brain-ocr-${label}-`));
  const manifestDir = join(root, "manifest");
  mkdirSync(manifestDir, { mode: 0o700 });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const key = "k".repeat(40);
  const sourceId = `${label}-fixture`;
  const sourceUid = `drive:${sourceId}`;
  const manifest = {
    client: { slug: "fixture" },
    brain: { domain: "brain.example" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: { google_drive: { enabled: true, root_folder_ids: ["fixture-root"] } },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [],
      ocr: { enabled: true, model: DEFAULT_OCR_MODEL, max_pages_per_document: 2 },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const file = {
    id: sourceId,
    name: `${label}-fixture.pdf`,
    mimeType: "application/pdf",
    size: String(scanPdf().length),
    modifiedTime: "2026-09-24T12:00:00.000Z",
    createdTime: "2026-09-24T12:00:00.000Z",
    parents: ["fixture-root"],
  };
  const activeFolders = Array.from({ length: 19 }, (_, index) => ({
    id: `active-folder-${index + 1}`,
    name: `Active folder ${index + 1}`,
    mimeType: "application/vnd.google-apps.folder",
    modifiedTime: "2026-09-24T12:00:00.000Z",
    parents: ["fixture-root"],
  }));
  const storedFamilies = [sourceUid, ...activeFolders.map((entry) => `drive:${entry.id}`)].sort();
  const drive = {
    ...googleDrive,
    startPageToken: async () => "next-cursor",
    listRootedFiles: async function* () { yield file; yield* activeFolders; },
    toEnvelope: (...args) => googleDrive.toEnvelope(
      ...args,
      { fetchImpl: async () => new Response(scanPdf()) },
    ),
  };
  const batchStream = async function* (items, prepare, { onSkip } = {}) {
    const group = [];
    for (const item of items) {
      const prepared = await prepare(item);
      if (prepared?.skip) onSkip?.(prepared.skip);
      else if (prepared) group.push(prepared);
    }
    if (group.length) yield group;
  };
  const priorState = {
    version: 1,
    done: { [sourceUid]: "prior-accepted-revision" },
    skipped: {},
    sync_token: "prior-cursor",
  };
  const savedStates = [];
  const sourceReceipts = [];
  let sourceInventoryCalls = 0;
  let replacementIngestCalls = 0;
  let removalCalls = 0;
  let removed = false;

  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.endsWith("/api/admin/brain/ocr")) {
      return new Response(JSON.stringify({ error: `synthetic HTTP ${status}` }), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target.includes("/api/admin/brain/source-families")) {
      sourceInventoryCalls++;
      return new Response(JSON.stringify({
        source: "drive",
        families: removed ? storedFamilies.filter((uid) => uid !== sourceUid) : storedFamilies,
        next_cursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", Date: "Thu, 24 Sep 2026 19:00:00 GMT" },
      });
    }
    if (target.endsWith("/api/admin/brain/ingest") || target.endsWith("/api/admin/brain/ingest/batch")) {
      replacementIngestCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (target.endsWith("/api/admin/brain/forget")) {
      removalCalls++;
      removed = true;
      return new Response(JSON.stringify({ documents: 1, chunks: 1, vectors: 1, targets: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (target.endsWith("/api/admin/brain/documents")) {
      return new Response(JSON.stringify({
        vector_backlog: { pending: 0 },
        vector_readiness: { ready: true, actual_vectors: 19, expected_vectors: 19 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/health")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected synthetic request: ${new URL(target).pathname}`);
  };

  let stopped = null;
  try {
    await cmdIngestRemote(manifest, manifestPath, { from: "drive", source: "drive" }, {
      withSourceIngestLock: async (_lockOptions, task) => task({ assertOwned: () => true }),
      resolveBaseUrl: async () => "https://brain.example",
      resolveAdminKey: () => key,
      getAccessToken: async () => "synthetic-access",
      drive,
      ingestLib: async () => ({
        batchStream,
        splitOversized: (envelope) => [envelope],
        loadState: () => structuredClone(priorState),
        saveState: (_path, state) => savedStates.push(structuredClone(state)),
        prefetch: async function* (items) { yield* items; },
      }),
      postSourceReceipt: async (_base, _adminKey, receipt) => { sourceReceipts.push(receipt); },
    });
  } catch (error) {
    stopped = error;
  } finally {
    globalThis.fetch = priorFetch;
    rmSync(root, { recursive: true, force: true });
  }

  return {
    sourceUid,
    stopped,
    sourceInventoryCalls,
    replacementIngestCalls,
    removalCalls,
    finalState: savedStates.at(-1) || priorState,
    sourceReceipts,
  };
}

{
  const template = JSON.parse(readFileSync(join(HERE, "..", "templates", "brain.manifest.json"), "utf8"));
  const schema = JSON.parse(readFileSync(join(HERE, "..", "manifest.schema.json"), "utf8"));
  const wranglerTemplate = readFileSync(join(HERE, "..", "worker", "wrangler.toml.template"), "utf8");
  const cliDefault = workerBindings({}, { d1_database_id: "fixture-d1" })
    .find((binding) => binding.name === "OCR_MODEL")?.text;
  const schemaDefault = schema.properties.safety.properties.ocr.properties.model.default;
  const manifestDefault = template.safety.ocr.model;
  const wranglerDefault = /^OCR_MODEL = "([^"]+)"$/mu.exec(wranglerTemplate)?.[1];
  check("every public and runtime OCR default names the reviewed model",
    [cliDefault, schemaDefault, manifestDefault, wranglerDefault, OCR_PREFLIGHT_DEFAULT_MODEL]
      .every((model) => model === DEFAULT_OCR_MODEL),
    JSON.stringify({ cliDefault, schemaDefault, manifestDefault, wranglerDefault, workerDefault: DEFAULT_OCR_MODEL }));
  check("the default model's owner estimate and Worker spend rate agree",
    OCR_PRICE.input_usd_per_m === workersAiRate(DEFAULT_OCR_MODEL).in &&
      OCR_PRICE.output_usd_per_m === workersAiRate(DEFAULT_OCR_MODEL).out,
    JSON.stringify({ price: OCR_PRICE, rate: workersAiRate(DEFAULT_OCR_MODEL) }));
}

/* ================================================================ pixels */
/* The day-zero question: can a page become an image with no native module? */

{
  const clean = await renderPdfPageImages(new Uint8Array(scanPdf()));
  check("a scanned page becomes a real PNG with no native module",
    clean.pages[0]?.png_base64?.length > 0, JSON.stringify(clean.pages[0]));
  const png = Buffer.from(clean.pages[0].png_base64, "base64");
  check("and it is a structurally valid PNG",
    png.subarray(1, 4).toString() === "PNG" && png.subarray(12, 16).toString() === "IHDR",
    png.subarray(0, 16).toString("hex"));

  // unpdf's own extractImages silently drops this shape, and it is exactly the
  // fax and photocopier population the feature exists for.
  const fax = await renderPdfPageImages(new Uint8Array(scanPdf({ depth: 1 })));
  check("a ONE-BIT fax scan is rendered, not dropped",
    fax.pages[0]?.png_base64?.length > 0, JSON.stringify(fax.pages[0]));

  const none = await renderPdfPageImages(new Uint8Array(blankPdf()));
  check("a page with no image object renders as null, never as a blank image",
    none.pages[0] === null, JSON.stringify(none.pages[0]));

  const many = await renderPdfPageImages(new Uint8Array(scanPdf({ pages: 3 })), {});
  check("every page of a multi-page scan is rendered", many.pages.filter(Boolean).length === 3);

  const capped = await renderPdfPageImages(new Uint8Array(scanPdf({ pages: 3 })), { maxPages: 2 });
  check("the per-document page ceiling is respected, so one huge scan cannot run away",
    capped.pages.length === 2 && capped.totalPages === 3, JSON.stringify(capped.pages.length));
}

/* ============================================================ page verdict */

{
  check("a plain transcription is a read page", judgePage("Invoice total 1,204.55 due 30 June").status === "read");

  // The single most dangerous outcome: fluent English that no one transcribed.
  for (const narration of [
    "The image shows a bank statement with several transactions listed.",
    "This appears to be a deposit slip from a local branch.",
    "I can see a handwritten ledger page with numbers on it.",
    "Sorry, I cannot read this document clearly.",
    "Here is the transcription of the page you provided:",
  ]) {
    const verdict = judgePage(narration);
    check(`narration is refused, not indexed: "${narration.slice(0, 34)}..."`,
      verdict.status === "unreadable" && /described the page/.test(verdict.reason || ""),
      JSON.stringify(verdict));
  }

  check("a quoted narration phrase INSIDE a real transcription is not refused",
    judgePage("MEMORANDUM\nTo: all staff\nThe image shows our new logo on page two.").status === "read");

  check("the blank sentinel is a blank page, not a failure",
    judgePage(BLANK_SENTINEL).status === "blank");
  check("a page that is only unreadable markers is unreadable",
    judgePage(`${UNREADABLE_SENTINEL} ${UNREADABLE_SENTINEL}`).status === "unreadable");
  check("an empty response is unreadable, never silently accepted",
    judgePage("").status === "unreadable");

  const loop = judgePage(Array(12).fill("Balance forward").join("\n"));
  check("a model stuck repeating one line is caught",
    loop.status === "unreadable" && /repeated one line/.test(loop.reason || ""), JSON.stringify(loop));

  // The guard that must NOT fire: a real statement page is legitimately
  // repetitive, and a unique-word ratio would throw it away.
  const statement = [
    "01 Mar  Debit card purchase   42.10   1,204.55",
    "02 Mar  Debit card purchase   18.99   1,185.56",
    "03 Mar  Debit card purchase  105.00   1,080.56",
    "04 Mar  Debit card purchase   12.45   1,068.11",
    "05 Mar  Debit card purchase   77.80     990.31",
  ].join("\n");
  check("a repetitive but REAL statement page survives", judgePage(statement).status === "read",
    JSON.stringify(judgePage(statement)));
  check("and its digit density is recorded for the reader",
    judgePage(statement).metrics.digit_ratio > 0.3, JSON.stringify(judgePage(statement).metrics));
}

/* ========================================================= document verdict */

const longPage = (n) =>
  `Statement page ${n}. ` + Array(12).fill("Debit card purchase 42.10 balance 1,204.55.").join(" ");

{
  const good = assembleOcr([1, 2, 3].map((page) => ({ page, text: longPage(page) })), { totalPages: 3, model: "@cf/test" });
  check("three clean pages assemble into an indexable document", good.ok === true, JSON.stringify(good.refusal));
  check("the text announces itself as OCR", good.text.startsWith(OCR_BANNER), good.text.slice(0, 60));
  check("every page carries its own marker",
    /\[\[page 1 \| OCR\]\]/.test(good.text) && /\[\[page 3 \| OCR\]\]/.test(good.text));
  check("provenance says ocr, not ocr_partial", good.provenance.text_source === "ocr", good.provenance.text_source);
  check("and the text is explicitly NOT reliable", good.provenance.text_reliable === false);
  check("confidence is 1 when every attempted page read", good.provenance.confidence === 1, String(good.provenance.confidence));

  const partial = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: longPage(2) },
    { page: 3, text: "The image shows a page of a document." },
  ], { totalPages: 3 });
  check("one bad page in three is indexed as PARTIAL, not as whole",
    partial.ok === true && partial.provenance.text_source === "ocr_partial", JSON.stringify(partial.refusal));
  check("the failed page is NAMED in the text rather than dropped",
    /\[\[page 3: could not be read/.test(partial.text), partial.text.slice(-160));
  check("and confidence falls below 1", partial.provenance.confidence < 1, String(partial.provenance.confidence));
  check("the owner-facing note says which pages were lost",
    /1 of 3 pages could not be read/.test(partial.note), partial.note);

  /* --- the refusals --- */
  const narrated = assembleOcr([1, 2].map((page) => ({ page, text: "This appears to be a scanned document." })), { totalPages: 2 });
  check("a document the model DESCRIBED is refused whole",
    narrated.ok === false && /produced nothing readable/.test(narrated.refusal), JSON.stringify(narrated));

  const mostlyBad = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: "The image shows a page." },
    { page: 3, text: "I cannot read this." },
  ], { totalPages: 3 });
  check(`over ${MAX_UNREADABLE_SHARE * 100}% unreadable refuses the whole document`,
    mostlyBad.ok === false && /came back unreadable/.test(mostlyBad.refusal), JSON.stringify(mostlyBad.refusal));

  const thin = assembleOcr([1, 2, 3].map((page) => ({ page, text: `page ${page} total 42` })), { totalPages: 3 });
  check("OCR text must clear the SAME per-page floor a text layer clears",
    thin.ok === false && new RegExp(String(MIN_CHARS_PER_PAGE)).test(thin.refusal), JSON.stringify(thin.refusal));

  const blanks = assembleOcr([
    { page: 1, text: longPage(1) },
    { page: 2, text: BLANK_SENTINEL },
    { page: 3, text: BLANK_SENTINEL },
  ], { totalPages: 3 });
  check("genuinely blank pages are not counted as failures",
    blanks.ok === true && blanks.provenance.pages_blank === 2 && blanks.provenance.confidence === 1,
    JSON.stringify(blanks.provenance));

  check("a page that never reached the model is counted, never dropped",
    assembleOcr([{ page: 1, error: "no image on this page" }], { totalPages: 1 }).ok === false);

  check("confidence is a coverage number anyone can recompute",
    ocrConfidence({ read: 3, unreadable: 1, judged: [] }) === 0.75,
    String(ocrConfidence({ read: 3, unreadable: 1, judged: [] })));
}

/* ================================================== the extractor decision */
/* Where the refusal used to live, and what happens there now. */

const pageText = "Deposit slip. Cash 400.00. Cheques 1,204.55. Total 1,604.55. Teller 14. Branch 002. Reference 88213.";

function stubOcr({ reply = () => pageText, model = "@cf/meta/llama-4-scout-17b-16e-instruct", maxPages = 40 } = {}) {
  const calls = [];
  const fn = async (image, meta) => {
    calls.push({ page: meta.page, bytes: image?.png_base64?.length || 0 });
    return { text: reply(meta.page) };
  };
  fn.model = model;
  fn.maxPages = maxPages;
  fn.calls = calls;
  return fn;
}

{
  /* ---- 3. a PDF WITH a text layer must never reach the model ---- */
  const ocr = stubOcr();
  let renderRequested = false;
  const got = await extractPdf(textPdf(), { ocr }, {
    pdfPassImpl: async (buf, opts) => {
      if (opts?.withPageImages) renderRequested = true;
      const { extractText } = await import("unpdf");
      const r = await extractText(new Uint8Array(buf), { mergePages: true });
      return { body: r.text.trim(), totalPages: r.totalPages, perPage: r.text.trim().length, pageImages: null };
    },
  });
  check("a PDF with a text layer is extracted normally", /must never be sent to OCR/.test(got.text || ""), JSON.stringify(got).slice(0, 200));
  check("and NOT ONE page of it is sent to the model", ocr.calls.length === 0, JSON.stringify(ocr.calls));
  check("and it carries no OCR provenance", got.provenance === undefined, JSON.stringify(got.provenance));

  // Requesting a render is itself a cost, so it is asked for only when there is
  // somewhere to send the pixels — but it is asked for BEFORE the text result
  // is known, so this asserts the flag reaches the child, not that it is free.
  check("with no OCR callback the child is never asked to render at all",
    await (async () => {
      let asked = false;
      await extractPdf(textPdf(), {}, {
        pdfPassImpl: async (buf, opts) => {
          asked = Boolean(opts?.withPageImages);
          return { body: "real text layer here", totalPages: 1, perPage: 900 };
        },
      });
      return asked === false;
    })());
}

{
  /* ---- 1. a clean scan is read and marked ---- */
  const ocr = stubOcr();
  const got = await extractPdf(scanPdf({ pages: 2 }), { ocr }, { pdfPassImpl: scannedPass });
  check("a scanned PDF is now READ instead of refused outright", typeof got.text === "string" && !got.error,
    JSON.stringify(got.error));
  check("every page was sent to the model", ocr.calls.length === 2, JSON.stringify(ocr.calls));
  check("the model received real PNG bytes, not an empty prompt", ocr.calls.every((c) => c.bytes > 50),
    JSON.stringify(ocr.calls));
  check("the stored text is marked as OCR in the body itself", got.text.includes(OCR_BANNER));
  check("provenance travels out of the extractor", got.provenance?.text_source === "ocr", JSON.stringify(got.provenance));
  check("the note tells the owner it was read from a picture", /read by OCR from a scanned image/.test(got.note || ""), got.note);

  /* ---- and it survives extract(), the funnel every ingest path uses ---- */
  const viaExtract = await extract(scanPdf(), "statement.pdf", { ocr: stubOcr() });
  check("extract() forwards the provenance instead of dropping it",
    viaExtract.provenance?.text_source === "ocr" && viaExtract.provenance.text_reliable === false,
    JSON.stringify(viaExtract.provenance));

  // A cold-file retry is allowed to return different bytes. When that second
  // parse still has no text, extractPdf deliberately keeps the first parse and
  // OCRs its rendered pages. The raw-original receipt must therefore stay on
  // the first bytes rather than following a reread that did not win.
  const firstBytes = Buffer.from("first scan bytes");
  const changedReread = Buffer.from("changed reread bytes");
  const rereadOcr = stubOcr();
  let acceptedReread = null;
  let pass = 0;
  const retainedFirst = await extractPdf(firstBytes, {
    reread: async () => changedReread,
    onRereadAccepted: (bytes) => { acceptedReread = bytes; },
    ocr: rereadOcr,
  }, {
    pdfPassImpl: async (bytes) => {
      pass++;
      return {
        body: "",
        totalPages: 1,
        perPage: 0,
        pageImages: [{
          page: 1,
          png_base64: Buffer.from(bytes).equals(firstBytes)
            ? "first-page-image".repeat(8)
            : "reread-page-image".repeat(8),
        }],
      };
    },
  });
  check("a changed empty PDF reread is parsed but not selected", pass === 2 && acceptedReread === null,
    JSON.stringify({ pass, acceptedReread: Boolean(acceptedReread) }));
  check("OCR succeeds against the retained first PDF parse",
    retainedFirst.provenance?.text_source === "ocr" && rereadOcr.calls.length === 1,
    JSON.stringify(retainedFirst));
}

{
  /* ---- 2. a poor scan is refused, in the product's own voice ---- */
  const ocr = stubOcr({ reply: () => "The image shows a document with some writing on it." });
  const got = await extractPdf(scanPdf(), { ocr }, { pdfPassImpl: scannedPass });
  check("a scan the model only DESCRIBED is refused", got.text === null, JSON.stringify(got).slice(0, 200));
  check("the refusal keeps the product's original opening phrase byte for byte",
    got.error.startsWith("no text layer: this is a scanned PDF"), got.error);
  check("and it says OCR was tried, rather than pretending it was not",
    /OCR was attempted/.test(got.error), got.error);

  const empty = await extractPdf(blankPdf(), { ocr: stubOcr() }, {
    pdfPassImpl: async () => ({ body: "", totalPages: 1, perPage: 0, pageImages: [null] }),
  });
  check("a scan with no image to read refuses honestly about WHY",
    empty.text === null && /nothing to send to OCR/.test(empty.error), empty.error);
}

{
  /* ---- the spend guard binds, and a cap hit is never blamed on the document ---- */
  const capped = Object.assign(async () => {
    const e = new Error("daily LLM spend cap of $10 reached");
    e.fatal = true;
    e.llm_cap_exceeded = true;
    throw e;
  }, { model: "@cf/x", maxPages: 40 });

  let thrown = null;
  try {
    await extractPdf(scanPdf(), { ocr: capped }, { pdfPassImpl: scannedPass });
  } catch (e) { thrown = e; }
  check("a spend-cap hit ESCAPES as fatal so the source cursor stays retryable",
    thrown?.fatal === true && thrown?.llm_cap_exceeded === true, String(thrown?.message));
  check("and the document is never recorded as unreadable because of it", thrown !== null);

  // A per-page model error is different: it IS about that page.
  const flaky = Object.assign(async ({ }, meta) => (meta.page === 1 ? { error: "model 500" } : { text: longPage(meta.page) }),
    { model: "@cf/x", maxPages: 40 });
  const mixed = await extractPdf(scanPdf({ pages: 4 }), { ocr: flaky }, { pdfPassImpl: scannedPass });
  check("a single failing page is reported inline, not thrown",
    mixed.text?.includes("[[page 1: could not be read"), JSON.stringify(mixed).slice(0, 200));
}

/* ============================================ the model call, and custody */

{
  const db = () => ({ prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => ({ m: 0 }) }), run: async () => {}, first: async () => ({ m: 0 }) }) });
  const origFetch = globalThis.fetch;
  let anthropicCalls = 0;
  globalThis.fetch = async () => { anthropicCalls++; return { ok: true, status: 200, json: async () => ({ content: [], usage: {} }), text: async () => "" }; };
  try {
    await (async () => {
      let rejected = null;
      try {
        await callLLM({ DB: db(), AI: { run: async () => ({ response: "x" }) }, ANTHROPIC_API_KEY: "k" },
          { model: "claude-sonnet-4-5", system: "s", messages: [], image: "AAAA", label: "ocr" });
      } catch (e) { rejected = e; }
      check("a page image can NEVER be sent to a non-Cloudflare model",
        rejected?.provider_mismatch === true, String(rejected?.message));
      check("and the refusal happens before any request leaves", anthropicCalls === 0, String(anthropicCalls));
    })();

    let rejected = null;
    try {
      await callLLM({ DB: db(), ANTHROPIC_API_KEY: "k" },
        { model: "@cf/google/gemma-4-26b-a4b-it", system: "s", messages: [], image: "AAAA", label: "ocr" });
    } catch (e) { rejected = e; }
    check("with no AI binding OCR refuses rather than finding another provider",
      rejected?.provider_mismatch === true, String(rejected?.message));
    check("still nothing reached Anthropic", anthropicCalls === 0, String(anthropicCalls));

    let sent = null;
    await callLLM({ DB: db(), AI: { run: async (m, body) => { sent = { m, body }; return { response: "TOTAL 42", usage: {} }; } } },
      { model: "@cf/google/gemma-4-26b-a4b-it", system: "transcribe", messages: [{ role: "user", content: "go" }], image: "AAAA", label: "ocr" });
    check("the image reaches Workers AI attached to the message",
      JSON.stringify(sent.body.messages).includes("data:image/png;base64,AAAA"), JSON.stringify(sent.body).slice(0, 200));
    check("temperature is zero, because a transcription must not be creative", sent.body.temperature === 0);
  } finally { globalThis.fetch = origFetch; }

  check("the alternate image shape is a named switch, not a rewrite",
    JSON.stringify(visionMessages("s", [], "AAAA", { OCR_IMAGE_FORMAT: "image_field" })).includes('"image":"data:image/png'),
    JSON.stringify(visionMessages("s", [], "AAAA", { OCR_IMAGE_FORMAT: "image_field" })));

  check("OCR is priced at the OCR model's rate, not the answer model's",
    workersAiRate("@cf/google/gemma-4-26b-a4b-it").in === 0.1 &&
    workersAiRate("@cf/meta/llama-4-scout-17b-16e-instruct").out === 2.25 &&
    workersAiRate("@cf/meta/llama-3.3-70b-instruct-fp8-fast").out === 2.25,
    JSON.stringify(workersAiRate("@cf/google/gemma-4-26b-a4b-it")));
  check("an unknown model is priced at the DEARER rate, so the cap cannot fail quiet",
    workersAiRate("@cf/some/new-model").out === 2.25);
}

/* ------------------------------------------------------- the worker route */

{
  const key = "k".repeat(40);
  const req = (body) => new Request("https://brain.example/api/admin/brain/ocr", {
    method: "POST", headers: { "X-Admin-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const sqlite = new DatabaseSync(":memory:");
  for (const file of [
    "0002_llm_call_log.sql",
    "0047_ocr_page_idempotency.sql",
    "0048_ocr_page_acknowledgement.sql",
    "0049_ocr_page_retry_budget.sql",
  ]) {
    for (const statement of splitStatements(readFileSync(join(HERE, "..", "migrations", "d1", file), "utf8"))) {
      sqlite.exec(statement);
    }
  }
  const db = {
    exec: async (sql) => { sqlite.exec(sql); },
    prepare: (sql) => {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        first: async () => sqlite.prepare(sql).get(...params) ?? null,
        all: async () => ({ results: sqlite.prepare(sql).all(...params) }),
        run: async () => {
          const result = sqlite.prepare(sql).run(...params);
          return { results: [], meta: { changes: Number(result.changes || 0) } };
        },
      });
      return shape();
    },
  };

  const unauth = await handleOcr({ ADMIN_KEY: key, OCR_ENABLED: "1", DB: db }, new Request("https://b/x", { method: "POST" }));
  check("the OCR route is admin-gated", unauth.status === 401, String(unauth.status));

  const off = await handleOcr({ ADMIN_KEY: key, DB: db }, req({ image_base64: "AA", prompt: "p" }));
  check("OCR is OFF by default, so an upgrade never starts spending on its own",
    off.status === 409 && (await off.clone().json()).ocr_enabled === false, String(off.status));

  const ok = await handleOcr(
    { ADMIN_KEY: key, OCR_ENABLED: "1", DB: db, AI: { run: async () => ({ response: "TOTAL 1,204.55", usage: {} }) } },
    req({ image_base64: "AA", page: 1, prompt: "transcribe" }),
  );
  const okBody = await ok.json();
  check("an enabled brain transcribes and says which model did it",
    ok.status === 200 && okBody.text === "TOTAL 1,204.55" &&
      okBody.model === "@cf/meta/llama-4-scout-17b-16e-instruct",
    JSON.stringify(okBody));
  check("and it reports the image shape it used, so a wrong guess is one call to find",
    okBody.image_format === "content_array", JSON.stringify(okBody));

  const capped = await handleOcr(
    {
      ADMIN_KEY: key, OCR_ENABLED: "1", DAILY_LLM_CAP_USD: "0",
      DB: db,
      AI: { run: async () => ({ response: "x" }) },
    },
    req({ image_base64: "AA", prompt: "p" }),
  );
  check("the daily spend cap binds on the OCR route too",
    capped.status === 429 && (await capped.clone().json()).llm_cap_exceeded === true, String(capped.status));

  const huge = await handleOcr({ ADMIN_KEY: key, OCR_ENABLED: "1", DB: db }, req({ image_base64: "A".repeat(4_000_001), prompt: "p" }));
  check("an oversized page image is refused with the size stated", huge.status === 413, String(huge.status));

  let idempotentModelCalls = 0;
  const idempotentEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: { run: async () => { idempotentModelCalls++; return { response: "TOTAL 42", usage: {} }; } },
  };
  const idempotentBody = {
    image_base64: "AA", page: 1, prompt: "transcribe", request_id: "a".repeat(64),
    replay_key: "D".repeat(43),
  };
  const first = await handleOcr(idempotentEnv, req(idempotentBody));
  const second = await handleOcr(idempotentEnv, req(idempotentBody));
  const replayed = await second.json();
  check("the Worker charges once and replays an identical retry from encrypted handoff",
    first.status === 200 && second.status === 200 && idempotentModelCalls === 1 &&
      replayed.idempotent_replay === true && replayed.text === "TOTAL 42",
    JSON.stringify({ first: first.status, second: second.status, idempotentModelCalls, replayed }));
}

/* ------------------------------------------------- the CLI callback contract */

{
  const seen = [];
  const call = makeOcrCallback({
    base: "https://brain.example", adminKey: "k", model: "@cf/m", maxPages: 7,
    httpImpl: async (url, opts) => {
      seen.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ text: "TOTAL 42" }) };
    },
  });
  const out = await call({ png_base64: "AAAA" }, {
    page: 2, totalPages: 5, source: "drive", sourceItemId: "callback-contract-fixture",
  });
  check("the CLI sends pages to the brain's OWN worker, never to a vendor API",
    seen[0].url === "https://brain.example/api/admin/brain/ocr", seen[0].url);
  check("the page image and the defensive prompt both travel with it",
    seen[0].body.image_base64 === "AAAA" && /do not describe them/i.test(seen[0].body.prompt),
    JSON.stringify(seen[0].body).slice(0, 160));
  check("and the transcription comes back", out.text === "TOTAL 42");
  check("the page ceiling rides on the callback", call.maxPages === 7);

  const reread = makeOcrCallback({
    base: "https://brain.example", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ text: "Recovered page", ocr_reread_after_expiry: true }),
    }),
  });
  await reread({ png_base64: "BBBB" }, {
    page: 1, totalPages: 1, source: "drive", sourceItemId: "reread-counter-fixture",
  });
  check("a replacement read reaches the load-report counter",
    reread.stats.rereadAfterExpiry === 1, JSON.stringify(reread.stats));

  let heldClock = 0;
  const dailyHeld = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1, attempts: 1,
    now: () => heldClock,
    sleep: async (delayMs) => { heldClock += delayMs; },
    httpImpl: async (url) => url.endsWith("/health")
      ? { ok: true, status: 200 }
      : {
          ok: false,
          status: 425,
          json: async () => ({
            ocr_request_pending: true,
            ocr_model_call_cap_exhausted: true,
            model_calls_in_24_hours: 3,
            retry_after_ms: 24 * 60 * 60 * 1000,
          }),
        },
  });
  const heldResult = await dailyHeld({ png_base64: "CCCC" }, {
    page: 1, totalPages: 1, source: "drive", sourceItemId: "daily-cap-report-fixture",
  });
  const heldReport = ocrRetryReportLines(dailyHeld).map((line) => line.message).join("\n");
  check("a daily-capped page reaches the load report as one plain count",
    heldResult.reason_code === "ocr_page_timeout" && dailyHeld.stats.dailyCapHeldPages === 1 &&
      /1 OCR page reached 3 model calls in 24 hours.*held until the next daily retry window/i.test(heldReport),
    JSON.stringify({ heldResult, stats: dailyHeld.stats, heldReport }));

  const cap = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 429, json: async () => ({ llm_cap_exceeded: true, detail: "cap" }) }),
  });
  let capErr = null;
  try {
    await cap({ png_base64: "A" }, {
      page: 1, source: "drive", sourceItemId: "cap-fixture",
    });
  } catch (e) { capErr = e; }
  check("a cap response becomes a FATAL error, so no document is blamed for it",
    capErr?.fatal === true && capErr?.llm_cap_exceeded === true, String(capErr?.message));

  const mismatch = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 409, json: async () => ({ provider_mismatch: true, detail: "no AI binding" }) }),
  });
  let misErr = null;
  try {
    await mismatch({ png_base64: "A" }, {
      page: 1, source: "drive", sourceItemId: "custody-fixture",
    });
  } catch (e) { misErr = e; }
  check("a custody refusal is fatal too", misErr?.fatal === true, String(misErr?.message));

  const flaky = makeOcrCallback({
    base: "b", adminKey: "k", model: "@cf/m", maxPages: 1,
    httpImpl: async () => ({ ok: false, status: 502, json: async () => ({ detail: "upstream blew up" }) }),
  });
  let systemErr = null;
  try {
    await flaky({ png_base64: "A" }, {
      page: 3, source: "drive", sourceItemId: "system-failure-fixture",
    });
  } catch (error) { systemErr = error; }
  check("a model 5xx is typed system evidence, never a document refusal",
    systemErr?.fatal === true && systemErr?.retryable === true &&
      systemErr?.code === "OCR_SYSTEM_UNAVAILABLE",
    JSON.stringify({ code: systemErr?.code, message: systemErr?.message }));
}

/* ------------------- live in-flight polling and document-scoped identities */

{
  const key = "k".repeat(40);
  const db = ocrRouteDb();
  const completedText = longPage(1);
  const startedAt = Date.parse("2026-09-24T12:00:00.000Z");
  let elapsedMs = 0;
  let modelCalls = 0;
  let routeCalls = 0;
  let pendingResponses = 0;
  let releaseModel;
  let signalStarted;
  let firstRoute = null;
  let modelReleased = false;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const held = new Promise((resolve) => { releaseModel = resolve; });
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: {
      run: async () => {
        modelCalls++;
        signalStarted();
        await held;
        return { response: completedText, usage: { prompt_tokens: 301, completion_tokens: 60 } };
      },
    },
  };
  const retryEvents = [];
  const callback = makeOcrCallback({
    base: "https://brain.example",
    adminKey: key,
    model: DEFAULT_OCR_MODEL,
    maxPages: 1,
    now: () => elapsedMs,
    random: () => 0.5,
    onRetry: (_message, detail) => retryEvents.push(detail),
    sleep: async (delayMs) => {
      elapsedMs += delayMs;
      if (!modelReleased && elapsedMs >= 75_000) {
        modelReleased = true;
        releaseModel();
        await firstRoute;
      }
    },
    httpImpl: async (url, options) => {
      if (url.endsWith("/health")) {
        return new Response("{}", { status: 200 });
      }
      routeCalls++;
      const route = handleOcr(workerEnv, new Request(url, options), {
        now: () => new Date(startedAt + elapsedMs),
      });
      if (routeCalls === 1) {
        firstRoute = route;
        await started;
        elapsedMs = 60_001;
        throw Object.assign(new Error("the OCR request timed out after 60s"), {
          name: "TimeoutError", retryable: true,
        });
      }
      const response = await route;
      if (response.status === 425) pendingResponses++;
      return response;
    },
  });

  let result = null, error = null;
  try {
    result = await callback({ png_base64: "same-rendered-page" }, {
      page: 1, totalPages: 1, source: "drive", sourceItemId: "late-model-fixture",
    });
  } catch (caught) { error = caught; }
  check("a model call that outlives 60 seconds is polled to completion through the real route",
    !error && result?.text === completedText && elapsedMs >= 75_000 &&
      pendingResponses >= 2 && routeCalls >= 4,
    JSON.stringify({ error: error?.message, elapsedMs, pendingResponses, routeCalls }));
  check("425 polling consumes no extra billable attempt",
    modelCalls === 1 && retryEvents.length === 1,
    JSON.stringify({ modelCalls, retryEvents }));
}

{
  const key = "k".repeat(40);
  const db = ocrRouteDb();
  let modelCalls = 0;
  const requestIds = [];
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: `${longPage(1)} call ${modelCalls}`, usage: {} };
      },
    },
  };
  const callback = makeOcrCallback({
    base: "https://brain.example", adminKey: key, model: DEFAULT_OCR_MODEL, maxPages: 1,
    httpImpl: async (url, options) => {
      requestIds.push(JSON.parse(options.body).request_id);
      return handleOcr(workerEnv, new Request(url, options));
    },
  });
  let first = null, second = null, nextPage = null, nextSource = null, error = null;
  try {
    first = await callback({ png_base64: "identical-rendered-page" }, {
      page: 1, source: "drive", sourceItemId: "document-a",
    });
    second = await callback({ png_base64: "identical-rendered-page" }, {
      page: 1, source: "drive", sourceItemId: "document-b",
    });
    nextPage = await callback({ png_base64: "identical-rendered-page" }, {
      page: 2, source: "drive", sourceItemId: "document-a",
    });
    nextSource = await callback({ png_base64: "identical-rendered-page" }, {
      page: 1, source: "upload", sourceItemId: "document-a",
    });
  } catch (caught) { error = caught; }
  const durableRows = db.sqlite.prepare("SELECT count(*) count FROM ocr_page_requests").get().count;
  check("two documents with identical rendered bytes retain separate durable OCR identities",
    !error && first?.text && second?.text && modelCalls === 4 && durableRows === 4 &&
      requestIds.length === 4 && new Set(requestIds).size === 4,
    JSON.stringify({ error: error?.message, modelCalls, durableRows, requestIds }));
  check("source and page index are independent parts of the opaque request identity",
    nextPage?.text && nextSource?.text && new Set(requestIds).size === 4,
    JSON.stringify({ error: error?.message, requestIds }));
}

/* ------------------------- content-free receipt through the document gate */

{
  const key = "k".repeat(40);
  const db = ocrRouteDb();
  const syntheticCredential = `sk-proj-${"A7".repeat(16)}`;
  let modelCalls = 0;
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: {
      run: async () => {
        modelCalls++;
        return {
          response: `${longPage(1)} Synthetic credential ${syntheticCredential}.`,
          usage: { prompt_tokens: 301, completion_tokens: 72 },
        };
      },
    },
  };
  const callback = makeOcrCallback({
    base: "https://brain.example",
    adminKey: key,
    model: DEFAULT_OCR_MODEL,
    maxPages: 2,
    httpImpl: async (url, opts) => {
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      return handleOcr(workerEnv, new Request(url, opts));
    },
  });
  const file = {
    id: "scan-credential-fixture",
    name: "scan-fixture.pdf",
    mimeType: "application/pdf",
    size: String(scanPdf().length),
    modifiedTime: "2026-09-24T12:00:00.000Z",
    createdTime: "2026-09-24T12:00:00.000Z",
    parents: [],
  };
  const converted = await googleDrive.toEnvelope(
    async () => "synthetic-access",
    file,
    { sourceName: "drive", ocr: callback },
    { fetchImpl: async () => new Response(scanPdf()) },
  );
  const refusal = credentialRefusalOf(converted.envelope, true);
  const receiptRow = db.sqlite.prepare(
    "SELECT status,response_json,replay_key_sha256,replay_iv,replay_ciphertext FROM ocr_page_requests",
  ).get();
  check("credential-shaped OCR reaches the complete-document credential refusal",
    modelCalls === 1 && refusal?.labels?.includes("openai_api_key"),
    JSON.stringify({ modelCalls, refusal }));
  const durableHandoff = JSON.stringify(receiptRow);
  check("no OCR plaintext survives in the durable receipt or encrypted handoff after refusal",
    receiptRow?.status === "completed" &&
      !durableHandoff.includes(syntheticCredential) &&
      !durableHandoff.includes("Synthetic credential") &&
      /^[0-9a-f]{64}$/u.test(receiptRow.replay_key_sha256 || "") &&
      typeof receiptRow.replay_iv === "string" && typeof receiptRow.replay_ciphertext === "string" &&
      /^[0-9a-f]{64}$/u.test(JSON.parse(receiptRow.response_json).response_sha256 || ""),
    durableHandoff);
}

/* ------------------------- completion readback failure through Drive sync */

{
  const root = mkdtempSync(join(tmpdir(), "brain-ocr-idempotency-"));
  const manifestDir = join(root, "manifest");
  mkdirSync(manifestDir, { mode: 0o700 });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const key = "k".repeat(40);
  const manifest = {
    client: { slug: "fixture" },
    brain: { domain: "brain.example" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: {
      google_drive: { enabled: true, root_folder_ids: ["fixture-root"] },
    },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [],
      ocr: { enabled: true, model: DEFAULT_OCR_MODEL, max_pages_per_document: 2 },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const durableDb = ocrRouteDb();
  let completionReadbacks = 0;
  const completionReadbackLostDb = {
    exec: durableDb.exec,
    prepare: (sql) => {
      const wrap = (statement) => ({
        bind: (...values) => wrap(statement.bind(...values)),
        first: () => statement.first(),
        run: () => statement.run(),
        all: async () => {
          const result = await statement.all();
          if (/UPDATE ocr_page_requests[\s\S]+status='completed'/u.test(sql)) {
            completionReadbacks++;
            return { results: [] };
          }
          return result;
        },
      });
      return wrap(durableDb.prepare(sql));
    },
  };

  let modelCalls = 0;
  let replacementIngestCalls = 0;
  let removalCalls = 0;
  let fileFetches = 0;
  const sourceReceipts = [];
  const savedStates = [];
  const priorState = {
    version: 1,
    done: { "drive:scan-fixture": "prior-accepted-revision" },
    skipped: {},
    sync_token: "prior-cursor",
  };
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: completionReadbackLostDb,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: longPage(1), usage: { prompt_tokens: 301, completion_tokens: 60 } };
      },
    },
  };
  const file = {
    id: "scan-fixture",
    name: "scan-fixture.pdf",
    mimeType: "application/pdf",
    size: String(scanPdf().length),
    modifiedTime: "2026-09-24T12:00:00.000Z",
    createdTime: "2026-09-24T12:00:00.000Z",
    parents: ["fixture-root"],
  };
  const drive = {
    ...googleDrive,
    startPageToken: async () => "next-cursor",
    listRootedFiles: async function* () { yield file; },
    toEnvelope: (...args) => {
      fileFetches++;
      return googleDrive.toEnvelope(...args, { fetchImpl: async () => new Response(scanPdf()) });
    },
  };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    if (target.endsWith("/api/admin/brain/ocr")) {
      return handleOcr(workerEnv, new Request(target, opts));
    }
    if (target.endsWith("/api/admin/brain/source-families")) {
      return new Response(JSON.stringify({
        source: "drive",
        families: ["drive:scan-fixture"],
        next_cursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", Date: "Thu, 24 Sep 2026 19:00:00 GMT" },
      });
    }
    if (target.endsWith("/api/admin/brain/ingest")) {
      replacementIngestCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (target.endsWith("/api/admin/brain/forget-families")) {
      removalCalls++;
      return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
    }
    if (target.endsWith("/health")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected synthetic request: ${new URL(target).pathname}`);
  };

  const batchStream = async function* (items, prepare, { onSkip } = {}) {
    const group = [];
    for (const item of items) {
      const prepared = await prepare(item);
      if (prepared?.skip) onSkip?.(prepared.skip);
      else if (prepared) group.push(prepared);
    }
    if (group.length) yield group;
  };
  let stopped = null;
  try {
    await cmdIngestRemote(manifest, manifestPath, { from: "drive", source: "drive" }, {
      withSourceIngestLock: async (_lockOptions, task) => task({ assertOwned: () => true }),
      resolveBaseUrl: async () => "https://brain.example",
      resolveAdminKey: () => key,
      getAccessToken: async () => "synthetic-access",
      drive,
      ingestLib: async () => ({
        batchStream,
        splitOversized: (envelope) => [envelope],
        loadState: () => structuredClone(priorState),
        saveState: (_path, state) => savedStates.push(structuredClone(state)),
        prefetch: async function* (items) { yield* items; },
      }),
      postSourceReceipt: async (_base, _adminKey, receipt) => { sourceReceipts.push(receipt); },
    });
  } catch (error) {
    stopped = error;
  } finally {
    globalThis.fetch = priorFetch;
    rmSync(root, { recursive: true, force: true });
  }

  const finalState = savedStates.at(-1) || priorState;
  const durableReceipt = durableDb.sqlite.prepare(
    "SELECT status,response_json FROM ocr_page_requests",
  ).get();
  check("completion-readback loss reaches the billable Worker boundary exactly once",
    fileFetches === 1 && modelCalls === 1 && completionReadbacks === 1 &&
      stopped?.ocr_idempotency_unavailable === true && stopped?.fatal === true && stopped?.retryable === true,
    JSON.stringify({ fileFetches, modelCalls, completionReadbacks, stopped: stopped?.message }));
  check("the system failure stores no replacement and never enters a removal plan",
    replacementIngestCalls === 0 && removalCalls === 0 &&
      finalState.done["drive:scan-fixture"] === "prior-accepted-revision",
    JSON.stringify({ replacementIngestCalls, removalCalls, finalState }));
  check("the system failure withholds cursor and terminal-ready receipt",
    finalState.sync_token === "prior-cursor" &&
      sourceReceipts.some((receipt) => receipt.status === "error" && receipt.walk_complete === false) &&
      !sourceReceipts.some((receipt) => receipt.status === "ready"),
    JSON.stringify(sourceReceipts));
  check("the ambiguous completion receipt contains no OCR plaintext",
    durableReceipt?.status === "completed" &&
      !durableReceipt.response_json.includes(longPage(1).slice(0, 24)),
    durableReceipt?.response_json);
}

/* ------------------------- model 502 through the Drive removal boundary */

{
  const root = mkdtempSync(join(tmpdir(), "brain-ocr-system-failure-"));
  const manifestDir = join(root, "manifest");
  mkdirSync(manifestDir, { mode: 0o700 });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const key = "k".repeat(40);
  const manifest = {
    client: { slug: "fixture" },
    brain: { domain: "brain.example" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: { google_drive: { enabled: true, root_folder_ids: ["fixture-root"] } },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [],
      ocr: { enabled: true, model: DEFAULT_OCR_MODEL, max_pages_per_document: 2 },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const durableDb = ocrRouteDb();
  let modelCalls = 0;
  let fileFetches = 0;
  let sourceInventoryCalls = 0;
  let replacementIngestCalls = 0;
  let removalCalls = 0;
  const sourceReceipts = [];
  const savedStates = [];
  const priorState = {
    version: 1,
    done: { "drive:system-failure-fixture": "prior-accepted-revision" },
    skipped: {},
    sync_token: "prior-cursor",
  };
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: durableDb,
    AI: {
      run: async () => {
        modelCalls++;
        throw new Error("synthetic provider outage");
      },
    },
  };
  const file = {
    id: "system-failure-fixture",
    name: "system-failure-fixture.pdf",
    mimeType: "application/pdf",
    size: String(scanPdf().length),
    modifiedTime: "2026-09-24T12:00:00.000Z",
    createdTime: "2026-09-24T12:00:00.000Z",
    parents: ["fixture-root"],
  };
  const drive = {
    ...googleDrive,
    startPageToken: async () => "next-cursor",
    listRootedFiles: async function* () { yield file; },
    toEnvelope: (...args) => {
      fileFetches++;
      return googleDrive.toEnvelope(...args, { fetchImpl: async () => new Response(scanPdf()) });
    },
  };
  const batchStream = async function* (items, prepare, { onSkip } = {}) {
    const group = [];
    for (const item of items) {
      const prepared = await prepare(item);
      if (prepared?.skip) onSkip?.(prepared.skip);
      else if (prepared) group.push(prepared);
    }
    if (group.length) yield group;
  };

  const priorFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith("/api/admin/brain/ocr")) {
      return handleOcr(workerEnv, new Request(target, options));
    }
    if (target.endsWith("/api/admin/brain/source-families")) {
      sourceInventoryCalls++;
      return new Response(JSON.stringify({
        source: "drive", families: ["drive:system-failure-fixture"], next_cursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", Date: "Thu, 24 Sep 2026 19:00:00 GMT" },
      });
    }
    if (target.endsWith("/api/admin/brain/ingest") || target.endsWith("/api/admin/brain/ingest/batch")) {
      replacementIngestCalls++;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (target.endsWith("/api/admin/brain/forget") || target.endsWith("/api/admin/brain/forget-families")) {
      removalCalls++;
      return new Response(JSON.stringify({ documents: 1, chunks: 1, vectors: 1, targets: [] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (target.endsWith("/health")) return new Response("{}", { status: 200 });
    throw new Error(`unexpected synthetic request: ${new URL(target).pathname}`);
  };

  let stopped = null;
  try {
    await cmdIngestRemote(manifest, manifestPath, { from: "drive", source: "drive" }, {
      withSourceIngestLock: async (_lockOptions, task) => task({ assertOwned: () => true }),
      resolveBaseUrl: async () => "https://brain.example",
      resolveAdminKey: () => key,
      getAccessToken: async () => "synthetic-access",
      drive,
      ingestLib: async () => ({
        batchStream,
        splitOversized: (envelope) => [envelope],
        loadState: () => structuredClone(priorState),
        saveState: (_path, state) => savedStates.push(structuredClone(state)),
        prefetch: async function* (items) { yield* items; },
      }),
      postSourceReceipt: async (_base, _adminKey, receipt) => { sourceReceipts.push(receipt); },
    });
  } catch (error) {
    stopped = error;
  } finally {
    globalThis.fetch = priorFetch;
    rmSync(root, { recursive: true, force: true });
  }

  const finalState = savedStates.at(-1) || priorState;
  check("a provider 502 reaches the source decision point as typed system evidence",
    fileFetches === 1 && modelCalls === 1 && sourceInventoryCalls >= 1 &&
      stopped?.code === "OCR_SYSTEM_UNAVAILABLE" && stopped?.fatal === true && stopped?.retryable === true,
    JSON.stringify({ fileFetches, modelCalls, sourceInventoryCalls, code: stopped?.code,
      message: stopped?.message }));
  check("a provider 502 preserves the accepted revision and creates no removal-plan action",
    replacementIngestCalls === 0 && removalCalls === 0 &&
      finalState.done["drive:system-failure-fixture"] === "prior-accepted-revision",
    JSON.stringify({ replacementIngestCalls, removalCalls, finalState }));
  check("a provider 502 retains the cursor and records only an error receipt",
    finalState.sync_token === "prior-cursor" &&
      sourceReceipts.some((receipt) => receipt.status === "error" && receipt.walk_complete === false) &&
      !sourceReceipts.some((receipt) => receipt.status === "ready"),
    JSON.stringify(sourceReceipts));
}

/* ---------------- authentication and unknown OCR status at the Drive boundary */

for (const failure of [
  { status: 401, label: "authentication" },
  { status: 418, label: "unknown-status" },
]) {
  const observed = await probeDriveOcrHttpFailure(failure);
  check(`OCR HTTP ${failure.status} reaches the source decision point as system evidence`,
    observed.sourceInventoryCalls >= 1 &&
      observed.stopped?.code === "OCR_SYSTEM_UNAVAILABLE" &&
      observed.stopped?.fatal === true && observed.stopped?.retryable === true,
    JSON.stringify({
      sourceInventoryCalls: observed.sourceInventoryCalls,
      code: observed.stopped?.code,
      message: observed.stopped?.message,
    }));
  check(`OCR HTTP ${failure.status} keeps the accepted revision and enters no removal call`,
    observed.replacementIngestCalls === 0 && observed.removalCalls === 0 &&
      observed.finalState.done[observed.sourceUid] === "prior-accepted-revision",
    JSON.stringify({
      replacementIngestCalls: observed.replacementIngestCalls,
      removalCalls: observed.removalCalls,
      finalState: observed.finalState,
    }));
  check(`OCR HTTP ${failure.status} withholds the cursor and terminal-ready receipt`,
    observed.finalState.sync_token === "prior-cursor" &&
      observed.sourceReceipts.some((receipt) => receipt.status === "error" && receipt.walk_complete === false) &&
      !observed.sourceReceipts.some((receipt) => receipt.status === "ready"),
    JSON.stringify(observed.sourceReceipts));
}

/* ----------------------------------------- slow-page retry and continuation */

const ocrTimeout = () => Object.assign(
  new Error("the OCR request timed out after 60s (brain.example)"),
  { name: "TimeoutError", retryable: true },
);

{
  const key = "k".repeat(40);
  const db = ocrRouteDb();
  const completedText = longPage(1);
  const startedAt = Date.parse("2026-09-24T12:00:00.000Z");
  let elapsedMs = 0;
  let modelCalls = 0;
  let routeCalls = 0;
  let healthProbes = 0;
  let releaseModel;
  let signalStarted;
  let firstRoute = null;
  let replayBody = null;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const held = new Promise((resolve) => { releaseModel = resolve; });
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: {
      run: async () => {
        modelCalls++;
        signalStarted();
        await held;
        return { response: completedText, usage: { prompt_tokens: 301, completion_tokens: 60 } };
      },
    },
  };
  const httpImpl = async (url, options, requestOptions = {}) => {
    if (url.endsWith("/health")) {
      healthProbes++;
      return new Response("{}", { status: 200 });
    }
    routeCalls++;
    const route = handleOcr(workerEnv, new Request(url, options), {
      now: () => new Date(startedAt + elapsedMs),
    });
    if (routeCalls === 1) {
      firstRoute = route;
      await started;
      elapsedMs += Number(requestOptions.timeoutMs || 0) + 1;
      throw ocrTimeout();
    }
    const response = await route;
    const body = await response.clone().json();
    if (response.status === 425) elapsedMs += Number(requestOptions.timeoutMs || 0);
    if (body.idempotent_replay === true) replayBody = body;
    return response;
  };
  const callbackOptions = {
    base: "https://brain.example",
    adminKey: key,
    model: DEFAULT_OCR_MODEL,
    maxPages: 1,
    now: () => elapsedMs,
    random: () => 0.5,
    sleep: async (delayMs) => { elapsedMs += delayMs; },
    httpImpl,
  };
  const identity = {
    page: 1,
    totalPages: 1,
    source: "drive",
    sourceItemId: "final-deadline-fixture",
  };
  const firstCallback = makeOcrCallback(callbackOptions);
  const firstResult = await firstCallback({ png_base64: "same-rendered-page" }, identity);
  const inFlightReceipt = db.sqlite.prepare(
    "SELECT status,replay_key_sha256 FROM ocr_page_requests",
  ).get();
  releaseModel();
  await firstRoute;
  const completedReceipt = db.sqlite.prepare(
    "SELECT status,replay_key_sha256,replay_ciphertext FROM ocr_page_requests",
  ).get();

  const nextCallback = makeOcrCallback(callbackOptions);
  let nextResult = null, nextError = null;
  try {
    nextResult = await nextCallback({ png_base64: "same-rendered-page" }, identity);
  } catch (error) {
    nextError = error;
  }
  check("a final-deadline timeout establishes and then completes one durable Worker receipt",
    firstResult?.reason_code === "ocr_page_timeout" && healthProbes === 1 && modelCalls === 1 &&
      inFlightReceipt?.status === "in_flight" && completedReceipt?.status === "completed" &&
      typeof completedReceipt?.replay_ciphertext === "string",
    JSON.stringify({ firstResult, healthProbes, modelCalls, inFlightReceipt, completedReceipt }));
  check("the next pass reuses a model result completed after every client deadline",
    !nextError && nextResult?.text === completedText && replayBody?.idempotent_replay === true && modelCalls === 1,
    JSON.stringify({ error: nextError?.message, nextResult, replayBody, modelCalls, routeCalls }));
  check("the completed late result clears the automatic hold without another charged call",
    nextError == null && nextCallback.stats.retriedPages === 0 && nextCallback.stats.skippedPages === 0 &&
      completedReceipt?.replay_key_sha256 === inFlightReceipt?.replay_key_sha256,
    JSON.stringify({ error: nextError?.message, stats: nextCallback.stats, modelCalls }));
}

{
  const root = mkdtempSync(join(tmpdir(), "brain-ocr-timeout-replay-"));
  const manifestDir = join(root, "manifest");
  mkdirSync(manifestDir, { mode: 0o700 });
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const key = "k".repeat(40);
  const manifest = {
    client: { slug: "fixture" },
    brain: { domain: "brain.example" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: {
      google_drive: { enabled: true, root_folder_ids: ["fixture-root"] },
    },
    safety: {
      credential_scanner: { enabled: true },
      private_path_prefixes: [],
      ocr: { enabled: true, model: DEFAULT_OCR_MODEL, max_pages_per_document: 2 },
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const durableDb = ocrRouteDb();
  const recoveredText = longPage(1);
  let pageRouteCalls = 0;
  let acknowledgementCalls = 0;
  let replayedRouteBody = null;
  let modelCalls = 0;
  let fileFetches = 0;
  let replacementIngestCalls = 0;
  let removalCalls = 0;
  const ingestedDocuments = [];
  const sourceReceipts = [];
  const savedStates = [];
  const priorState = {
    version: 1,
    done: { "drive:scan-fixture": "prior-accepted-revision" },
    skipped: {},
    sync_token: "prior-cursor",
  };
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: durableDb,
    AI: {
      run: async () => {
        modelCalls++;
        return { response: recoveredText, usage: { prompt_tokens: 301, completion_tokens: 60 } };
      },
    },
  };
  const file = {
    id: "scan-fixture",
    name: "scan-fixture.pdf",
    mimeType: "application/pdf",
    size: String(scanPdf().length),
    modifiedTime: "2026-09-24T12:00:00.000Z",
    createdTime: "2026-09-24T12:00:00.000Z",
    parents: ["fixture-root"],
  };
  const drive = {
    ...googleDrive,
    startPageToken: async () => "next-cursor",
    listRootedFiles: async function* () { yield file; },
    toEnvelope: (...args) => {
      fileFetches++;
      return googleDrive.toEnvelope(...args, { fetchImpl: async () => new Response(scanPdf()) });
    },
  };
  const batchStream = async function* (items, prepare, { onSkip } = {}) {
    const group = [];
    for (const item of items) {
      const prepared = await prepare(item);
      if (prepared?.skip) onSkip?.(prepared.skip);
      else if (prepared) group.push(...prepared.envelopes.map((envelope) => ({ ...prepared, envelope })));
    }
    if (group.length) yield group;
  };

  const priorFetch = globalThis.fetch;
  const priorAdminKey = process.env.ADMIN_KEY;
  globalThis.fetch = async (url, opts = {}) => {
    const target = String(url);
    if (target.endsWith("/api/admin/brain/ocr")) {
      const requestBody = JSON.parse(opts.body);
      if (Array.isArray(requestBody.acknowledge_request_ids)) {
        acknowledgementCalls++;
        return handleOcr(workerEnv, new Request(target, opts));
      }
      pageRouteCalls++;
      const response = await handleOcr(workerEnv, new Request(target, opts));
      if (pageRouteCalls === 1) {
        await response.clone().json();
        throw ocrTimeout();
      }
      replayedRouteBody = await response.clone().json();
      return response;
    }
    if (target.includes("/api/admin/brain/source-families")) {
      return new Response(JSON.stringify({
        source: "drive",
        families: ["drive:scan-fixture"],
        next_cursor: null,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", Date: "Thu, 24 Sep 2026 19:00:00 GMT" },
      });
    }
    if (target.endsWith("/api/admin/brain/ingest/batch")) {
      replacementIngestCalls++;
      const requestBody = JSON.parse(opts.body);
      ingestedDocuments.push(...requestBody.docs);
      return new Response(JSON.stringify({
        results: requestBody.docs.map((document) => ({ source_id: document.source_id, status: "updated" })),
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/api/admin/brain/forget-families")) {
      removalCalls++;
      return new Response(JSON.stringify({ removed: 1 }), { status: 200 });
    }
    if (target.endsWith("/api/admin/brain/forget")) {
      return new Response(JSON.stringify({
        dry_run: false,
        documents: 0,
        chunks: 0,
        vectors: 0,
        targets: [],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/api/admin/brain/documents")) {
      return new Response(JSON.stringify({
        vector_backlog: { pending: 0 },
        vector_readiness: { ready: true, actual_vectors: 1, expected_vectors: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/health")) throw new Error("health must not be needed after a successful replay");
    throw new Error(`unexpected synthetic request: ${new URL(target).pathname}`);
  };

  process.env.ADMIN_KEY = key;
  let result = null, error = null;
  try {
    result = await cmdIngestRemote(manifest, manifestPath, { from: "drive", source: "drive" }, {
      withSourceIngestLock: async (_lockOptions, task) => task({ assertOwned: () => true }),
      resolveBaseUrl: async () => "https://brain.example",
      resolveAdminKey: () => key,
      getAccessToken: async () => "synthetic-access",
      drive,
      ingestLib: async () => ({
        batchStream,
        splitOversized: (envelope) => [envelope],
        loadState: () => structuredClone(priorState),
        saveState: (_path, state) => savedStates.push(structuredClone(state)),
        prefetch: async function* (items) { yield* items; },
      }),
      postSourceReceipt: async (_base, _adminKey, receipt) => { sourceReceipts.push(receipt); },
    });
  }
  catch (caught) { error = caught; }
  finally {
    globalThis.fetch = priorFetch;
    if (priorAdminKey === undefined) delete process.env.ADMIN_KEY;
    else process.env.ADMIN_KEY = priorAdminKey;
    rmSync(root, { recursive: true, force: true });
  }

  const finalState = savedStates.at(-1) || priorState;
  const storedOcrReceipt = durableDb.sqlite.prepare(
    "SELECT acknowledged_at,response_json FROM ocr_page_requests",
  ).get();
  check("a lost first OCR response replays through the real route and stores one transcription",
    !error && result?.updated === 1 && pageRouteCalls === 2 && modelCalls === 1 &&
      replayedRouteBody?.idempotent_replay === true &&
      fileFetches === 1 && replacementIngestCalls === 1 && ingestedDocuments.length === 1 &&
      ingestedDocuments[0].content.includes(recoveredText.slice(0, 30)) &&
      ingestedDocuments[0].content.indexOf(recoveredText.slice(0, 30)) ===
        ingestedDocuments[0].content.lastIndexOf(recoveredText.slice(0, 30)),
    JSON.stringify({ error: error?.message, result, pageRouteCalls, modelCalls, replayedRouteBody, fileFetches,
      replacementIngestCalls, ingestedDocuments: ingestedDocuments.length }));
  check("the source acknowledges that page only after its transcription is stored",
    acknowledgementCalls === 1 && Boolean(storedOcrReceipt?.acknowledged_at) &&
      JSON.parse(storedOcrReceipt?.response_json || "{}").acknowledged_at === storedOcrReceipt?.acknowledged_at,
    JSON.stringify({ acknowledgementCalls, storedOcrReceipt }));
  check("the recovered source run reaches the safe terminal decisions without a removal plan",
    removalCalls === 0 && finalState.sync_token === "next-cursor" &&
      finalState.done["drive:scan-fixture"] !== "prior-accepted-revision" &&
      sourceReceipts.some((receipt) => receipt.status === "ready" && receipt.complete_sweep === true) &&
      !sourceReceipts.some((receipt) => receipt.status === "error"),
    JSON.stringify({ removalCalls, finalState, sourceReceipts }));
}

{
  const key = "k".repeat(40);
  const db = ocrRouteDb();
  const startedAt = Date.parse("2026-09-24T12:00:00.000Z");
  let elapsedMs = 0;
  let pageRequests = 0;
  let healthProbes = 0;
  let modelCalls = 0;
  let releaseFirstModel;
  let signalFirstStarted;
  let firstRoute = null;
  const firstStarted = new Promise((resolve) => { signalFirstStarted = resolve; });
  const firstHeld = new Promise((resolve) => { releaseFirstModel = resolve; });
  const workerEnv = {
    ADMIN_KEY: key,
    OCR_ENABLED: "1",
    DB: db,
    AI: {
      run: async () => {
        modelCalls++;
        if (modelCalls === 1) {
          signalFirstStarted();
          await firstHeld;
          return { response: longPage(1), usage: {} };
        }
        return { response: longPage(2), usage: {} };
      },
    },
  };
  const skipMessages = [];
  const call = makeOcrCallback({
    base: "https://brain.example", adminKey: key, model: DEFAULT_OCR_MODEL, maxPages: 2,
    now: () => elapsedMs,
    sleep: async (delayMs) => { elapsedMs += delayMs; },
    random: () => 0.5,
    onSkip: (message) => skipMessages.push(message),
    httpImpl: async (url, options, requestOptions = {}) => {
      if (url.endsWith("/health")) {
        healthProbes++;
        return new Response("{}", { status: 200 });
      }
      pageRequests++;
      const route = handleOcr(workerEnv, new Request(url, options), {
        now: () => new Date(startedAt + elapsedMs),
      });
      if (pageRequests === 1) {
        firstRoute = route;
        await firstStarted;
        elapsedMs += Number(requestOptions.timeoutMs || 0) + 1;
        throw ocrTimeout();
      }
      const response = await route;
      if (response.status === 425) elapsedMs += Number(requestOptions.timeoutMs || 0);
      return response;
    },
  });
  let result = null, error = null;
  try {
    result = await extractPdf(scanPdf({ pages: 2 }), {
      ocr: call,
      ocrDocument: { source: "drive", sourceItemId: "persistent-timeout-fixture" },
    }, { pdfPassImpl: scannedPass });
  } catch (caught) { error = caught; }
  const receiptsBeforeRelease = db.sqlite.prepare(
    "SELECT status,count(*) count FROM ocr_page_requests GROUP BY status ORDER BY status",
  ).all();
  releaseFirstModel();
  await firstRoute;
  const completedReceipts = db.sqlite.prepare(
    "SELECT count(*) count FROM ocr_page_requests WHERE status='completed'",
  ).get().count;
  check("a persistently slow page is skipped after bounded retries while the rest of the PDF finishes",
    !error && pageRequests === 4 && result?.text === null && result?.retryable === true &&
      result?.code === "ocr_page_timeout" && /document was skipped.*next pass/i.test(result?.error || "") &&
      modelCalls === 2 && receiptsBeforeRelease.some((row) => row.status === "in_flight" && row.count === 1) &&
      receiptsBeforeRelease.some((row) => row.status === "completed" && row.count === 1),
    String(error?.message || JSON.stringify({ result, modelCalls, receiptsBeforeRelease }).slice(0, 300)));
  check("a reachable Brain turns the exhausted timeout into one named page skip",
    healthProbes === 1 && /1 OCR page was slow.*skipped.*next pass/i.test(skipMessages[0] || ""),
    JSON.stringify({ healthProbes, skipMessages }));
  check("the callback records one retryable page without counting its later healthy sibling",
    call.stats.retriedPages === 1 && call.stats.skippedPages === 1 && completedReceipts === 2,
    JSON.stringify({ stats: call.stats, completedReceipts }));
}

{
  let pageRequests = 0;
  let healthProbes = 0;
  const call = makeOcrCallback({
    base: "https://brain.example", adminKey: "k", model: "@cf/m", maxPages: 1,
    sleep: async () => {},
    random: () => 0.5,
    httpImpl: async (url) => {
      if (url.endsWith("/health")) {
        healthProbes++;
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      }
      pageRequests++;
      throw ocrTimeout();
    },
  });
  let stopped = null;
  try {
    await call({ png_base64: "AAAA" }, {
      page: 1, totalPages: 1, source: "drive", sourceItemId: "unreachable-fixture",
    });
  }
  catch (caught) { stopped = caught; }
  check("an unreachable Brain stops only after bounded page retries and a failed health probe",
    pageRequests === 3 && healthProbes === 1 && stopped?.fatal === true &&
      stopped?.code === "NETWORK_UNREACHABLE",
    JSON.stringify({ pageRequests, healthProbes, code: stopped?.code, message: stopped?.message }));
  check("the unreachable stop says progress is resumable",
    /progress is saved.*checked again/i.test(stopped?.message || ""), String(stopped?.message));
}

/* ------------------------------------------------------------ the policy */

{
  check("OCR is off unless the manifest turns it on", ocrPolicy({}).enabled === false);
  check("and on when it does", ocrPolicy({ safety: { ocr: { enabled: true } } }).enabled === true);
  check("a per-document page ceiling always exists", ocrPolicy({}).maxPages > 0);

  const off = drivePolicyFingerprint({}, true, false);
  const on = drivePolicyFingerprint({}, true, true);
  check("turning OCR on changes the Drive policy fingerprint, forcing one full sweep",
    off !== on, `${off.slice(0, 12)} vs ${on.slice(0, 12)}`);
  check("...which is what makes a scan refused last month get looked at again",
    drivePolicyFingerprint({}, true, true) === on);
}

/* ---------------------------------------------------------- the cost model */

{
  const hundred = estimateOcrCost(100);
  check("cost is given as a RANGE, because the image token count is not published",
    hundred.usd_low > 0 && hundred.usd_high > hundred.usd_low, JSON.stringify(hundred));
  check("and time is estimated too, because time is the cost people feel",
    hundred.minutes_high > hundred.minutes_low, JSON.stringify(hundred));
  const line = describeOcrCost(estimateOcrCost(2000));
  check("the one-line estimate names pages, money and minutes",
    /2000 scanned pages/.test(line) && /\$/.test(line) && /minutes/.test(line), line);
  check("it says the estimate is a range and why", /range because/.test(line), line);
  check("zero scanned pages costs nothing and says so", /cost nothing/.test(describeOcrCost(estimateOcrCost(0))));
}

/* ================================================== survival into storage */
/* The claim that matters: the mark reaches a stored row and a citation. */

{
  const DIR = join(HERE, "..", "migrations", "d1");
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort()) {
    for (const statement of splitStatements(readFileSync(join(DIR, file), "utf-8"))) sqlite.exec(statement);
  }

  // The outbox generation clock is owned by install_state, and the trigger that
  // stamps it needs a row to read. A real install always has one.
  sqlite.exec(
    `INSERT INTO install_state (id, client_slug, product_version, schema_version, gate_version, installed_at, ring)
     VALUES (1, 'ocr-fixture', '0.0.0', 17, 0, '2026-01-01T00:00:00Z', 'test')`,
  );

  const columns = new Set(sqlite.prepare("PRAGMA table_info(documents)").all().map((r) => r.name));
  check("documents.text_source exists as a real column, not a JSON key",
    columns.has("text_source") && columns.has("text_reliable"), [...columns].join(","));

  // D1 hands a write back its RETURNING rows, and derives meta.changes from a
  // total_changes() delta that counts trigger writes too. node:sqlite's run()
  // reports neither, so a stub built on it cannot carry the ingest finalizer's
  // RETURNING proof. Execute RETURNING writes with all() and report the same
  // trigger-inclusive delta D1 does; a row that does not match still comes back
  // empty, so nothing here can manufacture a commit the database refused.
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
          const out = statements.map((s) => write(s._sql, s._params));
          sqlite.exec("COMMIT");
          return out;
        } catch (e) { sqlite.exec("ROLLBACK"); throw e; }
      },
    },
  };
  const store = storeFor(env);

  const ocrBody = `${OCR_BANNER}\n\n[[page 1 | OCR]]\n${longPage(1)}`;
  await store.ingest(env, {
    source_type: "upload", source_id: "scans/statement.pdf",
    title: "Statement", content: ocrBody,
    text_source: "ocr", text_reliable: false,
    metadata: { category: "upload", ocr: { pages_read: 1, confidence: 1 } },
  });
  await store.ingest(env, {
    source_type: "upload", source_id: "notes/plain.md",
    title: "Plain note", content: `A note that arrived with its own text layer. ${longPage(9)}`,
    text_source: "native", text_reliable: true,
    metadata: { category: "upload" },
  });

  const rows = Object.fromEntries(
    sqlite.prepare("SELECT source_id, text_source, text_reliable FROM documents").all().map((r) => [r.source_id, r]),
  );
  check("the OCR mark SURVIVED into the stored document",
    rows["scans/statement.pdf"].text_source === "ocr" && rows["scans/statement.pdf"].text_reliable === 0,
    JSON.stringify(rows["scans/statement.pdf"]));
  check("a document with a real text layer is stored as native and reliable",
    rows["notes/plain.md"].text_source === "native" && rows["notes/plain.md"].text_reliable === 1,
    JSON.stringify(rows["notes/plain.md"]));
  check("the per-page OCR detail is kept in meta for diagnosis",
    /"pages_read":1/.test(sqlite.prepare("SELECT meta FROM documents WHERE source_id='scans/statement.pdf'").get().meta));

  /* --- and it comes back OUT of retrieval, which is the only place it counts --- */
  const found = await store.search(env, { query: "Debit card purchase balance", limit: 5 });
  const byRef = Object.fromEntries(found.results.map((r) => [r.ref_key, r]));
  check("retrieval returns the provenance beside every result",
    byRef["scans/statement.pdf"]?.text_source === "ocr" &&
    byRef["scans/statement.pdf"]?.text_reliable === false,
    JSON.stringify(found.results.map((r) => [r.ref_key, r.text_source])));
  check("a natively extracted result is plainly distinguishable from it",
    byRef["notes/plain.md"]?.text_source === "native" && byRef["notes/plain.md"]?.text_reliable === true,
    JSON.stringify(byRef["notes/plain.md"]));

  /* --- re-extraction with a real text layer must CLEAR the mark --- */
  await store.ingest(env, {
    source_type: "upload", source_id: "scans/statement.pdf",
    title: "Statement", content: `A rescanned copy that now carries a text layer. ${longPage(2)}`,
    text_source: "native", text_reliable: true,
    metadata: { category: "upload" },
  });
  check("a document re-read from a real text layer stops being marked as a scan",
    sqlite.prepare("SELECT text_source FROM documents WHERE source_id='scans/statement.pdf'").get().text_source === "native");
}

/* --------------------------------------------- and into the confidence line */

{
  const clean = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "native" }],
  });
  const scanned = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "ocr" }],
  });
  const partial = computeAnswerConfidence({
    approvedDocs: [{ ref: "a", ts: "2026-01-01", date_reliable: true, text_source: "ocr_partial" }],
  });
  check("an answer resting on a scan scores LOWER than the same answer on real text",
    scanned.percent < clean.percent, `${scanned.percent} vs ${clean.percent}`);
  check("a half-read scan scores lower still", partial.percent < scanned.percent,
    `${partial.percent} vs ${scanned.percent}`);
  check("and the reason is stated in the basis, not buried in a number",
    scanned.basis.some((b) => /read by OCR from a scanned image/.test(b)), JSON.stringify(scanned.basis));
  check("a clean answer says nothing about OCR at all",
    !clean.basis.some((b) => /OCR/.test(b)), JSON.stringify(clean.basis));
}

/* ----------------------------------------------------------------- helper */

/** A pass that behaves like the real child on a document with no text layer. */
async function scannedPass(buf, opts) {
  if (!opts?.withPageImages) return { body: "", totalPages: 1, perPage: 0, pageImages: null };
  const rendered = await renderPdfPageImages(new Uint8Array(buf), { maxPages: opts.withPageImages });
  return { body: "", totalPages: rendered.totalPages, perPage: 0, pageImages: rendered.pages };
}

console.log(`\n${ran - fail}/${ran} checks passed`);
if (fail) process.exit(1);
