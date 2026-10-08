import assert from "node:assert/strict";
import { realpathSync, writeSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { restrictWindowsDirectoryToCurrentUser as restrict } from "../../operations/current-user-file.mjs";

export function restrictWindowsDirectoryToCurrentUser(path, options = {}) {
  const home = process.env.BRAIN_TEST_USER_ROOT;
  assert.ok(home, "lifecycle lock ACL fixture needs a scratch user root");
  // Compare physical paths so Windows short and long temp-directory aliases
  // select the same fixture, without widening the permitted directory.
  const root = realpathSync(home);
  const target = realpathSync(path);
  const suffix = relative(root, target);
  assert.ok(suffix && !isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`),
    "lifecycle lock ACL fixture refused a path outside its scratch user root");
  return restrict(path, {
    ...options,
    username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows" },
    runAcl(_command, args) {
      assert.equal(args[0], path);
      assert.deepEqual(args.slice(1), ["/inheritance:r", "/grant:r", "fixture-user:(OI)(CI)F"]);
      writeSync(1, "TEST_LIFECYCLE_ACL_REACHED\n");
      return { status: 0 };
    },
  });
}
