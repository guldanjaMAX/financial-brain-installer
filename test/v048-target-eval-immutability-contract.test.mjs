import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
} from "../operations/v048-d1-deletion-state-contract.mjs";
import {
  V048_TARGET_EVAL_ALLOWED_LLM_LABELS,
  V048_TARGET_EVAL_CLOCK_SKEW_MS,
  V048_TARGET_EVAL_IMMUTABLE_STATE_KIND,
  V048_TARGET_EVAL_LLM_APPEND_KIND,
  V048TargetEvalImmutabilityContractError,
  deriveV048TargetEvalExpectedInventory,
  deriveV048TargetEvalExpectedLlmCallBounds,
  deriveV048TargetEvalImmutableExportTables,
  fingerprintV048TargetEvalImmutableState,
  validateV048TargetEvalLlmAppend,
  validateV048TargetEvalLlmAppendReceipt,
} from "../operations/v048-target-eval-immutability-contract.mjs";
import {
  V048_WORKER_ANSWER_MODEL,
} from "../operations/v048-worker-version-contract.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const durableTables = Object.freeze([
  "install_state",
  "schema_migrations",
  "llm_call_log",
  "documents",
  "chunks",
]);
const immutableExportTables = Object.freeze([
  "install_state",
  "schema_migrations",
  "documents",
  "chunks",
  ...V048_D1_DELETION_STATE_FTS_SHADOW_TABLES,
]);
const inventory = deriveV048TargetEvalExpectedInventory(durableTables);
const schemaRows = Object.freeze(inventory.map((name) => Object.freeze({
  type: "table",
  name,
  tbl_name: name,
  sql: name === "chunks_fts"
    ? "CREATE VIRTUAL TABLE chunks_fts USING fts5(text,content='chunks',content_rowid='id')"
    : `CREATE TABLE ${name} (fixture BLOB)`,
})));
const migrations = Object.freeze(Array.from({ length: 47 }, (_, index) => Object.freeze({
  version: index + 1,
  name: `${String(index + 1).padStart(4, "0")}_fixture`,
  checksum: sha256(`migration:${index + 1}`).slice(0, 16),
})));
const binding = Object.freeze({
  account_id: "a".repeat(32),
  database_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  database_name: "brain-test-v048-field-target-recovery-gate-a48f1101",
});
const privateCorpusMarker = "synthetic-private-corpus-marker";
const privatePriorLabel = "synthetic-private-prior-label";

function sequence(name, seq) {
  return Object.freeze({
    name,
    name_type: "text",
    name_quote: `'${name}'`,
    seq,
    seq_type: "integer",
    seq_quote: String(seq),
  });
}

function stateInput(override = {}) {
  return {
    binding,
    durableTables,
    immutableExportTables,
    migrations,
    quickCheck: "ok",
    inventory,
    schemaRows,
    immutableExportSha256: sha256(privateCorpusMarker),
    immutableExportBytes: Buffer.byteLength(privateCorpusMarker),
    sequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 3)],
    ftsCount: 6001,
    ...override,
  };
}

function llmRow(id, override = {}) {
  return {
    id,
    ts: "2026-09-12T00:00:00.000Z",
    day: "2026-09-12",
    label: id <= 3 ? `${privatePriorLabel}-${id}` : "rag-think",
    model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    status: "ok",
    est_cost_usd_micros: 0,
    ...override,
  };
}

const beforeRows = Object.freeze([llmRow(1), llmRow(2), llmRow(3)]);
const afterRows = Object.freeze([
  ...beforeRows,
  llmRow(4, { label: "rag-think", est_cost_usd_micros: 17 }),
  llmRow(5, { label: "rag-evidence-gate", est_cost_usd_micros: 23 }),
]);
const beforeSequenceRows = Object.freeze([
  sequence("chunks", 6001),
  sequence("llm_call_log", 3),
]);
const afterSequenceRows = Object.freeze([
  sequence("chunks", 6001),
  sequence("llm_call_log", 5),
]);

function appendInput(override = {}) {
  return {
    durableTables,
    beforeRows,
    afterRows,
    beforeSequenceRows,
    afterSequenceRows,
    expectedModel: V048_WORKER_ANSWER_MODEL,
    expectedCallBounds: {
      ragThink: 1,
      minimumEvidenceGate: 1,
      maximumEvidenceGate: 1,
    },
    evaluationStartedAt: "2026-09-12T00:00:00.000Z",
    evaluationCompletedAt: "2026-09-12T00:01:00.000Z",
    ...override,
  };
}

function expectCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error instanceof V048TargetEvalImmutabilityContractError, true);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

test("immutable export tables exclude only llm_call_log and bind all FTS shadows", () => {
  const derived = deriveV048TargetEvalImmutableExportTables(durableTables);
  assert.deepEqual(derived, immutableExportTables);
  assert.equal(Object.isFrozen(derived), true);
  assert.equal(derived.includes("llm_call_log"), false);
  assert.deepEqual(derived.slice(-4), V048_D1_DELETION_STATE_FTS_SHADOW_TABLES);

  for (const invalid of [
    durableTables.filter((name) => name !== "llm_call_log"),
    [...durableTables, "documents"],
    [...durableTables, "chunks_fts"],
    [...durableTables, V048_D1_DELETION_STATE_FTS_SHADOW_TABLES[0]],
    [...durableTables.slice(0, -1), "bad-table-name"],
  ]) {
    expectCode(
      () => deriveV048TargetEvalImmutableExportTables(invalid),
      "V048_TARGET_EVAL_IMMUTABLE_TABLES_INVALID",
    );
  }
});

test("target immutable fingerprint changes for same-count corpus bytes but ignores llm sequence", () => {
  const baseline = fingerprintV048TargetEvalImmutableState(stateInput());
  const sameCountMutation = fingerprintV048TargetEvalImmutableState(stateInput({
    immutableExportSha256: sha256("synthetic-private-corpus-markes"),
  }));
  assert.match(baseline, /^[a-f0-9]{64}$/u);
  assert.notEqual(sameCountMutation, baseline);
  assert.equal(Buffer.byteLength("synthetic-private-corpus-markes"),
    Buffer.byteLength(privateCorpusMarker));
  assert.equal(fingerprintV048TargetEvalImmutableState(stateInput({
    sequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 5)],
  })), baseline);
  assert.notEqual(fingerprintV048TargetEvalImmutableState(stateInput({
    binding: { ...binding, database_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
  })), baseline);
  assert.equal(String(baseline).includes(privateCorpusMarker), false);
  assert.equal(V048_TARGET_EVAL_IMMUTABLE_STATE_KIND.includes("deletion"), false);
});

test("immutable fingerprint refuses a different export list, inventory, or schema table set", () => {
  for (const changed of [
    stateInput({ immutableExportTables: [...immutableExportTables].reverse() }),
    stateInput({ inventory: inventory.slice(1) }),
    stateInput({ schemaRows: schemaRows.slice(1) }),
  ]) {
    expectCode(
      () => fingerprintV048TargetEvalImmutableState(changed),
      "V048_TARGET_EVAL_IMMUTABLE_STATE_INVALID",
    );
  }
});

test("llm_call_log permits only a privacy-safe append with matching sequence advance", () => {
  const receipt = validateV048TargetEvalLlmAppend(appendInput());
  assert.deepEqual(receipt, {
    schema_version: 1,
    kind: V048_TARGET_EVAL_LLM_APPEND_KIND,
    before_rows: 3,
    appended_rows: 2,
    after_rows: 5,
    rag_think_rows: 1,
    rag_evidence_gate_rows: 1,
    transition_sha256: receipt.transition_sha256,
  });
  assert.match(receipt.transition_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(validateV048TargetEvalLlmAppendReceipt(receipt), receipt);
  assert.equal(JSON.stringify(receipt).includes(privatePriorLabel), false);
  assert.deepEqual(V048_TARGET_EVAL_ALLOWED_LLM_LABELS,
    ["rag-evidence-gate", "rag-think"]);
});

test("durable llm append receipts retain an exact aggregate shape", () => {
  const receipt = validateV048TargetEvalLlmAppend(appendInput());
  for (const mutate of [
    (value) => { value.unreviewed = true; },
    (value) => { delete value.transition_sha256; },
    (value) => { value.transition_sha256 = "invalid"; },
    (value) => { value.after_rows++; },
    (value) => { value.appended_rows++; },
    (value) => { value.rag_evidence_gate_rows = value.rag_think_rows + 1; },
  ]) {
    const invalid = structuredClone(receipt);
    mutate(invalid);
    expectCode(
      () => validateV048TargetEvalLlmAppendReceipt(invalid),
      "V048_TARGET_EVAL_LLM_APPEND_RECEIPT_INVALID",
    );
  }
});

test("release golden derives exact one-pass think and gate bounds without retaining questions", () => {
  const counts = deriveV048TargetEvalExpectedLlmCallBounds({
    questions: [
      { kind: "unanswerable" },
      { kind: "answerable", answer_expect: { claims: [{}] } },
      { kind: "answerable" },
      { kind: "single", answer_expect: { claims: [{}] } },
      { kind: "multi" },
    ],
  });
  assert.deepEqual(counts, {
    ragThink: 3,
    minimumEvidenceGate: 2,
    maximumEvidenceGate: 3,
  });
  assert.equal(Object.isFrozen(counts), true);
  expectCode(
    () => deriveV048TargetEvalExpectedLlmCallBounds({ questions: [{}] }, { repeat: 2 }),
    "V048_TARGET_EVAL_EXPECTATIONS_INVALID",
  );
});

test("an unanswerable cited draft may add one evidence gate without changing exact think count", () => {
  const rows = [
    ...beforeRows,
    llmRow(4, { label: "rag-think" }),
    llmRow(5, { label: "rag-evidence-gate" }),
    llmRow(6, { label: "rag-think" }),
    llmRow(7, { label: "rag-evidence-gate" }),
  ];
  const receipt = validateV048TargetEvalLlmAppend(appendInput({
    afterRows: rows,
    afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 7)],
    expectedCallBounds: {
      ragThink: 2,
      minimumEvidenceGate: 1,
      maximumEvidenceGate: 2,
    },
  }));
  assert.equal(receipt.rag_think_rows, 2);
  assert.equal(receipt.rag_evidence_gate_rows, 2);
});

test("deterministic answer cases require their evidence-gate lower bound", () => {
  expectCode(
    () => validateV048TargetEvalLlmAppend(appendInput({
      afterRows: [...beforeRows, llmRow(4, { label: "rag-think" })],
      afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 4)],
    })),
    "V048_TARGET_EVAL_LLM_APPEND_INVALID",
  );
});

test("no appended prefix can contain more evidence gates than completed think calls", () => {
  expectCode(
    () => validateV048TargetEvalLlmAppend(appendInput({
      afterRows: [
        ...beforeRows,
        llmRow(4, { label: "rag-evidence-gate" }),
        llmRow(5, { label: "rag-think" }),
      ],
    })),
    "V048_TARGET_EVAL_LLM_APPEND_INVALID",
  );
});

test("llm_call_log rejects a rewrite, deletion, or reorder of any prior row", () => {
  const rewritten = afterRows.map((row, index) => index === 1
    ? { ...row, model: "rewritten-model" }
    : row);
  const deleted = afterRows.filter((row) => row.id !== 2);
  const reordered = [beforeRows[1], beforeRows[0], ...afterRows.slice(2)];
  for (const changedRows of [rewritten, deleted, reordered]) {
    expectCode(
      () => validateV048TargetEvalLlmAppend(appendInput({ afterRows: changedRows })),
      "V048_TARGET_EVAL_LLM_APPEND_INVALID",
    );
  }
});

test("new llm rows reject bad labels, status, and ids", () => {
  const invalidRows = [
    [...beforeRows, llmRow(4, { label: "rag-rerank" })],
    [...beforeRows, llmRow(4, { status: "error" })],
    [...beforeRows, llmRow(3, { label: "rag-think" })],
    [...beforeRows, llmRow(Number.MAX_SAFE_INTEGER + 1, { label: "rag-think" })],
  ];
  for (const changedRows of invalidRows) {
    expectCode(
      () => validateV048TargetEvalLlmAppend(appendInput({
        afterRows: changedRows,
        afterSequenceRows: [
          sequence("chunks", 6001),
          sequence("llm_call_log", changedRows.at(-1).id),
        ],
      })),
      "V048_TARGET_EVAL_LLM_APPEND_INVALID",
    );
  }
});

test("new llm rows require bounded canonical UTC time, matching day, model, and cost", () => {
  for (const override of [
    { ts: "2026-09-12T00:00:00Z" },
    { ts: "2026-09-31T00:00:00.000Z", day: "2026-09-31" },
    { day: "2026-09-13" },
    { model: "" },
    { model: "@cf/meta/another-model" },
    {
      ts: new Date(
        Date.parse("2026-09-12T00:01:00.000Z") + V048_TARGET_EVAL_CLOCK_SKEW_MS + 1,
      ).toISOString(),
    },
    { model: `model-${"x".repeat(512)}` },
    { est_cost_usd_micros: -1 },
  ]) {
    expectCode(
      () => validateV048TargetEvalLlmAppend(appendInput({
        afterRows: [...beforeRows, llmRow(4, override)],
        afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 4)],
      })),
      "V048_TARGET_EVAL_LLM_APPEND_INVALID",
    );
  }
});

test("a plausible concurrent append and a future-dated row are refused", () => {
  expectCode(
    () => validateV048TargetEvalLlmAppend(appendInput({
      afterRows: [
        ...afterRows,
        llmRow(6, { label: "rag-think", ts: "2026-09-12T00:00:30.000Z" }),
      ],
      afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 6)],
    })),
    "V048_TARGET_EVAL_LLM_APPEND_INVALID",
  );
  expectCode(
    () => validateV048TargetEvalLlmAppend(appendInput({
      afterRows: [
        ...beforeRows,
        llmRow(4, { label: "rag-think", ts: "2026-09-12T00:10:00.001Z" }),
        llmRow(5, { label: "rag-evidence-gate" }),
      ],
    })),
    "V048_TARGET_EVAL_LLM_APPEND_INVALID",
  );
});

test("llm append rejects mutable max-id or filtered sqlite_sequence inconsistencies", () => {
  const cases = [
    { afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 4)] },
    { beforeSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 2)] },
    { afterSequenceRows: [sequence("chunks", 3202), sequence("llm_call_log", 5)] },
    { afterSequenceRows: [sequence("chunks", 6001)] },
    { afterSequenceRows: [
      sequence("chunks", 6001),
      { ...sequence("llm_call_log", 5), seq: "5", seq_type: "text", seq_quote: "'5'" },
    ] },
  ];
  for (const changed of cases) {
    expectCode(
      () => validateV048TargetEvalLlmAppend(appendInput(changed)),
      "V048_TARGET_EVAL_LLM_APPEND_INVALID",
    );
  }
});

test("zero appended rows are valid only when the llm sequence is unchanged", () => {
  const receipt = validateV048TargetEvalLlmAppend(appendInput({
    afterRows: beforeRows,
    afterSequenceRows: beforeSequenceRows,
    expectedCallBounds: {
      ragThink: 0,
      minimumEvidenceGate: 0,
      maximumEvidenceGate: 0,
    },
  }));
  assert.equal(receipt.appended_rows, 0);
  expectCode(
    () => validateV048TargetEvalLlmAppend(appendInput({
      afterRows: beforeRows,
      afterSequenceRows: [sequence("chunks", 6001), sequence("llm_call_log", 4)],
      expectedCallBounds: {
        ragThink: 0,
        minimumEvidenceGate: 0,
        maximumEvidenceGate: 0,
      },
    })),
    "V048_TARGET_EVAL_LLM_APPEND_INVALID",
  );
});
