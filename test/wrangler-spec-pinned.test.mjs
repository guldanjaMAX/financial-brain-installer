import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WRANGLER_SPEC, refreshWranglerSession } from '../operations/wrangler-oauth.mjs';
import { CLOUDFLARE_OAUTH_WRANGLER_PACKAGE } from '../operations/cloudflare-oauth-session.mjs';
import { WRANGLER_PACKAGE } from '../doctor.mjs';
assert.equal(WRANGLER_SPEC, 'wrangler@4.73.0', 'the legacy TOML reader keeps its compatible reviewed pin');
assert.match(CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, /^wrangler@4\.\d+\.\d+$/);
assert.equal(WRANGLER_PACKAGE, CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, 'doctor and named-profile control must agree');
let called;
assert.equal(refreshWranglerSession({ env: { HOME: '/synthetic-home', CLOUDFLARE_API_TOKEN: 'synthetic-env-value', UNRELATED_DESKTOP_VALUE: 'private' },
  run: (command, args, options) => { called = { command, args, env: options.env }; return { status: 0 }; } }), true);
assert.deepEqual(called.args, [WRANGLER_SPEC, 'whoami']);
assert.equal(called.env.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(called.env.UNRELATED_DESKTOP_VALUE, undefined);
const root = fileURLToPath(new URL('../', import.meta.url));
// Guides are executable too: a client runs what the guide says. An unpinned
// `npx wrangler@4 login` in onboarding is how an install ends up on a wrangler
// that writes an encrypted session the installer cannot read, which is the
// documented cause of a real field failure. CHANGELOG.md is deliberately out of
// scope: its entries record what past releases said and must not be rewritten.
const guideDirs = ['onboarding', 'docs'];
const guides = guideDirs.flatMap((dir) => {
  try {
    return readdirSync(join(root, dir)).filter((x) => x.endsWith('.md')).map((x) => `${dir}/${x}`);
  } catch { return []; }
});
const files = ['brain.mjs', 'doctor.mjs', ...readdirSync(join(root, 'operations')).filter((x) => x.endsWith('.mjs')).map((x) => `operations/${x}`), ...guides];
for (const path of files) {
  const source = readFileSync(join(root, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  assert.ok(!/wrangler@4(?![.\d])/.test(source), `${path} has an unpinned Wrangler operation or advice`);
}
console.log('Wrangler pins: current named-profile custody and legacy TOML compatibility are explicit and bounded');
