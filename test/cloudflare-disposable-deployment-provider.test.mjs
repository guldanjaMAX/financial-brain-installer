import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { splitStatements } from "../brain.mjs";

import {
  CloudflareDisposableDeploymentProviderError,
  prepareCloudflareDisposableDeploymentProvider,
  prepareCloudflareDisposableProvisioningProvider,
} from "../operations/cloudflare-disposable-deployment-provider.mjs";
import {
  verifyV048ExclusiveCampaignResourceCustodyWithAuthority,
} from "../operations/v048-exclusive-resource-custody-contract.mjs";
import {
  createCloudflareDisposableCampaignVectorizeInstanceAuthority,
} from "../operations/cloudflare-disposable-deployment-transport.mjs";
import {
  createTestDisposableRecoveryK0Capability,
} from "./helpers/disposable-recovery-k0-capability.mjs";

const HASH = "a".repeat(64);
const SOURCE_ACCOUNT = "1".repeat(32);
const TARGET_ACCOUNT = SOURCE_ACCOUNT;
const SOURCE_DATABASE = "10000000-0000-4000-8000-000000000001";
const TARGET_DATABASE = "20000000-0000-4000-8000-000000000002";
const SOURCE_VERSION = "30000000-0000-4000-8000-000000000003";
const SOURCE_DEPLOYMENT = "40000000-0000-4000-8000-000000000004";
const TARGET_VERSION = "50000000-0000-4000-8000-000000000005";
const TARGET_DEPLOYMENT = "60000000-0000-4000-8000-000000000006";
const NEW_VERSION = "70000000-0000-4000-8000-000000000007";
const NEW_DEPLOYMENT = "80000000-0000-4000-8000-000000000008";
const INSTALL_STATE_SQL = `CREATE TABLE IF NOT EXISTS install_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  client_slug TEXT NOT NULL,
  product_version TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 0,
  gate_version INTEGER NOT NULL DEFAULT 0,
  installed_at TEXT NOT NULL,
  last_upgraded_at TEXT,
  ring TEXT NOT NULL DEFAULT 'stable',
  notes TEXT
)`;

const digest = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function domainDigest(domain, value) {
  const serialized = canonical(value);
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(String(Buffer.byteLength(serialized)), "ascii")
    .update("\0", "utf8")
    .update(serialized, "utf8")
    .digest("hex");
}
const evidence = () => ({
  schema_version: 1,
  status: 200,
  content_type: "application/json",
  body_sha256: HASH,
});

const PROVIDER_K0_BINDING = Object.freeze({
  candidate_sha: "1".repeat(40),
  candidate_tree_sha: "2".repeat(40),
  package_sha256: digest("provider-package"),
  field_receipt_sha256: digest("provider-field-receipt"),
  account_id: SOURCE_ACCOUNT,
});
const PROVIDER_K0 = await createTestDisposableRecoveryK0Capability(
  PROVIDER_K0_BINDING,
);
const PROVIDER_K0_PROOF = PROVIDER_K0.proof;

function manifestBinding(role) {
  const source = role === "source";
  return {
    accountId: source ? SOURCE_ACCOUNT : TARGET_ACCOUNT,
    adminKeySecret: `keychain://brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}/owner`,
    answerModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    bankFeedEnabled: false,
    chunkOverlap: "300",
    chunkSize: "1500",
    clientDisplayName: "Synthetic Field Gate v0.4.8",
    clientSlug: "v048-field-proof",
    credentialScanner: "on",
    dailyLlmCapUsd: "10",
    databaseId: source ? SOURCE_DATABASE : TARGET_DATABASE,
    databaseName: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
    domain: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}.fixture.workers.dev`,
    embeddingDimensions: 768,
    embeddingModel: "@cf/baai/bge-base-en-v1.5",
    enabledCorpora: [],
    ocrEnabled: "0",
    ocrModel: "@cf/google/gemma-4-26b-a4b-it",
    productVersion: "0.4.8",
    recoveryArtifactKeySecret: source
      ? null
      : "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
    recoveryFieldGate: source ? null : { custom_domains: [], routes: [] },
    vectorizeIndex: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
    workerName: `brain-test-v048-field-${role}-recovery-gate-a48f110${source ? 1 : 2}`,
  };
}

function manifestBindings(phase = "target") {
  const source = {
    planFingerprint: HASH,
    source: manifestBinding("source"),
    sourceManifestFingerprint: "b".repeat(64),
  };
  return phase === "source" ? source : {
    ...source,
    target: manifestBinding("target"),
    targetManifestFingerprint: "c".repeat(64),
  };
}

function moduleFixture() {
  const root = mkdtempSync(join(tmpdir(), "v048-provider-"));
  chmodSync(root, 0o700);
  const source = join(root, "worker", "src");
  mkdirSync(join(source, "lib"), { recursive: true, mode: 0o700 });
  const records = [
    [join(source, "index.js"), "worker/src/index.js", "export default { fetch() {} };\n"],
    [join(source, "lib", "core.js"), "worker/src/lib/core.js", "export const value = 1;\n"],
  ];
  const executionPins = records.map(([path, relative, content]) => {
    writeFileSync(path, content, { mode: 0o600 });
    return { path, relative, hash: digest(content), info: lstatSync(path) };
  });
  return { root, executionPins };
}

function provisioningModuleFixture() {
  const fixture = moduleFixture();
  const migrationRoot = join(fixture.root, "migrations", "d1");
  mkdirSync(migrationRoot, { recursive: true, mode: 0o700 });
  for (let version = 1; version <= 46; version += 1) {
    const filename = `${String(version).padStart(4, "0")}_fixture_${version}.sql`;
    const relative = `migrations/d1/${filename}`;
    const path = join(fixture.root, relative);
    const content = version === 1
      ? `${INSTALL_STATE_SQL};
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS fixture_1 (id INTEGER PRIMARY KEY);
`
      : `CREATE TABLE IF NOT EXISTS fixture_${version} (id INTEGER PRIMARY KEY);\n`;
    writeFileSync(path, content, { mode: 0o600 });
    fixture.executionPins.push({
      path,
      relative,
      hash: digest(content),
      info: lstatSync(path),
    });
  }
  return fixture;
}

function realProvisioningExecutionFixture() {
  const workerPath = resolve("worker/src/index.js");
  const migrationFiles = readdirSync(resolve("migrations/d1"))
    .filter((name) => /^\d+_.*\.sql$/u.test(name))
    .sort();
  const records = [
    { path: workerPath, relative: "worker/src/index.js" },
    ...migrationFiles.map((name) => ({
      path: resolve("migrations/d1", name),
      relative: `migrations/d1/${name}`,
    })),
  ];
  const executionPins = records.map(({ path, relative }) => {
    const bytes = readFileSync(path);
    try {
      return { path, relative, hash: digest(bytes), info: lstatSync(path) };
    } finally { bytes.fill(0); }
  });
  const migrations = migrationFiles.map((name) => {
    const sql = readFileSync(resolve("migrations/d1", name), "utf8");
    return {
      version: Number(name.slice(0, 4)),
      statements: splitStatements(sql).map((statement) => statement.trim()),
    };
  });
  return { executionPins, migrations };
}

function sqliteSourceSchemaTransport(migrations, lossBoundary = null) {
  const database = new DatabaseSync(":memory:");
  let latestLedgerVersion = 0;
  let lost = false;
  const mutationCounts = new Map();
  const normalized = (sql) => sql.trim().replace(/\s+/gu, " ");
  const migrationStatements = new Map(migrations.map(({ version, statements }) => [
    version,
    new Map(statements.map((statement, index) => [
      normalized(statement),
      `statement:${version}:${index + 1}`,
    ])),
  ]));
  const recordBoundary = (label) => {
    if (!label) return;
    mutationCounts.set(label, (mutationCounts.get(label) || 0) + 1);
    if (!lost && lossBoundary === label) {
      lost = true;
      throw new Error(`synthetic committed response loss: ${label}`);
    }
  };
  const transport = {
    async queryD1({ sql, params }) {
      const statement = database.prepare(sql);
      const results = statement.all(...params).map((row) => ({ ...row }));
      const compact = normalized(sql);
      let boundaryLabel = null;
      if (compact.startsWith("INSERT INTO schema_migrations")) {
        latestLedgerVersion = Number(params[0]);
        boundaryLabel = `ledger:${latestLedgerVersion}`;
      } else if (migrationStatements.get(latestLedgerVersion + 1)?.has(compact)) {
        boundaryLabel = migrationStatements.get(latestLedgerVersion + 1).get(compact);
      } else if (compact.startsWith("INSERT INTO install_state")) {
        boundaryLabel = "postlude:install_state";
      } else if (compact.startsWith(
        "INSERT OR IGNORE INTO owner_financial_map_key_state",
      )) {
        boundaryLabel = "postlude:owner_key";
      } else if (compact.startsWith("INSERT INTO source_original_id_key_state")) {
        boundaryLabel = "postlude:source_key";
      }
      recordBoundary(boundaryLabel);
      return { results, response: evidence() };
    },
  };
  const shape = () => {
    const schema = database.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master " +
      "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    ).all().map((row) => ({ ...row }));
    const tableRows = schema.filter((row) => row.type === "table")
      .map(({ name }) => {
        const quoted = `"${name.replaceAll('"', '""')}"`;
        return [name, Number(database.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get().count)];
      });
    return { schema, table_rows: tableRows };
  };
  const salts = () => ({
    owner: database.prepare(
      "SELECT signing_salt FROM owner_financial_map_key_state WHERE tenant_id = 'primary'",
    ).get()?.signing_salt,
    source: database.prepare(
      "SELECT signing_salt FROM source_original_id_key_state WHERE tenant_id = 'primary'",
    ).get()?.signing_salt,
  });
  const ledger = () => database.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all().map((row) => ({ ...row }));
  return {
    close: () => database.close(),
    ledger,
    mutationCounts,
    salts,
    shape,
    transport,
  };
}

function sourceSchemaTransport({ loseAfter = null, initialTables = [] } = {}) {
  const state = {
    tables: new Map(initialTables),
    applied: [],
    installState: false,
    ownerSalt: null,
    sourceSalt: null,
    lost: false,
    mutationCounts: new Map(),
  };
  const commit = (label, change) => {
    const changed = change();
    if (changed) state.mutationCounts.set(label, (state.mutationCounts.get(label) || 0) + 1);
    if (!state.lost && loseAfter === label) {
      state.lost = true;
      throw new Error(`synthetic committed response loss: ${label}`);
    }
  };
  const validSalt = (value) => /^[a-f0-9]{64}$/u.test(value || "");
  return {
    state,
    transport: {
      async queryD1({ sql, params }) {
        const compact = sql.replace(/\s+/gu, " ").trim();
        let results;
        if (compact.includes("AS user_table_count") &&
            compact.includes("AS schema_migrations_table")) {
          results = [{
            user_table_count: state.tables.size,
            schema_migrations_table: state.tables.has("schema_migrations") ? 1 : 0,
          }];
        } else if (compact.startsWith("SELECT name, type, sql FROM sqlite_master")) {
          results = [...state.tables.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, definition]) => ({ name, type: "table", sql: definition }));
        } else if (compact.startsWith("SELECT version, name, checksum")) {
          results = state.applied.map((row) => ({ ...row }));
        } else if (/^CREATE TABLE IF NOT EXISTS /u.test(compact)) {
          const name = /^CREATE TABLE IF NOT EXISTS ([a-zA-Z0-9_]+)/u.exec(compact)?.[1];
          if (!name) throw new Error("unrecognized fixture DDL");
          commit(`create:${name}`, () => {
            if (state.tables.has(name)) return false;
            state.tables.set(name, sql.trim());
            return true;
          });
          results = [];
        } else if (compact.startsWith("INSERT INTO schema_migrations")) {
          const version = Number(params[0]);
          commit(`ledger:${version}`, () => {
            state.applied.push({ version, name: params[1], checksum: params[3] });
            return true;
          });
          results = [];
        } else if (compact.includes("AS install_state_total_rows") &&
            compact.includes("AS equal_primary_key_rows")) {
          results = [{
            install_state_total_rows: state.installState ? 1 : 0,
            install_state_valid_rows: state.installState ? 1 : 0,
            owner_key_total_rows: state.ownerSalt === null ? 0 : 1,
            owner_key_valid_rows: validSalt(state.ownerSalt) ? 1 : 0,
            source_key_total_rows: state.sourceSalt === null ? 0 : 1,
            source_key_valid_rows: validSalt(state.sourceSalt) ? 1 : 0,
            equal_primary_key_rows: state.ownerSalt !== null &&
              state.ownerSalt === state.sourceSalt ? 1 : 0,
          }];
        } else if (compact.startsWith("INSERT INTO install_state")) {
          commit("postlude:install_state", () => {
            if (state.installState) return false;
            state.installState = true;
            return true;
          });
          results = [];
        } else if (compact.startsWith(
          "INSERT OR IGNORE INTO owner_financial_map_key_state",
        )) {
          commit("postlude:owner_key", () => {
            if (state.ownerSalt !== null) return false;
            state.ownerSalt = "a".repeat(64);
            return true;
          });
          results = [];
        } else if (compact.startsWith("INSERT INTO source_original_id_key_state")) {
          commit("postlude:source_key", () => {
            if (state.sourceSalt !== null) return false;
            state.sourceSalt = "b".repeat(64);
            return true;
          });
          results = [];
        } else if (compact.includes("AS migrations") && compact.includes("AS outbox")) {
          results = [{
            migrations: state.applied.length,
            schema_version: state.applied.at(-1)?.version || 0,
            documents: 0,
            chunks: 0,
            fts: 0,
            outbox: 0,
          }];
        } else {
          throw new Error(`unrecognized fixture query: ${compact.slice(0, 100)}`);
        }
        return { results, response: evidence() };
      },
    },
  };
}

function resource(role, vectorCount = 0) {
  return {
    operation: "read_resource_contract",
    worker_exists: true,
    workers_dev_enabled: true,
    previews_enabled: false,
    routes_count: 0,
    custom_domains_count: 0,
    schedules_count: 0,
    d1_exists: true,
    d1_name_and_id_exact: true,
    vectorize_exists: true,
    vectorize_name_exact: true,
    vector_dimensions: 768,
    vector_metric: "cosine",
    vector_count: vectorCount,
    network_isolation: networkProof(role),
    responses: [
      { operation: "list_workers", ...evidence() },
      { operation: "read_worker_subdomain", ...evidence() },
    ],
  };
}

function fakeTransport(role, calls) {
  const source = role === "source";
  const versionId = source ? SOURCE_VERSION : TARGET_VERSION;
  const deploymentId = source ? SOURCE_DEPLOYMENT : TARGET_DEPLOYMENT;
  return {
    async readCurrentDeployment(input) {
      calls.push({ role, method: "readCurrentDeployment", input });
      return {
        schema_version: 1,
        operation: "read_current_deployment",
        deployment_id: deploymentId,
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
        response: evidence(),
      };
    },
    async readDeployment(input) {
      calls.push({ role, method: "readDeployment", input });
      return {
        schema_version: 1,
        operation: "read_deployment",
        deployment_id: input.deployment_id,
        strategy: "percentage",
        versions: [{ percentage: 100, version_id: versionId }],
        response: evidence(),
      };
    },
    async readVersion(input) {
      calls.push({ role, method: "readVersion", input });
      return {
        schema_version: 1,
        operation: "read_version",
        version_id: input.version_id,
        script_etag: digest(`etag-${role}:${input.version_id}`),
        bindings_sha256: "d".repeat(64),
        bindings_without_mode_sha256: "e".repeat(64),
        bindings_exact: true,
        compatibility_and_usage_model_exact: true,
        handlers: ["fetch", "scheduled"],
        named_handlers_count: 0,
        reviewed_worker_generation_sha256: digest(`reviewed-generation:${role}`),
        response: evidence(),
      };
    },
    async readResourceContract(input) {
      calls.push({ role, method: "readResourceContract", input });
      return resource(role);
    },
    async readCampaignCustody(input) {
      calls.push({ role, method: "readCampaignCustody", input });
      return custodyProof();
    },
    async uploadVersion(input) {
      calls.push({ role, method: "uploadVersion", input });
      return { version_id: NEW_VERSION, operation: "upload_version" };
    },
    async deployVersion(input) {
      calls.push({ role, method: "deployVersion", input });
      return { deployment_id: NEW_DEPLOYMENT, version_id: input.version_id };
    },
  };
}

function networkProof(role) {
  return {
    worker_identity_proved: true,
    worker_identity_sha256: digest(`worker-identity:${role}`),
    workers_dev_identity_proved: true,
    worker_previews_disabled: true,
    worker_cache_enabled: false,
    worker_extra_exports: 0,
    worker_tail_consumers: 0,
    worker_assets: false,
    worker_logpush: false,
    cron_triggers: 0,
    routes: 0,
    custom_domains: 0,
  };
}

function custodyProof() {
  const deployedOn = "2026-09-12T12:00:00.000Z";
  const workerId = (role) => `${role}-worker-id`;
  const binding = (role) => manifestBinding(role);
  const custody = verifyV048ExclusiveCampaignResourceCustodyWithAuthority({
    campaignResources: {
      teardownRole: "source",
      source: {
        workerName: binding("source").workerName,
        workerState: "present",
        d1DatabaseId: binding("source").databaseId,
        vectorizeIndexName: binding("source").vectorizeIndex,
      },
      target: {
        workerName: binding("target").workerName,
        workerState: "present",
        d1DatabaseId: binding("target").databaseId,
        vectorizeIndexName: binding("target").vectorizeIndex,
      },
    },
    initialWorkerList: {
      total_count: 2,
      workers: ["source", "target"].map((role) => ({
        id: workerId(role),
        name: binding(role).workerName,
        deployed_on: deployedOn,
      })),
    },
    nonCampaignWorkers: [],
  });
  const generation = (role) => {
    const mode = role === "source" ? "active" : "paused";
    const preimage = {
      schema_version: 1,
      role,
      mode,
      worker_identity_sha256: networkProof(role).worker_identity_sha256,
      deployment_id: role === "source" ? SOURCE_DEPLOYMENT : TARGET_DEPLOYMENT,
      version_id: role === "source" ? SOURCE_VERSION : TARGET_VERSION,
      reviewed_worker_generation_sha256: digest(`reviewed-generation:${role}`),
    };
    return {
      ...preimage,
      worker_generation_sha256: domainDigest(
        "financial-brain:v0.4.8:disposable-worker-generation:v1",
        preimage,
      ),
    };
  };
  const generationAuthority = {
    source: generation("source"),
    target: generation("target"),
  };
  const vectorizeInstanceAuthority = Object.fromEntries(
    ["source", "target"].map((role) => [role,
      createCloudflareDisposableCampaignVectorizeInstanceAuthority({
        role,
        index_name: binding(role).vectorizeIndex,
        dimensions: 768,
        metric: "cosine",
        created_on: deployedOn,
      })]),
  );
  const roleProof = (role) => ({
    state: { worker: "present", d1: "present", vectorize: "present" },
    worker_instance_sha256: digest(`worker-instance:${role}`),
    d1_instance_sha256: digest(`d1-instance:${role}`),
    vectorize_instance_sha256:
      vectorizeInstanceAuthority[role].instance_sha256,
    worker_protection: {
      schema_version: 1,
      worker_identity_proved: true,
      worker_identity_sha256: networkProof(role).worker_identity_sha256,
      worker_reference_snapshot_sha256: digest(`worker-reference:${role}`),
      reviewed_worker_generation_sha256: digest(`reviewed-generation:${role}`),
      worker_generation_proved: true,
      worker_generation_sha256: generationAuthority[role].worker_generation_sha256,
    },
  });
  const semantic = {
    schema_version: 1,
    operation: "read_campaign_custody",
    captures: 2,
    teardown_role: "source",
    roles: { source: roleProof("source"), target: roleProof("target") },
    campaign_custody: custody.receipt,
    campaign_custody_authority: custody.authority,
    generation_authority: generationAuthority,
    vectorize_instance_authority: vectorizeInstanceAuthority,
  };
  return {
    ...semantic,
    proof_sha256: domainDigest(
      "financial-brain:v0.4.8:disposable-campaign-transport-proof:v1",
      semantic,
    ),
    responses: [{ operation: "campaign_capture", ...evidence() }],
  };
}

function requestPlan(moduleInventorySha256) {
  return {
    source_active_upload: {
      role: "source", mode: "active", module_inventory_sha256: moduleInventorySha256,
    },
    source_active_deployment: {
      role: "source", mode: "active", traffic_percent: 100, force: false,
    },
    target_paused_upload: {
      role: "target", mode: "paused-for-upgrade",
      module_inventory_sha256: moduleInventorySha256,
    },
    target_active_upload: {
      role: "target", mode: "active", module_inventory_sha256: moduleInventorySha256,
    },
    target_paused_deployment: {
      role: "target", mode: "paused-for-upgrade", traffic_percent: 100, force: false,
    },
  };
}

function context(
  phase,
  stage,
  requests,
  keychainBindingSha256 = PROVIDER_K0_PROOF.keychain_binding_sha256,
  exactKeychainBinding = PROVIDER_K0_BINDING,
) {
  const value = {
    binding: {
      candidate_sha: exactKeychainBinding.candidate_sha,
      candidate_tree_sha: exactKeychainBinding.candidate_tree_sha,
      package_sha256: exactKeychainBinding.package_sha256,
      field_receipt_sha256: exactKeychainBinding.field_receipt_sha256,
      campaign_fingerprint: HASH,
      keychain_binding_sha256: keychainBindingSha256,
      plan_fingerprint: HASH,
      source_manifest_fingerprint: "b".repeat(64),
      source_resource_fingerprint: "f".repeat(64),
      target_manifest_fingerprint: "c".repeat(64),
      target_resource_fingerprint: "0".repeat(64),
    },
    phase,
    stage,
    requests,
  };
  if (phase === "target") {
    value.vectorize_mutation_quiescence = {
      schema_version: 1,
      kind: "v048_vectorize_mutation_quiescence_v1",
      approval_fingerprint: digest("quiescence-approval"),
      campaign_identity_sha256: digest("quiescence-campaign"),
      target_resource_fingerprint: "0".repeat(64),
      scope_sha256: digest("quiescence-scope"),
      continuous: true,
      interval_start: "exact_disposable_target_vectorize_index_creation_or_provisioning",
      interval_end: "recovery_final_active_composite_proof_accepted",
      includes_pending_before_first_provider_observation: true,
      mutation_surfaces_attested: 5,
    };
  }
  return value;
}

test("provider refuses non-macOS before credential or transport setup", () => {
  let touched = false;
  assert.throws(
    () => prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: {}, executionPins: [],
    }, {
      platform: "win32",
      fetchImpl: async () => {},
      loadToken: () => { touched = true; },
      createTransport: () => { touched = true; },
    }),
    (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_MACOS_KEYCHAIN_REQUIRED",
  );
  assert.equal(touched, false);
});

test("provider rejects a copied K0 proof before credential or transport setup", () => {
  const fixture = moduleFixture();
  let touched = false;
  try {
    assert.throws(
      () => prepareCloudflareDisposableDeploymentProvider({
        manifestBindings: manifestBindings("source"),
        executionPins: fixture.executionPins,
        phase: "source",
        keychainBinding: PROVIDER_K0_BINDING,
        keychainProof: Object.freeze({ ...PROVIDER_K0_PROOF }),
      }, {
        platform: "darwin",
        fetchImpl: async () => { touched = true; },
        loadToken: () => { touched = true; },
        createTransport: () => { touched = true; },
      }),
      (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
        error.code === "CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID",
    );
    assert.equal(touched, false);
    assert.throws(
      () => prepareCloudflareDisposableProvisioningProvider({
        executionPins: fixture.executionPins,
        role: "target",
        accountId: "2".repeat(32),
        keychainBinding: PROVIDER_K0_BINDING,
        keychainProof: PROVIDER_K0_PROOF,
      }, {
        platform: "darwin",
        fetchImpl: async () => { touched = true; },
        loadToken: () => { touched = true; },
        readKeychain: () => { touched = true; },
        createTransport: () => { touched = true; },
      }),
      (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
        error.code === "CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID",
    );
    assert.equal(touched, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provisioning provider resolves bounded Keychain values before writes and confirms six ACTIVE indexes", async () => {
  const fixture = provisioningModuleFixture();
  const calls = [];
  const metadataIndexes = [];
  const resourceName = "brain-test-v048-field-target-recovery-gate-a48f1102";
  const workerId = "9".repeat(32);
  const createdOn = "2026-09-13T12:00:00.000Z";
  const artifactKey = `v1.${Buffer.alloc(32, 1).toString("base64url")}`;
  const bankKey = `v2.${Buffer.alloc(32, 2).toString("base64url")}`;
  const adminKey = "A".repeat(48);
  let baselineSecretNames = [];
  try {
    const prepared = prepareCloudflareDisposableProvisioningProvider({
      executionPins: fixture.executionPins,
      role: "target",
      accountId: SOURCE_ACCOUNT,
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: async () => Buffer.alloc(32, 3),
      readKeychain(reference) {
        calls.push(`keychain:${reference.service}/${reference.account}`);
        if (reference.account === "artifact-v1") return artifactKey;
        if (reference.account === "bank-wrapping-v2") return bankKey;
        return adminKey;
      },
      createTransport: () => ({
        async createD1Database() {
          calls.push("provider:createD1");
          return { database_id: TARGET_DATABASE, response: evidence() };
        },
        async createVectorizeIndex() {
          calls.push("provider:createVectorize");
          return { created_on: createdOn, response: evidence() };
        },
        async createVectorizeMetadataIndex(input) {
          calls.push(`provider:createMetadata:${input.property_name}`);
          metadataIndexes.push({
            property_name: input.property_name,
            index_type: input.index_type,
          });
          return { response: evidence() };
        },
        async readVectorizeMetadataIndexes() {
          calls.push("provider:readMetadata");
          return { indexes: [...metadataIndexes], response: evidence() };
        },
        async createWorkerIdentity(input) {
          calls.push("provider:createWorker");
          assert.equal(input.tag, `v048-field-target-${HASH}`);
          return { worker_id: workerId, response: evidence() };
        },
        async readWorkerIdentity(input) {
          calls.push("provider:readWorker");
          assert.equal(input.expected_tag, `v048-field-target-${HASH}`);
          return {
            worker_id: workerId,
            hostname: `${resourceName}.fixture.workers.dev`,
            created_on: createdOn,
            tag_sha256: digest(`v048-field-target-${HASH}`),
            response: evidence(),
          };
        },
        async createWorkerBaseline(input) {
          calls.push("provider:createBaseline");
          baselineSecretNames = input.secret_bindings.map(({ name }) => name).sort();
          assert.equal(input.secret_bindings.find(({ name }) => name === "ADMIN_KEY").text,
            adminKey);
          assert.equal(input.secret_bindings.find(({ name }) =>
            name === "BANK_FEED_WRAPPING_KEY_V2").text, bankKey);
          return { version_id: TARGET_VERSION, response: evidence() };
        },
      }),
    });
    assert.equal(calls.length, 0, "preparation must not touch Keychain or provider");
    assert.match(prepared.migrationInventorySha256, /^[a-f0-9]{64}$/u);
    const mutation = await prepared.createMutationProvider();
    assert.equal(calls.length, 3, "all target secrets resolve before the first provider call");
    assert.equal(calls.every((entry) => entry.startsWith("keychain:")), true);
    const d1 = await mutation.createD1();
    const vector = await mutation.createVectorize();
    for (const [propertyName, indexType] of [
      ["source", "string"], ["client", "string"], ["category", "string"],
      ["top_folder", "string"], ["platform", "string"], ["document_date", "number"],
    ]) {
      const result = await mutation.createMetadataIndex(
        { propertyName, indexType }, { sleep: async () => {}, attempts: 1 },
      );
      assert.deepEqual(result.result, {
        property_name: propertyName,
        index_type: indexType,
      });
    }
    const worker = await mutation.createWorker({ campaignFingerprint: HASH });
    const identity = await mutation.readFinalIdentity({
      workerId: worker.result.worker_id,
      campaignFingerprint: HASH,
    });
    const baseline = await mutation.createBaseline({
      databaseId: d1.result.database_id,
      workerId: worker.result.worker_id,
      hostname: identity.hostname,
      campaignFingerprint: HASH,
    });
    assert.equal(vector.result.accepted, true);
    assert.equal(metadataIndexes.length, 6);
    assert.deepEqual(baselineSecretNames, [
      "ADMIN_KEY", "BANK_FEED_WRAPPING_KEY_V2", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY",
    ]);
    assert.equal(baseline.result.version_id, TARGET_VERSION);
    const serialized = JSON.stringify({ prepared, d1, vector, worker, baseline });
    for (const secret of [adminKey, artifactKey, bankKey]) {
      assert.equal(serialized.includes(secret), false);
    }
    mutation.dispose();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real provisioning provider reconciles each resource state without issuing a second mutation", async () => {
  const fixture = provisioningModuleFixture();
  const resourceName = "brain-test-v048-field-target-recovery-gate-a48f1102";
  const workerId = "9".repeat(32);
  const createdOn = "2026-09-13T12:00:00.000Z";
  let collisionSequence = [];
  let state = {};
  let metadataIndexes = [];
  let metadataSequence = [];
  let identityReads = 0;
  let identityDrift = false;
  let mutationCalls = 0;
  const collision = (overrides = {}) => ({
    schema_version: 1,
    operation: "read_provisioning_collisions",
    account_id: SOURCE_ACCOUNT,
    resource_name: resourceName,
    worker_exists: false,
    d1_exists: false,
    vectorize_exists: false,
    worker_ids: [],
    d1_ids: [],
    vectorize_names: [],
    vectorize_created_on: null,
    responses: [{ operation: "fixture", ...evidence() }],
    ...overrides,
  });
  try {
    const transport = {
      async readProvisioningCollisions() {
        return collisionSequence.length > 0
          ? collision(collisionSequence.shift())
          : collision(state);
      },
      async readVectorizeMetadataIndexes() {
        return {
          indexes: metadataSequence.length > 0
            ? metadataSequence.shift()
            : metadataIndexes.map((entry) => ({ ...entry })),
          response: evidence(),
        };
      },
      async readWorkerIdentity() {
        identityReads += 1;
        return {
          worker_id: workerId,
          hostname: identityDrift && identityReads % 2 === 0
            ? `competing-${resourceName}.fixture.workers.dev`
            : `${resourceName}.fixture.workers.dev`,
          created_on: createdOn,
          tag_sha256: digest(`v048-field-target-${HASH}`),
          response: evidence(),
        };
      },
      async createD1Database() { mutationCalls += 1; throw new Error("unexpected mutation"); },
      async createVectorizeIndex() { mutationCalls += 1; throw new Error("unexpected mutation"); },
      async createVectorizeMetadataIndex() {
        mutationCalls += 1; throw new Error("unexpected mutation");
      },
      async createWorkerIdentity() { mutationCalls += 1; throw new Error("unexpected mutation"); },
    };
    const prepared = prepareCloudflareDisposableProvisioningProvider({
      executionPins: fixture.executionPins,
      role: "target",
      accountId: SOURCE_ACCOUNT,
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: async () => Buffer.alloc(32, 3),
      readKeychain(reference) {
        if (reference.account === "artifact-v1") {
          return `v1.${Buffer.alloc(32, 1).toString("base64url")}`;
        }
        if (reference.account === "bank-wrapping-v2") {
          return `v2.${Buffer.alloc(32, 2).toString("base64url")}`;
        }
        return "A".repeat(48);
      },
      createTransport: () => transport,
    });
    const mutation = await prepared.createMutationProvider();

    state = {};
    assert.deepEqual(await mutation.reconcileD1(async () => true), {
      outcome: "resume_safe",
    });
    state = { d1_exists: true, d1_ids: [TARGET_DATABASE] };
    const d1Confirmed = await mutation.reconcileD1(async () => true);
    assert.equal(d1Confirmed.outcome, "confirmed");
    assert.equal(d1Confirmed.value.result.database_id, TARGET_DATABASE);
    collisionSequence = [{}, { d1_exists: true, d1_ids: [TARGET_DATABASE] }];
    await assert.rejects(mutation.reconcileD1(async () => true), (error) =>
      error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
    state = { vectorize_exists: true, vectorize_names: [resourceName],
      vectorize_created_on: createdOn };
    await assert.rejects(mutation.reconcileD1(async () => true), (error) =>
      error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");

    state = { d1_exists: true, d1_ids: [TARGET_DATABASE] };
    assert.deepEqual(await mutation.reconcileVectorize(
      TARGET_DATABASE, async () => true,
    ), { outcome: "resume_safe" });
    state = {
      d1_exists: true, d1_ids: [TARGET_DATABASE], vectorize_exists: true,
      vectorize_names: [resourceName], vectorize_created_on: createdOn,
    };
    const vectorConfirmed = await mutation.reconcileVectorize(
      TARGET_DATABASE, async () => true,
    );
    assert.equal(vectorConfirmed.outcome, "confirmed");
    assert.equal(vectorConfirmed.value.result.created_on, createdOn);
    state.vectorize_created_on = "not-a-time";
    await assert.rejects(mutation.reconcileVectorize(
      TARGET_DATABASE, async () => true,
    ), (error) => error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");

    for (const [propertyName, indexType] of [
      ["source", "string"], ["client", "string"], ["category", "string"],
      ["top_folder", "string"], ["platform", "string"], ["document_date", "number"],
    ]) {
      metadataIndexes = [];
      assert.deepEqual(await mutation.reconcileMetadataIndex(
        { propertyName, indexType }, async () => true,
      ), { outcome: "resume_safe" });
      metadataIndexes = [{ property_name: propertyName, index_type: indexType }];
      const confirmed = await mutation.reconcileMetadataIndex(
        { propertyName, indexType }, async () => true,
      );
      assert.equal(confirmed.outcome, "confirmed");
      metadataIndexes = [{ property_name: propertyName,
        index_type: indexType === "string" ? "number" : "string" }];
      await assert.rejects(mutation.reconcileMetadataIndex(
        { propertyName, indexType }, async () => true,
      ), (error) => error.code === "CF_DISPOSABLE_PROVIDER_METADATA_INDEX_MISMATCH");
    }
    metadataIndexes = [];
    metadataSequence = [[], [{ property_name: "source", index_type: "string" }]];
    await assert.rejects(mutation.reconcileMetadataIndex(
      { propertyName: "source", indexType: "string" }, async () => true,
    ), (error) => error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");

    state = {
      d1_exists: true, d1_ids: [TARGET_DATABASE], vectorize_exists: true,
      vectorize_names: [resourceName], vectorize_created_on: createdOn,
    };
    assert.deepEqual(await mutation.reconcileWorker(
      TARGET_DATABASE, HASH, async () => true,
    ), { outcome: "resume_safe" });
    state = { ...state, worker_exists: true, worker_ids: [workerId] };
    identityReads = 0;
    const workerConfirmed = await mutation.reconcileWorker(
      TARGET_DATABASE, HASH, async () => true,
    );
    assert.equal(workerConfirmed.outcome, "confirmed");
    assert.equal(workerConfirmed.value.result.worker_id, workerId);
    identityDrift = true;
    identityReads = 0;
    await assert.rejects(mutation.reconcileWorker(
      TARGET_DATABASE, HASH, async () => true,
    ), (error) => error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");
    identityDrift = false;
    state = { ...state, worker_ids: [workerId, "8".repeat(32)] };
    await assert.rejects(mutation.reconcileWorker(
      TARGET_DATABASE, HASH, async () => true,
    ), (error) => error.code === "CF_DISPOSABLE_PROVIDER_RESOURCE_CHANGED");

    assert.equal(mutationCalls, 0);
    mutation.dispose();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("baseline reconciliation never duplicates an orphaned upload and binds one exact campaign version", async () => {
  const fixture = provisioningModuleFixture();
  const resourceName = "brain-test-v048-field-target-recovery-gate-a48f1102";
  const workerId = "9".repeat(32);
  const hostname = `${resourceName}.fixture.workers.dev`;
  let mode = "empty";
  let baselineCreates = 0;
  try {
    let prepared;
    const transport = {
      async readCurrentDeploymentState() {
        const deploymentCount = mode === "empty" || mode === "orphan" ? 0 :
          mode === "multiple-deployments" ? 2 : 1;
        return {
          schema_version: 1,
          operation: "read_current_deployment_state",
          deployment_count: deploymentCount,
          current: deploymentCount === 0 ? null : {
            deployment_id: TARGET_DEPLOYMENT,
            strategy: "percentage",
            versions: [{ percentage: 100, version_id: TARGET_VERSION }],
          },
          response: evidence(),
        };
      },
      async readWorkerVersionInventory() {
        const empty = mode === "empty";
        return {
          schema_version: 1,
          operation: "read_worker_version_inventory",
          worker_id: workerId,
          version_count: empty ? 0 : 1,
          versions: empty ? [] : [{
            version_id: TARGET_VERSION,
            created_on: "2026-09-13T12:00:00.000Z",
            number: 1,
            tag_sha256: digest(`v048-field-target-bootstrap-${HASH}`),
            message_sha256: digest(
              "Financial Brain 0.4.8 disposable target maintenance bootstrap",
            ),
            compatibility_date: "2026-01-01",
            main_module: "field-bootstrap.mjs",
            bindings_sha256: HASH,
            module_inventory_sha256: mode === "module-drift"
              ? "f".repeat(64)
              : prepared.bootstrapModuleInventorySha256,
          }],
          responses: [{ operation: "list_worker_versions_for_provision_page_1", ...evidence() }],
        };
      },
      async readWorkerVersionForProvisioning(input) {
        return {
          worker_id: workerId,
          version_id: input.version_id,
          tag_sha256: digest(`v048-field-target-bootstrap-${HASH}`),
          message_sha256: digest(
            "Financial Brain 0.4.8 disposable target maintenance bootstrap",
          ),
          compatibility_date: "2026-01-01",
          main_module: "field-bootstrap.mjs",
          bindings_sha256: HASH,
          behavior_exact: true,
          behavior_sha256: "b".repeat(64),
          module_inventory_sha256: mode === "module-drift"
            ? "f".repeat(64)
            : prepared.bootstrapModuleInventorySha256,
          response: evidence(),
        };
      },
      async readDeployment() {
        return {
          deployment_id: TARGET_DEPLOYMENT,
          versions: [{ percentage: 100, version_id: TARGET_VERSION }],
          response: evidence(),
        };
      },
      async readVersion() {
        return {
          version_id: TARGET_VERSION,
          script_etag: "fixture-bootstrap-etag",
          bindings_sha256: HASH,
          bindings_without_mode_sha256: HASH,
          behavior_exact: true,
          behavior_sha256: "b".repeat(64),
          handlers: ["fetch", "scheduled"],
          named_handlers_count: 0,
          response: evidence(),
        };
      },
      async readWorkerVersionSettings() {
        return {
          tag_sha256: digest(`v048-field-target-bootstrap-${HASH}`),
          message_sha256: digest(
            "Financial Brain 0.4.8 disposable target maintenance bootstrap",
          ),
          behavior_exact: true,
          behavior_sha256: "c".repeat(64),
          response: evidence(),
        };
      },
      async readWorkerIdentity() {
        return {
          worker_id: workerId,
          hostname,
          created_on: "2026-09-13T12:00:00.000Z",
          tag_sha256: digest(`v048-field-target-${HASH}`),
          response: evidence(),
        };
      },
      async readResourceContract() {
        return {
          ...resource("target", 0),
          vectorize_created_on: "2026-09-13T12:00:00.000Z",
        };
      },
      async readVectorizeMetadataIndexes() {
        return {
          indexes: [
            { property_name: "category", index_type: "string" },
            { property_name: "client", index_type: "string" },
            { property_name: "document_date", index_type: "number" },
            { property_name: "platform", index_type: "string" },
            { property_name: "source", index_type: "string" },
            { property_name: "top_folder", index_type: "string" },
          ],
          response: evidence(),
        };
      },
      async queryD1() {
        return { results: [{ user_table_count: 0 }], response: evidence() };
      },
      async createWorkerBaseline() {
        baselineCreates += 1;
        throw new Error("must not be called by reconciliation");
      },
    };
    prepared = prepareCloudflareDisposableProvisioningProvider({
      executionPins: fixture.executionPins,
      role: "target",
      accountId: SOURCE_ACCOUNT,
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: async () => Buffer.alloc(32, 3),
      readKeychain(reference) {
        if (reference.account === "artifact-v1") {
          return `v1.${Buffer.alloc(32, 1).toString("base64url")}`;
        }
        if (reference.account === "bank-wrapping-v2") {
          return `v2.${Buffer.alloc(32, 2).toString("base64url")}`;
        }
        return "A".repeat(48);
      },
      createTransport: () => transport,
    });
    const mutation = await prepared.createMutationProvider();
    const input = {
      databaseId: TARGET_DATABASE,
      workerId,
      hostname,
      campaignFingerprint: HASH,
    };
    assert.deepEqual(await mutation.reconcileBaseline(input), { outcome: "resume_safe" });

    mode = "orphan";
    await assert.rejects(mutation.reconcileBaseline(input), (error) =>
      error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_BASELINE_UPLOAD_AMBIGUOUS");

    mode = "multiple-deployments";
    await assert.rejects(mutation.reconcileBaseline(input), (error) =>
      error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");

    mode = "module-drift";
    await assert.rejects(mutation.reconcileBaseline(input), (error) =>
      error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");

    mode = "confirmed";
    const confirmed = await mutation.reconcileBaseline(input);
    assert.equal(confirmed.outcome, "confirmed");
    assert.equal(confirmed.value.result.version_id, TARGET_VERSION);
    assert.equal(baselineCreates, 0);

    const final = await mutation.readFinal({
      databaseId: TARGET_DATABASE,
      workerId,
      vectorCreatedOn: "2026-09-13T12:00:00.000Z",
      baselineVersionId: TARGET_VERSION,
      campaignFingerprint: HASH,
    });
    assert.equal(final.semantic.active_version_id, TARGET_VERSION);
    assert.equal(final.semantic.worker_id, workerId);

    mode = "multiple-deployments";
    await assert.rejects(mutation.readFinal({
      databaseId: TARGET_DATABASE,
      workerId,
      vectorCreatedOn: "2026-09-13T12:00:00.000Z",
      baselineVersionId: TARGET_VERSION,
      campaignFingerprint: HASH,
    }), (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
      error.code === "CF_DISPOSABLE_PROVIDER_DEPLOYMENT_CHANGED");
    mutation.dispose();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source final read proves valid independent key-state rows without returning salts", async () => {
  const fixture = provisioningModuleFixture();
  const resourceName = "brain-test-v048-field-source-recovery-gate-a48f1101";
  const workerId = "7".repeat(32);
  const hostname = `${resourceName}.fixture.workers.dev`;
  const createdOn = "2026-09-13T12:00:00.000Z";
  let equalPrimaryKeyRows = 0;
  try {
    let prepared;
    const transport = {
      async readWorkerIdentity() {
        return {
          worker_id: workerId, hostname, created_on: createdOn,
          tag_sha256: digest(`v048-field-source-${HASH}`), response: evidence(),
        };
      },
      async readCurrentDeploymentState() {
        return {
          deployment_count: 1,
          current: {
            deployment_id: SOURCE_DEPLOYMENT,
            strategy: "percentage",
            versions: [{ percentage: 100, version_id: SOURCE_VERSION }],
          },
          response: evidence(),
        };
      },
      async readWorkerVersionInventory() {
        return {
          worker_id: workerId, version_count: 1,
          versions: [{ version_id: SOURCE_VERSION, created_on: createdOn, number: 1 }],
          responses: [{ operation: "fixture", ...evidence() }],
        };
      },
      async readWorkerVersionForProvisioning() {
        return {
          worker_id: workerId,
          version_id: SOURCE_VERSION,
          tag_sha256: digest(`v048-field-source-bootstrap-${HASH}`),
          message_sha256: digest(
            "Financial Brain 0.4.8 disposable source maintenance bootstrap",
          ),
          compatibility_date: "2026-01-01",
          main_module: "field-bootstrap.mjs",
          bindings_sha256: HASH,
          behavior_exact: true,
          behavior_sha256: "b".repeat(64),
          module_inventory_sha256: prepared.bootstrapModuleInventorySha256,
          response: evidence(),
        };
      },
      async readDeployment() {
        return {
          deployment_id: SOURCE_DEPLOYMENT,
          versions: [{ percentage: 100, version_id: SOURCE_VERSION }],
          response: evidence(),
        };
      },
      async readVersion() {
        return {
          version_id: SOURCE_VERSION,
          script_etag: "fixture-source-bootstrap-etag",
          bindings_sha256: HASH,
          bindings_without_mode_sha256: HASH,
          behavior_exact: true,
          behavior_sha256: "b".repeat(64),
          handlers: ["fetch", "scheduled"],
          named_handlers_count: 0,
          response: evidence(),
        };
      },
      async readWorkerVersionSettings(input) {
        assert.equal(input.worker_tag, `v048-field-source-${HASH}`);
        return {
          tag_sha256: digest(`v048-field-source-bootstrap-${HASH}`),
          message_sha256: digest(
            "Financial Brain 0.4.8 disposable source maintenance bootstrap",
          ),
          behavior_exact: true,
          behavior_sha256: "c".repeat(64),
          response: evidence(),
        };
      },
      async readResourceContract() {
        return { ...resource("source", 0), vectorize_created_on: createdOn };
      },
      async readVectorizeMetadataIndexes() {
        return {
          indexes: [
            { property_name: "category", index_type: "string" },
            { property_name: "client", index_type: "string" },
            { property_name: "document_date", index_type: "number" },
            { property_name: "platform", index_type: "string" },
            { property_name: "source", index_type: "string" },
            { property_name: "top_folder", index_type: "string" },
          ],
          response: evidence(),
        };
      },
      async queryD1() {
        return {
          results: [{
            migrations: 46,
            schema_version: 46,
            documents: 0,
            chunks: 0,
            fts: 0,
            outbox: 0,
            install_state_total_rows: 1,
            install_state_valid_rows: 1,
            owner_key_total_rows: 1,
            owner_key_valid_rows: 1,
            source_key_total_rows: 1,
            source_key_valid_rows: 1,
            equal_primary_key_rows: equalPrimaryKeyRows,
          }],
          response: evidence(),
        };
      },
    };
    prepared = prepareCloudflareDisposableProvisioningProvider({
      executionPins: fixture.executionPins,
      role: "source",
      accountId: SOURCE_ACCOUNT,
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: async () => Buffer.alloc(32, 4),
      readKeychain: () => "A".repeat(48),
      createTransport: () => transport,
    });
    const mutation = await prepared.createMutationProvider();
    const final = await mutation.readFinal({
      databaseId: SOURCE_DATABASE,
      workerId,
      vectorCreatedOn: createdOn,
      baselineVersionId: SOURCE_VERSION,
      campaignFingerprint: HASH,
    });
    assert.equal(final.semantic.schema_version, 46);
    assert.equal(JSON.stringify(final).includes("0123456789abcdef".repeat(4)), false);
    assert.equal(JSON.stringify(final).includes("fedcba9876543210".repeat(4)), false);
    equalPrimaryKeyRows = 1;
    await assert.rejects(mutation.readFinal({
      databaseId: SOURCE_DATABASE,
      workerId,
      vectorCreatedOn: createdOn,
      baselineVersionId: SOURCE_VERSION,
      campaignFingerprint: HASH,
    }), (error) => error.code === "CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
    mutation.dispose();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source schema initialization reconciles an exact committed migration prefix and resumes pending work", async () => {
  const fixture = provisioningModuleFixture();
  const applied = [];
  const statementCalls = new Map();
  let schemaTable = false;
  let installState = false;
  let ownerKey = false;
  let sourceKey = false;
  let loseAtTwelve = true;
  try {
    const prepared = prepareCloudflareDisposableProvisioningProvider({
      executionPins: fixture.executionPins,
      role: "source",
      accountId: SOURCE_ACCOUNT,
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: async () => Buffer.alloc(32, 4),
      readKeychain: () => "A".repeat(48),
      createTransport: () => ({
        async queryD1({ sql, params }) {
          const compact = sql.replace(/\s+/gu, " ").trim();
          let results = [];
          if (compact.includes("AS user_table_count") &&
              compact.includes("AS schema_migrations_table")) {
            results = [{
              user_table_count: schemaTable ? applied.length + 1 : 0,
              schema_migrations_table: schemaTable ? 1 : 0,
            }];
          } else if (compact.startsWith("SELECT version, name, checksum")) {
            results = applied.map((row) => ({ ...row }));
          } else if (compact.startsWith("CREATE TABLE IF NOT EXISTS fixture_")) {
            const version = Number(/fixture_(\d+)/u.exec(compact)?.[1]);
            statementCalls.set(version, (statementCalls.get(version) || 0) + 1);
          } else if (compact.startsWith("INSERT INTO schema_migrations")) {
            schemaTable = true;
            applied.push({ version: params[0], name: params[1], checksum: params[3] });
            if (params[0] === 12 && loseAtTwelve) {
              loseAtTwelve = false;
              throw new Error("synthetic committed query response loss");
            }
          } else if (compact.includes("AS install_state_total_rows") &&
              compact.includes("AS equal_primary_key_rows")) {
            results = [{
              install_state_total_rows: installState ? 1 : 0,
              install_state_valid_rows: installState ? 1 : 0,
              owner_key_total_rows: ownerKey ? 1 : 0,
              owner_key_valid_rows: ownerKey ? 1 : 0,
              source_key_total_rows: sourceKey ? 1 : 0,
              source_key_valid_rows: sourceKey ? 1 : 0,
              equal_primary_key_rows: 0,
            }];
          } else if (compact.startsWith("INSERT INTO install_state")) {
            installState = true;
          } else if (compact.startsWith("INSERT OR IGNORE INTO owner_financial_map_key_state")) {
            ownerKey = true;
          } else if (compact.startsWith("INSERT INTO source_original_id_key_state")) {
            sourceKey = true;
          } else if (compact.includes("AS migrations") && compact.includes("AS outbox")) {
            results = [{
              migrations: applied.length,
              schema_version: applied.at(-1)?.version || 0,
              documents: 0,
              chunks: 0,
              fts: 0,
              outbox: 0,
              install_state_rows: installState ? 1 : 0,
            }];
          }
          return { results, response: evidence() };
        },
      }),
    });
    const mutation = await prepared.createMutationProvider();
    await assert.rejects(
      mutation.initializeSourceSchema(SOURCE_DATABASE),
      /synthetic committed query response loss/,
    );
    assert.equal(applied.length, 12);
    assert.deepEqual(await mutation.reconcileSourceSchema(SOURCE_DATABASE), {
      outcome: "resume_safe",
    });
    const completed = await mutation.initializeSourceSchema(SOURCE_DATABASE);
    assert.equal(completed.result.schema_version, 46);
    assert.equal(applied.length, 46);
    for (let version = 1; version <= 12; version += 1) {
      assert.equal(statementCalls.get(version), 1, `migration ${version} must not replay`);
    }
    const reconciled = await mutation.reconcileSourceSchema(SOURCE_DATABASE);
    assert.equal(reconciled.outcome, "confirmed");
    assert.equal(reconciled.value.result.schema_version, 46);
    mutation.dispose();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("source schema resumes every committed bootstrap and postlude boundary without rotating salts", async (t) => {
  const fixture = provisioningModuleFixture();
  const prepare = (transport) => prepareCloudflareDisposableProvisioningProvider({
    executionPins: fixture.executionPins,
    role: "source",
    accountId: SOURCE_ACCOUNT,
    keychainBinding: PROVIDER_K0_BINDING,
    keychainProof: PROVIDER_K0_PROOF,
  }, {
    platform: "darwin",
    fetchImpl: async () => { throw new Error("unused"); },
    loadToken: async () => Buffer.alloc(32, 4),
    readKeychain: () => "A".repeat(48),
    createTransport: () => transport,
  });
  try {
    for (const loss of [
      "create:install_state",
      "ledger:46",
      "postlude:install_state",
      "postlude:owner_key",
      "postlude:source_key",
    ]) {
      await t.test(loss, async () => {
        const fixtureTransport = sourceSchemaTransport({ loseAfter: loss });
        const mutation = await prepare(fixtureTransport.transport).createMutationProvider();
        await assert.rejects(
          mutation.initializeSourceSchema(SOURCE_DATABASE),
          new RegExp(`synthetic committed response loss: ${loss}`),
        );
        const reconciliation = await mutation.reconcileSourceSchema(SOURCE_DATABASE);
        assert.equal(reconciliation.outcome,
          loss === "postlude:source_key" ? "confirmed" : "resume_safe");
        const completed = await mutation.initializeSourceSchema(SOURCE_DATABASE);
        assert.equal(completed.result.schema_version, 46);
        assert.equal(fixtureTransport.state.installState, true);
        assert.match(fixtureTransport.state.ownerSalt, /^[a-f0-9]{64}$/u);
        assert.match(fixtureTransport.state.sourceSalt, /^[a-f0-9]{64}$/u);
        assert.notEqual(fixtureTransport.state.ownerSalt, fixtureTransport.state.sourceSalt);
        for (const label of [
          "ledger:46", "postlude:install_state", "postlude:owner_key",
          "postlude:source_key",
        ]) {
          assert.equal(fixtureTransport.state.mutationCounts.get(label), 1,
            `${label} must commit exactly once after ${loss}`);
        }
        assert.equal(fixtureTransport.state.mutationCounts.get("create:install_state"), 1);
        const finalReconcile = await mutation.reconcileSourceSchema(SOURCE_DATABASE);
        assert.equal(finalReconcile.outcome, "confirmed");
        mutation.dispose();
      });
    }

    await t.test("unknown pre-ledger table", async () => {
      const fixtureTransport = sourceSchemaTransport({
        initialTables: [["foreign_table", "CREATE TABLE foreign_table (id INTEGER)"]],
      });
      const mutation = await prepare(fixtureTransport.transport).createMutationProvider();
      await assert.rejects(mutation.reconcileSourceSchema(SOURCE_DATABASE), (error) =>
        error.code === "CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
      mutation.dispose();
    });

    await t.test("lookalike install_state schema", async () => {
      const fixtureTransport = sourceSchemaTransport({
        initialTables: [["install_state", "CREATE TABLE install_state (id INTEGER)"]],
      });
      const mutation = await prepare(fixtureTransport.transport).createMutationProvider();
      await assert.rejects(mutation.reconcileSourceSchema(SOURCE_DATABASE), (error) =>
        error.code === "CF_DISPOSABLE_PROVIDER_D1_NOT_EMPTY");
      mutation.dispose();
    });

    await t.test("equal supposedly independent salts", async () => {
      const fixtureTransport = sourceSchemaTransport();
      const mutation = await prepare(fixtureTransport.transport).createMutationProvider();
      await mutation.initializeSourceSchema(SOURCE_DATABASE);
      fixtureTransport.state.sourceSalt = fixtureTransport.state.ownerSalt;
      await assert.rejects(mutation.reconcileSourceSchema(SOURCE_DATABASE), (error) =>
        error.code === "CF_DISPOSABLE_PROVIDER_D1_READBACK_INVALID");
      mutation.dispose();
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("real schema 46 resumes every migration statement and ledger boundary exactly", {
  timeout: 120_000,
}, async () => {
  const fixture = realProvisioningExecutionFixture();
  assert.equal(fixture.migrations.length, 46);
  let active;
  const transportProxy = {
    queryD1: (...args) => active.transport.queryD1(...args),
  };
  const prepared = prepareCloudflareDisposableProvisioningProvider({
    executionPins: fixture.executionPins,
    role: "source",
    accountId: SOURCE_ACCOUNT,
    keychainBinding: PROVIDER_K0_BINDING,
    keychainProof: PROVIDER_K0_PROOF,
  }, {
    platform: "darwin",
    fetchImpl: async () => { throw new Error("unused"); },
    loadToken: async () => Buffer.alloc(32, 4),
    readKeychain: () => "A".repeat(48),
    createTransport: () => transportProxy,
  });
  const complete = async (lossBoundary = null) => {
    active = sqliteSourceSchemaTransport(fixture.migrations, lossBoundary);
    const mutation = await prepared.createMutationProvider();
    try {
      if (lossBoundary !== null) {
        await assert.rejects(
          mutation.initializeSourceSchema(SOURCE_DATABASE),
          (error) => error?.message ===
            `synthetic committed response loss: ${lossBoundary}`,
          lossBoundary,
        );
        const reconciled = await mutation.reconcileSourceSchema(SOURCE_DATABASE);
        assert.equal(reconciled.outcome,
          lossBoundary === "postlude:source_key" ? "confirmed" : "resume_safe",
          lossBoundary);
      }
      const result = await mutation.initializeSourceSchema(SOURCE_DATABASE);
      assert.equal(result.result.schema_version, 46, lossBoundary || "clean");
      const firstSalts = active.salts();
      assert.match(firstSalts.owner, /^[a-f0-9]{64}$/u, lossBoundary || "clean");
      assert.match(firstSalts.source, /^[a-f0-9]{64}$/u, lossBoundary || "clean");
      assert.notEqual(firstSalts.owner, firstSalts.source, lossBoundary || "clean");
      const second = await mutation.initializeSourceSchema(SOURCE_DATABASE);
      assert.equal(second.result.schema_version, 46, lossBoundary || "clean");
      assert.deepEqual(active.salts(), firstSalts,
        `${lossBoundary || "clean"}: identity salts must never rotate`);
      const ledger = active.ledger();
      assert.equal(ledger.length, 46, lossBoundary || "clean");
      assert.deepEqual(ledger.map(({ version }) => Number(version)),
        Array.from({ length: 46 }, (_, index) => index + 1), lossBoundary || "clean");
      for (let version = 1; version <= 46; version += 1) {
        assert.equal(active.mutationCounts.get(`ledger:${version}`), 1,
          `${lossBoundary || "clean"}: ledger ${version} must commit once`);
      }
      return active.shape();
    } finally {
      mutation.dispose();
    }
  };

  const cleanShape = await complete();
  active.close();
  const statementBoundaries = fixture.migrations.flatMap(({ version, statements }) =>
    statements.map((unused, index) => `statement:${version}:${index + 1}`));
  assert.equal(statementBoundaries.length, 422,
    "the immutable schema-46 inventory changed; review this crash matrix before updating it");
  const lossBoundaries = [
    ...statementBoundaries,
    ...Array.from({ length: 46 }, (_, index) => `ledger:${index + 1}`),
    "postlude:install_state",
    "postlude:owner_key",
    "postlude:source_key",
  ];
  for (const lossBoundary of lossBoundaries) {
    try {
      const resumedShape = await complete(lossBoundary);
      assert.deepEqual(resumedShape, cleanShape,
        `${lossBoundary}: resume must neither duplicate nor skip schema effects`);
    } finally {
      active.close();
    }
  }
});

test("provider rejects cross-account manifests before transport or token access", () => {
  const fixture = moduleFixture();
  let touched = false;
  try {
    const bindings = manifestBindings();
    const crossAccount = {
      ...bindings,
      target: { ...bindings.target, accountId: "2".repeat(32) },
    };
    assert.throws(
      () => prepareCloudflareDisposableDeploymentProvider({
        manifestBindings: crossAccount,
        executionPins: fixture.executionPins,
        phase: "target",
        keychainBinding: PROVIDER_K0_BINDING,
        keychainProof: PROVIDER_K0_PROOF,
      }, {
        platform: "darwin",
        fetchImpl: async () => { touched = true; },
        loadToken: () => { touched = true; },
        createTransport: () => { touched = true; },
      }),
      (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
        error.code === "CF_DISPOSABLE_PROVIDER_BINDING_INVALID",
    );
    assert.equal(touched, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provider stops before the next operation when K0 revalidation changes", async () => {
  const fixture = moduleFixture();
  const driftBinding = Object.freeze({
    candidate_sha: "3".repeat(40),
    candidate_tree_sha: "4".repeat(40),
    package_sha256: digest("drift-package"),
    field_receipt_sha256: digest("drift-field-receipt"),
    account_id: SOURCE_ACCOUNT,
  });
  const driftK0 = await createTestDisposableRecoveryK0Capability(driftBinding);
  const calls = [];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings("source"),
      executionPins: fixture.executionPins,
      phase: "source",
      keychainBinding: driftBinding,
      keychainProof: driftK0.proof,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport("source", calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context(
        "source",
        "source_preflight",
        requests,
        driftK0.proof.keychain_binding_sha256,
        driftBinding,
      ),
    );
    const [locator] = driftK0.keychain.values.keys();
    driftK0.keychain.values.get(locator)?.fill(0);
    driftK0.keychain.values.set(locator, null);
    await assert.rejects(
      provider.readSnapshot({
        schema_version: 2,
        protocol: "v048-fixture",
        operation: "read_snapshot",
        phase: "source",
        stage: "source_preflight",
        read_ordinal: 1,
        campaign_fingerprint: HASH,
        expected: null,
      }),
      (error) => error instanceof CloudflareDisposableDeploymentProviderError &&
        error.code === "CF_DISPOSABLE_PROVIDER_KEYCHAIN_CAPABILITY_INVALID",
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provider pins modules and wires only the account-bound Keychain resolver", async () => {
  const fixture = moduleFixture();
  const resolverRecords = [];
  const transportRecords = [];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings("source"),
      executionPins: fixture.executionPins,
      phase: "source",
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => { throw new Error("unused"); },
      loadToken(accountId, options) {
        resolverRecords.push({ accountId, options });
        return Buffer.from("synthetic-provider-token-value", "utf8");
      },
      createTransport(options) {
        transportRecords.push(options);
        return fakeTransport("source", []);
      },
    });
    assert.match(prepared.moduleInventorySha256, /^[a-f0-9]{64}$/u);
    const provider = await prepared.createProvider(() => true,
      context("source", "source_preflight", requestPlan(prepared.moduleInventorySha256)));
    assert.equal(transportRecords.length, 1);
    const token = await transportRecords[0].resolveToken();
    try {
      assert.equal(resolverRecords[0].accountId, SOURCE_ACCOUNT);
      assert.deepEqual(resolverRecords[0].options, { platform: "darwin" });
      assert.equal(JSON.stringify(prepared).includes(token.toString("utf8")), false);
    } finally {
      token.fill(0);
    }
    assert.deepEqual(Object.keys(provider).sort(), [
      "deployVersion", "readSnapshot", "uploadVersion",
    ]);

    writeFileSync(fixture.executionPins[0].path, "changed\n");
    assert.throws(
      () => prepareCloudflareDisposableDeploymentProvider({
        manifestBindings: manifestBindings("source"), executionPins: fixture.executionPins,
        phase: "source",
        keychainBinding: PROVIDER_K0_BINDING,
        keychainProof: PROVIDER_K0_PROOF,
      }, {
        platform: "darwin", fetchImpl: async () => {},
        loadToken: () => Buffer.alloc(32), createTransport: () => ({}),
      }),
      /CF_DISPOSABLE_PROVIDER_MODULE_INVENTORY_CHANGED/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("provider preflight uses current discovery plus exact deployment GET and keeps phases split", async () => {
  const fixture = moduleFixture();
  const calls = [];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings("source"), executionPins: fixture.executionPins,
      phase: "source",
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport("source", calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context("source", "source_preflight", requests),
    );
    const snapshot = await provider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "source",
      stage: "source_preflight",
      read_ordinal: 1,
      campaign_fingerprint: HASH,
      expected: null,
    });
    assert.deepEqual(calls.slice(0, 4).map(({ method }) => method), [
      "readCurrentDeployment", "readDeployment", "readVersion", "readResourceContract",
    ]);
    assert.equal(calls[1].input.deployment_id, SOURCE_DEPLOYMENT);
    assert.equal(snapshot.semantic.source.baseline_deployment_id, SOURCE_DEPLOYMENT);
    assert.equal(JSON.stringify(snapshot).includes(SOURCE_ACCOUNT), false);

    const uploaded = await provider.uploadVersion(requests.source_active_upload, {
      source: { baseline_version_id: SOURCE_VERSION },
    });
    assert.equal(uploaded.version_id, NEW_VERSION);
    const upload = calls.find(({ method }) => method === "uploadVersion").input;
    assert.deepEqual(upload.secret_names, [
      "ADMIN_KEY", "RAG_PROXY_KEY", "SESSION_SIGNING_KEY",
    ]);
    assert.equal(upload.modules.some(({ name }) => name === "index.js"), true);
    assert.equal(upload.bindings.some(({ name }) => name === "VECTOR_DRAIN_MODE"), false);
    assert.equal(upload.bindings.some(({ name }) => name === "DB"), true);
    assert.equal(Object.hasOwn(upload, "token"), false);

    const deployed = await provider.deployVersion(
      requests.source_active_deployment,
      NEW_VERSION,
      {},
    );
    assert.equal(deployed.deployment_id, NEW_DEPLOYMENT);
    assert.equal(calls.at(-1).role, "source");

    const finalProvider = await prepared.createProvider(
      () => true,
      context("source", "source_phase", requests),
    );
    const final = await finalProvider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "source",
      stage: "source_final",
      read_ordinal: 2,
      campaign_fingerprint: HASH,
      expected: {
        active_deployment_id: SOURCE_DEPLOYMENT,
        active_version_id: SOURCE_VERSION,
      },
    });
    assert.equal(final.semantic.source.active_deployment.deployment_id,
      SOURCE_DEPLOYMENT);
    assert.equal(calls.filter(({ method, input }) =>
      method === "readDeployment" && input.deployment_id === SOURCE_DEPLOYMENT).length,
    2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("target provider inherits only the reviewed target secrets and deploys paused only", async () => {
  const fixture = moduleFixture();
  const calls = [];
  const roles = ["source", "target"];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings(), executionPins: fixture.executionPins,
      phase: "target",
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport(roles.shift(), calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context("target", "target_phase", requests),
    );
    await provider.uploadVersion(requests.target_paused_upload, {
      target: { baseline_version_id: TARGET_VERSION },
    });
    await provider.uploadVersion(requests.target_active_upload, {
      target: { baseline_version_id: TARGET_VERSION },
    });
    await provider.deployVersion(requests.target_paused_deployment, NEW_VERSION, {});
    const uploads = calls.filter(({ method }) => method === "uploadVersion");
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads.map(({ role }) => role), ["target", "target"]);
    assert.deepEqual(uploads[0].input.secret_names, [
      "ADMIN_KEY", "BANK_FEED_WRAPPING_KEY_V2", "RAG_PROXY_KEY",
      "SESSION_SIGNING_KEY",
    ]);
    assert.equal(uploads[0].input.bindings.some(({ name, text }) =>
      name === "VECTOR_DRAIN_MODE" && text === "paused-for-upgrade"), true);
    assert.equal(uploads[1].input.bindings.some(({ name }) =>
      name === "VECTOR_DRAIN_MODE"), false);
    assert.equal(calls.at(-1).role, "target");
    assert.equal(calls.at(-1).method, "deployVersion");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("target preflight binds aggregate campaign custody and quiescence into the semantic snapshot", async () => {
  const fixture = moduleFixture();
  const calls = [];
  const roles = ["source", "target"];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings(), executionPins: fixture.executionPins,
      phase: "target",
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => fakeTransport(roles.shift(), calls),
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const providerContext = context("target", "target_preflight", requests);
    const provider = await prepared.createProvider(() => true, providerContext);
    const snapshot = await provider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "target",
      stage: "target_preflight",
      read_ordinal: 1,
      campaign_fingerprint: HASH,
      expected: null,
    });

    const custody = calls.find(({ method }) => method === "readCampaignCustody");
    assert.ok(custody);
    assert.equal(custody.role, "target");
    assert.equal(custody.input.account_id, SOURCE_ACCOUNT);
    assert.equal(custody.input.expected_workers.source.deployment_id,
      SOURCE_DEPLOYMENT);
    assert.equal(custody.input.expected_workers.target.deployment_id,
      TARGET_DEPLOYMENT);
    assert.equal(custody.input.expected_workers.source
      .reviewed_worker_generation_sha256, digest("reviewed-generation:source"));
    assert.deepEqual(snapshot.semantic.vectorize_mutation_quiescence,
      providerContext.vectorize_mutation_quiescence);
    const expectedCustody = custodyProof();
    assert.equal(snapshot.semantic.campaign_custody.proof_sha256,
      expectedCustody.proof_sha256);
    assert.equal(snapshot.semantic.source.worker_generation.worker_generation_sha256,
      expectedCustody.generation_authority.source.worker_generation_sha256);
    assert.equal(snapshot.semantic.target.worker_generation.worker_generation_sha256,
      expectedCustody.generation_authority.target.worker_generation_sha256);
    assert.equal(Object.hasOwn(snapshot.semantic.campaign_custody, "responses"), false);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(SOURCE_ACCOUNT, "u"));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("target preflight refuses a custody worker identity mismatch", async () => {
  const fixture = moduleFixture();
  const roles = ["source", "target"];
  try {
    const prepared = prepareCloudflareDisposableDeploymentProvider({
      manifestBindings: manifestBindings(), executionPins: fixture.executionPins,
      phase: "target",
      keychainBinding: PROVIDER_K0_BINDING,
      keychainProof: PROVIDER_K0_PROOF,
    }, {
      platform: "darwin",
      fetchImpl: async () => {},
      loadToken: () => Buffer.alloc(32, 1),
      createTransport: () => {
        const role = roles.shift();
        const transport = fakeTransport(role, []);
        if (role === "target") {
          transport.readCampaignCustody = async () => {
            const proof = custodyProof();
            proof.roles.source.worker_protection.worker_identity_sha256 =
              digest("wrong-source-worker-identity");
            return proof;
          };
        }
        return transport;
      },
    });
    const requests = requestPlan(prepared.moduleInventorySha256);
    const provider = await prepared.createProvider(
      () => true,
      context("target", "target_preflight", requests),
    );
    await assert.rejects(provider.readSnapshot({
      schema_version: 2,
      protocol: "v048-fixture",
      operation: "read_snapshot",
      phase: "target",
      stage: "target_preflight",
      read_ordinal: 1,
      campaign_fingerprint: HASH,
      expected: null,
    }), (error) => error?.code ===
      "CF_DISPOSABLE_PROVIDER_CAMPAIGN_CUSTODY_UNVERIFIED");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
