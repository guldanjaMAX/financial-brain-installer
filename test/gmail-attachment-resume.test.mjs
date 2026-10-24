import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, credentialScannerFingerprint } from "../brain.mjs";
import * as ingest from "../ingest/run.mjs";

const currentRevision = "gmail-extraction-2:message-history";
const json = (value) => new Response(JSON.stringify(value), { status: 200 });

// Use the real source runner with snapshot checkpoint storage. Atomic file
// replacement has its own suite; these tests isolate extraction-policy resume
// decisions from host file locks. Provider and credential boundaries are stubs.
async function sweep(savedRevision, { stored = true, refuse = false } = {}) {
  const temporaryRoot = realpathSync.native(tmpdir());
  const root = realpathSync.native(mkdtempSync(join(temporaryRoot, "gmail-attachment-resume-")));
  const manifestPath = join(root, "fixture.manifest.json");
  const manifest = {
    client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    corpora: { gmail: { enabled: true } },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  let persistedState = {
    version: 1, done: { "gmail:report-message": savedRevision }, skipped: {},
    history_id: "prior-history",
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
    gmail_policy_fingerprint: "previous-extraction-policy",
  };
  const reads = [];
  const sends = [];
  const receipts = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = console.warn = () => {};
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, "https://fixture.invalid");
    const route = new URL(url).pathname;
    if (route === "/api/admin/brain/ingest/batch") {
      const docs = JSON.parse(options.body).docs;
      sends.push(...docs);
      return json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "updated", chunks: 1 })) });
    }
    if (route === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    throw new Error("unexpected offline route");
  };
  let error = null;
  try {
    try {
      await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source: "gmail" }, {
        withSourceIngestLock: async (_options, run) => run({ assertOwned() {} }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => "synthetic-owner-authority",
        getAccessToken: async () => { throw new Error("provider token boundary must remain unused"); },
        ingestLib: async () => ({ ...ingest,
          loadState: () => structuredClone(persistedState),
          saveState: (_path, state) => { persistedState = structuredClone(state); },
        }),
        gmail: {
          currentHistoryId: async () => "next-history",
          listMessages: async function* () { yield "report-message"; },
          listHistory: async () => { throw new Error("a changed policy requires a full sweep"); },
          toEnvelope: async (_token, id) => {
            reads.push(id);
            return refuse
              ? { skip: { id, path: id, reason: "message MIME evidence is unavailable" }, retain_existing: true, cursor_blocking: true }
              : { version: currentRevision, envelope: {
                  source_type: "gmail", source_id: id, title: "Scheduled report",
                  content: "Synthetic balance sheet attachment: cash 400, liabilities 100, equity 300.",
                } };
          },
        },
        listStoredSourceFamilies: async () => new Set(stored ? ["gmail:report-message"] : []),
        postSourceReceipt: async (_base, _authority, receipt) => { receipts.push(receipt); return receipt; },
        removalPlanRequest: async ({ body }) => {
          assert.equal(body.action, "preview", "this test never authorizes removal");
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" }, targets: [], documents: 0 };
        },
      });
    } catch (caught) { error = caught; }
    return { error, reads, sends, receipts, state: persistedState };
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    const relativeRoot = relative(temporaryRoot, root);
    assert.ok(relativeRoot && !relativeRoot.startsWith("..") && !isAbsolute(relativeRoot));
    rmSync(root, { recursive: true, force: true });
  }
}

test("an accepted body-only revision is read again under the attachment policy", async () => {
  const result = await sweep("message-history");
  assert.equal(result.error, null);
  assert.deepEqual(result.reads, ["report-message"], "old message bodies must not bypass new attachment extraction");
  assert.equal(result.sends.length, 1);
  assert.match(result.sends[0].content, /balance sheet attachment/);
  assert.equal(result.state.done["gmail:report-message"], currentRevision);
  assert.equal(result.state.history_id, "next-history");
  assert.equal(result.receipts.at(-1).status, "ready");
});

test("a current accepted revision still resumes during an interrupted policy sweep", async () => {
  const result = await sweep(currentRevision);
  assert.equal(result.error, null);
  assert.deepEqual(result.reads, []);
  assert.deepEqual(result.sends, []);
  assert.equal(result.state.done["gmail:report-message"], currentRevision);
  assert.equal(result.state.history_id, "next-history");
});

test("a missing stored family is reread even with a current extraction revision", async () => {
  const result = await sweep(currentRevision, { stored: false });
  assert.equal(result.error, null);
  assert.deepEqual(result.reads, ["report-message"]);
  assert.equal(result.sends.length, 1);
});

test("missing message MIME evidence during policy migration keeps the prior cursor and family", async () => {
  const result = await sweep("message-history", { refuse: true });
  assert.ok(result.error, "missing message MIME evidence cannot close a successful sweep");
  assert.deepEqual(result.reads, ["report-message"]);
  assert.deepEqual(result.sends, []);
  assert.equal(result.state.done["gmail:report-message"], "message-history");
  assert.equal(result.state.history_id, "prior-history");
  assert.equal(result.state.gmail_policy_fingerprint, "previous-extraction-policy");
  assert.equal(result.receipts.at(-1).status, "error");
});
