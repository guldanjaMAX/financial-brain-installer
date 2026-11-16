import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { recoveryDataStatements, recoveryInsertCoverage } from "../operations/recovery-sql-parts.mjs";
import { verifyRecoverySqlArtifact } from "../operations/cloudflare-recovery-adapter.mjs";

const digest = (text) => createHash("sha256").update(text).digest("hex");
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "recovery-sql-units-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("data splitter preserves multiline UTF-8, comments, tuples and block-edge doubled quotes", async (t) => {
  const directory = fixture(t), path = join(directory, "dump.sql");
  for (const offset of [0, 1, 2, 3]) {
    const prefix = "-- " + "x".repeat(65520 + offset) + "\n";
    const sql = prefix + "INSERT INTO \"documents\" VALUES (1,'multi;\n雪 ''quote'''),(2,'body');\n";
    writeFileSync(path, sql, { mode: 0o600 });
    const units = [];
    for await (const part of recoveryDataStatements(path, 100_000)) units.push(part);
    assert.equal(Buffer.concat(units).toString().trim(), sql.trim());
    const counts = new Map();
    assert.deepEqual(recoveryInsertCoverage(units[0], counts, ["documents"]),
      [{ table: "documents", first_row: 1, last_row: 2 }]);
    assert.equal(counts.get("documents"), 2);
  }
});

for (const [label, sql] of [
  ["transaction", "BEGIN TRANSACTION;"], ["unknown table", "INSERT INTO unknown VALUES(1);"],
  ["select", "INSERT INTO documents SELECT 1;"], ["upsert", "INSERT INTO documents VALUES(1) ON CONFLICT DO NOTHING;"],
]) test(`dump rejects ${label} after a valid insert control`, () => {
  const counts = new Map();
  assert.equal(recoveryInsertCoverage(Buffer.from("INSERT INTO documents VALUES(1);"), counts, ["documents"]).length, 1);
  assert.throws(() => recoveryInsertCoverage(Buffer.from(sql), counts, ["documents"]), /SQL_DUMP_INVALID/);
  assert.equal(counts.get("documents"), 1);
});

test("unterminated and oversized SQL reach the streaming limit with green controls", async (t) => {
  const directory = fixture(t), path = join(directory, "dump.sql");
  let reached = 0;
  for (const [sql, bound, rejected] of [
    ["INSERT INTO documents VALUES(1);\n", 100, false],
    ["INSERT INTO documents VALUES('unterminated", 100, true],
    ["INSERT INTO documents VALUES('" + "x".repeat(200) + "');", 100, true],
  ]) {
    writeFileSync(path, sql, { mode: 0o600 });
    const consume = async () => { reached++; for await (const unit of recoveryDataStatements(path, bound)) assert.ok(unit.length); };
    if (rejected) await assert.rejects(consume(), /SQL_DUMP_INVALID/); else await consume();
  }
  assert.equal(reached, 3);
});

test("actual SQLite verifier reads every part and independently counts restored tables", async (t) => {
  const directory = fixture(t);
  const names = readdirSync("migrations/d1").filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const migrations = names.map((name, index) => {
    const sql = readFileSync(join("migrations/d1", name), "utf8");
    return { name, sql, version: index + 1, checksum: digest(sql).slice(0, 16) };
  });
  const files = migrations.map(({ name, sql }, index) => {
    const path = join(directory, `part-${index}.sql`); writeFileSync(path, sql, { mode: 0o600 }); return path;
  });
  const receipts = migrations.map(({ name, version, checksum }) =>
    `INSERT INTO schema_migrations(version,name,applied_at,checksum) VALUES(${version},'${name.replace(/\.sql$/, "")}','2026-11-14T00:00:00Z','${checksum}');\n`).join("");
  const final = join(directory, "receipts.sql"); writeFileSync(final, receipts, { mode: 0o600 }); files.push(final);
  const whole = join(directory, "whole.sql");
  writeFileSync(whole, migrations.map(({ sql }) => sql).join("\n") + "\n" + receipts, { mode: 0o600 });
  const single = await verifyRecoverySqlArtifact(null, { temporaryDirectory: directory,
    coverageTables: ["schema_migrations", "documents"], consumeParts: (consume) => consume(whole) });
  let consumed = 0;
  const multipart = await verifyRecoverySqlArtifact(null, { temporaryDirectory: directory, coverageTables: ["schema_migrations", "documents"],
    consumeParts: async (consume) => { for (const path of files) { await consume(path); consumed++; } } });
  assert.equal(consumed, files.length);
  const { tables, ...snapshot } = multipart;
  const { tables: singleTables, ...singleSnapshot } = single;
  assert.deepEqual(snapshot, singleSnapshot);
  assert.deepEqual(tables, singleTables);
  assert.deepEqual(tables, [{ table: "schema_migrations", rows: migrations.length }, { table: "documents", rows: 0 }]);
});
