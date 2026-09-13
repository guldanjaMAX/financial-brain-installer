import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

import {
  CloudflareRecoveryAdapterError,
  RECOVERY_DURABLE_TABLES,
  RECOVERY_EXPORT_TABLES,
  RECOVERY_FIELD_GATE_STOP_STAGES,
  RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_CODE,
  RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
  createCloudflareRecoveryFieldGateAdapters,
  assertDisposableRecoveryFieldCampaignIdentity,
  assertDisposableRecoverySourceFieldCampaignIdentity,
  inspectDisposableRecoveryDeploymentPreparation,
  inspectDisposableRecoverySourceDeploymentPreparation,
  inspectDisposableRecoverySeedPreparation,
  normalizedInstallStateExport,
  parseCloudflareRecoveryCliArguments,
  previewCloudflareRecoveryFieldGate,
  recoveryExportTables,
  recoveryVectorProtocolSupported,
  runCloudflareRecoveryFieldGate,
  verifyRecoverySqlArtifact,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  assertDisposableRecoveryDeploymentReceipt,
  assertDisposableRecoverySourcePhaseReceipt,
  assertDisposableRecoverySourcePreflightReceipt,
  assertDisposableRecoveryTargetPreflightReceipt,
  disposableRecoverySourceA2Fingerprint,
  disposableRecoveryTargetA4Fingerprint,
} from "../operations/disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  assertDisposableRecoverySeedReceipt,
} from "../operations/disposable-recovery-seeder.mjs";
import { readPrivateAggregateReceipt } from "../operations/private-aggregate-receipt.mjs";
import {
  initializeVerifiedRecovery,
  inspectVerifiedRecoveryManifestBindings,
  loadVerifiedRecoveryState,
  writeVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";
import { withDecryptedRecoveryArtifact } from "../operations/recovery-artifact-crypto.mjs";
import {
  LOCKED_WRANGLER_ENTRYPOINT,
  LOCKED_WRANGLER_RESOLUTION_GUARD,
  LOCKED_WRANGLER_RUNTIME_DIRECTORY,
  inspectLockedWranglerRuntime,
  materializeLockedWranglerRuntime,
  prepareLockedWranglerRuntimeFromCache,
} from "../operations/locked-wrangler-runtime.mjs";
import { ZOOM_CREDENTIAL_ENV } from "../connectors/zoom.mjs";
import Worker from "../worker/src/index.js";
import { BANK_ACCESS_WRAPPING_KEY_SECRET, encryptAccessReference } from "../worker/src/lib/bank-feed.js";
import { resolveNpmCacheContentRoot } from "../scripts/field-prepare.mjs";

const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "brain-cloudflare-recovery-adapter-")));
if (process.platform !== "win32") chmodSync(sandbox, 0o700);

// Schema 34's source inventory is durable schema, but its rows are a derived
// projection rebuilt from authoritative live documents during restore.
assert.equal(RECOVERY_DURABLE_TABLES.includes("document_source_inventory"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("document_source_inventory"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("plaid_sync_leases"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("plaid_sync_leases"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("memory_supersessions"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("memory_supersessions"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("owner_financial_map_inventory_state"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("owner_financial_map_inventory_state"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("owner_financial_map_key_state"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("owner_financial_map_key_state"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("owner_financial_map_snapshots"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("owner_financial_map_snapshots"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("owner_financial_map_previews"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("owner_financial_map_previews"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_id_key_state"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_id_key_state"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_observations"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_observations"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_result_bindings"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_bindings"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_result_family_members"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_members"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_result_family_receipts"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_receipts"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_accepted_resolutions"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolutions"), true);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_result_family_verifications"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_verifications"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_accepted_resolution_activations"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolution_activations"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_accepted_resolution_admissions"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_accepted_resolution_admissions"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("source_original_result_family_recovery_state"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("source_original_result_family_recovery_state"), false);
assert.ok(
  RECOVERY_EXPORT_TABLES.indexOf("source_original_observations") <
    RECOVERY_EXPORT_TABLES.indexOf("source_original_result_bindings") &&
    RECOVERY_EXPORT_TABLES.indexOf("documents") <
    RECOVERY_EXPORT_TABLES.indexOf("source_original_result_bindings") &&
    RECOVERY_EXPORT_TABLES.indexOf("source_original_result_bindings") <
      RECOVERY_EXPORT_TABLES.indexOf("source_original_result_family_members") &&
    RECOVERY_EXPORT_TABLES.indexOf("source_original_result_family_members") <
      RECOVERY_EXPORT_TABLES.indexOf("source_original_result_family_receipts") &&
    RECOVERY_EXPORT_TABLES.indexOf("source_original_result_family_receipts") <
      RECOVERY_EXPORT_TABLES.indexOf("source_original_accepted_resolutions"),
  "recovery restores observations and documents before raw bindings, family members, sealed family headers, then portable accepted resolutions",
);

const sourceManifestPath = join(sandbox, "source.manifest.json");
const targetManifestPath = join(sandbox, "target.manifest.json");
const planPath = join(sandbox, ".brain-recovery-plan.json");
const statePath = join(sandbox, ".brain-recovery-state.json");
const artifactDirectory = join(sandbox, "private-artifacts");
const wrapperPath = join(sandbox, "wrangler-owner-wrapper");
const goldenPath = join(sandbox, "brain.golden.json");
const fieldPreparationDirectory = join(sandbox, "private-v048-field-preparation");
const fieldReceiptPath = join(fieldPreparationDirectory, "field-prepare-receipt.json");
const fieldPackagePath = join(fieldPreparationDirectory, "brain-installer-0.4.8.tgz");
const fieldSourcePreflightReceiptPath = join(
  fieldPreparationDirectory,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
);
const fieldSourcePhaseReceiptPath = join(
  fieldPreparationDirectory,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
);
const fieldTargetPreflightReceiptPath = join(
  fieldPreparationDirectory,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
);
const fieldDeploymentReceiptPath = join(
  fieldPreparationDirectory,
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
);
const fieldSeedReceiptPath = join(
  fieldPreparationDirectory,
  "v048-disposable-seed-receipt.json",
);
const privateSentinel = "fixture-private-question-and-provider-output";
const fixtureAdminKey = "fixture-private-admin-key-value";
const fixtureRecoveryArtifactKey = `v1.${Buffer.alloc(32, 19).toString("base64url")}`;
const wrapperScript = "#!/bin/sh\n" +
  "CLOUDFLARE_API_TOKEN=\"$(/usr/bin/security find-generic-password " +
  "-a 'fixture-recovery' -s 'fixture-cloudflare-token' -w)\" || exit 125\n" +
  "[ -n \"$CLOUDFLARE_API_TOKEN\" ] || exit 125\n" +
  "export CLOUDFLARE_API_TOKEN\n" +
  "exec \"${BRAIN_RECOVERY_NODE:?}\" --no-global-search-paths --require " +
  "\"${BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD:?}\" " +
  "\"${BRAIN_RECOVERY_WRANGLER_ENTRYPOINT:?}\" \"$@\"\n";
let lockedWranglerRuntime = inspectLockedWranglerRuntime(process.cwd());
const sourceWorkerVersionId = "fixture-source-version-id";
const pausedWorkerVersionId = "fixture-paused-version-id";
const activeWorkerVersionId = "fixture-active-version-id";
const pausedWorkerScriptEtag = "a".repeat(64);
const activeWorkerScriptEtag = "c".repeat(64);
const sourceWorkerScriptEtag = "b".repeat(64);
const fieldSourceWorkerVersionId = "10000000-0000-4000-8000-000000000001";
const fieldPausedWorkerVersionId = "20000000-0000-4000-8000-000000000002";
const fieldActiveWorkerVersionId = "30000000-0000-4000-8000-000000000003";
const fieldSourceDeploymentId = "40000000-0000-4000-8000-000000000004";
const fieldTargetDeploymentId = "50000000-0000-4000-8000-000000000005";

const sourceManifest = {
  manifest_version: 1,
  client: { slug: "fixture-brain", display_name: "Synthetic Fixture" },
  brain: {
    version: "0.1.12",
    worker_name: "fixture-source-worker",
    domain: "source.fixture.invalid",
  },
  infrastructure: {
    cloudflare: {
      storage: "d1",
      account_id: "fixture-account-source",
      d1_database_name: "fixture-source-d1",
      d1_database_id: "fixture-source-database-id",
      vectorize_index: "fixture-source-vector",
    },
  },
  retrieval: {
    embed_model: "@cf/baai/bge-base-en-v1.5",
    embed_dimensions: 768,
  },
  operations: {
    admin_key_secret: "keychain://fixture-brain-source/owner",
  },
};

const targetManifest = {
  ...structuredClone(sourceManifest),
  brain: {
    ...sourceManifest.brain,
    worker_name: "fixture-brain-recovery-gate-deadbeef",
    domain: "fixture-brain-recovery-gate-deadbeef.fixture-account.workers.dev",
  },
  infrastructure: {
    cloudflare: {
      ...sourceManifest.infrastructure.cloudflare,
      account_id: "fixture-account-target",
      d1_database_name: "fixture-d1-recovery-gate-deadbeef",
      d1_database_id: "fixture-target-database-id",
      vectorize_index: "fixture-vector-recovery-gate-deadbeef",
    },
  },
  operations: {
    admin_key_secret: "keychain://fixture-brain-recovery/owner",
    recovery_artifact_key_secret: "keychain://fixture-brain-recovery/artifact-v1",
    recovery_field_gate: {
      paused_worker_version_id: pausedWorkerVersionId,
      paused_worker_script_etag: pausedWorkerScriptEtag,
      active_worker_version_id: activeWorkerVersionId,
      active_worker_script_etag: activeWorkerScriptEtag,
      routes: [],
      custom_domains: [],
      reviewed_at: "2026-08-25T11:55:00.000Z",
    },
  },
};

const syntheticFieldSourceResource =
  "brain-test-v048-field-source-recovery-gate-a48f1101";
const syntheticFieldTargetResource =
  "brain-test-v048-field-target-recovery-gate-a48f1102";
const syntheticFieldSourceManifest = {
  ...structuredClone(sourceManifest),
  client: { slug: "v048-field-proof", display_name: "Synthetic Field Gate v0.4.8" },
  brain: {
    version: "0.4.8",
    worker_name: syntheticFieldSourceResource,
    domain: `${syntheticFieldSourceResource}.fixture.workers.dev`,
  },
  infrastructure: {
    cloudflare: {
      ...sourceManifest.infrastructure.cloudflare,
      account_id: "fixture-v048-field-source-account",
      d1_database_name: syntheticFieldSourceResource,
      d1_database_id: "fixture-v048-field-source-database-id",
      vectorize_index: syntheticFieldSourceResource,
    },
  },
  operations: {
    admin_key_secret: `keychain://${syntheticFieldSourceResource}/owner`,
  },
};
const syntheticFieldTargetManifest = {
  ...structuredClone(syntheticFieldSourceManifest),
  brain: {
    ...syntheticFieldSourceManifest.brain,
    worker_name: syntheticFieldTargetResource,
    domain: `${syntheticFieldTargetResource}.fixture.workers.dev`,
  },
  infrastructure: {
    cloudflare: {
      ...syntheticFieldSourceManifest.infrastructure.cloudflare,
      account_id: "fixture-v048-field-target-account",
      d1_database_name: syntheticFieldTargetResource,
      d1_database_id: "fixture-v048-field-target-database-id",
      vectorize_index: syntheticFieldTargetResource,
    },
  },
  operations: {
    admin_key_secret: `keychain://${syntheticFieldTargetResource}/owner`,
    recovery_artifact_key_secret: `keychain://${syntheticFieldTargetResource}/artifact-v1`,
  },
};

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

const fullFieldPreparationSteps = Object.freeze([
  "source-identity", "full-suite", "frontend-test", "frontend-build", "hiccup-lab",
  "plaid-fake", "d1-auth-atomicity", "passkey-protocol", "package-privacy",
  "history-privacy", "dependency-audit", "package-build", "clean-prefix-smoke",
  "source-identity-final", "private-home-cleanup",
]);
const humanFieldGates = Object.freeze([
  "physical_windows_install", "disposable_cloudflare", "physical_passkeys",
  "plaid_sandbox", "quickbooks_sandbox", "watched_folder", "bank_exports",
]);

function npmPackageFixture(destination) {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = [
    ...(npmCli ? [npmCli] : []),
    "pack", "--ignore-scripts", "--json", "--pack-destination", destination,
  ];
  const packed = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  assert.equal(packed.status, 0, "focused recovery test must build its exact local npm package");
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  assert.equal(metadata[0].filename, "brain-installer-0.4.8.tgz");
  assert.equal(metadata[0].entryCount, metadata[0].files.length);
  return Object.freeze({
    bytes: readFileSync(join(destination, metadata[0].filename)),
    fileCount: metadata[0].files.length,
  });
}

function packageWithMutatedMember(packageBytes, wantedPath) {
  const archive = gunzipSync(packageBytes);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length)
      .toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(124, 12).trim(), 8);
    assert.equal(Number.isSafeInteger(size), true);
    const contentStart = offset + 512;
    if (path === `package/${wantedPath}`) {
      assert.ok(size > 0);
      archive[contentStart] ^= 1;
      return gzipSync(archive, { level: 1 });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  assert.fail(`package member missing from fixture: ${wantedPath}`);
}

function packageWithRenamedMember(packageBytes, wantedPath, replacementPath) {
  const archive = gunzipSync(packageBytes);
  const wanted = `package/${wantedPath}`;
  const replacement = `package/${replacementPath}`;
  assert.ok(Buffer.byteLength(replacement, "utf8") <= 100);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length)
      .toString("utf8").replace(/\0.*$/s, "");
    const name = text(0, 100);
    const prefix = text(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(text(124, 12).trim(), 8);
    assert.equal(Number.isSafeInteger(size), true);
    const contentStart = offset + 512;
    if (path === wanted) {
      assert.equal(prefix, "");
      header.fill(0, 0, 100);
      Buffer.from(replacement, "utf8").copy(header, 0);
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii")
        .copy(header, 148);
      return gzipSync(archive, { level: 1 });
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  assert.fail(`package member missing from fixture: ${wantedPath}`);
}

function fullFieldPreparationReceipt(candidateSha, packageBytes, packageFileCount, {
  runId = "11111111-1111-4111-8111-111111111111",
} = {}) {
  return {
    schema_version: 1,
    run_id: runId,
    generated_at: "2026-09-11T13:00:00.000Z",
    completed_at: "2026-09-11T13:30:00.000Z",
    status: "source_preparation_passed",
    profile: "full",
    scope: "source_preparation_only",
    proof_level: "offline_synthetic_only",
    ready_for_live_accounts: false,
    live_field_gates_run: false,
    customer_data_read: false,
    customer_manifests_read: false,
    credential_stores_read: false,
    live_accounts_contacted: false,
    external_network_allowed: false,
    tooling: {
      wrangler_package: "wrangler@4.131.1",
      wrangler_resolution: "locked_local_runtime_closure",
      wrangler_runtime_directory: LOCKED_WRANGLER_RUNTIME_DIRECTORY,
      wrangler_runtime_schema_version: lockedWranglerRuntime.schemaVersion,
      wrangler_entrypoint: lockedWranglerRuntime.entrypointRelative,
      wrangler_entrypoint_sha256: lockedWranglerRuntime.entrypointSha256,
      wrangler_runtime_inventory_sha256: lockedWranglerRuntime.inventorySha256,
      wrangler_runtime_package_count: lockedWranglerRuntime.packageCount,
      wrangler_runtime_file_count: lockedWranglerRuntime.fileCount,
      wrangler_runtime_bytes: lockedWranglerRuntime.totalBytes,
      wrangler_package_lock_sha256: lockedWranglerRuntime.packageLockSha256,
      wrangler_host_platform: lockedWranglerRuntime.host.platform,
      wrangler_host_arch: lockedWranglerRuntime.host.arch,
      wrangler_host_libc: lockedWranglerRuntime.host.libc,
      node_version: lockedWranglerRuntime.nodeVersion,
      node_executable_sha256: lockedWranglerRuntime.nodeExecSha256,
    },
    source: {
      head_sha: candidateSha,
      tree_sha: "b".repeat(40),
      package_name: "brain-installer",
      package_version: "0.4.8",
      package_alignment: {
        aligned: true,
        package_lock_name: "brain-installer",
        package_lock_version: "0.4.8",
        package_lock_root_name: "brain-installer",
        package_lock_root_version: "0.4.8",
      },
      package_json_sha256: hash(readFileSync(join(process.cwd(), "package.json"))),
      package_lock_sha256: hash(readFileSync(join(process.cwd(), "package-lock.json"))),
      working_tree_clean: true,
      shallow_repository: false,
      diff_check_clean: true,
      identity_stable_during_check: true,
      end_clean: true,
    },
    package: {
      filename: "brain-installer-0.4.8.tgz",
      bytes: packageBytes.length,
      sha256: hash(packageBytes),
      file_count: packageFileCount,
    },
    steps: fullFieldPreparationSteps.map((id) => ({
      id,
      title: `Synthetic ${id}`,
      status: "passed",
      proof: `Synthetic proof for ${id}`,
      duration_ms: 1,
      exit_code: null,
      failure_code: null,
      network_scope: id === "d1-auth-atomicity"
        ? "loopback_only"
        : ["source-identity", "source-identity-final", "private-home-cleanup"].includes(id)
          ? "local_only"
          : "local_only_offline_enforced",
    })),
    human_field_gates: humanFieldGates.map((id) => ({
      id,
      status: "pending_human_proof",
    })),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const hash = (value) => createHash("sha256").update(value).digest("hex");

function migrationRows() {
  return readdirSync(join(process.cwd(), "migrations", "d1"))
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8");
      return {
        version: Number(name.split("_")[0]),
        name: name.replace(/\.sql$/, ""),
        checksum: hash(sql).slice(0, 16),
      };
    });
}

const appliedMigrations = migrationRows();
assert.equal(recoveryVectorProtocolSupported(appliedMigrations.slice(0, 35)), false);
assert.equal(recoveryVectorProtocolSupported(appliedMigrations.slice(0, 36)), true);
assert.equal(recoveryVectorProtocolSupported(appliedMigrations), true);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 36)).includes("memory_supersessions"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("memory_supersessions"), true);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 40)).includes("owner_financial_map_snapshots"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("owner_financial_map_snapshots"), true);
assert.equal(recoveryExportTables(appliedMigrations).includes("owner_financial_map_previews"), false);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 41)).includes("source_original_id_key_state"), false);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 41)).includes("source_original_observations"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_id_key_state"), true);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_observations"), true);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 42)).includes("source_original_result_bindings"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_result_bindings"), true);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 43)).includes("source_original_result_family_members"), false);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 43)).includes("source_original_result_family_receipts"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_result_family_members"), true);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_result_family_receipts"), true);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_result_family_verifications"), false);
assert.equal(recoveryExportTables(appliedMigrations.slice(0, 44)).includes("source_original_accepted_resolutions"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_accepted_resolutions"), true);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_accepted_resolution_activations"), false);
assert.equal(recoveryExportTables(appliedMigrations).includes("source_original_accepted_resolution_admissions"), false);
const installStateColumns = Object.freeze([
  ["id", "INTEGER"],
  ["client_slug", "TEXT"],
  ["product_version", "TEXT"],
  ["schema_version", "INTEGER"],
  ["gate_version", "INTEGER"],
  ["installed_at", "TEXT"],
  ["last_upgraded_at", "TEXT"],
  ["ring", "TEXT"],
  ["notes", "TEXT"],
  ["outbox_generation", "INTEGER"],
  ["vector_drain_lease_owner", "TEXT"],
  ["vector_drain_lease_expires_at", "INTEGER"],
  ["vector_projection_mutation_id", "TEXT"],
  ["vector_projection_submitted_at", "INTEGER"],
  ["vector_projection_status", "TEXT"],
  ["vector_projection_bootstrap_epoch", "INTEGER"],
  ["vector_projection_bootstrap_cursor", "TEXT"],
  ["vector_projection_bootstrap_high_water", "TEXT"],
  ["vector_projection_bootstrap_protocol", "TEXT"],
  ["vector_projection_bootstrap_base_count", "INTEGER"],
  ["session_generation", "INTEGER"],
  ["vector_projection_residue_epoch", "INTEGER"],
  ["source_original_retrieval_generation", "INTEGER"],
]);
const fixtureInstallState = Object.freeze({
  id: 1,
  client_slug: "fixture-brain",
  product_version: "0.1.12",
  schema_version: 13,
  gate_version: 4,
  installed_at: "2026-08-25T12:00:00.000Z",
  last_upgraded_at: null,
  ring: "stable",
  notes: null,
  outbox_generation: 9,
  vector_drain_lease_owner: null,
  vector_drain_lease_expires_at: null,
  vector_projection_mutation_id: null,
  vector_projection_submitted_at: null,
  vector_projection_status: "bootstrap_required",
  vector_projection_bootstrap_epoch: 1,
  vector_projection_bootstrap_cursor: null,
  vector_projection_bootstrap_high_water: "fixture:chunk#0004",
  // This proof belongs to the source Vectorize index and must never survive a
  // recovery into the target's new index.
  vector_projection_bootstrap_protocol: "bootstrap-v2",
  vector_projection_bootstrap_base_count: 5,
  // Live owner-session coordination; recovery advances this generation once so
  // every cookie minted against the source is invalid on the restored Brain.
  session_generation: 4,
  vector_projection_residue_epoch: null,
  source_original_retrieval_generation: 37,
});
const normalizedInstallStateSql =
  `INSERT INTO "install_state" (${installStateColumns.map(([name]) => `"${name}"`).join(",")}) VALUES (` +
  `1,'fixture-brain','0.1.12',13,4,'2026-08-25T12:00:00.000Z',NULL,'stable',NULL,0,NULL,NULL,NULL,NULL,'bootstrap_required',1,NULL,'fixture:chunk#0004',NULL,0,5,NULL,0);\n`;
const schemaRows = Object.freeze([
  ...RECOVERY_DURABLE_TABLES.map((name) => ({
    type: "table",
    name,
    tbl_name: name,
    sql: `CREATE TABLE ${name} (fixture TEXT)`,
  })),
  {
    type: "table",
    name: "chunks_fts",
    tbl_name: "chunks_fts",
    sql: "CREATE VIRTUAL TABLE chunks_fts USING fts5(text)",
  },
].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));

function aggregateFromSql(sql) {
  const aggregate = {};
  for (const match of sql.matchAll(/AS\s+"([a-z0-9_]+)"/g)) aggregate[match[1]] = "0";
  aggregate.documents = "3";
  aggregate.chunks = "5";
  aggregate.chunks_fts = "5";
  aggregate.documents_ingested_max = "20";
  aggregate.documents_text_bytes = "100";
  aggregate.chunks_id_max = "5";
  aggregate.chunks_text_bytes = "500";
  return aggregate;
}

const aggregateTemplate = aggregateFromSql(
  "SELECT " + [
    ...RECOVERY_DURABLE_TABLES.filter((name) => name !== "document_source_inventory"),
    "chunks_fts",
    "documents_ingested_max",
    "documents_text_bytes",
    "chunks_id_max",
    "chunks_text_bytes",
    "vector_drain_lease_owner_present",
    "vector_drain_lease_expiry_present",
    "vector_projection_mutation_present",
    "vector_projection_submission_present",
  ].map((name) => `0 AS "${name}"`).join(","),
);
const deterministicDataExport = "-- deterministic data-only fixture\n";
const deterministicDataFingerprint = hash(normalizedInstallStateSql + deterministicDataExport);

function fixedReceiptHash(index) {
  return Number(index).toString(16).padStart(64, "0");
}

function receiptSnapshot(start) {
  return {
    first_raw_evidence_manifest_sha256: fixedReceiptHash(start),
    second_raw_evidence_manifest_sha256: fixedReceiptHash(start + 1),
    first_semantic_sha256: fixedReceiptHash(start + 2),
    second_semantic_sha256: fixedReceiptHash(start + 2),
    stable_semantic_sha256: fixedReceiptHash(start + 2),
  };
}

function receiptVersion({
  bindingHash,
  id,
  moduleHash,
  requestHash,
  responseHash,
  readbackHash,
  scriptEtag,
  withoutModeHash,
}) {
  return {
    version_id: id,
    script_etag: scriptEtag,
    upload_request_sha256: requestHash,
    module_inventory_sha256: moduleHash,
    bindings_sha256: bindingHash,
    bindings_without_mode_sha256: withoutModeHash,
    upload_response_evidence_manifest_sha256: responseHash,
    version_readback_evidence_manifest_sha256: readbackHash,
  };
}

function receiptDeployment({
  id,
  requestHash,
  responseHash,
  readbackHash,
  versionId,
}) {
  return {
    deployment_id: id,
    version_id: versionId,
    traffic_percent: 100,
    deployment_request_sha256: requestHash,
    deployment_response_evidence_manifest_sha256: responseHash,
    deployment_readback_evidence_manifest_sha256: readbackHash,
  };
}

function fullDisposableSourcePreflightReceipt(binding) {
  const receipt = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_PROTOCOL,
    kind: "source_preflight",
    status: "passed",
    completed_at: "2026-09-11T13:35:00.000Z",
    binding,
    planned_requests: {
      source_active_upload_sha256: fixedReceiptHash(1),
      source_active_deployment_sha256: fixedReceiptHash(2),
      seed_fixture_sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
    },
    snapshot: receiptSnapshot(10),
  };
  assertDisposableRecoverySourcePreflightReceipt(receipt);
  return receipt;
}

function fullDisposableSourcePhaseReceipt(binding, sourcePreflightReceiptSha256) {
  const sourceVersion = receiptVersion({
    id: fieldSourceWorkerVersionId,
    scriptEtag: "source-etag-v048",
    requestHash: fixedReceiptHash(1),
    moduleHash: fixedReceiptHash(20),
    bindingHash: fixedReceiptHash(21),
    withoutModeHash: fixedReceiptHash(22),
    responseHash: fixedReceiptHash(23),
    readbackHash: fixedReceiptHash(24),
  });
  const receipt = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_SOURCE_PHASE_PROTOCOL,
    kind: "source_phase",
    status: "passed",
    completed_at: "2026-09-11T13:40:00.000Z",
    binding,
    source_preflight_receipt_sha256: sourcePreflightReceiptSha256,
    a2_approval_fingerprint:
      disposableRecoverySourceA2Fingerprint(binding, sourcePreflightReceiptSha256),
    journal: {
      run_id: binding.run_id,
      through_sequence: 4,
      event_count: 4,
      head_sha256: fixedReceiptHash(25),
      event_manifest_sha256: fixedReceiptHash(26),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version: sourceVersion,
      active_deployment: receiptDeployment({
        id: fieldSourceDeploymentId,
        versionId: sourceVersion.version_id,
        requestHash: fixedReceiptHash(2),
        responseHash: fixedReceiptHash(27),
        readbackHash: fixedReceiptHash(28),
      }),
    },
    final_snapshot: receiptSnapshot(30),
  };
  assertDisposableRecoverySourcePhaseReceipt(receipt);
  return receipt;
}

function fullDisposableTargetPreflightReceipt(
  binding,
  sourcePhaseReceiptSha256,
  seedReceiptSha256,
) {
  const receipt = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_PROTOCOL,
    kind: "target_preflight",
    status: "passed",
    completed_at: "2026-09-11T13:50:00.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseReceiptSha256,
    seed_receipt_sha256: seedReceiptSha256,
    planned_requests: {
      target_paused_upload_sha256: fixedReceiptHash(40),
      target_active_upload_sha256: fixedReceiptHash(41),
      target_paused_deployment_sha256: fixedReceiptHash(42),
    },
    snapshot: receiptSnapshot(50),
  };
  assertDisposableRecoveryTargetPreflightReceipt(receipt);
  return receipt;
}

function fullDisposableDeploymentReceipt(
  binding,
  sourcePhaseReceipt,
  sourcePhaseReceiptSha256,
  seedReceiptSha256,
  targetPreflightReceiptSha256,
) {
  const pausedVersion = receiptVersion({
    id: fieldPausedWorkerVersionId,
    scriptEtag: "target-paused-etag-v048",
    requestHash: fixedReceiptHash(40),
    moduleHash: fixedReceiptHash(60),
    bindingHash: fixedReceiptHash(61),
    withoutModeHash: fixedReceiptHash(62),
    responseHash: fixedReceiptHash(63),
    readbackHash: fixedReceiptHash(64),
  });
  const activeVersion = receiptVersion({
    id: fieldActiveWorkerVersionId,
    scriptEtag: "target-active-etag-v048",
    requestHash: fixedReceiptHash(41),
    moduleHash: fixedReceiptHash(60),
    bindingHash: fixedReceiptHash(65),
    withoutModeHash: fixedReceiptHash(62),
    responseHash: fixedReceiptHash(66),
    readbackHash: fixedReceiptHash(67),
  });
  const receipt = {
    schema_version: 2,
    protocol: DISPOSABLE_RECOVERY_DEPLOYMENT_PROTOCOL,
    kind: "target_phase",
    status: "passed",
    completed_at: "2026-09-11T13:55:00.000Z",
    binding,
    source_phase_receipt_sha256: sourcePhaseReceiptSha256,
    seed_receipt_sha256: seedReceiptSha256,
    target_preflight_receipt_sha256: targetPreflightReceiptSha256,
    a4_approval_fingerprint: disposableRecoveryTargetA4Fingerprint(
      binding,
      sourcePhaseReceiptSha256,
      seedReceiptSha256,
      targetPreflightReceiptSha256,
    ),
    journal: {
      run_id: binding.run_id,
      through_sequence: 6,
      event_count: 6,
      source_prefix_head_sha256: sourcePhaseReceipt.journal.head_sha256,
      head_sha256: fixedReceiptHash(68),
      event_manifest_sha256: fixedReceiptHash(69),
    },
    source: {
      resource_fingerprint: binding.source_resource_fingerprint,
      active_version_id: sourcePhaseReceipt.source.active_version.version_id,
      active_script_etag: sourcePhaseReceipt.source.active_version.script_etag,
      active_deployment_id:
        sourcePhaseReceipt.source.active_deployment.deployment_id,
    },
    target: {
      resource_fingerprint: binding.target_resource_fingerprint,
      paused_version: pausedVersion,
      active_version: activeVersion,
      paused_deployment: receiptDeployment({
        id: fieldTargetDeploymentId,
        versionId: pausedVersion.version_id,
        requestHash: fixedReceiptHash(42),
        responseHash: fixedReceiptHash(70),
        readbackHash: fixedReceiptHash(71),
      }),
    },
    final_snapshot: receiptSnapshot(80),
  };
  assertDisposableRecoveryDeploymentReceipt(receipt);
  return receipt;
}

function writeDisposableTargetReceiptPair({
  binding,
  deploymentReceiptPath,
  seedReceiptPath,
  sourcePhaseReceipt,
  sourcePhaseReceiptPath,
  targetPreflightReceiptPath,
}) {
  const sourcePhaseReceiptSha256 = hash(readFileSync(sourcePhaseReceiptPath));
  const seedReceiptSha256 = hash(readFileSync(seedReceiptPath));
  writePrivateJson(
    targetPreflightReceiptPath,
    fullDisposableTargetPreflightReceipt(
      binding,
      sourcePhaseReceiptSha256,
      seedReceiptSha256,
    ),
  );
  const targetPreflightReceiptSha256 =
    hash(readFileSync(targetPreflightReceiptPath));
  writePrivateJson(
    deploymentReceiptPath,
    fullDisposableDeploymentReceipt(
      binding,
      sourcePhaseReceipt,
      sourcePhaseReceiptSha256,
      seedReceiptSha256,
      targetPreflightReceiptSha256,
    ),
  );
  return Object.freeze({
    sourcePhaseReceiptSha256,
    seedReceiptSha256,
    targetPreflightReceiptSha256,
    deploymentReceiptSha256: hash(readFileSync(deploymentReceiptPath)),
  });
}

function fullDisposableSeedReceipt(binding, {
  chunks = 7_202,
  contentFingerprint = deterministicDataFingerprint,
} = {}) {
  const receipt = {
    schema_version: 4,
    protocol: "disposable-recovery-seed-receipt-v2",
    status: "passed",
    completed_at: "2026-09-11T13:45:00.000Z",
    data_class: "deterministic_fictional_synthetic_only",
    binding,
    source_deployment: {
      source_phase_receipt_sha256: binding.source_phase_receipt_sha256,
      source_phase_run_id: binding.source_phase_run_id,
      source_a2_approval_fingerprint: binding.source_a2_approval_fingerprint,
      source_resource_fingerprint: binding.source_resource_fingerprint,
      source_active_version_id: binding.source_active_version_id,
      source_script_etag: binding.source_script_etag,
      source_deployment_id: binding.source_deployment_id,
      source_active_traffic_percent: 100,
    },
    fixture: {
      sha256: DISPOSABLE_RECOVERY_FIXTURE_SHA256,
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      maximum_batch_documents: 50,
    },
    ingest: {
      accepted_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      created_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      unchanged_documents: 0,
      updated_documents: 0,
      refused_documents: 0,
      failed_documents: 0,
    },
    verification_replay: {
      batches: DISPOSABLE_RECOVERY_SEED_BATCHES,
      unchanged_documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      exact_identity_and_content_replay: true,
    },
    opening_d1: {
      documents: 0,
      chunks: 0,
      fts: 0,
      pending_outbox: 0,
      failed_vectors: 0,
      independently_verified_empty: true,
    },
    d1: {
      worker_version: "0.4.8",
      documents: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      chunks,
      fts: chunks,
      minimum_chunks: DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
      document_counts_exact: true,
      chunk_counts_exact: true,
      minimum_chunk_count_met: true,
      pending_outbox: 0,
      failed_vectors: 0,
      content_fingerprint: contentFingerprint,
      content_fingerprint_source: "direct_d1_normalized_export",
    },
    projection: {
      vectorize_vectors: chunks,
      vector_dimensions: 768,
      vector_metric: "cosine",
      quarantined_vectors: 0,
      independent_control_plane: true,
    },
    evaluation: {
      supported_case_cited: true,
      unsupported_case_refused: true,
    },
    proof_boundary: {
      external_source_input: false,
      aggregate_only: true,
      authenticated_d1_inventory_verified: true,
      direct_d1_opening_empty_verified: true,
      worker_vector_readiness_verified: true,
      direct_d1_content_fingerprint_verified: true,
      vectorize_proven: true,
      retrieval_proven: true,
      recovery_proven: false,
    },
  };
  assert.equal(assertDisposableRecoverySeedReceipt(receipt), true);
  return receipt;
}
const historicalFamilyDataExport = `INSERT INTO "sources"
  ("name","kind","status","created_at")
  VALUES ('localdocs','upload','ready','2026-09-11T00:00:00Z');
INSERT INTO "source_original_observations"
  ("contract_version","tenant_id","source","original_id","locator_kind","run_id","plan_id",
   "source_snapshot_id","target_set_hash","target_count","observation_stage","outcome","reason_code",
   "text_state","original_content_sha256","original_byte_count","page_count","page_count_state",
   "result_document_count","result_document_set_hash","resolves_observation_hash","observation_hash",
   "recorded_at")
  VALUES
    (1,'primary','localdocs','hmac-sha256:${"1".repeat(64)}','source_relative_path',
     'historical_gap','${"9".repeat(64)}','sha256:${"0".repeat(64)}','sha256:${"9".repeat(64)}',1,
     'discovery','gap','provenance_unassessed','native_readable','${"3".repeat(64)}',123,NULL,
     'not_applicable',0,'sha256:${"0".repeat(64)}',NULL,'sha256:${"c".repeat(64)}',6),
    (1,'primary','localdocs','hmac-sha256:${"1".repeat(64)}','source_relative_path',
     'historical_repair','${"9".repeat(64)}','sha256:${"0".repeat(64)}','sha256:${"9".repeat(64)}',1,
     'repair','accepted','accepted_provenance_verified','native_readable','${"3".repeat(64)}',123,NULL,
     'not_applicable',1,'sha256:${"a".repeat(64)}','sha256:${"c".repeat(64)}',
     'sha256:${"d".repeat(64)}',9);
INSERT INTO "documents"
  ("doc_uid","source","source_id","title","ingested_at","content_hash","meta","deleted_at",
   "text_source","text_reliable","provenance_receipt_version","provenance_receipt_status",
   "provenance_receipt_reason","provenance_receipt_digest","document_revision_id",
   "source_original_binding_hash")
  VALUES ('localdocs:historical','localdocs','historical','Historical fixture',7,'${"4".repeat(64)}','{}',10,
          'native',1,1,'complete','lineage_and_text_recorded','${"5".repeat(64)}',
          'rev-v1:${"2".repeat(64)}','sha256:${"6".repeat(64)}');
INSERT INTO "chunks"
  ("chunk_uid","doc_uid","chunk_ix","text","source","title","vector_id",
   "bound_document_revision_id","result_chunk_receipt_hash")
  VALUES ('localdocs:historical#0','localdocs:historical',0,
          '[Historical fixture]' || char(10) || char(10) || 'Recovered body.',
          'localdocs','Historical fixture','localdocs:historical#0',
          'rev-v1:${"2".repeat(64)}','sha256:${"7".repeat(64)}');
INSERT INTO "source_original_result_bindings"
  ("contract_version","tenant_id","source","original_id","locator_kind","document_revision_id",
   "original_content_sha256","original_byte_count","document_content_hash",
   "provenance_receipt_digest","binding_hash","bound_at")
  VALUES (1,'primary','localdocs','hmac-sha256:${"1".repeat(64)}','source_relative_path',
          'rev-v1:${"2".repeat(64)}','${"3".repeat(64)}',123,'${"4".repeat(64)}',
          '${"5".repeat(64)}','sha256:${"6".repeat(64)}',7);
INSERT INTO "source_original_result_family_members"
  ("family_receipt_hash","document_revision_id","source_original_binding_hash","chunk_ix","chunk_receipt_hash")
  VALUES ('sha256:${"8".repeat(64)}','rev-v1:${"2".repeat(64)}','sha256:${"6".repeat(64)}',0,
          'sha256:${"7".repeat(64)}');
INSERT INTO "source_original_result_family_receipts"
  ("contract_version","tenant_id","source","original_id","locator_kind","original_content_sha256",
   "original_byte_count","document_count","document_set_hash","chunk_count","chunk_set_hash",
   "family_receipt_hash","sealed_at")
  VALUES (1,'primary','localdocs','hmac-sha256:${"1".repeat(64)}','source_relative_path',
          '${"3".repeat(64)}',123,1,'sha256:${"a".repeat(63)}b',1,'sha256:${"b".repeat(64)}',
          'sha256:${"8".repeat(64)}',8);
INSERT INTO "source_original_accepted_resolutions"
  ("contract_version","tenant_id","source","original_id","locator_kind","original_content_sha256",
   "original_byte_count","resolves_observation_hash","accepted_observation_hash","result_document_count",
   "result_document_set_hash","family_receipt_hash","admission_verification_hash","resolution_hash",
   "admitted_at")
  VALUES (1,'primary','localdocs','hmac-sha256:${"1".repeat(64)}','source_relative_path',
          '${"3".repeat(64)}',123,'sha256:${"c".repeat(64)}','sha256:${"d".repeat(64)}',1,
          'sha256:${"a".repeat(64)}','sha256:${"8".repeat(64)}','sha256:${"e".repeat(64)}',
          'sha256:${"f".repeat(64)}',9);
`;
const expectedSnapshot = Object.freeze({
  integrity: "ok",
  schema_fingerprint: hash(canonical({ migrations: appliedMigrations, schema: schemaRows })),
  aggregate_fingerprint: hash(canonical(aggregateTemplate)),
  document_count: 3,
  chunk_count: 5,
  fts_count: 5,
  content_fingerprint: deterministicDataFingerprint,
});

const emptyBankProof = { protocol: "bank-security-v1", proofs: [] };

// Only provider identity/export transport is scripted below. Bank reads and
// writes traverse the actual Worker and all real SQLite migrations.
async function recoveryBankFixture() {
  const db = new DatabaseSync(":memory:");
  for (const migration of appliedMigrations) {
    db.exec(readFileSync(join(process.cwd(), "migrations", "d1", `${migration.name}.sql`), "utf8"));
  }
  const fixture = { db, loseAfter: null, lossRemaining: 0, afterResponse: null, afterProof: null, writes: 0 };
  const env = {
    ADMIN_KEY: fixtureAdminKey,
    SESSION_SIGNING_KEY: "fixture-readable-legacy-key",
    [BANK_ACCESS_WRAPPING_KEY_SECRET]: `v2.${Buffer.alloc(32, 7).toString("base64url")}`,
    BRAIN_NAME: "fixture-brain", VECTOR_DRAIN_MODE: "paused-for-upgrade",
    DB: { prepare(sql) {
      const shape = (params = []) => ({
        bind: (...next) => shape(next),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => {
          const result = db.prepare(sql).run(...params);
          const kind = /SET access_ciphertext/.test(sql) ? "rewrap" : /SET status = 'reauth_required'/.test(sql) ? "reauth" : null;
          if (kind && result.changes) fixture.writes++;
          if (kind === fixture.loseAfter && fixture.lossRemaining > 0 && result.changes) {
            fixture.lossRemaining--;
            throw new Error("synthetic response loss after durable bank write");
          }
          return { meta: { changes: Number(result.changes) } };
        },
      });
      return shape();
    } },
  };
  fixture.env = env;
  for (let id = 1; id <= 4; id++) {
    const sealed = await encryptAccessReference(id % 2 ? env : {
      ...env, SESSION_SIGNING_KEY: "fixture-unavailable-original-key",
    }, `synthetic-bank-reference-${id}`, { keyVersion: 1 });
    db.prepare(`INSERT INTO bank_feed_items
      (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
      VALUES ('primary',?,?,?,?, 'sandbox','2026-08-25T00:00:00.000Z')`)
      .run(`synthetic-item-${id}`, sealed.ciphertext, sealed.iv, sealed.keyVersion);
  }
  fixture.exportData = () => `${deterministicDataExport}-- ${canonical(db.prepare("SELECT * FROM bank_feed_items ORDER BY id").all())}\n`;
  fixture.request = async (url, options) => {
    const response = await Worker.fetch(new Request(url, options), env, {});
    if (new URL(url).pathname.endsWith("/reconcile-recovery") && response.status === 200 && fixture.afterResponse) {
      const effect = fixture.afterResponse;
      fixture.afterResponse = null;
      await effect();
    }
    if (new URL(url).pathname.endsWith("/recovery-key-proof") && options.body && response.status === 200 && fixture.afterProof) {
      const effect = fixture.afterProof;
      fixture.afterProof = null;
      await effect();
    }
    return response;
  };
  return fixture;
}

function snapshotForCounts(documentCount, chunkCount) {
  const aggregate = {
    ...aggregateTemplate,
    documents: String(documentCount),
    chunks: String(chunkCount),
    chunks_fts: String(chunkCount),
    chunks_id_max: String(chunkCount),
    chunks_text_bytes: String(chunkCount * 100),
  };
  return Object.freeze({
    ...expectedSnapshot,
    aggregate_fingerprint: hash(canonical(aggregate)),
    document_count: documentCount,
    chunk_count: chunkCount,
    fts_count: chunkCount,
  });
}

function snapshotForChunkCount(chunkCount) {
  return snapshotForCounts(expectedSnapshot.document_count, chunkCount);
}

// Exercise the normalization projection against real SQLite, not only the
// provider harness. A live lease and mutation fence are invocation-local and
// never enter the artifact; a nonempty corpus receives its exact binary-order
// high-water so a resumed restore can advance the durable bootstrap cursor.
{
  const source = new DatabaseSync(":memory:");
  const destination = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations", "d1");
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    source.exec(sql);
    destination.exec(sql);
  }
  source.exec(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring,
        vector_drain_lease_owner,vector_drain_lease_expires_at,
        vector_projection_mutation_id,vector_projection_submitted_at)
     VALUES (1,'fixture-brain','0.1.12',13,4,'2026-08-25T12:00:00.000Z','stable',
             'raw-live-owner-must-not-export',999999,'raw-live-mutation-must-not-export',888888);
     INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
     VALUES ('fixture:doc','fixture','doc',1,'hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source)
     VALUES ('fixture:chunk#0004','fixture:doc',0,'restored fixture text','fixture');
     DELETE FROM vector_outbox;
     UPDATE install_state
        SET vector_projection_status='verified',
            vector_projection_bootstrap_epoch=7,
            vector_projection_bootstrap_cursor='fixture:chunk#0004',
            vector_projection_bootstrap_high_water='fixture:chunk#0004',
            vector_projection_bootstrap_protocol='bootstrap-v2',
            vector_projection_bootstrap_base_count=1;
     INSERT INTO vector_bootstrap_batches
       (epoch,batch_no,start_cursor,end_cursor,row_count,status,mutation_id,submitted_at,confirmed_at)
     VALUES (7,1,'','fixture:chunk#0004',1,'confirmed','source-only-mutation',1,2);`,
  );
  const readRows = async (_binding, sql) => source.prepare(sql).all();
  const first = await normalizedInstallStateExport({}, appliedMigrations, readRows);
  source.prepare(
    `UPDATE install_state
        SET outbox_generation=123456,
            source_original_retrieval_generation=source_original_retrieval_generation+1,
            vector_drain_lease_owner='different-live-owner',
            vector_drain_lease_expires_at=111111,
            vector_projection_mutation_id='different-live-mutation',
            vector_projection_submitted_at=222222
      WHERE id=1`,
  ).run();
  const retry = await normalizedInstallStateExport({}, appliedMigrations, readRows);
  assert.deepEqual(first, retry);
  const sql = first.toString("utf8");
  assert.equal(sql.includes("raw-live-owner-must-not-export"), false);
  assert.equal(sql.includes("different-live-owner"), false);
  assert.equal(sql.includes("bootstrap-v2"), false);
  assert.equal(sql.includes("source-only-mutation"), false);
  destination.exec(sql);
  assert.deepEqual({ ...destination.prepare(
    `SELECT outbox_generation generation,
            vector_drain_lease_owner owner,
            vector_drain_lease_expires_at expires,
            vector_projection_mutation_id mutation,
            vector_projection_submitted_at submitted,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water,
            vector_projection_bootstrap_protocol protocol,
            vector_projection_bootstrap_base_count base_count,
            session_generation session_generation,
            source_original_retrieval_generation retrieval_generation,
            (SELECT count(*) FROM vector_bootstrap_batches) batch_count
       FROM install_state WHERE id=1`,
  ).get() }, {
    generation: 0,
    owner: null,
    expires: null,
    mutation: null,
    submitted: null,
    status: "bootstrap_required",
    epoch: 1,
    cursor: null,
    high_water: "fixture:chunk#0004",
    protocol: null,
    base_count: 0,
    session_generation: 2,
    retrieval_generation: 0,
    batch_count: 0,
  });
  destination.exec(
    `INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
     VALUES ('fixture:doc','fixture','doc',1,'hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source)
     VALUES ('fixture:chunk#0004','fixture:doc',0,'restored fixture text','fixture');
     DELETE FROM vector_outbox;`,
  );
  const restoredReadRows = async (_binding, statement) => destination.prepare(statement).all();
  const preserved = await normalizedInstallStateExport(
    {},
    appliedMigrations,
    restoredReadRows,
    { sessionGenerationMode: "preserve" },
  );
  assert.deepEqual(preserved, first);
  source.prepare("UPDATE install_state SET session_generation=? WHERE id=1")
    .run(Number.MAX_SAFE_INTEGER);
  await assert.rejects(
    normalizedInstallStateExport({}, appliedMigrations, readRows),
    (error) => error.code === "RECOVERY_INSTALL_STATE_INVALID",
  );
  source.prepare("UPDATE install_state SET session_generation=0 WHERE id=1").run();
  await assert.rejects(
    normalizedInstallStateExport({}, appliedMigrations, readRows),
    (error) => error.code === "RECOVERY_INSTALL_STATE_INVALID",
  );
  source.close();
  destination.close();
}

// Historical schema-12 artifacts remain inspectable offline. The projection
// must not mention schema-13 columns while still resetting the visibility
// bootstrap for a fresh derived index.
{
  const source = new DatabaseSync(":memory:");
  const destination = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations", "d1");
  const migrationNames = readdirSync(migrationDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .slice(0, 12);
  for (const name of migrationNames) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    source.exec(sql);
    destination.exec(sql);
  }
  source.exec(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
     VALUES (1,'prefix-brain','0.1.14',12,4,'2026-08-25T12:00:00.000Z','stable');
     INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash)
     VALUES ('prefix:doc','fixture','doc',1,'prefix-hash');
     INSERT INTO chunks (chunk_uid,doc_uid,chunk_ix,text,source)
     VALUES ('prefix:chunk#0001','prefix:doc',0,'prefix fixture text','fixture');`,
  );
  const prefixMigrations = appliedMigrations.slice(0, 12);
  const readRows = async (_binding, sql) => source.prepare(sql).all();
  const normalized = await normalizedInstallStateExport({}, prefixMigrations, readRows);
  const sql = normalized.toString("utf8");
  assert.equal(sql.includes("vector_projection_bootstrap_protocol"), false);
  assert.equal(sql.includes("vector_projection_bootstrap_base_count"), false);
  assert.equal(sql.includes("vector_bootstrap_batches"), false);
  destination.exec(sql);
  assert.deepEqual({ ...destination.prepare(
    `SELECT schema_version,
            vector_projection_status status,
            vector_projection_bootstrap_epoch epoch,
            vector_projection_bootstrap_cursor cursor,
            vector_projection_bootstrap_high_water high_water
       FROM install_state WHERE id=1`,
  ).get() }, {
    schema_version: 12,
    status: "bootstrap_required",
    epoch: 1,
    cursor: null,
    high_water: "prefix:chunk#0001",
  });
  normalized.fill(0);
  source.close();
  destination.close();
}

// Schema 44 predates the deployment-local retrieval generation. Its recovery
// projection must remain an exact historical prefix and never mention the
// schema-45-only install-state column.
{
  const source = new DatabaseSync(":memory:");
  const destination = new DatabaseSync(":memory:");
  const migrationDirectory = join(process.cwd(), "migrations", "d1");
  const migrationNames = readdirSync(migrationDirectory)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .slice(0, 44);
  for (const name of migrationNames) {
    const sql = readFileSync(join(migrationDirectory, name), "utf8");
    source.exec(sql);
    destination.exec(sql);
  }
  source.exec(
    `INSERT INTO install_state
       (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
     VALUES (1,'schema44-brain','0.1.14',44,4,'2026-08-25T12:00:00.000Z','stable')`,
  );
  const prefixMigrations = appliedMigrations.slice(0, 44);
  const normalized = await normalizedInstallStateExport(
    {},
    prefixMigrations,
    async (_binding, sql) => source.prepare(sql).all(),
  );
  const sql = normalized.toString("utf8");
  assert.equal(sql.includes("source_original_retrieval_generation"), false);
  destination.exec(sql);
  assert.equal(
    destination.prepare("SELECT schema_version FROM install_state WHERE id=1").get().schema_version,
    44,
  );
  normalized.fill(0);
  source.close();
  destination.close();
}

await assert.rejects(
  normalizedInstallStateExport({}, appliedMigrations, async (_binding, sql) => {
    if (/PRAGMA table_info/.test(sql)) {
      return installStateColumns.map(([name, type], cid) => ({ cid, name, type }));
    }
    if (/FROM install_state ORDER BY id/.test(sql)) return [];
    throw new Error(`unexpected singleton fixture SQL: ${sql}`);
  }),
  (error) => error.code === "RECOVERY_INSTALL_STATE_INVALID",
);

function releaseGolden() {
  const questions = [];
  for (let index = 0; index < 60; index++) {
    const kind = index < 30 ? "answerable" : "unanswerable";
    questions.push({
      id: `fixture-${index + 1}`,
      kind,
      query_kind: kind,
      risk: "critical",
      domains: ["fixture"],
      formats: ["text"],
      question: index === 0 ? privateSentinel : `fixture question ${index + 1}`,
      ...(kind === "answerable"
        ? { expect: [{ doc: "Fixture document", source: "fixture" }] }
        : {}),
    });
  }
  return {
    schema_version: 1,
    release_slices: {
      risk: ["critical"],
      domain: ["fixture"],
      format: ["text"],
      query_kind: ["answerable", "unanswerable"],
    },
    questions,
  };
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function providerHarness({
  ambiguousSourceD1 = false,
  activeScriptEtag = null,
  activeVersionMode = null,
  bankKeyProofMismatch = false,
  bankFixture = null,
  bankProofTransform = (proof) => proof,
  bootstrapMutatesCorpus = false,
  bootstrapBusyOnce = false,
  bootstrapPageSize = 3_000,
  bootstrapReceiptTransform = (receipt) => receipt,
  busyReceiptTransform = (receipt) => receipt,
  deploymentChangesDuringEval = false,
  redirectHealth = false,
  redirectInventory = false,
  extraTargetSecret = false,
  extraTargetBinding = false,
  failEvalOnce = false,
  failBootstrapOnce = false,
  failBootstrapAfterProgressOnce = false,
  failPromotionAfterApplyOnce = false,
  healthModeOverride = null,
  healthProtocolOverride = null,
  healthTransform = (health) => health,
  initialAgentActionReceipts = 0,
  initialBootstrapConfirmed = null,
  initialTargetRestored = false,
  initialVectorCount = 0,
  missingVectorCount = false,
  pausedVersionMode = "paused-for-upgrade",
  pausedScriptEtag = null,
  plainTextOverrides = {},
  promotionNoop = false,
  readinessLagAfterBootstrap = false,
  recoveryArtifactKey = fixtureRecoveryArtifactKey,
  sourceDrainLease = false,
  sourceFamilyRecoveryStateActive = false,
  targetFamilyRecoveryStateActive = false,
  dataExport = deterministicDataExport,
  inspectCombinedArtifact = null,
  sourceWrappingSecret = false,
  partialZoomSecretGroup = false,
  zoomSecretGroup = false,
  // Current-protocol installs report whatever the newest real migration is,
  // so a new additive migration never breaks these fixtures (found 13 -> 14).
  sourceMigrationVersion = appliedMigrations.at(-1).version,
  targetChunkCount = 5,
  targetDocumentCount = 3,
  sourceChunkCount = targetChunkCount,
  sourceDocumentCount = targetDocumentCount,
  targetMigrationVersion = appliedMigrations.at(-1).version,
  sourceInstallStateMissing = false,
  sourceScriptEtagOverride = null,
  sourceVersionId = null,
  splitTargetDeployment = false,
  targetVersionId = null,
  wranglerVersion = "4.131.1",
  sourceManifestFixture = sourceManifest,
  targetManifestFixture = targetManifest,
} = {}) {
  const fieldCampaign = sourceManifestFixture.client?.slug === "v048-field-proof";
  const sourceVersion = sourceVersionId ??
    (fieldCampaign ? fieldSourceWorkerVersionId : sourceWorkerVersionId);
  const pausedVersion = fieldCampaign ? fieldPausedWorkerVersionId : pausedWorkerVersionId;
  const activeVersion = fieldCampaign ? fieldActiveWorkerVersionId : activeWorkerVersionId;
  const campaignPausedScriptEtag = fieldCampaign
    ? "target-paused-etag-v048"
    : pausedWorkerScriptEtag;
  const effectiveSourceScriptEtag = sourceScriptEtagOverride ??
    (fieldCampaign ? "source-etag-v048" : sourceWorkerScriptEtag);
  const effectivePausedScriptEtag = pausedScriptEtag ?? campaignPausedScriptEtag;
  const effectiveActiveScriptEtag = activeScriptEtag ??
    (fieldCampaign ? "target-active-etag-v048" : activeWorkerScriptEtag);
  let agentActionReceipts = initialAgentActionReceipts;
  let targetRestored = initialTargetRestored;
  let vectorCount = initialVectorCount;
  let outbox = 0;
  let bootstrapRequired = initialTargetRestored && initialVectorCount < targetChunkCount;
  let bootstrapEpoch = 1;
  let bootstrapConfirmed = initialBootstrapConfirmed ?? initialVectorCount;
  let bootstrapCursor = bootstrapConfirmed > 0
    ? `fixture:chunk#${String(Math.max(0, bootstrapConfirmed - 1)).padStart(8, "0")}`
    : null;
  let bootstrapProtocol = bootstrapConfirmed > 0 ? "bootstrap-v2" : null;
  let currentTargetVersionId = targetVersionId ?? pausedVersion;
  let corpusMutated = false;
  let evalCalls = 0;
  let evalFailuresRemaining = failEvalOnce ? 1 : 0;
  let adminReads = 0;
  let importCalls = 0;
  let bootstrapFailuresRemaining = failBootstrapOnce ? 1 : 0;
  let postProgressBootstrapFailuresRemaining = failBootstrapAfterProgressOnce ? 1 : 0;
  let bootstrapBusyRemaining = bootstrapBusyOnce ? 1 : 0;
  let readinessLagRemaining = readinessLagAfterBootstrap ? 1 : 0;
  let promotionFailuresRemaining = failPromotionAfterApplyOnce ? 1 : 0;
  let bootstrapCalls = 0;
  let holdBootstrapProgressOnce = false;
  let mutateBootstrapCursorWithoutOrdinalOnce = null;
  let mutateBootstrapHighWaterWithoutOrdinalOnce = null;
  let observedBootstrapHighWaterPosition = targetChunkCount;
  let observedBootstrapBaseCount = 0;
  let observedBootstrapBatchRows = null;
  let promotionCalls = 0;
  let sleepCalls = 0;
  let normalizedLeaseSelections = 0;
  let wranglerRuntimeMaterializations = 0;
  const wranglerCalls = [];
  const fetchCalls = [];
  const observerSnapshots = [];
  const openingSnapshots = [];
  const sensitiveBuffers = [];
  const sourceSnapshot = snapshotForCounts(sourceDocumentCount, sourceChunkCount);

  const bindingForAccount = (accountId) => accountId === sourceManifestFixture.infrastructure.cloudflare.account_id
    ? sourceManifestFixture.infrastructure.cloudflare
    : targetManifestFixture.infrastructure.cloudflare;
  const migrationVersionForAccount = (accountId) =>
    accountId === sourceManifestFixture.infrastructure.cloudflare.account_id
      ? sourceMigrationVersion
      : targetMigrationVersion;
  const mapTables = new Set([
    "owner_financial_map_key_state",
    "owner_financial_map_inventory_state",
    "owner_financial_map_previews",
    "owner_financial_map_snapshots",
  ]);
  const sourceOriginalTables = new Set([
    "source_original_id_key_state",
    "source_original_observations",
  ]);
  const sourceOriginalResultFamilyTables = new Set([
    "source_original_result_family_members",
    "source_original_result_family_receipts",
    "source_original_result_family_verifications",
    "source_original_result_family_recovery_state",
  ]);
  const sourceOriginalAcceptedResolutionTables = new Set([
    "source_original_accepted_resolution_admissions",
    "source_original_accepted_resolutions",
    "source_original_accepted_resolution_activations",
  ]);
  const durableTablesForVersion = (version) => RECOVERY_DURABLE_TABLES.filter((name) =>
    (version >= 37 || name !== "memory_supersessions") &&
    (version >= 41 || !mapTables.has(name)) &&
    (version >= 42 || !sourceOriginalTables.has(name)) &&
    (version >= 43 || name !== "source_original_result_bindings") &&
    (version >= 44 || !sourceOriginalResultFamilyTables.has(name)) &&
    (version >= 45 || !sourceOriginalAcceptedResolutionTables.has(name)));

  const runWrangler = async ({ command, args, env, cwd }) => {
    wranglerCalls.push({ command, args: [...args], env: { ...env }, cwd });
    assert.equal(Object.hasOwn(env, "CLOUDFLARE_API_TOKEN"), false);
    assert.equal(Object.hasOwn(env, "ADMIN_KEY"), false);
    assert.equal(Object.keys(env).some((name) => /SUPABASE|ANTHROPIC/.test(name)), false);
    assert.equal(env.WRANGLER_LOG_SANITIZE, "true");
    assert.equal(env.WRANGLER_LOG, "log");
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id ||
      env.CLOUDFLARE_ACCOUNT_ID === targetManifestFixture.infrastructure.cloudflare.account_id, true);
    if (Object.hasOwn(env, "BRAIN_RECOVERY_WRANGLER_ENTRYPOINT")) {
      assert.equal(env.BRAIN_RECOVERY_NODE, process.execPath);
      assert.equal(
        env.BRAIN_RECOVERY_WRANGLER_ENTRYPOINT,
        resolve(cwd, "wrangler-runtime", LOCKED_WRANGLER_ENTRYPOINT),
      );
      assert.equal(command, resolve(cwd, "wrangler-pinned"));
      assert.equal(
        env.BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD,
        resolve(cwd, "wrangler-runtime", LOCKED_WRANGLER_RESOLUTION_GUARD),
      );
      const executedWrapper = readFileSync(command, "utf8");
      assert.match(
        executedWrapper,
        /^#!\/bin\/sh\nCLOUDFLARE_API_TOKEN="\$\(\/usr\/bin\/security find-generic-password -a '[A-Za-z0-9._:@/-]+' -s '[A-Za-z0-9._:@/-]+' -w\)" \|\| exit 125\n\[ -n "\$CLOUDFLARE_API_TOKEN" \] \|\| exit 125\nexport CLOUDFLARE_API_TOKEN\nexec /,
      );
    }
    writeFileSync(join(env.WRANGLER_LOG_PATH, "fixture.log"), "aggregate-only fixture log\n", { mode: 0o600 });

    const ok = (payload = "") => {
      const stdout = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      const stderr = Buffer.from(privateSentinel);
      sensitiveBuffers.push(stderr);
      return { status: 0, stdout, stderr };
    };
    if (args[0] === "--version") return ok(`${wranglerVersion}\n`);
    for (const flag of [
      "--experimental-provision=false",
      "--experimental-auto-create=false",
    ]) assert.equal(args.includes(flag), true);
    // Wrangler 4.73 rejects this obsolete flag before executing even a
    // read-only JSON command. The pinned local wrapper already prevents any
    // package or skill installation path.
    assert.equal(args.includes("--install-skills=false"), false);

    const cloudflare = bindingForAccount(env.CLOUDFLARE_ACCOUNT_ID);
    if (args[0] === "d1" && args[1] === "list") {
      const row = { name: cloudflare.d1_database_name, uuid: cloudflare.d1_database_id };
      return ok(ambiguousSourceD1 && env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id
        ? [row, { ...row }]
        : [row]);
    }
    if (args[0] === "vectorize" && args[1] === "list") {
      return ok([{ name: cloudflare.vectorize_index, config: { dimensions: 768, metric: "cosine" } }]);
    }
    if (args[0] === "vectorize" && args[1] === "info") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
      return ok({
        dimensions: 768,
        ...(!isSource && missingVectorCount
          ? {}
          : { vectorCount: isSource ? 5 : vectorCount }),
      });
    }
    if (args[0] === "deployments" && args[1] === "status") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
      if (!isSource && splitTargetDeployment) {
        return ok({ versions: [
          { version_id: pausedVersion, percentage: 50 },
          { version_id: activeVersion, percentage: 50 },
        ] });
      }
      return ok({ versions: [{
        version_id: isSource ? sourceVersion : currentTargetVersionId,
        percentage: 100,
      }] });
    }
    if (args[0] === "versions" && args[1] === "view") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
      const manifest = isSource ? sourceManifestFixture : targetManifestFixture;
      const requestedVersionId = args[2];
      const targetMode = requestedVersionId === pausedVersion
        ? pausedVersionMode
        : requestedVersionId === activeVersion
          ? activeVersionMode
          : null;
      const scriptEtag = isSource
        ? effectiveSourceScriptEtag
        : requestedVersionId === pausedVersion
          ? effectivePausedScriptEtag
          : effectiveActiveScriptEtag;
      return ok({
        id: requestedVersionId,
        resources: {
          script: {
            etag: scriptEtag,
            handlers: ["fetch", "scheduled"],
            last_deployed_from: "api",
            named_handlers: [],
          },
          script_runtime: {
            compatibility_date: "2026-01-01",
            usage_model: "standard",
          },
          bindings: [
            {
              type: "d1",
              name: "DB",
              id: cloudflare.d1_database_id,
              database_id: cloudflare.d1_database_id,
            },
            { type: "ai", name: "AI", project: "<catalog>" },
            { type: "vectorize", name: "VECTORIZE", index_name: cloudflare.vectorize_index },
            { type: "plain_text", name: "STORAGE", text: "d1" },
            { type: "plain_text", name: "BRAIN_NAME", text: manifest.client.slug },
            { type: "plain_text", name: "BRAIN_OWNER",
              text: plainTextOverrides.BRAIN_OWNER ?? manifest.client.display_name },
            { type: "plain_text", name: "BRAIN_VERSION", text: manifest.brain.version },
            { type: "plain_text", name: "CHUNK_SIZE",
              text: plainTextOverrides.CHUNK_SIZE ?? "1500" },
            { type: "plain_text", name: "CHUNK_OVERLAP",
              text: plainTextOverrides.CHUNK_OVERLAP ?? "300" },
            { type: "plain_text", name: "DAILY_LLM_CAP_USD",
              text: plainTextOverrides.DAILY_LLM_CAP_USD ?? "10" },
            {
              type: "plain_text",
              name: "ANSWER_MODEL",
              text: plainTextOverrides.ANSWER_MODEL ??
                "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            },
            { type: "plain_text", name: "CREDENTIAL_SCANNER",
              text: plainTextOverrides.CREDENTIAL_SCANNER ?? "on" },
            {
              type: "plain_text",
              name: "OCR_ENABLED",
              text: plainTextOverrides.OCR_ENABLED ??
                (manifest.safety?.ocr?.enabled === true ? "1" : "0"),
            },
            {
              type: "plain_text",
              name: "OCR_MODEL",
              text: plainTextOverrides.OCR_MODEL ??
                (manifest.safety?.ocr?.model || "@cf/google/gemma-4-26b-a4b-it"),
            },
            { type: "secret_text", name: "ADMIN_KEY" },
            { type: "secret_text", name: "RAG_PROXY_KEY" },
            { type: "secret_text", name: "SESSION_SIGNING_KEY" },
            ...(zoomSecretGroup
              ? ZOOM_CREDENTIAL_ENV.map((name) => ({ type: "secret_text", name }))
              : partialZoomSecretGroup
                ? [{ type: "secret_text", name: ZOOM_CREDENTIAL_ENV[0] }]
                : []),
            ...(!isSource || sourceWrappingSecret
              ? [{ type: "secret_text", name: "BANK_FEED_WRAPPING_KEY_V2" }]
              : []),
            ...(!isSource && targetMode !== null
              ? [{ type: "plain_text", name: "VECTOR_DRAIN_MODE", text: targetMode }]
              : []),
            ...(!isSource && extraTargetSecret
              ? [{ type: "secret_text", name: "UNREVIEWED_SECRET" }]
              : []),
            ...(!isSource && extraTargetBinding
              ? [{ type: "plain_text", name: "UNREVIEWED_MODE", text: "enabled" }]
              : []),
          ],
        },
      });
    }
    if (args[0] === "versions" && args[1] === "deploy") {
      assert.deepEqual(args.slice(0, 6), [
        "versions", "deploy", `${activeVersion}@100%`,
        "--name", targetManifestFixture.brain.worker_name, "-y",
      ]);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, targetManifestFixture.infrastructure.cloudflare.account_id);
      promotionCalls++;
      if (!promotionNoop) currentTargetVersionId = activeVersion;
      if (promotionFailuresRemaining > 0) {
        promotionFailuresRemaining--;
        return { status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from("synthetic lost promotion response") };
      }
      return ok();
    }
    if (args[0] === "d1" && args[1] === "export") {
      // Wrangler 4.73 removed --skip-confirmation from d1 export. Export has no
      // confirmation option, while restore continues to use d1 execute --yes.
      assert.equal(args.includes("--skip-confirmation"), false);
      const output = args[args.indexOf("--output") + 1];
      const exportedTables = args
        .map((value, index) => value === "--table" ? args[index + 1] : null)
        .filter(Boolean);
      const includesBank = exportedTables.includes("bank_feed_items");
      const present = new Set(durableTablesForVersion(migrationVersionForAccount(env.CLOUDFLARE_ACCOUNT_ID)));
      assert.deepEqual(exportedTables, RECOVERY_EXPORT_TABLES.filter((table) =>
        present.has(table) && (includesBank || table !== "bank_feed_items")));
      assert.equal(exportedTables.includes("vector_outbox"), false);
      assert.equal(exportedTables.includes("vector_bootstrap_batches"), false);
      assert.equal(exportedTables.includes("install_state"), false);
      assert.equal(exportedTables.includes("document_source_inventory"), false);
      assert.equal(exportedTables.includes("agent_action_receipts"), false);
      writeFileSync(
        output,
        `${includesBank && bankFixture ? bankFixture.exportData() : dataExport}${corpusMutated ? "\n-- synthetic corpus mutation\n" : ""}`,
        { mode: 0o600 },
      );
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--file")) {
      const importPath = args[args.indexOf("--file") + 1];
      assert.match(importPath, /\.brain-recovery-plaintext\.tmp-[0-9a-f]+$/);
      const importSql = readFileSync(importPath, "utf8");
      assert.equal(importSql.includes("CREATE TABLE"), true);
      if (sourceMigrationVersion >= 44) {
        const markerOpen = importSql.indexOf(
          `INSERT INTO "source_original_result_family_recovery_state" ("id","mode")`,
        );
        const durableRows = importSql.indexOf(dataExport.slice(0, 32));
        const markerClose = importSql.indexOf(
          `DELETE FROM "source_original_result_family_recovery_state"`,
        );
        const markerAssertion = importSql.indexOf(
          `SELECT 2,'verified_recovery_import' WHERE EXISTS`,
        );
        assert.ok(markerOpen >= 0 && durableRows > markerOpen && markerClose > durableRows &&
          markerAssertion > markerClose,
        "portable family history is restored only inside the bounded recovery marker");
      }
      importCalls++;
      targetRestored = true;
      bootstrapRequired = true;
      bootstrapConfirmed = 0;
      bootstrapCursor = null;
      bootstrapProtocol = null;
      vectorCount = 0;
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
      const sql = args[args.indexOf("--command") + 1];
      let rows;
      if (/protocol_is_null[\s\S]+cursor_is_null[\s\S]+projection_fence_clear/.test(sql)) {
        openingSnapshots.push(Object.freeze({
          bootstrapCalls,
          confirmed: bootstrapConfirmed,
          epoch: bootstrapEpoch,
          protocol: bootstrapProtocol,
        }));
        rows = [{
          projection_status: bootstrapRequired ? "bootstrap_required" : "verified",
          epoch: bootstrapEpoch,
          base_count: observedBootstrapBaseCount,
          protocol_is_null: Number(bootstrapProtocol === null),
          cursor_is_null: Number(bootstrapCursor === null),
          high_water_set: Number(targetChunkCount > 0),
          high_water_position: observedBootstrapHighWaterPosition,
          high_water_matches_max: 1,
          documents: targetDocumentCount,
          chunks: targetChunkCount,
          fts: targetChunkCount,
          batches: bootstrapConfirmed === 0 ? 0 : Math.ceil(bootstrapConfirmed / bootstrapPageSize),
          batch_rows: observedBootstrapBatchRows ?? bootstrapConfirmed,
          outbox: 0,
          projection_fence_clear: 1,
        }];
      } else if (/^WITH observer_state AS \(/.test(sql)) {
        observerSnapshots.push(Object.freeze({
          bootstrapCalls,
          confirmed: bootstrapConfirmed,
          epoch: bootstrapEpoch,
        }));
        const durableBatchRows = observedBootstrapBatchRows ?? bootstrapConfirmed;
        const confirmedBatches = durableBatchRows === 0
          ? 0
          : Math.ceil(durableBatchRows / bootstrapPageSize);
        rows = [{
          projection_status: bootstrapRequired ? "bootstrap_required" : "verified",
          bootstrap_protocol: bootstrapProtocol,
          epoch: bootstrapEpoch,
          base_count: observedBootstrapBaseCount,
          cursor_set: Number(bootstrapConfirmed > 0),
          high_water_set: Number(targetChunkCount > 0),
          cursor_position: bootstrapConfirmed,
          high_water_position: observedBootstrapHighWaterPosition,
          cursor_valid: 1,
          high_water_valid: 1,
          cursor_not_after_high_water: 1,
          high_water_matches_max: 1,
          cursor_matches_batch_end: 1,
          documents: targetDocumentCount,
          chunks: targetChunkCount,
          fts: targetChunkCount,
          all_batches: confirmedBatches,
          current_batches: confirmedBatches,
          queued_batches: 0,
          submitted_batches: 0,
          confirmed_batches: confirmedBatches,
          failed_batches: 0,
          batch_rows_total: durableBatchRows,
          queued_batch_rows: 0,
          submitted_batch_rows: 0,
          confirmed_batch_rows: durableBatchRows,
          batch_start_position: observedBootstrapBaseCount,
          batch_end_position: bootstrapConfirmed,
          batch_sequence_valid: 1,
          batch_chain_breaks: 0,
          batch_row_mismatches: 0,
          foreign_batches: 0,
          outbox_pending: 0,
          outbox_queued: 0,
          outbox_submitted: 0,
          outbox_failed: 0,
          outbox_retrying: 0,
          foreign_outbox: 0,
          non_upsert_outbox: 0,
          projection_fence_pending: 0,
        }];
      } else if (/vector_projection_bootstrap_epoch AS epoch,[\s\S]+vector_projection_bootstrap_cursor AS cursor_value/.test(sql)) {
        rows = [{
          epoch: bootstrapEpoch,
          base_count: observedBootstrapBaseCount,
          protocol: bootstrapProtocol,
          cursor_value: bootstrapCursor,
        }];
      } else if (/user_table_count/.test(sql)) {
        rows = [{ user_table_count: targetRestored
          ? durableTablesForVersion(targetMigrationVersion).length + 1
          : 0 }];
      } else if (/pending_outbox/.test(sql)) {
        rows = [{ pending_outbox: outbox, failed_vectors: 0 }];
      } else if (/COUNT\(\*\) AS agent_action_receipts FROM agent_action_receipts/.test(sql)) {
        rows = [{ agent_action_receipts: agentActionReceipts }];
      } else if (/integrity-check/.test(sql)) {
        rows = [];
      } else if (/PRAGMA quick_check/.test(sql)) {
        rows = [{ quick_check: "ok" }];
      } else if (/COUNT\(\*\) AS active_imports FROM source_original_result_family_recovery_state/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
        rows = [{ active_imports: isSource
          ? (sourceFamilyRecoveryStateActive ? 1 : 0)
          : (targetFamilyRecoveryStateActive ? 1 : 0) }];
      } else if (/SELECT version,name,checksum/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
        const latest = isSource ? sourceMigrationVersion : targetMigrationVersion;
        rows = appliedMigrations.filter((row) => row.version <= latest);
      } else if (/PRAGMA table_info\(install_state\)/.test(sql)) {
        rows = installStateColumns.map(([name, type], cid) => ({ cid, name, type }));
      } else if (/^SELECT[\s\S]+FROM install_state ORDER BY id$/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifestFixture.infrastructure.cloudflare.account_id;
        assert.match(sql, /NULL AS "vector_drain_lease_owner"/);
        assert.match(sql, /NULL AS "vector_drain_lease_expires_at"/);
        assert.match(sql, /0 AS "outbox_generation"/);
        assert.match(sql, /0 AS "source_original_retrieval_generation"/);
        assert.match(sql, /NULL AS "vector_projection_mutation_id"/);
        assert.match(sql, /NULL AS "vector_projection_submitted_at"/);
        assert.match(sql, /CASE WHEN EXISTS \(SELECT 1 FROM chunks\) THEN 'bootstrap_required' ELSE 'verified' END AS "vector_projection_status"/);
        assert.match(sql, /CASE WHEN EXISTS \(SELECT 1 FROM chunks\) THEN 1 ELSE 0 END AS "vector_projection_bootstrap_epoch"/);
        assert.match(sql, /NULL AS "vector_projection_bootstrap_cursor"/);
        assert.match(sql, /\(SELECT MAX\(chunk_uid\) FROM chunks\) AS "vector_projection_bootstrap_high_water"/);
        assert.match(sql, /NULL AS "vector_projection_bootstrap_protocol"/);
        assert.match(sql, /0 AS "vector_projection_bootstrap_base_count"/);
        // An open residue-only re-projection belongs to the SOURCE index. A
        // restored brain re-walks its whole corpus into a new index, so the
        // marker must be NULL in the artifact, not the source's value.
        assert.match(sql, /NULL AS "vector_projection_residue_epoch"/);
        if (isSource) {
          assert.match(sql, /session_generation BETWEEN 1 AND 9007199254740990/);
        } else {
          assert.equal(sql.includes("session_generation BETWEEN"), false);
        }
        normalizedLeaseSelections++;
        rows = sourceInstallStateMissing ? [] : [{
          ...fixtureInstallState,
          // The source may own a live lease, but the only recovery data query
          // projects both ephemeral columns to NULL before they reach JS.
          vector_drain_lease_owner: null,
          vector_drain_lease_expires_at: null,
          outbox_generation: 0,
          vector_projection_mutation_id: null,
          vector_projection_submitted_at: null,
          vector_projection_status: "bootstrap_required",
          vector_projection_bootstrap_epoch: 1,
          vector_projection_bootstrap_cursor: null,
          vector_projection_bootstrap_high_water: "fixture:chunk#0004",
          vector_projection_bootstrap_protocol: null,
          vector_projection_bootstrap_base_count: 0,
          session_generation: fixtureInstallState.session_generation + 1,
          source_original_retrieval_generation: 0,
        }];
      } else if (/SELECT name FROM sqlite_schema/.test(sql)) {
        rows = durableTablesForVersion(migrationVersionForAccount(env.CLOUDFLARE_ACCOUNT_ID))
          .sort().map((name) => ({ name }));
      } else if (/SELECT type,name,tbl_name/.test(sql)) {
        const version = migrationVersionForAccount(env.CLOUDFLARE_ACCOUNT_ID);
        rows = schemaRows.filter((row) =>
          (version >= 37 || (row.name !== "memory_supersessions" && row.tbl_name !== "memory_supersessions")) &&
          (version >= 41 || (!mapTables.has(row.name) && !mapTables.has(row.tbl_name))));
      } else if (/documents_ingested_max/.test(sql)) {
        assert.match(
          sql,
          /CAST\(\(SELECT 0\) AS TEXT\) AS "vector_bootstrap_batches"/,
        );
        const isTarget = env.CLOUDFLARE_ACCOUNT_ID ===
          targetManifestFixture.infrastructure.cloudflare.account_id;
        const documentCount = isTarget && targetRestored
          ? targetDocumentCount
          : sourceDocumentCount;
        const chunkCount = isTarget && targetRestored ? targetChunkCount : sourceChunkCount;
        const aggregate = {
              ...aggregateTemplate,
              documents: String(documentCount),
              chunks: String(chunkCount),
              chunks_fts: String(chunkCount),
              chunks_id_max: String(chunkCount),
              chunks_text_bytes: String(chunkCount * 100),
              ...(corpusMutated
                ? { chunks_text_bytes: String(chunkCount * 100 + 1) }
                : {}),
            };
        rows = [{
          ...aggregate,
          vector_outbox: String(outbox),
          vector_drain_lease_owner_present: "0",
          vector_drain_lease_expiry_present: "0",
          vector_projection_mutation_present: "0",
          vector_projection_submission_present: "0",
        }];
      } else {
        throw new Error(`unhandled aggregate-only SQL fixture: ${sql.slice(0, 80)}`);
      }
      return ok([{ success: true, results: rows }]);
    }
    throw new Error(`unhandled Wrangler fixture: ${args.join(" ")}`);
  };

  const fetchImpl = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options: structuredClone({
      method: options.method,
      redirect: options.redirect,
      cache: options.cache,
      headers: options.headers,
      body: options.body,
    }) });
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.headers["Cache-Control"], "no-store");
    const parsedUrl = new URL(url);
    assert.equal(parsedUrl.protocol, "https:");
    assert.equal(parsedUrl.search, "");
    assert.equal(String(url).includes(fixtureAdminKey), false);
    assert.equal(String(url).includes(privateSentinel), false);
    const path = parsedUrl.pathname;
    if (path === "/health") {
      if (redirectHealth) return response({}, 302, { location: "https://redirected.fixture.invalid/health" });
      // Exercise the deployed handler's contract: paused HTTP health is 200,
      // but ok and accepting_documents are both false. A hand-written ok:true
      // fixture previously hid a recovery failure before any D1 restore.
      const mode = currentTargetVersionId === pausedVersion ? "paused-for-upgrade" : "active";
      const healthResponse = await Worker.fetch(new Request(String(url)), {
        BRAIN_NAME: targetManifestFixture.client.slug,
        BRAIN_VERSION: targetManifestFixture.brain.version,
        VECTOR_DRAIN_MODE: mode,
        DB: { prepare() { throw new Error("recovery health fixture touched D1"); } },
      }, {});
      assert.equal(healthResponse.status, 200);
      const health = await healthResponse.json();
      // Since 0.4.4 the Worker reports the version compiled into its own source
      // rather than the deploy-time variable, so a variable cannot outlive the
      // code it described. The version is therefore uninjectable here: restate
      // it, and drop the drift fields, to the body a real 0.1.12 Worker serves.
      delete health.configured_version;
      delete health.version_mismatch;
      health.brain = targetManifestFixture.client.slug;
      health.version = targetManifestFixture.brain.version;
      return response(healthTransform({
        ...health,
        ...(mode === "active"
          ? { schema_version: migrationVersionForAccount(targetManifestFixture.infrastructure.cloudflare.account_id) }
          : {}),
        vector_drain_mode: healthModeOverride ?? health.vector_drain_mode,
        vector_writer_protocol: healthProtocolOverride ?? health.vector_writer_protocol,
      }));
    }
    if (path === "/api/admin/brain/bootstrap") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      assert.equal(currentTargetVersionId, pausedVersion);
      assert.equal(options.body, undefined);
      bootstrapCalls++;
      bootstrapProtocol = "bootstrap-v2";
      if (bootstrapFailuresRemaining > 0) {
        bootstrapFailuresRemaining--;
        throw new TypeError("synthetic interrupted bootstrap");
      }
      if (bootstrapBusyRemaining > 0) {
        bootstrapBusyRemaining--;
        return response(busyReceiptTransform({
          protocol: "bootstrap-v2",
          busy: true,
          remaining: targetChunkCount - bootstrapConfirmed,
          retry_after_seconds: 2,
        }), 409);
      }
      if (bootstrapRequired && bootstrapConfirmed < targetChunkCount &&
          !holdBootstrapProgressOnce) {
        bootstrapConfirmed = Math.min(
          targetChunkCount,
          bootstrapConfirmed + bootstrapPageSize,
        );
        vectorCount = bootstrapConfirmed;
        bootstrapCursor = `fixture:chunk#${String(Math.max(0, bootstrapConfirmed - 1)).padStart(8, "0")}`;
      }
      if (mutateBootstrapCursorWithoutOrdinalOnce !== null) {
        bootstrapCursor = mutateBootstrapCursorWithoutOrdinalOnce;
        mutateBootstrapCursorWithoutOrdinalOnce = null;
        vectorCount = Math.min(targetChunkCount, Math.max(vectorCount, bootstrapConfirmed + 1));
      }
      if (mutateBootstrapHighWaterWithoutOrdinalOnce !== null) {
        observedBootstrapHighWaterPosition = mutateBootstrapHighWaterWithoutOrdinalOnce;
        mutateBootstrapHighWaterWithoutOrdinalOnce = null;
        vectorCount = Math.min(targetChunkCount, Math.max(vectorCount, bootstrapConfirmed + 1));
      }
      holdBootstrapProgressOnce = false;
      if (postProgressBootstrapFailuresRemaining > 0 && bootstrapConfirmed > 0) {
        postProgressBootstrapFailuresRemaining--;
        throw new TypeError("synthetic interruption after durable bootstrap progress");
      }
      const countComplete = bootstrapConfirmed === targetChunkCount;
      const visibilityLagged = countComplete && readinessLagRemaining > 0;
      if (visibilityLagged) readinessLagRemaining--;
      const complete = countComplete && !visibilityLagged;
      if (complete) bootstrapRequired = false;
      if (complete && bootstrapMutatesCorpus) corpusMutated = true;
      return response(bootstrapReceiptTransform({
        protocol: "bootstrap-v2",
        phase: complete ? "complete" : countComplete ? "waiting" : "building",
        epoch: bootstrapEpoch,
        total: targetChunkCount,
        confirmed: bootstrapConfirmed,
        queued: 0,
        submitted: 0,
        remaining: targetChunkCount - bootstrapConfirmed,
        in_flight_batches: 0,
        failed: 0,
        complete,
        vector_ready: complete,
        expected_vectors: targetChunkCount,
        actual_vectors: visibilityLagged ? Math.max(0, targetChunkCount - 1) : vectorCount,
      }));
    }
    if (path === "/api/bank-feed/recovery-key-proof") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (options.body) {
        if (bankFixture) return bankFixture.request(url, options);
        const request = JSON.parse(options.body);
        assert.equal(request.protocol, "bank-security-v1");
        assert.equal(request.offset, 0);
        return response(bankProofTransform({ ...emptyBankProof, count: 0,
          fingerprint: hash(canonical(emptyBankProof)), next_offset: null }));
      }
      const isSource = parsedUrl.hostname === sourceManifestFixture.brain.domain;
      return response({
        configured: true,
        key_version: 2,
        key_fingerprint: bankKeyProofMismatch && isSource
          ? "6".repeat(64)
          : "7".repeat(64),
      });
    }
    if (path === "/api/bank-feed/reconcile-recovery") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (bankFixture) return bankFixture.request(url, options);
      assert.equal(JSON.parse(options.body).protocol, "bank-security-v1");
      return response({
        scanned: 0,
        rewrapped: 0,
        reauthorization_required: 0,
        raced: 0,
        legacy_rewrap_required: 0,
        protected: 0,
        reauthorization_required_total: 0,
        unsupported_key_versions: 0,
      });
    }
    if (path === "/api/admin/brain/documents") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      if (redirectInventory) {
        // Match native fetch with redirect:error: no request is issued to the
        // Location host, so the authenticated header cannot cross origins.
        throw new TypeError("redirect mode is set to error");
      }
      const ready = !bootstrapRequired && outbox === 0 && vectorCount === targetChunkCount;
      return response({
        backend: "d1",
        rows: [],
        vector_backlog: {
          pending: outbox,
          upserts: outbox,
          deletes: 0,
          submitted: 0,
          oldest_queued_at: outbox ? 1_777_000_000_000 : null,
        },
        vector_readiness: {
          ready,
          reason: ready ? null : "accepted_mutation_processing",
          expected_vectors: targetChunkCount,
          actual_vectors: ready ? targetChunkCount : Math.max(0, vectorCount - 1),
          pending: outbox,
          submitted: 0,
          action: ready ? null : "Wait briefly, then run brain drain again.",
        },
      });
    }
    if (path === "/api/rag/unified") return response({ error: "unauthorized" }, 401);
    throw new Error(`unhandled fetch fixture: ${path}`);
  };

  return {
    dependencies: {
      platform: "darwin",
      environment: {
        HOME: sandbox,
        USER: "fixture",
        LOGNAME: "fixture",
        CLOUDFLARE_API_TOKEN: "ambient-cloudflare-secret",
        ADMIN_KEY: "ambient-admin-secret",
        SUPABASE_SERVICE_ROLE_KEY: "ambient-supabase-secret",
      },
      runWrangler,
      materializeWranglerRuntime: (expected, destination) => {
        wranglerRuntimeMaterializations++;
        assert.equal(expected.inventorySha256, lockedWranglerRuntime.inventorySha256);
        const entrypointPath = resolve(destination, expected.entrypointRelative);
        mkdirSync(dirname(entrypointPath), { recursive: true, mode: 0o700 });
        writeFileSync(entrypointPath, "// isolated synthetic Wrangler entrypoint\n", {
          flag: "wx",
          mode: 0o700,
        });
        const resolutionGuardPath = resolve(destination, LOCKED_WRANGLER_RESOLUTION_GUARD);
        writeFileSync(resolutionGuardPath, "// isolated synthetic resolution guard\n", {
          flag: "wx",
          mode: 0o600,
        });
        return Object.freeze({
          root: resolve(destination),
          entrypointPath,
          resolutionGuardPath,
          inventorySha256: expected.inventorySha256,
          filePins: Object.freeze([]),
        });
      },
      assertMaterializedWranglerRuntimeUnchanged: (runtime) => {
        assert.equal(runtime.inventorySha256, lockedWranglerRuntime.inventorySha256);
        assert.equal(existsSync(runtime.entrypointPath), true);
        assert.equal(existsSync(runtime.resolutionGuardPath), true);
        return true;
      },
      assertLockedWranglerRuntimeUnchanged: (runtime) => {
        assert.equal(runtime.inventorySha256, lockedWranglerRuntime.inventorySha256);
        assert.equal(runtime.entrypointRelative, LOCKED_WRANGLER_ENTRYPOINT);
        assert.equal(existsSync(runtime.entrypointPath), true);
        return true;
      },
      fetchImpl,
      readAdminKey: () => {
        adminReads++;
        return fixtureAdminKey;
      },
      readRecoveryArtifactKey: () => recoveryArtifactKey,
      verifySqlArtifact: async (path) => {
        const text = readFileSync(path, "utf8");
        assert.match(text, /CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts/);
        assert.equal(text.includes(privateSentinel), false);
        if (inspectCombinedArtifact) await inspectCombinedArtifact(text);
        return sourceSnapshot;
      },
      runEval: async ({ args, env, input }) => {
        evalCalls++;
        assert.deepEqual(Buffer.from(input), Buffer.from(`${fixtureAdminKey}\n`));
        assert.equal(Object.hasOwn(env, "CLOUDFLARE_API_TOKEN"), false);
        assert.equal(Object.hasOwn(env, "ADMIN_KEY"), false);
        assert.equal(env.BRAIN_ADMIN_KEY_STDIN, "1");
        assert.equal(args.includes("--profile"), true);
        assert.equal(args[args.indexOf("--profile") + 1], "release");
        if (deploymentChangesDuringEval) currentTargetVersionId = "fixture-unreviewed-version-id";
        if (evalFailuresRemaining > 0) {
          evalFailuresRemaining--;
          return { status: 1 };
        }
        return { status: 0 };
      },
      sleep: async () => { sleepCalls++; },
      now: () => Date.parse("2026-08-25T13:00:00.000Z"),
      clock: (() => {
        let value = Date.parse("2026-08-25T13:00:00.000Z");
        return () => new Date(value += 1000);
      })(),
    },
    get adminReads() { return adminReads; },
    get evalCalls() { return evalCalls; },
    get importCalls() { return importCalls; },
    get bootstrapCalls() { return bootstrapCalls; },
    get bootstrapConfirmed() { return bootstrapConfirmed; },
    get currentTargetVersionId() { return currentTargetVersionId; },
    get promotionCalls() { return promotionCalls; },
    get sleepCalls() { return sleepCalls; },
    get wranglerCalls() { return wranglerCalls; },
    get fetchCalls() { return fetchCalls; },
    get observerSnapshots() { return observerSnapshots; },
    get openingSnapshots() { return openingSnapshots; },
    get sensitiveBuffers() { return sensitiveBuffers; },
    get normalizedLeaseSelections() { return normalizedLeaseSelections; },
    get wranglerRuntimeMaterializations() { return wranglerRuntimeMaterializations; },
    get bootstrapEpoch() { return bootstrapEpoch; },
    get bootstrapCursor() { return bootstrapCursor; },
    get sourceLeaseMarker() { return sourceDrainLease ? "fixture-live-drain-owner" : null; },
    mutateNonBank() { corpusMutated = true; },
    failNextBootstrapAfterProgress() { postProgressBootstrapFailuresRemaining++; },
    holdNextBootstrapProgress() { holdBootstrapProgressOnce = true; },
    mutateNextBootstrapCursorWithoutOrdinal(value) {
      holdBootstrapProgressOnce = true;
      mutateBootstrapCursorWithoutOrdinalOnce = value;
    },
    mutateNextBootstrapHighWaterWithoutOrdinal(value) {
      holdBootstrapProgressOnce = true;
      mutateBootstrapHighWaterWithoutOrdinalOnce = value;
    },
    setBootstrapCursor(value) { bootstrapCursor = value; },
    setBootstrapVectorCount(value) { vectorCount = value; },
    setObservedBootstrapHighWaterPosition(value) {
      observedBootstrapHighWaterPosition = value;
    },
    setObservedBootstrapLedger({ baseCount, batchRows }) {
      observedBootstrapBaseCount = baseCount;
      observedBootstrapBatchRows = batchRows;
    },
    setTargetVersionId(value) { currentTargetVersionId = value; },
  };
}

try {
  const recoveryFieldGateSchema = JSON.parse(
    readFileSync(join(process.cwd(), "manifest.schema.json"), "utf8"),
  ).properties.operations.properties.recovery_field_gate;
  assert.deepEqual(recoveryFieldGateSchema.required, [
    "paused_worker_version_id", "paused_worker_script_etag",
    "active_worker_version_id", "active_worker_script_etag", "routes",
    "custom_domains", "reviewed_at",
  ]);
  assert.equal(recoveryFieldGateSchema.additionalProperties, false);
  assert.equal(
    Object.hasOwn(recoveryFieldGateSchema.properties, "worker_script_etag"),
    false,
  );

  writePrivateJson(sourceManifestPath, sourceManifest);
  writePrivateJson(targetManifestPath, targetManifest);
  mkdirSync(artifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(artifactDirectory, 0o700);
  writeFileSync(wrapperPath, wrapperScript, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
  writePrivateJson(goldenPath, releaseGolden());

  const initialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    planPath,
    statePath,
    { now: new Date("2026-08-25T12:00:00.000Z") },
  );
  const baseConfig = {
    sourceManifestPath,
    targetManifestPath,
    planPath,
    statePath,
    artifactDirectory,
    wranglerWrapperPath: wrapperPath,
    goldenPath,
  };

  const preview = previewCloudflareRecoveryFieldGate(baseConfig, { platform: "darwin" });
  assert.equal(preview.ready_for_explicit_approval, true);
  assert.equal(preview.plan_fingerprint, initialized.plan.plan_fingerprint);
  assert.equal(preview.target_approval_fingerprint, initialized.plan.target_resource_fingerprint);
  assert.match(preview.target_execution_approval_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    preview.source_export_blocking_approval_fingerprint,
    initialized.plan.source_resource_fingerprint,
  );
  assert.match(preview.wrapper_approval_fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(preview.golden_approval_fingerprint, hash(readFileSync(goldenPath)));
  assert.notEqual(
    targetManifest.operations.recovery_field_gate.paused_worker_script_etag,
    targetManifest.operations.recovery_field_gate.active_worker_script_etag,
  );
  assert.deepEqual(RECOVERY_FIELD_GATE_STOP_STAGES, [
    "export_d1", "restore_d1", "reconcile_security", "rebuild_vectorize",
  ]);
  const approvedAdapterConfig = Object.freeze({
    ...baseConfig,
    plan: initialized.plan,
    approvePlan: initialized.plan.plan_fingerprint,
    approveDisposableTarget: initialized.plan.target_resource_fingerprint,
    approveTargetExecution: preview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
    approveWrapper: preview.wrapper_approval_fingerprint,
    approveGolden: preview.golden_approval_fingerprint,
  });

  const legacyTargetManifestPath = join(sandbox, "legacy-one-etag-target.manifest.json");
  const legacyPlanPath = join(sandbox, ".legacy-one-etag-plan.json");
  const legacyStatePath = join(sandbox, ".legacy-one-etag-state.json");
  const legacyTargetManifest = structuredClone(targetManifest);
  legacyTargetManifest.operations.recovery_field_gate = {
    paused_worker_version_id: pausedWorkerVersionId,
    active_worker_version_id: activeWorkerVersionId,
    worker_script_etag: pausedWorkerScriptEtag,
    routes: [],
    custom_domains: [],
    reviewed_at: "2026-08-25T11:55:00.000Z",
  };
  writePrivateJson(legacyTargetManifestPath, legacyTargetManifest);
  initializeVerifiedRecovery(
    sourceManifestPath,
    legacyTargetManifestPath,
    legacyPlanPath,
    legacyStatePath,
    { now: new Date("2026-08-25T12:00:00.000Z") },
  );
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...baseConfig,
      targetManifestPath: legacyTargetManifestPath,
      planPath: legacyPlanPath,
      statePath: legacyStatePath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
    "the legacy single-etag isolation shape is refused before provider access",
  );

  const stageContext = (stage, completed = [], attempt = 1) => ({ stage, attempt,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint, completed });

  const ordinaryCheckpointPath = join(
    artifactDirectory,
    ".brain-recovery-test-bootstrap-interruption-v1.json",
  );
  if (process.platform !== "win32") {
    symlinkSync(join(artifactDirectory, "missing-control-target"), ordinaryCheckpointPath);
    assert.throws(
      () => previewCloudflareRecoveryFieldGate(baseConfig, { platform: "darwin" }),
      (error) => error.code ===
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_APPROVAL_REQUIRED",
      "a dangling live-control symlink is present, never absent",
    );
    unlinkSync(ordinaryCheckpointPath);
  }
  const ordinaryControlHarness = providerHarness();
  const ordinaryControlGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    ordinaryControlHarness.dependencies,
  );
  writeFileSync(ordinaryCheckpointPath, "{}\n", { flag: "wx", mode: 0o600 });
  await assert.rejects(
    ordinaryControlGate.adapters.export_d1(stageContext("export_d1")),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
    "a live control injected after gate construction is refused at the first provider boundary",
  );
  assert.equal(ordinaryControlHarness.wranglerCalls.length, 0);
  assert.equal(ordinaryControlHarness.adminReads, 0);
  assert.equal(ordinaryControlHarness.fetchCalls.length, 0);
  unlinkSync(ordinaryCheckpointPath);

  async function bankRecoveryRun() {
    const bank = await recoveryBankFixture();
    const harness = providerHarness({ bankFixture: bank, initialTargetRestored: true });
    const gate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, harness.dependencies);
    const restored = await gate.adapters.verify_d1(stageContext("verify_d1"));
    assert.equal(restored.bank_security_proof.rows.length, 4);
    assert.equal(JSON.stringify(restored).includes("synthetic-item"), false);
    assert.equal(JSON.stringify(restored).includes("synthetic-bank-reference"), false);
    const context = stageContext("reconcile_security", [{ id: "verify_d1", evidence: restored }]);
    return { bank, harness, gate, restored, context };
  }

  for (const loss of ["rewrap", "reauth", "response"]) {
    const run = await bankRecoveryRun();
    if (loss === "response") run.bank.afterResponse = () => { throw new Error("synthetic response loss after final bank write"); };
    else { run.bank.loseAfter = loss; run.bank.lossRemaining = 1; }
    await assert.rejects(run.gate.adapters.reconcile_security(run.context));
    const midway = run.bank.db.prepare("SELECT key_version,status FROM bank_feed_items ORDER BY id").all();
    if (loss === "rewrap") assert.deepEqual(midway.map((row) => row.key_version), [2,1,1,1]);
    if (loss === "reauth") {
      assert.deepEqual(midway.map((row) => row.key_version), [2,1,1,1]);
      assert.equal(midway[1].status, "reauth_required");
    }
    if (loss === "response") assert.deepEqual(midway.map((row) => row.key_version), [2,1,2,1]);
    assert.notEqual(hash(normalizedInstallStateSql + run.bank.exportData()), run.restored.content_fingerprint);
    const receipt = await run.gate.adapters.reconcile_security({ ...run.context, attempt: 2 });
    assert.equal(receipt.bank_protected, 2);
    assert.equal(receipt.bank_reauthorization_required, 2);
    assert.equal(receipt.bank_legacy_rewrap_required, 0);
    assert.equal(run.bank.writes, 4);
    assert.equal(receipt.content_fingerprint, hash(normalizedInstallStateSql + run.bank.exportData()));
    const finalRows = run.bank.db.prepare("SELECT last_error_at FROM bank_feed_items WHERE status='reauth_required'").all();
    assert.equal(finalRows.every((row) => row.last_error_at === run.restored.bank_security_proof.reconciliation_at), true);
    assert.equal(run.harness.bootstrapCalls, 0);
    run.bank.db.close();
  }

  for (const status of ["connected", "reauth_required", "removed"]) {
    for (const phase of ["before", "during"]) {
      const bank = await recoveryBankFixture();
      const original = await encryptAccessReference(bank.env, "synthetic-bank-reference-1");
      bank.db.prepare(`UPDATE bank_feed_items SET access_ciphertext=?,access_iv=?,key_version=2,
        status=?,status_detail='synthetic existing status',removed_at=? WHERE id=1`)
        .run(original.ciphertext, original.iv, status, status === "removed" ? "2026-08-25" : null);
      const harness = providerHarness({ bankFixture: bank, initialTargetRestored: true });
      const gate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, harness.dependencies);
      const restored = await gate.adapters.verify_d1(stageContext("verify_d1"));
      const downgrade = async () => {
        const legacy = await encryptAccessReference(bank.env, "synthetic-bank-reference-1", { keyVersion: 1 });
        bank.db.prepare("UPDATE bank_feed_items SET access_ciphertext=?,access_iv=?,key_version=1 WHERE id=1")
          .run(legacy.ciphertext, legacy.iv);
      };
      if (phase === "during") bank.afterResponse = downgrade;
      else await downgrade();
      await assert.rejects(gate.adapters.reconcile_security(stageContext("reconcile_security",
        [{ id: "verify_d1", evidence: restored }])), (error) =>
        error.code === `RECOVERY_TARGET_CHANGED_${phase === "during" ? "DURING" : "BEFORE"}_SECURITY_RECONCILIATION`);
      assert.equal(harness.bootstrapCalls, 0);
      bank.db.close();
    }
  }
  {
    const run = await bankRecoveryRun();
    const request = run.bank.request;
    run.bank.request = async (url, options) => new URL(url).pathname.endsWith("/reconcile-recovery")
      ? Response.json({ scanned: 0, rewrapped: 0, reauthorization_required: 0, raced: 0,
        legacy_rewrap_required: 0, protected: 2, reauthorization_required_total: 2, unsupported_key_versions: 0 })
      : request(url, options);
    await assert.rejects(run.gate.adapters.reconcile_security(run.context), (error) =>
      error.code === "RECOVERY_TARGET_CHANGED_DURING_SECURITY_RECONCILIATION");
    assert.equal(run.bank.writes, 0);
    run.bank.db.close();
  }

  // Equal row counts are insufficient: reject every unapproved change before
  // the first attempt, after a mixed partial commit, and after its final write.
  for (const phase of ["before", "after_loss", "during"]) {
    for (const mutation of ["non_bank", "status", "time", "detail", "cursor", "identity", "reference", "remove", "insert"]) {
      const run = await bankRecoveryRun();
      if (phase === "after_loss") {
        run.bank.loseAfter = "reauth"; run.bank.lossRemaining = 1;
        await assert.rejects(run.gate.adapters.reconcile_security(run.context));
      }
      const mutate = async () => {
        const db = run.bank.db;
        if (mutation === "non_bank") run.harness.mutateNonBank();
        else if (mutation === "status") db.exec("UPDATE bank_feed_items SET status='error',status_detail='synthetic unrelated error' WHERE id=2");
        else if (mutation === "time") db.exec("UPDATE bank_feed_items SET last_error_at='2026-08-25T13:00:01.000Z' WHERE id=2");
        else if (mutation === "detail") db.exec("UPDATE bank_feed_items SET status_detail='synthetic changed detail' WHERE id=2");
        else if (mutation === "cursor") db.exec("UPDATE bank_feed_items SET cursor='synthetic different cursor' WHERE id=2");
        else if (mutation === "identity") db.exec("UPDATE bank_feed_items SET item_ref='synthetic replacement identity' WHERE id=2");
        else if (mutation === "remove") db.exec("DELETE FROM bank_feed_items WHERE id=4");
        else if (mutation === "insert") db.exec(`INSERT INTO bank_feed_items (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
          SELECT tenant_id,'synthetic extra item',access_ciphertext,access_iv,key_version,environment,connected_at FROM bank_feed_items WHERE id=4`);
        else {
          const sealed = await encryptAccessReference(run.bank.env, "synthetic wrong reference");
          db.prepare("UPDATE bank_feed_items SET access_ciphertext=?,access_iv=?,key_version=2 WHERE id=1").run(sealed.ciphertext, sealed.iv);
        }
      };
      if (phase === "during") run.bank.afterResponse = mutate;
      else await mutate();
      const writesBefore = run.bank.writes;
      await assert.rejects(run.gate.adapters.reconcile_security(run.context), (error) =>
        error.code === `RECOVERY_TARGET_CHANGED_${phase === "during" ? "DURING" : "BEFORE"}_SECURITY_RECONCILIATION`, `${phase}: ${mutation}`);
      if (phase !== "during") assert.equal(run.bank.writes, writesBefore);
      assert.equal(run.harness.bootstrapCalls, 0);
      run.bank.db.close();
    }
  }
  {
    const run = await bankRecoveryRun();
    const missing = structuredClone(run.context);
    delete missing.completed[0].evidence.bank_security_proof;
    await assert.rejects(run.gate.adapters.reconcile_security(missing), (error) =>
      error.code === "RECOVERY_TARGET_CHANGED_BEFORE_SECURITY_RECONCILIATION");
    assert.equal(run.bank.writes, 0);
    run.bank.db.close();
  }
  for (const count of [1000, 1001]) {
    const bank = await recoveryBankFixture();
    const insert = bank.db.prepare(`INSERT INTO bank_feed_items
      (tenant_id,item_ref,access_ciphertext,access_iv,key_version,environment,connected_at)
      SELECT tenant_id,?,access_ciphertext,access_iv,key_version,environment,connected_at FROM bank_feed_items WHERE id=1`);
    for (let index = 4; index < count; index++) insert.run(`synthetic-page-item-${index}`);
    const harness = providerHarness({ bankFixture: bank, initialTargetRestored: true });
    const gate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, harness.dependencies);
    if (count === 1000) {
      const restored = await gate.adapters.verify_d1(stageContext("verify_d1"));
      assert.equal(restored.bank_security_proof.rows.length, 1000);
      assert.ok(Buffer.byteLength(JSON.stringify(restored)) < 1024 * 1024);
      assert.equal(new Set(restored.bank_security_proof.rows.map((pair) => pair[0])).size, 1000);
    } else await assert.rejects(gate.adapters.verify_d1(stageContext("verify_d1")), (error) =>
      error.code === "RECOVERY_BANK_SECURITY_PROOF_LIMIT_REACHED");
    assert.equal(bank.writes, 0);
    assert.equal(harness.bootstrapCalls, 0);
    bank.db.close();
  }
  {
    const bank = await recoveryBankFixture();
    const harness = providerHarness({ bankFixture: bank, initialTargetRestored: true });
    const gate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, harness.dependencies);
    bank.afterProof = () => bank.db.exec("UPDATE bank_feed_items SET institution_label='synthetic baseline race' WHERE id=1");
    await assert.rejects(gate.adapters.verify_d1(stageContext("verify_d1")), (error) =>
      error.code === "RECOVERY_TARGET_CHANGED_DURING_SECURITY_BASELINE");
    assert.equal(bank.writes, 0);
    bank.db.close();
  }
  for (const mutate of [
    (proof) => { delete proof.proofs; },
    (proof) => { proof.unreviewed = true; },
    (proof) => { proof.protocol = "unknown"; },
    (proof) => { proof.count = 1; },
    (proof) => { proof.fingerprint = "f".repeat(64); },
    (proof) => { proof.next_offset = 100; },
    (proof) => { proof.proofs = [["a".repeat(64), "a".repeat(64)], ["a".repeat(64), "a".repeat(64)]];
      proof.count = 2; proof.fingerprint = hash(canonical({ protocol: proof.protocol, proofs: proof.proofs })); },
  ]) {
    const harness = providerHarness({ initialTargetRestored: true,
      bankProofTransform: (proof) => { mutate(proof); return proof; } });
    const gate = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, harness.dependencies);
    await assert.rejects(gate.adapters.verify_d1(stageContext("verify_d1")), (error) =>
      error.code === "RECOVERY_BANK_SECURITY_PROOF_INVALID");
    assert.equal(harness.fetchCalls.some((call) => call.url.endsWith("/reconcile-recovery")), false);
  }
  const previewText = JSON.stringify(preview);
  for (const forbidden of [privateSentinel, fixtureAdminKey, sourceManifest.brain.domain, wrapperPath]) {
    assert.equal(previewText.includes(forbidden), false);
  }

  assert.deepEqual(parseCloudflareRecoveryCliArguments([
    "preview",
    "--source-manifest", sourceManifestPath,
    "--target-manifest", targetManifestPath,
    "--plan", planPath,
    "--state", statePath,
    "--artifact-directory", artifactDirectory,
    "--wrangler-wrapper", wrapperPath,
    "--golden", goldenPath,
  ]).command, "preview");
  const parsedStop = parseCloudflareRecoveryCliArguments([
    "run",
    "--source-manifest", sourceManifestPath,
    "--target-manifest", targetManifestPath,
    "--plan", planPath,
    "--state", statePath,
    "--artifact-directory", artifactDirectory,
    "--wrangler-wrapper", wrapperPath,
    "--golden", goldenPath,
    "--approve-plan", initialized.plan.plan_fingerprint,
    "--approve-disposable-target", initialized.plan.target_resource_fingerprint,
    "--approve-target-execution", preview.target_execution_approval_fingerprint,
    "--approve-source-export-blocking", preview.source_export_blocking_approval_fingerprint,
    "--approve-wrapper", preview.wrapper_approval_fingerprint,
    "--approve-golden", preview.golden_approval_fingerprint,
    "--stop-after-stage", "restore_d1",
  ]);
  assert.equal(parsedStop.stopAfterStage, "restore_d1");
  assert.equal(parsedStop.approveGolden, preview.golden_approval_fingerprint);
  const testInterruptionCliArguments = [
    "run",
    "--source-manifest", sourceManifestPath,
    "--target-manifest", targetManifestPath,
    "--plan", planPath,
    "--state", statePath,
    "--artifact-directory", artifactDirectory,
    "--wrangler-wrapper", wrapperPath,
    "--golden", goldenPath,
    "--approve-plan", initialized.plan.plan_fingerprint,
    "--approve-disposable-target", initialized.plan.target_resource_fingerprint,
    "--approve-target-execution", preview.target_execution_approval_fingerprint,
    "--approve-source-export-blocking", preview.source_export_blocking_approval_fingerprint,
    "--approve-wrapper", preview.wrapper_approval_fingerprint,
    "--approve-golden", preview.golden_approval_fingerprint,
    "--field-deployment-receipt", fieldDeploymentReceiptPath,
    "--test-interrupt-mid-bootstrap", RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    "--test-bootstrap-candidate-sha", "c".repeat(40),
    "--test-bootstrap-field-receipt", fieldReceiptPath,
    "--test-bootstrap-package", fieldPackagePath,
    "--test-bootstrap-source-phase-receipt", fieldSourcePhaseReceiptPath,
    "--test-bootstrap-deployment-receipt", fieldDeploymentReceiptPath,
    "--test-bootstrap-seed-receipt", fieldSeedReceiptPath,
    "--approve-test-bootstrap-interruption", "d".repeat(64),
  ];
  const parsedTestInterruption = parseCloudflareRecoveryCliArguments(
    testInterruptionCliArguments,
  );
  assert.equal(
    parsedTestInterruption.testInterruptMidBootstrap,
    RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
  );
  assert.equal(parsedTestInterruption.testBootstrapCandidateSha, "c".repeat(40));
  assert.equal(parsedTestInterruption.fieldDeploymentReceiptPath, fieldDeploymentReceiptPath);
  assert.equal(parsedTestInterruption.testBootstrapFieldReceiptPath, fieldReceiptPath);
  assert.equal(parsedTestInterruption.testBootstrapPackagePath, fieldPackagePath);
  assert.equal(
    parsedTestInterruption.testBootstrapSourcePhaseReceiptPath,
    fieldSourcePhaseReceiptPath,
  );
  assert.equal(
    parsedTestInterruption.testBootstrapDeploymentReceiptPath,
    fieldDeploymentReceiptPath,
  );
  assert.equal(parsedTestInterruption.testBootstrapSeedReceiptPath, fieldSeedReceiptPath);
  assert.equal(parsedTestInterruption.approveTestBootstrapInterruption, "d".repeat(64));
  const sourcePhaseFlagIndex = testInterruptionCliArguments.indexOf(
    "--test-bootstrap-source-phase-receipt",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      ...testInterruptionCliArguments.slice(0, sourcePhaseFlagIndex),
      ...testInterruptionCliArguments.slice(sourcePhaseFlagIndex + 2),
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID",
    "the complete test-bootstrap chain requires an explicit source-phase receipt",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      "preview",
      "--source-manifest", sourceManifestPath,
      "--target-manifest", targetManifestPath,
      "--plan", planPath,
      "--state", statePath,
      "--artifact-directory", artifactDirectory,
      "--wrangler-wrapper", wrapperPath,
      "--golden", goldenPath,
      "--test-interrupt-mid-bootstrap", RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      "preview",
      "--source-manifest", sourceManifestPath,
      "--target-manifest", targetManifestPath,
      "--plan", planPath,
      "--state", statePath,
      "--artifact-directory", artifactDirectory,
      "--wrangler-wrapper", wrapperPath,
      "--golden", goldenPath,
      "--stop-after-stage", "restore_d1",
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_ARGUMENTS_INVALID",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments([
      ...[
        "run",
        "--source-manifest", sourceManifestPath,
        "--target-manifest", targetManifestPath,
        "--plan", planPath,
        "--state", statePath,
        "--artifact-directory", artifactDirectory,
        "--wrangler-wrapper", wrapperPath,
        "--golden", goldenPath,
        "--approve-plan", initialized.plan.plan_fingerprint,
        "--approve-disposable-target", initialized.plan.target_resource_fingerprint,
        "--approve-target-execution", preview.target_execution_approval_fingerprint,
        "--approve-source-export-blocking", preview.source_export_blocking_approval_fingerprint,
        "--approve-wrapper", preview.wrapper_approval_fingerprint,
        "--approve-golden", preview.golden_approval_fingerprint,
      ],
      "--stop-after-stage", "verify_health",
    ]),
    (error) => error.code === "RECOVERY_FIELD_GATE_STOP_STAGE_INVALID",
  );
  assert.throws(
    () => parseCloudflareRecoveryCliArguments(["run", "--plan", planPath, "--plan", planPath]),
    /RECOVERY_FIELD_GATE_ARGUMENTS_INVALID/,
  );

  writePrivateJson(goldenPath, { ...releaseGolden(), schema_version: 2 });
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(baseConfig, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_RELEASE_EVAL_INVALID",
  );
  writePrivateJson(goldenPath, releaseGolden());

  writeFileSync(wrapperPath, `${wrapperScript}# reviewed replacement\n`);
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
  const replacedWrapperHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: initialized.plan.plan_fingerprint,
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint,
      approveGolden: preview.golden_approval_fingerprint,
    }, replacedWrapperHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(replacedWrapperHarness.wranglerCalls.length, 0);
  assert.equal(replacedWrapperHarness.adminReads, 0);
  writeFileSync(wrapperPath, wrapperScript);
  if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);

  const unusedHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: "0".repeat(64),
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      stopAfterStage: "restore_d1",
    }, unusedHarness.dependencies),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(unusedHarness.wranglerCalls.length, 0);
  assert.equal(unusedHarness.adminReads, 0);

  const directBypassHarness = providerHarness();
  const unapprovedAdapters = createCloudflareRecoveryFieldGateAdapters({
    ...baseConfig,
    plan: initialized.plan,
  }, directBypassHarness.dependencies);
  await assert.rejects(
    unapprovedAdapters.adapters.export_d1({
      stage: "export_d1",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.equal(directBypassHarness.wranglerCalls.length, 0);

  const invalidStopHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: initialized.plan.plan_fingerprint,
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint,
      approveGolden: preview.golden_approval_fingerprint,
      stopAfterStage: "verify_health",
    }, invalidStopHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_STOP_STAGE_INVALID",
  );
  assert.equal(invalidStopHarness.wranglerCalls.length, 0);
  assert.equal(invalidStopHarness.adminReads, 0);

  // The mid-bootstrap hook is a separate, plan-bound synthetic field action.
  // Native Windows cannot run the macOS Keychain-bound field hook. Keep that
  // boundary explicit there; Linux still exercises the synthetic lifecycle and
  // must not turn its completed evidence into approved macOS field proof.
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(baseConfig, { platform: "win32" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_REQUIRES_MACOS_KEYCHAIN",
    "the special field hook remains unreachable on Windows",
  );
  if (process.platform !== "win32") {
  // A copied flag against the ordinary recovery fixture is refused before any
  // provider command or admin-key read, even when all ordinary approvals exist.
  const testCandidateSha = "c".repeat(40);
  mkdirSync(fieldPreparationDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(fieldPreparationDirectory, 0o700);
  const fieldPackage = npmPackageFixture(fieldPreparationDirectory);
  const fieldPackageBytes = fieldPackage.bytes;
  if (process.platform !== "win32") chmodSync(fieldPackagePath, 0o600);
  const npmCacheContentRoot = resolveNpmCacheContentRoot(process.env);
  const installedWranglerEntrypoint = join(process.cwd(), LOCKED_WRANGLER_ENTRYPOINT);
  const installedWranglerEntrypointBytes = readFileSync(installedWranglerEntrypoint);
  const installedWranglerEntrypointMode = statSync(installedWranglerEntrypoint).mode & 0o777;
  const corruptSourceHarness = providerHarness();
  try {
    writeFileSync(installedWranglerEntrypoint, Buffer.concat([
      installedWranglerEntrypointBytes,
      Buffer.from("\n// same-version synthetic source corruption\n"),
    ]));
    assert.throws(
      () => prepareLockedWranglerRuntimeFromCache({
        sourceRoot: process.cwd(),
        destination: join(fieldPreparationDirectory, "corrupt-source-runtime"),
        cacheContentRoot: npmCacheContentRoot,
      }),
      (error) => error.code === "LOCKED_WRANGLER_RUNTIME_SOURCE_MISMATCH",
      "a same-version installed entrypoint cannot be blessed into field preparation",
    );
    assert.equal(corruptSourceHarness.wranglerCalls.length, 0);
    assert.equal(corruptSourceHarness.adminReads, 0);
    assert.equal(corruptSourceHarness.fetchCalls.length, 0);
  } finally {
    writeFileSync(installedWranglerEntrypoint, installedWranglerEntrypointBytes);
    if (process.platform !== "win32") {
      chmodSync(installedWranglerEntrypoint, installedWranglerEntrypointMode);
    }
  }
  lockedWranglerRuntime = prepareLockedWranglerRuntimeFromCache({
    sourceRoot: process.cwd(),
    destination: join(fieldPreparationDirectory, LOCKED_WRANGLER_RUNTIME_DIRECTORY),
    cacheContentRoot: npmCacheContentRoot,
  });
  const smokeRuntimePath = join(fieldPreparationDirectory, "wrangler-runtime-smoke");
  const smokeRuntime = materializeLockedWranglerRuntime(
    lockedWranglerRuntime,
    smokeRuntimePath,
  );
  const runtimeSmoke = spawnSync(process.execPath, [
    "--no-global-search-paths",
    "--require", smokeRuntime.resolutionGuardPath,
    smokeRuntime.entrypointPath,
    "--version",
  ], {
    cwd: smokeRuntimePath,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
      HOME: sandbox,
      WRANGLER_SEND_METRICS: "false",
      NO_COLOR: "1",
      CI: "1",
    },
  });
  assert.equal(runtimeSmoke.status, 0, runtimeSmoke.stderr);
  assert.equal(runtimeSmoke.stdout.trim(), "4.131.1");
  rmSync(smokeRuntimePath, { recursive: true, force: true });
  writePrivateJson(
    fieldReceiptPath,
    fullFieldPreparationReceipt(testCandidateSha, fieldPackageBytes, fieldPackage.fileCount),
  );
  const copiedFlagHarness = providerHarness();
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...baseConfig,
      approvePlan: initialized.plan.plan_fingerprint,
      approveDisposableTarget: initialized.plan.target_resource_fingerprint,
      approveTargetExecution: preview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
      approveWrapper: preview.wrapper_approval_fingerprint,
      approveGolden: preview.golden_approval_fingerprint,
      testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
      testBootstrapCandidateSha: testCandidateSha,
      testBootstrapFieldReceiptPath: fieldReceiptPath,
      testBootstrapPackagePath: fieldPackagePath,
      testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
      approveTestBootstrapInterruption: "e".repeat(64),
    }, {
      ...copiedFlagHarness.dependencies,
      observeBootstrapInterruptionPoint: async () => assert.fail("observer must remain unreachable"),
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_IDENTITY_INVALID",
  );
  assert.equal(copiedFlagHarness.wranglerCalls.length, 0);
  assert.equal(copiedFlagHarness.adminReads, 0);
  assert.equal(copiedFlagHarness.fetchCalls.length, 0);

  const fieldSourceManifestPath = join(sandbox, "v048-field-source.manifest.json");
  const fieldTargetManifestPath = join(sandbox, "v048-field-target.manifest.json");
  const fieldPlanPath = join(sandbox, ".brain-v048-field-plan.json");
  const fieldStatePath = join(sandbox, ".brain-v048-field-state.json");
  const fieldArtifactDirectory = join(sandbox, "private-v048-field-artifacts");
  writePrivateJson(fieldSourceManifestPath, syntheticFieldSourceManifest);
  writePrivateJson(fieldTargetManifestPath, syntheticFieldTargetManifest);
  mkdirSync(fieldArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(fieldArtifactDirectory, 0o700);
  const fieldInitialized = initializeVerifiedRecovery(
    fieldSourceManifestPath,
    fieldTargetManifestPath,
    fieldPlanPath,
    fieldStatePath,
    { now: new Date("2026-09-11T14:00:00.000Z") },
  );
  const exactFieldManifestBindings = inspectVerifiedRecoveryManifestBindings(
    fieldInitialized.plan,
    fieldSourceManifestPath,
    fieldTargetManifestPath,
  );
  assert.equal(
    assertDisposableRecoveryFieldCampaignIdentity(exactFieldManifestBindings),
    true,
  );
  for (const [label, mutate] of [
    ["source admin-key locator", (value) => { value.source.adminKeySecret += "-other"; }],
    ["target admin-key locator", (value) => { value.target.adminKeySecret += "-other"; }],
    ["target artifact-key locator", (value) => {
      value.target.recoveryArtifactKeySecret += "-other";
    }],
    ["source artifact-key locator", (value) => {
      value.source.recoveryArtifactKeySecret = value.target.recoveryArtifactKeySecret;
    }],
    ["source OCR mode", (value) => { value.source.ocrEnabled = "1"; }],
    ["target OCR model", (value) => { value.target.ocrModel = "@cf/example/other"; }],
    ["source connector enablement", (value) => {
      value.source.enabledCorpora = ["google_drive"];
    }],
    ["target bank enablement", (value) => { value.target.bankFeedEnabled = true; }],
    ["mutable manifest isolation", (value) => {
      value.target.recoveryFieldGate = { active_worker_version_id: "unreviewed" };
    }],
  ]) {
    const changed = structuredClone(exactFieldManifestBindings);
    mutate(changed);
    assert.throws(
      () => assertDisposableRecoveryFieldCampaignIdentity(changed),
      (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_IDENTITY_INVALID",
      label,
    );
  }
  assert.throws(
    () => inspectDisposableRecoveryDeploymentPreparation({
      candidateSha: testCandidateSha,
      fieldReceiptPath,
      packagePath: fieldPackagePath,
      wranglerWrapperPath: wrapperPath,
      sourceManifestPath,
      targetManifestPath,
      plan: initialized.plan,
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_IDENTITY_INVALID",
    "deployment preparation must reject non-campaign manifests before provider creation",
  );
  const deploymentPreparation = inspectDisposableRecoveryDeploymentPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath,
    packagePath: fieldPackagePath,
    wranglerWrapperPath: wrapperPath,
    sourceManifestPath: fieldSourceManifestPath,
    targetManifestPath: fieldTargetManifestPath,
    plan: fieldInitialized.plan,
  });
  const sourceDeploymentPreparation =
    inspectDisposableRecoverySourceDeploymentPreparation({
      candidateSha: testCandidateSha,
      fieldReceiptPath,
      packagePath: fieldPackagePath,
      wranglerWrapperPath: wrapperPath,
      sourceManifestPath: fieldSourceManifestPath,
      plan: fieldInitialized.plan,
    });
  assert.equal(
    assertDisposableRecoverySourceFieldCampaignIdentity(
      sourceDeploymentPreparation.manifestBindings,
    ),
    true,
  );
  assert.deepEqual(Object.keys(sourceDeploymentPreparation.manifestBindings).sort(), [
    "planFingerprint", "source", "sourceManifestFingerprint",
  ]);
  assert.equal(sourceDeploymentPreparation.binding.campaign_fingerprint,
    deploymentPreparation.binding.campaign_fingerprint);
  writePrivateJson(
    fieldSourcePreflightReceiptPath,
    fullDisposableSourcePreflightReceipt(deploymentPreparation.binding),
  );
  const fieldSourcePreflightReceiptSha256 =
    hash(readFileSync(fieldSourcePreflightReceiptPath));
  const fieldSourcePhaseReceipt = fullDisposableSourcePhaseReceipt(
    deploymentPreparation.binding,
    fieldSourcePreflightReceiptSha256,
  );
  writePrivateJson(
    fieldSourcePhaseReceiptPath,
    fieldSourcePhaseReceipt,
  );
  const fieldSourcePhaseReceiptSha256 =
    hash(readFileSync(fieldSourcePhaseReceiptPath));
  const seedPreparation = inspectDisposableRecoverySeedPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath,
    sourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    packagePath: fieldPackagePath,
    wranglerWrapperPath: wrapperPath,
    plan: fieldInitialized.plan,
  });
  writePrivateJson(
    fieldSeedReceiptPath,
    fullDisposableSeedReceipt(seedPreparation.binding),
  );
  const fieldSeedReceiptSha256 = hash(readFileSync(fieldSeedReceiptPath));
  writePrivateJson(
    fieldTargetPreflightReceiptPath,
    fullDisposableTargetPreflightReceipt(
      deploymentPreparation.binding,
      fieldSourcePhaseReceiptSha256,
      fieldSeedReceiptSha256,
    ),
  );
  const fieldTargetPreflightReceiptSha256 =
    hash(readFileSync(fieldTargetPreflightReceiptPath));
  writePrivateJson(
    fieldDeploymentReceiptPath,
    fullDisposableDeploymentReceipt(
      deploymentPreparation.binding,
      fieldSourcePhaseReceipt,
      fieldSourcePhaseReceiptSha256,
      fieldSeedReceiptSha256,
      fieldTargetPreflightReceiptSha256,
    ),
  );
  assert.equal(
    readPrivateAggregateReceipt(fieldSeedReceiptPath).value.d1.documents,
    6_001,
  );
  const fieldBaseConfig = {
    sourceManifestPath: fieldSourceManifestPath,
    targetManifestPath: fieldTargetManifestPath,
    planPath: fieldPlanPath,
    statePath: fieldStatePath,
    artifactDirectory: fieldArtifactDirectory,
    wranglerWrapperPath: wrapperPath,
    goldenPath,
    fieldDeploymentReceiptPath,
  };
  const ordinaryFieldPreview = previewCloudflareRecoveryFieldGate(
    fieldBaseConfig,
    { platform: "darwin" },
  );
  // A receipt-backed ordinary stage must pin the source deployment even when
  // the later fault-hook bundle is not active. Version or opaque-etag drift is
  // refused before export and before any disposable-target mutation.
  for (const [label, drift] of [
    ["source version", {
      sourceVersionId: "40000000-0000-4000-8000-000000000004",
    }],
    ["source opaque etag", { sourceScriptEtagOverride: "source-etag-drifted" }],
  ]) {
    const sourceDriftHarness = providerHarness({
      ...drift,
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    const sourceDriftGate = createCloudflareRecoveryFieldGateAdapters({
      ...fieldBaseConfig,
      approvePlan: fieldInitialized.plan.plan_fingerprint,
      approveDisposableTarget: fieldInitialized.plan.target_resource_fingerprint,
      approveTargetExecution: ordinaryFieldPreview.target_execution_approval_fingerprint,
      approveSourceExportBlocking:
        ordinaryFieldPreview.source_export_blocking_approval_fingerprint,
      approveWrapper: ordinaryFieldPreview.wrapper_approval_fingerprint,
      approveGolden: ordinaryFieldPreview.golden_approval_fingerprint,
      plan: fieldInitialized.plan,
      state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
    }, sourceDriftHarness.dependencies);
    await assert.rejects(
      sourceDriftGate.adapters.export_d1({
        stage: "export_d1",
        attempt: 1,
        planFingerprint: fieldInitialized.plan.plan_fingerprint,
        targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
        completed: [],
      }),
      (error) => error.code === "RECOVERY_WORKER_CODE_INVALID",
      `${label} drift must invalidate ordinary receipt-backed export`,
    );
    assert.equal(sourceDriftHarness.importCalls, 0, label);
    assert.equal(sourceDriftHarness.bootstrapCalls, 0, label);
    assert.equal(sourceDriftHarness.promotionCalls, 0, label);
    assert.equal(sourceDriftHarness.adminReads, 0, label);
    assert.equal(sourceDriftHarness.fetchCalls.length, 0, label);
    assert.equal(sourceDriftHarness.wranglerCalls.some((call) =>
      call.env.CLOUDFLARE_ACCOUNT_ID ===
        syntheticFieldTargetManifest.infrastructure.cloudflare.account_id), false, label);
    assert.equal(sourceDriftHarness.wranglerCalls.some((call) =>
      call.args[0] === "d1" && call.args[1] === "export"), false, label);
  }
  const fieldHarness = providerHarness({
    bootstrapPageSize: 3_000,
    failEvalOnce: true,
    failPromotionAfterApplyOnce: true,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const fieldDependencies = fieldHarness.dependencies;
  const fieldRequestConfig = Object.freeze({
    ...fieldBaseConfig,
    testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    testBootstrapCandidateSha: testCandidateSha,
    testBootstrapFieldReceiptPath: fieldReceiptPath,
    testBootstrapPackagePath: fieldPackagePath,
    testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
    testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
  });
  let stagedFieldError = null;
  let stagedFieldResult = null;
  try {
    stagedFieldResult = await runCloudflareRecoveryFieldGate({
      ...fieldBaseConfig,
      approvePlan: fieldInitialized.plan.plan_fingerprint,
      approveDisposableTarget: fieldInitialized.plan.target_resource_fingerprint,
      approveTargetExecution: ordinaryFieldPreview.target_execution_approval_fingerprint,
      approveSourceExportBlocking:
        ordinaryFieldPreview.source_export_blocking_approval_fingerprint,
      approveWrapper: ordinaryFieldPreview.wrapper_approval_fingerprint,
      approveGolden: ordinaryFieldPreview.golden_approval_fingerprint,
      stopAfterStage: "reconcile_security",
    }, fieldDependencies);
  } catch (error) {
    stagedFieldError = error;
  }
  assert.equal(
    stagedFieldError?.code ?? stagedFieldResult?.cause,
    "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION",
  );
  const stagedFieldState = loadVerifiedRecoveryState(
    fieldStatePath,
    fieldInitialized.plan,
  );
  assert.equal(stagedFieldState.current_stage, "rebuild_vectorize");
  assert.equal(stagedFieldState.attempt, 0);
  assert.deepEqual(stagedFieldState.completed.map((entry) => entry.id), [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
    "verify_d1", "reconcile_security",
  ]);
  const verifyD1ResumeState = {
    ...structuredClone(stagedFieldState),
    status: "running",
    current_stage: "verify_d1",
    stage_status: "pending",
    attempt: 0,
    completed: structuredClone(stagedFieldState.completed.slice(0, 4)),
    failure: null,
  };
  for (const [stage, resumeState, drift] of [
    ["verify_d1", verifyD1ResumeState, {
      sourceVersionId: "40000000-0000-4000-8000-000000000004",
    }],
    ["rebuild_vectorize", stagedFieldState, {
      sourceScriptEtagOverride: "source-etag-drifted-on-resume",
    }],
  ]) {
    writeVerifiedRecoveryState(fieldStatePath, resumeState, fieldInitialized.plan);
    const resumedSourceDriftHarness = providerHarness({
      ...drift,
      initialTargetRestored: true,
      targetChunkCount: 7_202,
      targetDocumentCount: 6_001,
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    await assert.rejects(
      runCloudflareRecoveryFieldGate({
        ...fieldBaseConfig,
        approvePlan: fieldInitialized.plan.plan_fingerprint,
        approveDisposableTarget: fieldInitialized.plan.target_resource_fingerprint,
        approveTargetExecution: ordinaryFieldPreview.target_execution_approval_fingerprint,
        approveSourceExportBlocking:
          ordinaryFieldPreview.source_export_blocking_approval_fingerprint,
        approveWrapper: ordinaryFieldPreview.wrapper_approval_fingerprint,
        approveGolden: ordinaryFieldPreview.golden_approval_fingerprint,
      }, resumedSourceDriftHarness.dependencies),
      (error) => error.code === "RECOVERY_WORKER_CODE_INVALID",
      `${stage} resume must rebind the receipt-pinned source before target access`,
    );
    assert.equal(resumedSourceDriftHarness.importCalls, 0, stage);
    assert.equal(resumedSourceDriftHarness.bootstrapCalls, 0, stage);
    assert.equal(resumedSourceDriftHarness.promotionCalls, 0, stage);
    assert.equal(resumedSourceDriftHarness.adminReads, 0, stage);
    assert.equal(resumedSourceDriftHarness.fetchCalls.length, 0, stage);
    assert.equal(resumedSourceDriftHarness.wranglerCalls.some((call) =>
      call.env.CLOUDFLARE_ACCOUNT_ID ===
        syntheticFieldTargetManifest.infrastructure.cloudflare.account_id), false, stage);
  }
  writeVerifiedRecoveryState(fieldStatePath, stagedFieldState, fieldInitialized.plan);
  const prefixedWrapperHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  try {
    writeFileSync(
      wrapperPath,
      `#!/bin/sh\n: "\${CLOUDFLARE_ACCOUNT_ID:?}"\n${wrapperScript.slice("#!/bin/sh\n".length)}`,
    );
    if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
    assert.throws(
      () => createCloudflareRecoveryFieldGateAdapters({
        ...fieldBaseConfig,
        plan: fieldInitialized.plan,
        state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
        testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
        testBootstrapCandidateSha: testCandidateSha,
        testBootstrapFieldReceiptPath: fieldReceiptPath,
        testBootstrapPackagePath: fieldPackagePath,
        testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
        testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
        testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
      }, prefixedWrapperHarness.dependencies),
      (error) => error.code ===
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRAPPER_CONTRACT_INVALID",
      "a prefix command cannot run before the pinned Node trampoline",
    );
    assert.equal(prefixedWrapperHarness.wranglerCalls.length, 0);
    assert.equal(prefixedWrapperHarness.adminReads, 0);
    assert.equal(prefixedWrapperHarness.fetchCalls.length, 0);
  } finally {
    writeFileSync(wrapperPath, wrapperScript);
    if (process.platform !== "win32") chmodSync(wrapperPath, 0o700);
  }
  const fieldPreview = previewCloudflareRecoveryFieldGate(
    fieldRequestConfig,
    { platform: "darwin" },
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.mode,
    RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
  );
  assert.equal(fieldPreview.test_bootstrap_interruption.candidate_sha, testCandidateSha);
  assert.equal(
    fieldPreview.test_bootstrap_interruption.package_sha256,
    hash(fieldPackageBytes),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.field_receipt_sha256,
    hash(readFileSync(fieldReceiptPath)),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.source_preflight_receipt_sha256,
    hash(readFileSync(fieldSourcePreflightReceiptPath)),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.source_phase_receipt_sha256,
    hash(readFileSync(fieldSourcePhaseReceiptPath)),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.seed_receipt_sha256,
    hash(readFileSync(fieldSeedReceiptPath)),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.target_preflight_receipt_sha256,
    hash(readFileSync(fieldTargetPreflightReceiptPath)),
  );
  assert.equal(
    fieldPreview.test_bootstrap_interruption.deployment_receipt_sha256,
    hash(readFileSync(fieldDeploymentReceiptPath)),
  );
  assert.match(fieldPreview.test_bootstrap_interruption.approval_fingerprint, /^[0-9a-f]{64}$/);
  const approvedFieldConfig = Object.freeze({
    ...fieldBaseConfig,
    approvePlan: fieldInitialized.plan.plan_fingerprint,
    approveDisposableTarget: fieldInitialized.plan.target_resource_fingerprint,
    approveTargetExecution: fieldPreview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: fieldPreview.source_export_blocking_approval_fingerprint,
    approveWrapper: fieldPreview.wrapper_approval_fingerprint,
    approveGolden: fieldPreview.golden_approval_fingerprint,
    testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    testBootstrapCandidateSha: testCandidateSha,
    testBootstrapFieldReceiptPath: fieldReceiptPath,
    testBootstrapPackagePath: fieldPackagePath,
    testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
    testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
    approveTestBootstrapInterruption:
      fieldPreview.test_bootstrap_interruption.approval_fingerprint,
  });

  // Individually valid receipts from a different causal chain cannot be
  // substituted into the full bootstrap evidence. Re-sealing the final A4
  // receipt around the substituted target preflight still fails closed when
  // the adapter independently reloads and validates every receipt edge.
  const validFieldTargetPreflightReceipt = JSON.parse(
    readFileSync(fieldTargetPreflightReceiptPath, "utf8"),
  );
  const validFieldDeploymentReceipt = JSON.parse(
    readFileSync(fieldDeploymentReceiptPath, "utf8"),
  );
  try {
    const swappedTargetPreflightReceipt = structuredClone(
      validFieldTargetPreflightReceipt,
    );
    swappedTargetPreflightReceipt.source_phase_receipt_sha256 =
      fieldSourcePreflightReceiptSha256;
    assertDisposableRecoveryTargetPreflightReceipt(swappedTargetPreflightReceipt);
    writePrivateJson(
      fieldTargetPreflightReceiptPath,
      swappedTargetPreflightReceipt,
    );
    const swappedTargetPreflightReceiptSha256 = hash(
      readFileSync(fieldTargetPreflightReceiptPath),
    );
    const resealedDeploymentReceipt = structuredClone(validFieldDeploymentReceipt);
    resealedDeploymentReceipt.target_preflight_receipt_sha256 =
      swappedTargetPreflightReceiptSha256;
    resealedDeploymentReceipt.a4_approval_fingerprint =
      disposableRecoveryTargetA4Fingerprint(
        resealedDeploymentReceipt.binding,
        resealedDeploymentReceipt.source_phase_receipt_sha256,
        resealedDeploymentReceipt.seed_receipt_sha256,
        swappedTargetPreflightReceiptSha256,
      );
    assertDisposableRecoveryDeploymentReceipt(resealedDeploymentReceipt);
    writePrivateJson(fieldDeploymentReceiptPath, resealedDeploymentReceipt);
    assert.throws(
      () => previewCloudflareRecoveryFieldGate(fieldRequestConfig, {
        platform: "darwin",
      }),
      (error) => error.code ===
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
      "a valid target preflight from another receipt prefix must be rejected",
    );
  } finally {
    writePrivateJson(
      fieldTargetPreflightReceiptPath,
      validFieldTargetPreflightReceipt,
    );
    writePrivateJson(fieldDeploymentReceiptPath, validFieldDeploymentReceipt);
  }

  // Recomputing A4 after tampering with the final source-phase link proves
  // only that the final object is internally well formed. The independently
  // re-read source receipt must still be the exact hash linked by that object.
  try {
    const relinkedDeploymentReceipt = structuredClone(validFieldDeploymentReceipt);
    relinkedDeploymentReceipt.source_phase_receipt_sha256 =
      fieldSourcePreflightReceiptSha256;
    relinkedDeploymentReceipt.a4_approval_fingerprint =
      disposableRecoveryTargetA4Fingerprint(
        relinkedDeploymentReceipt.binding,
        relinkedDeploymentReceipt.source_phase_receipt_sha256,
        relinkedDeploymentReceipt.seed_receipt_sha256,
        relinkedDeploymentReceipt.target_preflight_receipt_sha256,
      );
    assertDisposableRecoveryDeploymentReceipt(relinkedDeploymentReceipt);
    writePrivateJson(fieldDeploymentReceiptPath, relinkedDeploymentReceipt);
    assert.throws(
      () => previewCloudflareRecoveryFieldGate(fieldRequestConfig, {
        platform: "darwin",
      }),
      (error) => error.code ===
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
      "a re-signed final receipt cannot relink an unverified source phase",
    );
  } finally {
    writePrivateJson(fieldDeploymentReceiptPath, validFieldDeploymentReceipt);
  }

  // Both phase receipts are pinned again at every later provider or credential
  // boundary. A valid receipt that changes after gate construction is rejected
  // as changed evidence, including the terminal receipt whose hash has no later
  // receipt edge.
  for (const {
    label,
    path,
    receipt,
    mutate,
    validate,
  } of [
    {
      label: "source phase",
      path: fieldSourcePhaseReceiptPath,
      receipt: fieldSourcePhaseReceipt,
      mutate: (value) => {
        value.final_snapshot.first_raw_evidence_manifest_sha256 =
          fixedReceiptHash(95);
      },
      validate: assertDisposableRecoverySourcePhaseReceipt,
    },
    {
      label: "final target phase",
      path: fieldDeploymentReceiptPath,
      receipt: validFieldDeploymentReceipt,
      mutate: (value) => {
        value.final_snapshot.first_raw_evidence_manifest_sha256 =
          fixedReceiptHash(96);
      },
      validate: assertDisposableRecoveryDeploymentReceipt,
    },
  ]) {
    const receiptPinHarness = providerHarness({
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    const receiptPinGate = createCloudflareRecoveryFieldGateAdapters({
      ...approvedFieldConfig,
      plan: fieldInitialized.plan,
      state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
    }, receiptPinHarness.dependencies);
    try {
      const changedReceipt = structuredClone(receipt);
      mutate(changedReceipt);
      validate(changedReceipt);
      writePrivateJson(path, changedReceipt);
      assert.throws(
        () => receiptPinGate.revalidate(),
        (error) => error.code ===
          "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED",
        `${label} is independently re-read before later boundaries`,
      );
      assert.equal(receiptPinHarness.wranglerCalls.length, 0, label);
      assert.equal(receiptPinHarness.adminReads, 0, label);
      assert.equal(receiptPinHarness.fetchCalls.length, 0, label);
    } finally {
      writePrivateJson(path, receipt);
    }
  }

  const fieldExportContext = Object.freeze({
    stage: "export_d1",
    attempt: 1,
    planFingerprint: fieldInitialized.plan.plan_fingerprint,
    targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
    completed: Object.freeze([]),
  });
  for (const [name, value] of Object.entries({
    CHUNK_SIZE: "1499",
    CHUNK_OVERLAP: "299",
    DAILY_LLM_CAP_USD: "9.5",
    BRAIN_OWNER: "Synthetic Field Gate altered owner",
    ANSWER_MODEL: "@cf/example/altered-answer-model",
    CREDENTIAL_SCANNER: "off",
    OCR_ENABLED: "1",
    OCR_MODEL: "@cf/example/altered-ocr-model",
  })) {
    const mismatchHarness = providerHarness({
      plainTextOverrides: { [name]: value },
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    const mismatchGate = createCloudflareRecoveryFieldGateAdapters({
      ...approvedFieldConfig,
      plan: fieldInitialized.plan,
      state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
    }, mismatchHarness.dependencies);
    await assert.rejects(
      mismatchGate.adapters.export_d1(fieldExportContext),
      (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
      `fixed campaign must reject a mismatched ${name} readback`,
    );
    assert.equal(mismatchHarness.adminReads, 0, name);
    assert.equal(mismatchHarness.fetchCalls.length, 0, name);
    assert.equal(mismatchHarness.wranglerCalls.some((call) =>
      call.args[0] === "d1" && call.args[1] === "export"), false, name);
  }
  const optionalSecretHarness = providerHarness({
    zoomSecretGroup: true,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const optionalSecretGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, optionalSecretHarness.dependencies);
  await assert.rejects(
    optionalSecretGate.adapters.export_d1(fieldExportContext),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
    "the fictional campaign refuses even generally supported optional connector secrets",
  );
  assert.equal(optionalSecretHarness.adminReads, 0);
  assert.equal(optionalSecretHarness.fetchCalls.length, 0);
  assert.equal(optionalSecretHarness.wranglerCalls.some((call) =>
    call.args[0] === "d1" && call.args[1] === "export"), false);

  // A durable deployment pending sibling means a provider mutation may have
  // crossed its response boundary. It blocks the adapter before Wrangler,
  // Keychain, or the Brain data plane can be touched.
  const fieldDeploymentPendingPath = fieldDeploymentReceiptPath
    .replace(/\.json$/u, ".pending.json");
  writePrivateJson(fieldDeploymentPendingPath, {
    schema_version: 1,
    kind: "v048_disposable_recovery_deployment_pending",
    status: "execution_in_progress",
  });
  const pendingDeploymentHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate(approvedFieldConfig, pendingDeploymentHarness.dependencies),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  assert.equal(pendingDeploymentHarness.wranglerCalls.length, 0);
  assert.equal(pendingDeploymentHarness.adminReads, 0);
  assert.equal(pendingDeploymentHarness.fetchCalls.length, 0);
  unlinkSync(fieldDeploymentPendingPath);

  // A durable pending sibling means the seed runner may have crossed a live
  // boundary without finalizing. It blocks the adapter before Wrangler,
  // Keychain, or the Brain data plane can be touched.
  const fieldSeedPendingPath = fieldSeedReceiptPath.replace(/\.json$/u, ".pending.json");
  writePrivateJson(fieldSeedPendingPath, {
    schema_version: 1,
    kind: "v048_disposable_recovery_seed_pending",
    status: "execution_in_progress",
  });
  const pendingSeedHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate(approvedFieldConfig, pendingSeedHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
  );
  assert.equal(pendingSeedHarness.wranglerCalls.length, 0);
  assert.equal(pendingSeedHarness.adminReads, 0);
  assert.equal(pendingSeedHarness.fetchCalls.length, 0);
  unlinkSync(fieldSeedPendingPath);

  // The old 3,201-document contract is invalid receipt evidence, even when all
  // candidate/package/runtime hashes remain correct.
  const validFieldSeedReceipt = JSON.parse(readFileSync(fieldSeedReceiptPath, "utf8"));
  const staleFieldSeedReceipt = structuredClone(validFieldSeedReceipt);
  staleFieldSeedReceipt.fixture.documents = 3_201;
  staleFieldSeedReceipt.ingest.accepted_documents = 3_201;
  staleFieldSeedReceipt.ingest.created_documents = 3_201;
  staleFieldSeedReceipt.verification_replay.unchanged_documents = 3_201;
  staleFieldSeedReceipt.d1.documents = 3_201;
  writePrivateJson(fieldSeedReceiptPath, staleFieldSeedReceipt);
  const staleSeedHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate(approvedFieldConfig, staleSeedHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
  );
  assert.equal(staleSeedHarness.wranglerCalls.length, 0);
  assert.equal(staleSeedHarness.adminReads, 0);
  assert.equal(staleSeedHarness.fetchCalls.length, 0);
  writePrivateJson(fieldSeedReceiptPath, validFieldSeedReceipt);

  // A well-formed but substituted direct-D1 hash gets its own exact approval,
  // then still fails the fresh source/artifact equality check before any
  // target bootstrap or promotion and before the journal is bound.
  const wrongFingerprintSeedReceipt = structuredClone(validFieldSeedReceipt);
  wrongFingerprintSeedReceipt.d1.content_fingerprint = "f".repeat(64);
  writePrivateJson(fieldSeedReceiptPath, wrongFingerprintSeedReceipt);
  writeDisposableTargetReceiptPair({
    binding: deploymentPreparation.binding,
    deploymentReceiptPath: fieldDeploymentReceiptPath,
    seedReceiptPath: fieldSeedReceiptPath,
    sourcePhaseReceipt: fieldSourcePhaseReceipt,
    sourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    targetPreflightReceiptPath: fieldTargetPreflightReceiptPath,
  });
  const wrongFingerprintPreview = previewCloudflareRecoveryFieldGate({
    ...fieldBaseConfig,
    testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    testBootstrapCandidateSha: testCandidateSha,
    testBootstrapFieldReceiptPath: fieldReceiptPath,
    testBootstrapPackagePath: fieldPackagePath,
    testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
    testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
  }, { platform: "darwin" });
  const wrongFingerprintHarness = providerHarness({
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...approvedFieldConfig,
      approveTargetExecution:
        wrongFingerprintPreview.target_execution_approval_fingerprint,
      approveTestBootstrapInterruption:
        wrongFingerprintPreview.test_bootstrap_interruption.approval_fingerprint,
    }, wrongFingerprintHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SEED_MISMATCH",
  );
  assert.equal(wrongFingerprintHarness.bootstrapCalls, 0);
  assert.equal(wrongFingerprintHarness.promotionCalls, 0);
  assert.equal(wrongFingerprintHarness.adminReads, 0);
  assert.equal(
    Object.hasOwn(
      loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
      "field_proof",
    ),
    false,
  );
  writePrivateJson(fieldSeedReceiptPath, validFieldSeedReceipt);
  writeDisposableTargetReceiptPair({
    binding: deploymentPreparation.binding,
    deploymentReceiptPath: fieldDeploymentReceiptPath,
    seedReceiptPath: fieldSeedReceiptPath,
    sourcePhaseReceipt: fieldSourcePhaseReceipt,
    sourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
    targetPreflightReceiptPath: fieldTargetPreflightReceiptPath,
  });

  // The receipt and approval bind the clean, cache-integrity-derived runtime.
  // Replacing either the entrypoint or a transitive package with changed bytes
  // under the same package version is refused before wrapper, key, or provider
  // access.
  for (const relativePath of [
    LOCKED_WRANGLER_ENTRYPOINT,
    "node_modules/miniflare/dist/src/index.js",
  ]) {
    const runtimePath = join(
      fieldPreparationDirectory,
      LOCKED_WRANGLER_RUNTIME_DIRECTORY,
      relativePath,
    );
    const original = readFileSync(runtimePath);
    const mode = statSync(runtimePath).mode & 0o777;
    const harness = providerHarness({
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    try {
      writeFileSync(runtimePath, Buffer.concat([
        original,
        Buffer.from("\n// same-version synthetic prepared-runtime corruption\n"),
      ]));
      await assert.rejects(
        runCloudflareRecoveryFieldGate(approvedFieldConfig, harness.dependencies),
        (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
        relativePath,
      );
      assert.equal(harness.wranglerCalls.length, 0, relativePath);
      assert.equal(harness.adminReads, 0, relativePath);
      assert.equal(harness.fetchCalls.length, 0, relativePath);
    } finally {
      writeFileSync(runtimePath, original);
      if (process.platform !== "win32") chmodSync(runtimePath, mode);
    }
  }
  const runtimePinHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const runtimePinDependencies = { ...runtimePinHarness.dependencies };
  delete runtimePinDependencies.assertLockedWranglerRuntimeUnchanged;
  const runtimePinGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, runtimePinDependencies);
  const pinnedDependencyPath = join(
    fieldPreparationDirectory,
    LOCKED_WRANGLER_RUNTIME_DIRECTORY,
    "node_modules/miniflare/dist/src/index.js",
  );
  const pinnedDependencyBytes = readFileSync(pinnedDependencyPath);
  const pinnedDependencyMode = statSync(pinnedDependencyPath).mode & 0o777;
  try {
    writeFileSync(pinnedDependencyPath, Buffer.concat([
      pinnedDependencyBytes,
      Buffer.from("\n// changed after local evidence was pinned\n"),
    ]));
    assert.throws(
      () => runtimePinGate.revalidate(),
      (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED",
    );
    assert.equal(runtimePinHarness.wranglerCalls.length, 0);
    assert.equal(runtimePinHarness.adminReads, 0);
    assert.equal(runtimePinHarness.fetchCalls.length, 0);
  } finally {
    writeFileSync(pinnedDependencyPath, pinnedDependencyBytes);
    if (process.platform !== "win32") chmodSync(pinnedDependencyPath, pinnedDependencyMode);
  }
  lockedWranglerRuntime = inspectLockedWranglerRuntime(
    join(fieldPreparationDirectory, LOCKED_WRANGLER_RUNTIME_DIRECTORY),
    { ownerOnly: true, exactRoot: true },
  );

  const undersizedFieldHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const undersizedFieldGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, undersizedFieldHarness.dependencies);
  await assert.rejects(
    undersizedFieldGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SCALE_INVALID",
  );
  assert.equal(undersizedFieldHarness.wranglerCalls.length, 0);
  assert.equal(undersizedFieldHarness.adminReads, 0);
  assert.equal(undersizedFieldHarness.fetchCalls.length, 0);

  const largeFieldSnapshot = snapshotForCounts(6_001, 7_202);
  const wrapperSwapHarness = providerHarness({
    initialTargetRestored: true,
    sourceChunkCount: 7_202,
    sourceDocumentCount: 6_001,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const wrapperSwapDependencies = { ...wrapperSwapHarness.dependencies };
  const fixtureMaterialize = wrapperSwapDependencies.materializeWranglerRuntime;
  wrapperSwapDependencies.materializeWranglerRuntime = (expected, destination) => {
    const materialized = fixtureMaterialize(expected, destination);
    const executionWrapper = join(dirname(destination), "wrangler-pinned");
    const bytes = readFileSync(executionWrapper);
    unlinkSync(executionWrapper);
    writeFileSync(executionWrapper, bytes, { flag: "wx", mode: 0o700 });
    if (process.platform !== "win32") chmodSync(executionWrapper, 0o700);
    bytes.fill(0);
    return materialized;
  };
  const wrapperSwapGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, wrapperSwapDependencies);
  await assert.rejects(
    wrapperSwapGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: largeFieldSnapshot }],
    }),
    (error) => error.code ===
      "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_CHANGED",
    "same-byte wrapper replacement is refused before the child/provider boundary",
  );
  assert.equal(wrapperSwapHarness.wranglerCalls.length, 0);
  assert.equal(wrapperSwapHarness.adminReads, 0);
  assert.equal(wrapperSwapHarness.fetchCalls.length, 0);

  const wrapperMidCallHarness = providerHarness({
    initialTargetRestored: true,
    sourceChunkCount: 7_202,
    sourceDocumentCount: 6_001,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const wrapperMidCallDependencies = { ...wrapperMidCallHarness.dependencies };
  const fixtureRunWrangler = wrapperMidCallDependencies.runWrangler;
  let swappedWrapperDuringCall = false;
  wrapperMidCallDependencies.runWrangler = async (request) => {
    if (!swappedWrapperDuringCall) {
      swappedWrapperDuringCall = true;
      const bytes = readFileSync(request.command);
      unlinkSync(request.command);
      writeFileSync(request.command, bytes, { flag: "wx", mode: 0o700 });
      if (process.platform !== "win32") chmodSync(request.command, 0o700);
      bytes.fill(0);
    }
    return fixtureRunWrangler(request);
  };
  const wrapperMidCallGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, wrapperMidCallDependencies);
  await assert.rejects(
    wrapperMidCallGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: largeFieldSnapshot }],
    }),
    (error) => error.code ===
      "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_CHANGED",
    "same-byte wrapper replacement during the call invalidates its result",
  );
  assert.equal(wrapperMidCallHarness.wranglerCalls.length, 1);
  assert.equal(wrapperMidCallHarness.adminReads, 0);
  assert.equal(wrapperMidCallHarness.fetchCalls.length, 0);

  const callRuntimeSwapHarness = providerHarness({
    initialTargetRestored: true,
    sourceChunkCount: 7_202,
    sourceDocumentCount: 6_001,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const callRuntimeSwapDependencies = { ...callRuntimeSwapHarness.dependencies };
  callRuntimeSwapDependencies.materializeWranglerRuntime = (expected, destination) => {
    const materialized = materializeLockedWranglerRuntime(expected, destination);
    const bytes = readFileSync(materialized.entrypointPath);
    unlinkSync(materialized.entrypointPath);
    writeFileSync(materialized.entrypointPath, bytes, { flag: "wx", mode: 0o700 });
    if (process.platform !== "win32") chmodSync(materialized.entrypointPath, 0o700);
    bytes.fill(0);
    return materialized;
  };
  delete callRuntimeSwapDependencies.assertMaterializedWranglerRuntimeUnchanged;
  const callRuntimeSwapGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, callRuntimeSwapDependencies);
  await assert.rejects(
    callRuntimeSwapGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: largeFieldSnapshot }],
    }),
    (error) => error.code ===
      "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_INVALID",
    "same-version call-local entrypoint replacement is refused before execution",
  );
  assert.equal(callRuntimeSwapHarness.wranglerCalls.length, 0);
  assert.equal(callRuntimeSwapHarness.adminReads, 0);
  assert.equal(callRuntimeSwapHarness.fetchCalls.length, 0);

  const wrongWranglerHarness = providerHarness({
    initialTargetRestored: true,
    sourceChunkCount: 7_202,
    sourceDocumentCount: 6_001,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    wranglerVersion: "4.99.0",
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const wrongWranglerGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, wrongWranglerHarness.dependencies);
  await assert.rejects(
    wrongWranglerGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: largeFieldSnapshot }],
    }),
    (error) => error.code === "RECOVERY_WRANGLER_VERSION_UNSUPPORTED",
  );
  assert.equal(wrongWranglerHarness.wranglerCalls.length, 1);
  assert.equal(wrongWranglerHarness.adminReads, 0);
  assert.equal(wrongWranglerHarness.fetchCalls.length, 0);
  assert.equal(wrongWranglerHarness.promotionCalls, 0);

  const preexistingBootstrapHarness = providerHarness({
    bootstrapPageSize: 3_000,
    initialBootstrapConfirmed: 3_000,
    initialTargetRestored: true,
    initialVectorCount: 0,
    sourceChunkCount: 7_202,
    sourceDocumentCount: 6_001,
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const preexistingBootstrapGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, preexistingBootstrapHarness.dependencies);
  await assert.rejects(
    preexistingBootstrapGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: fieldInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: fieldInitialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: largeFieldSnapshot }],
    }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OPENING_INVALID",
  );
  assert.equal(preexistingBootstrapHarness.bootstrapCalls, 0);
  assert.equal(preexistingBootstrapHarness.adminReads, 0);
  assert.equal(preexistingBootstrapHarness.promotionCalls, 0);

  // A receipt can name the right candidate and carry a self-consistent archive
  // hash while the archive's adapter bytes differ from the code actually
  // executing. Full member-by-member binding rejects that package locally.
  const mismatchedRuntimeDirectory = join(sandbox, "private-v048-runtime-mismatch");
  const mismatchedRuntimeReceiptPath = join(
    mismatchedRuntimeDirectory,
    "field-prepare-receipt.json",
  );
  const mismatchedRuntimePackagePath = join(
    mismatchedRuntimeDirectory,
    "brain-installer-0.4.8.tgz",
  );
  mkdirSync(mismatchedRuntimeDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(mismatchedRuntimeDirectory, 0o700);
  materializeLockedWranglerRuntime(
    lockedWranglerRuntime,
    join(mismatchedRuntimeDirectory, LOCKED_WRANGLER_RUNTIME_DIRECTORY),
  );
  const mismatchedRuntimePackage = packageWithMutatedMember(
    fieldPackageBytes,
    "operations/cloudflare-recovery-adapter.mjs",
  );
  writeFileSync(mismatchedRuntimePackagePath, mismatchedRuntimePackage, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(mismatchedRuntimePackagePath, 0o600);
  writePrivateJson(
    mismatchedRuntimeReceiptPath,
    fullFieldPreparationReceipt(
      testCandidateSha,
      mismatchedRuntimePackage,
      fieldPackage.fileCount,
      { runId: "33333333-3333-4333-8333-333333333333" },
    ),
  );
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...fieldBaseConfig,
      testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
      testBootstrapCandidateSha: testCandidateSha,
      testBootstrapFieldReceiptPath: mismatchedRuntimeReceiptPath,
      testBootstrapPackagePath: mismatchedRuntimePackagePath,
      testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
  );

  const omittedRuntimeDirectory = join(sandbox, "private-v048-runtime-member-omitted");
  const omittedRuntimeReceiptPath = join(
    omittedRuntimeDirectory,
    "field-prepare-receipt.json",
  );
  const omittedRuntimePackagePath = join(
    omittedRuntimeDirectory,
    "brain-installer-0.4.8.tgz",
  );
  mkdirSync(omittedRuntimeDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(omittedRuntimeDirectory, 0o700);
  materializeLockedWranglerRuntime(
    lockedWranglerRuntime,
    join(omittedRuntimeDirectory, LOCKED_WRANGLER_RUNTIME_DIRECTORY),
  );
  const omittedRuntimePackage = packageWithRenamedMember(
    fieldPackageBytes,
    "operations/locked-wrangler-runtime.mjs",
    "operations/locked-wrangler-runtime-omitted.mjs",
  );
  writeFileSync(omittedRuntimePackagePath, omittedRuntimePackage, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(omittedRuntimePackagePath, 0o600);
  writePrivateJson(
    omittedRuntimeReceiptPath,
    fullFieldPreparationReceipt(
      testCandidateSha,
      omittedRuntimePackage,
      fieldPackage.fileCount,
      { runId: "44444444-4444-4444-8444-444444444444" },
    ),
  );
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...fieldBaseConfig,
      testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
      testBootstrapCandidateSha: testCandidateSha,
      testBootstrapFieldReceiptPath: omittedRuntimeReceiptPath,
      testBootstrapPackagePath: omittedRuntimePackagePath,
      testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID",
    "the packed execution inventory must include the locked runtime verifier",
  );

  // Missing/wrong approval, missing evidence, and a wrong-but-well-formed
  // caller SHA all stop before credentials or provider access. The SHA is an
  // expectation only; it cannot override the independently loaded receipt.
  for (const [label, overrides, omitApproval, expectedCodes] of [
    ["missing approval", {}, true, ["RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID"]],
    ["wrong approval", { approveTestBootstrapInterruption: "0".repeat(64) }, false,
      ["RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_APPROVAL_MISMATCH"]],
    ["missing package evidence", { testBootstrapPackagePath: undefined }, false,
      ["RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID"]],
    ["wrong well-formed candidate SHA", { testBootstrapCandidateSha: "d".repeat(40) }, false,
      ["RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CANDIDATE_MISMATCH"]],
  ]) {
    const harness = providerHarness({
      sourceManifestFixture: syntheticFieldSourceManifest,
      targetManifestFixture: syntheticFieldTargetManifest,
    });
    const config = { ...approvedFieldConfig, ...overrides };
    if (omitApproval) delete config.approveTestBootstrapInterruption;
    await assert.rejects(
      runCloudflareRecoveryFieldGate(config, harness.dependencies),
      (error) => expectedCodes.includes(error.code),
      label,
    );
    assert.equal(harness.wranglerCalls.length, 0, label);
    assert.equal(harness.adminReads, 0, label);
    assert.equal(harness.fetchCalls.length, 0, label);
  }

  // Even the same candidate/package/plan needs the approval for this exact
  // field-preparation receipt. A copied approval cannot authorize a later run.
  const replayReceiptDirectory = join(sandbox, "private-v048-field-preparation-replay");
  const replayReceiptPath = join(replayReceiptDirectory, "field-prepare-receipt.json");
  const replayPackagePath = join(replayReceiptDirectory, "brain-installer-0.4.8.tgz");
  const replaySourcePreflightReceiptPath = join(
    replayReceiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  );
  const replaySourcePhaseReceiptPath = join(
    replayReceiptDirectory,
    DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  );
  const replayTargetPreflightReceiptPath = join(
    replayReceiptDirectory,
    DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  );
  const replayDeploymentReceiptPath = join(
    replayReceiptDirectory,
    DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  );
  const replaySeedReceiptPath = join(
    replayReceiptDirectory,
    "v048-disposable-seed-receipt.json",
  );
  mkdirSync(replayReceiptDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(replayReceiptDirectory, 0o700);
  materializeLockedWranglerRuntime(
    lockedWranglerRuntime,
    join(replayReceiptDirectory, LOCKED_WRANGLER_RUNTIME_DIRECTORY),
  );
  writeFileSync(replayPackagePath, fieldPackageBytes, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(replayPackagePath, 0o600);
  writePrivateJson(replayReceiptPath, fullFieldPreparationReceipt(
    testCandidateSha,
    fieldPackageBytes,
    fieldPackage.fileCount,
    { runId: "22222222-2222-4222-8222-222222222222" },
  ));
  const replayDeploymentPreparation = inspectDisposableRecoveryDeploymentPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath: replayReceiptPath,
    packagePath: replayPackagePath,
    wranglerWrapperPath: wrapperPath,
    sourceManifestPath: fieldSourceManifestPath,
    targetManifestPath: fieldTargetManifestPath,
    plan: fieldInitialized.plan,
  });
  writePrivateJson(
    replaySourcePreflightReceiptPath,
    fullDisposableSourcePreflightReceipt(replayDeploymentPreparation.binding),
  );
  const replaySourcePreflightReceiptSha256 =
    hash(readFileSync(replaySourcePreflightReceiptPath));
  const replaySourcePhaseReceipt = fullDisposableSourcePhaseReceipt(
    replayDeploymentPreparation.binding,
    replaySourcePreflightReceiptSha256,
  );
  writePrivateJson(
    replaySourcePhaseReceiptPath,
    replaySourcePhaseReceipt,
  );
  const replaySourcePhaseReceiptSha256 =
    hash(readFileSync(replaySourcePhaseReceiptPath));
  const replaySeedPreparation = inspectDisposableRecoverySeedPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath: replayReceiptPath,
    sourcePhaseReceiptPath: replaySourcePhaseReceiptPath,
    packagePath: replayPackagePath,
    wranglerWrapperPath: wrapperPath,
    plan: fieldInitialized.plan,
  });
  writePrivateJson(
    replaySeedReceiptPath,
    fullDisposableSeedReceipt(replaySeedPreparation.binding),
  );
  const replaySeedReceiptSha256 = hash(readFileSync(replaySeedReceiptPath));
  writePrivateJson(
    replayTargetPreflightReceiptPath,
    fullDisposableTargetPreflightReceipt(
      replayDeploymentPreparation.binding,
      replaySourcePhaseReceiptSha256,
      replaySeedReceiptSha256,
    ),
  );
  const replayTargetPreflightReceiptSha256 =
    hash(readFileSync(replayTargetPreflightReceiptPath));
  writePrivateJson(
    replayDeploymentReceiptPath,
    fullDisposableDeploymentReceipt(
      replayDeploymentPreparation.binding,
      replaySourcePhaseReceipt,
      replaySourcePhaseReceiptSha256,
      replaySeedReceiptSha256,
      replayTargetPreflightReceiptSha256,
    ),
  );
  const replayReceiptHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...approvedFieldConfig,
      fieldDeploymentReceiptPath: replayDeploymentReceiptPath,
      testBootstrapFieldReceiptPath: replayReceiptPath,
      testBootstrapPackagePath: replayPackagePath,
      testBootstrapSourcePhaseReceiptPath: replaySourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: replayDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: replaySeedReceiptPath,
    }, replayReceiptHarness.dependencies),
    (error) => [
      "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
      "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_APPROVAL_MISMATCH",
    ].includes(error.code),
  );
  assert.equal(replayReceiptHarness.wranglerCalls.length, 0);
  assert.equal(replayReceiptHarness.adminReads, 0);
  assert.equal(replayReceiptHarness.fetchCalls.length, 0);

  // The same approval cannot be replayed against a second plan, even when the
  // exact synthetic manifests and candidate SHA are unchanged.
  const replayPlanPath = join(sandbox, ".brain-v048-field-replay-plan.json");
  const replayStatePath = join(sandbox, ".brain-v048-field-replay-state.json");
  const replayArtifactDirectory = join(sandbox, "private-v048-field-replay-artifacts");
  mkdirSync(replayArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(replayArtifactDirectory, 0o700);
  const replayInitialized = initializeVerifiedRecovery(
    fieldSourceManifestPath,
    fieldTargetManifestPath,
    replayPlanPath,
    replayStatePath,
    { now: new Date("2026-09-11T14:01:00.000Z") },
  );
  const replayBase = {
    ...fieldBaseConfig,
    planPath: replayPlanPath,
    statePath: replayStatePath,
    artifactDirectory: replayArtifactDirectory,
  };
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...replayBase,
      testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
      testBootstrapCandidateSha: testCandidateSha,
      testBootstrapFieldReceiptPath: fieldReceiptPath,
      testBootstrapPackagePath: fieldPackagePath,
      testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
    "a deployment receipt from another plan cannot establish isolation",
  );
  const replayPlanDeploymentPreparation = inspectDisposableRecoveryDeploymentPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath: replayReceiptPath,
    packagePath: replayPackagePath,
    wranglerWrapperPath: wrapperPath,
    sourceManifestPath: fieldSourceManifestPath,
    targetManifestPath: fieldTargetManifestPath,
    plan: replayInitialized.plan,
  });
  writePrivateJson(
    replaySourcePreflightReceiptPath,
    fullDisposableSourcePreflightReceipt(replayPlanDeploymentPreparation.binding),
  );
  const replayPlanSourcePreflightReceiptSha256 =
    hash(readFileSync(replaySourcePreflightReceiptPath));
  const replayPlanSourcePhaseReceipt = fullDisposableSourcePhaseReceipt(
    replayPlanDeploymentPreparation.binding,
    replayPlanSourcePreflightReceiptSha256,
  );
  writePrivateJson(
    replaySourcePhaseReceiptPath,
    replayPlanSourcePhaseReceipt,
  );
  const replayPlanSourcePhaseReceiptSha256 =
    hash(readFileSync(replaySourcePhaseReceiptPath));
  const replayPlanSeedPreparation = inspectDisposableRecoverySeedPreparation({
    candidateSha: testCandidateSha,
    fieldReceiptPath: replayReceiptPath,
    sourcePhaseReceiptPath: replaySourcePhaseReceiptPath,
    packagePath: replayPackagePath,
    wranglerWrapperPath: wrapperPath,
    plan: replayInitialized.plan,
  });
  writePrivateJson(
    replaySeedReceiptPath,
    fullDisposableSeedReceipt(replayPlanSeedPreparation.binding),
  );
  const replayPlanSeedReceiptSha256 = hash(readFileSync(replaySeedReceiptPath));
  writePrivateJson(
    replayTargetPreflightReceiptPath,
    fullDisposableTargetPreflightReceipt(
      replayPlanDeploymentPreparation.binding,
      replayPlanSourcePhaseReceiptSha256,
      replayPlanSeedReceiptSha256,
    ),
  );
  const replayPlanTargetPreflightReceiptSha256 =
    hash(readFileSync(replayTargetPreflightReceiptPath));
  writePrivateJson(
    replayDeploymentReceiptPath,
    fullDisposableDeploymentReceipt(
      replayPlanDeploymentPreparation.binding,
      replayPlanSourcePhaseReceipt,
      replayPlanSourcePhaseReceiptSha256,
      replayPlanSeedReceiptSha256,
      replayPlanTargetPreflightReceiptSha256,
    ),
  );
  const replayRequestConfig = Object.freeze({
    ...replayBase,
    fieldDeploymentReceiptPath: replayDeploymentReceiptPath,
    testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    testBootstrapCandidateSha: testCandidateSha,
    testBootstrapFieldReceiptPath: replayReceiptPath,
    testBootstrapPackagePath: replayPackagePath,
    testBootstrapSourcePhaseReceiptPath: replaySourcePhaseReceiptPath,
    testBootstrapDeploymentReceiptPath: replayDeploymentReceiptPath,
    testBootstrapSeedReceiptPath: replaySeedReceiptPath,
  });
  const replayIsolationConfig = Object.freeze({
    ...replayBase,
    fieldDeploymentReceiptPath: replayDeploymentReceiptPath,
  });
  const replayStagePreview = previewCloudflareRecoveryFieldGate(
    replayIsolationConfig,
    { platform: "darwin" },
  );
  const replayHarness = providerHarness({
    targetChunkCount: 7_202,
    targetDocumentCount: 6_001,
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  let stagedReplayError = null;
  try {
    await runCloudflareRecoveryFieldGate({
      ...replayIsolationConfig,
      approvePlan: replayInitialized.plan.plan_fingerprint,
      approveDisposableTarget: replayInitialized.plan.target_resource_fingerprint,
      approveTargetExecution: replayStagePreview.target_execution_approval_fingerprint,
      approveSourceExportBlocking:
        replayStagePreview.source_export_blocking_approval_fingerprint,
      approveWrapper: replayStagePreview.wrapper_approval_fingerprint,
      approveGolden: replayStagePreview.golden_approval_fingerprint,
      stopAfterStage: "reconcile_security",
    }, replayHarness.dependencies);
  } catch (error) {
    stagedReplayError = error;
  }
  assert.equal(
    stagedReplayError?.code,
    "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION",
  );
  const replayPreview = previewCloudflareRecoveryFieldGate(
    replayRequestConfig,
    { platform: "darwin" },
  );
  const replayCallsBeforeCrossPlanRefusal = {
    wrangler: replayHarness.wranglerCalls.length,
    admin: replayHarness.adminReads,
    fetch: replayHarness.fetchCalls.length,
  };
  await assert.rejects(
    runCloudflareRecoveryFieldGate({
      ...replayRequestConfig,
      approvePlan: replayInitialized.plan.plan_fingerprint,
      approveDisposableTarget: replayInitialized.plan.target_resource_fingerprint,
      approveTargetExecution: replayPreview.target_execution_approval_fingerprint,
      approveSourceExportBlocking: replayPreview.source_export_blocking_approval_fingerprint,
      approveWrapper: replayPreview.wrapper_approval_fingerprint,
      approveGolden: replayPreview.golden_approval_fingerprint,
      approveTestBootstrapInterruption:
        fieldPreview.test_bootstrap_interruption.approval_fingerprint,
    }, replayHarness.dependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_APPROVAL_MISMATCH",
  );
  assert.deepEqual({
    wrangler: replayHarness.wranglerCalls.length,
    admin: replayHarness.adminReads,
    fetch: replayHarness.fetchCalls.length,
  }, replayCallsBeforeCrossPlanRefusal);

  const interruptedField = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(interruptedField.ok, false);
  assert.equal(interruptedField.cause, RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_CODE);
  assert.equal(interruptedField.state.current_stage, "rebuild_vectorize");
  assert.equal(interruptedField.state.stage_status, "failed");
  assert.equal(interruptedField.state.attempt, 1);
  assert.deepEqual(interruptedField.state.completed.map((entry) => entry.id), [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
    "verify_d1", "reconcile_security",
  ]);
  assert.equal(fieldHarness.bootstrapCalls, 2);
  assert.equal(fieldHarness.bootstrapConfirmed, 6_000);
  assert.equal(fieldHarness.bootstrapEpoch, 1);
  assert.equal(fieldHarness.bootstrapCursor, "fixture:chunk#00005999");
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.equal(fieldHarness.currentTargetVersionId, fieldPausedWorkerVersionId);
  assert.deepEqual(fieldHarness.openingSnapshots, [0, 0].map((bootstrapCalls) => ({
    bootstrapCalls,
    confirmed: 0,
    epoch: 1,
    protocol: null,
  })));
  assert.deepEqual(fieldHarness.observerSnapshots, [1, 1, 2, 2]
    .map((bootstrapCalls) => ({
      bootstrapCalls,
      confirmed: bootstrapCalls * 3_000,
      epoch: 1,
    })));
  assert.equal(
    existsSync(join(fieldArtifactDirectory, ".brain-recovery-field-gate.lock")),
    false,
  );
  const interruptionCheckpointPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-interruption-v1.json",
  );
  const completedInterruptionCheckpointPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-interruption-v1.completed.json",
  );
  assert.equal(existsSync(interruptionCheckpointPath), true);
  const checkpointText = readFileSync(interruptionCheckpointPath, "utf8");
  assert.equal(checkpointText.includes("fixture:chunk#"), false);
  assert.equal(checkpointText.includes(privateSentinel), false);
  const checkpointReceipt = JSON.parse(checkpointText);
  assert.equal(checkpointReceipt.schema_version, 7);
  assert.equal(checkpointReceipt.plan_fingerprint, fieldInitialized.plan.plan_fingerprint);
  assert.equal(checkpointReceipt.candidate_sha, testCandidateSha);
  assert.equal(checkpointReceipt.field_receipt_sha256, hash(readFileSync(fieldReceiptPath)));
  assert.equal(checkpointReceipt.package_sha256, hash(fieldPackageBytes));
  assert.equal(checkpointReceipt.package_file_count, fieldPackage.fileCount);
  assert.match(checkpointReceipt.execution_inventory_sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    checkpointReceipt.source_preflight_receipt_sha256,
    hash(readFileSync(fieldSourcePreflightReceiptPath)),
  );
  assert.equal(
    checkpointReceipt.source_phase_receipt_sha256,
    hash(readFileSync(fieldSourcePhaseReceiptPath)),
  );
  assert.equal(
    checkpointReceipt.seed_receipt_sha256,
    hash(readFileSync(fieldSeedReceiptPath)),
  );
  assert.equal(
    checkpointReceipt.target_preflight_receipt_sha256,
    hash(readFileSync(fieldTargetPreflightReceiptPath)),
  );
  assert.equal(
    checkpointReceipt.deployment_receipt_sha256,
    hash(readFileSync(fieldDeploymentReceiptPath)),
  );
  assert.equal(
    checkpointReceipt.seed_fixture_sha256,
    DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  );
  assert.equal(
    checkpointReceipt.seed_d1_content_fingerprint,
    deterministicDataFingerprint,
  );
  assert.equal(checkpointReceipt.seed_document_count, 6_001);
  assert.equal(checkpointReceipt.seed_chunk_count, 7_202);
  assert.equal(checkpointReceipt.seed_fts_count, 7_202);
  assert.equal(checkpointReceipt.seed_vector_count, 7_202);
  assert.equal(checkpointReceipt.seed_replay_unchanged_documents, 6_001);
  assert.equal(
    checkpointReceipt.wrangler_runtime_schema_version,
    lockedWranglerRuntime.schemaVersion,
  );
  assert.equal(
    checkpointReceipt.wrangler_wrapper_sha256,
    hash(readFileSync(wrapperPath)),
  );
  assert.equal(
    checkpointReceipt.private_cursor_sha256,
    hash("fixture:chunk#00005999"),
  );
  assert.equal(
    checkpointReceipt.interruption_approval_fingerprint,
    fieldPreview.test_bootstrap_interruption.approval_fingerprint,
  );
  assert.equal(checkpointReceipt.observation.epoch, 1);
  assert.equal(checkpointReceipt.observation.cursor_position, 6_000);
  assert.equal(checkpointReceipt.observation.confirmed, 6_000);
  assert.equal(checkpointReceipt.observation.batch_rows, 6_000);
  assert.equal(checkpointReceipt.observation.ready_to_interrupt, true);

  // Once parsed, a control receipt is pinned to the exact inode and bytes.
  // An identical-byte replacement cannot be substituted between local proof
  // and the first provider or credential boundary.
  const checkpointPinGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, fieldDependencies);
  const beforeCheckpointReplacement = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  };
  unlinkSync(interruptionCheckpointPath);
  writeFileSync(interruptionCheckpointPath, checkpointText, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(interruptionCheckpointPath, 0o600);
  assert.throws(
    () => checkpointPinGate.revalidate(),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
  );
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  }, beforeCheckpointReplacement);

  // A power loss can occur after the checkpoint directory is fsynced but
  // before the generic runner changes its already-durable running state to
  // failed. Only that exact running/running shape is resumable. A looser
  // running/pending state is refused locally without touching the provider or
  // either keychain locator.
  const crashWindowState = {
    ...structuredClone(interruptedField.state),
    status: "running",
    stage_status: "running",
    failure: null,
    updated_at: "2026-09-11T14:02:00.000Z",
  };
  writePrivateJson(fieldStatePath, {
    ...crashWindowState,
    stage_status: "pending",
  });
  const beforeInvalidCrashState = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  };
  await assert.rejects(
    runCloudflareRecoveryFieldGate(approvedFieldConfig, fieldDependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_STATE_INVALID",
  );
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  }, beforeInvalidCrashState);
  writePrivateJson(fieldStatePath, crashWindowState);

  // A copied state/checkpoint cannot resume through an out-of-band active
  // promotion. The special path requires the exact paused version on every
  // attempt and never sends another bootstrap request in this state. Reaching
  // that exact remote check also proves the crash-window state was accepted.
  fieldHarness.setTargetVersionId(fieldActiveWorkerVersionId);
  const activeBypass = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(activeBypass.ok, false);
  assert.equal(activeBypass.cause, "RECOVERY_TARGET_EXECUTION_CHANGED");
  assert.equal(activeBypass.state.attempt, 2);
  assert.equal(fieldHarness.bootstrapCalls, 2);
  assert.equal(fieldHarness.promotionCalls, 0);
  fieldHarness.setTargetVersionId(fieldPausedWorkerVersionId);

  // The ordinal can remain unchanged while the underlying private cursor is
  // replaced. Its private digest is what binds the exact resume cut.
  fieldHarness.setBootstrapCursor("fixture:chunk#same-ordinal-but-different-private-cursor");
  const adminReadsBeforeCursorMismatch = fieldHarness.adminReads;
  const cursorMismatch = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(cursorMismatch.ok, false);
  assert.equal(cursorMismatch.cause, "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH");
  assert.equal(fieldHarness.bootstrapCalls, 2);
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.equal(fieldHarness.adminReads, adminReadsBeforeCursorMismatch,
    "checkpoint mismatch is refused before the Brain admin key is read");
  assert.deepEqual(fieldHarness.observerSnapshots.slice(4, 6), [
    { bootstrapCalls: 2, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 2, confirmed: 6_000, epoch: 1 },
  ], "private cursor mismatch is observed before any new bootstrap request");
  fieldHarness.setBootstrapCursor("fixture:chunk#00005999");

  // A same-epoch ledger rewrite cannot replace admitted batch history with a
  // larger base_count while preserving the same raw cursor. The remote cut is
  // exact only when durable rows, confirmed rows, total confirmation, and
  // provider visibility are all monotonic from the fsynced checkpoint.
  fieldHarness.setObservedBootstrapLedger({ baseCount: 3_000, batchRows: 3_000 });
  const adminReadsBeforeLedgerMismatch = fieldHarness.adminReads;
  const ledgerMismatch = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(ledgerMismatch.ok, false);
  assert.equal(
    ledgerMismatch.cause,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH",
  );
  assert.equal(fieldHarness.bootstrapCalls, 2);
  assert.equal(fieldHarness.adminReads, adminReadsBeforeLedgerMismatch);
  assert.equal(fieldHarness.promotionCalls, 0);
  fieldHarness.setObservedBootstrapLedger({ baseCount: 0, batchRows: null });

  // A 200 response can move non-ordinal progress while leaving the cursor
  // ordinal unchanged. Replacing the opaque cursor at that same ordinal must
  // still fail the first post-resume bracket; a changed vector count cannot
  // make the private checkpoint digest optional.
  fieldHarness.mutateNextBootstrapCursorWithoutOrdinal(
    "fixture:chunk#same-ordinal-after-bootstrap-200",
  );
  const postResponseCursorMismatch = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(postResponseCursorMismatch.ok, false);
  assert.equal(
    postResponseCursorMismatch.cause,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH",
  );
  assert.equal(fieldHarness.bootstrapCalls, 3);
  assert.equal(fieldHarness.bootstrapConfirmed, 6_000);
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.deepEqual(fieldHarness.observerSnapshots.slice(8, 12), [
    { bootstrapCalls: 2, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 2, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 3, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 3, confirmed: 6_000, epoch: 1 },
  ], "same-ordinal private cursor replacement is rejected after the 200 response");
  const resumeAuthorizationPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-resume-authorized-v1.json",
  );
  assert.equal(existsSync(resumeAuthorizationPath), true);
  const resumeAuthorizationText = readFileSync(resumeAuthorizationPath, "utf8");
  assert.equal(resumeAuthorizationText.includes("fixture:chunk#"), false);
  assert.equal(resumeAuthorizationText.includes(privateSentinel), false);
  const resumePinGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, fieldDependencies);
  const beforeResumeReplacement = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  };
  unlinkSync(resumeAuthorizationPath);
  writeFileSync(resumeAuthorizationPath, resumeAuthorizationText, {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(resumeAuthorizationPath, 0o600);
  assert.throws(
    () => resumePinGate.revalidate(),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
  );
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  }, beforeResumeReplacement);

  // Losing the active checkpoint filename cannot make ordinary recovery ignore
  // a still-live phase authorization. Only the completed checkpoint receipt
  // unblocks an ordinary future invocation.
  const activeCheckpointBytes = readFileSync(interruptionCheckpointPath);
  unlinkSync(interruptionCheckpointPath);
  for (const completedFixture of [
    { malformed: true },
    { ...checkpointReceipt, plan_fingerprint: "f".repeat(64) },
  ]) {
    writePrivateJson(completedInterruptionCheckpointPath, completedFixture);
    assert.throws(
      () => previewCloudflareRecoveryFieldGate(fieldBaseConfig, { platform: "darwin" }),
      (error) => error.code ===
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_APPROVAL_REQUIRED",
      "completed-marker existence never bypasses a live resume authorization",
    );
    assert.throws(
      () => previewCloudflareRecoveryFieldGate({
        ...fieldBaseConfig,
        testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
        testBootstrapCandidateSha: testCandidateSha,
        testBootstrapFieldReceiptPath: fieldReceiptPath,
        testBootstrapPackagePath: fieldPackagePath,
        testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
        testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
        testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
      }, { platform: "darwin" }),
      (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID",
      "malformed or cross-plan completion cannot consume this campaign",
    );
    unlinkSync(completedInterruptionCheckpointPath);
  }
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(fieldBaseConfig, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_APPROVAL_REQUIRED",
  );
  writeFileSync(interruptionCheckpointPath, activeCheckpointBytes, { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") chmodSync(interruptionCheckpointPath, 0o600);
  fieldHarness.setBootstrapCursor("fixture:chunk#00005999");
  fieldHarness.setBootstrapVectorCount(6_000);

  // The high-water ordinal is immutable across every resumed observation, not
  // just the pre-POST comparison. A 200 response followed by a changed D1
  // high-water is rejected by the observer/continuity boundary before any
  // active-mode promotion.
  fieldHarness.mutateNextBootstrapHighWaterWithoutOrdinal(7_201);
  const postResponseHighWaterMismatch = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(postResponseHighWaterMismatch.ok, false);
  assert.equal(
    postResponseHighWaterMismatch.cause,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED",
  );
  assert.equal(fieldHarness.bootstrapCalls, 4);
  assert.equal(fieldHarness.bootstrapConfirmed, 6_000);
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.deepEqual(fieldHarness.observerSnapshots.slice(12, 16), [
    { bootstrapCalls: 3, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 3, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 3, confirmed: 6_000, epoch: 1 },
    { bootstrapCalls: 4, confirmed: 6_000, epoch: 1 },
  ], "post-response high-water drift is observed and refused");
  fieldHarness.setObservedBootstrapHighWaterPosition(7_202);
  fieldHarness.setBootstrapVectorCount(6_000);

  // The first POST after a valid resume comparison must move monotonically
  // beyond the checkpoint. An unchanged receipt is not accepted as success or
  // allowed to reach active-mode promotion.
  fieldHarness.holdNextBootstrapProgress();
  const stalledResume = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(stalledResume.ok, false);
  assert.equal(stalledResume.cause, "RECOVERY_BOOTSTRAP_STALLED");
  assert.equal(fieldHarness.bootstrapCalls, 5);
  assert.equal(fieldHarness.bootstrapConfirmed, 6_000);
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.equal(existsSync(interruptionCheckpointPath), true);

  // Once the exact checkpoint cut has been fsynced as resume-authorized, a
  // later POST may commit remotely and lose its response. The next attempt may
  // accept only monotonic same-epoch progress from that checkpoint; it must not
  // be trapped demanding the original cursor forever.
  fieldHarness.failNextBootstrapAfterProgress();
  const lostBootstrapResponse = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(lostBootstrapResponse.ok, false);
  assert.equal(lostBootstrapResponse.cause, "RECOVERY_DATA_PLANE_REQUEST_FAILED");
  assert.equal(lostBootstrapResponse.state.current_stage, "rebuild_vectorize");
  assert.equal(fieldHarness.bootstrapCalls, 6);
  assert.equal(fieldHarness.bootstrapConfirmed, 7_202);
  assert.equal(fieldHarness.currentTargetVersionId, fieldPausedWorkerVersionId);
  assert.equal(fieldHarness.promotionCalls, 0);
  assert.equal(existsSync(interruptionCheckpointPath), true);

  const lostPromotionField = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(lostPromotionField.ok, false);
  assert.equal(lostPromotionField.cause, "RECOVERY_WRANGLER_CALL_FAILED");
  assert.equal(lostPromotionField.state.current_stage, "rebuild_vectorize");
  assert.equal(lostPromotionField.state.stage_status, "failed");
  const promotionAuthorizationPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-promotion-authorized-v1.json",
  );
  assert.equal(existsSync(promotionAuthorizationPath), true);
  const promotionAuthorizationText = readFileSync(promotionAuthorizationPath, "utf8");
  assert.equal(promotionAuthorizationText.includes("fixture:chunk#"), false);
  assert.equal(promotionAuthorizationText.includes(privateSentinel), false);
  assert.equal(existsSync(interruptionCheckpointPath), true);
  assert.equal(fieldHarness.currentTargetVersionId, fieldActiveWorkerVersionId,
    "the exact reviewed promotion applied before its response was lost");
  assert.equal(fieldHarness.promotionCalls, 1);
  const promotionPinGate = createCloudflareRecoveryFieldGateAdapters({
    ...approvedFieldConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, fieldDependencies);
  const beforePromotionReplacement = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  };
  unlinkSync(promotionAuthorizationPath);
  writeFileSync(promotionAuthorizationPath, promotionAuthorizationText, {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(promotionAuthorizationPath, 0o600);
  assert.throws(
    () => promotionPinGate.revalidate(),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
  );
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  }, beforePromotionReplacement);

  // The fsynced promotion authorization distinguishes that lost response from
  // the out-of-band active bypass rejected above. Resume reconciles exact
  // active evidence, sends no second bootstrap POST or deploy, and continues
  // through health/eval before retiring the interruption checkpoint.
  const laterStageFailure = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(laterStageFailure.ok, false);
  assert.equal(laterStageFailure.cause, "RECOVERY_RELEASE_EVAL_FAILED");
  assert.equal(laterStageFailure.state.current_stage, "verify_eval");
  assert.equal(laterStageFailure.state.stage_status, "failed");
  assert.equal(laterStageFailure.state.completed.at(-2).id, "rebuild_vectorize");
  assert.equal(laterStageFailure.state.completed.at(-1).id, "verify_health");
  assert.equal(existsSync(interruptionCheckpointPath), true,
    "later-stage failure keeps the campaign checkpoint retryable");
  assert.equal(fieldHarness.bootstrapCalls, 7);
  assert.equal(fieldHarness.promotionCalls, 1);

  const completedField = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(completedField.ok, true);
  assert.equal(completedField.status.status, "complete");
  assert.deepEqual(fieldHarness.observerSnapshots.slice(22, 25), [
    { bootstrapCalls: 6, confirmed: 7_202, epoch: 1 },
    { bootstrapCalls: 6, confirmed: 7_202, epoch: 1 },
    { bootstrapCalls: 6, confirmed: 7_202, epoch: 1 },
  ], "monotonic remote progress is bracketed before retrying a lost bootstrap response");
  assert.deepEqual(fieldHarness.observerSnapshots.slice(25, 27), [
    { bootstrapCalls: 7, confirmed: 7_202, epoch: 1 },
    { bootstrapCalls: 7, confirmed: 7_202, epoch: 1 },
  ], "the reconciled complete receipt is bracketed against the checkpoint");
  assert.deepEqual(fieldHarness.observerSnapshots.slice(27, 29), [
    { bootstrapCalls: 7, confirmed: 7_202, epoch: 1 },
    { bootstrapCalls: 7, confirmed: 7_202, epoch: 1 },
  ], "paused parity is bracketed before promotion authorization is fsynced");
  assert.equal(fieldHarness.bootstrapCalls, 7);
  assert.equal(fieldHarness.bootstrapEpoch, 1);
  assert.equal(fieldHarness.bootstrapCursor, "fixture:chunk#00007201");
  assert.equal(fieldHarness.promotionCalls, 1);
  assert.equal(fieldHarness.currentTargetVersionId, fieldActiveWorkerVersionId);
  assert.equal(
    existsSync(join(fieldArtifactDirectory, ".brain-recovery-field-gate.lock")),
    false,
  );
  assert.equal(existsSync(interruptionCheckpointPath), false);
  assert.equal(existsSync(completedInterruptionCheckpointPath), true);
  const completedResumeAuthorizationPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-resume-authorized-v1.completed.json",
  );
  const completedPromotionAuthorizationPath = join(
    fieldArtifactDirectory,
    ".brain-recovery-test-bootstrap-promotion-authorized-v1.completed.json",
  );
  assert.equal(existsSync(resumeAuthorizationPath), false);
  assert.equal(existsSync(promotionAuthorizationPath), false);
  assert.equal(existsSync(completedResumeAuthorizationPath), true);
  assert.equal(existsSync(completedPromotionAuthorizationPath), true);

  // Model the narrow crash after the verified runner durably records complete
  // but before the active interruption checkpoint is renamed. A bound special
  // retry must perform only the local retirement; it must not touch Wrangler,
  // the Brain admin key, the data plane, bootstrap, or promotion again.
  const completedCheckpointBytes = readFileSync(completedInterruptionCheckpointPath);
  unlinkSync(completedInterruptionCheckpointPath);
  writeFileSync(interruptionCheckpointPath, completedCheckpointBytes, {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(interruptionCheckpointPath, 0o600);
  const beforeCompleteStateRetirement = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
    bootstrap: fieldHarness.bootstrapCalls,
    promotion: fieldHarness.promotionCalls,
  };
  const completeStateRetirement = await runCloudflareRecoveryFieldGate(
    approvedFieldConfig,
    fieldDependencies,
  );
  assert.equal(completeStateRetirement.ok, true);
  assert.equal(completeStateRetirement.status.status, "complete");
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
    bootstrap: fieldHarness.bootstrapCalls,
    promotion: fieldHarness.promotionCalls,
  }, beforeCompleteStateRetirement);
  assert.equal(existsSync(interruptionCheckpointPath), false);
  assert.equal(existsSync(completedInterruptionCheckpointPath), true);
  assert.equal(existsSync(resumeAuthorizationPath), false);
  assert.equal(existsSync(promotionAuthorizationPath), false);
  assert.equal(existsSync(completedResumeAuthorizationPath), true);
  assert.equal(existsSync(completedPromotionAuthorizationPath), true);

  // The field hook is intentionally macOS-only. Cross-platform lanes still
  // exercise the synthetic interruption lifecycle above, but their locked
  // Wrangler receipt truthfully records linux or win32. A completed campaign
  // from that non-field host must never unblock ordinary recovery as though it
  // were the approved macOS campaign.
  if (lockedWranglerRuntime.host.platform !== "darwin") {
    assert.throws(
      () => previewCloudflareRecoveryFieldGate(fieldBaseConfig, { platform: "darwin" }),
      (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID",
      "a completed non-macOS test runtime cannot become ordinary field proof",
    );
  } else {
  const ordinaryCompletedPreview = previewCloudflareRecoveryFieldGate(
    fieldBaseConfig,
    { platform: "darwin" },
  );
  assert.equal(ordinaryCompletedPreview.status, "complete");
  const completedControlHarness = providerHarness({
    sourceManifestFixture: syntheticFieldSourceManifest,
    targetManifestFixture: syntheticFieldTargetManifest,
  });
  const completedControlPinGate = createCloudflareRecoveryFieldGateAdapters({
    ...fieldBaseConfig,
    plan: fieldInitialized.plan,
    state: loadVerifiedRecoveryState(fieldStatePath, fieldInitialized.plan),
  }, completedControlHarness.dependencies);
  const completedCheckpointText = readFileSync(completedInterruptionCheckpointPath, "utf8");
  unlinkSync(completedInterruptionCheckpointPath);
  writeFileSync(completedInterruptionCheckpointPath, completedCheckpointText, {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(completedInterruptionCheckpointPath, 0o600);
  assert.throws(
    () => completedControlPinGate.revalidate(),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
    "retired campaign controls remain inode- and byte-pinned in ordinary mode",
  );
  assert.equal(completedControlHarness.wranglerCalls.length, 0);
  assert.equal(completedControlHarness.adminReads, 0);
  assert.equal(completedControlHarness.fetchCalls.length, 0);

  const validCompletedCheckpoint = JSON.parse(completedCheckpointText);
  writePrivateJson(completedInterruptionCheckpointPath, {
    ...validCompletedCheckpoint,
    plan_fingerprint: "f".repeat(64),
  });
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(fieldBaseConfig, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID",
    "a cross-plan completed marker cannot unblock ordinary recovery",
  );
  writeFileSync(completedInterruptionCheckpointPath, completedCheckpointText);
  if (process.platform !== "win32") chmodSync(completedInterruptionCheckpointPath, 0o600);
  unlinkSync(completedInterruptionCheckpointPath);
  assert.throws(
    () => previewCloudflareRecoveryFieldGate(fieldBaseConfig, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID",
    "orphan completed authorizations require their exact plan-bound checkpoint",
  );
  writeFileSync(completedInterruptionCheckpointPath, completedCheckpointText, {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform !== "win32") chmodSync(completedInterruptionCheckpointPath, 0o600);
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...fieldBaseConfig,
      testInterruptMidBootstrap: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
      testBootstrapCandidateSha: testCandidateSha,
      testBootstrapFieldReceiptPath: fieldReceiptPath,
      testBootstrapPackagePath: fieldPackagePath,
      testBootstrapSourcePhaseReceiptPath: fieldSourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: fieldDeploymentReceiptPath,
      testBootstrapSeedReceiptPath: fieldSeedReceiptPath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_CONSUMED",
    "a completed/past-midpoint state cannot claim a newly requested interruption",
  );

  // A stale active filename appearing beside the consumed marker cannot revive
  // a completed test authorization. The completed marker is terminal before
  // any provider or keychain read, regardless of active-checkpoint residue.
  writeFileSync(
    interruptionCheckpointPath,
    readFileSync(completedInterruptionCheckpointPath),
    { flag: "wx", mode: 0o600 },
  );
  if (process.platform !== "win32") chmodSync(interruptionCheckpointPath, 0o600);
  const beforeBothCheckpointRefusal = {
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  };
  await assert.rejects(
    runCloudflareRecoveryFieldGate(approvedFieldConfig, fieldDependencies),
    (error) => error.code === "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_CONSUMED",
  );
  assert.deepEqual({
    wrangler: fieldHarness.wranglerCalls.length,
    admin: fieldHarness.adminReads,
    fetch: fieldHarness.fetchCalls.length,
  }, beforeBothCheckpointRefusal);
  unlinkSync(interruptionCheckpointPath);
  }
  }

  const drillPlanPath = join(sandbox, ".brain-recovery-drill-plan.json");
  const drillStatePath = join(sandbox, ".brain-recovery-drill-state.json");
  const drillArtifactDirectory = join(sandbox, "private-drill-artifacts");
  mkdirSync(drillArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(drillArtifactDirectory, 0o700);
  const drillInitialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    drillPlanPath,
    drillStatePath,
    { now: new Date("2026-08-25T12:30:00.000Z") },
  );
  const drillConfig = {
    ...baseConfig,
    planPath: drillPlanPath,
    statePath: drillStatePath,
    artifactDirectory: drillArtifactDirectory,
  };
  const drillPreview = previewCloudflareRecoveryFieldGate(drillConfig, { platform: "darwin" });
  const approvedDrillConfig = Object.freeze({
    ...drillConfig,
    approvePlan: drillInitialized.plan.plan_fingerprint,
    approveDisposableTarget: drillInitialized.plan.target_resource_fingerprint,
    approveTargetExecution: drillPreview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: drillPreview.source_export_blocking_approval_fingerprint,
    approveWrapper: drillPreview.wrapper_approval_fingerprint,
    approveGolden: drillPreview.golden_approval_fingerprint,
  });
  const openFamilyImportHarness = providerHarness({ sourceFamilyRecoveryStateActive: true });
  const openFamilyImportGate = createCloudflareRecoveryFieldGateAdapters(
    { ...approvedDrillConfig, plan: drillInitialized.plan },
    openFamilyImportHarness.dependencies,
  );
  await assert.rejects(
    openFamilyImportGate.adapters.export_d1({
      stage: "export_d1",
      attempt: 1,
      planFingerprint: drillInitialized.plan.plan_fingerprint,
      targetResourceFingerprint: drillInitialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_RESULT_FAMILY_IMPORT_STATE_ACTIVE",
  );
  assert.equal(openFamilyImportHarness.wranglerCalls.some((call) =>
    call.args[0] === "d1" && call.args[1] === "export"), false);

  const historicalFamilyHarness = providerHarness({
    dataExport: historicalFamilyDataExport,
    inspectCombinedArtifact: (sql) => {
      const replay = new DatabaseSync(":memory:");
      try {
        replay.exec(sql);
        assert.deepEqual({
          active_imports: replay.prepare(
            "SELECT count(*) AS n FROM source_original_result_family_recovery_state",
          ).get().n,
          deleted_receipted_chunks: replay.prepare(
            `SELECT count(*) AS n
               FROM chunks c JOIN documents d ON d.doc_uid=c.doc_uid
              WHERE d.deleted_at IS NOT NULL
                AND c.bound_document_revision_id IS NOT NULL
                AND c.result_chunk_receipt_hash IS NOT NULL`,
          ).get().n,
          portable_receipts: replay.prepare(
            "SELECT count(*) AS n FROM source_original_result_family_receipts",
          ).get().n,
          accepted_observations: replay.prepare(
            "SELECT count(*) AS n FROM source_original_observations WHERE outcome = 'accepted'",
          ).get().n,
          portable_accepted_resolutions: replay.prepare(
            "SELECT count(*) AS n FROM source_original_accepted_resolutions",
          ).get().n,
          local_verifications: replay.prepare(
            "SELECT count(*) AS n FROM source_original_result_family_verifications",
          ).get().n,
          local_activations: replay.prepare(
            "SELECT count(*) AS n FROM source_original_accepted_resolution_activations",
          ).get().n,
          ephemeral_admissions: replay.prepare(
            "SELECT count(*) AS n FROM source_original_accepted_resolution_admissions",
          ).get().n,
          current_accepted_resolutions: replay.prepare(
            "SELECT count(*) AS n FROM source_original_current_accepted_resolutions",
          ).get().n,
        }, {
          active_imports: 0,
          deleted_receipted_chunks: 1,
          portable_receipts: 1,
          accepted_observations: 1,
          portable_accepted_resolutions: 1,
          local_verifications: 0,
          local_activations: 0,
          ephemeral_admissions: 0,
          current_accepted_resolutions: 0,
        });
      } finally {
        replay.close();
      }
    },
  });
  const historicalFamilyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    historicalFamilyHarness.dependencies,
  );
  const historicalExport = await historicalFamilyGate.adapters.export_d1(
    stageContext("export_d1"),
  );
  await historicalFamilyGate.adapters.verify_export(stageContext("verify_export", [{
    id: "export_d1",
    evidence: historicalExport,
  }]));
  unlinkSync(join(artifactDirectory, initialized.plan.artifact.relative_name));

  const openTargetFamilyImportHarness = providerHarness({
    initialTargetRestored: true,
    targetFamilyRecoveryStateActive: true,
  });
  const openTargetFamilyImportGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    openTargetFamilyImportHarness.dependencies,
  );
  await assert.rejects(
    openTargetFamilyImportGate.adapters.verify_d1(stageContext("verify_d1")),
    (error) => error.code === "RECOVERY_RESULT_FAMILY_IMPORT_STATE_ACTIVE",
  );

  const drillHarness = providerHarness();
  const exportCalls = () => drillHarness.wranglerCalls.filter((call) =>
    call.env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id &&
      call.args[0] === "d1" && call.args[1] === "export").length;
  const rebuildCalls = () => drillHarness.fetchCalls.filter((call) =>
    new URL(call.url).pathname === "/api/admin/brain/reindex" &&
      JSON.parse(call.options.body).confirm === true).length;
  const runToCheckpoint = async (stopAfterStage, currentStage, completedStages) => {
    let stopped = null;
    try {
      const unexpected = await runCloudflareRecoveryFieldGate(
        { ...approvedDrillConfig, stopAfterStage },
        drillHarness.dependencies,
      );
      assert.fail(
        `expected intentional checkpoint after ${stopAfterStage}; ` +
        `runner returned ${unexpected?.errorCode || unexpected?.status?.status || "unknown"}`,
      );
    } catch (error) {
      stopped = error;
    }
    if (!(stopped instanceof CloudflareRecoveryAdapterError)) {
      assert.fail(stopped?.message || "checkpoint did not raise the adapter interruption");
    }
    assert.equal(stopped.code, "RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION");
    const checkpoint = loadVerifiedRecoveryState(drillStatePath, drillInitialized.plan);
    assert.equal(checkpoint.status, "running");
    assert.equal(checkpoint.current_stage, currentStage);
    assert.equal(checkpoint.stage_status, "pending");
    assert.equal(checkpoint.failure, null);
    assert.deepEqual(checkpoint.completed.map((entry) => entry.id), completedStages);
    assert.equal(
      existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")),
      false,
    );
  };

  await runToCheckpoint("export_d1", "verify_export", ["export_d1"]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 0, 0]);

  // A supervised resume must use the exact golden bytes that were previewed.
  // Replacing them with another structurally valid release suite cannot inherit
  // the old approval or reach Cloudflare, Keychain, import, or evaluation.
  const swappedGolden = releaseGolden();
  swappedGolden.questions[0].question = `${privateSentinel} reviewed replacement`;
  writePrivateJson(goldenPath, swappedGolden);
  assert.notEqual(hash(readFileSync(goldenPath)), drillPreview.golden_approval_fingerprint);
  const callsBeforeGoldenSwap = Object.freeze({
    wrangler: drillHarness.wranglerCalls.length,
    adminReads: drillHarness.adminReads,
    imports: drillHarness.importCalls,
    evals: drillHarness.evalCalls,
  });
  await assert.rejects(
    runCloudflareRecoveryFieldGate(
      { ...approvedDrillConfig, stopAfterStage: "restore_d1" },
      drillHarness.dependencies,
    ),
    (error) => error instanceof CloudflareRecoveryAdapterError &&
      error.code === "RECOVERY_FIELD_GATE_APPROVAL_MISMATCH",
  );
  assert.deepEqual({
    wrangler: drillHarness.wranglerCalls.length,
    adminReads: drillHarness.adminReads,
    imports: drillHarness.importCalls,
    evals: drillHarness.evalCalls,
  }, callsBeforeGoldenSwap);
  assert.equal(
    loadVerifiedRecoveryState(drillStatePath, drillInitialized.plan).current_stage,
    "verify_export",
  );
  assert.equal(
    existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")),
    false,
  );
  writePrivateJson(goldenPath, releaseGolden());
  assert.equal(hash(readFileSync(goldenPath)), drillPreview.golden_approval_fingerprint);

  await runToCheckpoint("restore_d1", "verify_d1", [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
  ]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);

  await runToCheckpoint("rebuild_vectorize", "verify_health", [
    "export_d1", "verify_export", "prove_target_clean", "restore_d1",
    "verify_d1", "reconcile_security", "rebuild_vectorize",
  ]);
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);
  assert.equal(drillHarness.bootstrapCalls, 1);
  assert.equal(drillHarness.promotionCalls, 1);
  assert.equal(drillHarness.currentTargetVersionId, activeWorkerVersionId);
  assert.equal(drillHarness.evalCalls, 0);

  // Reusing the last boundary proves a completed rebuild neither re-stops nor replays.
  const resumedDrill = await runCloudflareRecoveryFieldGate(
    { ...approvedDrillConfig, stopAfterStage: "rebuild_vectorize" },
    drillHarness.dependencies,
  );
  assert.equal(resumedDrill.ok, true);
  assert.equal(resumedDrill.status.status, "complete");
  assert.deepEqual([exportCalls(), drillHarness.importCalls, rebuildCalls()], [1, 1, 0]);
  assert.equal(drillHarness.bootstrapCalls, 1);
  assert.equal(drillHarness.promotionCalls, 1);
  assert.equal(drillHarness.evalCalls, 1);
  assert.equal(existsSync(join(drillArtifactDirectory, ".brain-recovery-field-gate.lock")), false);

  // The complete field gate must accept the exact four-secret group written by
  // `brain connect zoom`, while still requiring source and target parity.
  const harness = providerHarness({ zoomSecretGroup: true });
  const completed = await runCloudflareRecoveryFieldGate({
    ...baseConfig,
    approvePlan: initialized.plan.plan_fingerprint,
    approveDisposableTarget: initialized.plan.target_resource_fingerprint,
    approveTargetExecution: preview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: preview.source_export_blocking_approval_fingerprint,
    approveWrapper: preview.wrapper_approval_fingerprint,
    approveGolden: preview.golden_approval_fingerprint,
  }, harness.dependencies);
  assert.equal(completed.ok, true);
  assert.equal(completed.status.status, "complete");
  assert.equal(completed.status.completed_stages, 9);
  assert.equal(harness.importCalls, 1);
  assert.equal(harness.evalCalls, 1);
  assert.equal(harness.adminReads, 12);
  assert.equal(harness.fetchCalls.every((call) => call.options.redirect === "error"), true);
  assert.equal(harness.fetchCalls.every((call) => call.options.cache === "no-store"), true);
  assert.equal(harness.fetchCalls.every((call) => new URL(call.url).search === ""), true);
  assert.equal(harness.wranglerCalls.every((call) => call.command !== wrapperPath), true);
  const stateChangingWorkerCalls = harness.wranglerCalls.filter((call) =>
    ["create", "delete", "deploy", "rollback", "upload"].includes(call.args[1]) ||
    ["create", "delete", "deploy", "rollback", "upload"].includes(call.args[0]));
  assert.equal(stateChangingWorkerCalls.length, 1);
  assert.deepEqual(stateChangingWorkerCalls[0].args.slice(0, 6), [
    "versions", "deploy", `${activeWorkerVersionId}@100%`,
    "--name", targetManifest.brain.worker_name, "-y",
  ]);
  assert.equal(harness.wranglerCalls.some((call) =>
    call.env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id &&
    call.args.includes("integrity-check")), false);
  assert.equal(harness.sensitiveBuffers.every((buffer) => buffer.every((byte) => byte === 0)), true);

  const artifactPath = join(artifactDirectory, initialized.plan.artifact.relative_name);
  assert.equal(existsSync(artifactPath), true);
  if (process.platform !== "win32") assert.equal(statSync(artifactPath).mode & 0o777, 0o600);
  const ciphertext = readFileSync(artifactPath);
  assert.equal(ciphertext.includes(Buffer.from("Financial Brain verified recovery artifact")), false);
  assert.equal(ciphertext.includes(Buffer.from(deterministicDataExport)), false);
  const recoveredSql = await withDecryptedRecoveryArtifact(
    artifactPath,
    artifactDirectory,
    fixtureRecoveryArtifactKey,
    (path) => readFileSync(path, "utf8"),
  );
  assert.equal(recoveredSql.includes("Financial Brain verified recovery artifact"), true);
  assert.equal(recoveredSql.includes(deterministicDataExport.trim()), true);
  assert.equal(existsSync(join(artifactDirectory, ".brain-recovery-field-gate.lock")), false);
  assert.equal(readdirSync(artifactDirectory).some((name) =>
    name.startsWith(".brain-recovery-plaintext.tmp-") ||
      name.startsWith(".brain-recovery-encrypted.tmp-")), false);
  assert.equal(readdirSync(artifactDirectory).some((name) => name.startsWith(".brain-recovery-runtime-")), false);
  const stateText = readFileSync(statePath, "utf8");
  for (const forbidden of [
    privateSentinel,
    fixtureAdminKey,
    fixtureRecoveryArtifactKey,
    sourceManifest.brain.domain,
    wrapperPath,
    goldenPath,
  ]) {
    assert.equal(stateText.includes(forbidden), false);
  }

  const wrongArtifactKeyHarness = providerHarness({
    recoveryArtifactKey: `v1.${Buffer.alloc(32, 20).toString("base64url")}`,
  });
  const wrongArtifactKeyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    wrongArtifactKeyHarness.dependencies,
  );
  await assert.rejects(
    wrongArtifactKeyGate.adapters.verify_export({
      stage: "verify_export",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{
        id: "export_d1",
        evidence: {
          artifact_sha256: hash(ciphertext),
          artifact_bytes: ciphertext.length,
        },
      }],
    }),
    (error) => error.code === "RECOVERY_ARTIFACT_CRYPTO_REFUSED",
  );
  assert.equal(readdirSync(artifactDirectory).some((name) =>
    name.startsWith(".brain-recovery-plaintext.tmp-")), false);

  const unexpectedArtifactHarness = providerHarness();
  const unexpectedArtifactGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    unexpectedArtifactHarness.dependencies,
  );
  await assert.rejects(
    unexpectedArtifactGate.adapters.export_d1({
      stage: "export_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_EXPORT_ARTIFACT_APPEARED",
  );
  assert.equal(unexpectedArtifactHarness.wranglerCalls.some((call) =>
    call.args[0] === "d1" && call.args[1] === "export"), false);

  const residueData = join(artifactDirectory, ".brain-recovery-export.sql.tmp-data");
  const residueCombined = join(artifactDirectory, ".brain-recovery-export.sql.tmp-combined");
  writeFileSync(residueData, "synthetic interrupted data partial\n", { mode: 0o600 });
  writeFileSync(residueCombined, "synthetic interrupted combined partial\n", { mode: 0o600 });
  const residueHarness = providerHarness();
  const residueGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    residueHarness.dependencies,
  );
  const residueContext = {
    stage: "export_d1",
    attempt: 2,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: [],
  };
  await assert.rejects(
    residueGate.adapters.export_d1(residueContext),
    (error) => error.code === "RECOVERY_EXPORT_PLAINTEXT_RESIDUE_REVIEW_REQUIRED",
  );
  assert.equal(existsSync(residueData), true);
  assert.equal(existsSync(residueCombined), true);
  unlinkSync(residueData);
  unlinkSync(residueCombined);
  const reconciledArtifact = await residueGate.adapters.export_d1(residueContext);
  assert.equal(reconciledArtifact.artifact_sha256, hash(readFileSync(artifactPath)));
  assert.equal(statSync(artifactPath).nlink, 1);

  const readbackResidue = join(
    artifactDirectory,
    ".brain-recovery-export.sql.tmp-readback",
  );
  writeFileSync(readbackResidue, "synthetic interrupted readback partial\n", { mode: 0o600 });
  const readbackResidueHarness = providerHarness({ initialTargetRestored: true });
  const readbackResidueGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    readbackResidueHarness.dependencies,
  );
  await assert.rejects(
    readbackResidueGate.adapters.verify_d1({
      stage: "verify_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_EXPORT_PLAINTEXT_RESIDUE_REVIEW_REQUIRED",
  );
  assert.equal(existsSync(readbackResidue), true);
  unlinkSync(readbackResidue);

  const ambiguousHarness = providerHarness({ ambiguousSourceD1: true });
  const ambiguousGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    ambiguousHarness.dependencies,
  );
  await assert.rejects(
    ambiguousGate.adapters.export_d1({
      stage: "export_d1",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_D1_RESOURCE_AMBIGUOUS",
  );

  // Schema 44 has the reviewed result-family protocol, but the current Worker
  // reads schema-45 accepted-resolution state. It must be updated before export;
  // restoring the older prefix would otherwise produce a healthy-looking brain
  // whose next ordinary write fails.
  const prefixSourceHarness = providerHarness({ sourceMigrationVersion: 44 });
  const prefixSourceGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prefixSourceHarness.dependencies,
  );
  await assert.rejects(
    prefixSourceGate.adapters.export_d1({
      stage: "export_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_SOURCE_UPGRADE_REQUIRED",
  );
  assert.equal(prefixSourceHarness.wranglerCalls.some((call) =>
    call.args[0] === "d1" && call.args[1] === "export"), false);

  const leasePlanPath = join(sandbox, ".brain-recovery-lease-plan.json");
  const leaseStatePath = join(sandbox, ".brain-recovery-lease-state.json");
  const leaseArtifactDirectory = join(sandbox, "private-lease-artifacts");
  mkdirSync(leaseArtifactDirectory, { mode: 0o700 });
  if (process.platform !== "win32") chmodSync(leaseArtifactDirectory, 0o700);
  const leaseInitialized = initializeVerifiedRecovery(
    sourceManifestPath,
    targetManifestPath,
    leasePlanPath,
    leaseStatePath,
    { now: new Date("2026-08-25T12:45:00.000Z") },
  );
  const leaseConfig = {
    ...baseConfig,
    planPath: leasePlanPath,
    statePath: leaseStatePath,
    artifactDirectory: leaseArtifactDirectory,
  };
  const leasePreview = previewCloudflareRecoveryFieldGate(leaseConfig, { platform: "darwin" });
  const approvedLeaseConfig = Object.freeze({
    ...leaseConfig,
    plan: leaseInitialized.plan,
    approvePlan: leaseInitialized.plan.plan_fingerprint,
    approveDisposableTarget: leaseInitialized.plan.target_resource_fingerprint,
    approveTargetExecution: leasePreview.target_execution_approval_fingerprint,
    approveSourceExportBlocking: leasePreview.source_export_blocking_approval_fingerprint,
    approveWrapper: leasePreview.wrapper_approval_fingerprint,
    approveGolden: leasePreview.golden_approval_fingerprint,
  });
  const leasedSourceHarness = providerHarness({ sourceDrainLease: true });
  const leasedSourceGate = createCloudflareRecoveryFieldGateAdapters(
    approvedLeaseConfig,
    leasedSourceHarness.dependencies,
  );
  const leaseContext = {
    planFingerprint: leaseInitialized.plan.plan_fingerprint,
    targetResourceFingerprint: leaseInitialized.plan.target_resource_fingerprint,
  };
  const leasedExport = await leasedSourceGate.adapters.export_d1({
    stage: "export_d1",
    attempt: 2,
    ...leaseContext,
    completed: [],
  });
  const leasedArtifactPath = join(
    leaseArtifactDirectory,
    leaseInitialized.plan.artifact.relative_name,
  );
  const leasedArtifactText = await withDecryptedRecoveryArtifact(
    leasedArtifactPath,
    leaseArtifactDirectory,
    fixtureRecoveryArtifactKey,
    (path) => readFileSync(path, "utf8"),
  );
  assert.equal(leasedArtifactText.includes(normalizedInstallStateSql), true);
  assert.equal(leasedArtifactText.includes(leasedSourceHarness.sourceLeaseMarker), false);
  assert.equal(leasedSourceHarness.normalizedLeaseSelections, 1);
  const verifyLeasedExport = () => leasedSourceGate.adapters.verify_export({
    stage: "verify_export",
    ...leaseContext,
    completed: [{ id: "export_d1", evidence: leasedExport }],
  });
  const firstLeasedVerification = await verifyLeasedExport();
  const retriedLeasedVerification = await verifyLeasedExport();
  assert.equal(firstLeasedVerification.aggregate_fingerprint, retriedLeasedVerification.aggregate_fingerprint);

  const redirectHarness = providerHarness({
    redirectHealth: true,
    targetVersionId: activeWorkerVersionId,
  });
  const redirectGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    redirectHarness.dependencies,
  );
  await assert.rejects(
    redirectGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REDIRECT_REFUSED",
  );
  assert.equal(redirectHarness.adminReads, 0);
  assert.equal(redirectHarness.fetchCalls.length, 1);
  assert.equal(redirectHarness.fetchCalls.some((call) =>
    new URL(call.url).hostname === "redirected.fixture.invalid"), false);

  const authenticatedRedirectHarness = providerHarness({
    redirectInventory: true,
    targetVersionId: activeWorkerVersionId,
  });
  const authenticatedRedirectGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    authenticatedRedirectHarness.dependencies,
  );
  await assert.rejects(
    authenticatedRedirectGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "rebuild_vectorize", evidence: { chunk_count: 5 } }],
    }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  assert.equal(authenticatedRedirectHarness.adminReads, 1);
  assert.equal(authenticatedRedirectHarness.fetchCalls.length, 2);
  assert.equal(authenticatedRedirectHarness.fetchCalls.some((call) =>
    new URL(call.url).hostname === "redirected.fixture.invalid"), false);

  const extraSecretHarness = providerHarness({ extraTargetSecret: true });
  const extraSecretGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    extraSecretHarness.dependencies,
  );
  await assert.rejects(
    extraSecretGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
  );

  const partialZoomSecretHarness = providerHarness({ partialZoomSecretGroup: true });
  const partialZoomSecretGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    partialZoomSecretHarness.dependencies,
  );
  await assert.rejects(
    partialZoomSecretGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
  );
  assert.equal(partialZoomSecretHarness.importCalls, 0);

  const mismatchedBankKeyHarness = providerHarness({
    sourceWrappingSecret: true,
    bankKeyProofMismatch: true,
  });
  const mismatchedBankKeyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    mismatchedBankKeyHarness.dependencies,
  );
  await assert.rejects(
    mismatchedBankKeyGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_BANK_KEY_MISMATCH",
  );
  assert.equal(mismatchedBankKeyHarness.importCalls, 0);

  const restoredAgentAuthorityHarness = providerHarness({
    initialTargetRestored: true,
    initialAgentActionReceipts: 1,
  });
  const restoredAgentAuthorityGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    restoredAgentAuthorityHarness.dependencies,
  );
  await assert.rejects(
    restoredAgentAuthorityGate.adapters.reconcile_security({
      stage: "reconcile_security",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_AGENT_AUTHORITY_NOT_EMPTY",
  );
  assert.equal(restoredAgentAuthorityHarness.fetchCalls.some((call) =>
    new URL(call.url).pathname === "/api/bank-feed/reconcile-recovery"), false);

  const extraBindingHarness = providerHarness({ extraTargetBinding: true });
  const extraBindingGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    extraBindingHarness.dependencies,
  );
  await assert.rejects(
    extraBindingGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_BINDINGS_INVALID",
  );

  const mismatchedCodeHarness = providerHarness({
    activeScriptEtag: "d".repeat(64),
  });
  const mismatchedCodeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    mismatchedCodeHarness.dependencies,
  );
  await assert.rejects(
    mismatchedCodeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_CODE_INVALID",
  );

  const splitDeploymentHarness = providerHarness({ splitTargetDeployment: true });
  const splitDeploymentGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    splitDeploymentHarness.dependencies,
  );
  await assert.rejects(
    splitDeploymentGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS",
  );

  const missingVectorCountHarness = providerHarness({ missingVectorCount: true });
  const missingVectorCountGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    missingVectorCountHarness.dependencies,
  );
  await assert.rejects(
    missingVectorCountGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_VECTORIZE_RESPONSE_INVALID",
  );

  const changedVersionHarness = providerHarness({ targetVersionId: "unreviewed-target-version" });
  const changedVersionGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    changedVersionHarness.dependencies,
  );
  await assert.rejects(
    changedVersionGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );

  const completedEvidence = [{
    id: "verify_export",
    evidence: {
      artifact_sha256: hash(readFileSync(artifactPath)),
      artifact_bytes: statSync(artifactPath).size,
      ...expectedSnapshot,
    },
  }];
  const prepopulatedHarness = providerHarness({ initialTargetRestored: true });
  const prepopulatedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prepopulatedHarness.dependencies,
  );
  await assert.rejects(
    prepopulatedGate.adapters.restore_d1({
      stage: "restore_d1",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: completedEvidence,
    }),
    (error) => error.code === "RECOVERY_TARGET_IMPORT_AMBIGUOUS",
  );
  const reconciled = await prepopulatedGate.adapters.restore_d1({
    stage: "restore_d1",
    attempt: 2,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: completedEvidence,
  });
  assert.equal(reconciled.import_completed, true);
  assert.equal(prepopulatedHarness.importCalls, 0);

  const preindexedHarness = providerHarness({ initialTargetRestored: true, initialVectorCount: 2 });
  const preindexedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    preindexedHarness.dependencies,
  );
  await assert.rejects(
    preindexedGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 1,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_VECTORIZE_TARGET_AMBIGUOUS",
  );
  assert.equal(preindexedHarness.adminReads, 0);

  // A resumed journal can carry an old verify_d1 checkpoint. Recheck the live
  // target schema before any current drain or Vectorize call instead of
  // assuming the historical checkpoint is compatible with the current Worker.
  const prefixTargetHarness = providerHarness({
    initialTargetRestored: true,
    targetMigrationVersion: 43,
  });
  const prefixTargetGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    prefixTargetHarness.dependencies,
  );
  await assert.rejects(
    prefixTargetGate.adapters.rebuild_vectorize({
      stage: "rebuild_vectorize",
      attempt: 2,
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
    }),
    (error) => error.code === "RECOVERY_TARGET_UPGRADE_REQUIRED",
  );
  assert.equal(prefixTargetHarness.adminReads, 0);
  assert.equal(prefixTargetHarness.fetchCalls.length, 0);

  const interruptedHarness = providerHarness({
    initialTargetRestored: true,
    failBootstrapOnce: true,
  });
  const interruptedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    interruptedHarness.dependencies,
  );
  const rebuildContext = {
    stage: "rebuild_vectorize",
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
    completed: [{ id: "verify_d1", evidence: expectedSnapshot }],
  };
  await assert.rejects(
    interruptedGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  const resumedRebuild = await interruptedGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.deepEqual(resumedRebuild, {
    chunk_count: 5,
    vector_count: 5,
    pending_outbox: 0,
    failed_vectors: 0,
  });
  assert.equal(interruptedHarness.bootstrapCalls, 2);
  assert.equal(interruptedHarness.sleepCalls, 0);
  assert.equal(interruptedHarness.promotionCalls, 1);

  const progressedHarness = providerHarness({
    initialTargetRestored: true,
    failBootstrapAfterProgressOnce: true,
  });
  const progressedGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    progressedHarness.dependencies,
  );
  await assert.rejects(
    progressedGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_DATA_PLANE_REQUEST_FAILED",
  );
  assert.equal(progressedHarness.bootstrapEpoch, 1);
  assert.equal(progressedHarness.bootstrapCursor, "fixture:chunk#00000004");
  const resumedProgress = await progressedGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(resumedProgress.vector_count, 5);
  assert.equal(progressedHarness.bootstrapEpoch, 1);
  assert.equal(progressedHarness.bootstrapCursor, "fixture:chunk#00000004");
  assert.equal(progressedHarness.fetchCalls.some((call) =>
    new URL(call.url).pathname === "/api/admin/brain/reindex"), false);

  const laggedVisibilityHarness = providerHarness({
    initialTargetRestored: true,
    readinessLagAfterBootstrap: true,
  });
  const laggedVisibilityGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    laggedVisibilityHarness.dependencies,
  );
  const laggedVisibility = await laggedVisibilityGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 1,
  });
  assert.equal(laggedVisibility.vector_count, 5);
  assert.equal(laggedVisibilityHarness.bootstrapCalls, 2);
  assert.equal(laggedVisibilityHarness.sleepCalls, 1);

  // The old active /drain loop could submit at most 79,200 restored rows. The
  // paused schema-13 bootstrap advances its durable provider-receipt cursor
  // until exact completion, with no corpus-sized adapter ceiling.
  const largeChunkCount = 80_001;
  const largeSnapshot = snapshotForChunkCount(largeChunkCount);
  const largeHarness = providerHarness({
    initialTargetRestored: true,
    targetChunkCount: largeChunkCount,
  });
  const largeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    largeHarness.dependencies,
  );
  const largeResult = await largeGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 1,
    completed: [{ id: "verify_d1", evidence: largeSnapshot }],
  });
  assert.deepEqual(largeResult, {
    chunk_count: largeChunkCount,
    vector_count: largeChunkCount,
    pending_outbox: 0,
    failed_vectors: 0,
  });
  assert.equal(largeHarness.bootstrapCalls, Math.ceil(largeChunkCount / 3_000));
  assert.equal(largeHarness.promotionCalls, 1);
  assert.equal(largeHarness.fetchCalls.some((call) =>
    new URL(call.url).pathname === "/api/admin/brain/drain"), false);

  const busyHarness = providerHarness({ initialTargetRestored: true, bootstrapBusyOnce: true });
  const busyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    busyHarness.dependencies,
  );
  const busyResult = await busyGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 });
  assert.equal(busyResult.vector_count, 5);
  assert.equal(busyHarness.bootstrapCalls, 2);
  assert.equal(busyHarness.sleepCalls, 1);

  const malformedReceiptHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapReceiptTransform: (receipt) => ({ ...receipt, unreviewed_detail: "refuse" }),
  });
  const malformedReceiptGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    malformedReceiptHarness.dependencies,
  );
  await assert.rejects(
    malformedReceiptGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_BOOTSTRAP_RECEIPT_INVALID",
  );
  assert.equal(malformedReceiptHarness.promotionCalls, 0);

  const malformedBusyHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapBusyOnce: true,
    busyReceiptTransform: (receipt) => ({ ...receipt, error: "unreviewed" }),
  });
  const malformedBusyGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    malformedBusyHarness.dependencies,
  );
  await assert.rejects(
    malformedBusyGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_BOOTSTRAP_BUSY_RECEIPT_INVALID",
  );
  assert.equal(malformedBusyHarness.promotionCalls, 0);

  const mutatedCorpusHarness = providerHarness({
    initialTargetRestored: true,
    bootstrapMutatesCorpus: true,
  });
  const mutatedCorpusGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    mutatedCorpusHarness.dependencies,
  );
  await assert.rejects(
    mutatedCorpusGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
  );
  assert.equal(mutatedCorpusHarness.promotionCalls, 0);

  const promotionNoopHarness = providerHarness({
    initialTargetRestored: true,
    promotionNoop: true,
  });
  const promotionNoopGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    promotionNoopHarness.dependencies,
  );
  await assert.rejects(
    promotionNoopGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(promotionNoopHarness.promotionCalls, 1);

  const badPausedModeHarness = providerHarness({ pausedVersionMode: "active" });
  const badPausedModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badPausedModeHarness.dependencies,
  );
  await assert.rejects(
    badPausedModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_MODE_INVALID",
  );
  assert.equal(badPausedModeHarness.bootstrapCalls, 0);
  assert.equal(badPausedModeHarness.promotionCalls, 0);

  const badActiveModeHarness = providerHarness({ activeVersionMode: "paused-for-upgrade" });
  const badActiveModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badActiveModeHarness.dependencies,
  );
  await assert.rejects(
    badActiveModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_MODE_INVALID",
  );
  assert.equal(badActiveModeHarness.bootstrapCalls, 0);
  assert.equal(badActiveModeHarness.promotionCalls, 0);

  // Pin the mode-dependent contract to real Worker health. Missing fields are
  // not a legacy success mode, and optimistic paused health is unsafe.
  for (const active of [false, true]) {
    for (const field of ["ok", "status", "accepting_documents"]) {
      for (const missing of [false, true]) {
        const h = providerHarness({
          targetVersionId: active ? activeWorkerVersionId : pausedWorkerVersionId,
          initialTargetRestored: active,
          initialVectorCount: active ? 5 : 0,
          healthTransform: (health) => {
            const changed = { ...health };
            if (missing) delete changed[field];
            else changed[field] = field === "status"
              ? (active ? "paused-for-upgrade" : "ok")
              : !active;
            return changed;
          },
        });
        const g = createCloudflareRecoveryFieldGateAdapters(approvedAdapterConfig, h.dependencies);
        await assert.rejects(
          g.adapters[active ? "verify_health" : "prove_target_clean"]({
            stage: active ? "verify_health" : "prove_target_clean",
            planFingerprint: initialized.plan.plan_fingerprint,
            targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
            completed: [],
          }),
          (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
          `${active ? "active" : "paused"} ${missing ? "missing" : "inconsistent"} ${field}`,
        );
        assert.equal(h.bootstrapCalls, 0);
        assert.equal(h.promotionCalls, 0);
      }
    }
  }

  // Active health is the last cheap proof that the promoted Worker and restored
  // database still belong to the same release. A schema-44 time-travel restore
  // between resumable stages must not pass as an active schema-45 brain.
  for (const schemaVersion of [undefined, 44]) {
    const staleSchemaHarness = providerHarness({
      targetVersionId: activeWorkerVersionId,
      initialTargetRestored: true,
      initialVectorCount: 5,
      healthTransform: (health) => {
        const changed = { ...health };
        if (schemaVersion === undefined) delete changed.schema_version;
        else changed.schema_version = schemaVersion;
        return changed;
      },
    });
    const staleSchemaGate = createCloudflareRecoveryFieldGateAdapters(
      approvedAdapterConfig,
      staleSchemaHarness.dependencies,
    );
    await assert.rejects(
      staleSchemaGate.adapters.verify_health({
        stage: "verify_health",
        planFingerprint: initialized.plan.plan_fingerprint,
        targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
        completed: [],
      }),
      (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
      `active ${schemaVersion === undefined ? "missing" : "stale"} schema version`,
    );
    assert.equal(staleSchemaHarness.bootstrapCalls, 0);
    assert.equal(staleSchemaHarness.promotionCalls, 0);
  }

  const badHealthModeHarness = providerHarness({ healthModeOverride: "active" });
  const badHealthModeGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badHealthModeHarness.dependencies,
  );
  await assert.rejects(
    badHealthModeGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
  );
  assert.equal(badHealthModeHarness.bootstrapCalls, 0);
  assert.equal(badHealthModeHarness.promotionCalls, 0);

  const badHealthProtocolHarness = providerHarness({ healthProtocolOverride: "legacy" });
  const badHealthProtocolGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    badHealthProtocolHarness.dependencies,
  );
  await assert.rejects(
    badHealthProtocolGate.adapters.prove_target_clean({
      stage: "prove_target_clean",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_HEALTH_IDENTITY_MISMATCH",
  );

  const pausedFinalGateHarness = providerHarness();
  const pausedFinalGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    pausedFinalGateHarness.dependencies,
  );
  await assert.rejects(
    pausedFinalGate.adapters.verify_health({
      stage: "verify_health",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [{ id: "rebuild_vectorize", evidence: { chunk_count: 5 } }],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  await assert.rejects(
    pausedFinalGate.adapters.verify_eval({
      stage: "verify_eval",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );

  const changingEvalHarness = providerHarness({
    deploymentChangesDuringEval: true,
    targetVersionId: activeWorkerVersionId,
  });
  const changingEvalGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    changingEvalHarness.dependencies,
  );
  await assert.rejects(
    changingEvalGate.adapters.verify_eval({
      stage: "verify_eval",
      planFingerprint: initialized.plan.plan_fingerprint,
      targetResourceFingerprint: initialized.plan.target_resource_fingerprint,
      completed: [],
    }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(changingEvalHarness.evalCalls, 1);

  const activeFirstAttemptHarness = providerHarness({
    initialTargetRestored: true,
    initialVectorCount: 5,
    targetVersionId: activeWorkerVersionId,
  });
  const activeFirstAttemptGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    activeFirstAttemptHarness.dependencies,
  );
  await assert.rejects(
    activeFirstAttemptGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_TARGET_EXECUTION_CHANGED",
  );
  assert.equal(activeFirstAttemptHarness.bootstrapCalls, 0);
  assert.equal(activeFirstAttemptHarness.promotionCalls, 0);
  const reconciledActive = await activeFirstAttemptGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(reconciledActive.vector_count, 5);
  assert.equal(activeFirstAttemptHarness.promotionCalls, 0);

  const ambiguousPromotionHarness = providerHarness({
    initialTargetRestored: true,
    failPromotionAfterApplyOnce: true,
  });
  const ambiguousPromotionGate = createCloudflareRecoveryFieldGateAdapters(
    approvedAdapterConfig,
    ambiguousPromotionHarness.dependencies,
  );
  await assert.rejects(
    ambiguousPromotionGate.adapters.rebuild_vectorize({ ...rebuildContext, attempt: 1 }),
    (error) => error.code === "RECOVERY_WRANGLER_CALL_FAILED",
  );
  assert.equal(ambiguousPromotionHarness.currentTargetVersionId, activeWorkerVersionId);
  const reconciledPromotion = await ambiguousPromotionGate.adapters.rebuild_vectorize({
    ...rebuildContext,
    attempt: 2,
  });
  assert.equal(reconciledPromotion.vector_count, 5);
  assert.equal(ambiguousPromotionHarness.bootstrapCalls, 1);
  assert.equal(ambiguousPromotionHarness.promotionCalls, 1);

  const productionTargetPath = join(sandbox, "production-target.manifest.json");
  const productionPlanPath = join(sandbox, ".brain-recovery-production-plan.json");
  const productionStatePath = join(sandbox, ".brain-recovery-production-state.json");
  writePrivateJson(productionTargetPath, {
    ...structuredClone(targetManifest),
    brain: {
      ...targetManifest.brain,
      worker_name: "fixture-production-worker",
      domain: "fixture-production-worker.fixture-account.workers.dev",
    },
  });
  initializeVerifiedRecovery(
    sourceManifestPath,
    productionTargetPath,
    productionPlanPath,
    productionStatePath,
    { now: new Date("2026-08-25T12:00:01.000Z") },
  );
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({
      ...baseConfig,
      targetManifestPath: productionTargetPath,
      planPath: productionPlanPath,
      statePath: productionStatePath,
    }, { platform: "darwin" }),
    (error) => error.code === "RECOVERY_TARGET_NOT_DISPOSABLE",
  );

  const unsafeWrapper = join(sandbox, "unsafe-wrapper-link");
  symlinkSync(wrapperPath, unsafeWrapper);
  assert.throws(
    () => previewCloudflareRecoveryFieldGate({ ...baseConfig, wranglerWrapperPath: unsafeWrapper }, {
      platform: "darwin",
    }),
    (error) => error.code === "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
  );

  if (process.platform !== "win32" && existsSync("/usr/bin/sqlite3")) {
    const localArtifact = join(sandbox, ".brain-recovery-local-verifier.sql");
    const schemaSql = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const receipts = appliedMigrations.map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const installState =
      "INSERT INTO install_state " +
      "(id,client_slug,product_version,schema_version,gate_version,installed_at,ring," +
      "source_original_retrieval_generation) VALUES " +
      `(1,'fixture','0.0.0',${appliedMigrations.at(-1).version},0,` +
      "'2026-08-25T12:00:00.000Z','stable',0);";
    const largeCorpus =
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000) " +
      "INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash) " +
      "SELECT 'doc-'||x,'fixture','source-'||x,1700000000000,'hash-'||x FROM n;";
    const sql = `${schemaSql}\n${receipts}\n${installState}\n${largeCorpus}\n`;
    writeFileSync(localArtifact, sql, { mode: 0o600 });
    chmodSync(localArtifact, 0o600);
    const local = await verifyRecoverySqlArtifact(localArtifact);
    assert.equal(local.integrity, "ok");
    assert.equal(local.document_count, 6000);
    assert.equal(local.chunk_count, 0);
    assert.equal(local.fts_count, 0);

    // Confirmed bulk-bootstrap receipts are durable evidence for one provider
    // index, but not part of the recoverable corpus. Even a source retaining
    // that history must produce the same normalized structural aggregate.
    const batchHistoryArtifact = join(sandbox, ".brain-recovery-batch-history-verifier.sql");
    const batchHistory =
      "INSERT INTO vector_bootstrap_batches " +
      "(epoch,batch_no,start_cursor,end_cursor,row_count,status,mutation_id,submitted_at,confirmed_at) " +
      "VALUES (7,1,'fixture:start','fixture:end',1,'confirmed','fixture-mutation',1,2);";
    writeFileSync(batchHistoryArtifact, `${sql}\n${batchHistory}\n`, { mode: 0o600 });
    chmodSync(batchHistoryArtifact, 0o600);
    const withBatchHistory = await verifyRecoverySqlArtifact(batchHistoryArtifact);
    assert.equal(withBatchHistory.schema_fingerprint, local.schema_fingerprint);
    assert.equal(withBatchHistory.aggregate_fingerprint, local.aggregate_fingerprint);
    assert.equal(withBatchHistory.document_count, local.document_count);

    // D1 removes full-line SQL comments from sqlite_schema. The exact migration
    // checksums remain separately pinned, so schema comparison must treat only
    // those non-semantic comments and whitespace as equivalent.
    const commentlessArtifact = join(sandbox, ".brain-recovery-commentless-verifier.sql");
    const commentlessSchema = schemaSql.replace(/^[ \t]*--[^\r\n]*(?:\r?\n|$)/gm, "");
    writeFileSync(commentlessArtifact, `${commentlessSchema}\n${receipts}\n`, { mode: 0o600 });
    chmodSync(commentlessArtifact, 0o600);
    const commentless = await verifyRecoverySqlArtifact(commentlessArtifact);
    assert.equal(commentless.schema_fingerprint, local.schema_fingerprint);

    // Recovery intentionally accepts an exact applied-migration prefix. The
    // normalized aggregate must not reference lease columns before 0011.
    const prefixMigrationNames = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .slice(0, 10);
    const prefixSchema = prefixMigrationNames
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const prefixReceipts = appliedMigrations.slice(0, 10).map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const prefixInstall =
      "INSERT INTO install_state " +
      "(id,client_slug,product_version,schema_version,gate_version,installed_at,ring,outbox_generation) " +
      "VALUES (1,'fixture-brain','0.1.12',10,4,'2026-08-25T12:00:00.000Z','stable',9);";
    const prefixArtifact = join(sandbox, ".brain-recovery-prefix-verifier.sql");
    writeFileSync(prefixArtifact, `${prefixSchema}\n${prefixReceipts}\n${prefixInstall}\n`, { mode: 0o600 });
    chmodSync(prefixArtifact, 0o600);
    const prefix = await verifyRecoverySqlArtifact(prefixArtifact);
    assert.equal(prefix.integrity, "ok");
    assert.equal(prefix.document_count, 0);

    // Schema 12 is the immediate historical prefix. Its exact artifact remains
    // inspectable offline even though live recovery requires schema 13.
    const schema12MigrationNames = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .slice(0, 12);
    const schema12Schema = schema12MigrationNames
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const schema12Receipts = appliedMigrations.slice(0, 12).map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const schema12Artifact = join(sandbox, ".brain-recovery-schema12-prefix-verifier.sql");
    writeFileSync(schema12Artifact, `${schema12Schema}\n${schema12Receipts}\n`, { mode: 0o600 });
    chmodSync(schema12Artifact, 0o600);
    const schema12 = await verifyRecoverySqlArtifact(schema12Artifact);
    assert.equal(schema12.integrity, "ok");
    assert.equal(schema12.document_count, 0);

    // Schema 33 is the immediate recovery prefix before the derived source
    // inventory. It must remain verifiable without querying schema-34 tables.
    const schema33MigrationNames = readdirSync(join(process.cwd(), "migrations", "d1"))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()
      .slice(0, 33);
    const schema33Schema = schema33MigrationNames
      .map((name) => readFileSync(join(process.cwd(), "migrations", "d1", name), "utf8"))
      .join("\n\n");
    const schema33Receipts = appliedMigrations.slice(0, 33).map((row) =>
      `INSERT INTO schema_migrations (version,name,applied_at,checksum) VALUES (` +
      `${row.version},'${row.name}','2026-08-25T12:00:00.000Z','${row.checksum}');`).join("\n");
    const schema33Artifact = join(sandbox, ".brain-recovery-schema33-prefix-verifier.sql");
    writeFileSync(schema33Artifact, `${schema33Schema}\n${schema33Receipts}\n`, { mode: 0o600 });
    chmodSync(schema33Artifact, 0o600);
    const schema33 = await verifyRecoverySqlArtifact(schema33Artifact);
    assert.equal(schema33.integrity, "ok");
    assert.equal(schema33.document_count, 0);
    assert.notEqual(schema33.schema_fingerprint, local.schema_fingerprint);
  }

  console.log("PASS  Cloudflare recovery adapter is disposable-only, credential-safe, redirect-safe, and resumable");
} finally {
  try { unlinkSync(join(artifactDirectory, ".brain-recovery-field-gate.lock")); } catch { /* absent */ }
  rmSync(sandbox, { recursive: true, force: true });
}
