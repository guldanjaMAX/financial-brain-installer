import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

const spawn = childProcess.spawnSync;
childProcess.spawnSync = (command, args = [], ...options) => {
  if (command === process.execPath) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] !== "--import") continue;
      process.stderr.write("IMPORT_ARGUMENT_REACHED\n");
      assert.match(args[++i], /^file:/u, "filesystem --import arguments must be file: URLs");
      process.stderr.write("IMPORT_FILE_URL_REACHED\n");
    }
  }
  return spawn(command, args, ...options);
};
syncBuiltinESMExports();
