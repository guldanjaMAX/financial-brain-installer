/**
 * Preview and apply the one reviewed bank-provider transition.
 *
 * This command deliberately knows no provider credential shape. Its only
 * remote observation is one aggregate D1 row, and its only write is the
 * existing verified manifest replacement boundary.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  readBrainRecoveryFence,
  readBrainRecoveryFenceReadOnly,
  withBrainLifecycleLock,
} from "./brain-lifecycle-lock.mjs";
import { writeManifestAtomically } from "./folder-retirement.mjs";
import { manifestBankFeedProvider } from "../worker/src/lib/bank-feed-profiles.js";

// Read lazily: recovery runtimes import this module from a fixed file graph
// that does not carry manifest.schema.json, so no file IO may run at import.
let defaultSchemaCache = null;
function defaultSchema() {
  if (defaultSchemaCache === null) {
    defaultSchemaCache = JSON.parse(readFileSync(
      new URL("../manifest.schema.json", import.meta.url),
      "utf8",
    ));
  }
  return defaultSchemaCache;
}

export const BANK_PROVIDER_STALE_FIELDS = Object.freeze([
  "api_base",
  "link_sdk_url",
  "link_global",
  "registered_redirect_uris",
  "registered_webhook_uris",
  "country_codes",
  "reconciliation_interval_minutes",
]);

const LEDGER_TABLES = Object.freeze([
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
  "fin_reconciliation_claims",
]);

const BANK_LEDGER_CTE = `WITH bank_ledger AS (
  ${LEDGER_TABLES.map((table) =>
    `SELECT source_feed FROM ${table} WHERE source_feed LIKE 'bank-feed:%'`).join("\n  UNION ALL\n  ")}
)`;

// Every arm returns counts and fixed provider-state labels only. No identifier,
// institution, account, amount, date, description, or payload crosses this
// boundary. Provider identity comes from the provider-specific custody table,
// never from the already-edited local manifest.
export const BANK_PROVIDER_STATE_SQL = `${BANK_LEDGER_CTE}
SELECT
  (SELECT COUNT(*) FROM bank_feed_items WHERE removed_at IS NULL) AS bank_connections,
  (SELECT COUNT(*) FROM bank_feed_items i
    WHERE i.removed_at IS NULL AND EXISTS (
      SELECT 1 FROM simplefin_connections s
       WHERE s.tenant_id=i.tenant_id AND s.item_ref=i.item_ref
    )) AS simplefin_connections,
  (SELECT COUNT(*) FROM bank_feed_items i
    WHERE i.removed_at IS NULL AND NOT EXISTS (
      SELECT 1 FROM simplefin_connections s
       WHERE s.tenant_id=i.tenant_id AND s.item_ref=i.item_ref
    )) AS non_simplefin_connections,
  (SELECT COUNT(*) FROM bank_ledger) AS bank_ledger_rows,
  (SELECT COUNT(*) FROM bank_ledger l WHERE EXISTS (
    SELECT 1 FROM simplefin_connections s
     WHERE l.source_feed='bank-feed:'||s.item_ref
  )) AS simplefin_ledger_rows,
  (SELECT COUNT(*) FROM bank_ledger l WHERE NOT EXISTS (
    SELECT 1 FROM simplefin_connections s
     WHERE l.source_feed='bank-feed:'||s.item_ref
  )) AS non_simplefin_ledger_rows,
  (SELECT deployed_provider FROM bank_provider_runtime_state WHERE id=1) AS deployed_provider,
  (SELECT transition_target FROM bank_provider_runtime_state WHERE id=1) AS transition_target,
  (SELECT transition_ref FROM bank_provider_runtime_state WHERE id=1) AS transition_ref`;

export const BANK_PROVIDER_ESTABLISH_TRANSITION_SQL = `${BANK_LEDGER_CTE}
UPDATE bank_provider_runtime_state
   SET transition_target='simplefin',transition_ref=?1,transition_started_at=?2,updated_at=?2
 WHERE id=1 AND deployed_provider<>'simplefin' AND transition_target IS NULL
   AND NOT EXISTS (SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM bank_ledger)
RETURNING deployed_provider,transition_target,transition_ref`;

export const BANK_PROVIDER_COMPLETE_TRANSITION_SQL = `${BANK_LEDGER_CTE}
UPDATE bank_provider_runtime_state
   SET deployed_provider='simplefin',transition_target=NULL,transition_ref=NULL,
       transition_started_at=NULL,updated_at=?2
 WHERE id=1 AND transition_target='simplefin' AND transition_ref=?1
   AND NOT EXISTS (SELECT 1 FROM bank_feed_items WHERE removed_at IS NULL)
   AND NOT EXISTS (SELECT 1 FROM bank_ledger)
RETURNING deployed_provider,transition_target,transition_ref`;

export class BankProviderCommandError extends Error {
  constructor(code, message, receipt = null) {
    super(message);
    this.name = "BankProviderCommandError";
    this.code = code;
    this.receipt = receipt;
  }
}

function fail(code, message, receipt = null) {
  throw new BankProviderCommandError(code, message, receipt);
}

const BANK_PROVIDER_VALUE_OPTIONS = new Set(["set", "approve"]);
const BANK_PROVIDER_SWITCH_OPTIONS = new Set(["enable", "json", "apply"]);
const BANK_PROVIDER_USAGE =
  "usage: brain bank-provider <manifest> --set simplefin --enable [--json] " +
  "[--apply --approve <plan-id>]";
const D1_DATABASE_ID_RE =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function objectType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value === "number" ? "number" : typeof value;
}

function matchesType(value, expected) {
  if (expected === "number") return typeof value === "number" && Number.isFinite(value);
  if (expected === "integer") return Number.isSafeInteger(value);
  if (expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (expected === "array") return Array.isArray(value);
  if (expected === "null") return value === null;
  return typeof value === expected;
}

function formatIsValid(value, format) {
  if (typeof value !== "string") return true;
  if (format === "email") {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  }
  if (format === "uri") {
    try { return Boolean(new URL(value).protocol); } catch { return false; }
  }
  if (format === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }
  if (format === "date-time") {
    return /^\d{4}-\d{2}-\d{2}T/iu.test(value) && Number.isFinite(Date.parse(value));
  }
  return true;
}

/** The bank-feed schema uses only these draft-2020 structural keywords. */
function schemaErrors(value, schema, path = "$", errors = []) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return errors;
  const types = schema.type === undefined
    ? null
    : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types && !types.some((type) => matchesType(value, type))) {
    errors.push(`${path} must be ${types.join(" or ")}, not ${objectType(value)}`);
    return errors;
  }
  if (Object.hasOwn(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    errors.push(`${path} does not match its required constant`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => isDeepStrictEqual(value, item))) {
    errors.push(`${path} is not an allowed value`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const choice of schema.allOf) schemaErrors(value, choice, path, errors);
  }
  if (Array.isArray(schema.anyOf) &&
      !schema.anyOf.some((choice) => schemaErrors(value, choice, path, []).length === 0)) {
    errors.push(`${path} does not match any allowed shape`);
  }
  if (Array.isArray(schema.oneOf) &&
      schema.oneOf.filter((choice) => schemaErrors(value, choice, path, []).length === 0).length !== 1) {
    errors.push(`${path} does not match exactly one allowed shape`);
  }
  if (schema.not && schemaErrors(value, schema.not, path, []).length === 0) {
    errors.push(`${path} matches a forbidden shape`);
  }
  if (schema.if && schemaErrors(value, schema.if, path, []).length === 0 && schema.then) {
    schemaErrors(value, schema.then, path, errors);
  }

  if (typeof value === "string") {
    if (Number.isSafeInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path} is shorter than allowed`);
    }
    if (Number.isSafeInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path} is longer than allowed`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${path} does not match its required pattern`);
    }
    if (typeof schema.format === "string" && !formatIsValid(value, schema.format)) {
      errors.push(`${path} is not a valid ${schema.format}`);
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path} is below its minimum`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path} is above its maximum`);
    }
  }
  if (Array.isArray(value)) {
    if (Number.isSafeInteger(schema.minItems) && value.length < schema.minItems) {
      errors.push(`${path} has too few items`);
    }
    if (Number.isSafeInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path} has too many items`);
    }
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1) {
        for (let right = left + 1; right < value.length; right += 1) {
          if (isDeepStrictEqual(value[left], value[right])) {
            errors.push(`${path} contains a duplicate item`);
            left = value.length;
            break;
          }
        }
      }
    }
    if (schema.items && typeof schema.items === "object") {
      value.forEach((item, index) => schemaErrors(item, schema.items, `${path}[${index}]`, errors));
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties
      : {};
    for (const required of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, required)) errors.push(`${path}.${required} is required`);
    }
    for (const [name, propertyValue] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        schemaErrors(propertyValue, properties[name], `${path}.${name}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${name} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        schemaErrors(propertyValue, schema.additionalProperties, `${path}.${name}`, errors);
      }
    }
  }
  return errors;
}

/** Validate the complete reconciled manifest plus the provisioned D1 UUID. */
export function validateBankProviderManifest(manifest, schema = defaultSchema()) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    errors.push("$ must be one JSON object");
  } else {
    schemaErrors(manifest, schema, "$", errors);
    const cloudflare = manifest.infrastructure?.cloudflare;
    const d1DatabaseId = cloudflare?.d1_database_id;
    if (d1DatabaseId !== undefined && d1DatabaseId !== null && d1DatabaseId !== "" &&
        (typeof d1DatabaseId !== "string" || !D1_DATABASE_ID_RE.test(d1DatabaseId))) {
      errors.push("$.infrastructure.cloudflare.d1_database_id must be one canonical D1 UUID");
    }
  }
  if (errors.length) {
    fail(
      "BANK_PROVIDER_MANIFEST_INVALID",
      `The Brain manifest is invalid: ${errors[0]}. Nothing was inspected or changed.`,
    );
  }
  return manifest;
}

const BANK_PROVIDER_COUNT_FIELDS = Object.freeze([
  "bank_connections",
  "simplefin_connections",
  "non_simplefin_connections",
  "bank_ledger_rows",
  "simplefin_ledger_rows",
  "non_simplefin_ledger_rows",
]);
const DEPLOYED_PROVIDERS = new Set(["unknown", "plaid", "simplefin", "custom"]);

function normalizeBankProviderStateRow(row) {
  const counts = Object.fromEntries(BANK_PROVIDER_COUNT_FIELDS.map((field) => [field, Number(row?.[field])]));
  if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0) ||
      counts.bank_connections !== counts.simplefin_connections + counts.non_simplefin_connections ||
      counts.bank_ledger_rows !== counts.simplefin_ledger_rows + counts.non_simplefin_ledger_rows) {
    throw new Error("the aggregate bank state returned invalid provider counts");
  }
  const deployedProvider = String(row?.deployed_provider || "");
  if (!DEPLOYED_PROVIDERS.has(deployedProvider)) {
    throw new Error("the aggregate bank state returned no deployed provider authority");
  }
  const transitionTarget = row?.transition_target ?? null;
  const transitionRef = row?.transition_ref ?? null;
  if ((transitionTarget !== null && transitionTarget !== "simplefin") ||
      (transitionTarget === null && transitionRef !== null) ||
      (transitionTarget === "simplefin" && !/^[a-f0-9]{64}$/u.test(String(transitionRef || "")))) {
    throw new Error("the aggregate bank state returned an invalid provider transition");
  }
  return Object.freeze({
    ...counts,
    deployed_provider: deployedProvider,
    transition_target: transitionTarget,
    transition_ref: transitionRef,
  });
}

export function normalizeBankProviderState(result) {
  const rows = result?.results;
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error("the aggregate bank state did not return exactly one row");
  }
  return normalizeBankProviderStateRow(rows[0]);
}

function hasAnyBankState(state) {
  return state.bank_connections > 0 || state.bank_ledger_rows > 0;
}

function hasNonSimpleFinState(state) {
  return state.non_simplefin_connections > 0 || state.non_simplefin_ledger_rows > 0;
}

/** Fail-closed preflight for the standalone deploy continuation. */
export async function prepareBankProviderDeployment({
  targetProvider,
  liveProvider,
  inspectBankState,
}) {
  if (targetProvider !== "simplefin") return null;
  if (typeof inspectBankState !== "function") throw new TypeError("a bank-provider deploy inspector is required");
  const state = normalizeBankProviderStateRow(await inspectBankState());
  if (state.transition_target === "simplefin") {
    if (hasAnyBankState(state)) {
      fail(
        "BANK_PROVIDER_STATE_PRESENT",
        "The SimpleFIN deploy was refused because bank state appeared after the transition fence. The fence remains active.",
      );
    }
    return Object.freeze({
      target_provider: "simplefin",
      transition_ref: state.transition_ref,
      deployed_provider: state.deployed_provider,
      live_provider: liveProvider,
    });
  }
  if (state.deployed_provider === "simplefin" && liveProvider === "simplefin" && !hasNonSimpleFinState(state)) {
    return Object.freeze({
      target_provider: "simplefin",
      transition_ref: null,
      deployed_provider: "simplefin",
      live_provider: "simplefin",
    });
  }
  fail(
    "BANK_PROVIDER_TRANSITION_REQUIRED",
    "This deploy would change the live bank provider without the reviewed D1 transition fence. Run brain bank-provider first.",
  );
}

/** Verify the uploaded binding, atomically recheck zero state, then clear. */
export async function completeBankProviderDeployment({
  targetProvider,
  liveProvider,
  transition,
  completeTransition,
}) {
  if (targetProvider !== "simplefin") return null;
  if (liveProvider !== "simplefin") {
    fail(
      "BANK_PROVIDER_RUNTIME_UNVERIFIED",
      "The Worker upload did not read back the SimpleFIN provider binding. The transition fence remains active.",
    );
  }
  if (!transition?.transition_ref) return Object.freeze({ deployed_provider: "simplefin" });
  if (typeof completeTransition !== "function") {
    throw new TypeError("a bank-provider transition completer is required");
  }
  const completed = await completeTransition(transition.transition_ref);
  if (completed?.deployed_provider !== "simplefin" || completed?.transition_target != null ||
      completed?.transition_ref != null) {
    fail(
      "BANK_PROVIDER_TRANSITION_UNCLEARED",
      "The SimpleFIN runtime was verified, but the zero-state transition could not be cleared. The fence remains active.",
    );
  }
  return Object.freeze({ deployed_provider: "simplefin" });
}

function validateArguments(flags) {
  const allowed = new Set(["set", "enable", "json", "apply", "approve"]);
  const unknown = Object.keys(flags || {}).find((name) => !allowed.has(name));
  if (unknown) {
    fail(
      "BANK_PROVIDER_ARGUMENT_INVALID",
      "brain bank-provider received an unsupported option. No manifest or provider state was read.",
    );
  }
  for (const name of ["enable", "json", "apply"]) {
    if (flags?.[name] !== undefined && flags[name] !== true) {
      fail("BANK_PROVIDER_ARGUMENT_INVALID", `--${name} is a switch and does not take a value.`);
    }
  }
  if (flags?.set !== "simplefin" || flags?.enable !== true) {
    fail("BANK_PROVIDER_ARGUMENT_INVALID", BANK_PROVIDER_USAGE);
  }
  const apply = flags.apply === true;
  if (!apply && flags.approve !== undefined) {
    fail("BANK_PROVIDER_ARGUMENT_INVALID", "--approve is accepted only with --apply.");
  }
  if (apply && !/^[a-f0-9]{64}$/u.test(String(flags.approve || ""))) {
    fail("BANK_PROVIDER_ARGUMENT_INVALID", "--apply needs the exact 64-character --approve plan-id from preview.");
  }
  return apply;
}

/**
 * Parse the complete command tail before a manifest or credential boundary.
 *
 * The shared CLI parser deliberately accepts unknown flags and ignores bare
 * positional values. This command has a stricter contract because an ignored
 * or reflected value could be a provider credential. No error includes raw
 * option text or an unexpected positional value.
 */
export function parseBankProviderArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0 ||
      typeof argv[0] !== "string" || !argv[0] || argv[0].startsWith("-")) {
    fail("BANK_PROVIDER_ARGUMENT_INVALID", BANK_PROVIDER_USAGE);
  }
  const manifestPath = argv[0];
  const flags = {};
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string" || !argument.startsWith("--") || argument.includes("=")) {
      fail(
        "BANK_PROVIDER_ARGUMENT_INVALID",
        "brain bank-provider received an unexpected positional or option form. " +
          "No manifest or provider state was read.",
      );
    }
    const name = argument.slice(2);
    if ((!BANK_PROVIDER_VALUE_OPTIONS.has(name) && !BANK_PROVIDER_SWITCH_OPTIONS.has(name)) ||
        Object.hasOwn(flags, name)) {
      fail(
        "BANK_PROVIDER_ARGUMENT_INVALID",
        "brain bank-provider received an unsupported or repeated option. " +
          "No manifest or provider state was read.",
      );
    }
    if (BANK_PROVIDER_VALUE_OPTIONS.has(name)) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        fail(
          "BANK_PROVIDER_ARGUMENT_INVALID",
          `brain bank-provider --${name} needs a separate value. No manifest or provider state was read.`,
        );
      }
      flags[name] = value;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  validateArguments(flags);
  return Object.freeze({ manifestPath, flags: Object.freeze(flags) });
}

function loadManifest(manifestPath, { readFile, schema }) {
  if (typeof manifestPath !== "string" || !manifestPath || manifestPath.startsWith("--")) {
    fail("BANK_PROVIDER_ARGUMENT_INVALID", "usage: brain bank-provider <manifest> --set simplefin --enable");
  }
  let bytes;
  try {
    const value = readFile(manifestPath);
    bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  } catch {
    fail("BANK_PROVIDER_MANIFEST_INVALID", "The Brain manifest could not be read. Nothing was inspected or changed.");
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("BANK_PROVIDER_MANIFEST_INVALID", "The Brain manifest is not valid JSON. Nothing was inspected or changed.");
  }
  validateBankProviderManifest(manifest, schema);
  return Object.freeze({ bytes, manifest });
}

function intendedSimpleFinManifest(manifest) {
  const intended = structuredClone(manifest);
  if (!intended.corpora || typeof intended.corpora !== "object" || Array.isArray(intended.corpora)) {
    intended.corpora = {};
  }
  const current = intended.corpora.bank_feed;
  const feed = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  feed.enabled = true;
  feed.provider = "simplefin";
  feed.environment = "production";
  for (const field of BANK_PROVIDER_STALE_FIELDS) delete feed[field];
  intended.corpora.bank_feed = feed;
  return intended;
}

function planFor({ manifestPath, displayManifestPath, bytes, manifest, state, schema }) {
  const feed = manifest?.corpora?.bank_feed || {};
  const provider = manifestBankFeedProvider(feed);
  const intended = intendedSimpleFinManifest(manifest);
  validateBankProviderManifest(intended, schema);
  const removeFields = BANK_PROVIDER_STALE_FIELDS.filter((field) => Object.hasOwn(feed, field));
  const changes = [
    ["corpora.bank_feed.enabled", feed.enabled, true],
    ["corpora.bank_feed.provider", provider, "simplefin"],
    ["corpora.bank_feed.environment", feed.environment, "production"],
  ].filter(([, before, after]) => !isDeepStrictEqual(before, after))
    .map(([path, , value]) => Object.freeze({ path, value }));
  const writeRequired = !isDeepStrictEqual(manifest, intended);
  const transitionPending = state.transition_target === "simplefin";
  const transitionRequired = state.deployed_provider !== "simplefin" || transitionPending;
  const manifestSha256 = sha256(bytes);
  const approvalPayload = Object.freeze({
    schema_version: 1,
    kind: "bank_provider_change_approval",
    manifest_sha256: manifestSha256,
    current_provider: provider,
    bank_connections: state.bank_connections,
    bank_ledger_rows: state.bank_ledger_rows,
    simplefin_connections: state.simplefin_connections,
    non_simplefin_connections: state.non_simplefin_connections,
    simplefin_ledger_rows: state.simplefin_ledger_rows,
    non_simplefin_ledger_rows: state.non_simplefin_ledger_rows,
    deployed_provider: state.deployed_provider,
    transition_target: state.transition_target,
    transition_ref: state.transition_ref,
    changes,
    remove_fields: removeFields,
  });
  const planId = sha256(JSON.stringify(approvalPayload));
  const shownPath = displayManifestPath || manifestPath;
  return Object.freeze({
    schema_version: 1,
    kind: "bank_provider_change",
    plan_id: planId,
    manifest_sha256: manifestSha256,
    current_state: Object.freeze({
      provider,
      enabled: feed.enabled === true,
      environment: typeof feed.environment === "string" ? feed.environment : null,
      bank_connections: state.bank_connections,
      bank_ledger_rows: state.bank_ledger_rows,
      simplefin_connections: state.simplefin_connections,
      non_simplefin_connections: state.non_simplefin_connections,
      simplefin_ledger_rows: state.simplefin_ledger_rows,
      non_simplefin_ledger_rows: state.non_simplefin_ledger_rows,
      deployed_provider: state.deployed_provider,
      transition_target: state.transition_target,
      transition_ref: state.transition_ref,
    }),
    changes: Object.freeze(changes),
    remove_fields: Object.freeze(removeFields),
    write_required: writeRequired,
    transition_required: transitionRequired,
    transition_pending: transitionPending,
    intended,
    apply_command: `brain bank-provider ${shownPath} --set simplefin --enable --apply --approve ${planId}`,
    next_steps: Object.freeze([
      Object.freeze({ id: "deploy", command: `brain deploy ${shownPath}` }),
      Object.freeze({ id: "owner_app_sign_in", instruction: "The owner signs in at /app." }),
      Object.freeze({ id: "connect_bank", command: `brain connect bank ${shownPath}` }),
    ]),
  });
}

function publicReceipt(plan, { mode, status, backupPath = null, errorCode = null }) {
  return Object.freeze({
    schema_version: plan.schema_version,
    kind: plan.kind,
    mode,
    status,
    plan_id: plan.plan_id,
    manifest_sha256: plan.manifest_sha256,
    current_state: plan.current_state,
    changes: plan.changes,
    remove_fields: plan.remove_fields,
    write_required: plan.write_required,
    transition_required: plan.transition_required,
    transition_pending: plan.transition_pending,
    apply_command: plan.apply_command,
    next_steps: status === "refused" ? [] : plan.next_steps,
    ...(backupPath ? { backup_path: backupPath } : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    setup_token: "not_read_or_accepted",
  });
}

async function inspectState(inspectBankState, manifest) {
  try {
    return normalizeBankProviderStateRow(await inspectBankState(manifest));
  } catch {
    fail(
      "BANK_PROVIDER_STATE_UNREADABLE",
      "The aggregate bank connection and ledger state could not be verified. Nothing was changed.",
    );
  }
}

/**
 * The only mutating route. Apply re-runs this whole function under the shared
 * lifecycle lock, so approval, recovery, state, ownership, and bytes are all
 * checked again at the write boundary.
 */
export async function runBankProviderCommand(input, options = {}) {
  const { manifestPath, flags = {} } = Array.isArray(input?.argv)
    ? parseBankProviderArgv(input.argv)
    : input || {};
  const apply = validateArguments(flags);
  const deps = {
    schema: options.schema ?? defaultSchema(),
    readFile: options.readFile ?? ((path) => readFileSync(path)),
    readRecoveryFence: options.readRecoveryFence ?? ((path) => apply
      ? readBrainRecoveryFence({ manifestPath: path })
      : readBrainRecoveryFenceReadOnly({ manifestPath: path })),
    inspectBankState: options.inspectBankState,
    withLifecycle: options.withLifecycle ?? ((task) => withBrainLifecycleLock({
      manifestPath,
      operation: "bank-provider",
      retryCommand: `brain bank-provider ${options.displayManifestPath || manifestPath} --set simplefin --enable`,
    }, task)),
    writeManifest: options.writeManifest ?? writeManifestAtomically,
    establishTransition: options.establishTransition,
  };
  if (typeof deps.inspectBankState !== "function") {
    throw new TypeError("an aggregate bank-state inspector is required");
  }

  // Normalize invalid-manifest failures before the lifecycle helper has to
  // derive the same manifest identity. The locked path re-reads it below.
  if (apply) loadManifest(manifestPath, deps);

  const execute = async (lock = null) => {
    const { bytes, manifest } = loadManifest(manifestPath, deps);
    if (deps.readRecoveryFence(manifestPath)) {
      fail(
        "BANK_PROVIDER_RECOVERY_OPEN",
        "A prior Brain update still requires verified recovery. The bank provider was not inspected or changed.",
      );
    }
    if (!manifest.infrastructure?.cloudflare?.d1_database_id) {
      fail(
        "BANK_PROVIDER_D1_UNPROVISIONED",
        "This Brain has no provisioned D1 database to inspect. Run `brain provision <manifest>` first. " +
          "The bank provider was not inspected or changed.",
      );
    }
    const state = await inspectState(deps.inspectBankState, manifest);
    const plan = planFor({
      manifestPath,
      displayManifestPath: options.displayManifestPath,
      bytes,
      manifest,
      state,
      schema: deps.schema,
    });
    const switchingProvider = state.deployed_provider !== "simplefin" || plan.transition_pending;
    if (hasNonSimpleFinState(state) || (switchingProvider && hasAnyBankState(state))) {
      const receipt = publicReceipt(plan, {
        mode: apply ? "apply" : "preview",
        status: "refused",
        errorCode: "BANK_PROVIDER_STATE_PRESENT",
      });
      fail(
        "BANK_PROVIDER_STATE_PRESENT",
        `The zero-history switch was refused: ${state.bank_connections} active bank connection(s) and ` +
          `${state.bank_ledger_rows} provider-derived ledger row(s) exist. Nothing was changed.`,
        receipt,
      );
    }
    if (!apply) {
      return publicReceipt(plan, {
        mode: "preview",
        status: plan.write_required || (plan.transition_required && !plan.transition_pending)
          ? "ready"
          : plan.transition_pending ? "transition_pending" : "unchanged",
      });
    }
    if (flags.approve !== plan.plan_id) {
      fail(
        "BANK_PROVIDER_APPROVAL_STALE",
        "The manifest or aggregate bank state changed after preview, so the approval is stale. Nothing was changed.",
      );
    }
    if (plan.transition_pending && !plan.write_required) {
      return publicReceipt(plan, { mode: "apply", status: "transition_pending" });
    }
    let transitionEstablished = false;
    if (plan.transition_required && !plan.transition_pending) {
      if (typeof deps.establishTransition !== "function") {
        throw new TypeError("a bank-provider transition writer is required for apply");
      }
      let transition;
      try {
        transition = await deps.establishTransition(manifest, {
          transition_ref: plan.plan_id,
          started_at: (options.now ? options.now() : new Date()).toISOString(),
        });
      } catch {
        fail(
          "BANK_PROVIDER_TRANSITION_FAILED",
          "The zero-state provider transition could not be fenced atomically. The manifest was not changed.",
        );
      }
      if (transition?.transition_target !== "simplefin" || transition?.transition_ref !== plan.plan_id) {
        fail(
          "BANK_PROVIDER_TRANSITION_FAILED",
          "The zero-state provider transition was not established exactly. The manifest was not changed.",
        );
      }
      transitionEstablished = true;
    }
    if (!plan.write_required) {
      return publicReceipt(plan, {
        mode: "apply",
        status: transitionEstablished ? "fenced" : "unchanged",
      });
    }
    lock?.assertOwned?.();
    let writeResult;
    try {
      writeResult = deps.writeManifest(manifestPath, plan.intended, {
        expectedOriginalBytes: bytes,
        backupTag: "bank-provider",
        operationLabel: "bank-provider apply",
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (error) {
      fail(
        "BANK_PROVIDER_WRITE_FAILED",
        `The manifest was not replaced: ${String(error?.message || error)}.`,
      );
    }
    return publicReceipt(plan, {
      mode: "apply",
      status: "applied",
      backupPath: writeResult?.backupPath || null,
    });
  };

  return apply ? deps.withLifecycle(execute) : execute();
}

export function renderBankProviderReceipt(receipt) {
  const lines = [
    `Bank provider ${receipt.mode}: ${receipt.status}`,
    `  manifest provider:      ${receipt.current_state.provider}`,
    `  deployed provider:      ${receipt.current_state.deployed_provider}`,
    `  transition target:      ${receipt.current_state.transition_target || "none"}`,
    `  active connections:     ${receipt.current_state.bank_connections}`,
    `  provider ledger rows:   ${receipt.current_state.bank_ledger_rows}`,
  ];
  if (receipt.changes.length) {
    lines.push("  fields to set:");
    for (const change of receipt.changes) lines.push(`    ${change.path} = ${JSON.stringify(change.value)}`);
  } else {
    lines.push("  fields to set:           none");
  }
  lines.push(`  fields to remove:        ${receipt.remove_fields.length ? receipt.remove_fields.join(", ") : "none"}`);
  lines.push("  Setup Token:             not read or accepted");
  if (receipt.mode === "preview" && receipt.status === "ready") {
    lines.push(
      "",
      "Apply this unchanged plan:",
      `  ${receipt.apply_command}`,
    );
  }
  if (receipt.next_steps.length) {
    lines.push("", "Next steps:");
    for (const step of receipt.next_steps) lines.push(`  ${step.command || step.instruction}`);
  }
  if (receipt.backup_path) lines.push(`  Manifest backup: ${receipt.backup_path}`);
  return lines.join("\n");
}
