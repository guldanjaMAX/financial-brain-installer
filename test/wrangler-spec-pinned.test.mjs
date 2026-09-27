import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WRANGLER_SPEC, legacyWranglerLoginCommand, refreshWranglerSession } from '../operations/wrangler-oauth.mjs';
import { CLOUDFLARE_OAUTH_WRANGLER_PACKAGE } from '../operations/cloudflare-oauth-session.mjs';
import { LOCKED_WRANGLER_VERSION } from '../operations/locked-wrangler-runtime.mjs';
import {
  MINIMUM_REVIEWED_SHARP_VERSION,
  REVIEWED_WRANGLER_SPEC,
  REVIEWED_WRANGLER_VERSION,
} from '../operations/wrangler-runtime-contract.mjs';
import { WRANGLER_PACKAGE } from '../doctor.mjs';
assert.match(REVIEWED_WRANGLER_SPEC, /^wrangler@4\.\d+\.\d+$/);
assert.equal(CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, REVIEWED_WRANGLER_SPEC,
  'named-profile control must use the reviewed runtime contract');
assert.equal(WRANGLER_PACKAGE, REVIEWED_WRANGLER_SPEC,
  'doctor must use the reviewed runtime contract');
assert.equal(WRANGLER_SPEC, REVIEWED_WRANGLER_SPEC,
  'legacy TOML refresh must use the same patched reviewed runtime as named-profile control');
assert.equal(LOCKED_WRANGLER_VERSION, REVIEWED_WRANGLER_VERSION,
  'the locked recovery runtime must use the same patched reviewed runtime');

const root = fileURLToPath(new URL('../', import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const reviewedVersion = REVIEWED_WRANGLER_VERSION;
assert.equal(packageJson.devDependencies?.wrangler, reviewedVersion,
  'package metadata must install the reviewed Wrangler version');
assert.equal(packageLock.packages?.['']?.devDependencies?.wrangler, reviewedVersion,
  'the lock root must select the reviewed Wrangler version');
assert.equal(packageLock.packages?.['node_modules/wrangler']?.version, reviewedVersion,
  'the lock must contain the exact reviewed Wrangler package');
assert.equal(
  packageLock.packages?.['node_modules/wrangler']?.resolved,
  `https://registry.npmjs.org/wrangler/-/wrangler-${reviewedVersion}.tgz`,
  'the lock must resolve the exact reviewed Wrangler archive',
);
assert.match(packageLock.packages?.['node_modules/wrangler']?.integrity || '', /^sha512-/,
  'the exact reviewed Wrangler archive must carry lock integrity');

const miniflare = packageLock.packages?.['node_modules/miniflare'];
const sharp = packageLock.packages?.['node_modules/sharp'];
assert.ok(miniflare && sharp, 'the reviewed Wrangler lock closure must include Miniflare and Sharp');
assert.equal(miniflare.dependencies?.sharp, sharp.version,
  'the reviewed Wrangler lock closure must resolve the declared Sharp version exactly');
const exactVersion = (value) => {
  const parts = String(value).split('.').map(Number);
  assert.ok(parts.length === 3 && parts.every(Number.isInteger),
    `reviewed dependency versions must be exact three-part versions, found ${value}`);
  return parts;
};
const compareVersions = (left, right) => {
  const leftParts = exactVersion(left);
  const rightParts = exactVersion(right);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
};
assert.ok(compareVersions(sharp.version, MINIMUM_REVIEWED_SHARP_VERSION) >= 0,
  `every reviewed Wrangler runtime must resolve Sharp ${MINIMUM_REVIEWED_SHARP_VERSION} or newer, found ${sharp.version}`);
let called;
assert.equal(refreshWranglerSession({ env: { HOME: '/synthetic-home', CLOUDFLARE_API_TOKEN: 'synthetic-env-value', UNRELATED_DESKTOP_VALUE: 'private' },
  run: (command, args, options) => { called = { command, args, env: options.env }; return { status: 0 }; } }), true);
assert.deepEqual(called.args, [WRANGLER_SPEC, 'whoami']);
assert.equal(called.env.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(called.env.UNRELATED_DESKTOP_VALUE, undefined);
// The legacy sign-in advice must write the plaintext session the legacy reader
// parses, so it carries the same keyring opt-out as the refresh child, in a
// form each platform's copy shell accepts. PowerShell rejects `NAME=value cmd`.
assert.equal(called.env.CLOUDFLARE_AUTH_USE_KEYRING, 'false');
assert.equal(legacyWranglerLoginCommand({ platformName: 'linux' }),
  `CLOUDFLARE_AUTH_USE_KEYRING='false' npx ${REVIEWED_WRANGLER_SPEC} login`);
assert.equal(legacyWranglerLoginCommand({ platformName: 'darwin' }),
  `CLOUDFLARE_AUTH_USE_KEYRING='false' npx ${REVIEWED_WRANGLER_SPEC} login`);
assert.equal(legacyWranglerLoginCommand({ platformName: 'win32' }),
  `$env:CLOUDFLARE_AUTH_USE_KEYRING='false'; npx ${REVIEWED_WRANGLER_SPEC} login`);
// `--no-use-keyring` would persist a global preference and silently disable
// the named-profile flow's encrypted storage, so the advice must never use it.
for (const platformName of ['linux', 'darwin', 'win32']) {
  assert.doesNotMatch(legacyWranglerLoginCommand({ platformName }), /use-keyring/);
}
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
  for (const match of source.matchAll(/npx (wrangler@\d+\.\d+\.\d+)/g)) {
    assert.equal(match[1], REVIEWED_WRANGLER_SPEC,
      `${path} can invoke a Wrangler package outside the reviewed runtime contract`);
  }
}
console.log(`Wrangler pins: every invocable path uses ${REVIEWED_WRANGLER_SPEC} with Sharp ${sharp.version}`);
