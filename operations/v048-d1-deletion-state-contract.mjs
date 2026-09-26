import { createHash } from "node:crypto";

export const V048_D1_DELETION_STATE_SCHEMA_VERSION = 1;
export const V048_D1_DELETION_STATE_KIND = "v048_d1_deletion_state_v1";
export const V048_D1_DELETION_STATE_MAX_EXPORT_BYTES = 64 * 1024 * 1024;
export const V048_D1_DELETION_STATE_FTS_SHADOW_TABLES = Object.freeze([
  "chunks_fts_data",
  "chunks_fts_idx",
  "chunks_fts_docsize",
  "chunks_fts_config",
]);
export const V048_D1_DELETION_STATE_SEQUENCE_TABLES = Object.freeze([
  "chunks",
  "llm_call_log",
]);

export const V048_D1_DELETION_STATE_INVENTORY_SQL =
  "SELECT name FROM sqlite_schema WHERE type='table' " +
  "AND name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "ORDER BY name COLLATE BINARY";

export const V048_D1_DELETION_STATE_SCHEMA_SQL =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema " +
  "WHERE name NOT LIKE 'sqlite_%' AND name <> '_cf_KV' " +
  "ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY";

export const V048_D1_DELETION_STATE_SEQUENCE_SQL =
  "SELECT name,typeof(name) AS name_type,quote(name) AS name_quote," +
  "seq,typeof(seq) AS seq_type,quote(seq) AS seq_quote " +
  "FROM sqlite_sequence ORDER BY name COLLATE BINARY";

export const V048_D1_DELETION_STATE_FTS_COUNT_SQL =
  "SELECT COUNT(*) AS fts_count FROM chunks_fts";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

function fail() {
  throw new Error("V048_D1_DELETION_STATE_INVALID");
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    fail();
  }
  return value;
}

function exactString(value, { allowControls = false, maximum = 256 * 1024 } = {}) {
  if (typeof value !== "string" || !value || value.length > maximum ||
      value.includes("\0") || (!allowControls && CONTROL_RE.test(value))) {
    fail();
  }
  return value;
}

function nonNegativeInteger(value) {
  const normalized = typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(normalized) || normalized < 0) fail();
  return normalized;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function binaryCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedMigrations(rows) {
  if (!Array.isArray(rows) || rows.length !== 48) fail();
  const normalized = rows.map((row) => {
    exactKeys(row, ["version", "name", "checksum"]);
    return Object.freeze({
      version: nonNegativeInteger(row.version),
      name: exactString(row.name),
      checksum: exactString(row.checksum),
    });
  });
  if (normalized.some((row, index) => row.version !== index + 1)) fail();
  return Object.freeze(normalized);
}

function normalizedInventory(rows) {
  if (!Array.isArray(rows) || rows.length < 1) fail();
  const normalized = rows.map((name) => exactString(name));
  const ordered = [...normalized].sort(binaryCompare);
  if (canonical(normalized) !== canonical(ordered) || new Set(normalized).size !== normalized.length ||
      !normalized.includes("chunks_fts") ||
      V048_D1_DELETION_STATE_FTS_SHADOW_TABLES.some((name) => !normalized.includes(name))) {
    fail();
  }
  return Object.freeze(normalized);
}

function normalizedSchema(rows) {
  if (!Array.isArray(rows) || rows.length < 1) fail();
  const normalized = rows.map((row) => {
    exactKeys(row, ["type", "name", "tbl_name", "sql"]);
    const sql = row.sql === null
      ? null
      : exactString(row.sql, { allowControls: true });
    return Object.freeze({
      type: exactString(row.type),
      name: exactString(row.name),
      tbl_name: exactString(row.tbl_name),
      sql,
    });
  });
  const ordered = [...normalized].sort((left, right) =>
    binaryCompare(left.type, right.type) || binaryCompare(left.name, right.name) ||
      binaryCompare(left.tbl_name, right.tbl_name));
  if (canonical(normalized) !== canonical(ordered)) fail();
  return Object.freeze(normalized);
}

export function normalizeV048D1DeletionStateSequences(rows, inventory) {
  const allowedNames = normalizedInventory(inventory);
  const allowedNameSet = new Set(allowedNames);
  if (!Array.isArray(rows) || rows.length !==
      V048_D1_DELETION_STATE_SEQUENCE_TABLES.length ||
      V048_D1_DELETION_STATE_SEQUENCE_TABLES.some((name) => !allowedNameSet.has(name))) {
    fail();
  }
  const normalized = rows.map((row) => {
    exactKeys(row, ["name", "name_type", "name_quote", "seq", "seq_type", "seq_quote"]);
    const name = exactString(row.name);
    const nameType = exactString(row.name_type);
    const nameQuote = exactString(row.name_quote, { allowControls: true });
    const seqType = exactString(row.seq_type);
    const seqQuote = exactString(row.seq_quote, { allowControls: true });
    if (nameType !== "text" || nameQuote !== `'${name.replaceAll("'", "''")}'` ||
        !new Set(["integer", "real", "text", "null"]).has(seqType)) {
      fail();
    }
    if ((seqType === "integer" && (!Number.isSafeInteger(row.seq) || row.seq < 0 ||
          seqQuote !== String(row.seq))) ||
        (seqType === "real" && (typeof row.seq !== "number" || !Number.isFinite(row.seq))) ||
        (seqType === "text" && typeof row.seq !== "string") ||
        (seqType === "null" && (row.seq !== null || seqQuote !== "NULL"))) {
      fail();
    }
    return Object.freeze({
      name,
      name_type: nameType,
      name_quote: nameQuote,
      seq: row.seq,
      seq_type: seqType,
      seq_quote: seqQuote,
    });
  });
  const ordered = [...normalized].sort((left, right) => binaryCompare(left.name, right.name));
  if (canonical(normalized) !== canonical(ordered) ||
      new Set(normalized.map((row) => row.name)).size !== normalized.length ||
      canonical(normalized.map((row) => row.name)) !==
        canonical(V048_D1_DELETION_STATE_SEQUENCE_TABLES)) {
    fail();
  }
  return Object.freeze(normalized);
}

/**
 * Produce the privacy-safe deletion identity for one complete schema-48 D1.
 * Raw schema, sequence, and table-export material is consumed only to derive
 * hashes; callers persist only the returned SHA-256.
 */
export function fingerprintV048D1DeletionState({
  role,
  binding,
  migrations,
  quickCheck,
  inventory,
  schemaRows,
  durableExportSha256,
  durableExportBytes,
  sequenceRows,
  ftsCount,
} = {}) {
  if (!new Set(["source", "target"]).has(role)) fail();
  exactKeys(binding, ["account_id", "database_id", "database_name"]);
  const normalizedBinding = Object.freeze({
    role,
    account_id: exactString(binding.account_id),
    database_id: exactString(binding.database_id),
    database_name: exactString(binding.database_name),
  });
  const normalizedMigrationRows = normalizedMigrations(migrations);
  const normalizedInventoryRows = normalizedInventory(inventory);
  const normalizedSchemaRows = normalizedSchema(schemaRows);
  const normalizedSequenceRows = normalizeV048D1DeletionStateSequences(
    sequenceRows,
    normalizedInventoryRows,
  );
  if (quickCheck !== "ok" || !SHA256_RE.test(durableExportSha256 || "")) fail();
  const normalizedExportBytes = nonNegativeInteger(durableExportBytes);
  if (normalizedExportBytes < 1 ||
      normalizedExportBytes > V048_D1_DELETION_STATE_MAX_EXPORT_BYTES) {
    fail();
  }
  const components = Object.freeze({
    schema_version: V048_D1_DELETION_STATE_SCHEMA_VERSION,
    kind: V048_D1_DELETION_STATE_KIND,
    binding_sha256: sha256(canonical(normalizedBinding)),
    migrations_sha256: sha256(canonical(normalizedMigrationRows)),
    quick_check: quickCheck,
    inventory_sha256: sha256(canonical(normalizedInventoryRows)),
    schema_sha256: sha256(canonical(normalizedSchemaRows)),
    durable_export_sha256: durableExportSha256,
    durable_export_bytes: normalizedExportBytes,
    sqlite_sequence_sha256: sha256(canonical(normalizedSequenceRows)),
    fts_count: nonNegativeInteger(ftsCount),
  });
  return sha256(canonical(components));
}
