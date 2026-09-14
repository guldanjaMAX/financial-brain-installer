import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

import {
  MIGRATION_CONTRACT_SQL,
  RECOVERY_DURABLE_TABLES,
} from "../operations/cloudflare-recovery-adapter.mjs";
import {
  V048_D1_DELETION_STATE_FTS_COUNT_SQL,
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  V048_D1_DELETION_STATE_INVENTORY_SQL,
  V048_D1_DELETION_STATE_SCHEMA_SQL,
  V048_D1_DELETION_STATE_SEQUENCE_SQL,
  fingerprintV048D1DeletionState,
} from "../operations/v048-d1-deletion-state-contract.mjs";
import {
  V048_D1_DELETION_QUICK_CHECK_SQL,
  V048_TEARDOWN_D1_CONTENT_MAX_BYTES,
  V048_TEARDOWN_D1_EXPORT_NAME,
  V048_TEARDOWN_D1_TEMPORARY_PREFIX,
  V048_TEARDOWN_D1_WRANGLER_OUTPUT_MAX_BYTES,
  V048TeardownD1ContentProofError,
  captureV048TeardownD1ContentFingerprint,
  captureV048TeardownD1DeletionStateFingerprint,
} from "../operations/v048-teardown-d1-content-proof.mjs";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/d1/", import.meta.url));
const ACCOUNT_ID = "a".repeat(32);
const SOURCE_DATABASE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_DATABASE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SOURCE_DATABASE_NAME = "brain-test-v048-field-source-recovery-gate-a48f1101";
const TARGET_DATABASE_NAME = "brain-test-v048-field-target-recovery-gate-a48f1101";
const RAW_PRIVATE_MARKER = "synthetic-private-auth-row-must-never-return";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function migrationRows() {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((name) => /^\d+_.*\.sql$/u.test(name))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(MIGRATIONS_DIRECTORY, name), "utf8");
      return Object.freeze({
        version: Number(name.split("_")[0]),
        name: name.replace(/\.sql$/u, ""),
        checksum: sha256(sql).slice(0, 16),
      });
    });
}

const migrations = migrationRows();
const database = new DatabaseSync(":memory:");
for (const migration of migrations) {
  database.exec(readFileSync(join(MIGRATIONS_DIRECTORY, `${migration.name}.sql`), "utf8"));
}
database.prepare(
  `INSERT INTO install_state
     (id,client_slug,product_version,schema_version,gate_version,installed_at,ring)
   VALUES (1,'v048-field-proof','0.4.8',46,4,'2026-09-12T00:00:00.000Z','stable')`,
).run();
const insertMigration = database.prepare(
  `INSERT INTO schema_migrations (version,name,applied_at,checksum)
   VALUES (?,?,'2026-09-12T00:00:00.000Z',?)`,
);
for (const migration of migrations) {
  insertMigration.run(migration.version, migration.name, migration.checksum);
}
database.prepare(
  "INSERT INTO upgrade_runs (started_at,status) VALUES ('2026-09-12T00:00:00.000Z','verified')",
).run();
// The disposable campaign's accepted full-state snapshot has exactly the two
// AUTOINCREMENT high-water rows produced by seeded chunks and LLM calls.
database.exec(
  "DELETE FROM sqlite_sequence;" +
  "INSERT INTO sqlite_sequence(name,seq) VALUES('chunks',3201),('llm_call_log',3);",
);
after(() => database.close());

const BASE_EXPORT = Buffer.from(
  `INSERT INTO "auth_challenges" VALUES('${RAW_PRIVATE_MARKER}');\n` +
  "INSERT INTO \"vector_outbox\" VALUES('synthetic-derived-queue-row');\n" +
  "INSERT INTO \"chunks_fts_data\" VALUES(1,X'010203');\n",
  "utf8",
);

function binding(role = "source") {
  return Object.freeze({
    role,
    accountId: ACCOUNT_ID,
    databaseId: role === "source" ? SOURCE_DATABASE_ID : TARGET_DATABASE_ID,
    databaseName: role === "source" ? SOURCE_DATABASE_NAME : TARGET_DATABASE_NAME,
  });
}

function rowsForSql(sql) {
  return database.prepare(sql).all().map((row) => ({ ...row }));
}

function makeRunner({
  selectedBinding = binding(),
  exportBytes = BASE_EXPORT,
  transformRows = (_sql, rows) => rows,
  onExport = () => {},
  firstOutput = null,
} = {}) {
  const calls = [];
  const returnedOutputs = [];
  const temporaryDirectories = [];
  let callCount = 0;
  const runWrangler = async (args) => {
    assert.equal(Object.isFrozen(args), true);
    calls.push([...args]);
    callCount++;
    if (firstOutput !== null && callCount === 1) return firstOutput;
    if (args[0] === "d1" && args[1] === "execute") {
      assert.deepEqual(args.slice(0, 5), [
        "d1", "execute", selectedBinding.databaseId, "--remote", "--command",
      ]);
      assert.equal(args.length, 7);
      assert.equal(args[6], "--json");
      const rows = transformRows(args[5], rowsForSql(args[5]));
      const output = Buffer.from(JSON.stringify([{ success: true, results: rows }]), "utf8");
      returnedOutputs.push({ output, snapshot: Buffer.from(output) });
      return output;
    }
    assert.equal(args[0], "d1");
    assert.equal(args[1], "export");
    assert.equal(args[2], selectedBinding.databaseId);
    assert.deepEqual(args.slice(3, 6), ["--remote", "--no-schema", "--output"]);
    const outputPath = args[6];
    temporaryDirectories.push(dirname(outputPath));
    assert.equal(basename(outputPath), V048_TEARDOWN_D1_EXPORT_NAME);
    assert.equal(basename(dirname(outputPath)).startsWith(V048_TEARDOWN_D1_TEMPORARY_PREFIX), true);
    assert.equal(dirname(dirname(outputPath)), resolve(tmpdir()));
    const initial = lstatSync(outputPath);
    assert.equal(initial.isFile(), true);
    assert.equal(initial.isSymbolicLink(), false);
    assert.equal(initial.nlink, 1);
    assert.equal(initial.size, 0);
    if (process.platform !== "win32") assert.equal(initial.mode & 0o777, 0o600);
    writeFileSync(outputPath, exportBytes);
    await onExport({ args, outputPath });
    const output = Buffer.from("synthetic bounded wrapper stdout\n", "utf8");
    returnedOutputs.push({ output, snapshot: Buffer.from(output) });
    return output;
  };
  return Object.freeze({ calls, returnedOutputs, temporaryDirectories, runWrangler });
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof V048TeardownD1ContentProofError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

function expectedFingerprint(selectedBinding, exportBytes, transformRows = (_sql, rows) => rows) {
  const inventory = transformRows(
    V048_D1_DELETION_STATE_INVENTORY_SQL,
    rowsForSql(V048_D1_DELETION_STATE_INVENTORY_SQL),
  ).map((row) => row.name);
  const schemaRows = transformRows(
    V048_D1_DELETION_STATE_SCHEMA_SQL,
    rowsForSql(V048_D1_DELETION_STATE_SCHEMA_SQL),
  );
  const sequenceRows = transformRows(
    V048_D1_DELETION_STATE_SEQUENCE_SQL,
    rowsForSql(V048_D1_DELETION_STATE_SEQUENCE_SQL),
  );
  const ftsRows = transformRows(
    V048_D1_DELETION_STATE_FTS_COUNT_SQL,
    rowsForSql(V048_D1_DELETION_STATE_FTS_COUNT_SQL),
  );
  return fingerprintV048D1DeletionState({
    role: selectedBinding.role,
    binding: {
      account_id: selectedBinding.accountId,
      database_id: selectedBinding.databaseId,
      database_name: selectedBinding.databaseName,
    },
    migrations,
    quickCheck: "ok",
    inventory,
    schemaRows,
    durableExportSha256: sha256(exportBytes),
    durableExportBytes: exportBytes.length,
    sequenceRows,
    ftsCount: Number(ftsRows[0].fts_count),
  });
}

test("full deletion capture uses exact UUID argv, inventory, shadows, and pure fingerprint contract", async () => {
  const selected = binding("source");
  const runner = makeRunner({ selectedBinding: selected });
  const result = await captureV048TeardownD1DeletionStateFingerprint({
    binding: selected,
    runWrangler: runner.runWrangler,
  });
  assert.equal(result, expectedFingerprint(selected, BASE_EXPORT));
  assert.match(result, /^[a-f0-9]{64}$/u);
  assert.equal(result.includes(RAW_PRIVATE_MARKER), false);
  assert.equal(captureV048TeardownD1ContentFingerprint,
    captureV048TeardownD1DeletionStateFingerprint);

  const executeCalls = runner.calls.filter((args) => args[1] === "execute");
  assert.equal(executeCalls.length, 6);
  assert.deepEqual(executeCalls.map((args) => args[5]), [
    MIGRATION_CONTRACT_SQL,
    V048_D1_DELETION_QUICK_CHECK_SQL,
    V048_D1_DELETION_STATE_INVENTORY_SQL,
    V048_D1_DELETION_STATE_SCHEMA_SQL,
    V048_D1_DELETION_STATE_SEQUENCE_SQL,
    V048_D1_DELETION_STATE_FTS_COUNT_SQL,
  ]);
  assert.equal(runner.calls.every((args) => args[2] === SOURCE_DATABASE_ID), true);
  assert.equal(runner.calls.some((args) => args.includes(SOURCE_DATABASE_NAME)), false);

  const exportCall = runner.calls.find((args) => args[1] === "export");
  const exportedTables = [];
  for (let index = 7; index < exportCall.length; index += 2) {
    assert.equal(exportCall[index], "--table");
    exportedTables.push(exportCall[index + 1]);
  }
  assert.deepEqual(exportedTables, [
    ...RECOVERY_DURABLE_TABLES,
    ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  ]);
  assert.equal(exportedTables.includes("chunks_fts"), false);
  assert.deepEqual(
    rowsForSql(V048_D1_DELETION_STATE_INVENTORY_SQL).map((row) => row.name),
    [...RECOVERY_DURABLE_TABLES, "chunks_fts", ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES].sort(),
  );
  for (const { output, snapshot } of runner.returnedOutputs) {
    assert.deepEqual(output, snapshot, "caller-owned wrapper output must not be wiped or mutated");
  }
  assert.equal(runner.temporaryDirectories.every((path) => !existsSync(path)), true);
});

test("role and exact D1 binding are part of the deletion fingerprint", async () => {
  const source = binding("source");
  const target = binding("target");
  const sourceRunner = makeRunner({ selectedBinding: source });
  const targetRunner = makeRunner({ selectedBinding: target });
  const sourceHash = await captureV048TeardownD1DeletionStateFingerprint({
    binding: source,
    runWrangler: sourceRunner.runWrangler,
  });
  const targetHash = await captureV048TeardownD1DeletionStateFingerprint({
    binding: target,
    runWrangler: targetRunner.runWrangler,
  });
  assert.notEqual(sourceHash, targetHash);
  assert.equal(targetRunner.calls.every((args) => args[2] === TARGET_DATABASE_ID), true);
  assert.equal(targetRunner.calls.some((args) => args.includes(TARGET_DATABASE_NAME)), false);
});

test("raw auth, queue, and FTS-shadow bytes all change the full deletion fingerprint", async () => {
  const selected = binding("source");
  const variants = [
    BASE_EXPORT,
    Buffer.from(`${BASE_EXPORT.toString("utf8")}-- changed auth row\n`, "utf8"),
    Buffer.from(`${BASE_EXPORT.toString("utf8")}-- changed queue row\n`, "utf8"),
    Buffer.from(`${BASE_EXPORT.toString("utf8")}-- changed chunks_fts_data row\n`, "utf8"),
  ];
  const hashes = [];
  for (const exportBytes of variants) {
    const runner = makeRunner({ selectedBinding: selected, exportBytes });
    hashes.push(await captureV048TeardownD1DeletionStateFingerprint({
      binding: selected,
      runWrangler: runner.runWrangler,
    }));
    assert.equal(runner.temporaryDirectories.every((path) => !existsSync(path)), true);
  }
  assert.equal(new Set(hashes).size, variants.length);
  assert.equal(hashes.some((hash) => hash.includes(RAW_PRIVATE_MARKER)), false);
});

test("logical schema, sqlite_sequence, and FTS-count drift independently change the hash", async (t) => {
  const selected = binding("source");
  const baselineRunner = makeRunner({ selectedBinding: selected });
  const baseline = await captureV048TeardownD1DeletionStateFingerprint({
    binding: selected,
    runWrangler: baselineRunner.runWrangler,
  });
  const cases = [
    ["schema", (sql, rows) => sql === V048_D1_DELETION_STATE_SCHEMA_SQL
      ? rows.map((row, index) => index === 0 ? { ...row, sql: `${row.sql ?? ""}\n-- drift` } : row)
      : rows],
    ["sequence", (sql, rows) => sql === V048_D1_DELETION_STATE_SEQUENCE_SQL
      ? rows.map((row, index) => index === 0
        ? { ...row, seq: Number(row.seq) + 1, seq_quote: String(Number(row.seq) + 1) }
        : row)
      : rows],
    ["sequence storage type", (sql, rows) => sql === V048_D1_DELETION_STATE_SEQUENCE_SQL
      ? rows.map((row, index) => index === 0
        ? { ...row, seq: String(row.seq), seq_type: "text", seq_quote: `'${row.seq}'` }
        : row)
      : rows],
    ["FTS count", (sql, rows) => sql === V048_D1_DELETION_STATE_FTS_COUNT_SQL
      ? [{ fts_count: Number(rows[0].fts_count) + 1 }]
      : rows],
  ];
  for (const [name, transformRows] of cases) {
    await t.test(name, async () => {
      const runner = makeRunner({ selectedBinding: selected, transformRows });
      const changed = await captureV048TeardownD1DeletionStateFingerprint({
        binding: selected,
        runWrangler: runner.runWrangler,
      });
      assert.notEqual(changed, baseline);
      assert.equal(changed, expectedFingerprint(selected, BASE_EXPORT, transformRows));
    });
  }
});

test("teardown capture rejects unknown and existing-table sqlite_sequence decoys", async (t) => {
  const selected = binding("source");
  for (const decoy of ["ghost", "auth_challenges"]) {
    await t.test(decoy, async () => {
      const runner = makeRunner({
        selectedBinding: selected,
        transformRows: (sql, rows) => sql === V048_D1_DELETION_STATE_SEQUENCE_SQL
          ? rows.map((row) => row.name === "llm_call_log"
            ? { ...row, name: decoy, name_quote: `'${decoy}'` }
            : row).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
          : rows,
      });
      await expectCode(
        captureV048TeardownD1DeletionStateFingerprint({
          binding: selected,
          runWrangler: runner.runWrangler,
        }),
        "V048_TEARDOWN_D1_SEQUENCE_INVALID",
      );
    });
  }
});

test("replacement, symlink, hardlink, mode, oversize, and directory races fail closed and clean up", async (t) => {
  const selected = binding("source");
  const attackRoot = mkdtempSync(join(tmpdir(), "v048-d1-proof-attacks-"));
  if (process.platform !== "win32") chmodSync(attackRoot, 0o700);
  try {
    const externalTarget = join(attackRoot, "external-target.sql");
    writeFileSync(externalTarget, "external target must remain\n", { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(externalTarget, 0o600);
    const cases = [
      ["replaced inode", "V048_TEARDOWN_D1_EXPORT_UNSAFE", ({ outputPath }) => {
        unlinkSync(outputPath);
        writeFileSync(outputPath, BASE_EXPORT, { mode: 0o600 });
        if (process.platform !== "win32") chmodSync(outputPath, 0o600);
      }],
      ...(process.platform === "win32" ? [] : [
        ["symlink", "V048_TEARDOWN_D1_EXPORT_UNSAFE", ({ outputPath }) => {
          unlinkSync(outputPath);
          symlinkSync(externalTarget, outputPath);
        }],
        ["hardlink", "V048_TEARDOWN_D1_EXPORT_UNSAFE", ({ outputPath }) => {
          linkSync(outputPath, join(attackRoot, "surviving-hardlink.sql"));
        }],
        ["unsafe mode", "V048_TEARDOWN_D1_EXPORT_UNSAFE", ({ outputPath }) => {
          chmodSync(outputPath, 0o640);
        }],
      ]),
      ["directory replacement", "V048_TEARDOWN_D1_EXPORT_UNSAFE", ({ outputPath }) => {
        unlinkSync(outputPath);
        mkdirSync(outputPath, { mode: 0o700 });
      }],
      ["oversize", "V048_TEARDOWN_D1_EXPORT_TOO_LARGE", ({ outputPath }) => {
        truncateSync(outputPath, V048_TEARDOWN_D1_CONTENT_MAX_BYTES + 1);
      }],
      ["extra directory entry", "V048_TEARDOWN_D1_TEMPORARY_DIRECTORY_CHANGED", ({ outputPath }) => {
        writeFileSync(join(dirname(outputPath), "unexpected"), "x", { mode: 0o600 });
      }],
    ];
    for (const [name, code, onExport] of cases) {
      await t.test(name, async () => {
        const runner = makeRunner({ selectedBinding: selected, onExport });
        await expectCode(
          captureV048TeardownD1DeletionStateFingerprint({
            binding: selected,
            runWrangler: runner.runWrangler,
          }),
          code,
        );
        assert.equal(runner.temporaryDirectories.every((path) => !existsSync(path)), true);
      });
    }
    assert.equal(readFileSync(externalTarget, "utf8"), "external target must remain\n");
  } finally {
    rmSync(attackRoot, { recursive: true, force: true });
  }
});

test("malformed, oversized, non-Buffer, and thrown wrapper outputs are fixed-code refusals", async (t) => {
  const selected = binding("source");
  const before = new Set(readdirSync(tmpdir()).filter((name) =>
    name.startsWith(V048_TEARDOWN_D1_TEMPORARY_PREFIX)));
  const cases = [
    ["malformed JSON", Buffer.from("not-json", "utf8"), "V048_TEARDOWN_D1_RESPONSE_INVALID"],
    ["oversized stdout", Buffer.alloc(V048_TEARDOWN_D1_WRANGLER_OUTPUT_MAX_BYTES + 1),
      "V048_TEARDOWN_D1_WRANGLER_OUTPUT_INVALID"],
    ["non-Buffer stdout", "{}", "V048_TEARDOWN_D1_WRANGLER_OUTPUT_INVALID"],
  ];
  for (const [name, firstOutput, code] of cases) {
    await t.test(name, async () => {
      const runner = makeRunner({ selectedBinding: selected, firstOutput });
      await expectCode(
        captureV048TeardownD1DeletionStateFingerprint({
          binding: selected,
          runWrangler: runner.runWrangler,
        }),
        code,
      );
    });
  }
  await t.test("wrapper throws", async () => {
    await expectCode(
      captureV048TeardownD1DeletionStateFingerprint({
        binding: selected,
        runWrangler: async () => { throw new Error("raw provider detail must not escape"); },
      }),
      "V048_TEARDOWN_D1_WRANGLER_CALL_FAILED",
    );
  });
  const afterNames = readdirSync(tmpdir()).filter((name) =>
    name.startsWith(V048_TEARDOWN_D1_TEMPORARY_PREFIX));
  assert.deepEqual(afterNames.filter((name) => !before.has(name)), []);
});

test("wrong role, name, account, UUID, or dependency is refused before Wrangler", async () => {
  const cases = [
    { ...binding(), role: "observer" },
    { ...binding(), databaseName: "../replacement" },
    { ...binding(), accountId: "a".repeat(31) },
    { ...binding(), databaseId: SOURCE_DATABASE_NAME },
  ];
  for (const invalid of cases) {
    let calls = 0;
    await expectCode(
      captureV048TeardownD1DeletionStateFingerprint({
        binding: invalid,
        runWrangler: async () => { calls++; return Buffer.from("{}"); },
      }),
      "V048_TEARDOWN_D1_CAPTURE_INPUT_INVALID",
    );
    assert.equal(calls, 0);
  }
  await expectCode(
    captureV048TeardownD1DeletionStateFingerprint({ binding: binding() }),
    "V048_TEARDOWN_D1_CAPTURE_INPUT_INVALID",
  );
});

console.log("v0.4.8 teardown D1 deletion-state proof: exact UUID, full durable and FTS-shadow state, private temp-file safety, and fixed refusals verified");
