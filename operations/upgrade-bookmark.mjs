import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Keep the pre-change restore point even if deployment kills the process.
 * Local storage also covers legacy databases without upgrade_runs. Every
 * attempt gets its own immutable receipt; a retry never replaces the earlier
 * pre-migration bookmark with a snapshot of a partly migrated database.
 */
export function saveUpgradeBookmark(record, {
  directory = join(homedir(), ".brain", "upgrade-bookmarks"),
  now = () => new Date(),
  io = fs,
} = {}) {
  const syncDirectory = (path) => {
    // Node cannot fsync a directory on Windows. The receipt file itself is
    // flushed everywhere; native Windows power-loss durability is a field gate.
    if (process.platform === "win32") return;
    const fd = io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  const ensureDirectory = (path) => {
    try {
      if (!io.lstatSync(path).isDirectory()) throw new Error("unsafe recovery directory");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      ensureDirectory(dirname(path));
      io.mkdirSync(path, { mode: 0o700 });
      syncDirectory(dirname(path));
    }
  };
  for (const value of [record.account_id, record.database_id, record.bookmark, record.from_version, record.to_version]) {
    if (typeof value !== "string" || !value.length || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("invalid recovery bookmark identity");
    }
  }
  const bytes = JSON.stringify({ schema_version: 1, captured_at: now().toISOString(), ...record }) + "\n";
  directory = resolve(directory);
  ensureDirectory(directory);
  if (io.realpathSync.native(directory) !== directory) throw new Error("recovery directory must not use links");
  const directoryStat = io.lstatSync(directory);
  if (process.platform !== "win32" && ((directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid())) {
    throw new Error("recovery directory must be private and owned by this user");
  }
  const path = join(directory, `${randomUUID()}.json`);
  const fd = io.openSync(path, "wx", 0o600);
  // Leave incomplete receipts in place for inspection; never erase recovery
  // evidence when a write, flush, or readback fails.
  try {
    io.writeFileSync(fd, bytes);
    io.fsyncSync(fd);
  } finally { io.closeSync(fd); }
  syncDirectory(directory);
  const readFd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = io.fstatSync(readFd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== Buffer.byteLength(bytes) ||
        io.readFileSync(readFd, "utf8") !== bytes) throw new Error("recovery bookmark did not read back exactly");
  } finally { io.closeSync(readFd); }
  return path;
}
