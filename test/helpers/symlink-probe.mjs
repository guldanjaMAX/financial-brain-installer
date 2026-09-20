import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SYMLINK_SKIP_REASON = "host cannot create file symlinks (SeCreateSymbolicLinkPrivilege)";
const SKIP_MESSAGE = `${SYMLINK_SKIP_REASON}; assertions did not run`;
let cachedResult;

export function probeFileSymlinkSupport() {
  if (cachedResult) return cachedResult;
  const directory = mkdtempSync(join(tmpdir(), "brain-symlink-probe-"));
  try {
    const target = join(directory, "target.txt");
    writeFileSync(target, "probe\n");
    try {
      symlinkSync(target, join(directory, "link.txt"));
      cachedResult = Object.freeze({ ok: true });
    } catch (error) {
      if (error?.code !== "EPERM" || error?.syscall !== "symlink") throw error;
      cachedResult = Object.freeze({ ok: false, reason: SYMLINK_SKIP_REASON });
    }
    return cachedResult;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function skipSymlinkTest(t) {
  const probe = probeFileSymlinkSupport();
  if (probe.ok) return false;
  t.skip(SKIP_MESSAGE);
  return true;
}

export function printSymlinkSkip(name) {
  const probe = probeFileSymlinkSupport();
  if (probe.ok) return false;
  console.log(`SKIP  ${name}  ${SKIP_MESSAGE}`);
  return true;
}
