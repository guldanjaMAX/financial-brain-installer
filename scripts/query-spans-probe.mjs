#!/usr/bin/env node
// Operator-invoked read-only query probe. Never run automatically at install,
// update or test time. The existing query routes may record ordinary usage.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { projectQueryTiming } from '../worker/src/lib/query-timing.js';

export const QUERY_SPAN_CASES = Object.freeze([
  Object.freeze({ id: 'fact', q: 'What is the release threshold for the synthetic test project?' }),
  Object.freeze({ id: 'event', q: 'When is the next synthetic planning session?' }),
  Object.freeze({ id: 'decision', q: 'What decision was recorded for the synthetic deployment plan?' }),
]);
const MAX_RESPONSE_BYTES = 1_048_576;

function targetOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid_target');
  }
  return url.origin;
}

async function readResponse(response) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('response_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { body: JSON.parse(text), bytes };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runQuerySpansProbe({ url, adminKeyFile }, {
  fetchImpl = globalThis.fetch, readKeyFile = path => readFile(path, 'utf8'),
  now = () => performance.now(),
} = {}) {
  let origin;
  try { origin = targetOrigin(url); } catch { return { version: 1, ok: false, error: 'invalid_target', samples: [] }; }
  if (typeof adminKeyFile !== 'string' || !adminKeyFile) {
    return { version: 1, ok: false, error: 'key_file_required', samples: [] };
  }
  let key;
  try {
    key = (await readKeyFile(adminKeyFile)).trim();
    if (key.length < 16 || key.length > 4096 || /\s/.test(key)) throw new Error('invalid_key_file');
  } catch { return { version: 1, ok: false, error: 'key_file_unavailable', samples: [] }; }
  const samples = [];
  for (const entry of QUERY_SPAN_CASES) {
    for (const route of ['think', 'unified']) {
      const sample = { case: entry.id, route };
      const start = now();
      try {
        const response = await fetchImpl(`${origin}/api/rag/${route}`, {
          method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key },
          body: JSON.stringify({ q: entry.q }),
          signal: AbortSignal.timeout(130_000),
        });
        sample.http_status = response.status;
        const { body, bytes } = await readResponse(response);
        sample.response_bytes = bytes;
        const timing = projectQueryTiming(body.timing);
        if (timing && timing.route === route) sample.timing = timing;
        else sample.error = 'timing_missing_or_invalid';
      } catch { sample.error = 'request_or_response_failed'; }
      sample.client_ms = Math.round(Math.max(0, now() - start) * 1000) / 1000;
      samples.push(sample);
      // A failed endpoint is a finding, not permission to retry or change paths.
      if (sample.error || sample.http_status !== 200) {
        return { version: 1, ok: false, samples };
      }
    }
  }
  return { version: 1, ok: true, samples };
}

export function parseQuerySpansArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i] === '--url' ? 'url' : args[i] === '--admin-key-file' ? 'adminKeyFile' : null;
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('invalid_arguments');
    options[key] = args[++i];
  }
  if (!options.url || !options.adminKeyFile) throw new Error('invalid_arguments');
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.slice(2).length === 1 && process.argv[2] === '--help') {
    console.log('Usage: node scripts/query-spans-probe.mjs --url https://brain.example.invalid --admin-key-file /private/path/admin-key');
  } else {
    let result;
    try { result = await runQuerySpansProbe(parseQuerySpansArgs(process.argv.slice(2))); }
    catch { result = { version: 1, ok: false, error: 'invalid_arguments', samples: [] }; }
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  }
}
