import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Acceptance } from "../acceptance.mjs";
import { ownerAcceptanceRows, ownerDoctorRow, ownerSourceRows, ownerUpdateRows, acceptanceDiagnostics } from "../operations/owner-checklist.mjs";

const productVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function ownerFixture(t) {
  const home = mkdtempSync(join(tmpdir(), "owner-checklist-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const manifest = join(home, "brain.manifest.json");
  writeFileSync(manifest, JSON.stringify({
    client: { slug: "fixture" },
    brain: { version: "0.4.32", domain: "brain.example.invalid", worker_name: "fixture-brain" },
    infrastructure: { cloudflare: { account_id: "a".repeat(32),
      storage: "d1", d1_database_id: "11111111-2222-4333-8444-555555555555", vectorize_index: "fixture" } },
  }));
  return { manifest, home };
}

test("clean update checklist shows only proven checks, with quality detail retained for support", () => {
  const results = [
    { name: "health responds", status: "pass", detail: "version 0.4.33" },
    { name: "every source expected to refresh is current", status: "warn", detail: "no refresh schedule" },
    { name: "freshness: gmail", status: "warn", detail: "NO REFRESH IS SCHEDULED" },
    { name: "document boundary reading", status: "warn", detail: "attributed source reading returned below High confidence" },
  ];
  assert.deepEqual(ownerAcceptanceRows({ results, sources: [{ kind: "gmail", state: "unscheduled" }] }), [
    "✔ Brain is online",
  ]);
  assert.deepEqual(acceptanceDiagnostics({ results }), [results[3]]);
});

test("owner source evidence stays out of generic acceptance summaries", () => {
  const suite = new Acceptance({ base: "https://brain.example.invalid" });
  suite.sources = [{ name: "gmail", kind: "gmail", state: "ok" }];
  assert.equal(Object.hasOwn(suite.summary(), "sources"), false);
});

test("scheduled Gmail continuation and rate limits stay pending", () => {
  assert.deepEqual(ownerSourceRows([
    { name: "gmail", kind: "gmail", state: "indexing", expected_every_days: 1 },
    { name: "drive", kind: "drive", state: "broken", expected_every_days: 1, continuation: "rate_limited" },
    { name: "calendar", kind: "calendar", state: "ok" },
  ]), [
    "✔ Calendar is up to date",
    "Gmail is catching up and will finish on its own.",
    "Google Drive will continue on its next scheduled run.",
  ]);
});

test("real failures keep one line with an action and no private diagnostics", () => {
  const results = [
    { name: "wrong key is refused", status: "fail", detail: "private diagnostic" },
    { name: "unauthenticated request is refused", status: "fail", detail: "private diagnostic" },
  ];
  assert.deepEqual(ownerAcceptanceRows({ results }), [
    "Brain access protection needs attention. Ask your installer to check it.",
  ]);
  assert.deepEqual(ownerSourceRows([
    { name: "gmail", kind: "gmail", state: "broken", continuation: "rate_limited" },
  ]), ["Gmail could not finish updating. Ask your installer to check it."]);
  assert.equal(ownerDoctorRow({ name: "Bank feed", status: "fail", detail: "private diagnostic" }),
    "Bank feed needs attention. Ask your installer to check it.");
});

test("a saved bank sign-in problem stays visible when the update itself passed", () => {
  assert.deepEqual(ownerUpdateRows({ version: "0.4.33", bank: [
    { state: "reauth_required", ok: true }, { state: "connected", ok: true },
  ] }), ["✔ Version 0.4.33", "Bank access needs attention. Ask your installer to check it."]);
  assert.deepEqual(ownerUpdateRows({ version: "0.4.33", bank: [
    { state: "removed", ok: false }, { state: "connected", ok: true },
  ] }), ["✔ Version 0.4.33", "✔ Bank connected"]);
});

test("a pending version commit is checked after acceptance instead of reported as a mismatch", async () => {
  const suite = new Acceptance({ manifest: { brain: { version: "0.4.32" } },
    expectVersion: "0.4.33", versionReadbackAfterAcceptance: true });
  suite.observedVersion = "0.4.33";
  await suite.tierOperations({ schema_version: 1, gate_version: 2, product_version: "0.4.32" });
  assert.ok(!suite.results.some(row => row.name === "install state records the running version"));
  assert.match(readFileSync(new URL("../skills/financial-brain-technician/SKILL.md", import.meta.url), "utf8"),
    /checkmarks first[\s\S]{0,500}internal codes or scores/i);
});

test("a partial Gmail receipt needs a matched continuation marker and measured clean outcomes", async () => {
  const { sourceRefreshContinuation } = await import("../worker/src/lib/store-d1.js");
  const now = Date.parse("2026-11-21T10:00:00Z");
  const run = { run_id: "gmail-run", finished_at: "2026-11-21T09:00:00Z", walk_complete: 0, metrics_version: 1,
    docs_failed: 0, docs_refused: 0 };
  const source = { kind: "gmail", expected_refresh_seconds: 86400, gmail_ingest_detail: "gmail backfill sync completed; more_history=1; withheld_for_secrets=0 run_id=gmail-run" };
  assert.equal(sourceRefreshContinuation(source, run, null, now), "catching_up");
  assert.equal(sourceRefreshContinuation(source, { ...run, docs_failed: 1 }, null, now), null);
  assert.equal(sourceRefreshContinuation({ ...source, gmail_ingest_detail: null }, run, null, now), null);
  assert.equal(sourceRefreshContinuation(source, { ...run, error: "INGEST_FAILED" }, { http_status: 429, checkpoint_readback: "verified", cursor_preservation: "present_preserved" }, now), "rate_limited");
  assert.equal(sourceRefreshContinuation(source, { ...run, error: "INGEST_FAILED" }, { http_status: 429, checkpoint_readback: "verified", cursor_preservation: "present_preserved" }, now + 172800000), null);
});

test("the freshness read projects only the matching Gmail continuation receipt", async t => {
  const [{ createProductFixture }, { freshnessReport }] = await Promise.all([
    import("../worker/test/product-contract-fixture.mjs"), import("../worker/src/lib/store-d1.js"),
  ]);
  const fixture = await createProductFixture();
  t.after(() => fixture.close());
  const finished = "2026-11-21T09:00:00.000Z";
  const now = Date.parse("2026-11-21T10:00:00.000Z");
  fixture.raw(`INSERT INTO sources (name, kind, status, created_at, last_ingest_at, expected_refresh_seconds)
    VALUES ('gmail', 'gmail', 'ready', ?, ?, 86400)`, finished, finished);
  fixture.raw(`INSERT INTO sync_runs (run_id, source, lane, started_at, finished_at, walk_complete,
    metrics_version, docs_failed, docs_refused)
    VALUES ('gmail-run', 'gmail', 'history', ?, ?, 0, 1, 0, 0)`, now - 7200000, finished);
  fixture.raw(`INSERT INTO source_events (source_name, event, at, detail)
    VALUES ('gmail', 'ingest', ?, 'gmail history sync completed; more_history=1; withheld_for_secrets=0 run_id=gmail-run')`, finished);
  const report = await freshnessReport(fixture.env, { now });
  assert.equal(report.sources[0]?.continuation, "catching_up");
  assert.doesNotMatch(JSON.stringify(report), /gmail-run|withheld_for_secrets/);
  fixture.raw("UPDATE sync_runs SET docs_failed = 1 WHERE run_id = 'gmail-run'");
  assert.equal((await freshnessReport(fixture.env, { now })).sources[0]?.continuation, undefined);
});

test("Check my Brain prints passes first and keeps a broken check to one calm line", async t => {
  const { cmdDoctor } = await import("../brain.mjs");
  const { manifest } = ownerFixture(t);
  const rows = [];
  const broken = { name: "Bank feed", status: "fail", detail: "internal detail", fix: "internal code" };
  const unused = { name: "Google connection", status: "warn", detail: "not connected" };
  await assert.rejects(cmdDoctor(manifest, {
    doctorRunAll: async ({ onResult }) => {
      onResult(broken);
      return [broken, unused, { name: "Node", status: "ok" }];
    },
    withAvailableCloudflareToken: async run => run(),
    buildUpgradePauseCheck: async () => ({ name: "upgrade state", status: "ok", version: "0.4.33" }),
    buildAnthropicWorkerSecretCheck: async () => ({ name: "Anthropic Worker key", status: "ok", detail: "not required" }),
    buildChecksumDriftCheck: async () => ({ name: "migration checksums", status: "ok" }),
    checkBankFeedRedirect: () => broken,
    checkPrioritySlice: () => ({ name: "priority slice", status: "ok", detail: "handoff is complete" }),
    readOwnerFreshness: async () => [{ name: "gmail", kind: "gmail", state: "ok" }],
    readOwnerDaily: async () => ({ present: true, enabled: true, schedule: ["09:00", 1, true] }),
    reportChecklist: line => rows.push(line),
  }), { ownerMessage: "Bank feed needs attention. Ask your installer to check it." });
  assert.deepEqual(rows, [
    "✔ Local runtime checked", "✔ Version 0.4.33", "✔ Brain database checked",
    "✔ Daily update on, scheduled for 9:00 AM", "✔ Gmail is up to date",
  ]);
  assert.equal(ownerDoctorRow(unused, { googleExpected: true }),
    "Google connection needs attention. Ask your installer to check it.");
});

for (const state of ["ok", "indexing", "broken"]) {
  test(`Update my Brain reports the final ${state} source state`, async t => {
    const { cmdUpdate } = await import("../brain.mjs");
    const { manifest, home } = ownerFixture(t);
    const finish = [];
    await cmdUpdate(manifest, {
      lifecycleLockHeld: true,
      home,
      withCloudflareControl: async run => run(),
      adoptCloudflareAuthProfile: async () => {},
      readUpdateBacklog: async () => ({ pending: 0 }),
      cmdVerify: async () => {},
      cmdUpgrade: async (_path, { onOwnerAcceptance }) => {
        onOwnerAcceptance({
          passed: true,
          results: [
            { name: "health responds", status: "pass" },
            { name: "document boundary reading", status: "warn", detail: "below High confidence",
              diagnostic: { confidence_percent: 81 } },
          ],
          sources: [{ name: "gmail", kind: "gmail", state, expected_every_days: 1 }],
        });
      },
      dailyRefreshOptions: { platform: "linux" },
      installTechnicianSkills: () => [{ root: ".codex", status: "verified" }],
      installedManifestOptions: { home, stateDirectory: join(home, "state") },
      reportSkillRefreshOk: () => {},
      reportUpdateFinish: line => finish.push(line),
    });
    assert.deepEqual(finish, [[
      `✔ Version ${productVersion}`,
      "✔ Brain is online",
      {
        ok: "✔ Gmail is up to date",
        indexing: "Gmail is catching up and will finish on its own.",
        broken: "Gmail could not finish updating. Ask your installer to check it.",
      }[state],
    ].join("\n")]);
  });
}

test("assistant reconnection reports its failure once through the update checklist", async t => {
  const { wireAgents } = await import("../brain.mjs");
  const { manifest } = ownerFixture(t);
  const checks = [];
  t.mock.method(console, "log", line => checks.push(line));
  const result = await wireAgents({}, manifest, {
    quiet: true,
    platform: "darwin",
    targets: ["claude-code-mcp"],
    baseUrl: "https://brain.example.invalid",
    runCommand: () => ({ ok: true, out: "fixture 1.2.3" }),
    adminKeyPersistencePlan: () => ({}),
    readAdminKeyDurably: () => null,
  });
  assert.deepEqual(result.failures, ["durable-key"]);
  assert.deepEqual(checks, []);
});

test("owner checkup names the followed custom API endpoint move", () => {
  const rows = ownerSourceRows([{
    name: "store-dashboard", kind: "custom_api", state: "ok",
    endpoint_moves: [{endpoint: "sales", old_path: "/api/sales", new_path: "/v2/sales"}],
  }]);
  assert.match(rows.join("\n"), /sales moved from \/api\/sales to \/v2\/sales\. The Brain followed it/);
});
