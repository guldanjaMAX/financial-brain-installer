import fs from "node:fs";
import { saveUpgradeBookmark } from "../../operations/upgrade-bookmark.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const step = process.argv[2];
const hang = () => {
  fs.writeSync(1, "REACHED\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const io = { ...fs,
  openSync(...args) { if (step === "open") hang(); return fs.openSync(...args); },
  fsyncSync(fd) {
    if (step === (fs.fstatSync(fd).isDirectory() ? "directory-flush" : "file-flush")) hang();
    return fs.fsyncSync(fd);
  },
  readFileSync(...args) { if (step === "readback") hang(); return fs.readFileSync(...args); },
};
saveUpgradeBookmark(request.record, {
  directory: request.directory, now: () => new Date(request.capturedAt), io,
  platform: step === "acl" ? "win32" : process.platform,
  windowsAcl: step === "acl" ? hang : () => {}, macAcl: () => {},
});
