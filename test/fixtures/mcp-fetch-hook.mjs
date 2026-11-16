// Test-only fetch over the existing parent/child pipe. No listening socket or
// host credential source is involved, and every target is checked by the parent.
let sequence = 0;
const pending = new Map();
process.on('message', message => {
  if (message?.kind !== 'fixture-fetch-result') return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (!pending.size) process.channel?.unref();
  if (message.error) request.reject(new Error(message.error));
  else request.resolve(new Response(message.body, { status: message.status, headers: message.headers }));
});
process.channel?.unref();
globalThis.fetch = (input, init = {}) => new Promise((resolve, reject) => {
  if (init.signal?.aborted) return reject(init.signal.reason);
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  process.channel?.ref();
  process.send({ kind: 'fixture-fetch', id, url: String(input), method: init.method ?? 'GET',
    headers: Object.fromEntries(new Headers(init.headers)), body: init.body ?? '' });
});
