// "Clean my Brain": an item the owner removed stays out when Gmail or Drive is
// read again in full, after a history gap, after --reset, and when it simply
// shows up in history again. Local fixtures only.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./helpers/gmail-batch-fixture.mjs";
import { listOwnerRemovedFamilies } from "../brain.mjs";
import { makeBrain, ADMIN_KEY, BASE } from "./helpers/clean-brain-fixture.mjs";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdIngestRemote, credentialScannerFingerprint } from "../brain.mjs";
import * as drive from "../connectors/google-drive.mjs";
import { batchStream, splitOversized, prefetch } from "../ingest/run.mjs";

const REMOVED = new Set(["gmail:entry-1", "gmail:entry-3"]);
const ledger = (calls) => async ({ uids, source }) => {
  calls?.push({ source, uids: [...uids] });
  return new Set(uids.filter((uid) => REMOVED.has(uid)));
};

test("incremental history: a removed message that appears again is not fetched or stored", async () => fixture(async f => {
  const asked = [];
  f.options = { listOwnerRemovedFamilies: ledger(asked) };
  f.ids = ["entry-0", "entry-1", "entry-2", "entry-3"];
  const run = await f.once();
  assert.equal(run.error, null);
  assert.deepEqual(f.reads.sort(), ["entry-0", "entry-2"], "removed mail was never fetched");
  assert.deepEqual([...f.stored].sort(), ["gmail:entry-0", "gmail:entry-2"]);
  assert.equal(run.state.history_id, "next", "an owner removal never holds the history cursor");
  assert.equal(f.calls.flat().some((id) => /entry-[13]/.test(id)), false, "never posted");
  assert.equal(Object.keys(run.state.gmail_entry_failures || {}).length, 0, "no retry hold");
  assert.equal(Object.keys(run.state.gmail_retries || {}).length, 0);
  assert.match(run.state.skipped["gmail:entry-1"], /OWNER_REMOVED/);
  assert.ok(asked.length > 0 && asked.every((call) => call.source === "gmail"));
  assert.equal(f.forgotten, 0);
}));

test("a full re-read after a history gap skips removed mail, loads the rest, and settles like a clean run", async () => {
  const outcome = async (removed) => {
    let result;
    await fixture(async f => {
      f.options = { listOwnerRemovedFamilies: async ({ uids }) => new Set(uids.filter((uid) => removed.has(uid))) };
      f.ids = ["entry-0", "entry-1", "entry-2", "entry-3", "entry-4"];
      f.setState({ ...f.state(), history_id: null });
      const run = await f.once();
      assert.equal(run.error, null);
      assert.ok((f.fullLists || 0) + (f.listPages || 0) > 0, "this was a full listing, not history");
      result = { reads: [...f.reads].sort(), stored: [...f.stored].sort(), history: run.state.history_id,
        holds: Object.keys(run.state.gmail_entry_failures || {}).length, status: run.receipt?.status };
    });
    return result;
  };
  const control = await outcome(new Set());
  const cleaned = await outcome(REMOVED);
  assert.deepEqual(control.stored, ["gmail:entry-0", "gmail:entry-1", "gmail:entry-2", "gmail:entry-3", "gmail:entry-4"]);
  assert.deepEqual(cleaned.reads, ["entry-0", "entry-2", "entry-4"], "removed mail is never fetched");
  assert.deepEqual(cleaned.stored, ["gmail:entry-0", "gmail:entry-2", "gmail:entry-4"]);
  assert.equal(cleaned.history, control.history, "the cursor settles exactly as it does with nothing removed");
  assert.equal(cleaned.holds, 0);
  assert.equal(cleaned.status, control.status);
});

test("--reset keeps the removal memory because it lives on the Brain, not in the local state", async () => fixture(async f => {
  f.options = { listOwnerRemovedFamilies: ledger() };
  f.ids = ["entry-0", "entry-1"];
  const first = await f.once();
  assert.equal(first.error, null);
  const reset = await f.once({ reset: true });
  assert.equal(reset.error, null);
  assert.equal(f.reads.filter((id) => id === "entry-1").length, 0, "never fetched, before or after the reset");
  assert.equal(f.stored.has("gmail:entry-1"), false);
}));

test("only ids missing from the Brain are asked about: stored mail costs no ledger read", async () => fixture(async f => {
  const asked = [];
  f.options = { listOwnerRemovedFamilies: ledger(asked) };
  f.ids = ["entry-0", "entry-1"];
  f.stored.add("gmail:entry-0");
  await f.once();
  assert.deepEqual(asked.flatMap((call) => call.uids), ["gmail:entry-1"]);
}));

test("without the ledger (an older Worker) mail loads as before", async () => fixture(async f => {
  f.options = { listOwnerRemovedFamilies: async () => new Set() };
  f.ids = ["entry-0", "entry-1"];
  const run = await f.once();
  assert.equal(run.error, null);
  assert.deepEqual([...f.stored].sort(), ["gmail:entry-0", "gmail:entry-1"]);
}));

test("the Worker's own refusal is the second line of defense and does not stall the run", async () => fixture(async f => {
  // The client does not know (ledger unreachable); the Worker refuses the post.
  f.options = { listOwnerRemovedFamilies: async () => new Set() };
  f.ids = ["entry-0", "entry-1"];
  f.respond = (docs) => Response.json({ results: docs.map((doc) => doc.source_id === "entry-1"
    ? { source_id: doc.source_id, status: "refused", labels: ["owner_removed"] }
    : { source_id: doc.source_id, status: "created", chunks: 1 }) });
  const run = await f.once();
  assert.equal(run.error, null);
  assert.equal(run.state.history_id, "next", "a refused removed item does not hold the cursor");
}));

test("the client ledger check: one bounded read, any failure means none known", async () => {
  const brain = makeBrain();
  brain.load("gmail", ["live"]);
  brain.db.prepare("INSERT INTO owner_removals (family_uid, source, provider_id, removed_at, run_id, batch_no, reason) VALUES ('gmail:gone', 'gmail', 'gone', 1, 'clean_run_x1', 0, 'owner_removal')").run();
  const http = (url, options) => brain.fetch(url, options);
  const found = await listOwnerRemovedFamilies({ base: BASE, adminKey: ADMIN_KEY, source: "gmail", uids: ["gmail:gone", "gmail:live", "gmail:never"], fetchImpl: http });
  assert.deepEqual([...found], ["gmail:gone"]);
  // 250 ids go out as three bounded calls of at most 97.
  brain.requests.length = 0;
  const many = Array.from({ length: 250 }, (_, i) => `gmail:x${i}`);
  await listOwnerRemovedFamilies({ base: BASE, adminKey: ADMIN_KEY, source: "gmail", uids: many, fetchImpl: http });
  assert.deepEqual(brain.requests.map((r) => r.body.uids.length), [97, 97, 56]);
  // An unreachable or older Worker never blocks a read.
  for (const fetchImpl of [async () => { throw new Error("network"); }, async () => new Response("no", { status: 404 }), async () => new Response("{", { status: 200 })]) {
    assert.equal((await listOwnerRemovedFamilies({ base: BASE, adminKey: ADMIN_KEY, source: "gmail", uids: ["gmail:gone"], fetchImpl })).size, 0);
  }
});

// ---- Drive -----------------------------------------------------------------
const stamp = "2026-11-01T00:00:00.000Z";
const body = "The owner reviewed this synthetic project record and approved the next scheduled review. This document records the decision and supporting evidence for the plan.";
const driveFile = (id) => ({ id, name: `${id}.txt`, mimeType: "text/plain", parents: ["reviewed"], size: String(body.length), modifiedTime: stamp });
const folder = (id, parent) => ({ id, name: id, mimeType: drive.FOLDER_MIME, parents: parent ? [parent] : [] });

// Drive writes only through the incremental change feed (a full comparison is
// read-only review), so this is the path a removed file would come back on:
// someone edits it again.
function driveHarness({ removed = new Set() }) {
  const state = { version: 1, done: {}, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true),
    sync_token: "old-page" };
  const downloads = [], sent = [], asked = [];
  const files = ["fileA", "fileB", "fileC"].map(driveFile);
  const byId = new Map([folder("reviewed", "account-root"), folder("account-root"), ...files].map((f) => [f.id, f]));
  const opts = { attempts: 1, fetchImpl: async (input) => {
    const url = new URL(input), id = decodeURIComponent(url.pathname.split("/").at(-1));
    if (url.searchParams.get("alt") === "media") { downloads.push(id); return new Response(body); }
    if (id === "startPageToken") return Response.json({ startPageToken: "seed" });
    if (id === "changes") return Response.json({ changes: files.map((f) => ({ fileId: f.id, file: f })), newStartPageToken: "done-page" });
    assert.ok(byId.has(id === "root" ? "account-root" : id), `unexpected metadata lookup ${id}`);
    return Response.json(byId.get(id === "root" ? "account-root" : id));
  } };
  const connector = new Proxy(drive, { get(target, name) {
    if (["startPageToken", "getFileMetadata"].includes(name)) return (...args) => target[name](...args, opts);
    if (name === "listChanges") return (get, page) => target[name](get, page, opts);
    if (name === "listChangePage") return (get, page, config) => target[name](get, page, { ...config, ...opts });
    if (name === "changeScope") return (get, f, config) => target[name](get, f, { ...config, opts });
    if (name === "toEnvelope") return (get, f, config) => drive.toEnvelope(get, f, config, opts);
    if (name === "listRootedFiles") return async function* () { yield* files; };
    return target[name];
  } });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-clean-")));
  const manifestPath = join(root, "manifest.json");
  const keyPath = join(root, ".brain-admin-key");
  const launchctl = join(root, "launchctl-fixture");
  writeFileSync(launchctl, "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const manifest = { brain: { domain: "owner.invalid" }, corpora: { google_drive: { enabled: true, root_folder_ids: ["reviewed"] } },
    safety: { ocr: { enabled: false }, credential_scanner: { enabled: true } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const options = {
    launchctl, drive: connector, getAccessToken: async () => "token",
    resolveBaseUrl: async () => "https://owner.invalid", resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state, saveState() {} }),
    verifyDriveIncrementalWorker: async () => {}, readDriveFamily: async () => true,
    readCurrentIngestParts: async ({ envelopes, proof }) => ({ parts: envelopes || proof.parts,
      database: { instance: "1".repeat(32), nonce: "2".repeat(32), generation: 1 } }),
    sendBatches: async ({ groups, onResult }) => {
      const tally = { created: 0, updated: 0, unchanged: 0, refused: 0, failed: 0 };
      for (const item of groups.flat()) { sent.push(item.envelope.source_id); tally.created++; onResult?.(item, { status: "created" }); }
      return tally;
    },
    listStoredSourceFamilies: async () => { throw new Error("corpus inventory reached"); },
    listOwnerRemovedFamilies: async ({ uids }) => { asked.push([...uids]); return new Set(uids.filter((uid) => removed.has(uid))); },
    applyDriveRemovals: async () => { throw new Error("automatic removal reached"); },
    reconcileDocumentFamilies: async () => {},
    postSourceReceipt: async () => {}, driveNow: () => Date.parse(stamp), write: () => {},
  };
  return { state, downloads, sent, asked, run: () => cmdIngestRemote(manifest, manifestPath, { from: "drive" }, options) };
}

test("Drive: a removed file that changes again is never downloaded or sent; the others load", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error("unexpected network attempt"); };
    try {
      const h = driveHarness({ removed: new Set(["drive:fileB"]) });
      await h.run();
      assert.deepEqual([...h.sent].sort(), ["fileA", "fileC"], "only the files the owner kept");
      assert.equal(h.downloads.includes("fileB"), false, "the removed file's bytes were never fetched");
      assert.match(h.state.skipped["drive:fileB"], /OWNER_REMOVED/);
      assert.ok(h.asked.flat().includes("drive:fileB"));
      // Control: with nothing remembered, the same run loads all three.
      const control = driveHarness({});
      await control.run();
      assert.deepEqual([...control.sent].sort(), ["fileA", "fileB", "fileC"]);
    } finally { globalThis.fetch = realFetch; }
  });
