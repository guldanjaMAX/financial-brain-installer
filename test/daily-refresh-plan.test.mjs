import assert from "node:assert/strict";
import test from "node:test";

import { dailyRefreshPrincipal, planDailyRefresh } from "../operations/daily-refresh-plan.mjs";

const manifest = (overrides = {}) => ({
  client: { slug: "owner-brain", timezone: "America/Phoenix" },
  brain: { worker_name: "owner-brain", domain: "brain.example.invalid" },
  infrastructure: { cloudflare: { account_id: "account", d1_database_id: "database" } },
  corpora: {
    google_drive: { enabled: true },
    gmail: { enabled: false },
    local_folder: { enabled: true, path: "/fixtures/inbox", source: "folder" },
    custom_api: { enabled: true, source: "records" },
    zoom: { enabled: true },
    iphone_backup: { enabled: true },
    future_source: { enabled: true },
  },
  operations: {
    daily_refresh: {
      enabled: true,
      cron: "0 9 * * *",
      timezone: "America/Phoenix",
      max_runtime_minutes: 45,
    },
  },
  ...overrides,
});

const entries = [
  { key: "google_drive", enabled: true, status: "ready", legs: [{ source: "drive" }] },
  { key: "gmail", enabled: false, status: "skipped", reason: "not enabled", legs: [] },
  { key: "local_folder", enabled: true, status: "skipped", reason: "owned elsewhere", daily_class: "machine-pull", daily_owner: "existing-local-scheduler", legs: [] },
  { key: "custom_api", enabled: true, status: "skipped", reason: "Worker cron", daily_class: "server-managed", daily_owner: "worker-cron", legs: [] },
  { key: "zoom", enabled: true, status: "skipped", reason: "webhook", daily_class: "push", daily_owner: "push", legs: [] },
  { key: "iphone_backup", enabled: true, status: "skipped", reason: "snapshot", daily_class: "snapshot", daily_owner: "snapshot", legs: [] },
  { key: "future_source", enabled: true, status: "unavailable", reason: "no loader", legs: [] },
];

test("Windows identity is the exact current-user SID and fails closed when it cannot be read", () => {
  let calls = 0;
  const principal = dailyRefreshPrincipal({
    platform: "win32",
    uid: null,
    environment: { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" },
    spawn: (command, args, options) => {
      calls += 1;
      assert.equal(command, "C:\\Windows\\System32\\whoami.exe");
      assert.deepEqual(args, ["/user", "/fo", "csv", "/nh"]);
      assert.deepEqual(options.env, { SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows" });
      assert.equal("PATH" in options.env, false, "SID lookup never inherits the desktop PATH or credentials");
      return { status: 0, stdout: `"fixture","S-1-5-21-123456"\r\n` };
    },
  });
  assert.equal(calls, 1, "the native principal decision point was reached");
  assert.equal(principal, "sid:S-1-5-21-123456");
  assert.throws(
    () => dailyRefreshPrincipal({
      platform: "win32", uid: null, spawn: () => ({ status: 1, stdout: "" }),
    }),
    /user SID is unavailable/i,
  );
});

test("daily plan comes from every manifest corpus and reports unsupported sources", async () => {
  let planningCalls = 0;
  const plan = await planDailyRefresh({
    m: manifest(),
    manifestPath: "/fixtures/brain.manifest.json",
    platform: "win32",
    principal: "sid:S-1-5-21-owner",
    planLoadFn: async () => {
      planningCalls += 1;
      return entries;
    },
  });

  assert.equal(planningCalls, 1, "the real load-planning decision point was reached");
  assert.deepEqual(plan.sources.map((source) => source.key), Object.keys(manifest().corpora));
  assert.equal(plan.sources.find((source) => source.key === "google_drive").owner, "daily-task");
  assert.equal(plan.sources.find((source) => source.key === "gmail").class, "disabled");
  assert.equal(plan.sources.find((source) => source.key === "local_folder").owner, "existing-local-scheduler");
  assert.equal(plan.sources.find((source) => source.key === "custom_api").owner, "worker-cron");
  assert.equal(plan.sources.find((source) => source.key === "zoom").owner, "push");
  assert.equal(plan.sources.find((source) => source.key === "iphone_backup").class, "snapshot");
  assert.equal(plan.sources.find((source) => source.key === "future_source").class, "unsupported");
  assert.equal(plan.ready, false, "one enabled unsupported source fails the plan visibly");
  assert.equal(plan.unsupported_sources, 1);
});

test("identity survives manifest edits but separates Brains and users", async () => {
  const makePlan = (m, principal) => planDailyRefresh({
    m,
    manifestPath: "/fixtures/brain.manifest.json",
    platform: "darwin",
    principal,
    planLoadFn: async () => entries.filter((entry) => entry.key !== "future_source"),
  });
  const first = await makePlan(manifest({ corpora: { google_drive: { enabled: true } } }), "uid:501");
  const edited = await makePlan(manifest({ corpora: { google_drive: { enabled: false } } }), "uid:501");
  const anotherUser = await makePlan(manifest({ corpora: { google_drive: { enabled: true } } }), "uid:502");
  const anotherBrain = await makePlan({
    ...manifest({ corpora: { google_drive: { enabled: true } } }),
    infrastructure: { cloudflare: { account_id: "account", d1_database_id: "other-database" } },
  }, "uid:501");

  assert.equal(first.identity.id, edited.identity.id, "content edits do not rename the owned schedule");
  assert.notEqual(first.manifest_content_hash, edited.manifest_content_hash, "content drift remains detectable");
  assert.notEqual(first.source_plan_hash, edited.source_plan_hash, "an enabled-bit mutation changes the source plan");
  assert.notEqual(first.identity.id, anotherUser.identity.id, "user identity participates in ownership");
  assert.notEqual(first.identity.id, anotherBrain.identity.id, "Brain identity participates in ownership");
});

test("invalid daily configuration fails closed while the bounded control remains ready", async () => {
  const configuredManifest = manifest({
    corpora: { google_drive: { enabled: true } },
    operations: { daily_refresh: { enabled: true, cron: "0 9 * * *", max_runtime_minutes: 721 } },
  });
  let planningCalls = 0;
  const invalid = await planDailyRefresh({
    m: configuredManifest,
    manifestPath: "/fixtures/brain.manifest.json",
    platform: "win32",
    principal: "user:fixture",
    localTimezone: "America/Phoenix",
    planLoadFn: async () => { planningCalls += 1; return entries.slice(0, 1); },
  });
  assert.equal(planningCalls, 1, "the malformed configuration reached the planning decision point");
  assert.equal(invalid.ready, false);
  assert.match(invalid.configuration_error, /1 through 720/);

  configuredManifest.operations.daily_refresh.max_runtime_minutes = 45;
  const control = await planDailyRefresh({
    m: configuredManifest,
    manifestPath: "/fixtures/brain.manifest.json",
    platform: "win32",
    principal: "user:fixture",
    localTimezone: "America/Phoenix",
    planLoadFn: async () => entries.slice(0, 1),
  });
  assert.equal(control.ready, true, "the bounded control remains schedulable");
});
