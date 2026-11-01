import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sync from "../operations/curated-dual-sync.mjs";
import * as scheduler from "../operations/curated-sync-scheduler.mjs";

const now = new Date("2026-10-01T12:00:00.000Z");
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => JSON.stringify(body),
});

function fixture(t, count = 3, rawDrive = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "curated-readback-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(join(root, "corpus"), { mode: 0o700 });
  const documents = Array.from({ length: count }, (_, i) => ({
    relative_path: `fixture-${i}.md`, role: "plain",
    legacy_source_type: "custom", legacy_source_id: `fixture-${i}`,
  }));
  const done = {};
  for (const [i, document] of documents.entries()) {
    const content = `# Synthetic document ${i}\nSynthetic body.\n`;
    const path = join(root, "corpus", document.relative_path);
    writeFileSync(path, content, { mode: 0o600 });
    utimesSync(path, now, now);
    done[`drive:fixture-${i}`] = JSON.stringify([
      "revision", createHash("md5").update(content).digest("hex"),
      document.relative_path, "text/markdown", "Fixture",
    ]);
  }
  const plan = {
    schema_version: 1, root: "corpus", expected_documents: count,
    expected_roles: { authoritative: 0, superseded: 0, plain: count },
    ledger_namespace: "synthetic-readback-v1", documents,
    transforms: Object.fromEntries(["authoritative", "superseded", "plain"].map(role => [
      role, { content_prefix: "", title_prefix: "" },
    ])),
    cloudflare_target: { manifest: "target.json", backend: "cloudflare_d1" },
    ledger_file: "coverage.json",
    scheduler: { slug: "fixture-curated", cron: "10 7 * * *", timezone: "UTC" },
    ...(rawDrive ? { raw_drive: {
      state_file: "drive-state.json", path_prefix: "Fixture", match: "path", require_state_match: true,
    } } : {}),
  };
  const path = join(root, "plan.json");
  writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
  writeFileSync(join(root, "target.json"), JSON.stringify({
    brain: { domain: "fixture.invalid" }, infrastructure: { cloudflare: { storage: "d1" } },
  }), { mode: 0o600 });
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  if (rawDrive) writeFileSync(join(root, "drive-state.json"), JSON.stringify({ version: 6, done }), { mode: 0o600 });
  const prepared = sync.prepareCuratedCorpus(plan, { planDirectory: root });
  const byId = new Map(prepared.documents.map(document => [document.cloudflareEnvelope.source_id, document]));
  const calls = [];
  const fetch = async (url, options) => {
    const route = new URL(url);
    assert.equal(route.origin, "https://fixture.invalid");
    assert.equal(route.search, "", "private identities stay in JSON bodies");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "manual");
    const body = JSON.parse(options.body);
    calls.push({ path: route.pathname, source: body.source, body });
    if (route.pathname.endsWith("/ingest")) {
      assert.ok(byId.has(body.source_id));
      return reply({ doc_uid: `curated:${body.source_id}`, action: "unchanged" });
    }
    if (route.pathname.endsWith("/curated-verify")) {
      const document = byId.get(body.source_id);
      assert.deepEqual(body, document.cloudflareEnvelope);
      return reply({ confirmed: true, doc_uid: `curated:${body.source_id}`, envelope_sha256: document.envelopeHash });
    }
    assert.equal(route.pathname, "/api/admin/brain/source-families");
    return reply({ source: body.source, families: body.source === "curated"
      ? [...byId.keys()].map(id => `curated:${id}`) : Object.keys(done), next_cursor: null });
  };
  const options = {
    mode: "sync", home, planPath: path, planDirectory: root, fetch,
    resolveTarget: async () => ({ baseUrl: "https://fixture.invalid", backend: "cloudflare_d1",
      adminKey: readFileSync(join(root, ".brain-admin-key"), "utf8") }),
  };
  const common = { platform: "darwin", uid: process.getuid?.() ?? 501, home, localTimeZone: "UTC", now };
  return { root, path, plan, calls, options, common };
}

function countCalls(f, suffix) {
  return f.calls.filter(call => call.path.endsWith(suffix)).length;
}

// A real abortable delay models slow inventory pages without a large corpus or
// a provider request. Keep a timer alive because AbortSignal.timeout is unref'd.
async function inventoryTimeout(signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1_000);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  throw new Error("synthetic inventory exceeded its timeout");
}

test("49 accepted revisions confirm independently of a large slow inventory", async t => {
  const f = fixture(t, 49);
  const control = await sync.runCuratedDualSync(f.plan, f.options);
  assert.equal(control.ok, true);
  assert.equal(countCalls(f, "/ingest"), 49);
  assert.equal(countCalls(f, "/curated-verify"), 49);
  f.calls.length = 0;
  let pages = 0;
  let timeouts = 0;
  const inventory = Array.from({ length: 100_000 }, (_, i) =>
    `curated:unrelated-${String(i).padStart(6, "0")}`);
  const report = await sync.runCuratedDualSync(f.plan, { ...f.options, targetTimeoutMs: 20,
    fetch: async (url, options) => {
      const control = await f.options.fetch(url, options);
      if (!new URL(url).pathname.endsWith("/source-families")) return control;
      if (++pages === 1) {
        await new Promise(resolve => setTimeout(resolve, 5));
        return reply({ source: "curated", families: inventory.slice(0, 1000), next_cursor: inventory[999] });
      }
      timeouts++;
      return inventoryTimeout(options.signal);
    },
  });
  assert.equal(inventory.length, 100_000);
  assert.equal(countCalls(f, "/ingest"), 49, "the failure arm reached every accepted write");
  assert.equal(report.actions.cloudflare.unchanged, 49);
  t.diagnostic(JSON.stringify({ accepted: 49, confirmed: report.targetCoverage.cloudflare_confirmed.total,
    invalid_receipts: report.ledger.documents.filter(document => document.targets.cloudflare === "invalid_receipt").length,
    revision_reads: countCalls(f, "/curated-verify"), inventory_pages: pages, inventory_timeouts: timeouts }));
  assert.equal(report.ok, true, `accepted writes lost confirmation after ${pages} inventory pages and ${timeouts} timeouts`);
  assert.equal(report.targetCoverage.cloudflare_confirmed.total, 49);
  assert.equal(countCalls(f, "/curated-verify"), 49);
  assert.equal(pages, 0, "sync performs no full inventory request");
});

test("historical Drive inventory is an explicit deferred advisory during sync", async t => {
  const f = fixture(t, 3, true);
  const control = await sync.runCuratedDualSync(f.plan, { ...f.options, mode: "audit" });
  assert.equal(control.ok, true);
  assert.equal(control.rawDriveHistoricalChecksumMatches.total, 3);
  assert.equal(countCalls(f, "/ingest"), 0);
  f.calls.length = 0;
  let timedOut = 0;
  const fetch = async (url, options) => {
    const control = await f.options.fetch(url, options);
    if (JSON.parse(options.body).source !== "drive") return control;
    timedOut++;
    return inventoryTimeout(options.signal);
  };
  const failedAudit = await sync.runCuratedDualSync(f.plan, { ...f.options, mode: "audit", fetch, targetTimeoutMs: 20 });
  assert.equal(failedAudit.ok, false);
  assert.equal(timedOut, 1, "the explicit audit reached the failing inventory request");
  f.calls.length = 0;
  const report = await sync.runCuratedDualSync(f.plan, { ...f.options, fetch, targetTimeoutMs: 20 });
  assert.equal(countCalls(f, "/ingest"), 3);
  assert.equal(report.ok, true, "historical audit availability cannot fail current revision confirmation");
  assert.deepEqual(report.advisories, ["RAW_DRIVE_AUDIT_DEFERRED"]);
  assert.equal(countCalls(f, "/source-families"), 0);
  assert.ok(report.ledger.documents.every(document => document.raw_drive === "not_verified"));
  assert.equal(report.ledger.raw_drive_evidence.deletion_eligible, false);
});

test("exact revision faults fail closed with bounded existing support codes", async t => {
  for (const [fault, code] of [
    ["timeout", "NETWORK_UNREACHABLE"], ["body-timeout", "NETWORK_UNREACHABLE"],
    ["http-404", "REMOTE_NOT_FOUND"], ["http-503", "REMOTE_UNAVAILABLE"],
    ["http-429", "RATE_LIMITED"], ["http-401", "AUTH_EXPIRED"],
    ["http-403", "REMOTE_PERMISSION_DENIED"], ["wrong-identity", "INPUT_REFUSED"],
    ["wrong-revision", "INPUT_REFUSED"], ["unconfirmed", "INPUT_REFUSED"],
    ["redirect", "REMOTE_PERMISSION_DENIED"], ["malformed", "INPUT_REFUSED"],
  ]) await t.test(fault, async t => {
    const f = fixture(t);
    assert.equal((await sync.runCuratedDualSync(f.plan, f.options)).ok, true);
    f.calls.length = 0;
    const report = await sync.runCuratedDualSync(f.plan, { ...f.options, targetTimeoutMs: 20,
      fetch: async (url, options) => {
        const control = await f.options.fetch(url, options);
        if (!new URL(url).pathname.endsWith("/curated-verify")) return control;
        if (fault === "timeout") return inventoryTimeout(options.signal);
        if (fault === "body-timeout") return { ...control, text: () => inventoryTimeout(options.signal) };
        if (fault.startsWith("http-")) return { ...control, ok: false, status: Number(fault.slice(5)), text: async () => "not JSON" };
        if (fault === "redirect") return { ...control, url: "https://redirect.invalid/readback" };
        if (fault === "malformed") return { ...control, text: async () => "{" };
        const body = JSON.parse(await control.text());
        if (fault === "wrong-identity") body.doc_uid = "curated:unrelated";
        if (fault === "wrong-revision") body.envelope_sha256 = "0".repeat(64);
        if (fault === "unconfirmed") body.confirmed = false;
        return reply(body);
      },
    });
    assert.equal(countCalls(f, "/ingest"), 3);
    assert.equal(countCalls(f, "/curated-verify"), 3, "every accepted write reached the negative decision point");
    assert.equal(report.ok, false);
    assert.equal(report.targetCoverage.cloudflare_confirmed.total, 0);
    assert.ok(report.ledger.documents.every(document => document.targets.cloudflare === "invalid_receipt"));
    assert.deepEqual(report.failure, { phase: "readback", code });
  });
});

test("a target HTTP refusal keeps its code even when the error body is not JSON", async t => {
  const f = fixture(t);
  assert.equal((await sync.runCuratedDualSync(f.plan, f.options)).ok, true);
  f.calls.length = 0;
  const report = await sync.runCuratedDualSync(f.plan, { ...f.options, fetch: async (url, options) => {
    const control = await f.options.fetch(url, options);
    if (!new URL(url).pathname.endsWith("/ingest")) return control;
    return { ...control, ok: false, status: 503, text: async () => { throw new Error("private-response-sentinel"); } };
  } });
  assert.equal(countCalls(f, "/ingest"), 3, "the refusal reached every target write");
  assert.equal(countCalls(f, "/curated-verify"), 0, "unaccepted writes are never verified");
  assert.equal(report.ok, false);
  assert.deepEqual(report.failure, { phase: "target", code: "REMOTE_UNAVAILABLE" });
  assert.equal(JSON.stringify(report).includes("private-response-sentinel"), false);
});

test("scheduled readback failure preserves freshness and journals the same safe code as the log", async t => {
  const f = fixture(t, 3, true);
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  mkdirSync(plan.locksDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.lockPath, "", { mode: 0o600 });
  const fd = openSync(plan.lockPath, "r+");
  t.after(() => closeSync(fd));
  let fault = false;
  const options = {
    ...f.common, expectedConfigHash: plan.configHash, lockDescriptor: fd,
    inspectLockParent: () => "/usr/bin/lockf", probeLockContention: () => ({ status: 75 }),
    runSync: (input, opts) => sync.runCuratedDualSync(input, { ...f.options, ...opts, targetTimeoutMs: 20,
      fetch: async (url, options) => {
        const control = await f.options.fetch(url, options);
        if (fault && new URL(url).pathname.endsWith("/curated-verify")) return inventoryTimeout(options.signal);
        return control;
      },
    }),
  };
  const control = await scheduler.executeScheduledCuratedSync(f.path, options);
  assert.equal(control.status, "complete");
  assert.deepEqual(control.advisories, ["RAW_DRIVE_AUDIT_DEFERRED"]);
  const freshness = readFileSync(plan.freshnessPath);
  f.calls.length = 0;
  fault = true;
  let failure;
  try { await scheduler.executeScheduledCuratedSync(f.path, options); }
  catch (error) { failure = error; }
  assert.equal(countCalls(f, "/ingest"), 3);
  assert.equal(countCalls(f, "/curated-verify"), 3);
  assert.ok(failure);
  assert.deepEqual(readFileSync(plan.freshnessPath), freshness);
  const message = scheduler.curatedSchedulerFailureMessage(failure);
  assert.match(message, /readback.*NETWORK_UNREACHABLE/);
  const eventId = scheduler.recordCuratedSchedulerFailure({ error: failure, journalOptions: { root: f.common.home, now } });
  assert.match(eventId, /^evt_[0-9a-f]{32}$/);
  const directory = join(f.common.home, ".brain", "support", "events");
  const files = readdirSync(directory);
  assert.equal(files.length, 1);
  const event = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
  assert.equal(event.error_code, "NETWORK_UNREACHABLE");
  for (const value of ["Synthetic body", "fixture-0", "fixture.invalid", f.path]) {
    assert.equal((message + JSON.stringify(event)).includes(value), false);
  }
});

test("untrusted exceptions cannot place content or invented codes in scheduler diagnostics", async t => {
  const f = fixture(t);
  const error = Object.assign(new Error("private-diagnostic-sentinel"), {
    supportCode: "private-code-sentinel", phase: "private-phase-sentinel",
  });
  assert.equal(typeof scheduler.curatedSchedulerFailureMessage, "function");
  const message = scheduler.curatedSchedulerFailureMessage(error);
  assert.match(message, /SCHEDULE_RUN_FAILED/, "unexpected failures also name their stable support code in the log");
  assert.equal(message.includes("sentinel"), false);
  const eventId = scheduler.recordCuratedSchedulerFailure({ error, journalOptions: { root: f.common.home, now } });
  assert.match(eventId, /^evt_[0-9a-f]{32}$/);
  const event = JSON.parse(readFileSync(join(f.common.home, ".brain", "support", "events", `${eventId}.json`), "utf8"));
  assert.equal(event.error_code, "SCHEDULE_RUN_FAILED");
  assert.equal(JSON.stringify(event).includes("sentinel"), false);
});
