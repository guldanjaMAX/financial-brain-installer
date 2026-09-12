import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildNpmCliInvocation,
  resolveNpmCliPath,
} from "../operations/npm-cli-runtime.mjs";

import {
  provenanceTargetDependencies,
  provenanceTargetRuntimePackageFiles,
  provenanceTargetRuntimePackageFingerprint,
} from "../brain.mjs";

const SOURCE = "client_docs";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const HISTORY_SNAPSHOT = `sha256:${"b".repeat(64)}`;

function jsonResponse(body, { status = 200, onText = () => {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      onText();
      return JSON.stringify(body);
    },
  };
}

function sourceRow(source, kind = "upload") {
  return {
    source_id: source,
    name: source,
    kind,
    registered: true,
    zone: null,
    connector: { kind, provider: "local", provider_identity_status: "supported" },
    configuration: { status: "complete" },
    storage: { physical_documents: 1, logical_documents: 1 },
    readability: { status: "complete" },
    provenance: { status: "complete" },
    recovery_plan: { status: "no_candidates", candidate_documents: 0 },
    receipt: { status: "ready", complete_history_through: "2026-09-11T12:00:00.000Z" },
    last_failure: null,
    freshness: { state: "ok" },
  };
}

function sourcePage({ sources, cursor = null, truncated = false }) {
  const asOf = "2026-09-11T12:00:00.000Z";
  return {
    contract_version: 3,
    kind: "source_inventory",
    complete: !truncated,
    total: 2,
    returned: sources.length,
    truncated,
    cursor,
    as_of: asOf,
    snapshot: { id: SNAPSHOT, as_of: asOf, stable: true, total: 2 },
    sources,
    recovery_plan_summary: { candidate_documents: 0 },
    limitations: [],
  };
}

function observation(sequence) {
  return {
    sequence,
    source: SOURCE,
    original_id: `hmac-sha256:${String(sequence).repeat(64)}`,
    observation_hash: `sha256:${String(sequence + 2).repeat(64)}`,
    outcome: "gap",
  };
}

function activeHealth() {
  return {
    ok: true,
    status: "ok",
    accepting_documents: true,
    version: VERSION,
    schema_version: 46,
    vector_writer_protocol: "lease-v1",
    vector_drain_mode: "active",
  };
}

function readyDocuments() {
  return {
    version: VERSION,
    backend: "d1",
    rows: [],
    vector_drain_mode: "active",
    vector_backlog: { pending: 0, upserts: 0, deletes: 0, submitted: 0 },
    vector_readiness: {
      ready: true,
      expected_vectors: 2,
      actual_vectors: 2,
      pending: 0,
      submitted: 0,
      projection_status: "verified",
    },
  };
}

function adapterHarness() {
  const state = {
    held: false,
    assertedSinceIo: false,
    released: 0,
    events: [],
    inventoryPayloads: [],
    observationPayloads: [],
    batches: [],
    reconciliations: [],
    proofRequests: [],
  };
  const assertOwned = () => {
    assert.equal(state.held, true, "ownership was checked without a held source lease");
    state.assertedSinceIo = true;
    state.events.push("lease.assert");
    return true;
  };
  const guardedIo = (name) => {
    assert.equal(state.held, true, `${name} ran without the source lease`);
    assert.equal(state.assertedSinceIo, true, `${name} ran without a fresh ownership check`);
    state.assertedSinceIo = false;
    state.events.push(name);
  };
  const inventoryPages = [
    sourcePage({
      sources: [sourceRow("archive")],
      cursor: "inventory-page-2",
      truncated: true,
    }),
    sourcePage({ sources: [sourceRow(SOURCE)] }),
  ];

  const managedSourceRequest = async (url, init = {}) => {
    guardedIo(`network:${new URL(url).pathname}`);
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === "/api/admin/brain/documents") {
      return jsonResponse(readyDocuments(), { onText: () => guardedIo("body:documents") });
    }
    if (path === "/api/admin/brain/drain") {
      return jsonResponse({
        drained: 1,
        submitted: 1,
        waiting: 0,
        remaining: 0,
        vector_ready: true,
        expected_vectors: 2,
        actual_vectors: 2,
      }, { onText: () => guardedIo("body:drain") });
    }
    if (path === "/api/admin/brain/source-original-observations") {
      if (body?.mode === "inventory") {
        state.observationPayloads.push(body);
        const first = body.after_sequence === undefined;
        return jsonResponse(first ? {
          contract_version: 1,
          mode: "inventory",
          source: SOURCE,
          snapshot_id: HISTORY_SNAPSHOT,
          returned: 1,
          total: 2,
          observations: [observation(1)],
          page_complete: false,
          next_after_sequence: 1,
          scope: { whole_source_complete: false },
        } : {
          contract_version: 1,
          mode: "inventory",
          source: SOURCE,
          snapshot_id: HISTORY_SNAPSHOT,
          returned: 1,
          total: 2,
          observations: [observation(2)],
          page_complete: true,
          next_after_sequence: null,
          scope: { whole_source_complete: false },
        }, { onText: () => guardedIo("body:observations") });
      }
      state.proofRequests.push(body);
      return jsonResponse({ accepted: true }, { onText: () => guardedIo("body:proof") });
    }
    assert.fail(`unexpected managed request ${path}`);
  };

  const ingestRuntime = {
    localOriginalsForAssessment(root, options) {
      guardedIo("source:walk");
      assert.equal(root, "/synthetic/root");
      assert.deepEqual(options, {
        relativeLocators: ["records/report.txt"],
        privatePrefixes: ["private/"],
      });
      return {
        traversal_complete: true,
        target_resolution_complete: true,
        target_count: 1,
        originals: [{ _assessmentLocator: "records/report.txt" }],
      };
    },
    async prepare(original, options) {
      guardedIo("source:prepare");
      assert.equal(original._assessmentLocator, "records/report.txt");
      assert.deepEqual(options, { sourceName: SOURCE, ocr: null });
      return { envelope: { source_type: SOURCE, source_id: "records/report.txt" } };
    },
    batches(items) {
      return items.map((item) => [item]);
    },
  };

  const dependencies = provenanceTargetDependencies({
    acquireSourceIngestLock({ manifestPath, sourceName }) {
      assert.equal(manifestPath, "/synthetic/brain.manifest.json");
      assert.equal(sourceName, SOURCE);
      assert.equal(state.held, false);
      state.held = true;
      state.assertedSinceIo = false;
      state.events.push("lease.acquire");
      return {
        path: "/synthetic/lock",
        assertOwned,
        release() {
          assert.equal(state.held, true);
          state.held = false;
          state.assertedSinceIo = false;
          state.released += 1;
          state.events.push("lease.release");
          return true;
        },
      };
    },
    runtimeFingerprint() {
      guardedIo("runtime:fingerprint");
      return "c".repeat(64);
    },
    sourceInventoryAccess(manifestPath, manifest) {
      guardedIo("admin:resolve");
      assert.equal(manifestPath, "/synthetic/brain.manifest.json");
      assert.equal(manifest.brain.domain, "brain.example.invalid");
      return {
        base: "https://brain.example.invalid",
        managedSourceRequest,
        async requestPage(payload) {
          guardedIo("network:source-inventory");
          state.inventoryPayloads.push(payload);
          const page = inventoryPages.shift();
          assert.ok(page, "source inventory requested too many pages");
          return jsonResponse(page, { onText: () => guardedIo("body:source-inventory") });
        },
        async requestBatch({ docs, assertOwned: requestAssertOwned }) {
          guardedIo("network:ingest");
          assert.equal(requestAssertOwned, assertOwned);
          state.batches.push(docs);
          return {
            res: { ok: true, status: 200 },
            raw: JSON.stringify({
              results: docs.map((doc) => ({
                source_type: doc.source_type,
                source_id: doc.source_id,
                status: "created",
              })),
            }),
          };
        },
        async reconcileFamilies({ families, assertOwned: requestAssertOwned }) {
          guardedIo("network:reconcile");
          assert.equal(requestAssertOwned, assertOwned);
          state.reconciliations.push(families);
          return 1;
        },
      };
    },
    async http(url) {
      guardedIo(`network:${new URL(url).pathname}`);
      assert.equal(new URL(url).pathname, "/health");
      return jsonResponse(activeHealth(), { onText: () => guardedIo("body:health") });
    },
    ingestLib: async () => {
      guardedIo("runtime:ingest-library");
      return ingestRuntime;
    },
    sleep: async () => {
      guardedIo("clock:sleep");
    },
  });
  return { state, dependencies, assertOwned };
}

test("real Brain adapter keeps admin state opaque and lease-guards complete exact-target IO", async () => {
  const { state, dependencies, assertOwned } = adapterHarness();
  const lease = dependencies.acquireSourceLease({
    manifestPath: "/synthetic/brain.manifest.json",
    source: SOURCE,
  });
  assert.match(lease.fingerprint, /^[a-f0-9]{64}$/);
  await lease.assertOwned();

  const runtime = await dependencies.verifyCandidateRuntime({
    productVersion: VERSION,
    candidateRuntimePackageFingerprint: "c".repeat(64),
    assertOwned,
  });
  assert.deepEqual(runtime, {
    verified: true,
    product_version: VERSION,
    package_fingerprint: "c".repeat(64),
  });

  const adminAccess = await dependencies.resolveDurableAdminAccess({
    manifestPath: "/synthetic/brain.manifest.json",
    manifest: { brain: { domain: "brain.example.invalid" } },
    assertOwned,
  });
  assert.deepEqual(adminAccess, { kind: "durable_owner_admin_capability" });
  assert.equal(JSON.stringify(adminAccess).includes("key"), false);
  await assert.rejects(
    () => dependencies.readVectorReadiness({ adminAccess, assertOwned }),
    /cannot precede its public generation binding/,
  );

  const health = await dependencies.readWorkerHealth({ adminAccess, assertOwned });
  assert.deepEqual(health, {
    ok: true,
    active: true,
    accepting_documents: true,
    product_version: VERSION,
    schema_version: 46,
  });
  assert.equal((await dependencies.readVectorReadiness({ adminAccess, assertOwned })).ready, true);

  const inventory = await dependencies.readSourceInventory({
    source: SOURCE,
    adminAccess,
    assertOwned,
  });
  assert.deepEqual(inventory.sources.map((row) => row.source_id), ["archive", SOURCE]);
  assert.deepEqual(state.inventoryPayloads, [
    { limit: 250 },
    { limit: 250, cursor: "inventory-page-2" },
  ]);

  const history = await dependencies.readObservationInventory({
    source: SOURCE,
    adminAccess,
    assertOwned,
  });
  assert.deepEqual(history.observations.map((row) => row.sequence), [1, 2]);
  assert.deepEqual(state.observationPayloads, [
    { contract_version: 1, mode: "inventory", source: SOURCE, limit: 10 },
    {
      contract_version: 1,
      mode: "inventory",
      source: SOURCE,
      limit: 10,
      after_sequence: 1,
      snapshot_id: HISTORY_SNAPSHOT,
    },
  ]);

  const prepared = await dependencies.prepareOriginal({
    root: "/synthetic/root",
    locator: "records/report.txt",
    sourceName: SOURCE,
    privatePrefixes: ["private/"],
    ocr: null,
    allowStructuralSplit: true,
    assertOwned,
  });
  assert.equal(prepared.envelope.source_id, "records/report.txt");

  const envelopes = [
    { source_type: SOURCE, source_id: "records/report.txt#part1of2" },
    { source_type: SOURCE, source_id: "records/report.txt#part2of2" },
  ];
  const ingest = await dependencies.ingestPrepared({ envelopes, adminAccess, assertOwned });
  assert.equal(ingest.created, 2);
  assert.deepEqual(state.batches, [[envelopes[0]], [envelopes[1]]]);

  const family = {
    scope: "exact_structural_family",
    source: SOURCE,
    base_doc_uid: `${SOURCE}:records/report.txt`,
    keep_doc_uids: envelopes.map((item) => `${item.source_type}:${item.source_id}`),
  };
  const reconciliation = await dependencies.reconcileFamily({
    family,
    adminAccess,
    assertOwned,
  });
  assert.equal(reconciliation.removed_count, 1);
  assert.deepEqual(state.reconciliations, [[{
    base_doc_uid: family.base_doc_uid,
    keep_doc_uids: family.keep_doc_uids,
  }]]);

  const drained = await dependencies.drainVectorOutbox({
    scope: "global",
    adminAccess,
    assertOwned,
  });
  assert.equal(drained.complete, true);
  assert.equal(drained.readiness.actual_vectors, 2);

  const proofRequest = { contract_version: 1, mode: "seal", source: SOURCE };
  assert.deepEqual(await dependencies.sealTargets({
    request: proofRequest,
    adminAccess,
    assertOwned,
  }), { accepted: true });
  assert.deepEqual(state.proofRequests, [proofRequest]);

  lease.release();
  assert.equal(state.released, 1);
  assert.equal(state.held, false);
  assert.equal(state.events[0], "lease.acquire");
  assert.equal(state.events.at(-1), "lease.release");
});

test("real Brain adapter refuses widened target, OCR, family, drain, and generation boundaries", async () => {
  const { dependencies, assertOwned } = adapterHarness();
  const lease = dependencies.acquireSourceLease({
    manifestPath: "/synthetic/brain.manifest.json",
    source: SOURCE,
  });
  const adminAccess = await dependencies.resolveDurableAdminAccess({
    manifestPath: "/synthetic/brain.manifest.json",
    manifest: { brain: { domain: "brain.example.invalid" } },
    assertOwned,
  });
  await assert.rejects(
    () => dependencies.prepareOriginal({
      root: "/synthetic/root",
      locator: "records/report.txt",
      sourceName: SOURCE,
      privatePrefixes: [],
      ocr: { enabled: true },
      allowStructuralSplit: true,
      assertOwned,
    }),
    /preparation boundary is invalid/,
  );
  await assert.rejects(
    () => dependencies.reconcileFamily({
      family: { scope: "whole_source", keep_doc_uids: ["anything"] },
      adminAccess,
      assertOwned,
    }),
    /structural family plan is invalid/,
  );
  await assert.rejects(
    () => dependencies.drainVectorOutbox({
      scope: "target",
      adminAccess,
      assertOwned,
    }),
    /requires the global vector drain/,
  );
  lease.release();
});

test("runtime inventory exactly matches the local npm pack and rejects nested symlinks", (t) => {
  const npmCli = resolveNpmCliPath();
  const invocation = buildNpmCliInvocation(npmCli, [
    "pack", "--dry-run", "--json", "--ignore-scripts",
  ]);
  const packed = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    encoding: "utf8",
    shell: invocation.shell,
    timeout: 60_000,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const packFiles = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path).sort();
  const runtimeFiles = [...provenanceTargetRuntimePackageFiles({ root: ROOT })];
  assert.deepEqual(runtimeFiles, packFiles);
  assert.equal(runtimeFiles.includes("package-lock.json"), false);
  assert.equal(runtimeFiles.includes("operations/admin-key-persistence.mjs"), true);
  assert.equal(runtimeFiles.includes("ingest/pdf-child.mjs"), true);
  assert.equal(runtimeFiles.includes("node_modules/unpdf/package.json"), true);
  assert.match(provenanceTargetRuntimePackageFingerprint({ root: ROOT }), /^[a-f0-9]{64}$/);

  if (process.platform === "win32") return;
  const fixture = mkdtempSync(join(tmpdir(), "brain-runtime-inventory-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, "operations"));
  writeFileSync(join(fixture, "package.json"), JSON.stringify({
    files: ["brain.mjs", "operations/"],
    bundleDependencies: [],
  }));
  writeFileSync(join(fixture, "brain.mjs"), "export const brain = true;\n");
  writeFileSync(join(fixture, "outside.mjs"), "export const outside = true;\n");
  symlinkSync(join(fixture, "outside.mjs"), join(fixture, "operations", "linked.mjs"));
  assert.throws(
    () => provenanceTargetRuntimePackageFiles({ root: fixture }),
    /symbolic link/,
  );
});
