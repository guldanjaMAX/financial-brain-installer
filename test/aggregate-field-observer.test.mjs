import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AGGREGATE_FIELD_OBSERVER_D1_SQL,
  AGGREGATE_FIELD_OBSERVER_KIND,
  AGGREGATE_FIELD_OBSERVER_READS,
  AggregateFieldObserverError,
  createAggregateFieldObserver,
  validateAggregateFieldObservation,
} from "../operations/aggregate-field-observer.mjs";

const TARGET_FINGERPRINT = "a".repeat(64);
const OTHER_FINGERPRINT = "b".repeat(64);
const PRIVATE = Object.freeze({
  cursor: "private-client:payroll-ledger#chunk-3000",
  path: "/private/clients/Very Secret Tax Return.pdf",
  providerError: "provider response included account private-account-7744",
  token: `secret-${"Q7".repeat(28)}`,
});

const EXPECTED = Object.freeze({
  target_identity_fingerprint: TARGET_FINGERPRINT,
  documents: 3_201,
  chunks: 3_201,
  fts: 3_201,
});

function stage(overrides = {}) {
  return {
    projection_status: "bootstrap_required",
    bootstrap_protocol: "bootstrap-v2",
    epoch: 1,
    base_count: 0,
    cursor_set: 1,
    high_water_set: 1,
    cursor_position: 3_000,
    high_water_position: 3_201,
    cursor_valid: 1,
    high_water_valid: 1,
    cursor_not_after_high_water: 1,
    high_water_matches_max: 1,
    cursor_matches_batch_end: 1,
    documents: 3_201,
    chunks: 3_201,
    fts: 3_201,
    all_batches: 3,
    current_batches: 3,
    queued_batches: 0,
    submitted_batches: 2,
    confirmed_batches: 1,
    failed_batches: 0,
    batch_rows_total: 3_000,
    queued_batch_rows: 0,
    submitted_batch_rows: 2_000,
    confirmed_batch_rows: 1_000,
    batch_start_position: 0,
    batch_end_position: 3_000,
    batch_sequence_valid: 1,
    batch_chain_breaks: 0,
    batch_row_mismatches: 0,
    foreign_batches: 0,
    outbox_pending: 2_000,
    outbox_queued: 0,
    outbox_submitted: 2_000,
    outbox_failed: 0,
    outbox_retrying: 0,
    foreign_outbox: 0,
    non_upsert_outbox: 0,
    projection_fence_pending: 1,
    ...overrides,
  };
}

function receipt(overrides = {}) {
  return {
    protocol: "bootstrap-v2",
    phase: "building",
    epoch: 1,
    total: 3_201,
    confirmed: 1_000,
    queued: 0,
    submitted: 2_000,
    remaining: 2_201,
    in_flight_batches: 2,
    failed: 0,
    retrying: 0,
    complete: false,
    vector_ready: false,
    expected_vectors: 3_201,
    actual_vectors: 1_000,
    ...overrides,
  };
}

function laterStage(overrides = {}) {
  return stage({
    projection_status: "pending",
    cursor_position: 3_201,
    all_batches: 4,
    current_batches: 4,
    submitted_batches: 1,
    confirmed_batches: 3,
    batch_rows_total: 3_201,
    submitted_batch_rows: 201,
    confirmed_batch_rows: 3_000,
    batch_end_position: 3_201,
    outbox_pending: 201,
    outbox_submitted: 201,
    ...overrides,
  });
}

function completeStage(overrides = {}) {
  return laterStage({
    projection_status: "verified",
    submitted_batches: 0,
    confirmed_batches: 4,
    submitted_batch_rows: 0,
    confirmed_batch_rows: 3_201,
    outbox_pending: 0,
    outbox_submitted: 0,
    projection_fence_pending: 0,
    ...overrides,
  });
}

function completeReceipt(overrides = {}) {
  return receipt({
    phase: "complete",
    confirmed: 3_201,
    queued: 0,
    submitted: 0,
    remaining: 0,
    in_flight_batches: 0,
    retrying: 0,
    complete: true,
    vector_ready: true,
    actual_vectors: 3_201,
    ...overrides,
  });
}

function validate({
  d1Row = stage(),
  bootstrapReceipt = receipt(),
  vectorize = { actual_vectors: 1_000 },
  previous = null,
  identity = TARGET_FINGERPRINT,
  expected = EXPECTED,
} = {}) {
  return validateAggregateFieldObservation({
    expected,
    observedIdentityFingerprint: identity,
    bootstrapReceipt,
    d1Row,
    vectorize,
    previous,
  });
}

function observerCode(task, code) {
  assert.throws(task, (error) => {
    assert.ok(error instanceof AggregateFieldObserverError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    const surface = `${error.name}\n${error.message}\n${error.stack}`;
    for (const value of Object.values(PRIVATE)) assert.equal(surface.includes(value), false);
    return true;
  });
}

async function observerCodeAsync(task, code) {
  await assert.rejects(task, (error) => {
    assert.ok(error instanceof AggregateFieldObserverError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    const surface = `${error.name}\n${error.message}\n${error.stack}`;
    for (const value of Object.values(PRIVATE)) assert.equal(surface.includes(value), false);
    return true;
  });
}

function uid(position) {
  return `private-client:payroll-ledger#chunk-${String(position).padStart(4, "0")}`;
}

function sqliteAggregateFixture(corruptionSql = "") {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE install_state (
      id INTEGER PRIMARY KEY,
      vector_projection_status TEXT,
      vector_projection_bootstrap_protocol TEXT,
      vector_projection_bootstrap_epoch INTEGER,
      vector_projection_bootstrap_base_count INTEGER,
      vector_projection_bootstrap_cursor TEXT,
      vector_projection_bootstrap_high_water TEXT,
      vector_projection_mutation_id TEXT
    );
    CREATE TABLE documents (id TEXT PRIMARY KEY);
    CREATE TABLE chunks (chunk_uid TEXT PRIMARY KEY);
    CREATE TABLE chunks_fts (rowid INTEGER PRIMARY KEY);
    CREATE TABLE vector_bootstrap_batches (
      epoch INTEGER, batch_no INTEGER, start_cursor TEXT, end_cursor TEXT,
      row_count INTEGER, status TEXT
    );
    CREATE TABLE vector_outbox (
      chunk_uid TEXT PRIMARY KEY, submitted_mutation_id TEXT, generation INTEGER,
      attempts INTEGER, op TEXT, bootstrap_epoch INTEGER
    );
    CREATE TABLE vector_outbox_retry_state (
      chunk_uid TEXT, generation INTEGER, quarantined_at INTEGER, attempts INTEGER
    );
    INSERT INTO install_state VALUES (
      1, 'bootstrap_required', 'bootstrap-v2', 1, 0,
      '${uid(3_000)}', '${uid(3_201)}', 'private-provider-mutation-fence'
    );
    INSERT INTO vector_bootstrap_batches VALUES (1,1,'','${uid(1_000)}',1000,'confirmed');
    INSERT INTO vector_bootstrap_batches VALUES (1,2,'${uid(1_000)}','${uid(2_000)}',1000,'submitted');
    INSERT INTO vector_bootstrap_batches VALUES (1,3,'${uid(2_000)}','${uid(3_000)}',1000,'submitted');
    BEGIN;
  `);
  const insertDocument = db.prepare("INSERT INTO documents VALUES (?)");
  const insertChunk = db.prepare("INSERT INTO chunks VALUES (?)");
  const insertFts = db.prepare("INSERT INTO chunks_fts VALUES (?)");
  const insertOutbox = db.prepare(
    "INSERT INTO vector_outbox VALUES (?,?,?,?,?,?)",
  );
  for (let position = 1; position <= 3_201; position++) {
    insertDocument.run(`private-document-${position}`);
    insertChunk.run(uid(position));
    insertFts.run(position);
    if (position > 1_000 && position <= 3_000) {
      insertOutbox.run(
        uid(position),
        `private-provider-mutation-${position <= 2_000 ? 2 : 3}`,
        position,
        0,
        "upsert",
        1,
      );
    }
  }
  if (corruptionSql) db.exec(corruptionSql);
  db.exec("COMMIT; PRAGMA query_only=ON;");
  return db;
}

function queryFixture(corruptionSql = "") {
  const db = sqliteAggregateFixture(corruptionSql);
  try {
    return db.prepare(AGGREGATE_FIELD_OBSERVER_D1_SQL).get();
  } finally {
    db.close();
  }
}

test("the fixed D1 read is query-only and returns no cursor, id, or private detail", () => {
  assert.match(AGGREGATE_FIELD_OBSERVER_D1_SQL, /^WITH\b/);
  assert.doesNotMatch(
    AGGREGATE_FIELD_OBSERVER_D1_SQL,
    /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|VACUUM|PRAGMA)\b/i,
  );
  const db = sqliteAggregateFixture();
  try {
    const row = db.prepare(AGGREGATE_FIELD_OBSERVER_D1_SQL).get();
    assert.deepEqual(Object.keys(row).sort(), Object.keys(stage()).sort());
    assert.equal(row.cursor_position, 3_000);
    assert.equal(row.high_water_position, 3_201);
    assert.equal(row.batch_chain_breaks, 0);
    assert.equal(row.batch_row_mismatches, 0);
    const surface = JSON.stringify(row);
    assert.equal(surface.includes("private-client"), false);
    assert.equal(surface.includes("mutation"), false);
    assert.equal(surface.includes(PRIVATE.cursor), false);
    const observation = validate({ d1Row: row });
    assert.equal(observation.bootstrap.cursor_position, 3_000);
    assert.equal(Object.hasOwn(observation.bootstrap, "cursor"), false);
    assert.equal(Object.hasOwn(observation.bootstrap, "high_water"), false);
    assert.equal(JSON.stringify(observation).includes("private-client"), false);
  } finally {
    db.close();
  }
});

test("the fixed D1 SELECT surfaces durable SQLite corruption before validation", async (t) => {
  const corruptions = [
    {
      name: "a broken durable batch cursor chain",
      sql: `UPDATE vector_bootstrap_batches
               SET start_cursor = '${uid(1_999)}'
             WHERE epoch = 1 AND batch_no = 3`,
      signals: { batch_chain_breaks: 1 },
      code: "FIELD_OBSERVER_COUNTERS_INVALID",
    },
    {
      name: "a falsified durable batch row_count",
      sql: `UPDATE vector_bootstrap_batches
               SET row_count = 999
             WHERE epoch = 1 AND batch_no = 2`,
      signals: { batch_row_mismatches: 1, batch_rows_total: 2_999 },
      code: "FIELD_OBSERVER_COUNTERS_INVALID",
    },
    {
      name: "a foreign-epoch durable batch",
      sql: `INSERT INTO vector_bootstrap_batches
              VALUES (2, 1, '', '${uid(1)}', 1, 'confirmed')`,
      signals: { foreign_batches: 1 },
      code: "FIELD_OBSERVER_MIXED_EPOCH",
    },
    {
      name: "a foreign-epoch durable outbox row",
      sql: `INSERT INTO vector_outbox
              VALUES ('foreign-private-row', 'foreign-private-mutation', 1, 0, 'upsert', 2)`,
      signals: { foreign_outbox: 1 },
      code: "FIELD_OBSERVER_MIXED_EPOCH",
    },
  ];

  for (const corruption of corruptions) {
    await t.test(corruption.name, () => {
      const row = queryFixture(corruption.sql);
      for (const [field, expected] of Object.entries(corruption.signals)) {
        assert.equal(row[field], expected);
      }
      const surface = JSON.stringify(row);
      assert.equal(surface.includes("foreign-private"), false);
      assert.equal(surface.includes(PRIVATE.cursor), false);
      observerCode(() => validate({ d1Row: row }), corruption.code);
    });
  }
});

test("valid observations expose only frozen aggregate progress and complete exact readiness", () => {
  const first = validate();
  assert.equal(first.kind, AGGREGATE_FIELD_OBSERVER_KIND);
  assert.equal(first.aggregate_only, true);
  assert.equal(first.read_only, true);
  assert.equal(first.bootstrap.confirmed, 1_000);
  assert.equal(first.bootstrap.remaining, 2_201);
  assert.equal(first.vectorize.ready, false);
  assert.equal(first.complete, false);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.bootstrap));
  assert.ok(Object.isFrozen(first.outbox));

  const second = validate({
    d1Row: laterStage(),
    bootstrapReceipt: receipt({
      confirmed: 3_000,
      submitted: 201,
      remaining: 201,
      in_flight_batches: 1,
      actual_vectors: 3_000,
    }),
    vectorize: { actual_vectors: 3_000 },
    previous: first,
  });
  assert.equal(second.bootstrap.cursor_position, 3_201);
  assert.equal(second.batches.rows_confirmed, 3_000);

  const done = validate({
    d1Row: completeStage(),
    bootstrapReceipt: completeReceipt(),
    vectorize: { actual_vectors: 3_201 },
    previous: second,
  });
  assert.equal(done.complete, true);
  assert.deepEqual(done.vectorize, { expected: 3_201, actual: 3_201, ready: true });
  assert.equal(JSON.stringify(done).includes(PRIVATE.cursor), false);
});

test("the bracket permits monotonic bootstrap work but keeps corpus and identity fixed", async () => {
  const calls = [];
  const d1Reads = [stage(), laterStage()];
  let identityRead = 0;
  const observer = createAggregateFieldObserver({
    expected: EXPECTED,
    readIdentityAggregate: async (contract) => {
      calls.push(contract);
      assert.equal(Object.isFrozen(contract), true);
      assert.equal(Object.isFrozen(contract.fields), true);
      identityRead++;
      return {
        effect: "read_only",
        redirected: false,
        target_identity_fingerprint: TARGET_FINGERPRINT,
      };
    },
    readD1Aggregate: async (contract) => {
      calls.push(contract);
      assert.equal(contract, AGGREGATE_FIELD_OBSERVER_READS.d1);
      return { effect: "read_only", redirected: false, rows: [d1Reads.shift()] };
    },
    readVectorizeAggregate: async (contract) => {
      calls.push(contract);
      assert.equal(contract, AGGREGATE_FIELD_OBSERVER_READS.vectorize);
      return { effect: "read_only", redirected: false, actual_vectors: 2_500 };
    },
  });
  const observed = await observer.observe({ bootstrapReceipt: receipt(), previous: null });
  assert.equal(observed.bootstrap.cursor_position, 3_201);
  assert.equal(observed.bootstrap.confirmed, 3_000);
  assert.equal(observed.vectorize.actual, 2_500);
  assert.equal(observed.complete, false);
  assert.equal(identityRead, 2);
  assert.deepEqual(calls.map((call) => call.resource), [
    "target_identity", "d1", "vectorize", "d1", "target_identity",
  ]);
});

test("epoch, cursor, and provider progress cannot regress across observations", () => {
  const first = validate();
  const later = validate({
    d1Row: laterStage(),
    bootstrapReceipt: receipt({
      confirmed: 3_000,
      submitted: 201,
      remaining: 201,
      in_flight_batches: 1,
      actual_vectors: 3_000,
    }),
    vectorize: { actual_vectors: 3_000 },
    previous: first,
  });
  observerCode(() => validate({ previous: later }), "FIELD_OBSERVER_PROGRESS_REGRESSION");
  observerCode(() => validate({
    d1Row: laterStage(),
    bootstrapReceipt: receipt({
      confirmed: 3_000,
      submitted: 201,
      remaining: 201,
      in_flight_batches: 1,
      actual_vectors: 2_999,
    }),
    vectorize: { actual_vectors: 2_999 },
    previous: later,
  }), "FIELD_OBSERVER_PROGRESS_REGRESSION");
  observerCode(() => validate({
    d1Row: stage({ epoch: 2 }),
    bootstrapReceipt: receipt({ epoch: 2 }),
    previous: first,
  }), "FIELD_OBSERVER_MIXED_SNAPSHOT");
});

test("mixed epochs, impossible batch totals, and raw fields fail closed", () => {
  observerCode(() => validate({
    d1Row: stage({ all_batches: 4, foreign_batches: 1 }),
  }), "FIELD_OBSERVER_MIXED_EPOCH");
  observerCode(() => validate({
    d1Row: stage({ foreign_outbox: 1 }),
  }), "FIELD_OBSERVER_MIXED_EPOCH");
  observerCode(() => validate({
    d1Row: stage({ batch_rows_total: 2_999 }),
  }), "FIELD_OBSERVER_COUNTERS_INVALID");
  observerCode(() => validate({
    d1Row: { ...stage(), cursor_value: PRIVATE.cursor },
  }), "FIELD_OBSERVER_D1_RESPONSE_INVALID");
  observerCode(() => validate({
    bootstrapReceipt: { ...receipt(), raw_error: PRIVATE.providerError },
  }), "FIELD_OBSERVER_BOOTSTRAP_RECEIPT_INVALID");
  observerCode(() => validate({
    vectorize: { actual_vectors: 1_000, provider_path: PRIVATE.path },
  }), "FIELD_OBSERVER_VECTORIZE_RESPONSE_INVALID");
});

test("the read bracket rejects corpus drift and target identity drift", async () => {
  const makeObserver = ({ rows, identities }) => createAggregateFieldObserver({
    expected: EXPECTED,
    readIdentityAggregate: async () => ({
      effect: "read_only",
      redirected: false,
      target_identity_fingerprint: identities.shift(),
    }),
    readD1Aggregate: async () => ({
      effect: "read_only",
      redirected: false,
      rows: [rows.shift()],
    }),
    readVectorizeAggregate: async () => ({
      effect: "read_only",
      redirected: false,
      actual_vectors: 1_000,
    }),
  });

  await observerCodeAsync(
    () => makeObserver({
      rows: [stage(), stage({ documents: 3_202, chunks: 3_202, fts: 3_202, high_water_position: 3_202 })],
      identities: [TARGET_FINGERPRINT, TARGET_FINGERPRINT],
    }).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_MIXED_SNAPSHOT",
  );
  await observerCodeAsync(
    () => makeObserver({
      rows: [
        stage({ documents: 3_202, chunks: 3_202, fts: 3_202, high_water_position: 3_202 }),
        stage(),
      ],
      identities: [TARGET_FINGERPRINT, TARGET_FINGERPRINT],
    }).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_MIXED_SNAPSHOT",
  );
  await observerCodeAsync(
    () => makeObserver({
      rows: [stage(), stage()],
      identities: [TARGET_FINGERPRINT, OTHER_FINGERPRINT],
    }).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_IDENTITY_MISMATCH",
  );
});

test("redirects, write-shaped reads, and private callback errors are never forwarded", async () => {
  const observerWithIdentity = (identityReader) => createAggregateFieldObserver({
    expected: EXPECTED,
    readIdentityAggregate: identityReader,
    readD1Aggregate: async () => ({ effect: "read_only", redirected: false, rows: [stage()] }),
    readVectorizeAggregate: async () => ({ effect: "read_only", redirected: false, actual_vectors: 1_000 }),
  });

  await observerCodeAsync(
    () => observerWithIdentity(async () => ({
      effect: "read_only",
      redirected: true,
      target_identity_fingerprint: TARGET_FINGERPRINT,
    })).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_REDIRECT_REFUSED",
  );
  await observerCodeAsync(
    () => observerWithIdentity(async () => ({
      effect: "write",
      redirected: false,
      target_identity_fingerprint: TARGET_FINGERPRINT,
    })).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_READ_ONLY_VIOLATION",
  );
  await observerCodeAsync(
    () => observerWithIdentity(async () => {
      throw new Error(`${PRIVATE.providerError} ${PRIVATE.path} ${PRIVATE.token}`);
    }).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_READ_FAILED",
  );
  await observerCodeAsync(
    () => observerWithIdentity(async () => ({
      effect: "read_only",
      redirected: false,
      target_identity_fingerprint: TARGET_FINGERPRINT,
      path: PRIVATE.path,
    })).observe({ bootstrapReceipt: receipt(), previous: null }),
    "FIELD_OBSERVER_IDENTITY_RESPONSE_INVALID",
  );
});

test("the observer exposes no mutation dependency or ambient provider capability", () => {
  observerCode(() => createAggregateFieldObserver({
    expected: EXPECTED,
    readIdentityAggregate: async () => {},
    readD1Aggregate: async () => {},
    readVectorizeAggregate: async () => {},
    write: async () => { throw new Error("must never be accepted"); },
  }), "FIELD_OBSERVER_ARGUMENTS_INVALID");

  const source = readFileSync(new URL("../operations/aggregate-field-observer.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import\s/m);
  assert.doesNotMatch(source, /\b(?:fetch|spawn|execFile|writeFile|readFile|Keychain|Wrangler)\s*\(/);
  assert.equal(Object.isFrozen(AGGREGATE_FIELD_OBSERVER_READS), true);
  assert.equal(Object.isFrozen(AGGREGATE_FIELD_OBSERVER_READS.d1), true);
});
