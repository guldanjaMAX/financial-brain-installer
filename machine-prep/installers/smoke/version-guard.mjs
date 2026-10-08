import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";

const refuse = () => { throw new Error("BOOTSTRAP_VERSION_NETWORK_REFUSED=1"); };
for (const api of [http, https]) { api.request = refuse; api.get = refuse; }
net.connect = refuse;
net.createConnection = refuse;
net.Socket.prototype.connect = refuse;
tls.connect = refuse;
dgram.createSocket = refuse;
dns.lookup = refuse;
dns.resolve = refuse;
globalThis.fetch = refuse;
globalThis.WebSocket = refuse;
syncBuiltinESMExports();
