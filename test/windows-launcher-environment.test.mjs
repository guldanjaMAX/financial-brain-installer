import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupEnvironment } from '../machine-prep/installers/windows/launcher.mjs';
import { adminKeyPersistencePlan } from '../operations/admin-key-persistence.mjs';
import { validateAdminKeyFileDestination } from '../operations/admin-key-file.mjs';

const root = 'C:\\fixture\\app\\0.0.0';
const environment = {
  SystemRoot: 'C:\\Windows',
  WINDIR: 'C:\\Windows',
  COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\fixture-owner',
  LOCALAPPDATA: 'C:\\Users\\fixture-owner\\AppData\\Local',
  APPDATA: 'C:\\Users\\fixture-owner\\AppData\\Roaming',
  TEMP: 'C:\\fixture\\temp',
  TMP: 'C:\\fixture\\tmp',
  USERNAME: 'fixture-owner',
  NODE_OPTIONS: '--bad',
  PATH: 'C:\\untrusted',
  USER: 'unrelated-owner',
};

test('P1.1 setup keeps USERNAME and drops inherited loader overrides', () => {
  const env = setupEnvironment({ root, environment });
  assert.equal(env.SystemRoot, environment.SystemRoot, 'green control: allowlist reached');
  assert.equal(env.USERNAME, 'fixture-owner', 'USERNAME must reach the setup child');
  assert.equal(env.NODE_OPTIONS, undefined, 'NODE_OPTIONS must remain excluded');
  const { NODE_OPTIONS, PATH, USER, ...allowed } = environment;
  assert.deepEqual(env, {
    ...allowed,
    PATH: [join(root, 'runtime'), join(environment.SystemRoot, 'System32'),
      'C:\\Users\\fixture-owner\\.local\\bin'].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
  }, 'only USERNAME is added; every other key and derived PATH stays unchanged');
});

test('P1.2 PowerShell forwards USERNAME through its cleared allowlist', () => {
  const source = readFileSync(new URL('../machine-prep/installers/windows/start-brain-setup.ps1', import.meta.url), 'utf8');
  const list = source.match(/foreach \(\$name in @\(([^)]+)\)\)/);
  assert.ok(list, 'green control: forwarding decision point exists');
  assert.match(source, /\$info\.EnvironmentVariables\.Clear\(\)/);
  assert.match(source, /\$info\.EnvironmentVariables\[\$name\] = \$value/);
  const names = [...list[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.ok(names.includes('SystemRoot'), 'green control: existing system key forwarded');
  assert.ok(names.includes('USERNAME'), 'PowerShell allowlist must include USERNAME');
  assert.deepEqual(names, ['SystemRoot', 'WINDIR', 'COMSPEC', 'USERPROFILE',
    'LOCALAPPDATA', 'APPDATA', 'TEMP', 'TMP', 'USERNAME']);
});

test('P1.3 launched identity passes the real Windows admin-key destination check', t => {
  // macOS tmpdir() runs through the /var -> /private/var link, which the real destination check
  // rightly refuses; resolve it so the test exercises the check, not the host's temp layout.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'windows-launcher-environment-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const keyPath = join(directory, '.brain-admin-key');
  // Only metadata is inspected. No credential reader, ACL tool or DPAPI runs.
  writeFileSync(keyPath, randomBytes(32).toString('hex'), { mode: 0o600 });
  let validations = 0;
  const plan = env => adminKeyPersistencePlan(join(directory, 'brain.manifest.json'), {}, {
    platform: 'win32',
    username: env.USERNAME ?? env.USER,
    validateAdminKeyDestination: (path, options) => {
      validations++;
      assert.equal(path, keyPath);
      assert.equal(options.platform, 'win32');
      return validateAdminKeyFileDestination(path, options);
    },
  });
  assert.equal(plan({ USERNAME: 'fixture-owner' }).backend, 'file', 'green control: valid identity accepted');
  assert.equal(validations, 1);
  for (const env of [{}, { USERNAME: ' ' }]) {
    const before = validations;
    assert.throws(() => plan(env), /Windows could not identify the current user/);
    assert.equal(validations, before + 1, 'negative control reached the real validator');
  }
  const env = setupEnvironment({ root, environment });
  assert.doesNotThrow(() => plan(env), 'launcher identity must pass the real username check');
  assert.equal(validations, 4, 'launcher path reached the real validator');
});
