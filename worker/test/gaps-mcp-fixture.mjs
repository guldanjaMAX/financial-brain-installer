import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

// Execute the actual stdio entrypoint without sockets or a child process.
// Only its ESM import declarations are bound into the VM. Runtime functions,
// retry predicates, renderer and stdio dispatch remain byte-for-byte source.
export async function mcpFixture(t, f, { failFirst = false, failAlways = false } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'gaps-mcp-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const keyFile = join(root, '.brain-admin-key');
  const manifest = join(root, 'synthetic.manifest.json');
  writeFileSync(keyFile, randomUUID(), { mode: 0o600 });
  writeFileSync(manifest, JSON.stringify({ operations: { admin_key_secret: null } }), { mode: 0o600 });
  const moduleUrl = pathToFileURL(join(f.productRoot, 'components/brain-mcp.mjs'));
  const original = readFileSync(moduleUrl, 'utf8');
  const imports = [];
  const source = original.replace(/^#![^\n]*\n/, '').replace(
    /^import\s+([\s\S]*?)\s+from\s+"([^"]+)";/gm,
    (_, bindings, specifier) => { imports.push({ bindings, specifier }); return ''; });
  assert.ok(imports.length >= 10, 'actual entrypoint imports bound');
  const injected = {};
  for (const { bindings, specifier } of imports) {
    assert.match(bindings.trim(), /^\{[\s\S]*\}$/);
    const loaded = await import(specifier.startsWith('.') ? new URL(specifier, moduleUrl).href : specifier);
    for (const name of bindings.replace(/[{}]/g, '').split(',').map(s => s.trim()).filter(Boolean)) {
      const [imported, local = imported] = name.split(/\s+as\s+/);
      injected[local] = loaded[imported];
    }
  }
  let credentialReads = 0, forbiddenCredentials = 0, external = 0, attempts = 0, waits = 0;
  const resolver = injected.createBrainCredentialResolver;
  injected.createBrainCredentialResolver = options => resolver({ ...options,
    adminKeyPersistencePlan: () => ({ fixtureKeyFile: keyFile }),
    readAdminKeyDurably: plan => {
      credentialReads++; assert.equal(plan.fixtureKeyFile, keyFile);
      return readFileSync(keyFile, 'utf8');
    },
  });
  injected.readAdminKeyFromKeychain = () => { forbiddenCredentials++; throw new Error('host credential boundary forbidden'); };
  const timing = injected.createMcpQueryTiming;
  injected.createMcpQueryTiming = options => timing({ ...options, now: f.clock.now });
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  let resolveReply;
  const reply = new Promise(resolve => { resolveReply = resolve; });
  const timers = new Set();
  const context = { ...injected, URL, AbortController, Buffer, TextEncoder,
    process: {
      env: { HOME: root, BRAIN_MANIFEST: manifest, BRAIN_URL: 'https://brain.invalid',
        BRAIN_AGENT_PROFILE: 'technician', BRAIN_NO_WRANGLER_LOGIN: '1' },
      platform: process.platform, stdin,
      stdout: { write(text) { resolveReply(JSON.parse(text)); } },
      stderr: { write() { assert.fail('unexpected MCP startup error'); } },
      exit() { assert.fail('unexpected MCP exit'); },
    },
    // Configuration fallback stays inside the synthetic HOME as well.
    homedir: () => root,
    setTimeout(fn, ms) {
      const token = { cancelled: false }; timers.add(token);
      if (ms === 2000) { waits++; f.clock.operation('mcp_retry_wait', ms, null).then(() => { if (!token.cancelled) fn(); }); }
      else {
        assert.equal(ms, 120000, 'only the production request deadline is otherwise scheduled');
        f.clock.pending.push({ at: f.clock.ms + ms, run: () => { if (!token.cancelled) fn(); } });
      }
      return token;
    },
    clearTimeout(token) { token.cancelled = true; timers.delete(token); },
    async fetch(url, options) {
      if (url !== 'https://brain.invalid/api/rag/unified') { external++; throw new Error('external destination denied'); }
      attempts++;
      const fail = failAlways || (failFirst && attempts === 1);
      f.control.vectorFails = fail;
      f.dbControl.failOn = fail ? /chunks_fts MATCH/ : null;
      return f.dispatch('unified', JSON.parse(options.body).q);
    },
  };
  vm.runInNewContext(source, context, { filename: 'synthetic-mcp-entrypoint.mjs' });
  return { async search() {
    const start = f.clock.ms;
    f.control.delayed = true;
    stdin.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'brain_search', arguments: { query: 'address' } } }) + '\n');
    const response = await f.clock.finish(reply);
    f.control.delayed = false;
    assert.equal(external, 0); assert.equal(forbiddenCredentials, 0);
    assert.ok(credentialReads > 0, 'fixture key-file resolver reached');
    f.noExternal();
    return { response, elapsed: f.clock.ms - start, attempts, waits,
      source_sha256: createHash('sha256').update(original).digest('hex') };
  } };
}
