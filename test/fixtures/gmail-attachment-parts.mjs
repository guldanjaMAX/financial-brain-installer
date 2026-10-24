import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, credentialScannerFingerprint } from "../../brain.mjs";
import * as ingest from "../../ingest/run.mjs";
import * as gmail from "../../connectors/gmail.mjs";

export const BODY = "The owner can review the readable message body and the included financial reports.";
export const REPORT = "Account,Amount\nOperating cash,1200\nAccounts payable,200\nRetained earnings,1000\n";
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

export function message(attachments = [], body = BODY) {
  const lines = ["From: reports@example.invalid", "To: owner@example.invalid", "Subject: Scheduled report",
    'Content-Type: multipart/mixed; boundary="fixture-parts"', "",
    "--fixture-parts", "Content-Type: text/plain; charset=utf-8", "", body];
  for (const [name, text] of attachments) {
    lines.push("--fixture-parts", "Content-Type: application/octet-stream",
      `Content-Disposition: attachment; filename="${name}"`, "Content-Transfer-Encoding: base64", "",
      Buffer.from(text).toString("base64"));
  }
  lines.push("--fixture-parts--", "");
  return Buffer.from(lines.join("\r\n")).toString("base64url");
}

// Real history, preparation, credential scan, batching and receipt settlement;
// only provider/Worker requests, authority and snapshot storage are injected.
export async function fixture(run, { scannerEnabled = true } = {}) {
  const temporaryRoot = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(temporaryRoot, "gmail-attachment-parts-")));
  const manifestPath = join(root, "fixture.manifest.json");
  const manifest = { client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    corpora: { gmail: { enabled: true } },
    safety: { credential_scanner: { enabled: scannerEnabled }, ocr: { enabled: false } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const scanner = credentialScannerFingerprint(scannerEnabled);
  let persisted = { version: 1, done: {}, skipped: {}, history_id: "history-zero",
    credential_scanner_fingerprint: scanner,
    gmail_policy_fingerprint: gmail.gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }) };
  const f = { ids: [], raw: {}, marker: "history-one", reads: [], sends: [], receipts: [], histories: [],
    state: () => structuredClone(persisted) };
  const previous = { fetch: globalThis.fetch, log: console.log, warn: console.warn };
  console.log = console.warn = () => {};
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, "https://fixture.invalid");
    const route = new URL(url).pathname;
    if (route === "/api/admin/brain/ingest/batch") {
      const docs = JSON.parse(options.body).docs;
      f.sends.push(...docs);
      return json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "created", chunks: 1 })) });
    }
    if (route === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    throw new Error("unexpected offline Worker route");
  };
  f.once = async () => {
    let error = null;
    try {
      await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source: "gmail" }, {
        withSourceIngestLock: async (_options, task) => task({ assertOwned() {} }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => "synthetic-owner-authority",
        getAccessToken: async () => { throw new Error("provider credential boundary must remain unused"); },
        ingestLib: async () => ({ ...ingest,
          loadState: () => structuredClone(persisted),
          saveState: (_path, state) => { persisted = structuredClone(state); },
        }),
        gmail: {
          listAttachmentCandidates: async () => ({ ids: [], nextPageToken: null }),
          listHistory: async (_token, history) => {
            f.histories.push(history);
            return { ids: f.ids, deletedIds: [], historyId: f.marker };
          },
          listMessages: async function* () { throw new Error("part exclusions must retain the history lane"); },
          messagePolicy: async () => ({ allowed: true }),
          toEnvelope: async (_token, id, options) => {
            f.reads.push(id);
            return gmail.toEnvelope(async () => "synthetic-access", id, options, {
              fetchImpl: async (url) => {
                assert.equal(new URL(url).searchParams.get("format"), "raw");
                return json({ id, labelIds: f.labels || ["INBOX"], historyId: f.marker,
                  internalDate: "1792670400000", ...(f.raw[id] == null ? {} : { raw: f.raw[id] }) });
              },
            });
          },
        },
        listStoredSourceFamilies: async () => new Set(f.sends.map((doc) => `gmail:${doc.source_id}`)),
        postSourceReceipt: async (_base, _key, receipt) => { f.receipts.push(receipt); return receipt; },
        removalPlanRequest: async ({ body }) => {
          assert.equal(body.action, "preview");
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" }, targets: [], documents: 0 };
        },
      });
    } catch (caught) { error = caught; }
    return error;
  };
  try { await run(f); }
  finally {
    globalThis.fetch = previous.fetch;
    console.log = previous.log;
    console.warn = previous.warn;
    const suffix = relative(temporaryRoot, root);
    assert.ok(suffix && !suffix.startsWith("..") && !isAbsolute(suffix));
    rmSync(root, { recursive: true, force: true });
  }
}

