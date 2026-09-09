import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CloudflareRecoveryAdapterError,
  RECOVERY_DURABLE_TABLES,
  RECOVERY_EXPORT_TABLES,
  RECOVERY_FIELD_GATE_STOP_STAGES,
  createCloudflareRecoveryFieldGateAdapters,
  normalizedInstallStateExport,
  parseCloudflareRecoveryCliArguments,
  previewCloudflareRecoveryFieldGate,
  runCloudflareRecoveryFieldGate,
  verifyRecoverySqlArtifact,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  initializeVerifiedRecovery,
  loadVerifiedRecoveryState,
} from "../operations/verified-recovery.mjs";
import { withDecryptedRecoveryArtifact } from "../operations/recovery-artifact-crypto.mjs";
import { ZOOM_CREDENTIAL_ENV } from "../connectors/zoom.mjs";
import Worker from "../worker/src/index.js";
import { BANK_ACCESS_WRAPPING_KEY_SECRET, encryptAccessReference } from "../worker/src/lib/bank-feed.js";

const sandbox = mkdtempSync(join(tmpdir(), "brain-cloudflare-recovery-adapter-"));
if (process.platform !== "win32") chmodSync(sandbox, 0o700);

// Schema 34's source inventory is durable schema, but its rows are a derived
// projection rebuilt from authoritative live documents during restore.
assert.equal(RECOVERY_DURABLE_TABLES.includes("document_source_inventory"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("document_source_inventory"), false);
assert.equal(RECOVERY_DURABLE_TABLES.includes("plaid_sync_leases"), true);
assert.equal(RECOVERY_EXPORT_TABLES.includes("plaid_sync_leases"), true);

const sourceManifestPath = join(sandbox, "source.manifest.json");
const targetManifestPath = join(sandbox, "target.manifest.json");
const planPath = join(sandbox, ".brain-recovery-plan.json");
const statePath = join(sandbox, ".brain-recovery-state.json");
const artifactDirectory = join(sandbox, "private-artifacts");
const wrapperPath = join(sandbox, "wrangler-owner-wrapper");
const goldenPath = join(sandbox, "brain.golden.json");
const privateSentinel = "fixture-private-question-and-provider-output";
const fixtureAdminKey = "fixture-private-admin-key-value";
const fixtureRecoveryArtifactKey = `v1.${Buffer.alloc(32, 19).toString("base64url")}`;
const wrapperScript = "#!/bin/sh\nexec wrangler \"$@\"\n";
const sourceWorkerVersionId = "fixture-source-version-id";
const pausedWorkerVersionId = "fixture-paused-version-id";
const activeWorkerVersionId = "fixture-active-version-id";
const workerScriptEtag = "a".repeat(64);
const sourceWorkerScriptEtag = "b".repeat(64);

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
      active_worker_version_id: activeWorkerVersionId,
      worker_script_etag: workerScriptEtag,
      routes: [],
      custom_domains: [],
      reviewed_at: "2026-08-25T11:55:00.000Z",
    },
  },
};

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
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
});
const normalizedInstallStateSql =
  `INSERT INTO "install_state" (${installStateColumns.map(([name]) => `"${name}"`).join(",")}) VALUES (` +
  `1,'fixture-brain','0.1.12',13,4,'2026-08-25T12:00:00.000Z',NULL,'stable',NULL,0,NULL,NULL,NULL,NULL,'bootstrap_required',1,NULL,'fixture:chunk#0004',NULL,0,5,NULL);\n`;
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

function snapshotForChunkCount(chunkCount) {
  const aggregate = {
    ...aggregateTemplate,
    chunks: String(chunkCount),
    chunks_fts: String(chunkCount),
    chunks_id_max: String(chunkCount),
    chunks_text_bytes: String(chunkCount * 100),
  };
  return Object.freeze({
    ...expectedSnapshot,
    aggregate_fingerprint: hash(canonical(aggregate)),
    chunk_count: chunkCount,
    fts_count: chunkCount,
  });
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
  activeScriptEtag = workerScriptEtag,
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
  failBootstrapOnce = false,
  failBootstrapAfterProgressOnce = false,
  failPromotionAfterApplyOnce = false,
  healthModeOverride = null,
  healthProtocolOverride = null,
  healthTransform = (health) => health,
  initialAgentActionReceipts = 0,
  initialTargetRestored = false,
  initialVectorCount = 0,
  missingVectorCount = false,
  pausedVersionMode = "paused-for-upgrade",
  pausedScriptEtag = workerScriptEtag,
  promotionNoop = false,
  readinessLagAfterBootstrap = false,
  recoveryArtifactKey = fixtureRecoveryArtifactKey,
  sourceDrainLease = false,
  sourceWrappingSecret = false,
  partialZoomSecretGroup = false,
  zoomSecretGroup = false,
  // Current-protocol installs report whatever the newest real migration is,
  // so a new additive migration never breaks these fixtures (found 13 -> 14).
  sourceMigrationVersion = appliedMigrations.at(-1).version,
  targetChunkCount = 5,
  targetMigrationVersion = appliedMigrations.at(-1).version,
  sourceInstallStateMissing = false,
  splitTargetDeployment = false,
  targetVersionId = pausedWorkerVersionId,
} = {}) {
  let agentActionReceipts = initialAgentActionReceipts;
  let targetRestored = initialTargetRestored;
  let vectorCount = initialVectorCount;
  let outbox = 0;
  let bootstrapRequired = initialTargetRestored && initialVectorCount < targetChunkCount;
  let bootstrapEpoch = 1;
  let bootstrapCursor = null;
  let bootstrapConfirmed = initialVectorCount;
  let currentTargetVersionId = targetVersionId;
  let corpusMutated = false;
  let evalCalls = 0;
  let adminReads = 0;
  let importCalls = 0;
  let bootstrapFailuresRemaining = failBootstrapOnce ? 1 : 0;
  let postProgressBootstrapFailuresRemaining = failBootstrapAfterProgressOnce ? 1 : 0;
  let bootstrapBusyRemaining = bootstrapBusyOnce ? 1 : 0;
  let readinessLagRemaining = readinessLagAfterBootstrap ? 1 : 0;
  let promotionFailuresRemaining = failPromotionAfterApplyOnce ? 1 : 0;
  let bootstrapCalls = 0;
  let promotionCalls = 0;
  let sleepCalls = 0;
  let normalizedLeaseSelections = 0;
  const wranglerCalls = [];
  const fetchCalls = [];
  const sensitiveBuffers = [];

  const bindingForAccount = (accountId) => accountId === sourceManifest.infrastructure.cloudflare.account_id
    ? sourceManifest.infrastructure.cloudflare
    : targetManifest.infrastructure.cloudflare;

  const runWrangler = async ({ command, args, env, cwd }) => {
    wranglerCalls.push({ command, args: [...args], env: { ...env }, cwd });
    assert.equal(Object.hasOwn(env, "CLOUDFLARE_API_TOKEN"), false);
    assert.equal(Object.hasOwn(env, "ADMIN_KEY"), false);
    assert.equal(Object.keys(env).some((name) => /SUPABASE|ANTHROPIC/.test(name)), false);
    assert.equal(env.WRANGLER_LOG_SANITIZE, "true");
    assert.equal(env.WRANGLER_LOG, "log");
    assert.equal(env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id ||
      env.CLOUDFLARE_ACCOUNT_ID === targetManifest.infrastructure.cloudflare.account_id, true);
    writeFileSync(join(env.WRANGLER_LOG_PATH, "fixture.log"), "aggregate-only fixture log\n", { mode: 0o600 });

    const ok = (payload = "") => {
      const stdout = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
      const stderr = Buffer.from(privateSentinel);
      sensitiveBuffers.push(stderr);
      return { status: 0, stdout, stderr };
    };
    if (args[0] === "--version") return ok("4.99.0\n");
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
      return ok(ambiguousSourceD1 && env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id
        ? [row, { ...row }]
        : [row]);
    }
    if (args[0] === "vectorize" && args[1] === "list") {
      return ok([{ name: cloudflare.vectorize_index, config: { dimensions: 768, metric: "cosine" } }]);
    }
    if (args[0] === "vectorize" && args[1] === "info") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      return ok({
        dimensions: 768,
        ...(!isSource && missingVectorCount
          ? {}
          : { vectorCount: isSource ? 5 : vectorCount }),
      });
    }
    if (args[0] === "deployments" && args[1] === "status") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      if (!isSource && splitTargetDeployment) {
        return ok({ versions: [
          { version_id: pausedWorkerVersionId, percentage: 50 },
          { version_id: activeWorkerVersionId, percentage: 50 },
        ] });
      }
      return ok({ versions: [{
        version_id: isSource ? sourceWorkerVersionId : currentTargetVersionId,
        percentage: 100,
      }] });
    }
    if (args[0] === "versions" && args[1] === "view") {
      const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
      const manifest = isSource ? sourceManifest : targetManifest;
      const requestedVersionId = args[2];
      const targetMode = requestedVersionId === pausedWorkerVersionId
        ? pausedVersionMode
        : requestedVersionId === activeWorkerVersionId
          ? activeVersionMode
          : null;
      const scriptEtag = isSource
        ? sourceWorkerScriptEtag
        : requestedVersionId === pausedWorkerVersionId
          ? pausedScriptEtag
          : activeScriptEtag;
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
            { type: "plain_text", name: "BRAIN_OWNER", text: manifest.client.display_name },
            { type: "plain_text", name: "BRAIN_VERSION", text: manifest.brain.version },
            { type: "plain_text", name: "CHUNK_SIZE", text: "1500" },
            { type: "plain_text", name: "CHUNK_OVERLAP", text: "300" },
            { type: "plain_text", name: "DAILY_LLM_CAP_USD", text: "10" },
            {
              type: "plain_text",
              name: "ANSWER_MODEL",
              text: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
            },
            { type: "plain_text", name: "CREDENTIAL_SCANNER", text: "on" },
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
        "versions", "deploy", `${activeWorkerVersionId}@100%`,
        "--name", targetManifest.brain.worker_name, "-y",
      ]);
      assert.equal(env.CLOUDFLARE_ACCOUNT_ID, targetManifest.infrastructure.cloudflare.account_id);
      promotionCalls++;
      if (!promotionNoop) currentTargetVersionId = activeWorkerVersionId;
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
      assert.deepEqual(exportedTables, RECOVERY_EXPORT_TABLES.filter((table) => includesBank || table !== "bank_feed_items"));
      assert.equal(exportedTables.includes("vector_outbox"), false);
      assert.equal(exportedTables.includes("vector_bootstrap_batches"), false);
      assert.equal(exportedTables.includes("install_state"), false);
      assert.equal(exportedTables.includes("document_source_inventory"), false);
      assert.equal(exportedTables.includes("agent_action_receipts"), false);
      writeFileSync(
        output,
        `${includesBank && bankFixture ? bankFixture.exportData() : deterministicDataExport}${corpusMutated ? "\n-- synthetic corpus mutation\n" : ""}`,
        { mode: 0o600 },
      );
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--file")) {
      const importPath = args[args.indexOf("--file") + 1];
      assert.match(importPath, /\.brain-recovery-plaintext\.tmp-[0-9a-f]+$/);
      assert.equal(readFileSync(importPath, "utf8").includes("CREATE TABLE"), true);
      importCalls++;
      targetRestored = true;
      bootstrapRequired = true;
      bootstrapConfirmed = 0;
      vectorCount = 0;
      return ok();
    }
    if (args[0] === "d1" && args[1] === "execute" && args.includes("--command")) {
      const sql = args[args.indexOf("--command") + 1];
      let rows;
      if (/user_table_count/.test(sql)) {
        rows = [{ user_table_count: targetRestored ? RECOVERY_DURABLE_TABLES.length + 1 : 0 }];
      } else if (/pending_outbox/.test(sql)) {
        rows = [{ pending_outbox: outbox, failed_vectors: 0 }];
      } else if (/COUNT\(\*\) AS agent_action_receipts FROM agent_action_receipts/.test(sql)) {
        rows = [{ agent_action_receipts: agentActionReceipts }];
      } else if (/integrity-check/.test(sql)) {
        rows = [];
      } else if (/PRAGMA quick_check/.test(sql)) {
        rows = [{ quick_check: "ok" }];
      } else if (/SELECT version,name,checksum/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
        const latest = isSource ? sourceMigrationVersion : targetMigrationVersion;
        rows = appliedMigrations.filter((row) => row.version <= latest);
      } else if (/PRAGMA table_info\(install_state\)/.test(sql)) {
        rows = installStateColumns.map(([name, type], cid) => ({ cid, name, type }));
      } else if (/^SELECT[\s\S]+FROM install_state ORDER BY id$/.test(sql)) {
        const isSource = env.CLOUDFLARE_ACCOUNT_ID === sourceManifest.infrastructure.cloudflare.account_id;
        assert.match(sql, /NULL AS "vector_drain_lease_owner"/);
        assert.match(sql, /NULL AS "vector_drain_lease_expires_at"/);
        assert.match(sql, /0 AS "outbox_generation"/);
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
        }];
      } else if (/SELECT name FROM sqlite_schema/.test(sql)) {
        rows = [...RECOVERY_DURABLE_TABLES].sort().map((name) => ({ name }));
      } else if (/SELECT type,name,tbl_name/.test(sql)) {
        rows = schemaRows;
      } else if (/documents_ingested_max/.test(sql)) {
        assert.match(
          sql,
          /CAST\(\(SELECT 0\) AS TEXT\) AS "vector_bootstrap_batches"/,
        );
        const aggregate = env.CLOUDFLARE_ACCOUNT_ID === targetManifest.infrastructure.cloudflare.account_id &&
            targetRestored
          ? {
              ...aggregateTemplate,
              chunks: String(targetChunkCount),
              chunks_fts: String(targetChunkCount),
              chunks_id_max: String(targetChunkCount),
              chunks_text_bytes: String(targetChunkCount * 100),
              ...(corpusMutated
                ? { chunks_text_bytes: String(targetChunkCount * 100 + 1) }
                : {}),
            }
          : aggregateTemplate;
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
      const mode = currentTargetVersionId === pausedWorkerVersionId ? "paused-for-upgrade" : "active";
      const healthResponse = await Worker.fetch(new Request(String(url)), {
        BRAIN_NAME: "fixture-brain", BRAIN_VERSION: "0.1.12",
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
      health.version = "0.1.12";
      return response(healthTransform({
        ...health,
        vector_drain_mode: healthModeOverride ?? health.vector_drain_mode,
        vector_writer_protocol: healthProtocolOverride ?? health.vector_writer_protocol,
      }));
    }
    if (path === "/api/admin/brain/bootstrap") {
      assert.equal(options.headers["X-Admin-Key"], fixtureAdminKey);
      assert.equal(currentTargetVersionId, pausedWorkerVersionId);
      assert.equal(options.body, undefined);
      bootstrapCalls++;
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
      if (bootstrapRequired && bootstrapConfirmed < targetChunkCount) {
        bootstrapConfirmed = Math.min(
          targetChunkCount,
          bootstrapConfirmed + bootstrapPageSize,
        );
        vectorCount = bootstrapConfirmed;
        bootstrapCursor = `fixture:chunk#${String(Math.max(0, bootstrapConfirmed - 1)).padStart(8, "0")}`;
      }
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
      const isSource = parsedUrl.hostname === sourceManifest.brain.domain;
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
        return expectedSnapshot;
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
    get sensitiveBuffers() { return sensitiveBuffers; },
    get normalizedLeaseSelections() { return normalizedLeaseSelections; },
    get bootstrapEpoch() { return bootstrapEpoch; },
    get bootstrapCursor() { return bootstrapCursor; },
    get sourceLeaseMarker() { return sourceDrainLease ? "fixture-live-drain-owner" : null; },
    mutateNonBank() { corpusMutated = true; },
  };
}

try {
  const recoveryFieldGateSchema = JSON.parse(
    readFileSync(join(process.cwd(), "manifest.schema.json"), "utf8"),
  ).properties.operations.properties.recovery_field_gate;
  assert.deepEqual(recoveryFieldGateSchema.required, [
    "paused_worker_version_id", "active_worker_version_id", "worker_script_etag",
    "routes", "custom_domains", "reviewed_at",
  ]);
  assert.equal(recoveryFieldGateSchema.additionalProperties, false);

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

  const stageContext = (stage, completed = [], attempt = 1) => ({ stage, attempt,
    planFingerprint: initialized.plan.plan_fingerprint,
    targetResourceFingerprint: initialized.plan.target_resource_fingerprint, completed });
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

  const prefixSourceHarness = providerHarness({ sourceMigrationVersion: 12 });
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
    activeScriptEtag: "c".repeat(64),
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
  // assuming the historical checkpoint has the schema-13 writer protocol.
  const prefixTargetHarness = providerHarness({
    initialTargetRestored: true,
    targetMigrationVersion: 12,
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
    const largeCorpus =
      "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<6000) " +
      "INSERT INTO documents (doc_uid,source,source_id,ingested_at,content_hash) " +
      "SELECT 'doc-'||x,'fixture','source-'||x,1700000000000,'hash-'||x FROM n;";
    const sql = `${schemaSql}\n${receipts}\n${largeCorpus}\n`;
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
