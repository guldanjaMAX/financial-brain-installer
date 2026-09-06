import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalSourceIngestStatePath,
  SourceIngestLockError,
  acquireSourceIngestLock,
  sourceIngestLockPath,
  withSourceIngestLock,
} from "../operations/source-ingest-lock.mjs";
import {
  applyDriveRemovals,
  reconcileDocumentFamilies,
} from "../brain.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "brain.mjs");
const LOCK_MODULE = new URL("../operations/source-ingest-lock.mjs", import.meta.url).href;
const OLD = new Date(Date.now() - 180_000);
let ran = 0;
const check = (name, condition, detail = "") => {
  ran++;
  assert.ok(condition, `${name}${detail ? `: ${detail}` : ""}`);
  console.log(`PASS  ${name}`);
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "brain-source-ingest-lock-"));
  const home = join(root, "home");
  const manifests = join(root, "manifests");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(manifests, { mode: 0o700 });
  const manifestPath = join(manifests, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    brain: { domain: "fixture.invalid" },
    infrastructure: { cloudflare: { account_id: "fixture-account", d1_database_id: "fixture-db" } },
    corpora: { slack: { enabled: true, source: "client-chat", channel_ids: ["C1"] } },
    safety: { credential_scanner: { enabled: true }, private_path_prefixes: [] },
  }));
  return { root, home, manifests, manifestPath };
};

if (process.platform !== "win32") {
  const f = fixture();
  try {
    const target = join(f.root, "runtime-link-target");
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(f.home, ".brain"), "dir");
    assert.throws(
      () => sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a runtime-directory symlink is rejected without changing its target permissions",
      (lstatSync(target).mode & 0o077) !== 0);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }

  const f2 = fixture();
  try {
    const runtimeDir = join(f2.home, ".brain");
    const target = join(f2.root, "locks-link-target");
    mkdirSync(runtimeDir, { mode: 0o700 });
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, join(runtimeDir, "locks"), "dir");
    assert.throws(
      () => sourceIngestLockPath({ manifestPath: f2.manifestPath, sourceName: "gmail", home: f2.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("an ingest-lock-directory symlink is rejected without changing its target permissions",
      (lstatSync(target).mode & 0o077) !== 0);
  } finally {
    rmSync(f2.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const first = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const aliasRoot = join(f.root, "manifest-alias");
    if (process.platform !== "win32") {
      symlinkSync(f.manifests, aliasRoot, "dir");
      const capturedStatePath = canonicalSourceIngestStatePath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
      });
      const alias = sourceIngestLockPath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
        home: f.home,
      });
      check("canonical aliases share one source-state lock", first === alias);

      const retarget = join(f.root, "retargeted-manifests");
      mkdirSync(retarget, { mode: 0o700 });
      unlinkSync(aliasRoot);
      symlinkSync(retarget, aliasRoot, "dir");
      const movedStatePath = canonicalSourceIngestStatePath({
        manifestPath: join(aliasRoot, "brain.manifest.json"),
        sourceName: "gmail",
      });
      const capturedLock = sourceIngestLockPath({
        statePath: capturedStatePath,
        sourceName: "gmail",
        home: f.home,
      });
      check("a captured canonical state path remains bound after a symlink parent is retargeted",
        capturedStatePath !== movedStatePath && capturedLock === first);
    }
    const other = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail-archive", home: f.home });
    check("different source-state files receive different locks", first !== other);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const brainSource = readFileSync(CLI, "utf8");
  check("Gmail batch and terminal receipt writes are fenced by the active owner",
    /saveState, assertOwned: assertLockOwned/.test(brainSource) &&
    /assertLockOwned\?\.\(\);\s+await postSourceReceipt/.test(brainSource));
  check("a lock-lost failure cannot overwrite a successor's source receipt",
    /runOpened && !runClosed && error\?\.code !== "source_ingest_lock_lost"\) \{\s+assertLockOwned\?\.\(\);\s+try \{/.test(brainSource));
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
    });
    owner.release();
    let destructiveCalls = 0;
    await assert.rejects(
      applyDriveRemovals({
        uids: ["gmail:message-1"],
        base: "https://brain.invalid",
        adminKey: "synthetic-admin-key",
        state: { done: {}, removed: {} },
        dryRun: false,
        assertOwned: owner.assertOwned,
        fetchImpl: async () => {
          destructiveCalls++;
          return new Response("{}", { status: 200 });
        },
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a lost Gmail owner cannot begin a destructive source-family request",
      destructiveCalls === 0, `destructive calls=${destructiveCalls}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const owner = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
    });
    let destructiveCalls = 0;
    let waits = 0;
    await assert.rejects(
      reconcileDocumentFamilies({
        families: [{
          base_doc_uid: "gmail:message-1",
          keep_doc_uids: ["gmail:message-1#part1of2", "gmail:message-1#part2of2"],
        }],
        base: "https://brain.invalid",
        adminKey: "synthetic-admin-key",
        assertOwned: owner.assertOwned,
        fetchImpl: async () => {
          destructiveCalls++;
          owner.release();
          const error = new Error("synthetic lost response");
          error.name = "TimeoutError";
          throw error;
        },
        sleep: async () => { waits++; },
        onRetry: () => {},
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_lost",
    );
    check("a Gmail cleanup retry rechecks its owner and cannot issue a second destructive request",
      destructiveCalls === 1 && waits === 1,
      `destructive calls=${destructiveCalls} waits=${waits}`);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    let partialOwnerPath = null;
    const writeFailure = Object.assign(new Error("fixture owner write stopped"), { code: "ENOSPC" });
    assert.throws(
      () => acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: "gmail",
        home: f.home,
        writeOwner: (path, _content, options) => {
          partialOwnerPath = path;
          writeFileSync(path, "{", options);
          throw writeFailure;
        },
      }),
      (error) => error === writeFailure,
    );
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a partial owner write is removed with its failed acquisition",
      partialOwnerPath !== null && !existsSync(partialOwnerPath) && !existsSync(path));
    const retry = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("an owner-record write failure leaves the source immediately retryable", retry.assertOwned() === true);
    retry.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const deadPid = 99_999_999;
    const token = "a".repeat(32);
    mkdirSync(path, { mode: 0o700 });
    const ownerPath = join(path, `owner-${deadPid}-${token}.json`);
    writeFileSync(ownerPath, "{", { mode: 0o600 });
    assert.throws(
      () => acquireSourceIngestLock({
        manifestPath: f.manifestPath,
        sourceName: "gmail",
        home: f.home,
        isOwnerAlive: () => false,
      }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a recent malformed owner fails closed", existsSync(ownerPath));
    utimesSync(ownerPath, OLD, OLD);
    const recovered = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
      isOwnerAlive: () => false,
    });
    check("a private correctly named malformed owner recovers only when stale and dead",
      recovered.assertOwned() === true);
    recovered.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const holder = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    let entered = false;
    await assert.rejects(
      withSourceIngestLock(
        { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
        async () => { entered = true; },
      ),
      (error) => error instanceof SourceIngestLockError &&
        error.code === "source_ingest_already_running" && error.retryable === true,
    );
    check("a live owner blocks a second task before its callback starts", entered === false);
    holder.release();

    const value = await withSourceIngestLock(
      { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
      async ({ assertOwned }) => { assertOwned(); return 42; },
    );
    check("a successful task returns its value and releases the lease", value === 42 && !existsSync(holder.path));

    await assert.rejects(
      withSourceIngestLock(
        { manifestPath: f.manifestPath, sourceName: "gmail", home: f.home },
        async () => { throw new Error("fixture task stopped"); },
      ),
      /fixture task stopped/,
    );
    check("a thrown task also releases the lease", !existsSync(holder.path));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const live = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const liveOwner = join(live.path, readdirSync(live.path)[0]);
    utimesSync(liveOwner, OLD, OLD);
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_already_running",
    );
    check("an old heartbeat cannot evict a live process", existsSync(liveOwner));
    live.release();

    const crashed = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const crashedOwner = join(crashed.path, readdirSync(crashed.path)[0]);
    utimesSync(crashedOwner, OLD, OLD);
    const successor = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "gmail",
      home: f.home,
      isOwnerAlive: () => false,
    });
    check("a stale dead owner is replaced by a fresh lease", successor.assertOwned() === true);
    check("an old holder cannot release its successor's token", crashed.release() === false && successor.assertOwned() === true);
    successor.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    mkdirSync(path, { mode: 0o700 });
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_already_running",
    );
    check("a newly created ownerless directory is treated as an initializing live lock", existsSync(path));
    utimesSync(path, OLD, OLD);
    const recovered = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("an old empty crash residue can be recovered", recovered.assertOwned() === true);
    recovered.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  let child = null;
  try {
    const childSource = `
      import { acquireSourceIngestLock } from ${JSON.stringify(LOCK_MODULE)};
      acquireSourceIngestLock({ manifestPath: process.argv[1], sourceName: "gmail", home: process.argv[2] });
      console.log("READY");
      setInterval(() => {}, 1_000);
    `;
    child = spawn(
      process.execPath,
      ["--input-type=module", "--eval", childSource, f.manifestPath, f.home],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolveReady, rejectReady) => {
      let output = "";
      const timer = setTimeout(() => rejectReady(new Error("fixture lock child did not start")), 10_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (!output.includes("READY")) return;
        clearTimeout(timer);
        resolveReady();
      });
      child.once("error", (error) => { clearTimeout(timer); rejectReady(error); });
      child.once("exit", (code) => {
        if (output.includes("READY")) return;
        clearTimeout(timer);
        rejectReady(new Error(`fixture lock child exited ${code}`));
      });
    });
    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a separate process owns the same source lease", existsSync(path));
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const ownerPath = join(path, readdirSync(path)[0]);
    utimesSync(ownerPath, OLD, OLD);
    const recovered = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    check("a killed subprocess lease is reclaimed after its stale boundary", recovered.assertOwned() === true);
    recovered.release();
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGKILL");
    rmSync(f.root, { recursive: true, force: true });
  }
}

if (process.platform !== "win32") {
  const f = fixture();
  try {
    const permissive = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    chmodSync(permissive.path, 0o755);
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a permissive live lock directory fails closed", (lstatSync(permissive.path).mode & 0o077) !== 0);
    chmodSync(permissive.path, 0o700);
    permissive.release();

    const path = sourceIngestLockPath({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const target = join(f.root, "unsafe-target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, path, "dir");
    assert.throws(
      () => acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home }),
      (error) => error instanceof SourceIngestLockError && error.code === "source_ingest_lock_unsafe",
    );
    check("a symbolic-link lock path fails closed", lstatSync(path).isSymbolicLink());
    unlinkSync(path);
    rmdirSync(target);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

{
  const f = fixture();
  try {
    const holder = acquireSourceIngestLock({ manifestPath: f.manifestPath, sourceName: "gmail", home: f.home });
    const environment = {};
    for (const name of ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    environment.HOME = f.home;
    environment.USERPROFILE = f.home;
    environment.NO_COLOR = "1";
    environment.BRAIN_GOOGLE_TOKEN_STORE = "file";
    const result = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "gmail"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const output = `${result.stdout || ""}${result.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    check("the CLI refuses a second Gmail writer before credential or network access",
      result.status === 1 && /Gmail ingest is already running/.test(output) &&
      !/admin key|connect google|network|fetch/i.test(output), output.slice(-500));

    const dryResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "gmail", "--dry-run"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const dryOutput = `${dryResult.stdout || ""}${dryResult.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "");
    check("a read-only Gmail dry run does not contend with the durable writer",
      dryResult.status === 1 && !/Gmail ingest is already running/.test(dryOutput) &&
      /connect google|not connected|token/i.test(dryOutput), dryOutput.slice(-500));
    holder.release();

    const providerHolder = acquireSourceIngestLock({
      manifestPath: f.manifestPath,
      sourceName: "client-chat",
      home: f.home,
    });
    environment.BRAIN_SLACK_TOKEN_STORE = "file";
    const providerResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "slack"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const providerOutput = `${providerResult.stdout || ""}${providerResult.stderr || ""}`
      .replace(/\x1b\[[0-9;]*m/g, "");
    check("manual and scheduled provider commands share one canonical source lease",
      providerResult.status === 1 && /client-chat ingest is already running/.test(providerOutput) &&
      !/admin key|not connected|network|fetch/i.test(providerOutput), providerOutput.slice(-500));

    const providerDryResult = spawnSync(
      process.execPath,
      [CLI, "ingest", f.manifestPath, "--from", "slack", "--dry-run"],
      { encoding: "utf8", env: environment, timeout: 15_000 },
    );
    const providerDryOutput = `${providerDryResult.stdout || ""}${providerDryResult.stderr || ""}`
      .replace(/\x1b\[[0-9;]*m/g, "");
    check("a provider dry run stays read-only and does not contend with its writer",
      providerDryResult.status === 1 && !/ingest is already running/.test(providerDryOutput) &&
      /not connected/.test(providerDryOutput), providerDryOutput.slice(-500));
    providerHolder.release();
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

console.log(`\n${ran} source ingest lock checks passed.`);
