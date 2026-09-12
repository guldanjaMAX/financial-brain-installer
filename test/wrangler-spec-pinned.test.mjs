import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WRANGLER_SPEC, refreshWranglerSession } from '../operations/wrangler-oauth.mjs';
import { CLOUDFLARE_OAUTH_WRANGLER_PACKAGE } from '../operations/cloudflare-oauth-session.mjs';
import { RECOVERY_WRANGLER_VERSION } from '../operations/cloudflare-recovery-adapter.mjs';
import { WRANGLER_PACKAGE } from '../doctor.mjs';
assert.equal(WRANGLER_SPEC, 'wrangler@4.131.1', 'the legacy TOML reader keeps its compatible reviewed pin');
assert.equal(RECOVERY_WRANGLER_VERSION, '4.131.1', 'the live recovery wrapper requires the reviewed exact version');
assert.match(CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, /^wrangler@4\.\d+\.\d+$/);
assert.equal(WRANGLER_PACKAGE, CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, 'doctor and named-profile control must agree');
let called;
assert.equal(refreshWranglerSession({ env: { HOME: '/synthetic-home', CLOUDFLARE_API_TOKEN: 'synthetic-env-value', UNRELATED_DESKTOP_VALUE: 'private' },
  run: (command, args, options) => { called = { command, args, env: options.env }; return { status: 0 }; } }), true);
assert.deepEqual(called.args, [WRANGLER_SPEC, 'whoami']);
assert.equal(called.env.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(called.env.UNRELATED_DESKTOP_VALUE, undefined);
assert.equal(called.env.CLOUDFLARE_AUTH_USE_KEYRING, 'false',
  'legacy refresh must keep default.toml readable even when the machine prefers keyring storage');
const root = fileURLToPath(new URL('../', import.meta.url));
const expectedWranglerVersion = '4.131.1';
const expectedWranglerPackage = `wrangler@${expectedWranglerVersion}`;
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const lockedWrangler = packageLock.packages?.['node_modules/wrangler'];
const lockedMiniflare = packageLock.packages?.['node_modules/miniflare'];
const lockedSharp = packageLock.packages?.['node_modules/sharp'];
assert.equal(WRANGLER_SPEC, expectedWranglerPackage);
assert.equal(CLOUDFLARE_OAUTH_WRANGLER_PACKAGE, expectedWranglerPackage);
assert.equal(WRANGLER_PACKAGE, expectedWranglerPackage);
assert.equal(RECOVERY_WRANGLER_VERSION, expectedWranglerVersion);
assert.equal(packageJson.devDependencies?.wrangler, expectedWranglerVersion);
assert.equal(lockedWrangler?.version, expectedWranglerVersion);
assert.equal(lockedWrangler?.dependencies?.miniflare, lockedMiniflare?.version,
  'the reviewed Wrangler lock must resolve its exact Miniflare dependency');
assert.equal(lockedMiniflare?.dependencies?.sharp, '0.35.4',
  'the Miniflare graph must require the patched sharp release');
assert.equal(lockedSharp?.version, '0.35.4', 'the lock must install patched sharp 0.35.4');
assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/sharp/package.json'), 'utf8')).version,
  lockedSharp.version, 'the installed sharp package must match the reviewed lock');
const installedWranglerSource = readFileSync(join(root, 'node_modules/wrangler/wrangler-dist/cli.js'), 'utf8');
assert.match(installedWranglerSource,
  /if \(envOverride === false\) \{\s*return new FileCredentialStore\(configPath, profile, config2\.format\);/,
  'the pinned Wrangler must route an explicit false keyring override to its plaintext file store');
const cliProbeHome = mkdtempSync(join(tmpdir(), 'brain-wrangler-auth-help-'));
try {
  const windowsKeys = ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT'];
  const cliEnv = Object.fromEntries(windowsKeys
    .filter((key) => typeof process.env[key] === 'string')
    .map((key) => [key, process.env[key]]));
  Object.assign(cliEnv, {
    HOME: cliProbeHome,
    USERPROFILE: cliProbeHome,
    TMPDIR: tmpdir(),
    TEMP: tmpdir(),
    TMP: tmpdir(),
    CI: 'true',
    WRANGLER_SEND_METRICS: 'false',
    CLOUDFLARE_AUTH_USE_KEYRING: 'false',
    NO_UPDATE_NOTIFIER: '1',
  });
  for (const command of [['auth', 'create', '--help'], ['auth', 'token', '--help'], ['whoami', '--help']]) {
    const cliProbe = spawnSync(process.execPath, [
      join(root, 'node_modules/wrangler/bin/wrangler.js'), ...command,
    ], {
      cwd: cliProbeHome,
      env: cliEnv,
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(cliProbe.status, 0,
      `the installed pinned Wrangler command ${command.slice(0, -1).join(' ')} did not start cleanly ` +
      `(${cliProbe.error?.code || cliProbe.signal || 'exit'})`);
    assert.match(cliProbe.stdout, /wrangler/i,
      'the bounded isolated probe must reach the installed Wrangler command help');
  }
} finally {
  rmSync(cliProbeHome, { recursive: true, force: true });
}
assert.match(readFileSync(join(root, 'scripts/field-prepare.mjs'), 'utf8'),
  new RegExp(`const WRANGLER_PACKAGE = ["']${expectedWranglerPackage.replaceAll('.', '\\.')}`));
// Guides are executable too: a client runs what the guide says. An unpinned
// `npx wrangler@4 login` in onboarding is how an install ends up on a wrangler
// that writes an encrypted session the installer cannot read, which is the
// documented cause of a real field failure. CHANGELOG.md is deliberately out of
// scope: its entries record what past releases said and must not be rewritten.
function recursiveFiles(relativeDirectory, suffixes) {
  const found = [];
  for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) found.push(...recursiveFiles(relativePath, suffixes));
    else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(relativePath);
  }
  return found;
}

const files = [
  'brain.mjs',
  'doctor.mjs',
  'package.json',
  ...recursiveFiles('operations', ['.mjs']),
  ...recursiveFiles('scripts', ['.mjs']),
  ...recursiveFiles('test/live', ['.mjs']),
  ...recursiveFiles('onboarding', ['.md']),
  ...recursiveFiles('docs', ['.md']),
];
for (const path of files) {
  const source = readFileSync(join(root, path), 'utf8');
  assert.doesNotMatch(source, /\bnpx\s+(?:--yes\s+)?wrangler(?=\s|$)/i,
    `${path} has a floating bare Wrangler invocation`);
  for (const match of source.matchAll(/\bwrangler@([^\s"'<>),;\x60]+)/gi)) {
    const pin = match[1].replace(/[.,;:]+$/, '');
    assert.equal(pin, expectedWranglerVersion, `${path} has a mismatched or floating Wrangler pin`);
  }
}
const handoffGuide = readFileSync(join(root, 'onboarding/05-handoff-and-revocation.md'), 'utf8');
assert.doesNotMatch(handoffGuide, /npx\s+(?:--yes\s+)?wrangler[^\n]*vectorize\s+delete/i,
  'the owner deletion guide must not use an ambient or default Wrangler credential');
assert.match(handoffGuide, /compare the dashboard account ID with the exact\s+account ID in your manifest/i,
  'destructive owner guidance must require exact account identity confirmation');
console.log('Wrangler pins: current named-profile custody and legacy TOML compatibility are explicit and bounded');
