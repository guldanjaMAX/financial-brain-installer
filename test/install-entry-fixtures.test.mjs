import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ENDPOINTS, readInstallDoorwayContract, readSupervisedInstallContract,
  validateDoorways, validatePublicManifest, validateSupervisedInstallContract,
} from '../scripts/check-install-page-version.mjs';
import { expectedSupervisedGuideUrl } from '../scripts/supervised-install-guide-oracle.mjs';
import {
  createRuntimeIdentityReceipt, runtimeIdentityReceiptBytes, verifyRuntimeIdentityArtifact,
} from '../scripts/runtime-identity-receipt.mjs';

const root = new URL('./fixtures/install-entry-v3/', import.meta.url);
const bytes = (name) => readFileSync(new URL(name, root));
const json = (name) => JSON.parse(bytes(name));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const stable = json('stable-update-manifest-v2.json');
const held = json('held-update-manifest.json');
const expected = {
  sourceSha: stable.runtime_identity.source_sha,
  packageFilename: 'brain-installer-0.4.10.tgz', packageVersion: stable.release,
  packageBytes: stable.installer.bytes, packageFileCount: stable.runtime_identity.package_file_count,
  packageSha256: stable.installer.sha256, identityScheme: stable.runtime_identity.identity_scheme,
  runtimePayloadSha256: stable.runtime_identity.runtime_payload_sha256,
};
function verify(raw, expectation = expected) {
  return verifyRuntimeIdentityArtifact({ bytes: raw, artifactSha256: hash(raw),
    artifactBytes: raw.length, expected: expectation });
}
function reader(platform, manifest, guide) {
  const calls = [];
  const guideUrl = expectedSupervisedGuideUrl(platform);
  return { calls, platform, read: async (url, limit) => {
    calls.push({ url, limit });
    if (url === ENDPOINTS.manifest) return Buffer.from(JSON.stringify(manifest));
    if (url === guideUrl) return guide;
    throw new Error('unexpected synthetic read');
  } };
}

test('IC-03: actual package validators accept the shared schema-2 update and schema-1 receipt', () => {
  assert.equal(validatePublicManifest(held), held);
  assert.equal(validatePublicManifest(stable), stable);
  const raw = bytes('runtime-identity-v1.json');
  assert.equal(hash(raw), stable.runtime_identity.sha256);
  assert.equal(raw.length, stable.runtime_identity.bytes);
  assert.deepEqual(runtimeIdentityReceiptBytes(createRuntimeIdentityReceipt(expected)), raw);
  assert.equal(verify(raw).schema_version, 1);
});

test('IC-03: schema 2, unknown fields and noncanonical encoding reach the real receipt parser and refuse', () => {
  const raw = bytes('runtime-identity-v1.json');
  const receipt = verify(raw);
  assert.equal(receipt.schema_version, 1, 'green control reaches actual schema decision');
  const arms = [
    [bytes('unsupported-runtime-identity-v2.json'), 'RUNTIME_IDENTITY_RECEIPT_SCHEMA_INVALID'],
    [Buffer.from(JSON.stringify({ ...receipt, extra: null })), 'RUNTIME_IDENTITY_RECEIPT_SCHEMA_INVALID'],
    [Buffer.from(JSON.stringify(receipt)), 'RUNTIME_IDENTITY_RECEIPT_ENCODING_INVALID'],
    [Buffer.from(raw.toString().trimEnd()), 'RUNTIME_IDENTITY_RECEIPT_ENCODING_INVALID'],
  ];
  for (const [changed, code] of arms) {
    assert.notDeepEqual(changed, raw, 'mutation is nonempty');
    let decisions = 0;
    assert.throws(() => { decisions++; verify(changed); }, { code });
    assert.equal(decisions, 1, 'real verifier invoked with matching raw hash and length');
  }
});

test('IC-03: all package binding fields are independently enforced after the raw byte gate', () => {
  const raw = bytes('runtime-identity-v1.json');
  assert.equal(verify(raw).package_version, stable.release);
  for (const [key, value] of Object.entries(expected)) {
    const changed = { ...expected, [key]: typeof value === 'number' ? value + 1 : `${value}x` };
    assert.notDeepEqual(changed, expected);
    let decisions = 0;
    assert.throws(() => { decisions++; verify(raw, changed); }, { code: 'RUNTIME_IDENTITY_EXPECTATION_MISMATCH' });
    assert.equal(decisions, 1, key);
  }
});

for (const platform of ['windows', 'macos']) {
  test(`IC-04 current ${platform}: held bytes survive exactly, changes refuse at the guide decision`, async () => {
    const guide = bytes('held-install.txt');
    const control = reader(platform, held, guide);
    const result = await readInstallDoorwayContract(control);
    assert.equal(result.state, 'held');
    assert.equal(result.guide, guide.toString());
    assert.deepEqual(control.calls.map(({ url }) => url), [ENDPOINTS.manifest, expectedSupervisedGuideUrl(platform)]);
    for (const changed of [Buffer.from(guide.toString().trimEnd()), Buffer.concat([guide, Buffer.from('\n')]), bytes('open-install.html')]) {
      const arm = reader(platform, held, changed);
      await assert.rejects(readInstallDoorwayContract(arm), /invalid held install contract/);
      assert.deepEqual(arm.calls, control.calls, 'same actual manifest and guide decision reached; no artifact');
    }
  });

  test(`IC-04 current ${platform}: real legacy reader downloads verified synthetic bytes and rejects future HTML`, async () => {
    const guide = bytes(`legacy-${platform}-v2.md`);
    const parsed = validateSupervisedInstallContract(guide.toString(), { platform });
    const artifact = Buffer.from('NONEXECUTABLE synthetic package fixture\n');
    const calls = [];
    const result = await readSupervisedInstallContract({ platform, read: async (url, limit) => {
      calls.push({ url, limit });
      if (url === expectedSupervisedGuideUrl(platform)) return guide;
      assert.equal(url, parsed.artifactUrl);
      return artifact;
    } });
    assert.deepEqual(result.artifact, artifact);
    assert.deepEqual(calls.map(({ url }) => url), [expectedSupervisedGuideUrl(platform), parsed.artifactUrl]);
    const refused = [];
    await assert.rejects(readSupervisedInstallContract({ platform, read: async (url) => {
      refused.push(url); return bytes('open-install.html');
    } }), /AGENT_INSTALL_CONTRACT_VERSION/);
    assert.deepEqual(refused, [expectedSupervisedGuideUrl(platform)], 'real guide fetch precedes refusal');
  });
}

test('IC-04 current: stable updates with a separately held install still refuse, so compatibility remains deferred', async () => {
  const input = { manifest: stable, updateGuide: bytes('stable-update-guide.md').toString(),
    installGuide: bytes('legacy-windows-v2.md').toString() };
  assert.equal(validateDoorways(input).supervisedCandidate, '0.4.10', 'green release and guide control');
  assert.throws(() => validateDoorways({ ...input, installGuide: bytes('held-install.txt').toString() }), /AGENT_INSTALL_CONTRACT_VERSION/);
  const arm = reader('windows', stable, bytes('held-install.txt'));
  await assert.rejects(readInstallDoorwayContract(arm), /AGENT_INSTALL_CONTRACT_VERSION/);
  assert.equal(arm.calls.length, 2, 'both release and held guide fetched before refusal');
});

test('shared fixture approvals bind exact HTML bytes and canonical unsigned manifest, with nine separate receipts', () => {
  const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
      : JSON.stringify(value);
  const { approval, ...unsigned } = json('open-install-manifest.json');
  assert.equal(hash(canonical(unsigned)), approval.manifestSha256);
  assert.equal(hash(bytes('open-install.html')), approval.documentSha256);
  assert.equal(Object.keys(unsigned.evidence).length, 9);
  assert.equal(new Set(Object.values(unsigned.evidence)).size, 9);
  assert.deepEqual(json('held-install-manifest.json'), {
    schema_version: 3, entry_state: 'held', release: null, artifacts: null, evidence: null, approval: null,
  });
});
