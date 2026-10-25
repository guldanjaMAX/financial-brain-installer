import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeAdminKeyFile, readAdminKeyFile } from "../operations/admin-key-file.mjs";
import { saveTokens, loadTokens } from "../connectors/google-auth.mjs";
import { pinStagingMtime } from "./fixtures/rename-retry-staging.mjs";

function syntheticProtection() {
  const records = new Map();
  return (_command, args, options) => {
    const input = Buffer.from(options.input);
    if (args[args.indexOf("-Operation") + 1] === "protect") {
      const cipher = Buffer.from(`synthetic-protected-${records.size}`);
      records.set(cipher.toString("hex"), input);
      return { status: 0, stdout: cipher, stderr: Buffer.alloc(0) };
    }
    const plain = records.get(input.toString("hex"));
    return { status: plain ? 0 : 1, stdout: plain ? Buffer.from(plain) : Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
}

const writers = [
  {
    name: "admin key", filename: ".brain-admin-key", prior: `${"a".repeat(48)}\n`,
    write: (path, options) => writeAdminKeyFile(path, "b".repeat(48), options),
    current: (path, options) => readAdminKeyFile(path, options) === "b".repeat(48),
    renameOption: "rename",
  },
  {
    name: "Google token", filename: "tokens.json", prior: '{"google":{"scopes":["drive"]}}\n',
    write: (path, options) => saveTokens({ google: { scopes: ["drive", "gmail"] } }, { ...options, path, backend: "file" }),
    current: (path, options) => loadTokens({ ...options, path, backend: "file" })?.google?.scopes?.join(",") === "drive,gmail",
    renameOption: "renameFile",
  },
];

for (const writer of writers) {
  for (const blocked of [false, true]) {
    test(`${writer.name}: ${blocked ? "sharing lock during backup cleanup retains verified replacement" : "successful backup cleanup retains verified replacement"}`, () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-credential-cleanup-")));
      const path = join(root, writer.filename);
      fs.writeFileSync(path, writer.prior, { mode: 0o600 });
      const restorePin = pinStagingMtime(root);
      const nativeUnlink = fs.unlinkSync;
      const nativeRename = fs.renameSync;
      let backupRemovals = 0;
      let renames = 0;
      let refusal;
      const options = {
        platform: "win32", username: "synthetic-owner",
        environment: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
        runAcl: () => ({ status: 0 }), runPowerShell: syntheticProtection(),
        fetchImpl: () => { throw new Error("unexpected provider request"); },
        [writer.renameOption]: (from, to) => { renames++; return nativeRename(from, to); },
      };
      fs.unlinkSync = candidate => {
        if (candidate.startsWith(root) && candidate.endsWith(".bak")) {
          backupRemovals++;
          if (blocked) throw Object.assign(new Error("synthetic sharing refusal"), { code: "EPERM" });
        }
        return nativeUnlink(candidate);
      };
      syncBuiltinESMExports();
      try {
        try { writer.write(path, options); } catch (error) { refusal = error; }
        assert.equal(backupRemovals, 1, "the cleanup boundary was exercised");
        assert.equal(renames, 1, "verified publication must never be rolled back for cleanup");
        assert.equal(writer.current(path, options), true, "the verified replacement stays authoritative");
        const backups = fs.readdirSync(root).filter(name => name.endsWith(".bak"));
        if (blocked) {
          assert.match(refusal?.message || "", /replacement .*verified and remains stored; cleanup of its protected rollback backup could not be verified/);
          assert.doesNotMatch(refusal.message, /not verified|restored/);
          assert.equal(backups.length, 1, "the protected residue remains visible for recovery");
        } else {
          assert.equal(refusal, undefined);
          assert.equal(backups.length, 0);
        }
      } finally {
        fs.unlinkSync = nativeUnlink;
        syncBuiltinESMExports();
        restorePin();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

for (const writer of writers) {
  for (const drift of ["control", "change-time-only", "modification-time"]) {
    test(`${writer.name}: predecessor ${drift} after private snapshot`, () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-credential-predecessor-")));
      const path = join(root, writer.filename);
      fs.writeFileSync(path, writer.prior, { mode: 0o600 });
      const restorePin = pinStagingMtime(root);
      const nativeLstat = fs.lstatSync;
      const nativeRename = fs.renameSync;
      let prepared = false;
      let renames = 0;
      let refusal;
      const options = {
        platform: "win32", username: "synthetic-owner",
        environment: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
        runAcl: () => ({ status: 0 }), runPowerShell: syntheticProtection(),
        fetchImpl: () => { throw new Error("unexpected provider request"); },
        syncParentDirectory: (_directory, phase) => { if (phase === "prepared") prepared = true; },
        [writer.renameOption]: (from, to) => { renames++; return nativeRename(from, to); },
      };
      fs.lstatSync = (candidate, ...args) => {
        const identity = nativeLstat(candidate, ...args);
        if (candidate !== path || !prepared || renames || drift === "control") return identity;
        const changed = Object.assign(Object.create(Object.getPrototypeOf(identity)), identity);
        const key = drift === "change-time-only" ? "ctimeMs" : "mtimeMs";
        changed[key] += typeof changed[key] === "bigint" ? 1000n : 1000;
        return changed;
      };
      syncBuiltinESMExports();
      try {
        try { writer.write(path, options); } catch (error) { refusal = error; }
        if (drift === "modification-time") {
          assert.equal(renames, 0, "a changed predecessor must refuse before publication");
          assert.match(refusal?.message || "", /destination changed before replacement/);
          assert.equal(fs.readFileSync(path, "utf8") === writer.prior, true);
        } else {
          assert.equal(refusal, undefined, "delayed ACL change time cannot revoke the private snapshot");
          assert.equal(renames, 1);
          assert.equal(writer.current(path, options), true);
        }
      } finally {
        fs.lstatSync = nativeLstat;
        syncBuiltinESMExports();
        restorePin();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
