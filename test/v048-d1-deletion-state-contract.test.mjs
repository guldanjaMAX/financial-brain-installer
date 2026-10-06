import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  V048_D1_DELETION_STATE_INVENTORY_SQL,
  V048_D1_DELETION_STATE_MAX_EXPORT_BYTES,
  V048_D1_DELETION_STATE_SCHEMA_SQL,
  fingerprintV048D1DeletionState,
  normalizeV048D1DeletionStateSequences,
} from "../operations/v048-d1-deletion-state-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const migrations = Object.freeze(Array.from({ length: 48 }, (_, index) => Object.freeze({
  version: index + 1,
  name: `${String(index + 1).padStart(4, "0")}_fixture`,
  checksum: sha256(`migration:${index + 1}`).slice(0, 16),
})));
const inventory = Object.freeze([
  "chunks",
  "chunks_fts",
  ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
  "install_state",
  "llm_call_log",
].sort());
const schemaRows = Object.freeze(inventory.map((name) => Object.freeze({
  type: "table",
  name,
  tbl_name: name,
  sql: name === "chunks_fts"
    ? "CREATE VIRTUAL TABLE chunks_fts USING fts5(text,content='chunks',content_rowid='id')"
    : `CREATE TABLE ${name} (fixture BLOB)`,
})));
const privateRow = "private oauth token and live auth challenge";
const integerSequence = Object.freeze({
  name: "chunks",
  name_type: "text",
  name_quote: "'chunks'",
  seq: 3201,
  seq_type: "integer",
  seq_quote: "3201",
});
const llmIntegerSequence = Object.freeze({
  ...integerSequence,
  name: "llm_call_log",
  name_quote: "'llm_call_log'",
  seq: 3,
  seq_quote: "3",
});
const sequenceRows = Object.freeze([integerSequence, llmIntegerSequence]);

function input(override = {}) {
  return {
    role: "source",
    binding: {
      account_id: "account-fixture",
      database_id: "database-id-fixture",
      database_name: "database-name-fixture",
    },
    migrations,
    quickCheck: "ok",
    inventory,
    schemaRows,
    durableExportSha256: sha256(privateRow),
    durableExportBytes: Buffer.byteLength(privateRow),
    sequenceRows,
    ftsCount: 3201,
    ...override,
  };
}

test("v0.4.8 deletion-state fingerprint binds identity and every full-state component", () => {
  const baseline = fingerprintV048D1DeletionState(input());
  assert.match(baseline, /^[a-f0-9]{64}$/u);
  assert.equal(String(baseline).includes(privateRow), false);
  assert.equal(fingerprintV048D1DeletionState(input()), baseline);

  for (const changed of [
    input({ role: "target" }),
    input({ binding: { ...input().binding, database_id: "replacement-database-id" } }),
    input({ durableExportSha256: sha256(`${privateRow}:changed`) }),
    input({ durableExportBytes: Buffer.byteLength(privateRow) + 1 }),
    input({ sequenceRows: [
      { ...integerSequence, seq: 3202, seq_quote: "3202" },
      llmIntegerSequence,
    ] }),
    input({ ftsCount: 3200 }),
    input({ schemaRows: schemaRows.map((row) => row.name === "chunks_fts_idx"
      ? { ...row, sql: `${row.sql} STRICT` }
      : row) }),
  ]) {
    assert.notEqual(fingerprintV048D1DeletionState(changed), baseline);
  }
});

test("sqlite_sequence INTEGER 1 and TEXT '1' have different fingerprints", () => {
  const integerOne = fingerprintV048D1DeletionState(input({
    sequenceRows: [
      { ...integerSequence, seq: 1, seq_quote: "1" },
      llmIntegerSequence,
    ],
  }));
  const textOne = fingerprintV048D1DeletionState(input({
    sequenceRows: [
      {
        ...integerSequence,
        seq: "1",
        seq_type: "text",
        seq_quote: "'1'",
      },
      llmIntegerSequence,
    ],
  }));
  assert.notEqual(integerOne, textOne);
});

test("sqlite_sequence rejects unknown and existing-table decoy names", () => {
  const ghost = {
    ...integerSequence,
    name: "ghost",
    name_quote: "'ghost'",
  };
  assert.throws(
    () => normalizeV048D1DeletionStateSequences([ghost, llmIntegerSequence], inventory),
    /V048_D1_DELETION_STATE_INVALID/u,
  );
  assert.throws(
    () => fingerprintV048D1DeletionState(input({
      sequenceRows: [ghost, llmIntegerSequence],
    })),
    /V048_D1_DELETION_STATE_INVALID/u,
  );
  const existingTableDecoy = {
    ...llmIntegerSequence,
    name: "install_state",
    name_quote: "'install_state'",
  };
  assert.throws(
    () => fingerprintV048D1DeletionState(input({
      sequenceRows: [integerSequence, existingTableDecoy],
    })),
    /V048_D1_DELETION_STATE_INVALID/u,
  );
});

test("v0.4.8 deletion-state contract rejects incomplete FTS and oversized exports", () => {
  assert.equal(V048_D1_DELETION_STATE_INVENTORY_SQL.includes("chunks_fts_%"), false);
  assert.equal(V048_D1_DELETION_STATE_SCHEMA_SQL.includes("chunks_fts_%"), false);
  for (const shadow of V048_D1_DELETION_STATE_FTS_SHADOW_TABLES) {
    assert.throws(() => fingerprintV048D1DeletionState(input({
      inventory: inventory.filter((name) => name !== shadow),
    })), /V048_D1_DELETION_STATE_INVALID/u);
  }
  assert.throws(() => fingerprintV048D1DeletionState(input({
    durableExportBytes: V048_D1_DELETION_STATE_MAX_EXPORT_BYTES + 1,
  })), /V048_D1_DELETION_STATE_INVALID/u);
});
