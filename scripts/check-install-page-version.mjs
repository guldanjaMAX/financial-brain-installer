#!/usr/bin/env node
// Public metadata only. A healthy held doorway is not permission to update.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const ENDPOINTS = Object.freeze({
  manifest: 'https://financialbrain.ai/update/manifest.json',
  updateGuide: 'https://financialbrain.ai/update/agent.md',
  installGuide: 'https://financialbrain.ai/install/agent.md',
  installGuideMacos: 'https://financialbrain.ai/install/agent-macos.md',
  latest: 'https://api.github.com/repos/guldanjaMAX/financial-brain-installer/releases/latest',
});
const UPDATE_URL = 'https://financialbrain.ai/update';
const RELEASE_BASE = 'https://github.com/guldanjaMAX/financial-brain-installer/releases/download';
const versionPattern = /^\d+\.\d+\.\d+$/;
const digestPattern = /^[0-9a-f]{64}$/;
const requireValue = (condition, message) => { if (!condition) throw new Error(message); };
export function guideFields(text) {
  requireValue(typeof text === 'string' && text.length < 200_000, 'invalid agent guide');
  const fields = {};
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const header = line.match(/^[ \t]*([A-Z][A-Z0-9_]*):/);
    if (!header) continue;
    const exact = line.match(/^([A-Z][A-Z0-9_]*): ([^\r\n]+)$/);
    requireValue(exact, `malformed guide field ${header[1]}`);
    const [, key, value] = exact;
    requireValue(!Object.hasOwn(fields, key), `duplicate guide field ${key}`);
    fields[key] = value.trim();
  }
  return fields;
}

const SUPERVISED_TARGETS = Object.freeze({
  windows: 'physical Windows 10 or newer',
  macos: 'macOS 13 or newer, Apple silicon or Intel',
});

/**
 * Validate the executable candidate contract before its artifact URL can be
 * followed. Both the release-health checker and the install matrix use this
 * one parser, so a duplicate field or a weakened owner/target/status boundary
 * cannot be accepted by one surface and rejected by the other.
 */
export function validateSupervisedInstallContract(installGuide, { platform = 'windows' } = {}) {
  const target = SUPERVISED_TARGETS[platform];
  requireValue(target, 'unsupported supervised install platform');
  const install = guideFields(installGuide);
  requireValue(install.AGENT_INSTALL_CONTRACT_VERSION === '1' &&
    install.STATUS === 'supervised field-test candidate' &&
    install.OWNER_PRESENT === 'required' && install.TARGET === target &&
    typeof install.SETUP_PAGE === 'string', 'unrecognized supervised install contract');
  const setup = new URL(install.SETUP_PAGE);
  requireValue(setup.origin === 'https://financialbrain.ai' && /^\/[a-z0-9-]+$/.test(setup.pathname) &&
    !setup.search && !setup.hash && !setup.username && !setup.password, 'invalid supervised setup URL');
  requireValue(versionPattern.test(install.CANDIDATE_VERSION) && /^[0-9a-f]{40}$/.test(install.CANDIDATE_COMMIT) &&
    digestPattern.test(install.ARTIFACT_SHA256) && /^[1-9]\d*$/.test(install.ARTIFACT_BYTES) &&
    Number.isSafeInteger(Number(install.ARTIFACT_BYTES)) && Number(install.ARTIFACT_BYTES) <= 100 * 1024 * 1024,
  'invalid supervised candidate receipt');
  const expected = `${setup.href}/financial-brain-v${install.CANDIDATE_VERSION}-field-kit-${install.ARTIFACT_SHA256.slice(0, 16)}.zip`;
  requireValue(install.ARTIFACT_URL === expected, 'supervised candidate URL and receipt disagree');
  return Object.freeze({
    platform,
    guideUrl: platform === 'windows' ? ENDPOINTS.installGuide : ENDPOINTS.installGuideMacos,
    setupPage: setup.href,
    artifactUrl: install.ARTIFACT_URL,
    artifactBytes: Number(install.ARTIFACT_BYTES),
    artifactSha256: install.ARTIFACT_SHA256,
    candidateVersion: install.CANDIDATE_VERSION,
    candidateCommit: install.CANDIDATE_COMMIT,
  });
}
export function validatePublicManifest(value) {
  requireValue(value?.schema_version === 2, 'unsupported update manifest schema');
  requireValue(['held', 'candidate', 'stable'].includes(value.release_state), 'invalid release state');
  requireValue(value.update_url === UPDATE_URL, 'unexpected update URL');
  requireValue(Array.isArray(value.changes) && value.changes.every((item) => typeof item === 'string'), 'invalid release notes');
  requireValue(value.proof?.live_client_acceptance === 'required', 'client acceptance boundary is missing');
  if (value.release_state !== 'stable') {
    requireValue(value.available === false && value.release === null && value.published_at === null && value.installer === null,
      'nonstable manifest advertises an executable release');
    requireValue(value.changes.length === 0 && typeof value.held_reason === 'string' && value.held_reason.trim(), 'nonstable hold reason is missing');
    requireValue(value.proof.archive_release_gate === 'not_passed' && value.proof.automated_release_suite === 'pending', 'nonstable manifest overclaims proof');
    return value;
  }
  requireValue(value.available === true && typeof value.release === 'string' && versionPattern.test(value.release) && value.held_reason === null, 'incomplete stable release identity');
  requireValue(typeof value.published_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.published_at) &&
    !Number.isNaN(Date.parse(value.published_at)) && new Date(value.published_at).toISOString().slice(0, 10) === value.published_at, 'invalid publication date');
  const expectedUrl = `${RELEASE_BASE}/v${value.release}/brain-installer-${value.release}.tgz`;
  requireValue(value.installer?.url === expectedUrl && digestPattern.test(value.installer?.sha256) &&
    Number.isSafeInteger(value.installer?.bytes) && value.installer.bytes > 0 && value.installer.bytes <= 100 * 1024 * 1024,
  'invalid exact stable package receipt');
  requireValue(value.proof.archive_release_gate === 'passed' && value.proof.automated_release_suite === 'passed', 'stable manifest lacks release proof');
  return value;
}
export function validateDoorways({ manifest, updateGuide, installGuide }) {
  validatePublicManifest(manifest);
  const update = guideFields(updateGuide);
  requireValue(update.AGENT_UPDATE_CONTRACT_VERSION === '1' && update.RELEASE_STATE === manifest.release_state &&
    update.PAGE_URL === UPDATE_URL && update.RELEASE_MANIFEST === ENDPOINTS.manifest,
  'update guide and manifest disagree');
  const permitted = manifest.release_state === 'stable' ? 'guided-update-after-release-and-owner-checks' : 'read-only-diagnosis';
  requireValue(update.PERMITTED_MODE === permitted, 'update guide permits the wrong operation');
  // The unlisted /install doorway intentionally offers a supervised candidate.
  // Its older exact version must never be replaced with /releases/latest.
  const install = validateSupervisedInstallContract(installGuide);
  // The artifact must still be derivable from the setup page, the version and
  // the digest, so it can never be swapped for a moving target like
  // /releases/latest. What changed on 2026-09-08 is the human-readable part of
  // the name: the kit no longer embeds the setup page's own path or a single
  // platform, because one sealed kit carries Windows and macOS and clients other
  // than the person the page was named for now install from it.
  return { state: manifest.release_state, publicRelease: manifest.release, supervisedCandidate: install.candidateVersion };
}
export function verifyPublishedMetadata(manifest, release) {
  requireValue(manifest.release_state === 'stable', 'publication verification needs a stable manifest');
  requireValue(release?.tag_name === `v${manifest.release}` && release.draft === false && release.prerelease === false && release.immutable === true,
    'latest release is not the exact immutable stable release');
  requireValue(Array.isArray(release.assets) && release.assets.length === 2, 'release must contain exactly two package names');
  const required = new Set([`brain-installer-${manifest.release}.tgz`, 'brain-installer.tgz']);
  for (const asset of release.assets) {
    requireValue(required.delete(asset.name) && asset.state === 'uploaded' && asset.size === manifest.installer.bytes &&
      asset.digest === `sha256:${manifest.installer.sha256}`, 'release asset metadata disagrees with the stable receipt');
  }
  requireValue(required.size === 0, 'required release asset is missing');
}
export async function publicBytes(url, limit = 200_000, { fetchImpl = globalThis.fetch } = {}) {
  requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 100 * 1024 * 1024,
    'invalid public response byte limit');
  const response = await fetchImpl(url, { headers: { 'user-agent': 'brain-release-contract-check', 'cache-control': 'no-cache' },
    redirect: url.startsWith(RELEASE_BASE) ? 'follow' : 'error', signal: AbortSignal.timeout(30_000) });
  requireValue(response.ok, `public contract returned HTTP ${response.status}`);
  const contentLength = response.headers.get('content-length');
  requireValue(contentLength === null || (/^\d+$/.test(contentLength) && Number(contentLength) <= limit),
    'public response exceeds its byte limit');
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    requireValue(bytes <= limit, 'public response exceeds its byte limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Download one fixed platform guide, validate it, then and only then follow
 * its immutable, digest-derived, byte-bounded artifact URL. */
export async function readSupervisedInstallContract({ platform = 'windows', read = publicBytes } = {}) {
  const guideUrl = platform === 'windows' ? ENDPOINTS.installGuide
    : platform === 'macos' ? ENDPOINTS.installGuideMacos : null;
  requireValue(guideUrl, 'unsupported supervised install platform');
  const guideBytes = Buffer.from(await read(guideUrl, 200_000));
  requireValue(guideBytes.length < 200_000, 'invalid agent guide');
  const guide = guideBytes.toString('utf8');
  const contract = validateSupervisedInstallContract(guide, { platform });
  const artifact = Buffer.from(await read(contract.artifactUrl, contract.artifactBytes));
  requireValue(artifact.length === contract.artifactBytes &&
    createHash('sha256').update(artifact).digest('hex') === contract.artifactSha256,
  'downloaded supervised artifact differs from the published receipt');
  return Object.freeze({ ...contract, guide, artifact });
}
export async function checkInstallPage({ read = publicBytes, requireStable = false } = {}) {
  const [manifestBytes, updateBytes, installBytes] = await Promise.all([
    read(ENDPOINTS.manifest), read(ENDPOINTS.updateGuide), read(ENDPOINTS.installGuide),
  ]);
  const manifest = JSON.parse(String(manifestBytes));
  const result = validateDoorways({ manifest, updateGuide: String(updateBytes), installGuide: String(installBytes) });
  if (result.state !== 'stable') {
    requireValue(!requireStable, `public release remains ${result.state}; promotion is not allowed`);
    return { ...result, promotionAllowed: false, artifactVerified: false };
  }
  const release = JSON.parse(String(await read(ENDPOINTS.latest, 2_000_000)));
  verifyPublishedMetadata(manifest, release);
  const bytes = await read(manifest.installer.url, manifest.installer.bytes);
  requireValue(bytes.length === manifest.installer.bytes && createHash('sha256').update(bytes).digest('hex') === manifest.installer.sha256,
    'downloaded stable archive differs from the published receipt');
  return { ...result, promotionAllowed: true, artifactVerified: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    requireValue(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--require-stable'),
      'usage: check-install-page-version.mjs [--require-stable]');
    console.log(JSON.stringify(await checkInstallPage({ requireStable: process.argv[2] === '--require-stable' })));
  } catch (error) {
    console.error(`Install/update contract check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
