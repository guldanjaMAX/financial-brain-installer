import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const refuse = () => { throw new Error("FORBIDDEN uninjected network or native process boundary"); };
globalThis.fetch = refuse;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = refuse;
net.Socket.prototype.connect = refuse;
for (const method of ["exec", "execSync", "execFile", "execFileSync", "spawnSync", "fork"]) childProcess[method] = refuse;
const spawn = childProcess.spawn;
const localChildren = new Set([
  fileURLToPath(new URL("./update-faults-child.mjs", import.meta.url)),
  fileURLToPath(new URL("../operations/upgrade-bookmark-child.mjs", import.meta.url)),
]);
childProcess.spawn = (command, args, options) => {
  if (command !== process.execPath || !localChildren.has(args[0])) refuse();
  return spawn(command, args, options);
};
syncBuiltinESMExports();
