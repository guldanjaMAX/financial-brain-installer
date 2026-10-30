import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as brain from "../brain.mjs";

const migrationDirectory = new URL("../migrations/d1/", import.meta.url);
const migrations = readdirSync(migrationDirectory)
  .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
  .sort()
  .map((name) => {
    const sql = readFileSync(new URL(name, migrationDirectory), "utf8");
    return Object.freeze({
      version: Number(name.slice(0, 4)),
      name: name.slice(0, -4),
      checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
    });
  });

function fixtureManifest(schemaVersion = 48) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fix-update-ledger-")));
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { worker_name: "fixture-brain", version: "0.4.20" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        d1_database_id: "fixture-database",
        storage: "d1",
      },
    },
  }));
  const state = {
    client_slug: "fixture",
    product_version: "0.4.20",
    schema_version: schemaVersion,
  };
  return { root, manifestPath, state };
}

const appliedThrough = (version) => migrations
  .filter((migration) => migration.version <= version)
  .map((migration) => ({ ...migration, applied_at: "2026-10-01T00:00:00.000Z" }));

test("an unreadable migration ledger stops migrate before its first write", async (t) => {
  const fixture = fixtureManifest();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let ledgerReads = 0;
  let writes = 0;

  await assert.rejects(
    brain.cmdMigrate(fixture.manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/FROM schema_migrations/iu.test(sql)) {
          ledgerReads += 1;
          throw new Error("synthetic ledger transport interruption");
        }
        if (!/^\s*(SELECT|PRAGMA)\b/iu.test(sql)) writes += 1;
        throw new Error("migration continued after the ledger decision");
      },
    }),
    (error) => /migration ledger could not be read/iu.test(error?.message || "") &&
      /nothing was migrated/iu.test(error.message) && /run brain update again/iu.test(error.message),
  );
  assert.equal(ledgerReads, 1, "the real migrate path reached the ledger decision");
  assert.equal(writes, 0, "an unreadable ledger cannot be reinterpreted as empty");
});

test("only a missing schema_migrations table is accepted as an empty-ledger green control", async (t) => {
  const fixture = fixtureManifest();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  let ledgerReads = 0;
  let firstMigrationWrite = 0;

  await assert.rejects(
    brain.cmdMigrate(fixture.manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/FROM schema_migrations/iu.test(sql)) {
          ledgerReads += 1;
          throw new Error("no such table: schema_migrations");
        }
        if (/sqlite_master[\s\S]+install_state/iu.test(sql)) return { results: [] };
        if (/user_table_count/iu.test(sql)) return { results: [{ user_table_count: 0 }] };
        firstMigrationWrite += 1;
        throw new Error("fresh-ledger-control-reached-first-write");
      },
    }),
    /fresh-ledger-control-reached-first-write/u,
  );
  assert.equal(ledgerReads, 1, "the empty-ledger decision point was reached");
  assert.equal(firstMigrationWrite, 1, "the green control was admitted to migration work");
});

for (const [label, mutate, expected] of [
  [
    "an unknown ledger row",
    (rows) => [...rows, { version: 9999, name: "9999_unknown", checksum: "0".repeat(16) }],
    /unknown migration row/iu,
  ],
  [
    "a gap before a later ledger row",
    (rows) => rows.filter((row) => row.version !== 49),
    /gap[\s\S]*0049/iu,
  ],
  [
    "a ledger name that differs from the sealed file",
    (rows) => rows.map((row) => row.version === 48 ? { ...row, name: "0048_wrong_name" } : row),
    /name[\s\S]*0048/iu,
  ],
]) {
  test(`${label} is refused by migrate before writes`, async (t) => {
    const fixture = fixtureManifest(migrations.at(-1).version);
    t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
    const rows = mutate(appliedThrough(migrations.at(-1).version));
    let writes = 0;
    let decisions = 0;
    await assert.rejects(
      brain.cmdMigrate(fixture.manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => {
          if (/FROM schema_migrations/iu.test(sql)) {
            decisions += 1;
            return { results: rows };
          }
          writes += 1;
          throw new Error("unexpected write after invalid ledger");
        },
      }),
      expected,
    );
    assert.equal(decisions, 1, "the ledger validation decision point was reached");
    assert.equal(writes, 0, "the invalid ledger was refused before writes");
  });
}

test("update validates the complete ledger before bookmark or paused deployment", async (t) => {
  const fixture = fixtureManifest();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const rows = [...appliedThrough(48), {
    version: 9999,
    name: "9999_unknown",
    checksum: "0".repeat(16),
    applied_at: "2026-10-01T00:00:00.000Z",
  }];
  let ledgerReads = 0;
  let remoteMutations = 0;

  await assert.rejects(
    brain.cmdUpgrade(fixture.manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master[\s\S]+install_state/iu.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/iu.test(sql)) return { results: [fixture.state] };
        if (/FROM schema_migrations/iu.test(sql)) {
          ledgerReads += 1;
          return { results: rows };
        }
        throw new Error(`unexpected D1 query: ${sql}`);
      },
      cf: async () => { remoteMutations += 1; return { bookmark: "must-not-exist" }; },
      cmdDeploy: async () => { remoteMutations += 1; },
      cmdMigrate: async () => { remoteMutations += 1; },
    }),
    /unknown migration row/iu,
  );
  assert.equal(ledgerReads, 1, "the update path reached whole-ledger validation");
  assert.equal(remoteMutations, 0, "validation ran before bookmark and paused deployment");
});

test("schema 48 update prints its computed 0049-0057 pending set before remote work", async (t) => {
  const fixture = fixtureManifest();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const plans = [];
  let bookmarkReads = 0;
  await assert.rejects(
    brain.cmdUpgrade(fixture.manifestPath, {
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query: async (_account, _database, sql) => {
        if (/sqlite_master[\s\S]+install_state/iu.test(sql)) return { results: [{ name: "install_state" }] };
        if (/SELECT \* FROM install_state/iu.test(sql)) return { results: [fixture.state] };
        if (/FROM schema_migrations/iu.test(sql)) return { results: appliedThrough(48) };
        throw new Error(`unexpected D1 query: ${sql}`);
      },
      reportMigrationPlan: (line) => plans.push(line),
      cf: async () => {
        bookmarkReads += 1;
        throw new Error("stop-after-ledger-plan");
      },
    }),
    /restore bookmark could not be captured/iu,
  );
  assert.equal(bookmarkReads, 1, "the green control continued to bookmark capture");
  assert.deepEqual(plans, ["pending: 0049-0057 (9)"]);
});

test("repair diagnosis uses the shared ledger validator and retains applied_at", async () => {
  let sql = null;
  const diagnosis = await brain.diagnoseChecksumDrift("/fixture/brain.manifest.json", {
    loadManifest: () => ({ m: { infrastructure: { cloudflare: { d1_database_id: "fixture-database" } } } }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async (_account, _database, statement) => {
      sql = statement;
      return { results: [{
        version: 1,
        name: "0001_fixture",
        checksum: "old-checksum",
        applied_at: "2026-10-01T00:00:00.000Z",
      }] };
    },
    loadMigrations: () => [{
      version: 1,
      name: "0001_fixture",
      checksum: "new-checksum",
      sql: "SELECT 1;\n",
    }],
  });
  assert.match(sql, /applied_at/iu, "repair reads the ledger's recorded application time");
  assert.equal(diagnosis.checked, true);
  assert.equal(diagnosis.drift[0].appliedAt, "2026-10-01T00:00:00.000Z");

  const unknown = await brain.diagnoseChecksumDrift("/fixture/brain.manifest.json", {
    loadManifest: () => ({ m: { infrastructure: { cloudflare: { d1_database_id: "fixture-database" } } } }),
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async () => ({ results: [{
      version: 2,
      name: "0002_unknown",
      checksum: "unknown-checksum",
      applied_at: "2026-10-01T00:00:00.000Z",
    }] }),
    loadMigrations: () => [{
      version: 1,
      name: "0001_fixture",
      checksum: "known-checksum",
      sql: "SELECT 1;\n",
    }],
  });
  assert.equal(unknown.checked, false);
  assert.match(unknown.reason, /unknown migration row/iu);
});

test("status and update report an old-CLI schema regression with the repair command", async (t) => {
  assert.equal(typeof brain.cmdStatus, "function", "status exposes an injected real-path test seam");
  const fixture = fixtureManifest(48);
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const output = [];
  const warnings = [];
  const rows = appliedThrough(migrations.at(-1).version);
  await brain.cmdStatus(fixture.manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async (_account, _database, sql) => {
      if (/SELECT \* FROM install_state/iu.test(sql)) return { results: [fixture.state] };
      if (/FROM upgrade_runs/iu.test(sql)) return { results: [] };
      if (/FROM schema_migrations/iu.test(sql)) return { results: rows };
      throw new Error(`unexpected D1 query: ${sql}`);
    },
    write: (line) => output.push(line),
    warn: (line) => warnings.push(line),
  });
  assert.ok(output.length > 0, "status reached its reporting decision point");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /recorded schema 48[\s\S]*ledger maximum 57/iu);
  assert.match(warnings[0], /brain update/iu);

  const updateWarnings = [];
  let bookmarkReads = 0;
  await assert.rejects(brain.cmdUpgrade(fixture.manifestPath, {
    resolveAccount: async () => ({ id: "fixture-account" }),
    d1Query: async (_account, _database, sql) => {
      if (/sqlite_master[\s\S]+install_state/iu.test(sql)) return { results: [{ name: "install_state" }] };
      if (/SELECT \* FROM install_state/iu.test(sql)) return { results: [fixture.state] };
      if (/FROM schema_migrations/iu.test(sql)) return { results: rows };
      throw new Error(`unexpected D1 query: ${sql}`);
    },
    warn: (line) => updateWarnings.push(line),
    cf: async () => { bookmarkReads += 1; throw new Error("stop-after-schema-regression-warning"); },
  }), /restore bookmark could not be captured/iu);
  assert.equal(bookmarkReads, 1, "update continued into its safe repair path");
  assert.equal(updateWarnings.length, 1, "update reached the schema regression decision point");
  assert.match(updateWarnings[0], /recorded schema 48[\s\S]*ledger maximum 57/iu);
  assert.match(updateWarnings[0], /brain update/iu);
});

test("the owner runbook never routes a repair through direct migrate", () => {
  const runbook = readFileSync(new URL("../onboarding/06-runbook-top-ten-failures.md", import.meta.url), "utf8");
  assert.doesNotMatch(runbook, /node brain\.mjs migrate/iu);
  assert.match(runbook, /brain update <manifest>/iu);
  assert.match(runbook, /recorded applied time[\s\S]*older ledger rows[\s\S]*unknown/iu);
});
