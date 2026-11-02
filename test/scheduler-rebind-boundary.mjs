import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

export const boundaryCalls = [];
const blocked = kind => () => {
  boundaryCalls.push(kind);
  throw new Error('offline boundary reached');
};
for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[key] = blocked('subprocess');
}
for (const service of [http, https]) for (const key of ['get', 'request']) service[key] = blocked('http');
for (const key of ['connect', 'createConnection']) net[key] = blocked('socket');
net.Socket.prototype.connect = blocked('socket');
tls.connect = blocked('tls');
dgram.createSocket = blocked('datagram');
dns.lookup = blocked('dns');
dns.resolve = blocked('dns');
globalThis.fetch = blocked('fetch');
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2026-01-01T12:00:00Z'])); }
  static now() { return RealDate.parse('2026-01-01T12:00:00Z'); }
};
syncBuiltinESMExports();
