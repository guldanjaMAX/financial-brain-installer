import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cmdApplyIngestRemovals, cmdIngestCalendar, cmdLoad,
  credentialScannerFingerprint, drivePolicyFingerprint } from "../brain.mjs";
import { driveVersion } from "../connectors/google-drive.mjs";
import { createIngestRemovalReview } from "../operations/ingest-removal-plan.mjs";
import { buildDriveRemovalPlan } from "../operations/drive-removal-plan.mjs";
import { runDailyRefreshCli } from "../operations/daily-refresh-run.mjs";
import { dailyObservationStatus } from "../operations/daily-refresh-observation.mjs";
import { dailyRefreshIdentity } from "../operations/daily-refresh-plan.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";
import { ingestPlanStore } from "./helpers/ingest-plan-store.mjs";
import { cliTestEnvironment } from "./helpers/cli-test-environment.mjs";

// Use the real load registry, saved review, apply executor and D1 readback.
// Only provider reads and credential custody are synthetic and injected.
function fixture({ kind = "calendar", stored = 1269, deleted = 1, policy = 0, skip = 0,
  replacement = false, failure = null, dryRun = false, requireSourceApproval = false, cause = "explicit_deletion" } = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "small-removals-")));
  const manifestPath = join(home, "brain.manifest.json");
  const source = kind === "google_drive" ? "drive" : kind;
  const manifest = { client: { slug: "fixture" }, brain: { domain: "fixture.invalid" },
    corpora: { [kind]: { enabled: true, ...(kind === "upload" ? { folders: [{ path: home, source }] } : {}) } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const keyPath = join(home, ".brain-admin-key");
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = ingestPlanStore();
  for (let i = 0; i < stored; i++) store.put(`${source}:item${i}`);
  const state = { version: 1, done: {}, skipped: {} };
  let runs = 0;
  let applyCalls = 0;
  let savedPlans = 0;
  const appliedFlags = [];
  const lines = [];
  const request = async (input) => {
    if (input.body.action === "apply" && failure === "apply") throw new Error("synthetic apply failure");
    const result = await store.request(input);
    if (input.body.action === "preview" && failure === "readback" && store.calls.apply > 0) {
      return { ...result, targets: [`${source}:item0`] };
    }
    return result;
  };
  const options = {
    flags: { ...(dryRun ? { "dry-run": true } : {}) }, lifecycleLockHeld: true,
    assertOwned() {}, log: (line) => lines.push(line),
    probes: { [kind]: () => ({ connected: true }) },
    withSourceIngestLock: async (_input, task) => task({ assertOwned() {} }),
    ingestLib: async () => ({ loadState: () => state, saveState() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid",
    resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    removalPlanRequest: request, removalPlanRuntime: () => "fixture-runtime",
  };
  const run = async () => {
    runs++;
    const review = createIngestRemovalReview({ state, source,
      kind: source, manifest, manifestPath, base: "https://fixture.invalid",
      request, runtime: () => "fixture-runtime", saveState: () => { if (state.ingest_removal_plan) savedPlans++; } });
    const ids = (start, count) => Array.from({ length: count }, (_, i) => `${source}:item${start + i}`);
    if (replacement) {
      state.done.replacement = "v1";
      review.remember([{ base_doc_uid: `${source}:item${deleted + policy + skip}`,
        keep_doc_uids: [], stateKey: "replacement", hash: "v1" }]);
    }
    await review.finish({ requireSourceApproval, sourcePlan: buildDriveRemovalPlan({ storedFamilies: store.uids(),
      targetCauses: Object.fromEntries(ids(0, deleted).map(uid => [uid, cause])),
      vanishedCandidates: ids(0, deleted), policyCandidates: ids(deleted, policy),
      intentionalCandidates: ids(deleted + policy, skip) }) });
    return { sent: { created: 0, updated: 0, unchanged: 1 }, removed: 0 };
  };
  options.commands = { ingestCalendar: run, ingestRemote: run, ingestLocal: run,
    applyIngestRemovals: async (m, path, flags, applyOptions) => {
      applyCalls++;
      appliedFlags.push(flags);
      return cmdApplyIngestRemovals(m, path, flags, { ...options, ...applyOptions });
    } };
  return { home, manifestPath, source, store, state, lines, options,
    load: () => cmdLoad(manifestPath, options),
    runs: () => runs, applyCalls: () => applyCalls, savedPlans: () => savedPlans, appliedFlags,
    close: () => { store.db.close(); rmSync(home, { recursive: true, force: true }); } };
}

test("Drive CLI held review keeps the exact approval line with buffered output", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-review-output-")));
  const manifestPath = join(home, "brain.manifest.json");
  const statePath = join(home, ".brain-ingest-drive.json");
  const evidencePath = join(home, "review-evidence.json");
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    mkdirSync(join(home, ".brain"), { mode: 0o700 });
    writeFileSync(join(home, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
    writeFileSync(join(home, ".brain", "google-tokens.json"), JSON.stringify({ google: {
      client_id: "fixture-client", client_secret: null,
      refresh_token: randomBytes(32).toString("hex"), scopes: ["drive"],
    } }), { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { google_drive: { root_folder_ids: ["fixture-root"] } },
    }));
    writeFileSync(statePath, JSON.stringify({ version: 1, done: {
      "drive:active-migrated": driveVersion({ id: "active-migrated", name: "migrated.png",
        mimeType: "image/png", size: "200", createdTime: "2025-01-01T00:00:00Z",
        modifiedTime: "2026-08-20T00:00:00Z", md5Checksum: "migrated-current",
        parents: ["fixture-root"] }, "Reviewed Root"),
      "drive:active-stale": "prior-stale-version", "drive:active-sensitive": "prior-sensitive-version",
      "drive:source-missing": "prior-missing-version",
    }, skipped: {}, sync_token: "fixture-prior-cursor",
    drive_policy_fingerprint: drivePolicyFingerprint({ rootFolderIds: ["fixture-root"],
      excludeFileIds: [], excludePaths: [], excludeNameParts: [], privatePrefixes: [] }, true),
    credential_scanner_fingerprint: credentialScannerFingerprint(true),
    drive_last_full_sweep_at: "2000-01-01T00:00:00.000Z" }), { mode: 0o600 });
    // HOME alone still shares the machine-wide lifecycle lock. Keep that lock
    // and temporary files local so another fixture cannot stop this review.
    const environment = cliTestEnvironment(home, {
      NO_COLOR: "1", BRAIN_GOOGLE_TOKEN_STORE: "file",
      BRAIN_DRIVE_SKIP_USER_ROOT: home, BRAIN_DRIVE_SKIP_EVIDENCE: evidencePath,
      BRAIN_DRIVE_SKIP_MODE: "mixed",
      BRAIN_SMALL_REMOVAL_CONTROL: ["immediate-exit", "startup-refusal"].includes(process.env.BRAIN_SMALL_REMOVAL_CONTROL)
        ? process.env.BRAIN_SMALL_REMOVAL_CONTROL : "buffered-output",
      ...(process.env.BRAIN_LANE_NODE_WAIT ? { BRAIN_LANE_NODE_WAIT: process.env.BRAIN_LANE_NODE_WAIT } : {}),
    });
    if (process.env.BRAIN_LANE_NODE_WAIT) {
      const quiet = spawnSync("/bin/sh", ["-c", process.env.BRAIN_LANE_NODE_WAIT], { encoding: "utf8" });
      assert.equal(quiet.status, 0);
    }
    const result = spawnSync(process.execPath, ["--import", "./test/fixtures/small-removal-control.mjs",
      "--import", "./test/fixtures/drive-active-skip-fetch.mjs", "./brain.mjs", "ingest", manifestPath,
      "--from", "drive"], { cwd: root, encoding: "utf8", timeout: 60_000,
      env: environment });
    assert.ok(existsSync(evidencePath),
      `Drive CLI did not write review evidence: status=${result.status}, signal=${result.signal}, error=${result.error?.code || "none"}` +
      `\nstderr:\n${result.stderr || "(empty)"}\nstdout:\n${result.stdout || "(empty)"}`);
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const plan = state.ingest_removal_plan;
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.ok(plan.targets.length > 0, "the CLI reached a nonempty saved removal decision");
    assert.equal(plan.sourcePlan.tooLarge, true, "the additional approval decision was reached");
    assert.ok(evidence.inventoryReads > 0);
    assert.equal(evidence.forgetRequests, 0);
    assert.equal(state.sync_token, "fixture-prior-cursor");
    const command = renderCliCommands(`brain ingest <manifest> --from drive --source drive --apply-removals ${plan.fingerprint}` +
      ` --approve-removals ${plan.sourcePlan.fingerprint}`);
    const output = String(result.stdout).replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(output.split(/\r?\n/u).includes(`Review this plan, then run: ${command}`),
      "Drive held review lost its exact approval line before stdout drained");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

for (const [label, config] of [
  ["small deletion", {}],
  ["count gate", { stored: 2000, deleted: 101 }],
  ["ratio gate", { stored: 10, deleted: 2 }],
  ["policy", { deleted: 0, policy: 1 }],
  ["skip", { deleted: 0, skip: 1 }],
  ["mixed reasons", { policy: 1, skip: 1 }],
  ["replacement", { replacement: true }],
  ["additional source review", { requireSourceApproval: true }],
]) {
  test(`Drive held review keeps the exact approval line in load and daily status: ${label}`, async () => {
    const f = fixture({ ...config, kind: "google_drive" });
    try {
      let reads = 0;
      const output = [];
      const now = () => new Date("2026-11-01T12:00:00Z");
      const plan = { ready: true, enabled: true,
        identity: dailyRefreshIdentity(JSON.parse(readFileSync(f.manifestPath)), "uid:fixture"),
        manifest_path: f.manifestPath, max_runtime_minutes: 45,
        sources: [{ key: "google_drive", source_names: ["drive"], run_key: "google_drive",
          class: "machine-pull", owner: "daily-task", status: "ready" }] };
      const result = await runDailyRefreshCli(f.manifestPath, {
        brainModule: {}, buildPlan: async () => plan, runSource: f.load, principal: "uid:fixture",
        acquireLock: () => ({ assertOwned() {}, release() {} }), readUpdateTransaction: () => null,
        readFreshness: async () => ({ drive: { last_successful_run_at: ++reads === 1
          ? "2026-10-31T12:00:00Z" : "2026-11-01T12:00:00Z" } }),
        writeReceipt() {}, now, home: f.home, log: line => output.push(line),
      });
      const saved = f.state.ingest_removal_plan;
      assert.ok(saved.targets.length > 0, "the Drive removal decision was reached");
      assert.ok(f.savedPlans() > 0);
      assert.ok(f.store.calls.preview > 0);
      assert.equal(f.runs(), 1);
      assert.equal(f.applyCalls(), 0);
      assert.equal(f.store.calls.apply, 0);
      assert.equal(result.status, "waiting_for_owner");
      assert.equal(result.reason_code, "removal_review");
      const approval = saved.sourcePlan.tooLarge || saved.requireSourceApproval
        ? saved.sourcePlan.fingerprint : null;
      const command = renderCliCommands(`brain ingest <manifest> --from drive --source drive --apply-removals ${saved.fingerprint}` +
        (approval ? ` --approve-removals ${approval}` : ""));
      const review = result.sources[0].removal_reviews[0];
      assert.equal(review.approval_fingerprint, approval);
      assert.equal(review.apply_command, command);
      assert.ok(f.lines.some(line => line.includes(`Review this plan, then run: ${command}`)));
      assert.ok(output.some(line => line.includes(command)));
      const status = dailyObservationStatus(plan, { enabled: false }, { known: true, running: false, exit_code: 0 },
        true, { home: f.home, now });
      assert.equal(status.status, "waiting_for_owner");
      assert.equal(status.source_issues[0].removal_reviews[0].apply_command, command);
    } finally { f.close(); }
  });
}

test("the real Calendar pipeline keeps its old cursor through apply and advances only on replay", async () => {
  const f = fixture();
  try {
    f.state.primary = { sync_token: "fixture-prior" };
    let pulls = 0;
    const receipts = [];
    f.options.commands.ingestCalendar = (manifest, path, flags) => cmdIngestCalendar(manifest, path, flags, {
      ...f.options, getAccessToken: async () => "fixture-provider-proof",
      loadCalendarState: () => f.state,
      saveCalendarState: (_path, value) => {
        if (value === f.state) return;
        for (const key of Object.keys(f.state)) delete f.state[key];
        Object.assign(f.state, value);
      },
      listStoredSourceFamilies: async () => new Set(f.store.uids()),
      postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt),
      googleCalendar: {
        syncAll: async ({ state }) => {
          pulls++;
          assert.equal(state.primary.sync_token, "fixture-prior", "apply cannot advance a source cursor");
          return { ok: true, documents: [], deletions: [{ source_id: "item0", removal_cause: "explicit_deletion" }],
            state: { primary: { sync_token: "fixture-next" } },
            calendars: [{ ok: true, mode: "incremental", authoritative_snapshot: true }],
            summary: { events_seen: 1, calendars_ok: 1, calendars_failed: 0, skipped: 0 } };
        },
        ingestEnvelopes: async () => ({ created: 0, updated: 0, unchanged: 1, errors: [], refused: [] }),
      },
    });
    const result = await f.load();
    assert.equal(pulls, 2);
    assert.equal(f.applyCalls(), 1);
    assert.equal(f.store.calls.apply, 1);
    assert.equal(f.state.primary.sync_token, "fixture-next");
    assert.deepEqual(receipts.map(receipt => receipt.status), ["indexing", "error", "indexing", "ready"]);
    assert.equal(result.auto_applied_removals[0].readback, "passed");
  } finally { f.close(); }
});

for (const kind of ["calendar", "gmail"]) {
  test(`1 of 1269 ${kind} deletions uses exact reviewed apply, then refreshes once`, async () => {
    const f = fixture({ kind });
    try {
      let result;
      await assert.doesNotReject(async () => { result = await f.load(); }, "the eligible plan must complete through load");
      assert.equal(f.runs(), 2);
      assert.equal(f.applyCalls(), 1);
      assert.ok(f.savedPlans() > 0);
      assert.equal(f.store.calls.apply, 1);
      assert.equal(f.store.uids().length, 1268);
      assert.equal(f.state.ingest_removal_plan, undefined);
      const receipt = result.auto_applied_removals[0];
      assert.equal(receipt.source, kind);
      assert.equal(receipt.count, 1);
      assert.equal(receipt.percent, 100 / 1269);
      assert.deepEqual(receipt.reasons, { source_deleted: 1, source_policy: 0, intentional_skip: 0 });
      assert.equal(receipt.readback, "passed");
      assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
      assert.equal(f.appliedFlags[0]["apply-removals"], receipt.fingerprint);
      assert.equal(f.appliedFlags[0].from, kind);
      assert.equal(f.appliedFlags[0].source, kind);
    } finally { f.close(); }
  });
}

const heldCases = [
  ["26 deletions", { stored: 5000, deleted: 26 }],
  ["1.1 percent", { stored: 1000, deleted: 11 }],
  ["missing cause", { cause: null }],
  ["window exit", { cause: "window_exit" }],
  ["policy removal", { deleted: 0, policy: 1 }],
  ["intentional skip", { deleted: 0, skip: 1 }],
  ["mixed reasons", { policy: 1 }],
  ["replacement review", { replacement: true }],
  ["Drive", { kind: "google_drive" }],
  ["uploaded files", { kind: "upload" }],
  ["dry run", { dryRun: true }],
];
for (const [label, config] of heldCases) {
  test(`${label} stays held after reaching a nonempty reviewed plan`, async () => {
    const f = fixture(config);
    try {
      await assert.rejects(f.load(), (error) => {
        assert.equal(error.code, "SAFETY_REVIEW_REQUIRED");
        assert.ok(error.removal_reviews[0].stored_documents_to_remove > 0);
        assert.equal(error.removal_reviews[0].fingerprint, f.state.ingest_removal_plan.fingerprint);
        return true;
      });
      assert.equal(f.runs(), 1);
      assert.ok(f.savedPlans() > 0);
      assert.ok(f.store.calls.preview > 0);
      assert.equal(f.applyCalls(), 0);
      assert.equal(f.store.calls.apply, 0);
    } finally { f.close(); }
  });
}

test("25 deletions at exactly one percent are included", async () => {
  const f = fixture({ stored: 2500, deleted: 25 });
  try {
    const result = await f.load();
    assert.equal(f.applyCalls(), 1);
    assert.equal(f.runs(), 2);
    assert.equal(result.auto_applied_removals[0].percent, 1);
    assert.equal(f.store.uids().length, 2475);
  } finally { f.close(); }
});

test("a fresh review on the one source replay cannot trigger a second automatic apply", async () => {
  const f = fixture();
  try {
    const run = f.options.commands.ingestCalendar;
    let pulls = 0;
    f.options.commands.ingestCalendar = async (...args) => {
      if (++pulls === 2) f.store.put("calendar:item0", {}, "new-revision");
      return run(...args);
    };
    await assert.rejects(f.load(), error => {
      assert.equal(error.code, "SAFETY_REVIEW_REQUIRED");
      assert.equal(error.auto_applied_removals[0].readback, "passed");
      assert.notEqual(error.removal_review.fingerprint, error.auto_applied_removals[0].fingerprint);
      return true;
    });
    assert.equal(pulls, 2);
    assert.equal(f.applyCalls(), 1);
    assert.equal(f.store.calls.apply, 1);
    assert.equal(f.state.ingest_removal_plan.targets.length, 1, "the new decision point remains held");
  } finally { f.close(); }
});

for (const failure of [null, "apply", "readback", "held"]) {
  test(`daily receipt, owner sentence and persisted status: ${failure || "green control"}`, async () => {
    const f = fixture({ failure, ...(failure === "held" ? { deleted: 26, stored: 5000 } : {}) });
    try {
      let reads = 0;
      const dailyPlan = { ready: true, enabled: true,
        identity: dailyRefreshIdentity(JSON.parse(readFileSync(f.manifestPath)), "uid:fixture"), manifest_path: f.manifestPath,
        max_runtime_minutes: 45, sources: [{ key: "calendar", source_names: ["calendar"], run_key: "calendar",
          class: "machine-pull", owner: "daily-task", status: "ready" }] };
      const receipts = [];
      const output = [];
      const now = () => new Date("2026-11-01T12:00:00Z");
      const result = await runDailyRefreshCli(f.manifestPath, {
        brainModule: {}, buildPlan: async () => dailyPlan, runSource: f.load, principal: "uid:fixture",
        acquireLock: () => ({ assertOwned() {}, release() {} }), readUpdateTransaction: () => null,
        readFreshness: async () => ({ calendar: { last_successful_run_at: ++reads === 1
          ? "2026-10-31T12:00:00Z" : "2026-11-01T12:00:00Z" } }),
        writeReceipt: (receipt) => receipts.push(receipt), now, home: f.home,
        log: (line) => output.push(line),
      });
      assert.ok(f.savedPlans() > 0, "the real removal decision was reached");
      if (failure) {
        assert.equal(result.status, "waiting_for_owner");
        assert.equal(result.reason_code, "removal_review");
        const row = result.sources[0];
        assert.equal(row.status, "waiting_for_owner");
        assert.equal(row.reason_code, "removal_review");
        assert.equal(row.issue_code, "SAFETY_REVIEW_REQUIRED");
        assert.equal(f.runs(), 1, "failed apply/readback never reruns the source");
        assert.equal(f.applyCalls(), failure === "held" ? 0 : 1);
        const review = row.removal_reviews[0];
        assert.equal(review.reasons.source_deleted, failure === "held" ? 26 : 1);
        const command = renderCliCommands(`brain ingest <manifest> --from calendar --source calendar --apply-removals ${review.fingerprint}`);
        assert.equal(review.apply_command, command);
        assert.ok(row.reason.includes("Calendar is waiting for your OK to remove"));
        assert.ok(row.reason.includes(command));
        assert.ok(output.some((line) => line.includes(row.reason)));
        assert.ok(f.state.ingest_removal_plan, "failure preserves the saved review");
        if (failure !== "held") assert.equal(row.auto_applied_removals[0].readback, "failed");
        const schedule = dailyObservationStatus(dailyPlan, { enabled: false }, { known: true, running: false, exit_code: 0 },
          true, { home: f.home, now });
        assert.equal(schedule.last_result, "waiting_for_owner");
        assert.equal(schedule.status, "waiting_for_owner");
        assert.equal(schedule.reason_code, "removal_review");
        assert.equal(schedule.source_issues[0].reason_code, "removal_review");
        assert.deepEqual(schedule.source_issues[0].removal_reviews, row.removal_reviews);
      } else {
        assert.equal(result.status, "complete");
        assert.equal(f.runs(), 2);
        assert.equal(result.sources[0].auto_applied_removals[0].readback, "passed");
      }
      assert.deepEqual(receipts.at(-1), result);
    } finally { f.close(); }
  });
}
