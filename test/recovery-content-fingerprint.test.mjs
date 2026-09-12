import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "brain-content-fingerprint-"));
  if (process.platform !== "win32") chmodSync(root, 0o700);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return realpathSync(root);
}

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

test("symlink, hard-link, and non-private exports fail closed", (t) => {
  const root = fixture(t);
  const direct = join(root, "direct.sql");
  const alias = join(root, "alias.sql");
  const symlink = join(root, "symlink.sql");
  writeFileSync(direct, "synthetic\n", { mode: 0o600 });
  linkSync(direct, alias);
  assert.throws(
    () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), direct, 1024),
    (error) => error instanceof RecoveryContentFingerprintError &&
      error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
  );
  unlinkSync(alias);
  symlinkSync(direct, symlink);
  assert.throws(
    () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), symlink, 1024),
    (error) => error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
  );
  if (process.platform !== "win32") {
    mkdirSync(join(root, "private"), { mode: 0o700 });
    chmodSync(direct, 0o644);
    assert.throws(
      () => hashNormalizedRecoveryDataExport(Buffer.from("prefix"), direct, 1024),
      (error) => error.code === "RECOVERY_CONTENT_EXPORT_INVALID",
    );
  }
});
