import assert from "node:assert/strict";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  rmdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { cmdConnect, cmdUpdate, cmdUpgrade, cmdUpgradeInteractive } from "../brain.mjs";
import {
  answerSetupJournalPath,
  answerSetupJournal,
  answerSetupNeedsRecovery,
} from "../operations/answer-setup.mjs";
import { HALF_RUN } from "../operations/answer-setup-copy.mjs";
import {
  BrainLifecycleLockError,
  acquireBrainLifecycleLock,
  withBrainLifecycleLockWait,
} from "../operations/brain-lifecycle-lock.mjs";
import { renderCliCommands } from "../operations/cli-guidance.mjs";

const fixedNow = new Date("2026-10-23T12:00:00.000Z");
const holderStartedMs = fixedNow.getTime() - 25_000;
let mutantSequence = 0;

function realFilesystemLockPlatforms(hostPlatform, requested) {
  return hostPlatform === "win32" ? requested.filter((platform) => platform === "win32") : [...requested];
}

function normalizeMutantSource(source) {
  return source.replace(/\r\n/gu, "\n");
}

const JOURNAL_PRESENCE_CASES = Object.freeze([
  {
    name: "valid journal file",
    create: (path) => writeFileSync(path, `${JSON.stringify(answerSetupJournal({
      retrieval: {},
      safety: {},
    }, { mode: "keep", secretExisted: false }))}\n`, { mode: 0o600 }),
  },
  { name: "zero-byte journal file", create: (path) => writeFileSync(path, "", { mode: 0o600 }) },
  { name: "malformed journal file", create: (path) => writeFileSync(path, "not-json\n", { mode: 0o600 }) },
  { name: "journal directory", create: (path) => mkdirSync(path, { mode: 0o700 }) },
]);

function removeJournalEntry(path) {
  const state = lstatSync(path);
  if (state.isDirectory()) rmdirSync(path);
  else unlinkSync(path);
}

test("real-filesystem lock rows keep every native Windows case and omit incompatible simulated POSIX cases", () => {
  const rows = [
    { host: "win32", requested: ["win32", "darwin", "linux"], expected: ["win32"] },
    { host: "win32", requested: ["win32", "darwin"], expected: ["win32"] },
    { host: "darwin", requested: ["win32", "darwin", "linux"], expected: ["win32", "darwin", "linux"] },
    { host: "linux", requested: ["win32", "darwin", "linux"], expected: ["win32", "darwin", "linux"] },
  ];
  for (const row of rows) {
    const selected = realFilesystemLockPlatforms(row.host, row.requested);
    assert.deepEqual(selected, row.expected, `${row.host} selects only host-compatible filesystem rows`);
    assert.ok(selected.includes("win32"), `${row.host} retains the real Windows control row`);
  }
});

test("mutant source normalization makes LF and CRLF checkouts equivalent", () => {
  const anchor = "first line\nsecond line";
  for (const row of [
    { name: "LF checkout", source: "first line\nsecond line\n" },
    { name: "CRLF checkout", source: "first line\r\nsecond line\r\n" },
  ]) {
    const normalized = normalizeMutantSource(row.source);
    assert.ok(normalized.includes(anchor), `${row.name} reaches the same multi-line mutant anchor`);
    assert.ok(normalizeMutantSource("first line\nsecond line\n").includes(anchor),
      `${row.name} retains the LF green control`);
  }
});

function fixture(label = "partner-fix-") {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), label)));
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const manifestPath = join(root, "brain.manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture", timezone: "America/Phoenix" },
    brain: { worker_name: "fixture-brain", domain: "fixture.invalid" },
    infrastructure: {
      cloudflare: {
        account_id: "fixture-account",
        storage: "d1",
        d1_database_id: "fixture-database",
      },
    },
    retrieval: {
      answer_model: "claude-opus-5-5",
      gate_model: "claude-sonnet-5-5",
    },
    safety: { daily_llm_spend_cap_usd: 5 },
  }), { mode: 0o600 });
  return { root, home, manifestPath, machineLockRoot: join(root, "machine-locks") };
}

function windowsTicks(epochMs) {
  return 621355968000000000n + BigInt(epochMs) * 10_000n;
}

function touchOwner(lock, when) {
  const ownerPath = join(lock.path, readdirSync(lock.path)[0]);
  utimesSync(ownerPath, when, when);
  return ownerPath;
}

function replaceOwnerReceipt(lock, { pid, processInstance }) {
  const ownerPath = join(lock.path, readdirSync(lock.path)[0]);
  const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
  owner.pid = pid;
  owner.process_instance = processInstance;
  const nextOwnerPath = join(lock.path, `owner-${pid}-${owner.token}.json`);
  renameSync(ownerPath, nextOwnerPath);
  writeFileSync(nextOwnerPath, JSON.stringify(owner), { mode: 0o600 });
  return nextOwnerPath;
}

function platformIdentity(platform, startedMs) {
  return platform === "win32"
    ? `win32:${windowsTicks(startedMs)}`
    : `posix:${startedMs}`;
}

test("a live holder with a 6,939 ms identity difference stays busy on every platform", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    const input = fixture(`partner-lock-live-${platform}-`);
    const storedIdentity = platformIdentity(platform, holderStartedMs);
    const contenderIdentity = platformIdentity(platform, holderStartedMs - 6_939);
    const holder = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => storedIdentity,
    });
    replaceOwnerReceipt(holder, { pid: process.pid + 100_000, processInstance: storedIdentity });
    touchOwner(holder, fixedNow);
    let livenessChecks = 0;
    try {
      assert.throws(() => acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "update",
        now: () => new Date(fixedNow.getTime() + 1_000),
        staleMs: 60_000,
        isOwnerAlive: () => { livenessChecks += 1; return true; },
        processInstance: () => contenderIdentity,
      }), (error) => error?.code === "brain_lifecycle_busy", `${platform} live mismatch is busy`);
      assert.equal(livenessChecks, 1, `${platform} reached the live-owner decision`);
      assert.equal(holder.assertOwned(), true, `${platform} live holder retains custody`);
    } finally {
      holder.release();
    }
    const control = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      now: () => fixedNow,
      processInstance: () => contenderIdentity,
    });
    assert.equal(control.assertOwned(), true, `${platform} acquires after the live holder releases`);
    control.release();
  }
});

test("a live holder with unknown identity stays busy on every platform", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    const input = fixture(`partner-lock-unknown-${platform}-`);
    const holder = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => platformIdentity(platform, holderStartedMs),
    });
    replaceOwnerReceipt(holder, { pid: process.pid + 100_001, processInstance: null });
    touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
    let livenessChecks = 0;
    try {
      assert.throws(() => acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => { livenessChecks += 1; return true; },
        processInstance: () => null,
      }), (error) => error?.code === "brain_lifecycle_busy", `${platform} unknown live owner is busy`);
      assert.equal(livenessChecks, 1, `${platform} reached the unknown live-owner decision`);
      assert.equal(holder.assertOwned(), true, `${platform} unknown live owner retains custody`);
    } finally {
      holder.release();
    }
    const control = acquireBrainLifecycleLock({ ...input, platform, operation: "update", now: () => fixedNow });
    assert.equal(control.assertOwned(), true, `${platform} unknown-holder control acquires after release`);
    control.release();
  }
});

test("a live holder older than the stale age stays busy with restart guidance on every platform", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    const input = fixture(`partner-lock-long-held-${platform}-`);
    const identity = platformIdentity(platform, holderStartedMs);
    const holder = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => new Date(fixedNow.getTime() - 120_000),
      processInstance: () => identity,
    });
    replaceOwnerReceipt(holder, { pid: process.pid + 100_002, processInstance: identity });
    touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
    let decisions = 0;
    try {
      assert.throws(() => acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => true,
        processInstance: () => identity,
      }), (error) => {
        decisions += 1;
        assert.equal(error?.code, "brain_lifecycle_busy");
        assert.match(error.message, /Another Brain task has held the lock for 2 minutes\. If no Brain command is running, restart the computer and run the command again\./u);
        return true;
      }, `${platform} long-held live owner remains busy`);
      assert.equal(decisions, 1, `${platform} reached the long-held-live message decision`);
      assert.equal(holder.assertOwned(), true, `${platform} long-held live owner retains custody`);
    } finally {
      holder.release();
    }
    const control = acquireBrainLifecycleLock({ ...input, platform, operation: "update", now: () => fixedNow });
    assert.equal(control.assertOwned(), true, `${platform} long-held control acquires after release`);
    control.release();
  }
});

test("a dead holder stays busy while fresh and is reaped only after stale age on every platform", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    const input = fixture(`partner-lock-dead-${platform}-`);
    const holder = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => platformIdentity(platform, holderStartedMs),
    });
    replaceOwnerReceipt(holder, {
      pid: process.pid + 100_003,
      processInstance: platformIdentity(platform, holderStartedMs),
    });
    touchOwner(holder, fixedNow);
    let livenessChecks = 0;
    assert.throws(() => acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      now: () => new Date(fixedNow.getTime() + 1_000),
      staleMs: 60_000,
      isOwnerAlive: () => { livenessChecks += 1; return false; },
    }), (error) => error?.code === "brain_lifecycle_busy", `${platform} fresh dead owner stays busy`);
    assert.equal(livenessChecks, 1, `${platform} reached the fresh dead-owner decision`);
    assert.equal(holder.assertOwned(), true, `${platform} fresh dead owner retains custody until stale`);

    touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
    const replacement = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      now: () => fixedNow,
      staleMs: 60_000,
      isOwnerAlive: () => { livenessChecks += 1; return false; },
    });
    assert.ok(livenessChecks >= 3, `${platform} repeated the dead check before stale takeover`);
    assert.equal(replacement.assertOwned(), true, `${platform} stale dead-owner control acquires`);
    assert.equal(holder.release(), false, `${platform} old nonce cannot release the replacement`);
    replacement.release();
  }
});

test("only a stale prior owner with the contender's own PID and a different identity may be reaped", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    const input = fixture(`partner-lock-self-pid-${platform}-`);
    const priorIdentity = platformIdentity(platform, holderStartedMs);
    const contenderIdentity = platformIdentity(platform, holderStartedMs + 10_000);
    const holder = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => priorIdentity,
    });
    replaceOwnerReceipt(holder, { pid: process.pid, processInstance: priorIdentity });
    touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
    const replacement = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      now: () => fixedNow,
      staleMs: 60_000,
      isOwnerAlive: () => true,
      processInstance: () => contenderIdentity,
    });
    assert.equal(replacement.assertOwned(), true, `${platform} stale prior self-PID owner is reaped`);
    assert.equal(holder.release(), false, `${platform} prior self-PID nonce cannot release replacement`);
    replacement.release();

    const control = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => contenderIdentity,
    });
    touchOwner(control, new Date(fixedNow.getTime() - 120_000));
    let controlDecisions = 0;
    try {
      assert.throws(() => acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => { controlDecisions += 1; return true; },
        processInstance: () => contenderIdentity,
      }), (error) => error?.code === "brain_lifecycle_busy", `${platform} same self identity stays busy`);
      assert.ok(controlDecisions >= 1, `${platform} reached the self-identity decision`);
      assert.equal(control.assertOwned(), true, `${platform} same self identity retains custody`);
    } finally {
      control.release();
    }
  }
});

test("self-PID custody uses one process-wide instance across every observation transition", () => {
  const transitions = [
    { label: "native-to-fallback", first: "native-a", second: null },
    { label: "fallback-to-native", first: null, second: "native-a" },
    { label: "native-to-different-native", first: "native-a", second: "native-b" },
  ];
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin", "linux"])) {
    for (const transition of transitions) {
      const row = `${platform}-${transition.label}`;
      const input = fixture(`partner-lock-stable-self-${row}-`);
      const nativeIdentity = (value) => value === null
        ? null
        : platformIdentity(platform, holderStartedMs + (value === "native-b" ? 10_000 : 0));
      const holder = acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "daily-refresh",
        now: () => fixedNow,
        processInstance: () => nativeIdentity(transition.first),
      });
      touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
      let livenessChecks = 0;
      let busyDecisions = 0;
      let contender = null;
      try {
        assert.throws(() => {
          contender = acquireBrainLifecycleLock({
            ...input,
            platform,
            operation: "update",
            now: () => fixedNow,
            staleMs: 60_000,
            isOwnerAlive: () => { livenessChecks += 1; return true; },
            processInstance: () => nativeIdentity(transition.second),
          });
        }, (error) => {
          busyDecisions += 1;
          return error?.code === "brain_lifecycle_busy";
        }, `${row} keeps the live self-PID holder busy`);
        assert.equal(livenessChecks, 1, `${row} reached the live self-PID decision`);
        assert.equal(busyDecisions, 1, `${row} reached the busy decision`);
        assert.equal(holder.assertOwned(), true, `${row} original holder retains custody`);
      } finally {
        contender?.release();
        holder.release();
      }

      const priorHolder = acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "daily-refresh",
        now: () => fixedNow,
        processInstance: () => nativeIdentity(transition.first),
      });
      replaceOwnerReceipt(priorHolder, {
        pid: process.pid,
        processInstance: `prior-process-lifetime:${row}`,
      });
      touchOwner(priorHolder, new Date(fixedNow.getTime() - 120_000));
      let priorChecks = 0;
      const replacement = acquireBrainLifecycleLock({
        ...input,
        platform,
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => { priorChecks += 1; return true; },
        processInstance: () => nativeIdentity(transition.second),
      });
      assert.ok(priorChecks >= 2, `${row} repeated the prior-lifetime decision`);
      assert.equal(replacement.assertOwned(), true, `${row} prior-lifetime control acquires`);
      assert.equal(priorHolder.release(), false, `${row} prior lifetime cannot release the replacement`);
      replacement.release();
    }
  }
});

test("new owner receipts reuse one non-null process-wide instance", () => {
  const input = fixture("partner-lock-windows-fallback-");
  const first = acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => null,
  });
  const firstOwnerPath = join(first.path, readdirSync(first.path)[0]);
  const firstOwner = JSON.parse(readFileSync(firstOwnerPath, "utf8"));
  assert.match(firstOwner.process_instance, /^process-lifetime:[a-f0-9]{32}$/u);
  first.release();

  const second = acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "update",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  try {
    const secondOwnerPath = join(second.path, readdirSync(second.path)[0]);
    const secondOwner = JSON.parse(readFileSync(secondOwnerPath, "utf8"));
    assert.equal(secondOwner.process_instance, firstOwner.process_instance);
  } finally {
    second.release();
  }
});

test("fresh empty lifecycle directories are retryable while stale empty directories remain recoverable", () => {
  for (const platform of realFilesystemLockPlatforms(process.platform, ["win32", "darwin"])) {
    const input = fixture(`partner-lock-empty-${platform}-`);
    const seed = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "daily-refresh",
      now: () => fixedNow,
      processInstance: () => `epoch:${holderStartedMs}`,
      restrictWindowsDirectory: () => true,
    });
    seed.release();
    mkdirSync(seed.path, { mode: 0o700 });
    utimesSync(seed.path, fixedNow, fixedNow);

    let decisions = 0;
    assert.throws(() => acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      retryCommand: "brain update <manifest>",
      now: () => fixedNow,
      staleMs: 60_000,
      restrictWindowsDirectory: () => true,
    }), (error) => {
      decisions += 1;
      assert.equal(error?.code, "brain_lifecycle_busy");
      assert.equal(error?.retryable, true);
      assert.match(error.message, /being acquired/i);
      return true;
    }, `${platform} fresh empty contention is retryable`);
    assert.equal(decisions, 1, `${platform} fresh-empty decision point was reached`);

    const stale = new Date(fixedNow.getTime() - 120_000);
    utimesSync(seed.path, stale, stale);
    const recovered = acquireBrainLifecycleLock({
      ...input,
      platform,
      operation: "update",
      now: () => fixedNow,
      staleMs: 60_000,
      processInstance: () => `epoch:${holderStartedMs}`,
      restrictWindowsDirectory: () => true,
    });
    assert.equal(recovered.assertOwned(), true, `${platform} stale-empty recovery is the green control`);
    recovered.release();
  }
});

test("the wait lane retries an in-progress empty lock, observes its owner, and acquires after release", async () => {
  const input = fixture("partner-lock-empty-wait-");
  const seed = acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
    restrictWindowsDirectory: () => true,
  });
  seed.release();
  mkdirSync(seed.path, { mode: 0o700 });
  utimesSync(seed.path, fixedNow, fixedNow);

  const ownerPid = 4242;
  const token = "b".repeat(32);
  const ownerPath = join(seed.path, `owner-${ownerPid}-${token}.json`);
  let waits = 0;
  let ownerChecks = 0;
  let taskRuns = 0;
  await withBrainLifecycleLockWait({
    ...input,
    platform: "win32",
    operation: "update",
    retryCommand: "brain update <manifest>",
    now: () => fixedNow,
    waitMs: 10_000,
    retryMs: 25,
    restrictWindowsDirectory: () => true,
    isOwnerAlive: (pid) => { if (pid === ownerPid) ownerChecks += 1; return true; },
    processInstance: (pid) => pid === ownerPid
      ? `win32:${windowsTicks(holderStartedMs)}`
      : `win32:${windowsTicks(holderStartedMs + 1_000)}`,
    sleep: async () => {
      waits += 1;
      if (waits === 1) {
        writeFileSync(ownerPath, JSON.stringify({
          schema_version: 2,
          pid: ownerPid,
          token,
          operation: "daily-refresh",
          process_instance: `win32:${windowsTicks(holderStartedMs)}`,
          created_at: fixedNow.toISOString(),
        }), { mode: 0o600, flag: "wx" });
      } else if (waits === 2) {
        unlinkSync(ownerPath);
        rmdirSync(seed.path);
      }
    },
  }, async ({ assertOwned }) => {
    taskRuns += 1;
    assert.equal(assertOwned(), true);
  });
  assert.equal(waits, 2, "the wait lane observed both acquisition-in-progress and owner-present contention");
  assert.equal(ownerChecks, 1, "the eventual owner receipt reached the live-holder decision");
  assert.equal(taskRuns, 1, "release is the green control that eventually acquires");
});

test("busy lock copy uses a caller-supplied retry action and qualifies an unknown holder", () => {
  const verifiedInput = fixture("partner-lock-copy-");
  const verifiedHolder = acquireBrainLifecycleLock({
    ...verifiedInput,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  try {
    let decisions = 0;
    assert.throws(() => acquireBrainLifecycleLock({
      ...verifiedInput,
      platform: "win32",
      operation: "answer-setup",
      retryCommand: "the same connect command",
      now: () => fixedNow,
      isOwnerAlive: () => { decisions += 1; return true; },
      processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
    }), (error) => {
      assert.equal(error?.code, "brain_lifecycle_busy");
      assert.match(error.message, /held by daily-refresh/);
      assert.match(error.message, /then run the same connect command again/);
      assert.doesNotMatch(error.message, /brain answer-setup/);
      return true;
    });
    assert.equal(decisions, 1, "the verified-holder message decision was reached");
  } finally {
    verifiedHolder.release();
  }

  const unknownInput = fixture("partner-lock-unknown-");
  const unknownHolder = acquireBrainLifecycleLock({
    ...unknownInput,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  replaceOwnerReceipt(unknownHolder, { pid: process.pid + 100_005, processInstance: null });
  try {
    let decisions = 0;
    assert.throws(() => acquireBrainLifecycleLock({
      ...unknownInput,
      platform: "win32",
      operation: "update",
      now: () => fixedNow,
      isOwnerAlive: () => { decisions += 1; return true; },
      processInstance: () => null,
    }), (error) => {
      assert.equal(error?.code, "brain_lifecycle_busy");
      assert.match(error.message, /could not confirm it is the same one/i);
      assert.doesNotMatch(error.message, /That process is still running/);
      assert.match(error.message, /run the same command again/);
      return true;
    });
    assert.equal(decisions, 1, "the unknown-holder message decision was reached");
    assert.equal(unknownHolder.assertOwned(), true, "unknown identity fails closed without stealing custody");
  } finally {
    unknownHolder.release();
  }
});

test("brain update preserves the lifecycle holder message instead of classifying it as a network drop", async () => {
  const { manifestPath } = fixture("partner-update-busy-");
  const busy = new BrainLifecycleLockError(
    "brain_lifecycle_busy",
    "the Brain lifecycle lock is held by daily-refresh; wait for it to finish, then run the same command again",
    { retryable: true },
  );
  let decisions = 0;
  await assert.rejects(cmdUpdate(manifestPath, {
    withBrainLifecycleLockWait: async () => { decisions += 1; throw busy; },
  }), (error) => {
    assert.equal(error?.constructor?.name, "Fatal");
    assert.equal(error?.supportCode, "UPDATE_BRAIN_BUSY");
    assert.match(error.message, /held by daily-refresh/);
    assert.doesNotMatch(error.message, /internet connection dropped/i);
    return true;
  });
  assert.equal(decisions, 1, "the update lock-contention decision point was reached");

  const unrelated = new Error("synthetic unrelated failure");
  await assert.rejects(cmdUpdate(manifestPath, {
    withBrainLifecycleLockWait: async () => { throw unrelated; },
  }), (error) => error === unrelated);
});

test("brain update refuses every interrupted answer-setup journal shape before remote update work", async () => {
  for (const [index, journalCase] of JOURNAL_PRESENCE_CASES.entries()) {
    const { manifestPath } = fixture("partner-update-journal-");
    const journalPath = answerSetupJournalPath(manifestPath);
    journalCase.create(journalPath);
    const remoteEvents = [];
    const options = {
      discoverInstalledManifest: () => ({ path: manifestPath }),
      withBrainLifecycleLockWait: async (_input, action) => action(),
      readUpdateBacklog: async () => {
        remoteEvents.push("backlog");
        throw new Error("synthetic remote boundary");
      },
    };
    const updateTarget = index === 1 ? undefined : manifestPath;

    await assert.rejects(cmdUpdate(updateTarget, options), (error) => {
      assert.match(error.message, /Claude setup was interrupted part way/i);
      assert.match(error.message, /do not remove the Claude connection.*removes your stored key/i);
      assert.match(error.message, /ask the person who set up your Brain for help/i);
      assert.doesNotMatch(error.message, /disconnect/i);
      assert.doesNotMatch(error.message, /\bbrain\s+(?:connect|disconnect)\b/u,
        `${journalCase.name} exposes no unsafe recovery command`);
      return true;
    }, `${journalCase.name} refuses update`);
    assert.deepEqual(remoteEvents, [], `${journalCase.name} reached refusal before remote update work`);

    removeJournalEntry(journalPath);
    await assert.rejects(cmdUpdate(updateTarget, options), (error) => {
      assert.equal(error?.supportCode, "UPDATE_BRAIN_BUSY");
      return true;
    }, `${journalCase.name} absent-journal control reaches the next boundary`);
    assert.deepEqual(remoteEvents, ["backlog"], `${journalCase.name} green control differs only by journal absence`);
  }
});

test("the shared upgrade engine refuses every interrupted answer-setup journal shape before account work", async () => {
  for (const journalCase of JOURNAL_PRESENCE_CASES) {
    const { manifestPath } = fixture("partner-upgrade-journal-");
    const journalPath = answerSetupJournalPath(manifestPath);
    journalCase.create(journalPath);
    const events = [];
    let decisions = 0;
    const options = {
      answerSetupNeedsRecovery: (path) => {
        decisions += 1;
        return answerSetupNeedsRecovery(path);
      },
      resolveAccount: async () => {
        events.push("account");
        throw new Error("synthetic account boundary reached");
      },
    };

    await assert.rejects(cmdUpgrade(manifestPath, options), (error) => {
      assert.equal(error?.message, HALF_RUN(manifestPath));
      return true;
    }, `${journalCase.name} refuses the shared upgrade engine`);
    assert.equal(decisions, 1, `${journalCase.name} reached the upgrade journal decision`);
    assert.deepEqual(events, [], `${journalCase.name} stopped before account or remote work`);

    const routeEvents = [];
    let routeDecisions = 0;
    const routeOptions = {
      answerSetupNeedsRecovery: (path) => {
        routeDecisions += 1;
        return answerSetupNeedsRecovery(path);
      },
      withManifestControl: async () => {
        routeEvents.push("credential-control");
        throw new Error("synthetic credential boundary reached");
      },
    };
    await assert.rejects(cmdUpgradeInteractive(manifestPath, routeOptions), (error) => {
      assert.equal(error?.message, HALF_RUN(manifestPath));
      return true;
    }, `${journalCase.name} refuses the installed upgrade route`);
    assert.equal(routeDecisions, 1, `${journalCase.name} reached the installed-route decision`);
    assert.deepEqual(routeEvents, [], `${journalCase.name} stopped before credential control`);

    removeJournalEntry(journalPath);
    await assert.rejects(cmdUpgrade(manifestPath, options), /synthetic account boundary reached/u,
      `${journalCase.name} absent-journal control reaches account resolution`);
    assert.equal(decisions, 2, `${journalCase.name} absent control reached the same decision`);
    assert.deepEqual(events, ["account"], `${journalCase.name} green control differs only by journal absence`);
    await assert.rejects(cmdUpgradeInteractive(manifestPath, routeOptions), /synthetic credential boundary reached/u,
      `${journalCase.name} absent-journal route control reaches credential control`);
    assert.equal(routeDecisions, 2, `${journalCase.name} route control reached the same decision`);
    assert.deepEqual(routeEvents, ["credential-control"],
      `${journalCase.name} installed-route control differs only by journal absence`);
  }
});

test("the 0.4.19 owner changelog describes the shipped live-and-dead PID lock rule", () => {
  const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const entry = changelog.split("## 0.4.18", 1)[0];
  const rows = [
    {
      name: "owner summary",
      obsolete: /reused-process locks can recover safely/iu,
      shipped: /live PID is always\s+busy/iu,
    },
    {
      name: "technical summary",
      obsolete: /process-start identity/iu,
      shipped: /dead PID.*stale age.*second dead check/isu,
    },
  ];
  for (const row of rows) {
    assert.doesNotMatch(entry, row.obsolete, `${row.name} removes the unshipped claim`);
    assert.match(entry, row.shipped, `${row.name} retains a positive shipped-behavior control`);
  }
});

async function importMutant(relativePath, replacements, dependencyPaths) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "partner-mutant-")));
  const operations = join(root, "operations");
  mkdirSync(operations, { recursive: true, mode: 0o700 });
  const sourcePath = new URL(`../${relativePath}`, import.meta.url);
  let source = normalizeMutantSource(readFileSync(sourcePath, "utf8"));
  for (const [before, after] of replacements) {
    assert.ok(source.includes(before), `mutant anchor exists in ${relativePath}`);
    source = source.replace(before, after);
  }
  const target = join(root, relativePath);
  writeFileSync(target, source, { mode: 0o600 });
  for (const dependencyPath of dependencyPaths) {
    writeFileSync(
      join(root, dependencyPath),
      readFileSync(new URL(`../${dependencyPath}`, import.meta.url)),
      { mode: 0o600 },
    );
  }
  return import(`${pathToFileURL(target).href}?mutant=${mutantSequence++}`);
}

function verifyLiveIdentityMismatchStaysBusy(api) {
  const input = fixture("partner-lock-mutant-");
  const holder = api.acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  replaceOwnerReceipt(holder, {
    pid: process.pid + 100_004,
    processInstance: `win32:${windowsTicks(holderStartedMs)}`,
  });
  touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
  let contender = null;
  try {
    assert.throws(() => {
      contender = api.acquireBrainLifecycleLock({
        ...input,
        platform: "win32",
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => true,
        processInstance: () => `win32:${windowsTicks(holderStartedMs - 6_939)}`,
      });
    }, (error) => error?.code === "brain_lifecycle_busy");
    assert.equal(holder.assertOwned(), true);
  } finally {
    contender?.release();
    holder.release();
  }
}

test("the take-over-a-live-PID-on-identity-difference mutant is killed", async () => {
  const mutant = await importMutant("operations/brain-lifecycle-lock.mjs", [[
    "return live !== true || ownerIsPriorProcessWithContenderPid(owner, contenderProcessInstance);",
    "return live !== true || owner.process_instance !== contenderProcessInstance;",
  ]], ["operations/current-user-file.mjs"]);
  assert.throws(
    () => verifyLiveIdentityMismatchStaysBusy(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the stale live-holder probe kills identity-based takeover of a live PID",
  );
});

function verifyProcessWideSelfInstance(api) {
  const input = fixture("partner-stable-self-mutant-");
  const holder = api.acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  touchOwner(holder, new Date(fixedNow.getTime() - 120_000));
  let contender = null;
  try {
    assert.throws(() => {
      contender = api.acquireBrainLifecycleLock({
        ...input,
        platform: "win32",
        operation: "update",
        now: () => fixedNow,
        staleMs: 60_000,
        isOwnerAlive: () => true,
        processInstance: () => null,
      });
    }, (error) => error?.code === "brain_lifecycle_busy");
    assert.equal(holder.assertOwned(), true);
  } finally {
    contender?.release();
    holder.release();
  }
}

test("the per-acquisition self-observation mutant is killed", async () => {
  const mutant = await importMutant("operations/brain-lifecycle-lock.mjs", [
    [
      "  now = () => new Date(),",
      "  processInstance = (pid) => processStartIdentity(pid, { platform }),\n  now = () => new Date(),",
    ],
    [
      "  let token;",
      "  const contenderProcessInstance = () => {\n" +
        "    const observed = processInstance(process.pid);\n" +
        "    return typeof observed === \"string\" && observed ? observed : \"fallback-epoch:mutant\";\n" +
        "  };\n" +
        "  let token;",
    ],
    ["process_instance: CURRENT_PROCESS_INSTANCE,", "process_instance: contenderProcessInstance(),"],
    ["const contenderInstance = CURRENT_PROCESS_INSTANCE;", "const contenderInstance = contenderProcessInstance();"],
  ], ["operations/current-user-file.mjs"]);
  assert.throws(
    () => verifyProcessWideSelfInstance(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the stale live self-PID probe kills per-acquisition self observation",
  );
});

function verifyFreshEmptyRetry(api) {
  const input = fixture("partner-empty-mutant-");
  const seed = api.acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
    restrictWindowsDirectory: () => true,
  });
  seed.release();
  mkdirSync(seed.path, { mode: 0o700 });
  utimesSync(seed.path, fixedNow, fixedNow);
  assert.throws(() => api.acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "update",
    now: () => fixedNow,
    staleMs: 60_000,
    restrictWindowsDirectory: () => true,
  }), (error) => error?.code === "brain_lifecycle_busy" && error?.retryable === true);
}

test("the fresh-empty-as-damaged mutant is killed", async () => {
  const mutant = await importMutant("operations/brain-lifecycle-lock.mjs", [[
    "\"brain_lifecycle_busy\",\n          `the Brain lifecycle lock is being acquired.",
    "\"brain_lifecycle_unsafe\",\n          `the Brain lifecycle lock is being acquired.",
  ]], ["operations/current-user-file.mjs"]);
  assert.throws(
    () => verifyFreshEmptyRetry(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the retry probe kills classification of an in-progress empty lock as damage",
  );
});

function verifyBusyMessage(api) {
  const input = fixture("partner-message-mutant-");
  const holder = api.acquireBrainLifecycleLock({
    ...input,
    platform: "win32",
    operation: "daily-refresh",
    now: () => fixedNow,
    processInstance: () => `win32:${windowsTicks(holderStartedMs)}`,
  });
  replaceOwnerReceipt(holder, { pid: process.pid + 100_006, processInstance: null });
  try {
    assert.throws(() => api.acquireBrainLifecycleLock({
      ...input,
      platform: "win32",
      operation: "answer-setup",
      retryCommand: "the same connect command",
      now: () => fixedNow,
      isOwnerAlive: () => true,
      processInstance: () => null,
    }), (error) => {
      assert.match(error.message, /could not confirm it is the same one/i);
      assert.match(error.message, /then run the same connect command again/);
      assert.doesNotMatch(error.message, /brain answer-setup/);
      return true;
    });
  } finally {
    holder.release();
  }
}

test("the former lock-busy copy mutant is killed", async () => {
  const mutant = await importMutant("operations/brain-lifecycle-lock.mjs", [[
    "`${holderStatus} Wait for it to finish, ${busyRetryInstruction(retryCommand)}`",
    "`That process is still running. Wait for it to finish, then run brain ${operation} again.`",
  ]], ["operations/current-user-file.mjs"]);
  assert.throws(
    () => verifyBusyMessage(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the message probe kills invented internal commands and an unverified running claim",
  );
});
function verifyJournalPresenceRule(api) {
  let inspections = 0;
  assert.equal(api.answerSetupNeedsRecovery("/fixture/brain.manifest.json", {
    inspect: () => { inspections += 1; return {}; },
  }), true);
  assert.equal(api.answerSetupNeedsRecovery("/fixture/brain.manifest.json", {
    inspect: () => {
      inspections += 1;
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  }), false);
  assert.throws(() => api.answerSetupNeedsRecovery("/fixture/brain.manifest.json", {
    inspect: () => {
      inspections += 1;
      throw Object.assign(new Error("unknown"), { code: "EACCES" });
    },
  }), /could not be inspected/i);
  assert.equal(inspections, 3, "every journal state reached the normalized presence decision");
}

test("the drop-update-journal-guard mutant is killed", async () => {
  const mutant = await importMutant("operations/answer-setup.mjs", [[
    "inspect(answerSetupJournalPath(manifestPath));\n    return true;",
    "inspect(answerSetupJournalPath(manifestPath));\n    return false;",
  ]], ["operations/answer-setup-copy.mjs"]);
  assert.throws(
    () => verifyJournalPresenceRule(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the presence probe kills a guard that lets an interrupted setup reach update work",
  );
});

test("the remove-upgrade-journal-guard mutant is killed on the shared engine and installed route", async () => {
  const { manifestPath } = fixture("partner-upgrade-guard-mutant-");
  const journalPath = answerSetupJournalPath(manifestPath);
  writeFileSync(journalPath, "{", { mode: 0o600 });
  let directBoundary = 0;
  const directOptions = {
    resolveAccount: async () => {
      directBoundary += 1;
      throw new Error("mutant reached account work");
    },
  };
  await assert.rejects(cmdUpgrade(manifestPath, directOptions), (error) => error?.message === HALF_RUN(manifestPath));
  assert.equal(directBoundary, 0, "the real shared engine refuses before account work");
  await assert.rejects(cmdUpgrade(manifestPath, {
    ...directOptions,
    answerSetupNeedsRecovery: () => false,
  }), /mutant reached account work/u);
  assert.equal(directBoundary, 1, "removing the shared-engine guard reaches the unsafe boundary");

  let routeBoundary = 0;
  const routeOptions = {
    withManifestControl: async () => {
      routeBoundary += 1;
      throw new Error("mutant reached credential control");
    },
  };
  await assert.rejects(cmdUpgradeInteractive(manifestPath, routeOptions),
    (error) => error?.message === HALF_RUN(manifestPath));
  assert.equal(routeBoundary, 0, "the real installed route refuses before credential control");
  await assert.rejects(cmdUpgradeInteractive(manifestPath, {
    ...routeOptions,
    answerSetupNeedsRecovery: () => false,
  }), /mutant reached credential control/u);
  assert.equal(routeBoundary, 1, "removing the installed-route guard reaches the unsafe boundary");
});

function verifyStoredKeyCopy(api) {
  const rows = [
    { name: "pre-existing half-run", render: api.HALF_RUN },
    { name: "rollback could not finish", render: api.ROLLBACK_INCOMPLETE },
  ];
  for (const row of rows) {
    const held = row.render("<manifest>", true);
    assert.match(held, /Claude setup was interrupted part way/i, row.name);
    assert.match(held, /do not remove the Claude connection.*removes your stored key/i, row.name);
    assert.match(held, /ask the person who set up your Brain for help/i, row.name);
    assert.doesNotMatch(held, /disconnect/i, row.name);
    assert.doesNotMatch(held, /\bbrain\s+(?:connect|disconnect)\b/u, row.name);

    const control = renderCliCommands(row.render("<manifest>", false));
    assert.ok(control.includes(renderCliCommands("brain disconnect anthropic <manifest>")),
      `${row.name}: no-stored-key control retains the old guidance`);
  }
}

test("the restore-disconnect-advice-for-stored-key mutant is killed", async () => {
  const mutant = await importMutant("operations/answer-setup-copy.mjs", [
    ["secretNameExisted === false", "secretNameExisted === true"],
    ["secretNameExisted === false", "secretNameExisted === true"],
  ], []);
  assert.throws(
    () => verifyStoredKeyCopy(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the copy probe kills restored disconnect advice for both stored-key surfaces",
  );
});

function verifyRollbackSupportGuidance(api) {
  const rendered = api.renderSupportRecovery(api.supportRecovery("ANTHROPIC_ROLLBACK_INCOMPLETE"));
  assert.match(rendered, /ask the person who set up your Brain for help/iu);
  assert.doesNotMatch(rendered, /\bdisconnect\b/iu);
  assert.doesNotMatch(rendered, /\bbrain\s+[a-z][a-z-]*\b/u);
}

test("the restore-state-blind-disconnect-support mutant is killed", async () => {
  const mutant = await importMutant("support-recovery.mjs", [[
    "Leave the saved connection and half-run journal unchanged.",
    "Run brain disconnect anthropic <manifest> to restore the built-in model.",
  ]], [
    "support-journal.mjs",
    "operations/current-user-file.mjs",
    "operations/cloudflare-keyring-guidance.mjs",
    "operations/wrangler-runtime-contract.mjs",
  ]);
  assert.throws(
    () => verifyRollbackSupportGuidance(mutant),
    (error) => error?.code === "ERR_ASSERTION",
    "the rendered support probe kills restored state-blind disconnect advice",
  );
});

async function verifyConnectJournalGuard(inspectJournal) {
  const input = fixture("partner-connect-journal-mutant-");
  const journalPath = answerSetupJournalPath(input.manifestPath);
  writeFileSync(journalPath, "{", { mode: 0o600 });
  let decisions = 0;
  let credentialControls = 0;
  const options = {
    argv: [process.execPath, "brain.mjs", "connect", "anthropic", input.manifestPath],
    answerSetupNeedsRecovery: (manifestPath) => {
      decisions += 1;
      return inspectJournal(manifestPath);
    },
    withManifestControl: async () => {
      credentialControls += 1;
      throw new Error("fixture credential control reached");
    },
  };
  try {
    await assert.rejects(
      cmdConnect("anthropic", options),
      (error) => error.message === HALF_RUN(input.manifestPath),
    );
    assert.equal(decisions, 1, "the malformed journal reached the normalized decision");
    assert.equal(credentialControls, 0, "the malformed journal stopped before credential control");

    unlinkSync(journalPath);
    await assert.rejects(cmdConnect("anthropic", options), /fixture credential control reached/);
    assert.equal(decisions, 2, "the absent control reached the same decision");
    assert.equal(credentialControls, 1, "only the absent control reached credential control");
  } finally {
    rmSync(input.root, { recursive: true, force: true });
  }
}

test("the restore-pattern-based-connect-activation mutant is killed", async () => {
  await verifyConnectJournalGuard(answerSetupNeedsRecovery);
  const patternBasedActivation = (manifestPath) => {
    try {
      const value = JSON.parse(readFileSync(answerSetupJournalPath(manifestPath), "utf8"));
      return value?.schema_version === 1 && typeof value?.phase === "string";
    } catch {
      return false;
    }
  };
  await assert.rejects(
    verifyConnectJournalGuard(patternBasedActivation),
    (error) => error?.code === "ERR_ASSERTION",
    "the installed-route probe kills content-pattern activation that lets a malformed journal through",
  );
});
