import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { checkInstallPage, ENDPOINTS, guideFields, validateDoorways, validatePublicManifest, verifyPublishedMetadata } from '../scripts/check-install-page-version.mjs';
const bytes = Buffer.from('synthetic reviewed package fixture\n');
const sha = createHash('sha256').update(bytes).digest('hex');
const commit = createHash('sha1').update('synthetic candidate commit').digest('hex');
const installGuide = `AGENT_INSTALL_CONTRACT_VERSION: 1
STATUS: supervised field-test candidate
TARGET: physical Windows 10 or newer
OWNER_PRESENT: required
SETUP_PAGE: https://financialbrain.ai/operator
ARTIFACT_URL: https://financialbrain.ai/operator/financial-brain-v9.8.6-operator-windows-field-test-${sha.slice(0, 16)}.zip
ARTIFACT_BYTES: ${bytes.length}
ARTIFACT_SHA256: ${sha}
CANDIDATE_VERSION: 9.8.6
CANDIDATE_COMMIT: ${commit}
`;
const held = (state = 'held') => ({ schema_version: 2, release_state: state, available: false, release: null, published_at: null,
  update_url: 'https://financialbrain.ai/update', installer: null, changes: [], held_reason: 'Synthetic field evidence pending.',
  proof: { archive_release_gate: 'not_passed', automated_release_suite: 'pending', live_client_acceptance: 'required' } });
const stable = () => ({ ...held('stable'), available: true, release: '9.8.7', published_at: '2026-09-06', held_reason: null,
  installer: { url: 'https://github.com/guldanjaMAX/brain-installer/releases/download/v9.8.7/brain-installer-9.8.7.tgz', sha256: sha, bytes: bytes.length },
  proof: { archive_release_gate: 'passed', automated_release_suite: 'passed', live_client_acceptance: 'required' } });
const guide = (state) => `AGENT_UPDATE_CONTRACT_VERSION: 1\nRELEASE_STATE: ${state}\nPERMITTED_MODE: ${state === 'stable' ? 'guided-update-after-release-and-owner-checks' : 'read-only-diagnosis'}\nPAGE_URL: https://financialbrain.ai/update\nRELEASE_MANIFEST: ${ENDPOINTS.manifest}\n`;
const release = () => ({ tag_name: 'v9.8.7', draft: false, prerelease: false, immutable: true,
  assets: ['brain-installer-9.8.7.tgz', 'brain-installer.tgz'].map((name) => ({ name, size: bytes.length, digest: `sha256:${sha}`, state: 'uploaded' })) });
function reader(manifest, overrides = {}) {
  const values = { [ENDPOINTS.manifest]: Buffer.from(JSON.stringify(manifest)), [ENDPOINTS.updateGuide]: Buffer.from(guide(manifest.release_state)),
    [ENDPOINTS.installGuide]: Buffer.from(installGuide), [ENDPOINTS.latest]: Buffer.from(JSON.stringify(release())),
    ...(manifest.installer ? { [manifest.installer.url]: bytes } : {}), ...overrides };
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
  for (const mutation of [{ available: true }, { release: '9.8.7' }, { installer: stable().installer }, { held_reason: '' }, { changes: ['shipped'] }, { proof: stable().proof }]) {
    assert.throws(() => validatePublicManifest({ ...held(), ...mutation }));
  }
});
test('stable requires exact immutable receipt, independent bytes, and matching guide', async () => {
  assert.deepEqual(await checkInstallPage(reader(stable())), { state: 'stable', publicRelease: '9.8.7', supervisedCandidate: '9.8.6', promotionAllowed: true, artifactVerified: true });
  await assert.rejects(checkInstallPage(reader(stable(), { [stable().installer.url]: Buffer.from('wrong archive') })), /archive differs/);
  await assert.rejects(checkInstallPage(reader(stable(), { [ENDPOINTS.updateGuide]: Buffer.from(guide('held')) })), /disagree/);
});
test('stable metadata rejects malformed date, digest, size, URL, schema, and state', () => {
  for (const mutation of [{ schema_version: 1 }, { release_state: 'unknown' }, { available: false }, { release: 'latest' }, { published_at: '2026-02-30' }, { held_reason: 'held' }, { update_url: 'https://example.invalid/update' }]) {
    assert.throws(() => validatePublicManifest({ ...stable(), ...mutation }));
  }
  for (const mutation of [{ url: 'https://example.invalid/package.tgz' }, { sha256: 'bad' }, { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }]) {
    assert.throws(() => validatePublicManifest({ ...stable(), installer: { ...stable().installer, ...mutation } }));
  }
});
test('latest mutable, different-version, incomplete, and mismatched assets all refuse', () => {
  for (const mutation of [{ immutable: false }, { draft: true }, { prerelease: true }, { tag_name: 'v9.8.6' }, { assets: [] }, { assets: [release().assets[0], release().assets[0]] }]) {
    assert.throws(() => verifyPublishedMetadata(stable(), { ...release(), ...mutation }));
  }
  for (const field of [{ size: 1 }, { digest: 'sha256:wrong' }, { state: 'new' }]) {
    const data = release(); Object.assign(data.assets[0], field); assert.throws(() => verifyPublishedMetadata(stable(), data));
  }
});
test('duplicate fields, missing owner, swapped candidate URL, or update permission drift refuse', () => {
  assert.throws(() => guideFields('RELEASE_STATE: held\nRELEASE_STATE: stable\n'), /duplicate/);
  for (const bad of [installGuide.replace('OWNER_PRESENT: required', 'OWNER_PRESENT: optional'), installGuide.replace('/operator/financial-', '/install/financial-'), installGuide.replace('CANDIDATE_VERSION: 9.8.6', 'CANDIDATE_VERSION: latest')]) {
    assert.throws(() => validateDoorways({ manifest: held(), updateGuide: guide('held'), installGuide: bad }));
  }
  assert.throws(() => validateDoorways({ manifest: held(), installGuide, updateGuide: guide('held').replace('read-only-diagnosis', 'guided-update-after-release-and-owner-checks') }), /wrong operation/);
});
test('transport and unreadable metadata fail closed', async () => {
  await assert.rejects(checkInstallPage({ read: async () => { throw new Error('synthetic unavailable'); } }), /unavailable/);
  await assert.rejects(checkInstallPage(reader(held(), { [ENDPOINTS.manifest]: Buffer.from('not json') })));
});
