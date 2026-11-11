import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const NODE_VERSION = '24.13.1';
export const NODE_ARCHIVE = `node-v${NODE_VERSION}-win-x64.zip`;
export const NODE_SHA256 = 'fba577c4bb87df04d54dd87bbdaa5a2272f1f99a2acbf9152e1a91b8b5f0b279';
// Derived from the selected npm/npx + Node files in the authenticated official
// ZIP. Pin the tree separately: a good archive cannot bless unrelated inputs.
export const NODE_INVENTORY_SHA256 = '4bee47218eb338fe490e628d21ccd51dd1bb377ff563a9b4dd9e7aac2568b38d';
const source = dirname(fileURLToPath(import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value) + '\n';
function check(ok, code) { if (!ok) throw Object.assign(new Error(code), { code }); }
function same(a, b) { try { assert.deepEqual(a, b); } catch { check(false, 'TREE_MISMATCH'); } }
function physical(path) {
  const stat = lstatSync(path);
  check(!stat.isSymbolicLink() && realpathSync.native(path).toLowerCase() === resolve(path).toLowerCase(), 'UNSAFE_TREE');
  check(stat.isDirectory() || (stat.isFile() && stat.nlink === 1), 'UNSAFE_TREE');
  return stat;
}
// Windows modes are normalized to preserve the Mac inventory row shape.
// Reparse points and hard links are refused independently of POSIX modes.
export function inventory(root, omitReceipt = false) {
  check(physical(root).isDirectory(), 'UNSAFE_TREE');
  const walk = (directory, prefix = '') => readdirSync(directory).sort().flatMap(name => {
    check(!/[\x00-\x1f\x7f:]/.test(name), 'UNSAFE_TREE');
    const path = prefix + name, absolute = join(directory, name), stat = physical(absolute);
    if (omitReceipt && path === 'payload-receipt.json') return [];
    if (stat.isDirectory()) return [{ path, kind: 'directory', mode: 493 }, ...walk(absolute, path + '/')];
    const bytes = readFileSync(absolute);
    return [{ path, kind: 'file', mode: 420, size: bytes.length, sha256: sha256(bytes) }];
  });
  return walk(root);
}
export function artifact(path) { physical(path); const bytes = readFileSync(path); return { path, size: bytes.length, sha256: sha256(bytes) }; }
function verifyArtifact(record) { same(artifact(record.path), record); }
function x64(path) {
  physical(path);
  const bytes = readFileSync(path);
  check(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'ARCHITECTURE_MISMATCH');
  const offset = bytes.readUInt32LE(60);
  check(offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x4550 && bytes.readUInt16LE(offset + 4) === 0x8664, 'ARCHITECTURE_MISMATCH');
}
function cliIdentity(root, version) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  check(pkg.name === 'brain-installer' && pkg.version === version && ['brain.mjs', './brain.mjs'].includes(pkg.bin?.brain), 'CLI_IDENTITY_MISMATCH');
  physical(join(root, 'brain.mjs'));
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    check(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) && !name.split('/').includes('..') && /^\d+\.\d+\.\d+$/.test(version), 'CLI_DEPENDENCY_INVALID');
    const dependency = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json')));
    check(dependency.name === name && dependency.version === version, 'CLI_DEPENDENCY_INVALID');
  }
}
function below(parent, child) { const rel = relative(parent, child); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep); }
export function stagePayload({ receipt, destination }, {
  checkpoint = () => {}, rename = renameSync,
  wait = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
} = {}) {
  check(isAbsolute(destination) && resolve(destination) === destination && !existsSync(destination), 'UNSAFE_DESTINATION');
  physical(dirname(destination));
  check(receipt.schema === 1 && ['synthetic', 'real'].includes(receipt.evidence) && /^\d+\.\d+\.\d+$/.test(receipt.version) && /^[a-f0-9]{40}$/.test(receipt.source_sha), 'INVALID_RECEIPT');
  check(receipt.architecture === 'x64' && receipt.runtime.version === NODE_VERSION, 'ARCHITECTURE_MISMATCH');
  for (const component of [receipt.runtime, receipt.cli]) {
    check(isAbsolute(component.root) && !below(destination, component.root) && !below(component.root, destination), 'UNSAFE_DESTINATION');
    same(inventory(component.root), component.inventory);
  }
  verifyArtifact(receipt.cli.archive);
  if (receipt.evidence === 'real') {
    verifyArtifact(receipt.runtime.archive);
    check(receipt.runtime.archive.sha256 === NODE_SHA256, 'RUNTIME_ARCHIVE_MISMATCH');
    check(sha256(json(receipt.runtime.inventory)) === NODE_INVENTORY_SHA256, 'RUNTIME_TREE_MISMATCH');
  }
  x64(join(receipt.runtime.root, 'node.exe'));
  cliIdentity(receipt.cli.root, receipt.version);
  const lock = destination + '.lock';
  mkdirSync(lock);
  let temporary;
  try {
    temporary = mkdtempSync(join(dirname(destination), '.payload-stage-'));
    for (const [component, name] of [[receipt.runtime, 'runtime'], [receipt.cli, 'cli']]) {
      cpSync(component.root, join(temporary, name), { recursive: true, dereference: false });
      same(inventory(join(temporary, name)), component.inventory);
    }
    cpSync(receipt.cli.archive.path, join(temporary, 'cli.tgz'));
    same(artifact(join(temporary, 'cli.tgz')).sha256, receipt.cli.archive.sha256);
    for (const name of ['payload.mjs', 'launcher.mjs', 'start-brain-setup.ps1']) cpSync(join(source, name), join(temporary, name));
    const binding = {
      schema: 1, version: receipt.version, architecture: 'x64', source_sha: receipt.source_sha,
      runtime: { version: NODE_VERSION, inventory_sha256: sha256(json(receipt.runtime.inventory)), archive_sha256: receipt.runtime.archive?.sha256 ?? null },
      cli: { archive_size: receipt.cli.archive.size, archive_sha256: receipt.cli.archive.sha256, inventory_sha256: sha256(json(receipt.cli.inventory)) },
    };
    const manifest = { schema: 1, evidence: receipt.evidence, version: receipt.version, architecture: 'x64', source_sha: receipt.source_sha, binding, inventory: inventory(temporary) };
    writeFileSync(join(temporary, 'payload-receipt.json'), json(manifest));
    checkpoint(temporary);
    verifyPayload(temporary);
    // Windows scanners can briefly retain a directory handle after readback.
    // Retry sharing violations only, with bounded waits and fresh verification;
    // an occupied destination is never adopted or removed during recovery.
    for (let attempt = 0; ; attempt++) {
      check(!existsSync(destination), 'UNSAFE_DESTINATION');
      verifyPayload(temporary);
      try { rename(temporary, destination); temporary = undefined; break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 7) throw error;
        wait(50);
      }
    }
    verifyPayload(destination);
    return manifest;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    rmSync(lock, { recursive: true });
  }
}
export function verifyPayload(root) {
  physical(root); physical(join(root, 'payload-receipt.json'));
  const receipt = JSON.parse(readFileSync(join(root, 'payload-receipt.json')));
  check(receipt.schema === 1 && receipt.architecture === 'x64' && ['real', 'synthetic'].includes(receipt.evidence), 'INVALID_RECEIPT');
  same(inventory(root, true), receipt.inventory);
  if (receipt.evidence === 'real') check(receipt.binding.runtime.version === NODE_VERSION && sha256(json(inventory(join(root, 'runtime')))) === NODE_INVENTORY_SHA256, 'RUNTIME_TREE_MISMATCH');
  x64(join(root, 'runtime', 'node.exe'));
  cliIdentity(join(root, 'cli'), receipt.version);
  same(sha256(json(inventory(join(root, 'runtime')))), receipt.binding.runtime.inventory_sha256);
  same(sha256(json(inventory(join(root, 'cli')))), receipt.binding.cli.inventory_sha256);
  same(artifact(join(root, 'cli.tgz')).sha256, receipt.binding.cli.archive_sha256);
  return receipt;
}
