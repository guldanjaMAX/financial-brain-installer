/**
 * Owner Financial Map
 *
 * This is the owner-confirmed denominator for later completeness work. The
 * document corpus and financial ledger may suggest possible mentions, but they
 * never silently become the owner's entity or account map. Read and preview
 * are non-authoritative. Activation appends one sealed snapshot after a fresh
 * passkey assertion bound to the exact map, denominator and prior head.
 */

import { jsonResponse, privateNoStore, validateAdminKey, constantTimeEquals } from "./core.js";
import { ownerSessionPrincipal } from "./owner-auth.js";
import { issueChallenge, randomToken, sha256Hex, findPasskey } from "./auth-store.js";
import { verifyAssertion, b64uDecode } from "./webauthn.js";
import { backendOf, D1 } from "./store.js";

export const OWNER_FINANCIAL_MAP_PATH_PREFIX = "/api/admin/brain/financial-map/";
export const OWNER_FINANCIAL_MAP_READ_PATH = `${OWNER_FINANCIAL_MAP_PATH_PREFIX}read`;
export const OWNER_FINANCIAL_MAP_PREVIEW_PATH = `${OWNER_FINANCIAL_MAP_PATH_PREFIX}preview`;
export const OWNER_FINANCIAL_MAP_OPTIONS_PATH = `${OWNER_FINANCIAL_MAP_PATH_PREFIX}passkey/options`;
export const OWNER_FINANCIAL_MAP_ACTIVATE_PATH = `${OWNER_FINANCIAL_MAP_PATH_PREFIX}activate`;
export const OWNER_FINANCIAL_MAP_APP_PATH_PREFIX = "/api/owner/financial-map/";
export const OWNER_FINANCIAL_MAP_REVIEW_PATH = `${OWNER_FINANCIAL_MAP_APP_PATH_PREFIX}review`;
export const OWNER_FINANCIAL_MAP_APP_OPTIONS_PATH = `${OWNER_FINANCIAL_MAP_APP_PATH_PREFIX}passkey/options`;
export const OWNER_FINANCIAL_MAP_APP_ACTIVATE_PATH = `${OWNER_FINANCIAL_MAP_APP_PATH_PREFIX}activate`;

const CONTRACT_VERSION = 1;
const TENANT_ID = "primary";
const SCOPE_KIND = "whole_owner_financial_picture";
// A preview is non-authoritative and contains no credential. Give an owner a
// calm day to read the complete map, while keeping the WebAuthn challenge below
// short-lived and single-purpose.
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 768 * 1024;
const MAX_LABEL_CHARS = 160;
const MAX_FIELD_TEXT_CHARS = 240;
const MAX_ENTITIES = 250;
const MAX_ACCOUNTS = 500;
const MAX_FILING_UNITS = 250;
const MAX_HORIZON_YEARS = 21;
const MAX_OBLIGATION_ITEMS_PER_GROUP = 25;
const MAX_TOTAL_OBLIGATION_ITEMS = 10000;
const REVIEW_ID_PATTERN = /^ofmp_[a-f0-9]{64}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SNAPSHOT_ID_PATTERN = /^ofm_[A-Za-z0-9_-]{16,76}$/;
const MAP_ID_PATTERNS = Object.freeze({
  entity: /^ofme_[a-f0-9]{32}$/,
  account: /^ofma_[a-f0-9]{32}$/,
  filing_unit: /^ofmf_[a-f0-9]{32}$/,
  return: /^ofmr_[a-f0-9]{32}$/,
  form: /^ofmx_[a-f0-9]{32}$/,
  k1_role: /^ofmk_[a-f0-9]{32}$/,
  bookkeeper: /^ofmb_[a-f0-9]{32}$/,
  source: /^ofms_[a-f0-9]{32}$/,
});

const POPULATION_STATES = new Set(["owner_asserted_complete", "known_partial", "unknown"]);
const DISPOSITIONS = new Set(["included", "excluded", "unavailable"]);
const ASSESSMENTS = new Set(["confirmed", "unknown", "unavailable", "not_applicable"]);
const ENTITY_FIELDS = Object.freeze([
  "kind", "status", "holds", "ownership", "tax_class", "relationship", "parent",
]);
const ACCOUNT_FIELDS = Object.freeze([
  "entity_assignment", "kind", "balance_role", "currency", "status",
]);
const ENTITY_KINDS = new Set(["person", "household", "trust", "business", "property", "investment"]);
const ENTITY_STATUSES = new Set(["active", "sold", "dissolved", "closed"]);
const RELATIONSHIPS = new Set(["owned", "counterparty"]);
const ACCOUNT_KINDS = new Set([
  "checking", "savings", "card", "loan", "line_of_credit", "investment",
  "retirement", "merchant", "point_of_sale", "escrow", "other",
]);
const BALANCE_ROLES = new Set(["asset", "liability", "neither"]);
const ACCOUNT_STATUSES = new Set(["open", "closed", "never_connected"]);
const SOURCE_KINDS = new Set([
  "banking", "credit", "loan", "investment", "books", "payroll", "tax",
  "documents", "commerce", "other",
]);

const schemaObject = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const nullableSchema = (schema) => ({ anyOf: [schema, { type: "null" }] });
const mapIdSchema = (kind) => ({ type: "string", pattern: MAP_ID_PATTERNS[kind].source });
const assessmentSchema = () => ({ type: "string", enum: [...ASSESSMENTS] });
const fieldAnswerSchema = (valueSchema) => schemaObject({
  assessment: assessmentSchema(),
  owner_value: nullableSchema(valueSchema),
});
const obligationItemSchema = (kind) => schemaObject({
  map_id: mapIdSchema(kind),
  label: { type: "string", minLength: 1, maxLength: MAX_LABEL_CHARS },
  ...(kind === "source" ? { kind: { type: "string", enum: [...SOURCE_KINDS] } } : {}),
  assessment: assessmentSchema(),
});
const obligationGroupSchema = (kind) => schemaObject({
  assessment: assessmentSchema(),
  items: {
    type: "array", maxItems: MAX_OBLIGATION_ITEMS_PER_GROUP, items: obligationItemSchema(kind),
  },
});

/** Exact MCP-visible input shape. The Worker repeats every semantic check. */
export function ownerFinancialMapSnapshotInputSchema() {
  const label = { type: "string", minLength: 1, maxLength: MAX_LABEL_CHARS };
  const fieldText = { type: "string", minLength: 1, maxLength: MAX_FIELD_TEXT_CHARS };
  const entityYear = schemaObject({
    tax_year: { type: "integer", minimum: 1900, maximum: 2200 },
    state: { type: "string", enum: [...DISPOSITIONS] },
    filing_units: schemaObject({
      assessment: assessmentSchema(),
      refs: { type: "array", maxItems: MAX_FILING_UNITS, uniqueItems: true, items: mapIdSchema("filing_unit") },
    }),
    required_returns: obligationGroupSchema("return"),
    required_forms: obligationGroupSchema("form"),
    k1_roles: obligationGroupSchema("k1_role"),
    books: schemaObject({
      assessment: assessmentSchema(),
      bookkeeping_company: nullableSchema(obligationItemSchema("bookkeeper")),
    }),
    payroll: schemaObject({ assessment: assessmentSchema() }),
    expected_sources: obligationGroupSchema("source"),
  });
  return schemaObject({
    version: { type: "integer", enum: [CONTRACT_VERSION] },
    scope: schemaObject({
      tenant_id: { type: "string", enum: [TENANT_ID] },
      kind: { type: "string", enum: [SCOPE_KIND] },
    }),
    tax_year_horizon: schemaObject({
      start: { type: "integer", minimum: 1900, maximum: 2200 },
      end: { type: "integer", minimum: 1900, maximum: 2200 },
    }),
    population_state: { type: "string", enum: [...POPULATION_STATES] },
    filing_units: {
      type: "array", maxItems: MAX_FILING_UNITS, items: schemaObject({
        map_id: mapIdSchema("filing_unit"), label, assessment: assessmentSchema(),
      }),
    },
    entities: {
      type: "array", maxItems: MAX_ENTITIES, items: schemaObject({
        map_id: mapIdSchema("entity"),
        ledger_ref: nullableSchema({ type: "string", pattern: HASH_PATTERN.source }),
        label,
        disposition: { type: "string", enum: [...DISPOSITIONS] },
        fields: schemaObject({
          kind: fieldAnswerSchema({ type: "string", enum: [...ENTITY_KINDS] }),
          status: fieldAnswerSchema({ type: "string", enum: [...ENTITY_STATUSES] }),
          holds: fieldAnswerSchema(fieldText),
          ownership: fieldAnswerSchema({ type: "integer", minimum: 0, maximum: 10000 }),
          tax_class: fieldAnswerSchema(fieldText),
          relationship: fieldAnswerSchema({ type: "string", enum: [...RELATIONSHIPS] }),
          parent: fieldAnswerSchema(mapIdSchema("entity")),
        }),
        tax_years: { type: "array", minItems: 1, maxItems: MAX_HORIZON_YEARS, items: entityYear },
      }),
    },
    accounts: {
      type: "array", maxItems: MAX_ACCOUNTS, items: schemaObject({
        map_id: mapIdSchema("account"),
        ledger_ref: nullableSchema({ type: "string", pattern: HASH_PATTERN.source }),
        label,
        disposition: { type: "string", enum: [...DISPOSITIONS] },
        fields: schemaObject({
          entity_assignment: fieldAnswerSchema(mapIdSchema("entity")),
          kind: fieldAnswerSchema({ type: "string", enum: [...ACCOUNT_KINDS] }),
          balance_role: fieldAnswerSchema({ type: "string", enum: [...BALANCE_ROLES] }),
          currency: fieldAnswerSchema({ type: "string", pattern: "^[A-Z]{3}$" }),
          status: fieldAnswerSchema({ type: "string", enum: [...ACCOUNT_STATUSES] }),
        }),
      }),
    },
  });
}

const encoder = new TextEncoder();
const respond = (body, status = 200) => privateNoStore(jsonResponse(body, status));

class MapRequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalid = (code, message) => { throw new MapRequestError(400, code, message); };
const conflict = (code, message) => { throw new MapRequestError(409, code, message); };
const unavailable = (code = "owner_financial_map_unavailable") =>
  respond({ error: "unavailable", code }, 503);

function exactObject(value, allowed, required = allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function requestBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_REQUEST_BYTES) {
    await request.body?.cancel("Owner Financial Map request exceeded limit").catch(() => {});
    throw new MapRequestError(413, "owner_financial_map_request_too_large", "The map request is too large.");
  }
  if (!request.body) return {};
  if (typeof request.body.getReader !== "function") {
    invalid("owner_financial_map_invalid_json", "The map request must be JSON.");
  }
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
      total += bytes.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel("Owner Financial Map request exceeded limit").catch(() => {});
        throw new MapRequestError(413, "owner_financial_map_request_too_large", "The map request is too large.");
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof MapRequestError) throw error;
    invalid("owner_financial_map_invalid_json", "The map request must be JSON.");
  } finally {
    reader.releaseLock?.();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const raw = new TextDecoder().decode(joined);
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed;
  } catch {
    invalid("owner_financial_map_invalid_json", "The map request must be one JSON object.");
  }
}

function rowsOf(result) {
  if (!result || !Array.isArray(result.results)) throw new Error("D1 result is unavailable");
  return result.results;
}

function changed(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function safeText(value, fallback, max = 160) {
  const normalized = String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  // These labels are returned only on authenticated owner/admin routes. Keep
  // meaningful digits such as Form 1120-S and account suffixes visible for
  // exact owner review; raw slugs, masks, external IDs, and source locators
  // are excluded separately by the public inventory projection below.
  const result = normalized || fallback;
  if (result.length > max) throw new Error("structured financial text exceeds the review boundary");
  return result;
}

function optionalSafeText(value, max = 240) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  return safeText(value, "Not described", max);
}

function assertHash(value) {
  if (!HASH_PATTERN.test(String(value || ""))) throw new Error("map integrity hash is invalid");
}

function assertSafeInteger(value, minimum = 0) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < minimum) {
    throw new Error("map integrity number is invalid");
  }
  return Number(value);
}

async function signingContext(env) {
  const row = await env.DB.prepare(
    "SELECT tenant_id, signing_salt FROM owner_financial_map_key_state WHERE tenant_id = ?",
  ).bind(TENANT_ID).first();
  const secret = String(row?.signing_salt || "");
  if (row?.tenant_id !== TENANT_ID || !HASH_PATTERN.test(secret)) throw new Error("map signing is unavailable");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const hmac = async (purpose, value) => {
    const bytes = new Uint8Array(await crypto.subtle.sign(
      "HMAC", key, encoder.encode(`financial-brain:owner-financial-map:v1:${purpose}\0${canonical(value)}`),
    ));
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  return { hmac };
}

function normalizeDatabaseEntity(row) {
  const id = assertSafeInteger(row.id, 1);
  const slug = String(row.entity_slug || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug)) throw new Error("structured entity key is invalid");
  if (!ENTITY_KINDS.has(row.kind) || !ENTITY_STATUSES.has(row.status) || !RELATIONSHIPS.has(row.relationship)) {
    throw new Error("structured entity enum is unknown");
  }
  const ownership = row.ownership_bp === null ? null : assertSafeInteger(row.ownership_bp);
  if (ownership !== null && ownership > 10000) throw new Error("structured ownership is invalid");
  return {
    id,
    slug,
    label: safeText(row.display_label || row.legal_name, "Unnamed entity"),
    raw: {
      id,
      entity_slug: slug,
      legal_name: String(row.legal_name || ""),
      display_label: row.display_label === null ? null : String(row.display_label),
      kind: row.kind,
      status: row.status,
      holds: row.holds === null ? null : String(row.holds),
      ownership_bp: ownership,
      tax_class: row.tax_class === null ? null : String(row.tax_class),
      relationship: row.relationship,
      parent_entity_slug: row.parent_entity_slug === null ? null : String(row.parent_entity_slug),
      provenance: String(row.provenance || ""),
      basis_state: String(row.basis_state || ""),
      recorded_at: String(row.recorded_at || ""),
    },
  };
}

function normalizeDatabaseAccount(row) {
  const id = assertSafeInteger(row.id, 1);
  const slug = String(row.account_slug || "");
  const entitySlug = String(row.entity_slug || "");
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entitySlug)) {
    throw new Error("structured account key is invalid");
  }
  if (!ACCOUNT_KINDS.has(row.account_kind) || !BALANCE_ROLES.has(row.balance_role) ||
      !ACCOUNT_STATUSES.has(row.status) || !/^[A-Z]{3}$/.test(String(row.currency || ""))) {
    throw new Error("structured account enum is unknown");
  }
  return {
    id,
    slug,
    entitySlug,
    label: safeText(row.label || row.institution, "Unnamed account"),
    raw: {
      id,
      account_slug: slug,
      entity_slug: entitySlug,
      institution: row.institution === null ? null : String(row.institution),
      label: row.label === null ? null : String(row.label),
      account_kind: row.account_kind,
      balance_role: row.balance_role,
      currency: row.currency,
      status: row.status,
      provenance: String(row.provenance || ""),
      basis_state: String(row.basis_state || ""),
      recorded_at: String(row.recorded_at || ""),
    },
  };
}

async function publicInventory(entityRows, accountRows, signer) {
  const entities = entityRows.map(normalizeDatabaseEntity);
  const accounts = accountRows.map(normalizeDatabaseAccount);
  const entityBySlug = new Map();
  for (const entity of entities) {
    if (entityBySlug.has(entity.slug)) throw new Error("structured entity inventory is not unique");
    entityBySlug.set(entity.slug, entity);
  }
  const accountSlugs = new Set();
  for (const account of accounts) {
    if (accountSlugs.has(account.slug)) throw new Error("structured account inventory is not unique");
    accountSlugs.add(account.slug);
    if (!entityBySlug.has(account.entitySlug)) throw new Error("structured account has no current entity");
  }
  for (const entity of entities) {
    if (entity.raw.parent_entity_slug !== null && !entityBySlug.has(entity.raw.parent_entity_slug)) {
      throw new Error("structured entity has no current parent");
    }
    entity.ref = await signer.hmac("entity-ref", {
      tenant_id: TENANT_ID, id: entity.id, entity_slug: entity.slug,
    });
  }
  for (const account of accounts) {
    account.ref = await signer.hmac("account-ref", {
      tenant_id: TENANT_ID, id: account.id, account_slug: account.slug,
    });
  }

  const publicEntities = [];
  for (const entity of entities) {
    const parent = entity.raw.parent_entity_slug === null ? null : entityBySlug.get(entity.raw.parent_entity_slug);
    const values = {
      kind: entity.raw.kind,
      status: entity.raw.status,
      holds: optionalSafeText(entity.raw.holds),
      ownership: entity.raw.ownership_bp,
      tax_class: optionalSafeText(entity.raw.tax_class),
      relationship: entity.raw.relationship,
      parent: parent ? { entity_ref: parent.ref, label: parent.label } : null,
    };
    const fields = {};
    for (const field of ENTITY_FIELDS) {
      const rawValue = field === "parent" ? entity.raw.parent_entity_slug :
        field === "ownership" ? entity.raw.ownership_bp : entity.raw[field];
      fields[field] = {
        current_value: values[field],
        value_hash: await signer.hmac("entity-field", { entity: entity.raw, field, value: rawValue }),
      };
    }
    publicEntities.push({
      entity_ref: entity.ref,
      suggested_map_id: `ofme_${entity.ref.slice(0, 32)}`,
      label: entity.label,
      candidate_state: "possible_mention",
      row_hash: await signer.hmac("entity-row", entity.raw),
      fields,
    });
  }

  const publicAccounts = [];
  for (const account of accounts) {
    const assigned = entityBySlug.get(account.entitySlug);
    const values = {
      entity_assignment: { entity_ref: assigned.ref, label: assigned.label },
      kind: account.raw.account_kind,
      balance_role: account.raw.balance_role,
      currency: account.raw.currency,
      status: account.raw.status,
    };
    const fields = {};
    for (const field of ACCOUNT_FIELDS) {
      const rawValue = field === "entity_assignment" ? account.raw.entity_slug
        : field === "kind" ? account.raw.account_kind : account.raw[field];
      fields[field] = {
        current_value: values[field],
        value_hash: await signer.hmac("account-field", { account: account.raw, field, value: rawValue }),
      };
    }
    publicAccounts.push({
      account_ref: account.ref,
      suggested_map_id: `ofma_${account.ref.slice(0, 32)}`,
      label: account.label,
      candidate_state: "possible_mention",
      row_hash: await signer.hmac("account-row", account.raw),
      fields,
    });
  }

  const rawInventory = {
    tenant_id: TENANT_ID,
    entities: entities.map((entity) => entity.raw),
    accounts: accounts.map((account) => account.raw),
  };
  return {
    inventory_hash: await signer.hmac("current-inventory", rawInventory),
    entities: publicEntities,
    accounts: publicAccounts,
  };
}

function snapshotSealInput(row) {
  return {
    snapshot_id: row.snapshot_id,
    tenant_id: row.tenant_id,
    sequence_no: Number(row.sequence_no),
    previous_snapshot_id: row.previous_snapshot_id,
    previous_map_hash: row.previous_map_hash,
    contract_version: Number(row.contract_version),
    snapshot_json: row.snapshot_json,
    map_hash: row.map_hash,
    denominator_hash: row.denominator_hash,
    inventory_hash: row.inventory_hash,
    inventory_generation: Number(row.inventory_generation),
    population_state: row.population_state,
    tax_year_start: Number(row.tax_year_start),
    tax_year_end: Number(row.tax_year_end),
    entity_count: Number(row.entity_count),
    account_count: Number(row.account_count),
    entity_year_count: Number(row.entity_year_count),
    filing_unit_count: Number(row.filing_unit_count),
    obligation_count: Number(row.obligation_count),
    credential_ref: row.credential_ref,
    request_id: row.request_id,
    request_hash: row.request_hash,
    activated_at: Number(row.activated_at),
  };
}

function previewSealInput(row) {
  return {
    receipt_hash: row.receipt_hash,
    tenant_id: row.tenant_id,
    contract_version: Number(row.contract_version),
    snapshot_json: row.snapshot_json,
    map_hash: row.map_hash,
    denominator_hash: row.denominator_hash,
    inventory_hash: row.inventory_hash,
    inventory_generation: Number(row.inventory_generation),
    expected_head_snapshot_id: row.expected_head_snapshot_id,
    expected_head_map_hash: row.expected_head_map_hash,
    expected_sequence_no: Number(row.expected_sequence_no),
    population_state: row.population_state,
    tax_year_start: Number(row.tax_year_start),
    tax_year_end: Number(row.tax_year_end),
    entity_count: Number(row.entity_count),
    account_count: Number(row.account_count),
    entity_year_count: Number(row.entity_year_count),
    filing_unit_count: Number(row.filing_unit_count),
    obligation_count: Number(row.obligation_count),
    expires_at: Number(row.expires_at),
    created_at: Number(row.created_at),
  };
}

function assertMapId(value, kind, code) {
  if (!MAP_ID_PATTERNS[kind].test(String(value || ""))) invalid(code, `The ${kind} map ID is invalid.`);
  return String(value);
}

function normalizeLabel(value, code, max = MAX_LABEL_CHARS) {
  const normalized = typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/g, " ").trim()
    : "";
  if (normalized.length < 1 || normalized.length > max) {
    invalid(code, "A short plain-language label is required.");
  }
  return normalized;
}

function assessment(value, code) {
  if (!ASSESSMENTS.has(value)) invalid(code, "The assessment is not supported.");
  return value;
}

function normalizeEntityOwnerValue(field, value, entityMapIds) {
  if (field === "kind") {
    if (!ENTITY_KINDS.has(value)) invalid("owner_financial_map_entity_value_invalid", "The owner-confirmed entity kind is not supported.");
    return value;
  }
  if (field === "status") {
    if (!ENTITY_STATUSES.has(value)) invalid("owner_financial_map_entity_value_invalid", "The owner-confirmed entity status is not supported.");
    return value;
  }
  if (field === "relationship") {
    if (!RELATIONSHIPS.has(value)) invalid("owner_financial_map_entity_value_invalid", "The owner-confirmed relationship is not supported.");
    return value;
  }
  if (field === "ownership") {
    if (!Number.isSafeInteger(value) || value < 0 || value > 10000) {
      invalid("owner_financial_map_entity_value_invalid", "Owner-confirmed ownership must be basis points from 0 through 10000.");
    }
    return value;
  }
  if (field === "parent") {
    if (!MAP_ID_PATTERNS.entity.test(String(value || "")) || !entityMapIds.has(value)) {
      invalid("owner_financial_map_entity_value_invalid", "The owner-confirmed parent must name an entity in this map.");
    }
    return value;
  }
  return normalizeLabel(value, "owner_financial_map_entity_value_invalid", MAX_FIELD_TEXT_CHARS);
}

function normalizeAccountOwnerValue(field, value, entityMapIds) {
  if (field === "entity_assignment") {
    if (!MAP_ID_PATTERNS.entity.test(String(value || "")) || !entityMapIds.has(value)) {
      invalid("owner_financial_map_account_value_invalid", "The owner-confirmed account assignment must name an entity in this map.");
    }
    return value;
  }
  if (field === "kind") {
    if (!ACCOUNT_KINDS.has(value)) invalid("owner_financial_map_account_value_invalid", "The owner-confirmed account kind is not supported.");
    return value;
  }
  if (field === "balance_role") {
    if (!BALANCE_ROLES.has(value)) invalid("owner_financial_map_account_value_invalid", "The owner-confirmed balance role is not supported.");
    return value;
  }
  if (field === "currency") {
    if (!/^[A-Z]{3}$/.test(String(value || ""))) invalid("owner_financial_map_account_value_invalid", "Use a three-letter currency.");
    return value;
  }
  if (!ACCOUNT_STATUSES.has(value)) invalid("owner_financial_map_account_value_invalid", "The owner-confirmed account status is not supported.");
  return value;
}

function normalizeFieldAnswers(fields, required, entityMapIds, kind) {
  if (!exactObject(fields, required)) invalid(`owner_financial_map_${kind}_fields_invalid`, "Every required field needs one independent assessment and owner value.");
  const normalized = {};
  for (const field of required) {
    const answer = fields[field];
    if (!exactObject(answer, ["assessment", "owner_value"])) {
      invalid(`owner_financial_map_${kind}_fields_invalid`, `The ${field} answer is incomplete.`);
    }
    const state = assessment(answer.assessment, `owner_financial_map_${kind}_fields_invalid`);
    if (state !== "confirmed" && answer.owner_value !== null) {
      invalid(`owner_financial_map_${kind}_value_invalid`, `The ${field} owner value must be null unless it is confirmed.`);
    }
    if (state === "confirmed" && answer.owner_value === null) {
      invalid(`owner_financial_map_${kind}_value_invalid`, `The ${field} owner value is required when confirmed.`);
    }
    normalized[field] = {
      assessment: state,
      owner_value: state === "confirmed"
        ? (kind === "entity"
          ? normalizeEntityOwnerValue(field, answer.owner_value, entityMapIds)
          : normalizeAccountOwnerValue(field, answer.owner_value, entityMapIds))
        : null,
    };
  }
  return normalized;
}

function registerStableItem(registry, item, kind) {
  const identity = canonical({ label: item.label, kind: item.kind ?? null });
  const existing = registry.get(item.map_id);
  if (existing && existing !== identity) {
    invalid("owner_financial_map_obligation_identity_conflict", "A local map ID must keep the same label and kind everywhere it appears.");
  }
  registry.set(item.map_id, identity);
  return item;
}

function normalizeObligationGroup(value, kind, registry, counter) {
  if (!exactObject(value, ["assessment", "items"]) || !Array.isArray(value.items) ||
      value.items.length > MAX_OBLIGATION_ITEMS_PER_GROUP) {
    invalid("owner_financial_map_obligation_group_invalid", "An obligation group is incomplete or too large.");
  }
  const groupAssessment = assessment(value.assessment, "owner_financial_map_obligation_group_invalid");
  if (groupAssessment === "not_applicable" && value.items.length !== 0) {
    invalid("owner_financial_map_obligation_group_invalid", "A not-applicable obligation group must be empty.");
  }
  const seen = new Set();
  const items = value.items.map((item) => {
    const fields = kind === "source" ? ["map_id", "label", "kind", "assessment"]
      : ["map_id", "label", "assessment"];
    if (!exactObject(item, fields)) invalid("owner_financial_map_obligation_invalid", "An expected obligation is incomplete.");
    const mapId = assertMapId(item.map_id, kind, "owner_financial_map_obligation_invalid");
    if (seen.has(mapId)) invalid("owner_financial_map_obligation_duplicate", "An expected obligation appears twice in one entity-year.");
    seen.add(mapId);
    const normalized = {
      map_id: mapId,
      label: normalizeLabel(item.label, "owner_financial_map_obligation_invalid"),
      ...(kind === "source" ? { kind: item.kind } : {}),
      assessment: assessment(item.assessment, "owner_financial_map_obligation_invalid"),
    };
    if (kind === "source" && !SOURCE_KINDS.has(item.kind)) {
      invalid("owner_financial_map_source_kind_invalid", "The expected source kind is not supported.");
    }
    counter.count += 1;
    if (counter.count > MAX_TOTAL_OBLIGATION_ITEMS) {
      invalid("owner_financial_map_obligations_too_large", "The expected obligation list is too large.");
    }
    return registerStableItem(registry, normalized, kind);
  }).sort((left, right) => left.map_id.localeCompare(right.map_id));
  return { assessment: groupAssessment, items };
}

function normalizeBookkeeping(value, registry, counter) {
  if (!exactObject(value, ["assessment", "bookkeeping_company"])) {
    invalid("owner_financial_map_books_invalid", "The books answer is incomplete.");
  }
  const state = assessment(value.assessment, "owner_financial_map_books_invalid");
  if (value.bookkeeping_company === null) return { assessment: state, bookkeeping_company: null };
  if (state === "not_applicable" || !exactObject(value.bookkeeping_company, ["map_id", "label", "assessment"])) {
    invalid("owner_financial_map_books_invalid", "A not-applicable books answer cannot name a bookkeeping company.");
  }
  const company = {
    map_id: assertMapId(value.bookkeeping_company.map_id, "bookkeeper", "owner_financial_map_books_invalid"),
    label: normalizeLabel(value.bookkeeping_company.label, "owner_financial_map_books_invalid"),
    assessment: assessment(value.bookkeeping_company.assessment, "owner_financial_map_books_invalid"),
  };
  counter.count += 1;
  if (counter.count > MAX_TOTAL_OBLIGATION_ITEMS) invalid("owner_financial_map_obligations_too_large", "The expected obligation list is too large.");
  return { assessment: state, bookkeeping_company: registerStableItem(registry, company, "bookkeeper") };
}

function normalizeEntityYear(value, filingUnitIds, registries, counter) {
  const keys = [
    "tax_year", "state", "filing_units", "required_returns", "required_forms",
    "k1_roles", "books", "payroll", "expected_sources",
  ];
  if (!exactObject(value, keys) || !Number.isSafeInteger(value.tax_year) || !DISPOSITIONS.has(value.state)) {
    invalid("owner_financial_map_entity_year_invalid", "Every entity-year needs one complete supported obligation answer.");
  }
  if (!exactObject(value.filing_units, ["assessment", "refs"]) || !Array.isArray(value.filing_units.refs) ||
      value.filing_units.refs.length > MAX_FILING_UNITS) {
    invalid("owner_financial_map_filing_unit_refs_invalid", "The filing-unit answer is incomplete or too large.");
  }
  const filingAssessment = assessment(value.filing_units.assessment, "owner_financial_map_filing_unit_refs_invalid");
  if (filingAssessment === "not_applicable" && value.filing_units.refs.length !== 0) {
    invalid("owner_financial_map_filing_unit_refs_invalid", "A not-applicable filing-unit answer must be empty.");
  }
  const filingRefs = new Set();
  for (const ref of value.filing_units.refs) {
    if (!MAP_ID_PATTERNS.filing_unit.test(String(ref || "")) || !filingUnitIds.has(ref) || filingRefs.has(ref)) {
      invalid("owner_financial_map_filing_unit_refs_invalid", "Each filing-unit reference must be unique and defined in this map.");
    }
    filingRefs.add(ref);
  }
  if (!exactObject(value.payroll, ["assessment"])) {
    invalid("owner_financial_map_payroll_invalid", "The payroll applicability answer is incomplete.");
  }
  return {
    tax_year: value.tax_year,
    state: value.state,
    filing_units: { assessment: filingAssessment, refs: [...filingRefs].sort() },
    required_returns: normalizeObligationGroup(value.required_returns, "return", registries.returns, counter),
    required_forms: normalizeObligationGroup(value.required_forms, "form", registries.forms, counter),
    k1_roles: normalizeObligationGroup(value.k1_roles, "k1_role", registries.k1Roles, counter),
    books: normalizeBookkeeping(value.books, registries.bookkeepers, counter),
    payroll: { assessment: assessment(value.payroll.assessment, "owner_financial_map_payroll_invalid") },
    expected_sources: normalizeObligationGroup(value.expected_sources, "source", registries.sources, counter),
  };
}

function comparableCurrentValue(field, currentValue, ledgerToEntityMap) {
  if ((field === "parent" || field === "entity_assignment") && currentValue) {
    return ledgerToEntityMap.get(currentValue.entity_ref) ?? null;
  }
  return currentValue;
}

async function normalizeSubmittedSnapshot(value, inventory, signer, priorSnapshot = null) {
  if (!exactObject(value, [
    "version", "scope", "tax_year_horizon", "population_state", "filing_units", "entities", "accounts",
  ])) invalid("owner_financial_map_snapshot_fields_invalid", "Submit one full version 1 financial map, not a patch.");
  if (value.version !== CONTRACT_VERSION ||
      !exactObject(value.scope, ["tenant_id", "kind"]) || value.scope.tenant_id !== TENANT_ID ||
      value.scope.kind !== SCOPE_KIND) invalid("owner_financial_map_scope_invalid", "The financial map scope is not supported.");
  const horizon = value.tax_year_horizon;
  if (!exactObject(horizon, ["start", "end"]) || !Number.isSafeInteger(horizon.start) ||
      !Number.isSafeInteger(horizon.end) || horizon.start < 1900 || horizon.end > 2200 ||
      horizon.end < horizon.start || horizon.end - horizon.start + 1 > MAX_HORIZON_YEARS) {
    invalid("owner_financial_map_horizon_invalid", `Choose a finite tax-year horizon of ${MAX_HORIZON_YEARS} years or fewer.`);
  }
  if (!POPULATION_STATES.has(value.population_state)) invalid("owner_financial_map_population_state_invalid", "The population state is not supported.");
  if (!Array.isArray(value.filing_units) || value.filing_units.length > MAX_FILING_UNITS ||
      !Array.isArray(value.entities) || value.entities.length > MAX_ENTITIES ||
      !Array.isArray(value.accounts) || value.accounts.length > MAX_ACCOUNTS) {
    invalid("owner_financial_map_rows_invalid", "The filing-unit, entity, or account list is not supported.");
  }

  const filingUnits = [];
  const filingUnitIds = new Set();
  for (const row of value.filing_units) {
    if (!exactObject(row, ["map_id", "label", "assessment"])) invalid("owner_financial_map_filing_unit_invalid", "A filing unit is incomplete.");
    const mapId = assertMapId(row.map_id, "filing_unit", "owner_financial_map_filing_unit_invalid");
    if (filingUnitIds.has(mapId)) invalid("owner_financial_map_filing_unit_duplicate", "A filing unit appears more than once.");
    filingUnitIds.add(mapId);
    filingUnits.push({
      map_id: mapId,
      label: normalizeLabel(row.label, "owner_financial_map_filing_unit_invalid"),
      assessment: assessment(row.assessment, "owner_financial_map_filing_unit_invalid"),
    });
  }
  filingUnits.sort((left, right) => left.map_id.localeCompare(right.map_id));

  const entityInputs = new Map();
  const entityMapIds = new Set();
  const linkedEntityRefs = new Set();
  for (const row of value.entities) {
    if (!exactObject(row, ["map_id", "ledger_ref", "label", "disposition", "fields", "tax_years"]) ||
        !DISPOSITIONS.has(row.disposition) || !Array.isArray(row.tax_years)) {
      invalid("owner_financial_map_entity_invalid", "An entity answer is incomplete or unsupported.");
    }
    const mapId = assertMapId(row.map_id, "entity", "owner_financial_map_entity_invalid");
    if (entityMapIds.has(mapId)) invalid("owner_financial_map_entity_duplicate", "An entity map ID appears more than once.");
    entityMapIds.add(mapId);
    const ledgerRef = row.ledger_ref === null ? null : String(row.ledger_ref || "");
    if (ledgerRef !== null && (!HASH_PATTERN.test(ledgerRef) || linkedEntityRefs.has(ledgerRef))) {
      invalid("owner_financial_map_entity_invalid", "A current entity reference is invalid or duplicated.");
    }
    if (ledgerRef !== null) linkedEntityRefs.add(ledgerRef);
    entityInputs.set(mapId, { ...row, map_id: mapId, ledger_ref: ledgerRef, label: normalizeLabel(row.label, "owner_financial_map_entity_invalid") });
  }

  const accountInputs = new Map();
  const accountMapIds = new Set();
  const linkedAccountRefs = new Set();
  for (const row of value.accounts) {
    if (!exactObject(row, ["map_id", "ledger_ref", "label", "disposition", "fields"]) || !DISPOSITIONS.has(row.disposition)) {
      invalid("owner_financial_map_account_invalid", "An account answer is incomplete or unsupported.");
    }
    const mapId = assertMapId(row.map_id, "account", "owner_financial_map_account_invalid");
    if (accountMapIds.has(mapId)) invalid("owner_financial_map_account_duplicate", "An account map ID appears more than once.");
    accountMapIds.add(mapId);
    const ledgerRef = row.ledger_ref === null ? null : String(row.ledger_ref || "");
    if (ledgerRef !== null && (!HASH_PATTERN.test(ledgerRef) || linkedAccountRefs.has(ledgerRef))) {
      invalid("owner_financial_map_account_invalid", "A current account reference is invalid or duplicated.");
    }
    if (ledgerRef !== null) linkedAccountRefs.add(ledgerRef);
    accountInputs.set(mapId, { ...row, map_id: mapId, ledger_ref: ledgerRef, label: normalizeLabel(row.label, "owner_financial_map_account_invalid") });
  }

  const currentEntityRefs = new Set(inventory.entities.map((row) => row.entity_ref));
  const currentAccountRefs = new Set(inventory.accounts.map((row) => row.account_ref));
  if (linkedEntityRefs.size !== currentEntityRefs.size || [...linkedEntityRefs].some((ref) => !currentEntityRefs.has(ref)) ||
      linkedAccountRefs.size !== currentAccountRefs.size || [...linkedAccountRefs].some((ref) => !currentAccountRefs.has(ref))) {
    conflict("owner_financial_map_inventory_changed", "Every current entity and account must appear exactly once. Start a fresh map preview.");
  }
  const currentEntities = new Map(inventory.entities.map((row) => [row.entity_ref, row]));
  const currentAccounts = new Map(inventory.accounts.map((row) => [row.account_ref, row]));
  if (priorSnapshot) {
    const submittedEntityByLedger = new Map(
      [...entityInputs.values()].filter((row) => row.ledger_ref !== null).map((row) => [row.ledger_ref, row]),
    );
    const submittedAccountByLedger = new Map(
      [...accountInputs.values()].filter((row) => row.ledger_ref !== null).map((row) => [row.ledger_ref, row]),
    );
    for (const prior of priorSnapshot.entities) {
      const ref = prior.ledger_evidence.current_ref;
      const submitted = ref === null ? null : submittedEntityByLedger.get(ref);
      if (submitted && submitted.map_id !== prior.map_id) {
        conflict("owner_financial_map_local_id_changed", "A current entity must keep its stable local map ID. Review a fresh full map.");
      }
    }
    for (const prior of priorSnapshot.accounts) {
      const ref = prior.ledger_evidence.current_ref;
      const submitted = ref === null ? null : submittedAccountByLedger.get(ref);
      if (submitted && submitted.map_id !== prior.map_id) {
        conflict("owner_financial_map_local_id_changed", "A current account must keep its stable local map ID. Review a fresh full map.");
      }
    }
  }
  const ledgerToEntityMap = new Map(
    [...entityInputs.values()].filter((row) => row.ledger_ref !== null).map((row) => [row.ledger_ref, row.map_id]),
  );
  const registries = {
    returns: new Map(), forms: new Map(), k1Roles: new Map(), bookkeepers: new Map(), sources: new Map(),
  };
  const obligationCounter = { count: 0 };
  const referencedFilingUnits = new Set();

  const entities = [];
  for (const answer of [...entityInputs.values()].sort((left, right) => left.map_id.localeCompare(right.map_id))) {
    const current = answer.ledger_ref === null ? null : currentEntities.get(answer.ledger_ref);
    const submittedFields = normalizeFieldAnswers(answer.fields, ENTITY_FIELDS, entityMapIds, "entity");
    const fields = {};
    for (const field of ENTITY_FIELDS) {
      const currentValue = current?.fields[field].current_value ?? null;
      const comparable = comparableCurrentValue(field, currentValue, ledgerToEntityMap);
      fields[field] = {
        assessment: submittedFields[field].assessment,
        owner_value: submittedFields[field].owner_value,
        current_value: currentValue,
        value_hash: current?.fields[field].value_hash ?? await signer.hmac("declared-entity-field", {
          tenant_id: TENANT_ID, map_id: answer.map_id, field, current_value: null,
        }),
        evidence_match: submittedFields[field].assessment === "confirmed"
          ? Boolean(current && canonical(comparable) === canonical(submittedFields[field].owner_value)) : null,
      };
    }
    const years = new Map();
    for (const year of answer.tax_years) {
      const normalized = normalizeEntityYear(year, filingUnitIds, registries, obligationCounter);
      if (years.has(normalized.tax_year)) invalid("owner_financial_map_entity_year_invalid", "An entity-year appears more than once.");
      years.set(normalized.tax_year, normalized);
      for (const ref of normalized.filing_units.refs) referencedFilingUnits.add(ref);
    }
    if (years.size !== horizon.end - horizon.start + 1) {
      invalid("owner_financial_map_entity_years_incomplete", "Every entity needs one answer for every tax year in the horizon.");
    }
    const taxYears = [];
    for (let year = horizon.start; year <= horizon.end; year++) {
      if (!years.has(year)) invalid("owner_financial_map_entity_years_incomplete", "An entity-year answer is missing.");
      taxYears.push(years.get(year));
    }
    entities.push({
      map_id: answer.map_id,
      label: answer.label,
      disposition: answer.disposition,
      ledger_evidence: {
        state: current ? "linked_current_record" : "owner_declared_no_current_record",
        current_ref: current?.entity_ref ?? null,
        row_hash: current?.row_hash ?? await signer.hmac("declared-entity-row", {
          tenant_id: TENANT_ID, map_id: answer.map_id, current_ref: null,
        }),
      },
      fields,
      tax_years: taxYears,
    });
  }
  if ([...filingUnitIds].some((ref) => !referencedFilingUnits.has(ref))) {
    invalid("owner_financial_map_filing_unit_unreferenced", "Every filing unit must be assigned to at least one entity-year.");
  }

  const accounts = [];
  for (const answer of [...accountInputs.values()].sort((left, right) => left.map_id.localeCompare(right.map_id))) {
    const current = answer.ledger_ref === null ? null : currentAccounts.get(answer.ledger_ref);
    const submittedFields = normalizeFieldAnswers(answer.fields, ACCOUNT_FIELDS, entityMapIds, "account");
    const fields = {};
    for (const field of ACCOUNT_FIELDS) {
      const currentValue = current?.fields[field].current_value ?? null;
      const comparable = comparableCurrentValue(field, currentValue, ledgerToEntityMap);
      fields[field] = {
        assessment: submittedFields[field].assessment,
        owner_value: submittedFields[field].owner_value,
        current_value: currentValue,
        value_hash: current?.fields[field].value_hash ?? await signer.hmac("declared-account-field", {
          tenant_id: TENANT_ID, map_id: answer.map_id, field, current_value: null,
        }),
        evidence_match: submittedFields[field].assessment === "confirmed"
          ? Boolean(current && canonical(comparable) === canonical(submittedFields[field].owner_value)) : null,
      };
    }
    accounts.push({
      map_id: answer.map_id,
      label: answer.label,
      disposition: answer.disposition,
      ledger_evidence: {
        state: current ? "linked_current_record" : "owner_declared_no_current_record",
        current_ref: current?.account_ref ?? null,
        row_hash: current?.row_hash ?? await signer.hmac("declared-account-row", {
          tenant_id: TENANT_ID, map_id: answer.map_id, current_ref: null,
        }),
      },
      fields,
    });
  }
  return {
    version: CONTRACT_VERSION,
    scope: { tenant_id: TENANT_ID, kind: SCOPE_KIND },
    tax_year_horizon: { start: horizon.start, end: horizon.end },
    population_state: value.population_state,
    filing_units: filingUnits,
    entities,
    accounts,
  };
}

function obligationCount(snapshot) {
  return snapshot.entities.reduce((total, entity) => total + entity.tax_years.reduce((yearTotal, year) =>
    yearTotal + year.required_returns.items.length + year.required_forms.items.length +
      year.k1_roles.items.length + (year.books.bookkeeping_company ? 1 : 0) +
      year.expected_sources.items.length, 0), 0);
}

function snapshotMetadata(snapshot) {
  return {
    population_state: snapshot.population_state,
    tax_year_start: snapshot.tax_year_horizon.start,
    tax_year_end: snapshot.tax_year_horizon.end,
    entity_count: snapshot.entities.length,
    account_count: snapshot.accounts.length,
    entity_year_count: snapshot.entities.reduce((sum, entity) => sum + entity.tax_years.length, 0),
    filing_unit_count: snapshot.filing_units.length,
    obligation_count: obligationCount(snapshot),
  };
}

async function denominatorHashFor(snapshot) {
  return sha256Hex(canonical({
    version: CONTRACT_VERSION,
    scope: snapshot.scope,
    tax_year_horizon: snapshot.tax_year_horizon,
    population_state: snapshot.population_state,
    filing_units: snapshot.filing_units.map((row) => ({ map_id: row.map_id, assessment: row.assessment })),
    entities: snapshot.entities.map((row) => ({
      map_id: row.map_id,
      disposition: row.disposition,
      ledger_state: row.ledger_evidence.state,
      current_ref: row.ledger_evidence.current_ref,
      tax_years: row.tax_years,
    })),
    accounts: snapshot.accounts.map((row) => ({
      map_id: row.map_id,
      disposition: row.disposition,
      ledger_state: row.ledger_evidence.state,
      current_ref: row.ledger_evidence.current_ref,
    })),
  }));
}

function assertStoredAssessment(answer) {
  return exactObject(answer, ["assessment", "owner_value", "current_value", "value_hash", "evidence_match"]) &&
    ASSESSMENTS.has(answer.assessment) && HASH_PATTERN.test(String(answer.value_hash || "")) &&
    (answer.evidence_match === null || typeof answer.evidence_match === "boolean") &&
    ((answer.assessment === "confirmed" && answer.owner_value !== null && typeof answer.evidence_match === "boolean") ||
      (answer.assessment !== "confirmed" && answer.owner_value === null && answer.evidence_match === null));
}

function assertStoredGroup(group, kind, registry) {
  if (!exactObject(group, ["assessment", "items"]) || !ASSESSMENTS.has(group.assessment) ||
      !Array.isArray(group.items) || group.items.length > MAX_OBLIGATION_ITEMS_PER_GROUP ||
      (group.assessment === "not_applicable" && group.items.length !== 0)) throw new Error("stored obligation group is invalid");
  const seen = new Set();
  for (const item of group.items) {
    const fields = kind === "source" ? ["map_id", "label", "kind", "assessment"] : ["map_id", "label", "assessment"];
    if (!exactObject(item, fields) || !MAP_ID_PATTERNS[kind].test(String(item.map_id || "")) ||
        typeof item.label !== "string" || item.label.length < 1 || item.label.length > 160 ||
        !ASSESSMENTS.has(item.assessment) || seen.has(item.map_id) ||
        (kind === "source" && !SOURCE_KINDS.has(item.kind))) throw new Error("stored obligation item is invalid");
    seen.add(item.map_id);
    const identity = canonical({ label: item.label, kind: item.kind ?? null });
    if (registry.has(item.map_id) && registry.get(item.map_id) !== identity) throw new Error("stored obligation identity conflicts");
    registry.set(item.map_id, identity);
  }
}

function assertStoredSnapshot(snapshot, metadata) {
  if (!exactObject(snapshot, [
    "version", "scope", "tax_year_horizon", "population_state", "filing_units", "entities", "accounts",
  ]) || snapshot.version !== CONTRACT_VERSION ||
      !exactObject(snapshot.scope, ["tenant_id", "kind"]) || snapshot.scope.tenant_id !== TENANT_ID ||
      snapshot.scope.kind !== SCOPE_KIND || !exactObject(snapshot.tax_year_horizon, ["start", "end"]) ||
      !POPULATION_STATES.has(snapshot.population_state) || !Array.isArray(snapshot.filing_units) ||
      !Array.isArray(snapshot.entities) || !Array.isArray(snapshot.accounts) ||
      snapshot.filing_units.length > MAX_FILING_UNITS || snapshot.entities.length > MAX_ENTITIES ||
      snapshot.accounts.length > MAX_ACCOUNTS) throw new Error("stored map contract is invalid");
  const start = snapshot.tax_year_horizon.start;
  const end = snapshot.tax_year_horizon.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1900 || end > 2200 ||
      end < start || end - start + 1 > MAX_HORIZON_YEARS) throw new Error("stored map horizon is invalid");
  const filingUnitIds = new Set();
  for (const unit of snapshot.filing_units) {
    if (!exactObject(unit, ["map_id", "label", "assessment"]) ||
        !MAP_ID_PATTERNS.filing_unit.test(String(unit.map_id || "")) || filingUnitIds.has(unit.map_id) ||
        typeof unit.label !== "string" || unit.label.length < 1 || unit.label.length > 160 ||
        !ASSESSMENTS.has(unit.assessment)) throw new Error("stored filing unit is invalid");
    filingUnitIds.add(unit.map_id);
  }
  const entityMapIds = new Set(snapshot.entities.map((row) => row?.map_id));
  if (entityMapIds.size !== snapshot.entities.length || [...entityMapIds].some((id) => !MAP_ID_PATTERNS.entity.test(String(id || "")))) {
    throw new Error("stored entity map IDs are invalid");
  }
  const registries = { returns: new Map(), forms: new Map(), k1Roles: new Map(), bookkeepers: new Map(), sources: new Map() };
  const referencedFilingUnits = new Set();
  for (const entity of snapshot.entities) {
    if (!exactObject(entity, ["map_id", "label", "disposition", "ledger_evidence", "fields", "tax_years"]) ||
        typeof entity.label !== "string" || entity.label.length < 1 || entity.label.length > 160 ||
        !DISPOSITIONS.has(entity.disposition) || !exactObject(entity.ledger_evidence, ["state", "current_ref", "row_hash"]) ||
        !["linked_current_record", "owner_declared_no_current_record"].includes(entity.ledger_evidence.state) ||
        !HASH_PATTERN.test(String(entity.ledger_evidence.row_hash || "")) ||
        (entity.ledger_evidence.state === "linked_current_record") !== HASH_PATTERN.test(String(entity.ledger_evidence.current_ref || "")) ||
        !exactObject(entity.fields, ENTITY_FIELDS) || !Array.isArray(entity.tax_years)) throw new Error("stored entity map is invalid");
    for (const field of ENTITY_FIELDS) if (!assertStoredAssessment(entity.fields[field])) throw new Error("stored entity assessment is invalid");
    if (entity.tax_years.length !== end - start + 1) throw new Error("stored entity-year map is incomplete");
    for (let index = 0; index < entity.tax_years.length; index++) {
      const year = entity.tax_years[index];
      const keys = ["tax_year", "state", "filing_units", "required_returns", "required_forms", "k1_roles", "books", "payroll", "expected_sources"];
      if (!exactObject(year, keys) || year.tax_year !== start + index || !DISPOSITIONS.has(year.state) ||
          !exactObject(year.filing_units, ["assessment", "refs"]) || !ASSESSMENTS.has(year.filing_units.assessment) ||
          !Array.isArray(year.filing_units.refs) || new Set(year.filing_units.refs).size !== year.filing_units.refs.length ||
          year.filing_units.refs.some((ref) => !filingUnitIds.has(ref)) ||
          (year.filing_units.assessment === "not_applicable" && year.filing_units.refs.length !== 0) ||
          !exactObject(year.books, ["assessment", "bookkeeping_company"]) || !ASSESSMENTS.has(year.books.assessment) ||
          !exactObject(year.payroll, ["assessment"]) || !ASSESSMENTS.has(year.payroll.assessment)) {
        throw new Error("stored entity-year map is invalid");
      }
      for (const ref of year.filing_units.refs) referencedFilingUnits.add(ref);
      assertStoredGroup(year.required_returns, "return", registries.returns);
      assertStoredGroup(year.required_forms, "form", registries.forms);
      assertStoredGroup(year.k1_roles, "k1_role", registries.k1Roles);
      assertStoredGroup(year.expected_sources, "source", registries.sources);
      const company = year.books.bookkeeping_company;
      if (company !== null) {
        if (year.books.assessment === "not_applicable" || !exactObject(company, ["map_id", "label", "assessment"]) ||
            !MAP_ID_PATTERNS.bookkeeper.test(String(company.map_id || "")) || typeof company.label !== "string" ||
            company.label.length < 1 || company.label.length > 160 || !ASSESSMENTS.has(company.assessment)) {
          throw new Error("stored bookkeeping company is invalid");
        }
        const identity = canonical({ label: company.label, kind: null });
        if (registries.bookkeepers.has(company.map_id) && registries.bookkeepers.get(company.map_id) !== identity) {
          throw new Error("stored bookkeeping company identity conflicts");
        }
        registries.bookkeepers.set(company.map_id, identity);
      }
    }
  }
  if ([...filingUnitIds].some((ref) => !referencedFilingUnits.has(ref))) throw new Error("stored filing unit is unreferenced");
  const accountMapIds = new Set();
  for (const account of snapshot.accounts) {
    if (!exactObject(account, ["map_id", "label", "disposition", "ledger_evidence", "fields"]) ||
        !MAP_ID_PATTERNS.account.test(String(account.map_id || "")) || accountMapIds.has(account.map_id) ||
        typeof account.label !== "string" || account.label.length < 1 || account.label.length > 160 ||
        !DISPOSITIONS.has(account.disposition) || !exactObject(account.ledger_evidence, ["state", "current_ref", "row_hash"]) ||
        !["linked_current_record", "owner_declared_no_current_record"].includes(account.ledger_evidence.state) ||
        !HASH_PATTERN.test(String(account.ledger_evidence.row_hash || "")) ||
        (account.ledger_evidence.state === "linked_current_record") !== HASH_PATTERN.test(String(account.ledger_evidence.current_ref || "")) ||
        !exactObject(account.fields, ACCOUNT_FIELDS)) throw new Error("stored account map is invalid");
    accountMapIds.add(account.map_id);
    for (const field of ACCOUNT_FIELDS) if (!assertStoredAssessment(account.fields[field])) throw new Error("stored account assessment is invalid");
  }
  const derived = snapshotMetadata(snapshot);
  for (const key of Object.keys(derived)) if (derived[key] !== metadata[key]) throw new Error("stored map counts do not match");
  if (derived.obligation_count > MAX_TOTAL_OBLIGATION_ITEMS) throw new Error("stored obligation list is too large");
}

function unresolvedAssessment(items, base, value) {
  if (value === "unknown" || value === "unavailable") items.push({ ...base, state: value });
}

function unresolvedGroup(items, entity, year, kind, group) {
  unresolvedAssessment(items, { kind, entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year }, group.assessment);
  for (const item of group.items) {
    unresolvedAssessment(items, {
      kind, entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year,
      item_ref: item.map_id, item_label: item.label,
    }, item.assessment);
  }
}

function unresolvedItems(snapshot) {
  const items = [];
  if (snapshot.population_state !== "owner_asserted_complete") {
    items.push({ kind: "population", state: snapshot.population_state, message: "The owner has not asserted that the financial-map population is complete." });
  }
  for (const unit of snapshot.filing_units) {
    unresolvedAssessment(items, { kind: "filing_unit", item_ref: unit.map_id, item_label: unit.label }, unit.assessment);
  }
  for (const entity of snapshot.entities) {
    if (entity.disposition === "unavailable") items.push({ kind: "entity", entity_ref: entity.map_id, label: entity.label, field: "disposition", state: "unavailable" });
    if (entity.disposition === "included" && entity.ledger_evidence.state === "owner_declared_no_current_record") {
      items.push({ kind: "entity_evidence", entity_ref: entity.map_id, label: entity.label, state: "unavailable", message: "This owner-declared entity has no linked current structured record." });
    }
    for (const field of ENTITY_FIELDS) {
      const answer = entity.fields[field];
      unresolvedAssessment(items, { kind: "entity", entity_ref: entity.map_id, label: entity.label, field }, answer.assessment);
      if (answer.evidence_match === false) {
        items.push({ kind: "entity_evidence", entity_ref: entity.map_id, label: entity.label, field, state: "mismatch" });
      }
    }
    for (const year of entity.tax_years) {
      if (year.state === "unavailable") items.push({ kind: "entity_year", entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year, state: "unavailable" });
      unresolvedAssessment(items, { kind: "filing_units", entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year }, year.filing_units.assessment);
      unresolvedGroup(items, entity, year, "required_returns", year.required_returns);
      unresolvedGroup(items, entity, year, "required_forms", year.required_forms);
      unresolvedGroup(items, entity, year, "k1_roles", year.k1_roles);
      unresolvedAssessment(items, { kind: "books", entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year }, year.books.assessment);
      if (year.books.bookkeeping_company) {
        unresolvedAssessment(items, {
          kind: "bookkeeping_company", entity_ref: entity.map_id, label: entity.label,
          tax_year: year.tax_year, item_ref: year.books.bookkeeping_company.map_id,
          item_label: year.books.bookkeeping_company.label,
        }, year.books.bookkeeping_company.assessment);
      }
      unresolvedAssessment(items, { kind: "payroll", entity_ref: entity.map_id, label: entity.label, tax_year: year.tax_year }, year.payroll.assessment);
      unresolvedGroup(items, entity, year, "expected_sources", year.expected_sources);
    }
  }
  for (const account of snapshot.accounts) {
    if (account.disposition === "unavailable") items.push({ kind: "account", account_ref: account.map_id, label: account.label, field: "disposition", state: "unavailable" });
    if (account.disposition === "included" && account.ledger_evidence.state === "owner_declared_no_current_record") {
      items.push({ kind: "account_evidence", account_ref: account.map_id, label: account.label, state: "unavailable", message: "This owner-declared account has no linked current structured record." });
    }
    for (const field of ACCOUNT_FIELDS) {
      const answer = account.fields[field];
      unresolvedAssessment(items, { kind: "account", account_ref: account.map_id, label: account.label, field }, answer.assessment);
      if (answer.evidence_match === false) items.push({ kind: "account_evidence", account_ref: account.map_id, label: account.label, field, state: "mismatch" });
    }
  }
  return items;
}

function headSummary(head) {
  return head ? {
    snapshot_ref: head.snapshot_id,
    map_hash: head.map_hash,
    sequence: Number(head.sequence_no),
  } : { snapshot_ref: null, map_hash: null, sequence: 0 };
}

async function validateSnapshotRow(row, signer) {
  const sequence = Number(row.sequence_no);
  if (!SNAPSHOT_ID_PATTERN.test(String(row.snapshot_id || "")) || row.tenant_id !== TENANT_ID ||
      !Number.isSafeInteger(sequence) || sequence < 1 || Number(row.contract_version) !== CONTRACT_VERSION ||
      ((sequence === 1) !== (row.previous_snapshot_id === null && row.previous_map_hash === null))) {
    throw new Error("map chain row is invalid");
  }
  if (sequence > 1 && (!SNAPSHOT_ID_PATTERN.test(String(row.previous_snapshot_id || "")) ||
      !HASH_PATTERN.test(String(row.previous_map_hash || "")))) throw new Error("map chain link is invalid");
  assertHash(row.map_hash);
  assertHash(row.denominator_hash);
  assertHash(row.inventory_hash);
  assertHash(row.snapshot_seal);
  assertHash(row.credential_ref);
  assertHash(row.request_hash);
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { throw new Error("stored map JSON is invalid"); }
  const metadata = {
    population_state: row.population_state,
    tax_year_start: Number(row.tax_year_start),
    tax_year_end: Number(row.tax_year_end),
    entity_count: Number(row.entity_count),
    account_count: Number(row.account_count),
    entity_year_count: Number(row.entity_year_count),
    filing_unit_count: Number(row.filing_unit_count),
    obligation_count: Number(row.obligation_count),
  };
  assertStoredSnapshot(snapshot, metadata);
  if (!constantTimeEquals(await sha256Hex(canonical(snapshot)), row.map_hash) ||
      !constantTimeEquals(await denominatorHashFor(snapshot), row.denominator_hash) ||
      !constantTimeEquals(await signer.hmac("snapshot-seal", snapshotSealInput(row)), row.snapshot_seal)) {
    throw new Error("stored map seal does not verify");
  }
  return { ...row, snapshot };
}

async function validateHead(rows, summaryRows, signer) {
  if (summaryRows.length !== 1) throw new Error("map chain summary is unavailable");
  const count = assertSafeInteger(summaryRows[0].snapshot_count);
  const maximum = summaryRows[0].max_sequence === null ? null : assertSafeInteger(summaryRows[0].max_sequence, 1);
  if (count === 0) {
    if (maximum !== null || rows.length !== 0) throw new Error("empty map chain is inconsistent");
    return null;
  }
  if (maximum !== count || rows.length !== Math.min(2, count)) throw new Error("map chain has a gap or an unavailable head");
  const head = await validateSnapshotRow(rows[0], signer);
  if (Number(head.sequence_no) !== count) throw new Error("map head sequence is inconsistent");
  if (count === 1) return head;
  const previous = await validateSnapshotRow(rows[1], signer);
  if (Number(previous.sequence_no) !== count - 1 || head.previous_snapshot_id !== previous.snapshot_id ||
      head.previous_map_hash !== previous.map_hash) throw new Error("map head is not linked to its predecessor");
  return head;
}

async function captureCurrentState(env, signer) {
  const results = await env.DB.batch([
    env.DB.prepare(
      "SELECT tenant_id, generation FROM owner_financial_map_inventory_state WHERE tenant_id = ?",
    ).bind(TENANT_ID),
    env.DB.prepare(
      `SELECT id, entity_slug, legal_name, display_label, kind, status, relationship, holds,
              parent_entity_slug, ownership_bp, tax_class, provenance, basis_state, recorded_at
         FROM fin_entities
        WHERE tenant_id = ? AND superseded_by_id IS NULL
        ORDER BY id LIMIT ${MAX_ENTITIES + 1}`,
    ).bind(TENANT_ID),
    env.DB.prepare(
      `SELECT id, account_slug, entity_slug, institution, label, account_kind, balance_role,
              currency, status, provenance, basis_state, recorded_at
         FROM fin_accounts
        WHERE tenant_id = ? AND superseded_by_id IS NULL
        ORDER BY id LIMIT ${MAX_ACCOUNTS + 1}`,
    ).bind(TENANT_ID),
    env.DB.prepare(
      `SELECT snapshot_id, tenant_id, sequence_no, previous_snapshot_id, previous_map_hash,
              contract_version, snapshot_json, map_hash, denominator_hash, inventory_hash,
              inventory_generation, population_state, tax_year_start, tax_year_end,
              entity_count, account_count, entity_year_count, filing_unit_count,
              obligation_count, snapshot_seal, credential_ref,
              request_id, request_hash, activated_at
         FROM owner_financial_map_snapshots
        WHERE tenant_id = ? ORDER BY sequence_no DESC LIMIT 2`,
    ).bind(TENANT_ID),
    env.DB.prepare(
      `SELECT COUNT(*) AS snapshot_count, MAX(sequence_no) AS max_sequence
         FROM owner_financial_map_snapshots WHERE tenant_id = ?`,
    ).bind(TENANT_ID),
  ]);
  if (!Array.isArray(results) || results.length !== 5) throw new Error("map state query is incomplete");
  const markerRows = rowsOf(results[0]);
  const entityRows = rowsOf(results[1]);
  const accountRows = rowsOf(results[2]);
  const headRows = rowsOf(results[3]);
  const summaryRows = rowsOf(results[4]);
  if (markerRows.length !== 1 || markerRows[0].tenant_id !== TENANT_ID ||
      !Number.isSafeInteger(Number(markerRows[0].generation)) || Number(markerRows[0].generation) < 0 ||
      entityRows.length > MAX_ENTITIES || accountRows.length > MAX_ACCOUNTS || headRows.length > 2) {
    throw new Error("map state is incomplete or outside its closed bounds");
  }
  const [inventory, head] = await Promise.all([
    publicInventory(entityRows, accountRows, signer),
    validateHead(headRows, summaryRows, signer),
  ]);
  return {
    generation: Number(markerRows[0].generation),
    inventory,
    head,
  };
}

function readStateBody(state) {
  const active = state.head;
  // The generation is a local race fence, not durable content. Recovery
  // replays financial rows through its triggers, so only the exact current
  // inventory hash decides whether a restored active map is still current.
  const current = Boolean(active &&
    constantTimeEquals(active.inventory_hash, state.inventory.inventory_hash));
  const status = !active ? "not_established" : current ? "current" : "stale";
  const unresolved = active ? unresolvedItems(active.snapshot) : [{
    kind: "map",
    state: "not_established",
    message: "The owner has not activated a complete financial map.",
  }];
  if (active && !current) unresolved.unshift({
    kind: "map_currentness",
    state: "stale",
    message: "The structured entity or account inventory changed after this map was activated.",
  });
  return {
    version: CONTRACT_VERSION,
    authoritative: current,
    current_inventory_authoritative: false,
    map_status: status,
    population_state: active?.population_state ?? "unknown",
    current_head: headSummary(active),
    inventory_generation: state.generation,
    inventory_hash: state.inventory.inventory_hash,
    current_inventory: {
      candidate_notice: "These are possible mentions until the owner confirms each item in a complete financial map.",
      entities: state.inventory.entities,
      accounts: state.inventory.accounts,
    },
    active_map: active ? active.snapshot : null,
    active_map_matches_current_inventory: current,
    unresolved_count: unresolved.length,
    unresolved_items: unresolved,
    next_step: status === "current"
      ? "Review unresolved items before relying on completeness."
      : "Offer a guided owner interview, one short question at a time, then create a complete preview.",
  };
}

async function readOrPreviewPrincipal(request, env) {
  if (validateAdminKey(request, env)) return { kind: "admin" };
  const principal = await ownerSessionPrincipal(request, env);
  if (principal?.kind === "owner" && principal.grantId === null) return principal;
  if (principal) throw new MapRequestError(403, "owner_financial_map_owner_required", "The full owner is required.");
  throw new MapRequestError(401, "owner_financial_map_auth_required", "Owner or administrator authentication is required.");
}

async function requireExactOwner(request, env) {
  const principal = await ownerSessionPrincipal(request, env);
  if (principal?.kind === "owner" && principal.grantId === null) return principal;
  throw new MapRequestError(403, "owner_financial_map_fresh_passkey_required", "A signed-in owner must complete the separate passkey ceremony.");
}

function previewSelect() {
  return `SELECT receipt_hash, tenant_id, contract_version, snapshot_json, map_hash,
                 denominator_hash, inventory_hash, inventory_generation,
                 expected_head_snapshot_id, expected_head_map_hash, expected_sequence_no,
                 population_state, tax_year_start, tax_year_end, entity_count, account_count,
                 entity_year_count, filing_unit_count, obligation_count, preview_seal,
                 expires_at, state, request_id, request_hash,
                 activated_snapshot_id, created_at, activated_at
            FROM owner_financial_map_previews
           WHERE tenant_id = ? AND receipt_hash = ?`;
}

async function validatePreviewRow(row, signer) {
  if (!row) return null;
  if (row.tenant_id !== TENANT_ID) throw new Error("preview tenant is invalid");
  assertHash(row.receipt_hash);
  assertHash(row.map_hash);
  assertHash(row.denominator_hash);
  assertHash(row.inventory_hash);
  assertHash(row.preview_seal);
  let snapshot;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { throw new Error("preview map JSON is invalid"); }
  const metadata = {
    population_state: row.population_state,
    tax_year_start: Number(row.tax_year_start),
    tax_year_end: Number(row.tax_year_end),
    entity_count: Number(row.entity_count),
    account_count: Number(row.account_count),
    entity_year_count: Number(row.entity_year_count),
    filing_unit_count: Number(row.filing_unit_count),
    obligation_count: Number(row.obligation_count),
  };
  assertStoredSnapshot(snapshot, metadata);
  if (!constantTimeEquals(await sha256Hex(canonical(snapshot)), row.map_hash) ||
      !constantTimeEquals(await denominatorHashFor(snapshot), row.denominator_hash) ||
      !constantTimeEquals(await signer.hmac("preview-seal", previewSealInput(row)), row.preview_seal)) {
    throw new Error("preview seal does not verify");
  }
  return { ...row, snapshot };
}

async function loadPreviewByReceiptHash(env, receiptHash, signer) {
  if (!HASH_PATTERN.test(String(receiptHash || ""))) return null;
  const row = await env.DB.prepare(previewSelect()).bind(TENANT_ID, receiptHash).first();
  return validatePreviewRow(row, signer);
}

function reviewIdFor(preview) {
  assertHash(preview.receipt_hash);
  return `ofmp_${preview.receipt_hash}`;
}

function receiptHashFromReviewId(reviewId) {
  const normalized = String(reviewId || "");
  return REVIEW_ID_PATTERN.test(normalized) ? normalized.slice(5) : null;
}

async function loadReviewPreview(env, reviewId, signer) {
  const receiptHash = receiptHashFromReviewId(reviewId);
  return receiptHash ? loadPreviewByReceiptHash(env, receiptHash, signer) : null;
}

async function loadLatestPendingPreview(env, signer) {
  const result = await env.DB.prepare(
    `${previewSelect().replace("WHERE tenant_id = ? AND receipt_hash = ?", "WHERE tenant_id = ? AND state = 'previewed'")}
      ORDER BY created_at DESC, receipt_hash DESC LIMIT 2`,
  ).bind(TENANT_ID).all();
  const rows = rowsOf(result);
  if (rows.length > 1) throw new Error("more than one pending map preview exists");
  return validatePreviewRow(rows[0] ?? null, signer);
}

function stateMatchesPreview(state, preview) {
  const head = state.head;
  return Number(preview.inventory_generation) === state.generation &&
    constantTimeEquals(preview.inventory_hash, state.inventory.inventory_hash) &&
    Number(preview.expected_sequence_no) === (head ? Number(head.sequence_no) + 1 : 1) &&
    preview.expected_head_snapshot_id === (head?.snapshot_id ?? null) &&
    preview.expected_head_map_hash === (head?.map_hash ?? null);
}

async function invalidatePreview(env, preview) {
  await env.DB.prepare(
    "UPDATE owner_financial_map_previews SET state = 'invalidated' WHERE receipt_hash = ? AND state = 'previewed'",
  ).bind(preview.receipt_hash).run();
}

function reviewValue(value, labels) {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return labels.get(value) ?? value;
  if (value && typeof value === "object" && !Array.isArray(value) && typeof value.label === "string") {
    return value.label;
  }
  throw new Error("map review value is not display-safe");
}

function reviewField(answer, labels) {
  return {
    assessment: answer.assessment,
    owner_value: reviewValue(answer.owner_value, labels),
    current_value: reviewValue(answer.current_value, labels),
    comparison: answer.evidence_match === true ? "matches_current"
      : answer.evidence_match === false ? "differs_from_current"
        : "not_compared",
  };
}

function reviewGroup(group) {
  return {
    assessment: group.assessment,
    items: group.items.map((item) => ({
      label: item.label,
      ...(item.kind ? { kind: item.kind } : {}),
      assessment: item.assessment,
    })),
  };
}

/**
 * Owner-app projection of a complete stored preview.
 *
 * The sealed snapshot keeps opaque map references and evidence hashes so the
 * Worker can verify activation. The page needs the complete human review, not
 * those internals. This projection therefore preserves exact private labels
 * and values while removing every map id, row/value hash, ledger reference,
 * source locator, external reference, slug, and raw account mask.
 */
function reviewSnapshot(snapshot) {
  const labels = new Map();
  for (const row of snapshot.filing_units) labels.set(row.map_id, row.label);
  for (const row of snapshot.entities) labels.set(row.map_id, row.label);
  for (const row of snapshot.accounts) labels.set(row.map_id, row.label);

  const entities = snapshot.entities.map((entity) => ({
    label: entity.label,
    disposition: entity.disposition,
    evidence_state: entity.ledger_evidence.state,
    fields: Object.fromEntries(ENTITY_FIELDS.map((field) => [field, reviewField(entity.fields[field], labels)])),
    tax_years: entity.tax_years.map((year) => ({
      tax_year: year.tax_year,
      state: year.state,
      filing_units: {
        assessment: year.filing_units.assessment,
        labels: year.filing_units.refs.map((ref) => {
          const label = labels.get(ref);
          if (!label) throw new Error("map review filing unit is unavailable");
          return label;
        }),
      },
      required_returns: reviewGroup(year.required_returns),
      required_forms: reviewGroup(year.required_forms),
      k1_roles: reviewGroup(year.k1_roles),
      books: {
        assessment: year.books.assessment,
        bookkeeping_company: year.books.bookkeeping_company ? {
          label: year.books.bookkeeping_company.label,
          assessment: year.books.bookkeeping_company.assessment,
        } : null,
      },
      payroll: { assessment: year.payroll.assessment },
      expected_sources: reviewGroup(year.expected_sources),
    })),
  }));
  const accounts = snapshot.accounts.map((account) => ({
    label: account.label,
    disposition: account.disposition,
    evidence_state: account.ledger_evidence.state,
    fields: Object.fromEntries(ACCOUNT_FIELDS.map((field) => [field, reviewField(account.fields[field], labels)])),
  }));
  return {
    population_state: snapshot.population_state,
    tax_year_horizon: { ...snapshot.tax_year_horizon },
    filing_units: snapshot.filing_units.map((unit) => ({
      label: unit.label,
      assessment: unit.assessment,
    })),
    entities,
    accounts,
  };
}

function reviewUnresolved(items) {
  return items.map((item) => ({
    kind: item.kind,
    state: item.state,
    ...(item.label ? { label: item.label } : {}),
    ...(item.item_label ? { item_label: item.item_label } : {}),
    ...(item.field ? { field: item.field } : {}),
    ...(Number.isSafeInteger(item.tax_year) ? { tax_year: item.tax_year } : {}),
    ...(item.message ? { message: item.message } : {}),
  }));
}

function assessmentSummary(value) {
  return String(value).replaceAll("_", " ");
}

function fieldSummary(answer, labels) {
  const owner = reviewValue(answer.owner_value, labels);
  const current = reviewValue(answer.current_value, labels);
  return `${assessmentSummary(answer.assessment)}; owner: ${owner ?? "not recorded"}; ` +
    `current record: ${current ?? "not recorded"}; ${assessmentSummary(
      answer.evidence_match === true ? "matches current" : answer.evidence_match === false ? "different from current" : "not compared",
    )}`;
}

function groupSummary(group) {
  const items = group.items.map((item) =>
    `${item.label}${item.kind ? ` (${assessmentSummary(item.kind)})` : ""}: ${assessmentSummary(item.assessment)}`);
  return `${assessmentSummary(group.assessment)}; ${items.length ? items.join(", ") : "no individual items listed"}`;
}

function filingSummary(filing, labels) {
  return `${assessmentSummary(filing.assessment)}; ${filing.refs.length
    ? filing.refs.map((ref) => labels.get(ref) || "unavailable filing unit").join(", ")
    : "no individual filing units listed"}`;
}

function booksSummary(books) {
  return `${assessmentSummary(books.assessment)}; ${books.bookkeeping_company
    ? `${books.bookkeeping_company.label}: ${assessmentSummary(books.bookkeeping_company.assessment)}`
    : "no bookkeeping company listed"}`;
}

function changeEntry(changes, value) {
  if (value.before === value.after) return;
  changes.push(value);
}

function mapChanges(snapshot, prior) {
  if (!prior) return [];
  const changes = [];
  const labels = new Map();
  for (const source of [prior, snapshot]) {
    for (const row of source.filing_units) labels.set(row.map_id, row.label);
    for (const row of source.entities) labels.set(row.map_id, row.label);
    for (const row of source.accounts) labels.set(row.map_id, row.label);
  }
  changeEntry(changes, {
    area: "Population", subject: "Whole financial picture", field: "Completeness statement",
    before: assessmentSummary(prior.population_state), after: assessmentSummary(snapshot.population_state),
  });
  changeEntry(changes, {
    area: "Tax years", subject: "Review horizon", field: "Years included",
    before: `${prior.tax_year_horizon.start} through ${prior.tax_year_horizon.end}`,
    after: `${snapshot.tax_year_horizon.start} through ${snapshot.tax_year_horizon.end}`,
  });

  const compareRows = (area, currentRows, priorRows, visit) => {
    const current = new Map(currentRows.map((row) => [row.map_id, row]));
    const previous = new Map(priorRows.map((row) => [row.map_id, row]));
    for (const [id, row] of current) {
      const old = previous.get(id);
      if (!old) {
        changes.push({ area, subject: row.label, field: "Map entry", before: null, after: "Added" });
      } else {
        visit(row, old);
      }
    }
    for (const [id, row] of previous) {
      if (!current.has(id)) changes.push({ area, subject: row.label, field: "Map entry", before: "Present", after: "Removed" });
    }
  };

  compareRows("Filing units", snapshot.filing_units, prior.filing_units, (row, old) => {
    changeEntry(changes, { area: "Filing units", subject: row.label, field: "Label", before: old.label, after: row.label });
    changeEntry(changes, {
      area: "Filing units", subject: row.label, field: "Assessment",
      before: assessmentSummary(old.assessment), after: assessmentSummary(row.assessment),
    });
  });

  compareRows("Entities", snapshot.entities, prior.entities, (entity, old) => {
    changeEntry(changes, { area: "Entities", subject: entity.label, field: "Label", before: old.label, after: entity.label });
    changeEntry(changes, {
      area: "Entities", subject: entity.label, field: "Disposition",
      before: assessmentSummary(old.disposition), after: assessmentSummary(entity.disposition),
    });
    changeEntry(changes, {
      area: "Entities", subject: entity.label, field: "Current evidence",
      before: assessmentSummary(old.ledger_evidence.state), after: assessmentSummary(entity.ledger_evidence.state),
    });
    for (const field of ENTITY_FIELDS) {
      changeEntry(changes, {
        area: "Entities", subject: entity.label, field: field.replaceAll("_", " "),
        before: fieldSummary(old.fields[field], labels), after: fieldSummary(entity.fields[field], labels),
      });
    }
    const years = new Map(entity.tax_years.map((year) => [year.tax_year, year]));
    const oldYears = new Map(old.tax_years.map((year) => [year.tax_year, year]));
    const categories = [
      ["Filing units", (year) => filingSummary(year.filing_units, labels)],
      ["Required returns", (year) => groupSummary(year.required_returns)],
      ["Required forms", (year) => groupSummary(year.required_forms)],
      ["K-1 roles", (year) => groupSummary(year.k1_roles)],
      ["Books", (year) => booksSummary(year.books)],
      ["Payroll", (year) => assessmentSummary(year.payroll.assessment)],
      ["Expected sources", (year) => groupSummary(year.expected_sources)],
    ];
    for (const [yearNumber, year] of years) {
      const oldYear = oldYears.get(yearNumber);
      if (!oldYear) {
        changes.push({ area: "Entity years", subject: entity.label, tax_year: yearNumber, field: "Tax year", before: null, after: "Added" });
        continue;
      }
      changeEntry(changes, {
        area: "Entity years", subject: entity.label, tax_year: yearNumber, field: "Disposition",
        before: assessmentSummary(oldYear.state), after: assessmentSummary(year.state),
      });
      for (const [field, summarize] of categories) {
        changeEntry(changes, {
          area: "Entity years", subject: entity.label, tax_year: yearNumber, field,
          before: summarize(oldYear), after: summarize(year),
        });
      }
    }
    for (const yearNumber of oldYears.keys()) {
      if (!years.has(yearNumber)) {
        changes.push({ area: "Entity years", subject: entity.label, tax_year: yearNumber, field: "Tax year", before: "Present", after: "Removed" });
      }
    }
  });

  compareRows("Accounts", snapshot.accounts, prior.accounts, (account, old) => {
    changeEntry(changes, { area: "Accounts", subject: account.label, field: "Label", before: old.label, after: account.label });
    changeEntry(changes, {
      area: "Accounts", subject: account.label, field: "Disposition",
      before: assessmentSummary(old.disposition), after: assessmentSummary(account.disposition),
    });
    changeEntry(changes, {
      area: "Accounts", subject: account.label, field: "Current evidence",
      before: assessmentSummary(old.ledger_evidence.state), after: assessmentSummary(account.ledger_evidence.state),
    });
    for (const field of ACCOUNT_FIELDS) {
      changeEntry(changes, {
        area: "Accounts", subject: account.label, field: field.replaceAll("_", " "),
        before: fieldSummary(old.fields[field], labels), after: fieldSummary(account.fields[field], labels),
      });
    }
  });
  return changes;
}

function reviewPresentation(preview, { includeReviewId = false, priorSnapshot = null } = {}) {
  const unresolved = reviewUnresolved(unresolvedItems(preview.snapshot));
  const changes = mapChanges(preview.snapshot, priorSnapshot);
  return {
    status: "ready",
    review_state: "pending",
    authoritative: false,
    activation_performed: false,
    complete: true,
    truncated: false,
    ...(includeReviewId ? { review_id: reviewIdFor(preview) } : {}),
    map_hash: preview.map_hash,
    denominator_hash: preview.denominator_hash,
    expected_sequence: Number(preview.expected_sequence_no),
    created_at: Number(preview.created_at),
    expires_at: Number(preview.expires_at),
    counts: {
      entities: Number(preview.entity_count),
      accounts: Number(preview.account_count),
      entity_years: Number(preview.entity_year_count),
      filing_units: Number(preview.filing_unit_count),
      obligation_items: Number(preview.obligation_count),
    },
    complete_preview: reviewSnapshot(preview.snapshot),
    prior_comparison: {
      state: priorSnapshot ? "compared" : "no_prior_confirmed_map",
      changed: priorSnapshot ? changes.length > 0 : null,
      change_count: changes.length,
      changes,
      previous_confirmed_map: priorSnapshot ? reviewSnapshot(priorSnapshot) : null,
    },
    unresolved_count: unresolved.length,
    unresolved_items: unresolved,
    requires: "explicit_owner_passkey_confirmation",
  };
}

async function createPreview(env, body, state, signer, now) {
  if (!exactObject(body, ["snapshot"])) {
    invalid("owner_financial_map_preview_fields_invalid", "A preview requires exactly one full snapshot.");
  }
  const snapshot = await normalizeSubmittedSnapshot(body.snapshot, state.inventory, signer, state.head?.snapshot ?? null);
  const snapshotJson = canonical(snapshot);
  if (encoder.encode(snapshotJson).length > MAX_SNAPSHOT_BYTES) {
    throw new MapRequestError(413, "owner_financial_map_snapshot_too_large", "The complete financial map is too large for one durable snapshot.");
  }
  const mapHash = await sha256Hex(snapshotJson);
  const denominatorHash = await denominatorHashFor(snapshot);
  const metadata = snapshotMetadata(snapshot);
  // The random seed is discarded immediately. Only its digest is stored. The
  // owner app later uses that digest as a non-authorizing opaque selector after
  // an exact owner session has already been established.
  const receiptHash = await sha256Hex(randomToken(32));
  const expiresAt = now + PREVIEW_TTL_MS;
  const sequence = state.head ? Number(state.head.sequence_no) + 1 : 1;
  const row = {
    receipt_hash: receiptHash,
    tenant_id: TENANT_ID,
    contract_version: CONTRACT_VERSION,
    snapshot_json: snapshotJson,
    map_hash: mapHash,
    denominator_hash: denominatorHash,
    inventory_hash: state.inventory.inventory_hash,
    inventory_generation: state.generation,
    expected_head_snapshot_id: state.head?.snapshot_id ?? null,
    expected_head_map_hash: state.head?.map_hash ?? null,
    expected_sequence_no: sequence,
    ...metadata,
    expires_at: expiresAt,
    created_at: now,
  };
  const previewSeal = await signer.hmac("preview-seal", previewSealInput(row));
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE owner_financial_map_previews
          SET state = 'invalidated'
        WHERE tenant_id = ? AND state = 'previewed'`,
    ).bind(TENANT_ID),
    env.DB.prepare(
      `INSERT INTO owner_financial_map_previews
         (receipt_hash, tenant_id, contract_version, snapshot_json, map_hash,
          denominator_hash, inventory_hash, inventory_generation,
          expected_head_snapshot_id, expected_head_map_hash, expected_sequence_no,
          population_state, tax_year_start, tax_year_end, entity_count, account_count,
          entity_year_count, filing_unit_count, obligation_count, preview_seal,
          expires_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'previewed', ?)`,
    ).bind(
      receiptHash, TENANT_ID, CONTRACT_VERSION, snapshotJson, mapHash, denominatorHash,
      state.inventory.inventory_hash, state.generation, row.expected_head_snapshot_id,
      row.expected_head_map_hash, sequence, metadata.population_state, metadata.tax_year_start,
      metadata.tax_year_end, metadata.entity_count, metadata.account_count,
      metadata.entity_year_count, metadata.filing_unit_count, metadata.obligation_count,
      previewSeal, expiresAt, now,
    ),
  ]);
  if (!Array.isArray(results) || results.length !== 2 || changed(results[1]) !== 1) {
    throw new Error("map preview was not stored exactly once");
  }
  return {
    status: "ready",
    review_state: "pending",
    authoritative: false,
    activation_performed: false,
    expires_at: expiresAt,
    counts: {
      entities: metadata.entity_count,
      accounts: metadata.account_count,
      entity_years: metadata.entity_year_count,
      filing_units: metadata.filing_unit_count,
      obligation_items: metadata.obligation_count,
    },
    unresolved_count: unresolvedItems(snapshot).length,
    review_available_in_owner_app: true,
    owner_message: "Nothing changed. The exact private labels and full map are available only in Financial Map inside the signed-in owner app. Review everything there before choosing whether to confirm it with a fresh passkey.",
  };
}

function challengeFromClientData(clientDataJSON) {
  try {
    return JSON.parse(new TextDecoder().decode(b64uDecode(clientDataJSON)))?.challenge || null;
  } catch {
    return null;
  }
}

function challengePurpose(preview) {
  return `financial-map-activate:${preview.receipt_hash}:${preview.map_hash}:${preview.denominator_hash}:` +
    `${preview.expected_head_snapshot_id || "genesis"}:${preview.expected_head_map_hash || "genesis"}:` +
    `${Number(preview.expected_sequence_no)}`;
}

async function reviewPendingPreview(env, signer, now) {
  const preview = await loadLatestPendingPreview(env, signer);
  const state = await captureCurrentState(env, signer);
  if (!preview) {
    const current = Boolean(state.head &&
      constantTimeEquals(state.head.inventory_hash, state.inventory.inventory_hash));
    return {
      status: "no_pending_review",
      review_state: "none",
      complete: true,
      truncated: false,
      active_map_present: Boolean(state.head),
      active_map_authoritative: state.head ? current : false,
      active_sequence: state.head ? Number(state.head.sequence_no) : null,
      active_map_hash: state.head?.map_hash ?? null,
      active_denominator_hash: state.head?.denominator_hash ?? null,
      active_activated_at: state.head ? Number(state.head.activated_at) : null,
      owner_message: state.head
        ? "No Financial Map is waiting for review. The latest confirmed map remains available for future completeness checks."
        : "No Financial Map is waiting for review. Complete the guided interview and create a fresh preview.",
    };
  }
  if (Number(preview.expires_at) <= now) {
    throw new MapRequestError(
      410,
      "owner_financial_map_preview_expired",
      "This Financial Map review expired. Nothing was activated. Complete a fresh guided interview before confirming a map.",
    );
  }
  if (!stateMatchesPreview(state, preview)) {
    await invalidatePreview(env, preview);
    conflict(
      "owner_financial_map_preview_stale",
      "The current map or structured records changed after this review was prepared. Nothing was activated. Create and review a fresh preview.",
    );
  }
  return reviewPresentation(preview, {
    includeReviewId: true,
    priorSnapshot: state.head?.snapshot ?? null,
  });
}

async function passkeyOptions(env, request, body, signer, now) {
  if (!exactObject(body, ["review_id"]) || !REVIEW_ID_PATTERN.test(String(body.review_id || ""))) {
    invalid("owner_financial_map_options_fields_invalid", "Choose the exact current map preview.");
  }
  const preview = await loadReviewPreview(env, body.review_id, signer);
  if (!preview) throw new MapRequestError(404, "owner_financial_map_preview_not_found", "The map preview was not found.");
  if (preview.state !== "previewed") conflict("owner_financial_map_preview_replayed", "This preview is no longer available for activation.");
  if (Number(preview.expires_at) <= now) throw new MapRequestError(410, "owner_financial_map_preview_expired", "The map preview expired. Create and review a fresh one.");
  const state = await captureCurrentState(env, signer);
  if (!stateMatchesPreview(state, preview)) {
    await invalidatePreview(env, preview);
    conflict("owner_financial_map_preview_stale", "The map or structured inventory changed. Review a fresh preview.");
  }
  const ttl = Math.min(2 * 60 * 1000, Number(preview.expires_at) - now);
  const challenge = await issueChallenge(env, challengePurpose(preview), ttl);
  const credentialRows = await env.DB.prepare(
    `SELECT credential_id FROM owner_passkeys
      WHERE grant_id IS NULL AND document_grant_id IS NULL ORDER BY created_at`,
  ).all();
  return {
    challenge,
    rp_id: env.WEBAUTHN_RP_ID || new URL(request.url).hostname,
    allow_credentials: rowsOf(credentialRows).map((row) => row.credential_id),
    expires_at: Math.min(Number(preview.expires_at), now + ttl),
    ceremony_message: "Your passkey confirms this exact reviewed map, its full declared population, its yearly tax, books, payroll, and source obligations, and the current map head. It does not change accounts, books, taxes, payroll, sources, or ledger records.",
  };
}

async function activatedReplay(env, preview, requestHash, requestId) {
  if (preview.state !== "activated" || preview.request_id !== requestId ||
      !constantTimeEquals(String(preview.request_hash || ""), requestHash)) return null;
  const row = await env.DB.prepare(
    `SELECT snapshot_id, sequence_no, map_hash, denominator_hash, population_state,
            tax_year_start, tax_year_end, entity_count, account_count, entity_year_count,
            filing_unit_count, obligation_count, request_id, activated_at
       FROM owner_financial_map_snapshots
      WHERE tenant_id = ? AND snapshot_id = ? AND request_id = ? AND request_hash = ?`,
  ).bind(TENANT_ID, preview.activated_snapshot_id, requestId, requestHash).first();
  if (!row) throw new Error("activated map receipt is incomplete");
  return activationReceipt(row, true);
}

function activationReceipt(row, replayed = false) {
  return {
    activated: true,
    replayed,
    sequence: Number(row.sequence_no),
    map_hash: row.map_hash,
    denominator_hash: row.denominator_hash,
    population_state: row.population_state,
    tax_year_horizon: { start: Number(row.tax_year_start), end: Number(row.tax_year_end) },
    counts: {
      entities: Number(row.entity_count),
      accounts: Number(row.account_count),
      entity_years: Number(row.entity_year_count),
      filing_units: Number(row.filing_unit_count),
      obligation_items: Number(row.obligation_count),
    },
    request_id: row.request_id,
    activated_at: Number(row.activated_at),
    mutations: {
      owner_financial_map_snapshot: "appended",
      ledger: "none",
      sources: "none",
      taxes: "none",
      books: "none",
      payroll: "none",
      accounts: "none",
    },
  };
}

async function activate(env, request, body, signer, now) {
  const fields = [
    "review_id", "request_id", "credentialId", "authenticatorData", "clientDataJSON", "signature",
  ];
  if (!exactObject(body, fields) || !REVIEW_ID_PATTERN.test(String(body.review_id || "")) ||
      !REQUEST_ID_PATTERN.test(String(body.request_id || "")) ||
      ["credentialId", "authenticatorData", "clientDataJSON", "signature"].some((field) =>
        typeof body[field] !== "string" || body[field].length < 1 || body[field].length > 8192)) {
    invalid("owner_financial_map_activation_fields_invalid", "The owner activation response is incomplete.");
  }
  let preview = await loadReviewPreview(env, body.review_id, signer);
  if (!preview) throw new MapRequestError(404, "owner_financial_map_preview_not_found", "The map preview was not found.");
  const requestHash = await sha256Hex(canonical(body));
  const replay = await activatedReplay(env, preview, requestHash, body.request_id);
  if (replay) return replay;
  if (preview.request_id || preview.request_hash || preview.state !== "previewed") {
    conflict("owner_financial_map_preview_replayed", "This preview was already used or altered.");
  }
  if (Number(preview.expires_at) <= now) throw new MapRequestError(410, "owner_financial_map_preview_expired", "The map preview expired. Create and review a fresh one.");
  const existingRequest = await env.DB.prepare(
    "SELECT snapshot_id FROM owner_financial_map_snapshots WHERE tenant_id = ? AND request_id = ? LIMIT 1",
  ).bind(TENANT_ID, body.request_id).first();
  if (existingRequest) conflict("owner_financial_map_request_id_conflict", "This activation request id was already used.");
  const state = await captureCurrentState(env, signer);
  if (!stateMatchesPreview(state, preview)) {
    await invalidatePreview(env, preview);
    conflict("owner_financial_map_preview_stale", "The map or structured inventory changed. Review a fresh preview.");
  }

  const challenge = challengeFromClientData(body.clientDataJSON);
  if (!challenge) throw new MapRequestError(403, "owner_financial_map_passkey_challenge_invalid", "The passkey challenge is invalid.");
  const challengeHash = await sha256Hex(challenge);
  const purpose = challengePurpose(preview);
  const challengeRow = await env.DB.prepare(
    "SELECT purpose, expires_at FROM auth_challenges WHERE challenge_hash = ?",
  ).bind(challengeHash).first();
  if (!challengeRow || challengeRow.purpose !== purpose || Number(challengeRow.expires_at) <= now) {
    throw new MapRequestError(403, "owner_financial_map_passkey_challenge_invalid", "The passkey challenge is invalid or expired.");
  }
  const credential = await findPasskey(env, body.credentialId);
  if (!credential || credential.grant_id !== null || credential.document_grant_id !== null) {
    throw new MapRequestError(403, "owner_financial_map_owner_passkey_required", "A full owner passkey is required.");
  }
  let verdict;
  try {
    verdict = await verifyAssertion({
      authenticatorData: body.authenticatorData,
      clientDataJSON: body.clientDataJSON,
      signature: body.signature,
      expectedChallenge: challenge,
      expectedOrigin: new URL(request.url).origin,
      rpId: env.WEBAUTHN_RP_ID || new URL(request.url).hostname,
      credential,
    });
  } catch {
    throw new MapRequestError(403, "owner_financial_map_passkey_verification_failed", "The passkey could not verify this map.");
  }
  if (verdict.cloneSuspected) {
    throw new MapRequestError(403, "owner_financial_map_passkey_counter_regressed", "This passkey needs owner review before it can activate a map.");
  }

  const snapshotId = `ofm_${randomToken(24)}`;
  const credentialRef = await signer.hmac("activation-credential", { credential_id: credential.credential_id });
  const row = {
    snapshot_id: snapshotId,
    tenant_id: TENANT_ID,
    sequence_no: Number(preview.expected_sequence_no),
    previous_snapshot_id: preview.expected_head_snapshot_id,
    previous_map_hash: preview.expected_head_map_hash,
    contract_version: CONTRACT_VERSION,
    snapshot_json: preview.snapshot_json,
    map_hash: preview.map_hash,
    denominator_hash: preview.denominator_hash,
    inventory_hash: preview.inventory_hash,
    inventory_generation: Number(preview.inventory_generation),
    population_state: preview.population_state,
    tax_year_start: Number(preview.tax_year_start),
    tax_year_end: Number(preview.tax_year_end),
    entity_count: Number(preview.entity_count),
    account_count: Number(preview.account_count),
    entity_year_count: Number(preview.entity_year_count),
    filing_unit_count: Number(preview.filing_unit_count),
    obligation_count: Number(preview.obligation_count),
    credential_ref: credentialRef,
    request_id: body.request_id,
    request_hash: requestHash,
    activated_at: now,
  };
  const snapshotSeal = await signer.hmac("snapshot-seal", snapshotSealInput(row));
  const oldSignCount = Number(credential.sign_count || 0);
  const isGenesis = row.sequence_no === 1;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO owner_financial_map_snapshots
         (snapshot_id, tenant_id, sequence_no, previous_snapshot_id, previous_map_hash,
          contract_version, snapshot_json, map_hash, denominator_hash, inventory_hash,
          inventory_generation, population_state, tax_year_start, tax_year_end,
          entity_count, account_count, entity_year_count, filing_unit_count,
          obligation_count, snapshot_seal, credential_ref,
          request_id, request_hash, activated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM owner_financial_map_inventory_state
           WHERE tenant_id = ? AND generation = ?
        )
          AND EXISTS (
            SELECT 1 FROM owner_passkeys
             WHERE credential_id = ? AND sign_count = ?
               AND grant_id IS NULL AND document_grant_id IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM auth_challenges
             WHERE challenge_hash = ? AND purpose = ? AND expires_at > ?
          )
          AND EXISTS (
            SELECT 1 FROM owner_financial_map_previews
             WHERE receipt_hash = ? AND state = 'previewed' AND expires_at > ?
               AND inventory_hash = ? AND inventory_generation = ?
               AND map_hash = ? AND denominator_hash = ?
          )
          AND ((? = 1 AND NOT EXISTS (
                  SELECT 1 FROM owner_financial_map_snapshots WHERE tenant_id = ?
                ))
            OR (? = 0 AND EXISTS (
                  SELECT 1 FROM owner_financial_map_snapshots h
                   WHERE h.tenant_id = ? AND h.snapshot_id = ? AND h.map_hash = ?
                     AND h.sequence_no = ?
                     AND NOT EXISTS (
                       SELECT 1 FROM owner_financial_map_snapshots n
                        WHERE n.tenant_id = h.tenant_id AND n.sequence_no > h.sequence_no
                     )
                )))`,
    ).bind(
      row.snapshot_id, row.tenant_id, row.sequence_no, row.previous_snapshot_id,
      row.previous_map_hash, row.contract_version, row.snapshot_json, row.map_hash,
      row.denominator_hash, row.inventory_hash, row.inventory_generation,
      row.population_state, row.tax_year_start, row.tax_year_end, row.entity_count,
      row.account_count, row.entity_year_count, row.filing_unit_count,
      row.obligation_count, snapshotSeal, row.credential_ref,
      row.request_id, row.request_hash, row.activated_at,
      TENANT_ID, row.inventory_generation, credential.credential_id, oldSignCount,
      challengeHash, purpose, now, preview.receipt_hash, now, row.inventory_hash,
      row.inventory_generation, row.map_hash, row.denominator_hash,
      isGenesis ? 1 : 0, TENANT_ID, isGenesis ? 1 : 0, TENANT_ID,
      row.previous_snapshot_id, row.previous_map_hash, row.sequence_no - 1,
    ),
    env.DB.prepare(
      `UPDATE owner_passkeys SET sign_count = ?, last_used_at = ?
        WHERE credential_id = ? AND sign_count = ?
          AND grant_id IS NULL AND document_grant_id IS NULL
          AND EXISTS (
            SELECT 1 FROM owner_financial_map_snapshots
             WHERE tenant_id = ? AND snapshot_id = ? AND request_id = ? AND request_hash = ?
          )`,
    ).bind(
      verdict.signCount, now, credential.credential_id, oldSignCount,
      TENANT_ID, row.snapshot_id, row.request_id, row.request_hash,
    ),
    env.DB.prepare(
      `DELETE FROM auth_challenges
        WHERE challenge_hash = ? AND purpose = ? AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM owner_financial_map_snapshots
             WHERE tenant_id = ? AND snapshot_id = ? AND request_id = ? AND request_hash = ?
          )`,
    ).bind(challengeHash, purpose, now, TENANT_ID, row.snapshot_id, row.request_id, row.request_hash),
    env.DB.prepare(
      `UPDATE owner_financial_map_previews
          SET state = 'activated', request_id = ?, request_hash = ?, activated_snapshot_id = ?, activated_at = ?
        WHERE receipt_hash = ? AND state = 'previewed'
          AND EXISTS (
            SELECT 1 FROM owner_financial_map_snapshots
             WHERE tenant_id = ? AND snapshot_id = ? AND request_id = ? AND request_hash = ?
          )`,
    ).bind(
      row.request_id, row.request_hash, row.snapshot_id, now, preview.receipt_hash,
      TENANT_ID, row.snapshot_id, row.request_id, row.request_hash,
    ),
  ]);
  if (!Array.isArray(results) || results.length !== 4 || results.some((result) => changed(result) !== 1)) {
    const current = await loadReviewPreview(env, body.review_id, signer);
    const recovered = current ? await activatedReplay(env, current, requestHash, body.request_id) : null;
    if (recovered) return recovered;
    conflict("owner_financial_map_activation_raced", "The map, inventory, passkey, or prior head changed. Review a fresh preview.");
  }
  return activationReceipt(row);
}

/**
 * Route handler.
 *
 * Admin tooling and MCP can read or create a preview, but receive no selector
 * and cannot begin activation. The private owner app discovers the one pending
 * review only after an exact unscoped owner session and companion app header.
 */
export async function handleOwnerFinancialMap(env, request, path, deps = {}) {
  if (request.method !== "POST") return respond({ error: "not found" }, 404);
  if (backendOf(env) !== D1 || !env.DB) return unavailable();
  const now = typeof deps.now === "number" ? deps.now : Date.now();
  try {
    if (path === OWNER_FINANCIAL_MAP_READ_PATH || path === OWNER_FINANCIAL_MAP_PREVIEW_PATH) {
      await readOrPreviewPrincipal(request, env);
      const signer = await signingContext(env);
      const body = await requestBody(request);
      const state = await captureCurrentState(env, signer);
      if (path === OWNER_FINANCIAL_MAP_READ_PATH) {
        if (!exactObject(body, [])) invalid("owner_financial_map_read_fields_invalid", "The read request takes no fields.");
        return respond(readStateBody(state));
      }
      return respond(await createPreview(env, body, state, signer, now));
    }
    if (path === OWNER_FINANCIAL_MAP_OPTIONS_PATH || path === OWNER_FINANCIAL_MAP_ACTIVATE_PATH) {
      return respond({
        error: "gone",
        code: "owner_financial_map_raw_preview_ref_retired",
        detail: "Raw preview references are not accepted. Review and confirm the map from Financial Map in the private owner app.",
      }, 410);
    }
    if (path === OWNER_FINANCIAL_MAP_REVIEW_PATH || path === OWNER_FINANCIAL_MAP_APP_OPTIONS_PATH ||
        path === OWNER_FINANCIAL_MAP_APP_ACTIVATE_PATH) {
      await requireExactOwner(request, env);
      const signer = await signingContext(env);
      const body = await requestBody(request);
      if (path === OWNER_FINANCIAL_MAP_REVIEW_PATH) {
        if (!exactObject(body, [])) {
          invalid("owner_financial_map_review_fields_invalid", "The owner review request takes no fields.");
        }
        return respond(await reviewPendingPreview(env, signer, now));
      }
      if (env.VECTOR_DRAIN_MODE === "paused-for-upgrade") {
        return respond({ error: "unavailable", code: "owner_writes_paused", paused: true }, 503);
      }
      if (path === OWNER_FINANCIAL_MAP_APP_OPTIONS_PATH) {
        return respond(await passkeyOptions(env, request, body, signer, now));
      }
      return respond(await activate(env, request, body, signer, now));
    }
    return respond({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof MapRequestError) {
      const label = error.status === 400 ? "invalid_request" : error.status === 401 ? "unauthorized"
        : error.status === 403 ? "forbidden" : error.status === 404 ? "not_found"
          : error.status === 409 ? "conflict" : error.status === 410 ? "gone" : "unavailable";
      return respond({ error: label, code: error.code, detail: error.message }, error.status);
    }
    return unavailable();
  }
}
