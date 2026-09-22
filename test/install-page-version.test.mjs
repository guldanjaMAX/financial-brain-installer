import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { runInNewContext } from 'node:vm';
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
  expectedSupervisedGuideUrl,
  matchesExpectedSupervisedGuideUrl,
} from '../scripts/supervised-install-guide-oracle.mjs';
import {
  createRuntimeIdentityReceipt,
  runtimeIdentityReceiptBytes,
} from '../scripts/runtime-identity-receipt.mjs';
const WINDOWS_INSTALL_GUIDE_URL = expectedSupervisedGuideUrl('windows');
const MACOS_INSTALL_GUIDE_URL = expectedSupervisedGuideUrl('macos');
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

// These are the published field lines as read on 2026-09-21, not byte-for-byte
// captures. The public reader extracts text, and this validator deliberately
// parses only NAME: value lines while ignoring all other page content.
const publishedWindowsFieldLines = `AGENT_INSTALL_CONTRACT_VERSION: 2
STATUS: supervised field-test candidate
TARGET: physical Windows 10 or newer
OWNER_PRESENT: required
SETUP_PAGE: https://financialbrain.ai/kit
ARTIFACT_URL: https://financialbrain.ai/kit/financial-brain-v0.4.6-field-kit-f6d48781ca11e8e8.zip
ARTIFACT_BYTES: 5550455
ARTIFACT_SHA256: f6d48781ca11e8e8f677c74bd72f5444d7e1047ba3fd180733db358a143bb9c5
CANDIDATE_VERSION: 0.4.6
CANDIDATE_COMMIT: c4b44bd411a6bb901ceb652f1a6b694765782165
MACOS_RUNBOOK: https://financialbrain.ai/install/agent-macos.md
EXISTING_BRAIN_RUNBOOK: https://financialbrain.ai/install/agent-update.md
`;
const publishedMacosFieldLines = `AGENT_INSTALL_CONTRACT_VERSION: 2
STATUS: supervised field-test candidate
TARGET: macOS 13 or newer, Apple silicon or Intel
OWNER_PRESENT: required
SETUP_PAGE: https://financialbrain.ai/kit
ARTIFACT_URL: https://financialbrain.ai/kit/financial-brain-v0.4.6-field-kit-f6d48781ca11e8e8.zip
ARTIFACT_BYTES: 5550455
ARTIFACT_SHA256: f6d48781ca11e8e8f677c74bd72f5444d7e1047ba3fd180733db358a143bb9c5
PACKAGE: brain-installer-0.4.6.tgz
PACKAGE_BYTES: 5545076
PACKAGE_SHA256: 3e8afa545daac704220509336812dd9c2786c4a6b6a07ef2089a618c29cce920
MACOS_GUIDE: MACOS-FIELD-TEST.md (inside the archive)
MACOS_GUIDE_SHA256: 6db7f1b605e0cb75fd42712f71a9a10aecc90718c9082c96dc024a0380a2317f
SMOKE_DOCUMENT: package/CHANGELOG.md
SMOKE_DOCUMENT_SHA256: ed6d7049e59ca6beaf51c06bd4738a8c1fdc461282c7073eb661c5c8f46fcc00
CANDIDATE_VERSION: 0.4.6
CANDIDATE_COMMIT: c4b44bd411a6bb901ceb652f1a6b694765782165
WINDOWS_RUNBOOK: https://financialbrain.ai/install/agent.md
EXISTING_BRAIN_RUNBOOK: https://financialbrain.ai/install/agent-update.md
`;

const contractFailure = (reason) => { throw new Error(`safe-error-contract:${reason}`); };

function errorSurface(error) {
  const parts = [];
  const seen = new WeakSet();
  const append = (value) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') { parts.push(value); return; }
    if (typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'number' ||
        typeof value === 'boolean') {
      parts.push(String(value));
      return;
    }
    if (typeof value === 'function') {
      parts.push(Function.prototype.toString.call(value));
      return;
    }
    if (ArrayBuffer.isView(value)) {
      parts.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('utf8'));
      const bytesPerElement = Number(value.BYTES_PER_ELEMENT);
      const elementCount = Number(value.length);
      if ([1, 2, 4, 8].includes(bytesPerElement) && Number.isSafeInteger(elementCount) && elementCount >= 0) {
        parts.push(Array.from(value, (element) => {
          const codePoint = Number(element);
          return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : '\uFFFD';
        }).join(''));
      }
      return;
    }
    if (value instanceof ArrayBuffer) {
      parts.push(Buffer.from(value).toString('utf8'));
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      parts.push(String(key));
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, 'value')) append(descriptor.value);
    }
  };
  try {
    append(error);
    for (const key of ['message', 'stack', 'cause', 'input', 'code']) append(error?.[key]);
    // Node's runner renders thrown values through a util.inspect-like surface.
    parts.push(inspect(error, { depth: null, getters: false, showHidden: true }));
  } catch {
    contractFailure('uninspectable-surface');
  }
  return parts.join('\n');
}

function surfaceMatches(surface, forbidden) {
  if (typeof forbidden === 'string') return surface.includes(forbidden);
  const flags = forbidden.flags.replace(/[gy]/g, '');
  return new RegExp(forbidden.source, flags).test(surface);
}

function assertMessage(run, message, forbidden = null) {
  let error;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  if (!error) contractFailure('did-not-throw');
  if (error.message !== message) contractFailure('message-mismatch');
  if (forbidden && surfaceMatches(errorSurface(error), forbidden)) {
    contractFailure('unsafe-error-surface');
  }
}

function assertGuardFailure(run, reason, message) {
  assert.throws(run, (error) => error?.message === `safe-error-contract:${reason}`, message);
}

test('supervised install contract version 2 is the one accepted contract', () => {
  assert.equal(validateSupervisedInstallContract(installGuide, { platform: 'windows' }).candidateCommit, commit);
  for (const version of ['1', '3']) {
    assertMessage(
      () => validateSupervisedInstallContract(
        installGuide.replace('AGENT_INSTALL_CONTRACT_VERSION: 2', `AGENT_INSTALL_CONTRACT_VERSION: ${version}`),
        { platform: 'windows' },
      ),
      'unrecognized supervised install contract: AGENT_INSTALL_CONTRACT_VERSION',
    );
  }
});

test('wrong-platform guides name only the TARGET field in both directions', () => {
  assertMessage(
    () => validateSupervisedInstallContract(macosInstallGuide, { platform: 'windows' }),
    'unrecognized supervised install contract: TARGET',
  );
  assertMessage(
    () => validateSupervisedInstallContract(installGuide, { platform: 'macos' }),
    'unrecognized supervised install contract: TARGET',
  );
});

test('the exact-message and surface guards reject a collapsed diagnostic or leaked value', () => {
  assertGuardFailure(
    () => assertMessage(
      () => { throw new Error('unrecognized supervised install contract: TARGET'); },
      'unrecognized supervised install contract: STATUS',
    ),
    'message-mismatch',
  );
  const leaked = new Error('unrecognized supervised install contract: TARGET');
  leaked.input = 'private-untrusted-value';
  assertGuardFailure(
    () => assertMessage(
      () => { throw leaked; },
      'unrecognized supervised install contract: TARGET',
      /private-untrusted-value/,
    ),
    'unsafe-error-surface',
  );
});

test('supervised install validation requires the caller to state its platform', () => {
  assertMessage(
    () => validateSupervisedInstallContract(installGuide),
    'unsupported supervised install platform',
  );
});

test('the leak guard inspects covered error surfaces and runner rendering', () => {
  const message = 'invalid supervised setup URL';
  const marker = 'private-untrusted-error-surface';
  const errors = [];
  errors.push(new Error(message, { cause: new TypeError(`URL rejected ${marker}`) }));
  errors.push(Object.assign(new Error(message), { input: marker }));
  errors.push(Object.assign(new Error(message), { code: marker }));
  const stacked = new Error(message); stacked.stack = `Error: ${message}\n    at ${marker}`; errors.push(stacked);
  const nested = new Error(message); nested.details = { value: marker }; errors.push(nested);
  const hidden = new Error(message); Object.defineProperty(hidden, 'detail', { value: marker }); errors.push(hidden);
  const buffered = new Error(message); buffered.payload = Buffer.from(marker); errors.push(buffered);
  const inspected = new Error(message);
  inspected[inspect.custom] = () => `runner rendering ${marker}`;
  errors.push(inspected);
  for (const error of errors) {
    assertGuardFailure(
      () => assertMessage(() => { throw error; }, message, new RegExp(marker)),
      'unsafe-error-surface',
    );
  }
  const typedArrayTypes = [
    ['Uint8Array', Uint8Array, false],
    ['Uint8ClampedArray', Uint8ClampedArray, false],
    ['Int8Array', Int8Array, false],
    ['Uint16Array', Uint16Array, false],
    ['Int16Array', Int16Array, false],
    ['Uint32Array', Uint32Array, false],
    ['Int32Array', Int32Array, false],
    ['Float32Array', Float32Array, false],
    ['Float64Array', Float64Array, false],
    ['BigInt64Array', BigInt64Array, true],
    ['BigUint64Array', BigUint64Array, true],
  ];
  if (typeof Float16Array === 'function') typedArrayTypes.push(['Float16Array', Float16Array, false]);
  for (const [name, TypedArray, usesBigInt] of typedArrayTypes) {
    const encoded = TypedArray.from(marker, (character) => usesBigInt
      ? BigInt(character.charCodeAt(0))
      : character.charCodeAt(0));
    const error = new Error(message);
    error.payload = encoded;
    assertGuardFailure(
      () => assertMessage(() => { throw error; }, message, new RegExp(marker)),
      'unsafe-error-surface',
      name,
    );
  }
  const crossRealm = new Error(message);
  crossRealm.payload = runInNewContext(
    'Uint16Array.from(marker, (character) => character.charCodeAt(0))',
    { marker },
  );
  assertGuardFailure(
    () => assertMessage(() => { throw crossRealm; }, message, new RegExp(marker)),
    'unsafe-error-surface',
    'cross-realm Uint16Array',
  );
  const dataViewBytes = Uint8Array.from(marker, (character) => character.charCodeAt(0));
  const dataView = new Error(message);
  dataView.payload = new DataView(dataViewBytes.buffer, dataViewBytes.byteOffset, dataViewBytes.byteLength);
  assertGuardFailure(
    () => assertMessage(() => { throw dataView; }, message, new RegExp(marker)),
    'unsafe-error-surface',
    'DataView raw bytes',
  );
});

test('the leak guard fails closed when an error surface cannot be inspected', () => {
  const message = 'invalid supervised setup URL';
  const throwingStack = new Error(message);
  Object.defineProperty(throwingStack, 'stack', {
    configurable: true,
    get() { throw new Error('synthetic stack refusal'); },
  });
  const throwingRenderer = new Error(message);
  throwingRenderer[inspect.custom] = () => { throw new Error('synthetic renderer refusal'); };
  for (const error of [throwingStack, throwingRenderer]) {
    assertGuardFailure(
      () => assertMessage(() => { throw error; }, message, /private-untrusted-value/),
      'uninspectable-surface',
    );
  }
});

test('the supplied published field lines validate unchanged on their own platforms', () => {
  const windows = validateSupervisedInstallContract(publishedWindowsFieldLines, { platform: 'windows' });
  const macos = validateSupervisedInstallContract(publishedMacosFieldLines, { platform: 'macos' });
  assert.equal(windows.guideUrl, WINDOWS_INSTALL_GUIDE_URL);
  assert.equal(macos.guideUrl, MACOS_INSTALL_GUIDE_URL);
  assert.equal(windows.candidateVersion, '0.4.6');
  assert.equal(macos.candidateVersion, '0.4.6');
});

test('install guide URLs exist only in the supervised platform selector', () => {
  assert.equal(Object.hasOwn(ENDPOINTS, 'installGuide'), false);
  assert.equal(Object.hasOwn(ENDPOINTS, 'installGuideMacos'), false);
  assert.equal(
    validateSupervisedInstallContract(installGuide, { platform: 'windows' }).guideUrl,
    WINDOWS_INSTALL_GUIDE_URL,
  );
  assert.equal(
    validateSupervisedInstallContract(macosInstallGuide, { platform: 'macos' }).guideUrl,
    MACOS_INSTALL_GUIDE_URL,
  );
});

test('prototype property names are unsupported caller platforms', () => {
  for (const platform of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf']) {
    assertMessage(
      () => validateSupervisedInstallContract(installGuide, { platform }),
      'unsupported supervised install platform',
    );
  }
});

test('every supervised install boundary names only its bounded field', () => {
  const mutations = [
    ['AGENT_INSTALL_CONTRACT_VERSION', installGuide.replace(
      'AGENT_INSTALL_CONTRACT_VERSION: 2', 'AGENT_INSTALL_CONTRACT_VERSION: private-untrusted-value')],
    ['STATUS', installGuide.replace('STATUS: supervised field-test candidate', 'STATUS: private-untrusted-value')],
    ['OWNER_PRESENT', installGuide.replace('OWNER_PRESENT: required', 'OWNER_PRESENT: private-untrusted-value')],
    ['TARGET', installGuide.replace('TARGET: physical Windows 10 or newer', 'TARGET: private-untrusted-value')],
    ['SETUP_PAGE', installGuide.replace(
      /^SETUP_PAGE:.*\n/m, 'UNTRUSTED_CONTEXT: private-untrusted-value\n')],
  ];
  for (const [field, guideText] of mutations) {
    assertMessage(
      () => validateSupervisedInstallContract(guideText, { platform: 'windows' }),
      `unrecognized supervised install contract: ${field}`,
      /private-untrusted-value/,
    );
  }
});

test('the leak guard recognizes uppercase field-name payloads in parser diagnostics', () => {
  const marker = `PRIVATE_${'X'.repeat(4_992)}`;
  assert.equal(marker.length, 5_000);
  for (const [text, message] of [
    [`${marker}:\n`, `malformed guide field ${marker}`],
    [`${marker}: one\n${marker}: two\n`, `duplicate guide field ${marker}`],
  ]) {
    assertGuardFailure(
      () => assertMessage(() => guideFields(text), message, marker),
      'unsafe-error-surface',
    );
  }
});

test('a malformed setup page has a named value-free refusal', () => {
  const untrusted = 'private-untrusted-setup-value';
  const malformed = installGuide.replace('https://financialbrain.ai/operator', untrusted);
  assertMessage(
    () => validateSupervisedInstallContract(malformed, { platform: 'windows' }),
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
    [WINDOWS_INSTALL_GUIDE_URL]: Buffer.from(installGuide), [ENDPOINTS.latest]: Buffer.from(JSON.stringify(release())),
    ...(manifest.installer ? { [manifest.installer.url]: bytes } : {}),
    ...(manifest.runtime_identity ? { [manifest.runtime_identity.url]: runtimeBytes } : {}),
    ...overrides };
  const calls = [];
  return { calls, read: async (url) => { calls.push(url); assert.ok(Object.hasOwn(values, url), 'unexpected request'); return values[url]; } };
}
test('the independent supervised-guide oracle pins both public guide URLs', () => {
  const cases = [
    ['windows', 'https://financialbrain.ai/install/agent.md', 'https://financialbrain.ai/install/agent-macos.md'],
    ['macos', 'https://financialbrain.ai/install/agent-macos.md', 'https://financialbrain.ai/install/agent.md'],
  ];
  for (const [platform, literalUrl, otherPlatformUrl] of cases) {
    assert.equal(expectedSupervisedGuideUrl(platform), literalUrl, platform);
    assert.equal(matchesExpectedSupervisedGuideUrl(platform, literalUrl), true, platform);
    for (const confusedUrl of [
      otherPlatformUrl,
      literalUrl.replace('financialbrain.ai', 'attacker.invalid'),
      literalUrl.replace('https:', 'http:'),
      `${literalUrl}/extra`,
      `${literalUrl}?candidate=other`,
      `${literalUrl}#other`,
      'https://financialbrain.ai/install/not-the-guide.md',
    ]) {
      assert.equal(matchesExpectedSupervisedGuideUrl(platform, confusedUrl), false,
        `${platform} must reject ${confusedUrl}`);
    }
  }
  assert.equal(expectedSupervisedGuideUrl('constructor'), null);
  assert.equal(matchesExpectedSupervisedGuideUrl('constructor', 'https://financialbrain.ai/install/agent.md'), false);
  const oracleSource = readFileSync(
    new URL('../scripts/supervised-install-guide-oracle.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(oracleSource, /^\s*import(?:\s|["'{*])/m, 'oracle must have no static imports');
  assert.doesNotMatch(oracleSource, /\bimport\s*\(/, 'oracle must have no dynamic imports');
  assert.doesNotMatch(oracleSource, /\bENDPOINTS\b/, 'oracle must not derive its pins from ENDPOINTS');
});
test('release health fetches the Windows install guide selected by the shared platform table', async () => {
  const io = reader(held());
  await checkInstallPage(io);
  assert.deepEqual(io.calls, [
    ENDPOINTS.manifest,
    ENDPOINTS.updateGuide,
    'https://financialbrain.ai/install/agent.md',
  ]);
});
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
  assert.equal(validateSupervisedInstallContract(installGuide, { platform: 'windows' }).candidateCommit, commit);
  assert.equal(validateSupervisedInstallContract(macosInstallGuide, { platform: 'macos' }).guideUrl,
    MACOS_INSTALL_GUIDE_URL);
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
          if (url === WINDOWS_INSTALL_GUIDE_URL) return Buffer.from(badGuide);
          throw new Error('artifact download must not start');
        },
      }),
      undefined,
      label,
    );
    assert.deepEqual(calls, [{ url: WINDOWS_INSTALL_GUIDE_URL, limit: 200_000 }], label);
  }
});
test('each platform reader fetches its selected guide and only its validated bounded artifact', async () => {
  for (const { platform, guideUrl, guide } of [
    { platform: 'windows', guideUrl: WINDOWS_INSTALL_GUIDE_URL, guide: installGuide },
    { platform: 'macos', guideUrl: MACOS_INSTALL_GUIDE_URL, guide: macosInstallGuide },
  ]) {
    const calls = [];
    const artifactUrl = validateSupervisedInstallContract(guide, { platform }).artifactUrl;
    const result = await readSupervisedInstallContract({
      platform,
      read: async (url, limit) => {
        calls.push({ url, limit });
        if (calls.length === 1) return Buffer.from(guide);
        if (url === artifactUrl) return bytes;
        throw new Error('unexpected URL');
      },
    });
    assert.deepEqual(calls, [
      { url: guideUrl, limit: 200_000 },
      { url: result.artifactUrl, limit: bytes.length },
    ], platform);
    assert.equal(result.guideUrl, calls[0].url, platform);
    assert.deepEqual(result.artifact, bytes, platform);
  }
});

test('the public install runner uses the independent platform oracle before extraction', async () => {
  const source = readFileSync(new URL('../scripts/install-from-public-contract.mjs', import.meta.url), 'utf8');
  assert.match(source,
    /import \{ matchesExpectedSupervisedGuideUrl \} from "\.\/supervised-install-guide-oracle\.mjs";/);
  assert.doesNotMatch(source, /\bENDPOINTS\b/);
  assert.match(source, /ok\(`contract read from \$\{publicContract\.guideUrl\}`\);/);
  const downloadAt = source.indexOf('const publicContract = await readSupervisedInstallContract({ platform: guideArg });');
  const oracleAt = source.indexOf(
    'if (!matchesExpectedSupervisedGuideUrl(guideArg, publicContract.guideUrl))',
  );
  const writeAt = source.indexOf('mkdirSync(workdir, { recursive: true });');
  assert.ok(downloadAt >= 0 && oracleAt > downloadAt && writeAt > oracleAt,
    'guide oracle must run after both downloads and before filesystem extraction or execution');
});

test('a runner guide mismatch stops before filesystem or command execution', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'brain-runner-guide-mismatch-'));
  const bootstrapPath = join(fixtureRoot, 'bootstrap.mjs');
  const hooksPath = join(fixtureRoot, 'hooks.mjs');
  const workdir = join(fixtureRoot, 'runner-workdir');
  const executionMarker = join(fixtureRoot, 'exec-was-called.txt');
  const runnerUrl = new URL('../scripts/install-from-public-contract.mjs', import.meta.url).href;
  const runnerPath = fileURLToPath(runnerUrl);
  const emptySha256 = createHash('sha256').update(Buffer.alloc(0)).digest('hex');
  const contractSource = `
    export async function readSupervisedInstallContract() {
      return Object.freeze({
        guideUrl: 'https://financialbrain.ai/install/agent-macos.md',
        artifactBytes: 0,
        artifactSha256: '${emptySha256}',
        candidateVersion: '9.8.6',
        candidateCommit: '${'a'.repeat(40)}',
        artifact: Buffer.alloc(0),
      });
    }
  `;
  // A loader-hook stub is an ALLOWLIST of the module surface the runner imports.
  // An ESM named import is resolved at LINK time, so an export missing here kills
  // the runner before any of its own guards run, and every containment proof in
  // this file turns into a link error that still looks like a refusal. ADDING AN
  // IMPORT TO THE RUNNER IS A FIXTURE CHANGE: mirror it in both stubs.
  // spawn must mark and throw exactly as execFileSync does, so that asserting the
  // marker is absent means "no command ran", not "no execFileSync ran".
  const childProcessSource = `
    import { writeFileSync } from 'node:fs';
    function refuseExecution() {
      writeFileSync(${JSON.stringify(executionMarker)}, 'called');
      throw new Error('synthetic command execution boundary');
    }
    export function execFileSync() { return refuseExecution(); }
    export function spawn() { return refuseExecution(); }
  `;
  const hooksSource = `
    const runnerUrl = ${JSON.stringify(runnerUrl)};
    const contractSource = ${JSON.stringify(contractSource)};
    const childProcessSource = ${JSON.stringify(childProcessSource)};
    export async function resolve(specifier, context, nextResolve) {
      if (context.parentURL === runnerUrl && specifier === './check-install-page-version.mjs') {
        return { url: 'd9f:contract', shortCircuit: true };
      }
      if (context.parentURL === runnerUrl && specifier === 'node:child_process') {
        return { url: 'd9f:child-process', shortCircuit: true };
      }
      return nextResolve(specifier, context);
    }
    export async function load(url, context, nextLoad) {
      if (url === 'd9f:contract') {
        return { format: 'module', source: contractSource, shortCircuit: true };
      }
      if (url === 'd9f:child-process') {
        return { format: 'module', source: childProcessSource, shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  `;
  writeFileSync(hooksPath, hooksSource);
  writeFileSync(bootstrapPath, `
    import { register } from 'node:module';
    register(new URL('./hooks.mjs', import.meta.url), import.meta.url);
  `);
  try {
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(bootstrapPath).href,
      runnerPath,
      workdir,
      '--guide', 'windows',
    ], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /FAIL  strict contract reader selected the wrong platform guide/);
    assert.equal(existsSync(workdir), false, 'mismatch must stop before creating the work directory');
    assert.equal(existsSync(executionMarker), false, 'mismatch must stop before invoking a command');
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
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
  // Same allowlist rule as the guide-mismatch stub above: this module must export
  // every name the runner imports from node:child_process, or the runner dies at
  // link time and proves nothing. spawn needs no 'unzip' case, because nothing may
  // reach it; it marks and throws exactly as the non-unzip execFileSync branch does.
  const childProcessSource = `
    import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const fixture = ${JSON.stringify({
      rootCount, declaredName, workdir, fixtureRoot, executionMarker, archiveBase64, sha, commit,
      rootMode, archiveMode, receiptMode, documentsMode,
    })};
    export function spawn() {
      writeFileSync(fixture.executionMarker, 'called');
      throw new Error('synthetic install command must not run');
    }
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
