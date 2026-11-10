import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { fixture } from './helpers/windows-payload-fixture.mjs';
import { stagePayload, verifyPayload, inventory, artifact, NODE_ARCHIVE } from '../machine-prep/installers/windows/payload.mjs';
import { launch } from '../machine-prep/installers/windows/launcher.mjs';
import * as launcher from '../machine-prep/installers/windows/launcher.mjs';
import { checkClaudeCode } from '../doctor.mjs';
import { win32 } from 'node:path';
import { wixPayload } from '../machine-prep/installers/windows/build-payload.mjs';
import { runSmoke } from '../machine-prep/installers/smoke/contract.mjs';

function buildReadback(root, generated, version) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP']) if (process.env[key]) env[key] = process.env[key];
  return spawnSync(process.execPath, ['machine-prep/installers/windows/verify-build.mjs', root, generated, version], { env, encoding: 'utf8', windowsHide: true, shell: false });
}

test('setup environment preserves official Claude discovery for every profile shape', () => {
  for (const profile of ['C:\\Users\\tester', 'C:\\Users\\an owner', 'C:\\Users\\tester-\u00e9', '\\\\host.invalid\\profiles\\tester']) {
    const bin = win32.join(profile, '.local', 'bin');
    const environment = { SystemRoot: 'C:\\Windows', USERPROFILE: profile, PATH: 'C:\\untrusted', NODE_OPTIONS: '--invalid' };
    const probe = env => checkClaudeCode({ platformName: 'win32', environment: env,
      existsImpl: path => path === win32.join(bin, 'claude.exe'), runCommand: () => ({ ok: true, out: 'synthetic' }) });
    assert.equal(probe({ ...environment, PATH: bin }).status, 'ok', 'green control');
    const env = launcher.setupEnvironment({ root: 'C:\\app', environment });
    assert.equal(probe(env).status, 'ok', profile);
    assert.deepEqual(env.PATH.split(';'), [join('C:\\app', 'runtime'), join('C:\\Windows', 'System32'), bin]);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
  }
});

test('setup environment refuses ambiguous profile PATH entries', () => {
  for (const profile of ['', 'relative', 'C:relative', 'C:\\tester;C:\\untrusted', 'C:\\tester"', 'C:\\tester\n']) {
    assert.doesNotThrow(() => launcher.setupEnvironment({ root: 'C:\\app', environment: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\tester' } }), 'green control');
    assert.throws(() => launcher.setupEnvironment({ root: 'C:\\app', environment: { SystemRoot: 'C:\\Windows', USERPROFILE: profile } }));
  }
});

test('production build gate refuses synthetic payloads at every CLI version', () => {
  for (const version of ['0.0.1', '0.4.26']) {
    const f = fixture();
    try {
      f.receipt.version = version;
      const pkg = join(f.receipt.cli.root, 'package.json');
      writeFileSync(pkg, JSON.stringify({ ...JSON.parse(readFileSync(pkg)), version }));
      f.receipt.cli.inventory = inventory(f.receipt.cli.root);
      stagePayload(f);
      assert.equal(verifyPayload(f.destination).version, version, 'fixture API green control');
      const generated = join(f.root, 'Payload.wxs');
      writeFileSync(generated, wixPayload(f.destination));
      const result = buildReadback(f.destination, generated, version);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /PAYLOAD_BUILD_REFUSED=1/);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('payload smoke records bundled proof and always uninstalls a failed verification', async () => {
  const phases = ['verifyHash', 'verifySignature', 'inspectPayload', 'assertClean', 'install', 'verifyInstalled', 'uninstall', 'verifyRemoved'];
  for (const fail of [false, true]) {
    const reached = [], events = [];
    const host = Object.fromEntries(phases.map(name => [name, async () => {
      reached.push(name);
      if (fail && name === 'verifyInstalled') throw new Error('synthetic verification failure');
    }]));
    host.bundledPayload = true;
    if (fail) await assert.rejects(runSmoke(host, event => events.push(event)));
    else await runSmoke(host, event => events.push(event));
    assert.deepEqual(reached, phases);
    assert.equal(events.includes('INSTALLER_PAYLOAD_SMOKE_PASSED=1'), !fail);
    assert.ok(!events.some(event => event.includes('reason=not_bundled')));
  }
});

test('uninstall authoring removes only registered app files and empty directories', () => {
  const f = fixture();
  try {
    stagePayload(f);
    const source = readFileSync('machine-prep/installers/windows/Package.wxs', 'utf8') + wixPayload(f.destination);
    const active = source.replace(/<!--[\s\S]*?-->/g, '');
    assert.doesNotMatch(active, /<RemoveFile\b|<[^>]*RemoveFolderEx\b|<CustomAction\b|<MajorUpgrade\b/);
    assert.match(active, /Name="FinancialBrain"/);
    assert.match(active, /Name="app"/);
    assert.doesNotMatch(active, /On="both"|On="install"/);
    assert.match(active, /<RemoveFolder[^>]*Directory="OWNERROOT"[^>]*On="uninstall"/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('WiX automatic major upgrade is explicitly disabled to retain the older app', () => {
  assert.match(readFileSync('machine-prep/installers/windows/Package.wxs', 'utf8'), /UpgradeStrategy="none"/);
});

test('MSBuild verifier launches explicit Node with an allowlisted environment', () => {
  const project = readFileSync('machine-prep/installers/windows/FinancialBrainMachinePrep.wixproj', 'utf8');
  assert.match(project, /new ProcessStartInfo\(\)/);
  assert.match(project, /info\.Environment\.Clear\(\)/);
  assert.match(project, /info\.Arguments = quote\(Script\).*quote\(Root\)/);
  assert.doesNotMatch(project, /<Exec\b/);
});

test('custom install path is persisted and read back for native uninstall', () => {
  const source = readFileSync('machine-prep/installers/windows/Package.wxs', 'utf8');
  assert.match(source, /Property Id="INSTALLFOLDER"[\s\S]*?RegistrySearch[\s\S]*?Root="HKCU"[\s\S]*?Name="installDirectory"/);
  assert.match(source, /Name="installDirectory" Type="string" Value="\[INSTALLFOLDER\]" KeyPath="yes"/);
});

test('MSI explicitly creates every inventoried directory, including empty runtime directories', () => {
  const f = fixture();
  try {
    stagePayload(f);
    const generated = wixPayload(f.destination);
    assert.equal(generated.match(/<CreateFolder\b/g)?.length ?? 0, generated.match(/<Component\b/g).length);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('staging retries transient Windows rename locks, then verifies publication', () => {
  const f = fixture(); let attempts = 0;
  try {
    stagePayload(f, {
      rename: (from, to) => {
        attempts++;
        if (attempts < 3) throw Object.assign(new Error('synthetic sharing violation'), { code: 'EPERM' });
        renameSync(from, to);
      },
      wait: () => {},
    });
    assert.equal(attempts, 3);
    verifyPayload(f.destination);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('rename recovery preserves a newly occupied destination and stops at its bound', () => {
  const f = fixture(); let attempts = 0;
  try {
    assert.throws(() => stagePayload(f, { rename: () => { attempts++; throw Object.assign(new Error('synthetic lock'), { code: 'EPERM' }); }, wait: () => {} }));
    assert.equal(attempts, 8);
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(f.destination + '.lock'), false);
    assert.throws(() => stagePayload(f, {
      rename: () => {
        mkdirSync(f.destination);
        writeFileSync(join(f.destination, 'sentinel.txt'), 'preserve');
        throw Object.assign(new Error('synthetic race'), { code: 'EPERM' });
      }, wait: () => {},
    }));
    assert.equal(readFileSync(join(f.destination, 'sentinel.txt'), 'utf8'), 'preserve');
    assert.equal(existsSync(f.destination + '.lock'), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('real payload carries private npm and starts exact CLI offline', { skip: !process.env.WINDOWS_PAYLOAD_REAL_ROOT }, () => {
  const root = process.env.WINDOWS_PAYLOAD_REAL_ROOT;
  assert.equal(verifyPayload(root).evidence, 'real');
  for (const path of ['runtime/npm.cmd', 'runtime/npx.cmd', 'runtime/node_modules/npm/bin/npm-cli.js']) assert.ok(existsSync(join(root, path)), path);
  const f = fixture();
  try {
    const generated = join(f.root, 'Payload.wxs');
    writeFileSync(generated, wixPayload(root));
    const build = buildReadback(root, generated, verifyPayload(root).version);
    assert.equal(build.status, 0, build.stderr);
    assert.match(build.stdout, /PAYLOAD_BUILD_READBACK=1/);
    const env = { SystemRoot: process.env.SystemRoot, USERPROFILE: f.root, HOME: f.root, TEMP: f.root, TMP: f.root, LOCALAPPDATA: f.root, APPDATA: f.root, BRAIN_NO_WRANGLER_LOGIN: '1' };
    const result = spawnSync(join(root, 'runtime/node.exe'), ['--import', pathToFileURL(resolve('machine-prep/installers/smoke/version-guard.mjs')).href, join(root, 'cli/brain.mjs'), '--version'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(JSON.parse(readFileSync(join(root, 'cli/package.json'))).version.replaceAll('.', '\\.')));
    assert.equal(launch({ root, args: [], home: f.root, environment: { SystemRoot: process.env.SystemRoot, USERPROFILE: f.root, NODE_OPTIONS: '--invalid-synthetic-option' } }, {
      spawn: (node, args, options) => {
        assert.equal(node, join(root, 'runtime', 'node.exe'));
        assert.equal(options.env.PATHEXT, '.COM;.EXE;.BAT;.CMD');
        assert.equal(options.env.NODE_OPTIONS, undefined);
        assert.equal(options.shell, false);
        assert.deepEqual(options.env, launcher.setupEnvironment({ root, environment: { SystemRoot: process.env.SystemRoot, USERPROFILE: f.root } }));
        assert.equal(checkClaudeCode({ platformName: 'win32', environment: options.env,
          existsImpl: path => path === win32.join(f.root, '.local', 'bin', 'claude.exe'),
          runCommand: () => ({ ok: true, out: 'synthetic' }) }).status, 'ok');
        return { status: 0 };
      },
    }), 0);
    // An authentic archive must not authenticate an unrelated supplied tree.
    f.receipt.evidence = 'real';
    f.receipt.runtime.archive = artifact(join(root, '..', NODE_ARCHIVE));
    assert.throws(() => stagePayload(f));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('shell control: per-user installer carries its setup script', () => {
  assert.match(readFileSync('machine-prep/installers/windows/Package.wxs', 'utf8'), /Scope="perUser"/);
  assert.match(readFileSync('machine-prep/installers/windows/Package.wxs', 'utf8'), /start-brain-setup\.ps1/);
  assert.ok(existsSync('machine-prep/installers/windows/start-brain-setup.ps1'));
});

test('Windows payload stages private x64 Node, exact CLI archive and tree, and setup launcher', async () => {
  assert.ok(existsSync('machine-prep/installers/windows/payload.mjs'), 'private runtime staging path is missing');
  const f = fixture();
  try {
    const receipt = stagePayload(f);
    assert.equal(verifyPayload(f.destination).architecture, 'x64');
    for (const path of ['runtime/node.exe', 'cli.tgz', 'cli/brain.mjs', 'launcher.mjs', 'start-brain-setup.ps1']) assert.ok(receipt.inventory.some(row => row.path === path));
    assert.equal(launch({ root: f.destination, args: ['--self-check'] }), 0);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const fault of ['changed', 'extra', 'missing', 'architecture', 'junction', 'hard-link']) {
  test(`launch refuses ${fault} before spawning CLI`, () => {
    const f = fixture(); let spawned = false;
    try {
      stagePayload(f);
      if (fault === 'changed') writeFileSync(join(f.destination, 'cli/brain.mjs'), '// tampered');
      if (fault === 'extra') writeFileSync(join(f.destination, 'extra.txt'), 'extra');
      if (fault === 'missing') rmSync(join(f.destination, 'cli.tgz'));
      if (fault === 'architecture') {
        const path = join(f.destination, 'runtime/node.exe'), bytes = readFileSync(path);
        bytes.writeUInt16LE(0xaa64, 68); writeFileSync(path, bytes);
        const record = JSON.parse(readFileSync(join(f.destination, 'payload-receipt.json')));
        record.inventory = inventory(f.destination, true);
        writeFileSync(join(f.destination, 'payload-receipt.json'), JSON.stringify(record));
      }
      if (fault === 'junction') symlinkSync(f.receipt.runtime.root, join(f.destination, 'linked'), 'junction');
      if (fault === 'hard-link') linkSync(join(f.destination, 'cli/brain.mjs'), join(f.destination, 'linked.mjs'));
      assert.throws(() => launch({ root: f.destination, args: ['--self-check'] }, { spawn: () => { spawned = true; } }));
      assert.equal(spawned, false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('staging refuses changed input, occupied destination and interrupted promotion', () => {
  const f = fixture();
  try {
    assert.throws(() => stagePayload(f, { checkpoint: root => writeFileSync(join(root, 'extra'), '') }));
    assert.equal(existsSync(f.destination), false);
    assert.equal(existsSync(f.destination + '.lock'), false);
    stagePayload(f);
    assert.throws(() => stagePayload(f));
    rmSync(f.destination, { recursive: true });
    writeFileSync(join(f.receipt.runtime.root, 'node.exe'), 'bad');
    assert.throws(() => stagePayload(f));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
