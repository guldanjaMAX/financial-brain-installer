import { Readable } from 'node:stream';
const endpoints = new Map();
let sequence = 0;
export const fixtureFetchHook = new URL('./mcp-fetch-hook.mjs', import.meta.url).href;
export const hasFixtureTransport = url => endpoints.has(url);
export function fixtureTransport(handler) {
  const url = `https://synthetic-${++sequence}.invalid`;
  endpoints.set(url, handler);
  return { url, close: async () => { endpoints.delete(url); } };
}
export function connectFixtureTransport(child, expectedUrl) {
  child.on('message', async message => {
    if (message?.kind !== 'fixture-fetch') return;
    try {
      const url = new URL(message.url);
      const handler = endpoints.get(expectedUrl);
      if (url.origin !== expectedUrl || !handler) throw new Error('Network forbidden: unregistered fixture target');
      const req = Readable.from(message.body ? [Buffer.from(message.body)] : []);
      Object.assign(req, { method: message.method, headers: message.headers, url: url.pathname + url.search });
      let status = 200, headers = {};
      const res = {
        writeHead(value, fields) { status = value; headers = fields; },
        end(body) { child.send({ kind: 'fixture-fetch-result', id: message.id, status, headers, body: String(body ?? '') }); },
      };
      await handler(req, res);
    } catch (error) {
      child.send({ kind: 'fixture-fetch-result', id: message.id, error: error.message });
    }
  });
}
