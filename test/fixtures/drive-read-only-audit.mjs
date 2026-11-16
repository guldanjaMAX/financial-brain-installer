// Synthetic CLI preload: count every transport decision without retaining URLs
// or payloads. A refused command must reach its guard before even a read.
import { writeFileSync } from 'node:fs';
const path = process.env.BRAIN_DRIVE_READ_ONLY_AUDIT;
if (!path) throw new Error('read-only audit path required');
const calls = { reads: 0, writes: 0 };
const save = () => writeFileSync(path, JSON.stringify(calls));
let transport;
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  set(value) { transport = value; },
  get() { const target = transport; return async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const mutation = url.hostname === 'fixture.invalid' &&
      !['/api/admin/brain/source-families', '/api/admin/brain/documents',
        '/api/admin/brain/ingest-part-proof', '/api/admin/brain/ingest-capabilities'].includes(url.pathname);
    calls[mutation ? 'writes' : 'reads']++;
    save();
    if (!target) throw new Error('offline fixture transport missing');
    return target(input, options);
  }; },
});
save();
const NativeDate = Date;
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : ['2026-11-01T12:00:00Z'])); }
  static now() { return NativeDate.parse('2026-11-01T12:00:00Z'); }
};
