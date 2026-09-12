import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { cloudflareOAuthInstallIdentity } from "../brain.mjs";
import { cloudflareOAuthProfileName } from "../operations/cloudflare-oauth-session.mjs";
import {
  buildFieldGates,
  FULL_FIELD_PREPARATION_STEPS,
} from "../scripts/field-prepare.mjs";
import {
  BASELINE_SQL,
  EXECUTION_CONFIRMATION,
  MIGRATION_LEDGER_SQL,
  RESIDUE_SHAPE_SQL,
  SYNTHETIC_DISPLAY_NAME,
  UPGRADE_SUMMARY_SQL,
  acceleratedUpdatePlan,
  assertNoAmbientProviderCredential,
  createInstalledCloudflareProvider,
  createLifecycleEnvironment,
  deriveInstalledAuthProfile,
  executeAcceleratedUpdateFieldGate,
  finalizeReservedAggregateReceipt,
  inspectFieldPreparation,
  installCandidateArtifact,
  normalizeCompleteWorkerRecords,
  normalizeZoneRoutes,
  parseAcceleratedUpdateArgs,
  prepareAcceleratedUpdateFieldGate,
  readInstalledContract,
  removeCandidateRuntime,
  reserveAggregateReceipt,
  syntheticSeedReceipt,
  validateAccountWorkersDevSubdomain,
  validateActiveWorkerBindings,
  validateSeededState,
  validateSyntheticProvisionedManifest,
  validateSyntheticSeedReceipt,
} from "./live/accelerated-update-field-gate.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const HARNESS = join(ROOT, "test", "live", "accelerated-update-field-gate.mjs");
const PACKAGE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const COMMIT = "a".repeat(40);
const TREE = "b".repeat(40);
const ACCOUNT = "c".repeat(32);
const D1_ID = "11111111-1111-4111-8111-111111111111";
const SLUG = "synthetic-accelerated-update-a1b2c3";
const WORKER = `${SLUG}-brain`;
const INDEX = WORKER;
const DOMAIN = `${WORKER}.fixture.workers.dev`;
const PROFILE = `financial-brain-${"d".repeat(24)}`;
const ADMIN_SENTINEL = "admin-credential-never-record";
const PRIVATE_SENTINEL = "private-customer-value-never-record";
const TOKEN_SENTINEL = "ambient-token-never-forward";
const CONTRACT = readInstalledContract(ROOT);

function privateWrite(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function expectedProfile(manifestPath) {
  return cloudflareOAuthProfileName(cloudflareOAuthInstallIdentity(manifestPath));
}

function syntheticManifest(manifestPath = null) {
  return {
    $schema: "manifest.schema.json",
    manifest_version: 1,
    client: {
      slug: SLUG,
      display_name: SYNTHETIC_DISPLAY_NAME,
      timezone: "UTC",
    },
    brain: {
      version: "0.4.6",
      worker_name: WORKER,
      domain: DOMAIN,
    },
    infrastructure: {
      cloudflare: {
        account_id: ACCOUNT,
        auth_profile: manifestPath ? expectedProfile(manifestPath) : PROFILE,
        storage: "d1",
        d1_database_name: WORKER,
        d1_database_id: D1_ID,
        vectorize_index: INDEX,
        drain_cron: "* * * * *",
      },
    },
    corpora: {},
    operations: {
      admin_key_secret: `keychain://${SLUG}-brain-admin/owner-synthetic`,
    },
    field_gate: {
      schema_version: 2,
      purpose: "accelerated_lifecycle_update",
      data_class: "fictional_synthetic_only",
      target_management: "externally_provisioned_operator_managed",
      dedicated_resources: true,
      cleanup_required: true,
    },
  };
}

function commonArgs(directory) {
  return [
    "--manifest", join(directory, "brain.manifest.json"),
    "--package", join(directory, `brain-installer-${PACKAGE_VERSION}.tgz`),
    "--field-receipt", join(directory, "field-prepare-receipt.json"),
    "--target-account", ACCOUNT,
    "--target-worker", WORKER,
    "--target-d1", D1_ID,
    "--target-vector-index", INDEX,
    "--target-domain", DOMAIN,
    "--cleanup-owner", "Field gate operator",
    "--plan-receipt", join(directory, "plan.json"),
    "--seed-receipt", join(directory, "seed.json"),
    "--receipt", join(directory, "result.json"),
  ];
}

function optionsFor(directory, mode, approval = null) {
  return parseAcceleratedUpdateArgs([
    `--${mode}`,
    ...commonArgs(directory),
    ...(mode === "execute" ? ["--confirm", EXECUTION_CONFIRMATION, "--approve-plan", approval] : []),
  ]);
}

function fieldReceipt(packagePath) {
  const bytes = readFileSync(packagePath);
  const receipt = {
    schema_version: 1,
    run_id: "99999999-9999-4999-8999-999999999999",
    generated_at: "2026-09-11T11:59:00.000Z",
    completed_at: "2026-09-11T12:00:00.000Z",
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
      wrangler_package: "wrangler@4.127.1",
      wrangler_resolution: "locked_local_dev_dependency",
    },
    source: {
      head_sha: COMMIT,
      tree_sha: TREE,
      package_name: "brain-installer",
      package_version: PACKAGE_VERSION,
      package_alignment: {
        aligned: true,
        package_lock_name: "brain-installer",
        package_lock_version: PACKAGE_VERSION,
        package_lock_root_name: "brain-installer",
        package_lock_root_version: PACKAGE_VERSION,
      },
      package_json_sha256: "e".repeat(64),
      package_lock_sha256: "f".repeat(64),
      working_tree_clean: true,
      shallow_repository: false,
      diff_check_clean: true,
      identity_stable_during_check: true,
      end_clean: true,
    },
    package: {
      filename: basename(packagePath),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      file_count: 200,
    },
    steps: FULL_FIELD_PREPARATION_STEPS.map((step) => ({
      ...step,
      status: "passed",
      duration_ms: 1,
      exit_code: null,
      failure_code: null,
    })),
    human_field_gates: buildFieldGates().map(({ id }) => ({
      id,
      status: "pending_human_proof",
    })),
  };
  bytes.fill(0);
  return receipt;
}

function setupFixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-accelerated-gate-test-")));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  const manifestPath = join(directory, "brain.manifest.json");
  const packagePath = join(directory, `brain-installer-${PACKAGE_VERSION}.tgz`);
  const fieldReceiptPath = join(directory, "field-prepare-receipt.json");
  privateWrite(manifestPath, `${JSON.stringify(syntheticManifest(manifestPath), null, 2)}\n`);
  privateWrite(packagePath, "synthetic packed candidate fixture");
  privateWrite(fieldReceiptPath, `${JSON.stringify(fieldReceipt(packagePath), null, 2)}\n`);
  return { directory, manifestPath, packagePath, fieldReceiptPath };
}

function pin(path) {
  const info = lstatSync(path);
  const raw = readFileSync(path);
  const hash = createHash("sha256").update(raw).digest("hex");
  raw.fill(0);
  return { path: realpathSync(path), info, hash };
}

function inspectedField(fixture) {
  const packagePin = pin(fixture.packagePath);
  const receiptPin = pin(fixture.fieldReceiptPath);
  return {
    candidate: {
      commit: COMMIT,
      tree: TREE,
      name: "brain-installer",
      version: PACKAGE_VERSION,
      packageJsonSha256: "e".repeat(64),
      packageLockSha256: "f".repeat(64),
      archiveSha256: packagePin.hash,
      archiveBytes: packagePin.info.size,
      fileCount: 200,
    },
    packagePin,
    receiptPin,
  };
}

function runtimeFor(field) {
  const runtimeRoot = "/synthetic/private-runtime";
  return {
    runtimeRoot,
    runtimeInfo: { dev: 1, ino: 2 },
    environment: createLifecycleEnvironment({ PATH: process.env.PATH || "/usr/bin:/bin" }, runtimeRoot),
    prefix: `${runtimeRoot}/prefix`,
    packageRoot: `${runtimeRoot}/prefix/lib/node_modules/brain-installer`,
    cliPath: `${runtimeRoot}/prefix/bin/brain`,
    candidate: field.candidate,
    contract: CONTRACT,
  };
}

function baselineSnapshot() {
  return {
    install_rows: 1,
    client_slug: SLUG,
    product_version: "0.4.6",
    schema_version: CONTRACT.residueSchema,
    status: "verified",
    protocol: "bootstrap-v2",
    epoch: 7,
    base_count: 10,
    residue_epoch: null,
    lease_present: 0,
    documents: 10,
    chunks: 10,
    outbox: 0,
    batches: 0,
    unfinished_batches: 0,
    retry_rows: 0,
    event_count: 0,
    event_max_id: 0,
    bad_upgrade_runs: 0,
  };
}

function seededSnapshot() {
  return {
    ...baselineSnapshot(),
    status: "pending",
    documents: 10 + CONTRACT.triggerRows,
    chunks: 10 + CONTRACT.triggerRows,
    outbox: CONTRACT.triggerRows,
  };
}

function postSnapshot() {
  return {
    ...seededSnapshot(),
    product_version: PACKAGE_VERSION,
    schema_version: CONTRACT.terminalSchema,
    status: "verified",
    epoch: 9,
    base_count: 10 + CONTRACT.triggerRows,
    residue_epoch: 8,
    outbox: 0,
    batches: 2,
    event_count: 1,
    event_max_id: 1,
  };
}

function finalSnapshot() {
  return {
    ...postSnapshot(),
    documents: postSnapshot().documents + 1,
    chunks: postSnapshot().chunks + 1,
    base_count: postSnapshot().base_count + 1,
  };
}

function health(version) {
  return {
    status: 200,
    headers: new Headers(),
    body: {
      ok: true,
      status: "ok",
      accepting_documents: true,
      version,
      vector_writer_protocol: "lease-v1",
      vector_drain_mode: "active",
    },
  };
}

function workerVersionFixture(binding, version, id = "11111111-1111-1111-1111-111111111111") {
  const plain = (name, text) => ({ type: "plain_text", name, text });
  return {
    id,
    resources: {
      bindings: [
        { type: "d1", name: "DB", id: binding.databaseId },
        { type: "ai", name: "AI" },
        { type: "vectorize", name: "VECTORIZE", index_name: binding.vectorIndex },
        plain("STORAGE", "d1"),
        plain("BRAIN_NAME", binding.slug),
        plain("BRAIN_OWNER", binding.displayName),
        plain("BRAIN_VERSION", version),
        plain("CHUNK_SIZE", "1500"),
        plain("CHUNK_OVERLAP", "300"),
        plain("DAILY_LLM_CAP_USD", "10"),
        plain("ANSWER_MODEL", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
        plain("CREDENTIAL_SCANNER", "on"),
        plain("OCR_ENABLED", "0"),
        plain("OCR_MODEL", "@cf/google/gemma-4-26b-a4b-it"),
        { type: "secret_text", name: "ADMIN_KEY" },
        { type: "secret_text", name: "RAG_PROXY_KEY" },
        { type: "secret_text", name: "SESSION_SIGNING_KEY" },
      ],
      script: { etag: "1".repeat(64) },
      script_runtime: { compatibility_date: "2026-01-01", usage_model: "standard" },
    },
  };
}

function statefulProvider(state) {
  const vectorCount = () => state.phase === "baseline" || state.phase === "seeded"
    ? 10 : state.phase === "post" ? postSnapshot().chunks : finalSnapshot().chunks;
  const control = () => ({
    databaseId: D1_ID,
    databaseName: WORKER,
    vectorInfo: { name: INDEX, vectorCount: vectorCount(), dimensions: 768, metric: "cosine" },
    workersDevEnabled: true,
    workersDevDomainFingerprint: "3".repeat(64),
    workerBindingFingerprint: state.phase === "baseline" || state.phase === "seeded"
      ? "4".repeat(64) : "5".repeat(64),
    schedules: state.phase === "baseline" || state.phase === "seeded" ? [] : ["* * * * *"],
    routes: 0,
    customDomains: 0,
    activeVersionId: state.phase === "baseline" || state.phase === "seeded"
      ? "11111111-1111-1111-1111-111111111111"
      : "22222222-2222-2222-2222-222222222222",
    scriptEtag: state.phase === "baseline" || state.phase === "seeded" ? "1".repeat(64) : "2".repeat(64),
  });
  return {
    async withSession(action) {
      state.sessions += 1;
      return action(this);
    },
    async inspectControl(expectedVersion) {
      state.calls.push("control");
      assert.equal(
        expectedVersion,
        state.phase === "baseline" || state.phase === "seeded" ? "0.4.6" : PACKAGE_VERSION,
      );
      return control();
    },
    async vectorInfo() {
      state.calls.push("vector");
      return control().vectorInfo;
    },
    async health() {
      state.calls.push("health");
      return health(state.phase === "baseline" || state.phase === "seeded" ? "0.4.6" : PACKAGE_VERSION);
    },
    async d1Rows(sql) {
      state.calls.push(sql);
      if (sql === BASELINE_SQL) {
        const snapshot = state.phase === "baseline" ? baselineSnapshot()
          : state.phase === "seeded" ? seededSnapshot()
            : state.phase === "post" ? postSnapshot() : finalSnapshot();
        return [{ ...snapshot, client_slug: state.clientSlug || snapshot.client_slug }];
      }
      if (sql === UPGRADE_SUMMARY_SQL) {
        return [state.phase === "baseline" || state.phase === "seeded"
          ? { total: 2, max_id: 2 }
          : { total: 3, max_id: 3 }];
      }
      if (sql === RESIDUE_SHAPE_SQL) {
        return [{
          total: CONTRACT.triggerRows,
          upserts: CONTRACT.triggerRows,
          deletes: 0,
          submitted: 0,
          legacy_failed: 0,
          pageable: CONTRACT.triggerRows,
          quarantined: 0,
          orphan_upserts: 0,
        }];
      }
      if (sql === MIGRATION_LEDGER_SQL) return CONTRACT.migrations.map((entry) => ({ ...entry }));
      if (sql.startsWith("SELECT id,at,kind,epoch_before")) {
        return [{
          id: 1,
          at: 1,
          kind: "residue-reprojection",
          epoch_before: 7,
          epoch_after: 8,
          base_before: 10,
          base_after: 10,
          rows: CONTRACT.triggerRows,
          chunks: 10 + CONTRACT.triggerRows,
        }];
      }
      if (sql.startsWith("SELECT count(*) batches")) {
        return [{
          batches: 2,
          confirmed: 2,
          unfinished: 0,
          rows: CONTRACT.triggerRows,
          first_batch: 1,
          last_batch: 2,
          bad_full_pages: 0,
          last_rows: 1,
        }];
      }
      if (sql.startsWith("SELECT id,from_version")) {
        return [{
          id: 3,
          from_version: "0.4.6",
          to_version: PACKAGE_VERSION,
          status: "verified",
          started_present: 1,
          finished_present: 1,
          bookmark_present: 1,
          detail_absent: 1,
        }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async ingest(adminKey, docs) {
      state.calls.push("ingest");
      assert.equal(adminKey, ADMIN_SENTINEL);
      assert.equal(docs.length, 1);
      assert.equal(docs[0].source_type, "accelerated_field_gate");
      state.canaryTitle = docs[0].title;
      return {
        status: 200,
        headers: new Headers(),
        body: {
          total: 1, created: 1, updated: 0, unchanged: 0, refused: 0, failed: 0,
          results: [{ status: "created", chunks: 1, source_id: PRIVATE_SENTINEL }],
        },
      };
    },
    async drain(adminKey) {
      state.calls.push("drain");
      assert.equal(adminKey, ADMIN_SENTINEL);
      state.phase = "final";
      return {
        status: 200,
        headers: new Headers(),
        body: {
          drained: 1,
          submitted: 0,
          waiting: 0,
          remaining: 0,
          vector_ready: true,
          expected_vectors: finalSnapshot().chunks,
          actual_vectors: finalSnapshot().chunks,
        },
      };
    },
    async unified(adminKey, body) {
      state.calls.push("unified");
      assert.equal(adminKey, ADMIN_SENTINEL);
      assert.equal(body.source, "accelerated_field_gate");
      assert.equal(body.rerank, 0);
      return {
        status: 200,
        headers: new Headers({ "Cache-Control": "private, no-store" }),
        body: {
          ...(state.omitDegraded ? {} : { degraded: null }),
          results: [{ title: state.canaryTitle, content: PRIVATE_SENTINEL }],
        },
      };
    },
  };
}

function dependenciesFor(fixture, state, updateBehavior = null) {
  const field = inspectedField(fixture);
  const runtime = runtimeFor(field);
  return {
    environment: { PATH: process.env.PATH || "/usr/bin:/bin" },
    inspectFieldPreparation(packagePath, receiptPath) {
      assert.equal(packagePath, fixture.packagePath);
      assert.equal(receiptPath, fixture.fieldReceiptPath);
      return field;
    },
    installCandidateArtifact(received) {
      assert.equal(received, field);
      return runtime;
    },
    deriveInstalledAuthProfile(receivedRuntime, manifestPath) {
      assert.equal(receivedRuntime, runtime);
      assert.equal(manifestPath, fixture.manifestPath);
      return expectedProfile(manifestPath);
    },
    removeCandidateRuntime(received) {
      assert.equal(received, runtime);
    },
    createProvider(receivedRuntime, binding, { revalidate }) {
      assert.equal(receivedRuntime, runtime);
      assert.equal(binding.accountId, ACCOUNT);
      assert.equal(revalidate(), true);
      return statefulProvider(state);
    },
    readAdminKey(locator, environment) {
      assert.equal(locator.service, `${SLUG}-brain-admin`);
      assert.equal(locator.account, "owner-synthetic");
      assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
      return ADMIN_SENTINEL;
    },
    randomHex: () => "1234567890abcdef12345678",
    wait: async () => {},
    now: () => "2026-09-11T12:00:00.000Z",
    updateSpawn(command, args, options) {
      state.updateCalls += 1;
      assert.equal(command, runtime.cliPath);
      assert.deepEqual(args, ["update", fixture.manifestPath]);
      assert.equal(options.cwd, runtime.runtimeRoot);
      assert.equal(options.env.HOME, `${runtime.runtimeRoot}/home`);
      assert.equal(options.env.CODEX_HOME, `${runtime.runtimeRoot}/codex`);
      assert.equal(options.env.CLAUDE_CONFIG_DIR, `${runtime.runtimeRoot}/claude`);
      assert.equal(options.env.BRAIN_NO_WRANGLER_LOGIN, "1");
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(options.env.NODE_OPTIONS, undefined);
      if (updateBehavior) return updateBehavior(fixture, state);
      const updated = syntheticManifest(fixture.manifestPath);
      updated.brain.version = PACKAGE_VERSION;
      privateWrite(fixture.manifestPath, `${JSON.stringify(updated, null, 2)}\n`);
      state.phase = "post";
      return {
        status: 0,
        stdout: Buffer.from(`older database writers have finished; starting database migration\n${PRIVATE_SENTINEL}\n`),
        stderr: Buffer.from(ADMIN_SENTINEL),
      };
    },
  };
}

test("plan mode is inert and phase parsing binds every explicit provisioned target", () => {
  assert.deepEqual(parseAcceleratedUpdateArgs(["--plan"]), { mode: "plan" });
  const plan = acceleratedUpdatePlan();
  assert.equal(plan.mode, "plan_only");
  assert.equal(plan.command_entrypoint, "installed brain update");
  assert.equal(plan.creates_resources, false);
  assert.equal(plan.deletes_resources, false);
  assert.equal(plan.retries_update, false);
  assert.equal(plan.allowed_mutations.installed_brain_update_invocations, 1);
  assert.equal(plan.allowed_mutations.post_update_canary_drain_max_calls, 12);
  assert.equal(plan.forbidden_mutations.includes("direct residue bootstrap or residue drain"), true);
  assert.equal(plan.reads_manifest, false);
  const absolute = resolve("/tmp", "synthetic-accelerated-plan-test");
  const args = [
    "--prepare",
    "--manifest", `${absolute}.manifest.json`,
    "--package", `${absolute}.tgz`,
    "--field-receipt", `${absolute}.field.json`,
    "--target-account", ACCOUNT,
    "--target-worker", WORKER,
    "--target-d1", D1_ID,
    "--target-vector-index", INDEX,
    "--target-domain", DOMAIN,
    "--cleanup-owner", "Field gate operator",
    "--plan-receipt", `${absolute}.plan.json`,
    "--seed-receipt", `${absolute}.seed.json`,
    "--receipt", `${absolute}.result.json`,
  ];
  const parsed = parseAcceleratedUpdateArgs(args);
  assert.equal(parsed.mode, "prepare");
  assert.equal(parsed.targetAccount, ACCOUNT);
  assert.equal(parsed.targetDomain, DOMAIN);
  for (const invalid of [
    [],
    ["--plan", ...args.slice(1)],
    args.filter((value, index) => index < args.indexOf("--target-d1") || index > args.indexOf("--target-d1") + 1),
    [...args, "--confirm", EXECUTION_CONFIRMATION],
    [...args, "--live"],
  ]) assert.throws(() => parseAcceleratedUpdateArgs(invalid));
  assert.throws(() => parseAcceleratedUpdateArgs([
    "--execute", ...args.slice(1), "--confirm", "wrong", "--approve-plan", "a".repeat(64),
  ]), /exact_synthetic_confirmation_required/);
});

test("the CLI plan reads no manifest, credential store, or ambient private values", () => {
  const result = spawnSync(process.execPath, [HARNESS, "--plan"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: `/missing/${PRIVATE_SENTINEL}`,
      CLOUDFLARE_API_TOKEN: TOKEN_SENTINEL,
      CUSTOMER_MANIFEST: `/missing/${PRIVATE_SENTINEL}.json`,
      NODE_OPTIONS: "",
    },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stderr, "");
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.mode, "plan_only");
  assert.equal(plan.reads_manifest, false);
  assert.equal(plan.reads_credential_store, false);
  assert.doesNotMatch(result.stdout, new RegExp(`${PRIVATE_SENTINEL}|${TOKEN_SENTINEL}`));
});

test("the lifecycle environment isolates all mutable homes and ambient credentials are refused", () => {
  const root = "/private/synthetic-runtime";
  const environment = createLifecycleEnvironment({
    PATH: "/fixture/bin",
    HOME: "/owner/home",
    APPDATA: "/owner/appdata",
    CLOUDFLARE_API_TOKEN: TOKEN_SENTINEL,
    CF_API_TOKEN: TOKEN_SENTINEL,
    ADMIN_KEY: ADMIN_SENTINEL,
    NODE_OPTIONS: `--import=${PRIVATE_SENTINEL}`,
  }, root);
  assert.equal(environment.HOME, `${root}/home`);
  assert.equal(environment.USERPROFILE, `${root}/home`);
  assert.equal(environment.APPDATA, `${root}/appdata/roaming`);
  assert.equal(environment.LOCALAPPDATA, `${root}/appdata/local`);
  assert.equal(environment.XDG_CONFIG_HOME, `${root}/xdg/config`);
  assert.equal(environment.XDG_DATA_HOME, `${root}/xdg/data`);
  assert.equal(environment.XDG_STATE_HOME, `${root}/xdg/state`);
  assert.equal(environment.XDG_CACHE_HOME, `${root}/xdg/cache`);
  assert.equal(environment.CODEX_HOME, `${root}/codex`);
  assert.equal(environment.CLAUDE_CONFIG_DIR, `${root}/claude`);
  assert.equal(environment.TMPDIR, `${root}/tmp`);
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(environment.BRAIN_NO_WRANGLER_LOGIN, "1");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(environment.CF_API_TOKEN, undefined);
  assert.equal(environment.ADMIN_KEY, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.doesNotMatch(JSON.stringify(environment), new RegExp(`${PRIVATE_SENTINEL}|${TOKEN_SENTINEL}|${ADMIN_SENTINEL}`));
  assert.equal(assertNoAmbientProviderCredential({ PATH: "/bin" }), true);
  assert.throws(
    () => assertNoAmbientProviderCredential({ CLOUDFLARE_API_TOKEN: TOKEN_SENTINEL }),
    /ambient_cloudflare_credential_refused/,
  );
});

test("control-plane list proof refuses incomplete pagination or a different Worker", () => {
  const empty = normalizeCompleteWorkerRecords({
    result: [],
    resultInfo: { page: 1, count: 0, total_count: 0, total_pages: 0 },
  }, WORKER, "control_list_invalid");
  assert.deepEqual(empty, []);
  assert.throws(() => normalizeCompleteWorkerRecords({
    result: [],
    resultInfo: { page: 1, count: 0, total_count: 1, total_pages: 1 },
  }, WORKER, "control_list_invalid"), /control_list_invalid/);
  assert.throws(() => normalizeCompleteWorkerRecords({
    result: [],
    resultInfo: { page: 1, count: 0, total_count: 0, total_pages: 2 },
  }, WORKER, "control_list_invalid"), /control_list_invalid/);
  assert.throws(() => normalizeCompleteWorkerRecords({
    result: [{ service: "different-worker" }],
    resultInfo: null,
  }, WORKER, "control_list_invalid"), /control_list_invalid/);
  assert.throws(() => normalizeCompleteWorkerRecords({
    result: Array.from({ length: 100 }, () => ({})),
    resultInfo: null,
  }, WORKER, "control_list_invalid"), /control_list_invalid/);
  assert.equal(normalizeZoneRoutes({
    result: [
      { pattern: "other.example/*", script: "other-worker" },
      { pattern: "detached.example/*", script: null },
    ],
    resultInfo: null,
  }, WORKER), 0);
  assert.throws(
    () => normalizeZoneRoutes({ result: { records: [] }, resultInfo: null }, WORKER),
    /cloudflare_zone_routes_refused/,
  );
});

test("active Worker bindings join the exact D1, Vectorize, synthetic vars, and secret-name set", () => {
  const binding = validateSyntheticProvisionedManifest(syntheticManifest(), {
    targetAccount: ACCOUNT,
    targetWorker: WORKER,
    targetD1: D1_ID,
    targetVectorIndex: INDEX,
    targetDomain: DOMAIN,
  }, PACKAGE_VERSION);
  const activeId = "11111111-1111-1111-1111-111111111111";
  const version = workerVersionFixture(binding, "0.4.6", activeId);
  assert.match(validateActiveWorkerBindings(version, binding, "0.4.6", activeId), /^[a-f0-9]{64}$/);

  const d1 = version.resources.bindings.find((entry) => entry.name === "DB");
  delete d1.id;
  d1.database_id = D1_ID;
  assert.match(validateActiveWorkerBindings(version, binding, "0.4.6", activeId), /^[a-f0-9]{64}$/);
  d1.id = D1_ID;
  assert.match(validateActiveWorkerBindings(version, binding, "0.4.6", activeId), /^[a-f0-9]{64}$/);

  const mismatches = [
    (copy) => { copy.resources.bindings.find((entry) => entry.name === "DB").database_id = "2".repeat(32); },
    (copy) => {
      const entry = copy.resources.bindings.find((candidate) => candidate.name === "DB");
      delete entry.id;
      delete entry.database_id;
    },
    (copy) => { copy.resources.bindings.find((entry) => entry.name === "AI").type = "plain_text"; },
    (copy) => { copy.resources.bindings.find((entry) => entry.name === "VECTORIZE").index_name = "other-index"; },
    (copy) => { copy.resources.bindings.find((entry) => entry.name === "BRAIN_NAME").text = "other-brain"; },
    (copy) => { copy.resources.bindings.find((entry) => entry.name === "BRAIN_VERSION").text = PACKAGE_VERSION; },
    (copy) => { copy.resources.bindings.push({ type: "secret_text", name: "BANK_FEED_SECRET" }); },
  ];
  for (const mutate of mismatches) {
    const copy = structuredClone(version);
    mutate(copy);
    assert.throws(
      () => validateActiveWorkerBindings(copy, binding, "0.4.6", activeId),
      /cloudflare_worker_bindings_refused/,
    );
  }
});

test("the account workers.dev subdomain must produce the exact manifest hostname", () => {
  const binding = validateSyntheticProvisionedManifest(syntheticManifest(), {
    targetAccount: ACCOUNT,
    targetWorker: WORKER,
    targetD1: D1_ID,
    targetVectorIndex: INDEX,
    targetDomain: DOMAIN,
  }, PACKAGE_VERSION);
  assert.match(
    validateAccountWorkersDevSubdomain({ subdomain: "fixture" }, binding),
    /^[a-f0-9]{64}$/,
  );
  assert.throws(
    () => validateAccountWorkersDevSubdomain({ subdomain: "different-account" }, binding),
    /cloudflare_account_subdomain_refused/,
  );
});

test("the installed provider uses complete official zone-route and account-domain inventories", async () => {
  const binding = validateSyntheticProvisionedManifest(syntheticManifest(), {
    targetAccount: ACCOUNT,
    targetWorker: WORKER,
    targetD1: D1_ID,
    targetVectorIndex: INDEX,
    targetDomain: DOMAIN,
  }, PACKAGE_VERSION);
  const activeId = "11111111-1111-1111-1111-111111111111";
  const zoneId = "e".repeat(32);
  const oauthModule = {
    async withCloudflareOAuthSession(options) {
      const token = Buffer.from("synthetic-oauth-fixture");
      try {
        return await options.action({
          profile: binding.authProfile,
          account: { id: binding.accountId, name: "Synthetic" },
          token,
        });
      } finally {
        token.fill(0);
      }
    },
  };
  const makeFetch = ({ omitZonePageInfo = false, routeStatus = 200 } = {}) => {
    const calls = [];
    const fetchImpl = async (url, options) => {
      const path = `${url.pathname}${url.search}`;
      calls.push(path);
      assert.equal(options.headers.Authorization, "Bearer synthetic-oauth-fixture");
      let result;
      let resultInfo;
      let status = 200;
      if (path === `/client/v4/accounts/${ACCOUNT}/d1/database/${D1_ID}`) {
        result = { uuid: D1_ID, name: WORKER };
      } else if (path === `/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX}`) {
        result = { name: INDEX, vector_count: 10, config: { dimensions: 768, metric: "cosine" } };
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/subdomain`) {
        result = { subdomain: "fixture" };
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/subdomain`) {
        result = { enabled: true };
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/schedules`) {
        result = [];
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/deployments`) {
        result = { deployments: [{ versions: [{ percentage: 100, version_id: activeId }] }] };
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}/versions/${activeId}`) {
        result = workerVersionFixture(binding, "0.4.6", activeId);
      } else if (path === `/client/v4/zones?account.id=${ACCOUNT}&page=1&per_page=50`) {
        result = [{ id: zoneId, account: { id: ACCOUNT } }];
        if (!omitZonePageInfo) {
          resultInfo = { page: 1, count: 1, total_count: 1, total_pages: 1 };
        }
      } else if (path === `/client/v4/zones/${zoneId}/workers/routes`) {
        result = [];
        status = routeStatus;
      } else if (path === `/client/v4/accounts/${ACCOUNT}/workers/domains?service=${WORKER}&page=1&per_page=100`) {
        result = [];
        resultInfo = { page: 1, count: 0, total_count: 0, total_pages: 0 };
      } else {
        assert.fail(`unexpected Cloudflare fixture endpoint: ${path}`);
      }
      return new Response(JSON.stringify({
        success: status >= 200 && status < 300,
        errors: status >= 200 && status < 300 ? [] : [{ code: 10000 }],
        result,
        ...(resultInfo ? { result_info: resultInfo } : {}),
      }), { status, headers: { "Content-Type": "application/json" } });
    };
    return { calls, fetchImpl };
  };
  const runtime = {
    packageRoot: "/synthetic/installed-package",
    runtimeRoot: "/synthetic/runtime",
    environment: { PATH: "/usr/bin:/bin" },
  };

  const complete = makeFetch();
  const provider = await createInstalledCloudflareProvider(runtime, binding, {
    fetchImpl: complete.fetchImpl,
    oauthModule,
  });
  const control = await provider.withSession((active) => active.inspectControl("0.4.6"));
  assert.equal(control.routes, 0);
  assert.equal(control.customDomains, 0);
  assert.equal(complete.calls.includes(`/client/v4/zones/${zoneId}/workers/routes`), true);
  assert.equal(complete.calls.some((path) => path.includes("/workers/scripts/") && path.endsWith("/routes")), false);
  assert.equal(complete.calls.some((path) => path.includes("/workers/domains/records")), false);

  for (const fixture of [makeFetch({ omitZonePageInfo: true }), makeFetch({ routeStatus: 403 })]) {
    const refusing = await createInstalledCloudflareProvider(runtime, binding, {
      fetchImpl: fixture.fetchImpl,
      oauthModule,
    });
    await assert.rejects(
      () => refusing.withSession((active) => active.inspectControl("0.4.6")),
      /cloudflare_(?:zone_inventory|request)_refused/,
    );
  }
});

test("field preparation receipt binds exact full artifact bytes and refuses partial or public files", () => {
  const fixture = setupFixture();
  try {
    const inspected = inspectFieldPreparation(fixture.packagePath, fixture.fieldReceiptPath);
    assert.equal(inspected.candidate.commit, COMMIT);
    assert.equal(inspected.candidate.version, PACKAGE_VERSION);
    assert.equal(inspected.candidate.archiveSha256, pin(fixture.packagePath).hash);
    const partial = fieldReceipt(fixture.packagePath);
    partial.status = "partial_source_preparation";
    privateWrite(fixture.fieldReceiptPath, `${JSON.stringify(partial)}\n`);
    assert.throws(
      () => inspectFieldPreparation(fixture.packagePath, fixture.fieldReceiptPath),
      /field_prepare_receipt_incomplete/,
    );
    privateWrite(fixture.fieldReceiptPath, `${JSON.stringify(fieldReceipt(fixture.packagePath))}\n`);
    if (process.platform !== "win32") chmodSync(fixture.packagePath, 0o644);
    assert.throws(
      () => inspectFieldPreparation(fixture.packagePath, fixture.fieldReceiptPath),
      /candidate_archive_refused/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("prepare refuses missing, duplicate, unknown, or reordered full receipt steps before any mutation", async () => {
  const variants = [
    (receipt) => { receipt.steps.pop(); },
    (receipt) => { receipt.steps[1] = structuredClone(receipt.steps[0]); },
    (receipt) => { receipt.steps.at(-1).id = "forged-field-step"; },
    (receipt) => { [receipt.steps[0], receipt.steps[1]] = [receipt.steps[1], receipt.steps[0]]; },
  ];
  for (const mutate of variants) {
    const fixture = setupFixture();
    let installs = 0;
    let providerSessions = 0;
    try {
      const receipt = fieldReceipt(fixture.packagePath);
      mutate(receipt);
      privateWrite(fixture.fieldReceiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
      await assert.rejects(
        () => prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), {
          environment: { PATH: process.env.PATH || "/usr/bin:/bin" },
          installCandidateArtifact() {
            installs += 1;
            throw new Error("invalid_receipt_must_not_install");
          },
          createProvider() {
            providerSessions += 1;
            throw new Error("invalid_receipt_must_not_contact_provider");
          },
        }),
        /field_prepare_receipt_(?:incomplete|invalid)/,
      );
      assert.equal(installs, 0);
      assert.equal(providerSessions, 0);
      assert.equal(existsSync(join(fixture.directory, "plan.json")), false);
      assert.equal(existsSync(join(fixture.directory, "result.json")), false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("the installed package derives current migration and accelerated constants without pinning schema 41", () => {
  const migrationVersions = readdirSync(join(ROOT, "migrations", "d1"))
    .filter((name) => name.endsWith(".sql"))
    .map((name) => Number(name.slice(0, 4)));
  assert.equal(CONTRACT.terminalSchema, Math.max(...migrationVersions));
  assert.equal(CONTRACT.residueSchema, 36);
  assert.equal(CONTRACT.triggerRows, 1001);
  assert.equal(CONTRACT.pageSize, 1000);
  assert.equal(CONTRACT.window, 3);
  assert.equal(CONTRACT.ingestBatchMax, 50);
  assert.equal(CONTRACT.seedCalls, 21);
  const fakeRead = (path) => {
    if (String(path).endsWith("store-d1.js")) return `
      const DRAIN_BATCH_SIZE_MAX = 10;
      export const RESIDUE_REPROJECTION_MIN_ROWS = 10 * DRAIN_BATCH_SIZE_MAX;
      export const RESIDUE_REPROJECTION_SCHEMA = 1;
      export const ACCELERATED_BOOTSTRAP_PAGE_SIZE = 100;
      export const ACCELERATED_BOOTSTRAP_WINDOW = 2;
    `;
    if (String(path).endsWith("index.js")) return "const BATCH_MAX_DOCS = 25;";
    return "CREATE TABLE synthetic(value TEXT);";
  };
  const derived = readInstalledContract("/fixture", fakeRead, () => ["0001_vector_projection_events.sql"]);
  assert.equal(derived.terminalSchema, 1);
  assert.equal(derived.triggerRows, 101);
  assert.equal(derived.pageSize, 100);
  assert.equal(derived.seedCalls, 5);
  assert.throws(
    () => readInstalledContract("/fixture", fakeRead, () => ["0001_vector_projection_events.sql", "0003_gap.sql"]),
    /installed_migration_sequence_not_contiguous/,
  );
});

test("the exact archive can be installed offline and the installed brain wrapper/version is used", { timeout: 120_000 }, async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-accelerated-pack-test-")));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  try {
    const packed = spawnSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: directory },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(packed.status, 0, packed.stderr);
    const metadata = JSON.parse(packed.stdout)[0];
    const packagePath = realpathSync(join(directory, metadata.filename));
    if (process.platform !== "win32") chmodSync(packagePath, 0o600);
    const receiptPath = join(directory, "field.json");
    privateWrite(receiptPath, "{}\n");
    const packagePin = pin(packagePath);
    const field = {
      candidate: {
        commit: COMMIT,
        tree: TREE,
        name: "brain-installer",
        version: PACKAGE_VERSION,
        archiveSha256: packagePin.hash,
        archiveBytes: packagePin.info.size,
        fileCount: metadata.files.length,
      },
      packagePin,
      receiptPin: pin(receiptPath),
    };
    const runtime = installCandidateArtifact(field, { PATH: process.env.PATH || "/usr/bin:/bin" });
    try {
      assert.match(runtime.cliPath, /\/prefix\/bin\/brain$/);
      assert.equal(runtime.candidate.archiveSha256, packagePin.hash);
      assert.equal(runtime.contract.terminalSchema, CONTRACT.terminalSchema);
      assert.equal(runtime.contract.triggerRows, 1001);
      assert.equal(runtime.environment.HOME.startsWith(runtime.runtimeRoot), true);
      assert.equal(runtime.environment.NPM_CONFIG_OFFLINE, undefined);
      const manifestPath = join(directory, "profile-identity.manifest.json");
      assert.equal(
        await deriveInstalledAuthProfile(runtime, manifestPath),
        expectedProfile(manifestPath),
      );
    } finally {
      removeCandidateRuntime(runtime);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a post-install candidate mismatch removes the isolated runtime before refusing", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const dependencies = dependenciesFor(fixture, state);
  const install = dependencies.installCandidateArtifact;
  let removed = 0;
  dependencies.installCandidateArtifact = (field) => {
    const runtime = install(field);
    return { ...runtime, candidate: { ...runtime.candidate, version: "9.9.9" } };
  };
  dependencies.removeCandidateRuntime = () => { removed += 1; };
  try {
    await assert.rejects(
      () => prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies),
      /installed_candidate_binding_changed/,
    );
    assert.equal(removed, 1);
    assert.equal(state.sessions, 0);
    assert.equal(state.updateCalls, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("only the dedicated connector-free synthetic manifest and exact target tuple pass", () => {
  const targets = {
    targetAccount: ACCOUNT,
    targetWorker: WORKER,
    targetD1: D1_ID,
    targetVectorIndex: INDEX,
    targetDomain: DOMAIN,
  };
  const valid = validateSyntheticProvisionedManifest(syntheticManifest(), targets, PACKAGE_VERSION);
  assert.equal(valid.fromVersion, "0.4.6");
  assert.equal(valid.toVersion, PACKAGE_VERSION);
  assert.equal(valid.adminLocator.service, `${SLUG}-brain-admin`);
  const cases = [
    (copy) => { copy.client.display_name = "Ordinary customer"; },
    (copy) => { copy.client.primary_contact = "private@example.test"; },
    (copy) => { copy.corpora.gmail = { enabled: false }; },
    (copy) => { copy.testing = { probe_questions: [PRIVATE_SENTINEL] }; },
    (copy) => { copy.operations.admin_key_secret = ADMIN_SENTINEL; },
    (copy) => { copy.operations.admin_key_secret = "keychain://ordinary-brain-admin/owner-private"; },
    (copy) => { copy.brain.domain = "brain.customer.example"; },
    (copy) => { copy.brain.version = PACKAGE_VERSION; },
    (copy) => { copy.field_gate.data_class = "private"; },
    (copy) => { copy.field_gate.dedicated_resources = false; },
    (copy) => { copy.infrastructure.supabase = { enabled: true }; },
  ];
  for (const mutate of cases) {
    const copy = structuredClone(syntheticManifest());
    mutate(copy);
    assert.throws(() => validateSyntheticProvisionedManifest(copy, targets, PACKAGE_VERSION));
  }
  for (const changed of [
    { targetAccount: "0".repeat(32) },
    { targetWorker: "synthetic-accelerated-update-other-brain" },
    { targetD1: "22222222-2222-4222-8222-222222222222" },
    { targetVectorIndex: "synthetic-accelerated-update-other-brain" },
    { targetDomain: `${WORKER}.other.workers.dev` },
  ]) assert.throws(() => validateSyntheticProvisionedManifest(syntheticManifest(), { ...targets, ...changed }, PACKAGE_VERSION));
});

test("a valid-looking OAuth profile for a different manifest path is refused before provider access", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  try {
    const manifest = syntheticManifest(fixture.manifestPath);
    manifest.infrastructure.cloudflare.auth_profile = expectedProfile(join(fixture.directory, "other-brain.manifest.json"));
    assert.match(manifest.infrastructure.cloudflare.auth_profile, /^financial-brain-[a-f0-9]{24}$/);
    assert.notEqual(manifest.infrastructure.cloudflare.auth_profile, expectedProfile(fixture.manifestPath));
    privateWrite(fixture.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(
      () => prepareAcceleratedUpdateFieldGate(
        optionsFor(fixture.directory, "prepare"),
        dependenciesFor(fixture, state),
      ),
      /named_cloudflare_profile_manifest_mismatch/,
    );
    assert.equal(state.sessions, 0);
    assert.equal(state.updateCalls, 0);
    assert.equal(existsSync(join(fixture.directory, "plan.json")), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the threshold is strictly above 1000 and exact-1000 residue fails closed", () => {
  const baseline = baselineSnapshot();
  const binding = validateSyntheticProvisionedManifest(syntheticManifest(), {
    targetAccount: ACCOUNT,
    targetWorker: WORKER,
    targetD1: D1_ID,
    targetVectorIndex: INDEX,
    targetDomain: DOMAIN,
  }, PACKAGE_VERSION);
  const residue = {
    total: CONTRACT.triggerRows,
    upserts: CONTRACT.triggerRows,
    deletes: 0,
    submitted: 0,
    legacy_failed: 0,
    pageable: CONTRACT.triggerRows,
    quarantined: 0,
    orphan_upserts: 0,
  };
  const vector = { vectorCount: baseline.chunks, dimensions: 768, metric: "cosine" };
  assert.equal(validateSeededState(seededSnapshot(), residue, vector, baseline, binding, CONTRACT), true);
  const exactThreshold = { ...seededSnapshot(), documents: baseline.documents + 1000, chunks: baseline.chunks + 1000, outbox: 1000 };
  assert.throws(
    () => validateSeededState(exactThreshold, { ...residue, total: 1000, upserts: 1000, pageable: 1000 }, vector, baseline, binding, CONTRACT),
    /deterministic_seeded_residue_state_required/,
  );
});

test("seed receipts accept only the exact aggregate contract and reject identifiers or content", () => {
  const plan = {
    status: "ready_for_external_synthetic_seed",
    plan_fingerprint: "a".repeat(64),
    seed_receipt_contract: {
      documents_requested: CONTRACT.triggerRows,
      chunks: CONTRACT.triggerRows,
      batch_calls: CONTRACT.seedCalls,
      max_batch_size: CONTRACT.ingestBatchMax,
    },
  };
  const receipt = syntheticSeedReceipt(plan);
  assert.equal(validateSyntheticSeedReceipt(receipt, plan, CONTRACT), true);
  assert.throws(
    () => validateSyntheticSeedReceipt({ ...receipt, source_ids: [PRIVATE_SENTINEL] }, plan, CONTRACT),
    /seed_receipt_contains_nonaggregate_fields/,
  );
  assert.throws(
    () => validateSyntheticSeedReceipt({ ...receipt, created: 1000 }, plan, CONTRACT),
    /seed_receipt_invalid/,
  );
});

test("prepare refuses a logically different D1 client before authorizing any seed or update", async () => {
  const fixture = setupFixture();
  const state = {
    phase: "baseline",
    clientSlug: "synthetic-accelerated-update-wrong99",
    sessions: 0,
    updateCalls: 0,
    calls: [],
    canaryTitle: null,
  };
  try {
    await assert.rejects(
      () => prepareAcceleratedUpdateFieldGate(
        optionsFor(fixture.directory, "prepare"),
        dependenciesFor(fixture, state),
      ),
      /clean_residue_predecessor_baseline_required/,
    );
    assert.equal(state.updateCalls, 0);
    assert.equal(state.calls.includes("ingest"), false);
    assert.equal(existsSync(join(fixture.directory, "plan.json")), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a late final-receipt collision refuses before provider access or update", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const dependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies);
    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const sessionsBeforeExecute = state.sessions;
    dependencies.reserveReceipt = (output, marker) => {
      privateWrite(output.path, "{\"late_collision\":true}\n");
      return reserveAggregateReceipt(output, marker);
    };
    await assert.rejects(
      () => executeAcceleratedUpdateFieldGate(
        optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
        dependencies,
      ),
      /receipt_reservation_collision/,
    );
    assert.equal(state.sessions, sessionsBeforeExecute);
    assert.equal(state.updateCalls, 0);
    assert.equal(state.calls.includes("ingest"), false);
    assert.equal(existsSync(join(fixture.directory, ".accelerated-update-field-gate.lock")), false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("receipt finalization refuses a replaced result path or parent inode", () => {
  for (const replace of ["path", "parent"]) {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-receipt-reservation-test-")));
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    const moved = `${directory}-moved`;
    const output = {
      path: join(directory, "result.json"),
      parent: { path: directory, info: lstatSync(directory) },
    };
    const reservation = reserveAggregateReceipt(output, {
      schema_version: 1,
      status: "conservative_marker",
    });
    try {
      if (replace === "path") {
        renameSync(output.path, join(directory, "original-marker.json"));
        privateWrite(output.path, "{\"replacement\":true}\n");
      } else {
        renameSync(directory, moved);
        mkdirSync(directory, { mode: 0o700 });
        if (process.platform !== "win32") chmodSync(directory, 0o700);
      }
      assert.throws(
        () => finalizeReservedAggregateReceipt(reservation, { status: "must_not_commit" }),
        /receipt_reservation_changed/,
      );
    } finally {
      try { closeSync(reservation.descriptor); } catch { /* Already closed only on unexpected success. */ }
      reservation.closed = true;
      rmSync(directory, { recursive: true, force: true });
      rmSync(moved, { recursive: true, force: true });
    }
  }
});

test("prepare binds the clean live baseline and execute proves one durable update plus canary", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const dependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies);
    assert.equal(prepared.status, "ready_for_external_synthetic_seed");
    assert.match(prepared.plan_fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(prepared.contract.terminal_schema, CONTRACT.terminalSchema);
    assert.equal(prepared.contract.trigger_rows, 1001);
    assert.equal(prepared.control.zero_schedules, true);
    assert.equal(prepared.safeguards.update_executed, false);
    assert.equal(statSync(join(fixture.directory, "plan.json")).mode & 0o777, 0o600);

    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const result = await executeAcceleratedUpdateFieldGate(
      optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
      dependencies,
    );
    assert.equal(result.status, "passed_cleanup_required");
    assert.equal(state.updateCalls, 1);
    assert.equal(result.lifecycle.invocation_count, 1);
    assert.equal(result.lifecycle.paused_residue_event_count, 1);
    assert.equal(result.lifecycle.residue_rows, 1001);
    assert.equal(result.lifecycle.residue_batches, 2);
    assert.equal(result.lifecycle.migration_ledger_matches, true);
    assert.equal(result.lifecycle.verified_upgrade_runs_added, 1);
    assert.equal(result.safeguards.writer_quiescence_proven_by_installed_cli, true);
    assert.equal(Number.isSafeInteger(result.timings.total_ms), true);
    assert.equal(Number.isSafeInteger(result.timings.update_ms), true);
    assert.equal(Number.isSafeInteger(result.timings.canary_ms), true);
    assert.equal(result.projection.post_canary_chunks, finalSnapshot().chunks);
    assert.equal(result.projection.d1_vectorize_parity, true);
    assert.equal(result.canary.retrieved, true);
    assert.equal(result.mutations.direct_residue_drain_calls, 0);
    assert.equal(result.mutations.post_update_canary_ingest_calls, 1);
    assert.equal(result.mutations.post_update_canary_drain_calls, result.canary.drain_calls);
    assert.equal(result.mutations.post_update_canary_drain_calls, 1);
    assert.equal(result.mutations.post_update_canary_retrieval_calls, 1);
    assert.equal(result.control.declared_schedules_restored, 1);
    assert.equal(result.cleanup.verified, false);
    assert.equal(statSync(join(fixture.directory, "result.json")).mode & 0o777, 0o600);
    assert.equal(existsSync(join(fixture.directory, ".accelerated-update-field-gate.lock")), false);

    const persisted = readFileSync(join(fixture.directory, "result.json"), "utf8");
    assert.deepEqual(JSON.parse(persisted), result);
    assert.doesNotMatch(persisted, new RegExp([
      PRIVATE_SENTINEL,
      ADMIN_SENTINEL,
      TOKEN_SENTINEL,
      SLUG,
      WORKER,
      D1_ID,
      ACCOUNT,
      "workers\\.dev",
      "keychain",
      fixture.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ].join("|")));
    assert.equal(state.calls.some((call) => String(call).includes("vector_projection_events WHERE id>0")), true);
    assert.equal(state.calls.some((call) => String(call).includes("row_count<>1000")), true);
    assert.equal(state.calls.includes(MIGRATION_LEDGER_SQL), true);
    const upgradeDetailQuery = state.calls.find((call) =>
      String(call).startsWith("SELECT id,from_version,to_version,status,"));
    assert.match(upgradeDetailQuery, /started_at IS NOT NULL/);
    assert.match(upgradeDetailQuery, /finished_at IS NOT NULL/);
    assert.match(upgradeDetailQuery, /d1_bookmark IS NOT NULL/);
    assert.match(upgradeDetailQuery, /detail IS NULL/);
    assert.doesNotMatch(upgradeDetailQuery, /worker_version/);
    const cliSource = readFileSync(join(ROOT, "brain.mjs"), "utf8");
    const loggerColumns = /INSERT INTO upgrade_runs\s*\(([^)]+)\)/.exec(cliSource)?.[1]
      ?.split(",").map((value) => value.trim());
    assert.deepEqual(loggerColumns, [
      "started_at", "finished_at", "from_version", "to_version",
      "status", "d1_bookmark", "detail",
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("write, file-fsync, rename, and directory-fsync failures preserve a valid aggregate outcome", async () => {
  for (const stage of ["write", "file_fsync", "rename", "directory_fsync"]) {
    const fixture = setupFixture();
    const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
    const dependencies = dependenciesFor(fixture, state);
    try {
      const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies);
      privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
      state.phase = "seeded";
      const fail = () => { throw new Error(`simulated_${stage}_failure`); };
      dependencies.finalizeReceipt = (reservation, receipt) => finalizeReservedAggregateReceipt(
        reservation,
        receipt,
        {
          ...(stage === "write" ? { writeBytes: fail } : {}),
          ...(stage === "file_fsync" ? { syncFile: fail } : {}),
          ...(stage === "rename" ? { rename: fail } : {}),
          ...(stage === "directory_fsync" ? { syncDirectory: fail } : {}),
        },
      );
      await assert.rejects(
        () => executeAcceleratedUpdateFieldGate(
          optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
          dependencies,
        ),
        new RegExp(`simulated_${stage}_failure`),
      );
      assert.equal(state.updateCalls, 1);
      const visible = JSON.parse(readFileSync(join(fixture.directory, "result.json"), "utf8"));
      assert.equal([
        "execution_in_progress_or_interrupted_target_requires_review",
        "passed_cleanup_required",
      ].includes(visible.status), true);
      if (stage === "directory_fsync") assert.equal(visible.status, "passed_cleanup_required");
      else assert.equal(visible.status, "execution_in_progress_or_interrupted_target_requires_review");
      const persisted = JSON.stringify(visible);
      assert.doesNotMatch(persisted, new RegExp(`${PRIVATE_SENTINEL}|${ADMIN_SENTINEL}|${SLUG}|${D1_ID}|${ACCOUNT}`));
      assert.equal(existsSync(join(fixture.directory, ".accelerated-update-field-gate.lock")), true);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("the retrieval canary requires an explicit non-degraded result", async () => {
  const fixture = setupFixture();
  const state = {
    phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null,
    omitDegraded: true,
  };
  const dependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies);
    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const result = await executeAcceleratedUpdateFieldGate(
      optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
      dependencies,
    );
    assert.equal(result.status, "failed_target_requires_review");
    assert.equal(result.failure_code, "canary_retrieval_invalid");
    assert.equal(result.mutations.post_update_canary_retrieval_calls, 1);
    assert.equal(state.updateCalls, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a failed installed update is never retried and leaves only aggregate review evidence", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const successDependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), successDependencies);
    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const failureDependencies = dependenciesFor(fixture, state, () => ({
      status: 1,
      stdout: Buffer.from(PRIVATE_SENTINEL),
      stderr: Buffer.from(ADMIN_SENTINEL),
    }));
    const result = await executeAcceleratedUpdateFieldGate(
      optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
      failureDependencies,
    );
    assert.equal(result.status, "failed_target_requires_review");
    assert.equal(result.failure_code, "brain_update_failed");
    assert.equal(result.lifecycle.invocation_count, 1);
    assert.equal(state.updateCalls, 1);
    assert.equal(result.mutations.post_update_canary_drain_calls, 0);
    assert.equal(result.cleanup.target_must_be_preserved_for_review, true);
    const persisted = readFileSync(join(fixture.directory, "result.json"), "utf8");
    assert.doesNotMatch(persisted, new RegExp(`${PRIVATE_SENTINEL}|${ADMIN_SENTINEL}|${SLUG}|${D1_ID}`));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a successful CLI exit with unverified writer quiescence fails closed without retry", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const prepareDependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), prepareDependencies);
    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const dependencies = dependenciesFor(fixture, state, () => ({
      status: 0,
      stdout: Buffer.from("older database writers have finished; starting database migration\n"),
      stderr: Buffer.from("the safety pause elapsed but quiescence was NOT verified (probe-unreadable)\n"),
    }));
    const result = await executeAcceleratedUpdateFieldGate(
      optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
      dependencies,
    );
    assert.equal(result.status, "failed_target_requires_review");
    assert.equal(result.failure_code, "update_writer_quiescence_unverified");
    assert.equal(result.lifecycle.invocation_count, 1);
    assert.equal(state.updateCalls, 1);
    assert.equal(result.mutations.post_update_canary_drain_calls, 0);
    assert.equal(result.cleanup.target_must_be_preserved_for_review, true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("changed target approval and ambient tokens stop before update", async () => {
  const fixture = setupFixture();
  const state = { phase: "baseline", sessions: 0, updateCalls: 0, calls: [], canaryTitle: null };
  const dependencies = dependenciesFor(fixture, state);
  try {
    const prepared = await prepareAcceleratedUpdateFieldGate(optionsFor(fixture.directory, "prepare"), dependencies);
    privateWrite(join(fixture.directory, "seed.json"), `${JSON.stringify(syntheticSeedReceipt(prepared), null, 2)}\n`);
    state.phase = "seeded";
    const wrong = optionsFor(fixture.directory, "execute", "0".repeat(64));
    await assert.rejects(() => executeAcceleratedUpdateFieldGate(wrong, dependencies), /exact_plan_approval_required/);
    assert.equal(state.updateCalls, 0);
    await assert.rejects(
      () => executeAcceleratedUpdateFieldGate(
        optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
        { ...dependencies, environment: { PATH: "/bin", CLOUDFLARE_API_TOKEN: TOKEN_SENTINEL } },
      ),
      /ambient_cloudflare_credential_refused/,
    );
    assert.equal(state.updateCalls, 0);
    const tampered = structuredClone(prepared);
    tampered.candidate.private_extra = PRIVATE_SENTINEL;
    privateWrite(join(fixture.directory, "plan.json"), `${JSON.stringify(tampered, null, 2)}\n`);
    await assert.rejects(
      () => executeAcceleratedUpdateFieldGate(
        optionsFor(fixture.directory, "execute", prepared.plan_fingerprint),
        dependencies,
      ),
      /plan_receipt_invalid/,
    );
    assert.equal(state.updateCalls, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
