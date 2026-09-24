import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RecoveryContentFingerprintError,
  captureDirectD1ContentFingerprint,
  hashNormalizedRecoveryDataExport,
} from "../operations/recovery-content-fingerprint.mjs";
import {
  SYMLINK_PRIVILEGE_UNAVAILABLE_REASON,
  createTestSymlink,
} from "./helpers/symlink-capability.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "brain-content-fingerprint-"));
  if (process.platform !== "win32") chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
}

test("shared symlink fixture capability skips only missing privilege", () => {
  const calls = [];
  const skipped = [];
  const created = createTestSymlink({
    target: "target",
    path: "link",
    type: "file",
    symlink(target, path, type) {
      calls.push({ target, path, type });
    },
    onSkip: (reason) => skipped.push(reason),
  });
  assert.deepEqual(created, { created: true, type: "file" });
  assert.deepEqual(calls, [{ target: "target", path: "link", type: "file" }]);
  assert.deepEqual(skipped, []);

  const unavailable = createTestSymlink({
    target: "target",
    path: "link",
    type: "file",
    symlink() {
      const error = new Error("privilege not held");
      error.code = "EPERM";
      throw error;
    },
    onSkip: (reason) => skipped.push(reason),
  });
  assert.deepEqual(unavailable, { created: false, type: null });
  assert.deepEqual(skipped, [SYMLINK_PRIVILEGE_UNAVAILABLE_REASON]);

  const directoryAttempts = [];
  const junction = createTestSymlink({
    target: "target-directory",
    path: "linked-directory",
    type: "dir",
    platform: "win32",
    symlink(target, path, type) {
      directoryAttempts.push({ target, path, type });
      if (type === "dir") {
        const error = new Error("privilege not held");
        error.code = "EACCES";
        throw error;
      }
    },
    onSkip: (reason) => skipped.push(reason),
  });
  assert.deepEqual(junction, { created: true, type: "junction" });
  assert.deepEqual(directoryAttempts, [
    { target: "target-directory", path: "linked-directory", type: "dir" },
    { target: "target-directory", path: "linked-directory", type: "junction" },
  ]);
  assert.deepEqual(skipped, [SYMLINK_PRIVILEGE_UNAVAILABLE_REASON]);

  assert.throws(
    () => createTestSymlink({
      target: "target",
      path: "link",
      type: "file",
      symlink() {
        const error = new Error("unexpected fixture failure");
        error.code = "EINVAL";
        throw error;
      },
      onSkip: (reason) => skipped.push(reason),
    }),
    (error) => error?.code === "EINVAL",
  );
  assert.deepEqual(skipped, [SYMLINK_PRIVILEGE_UNAVAILABLE_REASON]);
});

test("normalized recovery fingerprint hashes the prefix and exact export bytes", (t) => {
  const root = fixture(t);
  const path = join(root, "data.sql");
  const prefix = Buffer.from("INSERT INTO install_state VALUES (1);\n", "utf8");
  const data = Buffer.from("INSERT INTO documents VALUES ('synthetic');\n", "utf8");
  writeFileSync(path, data, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(path, 0o600);
  const expected = createHash("sha256").update(prefix).update(data).digest("hex");
  assert.equal(hashNormalizedRecoveryDataExport(prefix, path, 1024), expected);
});

test("capture wipes the normalized prefix and always removes the direct export", async (t) => {
  const root = fixture(t);
  const path = join(root, "data.sql");
  const prefix = Buffer.from("private normalized prefix", "utf8");
  let cleaned = false;
  const fingerprint = await captureDirectD1ContentFingerprint({
    normalizedInstallState: prefix,
    exportPath: path,
    maxBytes: 1024,
    exportData: async () => {
      writeFileSync(path, "synthetic export\n", { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(path, 0o600);
    },
    cleanupExport: async () => {
      unlinkSync(path);
      cleaned = true;
    },
  });
  assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  assert.equal(cleaned, true);
  assert.ok(prefix.every((byte) => byte === 0));
});

test("capture leaves ambiguous export residue unless the caller explicitly owns retry cleanup", async (t) => {
  const root = fixture(t);
  const path = join(root, "data.sql");
  const prefix = Buffer.from("private normalized prefix", "utf8");
  let cleaned = false;
  await assert.rejects(captureDirectD1ContentFingerprint({
    normalizedInstallState: prefix,
    exportPath: path,
    maxBytes: 1024,
    exportData: async () => {
      writeFileSync(path, "partial\n", { mode: 0o600 });
      throw new Error("ambiguous transport");
    },
    cleanupExport: async () => {
      unlinkSync(path);
      cleaned = true;
    },
  }), /ambiguous transport/u);
  assert.equal(cleaned, false);
  assert.throws(() => writeFileSync(path, "replacement\n", { flag: "wx" }), /EEXIST/u);
  let retryTransportCalled = false;
  const retryPrefix = Buffer.from("retry prefix", "utf8");
  await assert.rejects(captureDirectD1ContentFingerprint({
    normalizedInstallState: retryPrefix,
    exportPath: path,
    maxBytes: 1024,
    exportData: async () => { retryTransportCalled = true; },
    cleanupExport: async () => { retryTransportCalled = true; },
  }), (error) => error.code === "RECOVERY_CONTENT_EXPORT_ALREADY_EXISTS");
  assert.equal(retryTransportCalled, false);
  assert.ok(retryPrefix.every((byte) => byte === 0));
  assert.ok(prefix.every((byte) => byte === 0));
});

test("capture refuses a pre-existing output before transport and supports fixed journal cleanup", async (t) => {
  const root = fixture(t);
  const path = join(root, "data.sql");
  writeFileSync(path, "existing\n", { mode: 0o600 });
  let called = false;
  await assert.rejects(captureDirectD1ContentFingerprint({
    normalizedInstallState: Buffer.from("prefix"),
    exportPath: path,
    maxBytes: 1024,
    exportData: async () => { called = true; },
    cleanupExport: async () => { called = true; },
  }), (error) => error.code === "RECOVERY_CONTENT_EXPORT_ALREADY_EXISTS");
  assert.equal(called, false);
  unlinkSync(path);

  const prefix = Buffer.from("private normalized prefix", "utf8");
  await assert.rejects(captureDirectD1ContentFingerprint({
    normalizedInstallState: prefix,
    exportPath: path,
    maxBytes: 1024,
    cleanupOnFailure: true,
    exportData: async () => {
      writeFileSync(path, "partial\n", { mode: 0o600 });
      throw new Error("journalled transport");
    },
    cleanupExport: async () => unlinkSync(path),
  }), /journalled transport/u);
  assert.doesNotThrow(() => writeFileSync(path, "replacement\n", { flag: "wx" }));
  assert.ok(prefix.every((byte) => byte === 0));
});

test("hard-link and non-private exports fail closed", (t) => {
  const root = fixture(t);
  const direct = join(root, "direct.sql");
  const alias = join(root, "alias.sql");
  writeFileSync(direct, "synthetic\n", { mode: 0o600 });
  linkSync(direct, alias);
  assert.throws(
    () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), direct, 1024),
    (error) => error instanceof RecoveryContentFingerprintError &&
      error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
  );
  unlinkSync(alias);
  if (process.platform !== "win32") {
    mkdirSync(join(root, "private"), { mode: 0o700 });
    chmodSync(direct, 0o644);
    assert.throws(
      () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), direct, 1024),
      (error) => error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
    );
  }
});

test("symlinked exports fail closed", (t) => {
  const root = fixture(t);
  const direct = join(root, "direct.sql");
  const symlink = join(root, "symlink.sql");
  writeFileSync(direct, "synthetic\n", { mode: 0o600 });
  const linked = createTestSymlink({
    target: direct,
    path: symlink,
    type: "file",
    onSkip: (reason) => t.skip(reason),
  });
  if (!linked.created) return;
  assert.throws(
    () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), symlink, 1024),
    (error) => error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
  );
});

test("an export below a directory link or junction fails closed", (t) => {
  const root = fixture(t);
  const target = join(root, "target");
  const linkedDirectory = join(root, "linked");
  mkdirSync(target, { mode: 0o700 });
  writeFileSync(join(target, "data.sql"), "synthetic\n", { mode: 0o600 });
  const linked = createTestSymlink({
    target,
    path: linkedDirectory,
    type: "dir",
    onSkip: (reason) => t.skip(reason),
  });
  if (!linked.created) return;
  assert.throws(
    () => hashNormalizedRecoveryDataExport(
      Buffer.from("prefix"),
      join(linkedDirectory, "data.sql"),
      1024,
    ),
    (error) => error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
  );
});
