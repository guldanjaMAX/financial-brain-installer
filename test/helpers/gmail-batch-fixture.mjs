import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cmdIngestRemote, cmdLoad, describeLoadResult, credentialScannerFingerprint } from "../../brain.mjs";
import { gmailPolicyFingerprint } from "../../connectors/gmail.mjs";
import * as ingest from "../../ingest/run.mjs";
import { runDailyRefresh } from "../../operations/daily-refresh-run.mjs";
import { createHash } from "node:crypto";
import { chunkText } from "../../worker/src/lib/store.js";
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

export async function fixture(run, source = "gmail") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "gmail-batch-")));
  const manifestPath = join(root, "fixture.manifest.json");
  const statePath = join(root, `.brain-ingest-${source}.json`);
  const manifest = {
    corpora: { gmail: { enabled: true } },
    client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    safety: { credential_scanner: { enabled: true }, ocr: { enabled: false } },
  };
  const key = ["synthetic", "offline", "value"].join("-");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(root, ".brain-admin-key"), key, { mode: 0o600 });
  const launchctl = join(root,"launchctl-fixture");
  writeFileSync(launchctl,"#!/bin/sh\nexit 99\n",{mode:0o700});
  const scanner = credentialScannerFingerprint(true);
  ingest.saveState(statePath, {
    version: 1, done: {}, skipped: {}, history_id: "prior",
    credential_scanner_fingerprint: scanner,
    gmail_policy_fingerprint: gmailPolicyFingerprint({ credentialScannerFingerprint: scanner }),
  });
  const f = {
    // Real checkpoints remain on disk. Retaining every growing proof map is
    // quadratic memory; opt in only when a test actually inspects snapshots.
    captureSaves: false,
    ids: Array.from({ length: 101 }, (_, i) => `entry-${i}`), marker: "next", calls: [], sleeps: [], receipts: [],
    reads: [], saves: [], previews: 0, selectors: [], historyReads: 0, failBatch: 0, forgotten: 0, leases: 0, policyReads: [], stored: new Set(), remoteParts: new Map(),
    policy: () => ({ allowed: true }), content: null, lostLease: false,
    hasMore: false, previewFailure: false,
    respond: (docs) => {
      for (const doc of docs) f.stored.add(`${source}:${doc.source_id.split("#part")[0]}`);
      return json({ results: docs.map((doc) => ({ source_id: doc.source_id, status: "created", chunks: 1 })) });
    },
    manifest, setSince: value => { manifest.corpora.gmail.since = value; writeFileSync(manifestPath, JSON.stringify(manifest)); },
    state: () => JSON.parse(readFileSync(statePath, "utf8")),
    setState: (state) => ingest.saveState(statePath, state),
  };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  console.log = console.warn = (...args) => logs.push(args.join(" "));
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path === "/api/admin/brain/ingest/batch") {
      const docs = JSON.parse(options.body).docs;
      f.calls.push(docs.map((doc) => doc.source_id));
      globalThis.__gmailEntryIdentity = docs[0]?.source_id;
      if (f.calls.length === f.failBatch) return json({ error: "synthetic account interruption" }, 401);
      const response = await f.respond(docs);
      const {results} = await response.clone().json();
      for (const result of results || []) if (["created","updated","unchanged"].includes(result.status)) {
        const doc = docs.find(doc=>doc.source_id === result.source_id);
        if (doc) f.remoteParts.set(doc.source_id,doc);
      }
      return response;
    }
    if (path === "/api/admin/brain/ingest-part-proof") {
      if (f.partProof) return f.partProof(url,options);
      const {source,source_ids} = JSON.parse(options.body);
      (f.partProofCalls ||= []).push(source_ids);
      return json({source,database:{instance:"1".repeat(32),nonce:"2".repeat(32),generation:f.remoteParts.size},geometry:{size:1500,overlap:300},
        parts:source_ids.flatMap(id=> {
          const doc=f.remoteParts.get(id);
          return doc ? [{source_id:id,content_hash:createHash('sha256').update(`chunk-v1:1500:300\0${doc.content}`).digest('hex'),chunk_count:chunkText(doc.content).length}] : [];
        })});
    }
    if (path === "/api/admin/brain/documents") return json({ vector_backlog: { pending: 1 } });
    if (f.providerFetch) return f.providerFetch(url, options);
    f.forgotten++;
    throw new Error("unexpected fixture HTTP route");
  };
  f.once = async (flags = {}, loadOptions = null) => {
    logs.length = 0;
    let error = null;
    let result = null;
    try {
      const dependencies = {
        launchctl,
        paceSleep: async ms => { (f.paceSleeps ||= []).push(ms); },
        ...f.options,
        withSourceIngestLock: async (_options, task) => task({ assertOwned: () => {
          f.leases++;
          if (f.lostLease) throw Object.assign(new Error("fixture lease lost"), { code: "source_ingest_lock_lost" });
        } }),
        resolveBaseUrl: async () => "https://fixture.invalid",
        resolveAdminKey: () => key,
        getAccessToken: async () => { throw new Error("provider credential seam must not be used"); },
        gmailBatchNow: () => "2026-01-01T12:00:00.000Z",
        ingestRetrySleep: async (ms) => { f.sleeps.push(ms); f.onSleep?.(ms); },
        ingestLib: async () => ({ ...ingest, ...f.ingestOverrides, saveState: (path, state) => {
          f.beforeSave?.(state);
          if (f.captureSaves !== false) f.saves.push(structuredClone(state));
          ingest.saveState(path, state, f.stateSaveOptions);
        } }),
        gmail: {
          currentHistoryId: async () => { f.profileReads = (f.profileReads || 0) + 1; return f.marker; },
          listHistory: async (...args) => { f.historyReads++; return f.history ? f.history(...args) : { ids: f.ids, deletedIds: [], historyId: f.marker, hasMore: f.hasMore }; },
          listMessages: async function* () { f.fullLists = (f.fullLists || 0) + 1; yield* f.ids; },
          listMessagePage: async (...args) => { f.listPages = (f.listPages || 0) + 1; return f.messagePage ? f.messagePage(...args) : { ids: f.ids, nextPageToken: null }; },
          messagePolicy: async (_token, id) => { f.policyReads.push(id); return f.policy(id); },
          toEnvelope: async (_token, id) => {
            f.reads.push(id); f.onEnvelope?.(id);
            if (f.customEnvelope) return f.customEnvelope(id);
            return { version: "revision", envelope: {
              source_type: source, source_id: id, title: "Synthetic correspondence",
              content: (typeof f.content === "function" ? f.content(id) : f.content) || "Ordinary invented correspondence for the offline storage probe.",
            } };
          },
        },
        listStoredSourceFamilies: async (args) => {
          (f.inventoryCalls ||= []).push(args);
          return f.inventory ? f.inventory(args) : args.singlePage ? { families: f.stored, nextCursor: null } : new Set([...f.stored].filter(uid => !args.uids || args.uids.includes(uid)));
        },
        postSourceReceipt: async (_base, _key, receipt) => { f.receipts.push(receipt); return receipt; },
        removalPlanRuntime: () => "fixture-runtime",
        removalPlanRequest: async ({ body }) => {
          assert.equal(body.action, "preview");
          f.previews++; f.selectors.push(...body.families);
          if (f.previewFailure) throw new Error("synthetic removal preview interruption");
          return { marker: { instance: "fixture", nonce: "fixture", generation: 1, runtime: "fixture" }, targets: f.previewTargets || [], documents: f.previewTargets?.length || 0 };
        },
      };
      const ingestRemote = async (m, path, args, loadDeps = {}) => {
        const value = await cmdIngestRemote(m, path, args, { ...dependencies, deferGmailRemovals: loadDeps.deferGmailRemovals,
          ingestDeadlineAt: loadDeps.ingestDeadlineAt ?? f.options?.ingestDeadlineAt });
        f.loadLeg = describeLoadResult(value);
        return value;
      };
      result = loadOptions
        ? await cmdLoad(manifestPath, {
            flags, lifecycleLockHeld: true, probes: { gmail: () => ({ connected: true }) },
            commands: { ingestRemote }, ...loadOptions,
          })
        : await cmdIngestRemote(manifest, manifestPath, { from: "gmail", source, ...flags }, dependencies);
    } catch (caught) { error = caught; }
    return { error, result, output: logs.join("\n"), receipt: f.receipts.at(-1), state: f.state() };
  };
  try { await run(f); }
  finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    rmSync(root, { recursive: true, force: true });
  }
}

export async function dailyFixture(f, clock) {
  const plan = { ready: true, enabled: true, identity: { id: "fixture-r4" }, max_runtime_minutes: 1,
    sources: [{ key: "gmail", run_key: "gmail", source_names: ["gmail"], class: "machine-pull", owner: "daily-task", status: "ready" }] };
  return runDailyRefresh({ plan, now: () => new Date(clock.now),
    acquireLock: () => ({ assertOwned() {}, release() {} }),
    runSource: async (_source, lease) => {
      const run = await f.once({ only: "gmail" }, { deferGmailRemovals: true, allowPartialRefresh: true, ingestDeadlineAt: lease.deadlineAt });
      assert.equal(run.error, null); return run.result;
    }, readFreshness: async () => ({}), writeReceipt() {},
  });
}
