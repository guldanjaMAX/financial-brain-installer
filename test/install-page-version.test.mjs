import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkInstallPage,
  ENDPOINTS,
  guideFields,
  publicBytes,
  readSupervisedInstallContract,
  validateDoorways,
  validatePublicManifest,
  validateSupervisedInstallContract,
  verifyPublishedMetadata,
} from '../scripts/check-install-page-version.mjs';
import {
  createRuntimeIdentityReceipt,
  runtimeIdentityReceiptBytes,
} from '../scripts/runtime-identity-receipt.mjs';
const bytes = Buffer.from('synthetic reviewed package fixture\n');
const sha = createHash('sha256').update(bytes).digest('hex');
const runtimePayloadSha = 'c'.repeat(64);
const runtimeBytes = runtimeIdentityReceiptBytes(createRuntimeIdentityReceipt({
  sourceSha: 'd'.repeat(40),
  packageFilename: 'brain-installer-9.8.7.tgz',
  packageVersion: '9.8.7',
  packageBytes: bytes.length,
  packageFileCount: 42,
  packageSha256: sha,
  identityScheme: 'brain.runtime-payload.sha256.v1',
  runtimePayloadSha256: runtimePayloadSha,
}));
const runtimeSha = createHash('sha256').update(runtimeBytes).digest('hex');
const commit = createHash('sha1').update('synthetic candidate commit').digest('hex');
const installGuide = `AGENT_INSTALL_CONTRACT_VERSION: 1
STATUS: supervised field-test candidate
TARGET: physical Windows 10 or newer
OWNER_PRESENT: required
SETUP_PAGE: https://financialbrain.ai/operator
ARTIFACT_URL: https://financialbrain.ai/operator/financial-brain-v9.8.6-field-kit-${sha.slice(0, 16)}.zip
ARTIFACT_BYTES: ${bytes.length}
ARTIFACT_SHA256: ${sha}
CANDIDATE_VERSION: 9.8.6
CANDIDATE_COMMIT: ${commit}
`;
const macosInstallGuide = installGuide
  .replace('TARGET: physical Windows 10 or newer', 'TARGET: macOS 13 or newer, Apple silicon or Intel');
const held = (state = 'held') => ({ schema_version: 2, release_state: state, available: false, release: null, published_at: null,
  update_url: 'https://financialbrain.ai/update', installer: null, changes: [], held_reason: 'Synthetic field evidence pending.',
  proof: { archive_release_gate: 'not_passed', automated_release_suite: 'pending', live_client_acceptance: 'required' } });
const stable = () => ({ ...held('stable'), available: true, release: '9.8.7', published_at: '2026-09-06', held_reason: null,
  installer: { url: 'https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v9.8.7/brain-installer-9.8.7.tgz', sha256: sha, bytes: bytes.length },
  runtime_identity: {
    url: 'https://github.com/guldanjaMAX/financial-brain-installer/releases/download/v9.8.7/brain-installer-9.8.7-runtime-identity.json',
    sha256: runtimeSha,
    bytes: runtimeBytes.length,
    source_sha: 'd'.repeat(40),
    package_file_count: 42,
    identity_scheme: 'brain.runtime-payload.sha256.v1',
    runtime_payload_sha256: runtimePayloadSha,
  },
  proof: { archive_release_gate: 'passed', automated_release_suite: 'passed', live_client_acceptance: 'required' } });
const guide = (state) => `AGENT_UPDATE_CONTRACT_VERSION: 1\nRELEASE_STATE: ${state}\nPERMITTED_MODE: ${state === 'stable' ? 'guided-update-after-release-and-owner-checks' : 'read-only-diagnosis'}\nPAGE_URL: https://financialbrain.ai/update\nRELEASE_MANIFEST: ${ENDPOINTS.manifest}\n`;
const release = () => ({ tag_name: 'v9.8.7', draft: false, prerelease: false, immutable: true,
  assets: ['brain-installer-9.8.7.tgz', 'brain-installer.tgz', 'brain-installer-9.8.7-runtime-identity.json'].map((name) => ({
    name,
    size: name.endsWith('.json') ? runtimeBytes.length : bytes.length,
    digest: `sha256:${name.endsWith('.json') ? runtimeSha : sha}`,
    state: 'uploaded',
  })) });
function reader(manifest, overrides = {}) {
  const values = { [ENDPOINTS.manifest]: Buffer.from(JSON.stringify(manifest)), [ENDPOINTS.updateGuide]: Buffer.from(guide(manifest.release_state)),
    [ENDPOINTS.installGuide]: Buffer.from(installGuide), [ENDPOINTS.latest]: Buffer.from(JSON.stringify(release())),
    ...(manifest.installer ? { [manifest.installer.url]: bytes } : {}),
    ...(manifest.runtime_identity ? { [manifest.runtime_identity.url]: runtimeBytes } : {}),
    ...overrides };
  const calls = [];
  return { calls, read: async (url) => { calls.push(url); assert.ok(Object.hasOwn(values, url), 'unexpected request'); return values[url]; } };
}
for (const state of ['held', 'candidate']) test(`${state} is healthy but never a promotion or artifact proof`, async () => {
  const io = reader(held(state));
  assert.deepEqual(await checkInstallPage(io), { state, publicRelease: null, supervisedCandidate: '9.8.6', promotionAllowed: false, artifactVerified: false });
  assert.equal(io.calls.length, 3, 'held checker must not fetch latest or install a candidate');
  await assert.rejects(checkInstallPage({ ...reader(held(state)), requireStable: true }), /promotion is not allowed/);
});
test('nonstable metadata cannot expose a release, installer, completion claim, or missing reason', () => {
  for (const mutation of [{ available: true }, { release: '9.8.7' }, { installer: stable().installer },
    { runtime_identity: stable().runtime_identity }, { held_reason: '' }, { changes: ['shipped'] },
    { proof: stable().proof }]) {
    assert.throws(() => validatePublicManifest({ ...held(), ...mutation }));
  }
});
test('stable requires exact immutable receipt, independent bytes, and matching guide', async () => {
  assert.deepEqual(await checkInstallPage(reader(stable())), { state: 'stable', publicRelease: '9.8.7', supervisedCandidate: '9.8.6', promotionAllowed: true, artifactVerified: true });
  await assert.rejects(checkInstallPage(reader(stable(), { [stable().installer.url]: Buffer.from('wrong archive') })), /archive differs/);
  await assert.rejects(checkInstallPage(reader(stable(), {
    [stable().runtime_identity.url]: Buffer.from('wrong runtime receipt'),
  })), /RUNTIME_IDENTITY_/);
  await assert.rejects(checkInstallPage(reader(stable(), { [ENDPOINTS.updateGuide]: Buffer.from(guide('held')) })), /disagree/);
});
test('stable metadata rejects malformed date, digest, size, URL, schema, and state', () => {
  for (const mutation of [{ schema_version: 1 }, { release_state: 'unknown' }, { available: false }, { release: 'latest' }, { published_at: '2026-02-30' }, { held_reason: 'held' }, { update_url: 'https://example.invalid/update' }]) {
    assert.throws(() => validatePublicManifest({ ...stable(), ...mutation }));
  }
  for (const mutation of [{ url: 'https://example.invalid/package.tgz' }, { sha256: 'bad' }, { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }]) {
    assert.throws(() => validatePublicManifest({ ...stable(), installer: { ...stable().installer, ...mutation } }));
  }
  for (const mutation of [{ url: 'https://example.invalid/runtime.json' }, { sha256: 'bad' },
    { bytes: 0 }, { bytes: 4097 }, { source_sha: 'bad' }, { package_file_count: 0 },
    { identity_scheme: 'wrong' }, { runtime_payload_sha256: 'bad' }]) {
    assert.throws(() => validatePublicManifest({
      ...stable(), runtime_identity: { ...stable().runtime_identity, ...mutation },
    }));
  }
  assert.throws(() => validatePublicManifest({
    ...stable(), runtime_identity: { ...stable().runtime_identity, unexpected: true },
  }));
});
test('public runtime receipt cannot disagree with its independently bound package fields', async () => {
  const mismatchedBytes = runtimeIdentityReceiptBytes(createRuntimeIdentityReceipt({
    sourceSha: stable().runtime_identity.source_sha,
    packageFilename: 'brain-installer-9.8.7.tgz',
    packageVersion: '9.8.7',
    packageBytes: bytes.length,
    packageFileCount: stable().runtime_identity.package_file_count + 1,
    packageSha256: sha,
    identityScheme: stable().runtime_identity.identity_scheme,
    runtimePayloadSha256: runtimePayloadSha,
  }));
  const mismatchedSha = createHash('sha256').update(mismatchedBytes).digest('hex');
  const manifest = {
    ...stable(),
    runtime_identity: {
      ...stable().runtime_identity,
      bytes: mismatchedBytes.length,
      sha256: mismatchedSha,
    },
  };
  const metadata = release();
  Object.assign(metadata.assets[2], {
    size: mismatchedBytes.length,
    digest: `sha256:${mismatchedSha}`,
  });
  await assert.rejects(checkInstallPage(reader(manifest, {
    [manifest.runtime_identity.url]: mismatchedBytes,
    [ENDPOINTS.latest]: Buffer.from(JSON.stringify(metadata)),
  })), /RUNTIME_IDENTITY_EXPECTATION_MISMATCH/);
});
test('latest mutable, different-version, incomplete, and mismatched assets all refuse', () => {
  for (const mutation of [{ immutable: false }, { draft: true }, { prerelease: true }, { tag_name: 'v9.8.6' }, { assets: [] }, { assets: [release().assets[0], release().assets[0]] }]) {
    assert.throws(() => verifyPublishedMetadata(stable(), { ...release(), ...mutation }));
  }
  for (const field of [{ size: 1 }, { digest: 'sha256:wrong' }, { state: 'new' }]) {
    const data = release(); Object.assign(data.assets[0], field); assert.throws(() => verifyPublishedMetadata(stable(), data));
    const runtimeData = release(); Object.assign(runtimeData.assets[2], field);
    assert.throws(() => verifyPublishedMetadata(stable(), runtimeData));
  }
});
test('duplicate fields, missing owner, swapped candidate URL, or update permission drift refuse', () => {
  assert.throws(() => guideFields('RELEASE_STATE: held\nRELEASE_STATE: stable\n'), /duplicate/);
  for (const bad of [installGuide.replace('OWNER_PRESENT: required', 'OWNER_PRESENT: optional'), installGuide.replace('/operator/financial-', '/install/financial-'), installGuide.replace('CANDIDATE_VERSION: 9.8.6', 'CANDIDATE_VERSION: latest')]) {
    assert.throws(() => validateDoorways({ manifest: held(), updateGuide: guide('held'), installGuide: bad }));
  }
  assert.throws(() => validateDoorways({ manifest: held(), installGuide, updateGuide: guide('held').replace('read-only-diagnosis', 'guided-update-after-release-and-owner-checks') }), /wrong operation/);
});
test('the reusable supervised-install parser refuses one defect at a time before an artifact can be selected', async () => {
  assert.equal(validateSupervisedInstallContract(installGuide).candidateCommit, commit);
  assert.equal(validateSupervisedInstallContract(macosInstallGuide, { platform: 'macos' }).guideUrl,
    ENDPOINTS.installGuideMacos);
  const mutations = [
    ['duplicate status', installGuide.replace('STATUS: supervised field-test candidate',
      'STATUS: supervised field-test candidate\nSTATUS: supervised field-test candidate')],
    ['short commit', installGuide.replace(commit, commit.slice(0, 7))],
    ['mutable artifact', installGuide.replace(/^ARTIFACT_URL: .*$/m,
      'ARTIFACT_URL: https://financialbrain.ai/operator/latest.zip')],
    ['arbitrary artifact', installGuide.replace(/^ARTIFACT_URL: .*$/m,
      'ARTIFACT_URL: https://example.invalid/fixture.zip')],
    ['missing owner', installGuide.replace(/^OWNER_PRESENT:.*\n/m, '')],
    ['missing target', installGuide.replace(/^TARGET:.*\n/m, '')],
    ['missing status', installGuide.replace(/^STATUS:.*\n/m, '')],
  ];
  for (const [label, badGuide] of mutations) {
    const calls = [];
    await assert.rejects(
      readSupervisedInstallContract({
        read: async (url, limit) => {
          calls.push({ url, limit });
          if (url === ENDPOINTS.installGuide) return Buffer.from(badGuide);
          throw new Error('artifact download must not start');
        },
      }),
      undefined,
      label,
    );
    assert.deepEqual(calls, [{ url: ENDPOINTS.installGuide, limit: 200_000 }], label);
  }
});
test('the supervised-install reader follows only the validated digest-derived URL with exact byte bounds', async () => {
  const calls = [];
  const result = await readSupervisedInstallContract({
    read: async (url, limit) => {
      calls.push({ url, limit });
      if (url === ENDPOINTS.installGuide) return Buffer.from(installGuide);
      if (url === validateSupervisedInstallContract(installGuide).artifactUrl) return bytes;
      throw new Error('unexpected URL');
    },
  });
  assert.deepEqual(calls, [
    { url: ENDPOINTS.installGuide, limit: 200_000 },
    { url: result.artifactUrl, limit: bytes.length },
  ]);
  assert.deepEqual(result.artifact, bytes);
});
test('the public byte reader stops a response as soon as its declared or streamed body exceeds the cap', async () => {
  const oversized = async () => new Response(Buffer.alloc(9), { status: 200 });
  await assert.rejects(publicBytes('https://fixture.invalid/body', 8, { fetchImpl: oversized }), /byte limit/);
  await assert.rejects(publicBytes('https://fixture.invalid/body', 100 * 1024 * 1024 + 1,
    { fetchImpl: oversized }), /invalid public response byte limit/);
});
test('transport and unreadable metadata fail closed', async () => {
  await assert.rejects(checkInstallPage({ read: async () => { throw new Error('synthetic unavailable'); } }), /unavailable/);
  await assert.rejects(checkInstallPage(reader(held(), { [ENDPOINTS.manifest]: Buffer.from('not json') })));
});

// Execute the real import-time runner. Only the public contract and external
// commands are synthetic; source-text checks cannot prove a refusal happens.
function runSyntheticKit({
  rootCount, declaredName = null, staleWorkdir = false,
  rootMode = 'directory', archiveMode = 'file', receiptMode = 'file',
  workdirMode = 'directory', documentsMode = 'none', failSecondMacRead = false,
}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'brain-kit-containment-'));
  const workdir = join(fixtureRoot, 'runner-workdir');
  const executionMarker = join(fixtureRoot, 'install-command-ran.txt');
  const runnerUrl = new URL('../scripts/install-from-public-contract.mjs', import.meta.url).href;
  const runnerPath = fileURLToPath(runnerUrl);
  const bootstrapPath = join(fixtureRoot, 'bootstrap.mjs');
  const hooksPath = join(fixtureRoot, 'hooks.mjs');
  const archiveBase64 = bytes.toString('base64');
  const contractSource = `
    export async function readSupervisedInstallContract() {
      return {
        guideUrl: 'https://financialbrain.ai/install/agent.md',
        artifactBytes: ${bytes.length}, artifactSha256: ${JSON.stringify(sha)},
        candidateVersion: '9.8.6', candidateCommit: ${JSON.stringify(commit)},
        artifact: Buffer.from(${JSON.stringify(archiveBase64)}, 'base64'),
      };
    }
  `;
  const childProcessSource = `
    import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const fixture = ${JSON.stringify({
      rootCount, declaredName, workdir, fixtureRoot, executionMarker, archiveBase64, sha, commit,
      rootMode, archiveMode, receiptMode, documentsMode,
    })};
    export function execFileSync(command, args) {
      if (command !== 'unzip') {
        writeFileSync(fixture.executionMarker, 'called');
        throw new Error('synthetic install command must not run');
      }
      const extractionDir = args[4];
      for (let index = 0; index < fixture.rootCount; index++) {
        const root = join(extractionDir, index === 0 ? 'kit' : 'extra-' + index);
        if (index === 0 && fixture.rootMode !== 'directory') {
          const target = fixture.rootMode === 'sibling-prefix'
            ? extractionDir + '-evil'
            : join(fixture.fixtureRoot,
              fixture.rootMode === 'broken-link' ? 'missing-root' : 'outside-root');
          if (fixture.rootMode !== 'broken-link') mkdirSync(target, { recursive: true });
          symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir');
        } else {
          mkdirSync(root, { recursive: true });
        }
        if (index === 0) {
          if (fixture.rootMode === 'broken-link') continue;
          const archive = Buffer.from(fixture.archiveBase64, 'base64');
          if (fixture.archiveMode === 'outside-link' || fixture.archiveMode === 'sibling-prefix') {
            const outside = fixture.archiveMode === 'sibling-prefix'
              ? root + '-evil' : join(fixture.fixtureRoot, 'outside-archive');
            if (fixture.archiveMode !== 'sibling-prefix') mkdirSync(outside, { recursive: true });
            symlinkSync(outside, join(root, 'brain-installer-9.8.6.tgz'),
              process.platform === 'win32' ? 'junction' : 'dir');
          } else if (fixture.archiveMode === 'outside-file-link') {
            const outside = join(fixture.fixtureRoot, 'outside-archive.tgz');
            writeFileSync(outside, archive);
            symlinkSync(outside, join(root, 'brain-installer-9.8.6.tgz'), 'file');
          } else if (fixture.archiveMode === 'file') {
            writeFileSync(join(root, 'brain-installer-9.8.6.tgz'), archive);
          }
          writeFileSync(join(extractionDir, 'brain-installer-9.8.6.tgz'), archive);
          if (fixture.declaredName !== null) {
            if (fixture.receiptMode === 'directory') {
              mkdirSync(join(root, 'SHA256SUMS.txt'));
            } else if (fixture.receiptMode === 'file') {
              writeFileSync(join(root, 'SHA256SUMS.txt'), fixture.sha + '  ' + fixture.declaredName + '\\n');
            }
          }
          if (fixture.documentsMode !== 'none') {
            const size = String(archive.length);
            const fieldText = 'Package size ' + size + ' bytes\\n';
            if (fixture.documentsMode !== 'missing-windows-guide') {
              writeFileSync(join(root, 'WINDOWS-FIELD-TEST.md'), fieldText);
            }
            if (fixture.documentsMode !== 'missing-macos-guide') {
              writeFileSync(join(root, 'MACOS-FIELD-TEST.md'),
                fieldText + 'CANDIDATE_COMMIT: ' + fixture.commit + '\\n');
            }
            if (fixture.documentsMode !== 'missing-receipt') {
              writeFileSync(join(root, 'RELEASE-CANDIDATE-RECEIPT.md'),
                fixture.commit.slice(0, 7) + ' ' + size + ' ' + fixture.sha + '\\n');
            }
          }
        }
      }
      return Buffer.alloc(0);
    }
  `;
  const hooksSource = `
    const runnerUrl = ${JSON.stringify(runnerUrl)};
    const contractSource = ${JSON.stringify(contractSource)};
    const childProcessSource = ${JSON.stringify(childProcessSource)};
    export async function resolve(specifier, context, nextResolve) {
      if (context.parentURL === runnerUrl && specifier === './check-install-page-version.mjs') {
        return { url: 'd10:contract', shortCircuit: true };
      }
      if (context.parentURL === runnerUrl && specifier === 'node:child_process') {
        return { url: 'd10:child-process', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === 'd10:contract') return { format: 'module', source: contractSource, shortCircuit: true };
      if (url === 'd10:child-process') return { format: 'module', source: childProcessSource, shortCircuit: true };
      return nextLoad(url, context);
    }
  `;
  writeFileSync(hooksPath, hooksSource);
  writeFileSync(bootstrapPath, `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { register, syncBuiltinESMExports } from 'node:module';
    if (${JSON.stringify(archiveMode === 'sibling-prefix')}) {
      const originalReaddir = fs.readdirSync;
      fs.readdirSync = (...args) => {
        const entries = originalReaddir(...args);
        if (String(args[0]).includes('kit-extract-') && entries.includes('kit')) {
          fs.mkdirSync(join(args[0], 'kit-evil'));
        }
        return entries;
      };
    }
    if (${JSON.stringify(failSecondMacRead)}) {
      const originalRead = fs.readFileSync;
      let macReads = 0;
      fs.readFileSync = (...args) => {
        if (String(args[0]).endsWith('MACOS-FIELD-TEST.md') && ++macReads === 2) {
          const error = new Error('synthetic second-read refusal');
          error.code = 'ENOENT';
          throw error;
        }
        return originalRead(...args);
      };
    }
    syncBuiltinESMExports();
    register(new URL('./hooks.mjs', import.meta.url), import.meta.url);
  `);
  try {
    if (workdirMode === 'linked') {
      const physicalWorkdir = join(fixtureRoot, 'physical-workdir');
      mkdirSync(physicalWorkdir);
      symlinkSync(physicalWorkdir, workdir, process.platform === 'win32' ? 'junction' : 'dir');
    }
    if (staleWorkdir) mkdirSync(join(workdir, 'old-kit'), { recursive: true });
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(bootstrapPath).href, runnerPath, workdir, '--guide', 'windows',
    ], { encoding: 'utf8' });
    assert.equal(existsSync(executionMarker), false, 'no install command may run');
    assert.equal(existsSync(join(workdir, 'prefix')), false, 'no install prefix may be created');
    return result;
  } finally {
    assert.ok(resolve(fixtureRoot).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

for (const [label, declaredName] of [
  ['parent traversal', '../brain-installer-9.8.6.tgz'],
  ['Windows parent traversal', '..\\brain-installer-9.8.6.tgz'],
  ['parent component alone', '..'],
  ['absolute POSIX path', '/brain-installer-9.8.6.tgz'],
  ['drive-relative path', 'C:brain-installer-9.8.6.tgz'],
  ['absolute Windows path', 'C:\\brain-installer-9.8.6.tgz'],
  ['empty filename', ''],
]) {
  test(`the public runner refuses SHA256SUMS.txt ${label} before installation`, () => {
    const result = runSyntheticKit({ rootCount: 1, declaredName });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /FAIL  SHA256SUMS\.txt archive filename must be one safe path segment(?:\r?\n|$)/);
  });
}

for (const rootCount of [0, 2]) {
  test(`the public runner refuses ${rootCount} extracted directories before installation`, () => {
    const result = runSyntheticKit({ rootCount, declaredName: 'brain-installer-9.8.6.tgz' });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, new RegExp(`FAIL  kit ZIP must extract exactly one top-level directory \\(found ${rootCount}\\)(?:\\r?\\n|$)`));
  });
}

test('the public runner ignores a stale work directory when the ZIP extracts no root', () => {
  const result = runSyntheticKit({ rootCount: 0, staleWorkdir: true });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit ZIP must extract exactly one top-level directory \(found 0\)(?:\r?\n|$)/);
});

test('one extracted root and a safe archive name reach the existing guide checks', () => {
  const result = runSyntheticKit({ rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS  brain-installer-9\.8\.6\.tgz matches the kit's own SHA256SUMS\.txt/);
  assert.match(result.stderr, /FAIL  kit WINDOWS-FIELD-TEST\.md is missing or unreadable(?:\r?\n|$)/);
});

test('a legitimate kit under a linked workdir reaches the guide checks', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', workdirMode: 'linked',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS  brain-installer-9\.8\.6\.tgz matches the kit's own SHA256SUMS\.txt/);
  assert.match(result.stderr, /FAIL  kit WINDOWS-FIELD-TEST\.md is missing or unreadable(?:\r?\n|$)/);
});

test('the public runner refuses a root resolving to a sibling prefix', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', rootMode: 'sibling-prefix',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit extraction root resolves outside its extraction directory(?:\r?\n|$)/);
});

test('the public runner refuses an archive resolving to a sibling prefix', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', archiveMode: 'sibling-prefix',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit archive resolves outside the extracted root(?:\r?\n|$)/);
});

test('the public runner refuses a readable archive file linked outside the root on POSIX',
  { skip: process.platform === 'win32' ? 'Windows without Developer Mode cannot create a file symlink' : false }, () => {
    const result = runSyntheticKit({
      rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', archiveMode: 'outside-file-link',
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /FAIL  kit archive resolves outside the extracted root(?:\r?\n|$)/);
  });

for (const [documentsMode, document] of [
  ['missing-windows-guide', 'WINDOWS-FIELD-TEST.md'],
  ['missing-macos-guide', 'MACOS-FIELD-TEST.md'],
  ['missing-receipt', 'RELEASE-CANDIDATE-RECEIPT.md'],
]) {
  test(`the public runner refuses a missing ${document} without a filesystem stack`, () => {
    const result = runSyntheticKit({
      rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', documentsMode,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, new RegExp(`FAIL  kit ${document.replace('.', '\\.')} is missing or unreadable(?:\\r?\\n|$)`));
    assert.doesNotMatch(result.stderr, /ENOENT|EISDIR|at file:/);
  });
}

test('the public runner refuses a macOS guide lost between its two reads', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz',
    documentsMode: 'complete', failSecondMacRead: true,
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /PASS  the receipt names this package's commit, byte count and digest/);
  assert.match(result.stderr, /FAIL  kit MACOS-FIELD-TEST\.md is missing or unreadable(?:\r?\n|$)/);
  assert.doesNotMatch(result.stderr, /ENOENT|EISDIR|at file:/);
});

test('the public runner refuses a root junction resolving outside extraction', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', rootMode: 'outside-link',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit extraction root resolves outside its extraction directory(?:\r?\n|$)/);
});

test('the public runner refuses a safe archive name resolving outside its root', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', archiveMode: 'outside-link',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit archive resolves outside the extracted root(?:\r?\n|$)/);
});

test('the public runner refuses a missing archive without a filesystem stack', () => {
  const result = runSyntheticKit({
    rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', archiveMode: 'missing',
  });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit archive is missing or unreadable(?:\r?\n|$)/);
  assert.doesNotMatch(result.stderr, /ENOENT|ERR_INVALID_ARG_TYPE/);
});

for (const receiptMode of ['missing', 'directory']) {
  test(`the public runner refuses a ${receiptMode} SHA256SUMS.txt without a filesystem stack`, () => {
    const result = runSyntheticKit({
      rootCount: 1, declaredName: 'brain-installer-9.8.6.tgz', receiptMode,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /FAIL  kit SHA256SUMS.txt is missing or unreadable(?:\r?\n|$)/);
    assert.doesNotMatch(result.stderr, /ENOENT|EISDIR/);
  });
}

test('the public runner refuses a broken root link without a filesystem stack', () => {
  const result = runSyntheticKit({ rootCount: 1, rootMode: 'broken-link' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /FAIL  kit ZIP extraction entry is missing or unreadable(?:\r?\n|$)/);
  assert.doesNotMatch(result.stderr, /ENOENT/);
});

// One release repository, asserted across every module that names one.
//
// This is the guard whose absence let two green suites contradict each other:
// worker/src/lib/update-status.js demanded financial-brain-installer while
// scripts/check-install-page-version.mjs demanded brain-installer, so NO stable
// manifest could satisfy both. Whichever URL was published, one side refused it,
// and nothing failed until the manifest was promoted. The worker's own test names
// the predecessor repo deliberately, as a source that must be REFUSED, so this
// reads the expected-asset host out of the worker rather than trusting a comment.
test('every module that names the release repository names the same one', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
  // Matches both github.com/OWNER/REPO and api.github.com/repos/OWNER/REPO.
  const hosts = (text) => [...text.matchAll(/github\.com\/(?:repos\/)?([A-Za-z0-9-]+\/[A-Za-z0-9-]+)/g)].map((m) => m[1]);

  // The worker is the authority: it is what a client's brain actually enforces.
  const worker = read('worker/src/lib/update-status.js');
  const expected = [...new Set(hosts(worker))];
  assert.equal(expected.length, 1, `the worker names ${expected.length} repositories: ${expected.join(', ')}`);
  const RELEASE_REPOSITORY = expected[0];

  // Every other surface a client or an operator can reach must agree with it.
  for (const file of [
    'scripts/check-install-page-version.mjs',
    'README.md',
    'tools/preflight.sh',
    'tools/preflight.ps1',
    'package.json',
  ]) {
    const named = [...new Set(hosts(read(file)))];
    for (const repo of named) {
      assert.equal(repo, RELEASE_REPOSITORY,
        `${file} names ${repo} but a client's brain only accepts ${RELEASE_REPOSITORY}; ` +
        'no published manifest can satisfy both, and the mismatch is invisible until release day');
    }
  }
});
