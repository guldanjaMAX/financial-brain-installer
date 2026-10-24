const LEDGER_SELECT =
  "SELECT version, checksum, name, applied_at FROM schema_migrations ORDER BY version";

export class MigrationLedgerReadError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "MigrationLedgerReadError";
  }
}

export class MigrationLedgerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationLedgerValidationError";
  }
}

function fourDigits(version) {
  return String(version).padStart(4, "0");
}

function sealedMigrationMap(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new MigrationLedgerValidationError("the sealed migration inventory is empty");
  }
  const byVersion = new Map();
  let prior = null;
  for (const migration of migrations) {
    const version = Number(migration?.version);
    if (!Number.isSafeInteger(version) || version <= 0 ||
        typeof migration?.name !== "string" || !migration.name ||
        typeof migration?.checksum !== "string" || !migration.checksum) {
      throw new MigrationLedgerValidationError("the sealed migration inventory is malformed");
    }
    if (byVersion.has(version)) {
      throw new MigrationLedgerValidationError(`the sealed migration inventory repeats ${fourDigits(version)}`);
    }
    if (prior !== null && version !== prior + 1) {
      throw new MigrationLedgerValidationError(
        `the sealed migration inventory has a gap at ${fourDigits(prior + 1)}`,
      );
    }
    byVersion.set(version, migration);
    prior = version;
  }
  return byVersion;
}

/**
 * Prove that the durable ledger is an exact prefix of the sealed files.
 * Checksum drift is returned rather than thrown so repair can describe it;
 * every structural ambiguity fails closed for update, migrate, and repair.
 */
export function validateMigrationLedger(migrations, rows) {
  const sealed = sealedMigrationMap(migrations);
  if (!Array.isArray(rows)) {
    throw new MigrationLedgerValidationError("the migration ledger response is malformed");
  }

  const applied = [];
  const seen = new Set();
  for (const row of rows) {
    const version = Number(row?.version);
    if (!Number.isSafeInteger(version) || version <= 0 ||
        typeof row?.name !== "string" || typeof row?.checksum !== "string") {
      throw new MigrationLedgerValidationError("the migration ledger contains a malformed row");
    }
    if (seen.has(version)) {
      throw new MigrationLedgerValidationError(`the migration ledger repeats row ${fourDigits(version)}`);
    }
    const migration = sealed.get(version);
    if (!migration) {
      throw new MigrationLedgerValidationError(
        `the migration ledger contains unknown migration row ${fourDigits(version)}`,
      );
    }
    if (row.name !== migration.name) {
      throw new MigrationLedgerValidationError(
        `the migration ledger name for ${fourDigits(version)} does not match the sealed file ${migration.name}`,
      );
    }
    seen.add(version);
    applied.push(row);
  }

  applied.sort((left, right) => Number(left.version) - Number(right.version));
  for (let index = 0; index < applied.length; index += 1) {
    const expected = migrations[index]?.version;
    if (Number(applied[index].version) !== Number(expected)) {
      throw new MigrationLedgerValidationError(
        `the migration ledger has a gap at ${fourDigits(expected)}`,
      );
    }
  }

  const checksumMismatches = applied.flatMap((row) => {
    const migration = sealed.get(Number(row.version));
    return row.checksum === migration.checksum ? [] : [{ migration, row }];
  });
  const pending = migrations.filter((migration) => !seen.has(Number(migration.version)));
  return Object.freeze({
    applied: Object.freeze(applied),
    pending: Object.freeze(pending),
    checksumMismatches: Object.freeze(checksumMismatches),
    maxAppliedVersion: applied.length ? Number(applied.at(-1).version) : 0,
    maxLocalVersion: Math.max(...migrations.map((migration) => Number(migration.version))),
  });
}

export async function readMigrationLedger({ accountId, databaseId, query, migrations }) {
  let response;
  try {
    response = await query(accountId, databaseId, LEDGER_SELECT);
  } catch (error) {
    if (/no such table:\s*schema_migrations/iu.test(String(error?.message || error))) {
      return validateMigrationLedger(migrations, []);
    }
    throw new MigrationLedgerReadError("the migration ledger could not be read", { cause: error });
  }
  if (!response || !Array.isArray(response.results)) {
    throw new MigrationLedgerReadError("the migration ledger returned an unreadable response");
  }
  return validateMigrationLedger(migrations, response.results);
}

export function formatPendingMigrations(pending) {
  if (!Array.isArray(pending) || pending.length === 0) return "pending: none (0)";
  const versions = pending.map((migration) => Number(migration.version));
  const first = fourDigits(versions[0]);
  const last = fourDigits(versions.at(-1));
  return `pending: ${first}${first === last ? "" : `-${last}`} (${versions.length})`;
}
