import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProvenanceRepairIncompleteError,
  buildProvenanceRepairPlan,
  cmdProvenanceRepair,
  collectSourceRecoveryPages,
  inspectProvenanceRepairReadiness,
  runCliCommandWithCredentialBoundary,
} from "../brain.mjs";
import { inspectGoogleTokenStorage, saveTokens } from "../connectors/google-auth.mjs";
import { DriveRemovalReviewRequired } from "../operations/drive-removal-plan.mjs";
import {
  provenanceRepairPlan,
  provenanceRepairReadback,
  provenanceRepairRemoteGeneration,
} from "../operations/provenance-repair.mjs";

const AS_OF = "2026-09-10T12:00:00.000Z";
const LATER = "2026-09-10T12:05:00.000Z";
const SOURCE_SNAPSHOT = `sha256:${"a".repeat(64)}`;
const RECOVERY_SNAPSHOT = `sha256:${"b".repeat(64)}`;
const CANDIDATE_A = `hmac-sha256:${"c".repeat(64)}`;
const CANDIDATE_B = `hmac-sha256:${"d".repeat(64)}`;
const MANIFEST_HASH = "1".repeat(64);
const CONFIG_HASH = "2".repeat(64);

function sourceRow(candidateCount = 1, receipt = null) {
  return {
    source_id: "drive",
    name: "drive",
    kind: "drive",
    registered: true,
    zone: null,
    connector: { kind: "drive", provider: "google", provider_identity_status: "supported" },
    configuration: { status: "complete" },
    storage: { physical_documents: candidateCount, logical_documents: candidateCount },
    readability: { status: candidateCount ? "partial" : "complete" },
    provenance: { status: candidateCount ? "partial" : "complete" },
    recovery_plan: { status: candidateCount ? "review_needed" : "no_candidates", candidate_documents: candidateCount },
    receipt: receipt || {
      status: "ready",
      complete_history_through: "2026-09-09T10:02:00.000Z",
      latest_run: {
        lane: "sweep",
        started_at: "2026-09-09T10:00:00.000Z",
        finished_at: "2026-09-09T10:02:00.000Z",
        walk_complete: true,
        docs_refused: 0,
        docs_failed: 0,
        outcome: "completed",
      },
    },
    freshness: { state: "ok" },
  };
}

function inventory({ asOf = AS_OF, snapshot = SOURCE_SNAPSHOT, candidateCount = 1, receipt = null } = {}) {
  return {
    contract_version: 2,
    kind: "source_inventory",
    complete: true,
    total: 1,
    returned: 1,
    truncated: false,
    cursor: null,
    as_of: asOf,
    snapshot: { id: snapshot, as_of: asOf, stable: true, total: 1 },
    sources: [sourceRow(candidateCount, receipt)],
    recovery_plan_summary: { candidate_documents: candidateCount },
    limitations: { entity_year_coverage: "not_available" },
  };
}

function candidate(recordId = CANDIDATE_A, reasons = ["derivation_lineage_missing"]) {
  return {
    record_id: recordId,
    locator: { kind: "opaque_document_digest", value: recordId, reversible: false },
    source_id: "drive",
    source_kind: "drive",
    registered: true,
    zone: null,
    ingested_at: "2026-09-01T00:00:00.000Z",
    text: { extraction_method: "native", content_state: "readable" },
    ocr: { likely_candidate: false },
    provenance: { status: "partial", missing_subfields: ["derivation_lineage"] },
    reasons,
    plan: { mode: "preview_only", suggested_next_step: "rewalk_source" },
  };
}

function recovery({
  asOf = AS_OF,
  snapshot = RECOVERY_SNAPSHOT,
  candidates = [candidate()],
  page = { limit: 250, returned: candidates.length, truncated: false },
  cursor = null,
  truncated = false,
} = {}) {
  return {
    contract_version: 2,
    kind: "source_recovery_plan",
    complete: !truncated,
    total: candidates.length,
    returned: candidates.length,
    truncated,
    cursor,
    as_of: asOf,
    snapshot: {
      id: snapshot,
      as_of: asOf,
      stable: true,
      total: candidates.length,
      basis: "corpus_mutation_receipt",
    },
    source_filter: "drive",
    recovery_plan_summary: {
      status: candidates.length ? "review_needed" : "no_candidates",
      candidate_documents: candidates.length,
      candidate_source_groups: candidates.length ? 1 : 0,
      reason_counts: { derivation_lineage_missing: candidates.length },
      page,
    },
    candidates,
    limitations: { read_only: true, repair_performed: false, ocr_performed: false },
  };
}

function state(options = {}) {
  const recoveryReceipt = recovery(options);
  return {
    inventory: inventory({
      asOf: options.asOf,
      snapshot: options.inventorySnapshot,
      candidateCount: recoveryReceipt.total,
      receipt: options.receipt,
    }),
    recovery: recoveryReceipt,
  };
}

const readiness = () => ({
  sourceConfigFingerprint: CONFIG_HASH,
  readiness: {
    source: "ready",
    credential: "readable saved Google connection with drive scope",
    scheduler: "not loaded",
    scheduler_state: { applicable: true, installed: true, loaded: false, running: false },
    blockers: [],
  },
});

function withManifest(run) {
  const directory = mkdtempSync(join(tmpdir(), "brain-provenance-repair-"));
  const manifest = join(directory, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    brain: { domain: "brain.example.invalid" },
    corpora: { google_drive: { enabled: true, root_folder_ids: ["opaque-reviewed-root"] } },
    safety: { ocr: { enabled: false } },
  }));
  return Promise.resolve().then(() => run(manifest)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

async function captureLogs(run) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    return { value: await run(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

test("semantic remote generation ignores only observation time and binds source and candidate evidence", () => {
  const first = provenanceRepairRemoteGeneration({ ...state(), sourceId: "drive" });
  const timeOnly = provenanceRepairRemoteGeneration({
    ...state({
      asOf: LATER,
      inventorySnapshot: `sha256:${"e".repeat(64)}`,
      snapshot: `sha256:${"f".repeat(64)}`,
    }),
    sourceId: "drive",
  });
  assert.equal(first.inventory_generation, timeOnly.inventory_generation);
  assert.equal(first.recovery_generation, timeOnly.recovery_generation);
  assert.notEqual(first.observations.source_inventory.snapshot_id, timeOnly.observations.source_inventory.snapshot_id);

  const reasonChanged = provenanceRepairRemoteGeneration({
    inventory: inventory(),
    recovery: recovery({ candidates: [candidate(CANDIDATE_A, ["text_reliability_missing"])] }),
    sourceId: "drive",
  });
  assert.notEqual(first.recovery_generation, reasonChanged.recovery_generation);

  const rowChangedReceipt = structuredClone(state());
  rowChangedReceipt.inventory.sources[0].storage.physical_documents = 2;
  const rowChanged = provenanceRepairRemoteGeneration({ ...rowChangedReceipt, sourceId: "drive" });
  assert.notEqual(first.inventory_generation, rowChanged.inventory_generation);

  const countChanged = provenanceRepairRemoteGeneration({
    inventory: inventory({ candidateCount: 2 }),
    recovery: recovery({ candidates: [candidate(), candidate(CANDIDATE_B)] }),
    sourceId: "drive",
  });
  assert.notEqual(first.candidate_set_hash, countChanged.candidate_set_hash);
  assert.equal(countChanged.candidate_count, 2);
});

test("approval ID binds selection, config, full reset/no-limit mode, OCR, and exact candidate IDs", () => {
  const remote = provenanceRepairRemoteGeneration({ ...state(), sourceId: "drive" });
  const input = {
    productVersion: "0.4.6",
    manifestFingerprint: MANIFEST_HASH,
    sourceConfigFingerprint: CONFIG_HASH,
    source: { id: "drive", kind: "drive" },
    remote,
    readiness: readiness().readiness,
    rewalk: { scope: "whole_source", mode: "full_rewalk_reingest", reset: true, limit: null },
    ocr: { applies: true, enabled: false, model: "fixture", max_pages_per_document: 40, detail: "off" },
  };
  const plan = provenanceRepairPlan(input);
  assert.equal(plan.can_apply, true);
  assert.deepEqual(plan.expected_candidates.ids, [CANDIDATE_A]);
  assert.notEqual(provenanceRepairPlan({ ...input, sourceConfigFingerprint: "3".repeat(64) }).plan_id, plan.plan_id);
  assert.notEqual(provenanceRepairPlan({ ...input, source: { id: "other", kind: "drive" } }).plan_id, plan.plan_id);
  assert.notEqual(provenanceRepairPlan({ ...input, ocr: { ...input.ocr, enabled: true } }).plan_id, plan.plan_id);
  assert.throws(
    () => provenanceRepairPlan({ ...input, rewalk: { ...input.rewalk, limit: 1 } }),
    /no-limit whole-source rewalk/,
  );
});

test("recovery pagination collects one exact source snapshot and rejects duplicates", async () => {
  const first = recovery({ candidates: [candidate()], truncated: true, cursor: "next" });
  first.total = 2;
  first.snapshot.total = 2;
  first.recovery_plan_summary.candidate_documents = 2;
  first.recovery_plan_summary.page = { limit: 1, returned: 1, truncated: true };
  const second = recovery({ candidates: [candidate(CANDIDATE_B)] });
  second.total = 2;
  second.snapshot.total = 2;
  second.recovery_plan_summary.candidate_documents = 2;
  second.recovery_plan_summary.reason_counts.derivation_lineage_missing = 2;
  first.recovery_plan_summary.reason_counts.derivation_lineage_missing = 2;
  second.recovery_plan_summary.page = { limit: 1, returned: 1, truncated: false };
  const bodies = [];
  const collected = await collectSourceRecoveryPages(async (body) => {
    bodies.push(body);
    return new Response(JSON.stringify(body.cursor ? second : first), { status: 200 });
  }, { source: "drive", limit: 1 });
  assert.deepEqual(bodies, [
    { mode: "recovery", source: "drive", limit: 1 },
    { mode: "recovery", source: "drive", limit: 1, cursor: "next" },
  ]);
  assert.deepEqual(collected.candidates.map((item) => item.record_id), [CANDIDATE_A, CANDIDATE_B]);

  const duplicateSecond = structuredClone(second);
  duplicateSecond.candidates = [candidate()];
  await assert.rejects(
    collectSourceRecoveryPages(async (body) =>
      new Response(JSON.stringify(body.cursor ? duplicateSecond : first), { status: 200 }),
    { source: "drive", limit: 1 }),
    /duplicate source-recovery candidate/,
  );
});

test("preview is read-only and apply recomputes, runs exact whole-source reset, and proves readback", async () => {
  await withManifest(async (manifest) => {
    let rewalkCalls = 0;
    const previewState = state();
    const preview = await buildProvenanceRepairPlan(manifest, "drive", {
      readRemoteState: async () => previewState,
      inspectReadiness: readiness,
    });

    const applyStates = [
      state({
        asOf: LATER,
        inventorySnapshot: `sha256:${"7".repeat(64)}`,
        snapshot: `sha256:${"8".repeat(64)}`,
      }),
      state({
        asOf: "2026-09-10T12:10:00.000Z",
        inventorySnapshot: `sha256:${"9".repeat(64)}`,
        snapshot: `sha256:${"0".repeat(64)}`,
        candidates: [],
        receipt: {
          status: "ready",
          complete_history_through: "2026-09-10T12:09:00.000Z",
          latest_run: {
            lane: "sweep",
            started_at: "2026-09-10T12:06:00.000Z",
            finished_at: "2026-09-10T12:09:00.000Z",
            walk_complete: true,
            docs_refused: 0,
            docs_failed: 0,
            outcome: "completed",
          },
        },
      }),
    ];
    const result = await cmdProvenanceRepair(manifest, {
      flags: { source: "drive", apply: true, approve: preview.plan_id },
      readRemoteState: async () => applyStates.shift(),
      inspectReadiness: readiness,
      async runSourceRewalk(args) {
        rewalkCalls++;
        assert.equal(args.source.id, "drive");
        assert.equal(args.source.kind, "drive");
        assert.equal(args.reset, true);
        assert.equal(args.limit, null);
        assert.equal(args.removalApproval, null);
        return { created: 0, updated: 1, unchanged: 0, refused: 0, scanned: 1, skipped: 0 };
      },
    });
    assert.equal(rewalkCalls, 1);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.fixed_candidate_ids, [CANDIDATE_A]);
    assert.equal(result.source_receipt.latest_run.outcome, "completed");
  });
});

test("stale approval and removal review both fail closed before claiming a fixed candidate", async () => {
  await withManifest(async (manifest) => {
    const approved = await buildProvenanceRepairPlan(manifest, "drive", {
      readRemoteState: async () => state(),
      inspectReadiness: readiness,
    });
    let runs = 0;
    await assert.rejects(
      cmdProvenanceRepair(manifest, {
        flags: { source: "drive", apply: true, approve: approved.plan_id },
        readRemoteState: async () => ({
          inventory: inventory(),
          recovery: recovery({ candidates: [candidate(CANDIDATE_A, ["text_reliability_missing"])] }),
        }),
        inspectReadiness: readiness,
        runSourceRewalk: async () => { runs++; },
      }),
      /missing, stale, or different/,
    );
    assert.equal(runs, 0);

    await assert.rejects(
      cmdProvenanceRepair(manifest, {
        flags: { source: "drive", apply: true, approve: approved.plan_id },
        readRemoteState: async () => state(),
        inspectReadiness: readiness,
        runSourceRewalk: async () => {
          throw new DriveRemovalReviewRequired("review then --approve-removals " + "4".repeat(64));
        },
      }),
      (error) => error instanceof ProvenanceRepairIncompleteError &&
        error.receipt?.status === "safety_review_required" &&
        error.receipt.fixed_candidate_ids.length === 0 &&
        /no provenance-repair success is claimed/i.test(error.message),
    );
  });
});

test("readback reports only actually absent candidates and withholds every claim without a new full-sweep receipt", () => {
  const before = provenanceRepairRemoteGeneration({
    inventory: inventory({ candidateCount: 2 }),
    recovery: recovery({ candidates: [candidate(), candidate(CANDIDATE_B)] }),
    sourceId: "drive",
  });
  const goodReceipt = {
    status: "ready",
    complete_history_through: "2026-09-10T12:09:00.000Z",
    latest_run: {
      lane: "sweep",
      started_at: "2026-09-10T12:06:00.000Z",
      finished_at: "2026-09-10T12:09:00.000Z",
      walk_complete: true,
      docs_refused: 0,
      docs_failed: 0,
      outcome: "completed",
    },
  };
  const after = provenanceRepairRemoteGeneration({
    inventory: inventory({ candidateCount: 1, receipt: goodReceipt }),
    recovery: recovery({ candidates: [candidate(CANDIDATE_B)] }),
    sourceId: "drive",
  });
  const partial = provenanceRepairReadback({ before, after });
  assert.equal(partial.status, "partial");
  assert.deepEqual(partial.fixed_candidate_ids, [CANDIDATE_A]);
  assert.deepEqual(partial.remaining_candidate_ids, [CANDIDATE_B]);

  const unverifiedAfter = structuredClone(after);
  unverifiedAfter.source.receipt.latest_run.docs_failed = 1;
  const unverified = provenanceRepairReadback({ before, after: unverifiedAfter });
  assert.equal(unverified.status, "unverified");
  assert.deepEqual(unverified.fixed_candidate_ids, []);
  assert.equal(unverified.remaining_count, null);
});

test("provenance repair bypasses Wrangler custody but leaves other commands wrapped", async () => {
  let repairRan = 0;
  let wrappers = 0;
  await runCliCommandWithCredentialBoundary("provenance-repair", async () => { repairRan++; }, {
    withWranglerSession: async () => { wrappers++; },
  });
  assert.equal(repairRan, 1);
  assert.equal(wrappers, 0);
  await runCliCommandWithCredentialBoundary("status", async () => {}, {
    withWranglerSession: async (run) => { wrappers++; return run(); },
  });
  assert.equal(wrappers, 1);
});

test("read-only Google readiness accepts an installed-app token with no client secret and exposes no OAuth value", () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-google-readiness-"));
  const path = join(directory, "google.json");
  // Use the host's real storage semantics. A Linux override on Windows would
  // ask NTFS to prove POSIX mode bits instead of exercising DPAPI and its ACL.
  const options = { backend: "file", path };
  const refreshToken = "fixture-refresh-value-never-returned";
  try {
    saveTokens({
      google: {
        client_id: "fixture-installed-app",
        client_secret: null,
        refresh_token: refreshToken,
        scopes: ["drive"],
      },
    }, options);
    const before = Buffer.from(readFileSync(path));
    const result = inspectGoogleTokenStorage(options);
    const after = Buffer.from(readFileSync(path));
    assert.equal(result.readable, true);
    assert.equal(result.connected, true);
    assert.deepEqual(result.scopes, ["drive"]);
    assert.match(result.record_fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(refreshToken));
    assert.deepEqual(after, before, "readiness inspection must not rewrite the credential store");
    saveTokens({
      google: {
        client_id: "fixture-installed-app",
        client_secret: null,
        refresh_token: "replacement-refresh-value",
        scopes: ["drive"],
      },
    }, options);
    const replacement = inspectGoogleTokenStorage(options);
    assert.notEqual(replacement.record_fingerprint, result.record_fingerprint);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduler readiness blocks a loaded macOS writer and names unsupported non-macOS scheduling without probing it", async () => {
  await withManifest(async (manifestPath) => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const credential = () => ({
      checked: true,
      readable: true,
      connected: true,
      backend: "fixture",
      scopes: ["drive"],
      record_fingerprint: "5".repeat(64),
    });
    const mac = await inspectProvenanceRepairReadiness({
      m,
      manifestPath,
      source: "drive",
      kind: "drive",
      options: {
        platform: "darwin",
        inspectGoogleCredential: credential,
        readSchedulerStatus: () => ({
          installed: true,
          loaded: true,
          running: false,
          definitionMatches: true,
          interpreterPresent: true,
          scheduleError: null,
        }),
      },
    });
    assert.match(mac.readiness.blockers.join(" "), /scheduler is loaded or running and could contend/);
    assert.equal(mac.readiness.scheduler_state.loaded, true);

    const running = await inspectProvenanceRepairReadiness({
      m,
      manifestPath,
      source: "drive",
      kind: "drive",
      options: {
        platform: "darwin",
        inspectGoogleCredential: credential,
        readSchedulerStatus: () => ({
          installed: true,
          loaded: false,
          running: true,
          definitionMatches: true,
          interpreterPresent: true,
          scheduleError: null,
        }),
      },
    });
    assert.match(running.readiness.blockers.join(" "), /scheduler is loaded or running and could contend/);

    let schedulerReads = 0;
    const linux = await inspectProvenanceRepairReadiness({
      m,
      manifestPath,
      source: "drive",
      kind: "drive",
      options: {
        platform: "linux",
        inspectGoogleCredential: credential,
        readSchedulerStatus: () => { schedulerReads++; throw new Error("must not be called"); },
      },
    });
    assert.equal(schedulerReads, 0);
    assert.equal(linux.readiness.scheduler_state.applicable, false);
    assert.match(linux.readiness.scheduler_state.reason, /no supported unattended scheduler/);
    assert.equal(linux.readiness.blockers.length, 0);
  });
});

test("readiness receipts never expose a local path or credential-inspection detail", async () => {
  const directory = mkdtempSync(join(tmpdir(), "brain-provenance-privacy-"));
  const privateMarker = "owner-private-path-marker";
  const manifestPath = join(directory, "brain.manifest.json");
  try {
    const upload = await inspectProvenanceRepairReadiness({
      m: {
        corpora: {
          local_folder: {
            enabled: true,
            source: "documents",
            path: join(directory, privateMarker, "missing"),
          },
        },
      },
      manifestPath,
      source: "documents",
      kind: "upload",
      options: { platform: "linux" },
    });
    assert.doesNotMatch(JSON.stringify(upload), new RegExp(privateMarker));
    assert.match(upload.readiness.blockers.join(" "), /not safely readable/);

    const credentialMarker = "keychain-private-detail-marker";
    const drive = await inspectProvenanceRepairReadiness({
      m: {
        corpora: { google_drive: { enabled: true, root_folder_ids: ["reviewed-root"] } },
      },
      manifestPath,
      source: "drive",
      kind: "drive",
      options: {
        platform: "linux",
        inspectGoogleCredential: () => ({
          checked: true,
          readable: false,
          connected: false,
          backend: "keychain",
          scopes: [],
          reason: `${credentialMarker}: ${join(directory, "secret")}`,
        }),
      },
    });
    assert.doesNotMatch(JSON.stringify(drive), new RegExp(credentialMarker));
    assert.doesNotMatch(JSON.stringify(drive), new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(drive.readiness.blockers.join(" "), /credential cannot be read/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconnecting a different Google credential invalidates the approved plan even when scopes match", async () => {
  await withManifest(async (manifestPath) => {
    const m = JSON.parse(readFileSync(manifestPath, "utf8"));
    const inspect = async (recordFingerprint) => inspectProvenanceRepairReadiness({
      m,
      manifestPath,
      source: "drive",
      kind: "drive",
      options: {
        platform: "linux",
        inspectGoogleCredential: () => ({
          checked: true,
          readable: true,
          connected: true,
          backend: "fixture",
          scopes: ["drive"],
          record_fingerprint: recordFingerprint,
        }),
      },
    });
    const firstLocal = await inspect("6".repeat(64));
    const replacementLocal = await inspect("7".repeat(64));
    assert.notEqual(firstLocal.sourceConfigFingerprint, replacementLocal.sourceConfigFingerprint);

    const remote = provenanceRepairRemoteGeneration({ ...state(), sourceId: "drive" });
    const common = {
      productVersion: "0.4.6",
      manifestFingerprint: MANIFEST_HASH,
      source: { id: "drive", kind: "drive" },
      remote,
      readiness: firstLocal.readiness,
      rewalk: { scope: "whole_source", mode: "full_rewalk_reingest", reset: true, limit: null },
      ocr: { applies: true, enabled: false, detail: "off" },
    };
    const approved = provenanceRepairPlan({
      ...common,
      sourceConfigFingerprint: firstLocal.sourceConfigFingerprint,
    });
    const afterReconnect = provenanceRepairPlan({
      ...common,
      sourceConfigFingerprint: replacementLocal.sourceConfigFingerprint,
    });
    assert.notEqual(approved.plan_id, afterReconnect.plan_id);
  });
});
