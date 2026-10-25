import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveDrainState } from "../connectors/whatsapp.mjs";
import { desktopBindingStore, makeDesktopBinding } from "../connectors/quickbooks-desktop-binding.mjs";
import { writeQuickBooksScheduleState } from "../operations/quickbooks-schedule-state.mjs";
import { pinStagingMtime } from "./fixtures/rename-retry-staging.mjs";

const writers = [
  {
    name: "private drain state",
    prepare(root, protectFile) {
      const path = join(root, "state.json");
      fs.writeFileSync(path, '{"version":1,"last_seq":1}', { mode: 0o600 });
      return { path, write: () => saveDrainState(path, { version: 1, last_seq: 2 }, {
        platform: "win32", username: "synthetic-owner",
        environment: { SystemRoot: process.env.SystemRoot || "C:\\Windows" },
        runAcl: (_command, args) => { protectFile(args[0]); return { status: 0 }; },
        fetchImpl: () => { throw new Error("unexpected provider request"); },
      }) };
    },
  },
  {
    name: "private desktop binding",
    prepare(root, protectFile) {
      const store = desktopBindingStore({ home: root, platform: "win32", protectFile, protectDirectory() {} });
      const value = makeDesktopBinding({ country: "US", accounts: [{ ListID: "80000001-1234567890", TimeCreated: "2026-01-01T00:00:00Z" }] });
      store.write(value);
      return { path: join(root, ".brain", "quickbooks-desktop.json"), write: () => store.write(value) };
    },
  },
  {
    name: "private schedule evidence",
    prepare(root, protectFile) {
      const plan = { identity: { id: "v1-0123456789abcdef" } };
      const source = { key: "quickbooks", configuration_hash: `sha256:${"a".repeat(64)}` };
      const options = { home: root, platform: "win32", protectFile, protectDirectory() {} };
      const value = { last_complete_snapshot_at: null, last_run_failed: false };
      writeQuickBooksScheduleState(plan, source, value, options);
      return { path: join(root, ".brain", "quickbooks-schedule", plan.identity.id, "quickbooks.json"),
        write: () => writeQuickBooksScheduleState(plan, source, { ...value, last_run_failed: true }, options) };
    },
  },
];

for (const writer of writers) {
  for (const drift of ["control", "change-time-only", "modification-time"]) {
    test(`${writer.name}: predecessor ${drift} after ACL preparation`, () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "brain-acl-predecessor-")));
      const restorePin = pinStagingMtime(root);
      let prepared = false;
      const { path, write } = writer.prepare(root, candidate => {
        if (/\.tmp(?:-|$)/.test(candidate) || candidate.endsWith(".tmp")) prepared = true;
      });
      prepared = false;
      const prior = fs.readFileSync(path);
      const nativeLstat = fs.lstatSync;
      const nativeRename = fs.renameSync;
      let renames = 0;
      let refusal;
      fs.lstatSync = (candidate, ...args) => {
        const identity = nativeLstat(candidate, ...args);
        if (candidate !== path || !prepared || renames || drift === "control") return identity;
        const changed = Object.assign(Object.create(Object.getPrototypeOf(identity)), identity);
        const key = drift === "change-time-only" ? "ctimeMs" : "mtimeMs";
        changed[key] += typeof changed[key] === "bigint" ? 1000n : 1000;
        return changed;
      };
      fs.renameSync = (from, to) => {
        if (to === path) renames++;
        return nativeRename(from, to);
      };
      syncBuiltinESMExports();
      try {
        try { write(); } catch (error) { refusal = error; }
        assert.equal(prepared, true, "the ACL preparation boundary was exercised");
        if (drift === "modification-time") {
          assert.equal(renames, 0, "modified predecessor must refuse before publication");
          assert.ok(refusal);
          assert.equal(fs.readFileSync(path).equals(prior), true);
        } else {
          assert.equal(refusal, undefined, "delayed ACL change time must permit the same predecessor");
          assert.equal(renames, 1);
        }
      } finally {
        fs.lstatSync = nativeLstat;
        fs.renameSync = nativeRename;
        syncBuiltinESMExports();
        restorePin();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}
