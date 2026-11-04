/** Directory-relative reader. Its isolated process never changes its cwd. */
import fs from "node:fs";
import { basename, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export const GRANOLA_EXPORT_MAX_BYTES = 512 * 1024;
export const GRANOLA_EXPORT_READER_PATH = fileURLToPath(import.meta.url);
const identity = (stat, expected) => stat.dev === expected.dev && stat.ino === expected.ino;
const privateRoot = (stat, expected) => stat.isDirectory() && !stat.isSymbolicLink() && identity(stat, expected) &&
  (process.platform === "win32" || ((stat.mode & 0o077) === 0 && stat.uid === expected.uid));

export function readGranolaExportAtCwd({ member, root, entry } = {}) {
  let fd;
  try {
    if (typeof member !== "string" || isAbsolute(member) || basename(member) !== member || !member.endsWith(".json") ||
        !root || !entry || !privateRoot(fs.lstatSync("."), root)) throw new Error();
    // Relative syscalls resolve against the kernel-held cwd, even if an
    // ancestor or the original root path is renamed during the read.
    const selected = fs.lstatSync(member);
    if (!selected.isFile() || selected.isSymbolicLink() || !identity(selected, entry)) throw new Error();
    fd = fs.openSync(member, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || !identity(before, selected) || before.size > GRANOLA_EXPORT_MAX_BYTES) throw new Error();
    const bytes = Buffer.alloc(GRANOLA_EXPORT_MAX_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = fs.readSync(fd, bytes, size, bytes.length - size, null);
      if (!read) break;
      size += read;
    }
    const after = fs.fstatSync(fd);
    if (size > GRANOLA_EXPORT_MAX_BYTES || before.size !== size || after.size !== size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        !privateRoot(fs.lstatSync("."), root)) throw new Error();
    return bytes.subarray(0, size);
  } catch {
    throw new Error("GRANOLA_FILE_UNSAFE");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

if (process.argv[1] === GRANOLA_EXPORT_READER_PATH) {
  // Source bytes use private pipes, never argv, environment, logs or files.
  let input = Buffer.alloc(0), refused = false;
  process.stdin.on("data", chunk => {
    if (input.length + chunk.length > 16_384) refused = true;
    if (!refused) input = Buffer.concat([input, chunk]);
  });
  process.stdin.on("end", () => {
    try {
      if (refused) throw new Error();
      process.stdout.write(readGranolaExportAtCwd(JSON.parse(input.toString("utf8"))));
    } catch { process.exitCode = 1; }
  });
}
