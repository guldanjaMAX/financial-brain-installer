import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildConfiguredDailyPlan, cmdIngestCalendar, cmdLoad, cmdSources, dailyFreshnessRows, splitStatements } from "../brain.mjs";
import { runDailyRefresh, runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import worker from "../worker/src/index.js";
import { sourceInventory } from "../worker/src/lib/store-d1.js";
import { runZoomDeliveryMaintenance } from "../worker/src/lib/zoom.js";
import { persistZoomDelivery, claimZoomDeliveries, finishZoomDelivery } from "../worker/src/lib/zoom-deliveries.js";
import { providerNoChangeCheckAt } from "../worker/src/lib/source-receipt.js";

const BEFORE = "2026-10-08T12:00:00.000Z";
const NOW = "2026-10-10T12:00:00.000Z";
const ORIGIN = "https://brain.example.invalid";
globalThis.fetch = async () => { throw new Error("unmocked request refused"); };

function fixture(t, { throughMigration = Infinity } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "daily-evidence-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyPath = join(root, ".brain-admin-key");
  writeFileSync(keyPath, "synthetic-owner-proof", { mode: 0o600 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const name of readdirSync(new URL("../migrations/d1/", import.meta.url))
    .filter(n => n.endsWith(".sql") && Number(n.slice(0, 4)) <= throughMigration).sort()) {
    for (const statement of splitStatements(readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8"))) db.exec(statement);
  }
  db.exec("INSERT INTO install_state (id,client_slug,product_version,installed_at) VALUES (1,'owner','0.0.0-test','2026-01-01')");
  db.exec("UPDATE zoom_reconciliation SET window_from='2026-09-10', updated_at_ms=0");
  const seen = { reads: 0, writes: 0, receipts: 0, provider: 0, plans: 0, runs: 0, token: 0, sql: [], runChanges: [] };
  const env = { STORAGE: "d1", ADMIN_KEY: readFileSync(keyPath, "utf8"), DB: {
    prepare(sql) {
      seen.sql.push(sql);
      const shape = (args = []) => ({
        bind: (...values) => shape(values),
        all: async () => { seen.reads++; return { results: db.prepare(sql).all(...args) }; },
        first: async () => { seen.reads++; return db.prepare(sql).get(...args) ?? null; },
        run: async () => {
          seen.writes++;
          // D1 includes trigger writes in meta.changes. SQLite's run().changes
          // excludes them and would hide a committed lease reported as lost.
          const before = db.prepare("SELECT total_changes() AS count").get().count;
          const meta = db.prepare(sql).run(...args);
          const changes = db.prepare("SELECT total_changes() AS count").get().count - before;
          seen.runChanges.push({ sql, changes });
          return { meta: { ...meta, changes } };
        },
      });
      return shape();
    },
    batch: async statements => Promise.all(statements.map(s => s.run())),
  } };
  const call = request => worker.fetch(request, env, { waitUntil() {} });
  const postReceipt = async body => {
    seen.receipts++;
    const response = await call(new Request(`${ORIGIN}/api/admin/brain/source-receipt`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_KEY }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200, "the real Worker receipt route accepted the synthetic run");
    return response.json();
  };
  return { root, keyPath, db, env, seen, call, postReceipt };
}

async function dailyCase(t, { mutate = x => x, inventoryMutation = x => x, runMutation = x => x,
  priorAt = BEFORE, skip = false, emptyPlan = false, providerFailure = false,
  providerPages = [{ items: [], nextSyncToken: "synthetic-next" }], calendarState = {} } = {}) {
  const f = fixture(t);
  const m = { client: { slug: "owner", timezone: "UTC" }, brain: { domain: "brain.example.invalid" },
    corpora: { calendar: { enabled: true }, upload: { enabled: false } }, operations: { daily_refresh: { enabled: true, timezone: "UTC" } },
    calendar: { calendars: ["primary"], maxRetries: 0 } };
  const manifestPath = join(f.root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(m));
  await f.postReceipt({ source: "calendar", kind: "calendar", status: "ready", run_id: "prior", lane: "manual",
    started_at: priorAt, completed_at: priorAt, walk_complete: true, files_seen: 1,
    docs_added: 1, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 0 });
  const commands = { ingestCalendar: (manifest, path, flags) => cmdIngestCalendar(manifest, path, flags, {
    withSourceIngestLock: async (_options, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => ORIGIN,
    resolveAdminKey: () => readFileSync(f.keyPath, "utf8"),
    getAccessToken: async () => "synthetic-provider-proof",
    fetchImpl: async url => {
      assert.equal(new URL(url).hostname, "www.googleapis.com");
      if (calendarState.primary?.sync_token) assert.equal(new URL(url).searchParams.get("syncToken"), calendarState.primary.sync_token);
      f.seen.provider++;
      assert.ok(providerFailure || providerPages.length > 0, "provider fixture pages cannot silently repeat");
      return Response.json(providerFailure ? { error: { message: "fixture failure" } } : providerPages.shift(),
        { status: providerFailure ? 403 : 200 });
    },
    loadCalendarState: () => calendarState, saveCalendarState() {},
    postSourceReceipt: async (_base, _key, row) => f.postReceipt(mutate(row)),
  }) };
  const probes = { calendar: async () => ({ connected: true }) };
  const buildPlan = async (...args) => {
    f.seen.plans++;
    const plan = await buildConfiguredDailyPlan(...args);
    assert.equal(plan.sources.filter(s => s.status === "ready").length, 1, "the real planner reached the selected provider");
    return emptyPlan ? { ...plan, sources: [] } : plan;
  };
  const brainModule = {
    cmdSources: async (path, options) => {
      const result = await cmdSources(path, { ...options, resolveAdminKey: () => readFileSync(f.keyPath, "utf8"),
        fetchImpl: (_url, init) => f.call(new Request(`${ORIGIN}/api/admin/brain/sources`, init)) });
      return f.seen.runs ? inventoryMutation(result) : result;
    },
    cmdLoad: async (path, options) => {
      f.seen.runs++;
      if (skip) return { status: "skipped" };
      return runMutation(await cmdLoad(path, { ...options, commands, probes, log() {} }));
    },
  };
  // Keep synthetic fixture values and connector chatter out of test output.
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", () => {});
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule, buildPlan, planOptions: { commands, probes }, existingSchedulerOwners: [],
    principal: "uid:fixture", platform: "darwin", localTimezone: "UTC", home: f.root,
    acquireLock: () => ({ assertOwned() {}, release() {} }), readUpdateTransaction: () => null,
    writeReceipt() {}, appendObservation() {}, silent: true,
  });
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  return { ...f, result, inventory, manifestPath, readSources: options => brainModule.cmdSources(manifestPath, options) };
}

for (const [name, page] of [
  ["missing page shape", {}], ["missing events", { nextSyncToken: "synthetic-next" }],
  ["malformed events", { items: {}, nextSyncToken: "synthetic-next" }],
  ["string events", { items: "", nextSyncToken: "synthetic-next" }],
  ["missing terminal token", { items: [] }],
  ["malformed terminal token", { items: [], nextSyncToken: {} }],
  ["empty terminal token", { items: [], nextSyncToken: "" }],
  ["malformed page token", { items: [], nextPageToken: 1, nextSyncToken: "synthetic-next" }],
  ["conflicting tokens", { items: [], nextPageToken: "synthetic-page", nextSyncToken: "synthetic-next" }],
]) {
  test(`Calendar completion evidence refuses ${name}`, async t => {
    const f = await dailyCase(t, { providerPages: [page] });
    assert.equal(f.seen.provider, 1);
    assert.equal(f.seen.runs, 1);
    assert.equal(f.seen.receipts, 3, "the terminal decision reached the durable receipt route");
    assert.equal(f.result.status, "failed");
    assert.equal(f.result.sources[0].check_verified, false);
    assert.equal(f.inventory.rows[0].receipt.last_ingest_receipt_at, BEFORE);
    if (name === "empty terminal token") {
      assert.equal(f.inventory.rows[0].receipt.status, "error", "an explicit invalid token is a malformed page");
    }
  });
}

test("Calendar quiet incremental completion has its own durable proof without full history", async t => {
  const f = await dailyCase(t, { calendarState: { primary: { sync_token: "synthetic-prior" } } });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.seen.receipts, 3);
  assert.equal(f.result.status, "complete");
  assert.equal(f.inventory.rows[0].receipt.latest_run.provider_check_complete, true);
  assert.equal(f.inventory.rows[0].receipt.complete_history_through, null);
  assert.equal(f.inventory.rows[0].receipt.last_ingest_receipt_at, BEFORE);
});

test("Calendar legacy walk completion cannot stand in for terminal provider proof", async t => {
  const f = await dailyCase(t, { mutate: ({ provider_check_complete, ...row }) => row });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.seen.receipts, 3);
  assert.equal(f.result.status, "failed");
  assert.equal(f.result.sources[0].check_verified, false);
});

test("a later legacy failure stays visible after a quiet Calendar check", async t => {
  const f = await dailyCase(t);
  const project = rows => dailyFreshnessRows({ sources: [{ key: "calendar" }] }, { sources: rows, as_of: NOW })[0];
  assert.equal(project(f.inventory.rows).current_state, "checked", "quiet green control");
  await f.postReceipt({ source: "calendar", kind: "calendar", status: "error",
    completed_at: "2026-10-10T12:00:01.000Z" });
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) + 1000 });
  assert.equal(f.seen.receipts, 4);
  assert.equal(inventory.rows[0].receipt.status, "error");
  assert.equal(inventory.rows[0].freshness.state, "broken");
  assert.equal(inventory.rows[0].receipt.latest_run.outcome, "empty");
  const lines = [];
  t.mock.method(console, "log", line => lines.push(String(line)));
  await f.readSources({ flags: {} });
  assert.match(lines.join("\n"), /calendar\s+calendar[^\n]+broken/);
  assert.equal(project(inventory.rows).current_state, "broken");
  assert.equal(project(inventory.rows).last_check_at, NOW, "retain separate earlier check evidence");
});

for (const throughMigration of [53, Infinity]) {
  const schema = throughMigration === 53 ? "legacy green control" : "current migrations";
  test(`D1 trigger-inclusive delivery claim succeeds with ${schema}`, async t => {
    const f = fixture(t, { throughMigration });
    const nowMs = Date.parse(NOW);
    await persistZoomDelivery(f.env, { uuid: "synthetic-claim", eventType: "recording.completed", receivedAtMs: nowMs });
    const claimed = await claimZoomDeliveries(f.env, { nowMs, ownerToken: "synthetic-lease" });
    const writes = f.seen.runChanges.filter(row => /UPDATE zoom_deliveries/.test(row.sql));
    assert.equal(writes.length, 1, "one candidate reached the conditional claim update");
    assert.equal(f.db.prepare("SELECT status FROM zoom_deliveries").get().status, "processing", "claim committed");
    assert.equal(claimed.length, 1, "a committed lease must not be silently skipped");
    assert.equal(writes[0].changes, 1, "claim changes must remain exact under D1 semantics");
  });

  test(`D1 trigger-inclusive delivery outcome succeeds with ${schema}`, async t => {
    const f = fixture(t, { throughMigration });
    const nowMs = Date.parse(NOW);
    await persistZoomDelivery(f.env, { uuid: "synthetic-outcome", eventType: "recording.completed", receivedAtMs: nowMs });
    // Seed the lease so a broken claim cannot prevent reaching the outcome CAS.
    f.db.prepare("UPDATE zoom_deliveries SET status='processing',lease_owner='synthetic-lease',lease_expires_at_ms=?")
      .run(nowMs + 1000);
    let outcomeError;
    try {
      await finishZoomDelivery(f.env, { recording_uuid: "synthetic-outcome", ownerToken: "synthetic-lease" },
        { outcome: { kind: "completed" }, nowMs });
    } catch (error) { outcomeError = error; }
    const writes = f.seen.runChanges.filter(row => /UPDATE zoom_deliveries/.test(row.sql));
    assert.equal(writes.length, 1, "the leased delivery reached the conditional outcome update");
    assert.equal(f.db.prepare("SELECT status FROM zoom_deliveries").get().status, "completed", "outcome committed");
    assert.equal(outcomeError, undefined, "a committed outcome must not report a lost lease");
    assert.equal(writes[0].changes, 1, "outcome changes must remain exact under D1 semantics");
  });
}

test("Zoom inventory groups retained deliveries through the covering status index", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.row.receipt.zoom.state, "checked", "quiet green control");
  f.db.exec(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<2000)
    INSERT INTO zoom_deliveries
      (recording_uuid,event_type,received_at_ms,status,next_attempt_at_ms,created_at_ms,updated_at_ms,completed_at_ms)
    SELECT 'synthetic-'||n,'recording.completed',0,'completed',0,0,0,0 FROM ids`);
  f.seen.sql.length = 0;
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(inventory.rows[0].receipt.zoom.deliveries.completed, 2000);
  const queries = f.seen.sql.filter(sql => /zoom_deliver/.test(sql));
  assert.ok(queries.length > 0, "the inventory reached delivery evidence");
  for (const sql of queries) {
    const plan = f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join("\n");
    assert.match(plan, /SCAN zoom_deliveries USING COVERING INDEX zoom_deliveries_status/);
    assert.doesNotMatch(plan, /TEMP B-TREE/);
  }
});

test("Zoom source failures take precedence over reconciliation in daily and source text", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.row.receipt.zoom.state, "checked");
  await f.postReceipt({ source: "zoom", kind: "zoom", status: "error", completed_at: NOW });
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  const row = inventory.rows[0];
  assert.equal(f.seen.receipts, 1);
  assert.equal(row.freshness.state, "broken");
  assert.equal(row.receipt.zoom.state, "checked", "separate reconciliation evidence remains available");
  const [daily] = dailyFreshnessRows({ sources: [{ key: "zoom", class: "push" }] }, { sources: [row], as_of: NOW });
  assert.equal(daily.current_state, "broken");
  assert.equal(daily.last_check_at, NOW);
  const manifestPath = join(f.root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({ brain: { domain: "brain.example.invalid" } }));
  const lines = [];
  t.mock.method(console, "log", line => lines.push(String(line)));
  await cmdSources(manifestPath, { flags: {}, resolveAdminKey: () => readFileSync(f.keyPath, "utf8"),
    fetchImpl: (_url, init) => f.call(new Request(`${ORIGIN}/api/admin/brain/sources`, init)) });
  assert.match(lines.join("\n"), /zoom\s+zoom[^\n]+broken/);
});

test("Zoom delivery totals follow real claims, duplicates, retries, failures, rollback and deletion", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  const nowMs = Date.parse(NOW);
  const checkCounts = async expected => {
    const inventory = await sourceInventory(f.env, { now: nowMs });
    const deliveries = inventory.rows[0].receipt.zoom.deliveries;
    assert.equal(inventory.rows[0].receipt.zoom.counts_available, true);
    for (const [status, count] of Object.entries(deliveries)) assert.equal(count, expected[status] || 0, status);
  };
  await checkCounts({});
  for (const status of ["completed", "refused", "unavailable", "retryable"]) {
    const delivery = { uuid: `synthetic-${status}`, eventType: "recording.completed", receivedAtMs: nowMs };
    await persistZoomDelivery(f.env, delivery);
    await persistZoomDelivery(f.env, delivery);
    const claimed = await claimZoomDeliveries(f.env, { nowMs, ownerToken: "synthetic-lease" });
    assert.equal(claimed.length, 1, "duplicate webhook creates exactly one claim");
    await finishZoomDelivery(f.env, claimed[0], { outcome: { kind: status }, nowMs, retryDelayMs: 1000 });
  }
  await checkCounts({ completed: 1, refused: 1, unavailable: 1, retryable: 1 });
  f.db.exec("BEGIN");
  await persistZoomDelivery(f.env, { uuid: "synthetic-rollback", eventType: "recording.completed", receivedAtMs: nowMs });
  await checkCounts({ completed: 1, refused: 1, unavailable: 1, retryable: 1, pending: 1 });
  f.db.exec("ROLLBACK");
  await checkCounts({ completed: 1, refused: 1, unavailable: 1, retryable: 1 });
  const claimed = await claimZoomDeliveries(f.env, { nowMs: nowMs + 1000, ownerToken: "synthetic-next-lease" });
  assert.equal(claimed.length, 1);
  await checkCounts({ completed: 1, refused: 1, unavailable: 1, processing: 1 });
  const writes = f.seen.writes;
  await assert.rejects(finishZoomDelivery(f.env, { ...claimed[0], ownerToken: "synthetic-wrong-lease" },
    { outcome: { kind: "completed" }, nowMs }), /lease was lost/);
  assert.equal(f.seen.writes, writes + 1, "the refused lease reached its conditional update");
  await checkCounts({ completed: 1, refused: 1, unavailable: 1, processing: 1 });
  await finishZoomDelivery(f.env, claimed[0], { outcome: { kind: "completed" }, nowMs });
  await checkCounts({ completed: 2, refused: 1, unavailable: 1 });
  f.db.exec("DELETE FROM zoom_deliveries WHERE status='completed'");
  await checkCounts({ refused: 1, unavailable: 1 });
});

test("daily evidence migration indexes retained debt and legacy readers cannot fabricate new proof", async t => {
  const f = fixture(t, { throughMigration: 53 });
  f.db.exec("INSERT INTO sources (name,kind,status,created_at) VALUES ('zoom','zoom','ready','2026-01-01')");
  Object.assign(f.env, { ZOOM_ACCOUNT_ID: "synthetic-account", ZOOM_CLIENT_ID: "synthetic-client",
    ZOOM_CLIENT_SECRET: "synthetic-secret", ZOOM_WEBHOOK_SECRET_TOKEN: "synthetic-webhook" });
  await persistZoomDelivery(f.env, { uuid: "synthetic-existing", eventType: "recording.completed", receivedAtMs: Date.parse(NOW) });
  const legacy = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(legacy.rows[0].receipt.zoom.state, "unknown");
  assert.equal(legacy.rows[0].receipt.zoom.counts_available, false);
  assert.equal(legacy.rows[0].receipt.zoom.deliveries.pending, null);
  assert.ok(f.seen.sql.some(sql => /0 AS provider_check_complete/.test(sql)), "legacy column fallback reached");
  assert.ok(f.seen.sql.some(sql => /INDEXED BY zoom_deliveries_status/.test(sql)), "legacy index lookup reached");
  const migration = readFileSync(new URL("../migrations/d1/0054_daily_evidence.sql", import.meta.url), "utf8");
  for (const statement of splitStatements(migration)) f.db.exec(statement);
  const upgraded = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(upgraded.rows[0].receipt.zoom.deliveries.pending, 1);
  assert.equal(upgraded.rows[0].receipt.zoom.counts_available, true);
  assert.equal(upgraded.rows[0].receipt.zoom.state, "pending");
  // The migration runner skips an already present column on an interrupted
  // retry. Every following statement must remain safe to replay as it does.
  for (const statement of splitStatements(migration).slice(1)) f.db.exec(statement);
  const replayed = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.deepEqual(replayed.rows[0].receipt.zoom, upgraded.rows[0].receipt.zoom);
});

test("non-Zoom inventory never requests Zoom totals", async t => {
  const f = await dailyCase(t);
  assert.equal(f.result.status, "complete");
  f.seen.sql.length = 0;
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(inventory.rows.length, 1, "nonempty inventory green control");
  assert.ok(f.seen.sql.length > 0);
  assert.equal(f.seen.sql.some(sql => /zoom_deliver/.test(sql)), false);
});

test("Zoom migration captures deliveries arriving between independently committed statements", async t => {
  const f = fixture(t, { throughMigration: 53 });
  f.db.exec("INSERT INTO sources (name,kind,status,created_at) VALUES ('zoom','zoom','ready','2026-01-01')");
  const statements = splitStatements(readFileSync(new URL("../migrations/d1/0054_daily_evidence.sql", import.meta.url), "utf8"));
  let arrivals = 0;
  for (const statement of statements) {
    f.db.exec(statement);
    arrivals++;
    await persistZoomDelivery(f.env, { uuid: `synthetic-arrival-${arrivals}`, eventType: "recording.completed", receivedAtMs: Date.parse(NOW) });
  }
  assert.ok(arrivals > 1, "every migration boundary received a real delivery write");
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(inventory.rows[0].receipt.zoom.deliveries.pending, arrivals);
});

test("Zoom incomplete migration reports unknown totals until the index exists", async t => {
  const f = fixture(t, { throughMigration: 53 });
  f.db.exec("INSERT INTO sources (name,kind,status,created_at) VALUES ('zoom','zoom','ready','2026-01-01')");
  const statements = splitStatements(readFileSync(new URL("../migrations/d1/0054_daily_evidence.sql", import.meta.url), "utf8"));
  for (const statement of statements.slice(0, -1)) f.db.exec(statement);
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(inventory.rows.length, 1);
  assert.ok(f.seen.sql.some(sql => /INDEXED BY zoom_deliveries_status/.test(sql)), "index decision reached");
  assert.equal(inventory.rows[0].receipt.zoom.counts_available, false);
  f.db.exec(statements.at(-1));
  const complete = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(complete.rows[0].receipt.zoom.counts_available, true, "completed migration green control");
});

test("daily evidence migration adds no delivery triggers or counter table", t => {
  const f = fixture(t);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('sync_runs') WHERE name='provider_check_complete'")
    .get().count, 1, "current migration reached and added its provider proof column");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='index' AND name='zoom_deliveries_status'")
    .get().count, 1, "covering index green control");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND tbl_name='zoom_deliveries'")
    .get().count, 0, "all applied migrations must preserve exact delivery write receipts");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='zoom_delivery_counts'")
    .get().count, 0);
});

test("Zoom malformed count evidence stays unknown after the aggregate is reached", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.row.receipt.zoom.counts_available, true, "valid empty aggregate green control");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let aggregates = 0;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (/INDEXED BY zoom_deliveries_status/.test(sql)) {
      const all = statement.all;
      statement.all = async () => {
        await all();
        aggregates++;
        return { results: [{ status: "pending", count: -1 }] };
      };
    }
    return statement;
  };
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(aggregates, 1);
  assert.equal(inventory.rows[0].receipt.zoom.counts_available, false);
  assert.equal(inventory.rows[0].receipt.zoom.deliveries.pending, null);
  assert.equal(inventory.rows[0].receipt.zoom.state, "unknown");
});

test("Zoom aggregate storage failures propagate after the indexed decision is reached", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.row.receipt.zoom.state, "checked", "indexed quiet green control");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let aggregates = 0;
  f.env.DB.prepare = sql => {
    const statement = prepare(sql);
    if (/INDEXED BY zoom_deliveries_status/.test(sql)) {
      const all = statement.all;
      statement.all = async () => {
        await all();
        aggregates++;
        throw new Error("synthetic storage read failure");
      };
    }
    return statement;
  };
  const outcome = await sourceInventory(f.env, { now: Date.parse(NOW) })
    .then(() => null, error => error);
  assert.equal(aggregates, 1);
  assert.match(outcome?.message || "", /synthetic storage read failure/);
});

for (const [name, options] of [
  ["static upload", { inventoryMutation: body => ({ ...body, sources: body.sources.map(row => ({ ...row, kind: "upload" })) }) }],
  ["borrowed ingest", { inventoryMutation: body => ({ ...body, sources: body.sources.map(row => ({ ...row,
    receipt: { ...row.receipt, last_successful_run_at: NOW } })) }) }],
  ["failed invocation", { runMutation: result => ({ ...result, status: "failed" }) }],
  ["skipped selected leg", { runMutation: result => ({ ...result,
    entries: result.entries.map(entry => ({ ...entry, status: "skipped" })) }) }],
  ["missing selected leg", { runMutation: result => ({ ...result, entries: [] }) }],
  ["unreached invocation", { runMutation: result => ({ ...result, loaded: 0 }) }],
  ["replayed check time", { priorAt: NOW }],
]) {
  test(`daily rejects ${name} at the evidence boundary`, async t => {
    const f = await dailyCase(t, options);
    assert.equal(f.seen.provider, 1);
    assert.equal(f.seen.receipts, 3);
    assert.equal(f.result.status, "failed");
    assert.equal(f.result.sources[0].check_verified, false);
  });
}

test("provider check validator requires every terminal field independently", () => {
  const run = { outcome: "empty", walk_complete: true, provider_check_complete: true, metrics_version: 1,
    files_seen: 0, docs_added: 0, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 0,
    started_at: NOW, finished_at: NOW };
  let decisions = 0;
  for (const kind of ["drive", "gmail", "imap", "calendar"]) {
    decisions++;
    assert.equal(providerNoChangeCheckAt(kind, run), NOW);
  }
  for (const [field, value] of [["outcome", "failed"], ["walk_complete", false], ["metrics_version", 0],
    ...["files_seen", "docs_added", "docs_updated", "docs_unchanged", "docs_refused", "docs_failed"].map(field => [field, 1]),
    ["started_at", null], ["finished_at", null], ["finished_at", BEFORE]]) {
    decisions++;
    assert.equal(providerNoChangeCheckAt("calendar", { ...run, [field]: value }), null, field);
  }
  assert.equal(providerNoChangeCheckAt("upload", run), null);
  assert.equal(decisions, 16, "all validator decisions and green provider controls ran");
});

test("daily quiet control reaches Calendar enumeration, Worker receipt and CLI inventory without inventing ingest", async t => {
  const f = await dailyCase(t);
  assert.equal(f.seen.plans, 1);
  assert.equal(f.seen.runs, 1);
  assert.equal(f.seen.provider, 1, "real provider pagination terminated on its completion token");
  assert.equal(f.seen.receipts, 3, "prior, started and terminal receipts reached the Worker");
  assert.ok(f.seen.writes > 0);
  assert.equal(f.result.status, "complete");
  const receipt = f.result.sources[0];
  assert.equal(receipt.check_verified, true);
  assert.equal(receipt.no_change, true);
  assert.equal(receipt.last_check_at_after, NOW);
  assert.equal(receipt.freshness_advanced, false);
  assert.equal(receipt.last_successful_run_at_after, BEFORE);
  assert.equal(f.inventory.rows[0].receipt.last_check_at, NOW);
  assert.equal(f.inventory.rows[0].receipt.last_ingest_receipt_at, BEFORE);
  assert.equal(f.inventory.rows[0].receipt.complete_history_through, null);
  const [status] = dailyFreshnessRows({ sources: [{ key: "calendar" }] }, { sources: f.inventory.rows, as_of: NOW });
  assert.equal(status.current_state, "checked");
  assert.equal(status.last_check_at, NOW);
  assert.equal(status.last_run_outcome, "no_change");
  const lines = [];
  t.mock.method(console, "log", line => lines.push(String(line)));
  await f.readSources({ flags: {} });
  assert.match(lines.join("\n"), /checked \(no changes\)/);
  assert.match(lines.join("\n"), /last ingest 2026-10-08T12:00:00.000Z/);
});

for (const [name, mutate] of [
  ["unfinished walk", row => ({ ...row, walk_complete: false })],
  ["unmeasured outcomes", ({ docs_failed, ...row }) => row],
  ["refused document", row => ({ ...row, docs_refused: 1 })],
  ["failed document", row => ({ ...row, docs_failed: 1 })],
  ["unaccounted seen item", row => ({ ...row, files_seen: 1 })],
  ["stale completion", row => ({ ...row, started_at: BEFORE, completed_at: BEFORE })],
  ["pre-invocation start", row => ({ ...row, started_at: BEFORE })],
  ["future completion", row => ({ ...row, completed_at: "2026-10-11T12:00:00.000Z" })],
  ["inverted times", row => ({ ...row, started_at: "2026-10-11T12:00:00.000Z" })],
]) {
  test(`daily refuses ${name} after provider and receipt decisions`, async t => {
    const f = await dailyCase(t, { mutate });
    assert.equal(f.seen.provider, 1);
    assert.equal(f.seen.receipts, 3);
    assert.equal(f.seen.runs, 1);
    assert.equal(f.result.status, "failed");
    assert.notEqual(f.result.sources[0].check_verified, true);
  });
}

for (const [name, options] of [["skipped invocation", { skip: true }], ["empty plan", { emptyPlan: true }],
  ["provider failure", { providerFailure: true }]]) {
  test(`daily refuses ${name} without borrowing prior success`, async t => {
    const f = await dailyCase(t, options);
    assert.equal(f.seen.plans, 1, "selected source was constructed before the negative arm");
    assert.equal(f.seen.runs, options.emptyPlan ? 0 : 1);
    assert.equal(f.seen.provider, options.providerFailure ? 1 : 0);
    assert.equal(f.result.status, "failed");
  });
}

async function zoomCase(t, { credentials = true, pages = [{}], debt = false } = {}) {
  const f = fixture(t);
  f.db.exec("INSERT INTO sources (name,kind,status,created_at) VALUES ('zoom','zoom','ready','2026-01-01')");
  if (credentials) Object.assign(f.env, { ZOOM_ACCOUNT_ID: "synthetic-account", ZOOM_CLIENT_ID: "synthetic-client",
    ZOOM_CLIENT_SECRET: "synthetic-secret", ZOOM_WEBHOOK_SECRET_TOKEN: "synthetic-webhook" });
  if (debt) await persistZoomDelivery(f.env, { uuid: "synthetic-recording", eventType: "recording.completed", receivedAtMs: Date.parse(NOW) + 1000 });
  const result = await runZoomDeliveryMaintenance(f.env, { now: () => Date.parse(NOW), maxPages: 1,
    fetchImpl: async url => {
      if (new URL(url).pathname === "/oauth/token") { f.seen.token++; return Response.json({ access_token: "synthetic-access" }); }
      assert.equal(new URL(url).pathname, "/v2/users/me/recordings");
      f.seen.provider++;
      return Response.json(pages.shift());
    },
  });
  const beforeReads = f.seen.reads;
  const beforeWrites = f.seen.writes;
  const response = await f.call(new Request(`${ORIGIN}/api/admin/brain/sources`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": f.env.ADMIN_KEY }, body: "{}",
  }));
  assert.equal(response.status, 200);
  const inventory = await response.json();
  assert.ok(f.seen.reads > beforeReads, "source status read the durable state");
  assert.equal(f.seen.writes, beforeWrites, "status does not write or advance evidence");
  assert.equal(inventory.sources.length, 1);
  return { ...f, result, row: inventory.sources[0] };
}

test("Zoom quiet reconciliation is visible without ingest or complete history", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [], next_page_token: "" }] });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.seen.token, 1);
  assert.equal(f.result.reconciliation.completeWindow, true);
  assert.equal(f.row.receipt.zoom.state, "checked");
  assert.equal(f.row.receipt.zoom.last_check_at, NOW);
  assert.equal(f.row.receipt.zoom.history.state, "unproven");
  assert.equal(f.row.receipt.last_ingest_receipt_at, null);
  assert.equal(f.row.receipt.complete_history_through, null);
  assert.deepEqual(f.row.receipt.zoom.deliveries, { pending: 0, processing: 0, retryable: 0, completed: 0, refused: 0, unavailable: 0 });
  const [daily] = dailyFreshnessRows({ sources: [{ key: "zoom", class: "push" }] }, { sources: [f.row], as_of: NOW });
  assert.equal(daily.current_state, "checked");
  assert.equal(daily.last_check_at, NOW);
});

test("Zoom missing credentials differs from a quiet provider check", async t => {
  const f = await zoomCase(t, { credentials: false });
  assert.equal(f.result.skipped, "not_configured", "the real maintenance configuration decision was reached");
  assert.equal(f.seen.provider, 0);
  assert.equal(f.row.receipt.zoom.state, "not_configured");
  assert.equal(f.row.receipt.zoom.last_check_at, null);
  assert.equal(f.row.receipt.zoom.history.state, "unproven");
});

test("Zoom partial pages and durable delivery debt stay visible", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [], next_page_token: "private-cursor-fixture" }], debt: true });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.result.reconciliation.completeWindow, false);
  assert.equal(f.row.receipt.zoom.state, "pending");
  assert.equal(f.row.receipt.zoom.pagination_pending, true);
  assert.equal(f.row.receipt.zoom.deliveries.pending, 1);
  assert.equal(f.row.receipt.zoom.last_check_at, null);
  assert.equal(f.row.receipt.zoom.history.state, "unproven");
  assert.doesNotMatch(JSON.stringify(f.row), /private-cursor-fixture|synthetic-recording|synthetic-secret/);
});

test("Zoom malformed provider page cannot fabricate a quiet completed check", async t => {
  const f = await zoomCase(t, { pages: [{}] });
  assert.equal(f.seen.provider, 1);
  assert.equal(f.result.reconciliation.outcome.kind, "retryable");
  assert.equal(f.row.receipt.zoom.state, "retryable");
  assert.equal(f.row.receipt.zoom.last_check_at, null);
});

test("Zoom finishing every rolling page still does not prove historical coverage", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [], next_page_token: "synthetic-next-page" }] });
  let pages = 0;
  const result = await runZoomDeliveryMaintenance(f.env, { now: () => Date.parse(NOW), fetchImpl: async url => {
    if (new URL(url).pathname === "/oauth/token") return Response.json({ access_token: "synthetic-access" });
    pages++;
    assert.equal(new URL(url).searchParams.get("next_page_token"), "synthetic-next-page");
    assert.equal(new URL(url).searchParams.get("from"), "2026-09-10", "the bounded pending window is retained");
    return Response.json({ meetings: [] });
  } });
  assert.equal(pages, 1);
  assert.equal(result.reconciliation.completeWindow, true);
  const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
  const status = inventory.rows[0].receipt.zoom;
  assert.equal(status.state, "checked");
  assert.equal(status.history.state, "unproven");
  assert.equal(inventory.rows[0].receipt.complete_history_through, null);
});

test("Zoom checks expire and losing one credential cannot borrow a prior quiet check", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.seen.provider, 1);
  const stale = await sourceInventory(f.env, { now: Date.parse(NOW) + 86_400_001 });
  assert.equal(stale.rows[0].receipt.zoom.state, "stale");
  delete f.env.ZOOM_CLIENT_SECRET;
  const missing = await sourceInventory(f.env, { now: Date.parse(NOW) });
  assert.equal(missing.rows[0].receipt.zoom.state, "credentials_missing");
  assert.equal(missing.rows[0].receipt.zoom.last_check_at, NOW, "prior check remains dated historical evidence");
});

test("daily requires each source leg and keeps mixed ingest and checks distinct", async () => {
  const quiet = { kind: "calendar", last_successful_run_at: BEFORE, latest_run: {
    outcome: "empty", walk_complete: true, provider_check_complete: true, metrics_version: 1, started_at: NOW, finished_at: NOW,
    files_seen: 0, docs_added: 0, docs_updated: 0, docs_unchanged: 0, docs_refused: 0, docs_failed: 0,
  } };
  const work = { ...quiet, last_successful_run_at: NOW, latest_run: { ...quiet.latest_run, outcome: "completed", files_seen: 1, docs_added: 1 } };
  for (const [second, expected, noChange] of [[quiet, "complete", true], [work, "complete", false], [null, "failed", false]]) {
    let reads = 0;
    let runs = 0;
    const result = await runDailyRefresh({
      plan: { ready: true, enabled: true, manifest_path: "/fixture/brain.manifest.json", identity: { id: "fixture" },
        sources: [{ key: "provider", class: "machine-pull", owner: "daily-task", status: "ready", source_names: ["first", "second"] }] },
      acquireLock: () => ({ assertOwned() {}, release() {} }),
      runSource: async () => { runs++; return { status: "complete" }; },
      now: () => new Date(NOW),
      readFreshness: async () => ++reads === 1 ? {
        first: { last_successful_run_at: BEFORE }, second: { last_successful_run_at: BEFORE },
      } : { first: quiet, ...(second ? { second } : {}) },
    });
    assert.equal(reads, 2);
    assert.equal(runs, 1);
    assert.equal(result.status, expected);
    assert.equal(result.sources[0].no_change, noChange);
    assert.equal(result.sources[0].freshness_advanced, false);
  }
});

test("Zoom failure, lease, debt and invalid time states never borrow a quiet check", async t => {
  const f = await zoomCase(t, { pages: [{ meetings: [] }] });
  assert.equal(f.seen.provider, 1, "green quiet control completed before state mutations");
  const read = async () => {
    const reads = f.seen.reads;
    const inventory = await sourceInventory(f.env, { now: Date.parse(NOW) });
    assert.ok(f.seen.reads > reads);
    return inventory.rows[0].receipt.zoom;
  };
  for (const status of ["retryable", "unavailable", "refused"]) {
    f.db.prepare("UPDATE zoom_reconciliation SET status=?").run(status);
    assert.equal((await read()).state, status);
  }
  f.db.exec("UPDATE zoom_reconciliation SET status='processing',lease_owner='fixture',lease_expires_at_ms=9999999999999");
  assert.equal((await read()).state, "processing");
  f.db.exec("UPDATE zoom_reconciliation SET status='idle',lease_owner=NULL,lease_expires_at_ms=NULL");
  await persistZoomDelivery(f.env, { uuid: "synthetic-debt", eventType: "recording.completed", receivedAtMs: Date.parse(NOW) });
  for (const status of ["refused", "unavailable"]) {
    f.db.prepare("UPDATE zoom_deliveries SET status=?").run(status);
    const observed = await read();
    assert.equal(observed.state, "needs_attention");
    assert.equal(observed.deliveries[status], 1);
  }
  f.db.exec("DELETE FROM zoom_deliveries");
  f.db.prepare("UPDATE zoom_reconciliation SET completed_at_ms=?").run(Date.parse(NOW) + 1000);
  assert.equal((await read()).last_check_at, null);
  f.db.exec("DELETE FROM zoom_reconciliation");
  assert.equal((await read()).state, "unknown");
});
