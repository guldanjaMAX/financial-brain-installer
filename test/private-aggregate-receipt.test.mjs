import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const receiptTest = process.platform === "win32" ? test.skip : test;

import {
  PrivateAggregateReceiptError,
  abandonPrivateAggregateReceipt,
  assertPrivateAggregateReceiptDirectory,
  assertPrivateAggregateOutputPath,
  clearPrivateAggregateReceiptReservation,
  finalizePrivateAggregateReceipt,
  privateAggregateReceiptCommitPath,
  privateAggregateReceiptPendingPath,
  privateAggregateReceiptStagedPath,
  readPrivateAggregateReceipt,
  readPrivateReceiptDescriptor,
  recoverPrivateAggregateReceiptFinalization,
  reservePrivateAggregateReceipt,
  resumePrivateAggregateReceiptReservation,
  syncPrivateReceiptDirectory,
  validatePrivateAggregateReceiptReservation,
  writePrivateReceiptDescriptor,
} from "../operations/private-aggregate-receipt.mjs";

function privateDirectory(prefix) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  return directory;
}

function outputFixture(prefix) {
  const directory = privateDirectory(prefix);
  const path = join(directory, "receipt.json");
  return {
    directory,
    path,
    output: assertPrivateAggregateOutputPath(path),
  };
}

function existingOutput(directory, path) {
  return Object.freeze({
    path,
    pendingPath: privateAggregateReceiptPendingPath(path),
    commitPath: privateAggregateReceiptCommitPath(path),
    stagedPath: privateAggregateReceiptStagedPath(path),
    parent: assertPrivateAggregateReceiptDirectory(directory),
  });
}

function spawnControlledNode(script) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: "/", stdio: ["ignore", "ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return { child, stderr: () => stderr };
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function waitForControlLine(control, diagnostics, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`control readiness timed out: ${diagnostics()}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      control.off("data", onData);
      control.off("end", onEnd);
      control.off("error", onError);
    };
    const onData = (chunk) => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      cleanup();
      resolve(line);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`control fd closed before readiness: ${diagnostics()}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    control.on("data", onData);
    control.once("end", onEnd);
    control.once("error", onError);
  });
}

async function parentKillControlledNode(script, expectedReady) {
  const processState = spawnControlledNode(script);
  const exited = waitForChildExit(processState.child);
  const ready = JSON.parse(await waitForControlLine(
    processState.child.stdio[3],
    processState.stderr,
  ));
  assert.deepEqual(ready, { ready: expectedReady });
  assert.equal(processState.child.kill("SIGKILL"), true);
  const outcome = await exited;
  assert.equal(outcome.code, null);
  assert.equal(outcome.signal, "SIGKILL");
}

async function runControlledNode(script) {
  const processState = spawnControlledNode(script);
  const exited = waitForChildExit(processState.child);
  const result = JSON.parse(await waitForControlLine(
    processState.child.stdio[3],
    processState.stderr,
  ));
  const outcome = await exited;
  assert.equal(outcome.code, 0, processState.stderr());
  assert.equal(outcome.signal, null);
  return result;
}

function privateWrite(path, value) {
  writeFileSync(path, value, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function receiptError(code) {
  return (error) => {
    assert.equal(error instanceof PrivateAggregateReceiptError, true);
    assert.equal(error.code, code);
    return true;
  };
}

function exactReceiptValidator(expected) {
  return (candidate) => {
    assert.deepEqual(candidate, expected);
    return true;
  };
}

test("native Windows refuses private aggregate receipts without verified DACL proof", {
  skip: process.platform !== "win32",
}, () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "brain-private-receipt-win-refuse-")));
  const path = join(directory, "receipt.json");
  try {
    assert.throws(
      () => assertPrivateAggregateOutputPath(path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED"),
    );
    writeFileSync(path, "{}\n");
    assert.throws(
      () => readPrivateAggregateReceipt(path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cleanupReservation(reservation) {
  if (reservation && !reservation.closed) abandonPrivateAggregateReceipt(reservation);
}

function macAclChange(...args) {
  const result = spawnSync("/bin/chmod", args, {
    cwd: "/",
    encoding: null,
    env: { LANG: "C", LC_ALL: "C" },
    shell: false,
    timeout: 5_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
}

test("macOS inherited ACLs refuse output binding and reservation before marker creation", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = privateDirectory("brain-private-receipt-parent-acl-");
  const path = join(directory, "receipt.json");
  const pendingPath = join(directory, "receipt.pending.json");
  try {
    macAclChange("+a", "everyone allow read,execute,file_inherit", directory);
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.throws(
      () => assertPrivateAggregateOutputPath(path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED"),
    );
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(pendingPath), false);

    macAclChange("-N", directory);
    const output = assertPrivateAggregateOutputPath(path);
    macAclChange("+a", "everyone allow read,execute,file_inherit", directory);
    assert.throws(
      () => reservePrivateAggregateReceipt(output, { status: "must_not_write" }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PARENT_REFUSED"),
    );
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(pendingPath), false);
  } finally {
    try { macAclChange("-N", directory); } catch { /* cleanup remains best effort */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS file ACLs refuse a private receipt before reading its bytes", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = privateDirectory("brain-private-receipt-file-acl-");
  const path = join(directory, "receipt.json");
  let reads = 0;
  try {
    privateWrite(path, '{"status":"private"}\n');
    macAclChange("+a", "everyone allow read", path);
    assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.throws(
      () => readPrivateAggregateReceipt(path, {
        readFile() {
          reads += 1;
          return Buffer.from('{"status":"must_not_read"}\n');
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    assert.equal(reads, 0);
  } finally {
    try { macAclChange("-N", path); } catch { /* cleanup remains best effort */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS parent ACLs refuse a finalized receipt before reading its bytes", {
  skip: process.platform !== "darwin",
}, () => {
  const fixture = outputFixture("brain-private-receipt-read-parent-acl-");
  let reservation;
  let reads = 0;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    finalizePrivateAggregateReceipt(reservation, { status: "private" });
    macAclChange("+a", "everyone allow read,execute", fixture.directory);
    assert.equal(lstatSync(fixture.directory).mode & 0o777, 0o700);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path, {
        readFile() {
          reads += 1;
          return Buffer.from('{"status":"must_not_read"}\n');
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    assert.equal(reads, 0);
  } finally {
    cleanupReservation(reservation);
    try { macAclChange("-N", fixture.directory); } catch { /* cleanup remains best effort */ }
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("reserve, finalize, and read preserve one exact owner-only aggregate receipt", () => {
  const fixture = outputFixture("brain-private-receipt-basic-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = {
    schema_version: 1,
    status: "passed_cleanup_required",
    aggregate: { chunks: 6001, pending: 0 },
  };
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.equal(reservation.closed, false);
    assert.equal(
      fixture.output.stagedPath,
      privateAggregateReceiptStagedPath(fixture.path),
    );
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), marker);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(fixture.directory).mode & 0o077, 0);
      assert.equal(lstatSync(fixture.output.pendingPath).mode & 0o077, 0);
    }

    assert.equal(finalizePrivateAggregateReceipt(reservation, receipt), true);
    assert.equal(reservation.closed, true);
    assert.equal(reservation.descriptor, undefined);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.equal(existsSync(fixture.output.stagedPath), false);

    const persistedBytes = readFileSync(fixture.path);
    const readback = readPrivateAggregateReceipt(fixture.path);
    assert.equal(readback.path, fixture.path);
    assert.equal(readback.parent.path, fixture.directory);
    assert.equal(readback.parent.info.dev, fixture.output.parent.info.dev);
    assert.equal(readback.parent.info.ino, fixture.output.parent.info.ino);
    assert.equal(
      readback.sha256,
      createHash("sha256").update(persistedBytes).digest("hex"),
    );
    assert.deepEqual(readback.value, receipt);
    assert.equal(Object.isFrozen(readback), true);
    assert.equal(Object.isFrozen(readback.parent), true);
    assert.equal(Object.isFrozen(readback.value), true);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(fixture.path).mode & 0o077, 0);
    }
    assert.equal(lstatSync(fixture.path).nlink, 1);
    persistedBytes.fill(0);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("deterministic staging and transition hooks expose only exact durable states", () => {
  const fixture = outputFixture("brain-private-receipt-transitions-");
  const marker = { schema_version: 1, status: "reserved" };
  const receipt = { schema_version: 1, status: "complete" };
  const commitPath = privateAggregateReceiptCommitPath(fixture.path);
  const stagedPath = privateAggregateReceiptStagedPath(fixture.path);
  const expectedPresence = {
    staged_receipt_created: [false, true, true, false],
    staged_receipt_written: [false, true, true, false],
    staged_receipt_file_fsynced: [false, true, true, false],
    staged_receipt_durable: [false, true, true, false],
    finalization_commit_durable: [false, true, true, true],
    final_receipt_link_durable: [true, true, true, true],
    final_receipt_durable: [true, true, false, true],
    pending_marker_removal_durable: [true, false, false, true],
    finalization_commit_removal_durable: [true, false, false, false],
  };
  const transitions = [];
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.equal(finalizePrivateAggregateReceipt(reservation, receipt, {
      onFinalizationTransition(name) {
        transitions.push(name);
        assert.deepEqual([
          existsSync(fixture.path),
          existsSync(fixture.output.pendingPath),
          existsSync(stagedPath),
          existsSync(commitPath),
        ], expectedPresence[name]);
        if (existsSync(stagedPath) && name !== "staged_receipt_created") {
          assert.deepEqual(JSON.parse(readFileSync(stagedPath, "utf8")), receipt);
          const expectedLinks = name === "final_receipt_link_durable" ? 2 : 1;
          assert.equal(lstatSync(stagedPath).nlink, expectedLinks);
          assert.equal(lstatSync(stagedPath).mode & 0o077, 0);
        }
        if (name === "final_receipt_link_durable") {
          const stagedInfo = lstatSync(stagedPath);
          const finalInfo = lstatSync(fixture.path);
          assert.equal(finalInfo.dev, stagedInfo.dev);
          assert.equal(finalInfo.ino, stagedInfo.ino);
          assert.equal(finalInfo.nlink, 2);
          assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), receipt);
        }
        if (name === "final_receipt_durable") {
          assert.equal(lstatSync(fixture.path).nlink, 1);
        }
        if (name === "finalization_commit_durable") {
          const commitment = JSON.parse(readFileSync(commitPath, "utf8"));
          assert.equal(
            commitment.final_receipt_path_sha256,
            createHash("sha256").update(fixture.path).digest("hex"),
          );
          assert.equal(
            commitment.staged_receipt_path_sha256,
            createHash("sha256").update(stagedPath).digest("hex"),
          );
        }
      },
    }), true);
    assert.deepEqual(transitions, Object.keys(expectedPresence));
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("terminal authority gates both last-guard removal and bare-final acceptance", () => {
  const fixture = outputFixture("brain-private-receipt-terminal-authority-");
  const marker = { schema_version: 1, status: "reserved" };
  const receipt = { schema_version: 1, status: "complete" };
  const phases = [];
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        validateTerminalAuthority(request) {
          phases.push(request.phase);
          assert.deepEqual(Object.keys(request), [
            "phase", "finalReceipt", "finalPath", "pendingPath", "stagedPath", "commitPath",
          ]);
          assert.equal(Object.isFrozen(request), true);
          assert.equal(Object.isFrozen(request.finalReceipt), true);
          assert.deepEqual(request.finalReceipt.value, receipt);
          assert.equal(request.finalPath, fixture.path);
          assert.equal(request.pendingPath, fixture.output.pendingPath);
          assert.equal(request.stagedPath, fixture.output.stagedPath);
          assert.equal(request.commitPath, fixture.output.commitPath);
          return false;
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_COMMIT_CHANGED"),
    );
    assert.deepEqual(phases, ["before_commit_guard_removal"]);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(fixture.output.stagedPath), false);
    assert.equal(existsSync(fixture.output.commitPath), true);

    assert.throws(
      () => recoverPrivateAggregateReceiptFinalization(
        fixture.output,
        marker,
        exactReceiptValidator(receipt),
        {
          validateTerminalAuthority() {
            throw new Error("synthetic terminal-authority failure");
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
    );
    assert.equal(existsSync(fixture.output.commitPath), true);
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), receipt);

    const recoveryPhases = [];
    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
      {
        validateTerminalAuthority(request) {
          recoveryPhases.push(request.phase);
          assert.deepEqual(request.finalReceipt.value, receipt);
          return true;
        },
      },
    );
    assert.equal(recovered.status, "finalized");
    assert.deepEqual(recoveryPhases, [
      "before_commit_guard_removal",
      "accept_terminal_final",
    ]);
    assert.equal(existsSync(fixture.output.commitPath), false);

    assert.throws(
      () => recoverPrivateAggregateReceiptFinalization(
        existingOutput(fixture.directory, fixture.path),
        marker,
        exactReceiptValidator(receipt),
        { validateTerminalAuthority: () => false },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
    );
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an exact unfinished marker can be explicitly resumed without recreating it", () => {
  const fixture = outputFixture("brain-private-receipt-resume-");
  const marker = { schema_version: 1, status: "provider_result_unconfirmed" };
  const receipt = { schema_version: 1, status: "passed" };
  let initial;
  let resumed;
  try {
    initial = reservePrivateAggregateReceipt(fixture.output, marker);
    const pendingBefore = lstatSync(fixture.output.pendingPath);
    assert.equal(existsSync(fixture.path), false);
    abandonPrivateAggregateReceipt(initial);
    resumed = resumePrivateAggregateReceiptReservation(fixture.output, marker);
    assert.equal(resumed.closed, false);
    assert.equal(existsSync(fixture.path), false);
    assert.equal(lstatSync(fixture.output.pendingPath).ino, pendingBefore.ino);
    assert.equal(finalizePrivateAggregateReceipt(resumed, receipt), true);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(resumed);
    cleanupReservation(initial);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an exactly authorized cancellation clears only matching reservation markers", () => {
  const fixture = outputFixture("brain-private-receipt-cancel-");
  const marker = { schema_version: 1, status: "cancel_exact_reservation" };
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    abandonPrivateAggregateReceipt(reservation);
    const transitions = [];
    const result = clearPrivateAggregateReceiptReservation(fixture.output, marker, {
      onTransition: (name) => transitions.push(name),
    });
    assert.deepEqual(result, { status: "cleared" });
    assert.deepEqual(transitions, ["pending_marker_removed"]);
    assert.equal(existsSync(fixture.path), false);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.deepEqual(
      clearPrivateAggregateReceiptReservation(fixture.output, marker),
      { status: "already_absent" },
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an interrupted exact cancellation remains idempotent after pending removal", () => {
  const fixture = outputFixture("brain-private-receipt-cancel-resume-");
  const marker = { schema_version: 1, status: "cancel_exact_reservation" };
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    abandonPrivateAggregateReceipt(reservation);
    assert.throws(
      () => clearPrivateAggregateReceiptReservation(fixture.output, marker, {
        onTransition(name) {
          if (name === "pending_marker_removed") throw new Error("simulated process stop");
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_CANCELLATION_INVALID"),
    );
    assert.equal(existsSync(fixture.path), false);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.deepEqual(
      clearPrivateAggregateReceiptReservation(fixture.output, marker),
      { status: "already_absent" },
    );
    assert.equal(existsSync(fixture.output.pendingPath), false);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an injected stop after the pending marker is durable resumes conservatively", () => {
  const fixture = outputFixture("brain-private-receipt-pending-only-resume-");
  const marker = { schema_version: 1, status: "pending_only_process_stop" };
  const receipt = { schema_version: 1, status: "resumed_complete" };
  let resumed;
  try {
    assert.throws(
      () => reservePrivateAggregateReceipt(fixture.output, marker, {
        onTransition(name) {
          if (name === "pending_marker_durable") throw new Error("simulated process stop");
        },
      }),
      /simulated process stop/u,
    );
    assert.equal(existsSync(fixture.path), false);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    resumed = resumePrivateAggregateReceiptReservation(fixture.output, marker);
    assert.equal(finalizePrivateAggregateReceipt(resumed, receipt), true);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(resumed);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("cancellation refuses changed markers or a finalization commitment", () => {
  for (const scenario of ["changed", "committed"]) {
    const fixture = outputFixture(`brain-private-receipt-cancel-${scenario}-`);
    const marker = { schema_version: 1, status: "cancel_exact_reservation" };
    let reservation;
    try {
      reservation = reservePrivateAggregateReceipt(fixture.output, marker);
      abandonPrivateAggregateReceipt(reservation);
      if (scenario === "changed") {
        privateWrite(fixture.output.pendingPath, '{"status":"replaced"}\n');
      } else {
        reservation = resumePrivateAggregateReceiptReservation(fixture.output, marker);
        assert.throws(
          () => finalizePrivateAggregateReceipt(
            reservation,
            { schema_version: 1, status: "final" },
            { publish: () => { throw new Error("simulated pre-publish death"); } },
          ),
        );
      }
      assert.throws(
        () => clearPrivateAggregateReceiptReservation(fixture.output, marker),
        receiptError("PRIVATE_AGGREGATE_RECEIPT_CANCELLATION_INVALID"),
      );
      assert.equal(existsSync(fixture.path), false);
      assert.equal(existsSync(fixture.output.pendingPath), true);
    } finally {
      cleanupReservation(reservation);
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

receiptTest("resume refuses a changed final or pending marker", () => {
  for (const changed of ["final", "pending"]) {
    const fixture = outputFixture(`brain-private-receipt-resume-${changed}-`);
    const marker = { schema_version: 1, status: "provider_result_unconfirmed" };
    let reservation;
    try {
      reservation = reservePrivateAggregateReceipt(fixture.output, marker);
      abandonPrivateAggregateReceipt(reservation);
      const changedPath = changed === "final" ? fixture.path : fixture.output.pendingPath;
      privateWrite(changedPath, '{"status":"changed-but-same-purpose"}\n');
      assert.throws(
        () => resumePrivateAggregateReceiptReservation(fixture.output, marker),
        receiptError("PRIVATE_AGGREGATE_RECEIPT_RESUME_INVALID"),
      );
      assert.equal(existsSync(fixture.path), changed === "final");
      assert.equal(existsSync(fixture.output.pendingPath), true);
    } finally {
      cleanupReservation(reservation);
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

receiptTest("a stale output binding cannot reserve the same final path twice", () => {
  const fixture = outputFixture("brain-private-receipt-collision-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "first" });
    assert.throws(
      () => reservePrivateAggregateReceipt(fixture.output, { status: "second" }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION"),
    );
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), {
      status: "first",
    });
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("reservation revalidation rejects in-place marker tampering", () => {
  const fixture = outputFixture("brain-private-receipt-marker-tamper-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    const marker = readFileSync(fixture.output.pendingPath);
    marker[0] ^= 1;
    writeFileSync(fixture.output.pendingPath, marker);
    marker.fill(0);
    assert.throws(
      () => validatePrivateAggregateReceiptReservation(reservation),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED"),
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("the durable pending guard precedes any final-path reservation failure", () => {
  const fixture = outputFixture("brain-private-receipt-final-collision-");
  const finalLooking = { schema_version: 1, status: "must_not_be_accepted" };
  try {
    // Simulate another owner process winning the final-path race after the
    // caller's initial absence check. Reservation must establish its pending
    // guard first, so even final-looking bytes cannot become restart proof.
    privateWrite(fixture.path, `${JSON.stringify(finalLooking)}\n`);
    assert.throws(
      () => reservePrivateAggregateReceipt(fixture.output, { status: "reserved" }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_COLLISION"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("recovery commits one exact staged receipt left before commitment", () => {
  const fixture = outputFixture("brain-private-receipt-staged-recovery-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "complete_after_recovery" };
  const failure = new Error("synthetic_staged_receipt_death");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        onFinalizationTransition(name) {
          if (name === "staged_receipt_durable") throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(existsSync(fixture.output.stagedPath), true);
    assert.equal(existsSync(fixture.output.commitPath), false);
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), marker);
    abandonPrivateAggregateReceipt(reservation);
    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(fixture.output.stagedPath), false);
    assert.equal(existsSync(fixture.output.commitPath), false);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a failed finalization retains the conservative marker", () => {
  const fixture = outputFixture("brain-private-receipt-failure-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const failure = new Error("synthetic_receipt_write_failure");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { schema_version: 1, status: "must_not_commit" },
        { writeBytes() { throw failure; } },
      ),
      (error) => error === failure,
    );
    assert.equal(reservation.closed, false);
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), marker);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.equal(existsSync(fixture.output.stagedPath), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    abandonPrivateAggregateReceipt(reservation);
    assert.throws(
      () => recoverPrivateAggregateReceiptFinalization(
        fixture.output,
        marker,
        exactReceiptValidator({ schema_version: 1, status: "must_not_commit" }),
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
    );
    assert.equal(existsSync(fixture.path), false);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(fixture.output.stagedPath), true);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a post-publication directory-sync stop recovers only the exact committed final", () => {
  const fixture = outputFixture("brain-private-receipt-post-publish-sync-");
  const receipt = { schema_version: 1, status: "must_not_look_committed" };
  const failure = Object.assign(new Error("synthetic_post_publish_sync_failure"), {
    code: "EIO",
  });
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        syncDirectory() { throw failure; },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), receipt);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    abandonPrivateAggregateReceipt(reservation);
    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      { status: "reserved" },
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a death after final sync but before pending removal recovers exact bytes only", () => {
  const fixture = outputFixture("brain-private-receipt-pending-commit-");
  const marker = { status: "reserved" };
  const receipt = { schema_version: 1, status: "must_remain_ambiguous" };
  const failure = new Error("synthetic_pending_commit_failure");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        removePending() { throw failure; },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), receipt);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    abandonPrivateAggregateReceipt(reservation);
    assert.throws(
      () => recoverPrivateAggregateReceiptFinalization(
        fixture.output,
        marker,
        () => false,
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a death after the finalization commitment recovers the exact staged receipt", () => {
  const fixture = outputFixture("brain-private-receipt-before-publish-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "must_be_recomputed" };
  const failure = new Error("synthetic_pre_publish_death");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        publish() { throw failure; },
      }),
      (error) => error === failure,
    );
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), marker);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    assert.equal(existsSync(fixture.output.stagedPath), true);
    abandonPrivateAggregateReceipt(reservation);

    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.equal(existsSync(fixture.output.stagedPath), false);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a death after pending removal recovers the exact final and removes commitment last", () => {
  const fixture = outputFixture("brain-private-receipt-after-pending-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "complete" };
  const failure = new Error("synthetic_commit_cleanup_death");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        removeCommit() { throw failure; },
      }),
      (error) => error === failure,
    );
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );

    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a death after commitment removal leaves an exact readable final", () => {
  const fixture = outputFixture("brain-private-receipt-after-commit-");
  const receipt = { schema_version: 1, status: "complete" };
  const failure = new Error("synthetic_final_directory_sync_death");
  let reservation;
  let directorySyncs = 0;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        syncDirectory(...args) {
          directorySyncs += 1;
          if (directorySyncs === 5) throw failure;
          return syncPrivateReceiptDirectory(
            args[0].parentPath,
            args[0].parentInfo,
            args[0].path,
            args[2],
            args[1],
          );
        },
      }),
      (error) => error === failure,
    );
    assert.equal(directorySyncs, 5);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), false);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("recovery refuses a replaced final or non-single-link commitment without removing guards", () => {
  for (const changed of ["final", "commit_hard_link"]) {
    const fixture = outputFixture(`brain-private-receipt-recovery-${changed}-`);
    const marker = { schema_version: 1, status: "execution_in_progress" };
    const receipt = { schema_version: 1, status: "complete" };
    const linkedCommit = join(fixture.directory, "linked-commit.json");
    let reservation;
    try {
      reservation = reservePrivateAggregateReceipt(fixture.output, marker);
      assert.throws(
        () => finalizePrivateAggregateReceipt(reservation, receipt, {
          removePending() { throw new Error("synthetic_pending_death"); },
        }),
        /synthetic_pending_death/u,
      );
      if (changed === "final") {
        privateWrite(fixture.path, `${JSON.stringify(receipt)}\n`);
      } else {
        linkSync(privateAggregateReceiptCommitPath(fixture.path), linkedCommit);
      }
      assert.throws(
        () => recoverPrivateAggregateReceiptFinalization(
          fixture.output,
          marker,
          exactReceiptValidator(receipt),
        ),
        receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
      );
      assert.equal(existsSync(fixture.output.pendingPath), true);
      assert.equal(existsSync(privateAggregateReceiptCommitPath(fixture.path)), true);
    } finally {
      cleanupReservation(reservation);
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

receiptTest("recovery refuses staged and commitment substitutions without deleting any guard", () => {
  const scenarios = [
    {
      name: "permissive_stage",
      transition: "staged_receipt_durable",
      mutate(fixture) { chmodSync(fixture.output.stagedPath, 0o640); },
    },
    {
      name: "linked_stage",
      transition: "staged_receipt_durable",
      mutate(fixture) {
        linkSync(fixture.output.stagedPath, join(fixture.directory, "linked-stage.json"));
      },
    },
    {
      name: "unrecognized_extra_stage",
      transition: "final_receipt_durable",
      mutate(fixture, receipt) {
        privateWrite(
          fixture.output.stagedPath,
          `${JSON.stringify(receipt, null, 2)}\n`,
        );
      },
    },
    {
      name: "changed_commit_path_binding",
      transition: "finalization_commit_durable",
      mutate(fixture) {
        const value = JSON.parse(readFileSync(fixture.output.commitPath, "utf8"));
        value.staged_receipt_path_sha256 = "0".repeat(64);
        privateWrite(fixture.output.commitPath, `${JSON.stringify(value, null, 2)}\n`);
      },
    },
  ];
  for (const scenario of scenarios) {
    const fixture = outputFixture(`brain-private-receipt-${scenario.name}-`);
    const marker = { schema_version: 1, status: "execution_in_progress" };
    const receipt = { schema_version: 1, status: "complete" };
    let reservation;
    try {
      reservation = reservePrivateAggregateReceipt(fixture.output, marker);
      assert.throws(
        () => finalizePrivateAggregateReceipt(reservation, receipt, {
          onFinalizationTransition(name) {
            if (name === scenario.transition) throw new Error("synthetic process death");
          },
        }),
        /synthetic process death/u,
      );
      abandonPrivateAggregateReceipt(reservation);
      scenario.mutate(fixture, receipt);
      const presentBefore = [
        fixture.path,
        fixture.output.pendingPath,
        fixture.output.stagedPath,
        fixture.output.commitPath,
      ].filter((path) => existsSync(path));
      const identities = presentBefore.map((path) => ({ path, info: lstatSync(path) }));
      assert.throws(
        () => recoverPrivateAggregateReceiptFinalization(
          fixture.output,
          marker,
          exactReceiptValidator(receipt),
        ),
        receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID"),
      );
      for (const identity of identities) {
        assert.equal(existsSync(identity.path), true);
        const current = lstatSync(identity.path);
        assert.equal(current.dev, identity.info.dev);
        assert.equal(current.ino, identity.info.ino);
      }
    } finally {
      cleanupReservation(reservation);
      if (process.platform !== "win32" && existsSync(fixture.output.stagedPath)) {
        try { chmodSync(fixture.output.stagedPath, 0o600); } catch { /* fixture cleanup */ }
      }
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

receiptTest("parent SIGKILL and fresh subprocess recovery cover every durability boundary", async () => {
  const transitions = [
    "staged_receipt_created",
    "staged_receipt_written",
    "staged_receipt_file_fsynced",
    "staged_receipt_durable",
    "finalization_commit_durable",
    "final_receipt_link_durable",
    "final_receipt_durable",
    "pending_marker_removal_durable",
    "finalization_commit_removal_durable",
  ];
  const expectedPresence = {
    staged_receipt_created: [false, true, true, false],
    staged_receipt_written: [false, true, true, false],
    staged_receipt_file_fsynced: [false, true, true, false],
    staged_receipt_durable: [false, true, true, false],
    finalization_commit_durable: [false, true, true, true],
    final_receipt_link_durable: [true, true, true, true],
    final_receipt_durable: [true, true, false, true],
    pending_marker_removal_durable: [true, false, false, true],
    finalization_commit_removal_durable: [true, false, false, false],
  };
  const moduleUrl = new URL("../operations/private-aggregate-receipt.mjs", import.meta.url).href;
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "complete_after_sigkill" };
  const recoveryScript = (fixture, {
    failStageSync = false,
    killAt = null,
  } = {}) => `
    import { writeSync } from "node:fs";
    const api = await import(${JSON.stringify(moduleUrl)});
    const output = Object.freeze({
      path: ${JSON.stringify(fixture.path)},
      pendingPath: api.privateAggregateReceiptPendingPath(${JSON.stringify(fixture.path)}),
      commitPath: api.privateAggregateReceiptCommitPath(${JSON.stringify(fixture.path)}),
      stagedPath: api.privateAggregateReceiptStagedPath(${JSON.stringify(fixture.path)}),
      parent: api.assertPrivateAggregateReceiptDirectory(${JSON.stringify(fixture.directory)}),
    });
    try {
      const result = api.recoverPrivateAggregateReceiptFinalization(
        output,
        ${JSON.stringify(marker)},
        (candidate) => JSON.stringify(candidate) === ${JSON.stringify(JSON.stringify(receipt))},
        {
          ${failStageSync ? `syncStagedFile() {
            throw new Error("synthetic recovery stage fsync failure");
          },` : ""}
          ${killAt ? `onFinalizationTransition(name) {
            if (name === ${JSON.stringify(killAt)}) {
              writeSync(
                3,
                JSON.stringify({ ready: \`recovery:\${name}\` }) + String.fromCharCode(10),
              );
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
          },` : ""}
        },
      );
      writeSync(
        3,
        JSON.stringify({ status: result.status }) + String.fromCharCode(10),
      );
    } catch (error) {
      writeSync(
        3,
        JSON.stringify({ error: error?.code ?? null }) + String.fromCharCode(10),
      );
    }
  `;
  for (const transition of transitions) {
    const fixture = outputFixture(`brain-private-receipt-sigkill-${transition}-`);
    try {
      const script = `
        import { writeSync } from "node:fs";
        const api = await import(${JSON.stringify(moduleUrl)});
        const output = api.assertPrivateAggregateOutputPath(${JSON.stringify(fixture.path)});
        const reservation = api.reservePrivateAggregateReceipt(
          output,
          ${JSON.stringify(marker)},
        );
        api.finalizePrivateAggregateReceipt(
          reservation,
          ${JSON.stringify(receipt)},
          {
            onFinalizationTransition(name) {
              if (name === ${JSON.stringify(transition)}) {
                writeSync(3, JSON.stringify({ ready: name }) + String.fromCharCode(10));
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
              }
            },
          },
        );
        writeSync(3, JSON.stringify({ error: "transition_not_reached" }) + String.fromCharCode(10));
      `;
      await parentKillControlledNode(script, transition);
      assert.deepEqual([
        existsSync(fixture.path),
        existsSync(fixture.output.pendingPath),
        existsSync(fixture.output.stagedPath),
        existsSync(fixture.output.commitPath),
      ], expectedPresence[transition]);

      if (transition === "staged_receipt_created") {
        assert.equal(lstatSync(fixture.output.stagedPath).size, 0);
        assert.deepEqual(await runControlledNode(recoveryScript(fixture)), {
          error: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID",
        });
        assert.deepEqual([
          existsSync(fixture.path),
          existsSync(fixture.output.pendingPath),
          existsSync(fixture.output.stagedPath),
          existsSync(fixture.output.commitPath),
        ], expectedPresence[transition]);
        continue;
      }

      if (transition === "staged_receipt_written") {
        assert.deepEqual(await runControlledNode(recoveryScript(fixture, {
          failStageSync: true,
        })), {
          error: "PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_RECOVERY_INVALID",
        });
        assert.deepEqual([
          existsSync(fixture.path),
          existsSync(fixture.output.pendingPath),
          existsSync(fixture.output.stagedPath),
          existsSync(fixture.output.commitPath),
        ], expectedPresence[transition]);
      }

      if (transition === "staged_receipt_durable") {
        for (const recoveryTransition of [
          "finalization_commit_durable",
          "final_receipt_link_durable",
          "final_receipt_durable",
          "pending_marker_removal_durable",
          "finalization_commit_removal_durable",
        ]) {
          await parentKillControlledNode(
            recoveryScript(fixture, { killAt: recoveryTransition }),
            `recovery:${recoveryTransition}`,
          );
          assert.deepEqual([
            existsSync(fixture.path),
            existsSync(fixture.output.pendingPath),
            existsSync(fixture.output.stagedPath),
            existsSync(fixture.output.commitPath),
          ], expectedPresence[recoveryTransition]);
        }
      }

      assert.deepEqual(await runControlledNode(recoveryScript(fixture)), {
        status: "finalized",
      });
      assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
      assert.equal(existsSync(fixture.output.pendingPath), false);
      assert.equal(existsSync(fixture.output.stagedPath), false);
      assert.equal(existsSync(fixture.output.commitPath), false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  }
});

receiptTest("descriptor helpers and deliberately short adapters preserve every receipt byte", () => {
  const fixture = outputFixture("brain-private-receipt-short-io-");
  const descriptorPath = join(fixture.directory, "descriptor.bin");
  let descriptor = openSync(
    descriptorPath,
    fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL,
    0o600,
  );
  const directBytes = Buffer.from("exact descriptor helper bytes", "utf8");
  const directReadback = Buffer.alloc(directBytes.length);
  let reservation;
  try {
    writePrivateReceiptDescriptor(descriptor, directBytes);
    readPrivateReceiptDescriptor(descriptor, directReadback);
    assert.deepEqual(directReadback, directBytes);
    closeSync(descriptor);
    descriptor = undefined;

    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    let writeCalls = 0;
    let readCalls = 0;
    assert.equal(finalizePrivateAggregateReceipt(
      reservation,
      {
        schema_version: 1,
        status: "complete",
        aggregate: { documents: 6001, chunks: 6001, pending: 0 },
      },
      {
        writeBytes(fileDescriptor, source) {
          let offset = 0;
          while (offset < source.length) {
            const length = Math.min(5, source.length - offset);
            const written = writeSync(fileDescriptor, source, offset, length, offset);
            assert.equal(written, length);
            offset += written;
            writeCalls += 1;
          }
        },
        readBytes(fileDescriptor, target) {
          let offset = 0;
          while (offset < target.length) {
            const length = Math.min(3, target.length - offset);
            const read = readSync(fileDescriptor, target, offset, length, offset);
            assert.equal(read, length);
            offset += read;
            readCalls += 1;
          }
          return target;
        },
      },
    ), true);
    assert.ok(writeCalls > 1);
    assert.ok(readCalls > 1);
    assert.equal(readPrivateAggregateReceipt(fixture.path).value.aggregate.pending, 0);
  } finally {
    directBytes.fill(0);
    directReadback.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* Best-effort fixture cleanup. */ }
    }
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an unsupported Windows finalization is refused before staging receipt bytes", () => {
  const fixture = outputFixture("brain-private-receipt-windows-order-");
  let reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
  try {
    const namesBefore = new Set(["receipt.pending.json"]);
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { schema_version: 1, status: "must_not_stage" },
        { platform: "win32" },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED"),
    );
    assert.equal(reservation.closed, false);
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), {
      status: "reserved",
    });
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.deepEqual(
      new Set(readdirSync(fixture.directory)),
      namesBefore,
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an unsupported-platform refusal leaves the marker and handle retryable", () => {
  const fixture = outputFixture("brain-private-receipt-windows-retry-");
  const marker = { schema_version: 1, status: "reserved" };
  let reservation = reservePrivateAggregateReceipt(fixture.output, marker);
  const originalDescriptor = reservation.descriptor;
  try {
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { schema_version: 1, status: "first_attempt_must_not_commit" },
        { platform: "win32" },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED"),
    );
    assert.equal(reservation.closed, false);
    assert.equal(reservation.descriptor, originalDescriptor);
    assert.equal(existsSync(fixture.path), false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.output.pendingPath, "utf8")), marker);

    assert.equal(finalizePrivateAggregateReceipt(
      reservation,
      { schema_version: 1, status: "retry_complete" },
    ), true);
    assert.equal(reservation.closed, true);
    assert.equal(reservation.descriptor, undefined);
    assert.equal(JSON.parse(readFileSync(fixture.path, "utf8")).status, "retry_complete");
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("Windows directory sync is refused rather than inferring privacy from mode bits", () => {
  const directory = privateDirectory("brain-private-receipt-directory-sync-");
  const finalPath = join(directory, "receipt.json");
  privateWrite(finalPath, "{}\n");
  const directoryInfo = lstatSync(directory);
  const finalInfo = lstatSync(finalPath);
  try {
    assert.throws(
      () => syncPrivateReceiptDirectory(
        directory,
        directoryInfo,
        finalPath,
        finalInfo,
        "SYNTHETIC_PARENT_CHANGED",
        { platform: "win32" },
      ),
      receiptError("SYNTHETIC_PARENT_CHANGED"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

receiptTest("directory sync refuses a parent made public during its durability barrier", {
  skip: process.platform === "win32",
}, () => {
  const directory = privateDirectory("brain-private-receipt-directory-mode-race-");
  const finalPath = join(directory, "receipt.json");
  privateWrite(finalPath, "{}\n");
  const directoryInfo = lstatSync(directory);
  const finalInfo = lstatSync(finalPath);
  try {
    assert.throws(
      () => syncPrivateReceiptDirectory(
        directory,
        directoryInfo,
        finalPath,
        finalInfo,
        "SYNTHETIC_PARENT_CHANGED",
        {
          syncDirectoryHandle(descriptor) {
            fsyncSync(descriptor);
            chmodSync(directory, 0o755);
          },
        },
      ),
      receiptError("SYNTHETIC_PARENT_CHANGED"),
    );
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

receiptTest("directory sync detects a parent made public and private again during fsync", {
  skip: process.platform === "win32",
}, () => {
  const directory = privateDirectory("brain-private-receipt-directory-mode-toggle-");
  const finalPath = join(directory, "receipt.json");
  privateWrite(finalPath, "{}\n");
  const directoryInfo = lstatSync(directory);
  const finalInfo = lstatSync(finalPath);
  try {
    assert.throws(
      () => syncPrivateReceiptDirectory(
        directory,
        directoryInfo,
        finalPath,
        finalInfo,
        "SYNTHETIC_PARENT_CHANGED",
        {
          syncDirectoryHandle(descriptor) {
            fsyncSync(descriptor);
            chmodSync(directory, 0o755);
            chmodSync(directory, 0o700);
          },
        },
      ),
      receiptError("SYNTHETIC_PARENT_CHANGED"),
    );
  } finally {
    chmodSync(directory, 0o700);
    rmSync(directory, { recursive: true, force: true });
  }
});

receiptTest("directory sync refuses parent owner drift observed after fsync", {
  skip: process.platform === "win32" || typeof process.getuid !== "function",
}, () => {
  const directory = privateDirectory("brain-private-receipt-directory-owner-race-");
  const finalPath = join(directory, "receipt.json");
  privateWrite(finalPath, "{}\n");
  const directoryInfo = lstatSync(directory);
  const finalInfo = lstatSync(finalPath);
  let statCalls = 0;
  try {
    assert.throws(
      () => syncPrivateReceiptDirectory(
        directory,
        directoryInfo,
        finalPath,
        finalInfo,
        "SYNTHETIC_PARENT_CHANGED",
        {
          statDirectoryHandle(descriptor) {
            const info = fstatSync(descriptor);
            statCalls += 1;
            if (statCalls === 2) info.uid = process.getuid() + 1;
            return info;
          },
        },
      ),
      receiptError("SYNTHETIC_PARENT_CHANGED"),
    );
    assert.equal(statCalls, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS directory sync detects a parent ACL added and removed during fsync", {
  skip: process.platform !== "darwin",
}, () => {
  const directory = privateDirectory("brain-private-receipt-directory-acl-toggle-");
  const finalPath = join(directory, "receipt.json");
  privateWrite(finalPath, "{}\n");
  const directoryInfo = lstatSync(directory);
  const finalInfo = lstatSync(finalPath);
  try {
    assert.throws(
      () => syncPrivateReceiptDirectory(
        directory,
        directoryInfo,
        finalPath,
        finalInfo,
        "SYNTHETIC_PARENT_CHANGED",
        {
          syncDirectoryHandle(descriptor) {
            fsyncSync(descriptor);
            macAclChange("+a", "everyone allow read,execute", directory);
            macAclChange("-N", directory);
          },
        },
      ),
      receiptError("SYNTHETIC_PARENT_CHANGED"),
    );
  } finally {
    try { macAclChange("-N", directory); } catch { /* fixture cleanup */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

receiptTest("finalization refuses a parent made public after sync and preserves the pending marker", {
  skip: process.platform === "win32",
}, () => {
  const fixture = outputFixture("brain-private-receipt-final-parent-race-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { status: "must_not_commit" },
        {
          syncDirectory() {
            chmodSync(fixture.directory, 0o755);
            return true;
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
  } finally {
    chmodSync(fixture.directory, 0o700);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("pending-marker commit rechecks parent privacy after descriptor close", {
  skip: process.platform === "win32",
}, () => {
  const fixture = outputFixture("brain-private-receipt-pending-parent-race-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { status: "must_not_commit" },
        {
          closeTemporary(descriptor) {
            closeSync(descriptor);
            chmodSync(fixture.directory, 0o755);
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PENDING_CHANGED"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
  } finally {
    chmodSync(fixture.directory, 0o700);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("pending-marker commit detects a parent permission toggle after descriptor close", {
  skip: process.platform === "win32",
}, () => {
  const fixture = outputFixture("brain-private-receipt-pending-parent-toggle-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { status: "must_not_commit" },
        {
          closeTemporary(descriptor) {
            closeSync(descriptor);
            chmodSync(fixture.directory, 0o755);
            chmodSync(fixture.directory, 0o700);
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PENDING_CHANGED"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
  } finally {
    chmodSync(fixture.directory, 0o700);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("pending-marker commit rejects a substituted finalized receipt", {
  skip: process.platform === "win32",
}, () => {
  const fixture = outputFixture("brain-private-receipt-final-substitution-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { status: "complete" },
        {
          closeTemporary(descriptor) {
            closeSync(descriptor);
            writeFileSync(
              fixture.path,
              JSON.stringify({ status: "altered!" }, null, 2) + "\n",
              { mode: 0o600 },
            );
            chmodSync(fixture.path, 0o600);
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PENDING_CHANGED"),
    );
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("hard-linked pending markers and concurrent final destinations are preserved", () => {
  const hardLinkFixture = outputFixture("brain-private-receipt-hard-link-");
  const hardLinkPath = join(hardLinkFixture.directory, "receipt-hard-link.json");
  let hardLinkReservation;
  try {
    hardLinkReservation = reservePrivateAggregateReceipt(
      hardLinkFixture.output,
      { status: "reserved" },
    );
    linkSync(hardLinkFixture.output.pendingPath, hardLinkPath);
    assert.throws(
      () => finalizePrivateAggregateReceipt(hardLinkReservation, { status: "must_not_commit" }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED"),
    );
    assert.equal(lstatSync(hardLinkFixture.output.pendingPath).nlink, 2);
  } finally {
    cleanupReservation(hardLinkReservation);
    rmSync(hardLinkFixture.directory, { recursive: true, force: true });
  }

  const replacementFixture = outputFixture("brain-private-receipt-final-collision-");
  const marker = { schema_version: 1, status: "reserved" };
  const sentinelBytes = Buffer.from('{"owner":"concurrent","must":"survive"}\n', "utf8");
  let replacementReservation;
  let sentinelInfo;
  try {
    replacementReservation = reservePrivateAggregateReceipt(replacementFixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        replacementReservation,
        { schema_version: 1, status: "must_not_commit" },
        {
          publish(from, to) {
            privateWrite(to, sentinelBytes);
            sentinelInfo = lstatSync(to);
            linkSync(from, to);
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    assert.equal(replacementReservation.closed, false);
    assert.equal(Number.isSafeInteger(replacementReservation.descriptor), true);
    const sentinelAfter = lstatSync(replacementFixture.path);
    assert.equal(sentinelAfter.dev, sentinelInfo.dev);
    assert.equal(sentinelAfter.ino, sentinelInfo.ino);
    assert.equal(sentinelAfter.nlink, 1);
    assert.equal(sentinelAfter.mode, sentinelInfo.mode);
    assert.equal(sentinelAfter.mtimeMs, sentinelInfo.mtimeMs);
    assert.equal(sentinelAfter.ctimeMs, sentinelInfo.ctimeMs);
    assert.deepEqual(readFileSync(replacementFixture.path), sentinelBytes);
    assert.equal(existsSync(replacementFixture.output.pendingPath), true);
    assert.equal(existsSync(replacementFixture.output.stagedPath), true);
    assert.equal(existsSync(replacementFixture.output.commitPath), true);
    const preserved = [
      replacementFixture.path,
      replacementFixture.output.pendingPath,
      replacementFixture.output.stagedPath,
      replacementFixture.output.commitPath,
    ].map((path) => ({ path, info: lstatSync(path), bytes: readFileSync(path) }));
    abandonPrivateAggregateReceipt(replacementReservation);
    assert.equal(replacementReservation.closed, true);
    for (const record of preserved) {
      const current = lstatSync(record.path);
      assert.equal(current.dev, record.info.dev);
      assert.equal(current.ino, record.info.ino);
      assert.deepEqual(readFileSync(record.path), record.bytes);
      record.bytes.fill(0);
    }
    assert.throws(
      () => readPrivateAggregateReceipt(replacementFixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    sentinelBytes.fill(0);
    cleanupReservation(replacementReservation);
    rmSync(replacementFixture.directory, { recursive: true, force: true });
  }
});

test("macOS refuses a staged-source symlink swap after publication and retains every guard", {
  skip: process.platform !== "darwin",
}, () => {
  const fixture = outputFixture("brain-private-receipt-source-symlink-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "must_not_accept_symlink_source" };
  const attackerPath = join(fixture.directory, "attacker.json");
  const attackerBytes = Buffer.from('{"owner":"attacker"}\n', "utf8");
  let reservation;
  try {
    privateWrite(attackerPath, attackerBytes);
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        publish(from, to) {
          unlinkSync(from);
          symlinkSync(attackerPath, from);
          linkSync(from, to);
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    for (const path of [
      fixture.path,
      fixture.output.pendingPath,
      fixture.output.stagedPath,
      fixture.output.commitPath,
    ]) {
      assert.equal(existsSync(path), true, path);
    }
    assert.equal(lstatSync(fixture.output.stagedPath).isSymbolicLink(), true);
    const finalInfo = lstatSync(fixture.path);
    const finalBytes = readFileSync(fixture.path);
    abandonPrivateAggregateReceipt(reservation);
    assert.equal(lstatSync(fixture.path).dev, finalInfo.dev);
    assert.equal(lstatSync(fixture.path).ino, finalInfo.ino);
    assert.deepEqual(readFileSync(fixture.path), finalBytes);
    finalBytes.fill(0);
  } finally {
    attackerBytes.fill(0);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("publication refuses an unexpected third hard link without deleting guards", () => {
  const fixture = outputFixture("brain-private-receipt-third-link-");
  const extraPath = join(fixture.directory, "extra-link.json");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, { status: "must_not_commit" }, {
        publish(from, to) {
          linkSync(from, to);
          linkSync(from, extraPath);
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    for (const path of [fixture.path, fixture.output.stagedPath, extraPath]) {
      assert.equal(lstatSync(path).nlink, 3);
    }
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(fixture.output.commitPath), true);
    abandonPrivateAggregateReceipt(reservation);
    assert.equal(lstatSync(fixture.path).nlink, 3);
    assert.equal(lstatSync(fixture.output.stagedPath).nlink, 3);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("fresh recovery repeats each directory barrier before cleanup or terminal acceptance", () => {
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "complete_after_barrier_recovery" };

  const linkedFixture = outputFixture("brain-private-receipt-linked-barrier-");
  let linkedReservation;
  try {
    linkedReservation = reservePrivateAggregateReceipt(linkedFixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(linkedReservation, receipt, {
        onFinalizationTransition(name) {
          if (name === "final_receipt_link_durable") throw new Error("linked stop");
        },
      }),
      /linked stop/u,
    );
    abandonPrivateAggregateReceipt(linkedReservation);
    let linkedBarrierObserved = false;
    recoverPrivateAggregateReceiptFinalization(
      linkedFixture.output,
      marker,
      exactReceiptValidator(receipt),
      {
        syncCommitDirectory(...args) {
          const options = args[5] || {};
          if (options.expectedLinkCount === 2) {
            assert.equal(lstatSync(linkedFixture.path).nlink, 2);
            assert.equal(lstatSync(linkedFixture.output.stagedPath).nlink, 2);
            linkedBarrierObserved = true;
          }
          return syncPrivateReceiptDirectory(...args);
        },
        removeStaged(stagedRecord, finalRecord) {
          assert.equal(linkedBarrierObserved, true);
          assert.equal(lstatSync(stagedRecord.path).nlink, 2);
          unlinkSync(stagedRecord.path);
          const info = lstatSync(finalRecord.path);
          assert.equal(info.nlink, 1);
          return Object.freeze({ ...finalRecord, info });
        },
      },
    );
    assert.equal(linkedBarrierObserved, true);
  } finally {
    cleanupReservation(linkedReservation);
    rmSync(linkedFixture.directory, { recursive: true, force: true });
  }

  const guardFixture = outputFixture("brain-private-receipt-guard-barriers-");
  let guardReservation;
  try {
    guardReservation = reservePrivateAggregateReceipt(guardFixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(guardReservation, receipt, {
        onFinalizationTransition(name) {
          if (name === "final_receipt_durable") throw new Error("guard stop");
        },
      }),
      /guard stop/u,
    );
    abandonPrivateAggregateReceipt(guardReservation);
    let finalBarriers = 0;
    recoverPrivateAggregateReceiptFinalization(
      guardFixture.output,
      marker,
      exactReceiptValidator(receipt),
      {
        syncDirectory(...args) {
          finalBarriers += 1;
          return syncPrivateReceiptDirectory(...args);
        },
        removeRecord(record) {
          if (record.path === guardFixture.output.pendingPath) {
            assert.ok(finalBarriers >= 1, "final barrier must precede pending deletion");
          } else if (record.path === guardFixture.output.commitPath) {
            assert.ok(finalBarriers >= 3, "final barrier must precede commit deletion");
          } else {
            assert.fail(`unexpected recovery deletion: ${record.path}`);
          }
          unlinkSync(record.path);
          return true;
        },
        validateTerminalAuthority(request) {
          if (request.phase === "before_commit_guard_removal") {
            assert.ok(finalBarriers >= 3);
          }
          if (request.phase === "accept_terminal_final") {
            assert.ok(finalBarriers >= 5, "terminal acceptance must follow its own barrier");
          }
          return true;
        },
      },
    );
    assert.ok(finalBarriers >= 5);
  } finally {
    cleanupReservation(guardReservation);
    rmSync(guardFixture.directory, { recursive: true, force: true });
  }
});

receiptTest("cancellation preserves a same-byte different-inode final collision", () => {
  const fixture = outputFixture("brain-private-receipt-cancel-final-collision-");
  const marker = { schema_version: 1, status: "cancel_exact_reservation" };
  const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    abandonPrivateAggregateReceipt(reservation);
    privateWrite(fixture.path, markerBytes);
    const finalBefore = lstatSync(fixture.path);
    const pendingBefore = lstatSync(fixture.output.pendingPath);
    assert.notEqual(finalBefore.ino, pendingBefore.ino);
    assert.throws(
      () => clearPrivateAggregateReceiptReservation(fixture.output, marker),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_CANCELLATION_INVALID"),
    );
    const finalAfter = lstatSync(fixture.path);
    const pendingAfter = lstatSync(fixture.output.pendingPath);
    assert.equal(finalAfter.dev, finalBefore.dev);
    assert.equal(finalAfter.ino, finalBefore.ino);
    assert.equal(pendingAfter.dev, pendingBefore.dev);
    assert.equal(pendingAfter.ino, pendingBefore.ino);
    assert.deepEqual(readFileSync(fixture.path), markerBytes);
    assert.deepEqual(readFileSync(fixture.output.pendingPath), markerBytes);
  } finally {
    markerBytes.fill(0);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("an ambiguous throw after hard-link publication retains both names for recovery", () => {
  const fixture = outputFixture("brain-private-receipt-ambiguous-link-");
  const marker = { schema_version: 1, status: "execution_in_progress" };
  const receipt = { schema_version: 1, status: "complete_after_recovery" };
  const failure = new Error("synthetic_ambiguous_link_result");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        publish(from, to) {
          linkSync(from, to);
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    const finalInfo = lstatSync(fixture.path);
    const stagedInfo = lstatSync(fixture.output.stagedPath);
    assert.equal(finalInfo.dev, stagedInfo.dev);
    assert.equal(finalInfo.ino, stagedInfo.ino);
    assert.equal(finalInfo.nlink, 2);
    assert.equal(stagedInfo.nlink, 2);
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(fixture.output.commitPath), true);
    abandonPrivateAggregateReceipt(reservation);
    assert.equal(lstatSync(fixture.path).ino, finalInfo.ino);
    assert.equal(lstatSync(fixture.output.stagedPath).ino, stagedInfo.ino);

    const recovered = recoverPrivateAggregateReceiptFinalization(
      fixture.output,
      marker,
      exactReceiptValidator(receipt),
    );
    assert.equal(recovered.status, "finalized");
    assert.equal(lstatSync(fixture.path).nlink, 1);
    assert.equal(existsSync(fixture.output.pendingPath), false);
    assert.equal(existsSync(fixture.output.stagedPath), false);
    assert.equal(existsSync(fixture.output.commitPath), false);
    assert.deepEqual(readPrivateAggregateReceipt(fixture.path).value, receipt);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("same-byte linked substitution before cleanup is refused without deletion", () => {
  const fixture = outputFixture("brain-private-receipt-linked-substitution-");
  const receipt = { schema_version: 1, status: "must_remain_guarded" };
  const substitutePath = join(fixture.directory, "substitute.json");
  let reservation;
  let substituteInfo;
  let substituteBytes;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        onFinalizationTransition(name) {
          if (name !== "final_receipt_link_durable") return;
          substituteBytes = readFileSync(fixture.path);
          unlinkSync(fixture.path);
          unlinkSync(fixture.output.stagedPath);
          privateWrite(substitutePath, substituteBytes);
          linkSync(substitutePath, fixture.path);
          linkSync(substitutePath, fixture.output.stagedPath);
          unlinkSync(substitutePath);
          substituteInfo = lstatSync(fixture.path);
          assert.equal(substituteInfo.nlink, 2);
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    for (const path of [fixture.path, fixture.output.stagedPath]) {
      const current = lstatSync(path);
      assert.equal(current.dev, substituteInfo.dev);
      assert.equal(current.ino, substituteInfo.ino);
      assert.equal(current.nlink, 2);
      assert.deepEqual(readFileSync(path), substituteBytes);
    }
    assert.equal(existsSync(fixture.output.pendingPath), true);
    assert.equal(existsSync(fixture.output.commitPath), true);
    abandonPrivateAggregateReceipt(reservation);
    assert.equal(lstatSync(fixture.path).ino, substituteInfo.ino);
    assert.equal(lstatSync(fixture.output.stagedPath).ino, substituteInfo.ino);
  } finally {
    if (substituteBytes) substituteBytes.fill(0);
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a hard-link race during readback is refused", () => {
  const fixture = outputFixture("brain-private-receipt-read-race-");
  const racedLink = join(fixture.directory, "raced-link.json");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    finalizePrivateAggregateReceipt(reservation, { status: "complete" });
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path, {
        readFile(descriptor) {
          const raw = readFileSync(descriptor);
          linkSync(fixture.path, racedLink);
          return raw;
        },
      }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
    assert.equal(lstatSync(fixture.path).nlink, 2);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("POSIX receipt paths and reads reject group or world access", {
  skip: process.platform === "win32",
}, () => {
  const publicDirectory = privateDirectory("brain-private-receipt-public-parent-");
  const publicPath = join(publicDirectory, "receipt.json");
  chmodSync(publicDirectory, 0o755);
  try {
    assert.throws(
      () => assertPrivateAggregateOutputPath(publicPath),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_OUTPUT_REFUSED"),
    );
  } finally {
    rmSync(publicDirectory, { recursive: true, force: true });
  }

  const fixture = outputFixture("brain-private-receipt-public-file-");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    finalizePrivateAggregateReceipt(reservation, { status: "complete" });
    chmodSync(fixture.path, 0o640);
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
