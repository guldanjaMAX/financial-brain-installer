import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createMigrationStatementIntentStore } from "../operations/migration-statement-intent.mjs";
import { supportRecovery } from "../support-recovery.mjs";

import {
  cloudflareApiRequest,
  cmdMigrate,
  cmdUpgrade,
  MIGRATION_STATEMENT_TIMEOUT_MS,
  runRestartSafeMigrationStatements,
  splitStatements,
  supportErrorCode,
  translatedHttpFailure,
  withWranglerSessionIfNeeded,
} from "../brain.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = join(ROOT, "migrations", "d1");
const MIGRATION_0044_STATEMENTS = splitStatements(readFileSync(
  join(MIGRATIONS, "0044_source_original_result_family_receipts.sql"),
  "utf8",
));
const FIRST_SLOW_ALTER = MIGRATION_0044_STATEMENTS.find((statement) =>
  /^ALTER TABLE chunks ADD COLUMN bound_document_revision_id\b/i.test(statement));
const SECOND_SLOW_ALTER = MIGRATION_0044_STATEMENTS.find((statement) =>
  /^ALTER TABLE chunks ADD COLUMN result_chunk_receipt_hash\b/i.test(statement));
assert.ok(FIRST_SLOW_ALTER);
assert.ok(SECOND_SLOW_ALTER);
const COMPATIBLE_CHUNKS_SQL = `CREATE TABLE chunks (
  chunk_uid TEXT PRIMARY KEY,
  bound_document_revision_id TEXT
    CHECK (bound_document_revision_id IS NULL OR (
      length(bound_document_revision_id) = 71
      AND substr(bound_document_revision_id, 1, 7) = 'rev-v1:'
      AND substr(bound_document_revision_id, 8) = lower(substr(bound_document_revision_id, 8))
      AND substr(bound_document_revision_id, 8) NOT GLOB '*[^0-9a-f]*'
    ))
)`;

function timeoutFailure(cause = new Error("fixture abort")) {
  cause.name = "TimeoutError";
  return translatedHttpFailure(cause, "https://provider.invalid/client/v4/d1", {
    timeoutMs: 300_000,
    what: "the database change",
  });
}

function transportFailure(code, { nested = false } = {}) {
  const cause = new Error(`fixture ${code}`);
  if (nested) {
    cause.cause = Object.assign(new Error("fixture transport cause"), { code });
  } else {
    cause.code = code;
  }
  return {
    cause,
    translated: translatedHttpFailure(cause, "https://provider.invalid/client/v4/d1", {
      timeoutMs: 300_000,
      what: "the database change",
    }),
  };
}

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: async (milliseconds) => { value += milliseconds; },
  };
}

function tableInfo(present = false, type = "TEXT") {
  return {
    results: present
      ? [{ name: "bound_document_revision_id", type, notnull: 0, dflt_value: null }]
      : [],
  };
}

test("cmdMigrate waits for one slow 0044 column and sends its ALTER once", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "migration-slow-command-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      brain: { version: "0.4.1" },
      infrastructure: { cloudflare: { d1_database_id: "fixture-db", storage: "d1" } },
    }));
    const applied = readdirSync(MIGRATIONS)
      .filter((name) => /^00(?:0[1-9]|[1-3][0-9]|4[0-3])_.*\.sql$/.test(name))
      .map((name) => {
        const sql = readFileSync(join(MIGRATIONS, name), "utf8");
        return {
          version: Number(name.slice(0, 4)),
          name: name.replace(/\.sql$/, ""),
          checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16),
        };
      });
    const database = new DatabaseSync(":memory:");
    for (const item of applied) database.exec(readFileSync(join(MIGRATIONS, item.name + ".sql"), "utf8"));
    const scriptedPolls = [tableInfo(), tableInfo(), timeoutFailure(), tableInfo(true)];
    const scriptedPollCount = scriptedPolls.length;
    const calls = [];
    const lines = [];
    const fakeClock = clock();
    let targetInspections = 0;
    const d1Query = async (_account, _database, sql, params = [], requestOptions) => {
      calls.push({ sql: String(sql), params, requestOptions });
      if (/SELECT version, checksum, name FROM schema_migrations/.test(sql)) return { results: applied };
      if (/^PRAGMA table_info\(chunks\)/i.test(sql) && targetInspections++ === 0) return tableInfo();
      if (/^PRAGMA table_info\(chunks\)/i.test(sql) && scriptedPolls.length) {
        const next = scriptedPolls.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      if (/^PRAGMA table_info|^SELECT sql FROM sqlite_master/i.test(sql)) return { results: database.prepare(sql).all() };
      if (requestOptions) database.exec(sql);
      if (String(sql).trim() === FIRST_SLOW_ALTER.trim()) throw timeoutFailure();
      return { results: [] };
    };

    await cmdMigrate(manifestPath, {
      migrationIntentDirectory: join(sandbox, "intents"),
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      d1Query,
      vectorDrainQuiesced: true,
      migrationPoll: {
        pollIntervalMs: 10,
        pollDeadlineMs: 40,
        sleep: fakeClock.sleep,
        now: fakeClock.now,
        log: (line) => lines.push(line),
      },
    });

    const targetAlters = calls.filter((call) => call.sql.trim() === FIRST_SLOW_ALTER.trim());
    assert.equal(targetAlters.length, 1);
    assert.equal(targetInspections, 1 + scriptedPollCount + 2);
    database.close();
    assert.equal(scriptedPolls.length, 0);
    assert.ok(calls.some((call) => /INSERT INTO schema_migrations/.test(call.sql) && call.params[0] === 44));
    assert.ok(lines.some((line) => /still applying a large database change/i.test(line)));
    assert.ok(lines.some((line) => /still applying \(20 ms so far\)/i.test(line)));
    assert.ok(lines.some((line) => /could not check yet; trying again in 10 ms/i.test(line)));
    assert.ok(lines.some((line) => /finished adding chunks\.bound_document_revision_id/i.test(line)));
    assert.doesNotMatch(lines.join("\n"), /VPN|network|timed out/i);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("every shipped ADD COLUMN recovers when the request times out after commit", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "migration-all-intents-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const migrationStatements = readdirSync(MIGRATIONS)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort()
    .flatMap((name) => splitStatements(readFileSync(join(MIGRATIONS, name), "utf8"))
      .map((statement) => ({ name, statement })));
  const addColumns = migrationStatements
    .map((entry, index) => ({ ...entry, index }))
    .filter(({ statement }) => /^\s*ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\b/i.test(statement));
  assert.ok(addColumns.length > 2, "the inventory must exercise more than migration 0044");

  for (const { name, statement, index } of addColumns) {
    const match = statement.match(/^\s*ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i);
    assert.ok(match, name);
    const [, table, column] = match;
    const database = new DatabaseSync(":memory:");
    for (const earlier of migrationStatements.slice(0, index)) database.exec(earlier.statement);
    const fakeClock = clock();
    let alterCalls = 0;
    let inventoryReads = 0;
    try {
      await runRestartSafeMigrationStatements([statement], async (sql) => {
        if (/^PRAGMA table_info/i.test(sql)) {
          inventoryReads++;
          return { results: database.prepare(sql).all() };
        }
        if (/^SELECT sql FROM sqlite_master/i.test(sql)) {
          return { results: database.prepare(sql).all() };
        }
        alterCalls++;
        database.exec(sql);
        throw timeoutFailure();
      }, {
        statementIntent: createMigrationStatementIntentStore({
          directory, accountId: "fixture-account", databaseId: "fixture-db",
          migrationChecksum: createHash("sha256").update(readFileSync(join(MIGRATIONS, name))).digest("hex").slice(0, 16),
        }),
        pollIntervalMs: 1,
        pollDeadlineMs: 2,
        sleep: fakeClock.sleep,
        now: fakeClock.now,
        log: () => {},
      });
      assert.equal(alterCalls, 1, `${name}:${table}.${column}`);
      assert.equal(inventoryReads, 2, `${name}:${table}.${column}`);
      assert.ok(
        database.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column),
        `${name}:${table}.${column}`,
      );
    } finally {
      database.close();
    }
  }
});

test("0044 resumes a partial apply without sending the completed column again", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE chunks (chunk_uid TEXT PRIMARY KEY, title TEXT, text TEXT)");
  database.exec(FIRST_SLOW_ALTER);
  const fakeClock = clock();
  const alters = [];
  const events = [];
  try {
    await runRestartSafeMigrationStatements(
      [FIRST_SLOW_ALTER, SECOND_SLOW_ALTER],
      async (sql) => {
        if (/^PRAGMA table_info/i.test(sql) || /^SELECT sql FROM sqlite_master/i.test(sql)) {
          return { results: database.prepare(sql).all() };
        }
        alters.push(sql);
        database.exec(sql);
        throw timeoutFailure();
      },
      {
        pollIntervalMs: 1,
        pollDeadlineMs: 2,
        sleep: fakeClock.sleep,
        now: fakeClock.now,
        log: () => {},
        afterStatement: (event) => events.push(event),
      },
    );
    assert.deepEqual(alters, [SECOND_SLOW_ALTER]);
    assert.deepEqual(events, [
      { index: 0, statement: FIRST_SLOW_ALTER, skipped: true },
      {
        index: 1,
        statement: SECOND_SLOW_ALTER,
        skipped: true,
        recoveredAfterSlowApply: true,
      },
    ]);
    const columns = database.prepare("PRAGMA table_info(chunks)").all().map((row) => row.name);
    assert.ok(columns.includes("bound_document_revision_id"));
    assert.ok(columns.includes("result_chunk_receipt_hash"));
  } finally {
    database.close();
  }
});

test("translated HTTP failures retain their transport class, cause, code, and wording", () => {
  const timeoutCause = new Error("fixture abort");
  const timeout = timeoutFailure(timeoutCause);
  assert.equal(timeout.transport, "timeout");
  assert.equal(timeout.cause, timeoutCause);
  assert.equal(timeout.code, "NETWORK_UNREACHABLE");
  assert.equal(timeout.retryable, true);
  assert.match(timeout.message, /the database change timed out after 300s/);

  const cases = [
    ["ENOTFOUND", "unresolved", /could not be resolved \(ENOTFOUND\)/],
    ["ECONNREFUSED", "connection", /connection .* failed \(ECONNREFUSED\)/],
    ["CERT_HAS_EXPIRED", "tls", /TLS certificate .* was rejected/],
    ["FIXTURE_OTHER", "other", /database change failed talking/],
  ];
  for (const [code, transport, message] of cases) {
    const failure = transportFailure(code);
    assert.equal(failure.translated.transport, transport);
    assert.equal(failure.translated.cause, failure.cause);
    assert.equal(failure.translated.code, "NETWORK_UNREACHABLE");
    assert.match(failure.translated.message, message);
  }
});

test("unresolved and refused statement requests rethrow unchanged without polling", async () => {
  for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
    const failure = transportFailure(code, { nested: true }).translated;
    let inspections = 0;
    let alters = 0;
    let sleeps = 0;
    let caught = null;
    try {
      await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
        if (/^PRAGMA table_info/i.test(sql)) {
          inspections++;
          return tableInfo();
        }
        alters++;
        throw failure;
      }, {
        pollIntervalMs: 1,
        pollDeadlineMs: 2,
        sleep: async () => { sleeps++; },
      });
    } catch (error) { caught = error; }
    assert.equal(caught, failure, code);
    assert.equal(inspections, 1, code);
    assert.equal(alters, 1, code);
    assert.equal(sleeps, 0, code);
  }
});

test("a deadline with no successful wait read reports network uncertainty", async () => {
  const fakeClock = clock();
  const firstFailure = timeoutFailure();
  const pollFailure = timeoutFailure();
  const lines = [];
  let inspections = 0;
  let alters = 0;
  let error = null;
  try {
    await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) {
        inspections++;
        if (inspections === 1) return tableInfo();
        throw pollFailure;
      }
      alters++;
      throw firstFailure;
    }, {
      pollIntervalMs: 10,
      pollDeadlineMs: 30,
      sleep: fakeClock.sleep,
      now: fakeClock.now,
      log: (line) => lines.push(line),
    });
  } catch (caught) { error = caught; }

  assert.equal(error?.supportCode, "NETWORK_UNREACHABLE");
  assert.equal(error?.cause, firstFailure);
  assert.match(error?.message || "", /could not reach Cloudflare to check on the change for 30 ms/i);
  assert.match(error?.message || "", /may or may not have finished/i);
  assert.match(error?.message || "", /Nothing was lost/i);
  assert.match(error?.message || "", /check the connection/i);
  assert.ok((error?.message || "").includes(renderCliCommands("brain update again")));
  assert.match(error?.message || "", /checks the column first/i);
  assert.match(error?.message || "", /PRAGMA table_info\(chunks\)/);
  assert.equal(inspections, 4);
  assert.equal(alters, 1);
  assert.equal(lines.filter((line) => /could not check yet; trying again in 10 ms/i.test(line)).length, 3);
  assert.equal(lines.filter((line) => /^still applying/i.test(line)).length, 0);
  const updateError = await capturedUpgradeFailure(error);
  assert.equal(updateError.supportCode, "NETWORK_UNREACHABLE");
  assert.match(updateError.message, /PRAGMA table_info\(chunks\)/);
  assert.match(updateError.message, /may or may not have finished/);
});

test("a slow ADD COLUMN deadline has a stable support code and bounded polls", async () => {
  const fakeClock = clock();
  const firstFailure = timeoutFailure();
  let inspections = 0;
  let polls = 0;
  let error = null;
  try {
    await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) {
        inspections++;
        if (inspections > 1) polls++;
        return tableInfo();
      }
      throw firstFailure;
    }, {
      pollIntervalMs: 10,
      pollDeadlineMs: 30,
      sleep: fakeClock.sleep,
      now: fakeClock.now,
      maxPollIterations: 4,
      log: () => {},
    });
  } catch (caught) { error = caught; }

  assert.equal(error?.supportCode, "MIGRATION_STILL_APPLYING");
  assert.equal(error?.cause, firstFailure);
  assert.equal(supportErrorCode(error, { command: "update" }), "MIGRATION_STILL_APPLYING");
  assert.match(error?.message || "", /still applying a large database change/i);
  assert.match(error?.message || "", /chunks\.bound_document_revision_id/);
  assert.match(error?.message || "", /Nothing was lost and nothing needs undoing/);
  assert.match(error?.message || "", /wait about 10 minutes/i);
  assert.ok((error?.message || "").includes(renderCliCommands("brain update")));
  assert.doesNotMatch(error?.message || "", /timed out|VPN|proxy|connection|network/i);
  assert.equal(polls, 3);
});

test("a rerun waits through pre-check failures and skips an already-added column", async () => {
  const fakeClock = clock();
  const inspections = [timeoutFailure(), timeoutFailure(), tableInfo(true)];
  let inventoryReads = 0;
  let alters = 0;
  await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async () => {
    alters++;
    return { results: [] };
  }, {
    inspectStatement: async (sql) => {
      if (/SELECT sql FROM sqlite_master/.test(sql)) {
        return { results: [{ sql: COMPATIBLE_CHUNKS_SQL }] };
      }
      inventoryReads++;
      const next = inspections.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    pollIntervalMs: 10,
    pollDeadlineMs: 30,
    sleep: fakeClock.sleep,
    now: fakeClock.now,
    log: () => {},
  });
  assert.equal(inventoryReads, 3);
  assert.equal(inspections.length, 0);
  assert.equal(alters, 0);
});

test("a rerun sends the ALTER once after a successful absent-column pre-check", async () => {
  const fakeClock = clock();
  const inspections = [timeoutFailure(), tableInfo()];
  let inventoryReads = 0;
  let alters = 0;
  await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
    assert.equal(sql, FIRST_SLOW_ALTER);
    alters++;
    return { results: [] };
  }, {
    inspectStatement: async () => {
      inventoryReads++;
      const next = inspections.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    pollIntervalMs: 10,
    pollDeadlineMs: 20,
    sleep: fakeClock.sleep,
    now: fakeClock.now,
    log: () => {},
  });
  assert.equal(inventoryReads, 2);
  assert.equal(inspections.length, 0);
  assert.equal(alters, 1);
});

test("slow migration support guidance matches the bounded retry contract", () => {
  const recovery = supportRecovery("MIGRATION_STILL_APPLYING");
  assert.equal(recovery.retry, "safe_after_step");
  assert.match(recovery.title, /still applying a database change/i);
  assert.ok(recovery.next_steps.some((step) => /wait about 10 minutes/i.test(step)));
  assert.ok(recovery.next_steps.some((step) => step.includes(renderCliCommands("brain update once more"))));
});

test("a recovered column must pass the same exact CHECK definition", async () => {
  const fakeClock = clock();
  let inspections = 0;
  let definitions = 0;
  let alterations = 0;
  await assert.rejects(
    runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) return tableInfo(++inspections > 1);
      if (/SELECT sql FROM sqlite_master/.test(sql)) {
        definitions++;
        return { results: [{ sql: COMPATIBLE_CHUNKS_SQL.replace("length(bound_document_revision_id) = 71", "length(bound_document_revision_id) = 70") }] };
      }
      alterations++;
      throw timeoutFailure();
    }, {
      pollIntervalMs: 1,
      pollDeadlineMs: 2,
      sleep: fakeClock.sleep,
      now: fakeClock.now,
      log: () => {},
    }),
    /already exists with an incompatible schema/,
  );
  assert.equal(inspections, 2);
  assert.equal(definitions, 1);
  assert.equal(alterations, 1);
});

test("a definitive ADD COLUMN error is returned unchanged without polling", async () => {
  const original = new Error("no such table: chunks");
  let inspections = 0;
  let sleeps = 0;
  let caught = null;
  try {
    await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) {
        inspections++;
        return tableInfo();
      }
      throw original;
    }, { sleep: async () => { sleeps++; } });
  } catch (error) { caught = error; }
  assert.equal(caught, original);
  assert.equal(inspections, 1);
  assert.equal(sleeps, 0);
});

test("a definitive D1 error mentioning offset 512 is returned without polling", async () => {
  const original = new Error("D1 rejected SQL near offset 512");
  let inspections = 0;
  let alters = 0;
  let sleeps = 0;
  let caught = null;
  try {
    await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) {
        inspections++;
        return tableInfo();
      }
      alters++;
      throw original;
    }, {
      pollIntervalMs: 1,
      pollDeadlineMs: 2,
      sleep: async () => { sleeps++; },
    });
  } catch (error) { caught = error; }
  assert.equal(caught, original);
  assert.equal(inspections, 1);
  assert.equal(alters, 1);
  assert.equal(sleeps, 0);
});

test("Cloudflare response errors retain their real HTTP status", async () => {
  const originalFetch = globalThis.fetch;
  const token = "a".repeat(40);
  try {
    for (const fixture of [
      { status: 503, body: "gateway page", expected: /returned non-JSON \(503\)/ },
      {
        status: 524,
        body: JSON.stringify({ success: false, errors: [{ code: 1000, message: "fixture refusal" }] }),
        expected: /failed \(524\)/,
      },
    ]) {
      globalThis.fetch = async () => new Response(fixture.body, { status: fixture.status });
      let error = null;
      try {
        await withWranglerSessionIfNeeded(
          () => cloudflareApiRequest("/accounts"),
          { env: {}, argv: ["--json"], readWranglerOAuthToken: () => token },
        );
      } catch (caught) { error = caught; }
      assert.equal(error?.status, fixture.status);
      assert.match(error?.message || "", fixture.expected);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("duplicate column response is verified and continued without another ALTER", async () => {
  const fakeClock = clock();
  let inspections = 0;
  let alters = 0;
  const events = [];
  await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
    if (/^PRAGMA table_info/i.test(sql)) return tableInfo(++inspections > 1);
    if (/SELECT sql FROM sqlite_master/.test(sql)) return { results: [{ sql: COMPATIBLE_CHUNKS_SQL }] };
    alters++;
    throw new Error("duplicate column name: bound_document_revision_id");
  }, {
    pollIntervalMs: 1,
    pollDeadlineMs: 2,
    sleep: fakeClock.sleep,
    now: fakeClock.now,
    log: () => {},
    afterStatement: (event) => events.push(event),
  });
  assert.equal(alters, 1);
  assert.equal(inspections, 2);
  assert.deepEqual(events, [{
    index: 0,
    statement: FIRST_SLOW_ALTER,
    skipped: true,
    recoveredAfterSlowApply: true,
  }]);
});

test("a normally completed ALTER keeps the existing zero-poll path", async () => {
  const calls = [];
  const events = [];
  await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
    calls.push(sql);
    return tableInfo();
  }, {
    sleep: async () => assert.fail("normal completion must not sleep"),
    afterStatement: (event) => events.push(event),
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^PRAGMA table_info/);
  assert.equal(calls[1], FIRST_SLOW_ALTER);
  assert.deepEqual(events, [{ index: 0, statement: FIRST_SLOW_ALTER, skipped: false }]);
});

test("only migration statements receive the longer request timeout", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "migration-timeout-option-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({
      client: { slug: "fixture" },
      infrastructure: { cloudflare: { d1_database_id: "fixture-db", storage: "d1" } },
    }));
    const calls = [];
    const database = new DatabaseSync(":memory:");
    await cmdMigrate(manifestPath, {
      migrationIntentDirectory: join(sandbox, "intents"),
      silent: true,
      resolveAccount: async () => ({ id: "fixture-account" }),
      vectorDrainQuiesced: true,
      d1Query: async (_account, _database, sql, params = [], requestOptions) => {
        calls.push({ sql: String(sql), params, requestOptions });
        if (/SELECT version, checksum, name FROM schema_migrations/.test(sql)) return { results: [] };
        if (/^PRAGMA table_info|^SELECT sql FROM sqlite_master/i.test(sql)) return { results: database.prepare(sql).all() };
        database.prepare(sql).run(...params);
        return { results: [] };
      },
    });
    database.close();
    const statements = calls.filter((call) =>
      call.requestOptions?.timeoutMs === MIGRATION_STATEMENT_TIMEOUT_MS);
    assert.ok(statements.length > 0);
    assert.ok(statements.some((call) => /^ALTER|^CREATE/i.test(call.sql.trim())));
    assert.ok(calls.filter((call) => /^PRAGMA|sqlite_master/i.test(call.sql.trim()))
      .every((call) => call.requestOptions === undefined));
    assert.ok(calls.filter((call) =>
      /INSERT INTO schema_migrations|SELECT version, checksum, name FROM schema_migrations/.test(call.sql))
      .every((call) => call.requestOptions === undefined));
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a non-ADD transient failure gets honest migration guidance", async () => {
  let error = null;
  let attempts = 0;
  try {
    await runRestartSafeMigrationStatements(
      ["CREATE TABLE IF NOT EXISTS fixture_table (id INTEGER PRIMARY KEY)"],
      async () => { attempts++; throw timeoutFailure(); },
      { migrationName: "0044_fixture", log: () => {} },
    );
  } catch (caught) { error = caught; }
  assert.equal(error?.supportCode, "MIGRATION_STILL_APPLYING");
  assert.equal(attempts, 1);
  assert.match(error?.message || "", /database change 1 of 1 in 0044_fixture/);
  assert.match(error?.message || "", /may still be working/i);
  assert.doesNotMatch(error?.message || "", /safe to repeat|timed out|VPN|proxy|connection|network/i);
});

function upgradeManifest() {
  return {
    client: { slug: "fixture" },
    brain: { version: "0.4.1", worker_name: "fixture-worker" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        d1_database_id: "fixture-db",
        storage: "supabase",
      },
    },
  };
}

async function capturedUpgradeFailure(migrationError, { paused = false, onMigrate = () => {} } = {}) {
  const sandbox = mkdtempSync(join(tmpdir(), "migration-upgrade-message-"));
  try {
    const manifestPath = join(sandbox, "brain.manifest.json");
    const manifest = upgradeManifest();
    if (paused) manifest.infrastructure.cloudflare.storage = "d1";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    let migrationsReached = 0;
    try {
      await cmdUpgrade(manifestPath, {
        resolveAccount: async () => ({ id: "fixture-account" }),
        d1Query: async (_account, _database, sql) => {
          if (/sqlite_master/.test(sql)) return { results: [{ name: "install_state" }] };
          if (/SELECT \* FROM install_state/.test(sql)) {
            return { results: [{ client_slug: "fixture", product_version: "0.4.1", schema_version: 10 }] };
          }
          return { results: [] };
        },
        cf: async () => ({ bookmark: "fixture-bookmark" }),
        readUpdateBacklog: async () => ({ pending: 0 }),
        cmdMigrate: async () => {
          migrationsReached++;
          onMigrate();
          throw migrationError;
        },
        cmdDeploy: paused
          ? async (_path, options) => assert.equal(options?.pauseVectorDrainForUpgrade, true)
          : async () => assert.fail("deployment must not run"),
        cmdHealth: async (_path, options) => assert.equal(options?.expectDrainMode, "paused-for-upgrade"),
        waitForVectorDrainQuiescence: async () => {},
      });
    } catch (error) {
      assert.equal(migrationsReached, 1, "update must reach migration before refusal");
      return error;
    }
    assert.fail("upgrade should fail");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("update preserves slow-migration wording and typed support code", async () => {
  const migrationError = new Error("private slow migration detail");
  migrationError.supportCode = "MIGRATION_STILL_APPLYING";
  const error = await capturedUpgradeFailure(migrationError);
  assert.equal(error?.supportCode, "MIGRATION_STILL_APPLYING");
  assert.ok((error?.message || "").startsWith(
    renderCliCommands("Cloudflare is still applying a large database change. Your Brain is working normally. Nothing was lost. Wait about 10 minutes, then run brain update once more."),
  ));
  assert.match(error?.message || "", /For your installer:/);
  assert.match(error?.message || "", /D1 recovery bookmark: fixture-bookmark/);
});

test("update preserves a direct migration outage as NETWORK_UNREACHABLE", async () => {
  const outage = transportFailure("ENOTFOUND", { nested: true }).translated;
  let migrationCalls = 0;
  const error = await capturedUpgradeFailure(outage, {
    onMigrate: () => { migrationCalls++; },
  });
  assert.equal(migrationCalls, 1);
  assert.equal(error?.supportCode, "NETWORK_UNREACHABLE");
  assert.match(error?.message || "", /could not be resolved \(ENOTFOUND\)/);
  assert.match(error?.message || "", /update stopped during migration/);
});

test("update says documents remain paused only after the pause was installed", async () => {
  const migrationError = new Error("private slow migration detail");
  migrationError.supportCode = "MIGRATION_STILL_APPLYING";
  const error = await capturedUpgradeFailure(migrationError, { paused: true });
  assert.equal(error?.supportCode, "MIGRATION_STILL_APPLYING");
  assert.ok((error?.message || "").startsWith(
    renderCliCommands("Cloudflare is still applying a large database change. Your Brain can still answer questions but won't take new documents until the update finishes. Nothing was lost. Wait about 10 minutes, then run brain update once more."),
  ));
});

test("update installer detail keeps the first slow-migration failure without network advice", async () => {
  const fakeClock = clock();
  const firstFailure = timeoutFailure();
  let migrationError = null;
  try {
    await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async (sql) => {
      if (/^PRAGMA table_info/i.test(sql)) return tableInfo();
      throw firstFailure;
    }, {
      pollIntervalMs: 10,
      pollDeadlineMs: 20,
      sleep: fakeClock.sleep,
      now: fakeClock.now,
      log: () => {},
    });
  } catch (error) { migrationError = error; }

  assert.equal(migrationError?.cause, firstFailure);
  const error = await capturedUpgradeFailure(migrationError);
  const installer = String(error?.message || "").split("For your installer:\n")[1] || "";
  assert.match(installer, /first reply: none within 5 min to the change for chunks\.bound_document_revision_id/i);
  assert.doesNotMatch(installer, /VPN|proxy|check the connection/i);
});

test("ordinary update migration failures keep their existing rendering", async () => {
  const error = await capturedUpgradeFailure(new Error("ordinary migration failure"));
  assert.equal(error?.supportCode, undefined);
  assert.ok((error?.message || "").startsWith(
    renderCliCommands("The update stopped before its last check. Your Brain is working normally and nothing was lost. Run brain update once more; it picks up where it stopped."),
  ));
  assert.match(error?.message || "", /update stopped during migration: ordinary migration failure/);
});

for (const slow of [false, true]) {
  test(`column completion after simulated 90 seconds: slow=${slow}`, async () => {
    let elapsed = 0;
    let writes = 0;
    let reads = 0;
    const events = [];
    await runRestartSafeMigrationStatements(['ALTER TABLE fixture ADD COLUMN value TEXT'], async (sql) => {
      if (sql.startsWith('PRAGMA')) {
        reads++;
        return { results: elapsed >= 90_000 ? [{ name: 'value', type: 'TEXT', notnull: 0, dflt_value: null }] : [] };
      }
      writes++;
      if (slow) throw Object.assign(new Error('fixture timeout'), { name: 'TimeoutError' });
      return { results: [] };
    }, {
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms; },
      pollIntervalMs: 30_000,
      pollDeadlineMs: 120_000,
      afterStatement: (event) => events.push(event),
    });
    assert.equal(writes, 1);
    assert.equal(events.length, 1);
    assert.equal(reads, slow ? 4 : 1);
    assert.equal(elapsed, slow ? 90_000 : 0);
  });
}

for (const version of [49, 50]) {
  for (const ambiguous of [false, true]) {
    test(`cmdMigrate covers migration ${version}, ambiguous=${ambiguous}`, async () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'migration-latest-'));
      const database = new DatabaseSync(':memory:');
      const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
      const applied = [];
      for (const name of migrations.filter((name) => Number(name.slice(0, 4)) < version)) {
        const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
        for (const statement of splitStatements(sql)) database.exec(statement);
        applied.push({ version: Number(name.slice(0, 4)), name: name.slice(0, -4),
          checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16) });
      }
      const manifestPath = join(sandbox, 'brain.manifest.json');
      writeFileSync(manifestPath, JSON.stringify({ client: { slug: 'fixture' },
        infrastructure: { cloudflare: { d1_database_id: 'fixture-db', storage: 'd1' } } }));
      const target = splitStatements(readFileSync(join(MIGRATIONS,
        migrations.find((name) => Number(name.slice(0, 4)) === version)), 'utf8'))[0];
      let targetCalls = 0;
      const receipts = [];
      let caught;
      try {
        await cmdMigrate(manifestPath, {
          migrationIntentDirectory: join(sandbox, "intents"),
          silent: true,
          vectorDrainQuiesced: true,
          resolveAccount: async () => ({ id: 'fixture-account' }),
          d1Query: async (_account, _database, sql, params = [], requestOptions) => {
            if (/SELECT version, checksum, name FROM schema_migrations/.test(sql)) return { results: applied };
            if (/INSERT INTO schema_migrations/.test(sql)) { receipts.push(params[0]); return { results: [] }; }
            // Later migrations may add columns. Their exact readback must use
            // the same SQLite database that accepted the fixture writes.
            if (/^PRAGMA|^SELECT sql FROM sqlite_master/.test(sql)) {
              return { results: database.prepare(sql).all(...params) };
            }
            if (sql === target) {
              targetCalls++;
              assert.equal(requestOptions.timeoutMs, MIGRATION_STATEMENT_TIMEOUT_MS);
              database.exec(sql);
              if (ambiguous) throw timeoutFailure();
              return { results: [] };
            }
            if (requestOptions) { database.exec(sql); return { results: [] }; }
            return { results: [] };
          },
        });
      } catch (error) { caught = error; }
      finally { database.close(); rmSync(sandbox, { recursive: true, force: true }); }
      assert.equal(targetCalls, 1, 'must reach the exact latest migration statement');
      if (ambiguous) {
        assert.equal(caught?.supportCode, 'MIGRATION_STILL_APPLYING');
        assert.ok(caught.message.includes(`00${version}_`));
        assert.deepEqual(receipts, [], 'uncertain completion must not advance the migration receipt');
      } else {
        assert.equal(caught, undefined);
        assert.ok(receipts.includes(version));
        assert.ok(receipts.includes(50));
        assert.deepEqual(receipts, migrations.map((name) => Number(name.slice(0, 4)))
          .filter((pendingVersion) => pendingVersion >= version),
        "every later migration must finish before its receipt is recorded");
      }
    });
  }
}

for(const arm of ['verified-restart-control','interrupted-ambiguous-restart']) {
  test(`BOUNDARY migration ${arm}`,async(t)=>{
    const directory=mkdtempSync(join(tmpdir(),"migration-intent-boundary-"));
    t.after(()=>rmSync(directory,{recursive:true,force:true}));
    const visible=arm==='verified-restart-control';
    let sends=0,inspections=0,verifiedCallbacks=0;
    let interrupt=true;
    const query=async(sql)=>{
      if(/^PRAGMA table_info/.test(sql)) {inspections++;return tableInfo(sends>0&&visible);}
      if(/^SELECT sql FROM sqlite_master/.test(sql))return {results:[{sql:COMPATIBLE_CHUNKS_SQL}]};
      assert.equal(sql,FIRST_SLOW_ALTER);
      sends++;
      throw timeoutFailure();
    };
    const invoke=async()=>{
      const time=clock();
      return runRestartSafeMigrationStatements([FIRST_SLOW_ALTER],query,{
        statementIntent:createMigrationStatementIntentStore({directory,accountId:"fixture-account",databaseId:"fixture-db",migrationChecksum:"fixture-checksum"}),
        pollIntervalMs:1,pollDeadlineMs:2,now:time.now,
        sleep:async(ms)=>{
          if(!visible&&interrupt){interrupt=false;throw new Error('fixture process interrupted');}
          await time.sleep(ms);
        },afterStatement:()=>verifiedCallbacks++,
      });
    };
    if(visible) {
      await invoke();await invoke();
      assert.equal(verifiedCallbacks,2);
      assert.equal(sends,1,'visible exact schema lets a restarted command skip its ALTER');
    } else {
      await assert.rejects(invoke,/fixture process interrupted/);
      assert.equal(sends,1,'first ambiguous write decision reached');
      await assert.rejects(invoke,error=>error.supportCode==='MIGRATION_STILL_APPLYING');
      assert.equal(verifiedCallbacks,0,'neither unverified invocation records statement completion');
      assert.ok(inspections>=3,'restart and follow-up inspections were reached');
      console.log(JSON.stringify({probe:arm,alterSends:sends,verifiedCallbacks,inspections}));
      assert.equal(sends,1,'a restarted command must not resend an ALTER still ambiguous from the previous invocation');
    }
  });
}

test("durable intent is scoped exactly and survives the before-dispatch interruption window", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "migration-intent-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const scope = { directory, accountId: "fixture-account", databaseId: "fixture-db", migrationChecksum: "checksum-one" };
  const first = createMigrationStatementIntentStore(scope);
  assert.equal(first.claim(FIRST_SLOW_ALTER), true);
  const persisted = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]), "utf8"));
  assert.deepEqual(Object.keys(persisted).sort(), ["databaseDigest", "migrationChecksum", "statementDigest", "version"]);
  assert.match(persisted.databaseDigest, /^[a-f0-9]{64}$/);
  assert.equal(persisted.statementDigest, createHash("sha256").update(FIRST_SLOW_ALTER).digest("hex"));
  const restart = createMigrationStatementIntentStore(scope);
  assert.equal(restart.claim(FIRST_SLOW_ALTER), false);
  for (const change of [{ accountId: "other-account" }, { databaseId: "other-db" }, { migrationChecksum: "checksum-two" }]) {
    assert.equal(createMigrationStatementIntentStore({ ...scope, ...change }).has(FIRST_SLOW_ALTER), false);
  }
  assert.equal(restart.has(SECOND_SLOW_ALTER), false);
  let reads = 0, sends = 0, completions = 0;
  const time = clock();
  await assert.rejects(runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async () => { sends++; }, {
    statementIntent: restart,
    inspectStatement: async () => { reads++; return tableInfo(); },
    now: time.now, sleep: time.sleep, pollIntervalMs: 1, pollDeadlineMs: 2,
    afterStatement: () => completions++,
  }), (error) => error.supportCode === "MIGRATION_STILL_APPLYING");
  assert.equal(reads, 3);
  assert.equal(sends, 0);
  assert.equal(completions, 0);
  assert.equal(restart.has(FIRST_SLOW_ALTER), true);
  await runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async () => { sends++; }, {
    statementIntent: createMigrationStatementIntentStore(scope),
    inspectStatement: async (sql) => /^PRAGMA/.test(sql) ? tableInfo(true) : { results: [{ sql: COMPATIBLE_CHUNKS_SQL }] },
    afterStatement: () => completions++,
  });
  assert.equal(sends, 0);
  assert.equal(completions, 1);
  assert.equal(restart.has(FIRST_SLOW_ALTER), false);
});

for (const arm of ["healthy", "non-delivery", "outage", "incompatible", "corrupt"]) {
  test(`durable intent recovery ${arm}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "migration-intent-recovery-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const scope = { directory, accountId: "fixture-account", databaseId: "fixture-db", migrationChecksum: "checksum" };
    let sends = 0, reads = 0, completions = 0;
    const store = () => createMigrationStatementIntentStore(scope);
    const time = clock();
    const invoke = () => runRestartSafeMigrationStatements([FIRST_SLOW_ALTER], async () => {
      sends++;
      assert.equal(store().has(FIRST_SLOW_ALTER), true, "intent must reach disk before dispatch");
      if (arm === "non-delivery") throw transportFailure("ENOTFOUND").translated;
      if (arm !== "healthy") throw timeoutFailure();
    }, {
      statementIntent: store(), pollIntervalMs: 1, pollDeadlineMs: 2, now: time.now, sleep: time.sleep,
      inspectStatement: async (sql) => {
        reads++;
        if (!sends || arm === "non-delivery") return tableInfo();
        if (arm === "outage") throw timeoutFailure();
        if (/^PRAGMA/.test(sql)) return tableInfo(true, arm === "incompatible" ? "INTEGER" : "TEXT");
        return { results: [{ sql: COMPATIBLE_CHUNKS_SQL }] };
      },
      afterStatement: () => completions++,
    });
    if (arm === "corrupt") {
      assert.equal(store().claim(FIRST_SLOW_ALTER), true);
      const [file] = readdirSync(directory);
      writeFileSync(join(directory, file), "{");
      await assert.rejects(invoke, /intent cannot be verified/);
      assert.equal(readdirSync(directory).length, 1);
      assert.equal(sends, 0);
      assert.equal(completions, 0);
      return;
    }
    if (arm === "healthy") {
      await invoke();
      assert.equal(completions, 1);
      assert.equal(reads, 3, "successful delivery still requires exact schema readback");
      assert.equal(store().has(FIRST_SLOW_ALTER), false);
    } else {
      await assert.rejects(invoke, arm === "incompatible" ? /incompatible schema/ :
        arm === "outage" ? /PRAGMA table_info\(chunks\)/ : /ENOTFOUND/);
      assert.equal(completions, 0);
      assert.ok(reads >= 1);
      assert.equal(store().has(FIRST_SLOW_ALTER), arm !== "non-delivery");
      if (arm === "non-delivery") {
        await assert.rejects(invoke, /ENOTFOUND/);
        assert.equal(sends, 2, "authoritative non-delivery permits a new dispatch");
        return;
      }
    }
    assert.equal(sends, 1);
  });
}

test("cmdMigrate restart keeps ambiguous 0044 pending until exact schema proof, then completes every later migration", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "migration-command-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  const applied = [];
  const migrationFiles = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  const pendingVersions = migrationFiles.map((name) => Number(name.slice(0, 4))).filter((version) => version >= 44);
  for (const name of migrationFiles) {
    if (Number(name.slice(0, 4)) >= 44) break;
    const sql = readFileSync(join(MIGRATIONS, name), "utf8");
    database.exec(sql);
    applied.push({ version: Number(name.slice(0, 4)), name: name.slice(0, -4), checksum: createHash("sha256").update(sql).digest("hex").slice(0, 16) });
  }
  const manifest = join(directory, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({ client: { slug: "fixture" }, infrastructure: { cloudflare: { d1_database_id: "fixture-db", storage: "d1" } } }));
  let sends = 0, reads = 0, receipts = 0, interrupt = true;
  const invoke = () => {
    const time = clock();
    return cmdMigrate(manifest, {
      silent: true, resolveAccount: async () => ({ id: "fixture-account" }), vectorDrainQuiesced: true,
      migrationIntentDirectory: join(directory, "intents"),
      migrationPoll: { pollIntervalMs: 1, pollDeadlineMs: 2, now: time.now, sleep: async (ms) => {
        if (interrupt) { interrupt = false; throw new Error("fixture process interrupted"); }
        await time.sleep(ms);
      } },
      d1Query: async (_account, _database, sql, params = []) => {
        if (/SELECT version, checksum, name/.test(sql)) return { results: applied };
        if (sql === FIRST_SLOW_ALTER) { sends++; throw timeoutFailure(); }
        if (/^PRAGMA|^SELECT sql FROM sqlite_master/.test(sql)) { reads++; return { results: database.prepare(sql).all() }; }
        if (/INSERT INTO schema_migrations/.test(sql)) receipts++;
        database.prepare(sql).run(...params);
        return { results: [] };
      },
    });
  };
  await assert.rejects(invoke, /fixture process interrupted/);
  assert.equal(sends, 1);
  await assert.rejects(invoke, (error) => error.supportCode === "MIGRATION_STILL_APPLYING");
  assert.ok(reads >= 4);
  assert.equal(sends, 1);
  assert.equal(receipts, 0);
  database.exec(FIRST_SLOW_ALTER); // The original remote operation finally commits.
  await invoke();
  assert.equal(sends, 1);
  assert.ok(pendingVersions.length >= 8, "the resumed path includes the SimpleFIN revision migration");
  assert.equal(receipts, pendingVersions.length);
  assert.deepEqual(database.prepare("SELECT version FROM schema_migrations WHERE version >= 44 ORDER BY version").all()
    .map((row) => row.version), pendingVersions);
  assert.equal(database.prepare("SELECT max(version) AS version FROM schema_migrations").get().version, pendingVersions.at(-1));
  assert.deepEqual(readdirSync(join(directory, "intents")), []);
});
