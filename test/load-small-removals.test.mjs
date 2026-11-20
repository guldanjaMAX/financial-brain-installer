import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { cmdApplyIngestRemovals, cmdIngestCalendar, cmdLoad,
  credentialScannerFingerprint, drivePolicyFingerprint, cmdIngestRemote } from "../brain.mjs";
import { driveVersion } from "../connectors/google-drive.mjs";
import * as drive from "../connectors/google-drive.mjs";
import { currentPartsFixture, driveChangesFixture } from "./helpers/current-sync-fixture.mjs";
import { batchStream, splitOversized, prefetch } from "../ingest/run.mjs";
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

test("Drive incremental ingest keeps removals pending with a reached addition control", async t => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-pending-")));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifestPath = join(home, "brain.manifest.json");
  const manifest = { brain: { domain: "fixture.invalid" },
    corpora: { google_drive: { enabled: true, root_folder_ids: ["fixture-root"] } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [], ocr: { enabled: false } } };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const keyPath = join(home, ".brain-admin-key");
  writeFileSync(keyPath, randomBytes(32).toString("hex"), { mode: 0o600 });
  const state = { version: 1, done: { "drive:removed": "prior-version" }, skipped: {}, sync_token: "prior-cursor" };
  const files = [{ id: "removed", trashed: true }, { id: "addition", name: "addition.txt",
    mimeType: "text/plain", parents: ["fixture-root"], modifiedTime: "2026-11-01T00:00:00Z" }];
  const changes = driveChangesFixture(drive, files);
  const parts = currentPartsFixture(), sent = [], receipts = [], saves = [];
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("unexpected transport in injected incremental fixture");
  t.after(() => { globalThis.fetch = fetchBefore; });
  let forbidden = 0;
  const deny = async () => { forbidden++; throw new Error("automatic removal or full inventory reached"); };
  const result = await cmdIngestRemote(manifest, manifestPath, { from: "drive" }, {
    assertOwned() {}, lifecycleLockHeld: true,
    withSourceIngestLock: async (_input, run) => run({ assertOwned() {} }),
    resolveBaseUrl: async () => "https://fixture.invalid", resolveAdminKey: () => readFileSync(keyPath, "utf8"),
    getAccessToken: async () => randomBytes(16).toString("hex"),
    verifyDriveIncrementalWorker: async () => {}, readDriveFamily: async () => true,
    readCurrentIngestParts: parts.read, driveNow: () => Date.parse("2026-11-01T12:00:00Z"),
    drive: { ...changes.drive, toEnvelope: async (_get, file) => ({ version: drive.driveVersion(file, ""), envelope: { source_type: "drive", source_id: file.id,
      title: file.name, content: "The owner reviewed this synthetic ordinary record and confirmed the next review date." } }) },
    ingestLib: async () => ({ batchStream, splitOversized, prefetch, loadState: () => state,
      saveState: (_path, value) => saves.push(structuredClone(value)) }),
    sendBatches: async ({ groups, onResult }) => {
      for (const item of groups.flat()) { parts.accept(item.envelope); sent.push(item.envelope.source_id); onResult?.(item, { status: "created" }); }
      return { created: groups.flat().length, updated: 0, unchanged: 0, refused: 0, failed: 0 };
    },
    listStoredSourceFamilies: deny, applyDriveRemovals: deny, reconcileDocumentFamilies: deny,
    postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt), write() {},
    launchctl: join(home, "launchctl-fixture"),
  });
  assert.equal(changes.calls.pages, 1, "the real change-feed decision was reached");
  assert.ok(changes.calls.metadata > 0);
  assert.deepEqual(sent, ["addition"], "a green addition reached the accepted writer");
  assert.equal(result.created, 1);
  assert.equal(result.pending_removals, 1);
  assert.equal(state.drive_pending_removals["drive:removed"].reason, "trashed");
  assert.equal(state.done["drive:removed"], "prior-version", "pending removal keeps the prior accepted document");
  assert.equal(state.ingest_removal_plan, undefined, "plain Drive ingest cannot mint an apply plan");
  assert.equal(forbidden, 0);
  assert.ok(saves.length > 0);
  assert.equal(result.failures, 0);
  assert.equal(result.feed_caught_up, true);
  assert.equal(result.complete, false, "a pending owner removal cannot claim completed coverage");
  assert.equal(receipts.at(-1).status, "error");
  assert.equal(receipts.at(-1).issue_code, "SAFETY_REVIEW_REQUIRED");
  assert.equal(receipts.at(-1).docs_failed, 0);
});

test("Folder CLI held review keeps the exact approval line with buffered output", () => {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "drive-review-output-")));
  const manifestPath = join(home, "brain.manifest.json");
  const statePath = join(home, ".brain-ingest-drive.json");
  const folder = join(home, "empty-folder");
  mkdirSync(folder);
  const evidencePath = join(home, "review-evidence.json");
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    mkdirSync(join(home, ".brain"), { mode: 0o700 });
    writeFileSync(join(home, "launchctl-fixture"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
    writeFileSync(join(home, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
    writeFileSync(join(home, ".brain", "google-tokens.json"), JSON.stringify({ google: {
      client_id: "fixture-client", client_secret: null,
      refresh_token: randomBytes(32).toString("hex"), scopes: ["drive"],
    } }), { mode: 0o600 });
    writeFileSync(manifestPath, JSON.stringify({ client: { slug: "fixture" },
      brain: { domain: "fixture.invalid" },
      infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
      safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
      corpora: { upload: { enabled: true, folders: [{ path: folder, source: "drive" }] } },
    }));
    // The saved state must carry the current credential-scanner fingerprint;
    // without it the CLI stops at "credential scanner changed" before the held
    // review this test exists to exercise (final review of 0.4.28 housekeeping).
    writeFileSync(statePath, JSON.stringify({ version: 1, done: {
      "source-missing": "prior-missing-version",
    }, skipped: {}, credential_scanner_fingerprint: credentialScannerFingerprint(true) }), { mode: 0o600 });
    // HOME alone still shares the machine-wide lifecycle lock. Keep that lock
    // and temporary files local so another fixture cannot stop this review.
    const environment = cliTestEnvironment(home, {
      NO_COLOR: "1", BRAIN_GOOGLE_TOKEN_STORE: "file",
      BRAIN_TEST_LAUNCHCTL: join(home, "launchctl-fixture"),
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
      "--path", folder, "--source", "drive"], { cwd: root, encoding: "utf8", timeout: 60_000,
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
    assert.equal(state.sync_token, undefined);
    const command = renderCliCommands(`brain ingest <manifest> --source drive --apply-removals ${plan.fingerprint}` +
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

test("the real Calendar pipeline retains cancellations and advances only after the marker succeeds", async () => {
  const f = fixture();
  try {
    f.state.primary = { sync_token: "fixture-prior" };
    let pulls = 0;
    const receipts = [], marked = [];
    f.options.commands.ingestCalendar = (manifest, path, flags) => cmdIngestCalendar(manifest, path, flags, {
      ...f.options, getAccessToken: async () => "fixture-provider-proof",
      loadCalendarState: () => f.state,
      saveCalendarState: (_path, value) => {
        if (value === f.state) return;
        for (const key of Object.keys(f.state)) delete f.state[key];
        Object.assign(f.state, value);
      },
      listStoredSourceFamilies: async () => new Set(f.store.uids()),
      markCalendarCancellations: async ({ cancellations }) => {
        assert.equal(f.state.primary.sync_token, "fixture-prior", "the cursor stays behind the unconfirmed marker");
        for (const item of cancellations) {
          assert.ok(f.store.uids().includes(`calendar:${item.source_id}`));
          marked.push(item.source_id);
        }
        return cancellations.length;
      },
      postSourceReceipt: async (_base, _key, receipt) => receipts.push(receipt),
      googleCalendar: {
        syncAll: async ({ state }) => {
          pulls++;
          assert.equal(state.primary.sync_token, "fixture-prior", "the provider receives the prior accepted cursor");
          return { ok: true, documents: [], deletions: [{ source_id: "item0", removal_cause: "explicit_deletion" }],
            state: { primary: { sync_token: "fixture-next" } },
            calendars: [{ ok: true, mode: "incremental", authoritative_snapshot: true }],
            summary: { events_seen: 1, calendars_ok: 1, calendars_failed: 0, skipped: 0 } };
        },
        ingestEnvelopes: async () => ({ created: 0, updated: 0, unchanged: 1, errors: [], refused: [] }),
      },
    });
    await f.load();
    assert.equal(pulls, 1);
    assert.deepEqual(marked, ["item0"], "a real cancellation reaches the marker boundary");
    assert.equal(f.applyCalls(), 0);
    assert.equal(f.store.calls.apply, 0);
    assert.equal(f.store.calls.preview, 0);
    assert.equal(f.state.primary.sync_token, "fixture-next");
    assert.deepEqual(receipts.map(receipt => receipt.status), ["indexing", "ready"]);
    assert.equal(f.state.ingest_removal_plan, undefined);
    assert.ok(f.store.uids().includes("calendar:item0"), "the cancelled event remains stored");
  } finally { f.close(); }
});

for (const kind of ["calendar", "gmail"]) {
  test(`1 of 1269 ${kind} deletions uses exact reviewed apply, then refreshes once`, async () => {
    const f = fixture({ kind });
    try {
      let failure;
      await assert.rejects(f.load(), error => { failure = error; return error.code === "SAFETY_REVIEW_REQUIRED"; });
      assert.equal(f.runs(), 1);
      assert.equal(f.applyCalls(), 0);
      assert.ok(f.savedPlans() > 0);
      assert.ok(f.store.calls.preview > 0);
      assert.equal(f.store.calls.apply, 0);
      assert.equal(f.store.uids().length, 1269);
      const receipt = failure.removal_reviews[0];
      assert.equal(receipt.source, kind);
      assert.equal(receipt.stored_documents_to_remove, 1);
      assert.deepEqual(receipt.reasons, { source_deleted: 1, source_policy: 0, intentional_skip: 0 });
      assert.match(receipt.fingerprint, /^[a-f0-9]{64}$/);
      const applied = await cmdApplyIngestRemovals(f.options ? JSON.parse(readFileSync(f.manifestPath)) : {},
        f.manifestPath, { from: kind, source: kind, "apply-removals": receipt.fingerprint },
        { ...f.options, automaticRemoval: false });
      assert.equal(applied.removed, 1, "the separately approved exact apply remains available");
      assert.equal(applied.readback, "passed");
      assert.equal(f.store.uids().length, 1268);
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
    await assert.rejects(f.load(), error => error.code === "SAFETY_REVIEW_REQUIRED");
    assert.equal(f.applyCalls(), 0);
    assert.equal(f.runs(), 1);
    assert.equal(f.state.ingest_removal_plan.targets.length, 25);
    assert.equal(f.store.uids().length, 2500);
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
      assert.equal(error.auto_applied_removals.length, 0);
      assert.equal(error.removal_review.fingerprint, f.state.ingest_removal_plan.fingerprint);
      return true;
    });
    assert.equal(pulls, 1);
    assert.equal(f.applyCalls(), 0);
    assert.equal(f.store.calls.apply, 0);
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
      {
        assert.equal(result.status, "waiting_for_owner");
        assert.equal(result.reason_code, "removal_review");
        const row = result.sources[0];
        assert.equal(row.status, "waiting_for_owner");
        assert.equal(row.reason_code, "removal_review");
        assert.equal(row.issue_code, "SAFETY_REVIEW_REQUIRED");
        assert.equal(f.runs(), 1, "failed apply/readback never reruns the source");
        assert.equal(f.applyCalls(), 0);
        const review = row.removal_reviews[0];
        assert.equal(review.reasons.source_deleted, failure === "held" ? 26 : 1);
        const command = renderCliCommands(`brain ingest <manifest> --from calendar --source calendar --apply-removals ${review.fingerprint}`);
        assert.equal(review.apply_command, command);
        assert.ok(row.reason.includes("Calendar is waiting for your OK to remove"));
        assert.ok(row.reason.includes(command));
        assert.ok(output.some((line) => line.includes(row.reason)));
        assert.ok(f.state.ingest_removal_plan, "failure preserves the saved review");
        assert.equal(row.auto_applied_removals, undefined);
        const schedule = dailyObservationStatus(dailyPlan, { enabled: false }, { known: true, running: false, exit_code: 0 },
          true, { home: f.home, now });
        assert.equal(schedule.last_result, "waiting_for_owner");
        assert.equal(schedule.status, "waiting_for_owner");
        assert.equal(schedule.reason_code, "removal_review");
        assert.equal(schedule.source_issues[0].reason_code, "removal_review");
        assert.deepEqual(schedule.source_issues[0].removal_reviews, row.removal_reviews);
      }
      assert.deepEqual(receipts.at(-1), result);
    } finally { f.close(); }
  });
}
