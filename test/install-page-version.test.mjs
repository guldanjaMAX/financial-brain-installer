import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
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
const installGuide = `AGENT_INSTALL_CONTRACT_VERSION: 2
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

function assertMessage(run, message, forbidden = null) {
  assert.throws(run, (error) => {
    assert.equal(error.message, message);
    if (forbidden) assert.doesNotMatch(error.message, forbidden);
    return true;
  });
}

test('supervised install contract version 2 is the one accepted contract', () => {
  assert.equal(validateSupervisedInstallContract(installGuide).candidateCommit, commit);
  assertMessage(
    () => validateSupervisedInstallContract(
      installGuide.replace('AGENT_INSTALL_CONTRACT_VERSION: 2', 'AGENT_INSTALL_CONTRACT_VERSION: 3'),
    ),
    'unrecognized supervised install contract: AGENT_INSTALL_CONTRACT_VERSION',
  );
});

test('wrong-platform guides name only the TARGET field in both directions', () => {
  assert.throws(
    () => validateSupervisedInstallContract(macosInstallGuide, { platform: 'windows' }),
    /unrecognized supervised install contract: TARGET/,
  );
  assert.throws(
    () => validateSupervisedInstallContract(installGuide, { platform: 'macos' }),
    /unrecognized supervised install contract: TARGET/,
  );
});

test('every supervised install boundary names only its bounded field', () => {
  const mutations = [
    ['STATUS', installGuide.replace('STATUS: supervised field-test candidate', 'STATUS: private-untrusted-value')],
    ['OWNER_PRESENT', installGuide.replace('OWNER_PRESENT: required', 'OWNER_PRESENT: private-untrusted-value')],
    ['TARGET', installGuide.replace('TARGET: physical Windows 10 or newer', 'TARGET: private-untrusted-value')],
    ['SETUP_PAGE', installGuide.replace(/^SETUP_PAGE:.*\n/m, '')],
  ];
  for (const [field, guideText] of mutations) {
    assertMessage(
      () => validateSupervisedInstallContract(guideText),
      `unrecognized supervised install contract: ${field}`,
      /private-untrusted-value/,
    );
  }
});

test('a malformed setup page has a named value-free refusal', () => {
  const untrusted = 'private-untrusted-setup-value';
  const malformed = installGuide.replace('https://financialbrain.ai/operator', untrusted);
  assertMessage(
    () => validateSupervisedInstallContract(malformed),
    'invalid supervised setup URL',
    new RegExp(untrusted),
  );
});
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
