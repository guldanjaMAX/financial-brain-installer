import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync,
  realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sync from "../operations/curated-dual-sync.mjs";
import * as scheduler from "../operations/curated-sync-scheduler.mjs";

const now = new Date("2026-10-01T12:00:00.000Z");
function fixture(t, dual = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "curated-targets-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "corpus"), { mode: 0o700 });
  mkdirSync(join(root, "home"), { mode: 0o700 });
  for (const name of ["alpha", "beta", "gamma"]) {
    const path = join(root, "corpus", `${name}.md`);
    writeFileSync(path, `# Synthetic ${name}\nFixture body.\n`, { mode: 0o600 });
    utimesSync(path, now, now);
  }
  const plan = {
    schema_version: 1, root: "corpus", expected_documents: 3,
    expected_roles: { authoritative: 1, superseded: 1, plain: 1 },
    ledger_namespace: "synthetic-curated-targets-v1",
    transforms: Object.fromEntries(["authoritative", "superseded", "plain"].map(role => [role, { content_prefix: "", title_prefix: "" }])),
    documents: ["alpha", "beta", "gamma"].map((name, i) => ({
      relative_path: `${name}.md`, role: ["authoritative", "superseded", "plain"][i],
      legacy_source_type: "custom", legacy_source_id: `fixture-${name}`,
    })),
    cloudflare_target: { manifest: "cloudflare.manifest.json", backend: "cloudflare_d1" },
    ...(dual ? { legacy_target: { manifest: "legacy.manifest.json", backend: "legacy_notes_supabase" } } : {}),
    ledger_file: "coverage.json",
    scheduler: { slug: "fixture-curated", cron: "10 7 * * *", timezone: "UTC" },
  };
  for (const name of dual ? ["legacy", "cloudflare"] : ["cloudflare"]) {
    writeFileSync(join(root, `${name}.manifest.json`), JSON.stringify({
      brain: { domain: `${name}.fixture.invalid` },
      infrastructure: { cloudflare: { storage: "d1" } },
    }), { mode: 0o600 });
  }
  // Production resolution uses only this synthetic adjacent file, never a host store.
  writeFileSync(join(root, ".brain-admin-key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const path = join(root, "plan.json");
  const save = () => writeFileSync(path, JSON.stringify(plan), { mode: 0o600 });
  save();
  const calls = [];
  const fetch = async (url, options) => {
    const parsed = new URL(url);
    assert.ok(["cloudflare.fixture.invalid", "legacy.fixture.invalid"].includes(parsed.hostname));
    const body = JSON.parse(options.body);
    calls.push({ host: parsed.hostname, path: parsed.pathname, source: body.source });
    if (parsed.pathname === "/api/admin/brain/curated-verify") {
      const document = sync.prepareCuratedCorpus(plan, { planDirectory: root }).documents
        .find(item => item.cloudflareEnvelope.source_id === body.source_id);
      const result = { doc_uid: `curated:${body.source_id}`, confirmed: true, envelope_sha256: document.envelopeHash };
      return { ok: true, status: 200, text: async () => JSON.stringify(result) };
    }
    const result = parsed.pathname === "/api/admin/brain/source-families"
      ? { source: body.source, families: body.source === "curated"
          ? plan.documents.map(d => `curated:brain:${d.legacy_source_type}:${d.legacy_source_id}`)
          : [], next_cursor: null }
      : parsed.hostname.startsWith("legacy")
        ? { brain_doc_id: "fixture-receipt", action: "unchanged" }
        : { doc_uid: `curated:${body.source_id}`, action: "unchanged" };
    return { ok: true, status: 200, text: async () => JSON.stringify(result) };
  };
  const options = { mode: "sync", planDirectory: root, planPath: path, fetch,
    runChild: () => { throw new Error("credential helper forbidden"); } };
  const common = { platform: "darwin", uid: process.getuid?.() ?? 501,
    home: join(root, "home"), localTimeZone: "UTC", now };
  return { root, plan, path, save, calls, options, common };
}

test("dual control preserves exact ledger bytes and both targets", async t => {
  const f = fixture(t, true);
  const report = await sync.runCuratedDualSync(f.plan, f.options);
  assert.equal(report.ok, true);
  assert.equal(f.calls.length, 10);
  assert.equal(f.calls.filter(call => call.path.endsWith("/curated-verify")).length, 3);
  assert.deepEqual(report.actions, { legacy: { created: 0, updated: 0, unchanged: 3 }, cloudflare: { created: 0, updated: 0, unchanged: 3 } });
  assert.deepEqual(Object.keys(report.targetCoverage), ["cloudflare_confirmed", "legacy_confirmed"]);
  const bytes = readFileSync(join(f.root, "coverage.json"));
  const hash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(hash, "fa26de09f7f0da0e73d92be0a2d3fc6a9d11b26bd94ad57ced3b6a04039da7d4");
});

test("Cloudflare-only sync confirms writes and emits no legacy aggregates", async t => {
  const f = fixture(t);
  const contracts = sync.inspectCuratedTargetContracts(f.plan, { planDirectory: f.root });
  assert.deepEqual(Object.keys(contracts), ["cloudflare"]);
  const report = await sync.runCuratedDualSync(f.plan, { ...f.options,
    expectedTargetFingerprints: { cloudflare: contracts.cloudflare.manifestFingerprint } });
  assert.equal(report.ok, true);
  assert.equal(f.calls.length, 7);
  assert.equal(f.calls.filter(call => call.path.endsWith("/curated-verify")).length, 3);
  assert.ok(f.calls.every(c => c.host === "cloudflare.fixture.invalid"));
  assert.deepEqual(report.actions, { cloudflare: { created: 0, updated: 0, unchanged: 3 } });
  assert.deepEqual(report.targetCoverage, { cloudflare_confirmed: { total: 3, authoritative: 1, superseded: 1, plain: 1 } });
  assert.ok(report.ledger.documents.every(d => JSON.stringify(d.targets) === '{"cloudflare":"confirmed"}'));
  assert.equal(report.ledger.raw_drive_evidence.deletion_eligible, false);
  assert.equal(report.rawDriveHistoricalChecksumMatches.total, 0);
  assert.equal(readFileSync(join(f.root, "coverage.json"), "utf8").includes("legacy"), false);
});

test("partial and malformed targets refuse after a valid nonempty control", async t => {
  const f = fixture(t, true);
  assert.equal((await sync.runCuratedDualSync(f.plan, f.options)).ok, true);
  assert.equal(f.calls.length, 10);
  let attempts = 0;
  for (const name of ["legacy_target", "cloudflare_target"]) {
    for (const invalid of [null, false, {}, [], { manifest: "target.json" }, { backend: f.plan[name].backend }, { ...f.plan[name], backend: "wrong" }]) {
      attempts++;
      const callsBefore = f.calls.length;
      await assert.rejects(sync.runCuratedDualSync({ ...f.plan, [name]: invalid }, f.options), new RegExp(name));
      assert.equal(f.calls.length, callsBefore);
    }
  }
  assert.equal(attempts, 14);
  const missing = structuredClone(f.plan);
  delete missing.cloudflare_target;
  await assert.rejects(sync.runCuratedDualSync(missing, f.options), /cloudflare_target/);
  const manifest = join(f.root, "legacy.manifest.json");
  const bytes = readFileSync(manifest);
  writeFileSync(manifest, readFileSync(join(f.root, "cloudflare.manifest.json")));
  assert.throws(() => sync.inspectCuratedTargetContracts(f.plan, { planDirectory: f.root }), /distinct backends and origins/);
  writeFileSync(manifest, bytes);
  assert.equal(Object.keys(sync.inspectCuratedTargetContracts(f.plan, { planDirectory: f.root })).length, 2);
});

test("target removal changes the bound hash and old scheduled runs refuse", async t => {
  const f = fixture(t, true);
  const before = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  delete f.plan.legacy_target;
  f.save();
  const after = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  assert.notEqual(after.configHash, before.configHash);
  assert.deepEqual(Object.keys(after.targetManifestFingerprints), ["cloudflare"]);
  let spawned = 0;
  const options = { ...f.common, spawn: () => { spawned++; return { status: 0 }; }, rotateLogs: () => {} };
  assert.equal(scheduler.runScheduledCuratedSync(f.path, { ...options, expectedConfigHash: after.configHash }).status, "complete");
  assert.equal(spawned, 1);
  assert.throws(() => scheduler.runScheduledCuratedSync(f.path, { ...options, expectedConfigHash: before.configHash }), /plan changed after this LaunchAgent was prepared/);
  assert.equal(spawned, 1);
  await assert.rejects(scheduler.executeScheduledCuratedSync(f.path, {
    ...f.common, expectedConfigHash: before.configHash, runSync: () => { spawned++; },
  }), /plan changed after this LaunchAgent was prepared/);
  assert.equal(spawned, 1);
});

test("single-target freshness records and validates exactly the planned coverage", async t => {
  const f = fixture(t);
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  mkdirSync(plan.locksDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.lockPath, "", { mode: 0o600 });
  const fd = openSync(plan.lockPath, "r+");
  let runs = 0;
  let result;
  try {
    result = await scheduler.executeScheduledCuratedSync(f.path, {
      ...f.common, expectedConfigHash: plan.configHash, lockDescriptor: fd,
      inspectLockParent: () => "/usr/bin/lockf", probeLockContention: () => ({ status: 75 }),
      runSync: async (input, opts) => { runs++; return sync.runCuratedDualSync(input, { ...f.options, ...opts }); },
    });
  } finally { closeSync(fd); }
  assert.equal(runs, 1);
  assert.equal(f.calls.length, 7);
  assert.deepEqual(result.receipt.target_coverage, { cloudflare: 3 });
  assert.deepEqual(scheduler.statusScheduledCuratedSync(f.path, f.common).freshness.targetCoverage, { cloudflare: 3 });
  const lastSuccess = readFileSync(plan.freshnessPath);
  const failedFd = openSync(plan.lockPath, "r+");
  let failedRuns = 0;
  try {
    await assert.rejects(scheduler.executeScheduledCuratedSync(f.path, {
      ...f.common, expectedConfigHash: plan.configHash, lockDescriptor: failedFd,
      inspectLockParent: () => "/usr/bin/lockf", probeLockContention: () => ({ status: 75 }),
      runSync: async (input, opts) => {
        failedRuns++;
        return sync.runCuratedDualSync(input, { ...f.options, ...opts, fetch: async (url, options) => {
          const result = await f.options.fetch(url, options);
          return { ...result, ok: false, status: 503 };
        } });
      },
    }), /did not confirm every required target/);
  } finally { closeSync(failedFd); }
  assert.equal(failedRuns, 1);
  assert.equal(f.calls.length, 10, "failed sync reached all three writes after the green control");
  assert.deepEqual(readFileSync(plan.freshnessPath), lastSuccess);
  for (const coverage of [{ cloudflare: 2 }, { cloudflare: 3, legacy: 3 }, {}]) {
    writeFileSync(plan.freshnessPath, JSON.stringify({ ...result.receipt, target_coverage: coverage }));
    assert.equal(scheduler.statusScheduledCuratedSync(f.path, f.common).freshness.status, "invalid");
  }
});

test("preview prints local counts without credentials or ledger mutation", async t => {
  const f = fixture(t, true);
  await sync.runCuratedDualSync(f.plan, f.options);
  const ledgerPath = join(f.root, "coverage.json");
  const prior = readFileSync(ledgerPath);
  writeFileSync(join(f.root, "corpus", "alpha.md"), "# Changed fixture\nNew body.\n");
  let resolves = 0;
  let writes = 0;
  const report = await sync.runCuratedDualSync(f.plan, { ...f.options, mode: "preview",
    resolveTarget: () => { resolves++; throw new Error("unexpected credentials"); },
    writeLedger: () => { writes++; },
  });
  assert.deepEqual(report.preview, { documents: 3, roles: f.plan.expected_roles, adds: 0, updates: 1, unchanged: 2, removed: 0 });
  assert.equal(f.calls.length, 10);
  assert.equal(resolves, 0);
  assert.equal(writes, 0);
  assert.deepEqual(readFileSync(ledgerPath), prior);
  // A real CLI invocation must succeed even with no manifests or key available.
  for (const name of ["legacy.manifest.json", "cloudflare.manifest.json", ".brain-admin-key"]) unlinkSync(join(f.root, name));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../operations/curated-dual-sync.mjs", import.meta.url)), "--plan", f.path, "--preview"], {
    encoding: "utf8", env: { HOME: f.common.home, TMPDIR: tmpdir(), BRAIN_NO_WRANGLER_LOGIN: "1", PATH: "/usr/bin:/bin" },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(JSON.parse(cli.stdout), report.preview);
  assert.equal(cli.stderr, "");
  assert.deepEqual(readFileSync(ledgerPath), prior);
  unlinkSync(ledgerPath);
  const first = await sync.runCuratedDualSync(f.plan, { ...f.options, mode: "preview" });
  assert.deepEqual(first.preview, { documents: 3, roles: f.plan.expected_roles, adds: 3, updates: 0, unchanged: 0, removed: 0 });
  assert.equal(existsSync(ledgerPath), false);
});

function launchctlFixture(plan, initial, failBootstrap = false) {
  let loaded = initial;
  const calls = [];
  return { calls, launchctl(args) {
    calls.push(args[0]);
    if (args[0] === "print") {
      const plist = loaded ? readFileSync(plan.plistPath, "utf8") : "";
      const oldHash = plist.match(/<string>([0-9a-f]{64})<\/string>/)?.[1];
      return loaded ? { status: 0, stdout: `state = waiting\narguments = {\n${[...plan.programArguments.slice(0, -1), oldHash].join("\n")}\n}\n` } : { status: 113 };
    }
    if (args[0] === "bootout") loaded = false;
    if (args[0] === "bootstrap") {
      if (failBootstrap) { failBootstrap = false; return { status: 1 }; }
      assert.ok(readFileSync(plan.plistPath, "utf8").includes("<key>ProgramArguments</key>"));
      loaded = true;
    }
    return { status: 0 };
  } };
}

test("reinstall stages and reads back the new hash using injected launchctl", t => {
  const f = fixture(t);
  assert.deepEqual(scheduler.parseCuratedSchedulerCliArguments(["reinstall", f.path]), {
    command: "reinstall", planPath: f.path, expectedConfigHash: undefined,
  });
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  const mock = launchctlFixture(plan, false);
  const installed = scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: mock.launchctl });
  assert.equal(installed.installed, true);
  assert.deepEqual(mock.calls, ["print", "enable", "bootstrap", "print"]);
  assert.equal(readFileSync(plan.plistPath, "utf8"), scheduler.renderCuratedLaunchAgentPlist(plan));
  assert.ok(readFileSync(plan.plistPath, "utf8").includes(plan.configHash));
});

test("reinstall preserves the old plist on bootstrap failure and refuses running jobs", t => {
  const f = fixture(t, true);
  const before = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  mkdirSync(dirname(before.plistPath), { recursive: true, mode: 0o700 });
  const prior = scheduler.renderCuratedLaunchAgentPlist(before);
  writeFileSync(before.plistPath, prior, { mode: 0o600 });
  delete f.plan.legacy_target;
  f.save();
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  const failed = launchctlFixture(plan, true, true);
  assert.throws(() => scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: failed.launchctl }), /replacement failed/);
  assert.ok(failed.calls.includes("bootstrap"));
  assert.equal(readFileSync(plan.plistPath, "utf8"), prior);
  let calls = 0;
  assert.throws(() => scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: () => { calls++; return { status: 0, stdout: `state = running\npid = 123\narguments = {\n${before.programArguments.join("\n")}\n}\n` }; } }), /currently running/);
  assert.equal(calls, 1);
  const control = launchctlFixture(plan, true);
  assert.equal(scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: control.launchctl }).installed, true);
  assert.deepEqual(control.calls, ["print", "bootout", "enable", "bootstrap", "print"]);
});

test("historical Drive evidence and incomplete Cloudflare receipts remain fail closed", async t => {
  const f = fixture(t);
  const docs = f.plan.documents;
  const done = Object.fromEntries(docs.map((doc, i) => [`drive:fixture-${i}`, JSON.stringify([
    "revision", i === 0 ? createHash("md5").update(readFileSync(join(f.root, "corpus", doc.relative_path))).digest("hex") : i === 1 ? "0".repeat(32) : "123",
    doc.relative_path, "text/markdown", "Fixture",
  ])]));
  writeFileSync(join(f.root, "drive-state.json"), JSON.stringify({ version: 6, done }), { mode: 0o600 });
  f.plan.raw_drive = { state_file: "drive-state.json", path_prefix: "Fixture", match: "path", require_state_match: true };
  f.save();
  let readbacks = 0;
  let incomplete = false;
  const fetch = async (url, options) => {
    const result = await f.options.fetch(url, options);
    const body = JSON.parse(options.body);
    if (body.source) {
      readbacks++;
      const value = JSON.parse(await result.text());
      if (body.source === "drive") value.families = docs.map((_, i) => `drive:fixture-${i}`);
      else if (incomplete) value.families.pop();
      return { ...result, text: async () => JSON.stringify(value) };
    }
    return result;
  };
  const control = await sync.runCuratedDualSync(f.plan, { ...f.options, fetch });
  assert.equal(control.ok, true);
  assert.equal(readbacks, 2);
  assert.equal(control.rawDriveHistoricalChecksumMatches.total, 1);
  assert.equal(control.rawDriveHistoricalChecksumMismatches.total, 1);
  assert.equal(control.rawDriveHistoricalPresenceUnverified.total, 1);
  assert.equal(control.ledger.raw_drive_evidence.deletion_eligible, false);
  incomplete = true;
  const failed = await sync.runCuratedDualSync(f.plan, { ...f.options, fetch });
  assert.equal(failed.ok, false);
  assert.equal(readbacks, 4);
  assert.equal(failed.targetCoverage.cloudflare_confirmed.total, 2);
});

test("reinstall refuses mismatched loaded arguments and plan drift with rollback", t => {
  const f = fixture(t);
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  const control = launchctlFixture(plan, false);
  scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: control.launchctl });
  const prior = readFileSync(plan.plistPath);
  for (const defect of ["arguments", "drift"]) {
    let prints = 0;
    let boots = 0;
    const mock = launchctlFixture(plan, true);
    const launchctl = args => {
      const result = mock.launchctl(args);
      if (args[0] === "bootstrap") boots++;
      if (args[0] === "print" && ++prints === 2) {
        if (defect === "arguments") result.stdout = result.stdout.replace(plan.configHash, "f".repeat(64));
        else { f.plan.common_metadata = { changed: true }; f.save(); }
      }
      return result;
    };
    assert.throws(() => scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl }), /replacement failed/);
    assert.equal(boots, 2, "both the replacement and rollback reached bootstrap");
    assert.deepEqual(readFileSync(plan.plistPath), prior);
    delete f.plan.common_metadata;
    f.save();
  }
});


test("F1 ambiguous bootout recovers and proves the prior loaded definition", t => {
  const f = fixture(t);
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  const control = launchctlFixture(plan, false);
  assert.equal(scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl: control.launchctl }).loaded, true);
  assert.equal(control.calls.length, 4);
  const prior = readFileSync(plan.plistPath);
  for (const effect of ["unloaded", "still-loaded", "throw", "bad-restore"]) {
    let loaded = true;
    let bootouts = 0;
    let bootstraps = 0;
    let readbacks = 0;
    const launchctl = args => {
      if (args[0] === "print") {
        readbacks++;
        const active = [...plan.programArguments];
        if (bootstraps && effect === "bad-restore") active[0] = "/unrelated/runtime";
        return loaded ? { status: 0, stdout: `state = waiting\narguments = {\n${active.join("\n")}\n}\n` } : { status: 113 };
      }
      if (args[0] === "bootout") {
        bootouts++;
        loaded = effect === "still-loaded";
        if (effect === "throw") throw new Error("synthetic timeout");
        return { status: null, error: { code: "ETIMEDOUT" } };
      }
      if (args[0] === "bootstrap") { bootstraps++; loaded = true; }
      return { status: 0 };
    };
    let failure;
    try { scheduler.reinstallScheduledCuratedSync(f.path, { ...f.common, launchctl }); }
    catch (error) { failure = error; }
    assert.equal(bootouts, 1, "reached the ambiguous mutation");
    assert.ok(failure);
    assert.equal(loaded, true, "prior service must remain loaded after an ambiguous acknowledgement");
    assert.ok(readbacks >= 2, "recovery inspected the service");
    assert.equal(bootstraps, effect === "still-loaded" ? 0 : 1);
    assert.match(failure.message, effect === "bad-restore" ? /rollback needs review/ : /previous service restored/);
    assert.deepEqual(readFileSync(plan.plistPath), prior);
  }
});

// The real reinstall CLI path drives macOS LaunchAgents; on other platforms
// the scheduler refuses before any of these filesystem faults are reached.
test("F2 real reinstall CLI bounds filesystem and child-process errors", { skip: process.platform !== "darwin" && "curated scheduling is macOS LaunchAgents only" }, t => {
  const f = fixture(t);
  const hookPath = join(f.root, "cli-isolation.mjs");
  const countersPath = join(f.root, "counters.json");
  writeFileSync(hookPath, String.raw`
    import fs from "node:fs";
    import child from "node:child_process";
    import { syncBuiltinESMExports } from "node:module";
    const counters = { launchctl: 0, network: 0, forbidden: 0, filesystem: 0 };
    process.on("exit", () => fs.writeFileSync(process.env.COUNTERS, JSON.stringify(counters)));
    const mkdir = fs.mkdirSync;
    fs.mkdirSync = (path, ...args) => {
      if ((process.env.FAULT === "mkdir" && String(path).endsWith("LaunchAgents")) ||
          (process.env.FAULT === "lock" && String(path).endsWith(".brain"))) {
        counters.filesystem++;
        throw new Error("EACCES private-home-sentinel " + path);
      }
      return mkdir(path, ...args);
    };
    const open = fs.openSync;
    fs.openSync = (path, ...args) => {
      if (process.env.FAULT === "stage" && String(path).includes(".plist.tmp-")) {
        counters.filesystem++;
        throw new Error("EACCES private-home-sentinel " + path);
      }
      return open(path, ...args);
    };
    let loaded = false;
    let active = [];
    child.spawnSync = (command, args) => {
      if (command !== "/bin/launchctl") { counters.forbidden++; throw new Error("forbidden host child"); }
      counters.launchctl++;
      if (process.env.FAULT === "child") throw new Error("private-home-sentinel child failure");
      if (args[0] === "bootstrap") {
        loaded = true;
        const text = fs.readFileSync(args[2], "utf8");
        const block = text.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)[1];
        active = [...block.matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1]);
      }
      if (args[0] === "print") return loaded ? { status: 0, stdout: "arguments = {\n" + active.join("\n") + "\n}\n" } : { status: 113 };
      return { status: 0 };
    };
    globalThis.fetch = () => { counters.network++; throw new Error("network forbidden"); };
    syncBuiltinESMExports();
  `);
  for (const fault of ["none", "mkdir", "stage", "child", "lock"]) {
    const home = join(f.root, `private-home-sentinel-${fault}`);
    mkdirSync(home, { mode: 0o700 });
    const command = fault === "lock"
      ? [fileURLToPath(new URL("../operations/curated-dual-sync.mjs", import.meta.url)), "--plan", f.path, "--dry-run"]
      : [fileURLToPath(new URL("../operations/curated-sync-scheduler.mjs", import.meta.url)), "reinstall", f.path];
    const cli = spawnSync(process.execPath, ["--import", hookPath, ...command], {
      encoding: "utf8", env: { HOME: home, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin",
        BRAIN_NO_WRANGLER_LOGIN: "1", COUNTERS: countersPath, FAULT: fault },
    });
    const counters = JSON.parse(readFileSync(countersPath));
    assert.equal(counters.network, 0);
    assert.equal(counters.forbidden, 0);
    if (fault === "none") {
      assert.equal(cli.status, 0, cli.stderr);
      assert.equal(counters.launchctl, 4);
    } else {
      assert.equal(cli.status, 1);
      assert.equal(counters.filesystem, fault === "child" ? 0 : 1, "reached the fault boundary");
      assert.equal(counters.launchctl, fault === "child" ? 1 : 0);
      assert.equal((cli.stdout + cli.stderr).includes("private-home-sentinel"), false);
      assert.match(cli.stderr, fault === "lock" ? /curated sync stopped:/ : /Curated scheduler failed:/);
    }
  }
});


test("F3 removed inventory remains visible and preserves unresolved ledger evidence", async t => {
  const f = fixture(t);
  const stored = new Map();
  const fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    if (new URL(url).pathname.endsWith("/ingest")) stored.set(body.source_id, structuredClone(body));
    return f.options.fetch(url, options);
  };
  assert.equal((await sync.runCuratedDualSync(f.plan, { ...f.options, fetch })).ok, true);
  assert.equal(stored.size, 3);
  const prior = readFileSync(join(f.root, "coverage.json"));
  const removed = f.plan.documents.pop();
  unlinkSync(join(f.root, "corpus", removed.relative_path));
  f.plan.expected_documents--;
  f.plan.expected_roles[removed.role]--;
  f.save();
  let resolutions = 0;
  const noCredentials = { ...f.options, resolveTarget: () => { resolutions++; throw new Error("unexpected credentials"); } };
  for (let repeat = 0; repeat < 2; repeat++) {
    const preview = await sync.runCuratedDualSync(f.plan, { ...noCredentials, mode: "preview" });
    assert.equal(preview.preview.documents, 2, "reached a nonempty changed inventory");
    assert.equal(preview.preview.unchanged, 2);
    assert.equal(preview.preview.removed, 1);
    for (const mode of ["sync", "audit", "dry-run"]) {
      await assert.rejects(sync.runCuratedDualSync(f.plan, { ...noCredentials, mode }), /1 removed.*reconciliation/);
      assert.deepEqual(readFileSync(join(f.root, "coverage.json")), prior);
    }
  }
  assert.equal(resolutions, 0);
  assert.equal(stored.size, 3, "no remote deletion is implicit");
  assert.ok(stored.has(`brain:${removed.legacy_source_type}:${removed.legacy_source_id}`));
});


test("F4 older remote revision cannot advance scheduled freshness", async t => {
  const f = fixture(t);
  const stored = new Map();
  const original = new Map();
  let race = false;
  let readbacks = 0;
  let verificationReads = 0;
  const { default: worker } = await import("../worker/src/index.js");
  const { expectedD1ContentHash } = await import("../worker/src/lib/store.js");
  const { normalizeIngestEnvelopeProvenance } = await import("../worker/src/lib/provenance-receipt.js");
  const env = { STORAGE: "d1", ADMIN_KEY: readFileSync(join(f.root, ".brain-admin-key"), "utf8"),
    DB: { prepare(sql) {
      assert.match(sql, /FROM documents/);
      assert.match(sql, /deleted_at IS NULL/);
      return { bind(uid) { return { async first() {
        verificationReads++;
        const input = stored.get(uid);
        if (!input) return null;
        const envelope = normalizeIngestEnvelopeProvenance(input);
        return { doc_uid: uid, source: envelope.source_type, source_id: envelope.source_id,
          title: envelope.title, content_hash: await expectedD1ContentHash(env, envelope),
          meta: JSON.stringify(envelope.metadata) };
      } }; } };
    } },
  };
  const fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    if (path.endsWith("/ingest")) stored.set(`curated:${body.source_id}`, structuredClone(body));
    if (path.endsWith("/source-families")) {
      readbacks++;
      // A writer on another machine can defeat any local lock. Its successful
      // older POST lands between this run's write and confirmation.
      if (race) for (const [uid, value] of original) stored.set(uid, structuredClone(value));
    }
    if (path.endsWith("/curated-verify")) {
      return worker.fetch(new Request(url, options), env);
    }
    return f.options.fetch(url, options);
  };
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  mkdirSync(plan.locksDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.lockPath, "", { mode: 0o600 });
  const fd = openSync(plan.lockPath, "r+");
  t.after(() => closeSync(fd));
  const run = () => scheduler.executeScheduledCuratedSync(f.path, {
    ...f.common, expectedConfigHash: plan.configHash, lockDescriptor: fd,
    inspectLockParent: () => "/usr/bin/lockf", probeLockContention: () => ({ status: 75 }),
    runSync: (input, opts) => sync.runCuratedDualSync(input, { ...f.options, ...opts, fetch }),
  });
  assert.equal((await run()).status, "complete");
  assert.equal(stored.size, 3);
  for (const [uid, value] of stored) original.set(uid, structuredClone(value));
  const freshness = readFileSync(plan.freshnessPath);
  writeFileSync(join(f.root, "corpus", "alpha.md"), "# New revision\nCurrent fixture content.\n");
  race = true;
  let failure;
  try { await run(); } catch (error) { failure = error; }
  assert.equal(readbacks, 2, "both runs reached final family readback");
  assert.equal(stored.size, 3, "identities alone still match");
  assert.ok(failure, "an older stored revision must refuse completion");
  assert.match(failure.message, /did not confirm every required target/);
  assert.ok(verificationReads >= 6, "both runs performed authenticated revision readback");
  assert.deepEqual(readFileSync(plan.freshnessPath), freshness);
  const failed = JSON.parse(readFileSync(join(f.root, "coverage.json")));
  assert.equal(failed.target_coverage.cloudflare_confirmed.total, 2);
});


test("F4 manual and scheduled sync share the local ledger lock", async t => {
  const f = fixture(t);
  assert.equal((await sync.runCuratedDualSync(f.plan, f.options)).ok, true);
  let announce;
  let release;
  const reached = new Promise(resolve => { announce = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let heldWrites = 0;
  const direct = sync.runCuratedDualSync(f.plan, { ...f.options, home: f.common.home, fetch: async (url, opts) => {
    if (new URL(url).pathname.endsWith("/ingest") && ++heldWrites === 1) { announce(); await held; }
    return f.options.fetch(url, opts);
  } });
  await reached;
  const plan = scheduler.buildCuratedSchedulerPlan(f.path, f.common);
  mkdirSync(plan.locksDir, { recursive: true, mode: 0o700 });
  writeFileSync(plan.lockPath, "", { mode: 0o600 });
  const fd = openSync(plan.lockPath, "r+");
  let scheduled = 0;
  let competingRequests = 0;
  let failure;
  try {
    try {
      await scheduler.executeScheduledCuratedSync(f.path, {
        ...f.common, expectedConfigHash: plan.configHash, lockDescriptor: fd,
        inspectLockParent: () => "/usr/bin/lockf", probeLockContention: () => ({ status: 75 }),
        runSync: (input, opts) => {
          scheduled++;
          return sync.runCuratedDualSync(input, { ...f.options, ...opts, home: f.common.home,
            fetch: (url, args) => { competingRequests++; return f.options.fetch(url, args); } });
        },
      });
    } catch (error) { failure = error; }
  } finally { release(); closeSync(fd); }
  assert.equal((await direct).ok, true);
  assert.equal(heldWrites, 3);
  assert.equal(scheduled, 1, "the scheduled runner reached the shared decision point");
  assert.ok(failure, "a concurrent local writer must be refused");
  assert.match(failure.message, /already running/);
  assert.equal(competingRequests, 0);
  assert.equal((await sync.runCuratedDualSync(f.plan, { ...f.options, home: f.common.home })).ok, true, "lock released after completion");
});

test("F4 authenticated verification reads exact durable content title and metadata", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { default: worker } = await import("../worker/src/index.js");
  const { expectedD1ContentHash } = await import("../worker/src/lib/store.js");
  const { normalizeIngestEnvelopeProvenance } = await import("../worker/src/lib/provenance-receipt.js");
  const db = new DatabaseSync(":memory:");
  const key = randomBytes(32).toString("hex");
  let selects = 0;
  let primarySessions = 0;
  const env = { STORAGE: "d1", ADMIN_KEY: key, DB: {
    withSession(constraint) { assert.equal(constraint, "first-primary"); primarySessions++; return this; },
    prepare(sql) {
      assert.match(sql, /^SELECT /, "verification never mutates storage");
      return { bind(...values) { return { async first() {
        selects++;
        return db.prepare(sql).get(...values) ?? null;
      } }; } };
    },
  } };
  const envelope = { source_type: "curated", source_id: "brain:custom:fixture-alpha", title: "Current fixture",
    content: "Current fixture body.", metadata: { role: "authoritative", nested: { marker: "current" } } };
  const normalized = normalizeIngestEnvelopeProvenance(envelope);
  const hash = await expectedD1ContentHash(env, normalized);
  const uid = `curated:${envelope.source_id}`;
  const expectedEnvelopeHash = createHash("sha256").update(`curated-sync-envelope-v1\0${canonicalForTest({ title: envelope.title, content: envelope.content, metadata: envelope.metadata })}`).digest("hex");
  db.exec("CREATE TABLE documents(doc_uid TEXT, source TEXT, source_id TEXT, title TEXT, content_hash TEXT, meta TEXT, deleted_at INTEGER)");
  const restore = () => {
    db.exec("DELETE FROM documents");
    db.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,NULL)").run(uid, "curated", envelope.source_id,
      envelope.title, hash, JSON.stringify(normalized.metadata));
  };
  const request = (body = envelope, extras = {}) => worker.fetch(new Request("https://fixture.invalid/api/admin/brain/curated-verify", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Key": key },
    body: JSON.stringify(body), ...extras,
  }), env);
  try {
    for (const column of ["content_hash", "title", "meta", "deleted_at", "source_id"]) {
      restore();
      const control = await request();
      assert.equal(control.status, 200);
      assert.match(control.headers.get("cache-control"), /no-store/);
      assert.deepEqual(await control.json(), { doc_uid: uid, confirmed: true, envelope_sha256: expectedEnvelopeHash });
      if (column === "meta") db.prepare("UPDATE documents SET meta=?").run(JSON.stringify({ ...normalized.metadata, nested: { marker: "older" } }));
      else if (column === "deleted_at") db.exec("UPDATE documents SET deleted_at=1");
      else db.prepare(`UPDATE documents SET ${column}=?`).run("older-revision");
      const before = selects;
      const refused = await request();
      assert.equal(selects, before + 1, "negative reached the durable row query");
      assert.deepEqual(await refused.json(), { doc_uid: uid, confirmed: false, envelope_sha256: null });
    }
    assert.equal(primarySessions, 10);
    restore();
    const beforeInvalid = selects;
    assert.equal((await request({ ...envelope, source_type: "drive" })).status, 400);
    assert.equal((await request(envelope, { method: "GET", body: undefined })).status, 405);
    assert.equal((await request(envelope, { headers: {} })).status, 401);
    assert.equal((await request(envelope, { body: "{" })).status, 400);
    assert.equal(selects, beforeInvalid);
    const unknown = await request(envelope, { body: " ".repeat(2 * 1024 * 1024 + 1) });
    assert.equal(unknown.status, 400, "body limit applies without Content-Length");
    const storedDb = env.DB;
    env.DB = { withSession() { throw new Error("private-database-sentinel"); } };
    const unavailable = await request();
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.text()).includes("private-database-sentinel"), false);
    env.DB = storedDb;
    assert.equal((await (await request()).json()).confirmed, true);
  } finally { db.close(); }
});

function canonicalForTest(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalForTest).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalForTest(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

test("F4 unavailable or mismatched verification never falls back to identities", async t => {
  const f = fixture(t);
  assert.equal((await sync.runCuratedDualSync(f.plan, f.options)).ok, true);
  for (const fault of ["missing-route", "wrong-hash", "redirect", "throw"]) {
    let verifies = 0;
    const report = await sync.runCuratedDualSync(f.plan, { ...f.options, fetch: async (url, options) => {
      const control = await f.options.fetch(url, options);
      if (!new URL(url).pathname.endsWith("/curated-verify")) return control;
      verifies++;
      if (fault === "throw") throw new Error("synthetic transport failure");
      if (fault === "missing-route") return { ...control, ok: false, status: 404 };
      if (fault === "redirect") return { ...control, url: "https://unrelated.invalid/readback" };
      const body = JSON.parse(await control.text());
      return { ...control, text: async () => JSON.stringify({ ...body, envelope_sha256: "0".repeat(64) }) };
    } });
    assert.equal(verifies, 3, "each confirmed write reached revision verification");
    assert.equal(report.ok, false);
    assert.equal(report.targetCoverage.cloudflare_confirmed.total, 0);
  }
});
