/** Bounded SQL units from the reviewed data-only D1 dump, never byte slices. */
import { createReadStream, fstatSync, lstatSync, openSync, closeSync, constants,
  mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

function fail() { throw new Error("RECOVERY_MULTIPART_SQL_DUMP_INVALID"); }
const identity = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

// Dump data contains INSERT/PRAGMA statements, never schema triggers. Track
// quotes and comments across stream blocks so embedded newlines/semicolons
// cannot become import boundaries. Migrations are separate atomic units.
export async function* recoveryDataStatements(path, maxUnitBytes) {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
      (process.platform !== "win32" && (before.mode & 0o077)) ||
      (typeof process.getuid === "function" && before.uid !== process.getuid())) fail();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let segments = [], length = 0, quote = 0, lineComment = false, blockComment = false, pending = null;
  try {
    if (!identity(before, fstatSync(fd))) fail();
    const input = createReadStream("", { fd, autoClose: false, highWaterMark: 64 * 1024 });
    // Retain a one-byte lookahead at block edges, including doubled quotes.
    async function* blocks() { yield* input; yield Buffer.from("\n"); }
    for await (let block of blocks()) {
      if (pending !== null) block = Buffer.concat([Buffer.from([pending]), block]);
      pending = block.at(-1);
      let start = 0;
      let i = 0;
      for (; i < block.length - 1; i++) {
        const c = block[i], next = block[i + 1];
        if (lineComment) { if (c === 10) lineComment = false; continue; }
        if (blockComment) { if (c === 42 && next === 47) { blockComment = false; i++; } continue; }
        if (quote) {
          if (c === quote) { if (next === quote) i++; else quote = 0; }
          continue;
        }
        if (c === 45 && next === 45) { lineComment = true; i++; continue; }
        if (c === 47 && next === 42) { blockComment = true; i++; continue; }
        if ([39, 34, 96].includes(c)) { quote = c; continue; }
        if (c !== 59) continue;
        const slice = block.subarray(start, i + 1);
        length += slice.length;
        if (length > maxUnitBytes) fail();
        segments.push(slice);
        yield Buffer.concat(segments, length);
        segments = []; length = 0; start = i + 1;
      }
      // A consumed lookahead (escaped quote or comment delimiter) must not be
      // scanned again in the next block.
      const boundary = Math.min(i, block.length);
      if (boundary === block.length) pending = null;
      if (start < boundary) {
        const slice = block.subarray(start, boundary);
        segments.push(slice); length += slice.length;
      }
      if (length > maxUnitBytes) fail();
    }
    if (pending !== null) { segments.push(Buffer.from([pending])); length++; }
    const tail = Buffer.concat(segments, length);
    if (quote || blockComment || tail.toString("utf8").replace(/--[^\n]*(?:\n|$)/g, "").trim()) fail();
    if (tail.length) yield tail;
    if (!identity(before, fstatSync(fd)) || !identity(before, lstatSync(path))) fail();
  } finally { closeSync(fd); }
}

export function recoveryInsertCoverage(sql, counts, tables) {
  const text = sql.toString("utf8").replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*|\s+$/g, "");
  if (!text || /^PRAGMA\s+defer_foreign_keys\s*=\s*(?:TRUE|ON|1)\s*;$/i.test(text)) return [];
  const match = text.match(/^INSERT\s+INTO\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|`([A-Za-z_][A-Za-z0-9_]*)`|([A-Za-z_][A-Za-z0-9_]*))\s*(?:\([^;]*?\)\s*)?VALUES\s*\(/i);
  const table = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!table || !tables.includes(table)) fail();
  // Count VALUES tuples outside strings, including escaped quotes. Expressions
  // may contain nested parentheses. SELECT/upsert/transaction dumps fail closed.
  let quote = null, depth = 0, rows = 0;
  const values = text.slice(match[0].length - 1);
  for (let i = 0; i < values.length; i++) {
    const c = values[i];
    if (quote) { if (c === quote) { if (values[i + 1] === quote) i++; else quote = null; } continue; }
    if (["'", '"', "`"].includes(c)) { quote = c; continue; }
    if (c === "(") { if (depth++ === 0) rows++; }
    else if (c === ")") { if (--depth < 0) fail(); }
    else if (depth === 0 && !/[\s,;]/.test(c)) fail();
  }
  if (quote || depth || !rows) fail();
  const first = (counts.get(table) ?? 0) + 1;
  counts.set(table, first + rows - 1);
  return [{ table, first_row: first, last_row: first + rows - 1 }];
}

/** A disk-backed verifier with a fresh SQLite connection for every import. */
export async function verifyRecoverySqlParts({ consumeParts, inspectDatabase, temporaryDirectory }) {
  if (typeof consumeParts !== "function" || typeof inspectDatabase !== "function" ||
      typeof temporaryDirectory !== "string") fail();
  const { DatabaseSync } = await import("node:sqlite");
  const directory = mkdtempSync(join(temporaryDirectory, ".brain-recovery-runtime-local-"));
  const path = join(directory, "verification.sqlite");
  closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600));
  let imported = 0;
  try {
    await consumeParts(async (part) => {
      const before = lstatSync(part);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 ||
          before.size < 1 || before.size > 256 * 1024 ** 2) fail();
      const bytes = readFileSync(part);
      let database;
      try {
        if (!identity(before, lstatSync(part)) || bytes.length !== before.size) fail();
        database = new DatabaseSync(path);
        database.exec(bytes.toString("utf8"));
        imported++;
      } finally { database?.close(); bytes.fill(0); }
    });
    if (!imported) fail();
    const database = new DatabaseSync(path);
    try { return inspectDatabase(database); } finally { database.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
