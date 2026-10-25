import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";

export const STAGING_MTIME_SECONDS = 2 * Math.floor(Date.now() / 2000) - 2;

// Whole even seconds round-trip through NTFS and POSIX timestamps exactly.
// Pin only exclusive-create descriptors, never the proof's read-only descriptor.
export function pinStagingMtime(root, time = STAGING_MTIME_SECONDS) {
  const native = {
    open: fs.openSync, fstat: fs.fstatSync, close: fs.closeSync, futimes: fs.futimesSync,
  };
  const descriptors = new Set();
  const createdPaths = new Map();
  const withinRoot = path => {
    if (typeof path !== "string") return false;
    const suffix = relative(resolve(root), resolve(path));
    return suffix !== ".." && !suffix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(suffix);
  };
  const pin = descriptor => {
    if (!descriptors.has(descriptor)) return;
    if (native.fstat(descriptor).mtimeMs !== time * 1000) native.futimes(descriptor, time, time);
  };
  fs.openSync = (path, flags, ...args) => {
    const descriptor = native.open(path, flags, ...args);
    const exclusive = typeof flags === "string" ? flags.includes("x")
      : (flags & fs.constants.O_CREAT) !== 0 && (flags & fs.constants.O_EXCL) !== 0;
    const writable = typeof flags === "string" ? /[wa+]/.test(flags)
      : (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0;
    if (withinRoot(path)) {
      const key = resolve(path);
      if (exclusive) createdPaths.set(key, native.fstat(descriptor, { bigint: true }));
      const created = createdPaths.get(key);
      if (writable && created) {
        const current = native.fstat(descriptor, { bigint: true });
        if (current.dev === created.dev && current.ino === created.ino) descriptors.add(descriptor);
      }
    }
    return descriptor;
  };
  fs.fstatSync = (descriptor, ...args) => {
    pin(descriptor);
    return native.fstat(descriptor, ...args);
  };
  fs.closeSync = descriptor => {
    try { pin(descriptor); }
    finally { descriptors.delete(descriptor); native.close(descriptor); }
  };
  syncBuiltinESMExports();
  return () => {
    fs.openSync = native.open;
    fs.fstatSync = native.fstat;
    fs.closeSync = native.close;
    syncBuiltinESMExports();
  };
}

export function rewriteStagingInPlace(path, time = STAGING_MTIME_SECONDS) {
  const before = fs.lstatSync(path, { bigint: true });
  const original = fs.readFileSync(path);
  assert.ok(original.length > 0, "the staged rewrite fixture needs nonempty bytes");
  const bytes = original.map(byte => byte ^ 0xff);
  const descriptor = fs.openSync(path, "r+");
  try {
    let written = 0;
    while (written < bytes.length) {
      const count = fs.writeSync(descriptor, bytes, written, bytes.length - written, written);
      assert.ok(count > 0, "the staged rewrite must make progress");
      written += count;
    }
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  fs.utimesSync(path, time, time);
  const after = fs.lstatSync(path, { bigint: true });
  for (const key of ["dev", "ino", "nlink", "size", "mtimeNs", "mode"]) {
    assert.equal(after[key], before[key], `rewrite must be invisible to the round 2 metadata snapshot (${key})`);
  }
  return { bytes, before, after };
}

export function assertStagingSurvives(path, expected, bytes) {
  const actual = fs.lstatSync(path, { bigint: true });
  assert.equal(actual.dev, expected.dev, "the replacement device must survive cleanup");
  assert.equal(actual.ino, expected.ino, "the replacement inode must survive cleanup");
  assert.deepEqual(fs.readFileSync(path), bytes, "the replacement bytes must survive cleanup");
}
