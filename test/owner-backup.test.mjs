import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  createOwnerBackup,
  latestOwnerRestorePoint,
  pruneOwnerBackups,
  resetOwnerIngestState,
} from "../operations/owner-backup.mjs";
import { generateRecoveryArtifactKey } from "../operations/recovery-artifact-crypto.mjs";
import { buildBackupSchedulerPlan } from "../operations/backup-scheduler.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-owner-backup-"));
  chmodSync(root, 0o700);
  const manifestPath = join(root, "brain.manifest.json");
  const backupRoot = join(root, "owner-backups");
  writeFileSync(manifestPath, JSON.stringify({
    client: { slug: "fixture" },
    infrastructure: { cloudflare: { d1_database_id: "fixture-db" } },
    operations: { backup: { directory: backupRoot, retention_days: 30 } },
    corpora: { local_folder: { enabled: true, path: "./documents" } },
  }, null, 2));
  writeFileSync(join(root, ".brain-ingest-drive.json"), JSON.stringify({ done: { one: "hash" } }));
  writeFileSync(join(root, ".brain-admin-key"), "must-not-leave-this-file");
  return { root, manifestPath, backupRoot };
}

test("backup copies the manifest and resumable state, records a D1 time, and excludes the admin key", async () => {
  const { manifestPath, backupRoot } = fixture();
  const result = await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    reason: "manual",
    nonce: "aaaaaaaaaaaaaaaa",
  });

  assert.equal(result.restorePoint.timestamp, "2026-09-24T12:00:00.000Z");
  assert.equal(result.restorePoint.bookmark, null);
  assert.equal(result.files.length, 2);
  assert.equal(existsSync(join(result.path, "brain.manifest.json")), true);
  assert.equal(existsSync(join(result.path, ".brain-ingest-drive.json")), true);
  assert.equal(existsSync(join(result.path, ".brain-admin-key")), false);
  assert.doesNotMatch(readFileSync(join(result.path, "receipt.json"), "utf8"), /must-not-leave-this-file/);
  assert.equal(latestOwnerRestorePoint(manifestPath).path, result.path);
  assert.equal(existsSync(backupRoot), true);
});

test("negative backup path reaches the state decision and rejects an admin-key-shaped state name", async () => {
  const { manifestPath, root } = fixture();
  let inspected = 0;
  await assert.rejects(
    createOwnerBackup(manifestPath, {
      now: () => new Date("2026-09-24T12:00:00.000Z"),
      nonce: "bbbbbbbbbbbbbbbb",
      listStateFiles: () => {
        inspected += 1;
        return [join(root, ".brain-admin-key")];
      },
    }),
    /state-file allowlist/,
  );
  assert.equal(inspected, 1, "the state-file decision point was reached");
});

test("a plaintext admin-key value in the manifest is refused before any snapshot is published", async () => {
  const { manifestPath, backupRoot } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.operations.admin_key_secret = "not-a-protected-locator";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await assert.rejects(createOwnerBackup(manifestPath), /protected-store locator/);
  assert.equal(existsSync(backupRoot), false);
});

test("every manifest secret field must be a locator before a backup directory is published", async () => {
  const { manifestPath, backupRoot } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.operations.alert_webhook_secret = "plain-webhook-value";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await assert.rejects(createOwnerBackup(manifestPath), /alert_webhook_secret.*locator/i);
  assert.equal(existsSync(backupRoot), false, "no backup root was published after the secret-field decision");
});

test("credential-shaped resume state is refused before a backup directory is published", async () => {
  const { manifestPath, backupRoot, root } = fixture();
  writeFileSync(join(root, ".brain-ingest-drive.json"), JSON.stringify({
    checkpoint: "safe",
    access_token: `ghp_${"a".repeat(36)}`,
  }));
  await assert.rejects(createOwnerBackup(manifestPath), /credential-like material/i);
  assert.equal(existsSync(backupRoot), false, "the scanner decision was reached before publication");
});

test("retention removes only complete owned backups older than the configured window", async () => {
  const { manifestPath, backupRoot } = fixture();
  const old = await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    nonce: "cccccccccccccccc",
  });
  const recent = await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-09-24T00:00:00.000Z"),
    nonce: "dddddddddddddddd",
  });
  mkdirSync(join(backupRoot, "do-not-touch"), { mode: 0o700 });

  const result = pruneOwnerBackups(manifestPath, {
    now: () => new Date("2026-09-24T12:00:00.000Z"),
  });
  assert.deepEqual(result.removed, [old.path]);
  assert.equal(existsSync(old.path), false);
  assert.equal(existsSync(recent.path), true);
  assert.equal(existsSync(join(backupRoot, "do-not-touch")), true);
});

test("optional encryption leaves no plaintext manifest or state in the completed backup", async () => {
  const { manifestPath } = fixture();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.operations.backup.encrypt = true;
  manifest.operations.backup.encryption_key_secret = "keychain://fixture/owner-backup";
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const key = generateRecoveryArtifactKey((size) => Buffer.alloc(size, 17));
  let keyReads = 0;
  const result = await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-09-24T12:00:00.000Z"),
    nonce: "eeeeeeeeeeeeeeee",
    resolveEncryptionKey: async (locator) => {
      keyReads += 1;
      assert.equal(locator, "keychain://fixture/owner-backup");
      return key;
    },
  });
  assert.equal(keyReads, 1);
  assert.deepEqual(readdirSync(result.path).sort(), ["backup.fbrenc", "receipt.json"]);
  assert.doesNotMatch(readFileSync(join(result.path, "backup.fbrenc")).toString("latin1"), /fixture-db|must-not-leave-this-file/);
});

test("the installed backup CLI stays local and emits one machine-readable receipt", () => {
  const { manifestPath } = fixture();
  const run = spawnSync(process.execPath, ["brain.mjs", "backup", manifestPath, "--json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.status, "saved");
  assert.equal(receipt.admin_key_included, false);
  assert.equal(run.stderr, "");
});

test("a mutating ingest command publishes its restore point before later validation fails", () => {
  const { manifestPath, backupRoot, root } = fixture();
  const userRoot = join(root, "isolated-user");
  mkdirSync(userRoot, { mode: 0o700 });
  const run = spawnSync(process.execPath, [
    "--import", new URL("./fixtures/isolate-support-root.mjs", import.meta.url).href,
    "brain.mjs", "ingest", manifestPath, "--path", join(root, "missing-source"),
  ], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      BRAIN_NO_WRANGLER_LOGIN: "1",
      BRAIN_TEST_USER_ROOT: userRoot,
    },
  });
  assert.equal(run.status, 1);
  assert.equal(existsSync(backupRoot), true, `${run.stdout}\n${run.stderr}`);
  const entries = readdirSync(backupRoot);
  assert.equal(entries.length, 1);
  const receipt = JSON.parse(readFileSync(join(backupRoot, entries[0], "receipt.json"), "utf8"));
  assert.equal(receipt.reason, "pre-ingest");
});

test("daily backup scheduler needs no Brain domain or admin key", () => {
  const { manifestPath, root } = fixture();
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const plan = buildBackupSchedulerPlan(manifestPath, {
    platform: "darwin",
    uid: 501,
    home,
    nodePath: process.execPath,
    brainPath: join(process.cwd(), "brain.mjs"),
  });
  assert.equal(plan.cron, "0 3 * * *");
  assert.deepEqual(plan.spec.childArgumentsOf(plan), ["backup", plan.path, "--scheduled"]);
});

test("rewind selection ignores a newer scheduled snapshot and finds the last protected mutation", async () => {
  const { manifestPath } = fixture();
  const mutation = await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-09-24T10:00:00.000Z"),
    reason: "pre-ingest",
    nonce: "1111111111111111",
  });
  await createOwnerBackup(manifestPath, {
    now: () => new Date("2026-09-24T11:00:00.000Z"),
    reason: "scheduled",
    nonce: "2222222222222222",
  });
  const selected = latestOwnerRestorePoint(manifestPath, {
    reasons: ["pre-ingest", "pre-load", "pre-forget", "pre-update"],
  });
  assert.equal(selected.path, mutation.path);
});

test("post-restore state reset reaches only adjacent resumable ingest files", () => {
  const { manifestPath, root } = fixture();
  const unrelated = join(root, "keep-me.json");
  writeFileSync(unrelated, "{}\n");
  const result = resetOwnerIngestState(manifestPath);
  assert.equal(result.reset, 1);
  assert.equal(existsSync(join(root, ".brain-ingest-drive.json")), false);
  assert.equal(existsSync(join(root, ".brain-admin-key")), true);
  assert.equal(existsSync(unrelated), true);
});

test("post-restore state reset refuses an admin-key-shaped candidate non-vacuously", () => {
  const { manifestPath, root } = fixture();
  let inventories = 0;
  assert.throws(() => resetOwnerIngestState(manifestPath, {
    listStateFiles: () => {
      inventories += 1;
      return [join(root, ".brain-admin-key")];
    },
  }), /state-file allowlist/);
  assert.equal(inventories, 1, "the reset allowlist decision point was reached");
  assert.equal(existsSync(join(root, ".brain-admin-key")), true);
});
