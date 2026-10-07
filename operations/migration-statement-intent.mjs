import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function syncDirectory(path) {
  // Windows does not expose directory fsync through Node. File contents are
  // flushed on both platforms; native power-loss durability remains a field gate.
  if (process.platform === "win32") return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(path) {
  try {
    if (!lstatSync(path).isDirectory()) throw new Error("migration intent directory is unsafe");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    ensureDirectory(dirname(path));
    try { mkdirSync(path, { mode: 0o700 }); } catch (mkdirError) {
      if (mkdirError.code !== "EEXIST") throw mkdirError;
      if (!lstatSync(path).isDirectory()) throw new Error("migration intent directory is unsafe");
    }
    syncDirectory(dirname(path));
  }
}

/** Durable, content-free write-ahead proof for independently committed ALTERs.
 * The exclusive file is also the dispatch claim: a second invocation can only
 * inspect. Even an empty/torn file blocks dispatch, never authorizes a retry.
 */
export function createMigrationStatementIntentStore({
  accountId, databaseId, migrationChecksum,
  directory = join(homedir(), ".brain", "migration-intents"),
}) {
  for (const value of [accountId, databaseId, migrationChecksum]) {
    if (typeof value !== "string" || !value.length || value !== value.trim()) {
      throw new Error("migration intent requires an exact database identity and checksum");
    }
  }
  const databaseDigest = digest(JSON.stringify([accountId, databaseId]));
  const recordFor = (statement) => ({
    version: 1, databaseDigest, migrationChecksum, statementDigest: digest(statement),
  });
  const pathFor = (statement) => join(directory, `${digest(JSON.stringify(recordFor(statement)))}.json`);
  const read = (statement) => {
    let fd;
    try {
      fd = openSync(pathFor(statement), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new Error("unsafe intent");
      if (readFileSync(fd, "utf8") !== JSON.stringify(recordFor(statement)) + "\n") throw new Error("invalid intent");
      return true;
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw new Error("Migration intent cannot be verified. Keep it in place and request installer review; no database change was sent.");
    } finally { if (fd !== undefined) closeSync(fd); }
  };
  return {
    has: read,
    claim(statement) {
      ensureDirectory(directory);
      let fd;
      try {
        fd = openSync(pathFor(statement), "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        read(statement);
        return false;
      }
      // Never remove an incomplete claim on error: a restart must fail closed.
      try {
        writeFileSync(fd, JSON.stringify(recordFor(statement)) + "\n");
        fsyncSync(fd);
      } finally { closeSync(fd); }
      syncDirectory(directory);
      return true;
    },
    clear(statement) {
      if (!read(statement)) return;
      unlinkSync(pathFor(statement));
      syncDirectory(directory);
    },
  };
}
