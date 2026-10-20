/**
 * Ingest-pipeline harness on the synthetic folder.
 *
 * WHAT IS REAL AND WHAT IS STUBBED
 *
 * Local folder lane: `cmdIngestLocal` runs exactly as `brain ingest --path`
 * does. The real walk, the real prepare() and every extractor it reaches
 * (ingest/extract.mjs, ingest/formats.mjs, the isolated PDF child process,
 * the mbox splitter), the real credential gate, splitOversized and the real
 * batchStream all run. Only the boundaries are injected: the Worker that
 * receives batches, the source receipt endpoint, the removal-plan endpoint,
 * the lock, and OCR. OCR is stubbed PER PAGE at the same `ocr(image, ctx)`
 * callback seam extractPdf calls, so page rendering is still real and the
 * stub sees exactly the pages a live run would bill.
 *
 * Drive lane: the connector's own exclusionReason() and toEnvelope() run
 * against a synthetic listing with an injected `fetchImpl`, then through the
 * same sanitize, credential, split and batchStream steps the Drive command
 * applies (brain.mjs prepareDrive). It does not run the Drive OAuth, cursor
 * or removal machinery.
 *
 * WHAT A BATCH IS HERE
 *
 * `batches` is `group.map((item) => item.envelope)` for every group handed to
 * sendBatches, which is byte-for-byte the `docs` array the real sendBatches
 * POSTs to the Worker. A consumer (the P6-10a Worker replay, when it lands)
 * receives those arrays through `onBatch` and its answer becomes the per-item
 * status the sync sees.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cmdIngestLocal, credentialRefusalOf, driveConnectorConfig } from "../../../../brain.mjs";
import * as realIngest from "../../../../ingest/run.mjs";
import * as drive from "../../../../connectors/google-drive.mjs";
import { ingestEnvelopeValidationError } from "../../../src/lib/ingest-envelope.js";
import { normalizeIngestEnvelopeProvenance } from "../../../src/lib/provenance-receipt.js";
import { sanitizeEnvelope } from "../../../src/lib/secret-scan.js";
import {
  SYNTHETIC_PRIVATE_PREFIX,
  materializeSyntheticFolder,
  syntheticPdf,
} from "./build.mjs";

export const SYNTHETIC_DOMAIN = "brain.example.invalid";
export const SYNTHETIC_LOCAL_SOURCE = "store-north";
export const SYNTHETIC_DRIVE_SOURCE = "drive";

/**
 * A per-page OCR stub. It never sees a model; it returns invented words for
 * each page it is handed and records every call so a test can assert which
 * documents and which pages would have been billed.
 */
export function perPageOcrStub({
  pageText = ({ page, sourceItemId }) =>
    `Synthetic OCR reading of page ${page} of ${sourceItemId}. ` +
    "Payer One remittance advice, deposit 4,200.00 to Store North on 2026-03-31, reference R-0042. " +
    "This sentence pads the page past the readable floor so the verdict is about coverage, not length.",
  maxPages = 40,
} = {}) {
  const calls = [];
  const ocr = async (image, context = {}) => {
    calls.push({
      page: context.page,
      totalPages: context.totalPages,
      source: context.source,
      sourceItemId: context.sourceItemId,
      hasImage: Boolean(image),
    });
    return { text: pageText(context) };
  };
  ocr.maxPages = maxPages;
  ocr.model = "synthetic-ocr-stub";
  ocr.calls = calls;
  return ocr;
}

/**
 * The default Worker double: the admission step of the real batch route
 * (worker/src/index.js normalizes, sanitizes, then calls
 * ingestEnvelopeValidationError). A document that fails it is answered
 * `failed` with the Worker's own error text, so an envelope the real Worker
 * would reject can never look accepted here. Storage is not simulated.
 */
export function admitLikeWorker(docs) {
  return docs.map((raw) => {
    const envelope = normalizeIngestEnvelopeProvenance(sanitizeEnvelope(raw));
    const error = ingestEnvelopeValidationError(envelope);
    return error
      ? { source_id: envelope?.source_id ?? null, status: "failed", error }
      : { source_id: envelope.source_id, status: "created" };
  });
}

function syntheticManifest() {
  return {
    brain: { domain: SYNTHETIC_DOMAIN },
    safety: {
      private_path_prefixes: [SYNTHETIC_PRIVATE_PREFIX],
      credential_scanner: { enabled: true },
    },
  };
}

/**
 * Run the real local-folder ingest over a fresh copy of the synthetic folder.
 *
 * Returns everything a sync would have sent or reported. The temporary folder
 * is removed before returning unless `keep` is set.
 */
export async function runSyntheticLocalSync({
  ocr = perPageOcrStub(),
  onBatch = admitLikeWorker,
  ingestLib = realIngest,
  keep = false,
} = {}) {
  const workRoot = mkdtempSync(join(tmpdir(), "brain-ingest-synthetic-"));
  const folder = materializeSyntheticFolder(join(workRoot, "store-north"));
  const manifestDir = join(workRoot, "install");
  mkdirSync(manifestDir);
  const manifestPath = join(manifestDir, "brain.manifest.json");
  const manifest = syntheticManifest();
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const batches = [];
  const items = [];
  const admissions = [];
  const receipts = [];
  const output = [];
  const prepared = [];
  const priorLog = console.log;
  const priorError = console.error;
  console.log = (...parts) => output.push(parts.join(" "));
  console.error = (...parts) => output.push(parts.join(" "));

  let result;
  let failure = null;
  try {
    result = await cmdIngestLocal(manifest, manifestPath, { path: folder, source: SYNTHETIC_LOCAL_SOURCE }, {
      withSourceIngestLock: async (_lock, run) => run({ assertOwned: () => true }),
      resolveBaseUrl: async () => `https://${SYNTHETIC_DOMAIN}`,
      resolveAdminKey: () => "synthetic-owner-proof",
      // The only change to the ingest library is the OCR callback. Every other
      // export is the shipped module, so walk, batching and splitting are real.
      ingestLib: async () => ({
        ...ingestLib,
        prepare: async (file, options) => {
          const r = await ingestLib.prepare(file, { ...options, ocr });
          prepared.push({ rel: String(file.rel).split("\\").join("/"), result: r });
          return r;
        },
      }),
      postSourceReceipt: async (_base, _key, receipt) => {
        receipts.push(structuredClone(receipt));
        return receipt;
      },
      sendBatches: async ({ groups, onResult }) => {
        const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
        for (const group of groups) {
          // Exactly the array the real sendBatches POSTs.
          const docs = group.map((item) => item.envelope);
          batches.push(structuredClone(docs));
          for (const item of group) items.push(structuredClone(item));
          const answers = await onBatch(structuredClone(docs));
          admissions.push(...structuredClone(answers || []));
          group.forEach((item, index) => {
            const status = answers?.[index]?.status || "failed";
            tally[status in tally ? status : "failed"]++;
            onResult?.(item, { source_id: item.envelope.source_id, status });
          });
        }
        return tally;
      },
      removalPlanRequest: async () => ({
        marker: { instance: "synthetic", nonce: "synthetic", generation: 1, runtime: "synthetic" },
        targets: [],
        documents: 0,
      }),
      listStoredSourceFamilies: async () => new Set(),
      reportBacklog: async () => {},
    });
  } catch (error) {
    failure = error;
  } finally {
    console.log = priorLog;
    console.error = priorError;
    if (!keep) rmSync(workRoot, { recursive: true, force: true });
  }

  return {
    result,
    failure,
    batches,
    envelopes: batches.flat(),
    items,
    admissions,
    prepared,
    receipts,
    output: output.join("\n"),
    ocrCalls: ocr?.calls || [],
    workRoot,
  };
}

/* ---------------------------------------------------------------- drive */

const DRIVE_ROOT = "synthetic-root-folder";

/** A synthetic Drive listing. Ids are opaque role-word strings. */
export function syntheticDriveListing() {
  const textPdf = syntheticPdf([{ text: [
    "Licensee Alpha license fee invoice for Store North, March 2026.",
    "Amount due 2,400.00 by 2026-04-15. Remit to Licensee Alpha operations.",
  ] }]);
  const scan = syntheticPdf([{ scan: true }]);
  const csv = Buffer.from(
    "Store North deposit log\n\nDate,Payer,Amount\n2026-03-31,Payer One,4200.00\n2026-03-16,Payer Two,980.00\n",
  );
  const excludedBytes = Buffer.from("A reviewed duplicate that the file-id policy excludes before any download.\n");
  const files = [
    { id: DRIVE_ROOT, name: "Store North", mimeType: drive.FOLDER_MIME, parents: [] },
    { id: "drive-file-license-invoice", name: "Licensee Alpha invoice 2026-03.pdf", mimeType: "application/pdf", bytes: textPdf },
    { id: "drive-file-remittance-scan", name: "Payer One remittance scan.pdf", mimeType: "application/pdf", bytes: scan },
    { id: "drive-file-deposit-log", name: "deposit log.csv", mimeType: "text/csv", bytes: csv },
    { id: "drive-file-reviewed-duplicate", name: "deposit log copy.txt", mimeType: "text/plain", bytes: excludedBytes },
    { id: "drive-file-shortcut", name: "Shortcut to outside folder", mimeType: drive.SHORTCUT_MIME },
    { id: "drive-file-photo", name: "storefront.png", mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  ];
  return files.map((file) => ({
    ...file,
    parents: file.parents ?? [DRIVE_ROOT],
    size: file.bytes ? String(file.bytes.length) : undefined,
    createdTime: "2026-03-01T12:00:00.000Z",
    modifiedTime: "2026-03-02T12:00:00.000Z",
    md5Checksum: file.bytes ? `synthetic-md5-${file.id}` : undefined,
    scope_root_ids: [DRIVE_ROOT],
  }));
}

export const SYNTHETIC_EXCLUDED_DRIVE_IDS = Object.freeze(["drive-file-reviewed-duplicate"]);

/**
 * Run the Drive connector's exclusion and extraction on the synthetic listing.
 * `fetchCalls` records every content request so a test can prove an excluded
 * id was never downloaded.
 */
export async function runSyntheticDriveExtraction({
  ocr = perPageOcrStub(),
  excludeFileIds = SYNTHETIC_EXCLUDED_DRIVE_IDS,
} = {}) {
  const listing = syntheticDriveListing();
  const byId = new Map(listing.map((file) => [file.id, file]));
  const policy = driveConnectorConfig({
    corpora: { google_drive: { root_folder_ids: [DRIVE_ROOT], exclude_file_ids: [...excludeFileIds] } },
    safety: { private_path_prefixes: [SYNTHETIC_PRIVATE_PREFIX] },
  }, join(tmpdir(), "synthetic.manifest.json"));
  const folders = drive.updateFolderIndex(listing);
  const pathOf = (file) => drive.folderPathFor(file, folders);
  const fetchCalls = [];
  const fetchImpl = async (url) => {
    const match = String(url.pathname || new URL(url).pathname).match(/\/files\/([^/]+)$/u);
    const id = match ? decodeURIComponent(match[1]) : "";
    fetchCalls.push(id);
    const file = byId.get(id);
    if (!file?.bytes) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    return new Response(file.bytes, { status: 200 });
  };
  const getToken = async () => "synthetic-drive-token";

  const skips = [];
  const batches = [];
  const admissions = [];
  const prepareDrive = async (file) => {
    const folder = pathOf(file);
    const excluded = drive.exclusionReason(file, folder, policy);
    if (excluded) {
      return { skip: { path: [folder, file.name].filter(Boolean).join("/"), id: file.id, reason: excluded } };
    }
    const r = await drive.toEnvelope(getToken, file, { sourceName: SYNTHETIC_DRIVE_SOURCE, pathOf, ocr }, { fetchImpl, attempts: 1 });
    if (!r) return null;
    if (r.skip) return { skip: r.skip };
    const envelope = sanitizeEnvelope(r.envelope);
    const refusal = credentialRefusalOf(envelope, true);
    if (refusal) return { skip: { path: file.name, id: file.id, reason: refusal.reason } };
    return { hash: r.version, envelopes: realIngest.splitOversized(envelope), rel: file.name };
  };
  for await (const group of realIngest.batchStream(listing, prepareDrive, {
    onSkip: (skip) => skips.push(skip),
  })) {
    const docs = group.map((item) => item.envelope);
    batches.push(docs);
    admissions.push(...admitLikeWorker(structuredClone(docs)));
  }
  return { policy, batches, envelopes: batches.flat(), admissions, skips, fetchCalls, ocrCalls: ocr?.calls || [] };
}
