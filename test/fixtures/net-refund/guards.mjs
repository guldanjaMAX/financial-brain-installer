import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
export const blocked = [];
const reject = capability => () => { blocked.push(capability); throw new Error(`FORBIDDEN_${capability}`); };
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) childProcess[name] = reject('PROCESS_OR_CREDENTIAL');
for (const mod of [http, https]) for (const name of ['request', 'get', 'createServer']) mod[name] = reject('NETWORK');
for (const name of ['connect', 'createConnection', 'createServer']) net[name] = reject('NETWORK');
tls.connect = reject('NETWORK');
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) dns[name] = reject('NETWORK');
globalThis.fetch = reject('NETWORK');
globalThis.WebSocket = class { constructor() { reject('NETWORK')(); } };
syncBuiltinESMExports();

const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : ['2026-10-12T12:00:00.000Z'])); }
  static now() { return NativeDate.parse('2026-10-12T12:00:00.000Z'); }
};
