import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { installLifecycleLockTripwire } from "./fixtures/lifecycle-lock-tripwire.mjs";
import { cmdDaily, cmdIngestProvider, cmdLoad, cmdSources, dailyFreshnessRows, splitStatements } from "../brain.mjs";
import { syncMicrosoftGraph } from "../connectors/microsoft-graph.mjs";
import { runProviderConnector } from "../connectors/provider-runtime.mjs";
import { providerWithheldCheckAt } from "../worker/src/lib/source-receipt.js";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { sourceInventory, freshnessReport } from "../worker/src/lib/store-d1.js";
import { ownerSystemStatus } from "../worker/src/lib/system-status.js";
import worker from "../worker/src/index.js";

const NOW = "2026-11-04T12:00:00.000Z";
const BEFORE = "2026-09-26T12:00:00.000Z";
const ORIGIN = "https://brain.example.invalid";
globalThis.fetch = async () => { throw new Error("unmocked request refused"); };

async function scenario(t, { accepted = 0, withheld = true, failure = null, known = true, mailResults = null } = {}) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ms-partial-status-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const guard = installLifecycleLockTripwire(root);
  t.after(() => { guard.restore(); assert.equal(guard.blocked, 0, "lifecycle writes stayed in the fixture"); });
  const keyPath = join(root, ".brain-admin-key");
  writeFileSync(keyPath, "synthetic-owner-proof", { mode: 0o600 });
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const name of readdirSync(new URL("../migrations/d1/", import.meta.url)).filter(n => n.endsWith(".sql")).sort()) {
    for (const sql of splitStatements(readFileSync(new URL(`../migrations/d1/${name}`, import.meta.url), "utf8"))) db.exec(sql);
  }
  db.exec("INSERT INTO install_state (id,client_slug,product_version,installed_at) VALUES (1,'owner','0.0.0-test','2026-01-01')");
  const env = { STORAGE: "d1", ADMIN_KEY: readFileSync(keyPath, "utf8"), SESSION_SIGNING_KEY: randomBytes(32).toString("hex"), DB: {
    prepare(sql) {
      const shape = (args = []) => ({ bind: (...values) => shape(values),
        all: async () => ({ results: db.prepare(sql).all(...args) }),
        first: async () => db.prepare(sql).get(...args) ?? null,
        run: async () => ({ meta: db.prepare(sql).run(...args) }),
      });
      return shape();
    },
    batch: async statements => Promise.all(statements.map(s => s.run())),
  } };
  const calls = { calendar: 0, mail: 0, delivery: 0, receipts: 0, saves: 0, removals: 0, sources: 0,
    inventories: 0, storedFamilies: 0, reconciliations: 0, calendarRemovals: null };
  const call = request => worker.fetch(request, env, { waitUntil() {} });
  const postReceipt = async body => {
    calls.receipts++;
    const response = await call(new Request(`${ORIGIN}/api/admin/brain/source-receipt`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Key": env.ADMIN_KEY }, body: JSON.stringify(body) }));
    assert.equal(response.status, 200, "the real receipt route was reached");
  };
  await postReceipt({ source: "mailbox", kind: "microsoft", status: "ready", run_id: "prior",
    started_at: BEFORE, completed_at: BEFORE, files_seen: 1, docs_added: 1, docs_updated: 0,
    docs_unchanged: 0, docs_refused: 0, docs_failed: 0, walk_complete: true });
  db.exec("UPDATE sources SET expected_refresh_seconds=86400");
  const manifest = { client: { slug: "owner", timezone: "UTC" }, brain: { domain: "brain.example.invalid" },
    corpora: { microsoft: { enabled: true, source: "mailbox", mail_folder_ids: ["inbox"], include_personal_drive: false },
      upload: { enabled: false } } };
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const ids = Array.from({ length: withheld ? 39 : 0 }, (_, i) => `event-${i}`);
  const cursor = { mail: {}, drives: {}, calendar: { delta_link: "https://graph.microsoft.com/v1.0/calendar-prior",
    window_start: "2026-10-05T00:00:00.000Z", window_end: "2027-02-02T00:00:00.000Z", id_type: "immutable",
    event_ids: known ? ids : [] } };
  let saved;
  const logs = [];
  t.mock.method(console, "log", line => logs.push(String(line)));
  t.mock.method(console, "warn", line => logs.push(String(line)));
  const commands = { ingestProvider: (m, path, flags) => cmdIngestProvider(m, path, flags, {
    withSourceIngestLock: async (_options, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => ORIGIN, resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    oauth: { providerAccessToken: async () => ({ accessToken: "synthetic-provider-proof" }),
      loadProviderSyncState: () => ({}), saveProviderSyncState: (_provider, _source, state) => { calls.saves++; saved = state; } },
    sync: async options => {
      const result = await syncMicrosoftGraph({ ...options, cursor, now: () => Date.parse(NOW) });
      calls.reconciliations++;
      calls.calendarRemovals = result.removal_review_scopes[0].deletion_source_ids.length;
      return result;
    },
    fetchImpl: async url => {
      const path = new URL(url).pathname;
      if (/calendar/.test(path)) {
        calls.calendar++;
        if (failure === "calendar") return Response.json({}, { status: 503 });
        return Response.json({ value: ids.map(id => ({ id, subject: "Synthetic event", start: null })),
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-next" });
      }
      assert.match(path, /mailFolders\/inbox\/messages\/delta/);
      calls.mail++;
      return Response.json({ value: Array.from({ length: mailResults?.length ?? accepted + (withheld ? 2 : 0) }, (_, i) => ({
        id: `message-${i}`, subject: "Synthetic mail", bodyPreview: "Synthetic content", receivedDateTime: NOW,
      })), "@odata.deltaLink": "https://graph.microsoft.com/v1.0/mail-next" });
    },
    requestIngestBatch: async ({ docs }) => {
      calls.delivery++;
      if (failure === "delivery") throw new Error("synthetic mid-run delivery failure");
      return { results: docs.map((doc, i) => ({ source_id: doc.source_id,
        ...(mailResults ? mailResults[i] : i < accepted ? { status: "created" }
          : { status: "refused", labels: ["private_key_header"] }) })) };
    },
    listStoredSourceFamilies: async () => {
      calls.inventories++;
      const families = new Set(ids.map(id => `mailbox:outlook:event:${id}`));
      calls.storedFamilies = families.size;
      return families;
    },
    applyDriveRemovals: async () => { calls.removals++; assert.fail("set-aside events are never removals"); },
    postSourceReceipt: (_base, _key, body) => postReceipt(body),
  }) };
  const plan = { ready: true, enabled: true, manifest_path: manifestPath, identity: { id: "v1-fixture" },
    cron: "0 8 * * *", timezone: "UTC", sources: [{ key: "microsoft", source_names: ["mailbox"],
      class: "machine-pull", owner: "daily-task", status: "ready", run_key: "microsoft" }] };
  const result = await runDailyRefreshCli(manifestPath, {
    brainModule: {}, buildPlan: async () => plan, home: root, platform: "darwin", now: () => new Date(NOW),
    acquireLock: () => ({ assertOwned() {}, release() {} }), readUpdateTransaction: () => null, writeReceipt() {},
    runSource: async () => cmdLoad(manifestPath, { only: "microsoft", allowPartialRefresh: true, commands,
      lifecycleLockOptions: { machineLockRoot: join(root, "lifecycle-locks") },
      probes: { microsoft: async () => ({ connected: true }) }, log: line => logs.push(String(line)) }),
    readFreshness: async () => Object.fromEntries((await sourceInventory(env, { now: Date.parse(NOW) })).rows
      .map(row => [row.name, { kind: row.kind, ...row.receipt }])),
    log: line => logs.push(String(line)),
  });
  const runLogEnd = logs.length;
  const inventory = await cmdSources(manifestPath, { resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    fetchImpl: (_url, init) => { calls.sources++; return call(new Request(`${ORIGIN}/api/admin/brain/sources`, init)); } });
  const sourcesLogEnd = logs.length;
  const daily = await cmdDaily(["status", manifestPath], { platform: "darwin", schedulerOptions: { platform: "darwin", home: root },
    existingSchedulerOwners: [], schedulerAdapter: { read: () => ({ exists: false }) },
    planDailyRefresh: async () => plan, readSourceInventory: async () => inventory, log: line => logs.push(String(line)) });
  const health = (await freshnessReport(env, { now: Date.parse(NOW) })).sources[0];
  const owner = await ownerSystemStatus(env, { health: async () => ({}), diagnose: async () => null,
    vectorReadiness: async () => null, freshness: async () => ({ sources: [health] }) });
  const row = inventory.sources[0];
  assert.equal(calls.calendar, failure === "calendar" ? 4 : 1, "the calendar fetch and bounded retry decisions were reached");
  assert.ok(calls.receipts >= 3, "both run receipt decisions were reached");
  assert.ok(calls.sources > 0, "the real CLI source inventory route was reached");
  assert.equal(calls.removals, 0, "set-aside events never authorize deletion");
  t.diagnostic(JSON.stringify({ case: { accepted, withheld, failure, known }, daily: result.status,
    source: row.freshness.state, reason: row.freshness.reason, health: health.state,
    health_reason: health.reason, calendar_age_days: health.days_since_ingest,
    last_loaded: row.receipt.last_ingest_receipt_at, last_check: row.receipt.last_check_at }));
  return { result, daily, health, owner: owner.sources[0], row, calls, saved, logs: logs.join("\n"),
    surfaces: [logs.slice(0, runLogEnd).join("\n"), logs.slice(runLogEnd, sourcesLogEnd).join("\n"),
      logs.slice(sourcesLogEnd).join("\n"), health.reason, owner.sources[0].reason] };
}

for (const accepted of [0, 1]) {
  test(`completed Microsoft check with 39 calendar and 2 mail set aside stays fresh (${accepted} accepted)`, async t => {
    const f = await scenario(t, { accepted });
    assert.equal(f.calls.mail, 1);
    assert.equal(f.calls.delivery, 1);
    assert.equal(f.calls.saves, 1);
    assert.equal(f.saved.cursor.calendar.pending_event_ids.ids.length, 39);
    assert.equal(f.calls.reconciliations, 1, "the calendar reconciliation decision was reached");
    assert.equal(f.calls.calendarRemovals, 0, "known incomplete events produce no removal candidates");
    assert.deepEqual(f.saved.cursor.calendar.event_ids, Array.from({ length: 39 }, (_, i) => `event-${i}`).sort(),
      "all prior identities survive alongside the retry queue");
    assert.equal(f.result.status, "partial", "coverage remains partial, execution finished");
    assert.equal(f.result.sources[0].check_verified, true);
    assert.equal(f.row.receipt.status, "ready");
    assert.equal(f.health.state, "ok", "a completed calendar read must not remain stale");
    assert.equal(f.health.days_since_ingest, 0, "freshness measures the completed read");
    assert.equal(f.row.receipt.last_check_at, NOW);
    assert.equal(f.row.receipt.last_successful_run_at, accepted ? NOW : BEFORE, "a read never invents accepted documents");
    assert.equal(f.row.receipt.complete_history_through, null);
    assert.equal(f.owner.coverage.live_updates.state, "current");
    assert.equal(f.owner.coverage.history.state, "needs_attention", "set-aside coverage is still incomplete");
    for (const surface of f.surfaces) {
      assert.match(surface, /ran 2026-11-04T12:00:00.000Z; 41 items set aside/);
      assert.match(surface, /39 incomplete calendar items queued for retry; 2 items held/);
    }
    assert.doesNotMatch(f.logs, /BROKEN|INGEST_FAILED/);
  });
}

for (const failure of ["delivery", "calendar"]) {
  test(`Microsoft ${failure} error remains broken after reaching its decision`, async t => {
    const f = await scenario(t, { failure });
    assert.equal(f.calls.mail, failure === "delivery" ? 1 : 0);
    assert.equal(f.calls.delivery, failure === "delivery" ? 1 : 0);
    assert.equal(f.calls.saves, 0);
    assert.equal(f.result.status, "failed");
    assert.equal(f.row.freshness.state, "broken");
    assert.equal(f.health.state, "broken");
    assert.equal(f.owner.state, "broken");
    assert.match(f.health.reason, /did not finish/);
    assert.equal(f.health.days_since_ingest, 39);
    assert.equal(f.row.receipt.last_ingest_receipt_at, BEFORE);
    assert.match(f.logs, /broken/);
  });
}

test("an unproven calendar gap cannot borrow a completed policy-only check", async t => {
  const f = await scenario(t, { known: false });
  assert.equal(f.calls.mail, 1);
  assert.equal(f.calls.delivery, 1);
  assert.equal(f.calls.saves, 0);
  assert.equal(f.result.status, "failed");
  assert.equal(f.health.state, "broken");
  assert.equal(f.health.days_since_ingest, 39);
  assert.equal(f.row.receipt.last_ingest_receipt_at, BEFORE);
});

test("Microsoft run with no set-aside items prints plain ran time", async t => {
  const f = await scenario(t, { accepted: 1, withheld: false });
  assert.equal(f.calls.delivery, 1);
  assert.equal(f.calls.saves, 1);
  assert.equal(f.result.status, "complete");
  assert.equal(f.health.state, "ok");
  for (const surface of f.surfaces) assert.match(surface, /ran 2026-11-04T12:00:00.000Z/);
  assert.doesNotMatch(f.logs, /items set aside/);
});

// Each failed arm differs from its completed control only in one delivery status.
for (const labels of [["env_assignment"], ["private_key_header"], ["env_assignment", "private_key_header"]]) {
  for (const status of ["failed", "unchanged"]) {
    test(`measured withholding survives ${status} delivery (${labels.join("+")})`, async t => {
      const f = await scenario(t, { withheld: false,
        mailResults: [{ status: "refused", labels }, { status }] });
      assert.equal(f.calls.mail, 1);
      assert.equal(f.calls.delivery, 1, "the mixed delivery tally was recorded");
      assert.equal(f.row.receipt.latest_run.docs_withheld, 1);
      assert.deepEqual(f.row.receipt.latest_run.withheld_reasons, { credential_detected: 1 });
      assert.equal(f.daily.sources[0].docs_withheld, 1);
      const dailyText = f.surfaces[2];
      assert.match(dailyText, /1 item set aside \(1 item held by the credential safety check for review\)/);
      if (status === "failed") {
        assert.equal(f.row.freshness.state, "broken");
        assert.equal(f.daily.sources[0].current_state, "broken");
        assert.equal(f.daily.sources[0].last_run_outcome, "failed");
        assert.equal(f.row.receipt.latest_run.docs_failed, 1);
        assert.equal(f.calls.saves, 0);
        assert.equal(f.row.receipt.last_ingest_receipt_at, BEFORE);
        assert.equal(providerWithheldCheckAt("microsoft", f.row.receipt.latest_run), null);
        assert.doesNotMatch(dailyText, /\bran /, "failed delivery cannot claim a completed run");
      } else {
        assert.equal(f.daily.sources[0].current_state, "checked");
        assert.equal(f.calls.saves, 1);
        assert.match(dailyText, /ran 2026-11-04T12:00:00.000Z;/);
      }
    });
  }
}

// Every provider shares this renderer. Cover each terminal/incomplete outcome
// and every reason-map shape without using success as a display prerequisite.
for (const kind of ["microsoft", "slack", "notion", "dropbox", "hubspot", "quickbooks"]) {
  test(`${kind}: measured counts render independently of freshness qualification`, async t => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "withheld-status-")));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const manifestPath = join(root, "brain.manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ client: { slug: "owner" }, brain: { domain: "brain.example.invalid" } }));
    const plan = { ready: true, enabled: true, manifest_path: manifestPath, identity: { id: "v1-fixture" },
      cron: "0 8 * * *", timezone: "UTC", sources: [{ key: kind, source_names: ["fixture"],
        class: "machine-pull", owner: "daily-task", status: "ready" }] };
    const reasons = [{ credential_detected: 2 }, undefined, { credential_detected: 1 }, { future_policy: 2 }];
    if (kind === "microsoft") reasons.push({ calendar_event_incomplete: 1, credential_detected: 1 });
    const render = async (run, { status, state }) => {
      let reads = 0;
      const inventory = { as_of: NOW, sources: [{ name: "fixture", kind, freshness: { state },
        receipt: { status, latest_run: run, last_successful_run_at: BEFORE, last_check_at: BEFORE,
          last_withheld: { count: 9, at: BEFORE } } }] };
      const lines = [];
      const result = await cmdDaily(["status", manifestPath], { platform: "darwin",
        schedulerOptions: { platform: "darwin", home: root }, existingSchedulerOwners: [],
        schedulerAdapter: { read: () => ({ exists: false }) }, planDailyRefresh: async () => plan,
        readSourceInventory: async () => { reads++; return inventory; }, log: line => lines.push(line) });
      assert.equal(reads, 1, "the injected inventory reached real daily status");
      assert.equal(result.sources[0].docs_withheld, run.docs_withheld);
      return lines.find(line => line.startsWith(`${kind} |`));
    };
    for (const outcome of ["failed", "refused", "empty", "missing_history", "in_progress", "partial", "completed"]) {
      for (const withheld_reasons of reasons) {
        const run = { outcome, docs_withheld: 2, docs_refused: 2, docs_failed: 1, withheld_reasons,
          started_at: NOW, finished_at: NOW, walk_complete: false, provider_check_complete: false,
          metrics_version: 1, files_seen: 3, docs_added: 0, docs_updated: 0, docs_unchanged: 0 };
        const line = await render(run, { status: "error", state: "broken" });
        assert.match(line, /\| broken \|/);
        const grouped = withheld_reasons?.credential_detected === 2 || withheld_reasons?.calendar_event_incomplete === 1;
        assert.match(line, grouped ? /2 items set aside/ : /2 item\(s\) withheld by design/);
        assert.doesNotMatch(line, /\bran |future_policy|9 item/);
        // The zero-count green control differs only in the measured field.
        const zero = await render({ ...run, docs_withheld: 0 }, { status: "error", state: "broken" });
        assert.doesNotMatch(zero, /items set aside|2 item\(s\) withheld/);
        assert.match(zero, /last withholding: 9 item\(s\)/);
      }
    }
    const positive = { outcome: "partial", docs_withheld: 2, docs_refused: 2, docs_failed: 1,
      withheld_reasons: { credential_detected: 2 } };
    const rows = [positive, { ...positive, docs_withheld: 3, docs_refused: 3,
      withheld_reasons: { credential_detected: 3 } }];
    const [combined] = dailyFreshnessRows({ sources: [{ key: kind, source_names: ["one", "two"] }] },
      { sources: rows.map((latest_run, index) => ({ name: index ? "two" : "one", kind,
        freshness: { state: "broken" }, receipt: { status: "error", latest_run } })) });
    assert.equal(combined.docs_withheld, 5);
    assert.deepEqual(combined.withheld_reasons, { credential_detected: 5 }, "multiple failed receipts retain their exact sum");
  });
}

for (const reason of ["deleted", "changed", "not_found"]) {
  for (const tombstone of [false, true]) {
    test(`calendar family retention has a nonempty scoped review control (${reason}, tombstone=${tombstone})`, async () => {
      const ids = Array.from({ length: 39 }, (_, i) => `event-${i}`);
      const families = new Set([...ids.map(id => `mailbox:outlook:event:${id}`),
        ...Array.from({ length: 1000 }, (_, i) => `mailbox:outlook:message:prior-${i}`)]);
      const prior = { calendar: { delta_link: "https://graph.microsoft.com/v1.0/calendar-prior",
        window_start: "2026-10-05T00:00:00.000Z", window_end: "2027-02-02T00:00:00.000Z",
        id_type: "immutable", event_ids: ids } };
      const calls = { fetches: 0, syncs: 0, inventories: 0, reviews: 0, saves: 0, removals: 0 };
      const receipts = [];
      let observed, saved;
      const run = () => runProviderConnector({ provider: "microsoft", kind: "microsoft", source: "mailbox",
        now: () => new Date(NOW), runId: "calendar-retention", assertOwned() {},
        resolveAccess: async () => ({ accessToken: "synthetic-provider-proof" }),
        loadState: () => ({ cursor: prior }), saveState: state => { calls.saves++; saved = state; },
        sync: async ({ cursor, accessToken }) => {
          calls.syncs++;
          observed = await syncMicrosoftGraph({ cursor, accessToken, now: () => Date.parse(NOW),
            includePersonalDrive: false, mailFolderIds: [], fetchImpl: async url => {
              calls.fetches++;
              assert.match(new URL(url).pathname, /calendar/);
              return Response.json({ value: ids.map(id => tombstone ? { id, "@removed": { reason } }
                : { id, subject: "Synthetic event", start: null }),
                "@odata.deltaLink": "https://graph.microsoft.com/v1.0/calendar-next" });
            } });
          return observed;
        },
        sendBatch: async () => assert.fail("calendar-only control submits no content"),
        listStoredFamilies: async () => { calls.inventories++; return families; },
        reviewRemovals: async ({ uids, storedFamilies, requiredApproval }) => {
          calls.reviews++;
          assert.equal(storedFamilies, families);
          assert.deepEqual([...uids].sort(), ids.map(id => `mailbox:outlook:event:${id}`).sort());
          assert.equal(uids.length, 39, "the review plan is nonempty");
          assert.match(requiredApproval, /^[a-f0-9]{64}$/, "calendar scope requires review despite 1000 unrelated mail families");
          throw Object.assign(new Error("synthetic review held"), { code: "provider_removal_review_required" });
        },
        removeDocuments: async () => { calls.removals++; assert.fail("review never applies removal"); },
        postReceipt: async (_base, _key, receipt) => { receipts.push(receipt); },
      });
      if (tombstone) await assert.rejects(run(), { code: "provider_removal_review_required" });
      else await run();
      assert.equal(calls.syncs, 1);
      assert.equal(calls.fetches, 1);
      assert.equal(families.size, 1039, "stored families remain preserved");
      assert.equal(calls.removals, 0);
      assert.equal(calls.reviews, tombstone ? 1 : 0);
      assert.equal(calls.inventories, tombstone ? 1 : 0);
      assert.equal(calls.saves, tombstone ? 0 : 1);
      assert.equal(observed.removal_review_scopes[0].prior_source_ids.length, 39);
      assert.equal(observed.deletions.length, tombstone ? 39 : 0);
      assert.equal(receipts.at(-1).status, tombstone ? "error" : "ready");
      if (!tombstone) {
        assert.deepEqual(saved.cursor.calendar.event_ids, [...ids].sort());
        assert.deepEqual(saved.cursor.calendar.pending_event_ids.ids, [...ids].sort());
      }
    });
  }
}
