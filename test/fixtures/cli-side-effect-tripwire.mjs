// Test-child preload only. Exit at the boundary: product error handling must
// never turn an unexpected host action into an apparently passing refusal.
import childProcess from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import dns from "node:dns";
import dgram from "node:dgram";
import { writeSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";

function blocked(boundary) {
  // Never include command arguments, hostnames, paths, or credential values.
  writeSync(2, `TEST_SIDE_EFFECT_BLOCKED:${boundary}\n`);
  process.exit(86);
}
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = () => blocked(`child_process.${name}`);
}
childProcess.ChildProcess.prototype.spawn = () => blocked("ChildProcess.spawn");
globalThis.fetch = () => blocked("fetch");
for (const [module, names, label] of [
  [net, ["connect", "createConnection"], "net"],
  [tls, ["connect"], "tls"],
  [http, ["request", "get"], "http"],
  [https, ["request", "get"], "https"],
  [http2, ["connect"], "http2"],
]) {
  for (const name of names) module[name] = () => blocked(`${label}.${name}`);
}
net.Socket.prototype.connect = () => blocked("Socket.connect");
for (const name of ["connect", "send"]) dgram.Socket.prototype[name] = () => blocked(`dgram.${name}`);
for (const target of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
  for (const name of Object.getOwnPropertyNames(target)) {
    if (/^(lookup|resolve|reverse)/.test(name) && typeof target[name] === "function") {
      target[name] = () => blocked("dns");
    }
  }
}
syncBuiltinESMExports();
