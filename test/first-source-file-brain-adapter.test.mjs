import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  classifyCliCredentialBoundary,
  cmdFirstSourceFile,
  firstSourceFileDependencies,
  pinFirstSourceManifest,
} from "../brain.mjs";
import {
  FirstSourceFileError,
  applyFirstSourceFile,
  parseFirstSourceFileArgv,
  previewFirstSourceFile,
} from "../operations/first-source-file.mjs";
import * as ingestRuntime from "../ingest/run.mjs";

const digest = (character) => character.repeat(64);
const source = "pilot_docs";
const file = "first-source.txt";
const privateText = "Synthetic uncommon reconciliation evidence for the exact same-item retrieval check.";
const RUNTIME_SHA256 = digest("a");
const RUNTIME_IDENTITY_SCHEME = "brain.runtime-payload.sha256.v1";

const architectureResult = Object.freeze({
  schema_version: 1,
  kind: "windows_native_architecture_gate",
  status: "verified",
  eligible: true,
  intended_architecture: "x64",
  probe_method: "runtime_information_os_architecture",
  native_windows_architecture: "x64",
  node_process_architecture: "x64",
  failure: null,
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "brain-first-source-adapter-"));
  const sourceRoot = join(root, "source");
  mkdirSync(sourceRoot);
  writeFileSync(join(sourceRoot, file), privateText, { mode: 0o600 });
  const manifest = join(root, "brain.manifest.json");
  writeFileSync(manifest, `${JSON.stringify({
    brain: { version: "0.4.8" },
    corpora: { local_folder: { enabled: true, path: sourceRoot, source } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }, null, 2)}\n`, { mode: 0o600 });
  return {
    root,
    sourceRoot,
    manifest,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function architectureLib(events = null) {
  return {
    probeWindowsNativeArchitecture: () => {
      events?.push("architecture");
      return architectureResult;
    },
    assertWindowsNativeArchitectureResult: (result) => {
      assert.deepEqual(result, architectureResult);
      return result;
    },
  };
}

function runtimeProof(runtime = RUNTIME_SHA256) {
  return Object.freeze({
    schema_version: 1,
    identity_scheme: RUNTIME_IDENTITY_SCHEME,
    runtime_payload_sha256: runtime,
    file_count: 12,
    total_bytes: 34_567,
    expected_runtime_sha256: runtime,
    verified_passes: 2,
  });
}

function runtimeOptions(overrides = {}) {
  return {
    runtimeRoot: "synthetic-runtime-root",
    runtimeAllowlist: ["package.json"],
    updatePreviewLib: {
      UPDATE_PREVIEW_SCHEMA_VERSION: 1,
      UPDATE_RUNTIME_IDENTITY_SCHEME: RUNTIME_IDENTITY_SCHEME,
      UPDATE_PREVIEW_LIMITS: { files: 20_000, total_bytes: 512 * 1024 * 1024 },
    },
    verifyRuntime: ({ expectedRuntimeSha256 }) => runtimeProof(expectedRuntimeSha256),
    pinRuntimePackage: () => ({
      manifest: { name: "brain-installer", version: "0.4.8" },
    }),
    revalidateRuntimePackage: () => {},
    ...overrides,
  };
}

function observedLocalOptions(events, overrides = {}) {
  return runtimeOptions({
    architectureLib: architectureLib(events),
    verifyRuntime: ({ expectedRuntimeSha256, root, allowlist }) => {
      events.push("runtime.verify");
      assert.equal(expectedRuntimeSha256, RUNTIME_SHA256);
      assert.equal(root, "synthetic-runtime-root");
      assert.deepEqual(allowlist, ["package.json"]);
      return runtimeProof(expectedRuntimeSha256);
    },
    ingestLib: async () => {
      events.push("ingest.module");
      return {
        ...ingestRuntime,
        resolveExactLocalFile: (...args) => {
          events.push("source.resolve");
          return ingestRuntime.resolveExactLocalFile(...args);
        },
      };
    },
    pinManifest: (path) => {
      events.push("manifest.pin");
      return pinFirstSourceManifest(path);
    },
    ...overrides,
  });
}

function familyReceipt(operation) {
  return {
    contract_version: 1,
    mode: "result_family",
    operation,
    source,
    original_id: `hmac-sha256:${digest("1")}`,
    family_receipt_hash: `sha256:${digest("2")}`,
    verification_hash: `sha256:${digest("3")}`,
    document_count: 1,
    chunk_count: 1,
    vector_readiness_hash: `sha256:${digest("4")}`,
    retrieval_probe_id: `probe-v1:${digest("5")}`,
    retrieval_status: "deterministic",
    citation_status: "same_family",
    accepted_outcome_authorized: false,
    recorded: operation === "record",
    replayed: operation === "verify",
  };
}

test("credential boundary grants apply support writes only to the exact apply grammar", () => {
  const exact = [
    "private.json", "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--apply", "--approve", digest("a"),
  ];
  assert.equal(classifyCliCredentialBoundary("ingest-file", exact), "ingest-file-apply");
  for (const malformed of [
    [...exact, "--json"],
    exact.with(8, "--approve=bad"),
    exact.with(9, "bad"),
    exact.toSpliced(7, 0, "--apply"),
    exact.toSpliced(5, 2),
    exact.with(6, "A".repeat(64)),
    exact.with(2, "Bad!"),
    exact.with(4, "../secret.txt"),
    exact.with(4, "NUL.txt"),
    exact.with(4, "decomposed-e\u0301.txt"),
    exact.with(5, "--expect-runtime-sha256=bad"),
    exact.toSpliced(7, 0, "--expect-runtime-sha256", RUNTIME_SHA256),
    ["private.json", "--source", source, "--file", file, "--json"],
  ]) {
    assert.equal(
      classifyCliCredentialBoundary("ingest-file", malformed),
      "ingest-file-preview",
    );
  }
});

test("real adapter preview proves one direct native file without exposing private input", async (t) => {
  const local = fixture();
  t.after(local.cleanup);
  const calls = [];
  const dependencies = firstSourceFileDependencies(observedLocalOptions(calls, {
    targetDependencies: {
      acquireSourceLease: () => { throw new Error("preview must not acquire a lease"); },
    },
  }));
  const input = parseFirstSourceFileArgv([
    local.manifest,
    "--source", source,
    "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--json",
  ]);
  const receipt = await previewFirstSourceFile(input, dependencies);
  assert.equal(calls[0], "architecture");
  assert.ok(calls.indexOf("runtime.verify") > calls.indexOf("architecture"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("ingest.module"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("manifest.pin"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("source.resolve"));
  assert.equal(receipt.status, "ready_for_approval");
  assert.match(receipt.approval_fingerprint, /^[a-f0-9]{64}$/u);
  const publicJson = JSON.stringify(receipt);
  for (const privateValue of [local.manifest, local.sourceRoot, source, file, privateText]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("real adapter apply leases first and maps the exact Worker result identity", async (t) => {
  const local = fixture();
  t.after(local.cleanup);
  const calls = [];
  const targetDependencies = {
    acquireSourceLease: ({ manifestPath, source: requestedSource }) => {
      calls.push("lease");
      assert.equal(manifestPath, local.manifest);
      assert.equal(requestedSource, source);
      return {
        fingerprint: digest("b"),
        assertOwned: async () => { calls.push("lease.assert"); },
        release: async () => { calls.push("lease.release"); },
      };
    },
    resolveDurableAdminAccess: async ({ manifest, manifestPath, assertOwned }) => {
      calls.push("credential");
      await assertOwned();
      assert.equal(manifestPath, local.manifest);
      assert.equal(manifest.corpora.local_folder.source, source);
      return Object.freeze({ kind: "synthetic_admin_capability" });
    },
    readSourceInventory: async ({ source: requestedSource, assertOwned }) => {
      calls.push("registration");
      await assertOwned();
      assert.equal(requestedSource, source);
      return {
        contract_version: 3,
        kind: "source_inventory",
        complete: true,
        truncated: false,
        cursor: null,
        total: 1,
        returned: 1,
        snapshot: { id: `sha256:${digest("6")}`, stable: true },
        sources: [{ source_id: source, name: source, kind: "upload", registered: true }],
      };
    },
    ingestPrepared: async ({ envelopes, assertOwned }) => {
      calls.push("ingest");
      await assertOwned();
      assert.equal(envelopes.length, 1);
      return {
        created: 1,
        updated: 0,
        unchanged: 0,
        refused: 0,
        failed: 0,
        results: [{
          source_type: source,
          source_id: file,
          doc_uid: `${source}:${file}`,
          status: "created",
        }],
      };
    },
    recordResultFamily: async ({ request, assertOwned }) => {
      calls.push("family.record");
      await assertOwned();
      assert.equal(request.retrieval_query, privateText);
      return familyReceipt("record");
    },
    verifyResultFamily: async ({ request, assertOwned }) => {
      calls.push("family.verify");
      await assertOwned();
      assert.equal(request.retrieval_query, privateText);
      return familyReceipt("verify");
    },
  };
  const options = observedLocalOptions(calls, {
    targetDependencies,
  });
  const previewDependencies = firstSourceFileDependencies(options);
  const previewInput = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256, "--json",
  ]);
  const preview = await previewFirstSourceFile(previewInput, previewDependencies);
  calls.length = 0;
  const applyDependencies = firstSourceFileDependencies(options);
  const applyInput = parseFirstSourceFileArgv([
    local.manifest,
    "--source", source,
    "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--apply",
    "--approve", preview.approval_fingerprint,
  ]);
  const receipt = await applyFirstSourceFile(applyInput, applyDependencies);
  assert.equal(receipt.complete, true);
  assert.equal(receipt.status, "same_item_proved");
  assert.equal(receipt.ingest.outcome, "created");
  assert.equal(calls[0], "architecture");
  assert.ok(calls.indexOf("lease") > calls.indexOf("architecture"));
  assert.ok(calls.indexOf("runtime.verify") > calls.indexOf("lease"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("ingest.module"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("manifest.pin"));
  assert.ok(calls.indexOf("runtime.verify") < calls.indexOf("source.resolve"));
  assert.ok(calls.indexOf("credential") > calls.indexOf("lease"));
  assert.ok(calls.indexOf("registration") > calls.indexOf("credential"));
  assert.ok(calls.indexOf("ingest") > calls.indexOf("registration"));
  assert.ok(calls.indexOf("family.record") > calls.indexOf("ingest"));
  assert.ok(calls.indexOf("family.verify") > calls.indexOf("family.record"));
  assert.equal(calls.at(-1), "lease.release");
});

test("ingest adapter rejects absent or substituted remote item identity", async () => {
  const envelope = Object.freeze({ source_type: source, source_id: file });
  const exact = {
    source_type: source,
    source_id: file,
    doc_uid: `${source}:${file}`,
    status: "created",
  };
  for (const result of [
    { source_id: file, status: "created" },
    { ...exact, source_type: "different_source" },
    { ...exact, source_id: "different-file.txt" },
    { ...exact, doc_uid: `${source}:different-file.txt` },
  ]) {
    const dependencies = firstSourceFileDependencies(runtimeOptions({
      targetDependencies: {
        ingestPrepared: async () => ({
          created: 1,
          updated: 0,
          unchanged: 0,
          refused: 0,
          failed: 0,
          results: [result],
        }),
      },
    }));
    await assert.rejects(
      dependencies.ingestExact({
        envelope,
        adminAccess: Object.freeze({ kind: "synthetic_admin_capability" }),
        assertOwned: async () => {},
      }),
      /different item identity/u,
    );
  }
});

test("runtime mismatch stops before private reads and releases an apply lease", async (t) => {
  const local = fixture();
  t.after(local.cleanup);
  const previewEvents = [];
  const previewDependencies = firstSourceFileDependencies(runtimeOptions({
    architectureLib: architectureLib(previewEvents),
    verifyRuntime: () => {
      previewEvents.push("runtime.verify");
      throw new Error("synthetic runtime mismatch");
    },
    ingestLib: async () => {
      previewEvents.push("ingest.module");
      return ingestRuntime;
    },
    pinManifest: () => {
      previewEvents.push("manifest.pin");
      throw new Error("manifest must remain unread");
    },
    targetDependencies: {},
  }));
  const previewInput = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256, "--json",
  ]);
  await assert.rejects(
    previewFirstSourceFile(previewInput, previewDependencies),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "read_only_snapshot");
      const publicJson = JSON.stringify(error.receipt);
      for (const privateValue of [local.manifest, local.sourceRoot, source, file, privateText]) {
        assert.equal(publicJson.includes(privateValue), false);
      }
      return true;
    },
  );
  assert.deepEqual(previewEvents, ["architecture", "runtime.verify"]);

  const applyEvents = [];
  const applyDependencies = firstSourceFileDependencies(runtimeOptions({
    architectureLib: architectureLib(applyEvents),
    verifyRuntime: () => {
      applyEvents.push("runtime.verify");
      throw new Error("synthetic runtime mismatch");
    },
    ingestLib: async () => {
      applyEvents.push("ingest.module");
      return ingestRuntime;
    },
    pinManifest: () => {
      applyEvents.push("manifest.pin");
      throw new Error("manifest must remain unread");
    },
    targetDependencies: {
      acquireSourceLease: () => {
        applyEvents.push("lease");
        return {
          fingerprint: digest("b"),
          assertOwned: async () => {},
          release: async () => { applyEvents.push("lease.release"); },
        };
      },
    },
  }));
  const applyInput = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--apply", "--approve", digest("b"),
  ]);
  await assert.rejects(
    applyFirstSourceFile(applyInput, applyDependencies),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "source_lease");
      assert.equal(JSON.stringify(error.receipt).includes(local.manifest), false);
      return true;
    },
  );
  assert.deepEqual(applyEvents, [
    "architecture",
    "lease",
    "runtime.verify",
    "lease.release",
  ]);
});

test("runtime proof drift during the private cut fails closed before external access", async (t) => {
  const local = fixture();
  t.after(local.cleanup);
  const events = [];
  let proofCount = 0;
  const dependencies = firstSourceFileDependencies(observedLocalOptions(events, {
    verifyRuntime: ({ expectedRuntimeSha256 }) => {
      events.push("runtime.verify");
      proofCount += 1;
      return Object.freeze({
        ...runtimeProof(expectedRuntimeSha256),
        file_count: proofCount === 1 ? 12 : 13,
      });
    },
    targetDependencies: {},
  }));
  const input = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256, "--json",
  ]);
  await assert.rejects(
    previewFirstSourceFile(input, dependencies),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "read_only_snapshot");
      const publicJson = JSON.stringify(error.receipt);
      for (const privateValue of [local.manifest, local.sourceRoot, source, file, privateText]) {
        assert.equal(publicJson.includes(privateValue), false);
      }
      return true;
    },
  );
  assert.equal(proofCount, 2);
  assert.ok(events.indexOf("runtime.verify") < events.indexOf("manifest.pin"));
  assert.ok(events.includes("source.resolve"));

  const applyEvents = [];
  let applyProofCount = 0;
  const applyDependencies = firstSourceFileDependencies(observedLocalOptions(applyEvents, {
    verifyRuntime: ({ expectedRuntimeSha256 }) => {
      applyEvents.push("runtime.verify");
      applyProofCount += 1;
      return Object.freeze({
        ...runtimeProof(expectedRuntimeSha256),
        total_bytes: applyProofCount === 1 ? 34_567 : 34_568,
      });
    },
    targetDependencies: {
      acquireSourceLease: () => {
        applyEvents.push("lease");
        return {
          fingerprint: digest("b"),
          assertOwned: async () => {},
          release: async () => { applyEvents.push("lease.release"); },
        };
      },
      resolveDurableAdminAccess: async () => {
        applyEvents.push("credential");
        throw new Error("credential boundary must remain closed");
      },
    },
  }));
  const applyInput = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--apply", "--approve", digest("b"),
  ]);
  await assert.rejects(
    applyFirstSourceFile(applyInput, applyDependencies),
    (error) => {
      assert.ok(error instanceof FirstSourceFileError);
      assert.equal(error.stage, "source_lease");
      return true;
    },
  );
  assert.equal(applyProofCount, 2);
  assert.equal(applyEvents.includes("credential"), false);
  assert.equal(applyEvents.at(-1), "lease.release");
});

test("malformed runtime proof stops before the private manifest", async (t) => {
  const local = fixture();
  t.after(local.cleanup);
  let manifestReads = 0;
  const dependencies = firstSourceFileDependencies(runtimeOptions({
    architectureLib: architectureLib(),
    verifyRuntime: ({ expectedRuntimeSha256 }) => ({
      ...runtimeProof(expectedRuntimeSha256),
      unexpected: true,
    }),
    pinManifest: () => {
      manifestReads += 1;
      throw new Error("manifest must remain unread");
    },
    targetDependencies: {},
  }));
  const input = parseFirstSourceFileArgv([
    local.manifest, "--source", source, "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256, "--json",
  ]);
  await assert.rejects(
    previewFirstSourceFile(input, dependencies),
    (error) => error instanceof FirstSourceFileError && error.stage === "read_only_snapshot",
  );
  assert.equal(manifestReads, 0);
});

test("command-level runtime refusal emits only the fixed identity-free receipt", async () => {
  const privateManifest = "C:\\Users\\PrivateOwner\\Brain\\brain.manifest.json";
  const privateRuntimeRoot = "C:\\Users\\PrivateOwner\\FinancialBrain";
  const writes = [];
  await assert.rejects(
    cmdFirstSourceFile([
      privateManifest,
      "--source", source,
      "--file", file,
      "--expect-runtime-sha256", RUNTIME_SHA256,
      "--json",
    ], {
      boundaryCommand: "ingest-file-preview",
      dependencyOptions: runtimeOptions({
        runtimeRoot: privateRuntimeRoot,
        architectureLib: architectureLib(),
        verifyRuntime: () => { throw new Error("observed secret runtime mismatch detail"); },
        pinManifest: () => { throw new Error("manifest must remain unread"); },
        targetDependencies: {},
      }),
      write: (value) => writes.push(value),
    }),
    (error) => {
      const receipt = JSON.parse(error.message);
      assert.equal(receipt.failed_stage, "read_only_snapshot");
      const publicJson = JSON.stringify(receipt);
      for (const privateValue of [
        privateManifest,
        privateRuntimeRoot,
        source,
        file,
        "observed secret runtime mismatch detail",
      ]) {
        assert.equal(publicJson.includes(privateValue), false);
      }
      return true;
    },
  );
  assert.deepEqual(writes, []);
});

test("spawned preview refuses non-Windows architecture before manifest access", () => {
  const privateManifest = join(tmpdir(), "must-not-be-read-first-source.json");
  const result = spawnSync(process.execPath, [
    new URL("../brain.mjs", import.meta.url).pathname,
    "ingest-file",
    privateManifest,
    "--source", source,
    "--file", file,
    "--expect-runtime-sha256", RUNTIME_SHA256,
    "--json",
  ], {
    cwd: new URL("..", import.meta.url).pathname,
    encoding: "utf8",
    env: { ...process.env },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.operation, "first-source-file");
  assert.equal(receipt.mode, "preview");
  assert.equal(receipt.failed_stage, "windows_x64_gate");
  const publicJson = JSON.stringify(receipt);
  for (const privateValue of [privateManifest, source, file]) {
    assert.equal(publicJson.includes(privateValue), false);
  }
});

test("command adapter emits one closed JSON failure for malformed preview syntax", async () => {
  const writes = [];
  await assert.rejects(
    cmdFirstSourceFile(["private.json", "--source", source, "--file", file], {
      boundaryCommand: "ingest-file-preview",
      write: (value) => writes.push(value),
    }),
    (error) => {
      const receipt = JSON.parse(error.message);
      assert.equal(receipt.failed_stage, "request_validation");
      assert.equal(receipt.mode, "preview");
      assert.equal(JSON.stringify(receipt).includes("private.json"), false);
      return true;
    },
  );
  assert.deepEqual(writes, []);
});
