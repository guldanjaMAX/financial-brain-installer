import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync,
  renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS } from "../scripts/run-test-chain.mjs";
import {
  exportMultipartRecovery, restoreMultipartRecovery,
} from "../operations/recovery-multipart.mjs";
import {
  encryptRecoveryArtifact, generateRecoveryArtifactKey, withDecryptedRecoveryArtifact,
} from "../operations/recovery-artifact-crypto.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const schema = "CREATE TABLE documents(id INTEGER PRIMARY KEY,body TEXT);\n";
const rows = Array.from({ length: 13 }, (_, i) =>
  `INSERT INTO documents VALUES(${i + 1},'synthetic ${"x".repeat(70)} ${i}');\n`);
const snapshot = {
  schema_fingerprint: hash(schema),
  content_fingerprint: hash(rows.join("")),
  aggregate_fingerprint: hash(JSON.stringify({ documents: 13 })),
  tables: [{ table: "documents", rows: 13 }],
};

// The fake D1 transport executes SQL in a real SQLite database. Readback uses
// the restored text, schema and row values, independently of the manifest.
function sqlite(path, sql) {
  const database = new DatabaseSync(path);
  try {
    if (/^\s*SELECT\b/i.test(sql)) {
      return database.prepare(sql).all().map((row) => Object.values(row).join("|")).join("\n");
    }
    database.exec(sql);
    return "";
  } finally { database.close(); }
}
function readback(path) {
  const count = Number(sqlite(path, "SELECT count(*) FROM documents;"));
  const actualSchema = sqlite(path, "SELECT sql FROM sqlite_schema WHERE name='documents';") + ";\n";
  const values = JSON.parse(sqlite(path, "SELECT json_group_array(json_object('id',id,'body',body)) FROM (SELECT * FROM documents ORDER BY id);"));
  const actualRows = values.map(({ id, body }) => `INSERT INTO documents VALUES(${id},'${body}');\n`);
  return { schema_fingerprint: hash(actualSchema), content_fingerprint: hash(actualRows.join("")),
    aggregate_fingerprint: hash(JSON.stringify({ documents: count })), tables: [{ table: "documents", rows: count }] };
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "brain-recovery-multipart-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const artifacts = join(directory, "parts");
  // Artifact directories are dedicated: an unrelated file is an extra part.
  sqlite(join(directory, "source.sqlite"), schema + rows.join(""));
  const key = generateRecoveryArtifactKey();
  const events = [];
  const sourceFingerprint = hash("synthetic-source-resource");
  const withKey = (callback) => callback(key);
  const consume = async (consumeParts) => {
    const path = join(directory, "verified.sqlite");
    rmSync(path, { force: true });
    await consumeParts(async (part) => sqlite(path, readFileSync(part, "utf8")));
    return readback(path);
  };
  const exporter = {
    directory: artifacts, sourceResourceFingerprint: sourceFingerprint,
    snapshot, withKey, maxPartBytes: 512,
    openUnits: async function* () {
      events.push("source-open");
      yield { sql: Buffer.from(schema), coverage: [] };
      for (let i = 0; i < rows.length; i++) {
        yield { sql: Buffer.from(rows[i]), coverage: [{ table: "documents", first_row: i + 1, last_row: i + 1 }] };
      }
    },
    inspectExport: consume,
    inspectSource: async () => { events.push("source-readback"); return readback(join(directory, "source.sqlite")); },
    onPartVerified: (part) => events.push({ part: part.index, skipped: part.skipped }),
  };
  const targetPath = join(directory, "target.sqlite");
  const target = { name: "recovery-gate-synthetic", resource_fingerprint: hash("synthetic-target-resource") };
  let imports = 0;
  let inspections = 0;
  const restore = (receipt, overrides = {}) => ({
    directory: artifacts, expectedManifestSha256: receipt.manifest_sha256, withKey, target,
    inspectTarget: async () => {
      inspections++;
      const count = Number(sqlite(targetPath, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%';"));
      return { ...target, user_table_count: count, ...(count ? { snapshot: readback(targetPath) } : {}) };
    },
    importPart: async ({ path, index }) => {
      imports++;
      events.push({ imported: index });
      sqlite(targetPath, readFileSync(path, "utf8"));
    },
    ...overrides,
  });
  return { directory, artifacts, targetPath, exporter, restore, events, withKey,
    get imports() { return imports; }, get inspections() { return inspections; } };
}

test("bounded fake D1 export restores three or more encrypted parts with exact fingerprints", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  assert.ok(receipt.part_count >= 3);
  for (const name of readdirSync(f.artifacts)) {
    assert.equal(readFileSync(join(f.artifacts, name), "utf8").includes("synthetic xxxx"), false);
    if (name.startsWith("part-")) assert.ok(statSync(join(f.artifacts, name)).size <= 512);
  }
  const restored = await restoreMultipartRecovery(f.restore(receipt));
  assert.equal(restored.import_completed, true);
  assert.deepEqual(readback(f.targetPath), snapshot);
  assert.equal(f.imports, receipt.part_count);
  assert.deepEqual(f.events.filter((e) => e.imported).map((e) => e.imported), Array.from({ length: receipt.part_count }, (_, i) => i + 1));
});

test("interrupted export resumes by authenticating and skipping the verified prefix", async (t) => {
  const f = fixture(t);
  let reached = 0;
  await assert.rejects(exportMultipartRecovery({ ...f.exporter, onPartVerified(part) {
    f.events.push(part);
    if (++reached === 2) throw new Error("SYNTHETIC_INTERRUPTION");
  } }), /SYNTHETIC_INTERRUPTION/);
  assert.equal(reached, 2);
  assert.ok(existsSync(join(f.artifacts, "export-binding.json.fbrenc")));
  const files = readdirSync(f.artifacts).filter((name) => name.startsWith("part-"));
  assert.equal(files.length, 2);
  const prior = files.map((name) => [name, hash(readFileSync(join(f.artifacts, name)))]);
  const receipt = await exportMultipartRecovery(f.exporter);
  for (const [name, digest] of prior) assert.equal(hash(readFileSync(join(f.artifacts, name))), digest);
  assert.equal(f.events.filter((e) => e.skipped).length, 2);
  assert.equal((await restoreMultipartRecovery(f.restore(receipt))).import_completed, true);
});

for (const defect of ["altered", "missing", "reordered", "extra", "manifest"]) {
  test(`${defect} artifact set is refused before any target mutation`, async (t) => {
    const f = fixture(t);
    const receipt = await exportMultipartRecovery(f.exporter);
    assert.ok(receipt.part_count >= 3, "fault reaches a nonempty verified plan");
    const names = readdirSync(f.artifacts).filter((name) => name.startsWith("part-")).sort();
    if (defect === "missing") rmSync(join(f.artifacts, names[1]));
    if (defect === "extra") writeFileSync(join(f.artifacts, "extra.fbrenc"), Buffer.alloc(1), { mode: 0o600 });
    if (defect === "altered" || defect === "manifest") {
      const path = join(f.artifacts, defect === "manifest" ? "manifest.json.fbrenc" : names[1]);
      const bytes = readFileSync(path); bytes[60] ^= 1; writeFileSync(path, bytes);
    }
    if (defect === "reordered") {
      renameSync(join(f.artifacts, names[0]), join(f.artifacts, "swap"));
      renameSync(join(f.artifacts, names[1]), join(f.artifacts, names[0]));
      renameSync(join(f.artifacts, "swap"), join(f.artifacts, names[1]));
    }
    await assert.rejects(restoreMultipartRecovery(f.restore(receipt)), /RECOVERY_MULTIPART_/);
    assert.equal(f.imports, 0);
    // Same receipt and key reach actual imports in the successful control above.
    assert.ok(existsSync(join(f.artifacts, "manifest.json.fbrenc")));
  });
}

test("nonempty target is refused after its real empty-target decision", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  sqlite(f.targetPath, schema + rows[0]);
  await assert.rejects(restoreMultipartRecovery(f.restore(receipt)), /RECOVERY_MULTIPART_TARGET_NOT_EMPTY/);
  assert.equal(f.inspections, 1);
  assert.equal(f.imports, 0);
  assert.equal(sqlite(f.targetPath, "SELECT count(*) FROM documents;"), "1");
});

test("final content mismatch cannot report success after imports", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const options = f.restore(receipt);
  const inspect = options.inspectTarget;
  options.inspectTarget = async () => {
    const state = await inspect();
    if (f.imports === receipt.part_count) state.snapshot.content_fingerprint = hash("different-content");
    return state;
  };
  await assert.rejects(restoreMultipartRecovery(options), /RECOVERY_MULTIPART_TARGET_FINGERPRINT_MISMATCH/);
  assert.equal(f.imports, receipt.part_count);
});

test("small single-artifact encryption path stays unchanged", async (t) => {
  const f = fixture(t);
  const source = join(f.directory, "small.sql");
  const artifact = join(f.directory, "small.sql.fbrenc");
  const bytes = schema + rows[0];
  writeFileSync(source, bytes, { mode: 0o600 });
  await f.withKey((key) => encryptRecoveryArtifact(source, artifact, key));
  assert.equal(readFileSync(artifact).subarray(0, 8).toString(), "FBRREC1\n");
  await f.withKey((key) => withDecryptedRecoveryArtifact(artifact, f.directory, key, (path) => {
    assert.equal(readFileSync(path, "utf8"), bytes);
  }));
});

test("an already sealed export resumes with identical manifest and part hashes", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const second = await exportMultipartRecovery(f.exporter);
  assert.deepEqual(second, receipt);
  assert.equal(f.events.filter((event) => event.skipped).length, receipt.part_count);
  assert.equal((await restoreMultipartRecovery(f.restore(second))).import_completed, true);
});

test("a corrupt resumed prefix is never replaced", async (t) => {
  const f = fixture(t);
  let reached = 0;
  await assert.rejects(exportMultipartRecovery({ ...f.exporter, onPartVerified() {
    reached++; throw new Error("SYNTHETIC_INTERRUPTION");
  } }), /SYNTHETIC_INTERRUPTION/);
  assert.equal(reached, 1);
  const path = join(f.artifacts, readdirSync(f.artifacts).find((name) => name.startsWith("part-")));
  const bytes = readFileSync(path); bytes[60] ^= 1; writeFileSync(path, bytes);
  const digest = hash(bytes);
  await assert.rejects(exportMultipartRecovery(f.exporter));
  assert.equal(hash(readFileSync(path)), digest);
  assert.equal(existsSync(join(f.artifacts, "manifest.json.fbrenc")), false);
});

for (const field of ["schema_fingerprint", "content_fingerprint", "aggregate_fingerprint"]) {
  test(`export source ${field} change prevents sealing after verified parts`, async (t) => {
    const f = fixture(t);
    let reached = 0;
    await assert.rejects(exportMultipartRecovery({ ...f.exporter, inspectSource: async () => {
      reached++; return { ...snapshot, [field]: hash("changed") };
    } }), /RECOVERY_MULTIPART_SOURCE_CHANGED/);
    assert.equal(reached, 1);
    assert.ok(f.events.filter((event) => event.part).length >= 3);
    assert.equal(existsSync(join(f.artifacts, "manifest.json.fbrenc")), false);
  });
}

test("coverage gaps fail after the producer supplies a real unit", async (t) => {
  const f = fixture(t);
  let reached = 0;
  await assert.rejects(exportMultipartRecovery({ ...f.exporter, openUnits: async function* () {
    reached++;
    yield { sql: Buffer.from(rows[1]), coverage: [{ table: "documents", first_row: 2, last_row: 2 }] };
  } }), /RECOVERY_MULTIPART_COVERAGE_INVALID/);
  assert.equal(reached, 1);
  assert.equal(existsSync(join(f.artifacts, "manifest.json.fbrenc")), false);
});

test("oversized individual SQL unit fails without splitting a statement", async (t) => {
  const f = fixture(t);
  let reached = 0;
  await assert.rejects(exportMultipartRecovery({ ...f.exporter, openUnits: async function* () {
    reached++; yield { sql: Buffer.alloc(513, 32), coverage: [] };
  } }), /RECOVERY_MULTIPART_SQL_UNIT_TOO_LARGE_OR_INVALID/);
  assert.equal(reached, 1);
  assert.deepEqual(readdirSync(f.artifacts), ["export-binding.json.fbrenc"]);
});

test("a verifier that never consumes the set cannot seal it", async (t) => {
  const f = fixture(t);
  let reached = 0;
  await assert.rejects(exportMultipartRecovery({ ...f.exporter, inspectExport: async () => {
    reached++; return snapshot;
  } }), /RECOVERY_MULTIPART_EXPORT_VERIFIER_NOT_REACHED/);
  assert.equal(reached, 1);
  assert.ok(f.events.filter((event) => event.part).length >= 3);
});

test("lost import response leaves a partial database and cannot be blindly resumed", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const options = f.restore(receipt);
  const original = options.importPart;
  options.importPart = async (part) => { await original(part); throw new Error("SYNTHETIC_LOST_RESPONSE"); };
  await assert.rejects(restoreMultipartRecovery(options), /SYNTHETIC_LOST_RESPONSE/);
  assert.equal(f.imports, 1);
  await assert.rejects(restoreMultipartRecovery(f.restore(receipt)), /RECOVERY_MULTIPART_TARGET_NOT_EMPTY/);
  assert.equal(f.imports, 1);
});

test("source resource and unlabelled target cannot enter the import decision", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const options = f.restore(receipt);
  await assert.rejects(restoreMultipartRecovery({ ...options, target: {
    ...options.target, resource_fingerprint: f.exporter.sourceResourceFingerprint,
  } }), /RECOVERY_MULTIPART_TARGET_IS_SOURCE/);
  await assert.rejects(restoreMultipartRecovery({ ...options, target: {
    ...options.target, name: "ordinary-database",
  } }), /RECOVERY_MULTIPART_TARGET_NOT_EXPLICIT_DISPOSABLE/);
  assert.equal(f.imports, 0);
  assert.ok(receipt.part_count >= 3);
});

test("package privacy inventory includes the multipart implementation", () => {
  const inventory = readFileSync(join(root, "test/package-privacy.test.mjs"), "utf8");
  assert.ok(inventory.includes('"operations/recovery-multipart.mjs",'));
  assert.ok(inventory.includes('"operations/recovery-sql-parts.mjs",'));
  for (const commands of [TEST_COMMANDS, POST_LAUNCHER_TEST_COMMANDS]) {
    for (const path of ["test/recovery-multipart-1114.test.mjs", "test/recovery-size-probe-1114.test.mjs",
      "test/recovery-sql-parts-1114.test.mjs", "test/recovery-implementation-imports-1114.test.mjs",
      "test/recovery-adapter-multipart-run-1114.test.mjs"]) {
      assert.equal(commands.filter((command) => command.includes(path)).length, 1);
    }
  }
});

test("authenticated manifest contains ordered counts, coverage, hashes and fingerprints", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  await f.withKey((key) => withDecryptedRecoveryArtifact(join(f.artifacts, "manifest.json.fbrenc"), f.artifacts, key, (path) => {
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(manifest.part_count, receipt.part_count);
    assert.deepEqual(manifest.snapshot, snapshot);
    let nextRow = 1;
    for (const part of manifest.parts) {
      assert.equal(part.bytes, statSync(join(f.artifacts, part.name)).size);
      assert.equal(part.sha256, hash(readFileSync(join(f.artifacts, part.name))));
      for (const range of part.coverage) {
        assert.equal(range.table, "documents");
        assert.equal(range.first_row, nextRow);
        nextRow = range.last_row + 1;
      }
    }
    assert.equal(nextRow, 14);
  }));
});

test("reordered authenticated manifest fails its ordinal decision with a fresh pin", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const artifact = join(f.artifacts, "manifest.json.fbrenc");
  let manifest;
  await f.withKey((key) => withDecryptedRecoveryArtifact(artifact, f.artifacts, key, (path) => {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  }));
  assert.ok(manifest.parts.length >= 3);
  [manifest.parts[0], manifest.parts[1]] = [manifest.parts[1], manifest.parts[0]];
  const source = join(f.directory, "changed-manifest.json");
  writeFileSync(source, JSON.stringify(manifest), { mode: 0o600 });
  rmSync(artifact); // Only this test's generated artifact is replaced.
  await f.withKey((key) => encryptRecoveryArtifact(source, artifact, key));
  const changedReceipt = { ...receipt, manifest_sha256: hash(readFileSync(artifact)) };
  await assert.rejects(restoreMultipartRecovery(f.restore(changedReceipt)), /RECOVERY_MULTIPART_PART_ORDER_OR_METADATA_INVALID/);
  assert.equal(f.imports, 0);
});

test("wrong key reaches authenticated decryption and cannot import", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const wrong = generateRecoveryArtifactKey();
  let reached = 0;
  await assert.rejects(restoreMultipartRecovery(f.restore(receipt, { withKey: (callback) => {
    reached++; return callback(wrong);
  } })));
  assert.equal(reached, 1);
  assert.equal(f.imports, 0);
  assert.equal((await restoreMultipartRecovery(f.restore(receipt))).import_completed, true);
});

test("actual restored text corruption is detected after all imports", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const options = f.restore(receipt);
  const importPart = options.importPart;
  options.importPart = async (part) => {
    await importPart(part);
    if (part.index === receipt.part_count) sqlite(f.targetPath, "UPDATE documents SET body='changed synthetic text' WHERE id=1;");
  };
  await assert.rejects(restoreMultipartRecovery(options), /RECOVERY_MULTIPART_TARGET_FINGERPRINT_MISMATCH/);
  assert.equal(f.imports, receipt.part_count);
});

test("target identity replacement is refused adjacent to the first import", async (t) => {
  const f = fixture(t);
  const receipt = await exportMultipartRecovery(f.exporter);
  const options = f.restore(receipt);
  const inspect = options.inspectTarget;
  let reached = 0;
  options.inspectTarget = async () => {
    const state = await inspect();
    if (++reached === 2) state.resource_fingerprint = hash("replacement-target");
    return state;
  };
  await assert.rejects(restoreMultipartRecovery(options), /RECOVERY_MULTIPART_TARGET_IDENTITY_CHANGED/);
  assert.equal(reached, 2);
  assert.equal(f.imports, 0);
});
