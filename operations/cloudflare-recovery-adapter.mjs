#!/usr/bin/env node
/**
 * Supervised live adapter for the disposable Cloudflare recovery field gate.
 *
 * This file can export the reviewed source D1 database and write only to an
 * already-provisioned target whose D1, Vectorize, Worker, and hostname all carry
 * one explicit recovery-gate nonce. It cannot create, upload, route, or destroy
 * a resource. Its only deployment mutation promotes one separately reviewed,
 * immutable active version after a paused version has completed the exact
 * Vectorize rebuild. Cloudflare control-plane credentials stay inside an
 * owner-only wrapper such as a macOS Keychain-backed Wrangler launcher. The
 * Brain admin key is read from the target manifest's exact Keychain locator and
 * is used only in request headers or evaluator stdin.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { localToolEnvironment } from "../doctor.mjs";
import { evaluateProfileCoverage } from "../eval/profile.mjs";
import { validateGolden } from "../eval/golden-validation.mjs";
import {
  AGGREGATE_FIELD_OBSERVER_D1_SQL,
  AGGREGATE_FIELD_OBSERVER_READS,
  createAggregateFieldObserver,
} from "./aggregate-field-observer.mjs";
import {
  keychainChildEnvironment,
  parseAdminKeySecretReference,
  readAdminKeyFromKeychain,
} from "./admin-key-persistence.mjs";
import {
  DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
  DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
  assertDisposableRecoveryDeploymentReceipt,
  assertDisposableRecoveryDeploymentReceiptChain,
  assertDisposableRecoverySourcePhaseReceipt,
  disposableRecoveryDeploymentCampaignFingerprint,
  readDisposableRecoveryDeploymentReceipt,
  readDisposableRecoverySourcePhaseReceipt,
  readDisposableRecoverySourcePreflightReceipt,
  readDisposableRecoveryTargetPreflightReceipt,
} from "./disposable-recovery-deployment-receipt.mjs";
import {
  DISPOSABLE_RECOVERY_FIXTURE_SHA256,
  DISPOSABLE_RECOVERY_SEED_BATCHES,
  DISPOSABLE_RECOVERY_SEED_DOCUMENTS,
  assertDisposableRecoverySeedReceipt,
  disposableRecoverySeedExecutionApprovalFingerprint,
} from "./disposable-recovery-seeder.mjs";
import {
  LOCKED_WRANGLER_ENTRYPOINT,
  LOCKED_WRANGLER_RUNTIME_DIRECTORY,
  LOCKED_WRANGLER_VERSION,
  assertLockedWranglerRuntimeUnchanged,
  assertMaterializedWranglerRuntimeUnchanged,
  inspectLockedWranglerRuntime,
  materializeLockedWranglerRuntime,
} from "./locked-wrangler-runtime.mjs";
import {
  assertNoDarwinReceiptAcl,
  readPrivateAggregateReceipt,
} from "./private-aggregate-receipt.mjs";
import {
  assertNoRecoveryArtifactResidue,
  encryptRecoveryArtifact,
  validateRecoveryArtifactKey,
  withDecryptedRecoveryArtifact,
} from "./recovery-artifact-crypto.mjs";
import {
  RecoveryContentFingerprintError,
  captureDirectD1ContentFingerprint,
  hashNormalizedRecoveryDataExport,
} from "./recovery-content-fingerprint.mjs";
import {
  VERIFIED_RECOVERY_STAGES,
  bindVerifiedRecoveryFieldProof,
  inspectVerifiedRecoveryManifestBindings,
  inspectVerifiedRecoverySourceManifestBinding,
  loadVerifiedRecoveryPlan,
  loadVerifiedRecoveryState,
  runVerifiedRecovery,
  validateVerifiedRecoveryPlan,
  validateBankRecoveryProof,
  verifiedRecoveryStatus,
  writeVerifiedRecoveryState,
} from "./verified-recovery.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MIGRATIONS_DIRECTORY = join(ROOT, "migrations", "d1");
const EVAL_RUNNER = join(ROOT, "eval", "run.mjs");

const MAX_WRAPPER_BYTES = 1024 * 1024;
const MAX_GOLDEN_BYTES = 16 * 1024 * 1024;
const MAX_PROVIDER_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SQLITE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_BYTES = 2 * 1024 * 1024;
const MAX_WRANGLER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_EVAL_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BOOTSTRAP_DURATION_MS = 6 * 60 * 60 * 1000;
const MAX_BOOTSTRAP_ROUNDS = 20_000;
const BOOTSTRAP_POLL_MS = 3_000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DISPOSABLE_WORKER_RE = /(?:^|-)recovery-gate-([a-z0-9]{8,24})$/;
const WORKER_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9-]{1,127}$/;
const RECOVERY_REQUIRED_SECRET_NAMES = Object.freeze([
  "ADMIN_KEY",
  "RAG_PROXY_KEY",
  "SESSION_SIGNING_KEY",
]);
const RECOVERY_BANK_PROVIDER_SECRET_NAMES = Object.freeze([
  "BANK_FEED_CLIENT_ID",
  "BANK_FEED_SECRET",
]);
const RECOVERY_ZOOM_SECRET_NAMES = Object.freeze([
  "ZOOM_ACCOUNT_ID",
  "ZOOM_CLIENT_ID",
  "ZOOM_CLIENT_SECRET",
  "ZOOM_WEBHOOK_SECRET_TOKEN",
]);
const RECOVERY_BANK_WRAPPING_SECRET_NAME = "BANK_FEED_WRAPPING_KEY_V2";
// Exact Worker-side secrets written by D1-compatible installer/connect flows.
// Supabase is intentionally absent because this adapter requires STORAGE=d1;
// the remaining connectors keep credentials in local owner custody.
const RECOVERY_OPTIONAL_SECRET_NAMES = Object.freeze([
  "ANTHROPIC_API_KEY",
  ...RECOVERY_BANK_PROVIDER_SECRET_NAMES,
  RECOVERY_BANK_WRAPPING_SECRET_NAME,
  ...RECOVERY_ZOOM_SECRET_NAMES,
]);
const RECOVERY_COMPLETE_OPTIONAL_SECRET_GROUPS = Object.freeze([
  RECOVERY_BANK_PROVIDER_SECRET_NAMES,
  RECOVERY_ZOOM_SECRET_NAMES,
]);

/**
 * Checkpoint boundaries available to a supervised live drill. Read-only stages
 * are intentionally absent: stopping there adds no recovery evidence, while
 * accepting arbitrary names would make an operator think a drill ran when it
 * did not.
 */
export const RECOVERY_FIELD_GATE_STOP_STAGES = Object.freeze(
  VERIFIED_RECOVERY_STAGES
    .filter((stage) => stage.effect !== "read_only")
    .map((stage) => stage.id),
);
const RECOVERY_FIELD_GATE_STOP_STAGE_SET = new Set(RECOVERY_FIELD_GATE_STOP_STAGES);

/**
 * One deliberately awkward test-only value binds the interruption hook to the
 * reviewed synthetic v0.4.8 field campaign. It is not an ordinary recovery or
 * customer option, and arbitrary truthy values are refused.
 */
export const RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE =
  "v048-synthetic-disposable-field-proof-v1";
export const RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_CODE =
  "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_INTERRUPTION";
const RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_NAME =
  ".brain-recovery-test-bootstrap-interruption-v1.json";
const RECOVERY_TEST_BOOTSTRAP_COMPLETED_CHECKPOINT_NAME =
  ".brain-recovery-test-bootstrap-interruption-v1.completed.json";
const RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_NAME =
  ".brain-recovery-test-bootstrap-promotion-authorized-v1.json";
const RECOVERY_TEST_BOOTSTRAP_COMPLETED_PROMOTION_AUTHORIZATION_NAME =
  ".brain-recovery-test-bootstrap-promotion-authorized-v1.completed.json";
const RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_NAME =
  ".brain-recovery-test-bootstrap-resume-authorized-v1.json";
const RECOVERY_TEST_BOOTSTRAP_COMPLETED_RESUME_AUTHORIZATION_NAME =
  ".brain-recovery-test-bootstrap-resume-authorized-v1.completed.json";
const MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES = 16 * 1024;
const MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES = 16 * 1024;
const MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES = 16 * 1024;
const MAX_RECOVERY_TEST_FIELD_RECEIPT_BYTES = 1024 * 1024;
const MAX_RECOVERY_TEST_DEPLOYMENT_RECEIPT_BYTES = 1024 * 1024;
const MAX_RECOVERY_TEST_SEED_RECEIPT_BYTES = 1024 * 1024;
const MAX_RECOVERY_TEST_PACKAGE_BYTES = 64 * 1024 * 1024;
const MAX_RECOVERY_TEST_PACKAGE_UNPACKED_BYTES = 256 * 1024 * 1024;
const MIN_RECOVERY_TEST_FIELD_DOCUMENTS = 6_001;
const MIN_RECOVERY_TEST_FIELD_CHUNKS = 6_001;
const MIN_RECOVERY_TEST_FIELD_EPOCH_ADMISSIONS = 3_001;
const RECOVERY_TEST_WRANGLER_VERSION = LOCKED_WRANGLER_VERSION;
const RECOVERY_TEST_CLOUDFLARE_TOKEN_NAME = ["CLOUDFLARE", "API", "TOKEN"].join("_");
const RECOVERY_TEST_WRANGLER_WRAPPER_EXEC_LINE =
  'exec "${BRAIN_RECOVERY_NODE:?}" --no-global-search-paths --require "${BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD:?}" "${BRAIN_RECOVERY_WRANGLER_ENTRYPOINT:?}" "$@"';
const RECOVERY_TEST_WRANGLER_WRAPPER_TOKEN_LINE_RE =
  /^CLOUDFLARE_API_TOKEN="\$\(\/usr\/bin\/security find-generic-password -a '[A-Za-z0-9._:@/-]{1,128}' -s '[A-Za-z0-9._:@/-]{1,128}' -w\)" \|\| exit 125$/;
const RECOVERY_TEST_PACKAGE_REQUIRED_MEMBERS = Object.freeze([
  "package.json",
  "doctor.mjs",
  "eval/golden-validation.mjs",
  "eval/profile.mjs",
  "eval/run.mjs",
  "operations/admin-key-file.mjs",
  "operations/admin-key-persistence.mjs",
  "operations/aggregate-field-observer.mjs",
  "operations/cloudflare-disposable-deployment-transport.mjs",
  "operations/cloudflare-recovery-adapter.mjs",
  "operations/disposable-recovery-deployment-journal.mjs",
  "operations/disposable-recovery-deployment-receipt.mjs",
  "operations/disposable-recovery-field-deploy.mjs",
  "operations/disposable-recovery-field-seed.mjs",
  "operations/disposable-recovery-seeder.mjs",
  "operations/locked-wrangler-runtime.mjs",
  "operations/private-aggregate-receipt.mjs",
  "operations/recovery-artifact-crypto.mjs",
  "operations/recovery-content-fingerprint.mjs",
  "operations/verified-recovery.mjs",
]);
const RECOVERY_TEST_PRIVATE_CURSOR_SQL = `SELECT
  vector_projection_bootstrap_epoch AS epoch,
  vector_projection_bootstrap_base_count AS base_count,
  vector_projection_bootstrap_protocol AS protocol,
  vector_projection_bootstrap_cursor AS cursor_value
FROM install_state
WHERE id = 1`;
const RECOVERY_TEST_BOOTSTRAP_OPENING_SQL = `SELECT
  vector_projection_status AS projection_status,
  vector_projection_bootstrap_epoch AS epoch,
  vector_projection_bootstrap_base_count AS base_count,
  CASE WHEN vector_projection_bootstrap_protocol IS NULL THEN 1 ELSE 0 END AS protocol_is_null,
  CASE WHEN vector_projection_bootstrap_cursor IS NULL THEN 1 ELSE 0 END AS cursor_is_null,
  CASE WHEN vector_projection_bootstrap_high_water IS NULL THEN 0 ELSE 1 END AS high_water_set,
  (SELECT COUNT(*) FROM chunks c
    WHERE c.chunk_uid <= install_state.vector_projection_bootstrap_high_water) AS high_water_position,
  CASE WHEN vector_projection_bootstrap_high_water = (SELECT MAX(chunk_uid) FROM chunks)
    THEN 1 ELSE 0 END AS high_water_matches_max,
  (SELECT COUNT(*) FROM documents) AS documents,
  (SELECT COUNT(*) FROM chunks) AS chunks,
  (SELECT COUNT(*) FROM chunks_fts) AS fts,
  (SELECT COUNT(*) FROM vector_bootstrap_batches) AS batches,
  COALESCE((SELECT SUM(row_count) FROM vector_bootstrap_batches), 0) AS batch_rows,
  (SELECT COUNT(*) FROM vector_outbox) AS outbox,
  CASE WHEN vector_projection_mutation_id IS NULL THEN 1 ELSE 0 END AS projection_fence_clear
FROM install_state
WHERE id = 1`.replace(/\s+/g, " ").trim();
const RECOVERY_TEST_FIELD_PREPARATION_STEPS = Object.freeze([
  "source-identity",
  "full-suite",
  "frontend-test",
  "frontend-build",
  "hiccup-lab",
  "plaid-fake",
  "d1-auth-atomicity",
  "passkey-protocol",
  "package-privacy",
  "history-privacy",
  "dependency-audit",
  "package-build",
  "clean-prefix-smoke",
  "source-identity-final",
  "private-home-cleanup",
]);
const RECOVERY_TEST_HUMAN_FIELD_GATES = Object.freeze([
  "physical_windows_install",
  "disposable_cloudflare",
  "physical_passkeys",
  "plaid_sandbox",
  "quickbooks_sandbox",
  "watched_folder",
  "bank_exports",
]);
const RECOVERY_TEST_FIELD_IDENTITY = Object.freeze({
  clientSlug: "v048-field-proof",
  clientDisplayName: "Synthetic Field Gate v0.4.8",
  productVersion: "0.4.8",
  sourceResource: "brain-test-v048-field-source-recovery-gate-a48f1101",
  targetResource: "brain-test-v048-field-target-recovery-gate-a48f1102",
  sourceAdminKeySecret:
    "keychain://brain-test-v048-field-source-recovery-gate-a48f1101/owner",
  targetAdminKeySecret:
    "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/owner",
  recoveryArtifactKeySecret:
    "keychain://brain-test-v048-field-target-recovery-gate-a48f1102/artifact-v1",
});

/**
 * D1 full export currently refuses FTS5 virtual tables. These are the durable
 * application tables expected in the schema. The checked-in, already-applied
 * migrations recreate that schema and the derived chunks_fts index. A future
 * migration that adds a table must update this reviewed list or the adapter
 * stops before exporting anything.
 */
export const RECOVERY_DURABLE_TABLES = Object.freeze([
  "install_state",
  "schema_migrations",
  "upgrade_runs",
  "llm_call_log",
  "sources",
  "source_events",
  "documents",
  "chunks",
  "vector_outbox",
  "vector_bootstrap_batches",
  "corpus_stats",
  "sync_runs",
  // Schema 14: the owner's enrolled passkeys are durable (losing them on a
  // recovery would lock every device out until a new invite); challenges and
  // enrollment codes are single-use fifteen-minute security state and are
  // deliberately NOT exported below.
  "owner_passkeys",
  "auth_challenges",
  "enrollment_codes",
  // Schemas 15 and 16: named capability grants and their zone vocabulary.
  "grants",
  "grant_credentials",
  "zones",
  // Schema 17: the structured financial ledger. Every one of these is durable
  // and every one is exported. A recovered brain that came back with its
  // documents and without its ledger would answer a question about money from
  // prose alone, silently, which is the exact failure the ledger exists to end.
  "fin_entities",
  "fin_accounts",
  "fin_account_coverage",
  "fin_documents",
  "fin_statements",
  "fin_transactions",
  "fin_balance_snapshots",
  "fin_obligations",
  "fin_deadlines",
  "fin_exceptions",
  "fin_open_items",
  "fin_reconciliations",
  "fin_reconciliation_claims",
  // Schema 18: hosted bank-feed connector state. `bank_feed_items` holds the
  // ENCRYPTED read-only access reference, and a recovered brain that came back
  // without it would look connected and silently read nothing further. The
  // backfill queue comes with it so an interrupted history load resumes rather
  // than restarting from scratch. Link sessions are single-use, minutes-long
  // handoff state and are deliberately NOT exported below, exactly like
  // auth_challenges.
  "bank_feed_items",
  "bank_feed_backfill",
  "bank_feed_link_sessions",
  // Schema 19: connector OAuth state is entirely live security material.
  // A recovered brain simply has its connectors re-authorize (dynamic
  // registration makes that automatic), so none of it is exported.
  "oauth_clients",
  "oauth_codes",
  "oauth_tokens",
  // Schema 21: owner decisions, settings, idempotency receipts, and the one
  // human-readable activity history are durable product state.
  "owner_action_requests",
  "owner_activity_events",
  "owner_approvals",
  "fin_period_closes",
  "owner_targets",
  "owner_preferences",
  // Schema 22: exact document grants, their immutable audit trail, persistent
  // idempotency receipts, and privacy-safe passkey telemetry are durable
  // security state. Restoring owner passkeys without their grant authority
  // would either lock scoped users out or risk widening them to owner access.
  "document_access_grants",
  "document_access_documents",
  "document_access_requests",
  "document_access_events",
  "passkey_security_events",
  "support_access_events",
  "support_access_requests",
  "support_auth_challenges",
  "support_enrollment_codes",
  "support_passkeys",
  "support_sessions",
  "agent_action_receipts",
  "zoom_deliveries",
  "zoom_reconciliation",
  "plaid_link_operations",
  "plaid_reconciliation",
  "plaid_revocation_outbox",
  "plaid_sync_stage_accounts",
  "plaid_sync_stage_transactions",
  "plaid_sync_windows",
  "plaid_webhook_events",
  "plaid_webhook_keys",
  "public_request_quotas",
  "vector_outbox_retry_state",
  "plaid_account_entity_assignments",
  "owner_bank_import_commits",
  "owner_bank_import_previews",
  "quickbooks_oauth_intents",
  "document_source_inventory",
  "plaid_sync_leases",
  "vector_projection_events",
  // Schema 37: append-only, server-verified correction history. Losing this
  // ledger would make known-wrong conversational memories current again.
  "memory_supersessions",
  // Schema 41: the immutable, owner-activated financial-map chain and the key
  // that verifies it are durable owner records. Expiring previews and the
  // replay-derived inventory counter remain in the table inventory but are
  // not recovery content.
  "owner_financial_map_key_state",
  "owner_financial_map_inventory_state",
  "owner_financial_map_previews",
  "owner_financial_map_snapshots",
  // Schema 42: the independent HMAC key and append-only observation ledger
  // are one recovery unit. Restoring rows without their original identity key
  // would make later bounded verification impossible; minting a replacement
  // key would silently assign different identities to the same originals.
  "source_original_id_key_state",
  "source_original_observations",
  // Schema 43: raw-original result bindings are immutable provenance history.
  // They remain durable after a later document revision or approved deletion,
  // so recovery must carry the ledger together with the current document
  // revision and binding-pointer columns.
  "source_original_result_bindings",
  // Schema 44: the exact chunk members are staged before the portable family
  // header seals them. Restore both after schema-43 raw bindings so every
  // referenced revision and binding already exists. Schema 45's accepted
  // resolution is portable history and follows that family header. The
  // verification, activation, and admission tables are part of the reviewed
  // schema inventory, but their rows bind one deployment or one live write
  // transaction and are deliberately excluded from recovery content.
  "source_original_result_family_members",
  "source_original_result_family_receipts",
  "source_original_accepted_resolutions",
  "source_original_result_family_verifications",
  "source_original_accepted_resolution_activations",
  "source_original_accepted_resolution_admissions",
  // Empty outside one schema-first recovery import. The schema inventory keeps
  // the control table explicit, but its rows are never exported; source and
  // target probes require it empty while the artifact opens and closes it.
  "source_original_result_family_recovery_state",
]);

/**
 * The Vectorize queue is derived recovery state. It must be empty on the
 * source snapshot and is intentionally recreated empty before the target is
 * reindexed. Excluding it from the byte fingerprint also makes an interrupted
 * reindex safely resumable without weakening the documents/chunks proof.
 */
export const RECOVERY_EXPORT_TABLES = Object.freeze(
  RECOVERY_DURABLE_TABLES.filter((table) =>
      table !== "vector_outbox" && table !== "vector_bootstrap_batches" &&
      table !== "install_state" &&
      table !== "document_source_inventory" &&
      // Live single-use auth material never enters a resumable artifact: a
      // recovered brain re-issues challenges, invites, connector grants and
      // bank-authorisation sessions from scratch.
      table !== "auth_challenges" && table !== "enrollment_codes" &&
      table !== "support_sessions" && table !== "support_access_requests" &&
      table !== "support_enrollment_codes" && table !== "support_auth_challenges" &&
      table !== "support_passkeys" &&
      table !== "agent_action_receipts" &&
      table !== "owner_financial_map_inventory_state" &&
      table !== "owner_financial_map_previews" &&
      table !== "source_original_result_family_verifications" &&
      table !== "source_original_accepted_resolution_activations" &&
      table !== "source_original_accepted_resolution_admissions" &&
      table !== "source_original_result_family_recovery_state" &&
      table !== "bank_feed_link_sessions" &&
      table !== "oauth_clients" && table !== "oauth_codes" && table !== "oauth_tokens"),
);

const SAFE_WRANGLER_PREFIXES = Object.freeze([
  ["--version"],
  ["d1", "list"],
  ["d1", "execute"],
  ["d1", "export"],
  ["vectorize", "list"],
  ["vectorize", "info"],
  ["deployments", "status"],
  ["versions", "view"],
]);
const WRANGLER_FAIL_CLOSED_FLAGS = Object.freeze([
  "--experimental-provision=false",
  "--experimental-auto-create=false",
]);

const TABLE_INVENTORY_SQL =
  "SELECT name FROM sqlite_schema " +
  "WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "AND name <> 'chunks_fts' AND name NOT LIKE 'chunks_fts_%' ORDER BY name";
const USER_TABLE_COUNT_SQL =
  "SELECT COUNT(*) AS user_table_count FROM sqlite_schema " +
  "WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV'";
const MIGRATION_CONTRACT_SQL =
  "SELECT version,name,checksum FROM schema_migrations ORDER BY version";
const LOGICAL_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema " +
  "WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "AND name NOT LIKE 'chunks_fts_%' ORDER BY type,name,tbl_name";
const QUICK_CHECK_SQL = "PRAGMA quick_check";
const FTS_INTEGRITY_SQL =
  "INSERT INTO chunks_fts(chunks_fts,rank) VALUES('integrity-check',1)";
const OUTBOX_SQL =
  "SELECT COUNT(*) AS pending_outbox, " +
  "COALESCE(SUM(CASE WHEN attempts > 0 AND last_error IS NOT NULL THEN 1 ELSE 0 END),0) AS failed_vectors " +
  "FROM vector_outbox";
const RESULT_FAMILY_RECOVERY_STATE_SQL =
  "SELECT COUNT(*) AS active_imports FROM source_original_result_family_recovery_state";
const AGENT_ACTION_RECEIPTS_SQL =
  "SELECT COUNT(*) AS agent_action_receipts FROM agent_action_receipts";
const INSTALL_STATE_BASE_COLUMNS = Object.freeze([
  "id", "client_slug", "product_version", "schema_version", "gate_version",
  "installed_at", "last_upgraded_at", "ring", "notes",
]);
const INSTALL_STATE_LEASE_COLUMNS = Object.freeze([
  "vector_drain_lease_owner", "vector_drain_lease_expires_at",
]);
const INSTALL_STATE_PROJECTION_COLUMNS = Object.freeze([
  "vector_projection_mutation_id", "vector_projection_submitted_at",
  "vector_projection_status", "vector_projection_bootstrap_epoch",
  "vector_projection_bootstrap_cursor", "vector_projection_bootstrap_high_water",
]);
const INSTALL_STATE_BOOTSTRAP_V2_COLUMNS = Object.freeze([
  "vector_projection_bootstrap_protocol", "vector_projection_bootstrap_base_count",
]);
const INSTALL_STATE_NULL_NORMALIZED_COLUMNS = Object.freeze([
  ...INSTALL_STATE_LEASE_COLUMNS,
  "vector_projection_mutation_id", "vector_projection_submitted_at",
  "vector_projection_bootstrap_cursor",
  "vector_projection_bootstrap_protocol",
  // An open residue-only walk belongs to the SOURCE index's projection. A
  // restored brain re-walks its whole corpus into the new index, so the marker
  // must not survive: with it, the restored walk would page only the outbox.
  "vector_projection_residue_epoch",
]);
const INSTALL_STATE_ZERO_NORMALIZED_COLUMNS = Object.freeze([
  // Queue generations belong to the target's derived Vectorize projection.
  // A resumable bootstrap advances this counter as it creates outbox rows,
  // even though no document or chunk content changed. Reset it alongside the
  // queue itself so corpus fingerprints remain stable across safe retries.
  "outbox_generation",
  "vector_projection_bootstrap_base_count",
  // Accepted result-family verifications bind the source deployment's complete
  // retrieval response. A recovered target must start a new local generation
  // and prove it after the portable corpus has been restored.
  "source_original_retrieval_generation",
]);
// The minimum schema carrying the reviewed vector recovery protocol. Historical
// additive prefixes after this floor remain available to offline artifact and
// table-contract inspection. The live field runner separately requires the
// exact current schema because it promotes this package's current Worker.
const RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION = 36;

function quoteIdentifier(value) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) {
    throw recoveryError("RECOVERY_SCHEMA_CONTRACT_INVALID");
  }
  return `"${value}"`;
}

const SCHEMA_15_TABLES = Object.freeze(["grants", "grant_credentials"]);
const SCHEMA_16_TABLES = Object.freeze(["zones"]);

// Schema 17: the structured financial ledger, added as one additive migration.
// Listed once and consumed twice, by the aggregate projection and by the
// expected-table gate, so the two cannot drift apart.
const SCHEMA_17_TABLES = Object.freeze([
  "fin_entities",
  "fin_accounts",
  "fin_account_coverage",
  "fin_documents",
  "fin_statements",
  "fin_transactions",
  "fin_balance_snapshots",
  "fin_obligations",
  "fin_deadlines",
  "fin_exceptions",
  "fin_open_items",
  "fin_reconciliations",
  "fin_reconciliation_claims",
]);

// Schema 18: the hosted bank-feed connector's own tables, listed for the same
// two reasons and consumed the same two ways.
const SCHEMA_18_TABLES = Object.freeze([
  "bank_feed_items",
  "bank_feed_backfill",
  "bank_feed_link_sessions",
]);

// Declared here rather than beside SCHEMA_14 further down:
// AGGREGATE_FIELDS below is built at module load, so a const declared after
// it is in the temporal dead zone and every import of this module throws.
const SCHEMA_19_TABLES = Object.freeze(["oauth_clients", "oauth_codes", "oauth_tokens"]);
const SCHEMA_21_TABLES = Object.freeze([
  "owner_action_requests",
  "owner_activity_events",
  "owner_approvals",
  "fin_period_closes",
  "owner_targets",
  "owner_preferences",
]);
const SCHEMA_22_TABLES = Object.freeze([
  "document_access_grants",
  "document_access_documents",
  "document_access_requests",
  "document_access_events",
  "passkey_security_events",
]);

// Ported from the field line 2026-09-04, migrations 0023 to 0032. A durable
// table absent from this contract is a table a recovery export omits SILENTLY,
// so every CREATE TABLE in a new migration belongs here.
const SCHEMA_23_TABLES = Object.freeze([
  "support_access_events",
  "support_access_requests",
  "support_auth_challenges",
  "support_enrollment_codes",
  "support_passkeys",
  "support_sessions",
]);
const SCHEMA_24_TABLES = Object.freeze([
  "agent_action_receipts",
]);
const SCHEMA_25_TABLES = Object.freeze([
  "zoom_deliveries",
  "zoom_reconciliation",
]);
const SCHEMA_26_TABLES = Object.freeze([
  "plaid_link_operations",
  "plaid_reconciliation",
  "plaid_revocation_outbox",
  "plaid_sync_stage_accounts",
  "plaid_sync_stage_transactions",
  "plaid_sync_windows",
  "plaid_webhook_events",
  "plaid_webhook_keys",
]);
const SCHEMA_27_TABLES = Object.freeze([
  "public_request_quotas",
]);
const SCHEMA_28_TABLES = Object.freeze([
  "vector_outbox_retry_state",
]);
const SCHEMA_30_TABLES = Object.freeze([
  "plaid_account_entity_assignments",
]);
const SCHEMA_31_TABLES = Object.freeze([
  "owner_bank_import_commits",
  "owner_bank_import_previews",
]);
const SCHEMA_32_TABLES = Object.freeze([
  "quickbooks_oauth_intents",
]);
const SCHEMA_34_TABLES = Object.freeze([
  "document_source_inventory",
]);
const SCHEMA_35_TABLES = Object.freeze([
  "plaid_sync_leases",
]);
const SCHEMA_36_TABLES = Object.freeze(["vector_projection_events"]);
const SCHEMA_37_TABLES = Object.freeze(["memory_supersessions"]);
const SCHEMA_41_TABLES = Object.freeze([
  "owner_financial_map_key_state",
  "owner_financial_map_inventory_state",
  "owner_financial_map_previews",
  "owner_financial_map_snapshots",
]);
const SCHEMA_42_TABLES = Object.freeze([
  "source_original_id_key_state",
  "source_original_observations",
]);
const SCHEMA_43_TABLES = Object.freeze(["source_original_result_bindings"]);
const SCHEMA_44_TABLES = Object.freeze([
  "source_original_result_family_members",
  "source_original_result_family_receipts",
  "source_original_result_family_verifications",
  "source_original_result_family_recovery_state",
]);
const SCHEMA_45_TABLES = Object.freeze([
  "source_original_accepted_resolution_admissions",
  "source_original_accepted_resolutions",
  "source_original_accepted_resolution_activations",
]);

const AGGREGATE_FIELDS = Object.freeze([
  ...RECOVERY_DURABLE_TABLES
    .filter((table) => table !== "document_source_inventory")
    .map((table) => [
    table,
    // Literal zeros keep older migration prefixes queryable without
    // referencing tables they do not have. Passkey restoration correctness is
    // proven by the export content itself, not by the corpus aggregate.
    // Literal zeros also cover migration-owned durable tables, for the same reason
    // the passkey tables take one: this aggregate is queried against databases
    // at several migration prefixes, and a COUNT against a table a prefix does
    // not have fails the whole snapshot. Ledger restoration correctness is
    // proven by the exported content, which these tables are fully part of.
    ["vector_bootstrap_batches", "owner_passkeys", "auth_challenges", "enrollment_codes",
     ...SCHEMA_15_TABLES, ...SCHEMA_16_TABLES, ...SCHEMA_17_TABLES, ...SCHEMA_18_TABLES,
     ...SCHEMA_19_TABLES, ...SCHEMA_21_TABLES, ...SCHEMA_22_TABLES, ...SCHEMA_23_TABLES,
     ...SCHEMA_24_TABLES, ...SCHEMA_25_TABLES, ...SCHEMA_26_TABLES, ...SCHEMA_27_TABLES,
     ...SCHEMA_28_TABLES, ...SCHEMA_30_TABLES, ...SCHEMA_31_TABLES,
     ...SCHEMA_32_TABLES, ...SCHEMA_34_TABLES, ...SCHEMA_35_TABLES,
     ...SCHEMA_36_TABLES, ...SCHEMA_37_TABLES, ...SCHEMA_41_TABLES,
     ...SCHEMA_42_TABLES, ...SCHEMA_43_TABLES, ...SCHEMA_44_TABLES,
     ...SCHEMA_45_TABLES].includes(table)
      ? "SELECT 0"
      : `SELECT COUNT(*) FROM ${quoteIdentifier(table)}`,
  ]),
  ["chunks_fts", "SELECT COUNT(*) FROM chunks_fts"],
  ["documents_ingested_max", "SELECT COALESCE(MAX(ingested_at),0) FROM documents"],
  ["documents_text_bytes", "SELECT COALESCE(SUM(length(COALESCE(title,''))+length(COALESCE(uri,''))+length(COALESCE(meta,''))+length(content_hash)),0) FROM documents"],
  ["chunks_id_max", "SELECT COALESCE(MAX(id),0) FROM chunks"],
  ["chunks_text_bytes", "SELECT COALESCE(SUM(length(text)+length(chunk_uid)),0) FROM chunks"],
  // Drain leases and Vectorize mutation fences belong to one live derived
  // index, not the durable corpus. Snapshot comparison always observes their
  // normalized recovery value. Literals also keep older migration prefixes
  // queryable without referencing columns they do not have.
  ["vector_drain_lease_owner_present", "SELECT 0"],
  ["vector_drain_lease_expiry_present", "SELECT 0"],
  ["vector_projection_mutation_present", "SELECT 0"],
  ["vector_projection_submission_present", "SELECT 0"],
]);

const AGGREGATE_SQL = `SELECT ${AGGREGATE_FIELDS.map(
  ([name, query]) => `CAST((${query}) AS TEXT) AS ${quoteIdentifier(name)}`,
).join(",")}`;

export class CloudflareRecoveryAdapterError extends Error {
  constructor(code, detail = null) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CloudflareRecoveryAdapterError";
    this.code = code;
    this.detail = detail;
  }
}

function recoveryError(code, detail = null) {
  return new CloudflareRecoveryAdapterError(code, detail);
}

function refuse(code, detail = null) {
  throw recoveryError(code, detail);
}

function normalizeStopAfterStage(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !RECOVERY_FIELD_GATE_STOP_STAGE_SET.has(value)) {
    refuse("RECOVERY_FIELD_GATE_STOP_STAGE_INVALID");
  }
  return value;
}

function normalizeTestBootstrapInterruption(value) {
  if (value === undefined) return null;
  if (value !== RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_INTERRUPTION_INVALID");
  }
  return value;
}

function normalizeTestBootstrapCandidateSha(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CANDIDATE_INVALID");
  }
  return value;
}

function normalizeTestBootstrapEvidencePath(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value || value.length > 4096 || CONTROL_RE.test(value)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID");
  }
  return resolve(value);
}

function normalizeTestBootstrapRequest(input, { approvalRequired = false } = {}) {
  const mode = normalizeTestBootstrapInterruption(input?.testInterruptMidBootstrap);
  const candidateSha = normalizeTestBootstrapCandidateSha(
    input?.testBootstrapCandidateSha,
  );
  const fieldReceiptPath = normalizeTestBootstrapEvidencePath(
    input?.testBootstrapFieldReceiptPath,
  );
  const packagePath = normalizeTestBootstrapEvidencePath(
    input?.testBootstrapPackagePath,
  );
  const sourcePhaseReceiptPath = normalizeTestBootstrapEvidencePath(
    input?.testBootstrapSourcePhaseReceiptPath,
  );
  const deploymentReceiptPath = normalizeTestBootstrapEvidencePath(
    input?.testBootstrapDeploymentReceiptPath,
  );
  const seedReceiptPath = normalizeTestBootstrapEvidencePath(
    input?.testBootstrapSeedReceiptPath,
  );
  const approval = input?.approveTestBootstrapInterruption;
  if (!mode) {
    if (candidateSha !== null || fieldReceiptPath !== null || packagePath !== null ||
        sourcePhaseReceiptPath !== null || deploymentReceiptPath !== null ||
        seedReceiptPath !== null || approval !== undefined) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
    }
    return null;
  }
  if (!candidateSha || !fieldReceiptPath || !packagePath ||
      !sourcePhaseReceiptPath || !deploymentReceiptPath || !seedReceiptPath ||
      (approvalRequired && !SHA256_RE.test(String(approval || ""))) ||
      (!approvalRequired && approval !== undefined)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    mode,
    candidateSha,
    fieldReceiptPath,
    packagePath,
    sourcePhaseReceiptPath,
    deploymentReceiptPath,
    seedReceiptPath,
    approval: approval ?? null,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function testBootstrapInterruptionApprovalFingerprint(plan, candidateEvidence, wrapperSha256) {
  return sha256(canonical({
    schema_version: 7,
    purpose: "controlled_synthetic_mid_bootstrap_interruption",
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    candidate_sha: candidateEvidence.candidateSha,
    candidate_tree_sha: candidateEvidence.candidateTreeSha,
    field_receipt_sha256: candidateEvidence.fieldReceiptSha256,
    field_receipt_run_id: candidateEvidence.fieldReceiptRunId,
    package_filename: candidateEvidence.packageFilename,
    package_bytes: candidateEvidence.packageBytes,
    package_sha256: candidateEvidence.packageSha256,
    package_file_count: candidateEvidence.packageFileCount,
    execution_inventory_sha256: candidateEvidence.executionInventorySha256,
    source_preflight_receipt_sha256:
      candidateEvidence.sourcePreflightReceiptSha256,
    source_phase_receipt_sha256: candidateEvidence.sourcePhaseReceiptSha256,
    seed_receipt_sha256: candidateEvidence.seedReceiptSha256,
    target_preflight_receipt_sha256:
      candidateEvidence.targetPreflightReceiptSha256,
    deployment_receipt_sha256: candidateEvidence.deploymentReceiptSha256,
    seed_fixture_sha256: candidateEvidence.seedFixtureSha256,
    seed_d1_content_fingerprint: candidateEvidence.seedD1ContentFingerprint,
    seed_document_count: candidateEvidence.seedDocumentCount,
    seed_chunk_count: candidateEvidence.seedChunkCount,
    seed_fts_count: candidateEvidence.seedFtsCount,
    seed_vector_count: candidateEvidence.seedVectorCount,
    seed_replay_unchanged_documents:
      candidateEvidence.seedReplayUnchangedDocuments,
    wrangler_runtime_inventory_sha256:
      candidateEvidence.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidateEvidence.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidateEvidence.wranglerRuntimeEntrypointSha256,
    wrangler_runtime_package_count: candidateEvidence.wranglerRuntimePackageCount,
    wrangler_runtime_file_count: candidateEvidence.wranglerRuntimeFileCount,
    wrangler_runtime_bytes: candidateEvidence.wranglerRuntimeBytes,
    wrangler_runtime_directory: candidateEvidence.wranglerRuntimeDirectory,
    wrangler_runtime_schema_version: candidateEvidence.wranglerRuntimeSchemaVersion,
    wrangler_host_platform: candidateEvidence.wranglerHostPlatform,
    wrangler_host_arch: candidateEvidence.wranglerHostArch,
    wrangler_host_libc: candidateEvidence.wranglerHostLibc,
    node_version: candidateEvidence.nodeVersion,
    node_executable_sha256: candidateEvidence.nodeExecutableSha256,
    wrangler_wrapper_sha256: wrapperSha256,
    plan_fingerprint: plan.plan_fingerprint,
    source_manifest_fingerprint: plan.source_manifest_fingerprint,
    target_manifest_fingerprint: plan.target_manifest_fingerprint,
    source_resource_fingerprint: plan.source_resource_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    client_slug: RECOVERY_TEST_FIELD_IDENTITY.clientSlug,
    product_version: RECOVERY_TEST_FIELD_IDENTITY.productVersion,
    data_class: "deterministic_fictional_synthetic_only",
    stage: "rebuild_vectorize",
    hook_point:
      "after_observed_persisted_nonfinal_bootstrap_v2_receipt_before_sleep_or_active_promotion",
  }));
}

const RECOVERY_TEST_BOOTSTRAP_SEED_CONTROL_FIELDS = Object.freeze([
  "source_preflight_receipt_sha256", "source_phase_receipt_sha256",
  "seed_receipt_sha256", "target_preflight_receipt_sha256",
  "deployment_receipt_sha256", "seed_fixture_sha256",
  "seed_d1_content_fingerprint",
  "seed_document_count", "seed_chunk_count", "seed_fts_count", "seed_vector_count",
  "seed_replay_unchanged_documents",
]);

function testBootstrapSeedControlEvidence(candidateEvidence) {
  return Object.freeze({
    source_preflight_receipt_sha256:
      candidateEvidence.sourcePreflightReceiptSha256,
    source_phase_receipt_sha256: candidateEvidence.sourcePhaseReceiptSha256,
    seed_receipt_sha256: candidateEvidence.seedReceiptSha256,
    target_preflight_receipt_sha256:
      candidateEvidence.targetPreflightReceiptSha256,
    deployment_receipt_sha256: candidateEvidence.deploymentReceiptSha256,
    seed_fixture_sha256: candidateEvidence.seedFixtureSha256,
    seed_d1_content_fingerprint: candidateEvidence.seedD1ContentFingerprint,
    seed_document_count: candidateEvidence.seedDocumentCount,
    seed_chunk_count: candidateEvidence.seedChunkCount,
    seed_fts_count: candidateEvidence.seedFtsCount,
    seed_vector_count: candidateEvidence.seedVectorCount,
    seed_replay_unchanged_documents: candidateEvidence.seedReplayUnchangedDocuments,
  });
}

function testBootstrapSeedControlEvidenceMatches(input, candidateEvidence) {
  const expected = testBootstrapSeedControlEvidence(candidateEvidence);
  return RECOVERY_TEST_BOOTSTRAP_SEED_CONTROL_FIELDS.every(
    (field) => input?.[field] === expected[field],
  );
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function pathInfoOrAbsent(path, code) {
  const absolute = resolve(path || "");
  try {
    return Object.freeze({ path: absolute, info: lstatSync(absolute) });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    refuse(code);
  }
}

function assertPathAbsent(path, code) {
  if (pathInfoOrAbsent(path, code)) refuse(code);
  return true;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function assertOwned(info, code) {
  const uid = currentUid();
  if (uid !== null && info.uid !== uid) refuse(code);
}

function assertOwnerOnly(info, code) {
  assertOwned(info, code);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) refuse(code);
}

function assertPrivateDirectory(path, code = "RECOVERY_PRIVATE_DIRECTORY_UNSAFE") {
  const absolute = resolve(path || "");
  let info;
  try { info = lstatSync(absolute); } catch { refuse(code); }
  if (!info.isDirectory() || info.isSymbolicLink()) refuse(code);
  assertOwnerOnly(info, code);
  let canonicalPath;
  try { canonicalPath = realpathSync(absolute); } catch { refuse(code); }
  // macOS exposes /var through the fixed /private/var system alias. The final
  // component itself was already proven not to be a link; use its canonical
  // locator from here onward so every child and artifact comparison is exact.
  return Object.freeze({ path: canonicalPath, info: statSync(canonicalPath) });
}

export function readStablePrivateFile(path, {
  code,
  maxBytes,
  executable = false,
  allowEmpty = false,
} = {}) {
  const absolute = resolve(path || "");
  let descriptor;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (!allowEmpty && before.size < 1) || before.size > maxBytes) refuse(code);
    assertOwnerOnly(before, code);
    if (executable && process.platform !== "win32" && (before.mode & 0o100) === 0) refuse(code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    const raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) refuse(code);
    return Object.freeze({ path: absolute, raw, hash: sha256(raw), info: opened });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function stablePrivateFileRecord(checked, value) {
  return Object.freeze({
    value,
    pin: Object.freeze({
      path: checked.path,
      hash: checked.hash,
      info: checked.info,
    }),
  });
}

export function assertStablePrivateFileRecord(record, {
  code,
  maxBytes,
} = {}) {
  const checked = readStablePrivateFileRecord(record, { code, maxBytes });
  checked.raw.fill(0);
  return true;
}

/** Reopen one exact pinned private file and return its still-bound bytes. */
export function readStablePrivateFileRecord(record, {
  code,
  maxBytes,
  executable = false,
} = {}) {
  if (!record?.pin || typeof record.pin.path !== "string" ||
      !SHA256_RE.test(String(record.pin.hash || "")) || !record.pin.info) {
    refuse(code);
  }
  const checked = readStablePrivateFile(record.pin.path, { code, maxBytes, executable });
  if (checked.hash !== record.pin.hash || !sameFile(checked.info, record.pin.info)) {
    checked.raw.fill(0);
    refuse(code);
  }
  return checked;
}

function movedStablePrivateFileRecord(record, path, { code, maxBytes }) {
  if (!record?.pin) refuse(code);
  const checked = readStablePrivateFile(path, { code, maxBytes });
  try {
    const before = record.pin.info;
    const after = checked.info;
    // rename(2) may update ctime. It must preserve the same inode and every
    // other security-relevant attribute, and the bytes must still hash to the
    // exact pinned control receipt.
    if (checked.hash !== record.pin.hash || before.dev !== after.dev ||
        before.ino !== after.ino || before.nlink !== after.nlink ||
        before.size !== after.size || before.mode !== after.mode ||
        before.uid !== after.uid || before.mtimeMs !== after.mtimeMs) {
      refuse(code);
    }
    return Object.freeze({
      value: record.value,
      pin: Object.freeze({
        path: checked.path,
        hash: checked.hash,
        info: checked.info,
      }),
    });
  } finally {
    checked.raw.fill(0);
  }
}

function assertArtifactFile(path, { maxBytes, allowEmpty = false } = {}) {
  const absolute = resolve(path || "");
  let info;
  try { info = lstatSync(absolute); } catch { refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE"); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
      (!allowEmpty && info.size < 1) || info.size > maxBytes) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  assertOwned(info, "RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  return Object.freeze({ path: absolute, info });
}

function hashStableArtifact(path, maxBytes) {
  const checked = assertArtifactFile(path, { maxBytes });
  let descriptor;
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    const hasher = createHash("sha256");
    const block = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const read = readSync(descriptor, block, 0, block.length, null);
      if (!read) break;
      hasher.update(block.subarray(0, read));
      bytes += read;
      if (bytes > maxBytes) refuse("RECOVERY_EXPORT_ARTIFACT_TOO_LARGE");
    }
    block.fill(0);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath) || bytes !== opened.size) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    return Object.freeze({ artifact_sha256: hasher.digest("hex"), artifact_bytes: bytes });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function validIsoTimestamp(value) {
  return typeof value === "string" && value.length <= 64 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(new Date(value).getTime());
}

function tarText(bytes) {
  return bytes.toString("utf8").replace(/\0.*$/s, "");
}

function tarNumber(bytes, code) {
  const text = tarText(bytes).trim();
  if (!/^[0-7]+$/.test(text)) refuse(code);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) refuse(code);
  return value;
}

function parsePaxPath(bytes, code) {
  let offset = 0;
  let path = null;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < offset + 1) refuse(code);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(lengthText)) refuse(code);
    const length = Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 4 || offset + length > bytes.length ||
        bytes[offset + length - 1] !== 0x0a) refuse(code);
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    if (equals < 1) refuse(code);
    if (record.slice(0, equals) === "path") {
      if (path !== null) refuse(code);
      path = record.slice(equals + 1);
    }
    offset += length;
  }
  return path;
}

function normalizePackedMemberPath(value, code) {
  if (typeof value !== "string" || !value.startsWith("package/") ||
      value.length > 4096 || CONTROL_RE.test(value) || value.includes("\\")) refuse(code);
  const relative = value.slice("package/".length);
  const segments = relative.split("/");
  if (!relative || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    refuse(code);
  }
  return relative;
}

function readStableExecutingPackageMember(relative, code, expectedSize = null) {
  const root = realpathSync(ROOT);
  const absolute = resolve(ROOT, relative);
  let descriptor;
  try {
    const before = lstatSync(absolute);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
        (expectedSize !== null && before.size !== expectedSize) ||
        before.size > MAX_RECOVERY_TEST_PACKAGE_UNPACKED_BYTES) {
      refuse(code);
    }
    assertOwned(before, code);
    const canonicalPath = realpathSync(absolute);
    if (!canonicalPath.startsWith(`${root}${sep}`)) refuse(code);
    descriptor = openSync(absolute, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(before, opened)) refuse(code);
    const raw = readFileSync(descriptor);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(absolute);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) refuse(code);
    return Object.freeze({ path: absolute, hash: sha256(raw), raw, info: opened });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/**
 * Bind the code which is actually executing to every regular member of the
 * separately approved npm archive. This is deliberately broader than an import
 * allowlist: a future transitive import, migration, evaluator file, or bundled
 * dependency cannot silently escape the package pin.
 */
function inspectNpmPackedExecutionInventory(raw, code) {
  let archive;
  try {
    archive = gunzipSync(raw, { maxOutputLength: MAX_RECOVERY_TEST_PACKAGE_UNPACKED_BYTES });
    const members = new Map();
    let pendingPaxPath = null;
    let pendingLongPath = null;
    let sawEnd = false;
    for (let offset = 0; offset + 512 <= archive.length;) {
      const header = archive.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) {
        sawEnd = true;
        break;
      }
      const storedChecksum = tarNumber(header.subarray(148, 156), code);
      const checksumHeader = Buffer.from(header);
      checksumHeader.fill(0x20, 148, 156);
      const calculatedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
      checksumHeader.fill(0);
      if (storedChecksum !== calculatedChecksum) refuse(code);
      const name = tarText(header.subarray(0, 100));
      const prefix = tarText(header.subarray(345, 500));
      const headerPath = prefix ? `${prefix}/${name}` : name;
      const size = tarNumber(header.subarray(124, 136), code);
      const type = String.fromCharCode(header[156] || 0);
      const contentStart = offset + 512;
      const contentEnd = contentStart + size;
      const next = contentStart + Math.ceil(size / 512) * 512;
      if (contentEnd > archive.length || next > archive.length) refuse(code);
      const content = archive.subarray(contentStart, contentEnd);
      if (type === "x") {
        pendingPaxPath = parsePaxPath(content, code);
      } else if (type === "L") {
        pendingLongPath = tarText(content);
      } else if (type === "g" || type === "5") {
        // Global metadata and directory entries carry no executable bytes.
      } else if (type === "0" || type === "\0") {
        const relative = normalizePackedMemberPath(
          pendingPaxPath ?? pendingLongPath ?? headerPath,
          code,
        );
        if (members.has(relative)) refuse(code);
        members.set(relative, Object.freeze({
          path: relative,
          size,
          hash: sha256(content),
        }));
      } else {
        // Symlinks, hardlinks, devices, and unknown tar extensions are not an
        // acceptable execution inventory for this field-only fault seam.
        refuse(code);
      }
      if (type !== "x" && type !== "L" && type !== "g") {
        pendingPaxPath = null;
        pendingLongPath = null;
      }
      offset = next;
    }
    if (!sawEnd || members.size < RECOVERY_TEST_PACKAGE_REQUIRED_MEMBERS.length ||
        RECOVERY_TEST_PACKAGE_REQUIRED_MEMBERS.some((path) => !members.has(path))) refuse(code);

    const migrationMembers = [...members.keys()]
      .filter((path) => /^migrations\/d1\/\d+_.*\.sql$/.test(path)).sort();
    const executingMigrations = readdirSync(MIGRATIONS_DIRECTORY)
      .filter((name) => /^\d+_.*\.sql$/.test(name)).sort()
      .map((name) => `migrations/d1/${name}`);
    if (canonical(migrationMembers) !== canonical(executingMigrations)) refuse(code);

    const ordered = [...members.values()].sort((left, right) => left.path.localeCompare(right.path));
    let packageJson = null;
    const executionPins = [];
    for (const member of ordered) {
      const local = readStableExecutingPackageMember(member.path, code, member.size);
      try {
        if (local.hash !== member.hash) refuse(code);
        executionPins.push(Object.freeze({
          path: local.path,
          relative: member.path,
          hash: local.hash,
          info: local.info,
        }));
        if (member.path === "package.json") {
          packageJson = JSON.parse(local.raw.toString("utf8"));
        }
      } finally {
        local.raw.fill(0);
      }
    }
    if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson) ||
        packageJson.name !== "brain-installer" || packageJson.version !== "0.4.8") refuse(code);
    return Object.freeze({
      name: packageJson.name,
      version: packageJson.version,
      fileCount: ordered.length,
      inventorySha256: sha256(canonical(ordered)),
      executionPins: Object.freeze(executionPins),
    });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse(code);
  } finally {
    archive?.fill(0);
  }
}

function inspectRecoveryTestWranglerRuntime(receiptParent, code) {
  try {
    const runtimePath = join(receiptParent.path, LOCKED_WRANGLER_RUNTIME_DIRECTORY);
    assertPrivateDirectory(runtimePath, code);
    return inspectLockedWranglerRuntime(runtimePath, {
      ownerOnly: true,
      exactRoot: true,
    });
  } catch {
    refuse(code);
  }
}

/**
 * Bind the dangerous test seam to the exact package that passed the complete
 * credential-free field-preparation profile. The caller's SHA is only an
 * expectation: the independently loaded owner-only receipt is authoritative,
 * and its package hash is checked against the separately loaded tarball bytes.
 */
function inspectTestBootstrapCandidateEvidence(request, plan, pins) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID";
  const receiptParent = assertPrivateDirectory(dirname(request.fieldReceiptPath), code);
  const packageParent = assertPrivateDirectory(dirname(request.packagePath), code);
  const sourcePreflightReceiptPath = request.sourcePhaseReceiptPath
    ? join(
        dirname(request.sourcePhaseReceiptPath),
        DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
      )
    : null;
  const targetPreflightReceiptPath = request.deploymentReceiptPath
    ? join(
        dirname(request.deploymentReceiptPath),
        DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
      )
    : null;
  const sourcePreflightReceiptParent = sourcePreflightReceiptPath
    ? assertPrivateDirectory(dirname(sourcePreflightReceiptPath), code)
    : receiptParent;
  const sourcePhaseReceiptParent = request.sourcePhaseReceiptPath
    ? assertPrivateDirectory(dirname(request.sourcePhaseReceiptPath), code)
    : receiptParent;
  const targetPreflightReceiptParent = targetPreflightReceiptPath
    ? assertPrivateDirectory(dirname(targetPreflightReceiptPath), code)
    : receiptParent;
  const deploymentReceiptParent = request.deploymentReceiptPath
    ? assertPrivateDirectory(dirname(request.deploymentReceiptPath), code)
    : receiptParent;
  const seedReceiptParent = request.seedReceiptPath
    ? assertPrivateDirectory(dirname(request.seedReceiptPath), code)
    : receiptParent;
  if (receiptParent.path !== packageParent.path ||
      (sourcePreflightReceiptPath &&
        receiptParent.path !== sourcePreflightReceiptParent.path) ||
      (request.sourcePhaseReceiptPath &&
        receiptParent.path !== sourcePhaseReceiptParent.path) ||
      (targetPreflightReceiptPath &&
        receiptParent.path !== targetPreflightReceiptParent.path) ||
      (request.deploymentReceiptPath &&
        receiptParent.path !== deploymentReceiptParent.path) ||
      (request.seedReceiptPath && receiptParent.path !== seedReceiptParent.path) ||
      basename(request.fieldReceiptPath) !== "field-prepare-receipt.json" ||
      (sourcePreflightReceiptPath &&
        basename(sourcePreflightReceiptPath) !==
          DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME) ||
      (request.sourcePhaseReceiptPath &&
        basename(request.sourcePhaseReceiptPath) !==
          DISPOSABLE_RECOVERY_SOURCE_PHASE_RECEIPT_NAME) ||
      (targetPreflightReceiptPath &&
        basename(targetPreflightReceiptPath) !==
          DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME) ||
      (request.deploymentReceiptPath &&
        basename(request.deploymentReceiptPath) !==
          DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME) ||
      (request.seedReceiptPath &&
        basename(request.seedReceiptPath) !== "v048-disposable-seed-receipt.json")) {
    refuse(code);
  }
  const receiptFile = readStablePrivateFile(request.fieldReceiptPath, {
    code,
    maxBytes: MAX_RECOVERY_TEST_FIELD_RECEIPT_BYTES,
  });
  const packageFile = readStablePrivateFile(request.packagePath, {
    code,
    maxBytes: MAX_RECOVERY_TEST_PACKAGE_BYTES,
  });
  let sourcePreflightReceiptFile = null;
  let seedReceiptFile = null;
  let sourcePhaseReceiptFile = null;
  let targetPreflightReceiptFile = null;
  let deploymentReceiptFile = null;
  if (sourcePreflightReceiptPath) {
    try {
      sourcePreflightReceiptFile = readDisposableRecoverySourcePreflightReceipt(
        sourcePreflightReceiptPath,
      );
      if (sourcePreflightReceiptFile.info.size >
          MAX_RECOVERY_TEST_DEPLOYMENT_RECEIPT_BYTES) {
        refuse(code);
      }
    } catch {
      refuse(code);
    }
  }
  if (request.sourcePhaseReceiptPath) {
    try {
      sourcePhaseReceiptFile = readDisposableRecoverySourcePhaseReceipt(
        request.sourcePhaseReceiptPath,
      );
      if (sourcePhaseReceiptFile.info.size > MAX_RECOVERY_TEST_DEPLOYMENT_RECEIPT_BYTES) {
        refuse(code);
      }
    } catch {
      refuse(code);
    }
  }
  if (request.deploymentReceiptPath) {
    try {
      targetPreflightReceiptFile = readDisposableRecoveryTargetPreflightReceipt(
        targetPreflightReceiptPath,
      );
      if (targetPreflightReceiptFile.info.size >
          MAX_RECOVERY_TEST_DEPLOYMENT_RECEIPT_BYTES) {
        refuse(code);
      }
    } catch {
      refuse(code);
    }
    try {
      deploymentReceiptFile = readDisposableRecoveryDeploymentReceipt(
        request.deploymentReceiptPath,
      );
      if (deploymentReceiptFile.info.size > MAX_RECOVERY_TEST_DEPLOYMENT_RECEIPT_BYTES) {
        refuse(code);
      }
    } catch {
      refuse(code);
    }
  }
  if (request.seedReceiptPath) {
    try {
      seedReceiptFile = readPrivateAggregateReceipt(request.seedReceiptPath, {
        code,
        maxBytes: MAX_RECOVERY_TEST_SEED_RECEIPT_BYTES,
      });
    } catch {
      refuse(code);
    }
  }
  let packageIdentity;
  try {
    packageIdentity = inspectNpmPackedExecutionInventory(packageFile.raw, code);
  } finally {
    packageFile.raw.fill(0);
  }
  const wranglerRuntime = inspectRecoveryTestWranglerRuntime(receiptParent, code);
  let receipt;
  let sourcePreflightReceipt;
  let sourcePhaseReceipt;
  let targetPreflightReceipt;
  let deploymentReceipt;
  let seedReceipt;
  try {
    receipt = JSON.parse(receiptFile.raw.toString("utf8"));
    if (sourcePreflightReceiptFile) {
      sourcePreflightReceipt = sourcePreflightReceiptFile.value;
    }
    if (sourcePhaseReceiptFile) {
      sourcePhaseReceipt = sourcePhaseReceiptFile.value;
      assertDisposableRecoverySourcePhaseReceipt(sourcePhaseReceipt);
    }
    if (targetPreflightReceiptFile) {
      targetPreflightReceipt = targetPreflightReceiptFile.value;
    }
    if (deploymentReceiptFile) {
      deploymentReceipt = deploymentReceiptFile.value;
      assertDisposableRecoveryDeploymentReceipt(deploymentReceipt);
    }
    if (seedReceiptFile) {
      seedReceipt = seedReceiptFile.value;
      assertDisposableRecoverySeedReceipt(seedReceipt);
    }
  } catch {
    refuse(code);
  } finally {
    receiptFile.raw.fill(0);
  }

  exactAggregateReceiptFields(receipt, [
    "schema_version", "run_id", "generated_at", "completed_at", "status",
    "profile", "scope", "proof_level", "ready_for_live_accounts",
    "live_field_gates_run", "customer_data_read", "customer_manifests_read",
    "credential_stores_read", "live_accounts_contacted", "external_network_allowed",
    "tooling", "source", "package", "steps", "human_field_gates",
  ], code);
  const falseBoundaryFields = [
    "ready_for_live_accounts", "live_field_gates_run", "customer_data_read",
    "customer_manifests_read", "credential_stores_read", "live_accounts_contacted",
    "external_network_allowed",
  ];
  if (receipt.schema_version !== 1 ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(String(receipt.run_id || "")) ||
      !validIsoTimestamp(receipt.generated_at) || !validIsoTimestamp(receipt.completed_at) ||
      receipt.status !== "source_preparation_passed" || receipt.profile !== "full" ||
      receipt.scope !== "source_preparation_only" ||
      receipt.proof_level !== "offline_synthetic_only" ||
      falseBoundaryFields.some((field) => receipt[field] !== false)) {
    refuse(code);
  }

  exactAggregateReceiptFields(receipt.tooling, [
    "wrangler_package", "wrangler_resolution", "wrangler_runtime_directory",
    "wrangler_runtime_schema_version", "wrangler_entrypoint",
    "wrangler_entrypoint_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_runtime_package_count", "wrangler_runtime_file_count",
    "wrangler_runtime_bytes", "wrangler_package_lock_sha256",
    "wrangler_host_platform", "wrangler_host_arch", "wrangler_host_libc",
    "node_version", "node_executable_sha256",
  ], code);
  if (receipt.tooling.wrangler_package !== "wrangler@4.127.1" ||
      receipt.tooling.wrangler_resolution !== "locked_local_runtime_closure" ||
      receipt.tooling.wrangler_runtime_directory !== LOCKED_WRANGLER_RUNTIME_DIRECTORY ||
      receipt.tooling.wrangler_runtime_schema_version !== wranglerRuntime.schemaVersion ||
      receipt.tooling.wrangler_entrypoint !== LOCKED_WRANGLER_ENTRYPOINT ||
      receipt.tooling.wrangler_entrypoint_sha256 !== wranglerRuntime.entrypointSha256 ||
      receipt.tooling.wrangler_runtime_inventory_sha256 !==
        wranglerRuntime.inventorySha256 ||
      receipt.tooling.wrangler_runtime_package_count !== wranglerRuntime.packageCount ||
      receipt.tooling.wrangler_runtime_file_count !== wranglerRuntime.fileCount ||
      receipt.tooling.wrangler_runtime_bytes !== wranglerRuntime.totalBytes ||
      receipt.tooling.wrangler_package_lock_sha256 !==
        wranglerRuntime.packageLockSha256 ||
      receipt.tooling.wrangler_host_platform !== wranglerRuntime.host.platform ||
      receipt.tooling.wrangler_host_arch !== wranglerRuntime.host.arch ||
      receipt.tooling.wrangler_host_libc !== wranglerRuntime.host.libc ||
      receipt.tooling.node_version !== wranglerRuntime.nodeVersion ||
      receipt.tooling.node_executable_sha256 !== wranglerRuntime.nodeExecSha256) {
    refuse(code);
  }

  const source = receipt.source;
  exactAggregateReceiptFields(source, [
    "head_sha", "tree_sha", "package_name", "package_version", "package_alignment",
    "package_json_sha256", "package_lock_sha256", "working_tree_clean",
    "shallow_repository", "diff_check_clean", "identity_stable_during_check",
    "end_clean",
  ], code);
  exactAggregateReceiptFields(source.package_alignment, [
    "aligned", "package_lock_name", "package_lock_version",
    "package_lock_root_name", "package_lock_root_version",
  ], code);
  if (!/^[0-9a-f]{40}$/.test(String(source.head_sha || "")) ||
      !/^[0-9a-f]{40}$/.test(String(source.tree_sha || "")) ||
      source.package_name !== "brain-installer" || source.package_version !== "0.4.8" ||
      !SHA256_RE.test(String(source.package_json_sha256 || "")) ||
      !SHA256_RE.test(String(source.package_lock_sha256 || "")) ||
      source.working_tree_clean !== true || source.shallow_repository !== false ||
      source.diff_check_clean !== true || source.identity_stable_during_check !== true ||
      source.end_clean !== true || source.package_alignment.aligned !== true ||
      source.package_alignment.package_lock_name !== source.package_name ||
      source.package_alignment.package_lock_version !== source.package_version ||
      source.package_alignment.package_lock_root_name !== source.package_name ||
      source.package_alignment.package_lock_root_version !== source.package_version ||
      source.package_lock_sha256 !== wranglerRuntime.packageLockSha256) {
    refuse(code);
  }
  if (request.candidateSha !== source.head_sha) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CANDIDATE_MISMATCH");
  }

  const packed = receipt.package;
  exactAggregateReceiptFields(packed, ["filename", "bytes", "sha256", "file_count"], code);
  const expectedFilename = `${source.package_name}-${source.package_version}.tgz`;
  if (packed.filename !== expectedFilename || basename(request.packagePath) !== expectedFilename ||
      !Number.isSafeInteger(packed.bytes) || packed.bytes < 1 ||
      !Number.isSafeInteger(packed.file_count) || packed.file_count < 1 ||
      !SHA256_RE.test(String(packed.sha256 || "")) ||
      packageIdentity.name !== source.package_name ||
      packageIdentity.version !== source.package_version ||
      packageIdentity.fileCount !== packed.file_count ||
      packed.bytes !== packageFile.info.size || packed.sha256 !== packageFile.hash) {
    refuse(code);
  }

  const executingPackageJson = readStableExecutingPackageMember(
    "package.json",
    code,
  );
  const executingPackageLock = readStableExecutingPackageMember(
    "package-lock.json",
    code,
  );
  try {
    if (executingPackageJson.hash !== source.package_json_sha256 ||
        executingPackageLock.hash !== source.package_lock_sha256) refuse(code);
  } finally {
    executingPackageJson.raw.fill(0);
    executingPackageLock.raw.fill(0);
  }

  if (!Array.isArray(receipt.steps) ||
      receipt.steps.length !== RECOVERY_TEST_FIELD_PREPARATION_STEPS.length) {
    refuse(code);
  }
  receipt.steps.forEach((step, index) => {
    exactAggregateReceiptFields(step, [
      "id", "title", "status", "proof", "duration_ms", "exit_code", "failure_code",
      "network_scope",
    ], code);
    if (step.id !== RECOVERY_TEST_FIELD_PREPARATION_STEPS[index] ||
        step.status !== "passed" || step.exit_code !== null || step.failure_code !== null ||
        !Number.isSafeInteger(step.duration_ms) || step.duration_ms < 0 ||
        typeof step.title !== "string" || !step.title ||
        typeof step.proof !== "string" || !step.proof ||
        !["local_only", "local_only_offline_enforced", "loopback_only"]
          .includes(step.network_scope)) {
      refuse(code);
    }
  });
  if (!Array.isArray(receipt.human_field_gates) ||
      receipt.human_field_gates.length !== RECOVERY_TEST_HUMAN_FIELD_GATES.length) {
    refuse(code);
  }
  receipt.human_field_gates.forEach((gate, index) => {
    exactAggregateReceiptFields(gate, ["id", "status"], code);
    if (gate.id !== RECOVERY_TEST_HUMAN_FIELD_GATES[index] ||
        gate.status !== "pending_human_proof") {
      refuse(code);
    }
  });

  const seederPin = packageIdentity.executionPins.find(
    (pin) => pin.relative === "operations/disposable-recovery-seeder.mjs",
  );
  const runnerPin = packageIdentity.executionPins.find(
    (pin) => pin.relative === "operations/disposable-recovery-field-seed.mjs",
  );
  const fingerprintPin = packageIdentity.executionPins.find(
    (pin) => pin.relative === "operations/recovery-content-fingerprint.mjs",
  );
  if (!seederPin || !runnerPin || !fingerprintPin) refuse(code);
  const commonEvidence = {
    candidateSha: source.head_sha,
    candidateTreeSha: source.tree_sha,
    fieldReceiptRunId: receipt.run_id,
    fieldReceiptSha256: receiptFile.hash,
    packageFilename: packed.filename,
    packageBytes: packed.bytes,
    packageSha256: packed.sha256,
    packageFileCount: packageIdentity.fileCount,
    executionInventorySha256: packageIdentity.inventorySha256,
    seederSha256: seederPin.hash,
    seedRunnerSha256: runnerPin.hash,
    seedContentFingerprintHelperSha256: fingerprintPin.hash,
    wranglerWrapperSha256: pins.wrapper.hash,
    wranglerRuntimeInventorySha256: wranglerRuntime.inventorySha256,
    wranglerRuntimeEntrypoint: wranglerRuntime.entrypointRelative,
    wranglerRuntimeEntrypointSha256: wranglerRuntime.entrypointSha256,
    wranglerRuntimePackageCount: wranglerRuntime.packageCount,
    wranglerRuntimeFileCount: wranglerRuntime.fileCount,
    wranglerRuntimeBytes: wranglerRuntime.totalBytes,
    wranglerRuntimeDirectory: LOCKED_WRANGLER_RUNTIME_DIRECTORY,
    wranglerRuntimeSchemaVersion: wranglerRuntime.schemaVersion,
    wranglerHostPlatform: wranglerRuntime.host.platform,
    wranglerHostArch: wranglerRuntime.host.arch,
    wranglerHostLibc: wranglerRuntime.host.libc,
    nodeVersion: wranglerRuntime.nodeVersion,
    nodeExecutableSha256: wranglerRuntime.nodeExecSha256,
    wranglerRuntime,
    executionPins: packageIdentity.executionPins,
    packageJsonInfo: executingPackageJson.info,
    packageLockInfo: executingPackageLock.info,
    receiptInfo: receiptFile.info,
    packageInfo: packageFile.info,
    ...(sourcePreflightReceiptFile ? {
      sourcePreflightReceipt,
      sourcePreflightReceiptSha256: sourcePreflightReceiptFile.sha256,
      sourcePreflightReceiptInfo: sourcePreflightReceiptFile.info,
    } : {}),
    ...(sourcePhaseReceiptFile ? {
      sourcePhaseReceipt,
      sourcePhaseReceiptSha256: sourcePhaseReceiptFile.sha256,
      sourcePhaseReceiptInfo: sourcePhaseReceiptFile.info,
    } : {}),
    ...(targetPreflightReceiptFile ? {
      targetPreflightReceipt,
      targetPreflightReceiptSha256: targetPreflightReceiptFile.sha256,
      targetPreflightReceiptInfo: targetPreflightReceiptFile.info,
    } : {}),
    ...(deploymentReceiptFile ? {
      deploymentReceipt,
      deploymentReceiptSha256: deploymentReceiptFile.sha256,
      deploymentReceiptInfo: deploymentReceiptFile.info,
    } : {}),
    ...(seedReceiptFile ? { seedReceiptInfo: seedReceiptFile.info } : {}),
  };
  if (sourcePhaseReceipt) {
    const sourcePhaseBinding = sourcePhaseReceipt.binding;
    if (!sourcePreflightReceipt ||
        sourcePhaseReceipt.source_preflight_receipt_sha256 !==
          sourcePreflightReceiptFile.sha256 ||
        canonical(sourcePhaseBinding) !== canonical(sourcePreflightReceipt.binding) ||
        sourcePhaseReceipt.source.active_version.upload_request_sha256 !==
          sourcePreflightReceipt.planned_requests.source_active_upload_sha256 ||
        sourcePhaseReceipt.source.active_deployment.deployment_request_sha256 !==
          sourcePreflightReceipt.planned_requests.source_active_deployment_sha256 ||
        !plan || sourcePhaseBinding.plan_fingerprint !== plan.plan_fingerprint ||
        sourcePhaseBinding.candidate_sha !== source.head_sha ||
        sourcePhaseBinding.candidate_tree_sha !== source.tree_sha ||
        sourcePhaseBinding.field_receipt_sha256 !== receiptFile.hash ||
        sourcePhaseBinding.field_receipt_run_id !== receipt.run_id ||
        sourcePhaseBinding.package_filename !== packed.filename ||
        sourcePhaseBinding.package_bytes !== packed.bytes ||
        sourcePhaseBinding.package_sha256 !== packed.sha256 ||
        sourcePhaseBinding.package_file_count !== packageIdentity.fileCount ||
        sourcePhaseBinding.execution_inventory_sha256 !== packageIdentity.inventorySha256 ||
        sourcePhaseBinding.installed_execution_inventory_sha256 !==
          packageIdentity.inventorySha256 ||
        sourcePhaseBinding.source_manifest_fingerprint !==
          plan.source_manifest_fingerprint ||
        sourcePhaseBinding.source_resource_fingerprint !==
          plan.source_resource_fingerprint ||
        sourcePhaseBinding.target_manifest_fingerprint !==
          plan.target_manifest_fingerprint ||
        sourcePhaseBinding.target_resource_fingerprint !==
          plan.target_resource_fingerprint ||
        sourcePhaseBinding.runtime_contract_fingerprint !==
          plan.runtime_contract_fingerprint ||
        sourcePhaseBinding.wrangler_version !== LOCKED_WRANGLER_VERSION ||
        sourcePhaseBinding.wrangler_wrapper_sha256 !== pins.wrapper.hash ||
        sourcePhaseBinding.wrangler_runtime_inventory_sha256 !==
          wranglerRuntime.inventorySha256 ||
        sourcePhaseBinding.wrangler_entrypoint_sha256 !==
          wranglerRuntime.entrypointSha256 ||
        sourcePhaseBinding.node_version !== wranglerRuntime.nodeVersion ||
        sourcePhaseBinding.node_executable_sha256 !== wranglerRuntime.nodeExecSha256) {
      refuse(code);
    }
  }
  if (deploymentReceipt) {
    const deploymentBinding = deploymentReceipt.binding;
    if (!sourcePhaseReceipt || !targetPreflightReceipt ||
        canonical(deploymentBinding) !== canonical(sourcePhaseReceipt.binding) ||
        canonical(deploymentBinding) !== canonical(targetPreflightReceipt.binding) ||
        !plan || deploymentBinding.plan_fingerprint !== plan.plan_fingerprint ||
        deploymentBinding.candidate_sha !== source.head_sha ||
        deploymentBinding.candidate_tree_sha !== source.tree_sha ||
        deploymentBinding.field_receipt_sha256 !== receiptFile.hash ||
        deploymentBinding.field_receipt_run_id !== receipt.run_id ||
        deploymentBinding.package_filename !== packed.filename ||
        deploymentBinding.package_bytes !== packed.bytes ||
        deploymentBinding.package_sha256 !== packed.sha256 ||
        deploymentBinding.package_file_count !== packageIdentity.fileCount ||
        deploymentBinding.execution_inventory_sha256 !== packageIdentity.inventorySha256 ||
        deploymentBinding.installed_execution_inventory_sha256 !==
          packageIdentity.inventorySha256 ||
        deploymentBinding.source_manifest_fingerprint !==
          plan.source_manifest_fingerprint ||
        deploymentBinding.source_resource_fingerprint !==
          plan.source_resource_fingerprint ||
        deploymentBinding.target_manifest_fingerprint !==
          plan.target_manifest_fingerprint ||
        deploymentBinding.target_resource_fingerprint !==
          plan.target_resource_fingerprint ||
        deploymentBinding.runtime_contract_fingerprint !==
          plan.runtime_contract_fingerprint ||
        deploymentBinding.wrangler_version !== LOCKED_WRANGLER_VERSION ||
        deploymentBinding.wrangler_wrapper_sha256 !== pins.wrapper.hash ||
        deploymentBinding.wrangler_runtime_inventory_sha256 !==
          wranglerRuntime.inventorySha256 ||
        deploymentBinding.wrangler_entrypoint_sha256 !==
          wranglerRuntime.entrypointSha256 ||
        deploymentBinding.node_version !== wranglerRuntime.nodeVersion ||
        deploymentBinding.node_executable_sha256 !== wranglerRuntime.nodeExecSha256) {
      refuse(code);
    }
  }
  if (!seedReceipt) return Object.freeze(commonEvidence);

  const seedBinding = seedReceipt.binding;
  if (seedBinding.candidate_sha !== source.head_sha ||
      seedBinding.candidate_tree_sha !== source.tree_sha ||
      seedBinding.field_receipt_sha256 !== receiptFile.hash ||
      seedBinding.source_phase_receipt_sha256 !== sourcePhaseReceiptFile?.sha256 ||
      seedBinding.package_sha256 !== packed.sha256 ||
      seedBinding.package_file_count !== packageIdentity.fileCount ||
      seedBinding.execution_inventory_sha256 !== packageIdentity.inventorySha256 ||
      seedBinding.installed_execution_inventory_sha256 !== packageIdentity.inventorySha256 ||
      seedBinding.runner_sha256 !== runnerPin.hash ||
      seedBinding.seeder_sha256 !== seederPin.hash ||
      seedBinding.content_fingerprint_helper_sha256 !== fingerprintPin.hash ||
      seedBinding.source_manifest_fingerprint !== plan.source_manifest_fingerprint ||
      seedBinding.source_resource_fingerprint !== plan.source_resource_fingerprint ||
      seedBinding.source_phase_run_id !== sourcePhaseReceipt?.binding?.run_id ||
      seedBinding.source_a2_approval_fingerprint !==
        sourcePhaseReceipt?.a2_approval_fingerprint ||
      seedBinding.source_active_version_id !==
        sourcePhaseReceipt?.source?.active_version?.version_id ||
      seedBinding.source_script_etag !==
        sourcePhaseReceipt?.source?.active_version?.script_etag ||
      seedBinding.source_deployment_id !==
        sourcePhaseReceipt?.source?.active_deployment?.deployment_id ||
      seedBinding.runtime_contract_fingerprint !== plan.runtime_contract_fingerprint ||
      seedBinding.wrangler_wrapper_sha256 !== pins.wrapper.hash ||
      seedBinding.wrangler_runtime_inventory_sha256 !== wranglerRuntime.inventorySha256 ||
      seedBinding.wrangler_entrypoint_sha256 !== wranglerRuntime.entrypointSha256 ||
      seedBinding.node_executable_sha256 !== wranglerRuntime.nodeExecSha256 ||
      seedBinding.execution_approval_fingerprint !==
        disposableRecoverySeedExecutionApprovalFingerprint(seedBinding) ||
      seedReceipt.fixture.sha256 !== DISPOSABLE_RECOVERY_FIXTURE_SHA256 ||
      seedReceipt.fixture.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      seedReceipt.fixture.batches !== DISPOSABLE_RECOVERY_SEED_BATCHES ||
      seedReceipt.d1.documents !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
      seedReceipt.d1.chunks < MIN_RECOVERY_TEST_FIELD_CHUNKS ||
      seedReceipt.d1.fts !== seedReceipt.d1.chunks ||
      seedReceipt.d1.pending_outbox !== 0 || seedReceipt.d1.failed_vectors !== 0 ||
      !SHA256_RE.test(seedReceipt.d1.content_fingerprint) ||
      seedReceipt.projection.vectorize_vectors !== seedReceipt.d1.chunks ||
      seedReceipt.projection.vector_dimensions !== 768 ||
      seedReceipt.projection.vector_metric !== "cosine" ||
      seedReceipt.projection.quarantined_vectors !== 0 ||
      seedReceipt.projection.independent_control_plane !== true ||
      seedReceipt.evaluation.supported_case_cited !== true ||
      seedReceipt.evaluation.unsupported_case_refused !== true ||
      seedReceipt.proof_boundary.vectorize_proven !== true ||
      seedReceipt.proof_boundary.retrieval_proven !== true) {
    refuse(code);
  }
  try {
    assertDisposableRecoveryDeploymentReceiptChain({
      source_preflight: sourcePreflightReceiptFile,
      source_phase: sourcePhaseReceiptFile,
      seed_receipt_sha256: seedReceiptFile.sha256,
      target_preflight: targetPreflightReceiptFile,
      target_phase: deploymentReceiptFile,
    });
  } catch {
    refuse(code);
  }

  return Object.freeze({
    ...commonEvidence,
    seedReceiptSha256: seedReceiptFile.sha256,
    seedFixtureSha256: seedReceipt.fixture.sha256,
    seedD1ContentFingerprint: seedReceipt.d1.content_fingerprint,
    seedDocumentCount: seedReceipt.d1.documents,
    seedChunkCount: seedReceipt.d1.chunks,
    seedFtsCount: seedReceipt.d1.fts,
    seedVectorCount: seedReceipt.projection.vectorize_vectors,
    seedReplayUnchangedDocuments:
      seedReceipt.verification_replay.unchanged_documents,
  });
}

function assertTestBootstrapCandidateEvidenceUnchanged(
  expected,
  request,
  assertWranglerRuntime = assertLockedWranglerRuntimeUnchanged,
) {
  let receiptInfo;
  let packageInfo;
  let sourcePreflightReceiptInfo;
  let sourcePhaseReceiptInfo;
  let targetPreflightReceiptInfo;
  let deploymentReceiptInfo;
  let seedReceiptInfo;
  try {
    receiptInfo = lstatSync(request.fieldReceiptPath);
    packageInfo = lstatSync(request.packagePath);
    if (request.sourcePhaseReceiptPath) {
      sourcePreflightReceiptInfo = lstatSync(join(
        dirname(request.sourcePhaseReceiptPath),
        DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
      ));
      sourcePhaseReceiptInfo = lstatSync(request.sourcePhaseReceiptPath);
    }
    if (request.deploymentReceiptPath) {
      targetPreflightReceiptInfo = lstatSync(join(
        dirname(request.deploymentReceiptPath),
        DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
      ));
      deploymentReceiptInfo = lstatSync(request.deploymentReceiptPath);
    }
    if (request.seedReceiptPath) seedReceiptInfo = lstatSync(request.seedReceiptPath);
  } catch {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (!sameFile(receiptInfo, expected.receiptInfo) ||
      !sameFile(packageInfo, expected.packageInfo) ||
      (request.sourcePhaseReceiptPath &&
        !sameFile(
          sourcePreflightReceiptInfo,
          expected.sourcePreflightReceiptInfo,
        )) ||
      (request.sourcePhaseReceiptPath &&
        !sameFile(sourcePhaseReceiptInfo, expected.sourcePhaseReceiptInfo)) ||
      (request.deploymentReceiptPath &&
        !sameFile(
          targetPreflightReceiptInfo,
          expected.targetPreflightReceiptInfo,
        )) ||
      (request.deploymentReceiptPath &&
        !sameFile(deploymentReceiptInfo, expected.deploymentReceiptInfo)) ||
      (request.seedReceiptPath && !sameFile(seedReceiptInfo, expected.seedReceiptInfo))) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  let currentSourcePreflightReceipt = null;
  let currentSourcePhaseReceipt = null;
  let currentTargetPreflightReceipt = null;
  let currentDeploymentReceipt = null;
  let currentSeedReceipt = null;
  if (request.sourcePhaseReceiptPath) try {
    currentSourcePreflightReceipt = readDisposableRecoverySourcePreflightReceipt(
      join(
        dirname(request.sourcePhaseReceiptPath),
        DISPOSABLE_RECOVERY_SOURCE_PREFLIGHT_RECEIPT_NAME,
      ),
    );
    if (currentSourcePreflightReceipt.sha256 !==
          expected.sourcePreflightReceiptSha256 ||
        !sameFile(
          currentSourcePreflightReceipt.info,
          expected.sourcePreflightReceiptInfo,
        )) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (request.sourcePhaseReceiptPath) try {
    currentSourcePhaseReceipt = readDisposableRecoverySourcePhaseReceipt(
      request.sourcePhaseReceiptPath,
    );
    if (currentSourcePhaseReceipt.sha256 !== expected.sourcePhaseReceiptSha256 ||
        !sameFile(currentSourcePhaseReceipt.info, expected.sourcePhaseReceiptInfo)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
    assertDisposableRecoverySourcePhaseReceipt(currentSourcePhaseReceipt.value);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (request.deploymentReceiptPath) try {
    currentTargetPreflightReceipt = readDisposableRecoveryTargetPreflightReceipt(
      join(
        dirname(request.deploymentReceiptPath),
        DISPOSABLE_RECOVERY_TARGET_PREFLIGHT_RECEIPT_NAME,
      ),
    );
    if (currentTargetPreflightReceipt.sha256 !==
          expected.targetPreflightReceiptSha256 ||
        !sameFile(
          currentTargetPreflightReceipt.info,
          expected.targetPreflightReceiptInfo,
        )) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (request.deploymentReceiptPath) try {
    currentDeploymentReceipt = readDisposableRecoveryDeploymentReceipt(
      request.deploymentReceiptPath,
    );
    if (currentDeploymentReceipt.sha256 !== expected.deploymentReceiptSha256 ||
        !sameFile(currentDeploymentReceipt.info, expected.deploymentReceiptInfo)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
    assertDisposableRecoveryDeploymentReceipt(currentDeploymentReceipt.value);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (request.seedReceiptPath) try {
    currentSeedReceipt = readPrivateAggregateReceipt(request.seedReceiptPath, {
      code: "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED",
      maxBytes: MAX_RECOVERY_TEST_SEED_RECEIPT_BYTES,
    });
    if (currentSeedReceipt.sha256 !== expected.seedReceiptSha256 ||
        !sameFile(currentSeedReceipt.info, expected.seedReceiptInfo)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
    assertDisposableRecoverySeedReceipt(currentSeedReceipt.value);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  if (request.deploymentReceiptPath) {
    try {
      assertDisposableRecoveryDeploymentReceiptChain({
        source_preflight: currentSourcePreflightReceipt,
        source_phase: currentSourcePhaseReceipt,
        seed_receipt_sha256: currentSeedReceipt.sha256,
        target_preflight: currentTargetPreflightReceipt,
        target_phase: currentDeploymentReceipt,
      });
    } catch {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
  }
  const sourcePins = [
    ...expected.executionPins,
    { path: join(ROOT, "package.json"), info: expected.packageJsonInfo },
    { path: join(ROOT, "package-lock.json"), info: expected.packageLockInfo },
  ];
  for (const pin of sourcePins) {
    let current;
    try { current = lstatSync(pin.path); } catch {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
    if (!sameFile(current, pin.info) || !current.isFile() || current.isSymbolicLink()) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
    }
  }
  try {
    assertWranglerRuntime(expected.wranglerRuntime);
  } catch {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
  }
  return true;
}

/**
 * Inspect the exact offline-prepared candidate before the synthetic source is
 * seeded. This returns only hash/count binding material plus a local
 * revalidator; it performs no credential lookup or provider call.
 */
export function inspectDisposableRecoverySeedPreparation({
  candidateSha,
  fieldReceiptPath,
  sourcePhaseReceiptPath,
  packagePath,
  wranglerWrapperPath,
  plan: planInput,
}) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  const normalizedCandidateSha = normalizeTestBootstrapCandidateSha(candidateSha);
  const request = Object.freeze({
    candidateSha: normalizedCandidateSha,
    fieldReceiptPath: normalizeTestBootstrapEvidencePath(fieldReceiptPath),
    packagePath: normalizeTestBootstrapEvidencePath(packagePath),
    sourcePhaseReceiptPath: normalizeTestBootstrapEvidencePath(sourcePhaseReceiptPath),
    deploymentReceiptPath: null,
    seedReceiptPath: null,
  });
  if (!request.candidateSha || !request.fieldReceiptPath || !request.packagePath ||
      !request.sourcePhaseReceiptPath) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  const wrapper = inspectWrapper(wranglerWrapperPath);
  try {
    assertTestBootstrapWrapperRuntimeContract(wrapper);
    const evidence = inspectTestBootstrapCandidateEvidence(request, plan, { wrapper });
    const sourcePhaseReceipt = evidence.sourcePhaseReceipt;
    const bindingBase = {
      schema_version: 4,
      candidate_sha: evidence.candidateSha,
      candidate_tree_sha: evidence.candidateTreeSha,
      field_receipt_sha256: evidence.fieldReceiptSha256,
      source_phase_receipt_sha256: evidence.sourcePhaseReceiptSha256,
      package_sha256: evidence.packageSha256,
      package_file_count: evidence.packageFileCount,
      execution_inventory_sha256: evidence.executionInventorySha256,
      installed_execution_inventory_sha256: evidence.executionInventorySha256,
      runner_sha256: evidence.seedRunnerSha256,
      seeder_sha256: evidence.seederSha256,
      content_fingerprint_helper_sha256:
        evidence.seedContentFingerprintHelperSha256,
      source_manifest_fingerprint: plan.source_manifest_fingerprint,
      source_resource_fingerprint: plan.source_resource_fingerprint,
      source_phase_run_id: sourcePhaseReceipt.binding.run_id,
      source_a2_approval_fingerprint: sourcePhaseReceipt.a2_approval_fingerprint,
      source_active_version_id: sourcePhaseReceipt.source.active_version.version_id,
      source_script_etag: sourcePhaseReceipt.source.active_version.script_etag,
      source_deployment_id: sourcePhaseReceipt.source.active_deployment.deployment_id,
      runtime_contract_fingerprint: plan.runtime_contract_fingerprint,
      wrangler_wrapper_sha256: wrapper.hash,
      wrangler_runtime_inventory_sha256: evidence.wranglerRuntimeInventorySha256,
      wrangler_entrypoint_sha256: evidence.wranglerRuntimeEntrypointSha256,
      node_executable_sha256: evidence.nodeExecutableSha256,
    };
    const binding = Object.freeze({
      ...bindingBase,
      execution_approval_fingerprint:
        disposableRecoverySeedExecutionApprovalFingerprint(bindingBase),
    });
    const revalidate = () => {
      assertTestBootstrapCandidateEvidenceUnchanged(evidence, request);
      const currentWrapper = inspectWrapper(wranglerWrapperPath);
      try {
        assertTestBootstrapWrapperRuntimeContract(currentWrapper);
        if (currentWrapper.hash !== wrapper.hash ||
            !sameFile(currentWrapper.info, wrapper.info)) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
        }
      } finally {
        currentWrapper.raw.fill(0);
      }
      return true;
    };
    return Object.freeze({
      binding,
      approvalFingerprint: binding.execution_approval_fingerprint,
      fieldReceiptRunId: evidence.fieldReceiptRunId,
      wranglerRuntime: evidence.wranglerRuntime,
      sourcePhaseReceipt,
      revalidate,
    });
  } finally {
    wrapper.raw.fill(0);
  }
}

/**
 * Bind the exact offline candidate to the fixed disposable deployment producer.
 * This is local inspection only. The returned manifest bindings stay
 * ephemeral for the narrow deployment provider; no receipt or journal may
 * serialize them. The returned revalidator opens no credential and makes no
 * provider call.
 */
function inspectDisposableRecoveryDeploymentPreparationInternal({
  candidateSha,
  fieldReceiptPath,
  packagePath,
  wranglerWrapperPath,
  sourceManifestPath,
  targetManifestPath,
  plan: planInput,
}, { sourceOnly = false } = {}) {
  const plan = validateVerifiedRecoveryPlan(planInput);
  const manifestBindings = sourceOnly
    ? inspectVerifiedRecoverySourceManifestBinding(plan, sourceManifestPath)
    : inspectVerifiedRecoveryManifestBindings(
      plan,
      sourceManifestPath,
      targetManifestPath,
    );
  if (sourceOnly) assertDisposableRecoverySourceFieldCampaignIdentity(manifestBindings);
  else assertDisposableRecoveryFieldCampaignIdentity(manifestBindings);
  const request = Object.freeze({
    candidateSha: normalizeTestBootstrapCandidateSha(candidateSha),
    fieldReceiptPath: normalizeTestBootstrapEvidencePath(fieldReceiptPath),
    packagePath: normalizeTestBootstrapEvidencePath(packagePath),
    sourcePhaseReceiptPath: null,
    deploymentReceiptPath: null,
    seedReceiptPath: null,
  });
  if (!request.candidateSha || !request.fieldReceiptPath || !request.packagePath) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  const wrapper = inspectWrapper(wranglerWrapperPath);
  try {
    assertTestBootstrapWrapperRuntimeContract(wrapper);
    const evidence = inspectTestBootstrapCandidateEvidence(request, plan, { wrapper });
    const bindingBase = {
      schema_version: 2,
      run_id: evidence.fieldReceiptRunId,
      plan_fingerprint: plan.plan_fingerprint,
      candidate_sha: evidence.candidateSha,
      candidate_tree_sha: evidence.candidateTreeSha,
      field_receipt_sha256: evidence.fieldReceiptSha256,
      field_receipt_run_id: evidence.fieldReceiptRunId,
      package_filename: evidence.packageFilename,
      package_bytes: evidence.packageBytes,
      package_sha256: evidence.packageSha256,
      package_file_count: evidence.packageFileCount,
      execution_inventory_sha256: evidence.executionInventorySha256,
      installed_execution_inventory_sha256: evidence.executionInventorySha256,
      source_manifest_fingerprint: plan.source_manifest_fingerprint,
      source_resource_fingerprint: plan.source_resource_fingerprint,
      target_manifest_fingerprint: plan.target_manifest_fingerprint,
      target_resource_fingerprint: plan.target_resource_fingerprint,
      runtime_contract_fingerprint: plan.runtime_contract_fingerprint,
      wrangler_version: LOCKED_WRANGLER_VERSION,
      wrangler_wrapper_sha256: wrapper.hash,
      wrangler_runtime_inventory_sha256: evidence.wranglerRuntimeInventorySha256,
      wrangler_entrypoint_sha256: evidence.wranglerRuntimeEntrypointSha256,
      node_version: evidence.nodeVersion,
      node_executable_sha256: evidence.nodeExecutableSha256,
    };
    const binding = Object.freeze({
      schema_version: bindingBase.schema_version,
      run_id: bindingBase.run_id,
      campaign_fingerprint:
        disposableRecoveryDeploymentCampaignFingerprint(bindingBase),
      ...Object.fromEntries(Object.entries(bindingBase).slice(2)),
    });
    const revalidate = () => {
      assertTestBootstrapCandidateEvidenceUnchanged(evidence, request);
      const currentWrapper = inspectWrapper(wranglerWrapperPath);
      try {
        assertTestBootstrapWrapperRuntimeContract(currentWrapper);
        if (currentWrapper.hash !== wrapper.hash ||
            !sameFile(currentWrapper.info, wrapper.info)) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_CHANGED");
        }
      } finally {
        currentWrapper.raw.fill(0);
      }
      return true;
    };
    return Object.freeze({
      binding,
      approvalFingerprint: binding.campaign_fingerprint,
      manifestBindings,
      wranglerRuntime: evidence.wranglerRuntime,
      executionPins: evidence.executionPins,
      revalidate,
    });
  } finally {
    wrapper.raw.fill(0);
  }
}

/** Source-only preparation deliberately never opens the target manifest. */
export function inspectDisposableRecoverySourceDeploymentPreparation(input) {
  return inspectDisposableRecoveryDeploymentPreparationInternal(input, {
    sourceOnly: true,
  });
}

/** Target preparation binds both manifests after the seeded-source boundary. */
export function inspectDisposableRecoveryDeploymentPreparation(input) {
  return inspectDisposableRecoveryDeploymentPreparationInternal(input);
}

/** Hash a canonical normalized prefix followed by one stable Wrangler export. */
function hashNormalizedDataExport(prefix, path, maxBytes) {
  try {
    return hashNormalizedRecoveryDataExport(prefix, path, maxBytes);
  } catch (error) {
    if (!(error instanceof RecoveryContentFingerprintError)) throw error;
    if (error.code === "RECOVERY_CONTENT_EXPORT_TOO_LARGE") {
      refuse("RECOVERY_EXPORT_ARTIFACT_TOO_LARGE");
    }
    if (error.code === "RECOVERY_CONTENT_EXPORT_CHANGED") {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    refuse("RECOVERY_EXPORT_ASSEMBLY_FAILED");
  }
}

function recoveryArtifactDataFingerprint(path, maxBytes) {
  const checked = assertArtifactFile(path, { maxBytes });
  let descriptor;
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    const header = Buffer.alloc(512);
    const count = readSync(descriptor, header, 0, header.length, 0);
    const match = header.subarray(0, count).toString("utf8").match(
      /^-- Financial Brain verified recovery artifact\.\n-- Durable-data-sha256: ([0-9a-f]{64})\n/,
    );
    header.fill(0);
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    if (!match) refuse("RECOVERY_EXPORT_ARTIFACT_INVALID");
    return match[1];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertDisposableTarget(binding) {
  const workerMatch = String(binding.workerName || "").match(DISPOSABLE_WORKER_RE);
  if (!workerMatch) refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  const suffix = `recovery-gate-${workerMatch[1]}`;
  const names = [binding.databaseName, binding.vectorizeIndex];
  if (names.some((name) => !(String(name) === suffix || String(name).endsWith(`-${suffix}`)))) {
    refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  }
  const labels = String(binding.domain || "").split(".");
  if (!binding.domain || labels[0] !== binding.workerName ||
      labels.length < 4 || labels.slice(-2).join(".") !== "workers.dev") {
    refuse("RECOVERY_TARGET_NOT_DISPOSABLE");
  }
  return Object.freeze({ nonce: workerMatch[1], suffix });
}

function exactWorkersDevIdentity(binding, expectedResource) {
  const labels = String(binding.domain || "").split(".");
  return binding.workerName === expectedResource &&
    binding.databaseName === expectedResource &&
    binding.vectorizeIndex === expectedResource &&
    labels[0] === expectedResource &&
    labels.length >= 4 && labels.slice(-2).join(".") === "workers.dev";
}

function exactDisposableRecoveryRuntime(binding) {
  return binding.embeddingModel === "@cf/baai/bge-base-en-v1.5" &&
    binding.embeddingDimensions === 768 && binding.chunkSize === "1500" &&
    binding.chunkOverlap === "300" && binding.dailyLlmCapUsd === "10" &&
    binding.answerModel === "@cf/meta/llama-3.3-70b-instruct-fp8-fast" &&
    binding.credentialScanner === "on" && binding.ocrEnabled === "0" &&
    binding.ocrModel === "@cf/google/gemma-4-26b-a4b-it";
}

function noDisposableRecoveryConnectors(binding) {
  return Array.isArray(binding.enabledCorpora) &&
    binding.enabledCorpora.length === 0 && binding.bankFeedEnabled === false;
}

/** Prove the fixed source identity without opening or observing the target. */
export function assertDisposableRecoverySourceFieldCampaignIdentity(binding) {
  const source = binding?.source;
  const expected = RECOVERY_TEST_FIELD_IDENTITY;
  if (!source || binding.planFingerprint === undefined ||
      binding.sourceManifestFingerprint === undefined ||
      source.clientSlug !== expected.clientSlug ||
      source.clientDisplayName !== expected.clientDisplayName ||
      source.productVersion !== expected.productVersion ||
      source.adminKeySecret !== expected.sourceAdminKeySecret ||
      source.recoveryArtifactKeySecret !== null ||
      source.recoveryFieldGate !== null ||
      !exactDisposableRecoveryRuntime(source) ||
      !noDisposableRecoveryConnectors(source) ||
      !exactWorkersDevIdentity(source, expected.sourceResource)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_IDENTITY_INVALID");
  }
  return true;
}

/**
 * This is intentionally not a broad "looks disposable" check. The mid-flight
 * fault belongs only to the named fictional v0.4.8 campaign reviewed in the
 * public field plan. Any future campaign must add a new reviewed identity and
 * mode instead of inheriting a fault switch that could reach an owner Brain.
 */
export function assertDisposableRecoveryFieldCampaignIdentity(binding) {
  const { source, target } = binding;
  const expected = RECOVERY_TEST_FIELD_IDENTITY;
  if (source.clientSlug !== expected.clientSlug ||
      target.clientSlug !== expected.clientSlug ||
      source.clientDisplayName !== expected.clientDisplayName ||
      target.clientDisplayName !== expected.clientDisplayName ||
      source.productVersion !== expected.productVersion ||
      target.productVersion !== expected.productVersion ||
      source.adminKeySecret !== expected.sourceAdminKeySecret ||
      target.adminKeySecret !== expected.targetAdminKeySecret ||
      source.recoveryArtifactKeySecret !== null ||
      target.recoveryArtifactKeySecret !== expected.recoveryArtifactKeySecret ||
      source.recoveryFieldGate !== null || target.recoveryFieldGate !== null ||
      !exactDisposableRecoveryRuntime(source) ||
      !exactDisposableRecoveryRuntime(target) ||
      !noDisposableRecoveryConnectors(source) ||
      !noDisposableRecoveryConnectors(target) ||
      !exactWorkersDevIdentity(source, expected.sourceResource) ||
      !exactWorkersDevIdentity(target, expected.targetResource)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_IDENTITY_INVALID");
  }
  return true;
}

function testBootstrapCheckpointPath(pins) {
  return join(pins.artifacts.path, RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_NAME);
}

function testBootstrapCompletedCheckpointPath(pins) {
  return join(pins.artifacts.path, RECOVERY_TEST_BOOTSTRAP_COMPLETED_CHECKPOINT_NAME);
}

function testBootstrapPromotionAuthorizationPath(pins) {
  return join(pins.artifacts.path, RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_NAME);
}

function testBootstrapCompletedPromotionAuthorizationPath(pins) {
  return join(
    pins.artifacts.path,
    RECOVERY_TEST_BOOTSTRAP_COMPLETED_PROMOTION_AUTHORIZATION_NAME,
  );
}

function testBootstrapResumeAuthorizationPath(pins) {
  return join(pins.artifacts.path, RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_NAME);
}

function testBootstrapCompletedResumeAuthorizationPath(pins) {
  return join(
    pins.artifacts.path,
    RECOVERY_TEST_BOOTSTRAP_COMPLETED_RESUME_AUTHORIZATION_NAME,
  );
}

function assertTestBootstrapStateCoherence(state, checkpoint, promotionAuthorization = null) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_STATE_INVALID";
  if (!state || !Array.isArray(state.completed)) refuse(code);
  const midpoint = VERIFIED_RECOVERY_STAGES.findIndex((stage) => stage.id === "rebuild_vectorize");
  const completedIds = state.completed.map((entry) => entry?.id);
  const expectedBeforeMidpoint = VERIFIED_RECOVERY_STAGES
    .slice(0, midpoint).map((stage) => stage.id);
  if (checkpoint) {
    const exactFailedCheckpoint = state.status === "failed" &&
      state.stage_status === "failed" && state.failure?.stage === "rebuild_vectorize";
    // The hook fsyncs its checkpoint before the generic recovery runner records
    // the adapter failure. A power loss in that narrow window leaves this exact
    // already-persisted running state. The resumed adapter still proves the
    // paused target and exact remote epoch/cursor cut before its first POST.
    const exactPreFailureCrashCheckpoint = state.status === "running" &&
      state.stage_status === "running" && state.failure === null;
    const rebuildingAtCheckpoint = canonical(completedIds) ===
      canonical(expectedBeforeMidpoint) && state.current_stage === "rebuild_vectorize" &&
      Number.isSafeInteger(state.attempt) && state.attempt >= 1 &&
      (exactFailedCheckpoint || exactPreFailureCrashCheckpoint);
    const rebuildCompleted = completedIds[midpoint] === "rebuild_vectorize";
    const laterVerifiedPrefix = Boolean(promotionAuthorization) && rebuildCompleted &&
      completedIds.length >= midpoint + 1;
    if (!rebuildingAtCheckpoint && !laterVerifiedPrefix) refuse(code);
    return true;
  }
  const exactPrefix = canonical(completedIds) === canonical(expectedBeforeMidpoint);
  const firstAttempt = state.status === "running" && state.stage_status === "pending" &&
    state.failure === null && state.attempt === 0;
  const resumablePreCheckpointAttempt = Number.isSafeInteger(state.attempt) &&
    state.attempt >= 1 && Boolean(state.field_proof) &&
    ((state.status === "failed" && state.stage_status === "failed" &&
      state.failure?.stage === "rebuild_vectorize" &&
      state.failure?.cause !== RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_CODE) ||
     (state.status === "running" && state.stage_status === "running" &&
      state.failure === null));
  // The deployment receipt establishes isolation from the first preview/run.
  // The separate seed/interruption bundle can be armed only after ordinary
  // recovery has durably restored and reconciled D1 but before its first
  // Vectorize rebuild attempt.
  if (!exactPrefix || state.current_stage !== "rebuild_vectorize" ||
      (!firstAttempt && !resumablePreCheckpointAttempt)) refuse(code);
  return true;
}

function validateTestBootstrapCheckpoint(
  input,
  plan,
  candidateEvidence,
  approvalFingerprint,
  wrapperSha256,
) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID";
  exactAggregateReceiptFields(input, [
    "schema_version", "mode", "plan_fingerprint", "target_resource_fingerprint",
    "candidate_sha", "candidate_tree_sha", "field_receipt_sha256",
    "field_receipt_run_id", "package_filename", "package_bytes", "package_sha256",
    "package_file_count", "execution_inventory_sha256",
    ...RECOVERY_TEST_BOOTSTRAP_SEED_CONTROL_FIELDS,
    "wrangler_runtime_inventory_sha256", "wrangler_entrypoint",
    "wrangler_entrypoint_sha256", "wrangler_runtime_package_count",
    "wrangler_runtime_file_count", "wrangler_runtime_bytes",
    "wrangler_runtime_directory", "wrangler_runtime_schema_version",
    "wrangler_host_platform", "wrangler_host_arch", "wrangler_host_libc",
    "node_version", "node_executable_sha256", "wrangler_wrapper_sha256",
    "interruption_approval_fingerprint", "private_cursor_sha256", "observation",
  ], code);
  if (input.schema_version !== 7 ||
      input.mode !== RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE ||
      input.plan_fingerprint !== plan.plan_fingerprint ||
      input.target_resource_fingerprint !== plan.target_resource_fingerprint ||
      input.candidate_sha !== candidateEvidence.candidateSha ||
      input.candidate_tree_sha !== candidateEvidence.candidateTreeSha ||
      input.field_receipt_sha256 !== candidateEvidence.fieldReceiptSha256 ||
      input.field_receipt_run_id !== candidateEvidence.fieldReceiptRunId ||
      input.package_filename !== candidateEvidence.packageFilename ||
      input.package_bytes !== candidateEvidence.packageBytes ||
      input.package_sha256 !== candidateEvidence.packageSha256 ||
      input.package_file_count !== candidateEvidence.packageFileCount ||
      input.execution_inventory_sha256 !== candidateEvidence.executionInventorySha256 ||
      !testBootstrapSeedControlEvidenceMatches(input, candidateEvidence) ||
      input.wrangler_runtime_inventory_sha256 !==
        candidateEvidence.wranglerRuntimeInventorySha256 ||
      input.wrangler_entrypoint !== candidateEvidence.wranglerRuntimeEntrypoint ||
      input.wrangler_entrypoint_sha256 !==
        candidateEvidence.wranglerRuntimeEntrypointSha256 ||
      input.wrangler_runtime_package_count !==
        candidateEvidence.wranglerRuntimePackageCount ||
      input.wrangler_runtime_file_count !== candidateEvidence.wranglerRuntimeFileCount ||
      input.wrangler_runtime_bytes !== candidateEvidence.wranglerRuntimeBytes ||
      input.wrangler_runtime_directory !== candidateEvidence.wranglerRuntimeDirectory ||
      input.wrangler_runtime_schema_version !==
        candidateEvidence.wranglerRuntimeSchemaVersion ||
      input.wrangler_host_platform !== candidateEvidence.wranglerHostPlatform ||
      input.wrangler_host_arch !== candidateEvidence.wranglerHostArch ||
      input.wrangler_host_libc !== candidateEvidence.wranglerHostLibc ||
      input.node_version !== candidateEvidence.nodeVersion ||
      input.node_executable_sha256 !== candidateEvidence.nodeExecutableSha256 ||
      input.wrangler_wrapper_sha256 !== wrapperSha256 ||
      input.interruption_approval_fingerprint !== approvalFingerprint ||
      !SHA256_RE.test(String(input.private_cursor_sha256 || ""))) {
    refuse(code);
  }
  return Object.freeze({
    schema_version: 7,
    mode: input.mode,
    plan_fingerprint: input.plan_fingerprint,
    target_resource_fingerprint: input.target_resource_fingerprint,
    candidate_sha: input.candidate_sha,
    candidate_tree_sha: input.candidate_tree_sha,
    field_receipt_sha256: input.field_receipt_sha256,
    field_receipt_run_id: input.field_receipt_run_id,
    package_filename: input.package_filename,
    package_bytes: input.package_bytes,
    package_sha256: input.package_sha256,
    package_file_count: input.package_file_count,
    execution_inventory_sha256: input.execution_inventory_sha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256: input.wrangler_runtime_inventory_sha256,
    wrangler_entrypoint: input.wrangler_entrypoint,
    wrangler_entrypoint_sha256: input.wrangler_entrypoint_sha256,
    wrangler_runtime_package_count: input.wrangler_runtime_package_count,
    wrangler_runtime_file_count: input.wrangler_runtime_file_count,
    wrangler_runtime_bytes: input.wrangler_runtime_bytes,
    wrangler_runtime_directory: input.wrangler_runtime_directory,
    wrangler_runtime_schema_version: input.wrangler_runtime_schema_version,
    wrangler_host_platform: input.wrangler_host_platform,
    wrangler_host_arch: input.wrangler_host_arch,
    wrangler_host_libc: input.wrangler_host_libc,
    node_version: input.node_version,
    node_executable_sha256: input.node_executable_sha256,
    wrangler_wrapper_sha256: input.wrangler_wrapper_sha256,
    interruption_approval_fingerprint: input.interruption_approval_fingerprint,
    private_cursor_sha256: input.private_cursor_sha256,
    observation: validateTestBootstrapObservation(input.observation, {
      phase: "checkpoint",
      targetResourceFingerprint: plan.target_resource_fingerprint,
    }),
  });
}

function readTestBootstrapCheckpoint(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  wrapperSha256,
  path = testBootstrapCheckpointPath(pins),
) {
  if (!pathInfoOrAbsent(path, "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID")) {
    return null;
  }
  const checked = readStablePrivateFile(path, {
    code: "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID",
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
  });
  try {
    const checkpoint = validateTestBootstrapCheckpoint(
      JSON.parse(checked.raw.toString("utf8")),
      plan,
      candidateEvidence,
      approvalFingerprint,
      wrapperSha256,
    );
    return stablePrivateFileRecord(checked, checkpoint);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID");
  } finally {
    checked.raw.fill(0);
  }
}

function readCompletedTestBootstrapCheckpoint(pins, plan) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID";
  const path = testBootstrapCompletedCheckpointPath(pins);
  const checked = readStablePrivateFile(path, {
    code,
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
  });
  try {
    let input;
    try { input = JSON.parse(checked.raw.toString("utf8")); }
    catch { refuse(code); }
    const candidateEvidence = Object.freeze({
      candidateSha: input?.candidate_sha,
      candidateTreeSha: input?.candidate_tree_sha,
      fieldReceiptRunId: input?.field_receipt_run_id,
      fieldReceiptSha256: input?.field_receipt_sha256,
      packageFilename: input?.package_filename,
      packageBytes: input?.package_bytes,
      packageSha256: input?.package_sha256,
      packageFileCount: input?.package_file_count,
      executionInventorySha256: input?.execution_inventory_sha256,
      sourcePreflightReceiptSha256:
        input?.source_preflight_receipt_sha256,
      sourcePhaseReceiptSha256: input?.source_phase_receipt_sha256,
      deploymentReceiptSha256: input?.deployment_receipt_sha256,
      seedReceiptSha256: input?.seed_receipt_sha256,
      targetPreflightReceiptSha256:
        input?.target_preflight_receipt_sha256,
      seedFixtureSha256: input?.seed_fixture_sha256,
      seedD1ContentFingerprint: input?.seed_d1_content_fingerprint,
      seedDocumentCount: input?.seed_document_count,
      seedChunkCount: input?.seed_chunk_count,
      seedFtsCount: input?.seed_fts_count,
      seedVectorCount: input?.seed_vector_count,
      seedReplayUnchangedDocuments: input?.seed_replay_unchanged_documents,
      wranglerRuntimeInventorySha256: input?.wrangler_runtime_inventory_sha256,
      wranglerRuntimeEntrypoint: input?.wrangler_entrypoint,
      wranglerRuntimeEntrypointSha256: input?.wrangler_entrypoint_sha256,
      wranglerRuntimePackageCount: input?.wrangler_runtime_package_count,
      wranglerRuntimeFileCount: input?.wrangler_runtime_file_count,
      wranglerRuntimeBytes: input?.wrangler_runtime_bytes,
      wranglerRuntimeDirectory: input?.wrangler_runtime_directory,
      wranglerRuntimeSchemaVersion: input?.wrangler_runtime_schema_version,
      wranglerHostPlatform: input?.wrangler_host_platform,
      wranglerHostArch: input?.wrangler_host_arch,
      wranglerHostLibc: input?.wrangler_host_libc,
      nodeVersion: input?.node_version,
      nodeExecutableSha256: input?.node_executable_sha256,
    });
    const positiveIntegers = [
      candidateEvidence.packageBytes,
      candidateEvidence.packageFileCount,
      candidateEvidence.wranglerRuntimePackageCount,
      candidateEvidence.wranglerRuntimeFileCount,
      candidateEvidence.wranglerRuntimeBytes,
      candidateEvidence.wranglerRuntimeSchemaVersion,
      candidateEvidence.seedDocumentCount,
      candidateEvidence.seedChunkCount,
      candidateEvidence.seedFtsCount,
      candidateEvidence.seedVectorCount,
      candidateEvidence.seedReplayUnchangedDocuments,
    ];
    if (!/^[0-9a-f]{40}$/.test(String(candidateEvidence.candidateSha || "")) ||
        !/^[0-9a-f]{40}$/.test(String(candidateEvidence.candidateTreeSha || "")) ||
        !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(
          String(candidateEvidence.fieldReceiptRunId || ""),
        ) ||
        [
          candidateEvidence.fieldReceiptSha256,
          candidateEvidence.packageSha256,
          candidateEvidence.executionInventorySha256,
          candidateEvidence.sourcePreflightReceiptSha256,
          candidateEvidence.sourcePhaseReceiptSha256,
          candidateEvidence.deploymentReceiptSha256,
          candidateEvidence.seedReceiptSha256,
          candidateEvidence.targetPreflightReceiptSha256,
          candidateEvidence.seedFixtureSha256,
          candidateEvidence.seedD1ContentFingerprint,
          candidateEvidence.wranglerRuntimeInventorySha256,
          candidateEvidence.wranglerRuntimeEntrypointSha256,
          candidateEvidence.nodeExecutableSha256,
          input?.wrangler_wrapper_sha256,
        ].some((value) => !SHA256_RE.test(String(value || ""))) ||
        positiveIntegers.some((value) => !Number.isSafeInteger(value) || value < 1) ||
        candidateEvidence.seedFixtureSha256 !== DISPOSABLE_RECOVERY_FIXTURE_SHA256 ||
        candidateEvidence.seedDocumentCount !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
        candidateEvidence.seedChunkCount < MIN_RECOVERY_TEST_FIELD_CHUNKS ||
        candidateEvidence.seedFtsCount !== candidateEvidence.seedChunkCount ||
        candidateEvidence.seedVectorCount !== candidateEvidence.seedChunkCount ||
        candidateEvidence.seedReplayUnchangedDocuments !==
          DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
        candidateEvidence.packageFilename !== "brain-installer-0.4.8.tgz" ||
        candidateEvidence.wranglerRuntimeDirectory !==
          LOCKED_WRANGLER_RUNTIME_DIRECTORY ||
        candidateEvidence.wranglerRuntimeEntrypoint !== LOCKED_WRANGLER_ENTRYPOINT ||
        candidateEvidence.wranglerHostPlatform !== "darwin" ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(
          String(candidateEvidence.wranglerHostArch || ""),
        ) ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(
          String(candidateEvidence.wranglerHostLibc || ""),
        ) ||
        !/^v\d+\.\d+\.\d+$/.test(String(candidateEvidence.nodeVersion || "")) ||
        input?.wrangler_wrapper_sha256 !== pins.wrapper.hash) {
      refuse(code);
    }
    const approvalFingerprint = testBootstrapInterruptionApprovalFingerprint(
      plan,
      candidateEvidence,
      pins.wrapper.hash,
    );
    if (input?.interruption_approval_fingerprint !== approvalFingerprint) refuse(code);
    let checkpoint;
    try {
      checkpoint = validateTestBootstrapCheckpoint(
        input,
        plan,
        candidateEvidence,
        approvalFingerprint,
        pins.wrapper.hash,
      );
    } catch {
      refuse(code);
    }
    return Object.freeze({
      checkpointRecord: stablePrivateFileRecord(checked, checkpoint),
      candidateEvidence,
      approvalFingerprint,
    });
  } finally {
    checked.raw.fill(0);
  }
}

function writeTestBootstrapCheckpoint(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  privateCursorSha256,
  observation,
) {
  const path = testBootstrapCheckpointPath(pins);
  const checkpoint = validateTestBootstrapCheckpoint({
    schema_version: 7,
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    plan_fingerprint: plan.plan_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    candidate_sha: candidateEvidence.candidateSha,
    candidate_tree_sha: candidateEvidence.candidateTreeSha,
    field_receipt_sha256: candidateEvidence.fieldReceiptSha256,
    field_receipt_run_id: candidateEvidence.fieldReceiptRunId,
    package_filename: candidateEvidence.packageFilename,
    package_bytes: candidateEvidence.packageBytes,
    package_sha256: candidateEvidence.packageSha256,
    package_file_count: candidateEvidence.packageFileCount,
    execution_inventory_sha256: candidateEvidence.executionInventorySha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256:
      candidateEvidence.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidateEvidence.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidateEvidence.wranglerRuntimeEntrypointSha256,
    wrangler_runtime_package_count: candidateEvidence.wranglerRuntimePackageCount,
    wrangler_runtime_file_count: candidateEvidence.wranglerRuntimeFileCount,
    wrangler_runtime_bytes: candidateEvidence.wranglerRuntimeBytes,
    wrangler_runtime_directory: candidateEvidence.wranglerRuntimeDirectory,
    wrangler_runtime_schema_version: candidateEvidence.wranglerRuntimeSchemaVersion,
    wrangler_host_platform: candidateEvidence.wranglerHostPlatform,
    wrangler_host_arch: candidateEvidence.wranglerHostArch,
    wrangler_host_libc: candidateEvidence.wranglerHostLibc,
    node_version: candidateEvidence.nodeVersion,
    node_executable_sha256: candidateEvidence.nodeExecutableSha256,
    wrangler_wrapper_sha256: pins.wrapper.hash,
    interruption_approval_fingerprint: approvalFingerprint,
    private_cursor_sha256: privateCursorSha256,
    observation,
  }, plan, candidateEvidence, approvalFingerprint, pins.wrapper.hash);
  let descriptor;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(checkpoint)}\n`, "utf8");
    if (bytes.length > MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_INVALID");
    }
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_WRITE_FAILED");
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(pins.artifacts.path);
  return readTestBootstrapCheckpoint(
    pins,
    plan,
    candidateEvidence,
    approvalFingerprint,
    pins.wrapper.hash,
  );
}

function validateTestBootstrapResumeAuthorization(
  input,
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID";
  const checkpoint = checkpointRecord?.value ?? null;
  exactAggregateReceiptFields(input, [
    "schema_version", "mode", "plan_fingerprint", "target_resource_fingerprint",
    "candidate_sha", "field_receipt_sha256", "package_sha256",
    "execution_inventory_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_entrypoint", "wrangler_entrypoint_sha256",
    ...RECOVERY_TEST_BOOTSTRAP_SEED_CONTROL_FIELDS,
    "interruption_approval_fingerprint",
    "checkpoint_sha256", "private_cursor_sha256", "observation",
  ], code);
  if (!checkpoint || !restored || input.schema_version !== 3 ||
      input.mode !== RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE ||
      input.plan_fingerprint !== plan.plan_fingerprint ||
      input.target_resource_fingerprint !== plan.target_resource_fingerprint ||
      input.candidate_sha !== candidateEvidence.candidateSha ||
      input.field_receipt_sha256 !== candidateEvidence.fieldReceiptSha256 ||
      input.package_sha256 !== candidateEvidence.packageSha256 ||
      input.execution_inventory_sha256 !== candidateEvidence.executionInventorySha256 ||
      !testBootstrapSeedControlEvidenceMatches(input, candidateEvidence) ||
      input.wrangler_runtime_inventory_sha256 !==
        candidateEvidence.wranglerRuntimeInventorySha256 ||
      input.wrangler_entrypoint !== candidateEvidence.wranglerRuntimeEntrypoint ||
      input.wrangler_entrypoint_sha256 !==
        candidateEvidence.wranglerRuntimeEntrypointSha256 ||
      input.interruption_approval_fingerprint !== approvalFingerprint ||
      input.checkpoint_sha256 !== checkpointRecord.pin.hash ||
      input.private_cursor_sha256 !== checkpoint.private_cursor_sha256) {
    refuse(code);
  }
  return Object.freeze({
    schema_version: 3,
    mode: input.mode,
    plan_fingerprint: input.plan_fingerprint,
    target_resource_fingerprint: input.target_resource_fingerprint,
    candidate_sha: input.candidate_sha,
    field_receipt_sha256: input.field_receipt_sha256,
    package_sha256: input.package_sha256,
    execution_inventory_sha256: input.execution_inventory_sha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256: input.wrangler_runtime_inventory_sha256,
    wrangler_entrypoint: input.wrangler_entrypoint,
    wrangler_entrypoint_sha256: input.wrangler_entrypoint_sha256,
    interruption_approval_fingerprint: input.interruption_approval_fingerprint,
    checkpoint_sha256: input.checkpoint_sha256,
    private_cursor_sha256: input.private_cursor_sha256,
    observation: validateTestBootstrapObservation(input.observation, {
      phase: "resume",
      targetResourceFingerprint: plan.target_resource_fingerprint,
      restored,
      checkpoint,
    }),
  });
}

function readTestBootstrapResumeAuthorization(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
  path = testBootstrapResumeAuthorizationPath(pins),
) {
  if (!pathInfoOrAbsent(
    path,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID",
  )) return null;
  const checked = readStablePrivateFile(path, {
    code: "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID",
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES,
  });
  try {
    const authorization = validateTestBootstrapResumeAuthorization(
      JSON.parse(checked.raw.toString("utf8")),
      pins,
      plan,
      candidateEvidence,
      approvalFingerprint,
      checkpointRecord,
      restored,
    );
    return stablePrivateFileRecord(checked, authorization);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID");
  } finally {
    checked.raw.fill(0);
  }
}

function writeTestBootstrapResumeAuthorization(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
  privateCursorSha256,
  observation,
) {
  const path = testBootstrapResumeAuthorizationPath(pins);
  const authorization = validateTestBootstrapResumeAuthorization({
    schema_version: 3,
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    plan_fingerprint: plan.plan_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    candidate_sha: candidateEvidence.candidateSha,
    field_receipt_sha256: candidateEvidence.fieldReceiptSha256,
    package_sha256: candidateEvidence.packageSha256,
    execution_inventory_sha256: candidateEvidence.executionInventorySha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256:
      candidateEvidence.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidateEvidence.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidateEvidence.wranglerRuntimeEntrypointSha256,
    interruption_approval_fingerprint: approvalFingerprint,
    checkpoint_sha256: checkpointRecord?.pin?.hash,
    private_cursor_sha256: privateCursorSha256,
    observation,
  }, pins, plan, candidateEvidence, approvalFingerprint, checkpointRecord, restored);
  let descriptor;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(authorization)}\n`, "utf8");
    if (bytes.length > MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID");
    }
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_WRITE_FAILED");
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(pins.artifacts.path);
  return readTestBootstrapResumeAuthorization(
    pins,
    plan,
    candidateEvidence,
    approvalFingerprint,
    checkpointRecord,
    restored,
  );
}

function validateTestBootstrapPromotionAuthorization(
  input,
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID";
  const checkpoint = checkpointRecord?.value ?? null;
  exactAggregateReceiptFields(input, [
    "schema_version", "mode", "plan_fingerprint", "target_resource_fingerprint",
    "candidate_sha", "field_receipt_sha256", "package_sha256",
    "execution_inventory_sha256", "wrangler_runtime_inventory_sha256",
    "wrangler_entrypoint", "wrangler_entrypoint_sha256",
    ...RECOVERY_TEST_BOOTSTRAP_SEED_CONTROL_FIELDS,
    "interruption_approval_fingerprint",
    "active_worker_version_id", "checkpoint_sha256", "private_cursor_sha256",
    "observation",
  ], code);
  if (!checkpoint || !restored || input.schema_version !== 3 ||
      input.mode !== RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE ||
      input.plan_fingerprint !== plan.plan_fingerprint ||
      input.target_resource_fingerprint !== plan.target_resource_fingerprint ||
      input.candidate_sha !== candidateEvidence.candidateSha ||
      input.field_receipt_sha256 !== candidateEvidence.fieldReceiptSha256 ||
      input.package_sha256 !== candidateEvidence.packageSha256 ||
      input.execution_inventory_sha256 !== candidateEvidence.executionInventorySha256 ||
      !testBootstrapSeedControlEvidenceMatches(input, candidateEvidence) ||
      input.wrangler_runtime_inventory_sha256 !==
        candidateEvidence.wranglerRuntimeInventorySha256 ||
      input.wrangler_entrypoint !== candidateEvidence.wranglerRuntimeEntrypoint ||
      input.wrangler_entrypoint_sha256 !==
        candidateEvidence.wranglerRuntimeEntrypointSha256 ||
      input.interruption_approval_fingerprint !== approvalFingerprint ||
      input.active_worker_version_id !== pins.isolation.activeWorkerVersionId ||
      input.checkpoint_sha256 !== checkpointRecord.pin.hash ||
      !SHA256_RE.test(String(input.private_cursor_sha256 || ""))) {
    refuse(code);
  }
  return Object.freeze({
    schema_version: 3,
    mode: input.mode,
    plan_fingerprint: input.plan_fingerprint,
    target_resource_fingerprint: input.target_resource_fingerprint,
    candidate_sha: input.candidate_sha,
    field_receipt_sha256: input.field_receipt_sha256,
    package_sha256: input.package_sha256,
    execution_inventory_sha256: input.execution_inventory_sha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256: input.wrangler_runtime_inventory_sha256,
    wrangler_entrypoint: input.wrangler_entrypoint,
    wrangler_entrypoint_sha256: input.wrangler_entrypoint_sha256,
    interruption_approval_fingerprint: input.interruption_approval_fingerprint,
    active_worker_version_id: input.active_worker_version_id,
    checkpoint_sha256: input.checkpoint_sha256,
    private_cursor_sha256: input.private_cursor_sha256,
    observation: validateTestBootstrapObservation(input.observation, {
      phase: "promotion",
      targetResourceFingerprint: plan.target_resource_fingerprint,
      restored,
      checkpoint,
    }),
  });
}

function readTestBootstrapPromotionAuthorization(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
  path = testBootstrapPromotionAuthorizationPath(pins),
) {
  if (!pathInfoOrAbsent(
    path,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID",
  )) return null;
  const checked = readStablePrivateFile(path, {
    code: "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID",
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES,
  });
  try {
    const authorization = validateTestBootstrapPromotionAuthorization(
      JSON.parse(checked.raw.toString("utf8")),
      pins,
      plan,
      candidateEvidence,
      approvalFingerprint,
      checkpointRecord,
      restored,
    );
    return stablePrivateFileRecord(checked, authorization);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID");
  } finally {
    checked.raw.fill(0);
  }
}

function writeTestBootstrapPromotionAuthorization(
  pins,
  plan,
  candidateEvidence,
  approvalFingerprint,
  checkpointRecord,
  restored,
  privateCursorSha256,
  observation,
) {
  const path = testBootstrapPromotionAuthorizationPath(pins);
  const authorization = validateTestBootstrapPromotionAuthorization({
    schema_version: 3,
    mode: RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE,
    plan_fingerprint: plan.plan_fingerprint,
    target_resource_fingerprint: plan.target_resource_fingerprint,
    candidate_sha: candidateEvidence.candidateSha,
    field_receipt_sha256: candidateEvidence.fieldReceiptSha256,
    package_sha256: candidateEvidence.packageSha256,
    execution_inventory_sha256: candidateEvidence.executionInventorySha256,
    ...testBootstrapSeedControlEvidence(candidateEvidence),
    wrangler_runtime_inventory_sha256:
      candidateEvidence.wranglerRuntimeInventorySha256,
    wrangler_entrypoint: candidateEvidence.wranglerRuntimeEntrypoint,
    wrangler_entrypoint_sha256: candidateEvidence.wranglerRuntimeEntrypointSha256,
    interruption_approval_fingerprint: approvalFingerprint,
    active_worker_version_id: pins.isolation.activeWorkerVersionId,
    checkpoint_sha256: checkpointRecord?.pin?.hash,
    private_cursor_sha256: privateCursorSha256,
    observation,
  }, pins, plan, candidateEvidence, approvalFingerprint, checkpointRecord, restored);
  let descriptor;
  let bytes;
  try {
    bytes = Buffer.from(`${JSON.stringify(authorization)}\n`, "utf8");
    if (bytes.length > MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID");
    }
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_WRITE_FAILED");
  } finally {
    bytes?.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
  syncDirectory(pins.artifacts.path);
  return readTestBootstrapPromotionAuthorization(
    pins,
    plan,
    candidateEvidence,
    approvalFingerprint,
    checkpointRecord,
    restored,
  );
}

function retirePinnedTestBootstrapControlFile({
  active,
  completed,
  record,
  maxBytes,
}) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_RETIRE_FAILED";
  if (!record?.pin || ![resolve(active), resolve(completed)].includes(record.pin.path)) {
    refuse(code);
  }
  assertStablePrivateFileRecord(record, { code, maxBytes });
  if (record.pin.path === resolve(completed)) {
    assertPathAbsent(active, code);
    return record;
  }
  assertPathAbsent(completed, code);
  try {
    renameSync(active, completed);
    syncDirectory(dirname(completed));
  } catch {
    refuse(code);
  }
  assertPathAbsent(active, code);
  const moved = movedStablePrivateFileRecord(record, completed, { code, maxBytes });
  assertStablePrivateFileRecord(moved, { code, maxBytes });
  return moved;
}

function retireTestBootstrapCheckpoint(
  pins,
  checkpointRecord,
  resumeAuthorizationRecord,
  promotionAuthorizationRecord,
) {
  if (!checkpointRecord || !resumeAuthorizationRecord || !promotionAuthorizationRecord) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_RETIRE_FAILED");
  }
  // Move both live phase authorizations first and the checkpoint last. At
  // every crash cut at least one active control file therefore remains, so an
  // ordinary recovery cannot mistake a partially retired campaign for clean
  // state. A bound special retry can finish these exact inode-preserving moves.
  const resume = retirePinnedTestBootstrapControlFile({
    active: testBootstrapResumeAuthorizationPath(pins),
    completed: testBootstrapCompletedResumeAuthorizationPath(pins),
    record: resumeAuthorizationRecord,
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES,
  });
  const promotion = retirePinnedTestBootstrapControlFile({
    active: testBootstrapPromotionAuthorizationPath(pins),
    completed: testBootstrapCompletedPromotionAuthorizationPath(pins),
    record: promotionAuthorizationRecord,
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES,
  });
  const checkpoint = retirePinnedTestBootstrapControlFile({
    active: testBootstrapCheckpointPath(pins),
    completed: testBootstrapCompletedCheckpointPath(pins),
    record: checkpointRecord,
    maxBytes: MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
  });
  return Object.freeze({ checkpoint, resume, promotion });
}

function inspectRecoveryIsolationClaim(binding, targetResourceFingerprint) {
  const claim = binding.recoveryFieldGate;
  const keys = claim && typeof claim === "object" && !Array.isArray(claim)
    ? Object.keys(claim).sort()
    : [];
  if (canonical(keys) !== canonical([
    "active_worker_script_etag", "active_worker_version_id", "custom_domains",
    "paused_worker_script_etag", "paused_worker_version_id", "reviewed_at", "routes",
  ])) {
    refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
  }
  const pausedWorkerVersionId = exactString(
    claim.paused_worker_version_id,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const activeWorkerVersionId = exactString(
    claim.active_worker_version_id,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const pausedWorkerScriptEtag = exactString(
    claim.paused_worker_script_etag,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const activeWorkerScriptEtag = exactString(
    claim.active_worker_script_etag,
    "RECOVERY_TARGET_EXECUTION_UNREVIEWED",
  );
  const reviewedAt = new Date(claim.reviewed_at);
  if (!Array.isArray(claim.routes) || claim.routes.length !== 0 ||
      !Array.isArray(claim.custom_domains) || claim.custom_domains.length !== 0 ||
      !WORKER_VERSION_RE.test(pausedWorkerVersionId) ||
      !WORKER_VERSION_RE.test(activeWorkerVersionId) ||
      pausedWorkerVersionId === activeWorkerVersionId ||
      pausedWorkerScriptEtag.length > 256 ||
      activeWorkerScriptEtag.length > 256 ||
      typeof claim.reviewed_at !== "string" ||
      !Number.isFinite(reviewedAt.getTime()) || reviewedAt.toISOString() !== claim.reviewed_at) {
    refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
  }
  return Object.freeze({
    pausedWorkerVersionId,
    activeWorkerVersionId,
    pausedWorkerScriptEtag,
    activeWorkerScriptEtag,
    approvalFingerprint: sha256(canonical({
      target_resource_fingerprint: targetResourceFingerprint,
      paused_worker_version_id: pausedWorkerVersionId,
      paused_worker_script_etag: pausedWorkerScriptEtag,
      active_worker_version_id: activeWorkerVersionId,
      active_worker_script_etag: activeWorkerScriptEtag,
      reviewed_at: claim.reviewed_at,
      routes: [],
      custom_domains: [],
    })),
  });
}

function inspectDisposableDeploymentIsolationClaim(receipt, receiptSha256, plan) {
  const code = "RECOVERY_TARGET_EXECUTION_UNREVIEWED";
  try { assertDisposableRecoveryDeploymentReceipt(receipt); } catch { refuse(code); }
  const pausedWorkerVersionId = receipt.target.paused_version.version_id;
  const activeWorkerVersionId = receipt.target.active_version.version_id;
  const pausedWorkerScriptEtag = receipt.target.paused_version.script_etag;
  const activeWorkerScriptEtag = receipt.target.active_version.script_etag;
  const sourceActiveWorkerVersionId = receipt.source.active_version_id;
  const sourceWorkerScriptEtag = receipt.source.active_script_etag;
  if (!SHA256_RE.test(String(receiptSha256 || "")) ||
      receipt.binding.plan_fingerprint !== plan.plan_fingerprint ||
      receipt.binding.source_manifest_fingerprint !== plan.source_manifest_fingerprint ||
      receipt.binding.source_resource_fingerprint !== plan.source_resource_fingerprint ||
      receipt.binding.target_manifest_fingerprint !== plan.target_manifest_fingerprint ||
      receipt.binding.target_resource_fingerprint !== plan.target_resource_fingerprint ||
      receipt.binding.runtime_contract_fingerprint !== plan.runtime_contract_fingerprint ||
      receipt.source.resource_fingerprint !== plan.source_resource_fingerprint ||
      receipt.target.resource_fingerprint !== plan.target_resource_fingerprint ||
      !WORKER_VERSION_RE.test(pausedWorkerVersionId) ||
      !WORKER_VERSION_RE.test(activeWorkerVersionId) ||
      pausedWorkerVersionId === activeWorkerVersionId ||
      pausedWorkerScriptEtag.length > 256 ||
      activeWorkerScriptEtag.length > 256) {
    refuse(code);
  }
  return Object.freeze({
    pausedWorkerVersionId,
    activeWorkerVersionId,
    pausedWorkerScriptEtag,
    activeWorkerScriptEtag,
    sourceActiveWorkerVersionId,
    sourceWorkerScriptEtag,
    approvalFingerprint: sha256(canonical({
      schema_version: 2,
      purpose: "v048_disposable_recovery_target_execution",
      plan_fingerprint: plan.plan_fingerprint,
      source_phase_receipt_sha256: receipt.source_phase_receipt_sha256,
      seed_receipt_sha256: receipt.seed_receipt_sha256,
      target_preflight_receipt_sha256:
        receipt.target_preflight_receipt_sha256,
      deployment_receipt_sha256: receiptSha256,
      target_resource_fingerprint: plan.target_resource_fingerprint,
      paused_worker_version_id: pausedWorkerVersionId,
      paused_worker_script_etag: pausedWorkerScriptEtag,
      active_worker_version_id: activeWorkerVersionId,
      active_worker_script_etag: activeWorkerScriptEtag,
      final_snapshot_semantic_sha256:
        receipt.final_snapshot.stable_semantic_sha256,
    })),
  });
}

function inspectGolden(path) {
  const loaded = readStablePrivateFile(path, {
    code: "RECOVERY_RELEASE_EVAL_UNSAFE",
    maxBytes: MAX_GOLDEN_BYTES,
  });
  let parsed;
  try { parsed = JSON.parse(loaded.raw.toString("utf8")); } catch {
    refuse("RECOVERY_RELEASE_EVAL_INVALID");
  }
  let coverage;
  try {
    validateGolden(parsed, "private release golden");
    coverage = evaluateProfileCoverage(parsed, "release");
  } catch {
    refuse("RECOVERY_RELEASE_EVAL_INVALID");
  }
  if (coverage.failures.length > 0) refuse("RECOVERY_RELEASE_EVAL_INCOMPLETE");
  return Object.freeze({ path: loaded.path, hash: loaded.hash, info: loaded.info });
}

export function inspectRecoveryWranglerWrapper(path) {
  const parentPath = dirname(resolve(path || ""));
  let parent;
  try { parent = lstatSync(parentPath); } catch {
    refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  }
  if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (process.platform !== "win32" && (parent.mode & 0o022) !== 0)) {
    refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  }
  assertOwned(parent, "RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  let canonicalParent;
  try { canonicalParent = realpathSync(parentPath); } catch {
    refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  }
  if (canonicalParent !== parentPath) refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
  assertNoDarwinReceiptAcl(parentPath, parent, {
    code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
  });
  const loaded = readStablePrivateFile(path, {
    code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
    maxBytes: MAX_WRAPPER_BYTES,
    executable: true,
  });
  assertNoDarwinReceiptAcl(loaded.path, loaded.info, {
    code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
  });
  return Object.freeze({
    path: loaded.path,
    hash: loaded.hash,
    info: loaded.info,
    raw: Buffer.from(loaded.raw),
    parent: Object.freeze({
      path: parentPath,
      dev: parent.dev,
      ino: parent.ino,
      mode: parent.mode,
      uid: parent.uid,
    }),
  });
}

const inspectWrapper = inspectRecoveryWranglerWrapper;

function assertTestBootstrapWrapperRuntimeContract(wrapper) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRAPPER_CONTRACT_INVALID";
  let text;
  try { text = wrapper.raw.toString("utf8"); }
  catch { refuse(code); }
  // The field path has no ambient Cloudflare token. Its only accepted shell
  // program is a fixed five-line trampoline: one literal, safely quoted
  // Keychain lookup; a non-empty check; export; and the pinned Node exec. The
  // private account/service locator may vary, but its grammar cannot execute
  // shell syntax. The full wrapper bytes are also approval-bound.
  const lines = text.split("\n");
  if (Buffer.byteLength(text, "utf8") !== wrapper.raw.length ||
      lines.length !== 6 || lines[5] !== "" || lines[0] !== "#!/bin/sh" ||
      !RECOVERY_TEST_WRANGLER_WRAPPER_TOKEN_LINE_RE.test(lines[1]) ||
      lines[2] !== `[ -n "$${RECOVERY_TEST_CLOUDFLARE_TOKEN_NAME}" ] || exit 125` ||
      lines[3] !== `export ${RECOVERY_TEST_CLOUDFLARE_TOKEN_NAME}` ||
      lines[4] !== RECOVERY_TEST_WRANGLER_WRAPPER_EXEC_LINE) {
    refuse(code);
  }
  return true;
}

function syncDirectory(path) {
  if (process.platform === "win32") return;
  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function removeKnownPartial(path, artifactDirectory) {
  const absolute = resolve(path);
  if (dirname(absolute) !== artifactDirectory || !basename(absolute).startsWith(".brain-recovery-export.sql.tmp-")) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  if (!existsSync(absolute)) return;
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  assertOwned(info, "RECOVERY_EXPORT_PARTIAL_UNSAFE");
  unlinkSync(absolute);
  syncDirectory(artifactDirectory);
}

function assertNoKnownPlaintextPartial(path, artifactDirectory) {
  const absolute = resolve(path);
  if (dirname(absolute) !== artifactDirectory ||
      !basename(absolute).startsWith(".brain-recovery-export.sql.tmp-")) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  if (!existsSync(absolute)) return;
  const info = lstatSync(absolute);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
  }
  assertOwned(info, "RECOVERY_EXPORT_PARTIAL_UNSAFE");
  refuse("RECOVERY_EXPORT_PLAINTEXT_RESIDUE_REVIEW_REQUIRED");
}

function reconcileExportResidue(artifactPath, dataPartial, combinedPartial, artifactDirectory, maxBytes) {
  // These partials contain plaintext corpus bytes. An interrupted run must
  // leave them for explicit owner review rather than silently deleting them.
  if (existsSync(dataPartial) || existsSync(combinedPartial)) {
    for (const partial of [dataPartial, combinedPartial].filter(existsSync)) {
      const info = lstatSync(partial);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
        refuse("RECOVERY_EXPORT_PARTIAL_UNSAFE");
      }
      assertOwned(info, "RECOVERY_EXPORT_PARTIAL_UNSAFE");
    }
    refuse("RECOVERY_EXPORT_PLAINTEXT_RESIDUE_REVIEW_REQUIRED");
  }
  if (!existsSync(artifactPath)) return false;
  let finalInfo;
  try { finalInfo = lstatSync(artifactPath); } catch {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  if (!finalInfo.isFile() || finalInfo.isSymbolicLink()) {
    refuse("RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  }
  assertOwnerOnly(finalInfo, "RECOVERY_EXPORT_ARTIFACT_UNSAFE");
  assertArtifactFile(artifactPath, { maxBytes });
  return true;
}

function wrapperEnvironment(
  accountId,
  callDirectory,
  environment = process.env,
  wranglerRuntime = null,
) {
  const keychain = keychainChildEnvironment(environment);
  return Object.freeze({
    ...keychain,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin",
    CLOUDFLARE_ACCOUNT_ID: String(accountId),
    // Wrangler 4 suppresses command stdout, including --json and --version,
    // when WRANGLER_LOG is "none" or "error". "log" preserves the machine
    // response while WRANGLER_LOG_SANITIZE and the owner-only temp directory
    // keep diagnostic material bounded and private.
    WRANGLER_LOG: "log",
    WRANGLER_LOG_SANITIZE: "true",
    WRANGLER_LOG_PATH: join(callDirectory, "logs"),
    WRANGLER_SEND_METRICS: "false",
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...(wranglerRuntime ? {
      BRAIN_RECOVERY_NODE: process.execPath,
      BRAIN_RECOVERY_WRANGLER_ENTRYPOINT: wranglerRuntime.entrypointPath,
      BRAIN_RECOVERY_WRANGLER_RESOLUTION_GUARD:
        wranglerRuntime.resolutionGuardPath,
    } : {}),
  });
}

function isAllowedWranglerCommand(args, approvedMutation = null) {
  if (SAFE_WRANGLER_PREFIXES.some((prefix) =>
    prefix.length <= args.length && prefix.every((part, index) => args[index] === part))) {
    return true;
  }
  // The only state-changing Wrangler command in this adapter promotes one
  // already-uploaded version to 100 percent. A shape check is insufficient:
  // bind the version and Worker to the separately approved execution claim.
  return Array.isArray(approvedMutation) &&
    canonical(args) === canonical(approvedMutation);
}

function normalizedChildResult(result) {
  return {
    status: Number.isInteger(result?.status) ? result.status : null,
    signal: result?.signal || null,
    error: result?.error || null,
    stdout: Buffer.isBuffer(result?.stdout)
      ? result.stdout
      : Buffer.from(String(result?.stdout ?? ""), "utf8"),
    stderr: Buffer.isBuffer(result?.stderr)
      ? result.stderr
      : Buffer.from(String(result?.stderr ?? ""), "utf8"),
  };
}

function defaultRunWrangler({ command, args, env, cwd, timeoutMs }) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: null,
    maxBuffer: MAX_PROVIDER_JSON_BYTES,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

function parseProviderJson(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2 || buffer.length > MAX_PROVIDER_JSON_BYTES) {
    refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
  }
  try { return JSON.parse(buffer.toString("utf8")); } catch {
    refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
  }
}

function d1ResultRows(payload) {
  const envelopes = Array.isArray(payload) ? payload : [payload];
  if (envelopes.length !== 1 || !envelopes[0] || typeof envelopes[0] !== "object" ||
      envelopes[0].success === false || !Array.isArray(envelopes[0].results)) {
    refuse("RECOVERY_D1_RESPONSE_INVALID");
  }
  return envelopes[0].results;
}

function nonNegativeInteger(value, code = "RECOVERY_AGGREGATE_INVALID") {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 0) refuse(code);
  return number;
}

function exactString(value, code) {
  const text = String(value ?? "");
  if (!text || text.length > 1024 || CONTROL_RE.test(text)) refuse(code);
  return text;
}

function migrationFileContract() {
  const files = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort();
  return files.map((name) => {
    const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), "utf8");
    return Object.freeze({
      version: Number.parseInt(name.split("_")[0], 10),
      name: name.replace(/\.sql$/, ""),
      checksum: sha256(sql).slice(0, 16),
      sql,
    });
  });
}

function validateMigrationContract(rows) {
  if (!Array.isArray(rows) || rows.length < 1) refuse("RECOVERY_MIGRATION_CONTRACT_INVALID");
  const available = migrationFileContract();
  const selected = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const version = nonNegativeInteger(row?.version, "RECOVERY_MIGRATION_CONTRACT_INVALID");
    const name = exactString(row?.name, "RECOVERY_MIGRATION_CONTRACT_INVALID");
    const checksum = String(row?.checksum ?? "");
    const local = available[index];
    if (version !== index + 1 || !local || local.version !== version || local.name !== name ||
        local.checksum !== checksum) {
      refuse("RECOVERY_MIGRATION_CONTRACT_INVALID");
    }
    selected.push(local);
  }
  return Object.freeze(selected);
}

function expectedInstallStateColumns(migrations) {
  const latest = migrations.at(-1)?.version || 0;
  return Object.freeze([
    ...INSTALL_STATE_BASE_COLUMNS,
    ...(latest >= 10 ? ["outbox_generation"] : []),
    ...(latest >= 11 ? INSTALL_STATE_LEASE_COLUMNS : []),
    ...(latest >= 12 ? INSTALL_STATE_PROJECTION_COLUMNS : []),
    ...(latest >= 13 ? INSTALL_STATE_BOOTSTRAP_V2_COLUMNS : []),
    ...(latest >= 14 ? ["session_generation"] : []),
    ...(latest >= 36 ? ["vector_projection_residue_epoch"] : []),
    ...(latest >= 45 ? ["source_original_retrieval_generation"] : []),
  ]);
}

function recoverySqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string" && value.length <= 1024 * 1024 && !value.includes("\0")) {
    return `'${value.replaceAll("'", "''")}'`;
  }
  refuse("RECOVERY_INSTALL_STATE_INVALID");
}

/**
 * Serialize the singleton install row without ever selecting live derived-index
 * coordination state.
 *
 * Wrangler's table export has no column projection. Exporting install_state
 * directly would therefore persist an opaque invocation owner or a source
 * Vectorize changeset in a resumable artifact. Read the reviewed schema first,
 * project ephemeral fields to SQL NULL, and build one bounded INSERT. Older
 * prefix schemas use the same path without referencing absent columns.
 */
export async function normalizedInstallStateExport(
  binding,
  migrations,
  readRows,
  { sessionGenerationMode = "increment" } = {},
) {
  if (!new Set(["increment", "preserve"]).has(sessionGenerationMode)) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const expectedColumns = expectedInstallStateColumns(migrations);
  const schema = await readRows(binding, "PRAGMA table_info(install_state)");
  if (!Array.isArray(schema) || schema.length !== expectedColumns.length) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const ordered = [...schema].sort((left, right) => Number(left?.cid) - Number(right?.cid));
  if (ordered.some((column, index) =>
    !column || column.name !== expectedColumns[index] ||
    !["INTEGER", "TEXT"].includes(String(column.type || "").toUpperCase()))) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const recoveryValue = (name, row = null) => {
    if (INSTALL_STATE_NULL_NORMALIZED_COLUMNS.includes(name)) return null;
    if (INSTALL_STATE_ZERO_NORMALIZED_COLUMNS.includes(name)) return 0;
    return row?.[name];
  };
  const projection = expectedColumns.map((name) => {
    if (name === "session_generation" && sessionGenerationMode === "increment") {
      // Recovery must invalidate every cookie minted against the source. Start
      // from a valid positive generation, advance it exactly once in the
      // artifact, then preserve that restored value during target readback.
      return `CASE WHEN session_generation BETWEEN 1 AND ${Number.MAX_SAFE_INTEGER - 1} ` +
        `THEN session_generation + 1 ELSE NULL END AS ${quoteIdentifier(name)}`;
    }
    if (name === "vector_projection_status") {
      return `CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 'bootstrap_required' ELSE 'verified' END AS ${quoteIdentifier(name)}`;
    }
    if (name === "vector_projection_bootstrap_epoch") {
      return `CASE WHEN EXISTS (SELECT 1 FROM chunks) THEN 1 ELSE 0 END AS ${quoteIdentifier(name)}`;
    }
    if (name === "vector_projection_bootstrap_high_water") {
      return `(SELECT MAX(chunk_uid) FROM chunks) AS ${quoteIdentifier(name)}`;
    }
    const normalized = recoveryValue(name);
    if (normalized === null) return `NULL AS ${quoteIdentifier(name)}`;
    if (normalized !== undefined) {
      return `${recoverySqlLiteral(normalized)} AS ${quoteIdentifier(name)}`;
    }
    return quoteIdentifier(name);
  });
  const rows = await readRows(
    binding,
    `SELECT ${projection.join(",")} FROM install_state ORDER BY id`,
  );
  if (!Array.isArray(rows) || rows.length !== 1) refuse("RECOVERY_INSTALL_STATE_INVALID");
  const row = rows[0];
  const hasCorpus = row?.vector_projection_bootstrap_high_water !== null;
  if (!row || typeof row !== "object" || Array.isArray(row) || Number(row.id) !== 1 ||
      expectedColumns.some((name) => !Object.hasOwn(row, name)) ||
      expectedColumns.some((name) =>
        recoveryValue(name, row) !== row[name]) ||
      (expectedColumns.includes("session_generation") &&
        (!Number.isSafeInteger(Number(row.session_generation)) ||
          Number(row.session_generation) < (sessionGenerationMode === "increment" ? 2 : 1))) ||
      (expectedColumns.includes("vector_projection_status") &&
        (row.vector_projection_status !== (hasCorpus ? "bootstrap_required" : "verified") ||
         Number(row.vector_projection_bootstrap_epoch) !== (hasCorpus ? 1 : 0)))) {
    refuse("RECOVERY_INSTALL_STATE_INVALID");
  }
  const columns = expectedColumns.map(quoteIdentifier).join(",");
  const values = expectedColumns.map((name) =>
    recoverySqlLiteral(recoveryValue(name, row))).join(",");
  return Buffer.from(`INSERT INTO "install_state" (${columns}) VALUES (${values});\n`, "utf8");
}

/**
 * Compare executable SQLite schema rather than provider-specific formatting.
 *
 * D1 removes SQL comments before storing CREATE statements in sqlite_schema,
 * while local SQLite preserves them. Migration checksums still bind the exact
 * reviewed files; this normalization only prevents non-semantic comments and
 * whitespace from making the independently restored schema look different.
 */
function canonicalSchemaSql(value) {
  let output = "";
  let quote = null;
  let pendingSpace = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (quote) {
      output += character;
      if (quote === "]") {
        if (character === "]") quote = null;
      } else if (character === quote) {
        if (next === quote) {
          output += next;
          index++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      if (pendingSpace && output) output += " ";
      pendingSpace = false;
      quote = character;
      output += character;
      continue;
    }
    if (character === "[") {
      if (pendingSpace && output) output += " ";
      pendingSpace = false;
      quote = "]";
      output += character;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n" && value[index] !== "\r") index++;
      pendingSpace = true;
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < value.length && !(value[index] === "*" && value[index + 1] === "/")) index++;
      if (index < value.length) index++;
      pendingSpace = true;
      continue;
    }
    if (/\s/.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && output) output += " ";
    pendingSpace = false;
    output += character;
  }
  return output.trim();
}

function normalizeSchemaRows(rows) {
  if (!Array.isArray(rows)) refuse("RECOVERY_SCHEMA_CONTRACT_INVALID");
  const normalized = rows.map((row) => {
    // SQLite records implicit auto-indexes with a null SQL definition. DDL can
    // legitimately contain whitespace and exceed an identity field's bound.
    const sql = row?.sql;
    if (sql !== null && (typeof sql !== "string" || !sql || sql.length > 256 * 1024 || sql.includes("\0"))) {
      refuse("RECOVERY_SCHEMA_CONTRACT_INVALID");
    }
    return {
      type: exactString(row?.type, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      name: exactString(row?.name, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      tbl_name: exactString(row?.tbl_name, "RECOVERY_SCHEMA_CONTRACT_INVALID"),
      sql: sql === null ? null : canonicalSchemaSql(sql),
    };
  });
  const sorted = [...normalized].sort((a, b) =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name) || a.tbl_name.localeCompare(b.tbl_name));
  return Object.freeze(sorted.map(Object.freeze));
}

function normalizeAggregate(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) refuse("RECOVERY_AGGREGATE_INVALID");
  const normalized = {};
  for (const [name] of AGGREGATE_FIELDS) {
    const value = String(row[name] ?? "");
    if (!/^(?:0|[1-9]\d*)$/.test(value)) refuse("RECOVERY_AGGREGATE_INVALID");
    normalized[name] = value;
  }
  return Object.freeze(normalized);
}

function snapshotEvidence({ quickCheck, migrations, schemaRows, aggregate }) {
  if (quickCheck !== "ok") refuse("RECOVERY_D1_INTEGRITY_FAILED");
  const migrationFingerprint = migrations.map(({ version, name, checksum }) => ({ version, name, checksum }));
  const schemaFingerprint = sha256(canonical({ migrations: migrationFingerprint, schema: schemaRows }));
  const aggregateFingerprint = sha256(canonical(aggregate));
  return Object.freeze({
    integrity: "ok",
    schema_fingerprint: schemaFingerprint,
    aggregate_fingerprint: aggregateFingerprint,
    document_count: nonNegativeInteger(aggregate.documents),
    chunk_count: nonNegativeInteger(aggregate.chunks),
    fts_count: nonNegativeInteger(aggregate.chunks_fts),
  });
}

function assertSameSnapshot(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "aggregate_fingerprint",
    "document_count", "chunk_count", "fts_count", "content_fingerprint",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

function assertSameStructuralSnapshot(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "aggregate_fingerprint",
    "document_count", "chunk_count", "fts_count",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

function assertSameRecoveryCorpus(left, right, code = "RECOVERY_D1_SNAPSHOT_MISMATCH") {
  const fields = [
    "integrity", "schema_fingerprint", "content_fingerprint",
    "document_count", "chunk_count", "fts_count",
  ];
  if (fields.some((field) => left?.[field] !== right?.[field])) refuse(code);
  return true;
}

const SCHEMA_14_TABLES = Object.freeze(["owner_passkeys", "auth_challenges", "enrollment_codes"]);

function expectedRecoveryTables(migrations) {
  const latest = migrations?.at(-1)?.version || migrationFileContract().at(-1)?.version || 0;
  return RECOVERY_DURABLE_TABLES.filter((table) =>
    (latest >= 13 || table !== "vector_bootstrap_batches") &&
    (latest >= 14 || !SCHEMA_14_TABLES.includes(table)) &&
    (latest >= 15 || !SCHEMA_15_TABLES.includes(table)) &&
    (latest >= 16 || !SCHEMA_16_TABLES.includes(table)) &&
    (latest >= 17 || !SCHEMA_17_TABLES.includes(table)) &&
    (latest >= 18 || !SCHEMA_18_TABLES.includes(table)) &&
    (latest >= 19 || !SCHEMA_19_TABLES.includes(table)) &&
    (latest >= 21 || !SCHEMA_21_TABLES.includes(table)) &&
    (latest >= 22 || !SCHEMA_22_TABLES.includes(table)) &&
    (latest >= 23 || !SCHEMA_23_TABLES.includes(table)) &&
    (latest >= 24 || !SCHEMA_24_TABLES.includes(table)) &&
    (latest >= 25 || !SCHEMA_25_TABLES.includes(table)) &&
    (latest >= 26 || !SCHEMA_26_TABLES.includes(table)) &&
    (latest >= 27 || !SCHEMA_27_TABLES.includes(table)) &&
    (latest >= 28 || !SCHEMA_28_TABLES.includes(table)) &&
    (latest >= 30 || !SCHEMA_30_TABLES.includes(table)) &&
    (latest >= 31 || !SCHEMA_31_TABLES.includes(table)) &&
    (latest >= 32 || !SCHEMA_32_TABLES.includes(table)) &&
    (latest >= 34 || !SCHEMA_34_TABLES.includes(table)) &&
    (latest >= 35 || !SCHEMA_35_TABLES.includes(table)) &&
    (latest >= 36 || !SCHEMA_36_TABLES.includes(table)) &&
    (latest >= 37 || !SCHEMA_37_TABLES.includes(table)) &&
    (latest >= 41 || !SCHEMA_41_TABLES.includes(table)) &&
    (latest >= 42 || !SCHEMA_42_TABLES.includes(table)) &&
    (latest >= 43 || !SCHEMA_43_TABLES.includes(table)) &&
    (latest >= 44 || !SCHEMA_44_TABLES.includes(table)) &&
    (latest >= 45 || !SCHEMA_45_TABLES.includes(table)));
}

export function recoveryExportTables(migrations, { excludeBankItems = false } = {}) {
  const present = new Set(expectedRecoveryTables(migrations));
  return RECOVERY_EXPORT_TABLES.filter((table) =>
    present.has(table) && (!excludeBankItems || table !== "bank_feed_items"));
}

async function assertResultFamilyRecoveryStateEmptyWithReader(
  binding,
  migrations,
  readD1Rows,
) {
  if (Number(migrations?.at(-1)?.version || 0) < 44) return true;
  const rows = await readD1Rows(binding, RESULT_FAMILY_RECOVERY_STATE_SQL);
  if (rows.length !== 1 ||
      nonNegativeInteger(
        rows[0]?.active_imports,
        "RECOVERY_RESULT_FAMILY_IMPORT_STATE_INVALID",
      ) !== 0) {
    refuse("RECOVERY_RESULT_FAMILY_IMPORT_STATE_ACTIVE");
  }
  return true;
}

/**
 * Capture the one canonical D1 content fingerprint used by recovery and the
 * installed synthetic seed runner. The caller supplies transport only; this
 * function owns migration validation, active-import refusal, normalized
 * install-state bytes, and the exact durable table list.
 */
export async function captureRecoveryD1ContentFingerprint({
  binding,
  exportPath,
  maxBytes,
  excludeBankItems = false,
  cleanupOnFailure = false,
  sessionGenerationMode = "preserve",
}, {
  readD1Rows,
  exportData,
  cleanupExport,
} = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding) ||
      typeof readD1Rows !== "function" || typeof exportData !== "function" ||
      typeof cleanupExport !== "function" || typeof excludeBankItems !== "boolean" ||
      typeof cleanupOnFailure !== "boolean" ||
      !new Set(["increment", "preserve"]).has(sessionGenerationMode)) {
    refuse("RECOVERY_CONTENT_FINGERPRINT_DEPENDENCIES_INVALID");
  }
  const migrations = validateMigrationContract(
    await readD1Rows(binding, MIGRATION_CONTRACT_SQL),
  );
  await assertResultFamilyRecoveryStateEmptyWithReader(binding, migrations, readD1Rows);
  const normalizedInstallState = await normalizedInstallStateExport(
    binding,
    migrations,
    readD1Rows,
    { sessionGenerationMode },
  );
  const tables = Object.freeze([
    ...recoveryExportTables(migrations, { excludeBankItems }),
  ]);
  return captureDirectD1ContentFingerprint({
    normalizedInstallState,
    exportPath,
    maxBytes,
    cleanupOnFailure,
    exportData: (path) => exportData(Object.freeze({ binding, path, tables })),
    cleanupExport,
  });
}

export function recoveryVectorProtocolSupported(migrations) {
  return (migrations?.at(-1)?.version || 0) >= RECOVERY_VECTOR_PROTOCOL_SCHEMA_VERSION;
}

function assertExpectedTables(rows, migrations) {
  if (!Array.isArray(rows)) refuse("RECOVERY_TABLE_INVENTORY_INVALID");
  const names = rows.map((row) => exactString(row?.name, "RECOVERY_TABLE_INVENTORY_INVALID"));
  if (canonical(names) !== canonical(expectedRecoveryTables(migrations).sort())) {
    refuse("RECOVERY_TABLE_INVENTORY_INVALID");
  }
  return names;
}

async function writeToChild(stream, value) {
  if (stream.write(value)) return;
  await new Promise((resolvePromise, reject) => {
    stream.once("drain", resolvePromise);
    stream.once("error", reject);
  });
}

/**
 * Execute a recovery SQL artifact in an in-memory sqlite3 process. The SQL is
 * streamed, never copied into another database file, and only aggregate JSON is
 * captured from stdout.
 */
export async function verifyRecoverySqlArtifact(artifactPath, {
  maxBytes = 5 * 1024 * 1024 * 1024,
  sqlitePath = "/usr/bin/sqlite3",
  spawnProcess = spawn,
  timeoutMs = MAX_WRANGLER_TIMEOUT_MS,
} = {}) {
  const checked = assertArtifactFile(artifactPath, { maxBytes });
  let descriptor;
  let child;
  let output = Buffer.alloc(0);
  try {
    descriptor = openSync(checked.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const opened = fstatSync(descriptor);
    if (!sameFile(checked.info, opened)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    child = spawnProcess(sqlitePath, ["-safe", ":memory:", "-batch", "-bail"], {
      env: localToolEnvironment(process.env, {
        PATH: "/usr/bin:/bin",
        LANG: "C",
        LC_ALL: "C",
      }),
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
    });
    if (!child?.stdin || !child?.stdout) refuse("RECOVERY_LOCAL_SQLITE_FAILED");
    child.stdout.on("data", (chunk) => {
      if (output.length + chunk.length > MAX_SQLITE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    await writeToChild(child.stdin, Buffer.from(".bail on\n", "utf8"));
    const input = createReadStream("", { fd: descriptor, autoClose: false });
    for await (const chunk of input) await writeToChild(child.stdin, chunk);
    // SQLite limits a function call to 100 arguments. Recovery now tracks
    // enough durable tables to exceed that limit in one json_object(), so
    // construct exact aggregate JSON in bounded objects and merge them.
    const aggregateJsonObjects = [];
    for (let offset = 0; offset < AGGREGATE_FIELDS.length; offset += 40) {
      const pairs = AGGREGATE_FIELDS.slice(offset, offset + 40).map(([name]) =>
        `'${name}',${quoteIdentifier(name)}`).join(",");
      aggregateJsonObjects.push(`json_object(${pairs})`);
    }
    const aggregateJsonObject = aggregateJsonObjects.reduce((left, right) =>
      `json_patch(${left},${right})`);
    const suffix = Buffer.from(
      `\n${FTS_INTEGRITY_SQL};\n.mode list\n` +
      `SELECT json_object('group','quick','rows',json_group_array(json_object('quick_check',quick_check))) ` +
        `FROM pragma_quick_check;\n` +
      `SELECT json_object('group','migrations','rows',json_group_array(json_object(` +
        `'version',version,'name',name,'checksum',checksum))) FROM (` +
        `SELECT version,name,checksum FROM schema_migrations ORDER BY version);\n` +
      `SELECT json_object('group','tables','rows',json_group_array(json_object('name',name))) FROM (` +
        `SELECT name FROM sqlite_schema WHERE type='table' ` +
        `AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' AND name <> 'chunks_fts' ` +
        `AND name NOT LIKE 'chunks_fts_%' ORDER BY name);\n` +
      `SELECT json_object('group','schema','rows',json_group_array(json_object(` +
        `'type',type,'name',name,'tbl_name',tbl_name,'sql',sql))) FROM (` +
        `SELECT type,name,tbl_name,sql FROM sqlite_schema ` +
        `WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' ` +
        `AND name NOT LIKE 'chunks_fts_%' ORDER BY type,name,tbl_name);\n` +
      `SELECT json_object('group','aggregate','rows',json_array(${aggregateJsonObject})) ` +
        `FROM (${AGGREGATE_SQL});\n`,
      "utf8",
    );
    await writeToChild(child.stdin, suffix);
    child.stdin.end();
    const result = await new Promise((resolvePromise) => {
      child.once("error", () => resolvePromise({ status: null }));
      child.once("close", (status, signal) => resolvePromise({ status, signal }));
    });
    const afterDescriptor = fstatSync(descriptor);
    const afterPath = lstatSync(checked.path);
    if (!sameFile(opened, afterDescriptor) || !sameFile(opened, afterPath)) {
      refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
    }
    if (result.status !== 0 || result.signal || output.length > MAX_SQLITE_OUTPUT_BYTES) {
      refuse("RECOVERY_LOCAL_SQLITE_FAILED");
    }
    const groups = output.toString("utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID"); }
    });
    const expectedGroups = ["quick", "migrations", "tables", "schema", "aggregate"];
    if (groups.length !== expectedGroups.length || groups.some((group, index) =>
      !group || group.group !== expectedGroups[index] || !Array.isArray(group.rows))) {
      refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID");
    }
    const quick = groups[0].rows[0];
    const migrations = validateMigrationContract(groups[1].rows);
    assertExpectedTables(groups[2].rows, migrations);
    const schemaRows = normalizeSchemaRows(groups[3].rows);
    const aggregateRow = groups[4].rows[0];
    if (!aggregateRow) {
      refuse("RECOVERY_LOCAL_SQLITE_RESPONSE_INVALID");
    }
    return snapshotEvidence({
      quickCheck: String(quick?.quick_check || ""),
      migrations,
      schemaRows,
      aggregate: normalizeAggregate(aggregateRow),
    });
  } catch (error) {
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_LOCAL_SQLITE_FAILED");
  } finally {
    output.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function createGateLocalPins(config, plan, { deferIsolation = false } = {}) {
  const binding = inspectVerifiedRecoveryManifestBindings(
    plan,
    config.sourceManifestPath,
    config.targetManifestPath,
  );
  const disposable = assertDisposableTarget(binding.target);
  const isolation = deferIsolation ? null : inspectRecoveryIsolationClaim(
    binding.target,
    plan.target_resource_fingerprint,
  );
  if (config.platform !== "darwin") refuse("RECOVERY_FIELD_GATE_REQUIRES_MACOS_KEYCHAIN");
  if (!binding.target.adminKeySecret) refuse("RECOVERY_TARGET_KEYCHAIN_REQUIRED");
  let targetAdminLocator;
  try { targetAdminLocator = parseAdminKeySecretReference(binding.target.adminKeySecret); } catch {
    refuse("RECOVERY_TARGET_KEYCHAIN_REQUIRED");
  }
  let sourceAdminLocator = null;
  if (binding.source.adminKeySecret) {
    try { sourceAdminLocator = parseAdminKeySecretReference(binding.source.adminKeySecret); } catch {
      refuse("RECOVERY_SOURCE_KEYCHAIN_REQUIRED");
    }
  }
  if (!binding.target.recoveryArtifactKeySecret) {
    refuse("RECOVERY_ARTIFACT_KEYCHAIN_REQUIRED");
  }
  let recoveryArtifactKeyLocator;
  try {
    recoveryArtifactKeyLocator = parseAdminKeySecretReference(
      binding.target.recoveryArtifactKeySecret,
    );
  } catch {
    refuse("RECOVERY_ARTIFACT_KEYCHAIN_REQUIRED");
  }
  const wrapper = inspectWrapper(config.wranglerWrapperPath);
  const golden = inspectGolden(config.goldenPath);
  const artifacts = assertPrivateDirectory(config.artifactDirectory);
  const artifactPath = join(artifacts.path, plan.artifact.relative_name);
  return Object.freeze({
    binding,
    disposable,
    isolation,
    sourceAdminLocator,
    targetAdminLocator,
    recoveryArtifactKeyLocator,
    wrapper,
    golden,
    artifacts,
    artifactPath,
  });
}

function assertLocalPinsUnchanged(pins, config, plan) {
  const binding = inspectVerifiedRecoveryManifestBindings(
    plan,
    config.sourceManifestPath,
    config.targetManifestPath,
  );
  if (canonical(binding) !== canonical(pins.binding)) refuse("RECOVERY_LOCAL_BINDING_CHANGED");
  const wrapper = inspectWrapper(config.wranglerWrapperPath);
  const golden = inspectGolden(config.goldenPath);
  const artifacts = assertPrivateDirectory(config.artifactDirectory);
  if (wrapper.hash !== pins.wrapper.hash || !sameFile(wrapper.info, pins.wrapper.info) ||
      canonical(wrapper.parent) !== canonical(pins.wrapper.parent) ||
      golden.hash !== pins.golden.hash || !sameFile(golden.info, pins.golden.info) ||
      artifacts.path !== pins.artifacts.path ||
      artifacts.info.dev !== pins.artifacts.info.dev || artifacts.info.ino !== pins.artifacts.info.ino) {
    refuse("RECOVERY_LOCAL_BINDING_CHANGED");
  }
  return true;
}

function acquireFieldGateLock(artifactDirectory, planFingerprint) {
  const path = join(artifactDirectory, ".brain-recovery-field-gate.lock");
  let descriptor;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    const bytes = Buffer.from(`${canonical({ schema_version: 1, plan_fingerprint: planFingerprint })}\n`, "utf8");
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    fchmodSync(descriptor, 0o600);
    const info = fstatSync(descriptor);
    syncDirectory(artifactDirectory);
    return Object.freeze({ path, descriptor, info });
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") refuse("RECOVERY_FIELD_GATE_LOCKED");
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_LOCK_FAILED");
  }
}

function releaseFieldGateLock(lock, artifactDirectory) {
  if (!lock) return;
  try {
    const current = lstatSync(lock.path);
    const opened = fstatSync(lock.descriptor);
    if (current.dev !== lock.info.dev || current.ino !== lock.info.ino ||
        opened.dev !== lock.info.dev || opened.ino !== lock.info.ino || current.nlink !== 1) {
      refuse("RECOVERY_FIELD_GATE_LOCK_CHANGED");
    }
    closeSync(lock.descriptor);
    unlinkSync(lock.path);
    syncDirectory(artifactDirectory);
  } catch (error) {
    try { closeSync(lock.descriptor); } catch { /* fixed failure below */ }
    if (error instanceof CloudflareRecoveryAdapterError) throw error;
    refuse("RECOVERY_FIELD_GATE_LOCK_RELEASE_FAILED");
  }
}

function dataPlaneBase(binding) {
  if (!binding.domain) refuse("RECOVERY_TARGET_DOMAIN_REQUIRED");
  return `https://${binding.domain}`;
}

function defaultReadAdminKey(locator, environment) {
  const value = readAdminKeyFromKeychain(locator, { environment });
  if (!value) refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_MISSING");
  return value;
}

async function boundedJsonResponse(response) {
  if (!response?.body || typeof response.body.getReader !== "function") {
    refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_HTTP_BYTES) {
        await reader.cancel().catch(() => {});
        refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
      }
      chunks.push(Buffer.from(value));
    }
    const raw = Buffer.concat(chunks, bytes);
    try { return JSON.parse(raw.toString("utf8")); } catch {
      refuse("RECOVERY_DATA_PLANE_RESPONSE_INVALID");
    } finally {
      raw.fill(0);
      for (const chunk of chunks) chunk.fill(0);
    }
  } finally {
    reader.releaseLock();
  }
}

async function exactFetch(fetchImpl, base, path, options = {}, timeoutMs = 180_000) {
  const baseUrl = new URL(base);
  const target = new URL(path, `${baseUrl.href.replace(/\/$/, "")}/`);
  const loopback = target.hostname === "localhost" || target.hostname === "127.0.0.1" ||
    target.hostname === "[::1]";
  if (target.origin !== baseUrl.origin ||
      (target.protocol !== "https:" && !(loopback && target.protocol === "http:")) ||
      target.username || target.password || target.search || target.hash) {
    refuse("RECOVERY_DATA_PLANE_TARGET_INVALID");
  }
  const response = await fetchImpl(target, {
    ...options,
    headers: {
      ...(options.headers || {}),
      "Cache-Control": "no-store",
    },
    cache: "no-store",
    // `error` prevents the runtime from issuing a second request. A manual
    // redirect still exposes response metadata and is easier for a custom
    // fetch implementation to mishandle when X-Admin-Key is present.
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  }).catch(() => { refuse("RECOVERY_DATA_PLANE_REQUEST_FAILED"); });
  if (response.redirected === true ||
      (response.url && new URL(response.url).origin !== target.origin)) {
    refuse("RECOVERY_DATA_PLANE_REDIRECT_REFUSED");
  }
  if (response.status >= 300 && response.status < 400) refuse("RECOVERY_DATA_PLANE_REDIRECT_REFUSED");
  return response;
}

const BOOTSTRAP_PHASES = new Set(["legacy_drain", "building", "waiting", "complete"]);
const BOOTSTRAP_RECEIPT_FIELDS = Object.freeze([
  "protocol", "phase", "epoch", "total", "confirmed", "queued", "submitted",
  "remaining", "in_flight_batches", "failed", "complete", "vector_ready",
  "expected_vectors", "actual_vectors",
]);
const BOOTSTRAP_BUSY_FIELDS = Object.freeze([
  "protocol", "busy", "remaining", "retry_after_seconds",
]);
const TEST_BOOTSTRAP_OBSERVATION_FIELDS = Object.freeze([
  "schema_version", "protocol", "target_identity_fingerprint", "epoch",
  "base_count", "cursor_position", "high_water_position", "cursor_present", "cursor_advanced",
  "cursor_matches_checkpoint",
  "batch_rows", "progressed_batch_rows", "queued", "submitted", "confirmed", "failed",
  "outbox_pending", "outbox_submitted", "outbox_failed", "provider_vectors",
  "d1_documents", "d1_chunks", "d1_fts", "corpus_matches_restore",
  "target_paused", "active_not_promoted", "ready_to_interrupt",
]);
const BANK_KEY_PROOF_FIELDS = Object.freeze([
  "configured", "key_version", "key_fingerprint",
]);
const BANK_RECONCILIATION_FIELDS = Object.freeze([
  "scanned", "rewrapped", "reauthorization_required", "raced",
  "legacy_rewrap_required", "protected", "reauthorization_required_total",
  "unsupported_key_versions",
]);

// Workers from 0.3.4 also report the not-yet-visible count as `retrying`;
// older Workers do not. Either shape is the same aggregate-only contract.
const OPTIONAL_RECEIPT_FIELDS = new Set(["retrying"]);

function exactAggregateReceiptFields(body, expected, code) {
  if (!body || typeof body !== "object" || Array.isArray(body)) refuse(code);
  const actual = Object.keys(body).filter((field) => !(OPTIONAL_RECEIPT_FIELDS.has(field) && expected.includes("failed"))).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    // Do not echo fields or values. This endpoint is allowed to return aggregate
    // progress only, so unexpected response material never reaches a terminal.
    refuse(code);
  }
}

function validateBankKeyProof(body) {
  const code = "RECOVERY_BANK_KEY_PROOF_INVALID";
  exactAggregateReceiptFields(body, BANK_KEY_PROOF_FIELDS, code);
  if (body.key_version !== 2 || typeof body.configured !== "boolean" ||
      (body.configured
        ? !SHA256_RE.test(String(body.key_fingerprint || ""))
        : body.key_fingerprint !== null)) {
    refuse(code);
  }
  return Object.freeze({
    configured: body.configured,
    keyVersion: body.key_version,
    keyFingerprint: body.key_fingerprint,
  });
}

function validateBankReconciliation(body) {
  const code = "RECOVERY_BANK_RECONCILIATION_INVALID";
  exactAggregateReceiptFields(body, BANK_RECONCILIATION_FIELDS, code);
  const receipt = {};
  for (const field of BANK_RECONCILIATION_FIELDS) {
    receipt[field] = nonNegativeInteger(body[field], code);
  }
  if (receipt.scanned > 100 ||
      receipt.rewrapped + receipt.reauthorization_required + receipt.raced > receipt.scanned) {
    refuse(code);
  }
  return Object.freeze(receipt);
}

function validateBootstrapReceipt(body, expectedTotal) {
  const code = "RECOVERY_BOOTSTRAP_RECEIPT_INVALID";
  exactAggregateReceiptFields(body, BOOTSTRAP_RECEIPT_FIELDS, code);
  if (body.protocol !== "bootstrap-v2" || !BOOTSTRAP_PHASES.has(body.phase) ||
      typeof body.complete !== "boolean" || typeof body.vector_ready !== "boolean") {
    refuse(code);
  }
  const receipt = Object.freeze({
    protocol: body.protocol,
    phase: body.phase,
    epoch: nonNegativeInteger(body.epoch, code),
    total: nonNegativeInteger(body.total, code),
    confirmed: nonNegativeInteger(body.confirmed, code),
    queued: nonNegativeInteger(body.queued, code),
    submitted: nonNegativeInteger(body.submitted, code),
    remaining: nonNegativeInteger(body.remaining, code),
    inFlightBatches: nonNegativeInteger(body.in_flight_batches, code),
    failed: nonNegativeInteger(body.failed, code),
    retrying: nonNegativeInteger(body.retrying ?? 0, code),
    complete: body.complete,
    vectorReady: body.vector_ready,
    expectedVectors: nonNegativeInteger(body.expected_vectors, code),
    actualVectors: nonNegativeInteger(body.actual_vectors, code),
  });
  if (receipt.total !== expectedTotal || receipt.expectedVectors !== expectedTotal ||
      receipt.actualVectors > expectedTotal || receipt.inFlightBatches > 3 ||
      receipt.confirmed > receipt.total ||
      receipt.remaining !== receipt.total - receipt.confirmed ||
      receipt.queued + receipt.submitted > receipt.remaining || receipt.failed !== 0 ||
      receipt.retrying > receipt.remaining ||
      (receipt.phase === "complete") !== receipt.complete ||
      (!receipt.complete && receipt.vectorReady) ||
      (receipt.complete && (
        receipt.remaining !== 0 || receipt.queued !== 0 || receipt.submitted !== 0 ||
        receipt.inFlightBatches !== 0 || receipt.retrying !== 0 || !receipt.vectorReady ||
        receipt.actualVectors !== expectedTotal
      ))) {
    refuse(code);
  }
  return receipt;
}

function validateBootstrapBusyReceipt(body, previousRemaining) {
  const code = "RECOVERY_BOOTSTRAP_BUSY_RECEIPT_INVALID";
  exactAggregateReceiptFields(body, BOOTSTRAP_BUSY_FIELDS, code);
  if (body.protocol !== "bootstrap-v2" || body.busy !== true) refuse(code);
  const remaining = nonNegativeInteger(body.remaining, code);
  const retryAfterSeconds = nonNegativeInteger(body.retry_after_seconds, code);
  if (retryAfterSeconds < 1 || retryAfterSeconds > 1_200 ||
      (previousRemaining !== null && remaining > previousRemaining)) {
    refuse(code);
  }
  return Object.freeze({ remaining, retryAfterSeconds });
}

function validateBootstrapProgress(previous, current) {
  if (!previous) return current;
  if (current.epoch !== previous.epoch || current.total !== previous.total ||
      current.confirmed < previous.confirmed || current.remaining > previous.remaining ||
      (previous.phase !== "legacy_drain" && current.phase === "legacy_drain")) {
    refuse("RECOVERY_BOOTSTRAP_PROGRESS_INVALID");
  }
  if (current.phase === "building" && [
    "confirmed", "remaining", "queued", "submitted", "inFlightBatches", "retrying",
    "actualVectors",
  ].every((field) => current[field] === previous[field])) {
    refuse("RECOVERY_BOOTSTRAP_STALLED");
  }
  return current;
}

function aggregateObserverBootstrapReceipt(receipt) {
  return Object.freeze({
    protocol: receipt.protocol,
    phase: receipt.phase,
    epoch: receipt.epoch,
    total: receipt.total,
    confirmed: receipt.confirmed,
    queued: receipt.queued,
    submitted: receipt.submitted,
    remaining: receipt.remaining,
    in_flight_batches: receipt.inFlightBatches,
    failed: receipt.failed,
    retrying: receipt.retrying,
    complete: receipt.complete,
    vector_ready: receipt.vectorReady,
    expected_vectors: receipt.expectedVectors,
    actual_vectors: receipt.actualVectors,
  });
}

function checkpointAggregateObserverBootstrapReceipt(observation) {
  return Object.freeze({
    protocol: observation.protocol,
    phase: "building",
    epoch: observation.epoch,
    total: observation.d1_chunks,
    confirmed: observation.confirmed,
    queued: observation.queued,
    submitted: observation.submitted,
    remaining: observation.d1_chunks - observation.confirmed,
    in_flight_batches: Number(observation.queued > 0) + Number(observation.submitted > 0),
    failed: observation.failed,
    retrying: 0,
    complete: false,
    vector_ready: false,
    expected_vectors: observation.d1_chunks,
    actual_vectors: observation.provider_vectors,
  });
}

function promotionAggregateBootstrapReceipt(observation) {
  return Object.freeze({
    protocol: observation.protocol,
    phase: "complete",
    epoch: observation.epoch,
    total: observation.d1_chunks,
    confirmed: observation.confirmed,
    queued: 0,
    submitted: 0,
    remaining: 0,
    inFlightBatches: 0,
    failed: 0,
    retrying: 0,
    complete: true,
    vectorReady: true,
    expectedVectors: observation.d1_chunks,
    actualVectors: observation.provider_vectors,
  });
}

function projectAggregateTestBootstrapObservation(observed, checkpoint = null, privateCursor = null) {
  const ready = !observed.complete && observed.bootstrap.cursor_position > 0 &&
    observed.bootstrap.cursor_position < observed.bootstrap.high_water_position &&
    observed.bootstrap.confirmed > 0 && observed.bootstrap.confirmed < observed.d1.chunks &&
    observed.batches.rows_total >= MIN_RECOVERY_TEST_FIELD_EPOCH_ADMISSIONS &&
    observed.batches.rows_confirmed >= 1;
  return Object.freeze({
    schema_version: observed.schema_version,
    protocol: observed.bootstrap.protocol,
    target_identity_fingerprint: observed.target_identity_fingerprint,
    epoch: observed.bootstrap.epoch,
    base_count: privateCursor?.baseCount ?? 0,
    cursor_position: observed.bootstrap.cursor_position,
    high_water_position: observed.bootstrap.high_water_position,
    cursor_present: observed.bootstrap.cursor_position > 0,
    cursor_advanced: observed.bootstrap.cursor_position > 0,
    cursor_matches_checkpoint: Boolean(checkpoint && privateCursor &&
      observed.bootstrap.epoch === checkpoint.observation.epoch &&
      privateCursor.epoch === checkpoint.observation.epoch &&
      privateCursor.sha256 === checkpoint.private_cursor_sha256 &&
      observed.bootstrap.cursor_position === checkpoint.observation.cursor_position &&
      observed.bootstrap.high_water_position === checkpoint.observation.high_water_position),
    batch_rows: observed.batches.rows_total,
    progressed_batch_rows: observed.batches.rows_confirmed,
    queued: observed.batches.rows_queued,
    submitted: observed.batches.rows_submitted,
    confirmed: observed.bootstrap.confirmed,
    failed: observed.batches.failed,
    outbox_pending: observed.outbox.pending,
    outbox_submitted: observed.outbox.submitted,
    outbox_failed: observed.outbox.failed,
    provider_vectors: observed.vectorize.actual,
    d1_documents: observed.d1.documents,
    d1_chunks: observed.d1.chunks,
    d1_fts: observed.d1.fts,
    corpus_matches_restore: true,
    target_paused: true,
    active_not_promoted: true,
    ready_to_interrupt: ready,
  });
}

/**
 * Narrow adapter-facing contract for the separate aggregate observer. It cannot
 * carry a raw cursor, row identity, title, source, URL, provider diagnostic, or
 * credential. The hook still checks every fact it relies on instead of trusting
 * a single observer boolean.
 */
function validateTestBootstrapObservation(input, {
  phase,
  targetResourceFingerprint,
  restored = null,
  receipt = null,
  checkpoint = null,
} = {}) {
  const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVATION_INVALID";
  exactAggregateReceiptFields(input, TEST_BOOTSTRAP_OBSERVATION_FIELDS, code);
  if (input.schema_version !== 1 || input.protocol !== "bootstrap-v2" ||
      input.target_identity_fingerprint !== targetResourceFingerprint ||
      typeof input.cursor_present !== "boolean" ||
      typeof input.cursor_advanced !== "boolean" ||
      typeof input.cursor_matches_checkpoint !== "boolean" ||
      typeof input.corpus_matches_restore !== "boolean" ||
      typeof input.target_paused !== "boolean" ||
      typeof input.active_not_promoted !== "boolean" ||
      typeof input.ready_to_interrupt !== "boolean") {
    refuse(code);
  }
  const observation = Object.freeze({
    schema_version: 1,
    protocol: input.protocol,
    target_identity_fingerprint: input.target_identity_fingerprint,
    epoch: nonNegativeInteger(input.epoch, code),
    base_count: nonNegativeInteger(input.base_count, code),
    cursor_position: nonNegativeInteger(input.cursor_position, code),
    high_water_position: nonNegativeInteger(input.high_water_position, code),
    cursor_present: input.cursor_present,
    cursor_advanced: input.cursor_advanced,
    cursor_matches_checkpoint: input.cursor_matches_checkpoint,
    batch_rows: nonNegativeInteger(input.batch_rows, code),
    progressed_batch_rows: nonNegativeInteger(input.progressed_batch_rows, code),
    queued: nonNegativeInteger(input.queued, code),
    submitted: nonNegativeInteger(input.submitted, code),
    confirmed: nonNegativeInteger(input.confirmed, code),
    failed: nonNegativeInteger(input.failed, code),
    outbox_pending: nonNegativeInteger(input.outbox_pending, code),
    outbox_submitted: nonNegativeInteger(input.outbox_submitted, code),
    outbox_failed: nonNegativeInteger(input.outbox_failed, code),
    provider_vectors: nonNegativeInteger(input.provider_vectors, code),
    d1_documents: nonNegativeInteger(input.d1_documents, code),
    d1_chunks: nonNegativeInteger(input.d1_chunks, code),
    d1_fts: nonNegativeInteger(input.d1_fts, code),
    corpus_matches_restore: input.corpus_matches_restore,
    target_paused: input.target_paused,
    active_not_promoted: input.active_not_promoted,
    ready_to_interrupt: input.ready_to_interrupt,
  });
  if (observation.epoch < 1 ||
      observation.high_water_position < observation.cursor_position || observation.failed !== 0 ||
      observation.outbox_failed !== 0 ||
      observation.progressed_batch_rows > observation.batch_rows ||
      observation.provider_vectors > observation.d1_chunks) {
    refuse(code);
  }
  if (!observation.cursor_present || !observation.cursor_advanced ||
      observation.cursor_position < 1) refuse(code);
  if (phase === "checkpoint") {
    if (!observation.ready_to_interrupt || observation.cursor_matches_checkpoint ||
        observation.base_count !== 0 ||
        observation.d1_documents < MIN_RECOVERY_TEST_FIELD_DOCUMENTS ||
        observation.d1_chunks < MIN_RECOVERY_TEST_FIELD_CHUNKS ||
        observation.batch_rows < MIN_RECOVERY_TEST_FIELD_EPOCH_ADMISSIONS) refuse(code);
    return observation;
  }
  if (!restored || observation.d1_documents !== restored.document_count ||
      observation.d1_chunks !== restored.chunk_count ||
      observation.d1_fts !== restored.fts_count ||
      !observation.corpus_matches_restore || !observation.target_paused ||
      !observation.active_not_promoted) {
    refuse(code);
  }
  if (phase === "resume") {
    if (!checkpoint || observation.epoch !== checkpoint.observation.epoch ||
        observation.base_count !== checkpoint.observation.base_count ||
        observation.cursor_position !== checkpoint.observation.cursor_position ||
        observation.high_water_position !== checkpoint.observation.high_water_position ||
        observation.batch_rows < checkpoint.observation.batch_rows ||
        observation.progressed_batch_rows < checkpoint.observation.progressed_batch_rows ||
        observation.confirmed < checkpoint.observation.confirmed ||
        observation.provider_vectors < checkpoint.observation.provider_vectors ||
        observation.cursor_matches_checkpoint !== true) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH");
    }
    return observation;
  }
  if (phase === "resume_progress") {
    if (!checkpoint || observation.epoch !== checkpoint.observation.epoch ||
        observation.base_count !== checkpoint.observation.base_count ||
        observation.high_water_position !== checkpoint.observation.high_water_position ||
        observation.cursor_position < checkpoint.observation.cursor_position ||
        observation.batch_rows < checkpoint.observation.batch_rows ||
        observation.progressed_batch_rows < checkpoint.observation.progressed_batch_rows ||
        observation.confirmed < checkpoint.observation.confirmed ||
        observation.provider_vectors < checkpoint.observation.provider_vectors ||
        (observation.cursor_position === checkpoint.observation.cursor_position &&
          observation.cursor_matches_checkpoint !== true) ||
        (observation.cursor_position > checkpoint.observation.cursor_position &&
          observation.cursor_matches_checkpoint !== false)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH");
    }
    return observation;
  }
  if (phase === "promotion") {
    if (!checkpoint || observation.epoch !== checkpoint.observation.epoch ||
        observation.base_count !== checkpoint.observation.base_count ||
        observation.cursor_position !== observation.high_water_position ||
        observation.high_water_position !== observation.d1_chunks ||
        observation.confirmed !== observation.d1_chunks ||
        observation.batch_rows < checkpoint.observation.batch_rows ||
        observation.progressed_batch_rows < checkpoint.observation.progressed_batch_rows ||
        observation.provider_vectors !== observation.d1_chunks ||
        observation.queued !== 0 || observation.submitted !== 0 ||
        observation.outbox_pending !== 0 || observation.outbox_submitted !== 0 ||
        observation.cursor_matches_checkpoint !== false ||
        observation.ready_to_interrupt !== false) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_PROOF_INVALID");
    }
    return observation;
  }
  if (phase === "progress") {
    if (!checkpoint || !receipt || observation.epoch !== checkpoint.observation.epoch ||
        observation.base_count !== checkpoint.observation.base_count ||
        observation.epoch !== receipt.epoch || observation.confirmed !== receipt.confirmed ||
        observation.queued !== receipt.queued || observation.submitted !== receipt.submitted ||
        observation.d1_chunks !== receipt.total ||
        observation.high_water_position !== checkpoint.observation.high_water_position ||
        observation.cursor_position < checkpoint.observation.cursor_position ||
        observation.batch_rows < checkpoint.observation.batch_rows ||
        (observation.cursor_position === checkpoint.observation.cursor_position &&
          observation.cursor_matches_checkpoint !== true) ||
        (observation.cursor_position > checkpoint.observation.cursor_position &&
          observation.cursor_matches_checkpoint !== false)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_MISMATCH");
    }
    return observation;
  }
  if (phase !== "interrupt" || !receipt || observation.cursor_matches_checkpoint ||
      observation.epoch !== receipt.epoch || observation.confirmed !== receipt.confirmed ||
      observation.queued !== receipt.queued || observation.submitted !== receipt.submitted ||
      observation.d1_chunks !== receipt.total) {
    refuse(code);
  }
  const conditionsProven = observation.batch_rows >= MIN_RECOVERY_TEST_FIELD_EPOCH_ADMISSIONS &&
    observation.base_count === 0 &&
    observation.progressed_batch_rows >= 1 && observation.confirmed > 0 &&
    observation.confirmed < observation.d1_chunks &&
    observation.queued + observation.submitted + observation.confirmed > 0;
  if (observation.ready_to_interrupt !== conditionsProven) refuse(code);
  return observation;
}

function validateExactVectorInventory(inventory, expectedVectors, code = "RECOVERY_HEALTH_FAILED") {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory) ||
      inventory.backend !== "d1" || !Array.isArray(inventory.rows)) refuse(code);
  const backlog = inventory.vector_backlog;
  const readiness = inventory.vector_readiness;
  if (!backlog || typeof backlog !== "object" || Array.isArray(backlog) ||
      !readiness || typeof readiness !== "object" || Array.isArray(readiness) ||
      Object.hasOwn(backlog, "error") || Object.hasOwn(readiness, "error")) refuse(code);
  const pending = nonNegativeInteger(backlog.pending, code);
  const submitted = nonNegativeInteger(backlog.submitted, code);
  const readinessPending = nonNegativeInteger(readiness.pending, code);
  const readinessSubmitted = nonNegativeInteger(readiness.submitted, code);
  const expected = nonNegativeInteger(readiness.expected_vectors, code);
  const actual = nonNegativeInteger(readiness.actual_vectors, code);
  if (readiness.ready !== true || pending !== 0 || submitted !== 0 ||
      readinessPending !== 0 || readinessSubmitted !== 0 ||
      pending !== readinessPending || submitted !== readinessSubmitted ||
      expected !== expectedVectors || actual !== expectedVectors) refuse(code);
  return Object.freeze({ expectedVectors: expected, actualVectors: actual });
}

function evalChildEnvironment(environment = process.env) {
  return localToolEnvironment(environment, {
    PATH: "/usr/bin:/bin:/usr/local/bin",
    LANG: "C",
    LC_ALL: "C",
    BRAIN_ADMIN_KEY_STDIN: "1",
    CLOUDFLARE_ACCOUNT_ID: undefined,
  });
}

function defaultRunEval({ args, env, input, cwd, timeoutMs }) {
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    input,
    encoding: null,
    maxBuffer: 1024,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
    timeout: timeoutMs,
    windowsHide: true,
  });
}

/**
 * Build the provider adapters after completing only local, pre-credential
 * checks. Each adapter revalidates the exact local pins around its own action.
 */
export function createCloudflareRecoveryFieldGateAdapters(configInput, dependencies = {}) {
  const config = Object.freeze({
    ...configInput,
    platform: dependencies.platform ?? process.platform,
    environment: dependencies.environment ?? process.env,
  });
  const plan = config.plan;
  if (!plan || !SHA256_RE.test(plan.plan_fingerprint || "")) {
    refuse("RECOVERY_FIELD_GATE_PLAN_INVALID");
  }
  const testBootstrapRequest = normalizeTestBootstrapRequest(configInput, {
    approvalRequired: configInput.approvePlan !== undefined,
  });
  const configuredDeploymentReceiptPath = normalizeTestBootstrapEvidencePath(
    configInput.fieldDeploymentReceiptPath,
  );
  if (configuredDeploymentReceiptPath && testBootstrapRequest?.deploymentReceiptPath &&
      configuredDeploymentReceiptPath !== testBootstrapRequest.deploymentReceiptPath) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  const fieldDeploymentReceiptPath = configuredDeploymentReceiptPath ??
    testBootstrapRequest?.deploymentReceiptPath ?? null;
  let pins = createGateLocalPins(config, plan, {
    deferIsolation: Boolean(fieldDeploymentReceiptPath),
  });
  let fieldDeploymentReceiptRecord = null;
  if (fieldDeploymentReceiptPath) {
    assertDisposableRecoveryFieldCampaignIdentity(pins.binding);
    try {
      if (basename(fieldDeploymentReceiptPath) !==
          DISPOSABLE_RECOVERY_DEPLOYMENT_RECEIPT_NAME) {
        refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
      }
      fieldDeploymentReceiptRecord = readDisposableRecoveryDeploymentReceipt(
        fieldDeploymentReceiptPath,
      );
      pins = Object.freeze({
        ...pins,
        isolation: inspectDisposableDeploymentIsolationClaim(
          fieldDeploymentReceiptRecord.value,
          fieldDeploymentReceiptRecord.sha256,
          plan,
        ),
      });
    } catch (error) {
      if (error instanceof CloudflareRecoveryAdapterError) throw error;
      refuse("RECOVERY_TARGET_EXECUTION_UNREVIEWED");
    }
  }
  if (testBootstrapRequest) assertDisposableRecoveryFieldCampaignIdentity(pins.binding);
  if (testBootstrapRequest) assertTestBootstrapWrapperRuntimeContract(pins.wrapper);
  const testBootstrapCandidateEvidence = testBootstrapRequest
    ? inspectTestBootstrapCandidateEvidence(testBootstrapRequest, plan, pins)
    : null;
  if (testBootstrapCandidateEvidence &&
      (testBootstrapCandidateEvidence.deploymentReceiptSha256 !==
        fieldDeploymentReceiptRecord?.sha256 ||
       !sameFile(
         testBootstrapCandidateEvidence.deploymentReceiptInfo,
         fieldDeploymentReceiptRecord.info,
       ))) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_EVIDENCE_INVALID");
  }
  const testBootstrapApprovalFingerprint = testBootstrapRequest
    ? testBootstrapInterruptionApprovalFingerprint(
        plan,
        testBootstrapCandidateEvidence,
        pins.wrapper.hash,
      )
    : null;
  const testBootstrapControlPaths = Object.freeze({
    checkpoint: testBootstrapCheckpointPath(pins),
    completedCheckpoint: testBootstrapCompletedCheckpointPath(pins),
    resume: testBootstrapResumeAuthorizationPath(pins),
    completedResume: testBootstrapCompletedResumeAuthorizationPath(pins),
    promotion: testBootstrapPromotionAuthorizationPath(pins),
    completedPromotion: testBootstrapCompletedPromotionAuthorizationPath(pins),
  });
  const controlPresence = (path) => Boolean(pathInfoOrAbsent(
    path,
    "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
  ));
  const testBootstrapCheckpointExists = controlPresence(testBootstrapControlPaths.checkpoint);
  const testBootstrapCompletedCheckpointExists = controlPresence(
    testBootstrapControlPaths.completedCheckpoint,
  );
  const testBootstrapPromotionAuthorizationExists = controlPresence(
    testBootstrapControlPaths.promotion,
  );
  const testBootstrapResumeAuthorizationExists = controlPresence(
    testBootstrapControlPaths.resume,
  );
  const testBootstrapCompletedResumeAuthorizationExists = controlPresence(
    testBootstrapControlPaths.completedResume,
  );
  const testBootstrapCompletedPromotionAuthorizationExists = controlPresence(
    testBootstrapControlPaths.completedPromotion,
  );
  const restoredFromState = config.state?.completed?.find(
    (entry) => entry?.id === "reconcile_security",
  )?.evidence ?? config.state?.completed?.find(
    (entry) => entry?.id === "verify_d1",
  )?.evidence ?? null;
  // A completed filename is never an ordinary-mode bypass. Successful
  // retirement moves every live authorization away before moving the active
  // checkpoint last; any remaining active control file therefore blocks.
  if (!testBootstrapRequest && (testBootstrapCheckpointExists ||
      testBootstrapResumeAuthorizationExists ||
      testBootstrapPromotionAuthorizationExists)) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_APPROVAL_REQUIRED");
  }
  let completedTestBootstrapCampaign = null;
  if (!testBootstrapRequest && (testBootstrapCompletedCheckpointExists ||
      testBootstrapCompletedResumeAuthorizationExists ||
      testBootstrapCompletedPromotionAuthorizationExists)) {
    if (!testBootstrapCompletedCheckpointExists ||
        !testBootstrapCompletedResumeAuthorizationExists ||
        !testBootstrapCompletedPromotionAuthorizationExists ||
        config.state?.status !== "complete" || !restoredFromState) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID");
    }
    try {
      const completed = readCompletedTestBootstrapCheckpoint(pins, plan);
      const resumeRecord = readTestBootstrapResumeAuthorization(
        pins,
        plan,
        completed.candidateEvidence,
        completed.approvalFingerprint,
        completed.checkpointRecord,
        restoredFromState,
        testBootstrapControlPaths.completedResume,
      );
      const promotionRecord = readTestBootstrapPromotionAuthorization(
        pins,
        plan,
        completed.candidateEvidence,
        completed.approvalFingerprint,
        completed.checkpointRecord,
        restoredFromState,
        testBootstrapControlPaths.completedPromotion,
      );
      if (!resumeRecord || !promotionRecord) {
        refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID");
      }
      completedTestBootstrapCampaign = Object.freeze({
        checkpointRecord: completed.checkpointRecord,
        resumeRecord,
        promotionRecord,
      });
    } catch {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_COMPLETION_INVALID");
    }
  }
  if (testBootstrapRequest && testBootstrapCompletedCheckpointExists) {
    // The special request supplies the exact candidate evidence needed to
    // validate this completed checkpoint. Existence alone is not proof that a
    // campaign was consumed.
    readTestBootstrapCheckpoint(
      pins,
      plan,
      testBootstrapCandidateEvidence,
      testBootstrapApprovalFingerprint,
      pins.wrapper.hash,
      testBootstrapCompletedCheckpointPath(pins),
    );
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_CONSUMED");
  }
  let testBootstrapCheckpointRecord = testBootstrapRequest && testBootstrapCheckpointExists
    ? readTestBootstrapCheckpoint(
        pins,
        plan,
        testBootstrapCandidateEvidence,
        testBootstrapApprovalFingerprint,
        pins.wrapper.hash,
      )
    : null;
  let testBootstrapCheckpoint = testBootstrapCheckpointRecord?.value ?? null;
  if (testBootstrapRequest &&
      ((testBootstrapResumeAuthorizationExists &&
        testBootstrapCompletedResumeAuthorizationExists) ||
       (testBootstrapPromotionAuthorizationExists &&
        testBootstrapCompletedPromotionAuthorizationExists))) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_AUTHORIZATION_RETIREMENT_INVALID");
  }
  const partiallyRetired = testBootstrapCompletedResumeAuthorizationExists ||
    testBootstrapCompletedPromotionAuthorizationExists;
  if (testBootstrapRequest && partiallyRetired && config.state?.status !== "complete") {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_AUTHORIZATION_RETIREMENT_INVALID");
  }
  if (testBootstrapRequest &&
      (testBootstrapResumeAuthorizationExists ||
       testBootstrapCompletedResumeAuthorizationExists) &&
      !testBootstrapCheckpointRecord) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_INVALID");
  }
  if (testBootstrapRequest &&
      (testBootstrapPromotionAuthorizationExists ||
       testBootstrapCompletedPromotionAuthorizationExists) &&
      !testBootstrapCheckpointRecord) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID");
  }
  let testBootstrapResumeAuthorizationRecord = testBootstrapRequest &&
      (testBootstrapResumeAuthorizationExists ||
       testBootstrapCompletedResumeAuthorizationExists)
    ? readTestBootstrapResumeAuthorization(
        pins,
        plan,
        testBootstrapCandidateEvidence,
        testBootstrapApprovalFingerprint,
        testBootstrapCheckpointRecord,
        restoredFromState,
        testBootstrapResumeAuthorizationExists
          ? testBootstrapResumeAuthorizationPath(pins)
          : testBootstrapCompletedResumeAuthorizationPath(pins),
      )
    : null;
  let testBootstrapResumeAuthorization =
    testBootstrapResumeAuthorizationRecord?.value ?? null;
  let testBootstrapPromotionAuthorizationRecord = testBootstrapRequest &&
      (testBootstrapPromotionAuthorizationExists ||
       testBootstrapCompletedPromotionAuthorizationExists)
    ? readTestBootstrapPromotionAuthorization(
        pins,
        plan,
        testBootstrapCandidateEvidence,
        testBootstrapApprovalFingerprint,
        testBootstrapCheckpointRecord,
        restoredFromState,
        testBootstrapPromotionAuthorizationExists
          ? testBootstrapPromotionAuthorizationPath(pins)
          : testBootstrapCompletedPromotionAuthorizationPath(pins),
      )
    : null;
  let testBootstrapPromotionAuthorization =
    testBootstrapPromotionAuthorizationRecord?.value ?? null;
  if (testBootstrapRequest && testBootstrapPromotionAuthorization &&
      !testBootstrapResumeAuthorization) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID");
  }
  if (testBootstrapRequest) {
    assertTestBootstrapStateCoherence(
      config.state,
      testBootstrapCheckpoint,
      testBootstrapPromotionAuthorization,
    );
  }
  const runWranglerImpl = dependencies.runWrangler ?? defaultRunWrangler;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
  const now = dependencies.now ?? Date.now;
  const verifySqlArtifact = dependencies.verifySqlArtifact ?? verifyRecoverySqlArtifact;
  const readAdminKey = dependencies.readAdminKey ?? ((locator) =>
    defaultReadAdminKey(locator, config.environment));
  const readRecoveryArtifactKey = dependencies.readRecoveryArtifactKey ?? ((locator) =>
    defaultReadAdminKey(locator, config.environment));
  const runEval = dependencies.runEval ?? defaultRunEval;
  const materializeWranglerRuntimeImpl = dependencies.materializeWranglerRuntime ??
    materializeLockedWranglerRuntime;
  const assertMaterializedWranglerRuntimeImpl =
    dependencies.assertMaterializedWranglerRuntimeUnchanged ??
      assertMaterializedWranglerRuntimeUnchanged;
  const assertLockedWranglerRuntimeImpl =
    dependencies.assertLockedWranglerRuntimeUnchanged ??
      assertLockedWranglerRuntimeUnchanged;
  let wrapperVersionProven = false;
  const operationApproved = config.approvePlan === plan.plan_fingerprint &&
    config.approveDisposableTarget === plan.target_resource_fingerprint &&
    config.approveTargetExecution === pins.isolation.approvalFingerprint &&
    config.approveSourceExportBlocking === plan.source_resource_fingerprint &&
    config.approveWrapper === pins.wrapper.hash &&
    // A valid replacement golden can change the recovery verdict just as much
    // as a different target can. Bind its exact bytes into every invocation so
    // a supervised stop cannot resume under an unreviewed evaluation suite.
    config.approveGolden === pins.golden.hash;
  const testBootstrapExecutionApproved = !testBootstrapRequest ||
    testBootstrapRequest.approval === testBootstrapApprovalFingerprint;
  if (operationApproved && !testBootstrapExecutionApproved) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_APPROVAL_MISMATCH");
  }

  // An ordinary invocation has no authority to consume or replace a live test
  // campaign. Pin the initial absence of all active test controls and prove it
  // again at every local/provider/key boundary. A dangling symlink is present,
  // not absent, and is therefore refused locally.
  const ordinaryControlAbsencePins = !testBootstrapRequest
    ? Object.freeze([
        testBootstrapControlPaths.checkpoint,
        testBootstrapControlPaths.resume,
        testBootstrapControlPaths.promotion,
        ...(!completedTestBootstrapCampaign ? [
          testBootstrapControlPaths.completedCheckpoint,
          testBootstrapControlPaths.completedResume,
          testBootstrapControlPaths.completedPromotion,
        ] : []),
      ].map((path) => {
        assertPathAbsent(
          path,
          "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_RESUME_APPROVAL_REQUIRED",
        );
        return resolve(path);
      }))
    : Object.freeze([]);

  const assertControlPath = (path, record, maxBytes) => {
    const absolute = resolve(path);
    if (record?.pin?.path === absolute) {
      return assertStablePrivateFileRecord(record, {
        code: "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
        maxBytes,
      });
    }
    assertPathAbsent(absolute, "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED");
    return true;
  };

  const assertTestBootstrapControlFilesUnchanged = () => {
    if (!testBootstrapRequest) {
      ordinaryControlAbsencePins.forEach((path) => assertPathAbsent(
        path,
        "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_CHANGED",
      ));
      if (completedTestBootstrapCampaign) {
        assertControlPath(
          testBootstrapControlPaths.completedCheckpoint,
          completedTestBootstrapCampaign.checkpointRecord,
          MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
        );
        assertControlPath(
          testBootstrapControlPaths.completedResume,
          completedTestBootstrapCampaign.resumeRecord,
          MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES,
        );
        assertControlPath(
          testBootstrapControlPaths.completedPromotion,
          completedTestBootstrapCampaign.promotionRecord,
          MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES,
        );
      }
      return true;
    }
    assertControlPath(
      testBootstrapCheckpointPath(pins),
      testBootstrapCheckpointRecord,
      MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
    );
    assertControlPath(
      testBootstrapCompletedCheckpointPath(pins),
      null,
      MAX_RECOVERY_TEST_BOOTSTRAP_CHECKPOINT_BYTES,
    );
    assertControlPath(
      testBootstrapResumeAuthorizationPath(pins),
      testBootstrapResumeAuthorizationRecord,
      MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES,
    );
    assertControlPath(
      testBootstrapCompletedResumeAuthorizationPath(pins),
      testBootstrapResumeAuthorizationRecord,
      MAX_RECOVERY_TEST_BOOTSTRAP_RESUME_AUTHORIZATION_BYTES,
    );
    assertControlPath(
      testBootstrapPromotionAuthorizationPath(pins),
      testBootstrapPromotionAuthorizationRecord,
      MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES,
    );
    assertControlPath(
      testBootstrapCompletedPromotionAuthorizationPath(pins),
      testBootstrapPromotionAuthorizationRecord,
      MAX_RECOVERY_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_BYTES,
    );
    return true;
  };

  const revalidate = () => {
    assertLocalPinsUnchanged(pins, config, plan);
    if (testBootstrapRequest) {
      assertTestBootstrapCandidateEvidenceUnchanged(
        testBootstrapCandidateEvidence,
        testBootstrapRequest,
        assertLockedWranglerRuntimeImpl,
      );
    }
    if (fieldDeploymentReceiptRecord) {
      try {
        const current = readDisposableRecoveryDeploymentReceipt(
          fieldDeploymentReceiptPath,
        );
        if (current.sha256 !== fieldDeploymentReceiptRecord.sha256 ||
            !sameFile(current.info, fieldDeploymentReceiptRecord.info) ||
            canonical(inspectDisposableDeploymentIsolationClaim(
              current.value,
              current.sha256,
              plan,
            )) !== canonical(pins.isolation)) {
          refuse("RECOVERY_LOCAL_BINDING_CHANGED");
        }
      } catch (error) {
        if (error instanceof CloudflareRecoveryAdapterError) throw error;
        refuse("RECOVERY_LOCAL_BINDING_CHANGED");
      }
    }
    assertTestBootstrapControlFilesUnchanged();
    return true;
  };

  async function observeTestBootstrapPoint(phase, restored, receipt = null) {
    if (!testBootstrapRequest || !testBootstrapExecutionApproved) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_APPROVAL_MISMATCH");
    }
    revalidate();
    let raw;
    try {
      const observer = createAggregateFieldObserver({
        expected: Object.freeze({
          target_identity_fingerprint: plan.target_resource_fingerprint,
          documents: restored.document_count,
          chunks: restored.chunk_count,
          fts: restored.fts_count,
        }),
        readIdentityAggregate: async (contract) => {
          if (canonical(contract) !== canonical(AGGREGATE_FIELD_OBSERVER_READS.identity)) {
            refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED");
          }
          await assertExactCloudflareResources(pins.binding.target, "target", "paused");
          return Object.freeze({
            effect: "read_only",
            redirected: false,
            target_identity_fingerprint: plan.target_resource_fingerprint,
          });
        },
        readD1Aggregate: async (contract) => {
          if (contract?.effect !== "read_only" ||
              contract?.sql !== AGGREGATE_FIELD_OBSERVER_D1_SQL) {
            refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED");
          }
          return Object.freeze({
            effect: "read_only",
            redirected: false,
            rows: await d1Rows(pins.binding.target, AGGREGATE_FIELD_OBSERVER_D1_SQL),
          });
        },
        readVectorizeAggregate: async (contract) => {
          if (canonical(contract) !== canonical(AGGREGATE_FIELD_OBSERVER_READS.vectorize)) {
            refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED");
          }
          const info = await vectorInfo(pins.binding.target);
          return Object.freeze({
            effect: "read_only",
            redirected: false,
            actual_vectors: info.vectorCount,
          });
        },
      });
      const checkpoint = testBootstrapCheckpoint ?? null;
      const bootstrapReceipt = receipt
        ? aggregateObserverBootstrapReceipt(receipt)
        : checkpointAggregateObserverBootstrapReceipt(checkpoint?.observation);
      const privateCursorBefore = await privateBootstrapCursorDigest();
      const aggregate = await observer.observe(Object.freeze({
        bootstrapReceipt,
        previous: null,
      }));
      const privateCursorAfter = await privateBootstrapCursorDigest();
      if (privateCursorBefore.epoch !== privateCursorAfter.epoch ||
          privateCursorBefore.baseCount !== privateCursorAfter.baseCount ||
          privateCursorBefore.protocol !== privateCursorAfter.protocol ||
          privateCursorBefore.sha256 !== privateCursorAfter.sha256 ||
          privateCursorAfter.epoch !== aggregate.bootstrap.epoch) {
        refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED");
      }
      raw = Object.freeze({
        observation: projectAggregateTestBootstrapObservation(
          aggregate,
          checkpoint,
          privateCursorAfter,
        ),
        privateCursorSha256: privateCursorAfter.sha256,
      });
    } catch (error) {
      if (error instanceof CloudflareRecoveryAdapterError) throw error;
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVER_FAILED");
    } finally {
      revalidate();
    }
    const observation = validateTestBootstrapObservation(raw.observation, {
      phase,
      targetResourceFingerprint: plan.target_resource_fingerprint,
      restored,
      receipt,
      checkpoint: testBootstrapCheckpoint,
    });
    return Object.freeze({ observation, privateCursorSha256: raw.privateCursorSha256 });
  }

  async function wrangler(binding, args, {
    json = false,
    text = false,
    timeoutMs = MAX_WRANGLER_TIMEOUT_MS,
  } = {}) {
    const approvedMutation = binding.accountId === pins.binding.target.accountId &&
        binding.workerName === pins.binding.target.workerName
      ? [
          "versions", "deploy", `${pins.isolation.activeWorkerVersionId}@100%`,
          "--name", pins.binding.target.workerName, "-y",
        ]
      : null;
    if (!isAllowedWranglerCommand(args, approvedMutation)) {
      refuse("RECOVERY_WRANGLER_COMMAND_REFUSED");
    }
    revalidate();
    const callDirectory = mkdtempSync(join(pins.artifacts.path, ".brain-recovery-runtime-"));
    let result;
    let materializedWranglerRuntime = null;
    try {
      chmodSync(callDirectory, 0o700);
      mkdirSync(join(callDirectory, "logs"), { mode: 0o700 });
      const executionWrapper = join(callDirectory, "wrangler-pinned");
      writeFileSync(executionWrapper, pins.wrapper.raw, { flag: "wx", mode: 0o700 });
      if (process.platform !== "win32") chmodSync(executionWrapper, 0o700);
      const executionPin = readStablePrivateFile(executionWrapper, {
        code: "RECOVERY_WRANGLER_WRAPPER_UNSAFE",
        maxBytes: MAX_WRAPPER_BYTES,
        executable: true,
      });
      const executionWrapperRecord = stablePrivateFileRecord(executionPin, null);
      try {
        if (executionPin.hash !== pins.wrapper.hash) refuse("RECOVERY_WRANGLER_WRAPPER_UNSAFE");
      } finally {
        executionPin.raw.fill(0);
      }
      if (testBootstrapRequest) {
        try {
          materializedWranglerRuntime = materializeWranglerRuntimeImpl(
            testBootstrapCandidateEvidence.wranglerRuntime,
            join(callDirectory, "wrangler-runtime"),
          );
          assertMaterializedWranglerRuntimeImpl(materializedWranglerRuntime);
        } catch {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_INVALID");
        }
      }
      revalidate();
      const env = wrapperEnvironment(
        binding.accountId,
        callDirectory,
        config.environment,
        materializedWranglerRuntime,
      );
      const executionWrapperCode = testBootstrapRequest
        ? "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_CHANGED"
        : "RECOVERY_WRANGLER_WRAPPER_UNSAFE";
      assertStablePrivateFileRecord(executionWrapperRecord, {
        code: executionWrapperCode,
        maxBytes: MAX_WRAPPER_BYTES,
      });
      if (testBootstrapRequest) {
        try { assertMaterializedWranglerRuntimeImpl(materializedWranglerRuntime); }
        catch { refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_CHANGED"); }
      }
      result = normalizedChildResult(await runWranglerImpl({
        command: executionWrapper,
        args: args[0] === "--version"
          ? [...args]
          : [...args, ...WRANGLER_FAIL_CLOSED_FLAGS],
        env,
        cwd: callDirectory,
        timeoutMs,
      }));
      assertStablePrivateFileRecord(executionWrapperRecord, {
        code: executionWrapperCode,
        maxBytes: MAX_WRAPPER_BYTES,
      });
      if (testBootstrapRequest) {
        try { assertMaterializedWranglerRuntimeImpl(materializedWranglerRuntime); }
        catch { refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_WRANGLER_RUNTIME_CHANGED"); }
      }
      revalidate();
      if (result.status !== 0 || result.signal || result.error) {
        refuse("RECOVERY_WRANGLER_CALL_FAILED");
      }
      if (result.stdout.length > MAX_PROVIDER_JSON_BYTES || result.stderr.length > MAX_PROVIDER_JSON_BYTES) {
        refuse("RECOVERY_CLOUDFLARE_RESPONSE_INVALID");
      }
      if (json) return parseProviderJson(result.stdout);
      if (text) return result.stdout.toString("utf8");
      return null;
    } finally {
      if (result) {
        result.stdout.fill(0);
        result.stderr.fill(0);
      }
      rmSync(callDirectory, { recursive: true, force: true });
      revalidate();
    }
  }

  async function ensureWrapperVersion(binding) {
    if (wrapperVersionProven) return;
    const version = String(await wrangler(binding, ["--version"], { text: true })).trim();
    if ((testBootstrapRequest && version !== RECOVERY_TEST_WRANGLER_VERSION) ||
        (!testBootstrapRequest && !/(?:^|\s)4\.\d+\.\d+(?:\s|$)/.test(version))) {
      refuse("RECOVERY_WRANGLER_VERSION_UNSUPPORTED");
    }
    wrapperVersionProven = true;
  }

  async function wranglerJson(binding, args) {
    await ensureWrapperVersion(binding);
    return wrangler(binding, args, { json: true });
  }

  async function d1Rows(binding, sql) {
    const payload = await wranglerJson(binding, [
      "d1", "execute", binding.databaseName,
      "--remote", "--command", sql, "--json",
    ]);
    return d1ResultRows(payload);
  }

  async function privateBootstrapCursorDigest() {
    const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PRIVATE_CURSOR_INVALID";
    const rows = await d1Rows(pins.binding.target, RECOVERY_TEST_PRIVATE_CURSOR_SQL);
    if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
    exactAggregateReceiptFields(rows[0], ["epoch", "base_count", "protocol", "cursor_value"], code);
    const epoch = nonNegativeInteger(rows[0].epoch, code);
    const baseCount = nonNegativeInteger(rows[0].base_count, code);
    const protocol = rows[0].protocol;
    const value = rows[0].cursor_value;
    if (epoch < 1 || protocol !== "bootstrap-v2" || typeof value !== "string" ||
        !value || value.length > 4096 ||
        CONTROL_RE.test(value)) refuse(code);
    const bytes = Buffer.from(value, "utf8");
    try {
      return Object.freeze({
        epoch,
        baseCount,
        protocol,
        sha256: sha256(bytes),
      });
    } finally {
      bytes.fill(0);
    }
  }

  async function vectorInfo(binding) {
    const info = await wranglerJson(binding, ["vectorize", "info", binding.vectorizeIndex, "--json"]);
    if (!info || typeof info !== "object" || Array.isArray(info)) {
      refuse("RECOVERY_VECTORIZE_RESPONSE_INVALID");
    }
    const rawVectorCount = info.vectorCount ?? info.vector_count;
    if (rawVectorCount === undefined || rawVectorCount === null) {
      refuse("RECOVERY_VECTORIZE_RESPONSE_INVALID");
    }
    const vectorCount = nonNegativeInteger(rawVectorCount, "RECOVERY_VECTORIZE_RESPONSE_INVALID");
    const dimensions = nonNegativeInteger(info.dimensions, "RECOVERY_VECTORIZE_RESPONSE_INVALID");
    return Object.freeze({ vectorCount, dimensions });
  }

  async function currentTestBootstrapReceipt(restored) {
    const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OBSERVATION_INVALID";
    const rows = await d1Rows(pins.binding.target, AGGREGATE_FIELD_OBSERVER_D1_SQL);
    if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
    const row = rows[0];
    if (!row || typeof row !== "object" || Array.isArray(row) ||
        row.bootstrap_protocol !== "bootstrap-v2") refuse(code);
    const epoch = nonNegativeInteger(row.epoch, code);
    const total = nonNegativeInteger(row.chunks, code);
    const confirmed = nonNegativeInteger(row.base_count, code) +
      nonNegativeInteger(row.confirmed_batch_rows, code);
    const queued = nonNegativeInteger(row.queued_batch_rows, code);
    const submitted = nonNegativeInteger(row.submitted_batch_rows, code);
    const inFlightBatches = nonNegativeInteger(row.queued_batches, code) +
      nonNegativeInteger(row.submitted_batches, code);
    const info = await vectorInfo(pins.binding.target);
    const complete = row.projection_status === "verified" && confirmed === total &&
      nonNegativeInteger(row.cursor_position, code) ===
        nonNegativeInteger(row.high_water_position, code) &&
      queued === 0 && submitted === 0 &&
      nonNegativeInteger(row.outbox_pending, code) === 0 &&
      info.vectorCount === total;
    return validateBootstrapReceipt({
      protocol: "bootstrap-v2",
      phase: complete ? "complete" : "building",
      epoch,
      total,
      confirmed,
      queued,
      submitted,
      remaining: total - confirmed,
      in_flight_batches: inFlightBatches,
      failed: nonNegativeInteger(row.failed_batches, code),
      retrying: nonNegativeInteger(row.outbox_retrying, code),
      complete,
      vector_ready: complete,
      expected_vectors: restored.chunk_count,
      actual_vectors: info.vectorCount,
    }, restored.chunk_count);
  }

  async function observeTestBootstrapOpening(restored) {
    const code = "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_OPENING_INVALID";
    const fields = [
      "projection_status", "epoch", "base_count", "protocol_is_null",
      "cursor_is_null", "high_water_set", "high_water_position",
      "high_water_matches_max", "documents", "chunks", "fts", "batches",
      "batch_rows", "outbox", "projection_fence_clear",
    ];
    const readOpening = async () => {
      const rows = await d1Rows(pins.binding.target, RECOVERY_TEST_BOOTSTRAP_OPENING_SQL);
      if (!Array.isArray(rows) || rows.length !== 1) refuse(code);
      exactAggregateReceiptFields(rows[0], fields, code);
      const row = { projection_status: rows[0].projection_status };
      for (const field of fields.slice(1)) row[field] = nonNegativeInteger(rows[0][field], code);
      return Object.freeze(row);
    };
    revalidate();
    await assertExactCloudflareResources(pins.binding.target, "target", "paused");
    const before = await readOpening();
    const vectors = await vectorInfo(pins.binding.target);
    const after = await readOpening();
    await assertExactCloudflareResources(pins.binding.target, "target", "paused");
    revalidate();
    if (canonical(before) !== canonical(after) ||
        before.projection_status !== "bootstrap_required" || before.epoch !== 1 ||
        before.base_count !== 0 || before.protocol_is_null !== 1 ||
        before.cursor_is_null !== 1 || before.high_water_set !== 1 ||
        before.high_water_position !== restored.chunk_count ||
        before.high_water_matches_max !== 1 ||
        before.documents !== restored.document_count || before.chunks !== restored.chunk_count ||
        before.fts !== restored.fts_count || before.batches !== 0 ||
        before.batch_rows !== 0 || before.outbox !== 0 ||
        before.projection_fence_clear !== 1 || vectors.vectorCount !== 0) {
      refuse(code);
    }
    return true;
  }

  async function inspectWorkerVersion(binding, role, versionId, expectedMode = null) {
    const version = await wranglerJson(binding, [
      "versions", "view", versionId, "--name", binding.workerName, "--json",
    ]);
    if (!version || version.id !== versionId) {
      refuse(role === "target"
        ? "RECOVERY_TARGET_EXECUTION_CHANGED"
        : "RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const resources = version?.resources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources) ||
        canonical(Object.keys(resources).sort()) !==
          canonical(["bindings", "script", "script_runtime"])) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    const script = resources.script;
    const runtime = resources.script_runtime;
    if (!script || typeof script !== "object" || Array.isArray(script) ||
        canonical(Object.keys(script).sort()) !==
          canonical(["etag", "handlers", "last_deployed_from", "named_handlers"]) ||
        !runtime || typeof runtime !== "object" || Array.isArray(runtime) ||
        canonical(Object.keys(runtime).sort()) !==
          canonical(["compatibility_date", "usage_model"])) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    const scriptEtag = exactString(script.etag, "RECOVERY_WORKER_CODE_INVALID");
    if (scriptEtag.length > 256 || script.last_deployed_from !== "api" ||
        !Array.isArray(script.handlers) ||
        canonical([...script.handlers].sort()) !== canonical(["fetch", "scheduled"]) ||
        !Array.isArray(script.named_handlers) ||
        script.named_handlers.some((entry) =>
          !entry || typeof entry !== "object" || Array.isArray(entry)) ||
        runtime.compatibility_date !== "2026-01-01" ||
        runtime.usage_model !== "standard") {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }

    const bindings = resources.bindings;
    if (!Array.isArray(bindings) || bindings.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry))) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const requiredBindingNames = [
      "AI", "ANSWER_MODEL", "BRAIN_NAME", "BRAIN_OWNER", "BRAIN_VERSION",
      "CHUNK_OVERLAP", "CHUNK_SIZE", "CREDENTIAL_SCANNER", "DAILY_LLM_CAP_USD",
      "DB", "OCR_ENABLED", "OCR_MODEL", "STORAGE", "VECTORIZE",
    ];
    const actualNonSecretNames = bindings
      .filter((entry) => entry.type !== "secret_text" && entry.name !== "VECTOR_DRAIN_MODE")
      .map((entry) => exactString(entry.name, "RECOVERY_WORKER_BINDINGS_INVALID"))
      .sort();
    const expectedNonSecretNames = [...requiredBindingNames].sort();
    if (canonical(actualNonSecretNames) !== canonical(expectedNonSecretNames)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const exactlyOne = (predicate) => bindings.filter(predicate).length === 1;
    if (!exactlyOne((entry) =>
      entry.type === "d1" && entry.name === "DB" && entry.id === binding.databaseId &&
        entry.database_id === binding.databaseId) ||
        !exactlyOne((entry) =>
          entry.type === "vectorize" && entry.name === "VECTORIZE" &&
          entry.index_name === binding.vectorizeIndex) ||
        !exactlyOne((entry) =>
          entry.type === "ai" && entry.name === "AI" && entry.project === "<catalog>") ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "STORAGE" && entry.text === "d1") ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "BRAIN_NAME" &&
          entry.text === binding.clientSlug) ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "BRAIN_VERSION" &&
          entry.text === binding.productVersion) ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "OCR_ENABLED" &&
          entry.text === binding.ocrEnabled) ||
        !exactlyOne((entry) =>
          entry.type === "plain_text" && entry.name === "OCR_MODEL" &&
          entry.text === binding.ocrModel)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const plainText = (name) => {
      const matches = bindings.filter((entry) =>
        entry.type === "plain_text" && entry.name === name);
      if (matches.length !== 1) refuse("RECOVERY_WORKER_BINDINGS_INVALID");
      return exactString(matches[0].text, "RECOVERY_WORKER_BINDINGS_INVALID");
    };
    const chunkSize = plainText("CHUNK_SIZE");
    const chunkOverlap = plainText("CHUNK_OVERLAP");
    const dailyCap = plainText("DAILY_LLM_CAP_USD");
    const chunkSizeNumber = Number(chunkSize);
    const chunkOverlapNumber = Number(chunkOverlap);
    if (!/^\d+$/.test(chunkSize) || !Number.isSafeInteger(chunkSizeNumber) ||
        chunkSizeNumber < 1 || !/^\d+$/.test(chunkOverlap) ||
        !Number.isSafeInteger(chunkOverlapNumber) || chunkOverlapNumber >= chunkSizeNumber ||
        !/^\d+(?:\.\d+)?$/.test(dailyCap) || !Number.isFinite(Number(dailyCap)) ||
        Number(dailyCap) < 0 || chunkSize !== binding.chunkSize ||
        chunkOverlap !== binding.chunkOverlap || dailyCap !== binding.dailyLlmCapUsd ||
        plainText("BRAIN_OWNER") !== binding.clientDisplayName ||
        plainText("ANSWER_MODEL") !== binding.answerModel ||
        plainText("CREDENTIAL_SCANNER") !== binding.credentialScanner) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    const secretNames = bindings
      .filter((entry) => entry.type === "secret_text")
      .map((entry) => String(entry.name || ""))
      .sort();
    const allowedSecrets = new Set([
      ...RECOVERY_REQUIRED_SECRET_NAMES,
      ...RECOVERY_OPTIONAL_SECRET_NAMES,
    ]);
    const exactFieldSecrets = fieldDeploymentReceiptRecord || testBootstrapRequest
      ? [...RECOVERY_REQUIRED_SECRET_NAMES,
          ...(role === "target" ? [RECOVERY_BANK_WRAPPING_SECRET_NAME] : [])].sort()
      : null;
    const incompleteOptionalGroup = RECOVERY_COMPLETE_OPTIONAL_SECRET_GROUPS.some((group) => {
      const present = group.filter((name) => secretNames.includes(name)).length;
      return present !== 0 && present !== group.length;
    });
    if ((exactFieldSecrets && canonical(secretNames) !== canonical(exactFieldSecrets)) ||
        RECOVERY_REQUIRED_SECRET_NAMES.some((name) => !secretNames.includes(name)) ||
        secretNames.some((name) => !allowedSecrets.has(name)) ||
        incompleteOptionalGroup ||
        (role === "target" && !secretNames.includes(RECOVERY_BANK_WRAPPING_SECRET_NAME))) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    if (role === "target") {
      const modeBindings = bindings.filter((entry) => entry?.name === "VECTOR_DRAIN_MODE");
      const paused = modeBindings.length === 1 &&
        modeBindings[0]?.type === "plain_text" &&
        modeBindings[0]?.text === "paused-for-upgrade";
      const active = modeBindings.length === 0;
      if ((expectedMode === "paused" && !paused) ||
          (expectedMode === "active" && !active) ||
          !["paused", "active"].includes(expectedMode)) {
        refuse("RECOVERY_TARGET_EXECUTION_MODE_INVALID");
      }
    }
    const comparable = bindings
      .filter((entry) => entry.name !== "VECTOR_DRAIN_MODE")
      .map((entry) => structuredClone(entry))
      .sort((left, right) => canonical(left).localeCompare(canonical(right)));
    return Object.freeze({
      comparable: Object.freeze(comparable.map(Object.freeze)),
      code: Object.freeze({
        // Provider etags are opaque per-version identifiers, not a shared
        // package digest. Compare only the bounded structural readback here;
        // field execution stays blocked until a canonical provider adapter
        // derives package-to-code causality independently.
        script: Object.freeze({
          handlers: structuredClone(script.handlers),
          last_deployed_from: script.last_deployed_from,
          named_handlers: structuredClone(script.named_handlers),
        }),
        runtime: structuredClone(runtime),
      }),
      scriptEtag,
      secretNames: Object.freeze([...secretNames]),
    });
  }

  async function assertReviewedTargetVersions(binding) {
    const paused = await inspectWorkerVersion(
      binding,
      "target",
      pins.isolation.pausedWorkerVersionId,
      "paused",
    );
    const active = await inspectWorkerVersion(
      binding,
      "target",
      pins.isolation.activeWorkerVersionId,
      "active",
    );
    if (paused.scriptEtag !== pins.isolation.pausedWorkerScriptEtag ||
        active.scriptEtag !== pins.isolation.activeWorkerScriptEtag ||
        canonical(paused.code) !== canonical(active.code)) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    if (canonical(paused.comparable) !== canonical(active.comparable)) {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    return paused;
  }

  async function assertReceiptBackedSourceDeploymentPin() {
    if (!fieldDeploymentReceiptRecord) return true;
    const binding = pins.binding.source;
    const deployment = await wranglerJson(binding, [
      "deployments", "status", "--name", binding.workerName, "--json",
    ]);
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment) ||
        !Array.isArray(deployment.versions) || deployment.versions.length !== 1 ||
        Number(deployment.versions[0]?.percentage) !== 100) {
      refuse("RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS");
    }
    const versionId = exactString(
      deployment.versions[0]?.version_id,
      "RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS",
    );
    const inspected = await inspectWorkerVersion(binding, "source", versionId);
    if (versionId !== pins.isolation.sourceActiveWorkerVersionId ||
        inspected.scriptEtag !== pins.isolation.sourceWorkerScriptEtag) {
      refuse("RECOVERY_WORKER_CODE_INVALID");
    }
    return true;
  }

  async function assertExactCloudflareResources(binding, role, targetMode = null) {
    if (role !== "source" && role !== "target") {
      refuse("RECOVERY_WORKER_BINDINGS_INVALID");
    }
    if (role === "target" && !["paused", "active", "either"].includes(targetMode)) {
      refuse("RECOVERY_TARGET_EXECUTION_MODE_INVALID");
    }
    const databases = await wranglerJson(binding, ["d1", "list", "--json"]);
    if (!Array.isArray(databases)) refuse("RECOVERY_D1_RESOURCE_AMBIGUOUS");
    const byName = databases.filter((row) => row?.name === binding.databaseName);
    const byId = databases.filter((row) => (row?.uuid ?? row?.id) === binding.databaseId);
    if (byName.length !== 1 || byId.length !== 1 || byName[0] !== byId[0]) {
      refuse("RECOVERY_D1_RESOURCE_AMBIGUOUS");
    }

    const indexes = await wranglerJson(binding, ["vectorize", "list", "--json"]);
    if (!Array.isArray(indexes)) refuse("RECOVERY_VECTORIZE_RESOURCE_AMBIGUOUS");
    const matchingIndexes = indexes.filter((row) => row?.name === binding.vectorizeIndex);
    if (matchingIndexes.length !== 1) refuse("RECOVERY_VECTORIZE_RESOURCE_AMBIGUOUS");
    const indexConfig = matchingIndexes[0]?.config || matchingIndexes[0] || {};
    if (Number(indexConfig.dimensions) !== 768 || String(indexConfig.metric).toLowerCase() !== "cosine") {
      refuse("RECOVERY_VECTORIZE_CONTRACT_MISMATCH");
    }
    const info = await vectorInfo(binding);
    if (info.dimensions !== 768) refuse("RECOVERY_VECTORIZE_CONTRACT_MISMATCH");

    const deployment = await wranglerJson(binding, [
      "deployments", "status", "--name", binding.workerName, "--json",
    ]);
    if (!deployment || typeof deployment !== "object" || Array.isArray(deployment) ||
        !Array.isArray(deployment.versions) || deployment.versions.length !== 1 ||
        Number(deployment.versions[0]?.percentage) !== 100) {
      refuse("RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS");
    }
    const versionId = exactString(
      deployment.versions[0]?.version_id,
      "RECOVERY_WORKER_DEPLOYMENT_AMBIGUOUS",
    );
    if (role === "source") {
      const inspected = await inspectWorkerVersion(binding, role, versionId);
      if (fieldDeploymentReceiptRecord &&
          (versionId !== pins.isolation.sourceActiveWorkerVersionId ||
           inspected.scriptEtag !== pins.isolation.sourceWorkerScriptEtag)) {
        refuse("RECOVERY_WORKER_CODE_INVALID");
      }
      return Object.freeze({
        vectorCount: info.vectorCount,
        workerVersionId: versionId,
        secretNames: inspected.secretNames,
      });
    }
    const deployedMode = versionId === pins.isolation.pausedWorkerVersionId
      ? "paused"
      : versionId === pins.isolation.activeWorkerVersionId
        ? "active"
        : null;
    if (!deployedMode || (targetMode !== "either" && targetMode !== deployedMode)) {
      refuse("RECOVERY_TARGET_EXECUTION_CHANGED");
    }
    const reviewed = await assertReviewedTargetVersions(binding);
    return Object.freeze({
      vectorCount: info.vectorCount,
      workerVersionId: versionId,
      targetMode: deployedMode,
      secretNames: reviewed.secretNames,
    });
  }

  async function remoteMigrationContract(binding) {
    const rows = await d1Rows(binding, MIGRATION_CONTRACT_SQL);
    return validateMigrationContract(rows);
  }

  async function assertResultFamilyRecoveryStateEmpty(binding, migrations) {
    return assertResultFamilyRecoveryStateEmptyWithReader(binding, migrations, d1Rows);
  }

  async function requireCurrentRecoverySchema(
    binding,
    code = "RECOVERY_TARGET_UPGRADE_REQUIRED",
  ) {
    const migrations = await remoteMigrationContract(binding);
    const requiredSchemaVersion = migrationFileContract().at(-1)?.version || 0;
    if (!recoveryVectorProtocolSupported(migrations) ||
        migrations.at(-1)?.version !== requiredSchemaVersion) {
      // Historical exact-prefix artifacts remain inspectable offline, but the
      // field runner promotes this package's current Worker. Once that Worker
      // reads a newly added column or table on an ordinary path, restoring an
      // older additive prefix would create an apparently healthy brain whose
      // next write fails. The runner has no implicit live-upgrade authority, so
      // stop before export, restore, or provider I/O and say what to do.
      refuse(code,
        `this brain's schema is at ${migrations.at(-1)?.version ?? "an unknown version"} and this recovery runner ` +
        `requires the current schema ${requiredSchemaVersion}. Run \`brain update <manifest>\` on it first, then recover. ` +
        "The runner never upgrades a brain implicitly.");
    }
    return migrations;
  }

  async function remoteDatabaseSnapshot(binding, { verifyFtsIntegrity = false } = {}) {
    const quickRows = await d1Rows(binding, QUICK_CHECK_SQL);
    const quick = quickRows?.[0];
    // FTS5 exposes integrity-check through a special INSERT command. Run it on
    // the disposable target only; source inspection remains SELECT-only.
    if (verifyFtsIntegrity) await d1Rows(binding, FTS_INTEGRITY_SQL);
    const migrationRows = await d1Rows(binding, MIGRATION_CONTRACT_SQL);
    const checkedMigrations = validateMigrationContract(migrationRows);
    await assertResultFamilyRecoveryStateEmpty(binding, checkedMigrations);
    assertExpectedTables(await d1Rows(binding, TABLE_INVENTORY_SQL), checkedMigrations);
    const schemaRows = normalizeSchemaRows(await d1Rows(binding, LOGICAL_SCHEMA_SQL));
    const aggregateRows = await d1Rows(binding, AGGREGATE_SQL);
    if (aggregateRows.length !== 1) refuse("RECOVERY_AGGREGATE_INVALID");
    return snapshotEvidence({
      quickCheck: String(quick?.quick_check ?? quick?.integrity_check ?? ""),
      migrations: checkedMigrations,
      schemaRows,
      aggregate: normalizeAggregate(aggregateRows[0]),
    });
  }

  async function targetUserTableCount() {
    const rows = await d1Rows(pins.binding.target, USER_TABLE_COUNT_SQL);
    if (rows.length !== 1) refuse("RECOVERY_TARGET_CLEAN_CHECK_INVALID");
    return nonNegativeInteger(rows[0]?.user_table_count, "RECOVERY_TARGET_CLEAN_CHECK_INVALID");
  }

  async function targetOutbox() {
    const rows = await d1Rows(pins.binding.target, OUTBOX_SQL);
    if (rows.length !== 1) refuse("RECOVERY_OUTBOX_RESPONSE_INVALID");
    return Object.freeze({
      pending_outbox: nonNegativeInteger(rows[0]?.pending_outbox, "RECOVERY_OUTBOX_RESPONSE_INVALID"),
      failed_vectors: nonNegativeInteger(rows[0]?.failed_vectors, "RECOVERY_OUTBOX_RESPONSE_INVALID"),
    });
  }

  async function assertTargetAgentAuthorityEmpty() {
    const rows = await d1Rows(pins.binding.target, AGENT_ACTION_RECEIPTS_SQL);
    if (rows.length !== 1 ||
        nonNegativeInteger(
          rows[0]?.agent_action_receipts,
          "RECOVERY_AGENT_AUTHORITY_INVALID",
        ) !== 0) {
      refuse("RECOVERY_AGENT_AUTHORITY_NOT_EMPTY");
    }
    return true;
  }

  function artifactEvidence() {
    assertNoRecoveryArtifactResidue(pins.artifacts.path);
    return hashStableArtifact(pins.artifactPath, plan.artifact.max_single_import_bytes);
  }

  async function remoteDataFingerprint(binding, {
    excludeBankItems = false,
    sessionGenerationMode = "preserve",
  } = {}) {
    const path = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-readback");
    assertNoKnownPlaintextPartial(path, pins.artifacts.path);
    try {
      return await captureRecoveryD1ContentFingerprint({
        binding,
        exportPath: path,
        maxBytes: plan.artifact.max_single_import_bytes,
        excludeBankItems,
        cleanupOnFailure: true,
        sessionGenerationMode,
      }, {
        readD1Rows: d1Rows,
        exportData: async ({ path: outputPath, tables }) => {
          await wrangler(binding, [
            "d1", "export", binding.databaseName,
            "--remote", "--no-schema", "--output", outputPath,
            ...tables.flatMap((table) => ["--table", table]),
          ]);
          if (process.platform !== "win32") chmodSync(outputPath, 0o600);
        },
        cleanupExport: async () => removeKnownPartial(path, pins.artifacts.path),
        // This adapter's D1 export is read-only and its recovery journal owns
        // retry ambiguity. Preserve the frozen adapter's reviewed behavior of
        // removing only this known private temporary path on a failed read.
      });
    } catch (error) {
      if (!(error instanceof RecoveryContentFingerprintError)) throw error;
      if (error.code === "RECOVERY_CONTENT_EXPORT_TOO_LARGE") {
        refuse("RECOVERY_EXPORT_ARTIFACT_TOO_LARGE");
      }
      if (error.code === "RECOVERY_CONTENT_EXPORT_CHANGED") {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      refuse("RECOVERY_EXPORT_ASSEMBLY_FAILED");
    }
  }

  async function targetDatabaseSnapshot() {
    const snapshot = await remoteDatabaseSnapshot(pins.binding.target, {
      verifyFtsIntegrity: true,
    });
    return Object.freeze({
      ...snapshot,
      content_fingerprint: await remoteDataFingerprint(pins.binding.target),
    });
  }

  function assertContext(context, stage) {
    if (!operationApproved) refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
    if (context?.stage !== stage || context?.planFingerprint !== plan.plan_fingerprint ||
        context?.targetResourceFingerprint !== plan.target_resource_fingerprint) {
      refuse("RECOVERY_ADAPTER_CONTEXT_INVALID");
    }
    return true;
  }

  function completedEvidence(context, stage) {
    return context.completed?.find((entry) => entry.id === stage)?.evidence ?? null;
  }

  function combineExport(
    migrations,
    normalizedInstallState,
    dataPartial,
    combinedPartial,
    dataFingerprint,
  ) {
    let output;
    let input;
    try {
      output = openSync(
        combinedPartial,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
      writeSync(output, Buffer.from(
        "-- Financial Brain verified recovery artifact.\n" +
        `-- Durable-data-sha256: ${dataFingerprint}\n` +
        "-- Checked-in applied migrations recreate schema and derived FTS.\n\n",
        "utf8",
      ));
      for (const migration of migrations) {
        const bytes = Buffer.from(`${migration.sql.trim()}\n\n`, "utf8");
        writeSync(output, bytes);
        bytes.fill(0);
      }
      const restoresPortableFamilyHistory = Number(migrations.at(-1)?.version || 0) >= 44;
      writeSync(output, normalizedInstallState);
      if (restoresPortableFamilyHistory) {
        const openFamilyHistoryImport = Buffer.from(
          `INSERT INTO "source_original_result_family_recovery_state" ("id","mode") ` +
          `VALUES (1,'verified_recovery_import');\n`,
          "utf8",
        );
        writeSync(output, openFamilyHistoryImport);
        openFamilyHistoryImport.fill(0);
      }
      const checkedData = assertArtifactFile(dataPartial, {
        maxBytes: plan.artifact.max_single_import_bytes,
        allowEmpty: true,
      });
      input = openSync(dataPartial, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const openedData = fstatSync(input);
      if (!sameFile(checkedData.info, openedData)) refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      const copiedDataHash = createHash("sha256").update(normalizedInstallState);
      const block = Buffer.allocUnsafe(1024 * 1024);
      for (;;) {
        const read = readSync(input, block, 0, block.length, null);
        if (!read) break;
        copiedDataHash.update(block.subarray(0, read));
        writeSync(output, block, 0, read);
      }
      block.fill(0);
      if (restoresPortableFamilyHistory) {
        const closeFamilyHistoryImport = Buffer.from(
          `\nDELETE FROM "source_original_result_family_recovery_state" ` +
          `WHERE "id"=1 AND "mode"='verified_recovery_import';\n` +
          `INSERT INTO "source_original_result_family_recovery_state" ("id","mode") ` +
          `SELECT 2,'verified_recovery_import' WHERE EXISTS (` +
          `SELECT 1 FROM "source_original_result_family_recovery_state");\n`,
          "utf8",
        );
        writeSync(output, closeFamilyHistoryImport);
        closeFamilyHistoryImport.fill(0);
      }
      const afterDataDescriptor = fstatSync(input);
      const afterDataPath = lstatSync(dataPartial);
      if (!sameFile(openedData, afterDataDescriptor) || !sameFile(openedData, afterDataPath) ||
          copiedDataHash.digest("hex") !== dataFingerprint) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      fsyncSync(output);
      fchmodSync(output, 0o600);
    } catch (error) {
      if (error instanceof CloudflareRecoveryAdapterError) throw error;
      refuse("RECOVERY_EXPORT_ASSEMBLY_FAILED");
    } finally {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
    }
  }

  async function withTargetKey(operation) {
    revalidate();
    const key = readAdminKey(pins.targetAdminLocator);
    if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key)) {
      refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_INVALID");
    }
    try { return await operation(key); } finally { revalidate(); }
  }

  async function withRecoveryArtifactKey(operation) {
    revalidate();
    let key;
    try {
      key = readRecoveryArtifactKey(pins.recoveryArtifactKeyLocator);
      validateRecoveryArtifactKey(key);
    } catch {
      refuse("RECOVERY_ARTIFACT_KEYCHAIN_VALUE_INVALID");
    }
    try { return await operation(key); } finally { revalidate(); }
  }

  async function withSourceKey(operation) {
    revalidate();
    if (!pins.sourceAdminLocator) refuse("RECOVERY_SOURCE_KEYCHAIN_REQUIRED");
    const key = readAdminKey(pins.sourceAdminLocator);
    if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key)) {
      refuse("RECOVERY_SOURCE_KEYCHAIN_VALUE_INVALID");
    }
    try { return await operation(key); } finally { revalidate(); }
  }

  async function bankKeyProof(binding, key) {
    const response = await exactFetch(
      fetchImpl,
      dataPlaneBase(binding),
      "/api/bank-feed/recovery-key-proof",
      { method: "POST", headers: { "X-Admin-Key": key } },
    );
    if (!response.ok) refuse("RECOVERY_BANK_KEY_PROOF_FAILED");
    return validateBankKeyProof(await boundedJsonResponse(response));
  }

  async function assertRecoverySecretReconciliation(targetMode) {
    const source = await assertExactCloudflareResources(pins.binding.source, "source");
    const target = await assertExactCloudflareResources(pins.binding.target, "target", targetMode);
    const expectedTarget = [...new Set([
      ...source.secretNames,
      RECOVERY_BANK_WRAPPING_SECRET_NAME,
    ])].sort();
    if (canonical(target.secretNames) !== canonical(expectedTarget)) {
      refuse("RECOVERY_WORKER_SECRET_RECONCILIATION_REQUIRED");
    }
    const targetProof = await withTargetKey((key) => bankKeyProof(pins.binding.target, key));
    if (!targetProof.configured) refuse("RECOVERY_BANK_KEY_PROOF_INVALID");
    if (source.secretNames.includes(RECOVERY_BANK_WRAPPING_SECRET_NAME)) {
      const sourceProof = await withSourceKey((key) => bankKeyProof(pins.binding.source, key));
      if (!sourceProof.configured || sourceProof.keyFingerprint !== targetProof.keyFingerprint) {
        refuse("RECOVERY_BANK_KEY_MISMATCH");
      }
    }
    return Object.freeze({ source, target, targetProof });
  }

  async function bankSecurityProof(key, reconciliationAt) {
    const rows = [];
    let cursor = 0;
    // The private journal is bounded. Never silently truncate a large bank
    // inventory; leave the target paused for a separately reviewed recovery.
    for (let page = 0; page < 10; page++) {
      const response = await exactFetch(fetchImpl, dataPlaneBase(pins.binding.target),
        "/api/bank-feed/recovery-key-proof", {
          method: "POST", headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ protocol: "bank-security-v1", offset: cursor,
            reconciliation_at: reconciliationAt }),
        });
      if (!response.ok) refuse("RECOVERY_BANK_SECURITY_PROOF_FAILED");
      const proof = await boundedJsonResponse(response);
      exactAggregateReceiptFields(proof,
        ["protocol", "count", "fingerprint", "proofs", "next_offset"],
        "RECOVERY_BANK_SECURITY_PROOF_INVALID");
      if (proof.protocol !== "bank-security-v1" || !Array.isArray(proof.proofs) ||
          proof.proofs.length > 100 || proof.count !== proof.proofs.length ||
          proof.fingerprint !== sha256(canonical({ protocol: proof.protocol, proofs: proof.proofs })) ||
          (proof.next_offset !== null && (proof.next_offset !== cursor + 100 || proof.count !== 100))) {
        refuse("RECOVERY_BANK_SECURITY_PROOF_INVALID");
      }
      rows.push(...proof.proofs);
      if (proof.next_offset === null) {
        const result = { protocol: "bank-security-v1", reconciliation_at: reconciliationAt, rows };
        try { validateBankRecoveryProof(result); } catch {
          refuse("RECOVERY_BANK_SECURITY_PROOF_INVALID");
        }
        return result;
      }
      cursor = proof.next_offset;
    }
    refuse("RECOVERY_BANK_SECURITY_PROOF_LIMIT_REACHED");
  }

  async function assertBankRecoveryEquivalent(restored, code, { requireComplete = false } = {}) {
    try { validateBankRecoveryProof(restored?.bank_security_proof); } catch { refuse(code); }
    if (!SHA256_RE.test(restored?.non_bank_content_fingerprint || "") ||
        restored.bank_security_fingerprint !== sha256(canonical(restored.bank_security_proof))) {
      refuse(code);
    }
    const before = await targetDatabaseSnapshot();
    assertSameStructuralSnapshot(before, restored, code);
    const nonBank = await remoteDataFingerprint(pins.binding.target, { excludeBankItems: true });
    const current = await withTargetKey((key) => bankSecurityProof(
      key, restored.bank_security_proof.reconciliation_at,
    ));
    if (nonBank !== restored.non_bank_content_fingerprint ||
        current.rows.length !== restored.bank_security_proof.rows.length ||
        current.rows.some((pair, index) => !restored.bank_security_proof.rows[index].includes(pair[0])) ||
        (requireComplete && current.rows.some((pair) => pair[0] !== pair[1]))) {
      refuse(code);
    }
    // A changing target cannot mix the proof of one snapshot with another.
    const after = await targetDatabaseSnapshot();
    assertSameSnapshot(after, before, code);
    return after;
  }

  async function driveRecoveredBankReconciliation(key, reconciliationAt) {
    let previousRemaining = null;
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const response = await exactFetch(
        fetchImpl,
        dataPlaneBase(pins.binding.target),
        "/api/bank-feed/reconcile-recovery",
        { method: "POST", headers: { "X-Admin-Key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ protocol: "bank-security-v1", reconciliation_at: reconciliationAt }) },
      );
      if (!response.ok) refuse("RECOVERY_BANK_RECONCILIATION_FAILED");
      const receipt = validateBankReconciliation(await boundedJsonResponse(response));
      if (receipt.unsupported_key_versions !== 0) {
        refuse("RECOVERY_BANK_KEY_VERSION_UNSUPPORTED");
      }
      if (receipt.legacy_rewrap_required === 0) return receipt;
      if (previousRemaining !== null && receipt.legacy_rewrap_required >= previousRemaining &&
          receipt.rewrapped === 0 && receipt.reauthorization_required === 0) {
        refuse("RECOVERY_BANK_RECONCILIATION_STALLED");
      }
      previousRemaining = receipt.legacy_rewrap_required;
    }
    refuse("RECOVERY_BANK_RECONCILIATION_LIMIT_REACHED");
  }

  async function targetHealth(expectedMode) {
    const response = await exactFetch(
      fetchImpl,
      dataPlaneBase(pins.binding.target),
      "/health",
      { method: "GET" },
      60_000,
    );
    if (response.status !== 200) refuse("RECOVERY_HEALTH_FAILED");
    const health = await boundedJsonResponse(response);
    const active = expectedMode === "active";
    // A reachable paused Worker deliberately reports not-ok and refuses
    // documents. Requiring ok:true would reject the real compatibility Worker
    // while accepting a response that conceals a missing write barrier.
    // Paused health deliberately performs no D1 read, but active health must
    // prove that the promoted Worker is serving against this package's schema.
    const requiredSchemaVersion = migrationFileContract().at(-1)?.version || 0;
    if (!["active", "paused-for-upgrade"].includes(expectedMode) ||
        health?.ok !== active || health?.accepting_documents !== active ||
        health?.status !== (active ? "ok" : "paused-for-upgrade") ||
        health?.version !== pins.binding.target.productVersion ||
        health?.brain !== pins.binding.target.clientSlug ||
        health?.vector_writer_protocol !== "lease-v1" ||
        health?.vector_drain_mode !== expectedMode ||
        (active && health?.schema_version !== requiredSchemaVersion)) {
      refuse("RECOVERY_HEALTH_IDENTITY_MISMATCH");
    }
    return health;
  }

  async function targetVectorInventory(key, expectedVectors, code) {
    const response = await exactFetch(
      fetchImpl,
      dataPlaneBase(pins.binding.target),
      "/api/admin/brain/documents",
      { method: "GET", headers: { "X-Admin-Key": key } },
    );
    if (!response.ok) refuse(code);
    return validateExactVectorInventory(
      await boundedJsonResponse(response),
      expectedVectors,
      code,
    );
  }

  async function drivePausedBootstrap(key, restored) {
    const expectedTotal = restored.chunk_count;
    if (testBootstrapRequest &&
        (restored.document_count !== testBootstrapCandidateEvidence.seedDocumentCount ||
         restored.chunk_count !== testBootstrapCandidateEvidence.seedChunkCount ||
         restored.fts_count !== testBootstrapCandidateEvidence.seedFtsCount ||
         restored.content_fingerprint !==
           testBootstrapCandidateEvidence.seedD1ContentFingerprint ||
         restored.document_count !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
         restored.chunk_count < MIN_RECOVERY_TEST_FIELD_CHUNKS ||
         restored.fts_count !== restored.chunk_count)) {
      refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SCALE_INVALID");
    }
    const startedAt = nonNegativeInteger(now(), "RECOVERY_BOOTSTRAP_CLOCK_INVALID");
    let previous = testBootstrapCheckpoint
      ? Object.freeze({
          protocol: "bootstrap-v2",
          phase: "building",
          epoch: testBootstrapCheckpoint.observation.epoch,
          total: expectedTotal,
          confirmed: testBootstrapCheckpoint.observation.confirmed,
          queued: testBootstrapCheckpoint.observation.queued,
          submitted: testBootstrapCheckpoint.observation.submitted,
          remaining: expectedTotal - testBootstrapCheckpoint.observation.confirmed,
          inFlightBatches: Number(testBootstrapCheckpoint.observation.queued > 0) +
            Number(testBootstrapCheckpoint.observation.submitted > 0),
          failed: 0,
          retrying: 0,
          complete: false,
          vectorReady: false,
          expectedVectors: expectedTotal,
          actualVectors: testBootstrapCheckpoint.observation.provider_vectors,
        })
      : null;
    let previousRemaining = previous?.remaining ?? expectedTotal;
    for (let round = 0; round < MAX_BOOTSTRAP_ROUNDS; round++) {
      const currentTime = nonNegativeInteger(now(), "RECOVERY_BOOTSTRAP_CLOCK_INVALID");
      if (currentTime < startedAt || currentTime - startedAt > MAX_BOOTSTRAP_DURATION_MS) {
        refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
      }
      const response = await exactFetch(
        fetchImpl,
        dataPlaneBase(pins.binding.target),
        "/api/admin/brain/bootstrap",
        {
          method: "POST",
          headers: { "X-Admin-Key": key },
        },
      );
      if (response.status === 409) {
        const busy = validateBootstrapBusyReceipt(
          await boundedJsonResponse(response),
          previousRemaining,
        );
        previousRemaining = busy.remaining;
        const waitMs = busy.retryAfterSeconds * 1_000;
        if (currentTime + waitMs - startedAt > MAX_BOOTSTRAP_DURATION_MS) {
          refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
        }
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) refuse("RECOVERY_DATA_PLANE_WRITE_FAILED");
      const receipt = validateBootstrapProgress(
        previous,
        validateBootstrapReceipt(await boundedJsonResponse(response), expectedTotal),
      );
      previous = receipt;
      previousRemaining = receipt.remaining;
      if (testBootstrapCheckpoint) {
        await observeTestBootstrapPoint("progress", restored, receipt);
      }
      if (receipt.complete) {
        if (testBootstrapRequest && !testBootstrapCheckpoint) {
          // A requested test fault that never reached its reviewed midpoint is
          // not proof. Stop while the paused version is still deployed.
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_POINT_NOT_REACHED");
        }
        return receipt;
      }
      if (testBootstrapRequest && !testBootstrapCheckpoint) {
        const observed = await observeTestBootstrapPoint("interrupt", restored, receipt);
        if (observed.observation.ready_to_interrupt) {
          revalidate();
          testBootstrapCheckpointRecord = writeTestBootstrapCheckpoint(
            pins,
            plan,
            testBootstrapCandidateEvidence,
            testBootstrapApprovalFingerprint,
            observed.privateCursorSha256,
            observed.observation,
          );
          testBootstrapCheckpoint = testBootstrapCheckpointRecord.value;
          revalidate();
          refuse(RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_CODE);
        }
      }
      await sleep(BOOTSTRAP_POLL_MS);
    }
    refuse("RECOVERY_BOOTSTRAP_LIMIT_REACHED");
  }

  async function exactTargetVectorCount(expectedVectors) {
    let count = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      count = (await vectorInfo(pins.binding.target)).vectorCount;
      if (count === expectedVectors) return count;
      if (count > expectedVectors) refuse("RECOVERY_VECTORIZE_COUNT_MISMATCH");
      await sleep(5_000);
    }
    refuse("RECOVERY_VECTORIZE_COUNT_MISMATCH");
  }

  async function promoteReviewedActiveWorker() {
    await wrangler(pins.binding.target, [
      "versions", "deploy", `${pins.isolation.activeWorkerVersionId}@100%`,
      "--name", pins.binding.target.workerName, "-y",
    ]);
  }

  const adapters = {
    export_d1: async (context) => {
      assertContext(context, "export_d1");
      assertNoRecoveryArtifactResidue(pins.artifacts.path);
      await assertExactCloudflareResources(pins.binding.source, "source");
      const migrations = await requireCurrentRecoverySchema(
        pins.binding.source,
        "RECOVERY_SOURCE_UPGRADE_REQUIRED",
      );
      await assertResultFamilyRecoveryStateEmpty(pins.binding.source, migrations);
      assertExpectedTables(await d1Rows(pins.binding.source, TABLE_INVENTORY_SQL), migrations);
      const dataPartial = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-data");
      const combinedPartial = join(pins.artifacts.path, ".brain-recovery-export.sql.tmp-combined");
      if (reconcileExportResidue(
        pins.artifactPath,
        dataPartial,
        combinedPartial,
        pins.artifacts.path,
        plan.artifact.max_single_import_bytes,
      )) {
        // A durable artifact can predate the local completion receipt only
        // after an ambiguous first export attempt. On attempt one, accepting a
        // pre-existing same-key artifact could restore stale corpus content.
        if (!Number.isSafeInteger(context.attempt) || context.attempt <= 1) {
          refuse("RECOVERY_EXPORT_ARTIFACT_APPEARED");
        }
        return artifactEvidence();
      }
      let normalizedInstallState = null;
      try {
        normalizedInstallState = await normalizedInstallStateExport(
          pins.binding.source,
          migrations,
          d1Rows,
        );
        await wrangler(pins.binding.source, [
          "d1", "export", pins.binding.source.databaseName,
          "--remote", "--no-schema", "--output", dataPartial,
          ...recoveryExportTables(migrations).flatMap((table) => ["--table", table]),
        ]);
        if (process.platform !== "win32") chmodSync(dataPartial, 0o600);
        assertArtifactFile(dataPartial, { maxBytes: plan.artifact.max_single_import_bytes, allowEmpty: true });
        const dataFingerprint = hashNormalizedDataExport(
          normalizedInstallState,
          dataPartial,
          plan.artifact.max_single_import_bytes,
        );
        combineExport(
          migrations,
          normalizedInstallState,
          dataPartial,
          combinedPartial,
          dataFingerprint,
        );
        const combined = assertArtifactFile(combinedPartial, {
          maxBytes: plan.artifact.max_single_import_bytes,
        });
        try {
          await withRecoveryArtifactKey((key) =>
            encryptRecoveryArtifact(combined.path, pins.artifactPath, key));
        } catch (error) {
          if (error instanceof CloudflareRecoveryAdapterError) throw error;
          refuse("RECOVERY_EXPORT_ENCRYPTION_FAILED");
        }
        unlinkSync(combinedPartial);
        unlinkSync(dataPartial);
        syncDirectory(pins.artifacts.path);
        return artifactEvidence();
      } catch (error) {
        try { removeKnownPartial(dataPartial, pins.artifacts.path); } catch { /* original fixed failure wins */ }
        try { removeKnownPartial(combinedPartial, pins.artifacts.path); } catch { /* original fixed failure wins */ }
        throw error;
      } finally {
        if (normalizedInstallState) normalizedInstallState.fill(0);
      }
    },

    verify_export: async (context) => {
      assertContext(context, "verify_export");
      const exported = completedEvidence(context, "export_d1");
      const artifact = artifactEvidence();
      if (artifact.artifact_sha256 !== exported?.artifact_sha256 ||
          artifact.artifact_bytes !== exported?.artifact_bytes) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      await assertExactCloudflareResources(pins.binding.source, "source");
      await remoteMigrationContract(pins.binding.source);
      const inspected = await withRecoveryArtifactKey((key) =>
        withDecryptedRecoveryArtifact(
          pins.artifactPath,
          pins.artifacts.path,
          key,
          async (plaintextPath) => Object.freeze({
            local: await verifySqlArtifact(plaintextPath, {
              maxBytes: plan.artifact.max_single_import_bytes,
            }),
            contentFingerprint: recoveryArtifactDataFingerprint(
              plaintextPath,
              plan.artifact.max_single_import_bytes,
            ),
          }),
        ));
      const local = inspected.local;
      const remote = await remoteDatabaseSnapshot(pins.binding.source);
      assertSameStructuralSnapshot(local, remote, "RECOVERY_EXPORT_SOURCE_MISMATCH");
      if (testBootstrapRequest) {
        // The encrypted recovery artifact intentionally advances the owner
        // session generation exactly once. Apply that same deterministic
        // projection to the live source readback so its direct fingerprint can
        // equal the artifact while target readbacks preserve the restored value.
        const directSourceFingerprint = await remoteDataFingerprint(
          pins.binding.source,
          { sessionGenerationMode: "increment" },
        );
        const closingRemote = await remoteDatabaseSnapshot(pins.binding.source);
        assertSameStructuralSnapshot(
          remote,
          closingRemote,
          "RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SEED_MISMATCH",
        );
        if (local.document_count !== testBootstrapCandidateEvidence.seedDocumentCount ||
            local.chunk_count !== testBootstrapCandidateEvidence.seedChunkCount ||
            local.fts_count !== testBootstrapCandidateEvidence.seedFtsCount ||
            testBootstrapCandidateEvidence.seedVectorCount !== local.chunk_count ||
            inspected.contentFingerprint !==
              testBootstrapCandidateEvidence.seedD1ContentFingerprint ||
            directSourceFingerprint !==
              testBootstrapCandidateEvidence.seedD1ContentFingerprint) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SEED_MISMATCH");
        }
      }
      return Object.freeze({
        ...artifact,
        ...local,
        content_fingerprint: inspected.contentFingerprint,
      });
    },

    prove_target_clean: async (context) => {
      assertContext(context, "prove_target_clean");
      const { target: resources } = await assertRecoverySecretReconciliation("paused");
      await targetHealth("paused-for-upgrade");
      const userTableCount = await targetUserTableCount();
      return Object.freeze({
        target_resource_fingerprint: plan.target_resource_fingerprint,
        user_table_count: userTableCount,
        vector_count: resources.vectorCount,
        vector_dimensions: 768,
        vector_metric: "cosine",
      });
    },

    restore_d1: async (context) => {
      assertContext(context, "restore_d1");
      const artifact = artifactEvidence();
      const exported = completedEvidence(context, "verify_export");
      if (artifact.artifact_sha256 !== exported?.artifact_sha256 ||
          artifact.artifact_bytes !== exported?.artifact_bytes) {
        refuse("RECOVERY_EXPORT_ARTIFACT_CHANGED");
      }
      const { target: resources } = await assertRecoverySecretReconciliation("paused");
      await targetHealth("paused-for-upgrade");
      const tables = await targetUserTableCount();
      if (tables > 0) {
        // A populated target is reconcilable only after this exact stage had an
        // ambiguous prior attempt. On attempt one it changed outside the gate.
        if (context.attempt === 1) refuse("RECOVERY_TARGET_IMPORT_AMBIGUOUS");
        const existing = await targetDatabaseSnapshot();
        assertSameSnapshot(existing, exported, "RECOVERY_TARGET_IMPORT_AMBIGUOUS");
        return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
      }
      if (resources.vectorCount !== 0) refuse("RECOVERY_TARGET_IMPORT_AMBIGUOUS");
      try {
        await withRecoveryArtifactKey((key) =>
          withDecryptedRecoveryArtifact(
            pins.artifactPath,
            pins.artifacts.path,
            key,
            (plaintextPath) => wrangler(pins.binding.target, [
              "d1", "execute", pins.binding.target.databaseName,
              "--remote", "--file", plaintextPath, "--yes",
            ]),
          ));
      } catch (error) {
        try {
          const reconciled = await targetDatabaseSnapshot();
          assertSameSnapshot(reconciled, exported, "RECOVERY_TARGET_IMPORT_AMBIGUOUS");
          return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
        } catch {
          throw error;
        }
      }
      const restored = await targetDatabaseSnapshot();
      assertSameSnapshot(restored, exported, "RECOVERY_TARGET_IMPORT_MISMATCH");
      return Object.freeze({ artifact_sha256: artifact.artifact_sha256, import_completed: true });
    },

    verify_d1: async (context) => {
      assertContext(context, "verify_d1");
      await assertExactCloudflareResources(pins.binding.target, "target", "paused");
      await targetHealth("paused-for-upgrade");
      await requireCurrentRecoverySchema(pins.binding.target);
      const restored = await targetDatabaseSnapshot();
      const nonBank = await remoteDataFingerprint(pins.binding.target, { excludeBankItems: true });
      const bankProof = await withTargetKey((key) => bankSecurityProof(key, new Date(now()).toISOString()));
      assertSameSnapshot(await targetDatabaseSnapshot(), restored, "RECOVERY_TARGET_CHANGED_DURING_SECURITY_BASELINE");
      return Object.freeze({ ...restored, non_bank_content_fingerprint: nonBank,
        bank_security_proof: bankProof, bank_security_fingerprint: sha256(canonical(bankProof)) });
    },

    reconcile_security: async (context) => {
      assertContext(context, "reconcile_security");
      await assertRecoverySecretReconciliation("paused");
      const restored = completedEvidence(context, "verify_d1");
      await assertTargetAgentAuthorityEmpty();
      await assertBankRecoveryEquivalent(restored, "RECOVERY_TARGET_CHANGED_BEFORE_SECURITY_RECONCILIATION");
      const receipt = await withTargetKey((key) => driveRecoveredBankReconciliation(
        key, restored.bank_security_proof.reconciliation_at,
      ));
      await assertTargetAgentAuthorityEmpty();
      const reconciled = await assertBankRecoveryEquivalent(
        restored, "RECOVERY_TARGET_CHANGED_DURING_SECURITY_RECONCILIATION", { requireComplete: true });
      return Object.freeze({
        ...reconciled,
        bank_protected: receipt.protected,
        bank_reauthorization_required: receipt.reauthorization_required_total,
        bank_legacy_rewrap_required: receipt.legacy_rewrap_required,
        bank_unsupported_key_versions: receipt.unsupported_key_versions,
      });
    },

    rebuild_vectorize: async (context) => {
      assertContext(context, "rebuild_vectorize");
      const restored = completedEvidence(context, "reconcile_security") ||
        completedEvidence(context, "verify_d1");
      if (testBootstrapRequest &&
          (restored?.document_count !== testBootstrapCandidateEvidence.seedDocumentCount ||
           restored?.chunk_count !== testBootstrapCandidateEvidence.seedChunkCount ||
           restored?.fts_count !== testBootstrapCandidateEvidence.seedFtsCount ||
           restored?.content_fingerprint !==
             testBootstrapCandidateEvidence.seedD1ContentFingerprint ||
           restored?.document_count !== DISPOSABLE_RECOVERY_SEED_DOCUMENTS ||
           restored?.chunk_count < MIN_RECOVERY_TEST_FIELD_CHUNKS ||
           restored?.fts_count !== restored?.chunk_count)) {
        refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SCALE_INVALID");
      }
      // Recheck on every resumed rebuild. An old journal checkpoint or an
      // out-of-band target replacement must never route schema-prefix data to
      // the current bulk bootstrap endpoint.
      await requireCurrentRecoverySchema(pins.binding.target);
      assertSameRecoveryCorpus(
        await targetDatabaseSnapshot(),
        restored,
        "RECOVERY_TARGET_CHANGED_BEFORE_REINDEX",
      );
      const initialOutbox = await targetOutbox();
      if (context.attempt === 1 &&
          (initialOutbox.pending_outbox !== 0 || initialOutbox.failed_vectors !== 0)) {
        refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      }
      const requiredTargetMode = testBootstrapRequest &&
          !testBootstrapPromotionAuthorization
        ? "paused"
        : "either";
      const resources = await assertExactCloudflareResources(
        pins.binding.target,
        "target",
        requiredTargetMode,
      );
      if (context.attempt === 1 && resources.targetMode !== "paused") {
        refuse("RECOVERY_TARGET_EXECUTION_CHANGED");
      }
      if (resources.vectorCount > restored.chunk_count) refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      if (context.attempt === 1 && resources.vectorCount !== 0) {
        refuse("RECOVERY_VECTORIZE_TARGET_AMBIGUOUS");
      }
      if (testBootstrapRequest && !testBootstrapCheckpoint) {
        // Bind the synthetic campaign to a truly unopened epoch before the
        // first bootstrap POST or Brain admin-key read. Pre-existing partial
        // work cannot be relabelled as this drill's controlled interruption.
        await observeTestBootstrapOpening(restored);
      } else if (testBootstrapCheckpoint && !testBootstrapResumeAuthorization &&
          !testBootstrapPromotionAuthorization) {
        // Prove the exact paused remote cut before resolving any admin key.
        // A stale or copied checkpoint needs read-only provider inspection,
        // but it has no reason to touch credentials or the data-plane door.
        const exactResumeProof = await observeTestBootstrapPoint("resume", restored);
        revalidate();
        testBootstrapResumeAuthorizationRecord = writeTestBootstrapResumeAuthorization(
          pins,
          plan,
          testBootstrapCandidateEvidence,
          testBootstrapApprovalFingerprint,
          testBootstrapCheckpointRecord,
          restored,
          exactResumeProof.privateCursorSha256,
          exactResumeProof.observation,
        );
        testBootstrapResumeAuthorization =
          testBootstrapResumeAuthorizationRecord.value;
        revalidate();
      } else if (testBootstrapResumeAuthorization &&
          !testBootstrapPromotionAuthorization) {
        const currentReceipt = await currentTestBootstrapReceipt(restored);
        await observeTestBootstrapPoint("resume_progress", restored, currentReceipt);
      } else if (testBootstrapPromotionAuthorization &&
          resources.targetMode === "paused") {
        const currentPromotionProof = await observeTestBootstrapPoint(
          "promotion",
          restored,
          promotionAggregateBootstrapReceipt(
            testBootstrapPromotionAuthorization.observation,
          ),
        );
        if (canonical(currentPromotionProof.observation) !==
              canonical(testBootstrapPromotionAuthorization.observation) ||
            currentPromotionProof.privateCursorSha256 !==
              testBootstrapPromotionAuthorization.private_cursor_sha256) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_PROMOTION_AUTHORIZATION_INVALID");
        }
      }
      await assertRecoverySecretReconciliation(requiredTargetMode);

      if (resources.targetMode === "paused") {
        await targetHealth("paused-for-upgrade");
        let completedBootstrapReceipt = null;
        await withTargetKey(async (key) => {
          if (!testBootstrapPromotionAuthorization) {
            // The verified artifact already normalizes a nonempty corpus to one
            // bootstrap epoch with its exact SQL high-water. Never call reindex
            // here: resetting the epoch on a retry would discard durable cursor
            // and provider-receipt progress.
            completedBootstrapReceipt = await drivePausedBootstrap(key, restored);
          }
          await targetVectorInventory(
            key,
            restored.chunk_count,
            "RECOVERY_VECTORIZE_NOT_READY",
          );
        });
        const pausedOutbox = await targetOutbox();
        if (pausedOutbox.pending_outbox !== 0 || pausedOutbox.failed_vectors !== 0) {
          refuse("RECOVERY_VECTORIZE_NOT_READY");
        }
        await exactTargetVectorCount(restored.chunk_count);
        // Bootstrap may only mutate projection receipts and the derived index.
        // Re-prove the restored corpus immediately before active code becomes
        // reachable so a compromised or drifting paused Worker cannot smuggle
        // a D1 content change through a vector-complete receipt.
        assertSameRecoveryCorpus(
          await targetDatabaseSnapshot(),
          restored,
          "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
        );
        await assertExactCloudflareResources(pins.binding.target, "target", "paused");
        await targetHealth("paused-for-upgrade");
        if (testBootstrapCheckpoint && !testBootstrapPromotionAuthorization) {
          const promotionProof = await observeTestBootstrapPoint(
            "promotion",
            restored,
            completedBootstrapReceipt,
          );
          revalidate();
          testBootstrapPromotionAuthorizationRecord =
            writeTestBootstrapPromotionAuthorization(
            pins,
            plan,
            testBootstrapCandidateEvidence,
            testBootstrapApprovalFingerprint,
            testBootstrapCheckpointRecord,
            restored,
            promotionProof.privateCursorSha256,
            promotionProof.observation,
          );
          testBootstrapPromotionAuthorization =
            testBootstrapPromotionAuthorizationRecord.value;
          revalidate();
        }
        // Both immutable versions and every binding were proven above. This is
        // the only state-changing Worker command the adapter permits. If the
        // command succeeds remotely but its response is lost, the next stage
        // attempt reconciles the already-active version from exact evidence.
        await promoteReviewedActiveWorker();
      }

      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      await targetHealth("active");
      await withTargetKey((key) => targetVectorInventory(
        key,
        restored.chunk_count,
        "RECOVERY_VECTORIZE_NOT_READY",
      ));
      const outbox = await targetOutbox();
      if (outbox.pending_outbox !== 0 || outbox.failed_vectors !== 0) {
        refuse("RECOVERY_VECTORIZE_NOT_READY");
      }
      const vectors = await exactTargetVectorCount(restored.chunk_count);
      assertSameRecoveryCorpus(
        await targetDatabaseSnapshot(),
        restored,
        "RECOVERY_TARGET_CHANGED_DURING_REINDEX",
      );
      if (testBootstrapRequest &&
          (!testBootstrapCheckpointRecord?.pin?.hash ||
           !testBootstrapResumeAuthorizationRecord?.pin?.hash ||
           !testBootstrapPromotionAuthorizationRecord?.pin?.hash)) {
        refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CONTROL_PROOF_INCOMPLETE");
      }
      return Object.freeze({
        chunk_count: restored.chunk_count,
        vector_count: vectors,
        pending_outbox: outbox.pending_outbox,
        failed_vectors: outbox.failed_vectors,
        ...(testBootstrapRequest ? {
          source_phase_receipt_sha256:
            testBootstrapCandidateEvidence.sourcePhaseReceiptSha256,
          deployment_receipt_sha256:
            testBootstrapCandidateEvidence.deploymentReceiptSha256,
          seed_receipt_sha256: testBootstrapCandidateEvidence.seedReceiptSha256,
          bootstrap_interruption_checkpoint_sha256:
            testBootstrapCheckpointRecord.pin.hash,
          bootstrap_resume_authorization_sha256:
            testBootstrapResumeAuthorizationRecord.pin.hash,
          bootstrap_promotion_authorization_sha256:
            testBootstrapPromotionAuthorizationRecord.pin.hash,
        } : {}),
      });
    },

    verify_health: async (context) => {
      assertContext(context, "verify_health");
      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      const base = dataPlaneBase(pins.binding.target);
      await targetHealth("active");
      const rebuilt = completedEvidence(context, "rebuild_vectorize");
      const expectedVectors = nonNegativeInteger(
        rebuilt?.chunk_count,
        "RECOVERY_HEALTH_FAILED",
      );
      await withTargetKey(async (key) => {
        await targetVectorInventory(key, expectedVectors, "RECOVERY_HEALTH_FAILED");
        const noKey = await exactFetch(fetchImpl, base, "/api/rag/unified", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: "recovery authorization probe", limit: 1 }),
        });
        if (noKey.status !== 401) refuse("RECOVERY_AUTHORIZATION_FAILED");
        const wrongKey = await exactFetch(fetchImpl, base, "/api/rag/unified", {
          method: "POST",
          headers: {
            "X-Admin-Key": "recovery-field-gate-invalid-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: "recovery authorization probe", limit: 1 }),
        });
        if (wrongKey.status !== 401) refuse("RECOVERY_AUTHORIZATION_FAILED");
      });
      return Object.freeze({ status: "pass", failure_count: 0, vector_backlog: 0 });
    },

    verify_eval: async (context) => {
      assertContext(context, "verify_eval");
      revalidate();
      await assertExactCloudflareResources(pins.binding.target, "target", "active");
      await targetHealth("active");
      const key = readAdminKey(pins.targetAdminLocator);
      if (typeof key !== "string" || !key || key.length > 4096 || /[\r\n\0]/.test(key)) {
        refuse("RECOVERY_TARGET_KEYCHAIN_VALUE_INVALID");
      }
      const input = Buffer.from(`${key}\n`, "utf8");
      try {
        const result = await runEval({
          args: [
            EVAL_RUNNER,
            "--base", dataPlaneBase(pins.binding.target),
            "--golden", pins.golden.path,
            "--profile", "release",
          ],
          env: evalChildEnvironment(config.environment),
          input,
          cwd: ROOT,
          timeoutMs: MAX_EVAL_TIMEOUT_MS,
        });
        if (result?.status !== 0 || result?.signal || result?.error) {
          refuse("RECOVERY_RELEASE_EVAL_FAILED");
        }
        // A long private evaluation cannot inherit its success across an
        // out-of-band deployment. Prove the exact active version and protocol
        // again before checkpointing the release result.
        await assertExactCloudflareResources(pins.binding.target, "target", "active");
        await targetHealth("active");
      } finally {
        input.fill(0);
        revalidate();
      }
      return Object.freeze({
        profile: "release",
        status: "pass",
        critical_failures: 0,
        unauthorized_retrievals: 0,
      });
    },
  };

  return Object.freeze({
    adapters: Object.freeze(adapters),
    revalidate,
    assertReceiptBackedSourceDeploymentPin,
    targetExecutionApprovalFingerprint: pins.isolation.approvalFingerprint,
    wrapperApprovalFingerprint: pins.wrapper.hash,
    goldenApprovalFingerprint: pins.golden.hash,
    testBootstrapCandidateEvidence: testBootstrapCandidateEvidence
      ? Object.freeze({
          candidateSha: testBootstrapCandidateEvidence.candidateSha,
          candidateTreeSha: testBootstrapCandidateEvidence.candidateTreeSha,
          fieldReceiptRunId: testBootstrapCandidateEvidence.fieldReceiptRunId,
          fieldReceiptSha256: testBootstrapCandidateEvidence.fieldReceiptSha256,
          packageFilename: testBootstrapCandidateEvidence.packageFilename,
          packageBytes: testBootstrapCandidateEvidence.packageBytes,
          packageSha256: testBootstrapCandidateEvidence.packageSha256,
          packageFileCount: testBootstrapCandidateEvidence.packageFileCount,
          executionInventorySha256:
            testBootstrapCandidateEvidence.executionInventorySha256,
          sourcePreflightReceiptSha256:
            testBootstrapCandidateEvidence.sourcePreflightReceiptSha256,
          sourcePhaseReceiptSha256:
            testBootstrapCandidateEvidence.sourcePhaseReceiptSha256,
          deploymentReceiptSha256:
            testBootstrapCandidateEvidence.deploymentReceiptSha256,
          seedReceiptSha256: testBootstrapCandidateEvidence.seedReceiptSha256,
          targetPreflightReceiptSha256:
            testBootstrapCandidateEvidence.targetPreflightReceiptSha256,
          seedFixtureSha256: testBootstrapCandidateEvidence.seedFixtureSha256,
          seedD1ContentFingerprint:
            testBootstrapCandidateEvidence.seedD1ContentFingerprint,
          seedDocumentCount: testBootstrapCandidateEvidence.seedDocumentCount,
          seedChunkCount: testBootstrapCandidateEvidence.seedChunkCount,
          seedFtsCount: testBootstrapCandidateEvidence.seedFtsCount,
          seedVectorCount: testBootstrapCandidateEvidence.seedVectorCount,
          seedReplayUnchangedDocuments:
            testBootstrapCandidateEvidence.seedReplayUnchangedDocuments,
          wranglerRuntimeInventorySha256:
            testBootstrapCandidateEvidence.wranglerRuntimeInventorySha256,
          wranglerRuntimeEntrypoint:
            testBootstrapCandidateEvidence.wranglerRuntimeEntrypoint,
          wranglerRuntimeEntrypointSha256:
            testBootstrapCandidateEvidence.wranglerRuntimeEntrypointSha256,
          wranglerRuntimePackageCount:
            testBootstrapCandidateEvidence.wranglerRuntimePackageCount,
          wranglerRuntimeFileCount:
            testBootstrapCandidateEvidence.wranglerRuntimeFileCount,
          wranglerRuntimeBytes: testBootstrapCandidateEvidence.wranglerRuntimeBytes,
          wranglerRuntimeDirectory:
            testBootstrapCandidateEvidence.wranglerRuntimeDirectory,
          wranglerRuntimeSchemaVersion:
            testBootstrapCandidateEvidence.wranglerRuntimeSchemaVersion,
          wranglerHostPlatform: testBootstrapCandidateEvidence.wranglerHostPlatform,
          wranglerHostArch: testBootstrapCandidateEvidence.wranglerHostArch,
          wranglerHostLibc: testBootstrapCandidateEvidence.wranglerHostLibc,
          nodeVersion: testBootstrapCandidateEvidence.nodeVersion,
          nodeExecutableSha256: testBootstrapCandidateEvidence.nodeExecutableSha256,
        })
      : null,
    testBootstrapInterruptionApprovalFingerprint: testBootstrapApprovalFingerprint,
    acquireLock: () => acquireFieldGateLock(pins.artifacts.path, plan.plan_fingerprint),
    releaseLock: (lock) => releaseFieldGateLock(lock, pins.artifacts.path),
    retireTestBootstrapCheckpoint: () => {
      if (!testBootstrapRequest || !testBootstrapCheckpointRecord) {
        refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_CHECKPOINT_RETIRE_FAILED");
      }
      const retired = retireTestBootstrapCheckpoint(
        pins,
        testBootstrapCheckpointRecord,
        testBootstrapResumeAuthorizationRecord,
        testBootstrapPromotionAuthorizationRecord,
      );
      testBootstrapCheckpointRecord = retired.checkpoint;
      testBootstrapCheckpoint = retired.checkpoint.value;
      testBootstrapResumeAuthorizationRecord = retired.resume;
      testBootstrapResumeAuthorization = retired.resume.value;
      testBootstrapPromotionAuthorizationRecord = retired.promotion;
      testBootstrapPromotionAuthorization = retired.promotion.value;
      return retired.checkpoint.pin.path;
    },
  });
}

function normalizeFieldGateConfig(input) {
  const required = [
    "sourceManifestPath", "targetManifestPath", "planPath", "statePath",
    "artifactDirectory", "wranglerWrapperPath", "goldenPath",
  ];
  if (!input || required.some((key) => typeof input[key] !== "string" || !input[key])) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  if (input.fieldDeploymentReceiptPath !== undefined &&
      (typeof input.fieldDeploymentReceiptPath !== "string" ||
       !input.fieldDeploymentReceiptPath)) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    ...Object.fromEntries(required.map((key) => [key, resolve(input[key])])),
    ...(typeof input.fieldDeploymentReceiptPath === "string" &&
        input.fieldDeploymentReceiptPath
      ? { fieldDeploymentReceiptPath: resolve(input.fieldDeploymentReceiptPath) }
      : {}),
  });
}

/** Local-only preview. No wrapper, Keychain, or network operation is invoked. */
export function previewCloudflareRecoveryFieldGate(configInput, dependencies = {}) {
  const config = normalizeFieldGateConfig(configInput);
  const testBootstrapRequest = normalizeTestBootstrapRequest(configInput);
  const plan = loadVerifiedRecoveryPlan(config.planPath);
  const state = loadVerifiedRecoveryState(config.statePath, plan);
  const gate = createCloudflareRecoveryFieldGateAdapters({
    ...config,
    plan,
    state,
    ...(testBootstrapRequest ? {
      testInterruptMidBootstrap: testBootstrapRequest.mode,
      testBootstrapCandidateSha: testBootstrapRequest.candidateSha,
      testBootstrapFieldReceiptPath: testBootstrapRequest.fieldReceiptPath,
      testBootstrapPackagePath: testBootstrapRequest.packagePath,
      testBootstrapSourcePhaseReceiptPath:
        testBootstrapRequest.sourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: testBootstrapRequest.deploymentReceiptPath,
      testBootstrapSeedReceiptPath: testBootstrapRequest.seedReceiptPath,
    } : {}),
  }, {
    ...dependencies,
    platform: dependencies.platform ?? process.platform,
  });
  const status = verifiedRecoveryStatus(plan, state);
  return Object.freeze({
    mode: "disposable_cloudflare_recovery_field_gate",
    ready_for_explicit_approval: true,
    plan_fingerprint: plan.plan_fingerprint,
    target_approval_fingerprint: plan.target_resource_fingerprint,
    target_execution_approval_fingerprint: gate.targetExecutionApprovalFingerprint,
    source_export_blocking_approval_fingerprint: plan.source_resource_fingerprint,
    wrapper_approval_fingerprint: gate.wrapperApprovalFingerprint,
    golden_approval_fingerprint: gate.goldenApprovalFingerprint,
    ...(testBootstrapRequest ? {
      test_bootstrap_interruption: Object.freeze({
        mode: testBootstrapRequest.mode,
        candidate_sha: gate.testBootstrapCandidateEvidence.candidateSha,
        candidate_tree_sha: gate.testBootstrapCandidateEvidence.candidateTreeSha,
        field_receipt_sha256: gate.testBootstrapCandidateEvidence.fieldReceiptSha256,
        field_receipt_run_id: gate.testBootstrapCandidateEvidence.fieldReceiptRunId,
        package_filename: gate.testBootstrapCandidateEvidence.packageFilename,
        package_bytes: gate.testBootstrapCandidateEvidence.packageBytes,
        package_sha256: gate.testBootstrapCandidateEvidence.packageSha256,
        package_file_count: gate.testBootstrapCandidateEvidence.packageFileCount,
        execution_inventory_sha256:
          gate.testBootstrapCandidateEvidence.executionInventorySha256,
        source_preflight_receipt_sha256:
          gate.testBootstrapCandidateEvidence.sourcePreflightReceiptSha256,
        source_phase_receipt_sha256:
          gate.testBootstrapCandidateEvidence.sourcePhaseReceiptSha256,
        target_preflight_receipt_sha256:
          gate.testBootstrapCandidateEvidence.targetPreflightReceiptSha256,
        deployment_receipt_sha256:
          gate.testBootstrapCandidateEvidence.deploymentReceiptSha256,
        seed_receipt_sha256: gate.testBootstrapCandidateEvidence.seedReceiptSha256,
        seed_fixture_sha256: gate.testBootstrapCandidateEvidence.seedFixtureSha256,
        seed_d1_content_fingerprint:
          gate.testBootstrapCandidateEvidence.seedD1ContentFingerprint,
        seed_document_count: gate.testBootstrapCandidateEvidence.seedDocumentCount,
        seed_chunk_count: gate.testBootstrapCandidateEvidence.seedChunkCount,
        seed_fts_count: gate.testBootstrapCandidateEvidence.seedFtsCount,
        seed_vector_count: gate.testBootstrapCandidateEvidence.seedVectorCount,
        seed_replay_unchanged_documents:
          gate.testBootstrapCandidateEvidence.seedReplayUnchangedDocuments,
        wrangler_runtime_inventory_sha256:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeInventorySha256,
        wrangler_entrypoint:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeEntrypoint,
        wrangler_entrypoint_sha256:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeEntrypointSha256,
        wrangler_runtime_package_count:
          gate.testBootstrapCandidateEvidence.wranglerRuntimePackageCount,
        wrangler_runtime_file_count:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeFileCount,
        wrangler_runtime_bytes:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeBytes,
        wrangler_runtime_directory:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeDirectory,
        wrangler_runtime_schema_version:
          gate.testBootstrapCandidateEvidence.wranglerRuntimeSchemaVersion,
        wrangler_host_platform:
          gate.testBootstrapCandidateEvidence.wranglerHostPlatform,
        wrangler_host_arch:
          gate.testBootstrapCandidateEvidence.wranglerHostArch,
        wrangler_host_libc:
          gate.testBootstrapCandidateEvidence.wranglerHostLibc,
        node_version: gate.testBootstrapCandidateEvidence.nodeVersion,
        node_executable_sha256:
          gate.testBootstrapCandidateEvidence.nodeExecutableSha256,
        stage: "rebuild_vectorize",
        hook_point:
          "after_observed_persisted_nonfinal_bootstrap_v2_receipt_before_sleep_or_active_promotion",
        approval_fingerprint: gate.testBootstrapInterruptionApprovalFingerprint,
      }),
    } : {}),
    status: status.status,
    current_stage: status.current_stage,
    completed_stages: status.completed_stages,
    total_stages: status.total_stages,
  });
}

/** Execute or resume the approved disposable field gate. */
export async function runCloudflareRecoveryFieldGate(configInput, dependencies = {}) {
  const config = normalizeFieldGateConfig(configInput);
  const stopAfterStage = normalizeStopAfterStage(configInput.stopAfterStage);
  const testBootstrapRequest = normalizeTestBootstrapRequest(configInput, {
    approvalRequired: true,
  });
  if (stopAfterStage && testBootstrapRequest) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  const plan = loadVerifiedRecoveryPlan(config.planPath);
  const state = loadVerifiedRecoveryState(config.statePath, plan);
  const rebuildIndex = VERIFIED_RECOVERY_STAGES.findIndex(
    (stage) => stage.id === "rebuild_vectorize",
  );
  if (configInput.approvePlan !== plan.plan_fingerprint ||
      configInput.approveDisposableTarget !== plan.target_resource_fingerprint ||
      configInput.approveSourceExportBlocking !== plan.source_resource_fingerprint) {
    refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
  }
  const gate = createCloudflareRecoveryFieldGateAdapters({
    ...config,
    plan,
    state,
    approvePlan: configInput.approvePlan,
    approveDisposableTarget: configInput.approveDisposableTarget,
    approveTargetExecution: configInput.approveTargetExecution,
    approveSourceExportBlocking: configInput.approveSourceExportBlocking,
    approveWrapper: configInput.approveWrapper,
    approveGolden: configInput.approveGolden,
    ...(testBootstrapRequest ? {
      testInterruptMidBootstrap: testBootstrapRequest.mode,
      testBootstrapCandidateSha: testBootstrapRequest.candidateSha,
      testBootstrapFieldReceiptPath: testBootstrapRequest.fieldReceiptPath,
      testBootstrapPackagePath: testBootstrapRequest.packagePath,
      testBootstrapSourcePhaseReceiptPath:
        testBootstrapRequest.sourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: testBootstrapRequest.deploymentReceiptPath,
      testBootstrapSeedReceiptPath: testBootstrapRequest.seedReceiptPath,
      approveTestBootstrapInterruption: testBootstrapRequest.approval,
    } : {}),
  }, dependencies);
  if (configInput.approveTargetExecution !== gate.targetExecutionApprovalFingerprint ||
      configInput.approveWrapper !== gate.wrapperApprovalFingerprint ||
      configInput.approveGolden !== gate.goldenApprovalFingerprint ||
      (testBootstrapRequest && configInput.approveTestBootstrapInterruption !==
        gate.testBootstrapInterruptionApprovalFingerprint)) {
    refuse("RECOVERY_FIELD_GATE_APPROVAL_MISMATCH");
  }
  const lock = gate.acquireLock();
  let result;
  let releaseError = null;
  try {
    if (state.status !== "complete") {
      // Every receipt-backed invocation, including a resume that begins on a
      // target-only stage, freshly rebinds the active source version and its
      // independent opaque etag before the first possible target-account call.
      await gate.assertReceiptBackedSourceDeploymentPin();
    }
    let executionState = state;
    if (testBootstrapRequest) {
      const fieldProof = {
        schema_version: 1,
        kind: "v048_disposable_recovery_seed_bridge",
        candidate_sha: gate.testBootstrapCandidateEvidence.candidateSha,
        package_sha256: gate.testBootstrapCandidateEvidence.packageSha256,
        field_receipt_sha256: gate.testBootstrapCandidateEvidence.fieldReceiptSha256,
        source_phase_receipt_sha256:
          gate.testBootstrapCandidateEvidence.sourcePhaseReceiptSha256,
        deployment_receipt_sha256:
          gate.testBootstrapCandidateEvidence.deploymentReceiptSha256,
        seed_receipt_sha256: gate.testBootstrapCandidateEvidence.seedReceiptSha256,
        fixture_sha256: gate.testBootstrapCandidateEvidence.seedFixtureSha256,
        seed_d1_content_fingerprint:
          gate.testBootstrapCandidateEvidence.seedD1ContentFingerprint,
        expected_documents: gate.testBootstrapCandidateEvidence.seedDocumentCount,
        expected_chunks: gate.testBootstrapCandidateEvidence.seedChunkCount,
        expected_fts: gate.testBootstrapCandidateEvidence.seedFtsCount,
        seed_replay_unchanged_documents:
          gate.testBootstrapCandidateEvidence.seedReplayUnchangedDocuments,
        paired_stop_stage: "rebuild_vectorize",
      };
      const readyToBindFieldProof = state.current_stage === "rebuild_vectorize" &&
        state.completed.length === rebuildIndex;
      if (state.status === "complete") {
        // A crash after the durable complete journal but before control-file
        // retirement has no remaining provider work. The already-validated
        // bound proof must match, but retirement stays local-only.
        executionState = bindVerifiedRecoveryFieldProof(state, plan, fieldProof);
      } else if (state.field_proof) {
        // Later-stage and rebuild retries must retain the exact immutable
        // proof already attached before the first rebuild attempt. The pure
        // binder verifies canonical identity and reuses its original time.
        executionState = bindVerifiedRecoveryFieldProof(state, plan, fieldProof);
      } else {
        if (!readyToBindFieldProof) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_STATE_INVALID");
        }
        // The seed is created before the ordinary recovery export. Re-run the
        // read-only export verification under the field lock so current direct
        // D1 truth, the encrypted artifact, seed receipt, and durable journal
        // remain one proven value before binding the journal. This check does
        // not append or replace a completed stage.
        gate.revalidate();
        const storedVerifyExport = state.completed
          .find((entry) => entry.id === "verify_export")?.evidence ?? null;
        const freshVerifyExport = await gate.adapters.verify_export(Object.freeze({
          stage: "verify_export",
          attempt: 1,
          planFingerprint: plan.plan_fingerprint,
          targetResourceFingerprint: plan.target_resource_fingerprint,
          completed: Object.freeze(state.completed.map((entry) => Object.freeze({
            id: entry.id,
            evidence: Object.freeze(structuredClone(entry.evidence)),
          }))),
        }));
        gate.revalidate();
        if (!storedVerifyExport ||
            canonical(freshVerifyExport) !== canonical(storedVerifyExport)) {
          refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_SEED_MISMATCH");
        }
        executionState = bindVerifiedRecoveryFieldProof(state, plan, fieldProof);
        writeVerifiedRecoveryState(config.statePath, executionState, plan);
      }
    }
    result = await runVerifiedRecovery(plan, executionState, gate.adapters, {
      revalidateManifests: async (fingerprint) => {
        if (fingerprint !== plan.plan_fingerprint) refuse("RECOVERY_FIELD_GATE_PLAN_CHANGED");
        return gate.revalidate();
      },
      persistState: async (next) => writeVerifiedRecoveryState(config.statePath, next, plan),
      ...(stopAfterStage ? {
        afterStageCheckpoint: async (stage) => {
          if (stage === stopAfterStage) {
            refuse("RECOVERY_FIELD_GATE_INTENTIONAL_INTERRUPTION");
          }
        },
      } : {}),
      ...(dependencies.clock ? { clock: dependencies.clock } : {}),
    });
    if (testBootstrapRequest && result.ok === true &&
        verifiedRecoveryStatus(plan, result.state).status === "complete") {
      gate.retireTestBootstrapCheckpoint();
    }
  } finally {
    try { gate.releaseLock(lock); } catch (error) { releaseError = error; }
  }
  if (releaseError) throw releaseError;
  return Object.freeze({ ...result, status: verifiedRecoveryStatus(plan, result.state) });
}

const CLI_VALUE_FLAGS = Object.freeze(new Set([
  "source-manifest", "target-manifest", "plan", "state", "artifact-directory",
  "wrangler-wrapper", "golden", "approve-plan", "approve-disposable-target",
  "approve-target-execution", "approve-source-export-blocking", "approve-wrapper",
  "approve-golden",
  "field-deployment-receipt",
  "stop-after-stage",
  "test-interrupt-mid-bootstrap", "test-bootstrap-candidate-sha",
  "test-bootstrap-field-receipt", "test-bootstrap-package",
  "test-bootstrap-source-phase-receipt",
  "test-bootstrap-deployment-receipt", "test-bootstrap-seed-receipt",
  "approve-test-bootstrap-interruption",
]));

export function parseCloudflareRecoveryCliArguments(argv) {
  if (!Array.isArray(argv) || !["preview", "run"].includes(argv[0])) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!/^--[a-z-]+$/.test(flag || "") || !CLI_VALUE_FLAGS.has(flag.slice(2)) ||
        typeof value !== "string" || !value || value.startsWith("--") ||
        Object.hasOwn(values, flag.slice(2))) {
      refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
    }
    values[flag.slice(2)] = value;
  }
  const required = [
    "source-manifest", "target-manifest", "plan", "state", "artifact-directory",
    "wrangler-wrapper", "golden",
    ...(command === "run" ? [
      "approve-plan", "approve-disposable-target", "approve-target-execution",
      "approve-source-export-blocking", "approve-wrapper", "approve-golden",
    ] : []),
  ];
  const allowed = [
    ...required,
    "field-deployment-receipt",
    "test-interrupt-mid-bootstrap", "test-bootstrap-candidate-sha",
    "test-bootstrap-field-receipt", "test-bootstrap-package",
    "test-bootstrap-source-phase-receipt",
    "test-bootstrap-deployment-receipt", "test-bootstrap-seed-receipt",
    ...(command === "run"
      ? ["stop-after-stage", "approve-test-bootstrap-interruption"]
      : []),
  ];
  if (argv.length % 2 !== 1 || required.some((key) => !Object.hasOwn(values, key)) ||
      Object.keys(values).some((key) => !allowed.includes(key))) {
    refuse("RECOVERY_FIELD_GATE_ARGUMENTS_INVALID");
  }
  const stopAfterStage = command === "run"
    ? normalizeStopAfterStage(values["stop-after-stage"])
    : null;
  const testBootstrapRequest = normalizeTestBootstrapRequest({
    testInterruptMidBootstrap: values["test-interrupt-mid-bootstrap"],
    testBootstrapCandidateSha: values["test-bootstrap-candidate-sha"],
    testBootstrapFieldReceiptPath: values["test-bootstrap-field-receipt"],
    testBootstrapPackagePath: values["test-bootstrap-package"],
    testBootstrapSourcePhaseReceiptPath:
      values["test-bootstrap-source-phase-receipt"],
    testBootstrapDeploymentReceiptPath: values["test-bootstrap-deployment-receipt"],
    testBootstrapSeedReceiptPath: values["test-bootstrap-seed-receipt"],
    approveTestBootstrapInterruption: values["approve-test-bootstrap-interruption"],
  }, { approvalRequired: command === "run" });
  if (stopAfterStage && testBootstrapRequest) {
    refuse("RECOVERY_FIELD_GATE_TEST_BOOTSTRAP_ARGUMENTS_INVALID");
  }
  return Object.freeze({
    command,
    sourceManifestPath: values["source-manifest"],
    targetManifestPath: values["target-manifest"],
    planPath: values.plan,
    statePath: values.state,
    artifactDirectory: values["artifact-directory"],
    wranglerWrapperPath: values["wrangler-wrapper"],
    goldenPath: values.golden,
    ...(values["field-deployment-receipt"] ? {
      fieldDeploymentReceiptPath: values["field-deployment-receipt"],
    } : {}),
    ...(command === "run" ? {
      approvePlan: values["approve-plan"],
      approveDisposableTarget: values["approve-disposable-target"],
      approveTargetExecution: values["approve-target-execution"],
      approveSourceExportBlocking: values["approve-source-export-blocking"],
      approveWrapper: values["approve-wrapper"],
      approveGolden: values["approve-golden"],
      ...(stopAfterStage ? { stopAfterStage } : {}),
    } : {}),
    ...(testBootstrapRequest ? {
      testInterruptMidBootstrap: testBootstrapRequest.mode,
      testBootstrapCandidateSha: testBootstrapRequest.candidateSha,
      testBootstrapFieldReceiptPath: testBootstrapRequest.fieldReceiptPath,
      testBootstrapPackagePath: testBootstrapRequest.packagePath,
      testBootstrapSourcePhaseReceiptPath:
        testBootstrapRequest.sourcePhaseReceiptPath,
      testBootstrapDeploymentReceiptPath: testBootstrapRequest.deploymentReceiptPath,
      testBootstrapSeedReceiptPath: testBootstrapRequest.seedReceiptPath,
      ...(command === "run" ? {
        approveTestBootstrapInterruption: testBootstrapRequest.approval,
      } : {}),
    } : {}),
  });
}

function printUsage() {
  console.log("usage: node operations/cloudflare-recovery-adapter.mjs preview --source-manifest <file> --target-manifest <file> --plan <file> --state <file> --artifact-directory <private-dir> --wrangler-wrapper <owner-only-wrapper> --golden <private-release-suite> [--field-deployment-receipt <owner-only-v048-deployment-receipt>]");
  console.log("       node operations/cloudflare-recovery-adapter.mjs run <same flags> --approve-plan <fingerprint> --approve-disposable-target <fingerprint> --approve-target-execution <fingerprint> --approve-source-export-blocking <fingerprint> --approve-wrapper <fingerprint> --approve-golden <fingerprint> [--stop-after-stage <export_d1|restore_d1|reconcile_security|rebuild_vectorize>]");
  console.log(`       test-only synthetic interruption preview adds --test-interrupt-mid-bootstrap ${RECOVERY_TEST_BOOTSTRAP_INTERRUPTION_MODE} --test-bootstrap-candidate-sha <40-hex-sha> --test-bootstrap-field-receipt <owner-only-full-field-receipt> --test-bootstrap-package <exact-owner-only-tarball> --test-bootstrap-source-phase-receipt <owner-only-v0.4.8-source-phase-receipt> --test-bootstrap-deployment-receipt <owner-only-v0.4.8-final-target-receipt> --test-bootstrap-seed-receipt <owner-only-v048-seed-receipt>; run also requires --approve-test-bootstrap-interruption <fingerprint>`);
}

async function main(argv = process.argv.slice(2)) {
  let parsed;
  try { parsed = parseCloudflareRecoveryCliArguments(argv); } catch {
    printUsage();
    return 1;
  }
  try {
    const result = parsed.command === "preview"
      ? previewCloudflareRecoveryFieldGate(parsed)
      : await runCloudflareRecoveryFieldGate(parsed);
    const output = parsed.command === "run" ? result.status : result;
    console.log(JSON.stringify(output, null, 2));
    if (result?.ok === false) {
      const failure = result.status?.failure ?? result.state?.failure ?? null;
      const cause = failure?.cause ? ` (${failure.cause})` : "";
      console.error(`Cloudflare recovery field gate stopped: ${result.errorCode ?? failure?.code ?? "RECOVERY_FAILED"}${cause}`);
      if (failure?.detail) console.error(`  ${failure.detail}`);
    }
    return result?.ok === false ? 1 : 0;
  } catch (error) {
    const code = error instanceof CloudflareRecoveryAdapterError
      ? error.code
      : "RECOVERY_FIELD_GATE_PREFLIGHT_FAILED";
    console.error(`Cloudflare recovery field gate stopped: ${code}`);
    if (error instanceof CloudflareRecoveryAdapterError && error.detail) console.error(`  ${error.detail}`);
    return 1;
  }
}

const IS_MAIN = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (IS_MAIN) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Cloudflare recovery field gate stopped: RECOVERY_FIELD_GATE_INTERNAL_FAILURE");
    process.exitCode = 1;
  });
}
