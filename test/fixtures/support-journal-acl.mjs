import assert from "node:assert/strict";
import { realpathSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { restrictWindowsFileToCurrentUser as restrict } from "../../operations/current-user-file.mjs";

export function restrictWindowsFileToCurrentUser(path, options = {}) {
  const home = process.env.BRAIN_TEST_USER_ROOT;
  assert.ok(home, "support ACL fixture needs a scratch user root");
  // Compare physical paths so Windows short and long temp-directory aliases
  // select the same fixture, without widening the permitted directory.
  const root = realpathSync(join(home, ".brain"));
  const target = realpathSync(path);
  const suffix = relative(root, target);
  assert.ok(!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`),
    "support ACL fixture refused a path outside its scratch runtime");
  return restrict(path, {
    ...options,
    username: "fixture-user",
    environment: { SystemRoot: "C:\\Windows" },
    runAcl(_command, args) {
      assert.equal(args[0], path);
      assert.deepEqual(args.slice(1), ["/inheritance:r", "/grant:r", "fixture-user:F"]);
      writeSync(1, "TEST_SUPPORT_ACL_REACHED\n");
      return { status: process.env.BRAIN_TEST_SUPPORT_ACL_FAIL === "1" ? 1 : 0 };
    },
  });
}
