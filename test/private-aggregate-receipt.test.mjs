import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
  assertPrivateAggregateOutputPath,
  finalizePrivateAggregateReceipt,
  readPrivateAggregateReceipt,
  readPrivateReceiptDescriptor,
  reservePrivateAggregateReceipt,
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
    aggregate: { chunks: 3201, pending: 0 },
  };
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, marker);
    assert.equal(reservation.closed, false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), marker);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(fixture.directory).mode & 0o077, 0);
      assert.equal(lstatSync(fixture.path).mode & 0o077, 0);
    }

    assert.equal(finalizePrivateAggregateReceipt(reservation, receipt), true);
    assert.equal(reservation.closed, true);
    assert.equal(reservation.descriptor, undefined);
    assert.equal(existsSync(fixture.output.pendingPath), false);

    const persistedBytes = readFileSync(fixture.path);
    const readback = readPrivateAggregateReceipt(fixture.path);
    assert.equal(readback.path, fixture.path);
    assert.equal(
      readback.sha256,
      createHash("sha256").update(persistedBytes).digest("hex"),
    );
    assert.deepEqual(readback.value, receipt);
    assert.equal(Object.isFrozen(readback), true);
    assert.equal(Object.isFrozen(readback.value), true);
    if (process.platform !== "win32") {
      assert.equal(lstatSync(fixture.path).mode & 0o077, 0);
    }
    persistedBytes.fill(0);
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
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
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), { status: "first" });
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
    const marker = readFileSync(fixture.path);
    marker[0] ^= 1;
    writeFileSync(fixture.path, marker);
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
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), marker);
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

receiptTest("a post-rename directory-sync failure remains visibly ambiguous", () => {
  const fixture = outputFixture("brain-private-receipt-post-rename-sync-");
  const receipt = { schema_version: 1, status: "must_not_look_committed" };
  const failure = Object.assign(new Error("synthetic_post_rename_sync_failure"), {
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
    assert.throws(
      () => readPrivateAggregateReceipt(fixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    cleanupReservation(reservation);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

receiptTest("a failure before the pending-marker commit point cannot expose a final receipt", () => {
  const fixture = outputFixture("brain-private-receipt-pending-commit-");
  const receipt = { schema_version: 1, status: "must_remain_ambiguous" };
  const failure = new Error("synthetic_pending_commit_failure");
  let reservation;
  try {
    reservation = reservePrivateAggregateReceipt(fixture.output, { status: "reserved" });
    assert.throws(
      () => finalizePrivateAggregateReceipt(reservation, receipt, {
        removePending() { throw failure; },
      }),
      (error) => error === failure,
    );
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), receipt);
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
        aggregate: { documents: 3201, chunks: 3201, pending: 0 },
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
    const namesBefore = new Set(["receipt.json", "receipt.pending.json"]);
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        reservation,
        { schema_version: 1, status: "must_not_stage" },
        { platform: "win32" },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_PLATFORM_UNSUPPORTED"),
    );
    assert.equal(reservation.closed, false);
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), { status: "reserved" });
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
    assert.deepEqual(JSON.parse(readFileSync(fixture.path, "utf8")), marker);

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

receiptTest("hard links and a finalization path replacement are refused", () => {
  const hardLinkFixture = outputFixture("brain-private-receipt-hard-link-");
  const hardLinkPath = join(hardLinkFixture.directory, "receipt-hard-link.json");
  let hardLinkReservation;
  try {
    hardLinkReservation = reservePrivateAggregateReceipt(
      hardLinkFixture.output,
      { status: "reserved" },
    );
    linkSync(hardLinkFixture.path, hardLinkPath);
    assert.throws(
      () => finalizePrivateAggregateReceipt(hardLinkReservation, { status: "must_not_commit" }),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_RESERVATION_CHANGED"),
    );
    assert.equal(lstatSync(hardLinkFixture.path).nlink, 2);
  } finally {
    cleanupReservation(hardLinkReservation);
    rmSync(hardLinkFixture.directory, { recursive: true, force: true });
  }

  const replacementFixture = outputFixture("brain-private-receipt-path-replacement-");
  const displacedPath = join(replacementFixture.directory, "original-marker.json");
  const marker = { schema_version: 1, status: "reserved" };
  const markerBytes = Buffer.from(`${JSON.stringify(marker, null, 2)}\n`, "utf8");
  let replacementReservation;
  try {
    replacementReservation = reservePrivateAggregateReceipt(replacementFixture.output, marker);
    assert.throws(
      () => finalizePrivateAggregateReceipt(
        replacementReservation,
        { schema_version: 1, status: "must_not_commit" },
        {
          rename(from, to) {
            renameSync(replacementFixture.path, displacedPath);
            privateWrite(replacementFixture.path, markerBytes);
            renameSync(from, to);
          },
        },
      ),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_FINALIZATION_CHANGED"),
    );
    assert.equal(replacementReservation.closed, false);
    assert.equal(Number.isSafeInteger(replacementReservation.descriptor), true);
    assert.equal(existsSync(displacedPath), true);
    assert.deepEqual(JSON.parse(readFileSync(replacementFixture.path, "utf8")), {
      schema_version: 1,
      status: "must_not_commit",
    });
    assert.equal(existsSync(replacementFixture.output.pendingPath), true);
    assert.throws(
      () => readPrivateAggregateReceipt(replacementFixture.path),
      receiptError("PRIVATE_AGGREGATE_RECEIPT_READ_REFUSED"),
    );
  } finally {
    markerBytes.fill(0);
    cleanupReservation(replacementReservation);
    rmSync(replacementFixture.directory, { recursive: true, force: true });
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
