import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyRelease } from "./verify-release-assets.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readText = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const ci = readText(join(root, ".github/workflows/ci.yml"));
const release = readText(join(root, ".github/workflows/release.yml"));
const installMatrix = readText(join(root, ".github/workflows/install-matrix.yml"));
const installRunner = readText(join(root, "scripts/install-from-public-contract.mjs"));
const windowsNpmHelper = readText(join(root, "scripts/invoke-public-npm-install.ps1"));
const workflowsDir = join(root, ".github/workflows");
const workflowFiles = readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => [name, readText(join(workflowsDir, name))]);

// Branch and pull-request CI remains independent. Tags have one route, through
// release.yml, so two racing CI runs cannot disagree about which one released.
assert.match(ci, /^  push:\n    branches:\n      - "\*\*"$/m);
assert.match(ci, /^  pull_request:$/m);
assert.match(ci, /^  workflow_dispatch:$/m);
assert.match(ci, /^  workflow_call:\n    outputs:/m);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.artifact_id \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.artifact_name \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.package_sha256 \}\}/);
assert.match(ci, /os: \[windows-latest, macos-latest, ubuntu-latest\]/);
assert.match(ci, /node: \['22', '24'\]/);
assert.match(ci, /^  preflight-traps:$/m);
assert.match(release, /^  push:\n    tags:\n      - "v\*\.\*\.\*"$/m);
assert.match(installMatrix, /^  workflow_dispatch:$/m);
assert.match(installMatrix, /^  workflow_call:$/m);
assert.match(installMatrix, /^  schedule:$/m);
assert.doesNotMatch(installMatrix, /^  push:$/m,
  "release.yml must call the public-contract matrix rather than racing an independent tag run");
assert.match(installMatrix, /verify and install from the published package contract/);
assert.match(installMatrix, /node scripts\/install-from-public-contract\.mjs/);
assert.doesNotMatch(installMatrix, /brain (?:setup|provision|drain|ask)/,
  "the package-only public-contract gate must not claim or start live provisioning");
assert.match(installRunner, /readSupervisedInstallContract\(\{ platform: guideArg \}\)/,
  "the install runner must reuse the strict live doorway validator before download");
assert.match(installRunner, /if \(process\.platform === "win32"\)[\s\S]*buildWindowsNpmPowerShellInvocation/,
  "the Windows path must enter the parsed npm.cmd contract through PowerShell");
assert.match(windowsNpmHelper, /Get-Command -Name \$contract\.executable -CommandType Application/);
assert.match(windowsNpmHelper, /& \$contract\.executable @arguments/);
assert.match(windowsNpmHelper, /GetCurrentPackageFullName/);
assert.match(windowsNpmHelper, /PUBLIC_NPM_REFUSED.*packaged_shell/s);
assert.match(windowsNpmHelper, /PUBLIC_NPM_REFUSED.*package_identity_unverified/s);
const packageIdentityIndex = windowsNpmHelper.indexOf("$packageContext = Get-WindowsPackageContext");
const contractReadIndex = windowsNpmHelper.indexOf("ReadAllText($ContractPath)");
const npmInvokeIndex = windowsNpmHelper.indexOf("& $contract.executable @arguments");
assert.ok(packageIdentityIndex > 0 && contractReadIndex > packageIdentityIndex && npmInvokeIndex > contractReadIndex,
  "the Windows installer must prove it is outside an app package before reading the contract or invoking npm");

// One Node 24 job creates the package. All operating-system jobs resolve the
// immutable artifact ID and verify the producer's raw SHA before installing it.
const packageIndex = ci.indexOf("  package:");
const testIndex = ci.indexOf("  test:");
const trapIndex = ci.indexOf("  preflight-traps:");
assert.ok(packageIndex > 0 && testIndex > packageIndex && trapIndex > testIndex,
  "the build-once package job must precede the test matrix");
const packageJob = ci.slice(packageIndex, testIndex);
const testJob = ci.slice(testIndex, trapIndex);
const preflightTrapJob = ci.slice(trapIndex);
assert.match(packageJob, /node-version: '24'/);
assert.match(packageJob, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
assert.match(packageJob, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
assert.match(packageJob, /^          name: \$\{\{ steps\.pack\.outputs\.artifact_name \}\}$/m);
assert.match(packageJob, /^          path: \$\{\{ steps\.pack\.outputs\.package_path \}\}$/m);
assert.match(packageJob, /^          archive: false$/m);
assert.match(packageJob, /^          overwrite: true$/m);
assert.match(packageJob, /ARTIFACT_ID: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
assert.match(packageJob, /UPLOAD_DIGEST: \$\{\{ steps\.upload\.outputs\.artifact-digest \}\}/);
assert.match(packageJob, /uploaded_sha256="\$\{UPLOAD_DIGEST#sha256:\}"/);
assert.equal([...ci.matchAll(/^\s+npm pack\b/gm)].length, 1,
  "CI must package exactly once");
const privacyScanIndex = packageJob.indexOf("node test/package-privacy.test.mjs --scan-only");
const packCommandIndex = packageJob.indexOf("npm pack --json");
const uploadActionIndex = packageJob.indexOf("actions/upload-artifact@");
assert.ok(privacyScanIndex > 0 && packCommandIndex > privacyScanIndex && uploadActionIndex > packCommandIndex,
  "private inputs must be rejected before packaging or upload");

assert.match(testJob, /^    needs: package$/m);
assert.match(testJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
assert.match(testJob, /artifact-ids: \$\{\{ needs\.package\.outputs\.artifact_id \}\}/);
assert.match(testJob, /^          skip-decompress: true$/m);
assert.match(testJob, /^          digest-mismatch: error$/m);
assert.match(testJob, /ARTIFACT_NAME: \$\{\{ needs\.package\.outputs\.artifact_name \}\}/);
assert.match(testJob, /EXPECTED_SHA256: \$\{\{ needs\.package\.outputs\.package_sha256 \}\}/);
assert.doesNotMatch(testJob, /^\s+npm pack\b/m);
const matrixDownloadIndex = testJob.indexOf("- name: download the one shared raw package");
const matrixHashIndex = testJob.indexOf("- name: verify exact shared package bytes");
const matrixPreflightExtractIndex = testJob.indexOf("- name: extract preflight from exact package");
const matrixInstallIndex = testJob.indexOf("- name: install");
const matrixPackageInstallIndex = testJob.indexOf('npm install -g "$TARBALL"');
assert.ok(matrixDownloadIndex > 0 && matrixHashIndex > matrixDownloadIndex &&
  matrixPreflightExtractIndex > matrixHashIndex && matrixInstallIndex > matrixPreflightExtractIndex &&
  matrixPackageInstallIndex > matrixInstallIndex,
"the matrix must hash the downloaded package and extract its preflight before any install");
assert.match(testJob, /tar -xzf "\$tarball" -C \.packaged-preflight[\s\S]*?package\/tools\/preflight\.sh package\/tools\/preflight\.ps1 \\\n\s+package\/operations\/installed-manifest\.mjs/);
const matrixPreflightExtract = testJob.slice(matrixPreflightExtractIndex, matrixInstallIndex);
assert.match(matrixPreflightExtract, /basename "\$tarball"/);
assert.match(matrixPreflightExtract, /test -f \.packaged-preflight\/package\/operations\/installed-manifest\.mjs/,
  "the exact-package preflight must include the helper both scripts execute");
assert.doesNotMatch(matrixPreflightExtract, /\$ARTIFACT_NAME/,
  "the extraction step must use variables exported to later steps rather than a prior step-local variable");
assert.match(testJob, /- name: packaged preflight runs and prints \(Windows\)[\s\S]*?\.packaged-preflight\\package\\tools\\preflight\.ps1/);
assert.match(testJob, /- name: packaged preflight runs and prints \(macOS and Linux\)[\s\S]*?bash \.packaged-preflight\/package\/tools\/preflight\.sh/);
assert.doesNotMatch(testJob, /(?:bash |Resolve-Path \.\\)tools[\\/]preflight\.(?:sh|ps1)/,
  "the matrix must run preflight from the exact package rather than the checkout");
assert.match(testJob, /- name: Windows PowerShell user-prefix command works[\s\S]*?PACKAGE_FILENAME: \$\{\{ needs\.package\.outputs\.artifact_name \}\}[\s\S]*?shell: pwsh[\s\S]*?Join-Path '\.release-package' \$env:PACKAGE_FILENAME/);
assert.match(preflightTrapJob, /trap 4: an empty earlier Wrangler directory cannot mask a later session/);
assert.match(preflightTrapJob, /New-Item -ItemType Directory -Force -Path \(Join-Path \$env:APPDATA 'xdg\.config\\\.wrangler\\config'\)[\s\S]*?Set-Content \(Join-Path \$session 'default\.toml'\)[\s\S]*?ok\\s\+wrangler session found/,
  "Windows CI must prove an empty earlier Wrangler directory cannot hide a later session file");
assert.match(preflightTrapJob, /trap 5: Node 21 is below the supported minimum[\s\S]*?if "%~1"=="-v"[\s\S]*?unexpected-node-use[\s\S]*?node\.cmd[\s\S]*?Test-Path \$unexpectedNodeUse[\s\S]*?installer needs 22 or newer/,
  "Windows CI must refuse Node 21 and prove the unsupported runtime is not reused");

const gateIndex = release.indexOf("  gate:");
const publicContractIndex = release.indexOf("  public-contract-install:");
const publishIndex = release.indexOf("  publish:");
assert.ok(gateIndex > 0 && publicContractIndex > gateIndex && publishIndex > publicContractIndex,
  "publish must follow both reusable release gates");
const gate = release.slice(gateIndex, publicContractIndex);
const publicContractGate = release.slice(publicContractIndex, publishIndex);
const publish = release.slice(publishIndex);
assert.match(gate, /uses: \.\/\.github\/workflows\/ci\.yml/);
assert.match(publicContractGate, /uses: \.\/\.github\/workflows\/install-matrix\.yml/);
assert.match(publish, /^    needs:\n      - gate\n      - public-contract-install$/m);
assert.match(publish, /^    permissions:\n      contents: write$/m);

const releaseDownloadIndex = release.indexOf("- name: download the package already tested by CI");
const releaseBindIndex = release.indexOf("- name: bind the tested bytes to both release names");
assert.ok(releaseDownloadIndex > publishIndex && releaseBindIndex > releaseDownloadIndex,
  "release must retrieve and bind the artifact tested by its CI gate");
const releaseArtifactBinding = release.slice(releaseDownloadIndex, release.indexOf("gh release create"));
assert.match(releaseArtifactBinding, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
assert.match(releaseArtifactBinding, /artifact-ids: \$\{\{ needs\.gate\.outputs\.artifact_id \}\}/);
assert.match(releaseArtifactBinding, /TESTED_ARTIFACT_NAME: \$\{\{ needs\.gate\.outputs\.artifact_name \}\}/);
assert.match(releaseArtifactBinding, /TESTED_PACKAGE_SHA256: \$\{\{ needs\.gate\.outputs\.package_sha256 \}\}/);
assert.doesNotMatch(releaseArtifactBinding, /^          (?:github-token|repository|run-id):/m,
  "same-run downloads must use the Actions runtime without cross-run API inputs");
assert.match(releaseArtifactBinding, /^          skip-decompress: true$/m);
assert.match(releaseArtifactBinding, /^          digest-mismatch: error$/m);
assert.match(releaseArtifactBinding, /actual_sha256=.*createHash\("sha256"\)/s);
assert.match(releaseArtifactBinding, /actual_sha256.*!=.*TESTED_PACKAGE_SHA256/s);
assert.match(releaseArtifactBinding, /cp "\$downloaded" "\$versioned"/);
assert.match(releaseArtifactBinding, /cp "\$versioned" "\$canonical"/);
assert.doesNotMatch(release, /^\s+npm (?:ci|pack)\b/m,
  "release must consume the tested artifact without rebuilding it");

const createCommands = [...release.matchAll(/^\s+gh release create /gm)];
assert.equal(createCommands.length, 1, "release assets must have one creation operation");
assert.doesNotMatch(release, /^\s+gh release upload /m);
const deleteCommands = [...release.matchAll(/^\s+gh api --method DELETE /gm)];
assert.equal(deleteCommands.length, 2,
  "only pre-create draft replacement and failed-run draft cleanup may delete a release");
assert.doesNotMatch(release, /gh release delete|--cleanup-tag/,
  "release cleanup must delete an owned numeric release id and preserve the git tag");
assert.doesNotMatch(release, /git tag -d|refs\/tags\/.*(?:DELETE|delete)/,
  "the workflow must never delete or move the release tag");
const createIndex = release.indexOf("gh release create");
const draftVerifyIndex = release.indexOf("verify-release-assets.mjs draft");
const publishStepIndex = release.indexOf("- name: publish the verified draft");
const prepublishVerifyIndex = release.indexOf("verify-release-assets.mjs draft", draftVerifyIndex + 1);
const publishCommandIndex = release.indexOf("gh api --method PATCH");
const publishedVerifyIndex = release.indexOf("verify-release-assets.mjs published");
const replaceDraftIndex = release.indexOf('gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$existing_id"');
const cleanupStepIndex = release.indexOf("- name: remove a failed draft without deleting its tag");
const cleanupDeleteIndex = release.indexOf('gh api --method DELETE "repos/$GITHUB_REPOSITORY/releases/$cleanup_id"');
assert.ok(createIndex < draftVerifyIndex && draftVerifyIndex < publishStepIndex &&
  publishStepIndex < prepublishVerifyIndex && prepublishVerifyIndex < publishCommandIndex &&
  publishCommandIndex < publishedVerifyIndex);
assert.ok(replaceDraftIndex > 0 && replaceDraftIndex < createIndex,
  "an exact-tag draft must be removed before recreating the release");
assert.ok(cleanupStepIndex > publishedVerifyIndex && cleanupDeleteIndex > cleanupStepIndex,
  "failed-run cleanup must run after every publish step and contain the second draft deletion");
assert.match(release.slice(createIndex, draftVerifyIndex), /"\$VERSIONED_TARBALL" "\$CANONICAL_TARBALL"/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--draft/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--verify-tag/);
assert.match(release.slice(createIndex, draftVerifyIndex), /--latest/);
assert.match(release.slice(0, createIndex), /secrets\.RELEASE_ADMIN_READ_TOKEN/);
assert.match(release.slice(0, createIndex), /"repos\/\$GITHUB_REPOSITORY\/immutable-releases"/);
assert.match(release.slice(publishCommandIndex), /isImmutable/);
assert.match(release.slice(publishCommandIndex), /installed_status=\$\?/);
assert.doesNotMatch(release.slice(publishCommandIndex), /bin\/brain"\s*\|/);

const replaceDraft = release.slice(release.lastIndexOf("existing_release=", createIndex), createIndex);
assert.match(replaceDraft, /gh api "repos\/\$GITHUB_REPOSITORY\/releases" --paginate/);
assert.match(replaceDraft, /select\(\.tag_name == env\.RELEASE_LOOKUP_TAG\)/);
assert.match(replaceDraft, /existing_state.*== "draft"/s);
assert.match(replaceDraft, /existing_owner.*!= "owned"/s);
assert.match(replaceDraft, /published release already exists/);
assert.match(replaceDraft, /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$existing_id"/);
assert.match(release.slice(0, draftVerifyIndex), /release_marker="brain-release-run:\$\{GITHUB_RUN_ID\}:\$\{GITHUB_RUN_ATTEMPT\}"/);
assert.match(release.slice(0, draftVerifyIndex), /--notes "<!-- \$release_marker -->"/);
const createdIdentity = release.slice(createIndex, draftVerifyIndex);
assert.match(createdIdentity, /gh api "repos\/\$GITHUB_REPOSITORY\/releases" --paginate/);
assert.match(createdIdentity, /select\(\.tag_name == env\.RELEASE_LOOKUP_TAG\)/);
assert.match(createdIdentity, /expected exactly one release for the tag/);
assert.match(createdIdentity, /value\.draft !== true/);
assert.match(createdIdentity, /Number\.isSafeInteger\(value\.id\)/);
assert.match(createdIdentity, /created release does not carry this run marker/);
assert.match(createdIdentity, /RELEASE_DRAFT_ID=\$created_id/);

const publishStep = release.slice(publishStepIndex, publishedVerifyIndex);
assert.match(publishStep, /repos\/\$GITHUB_REPOSITORY\/releases\/\$RELEASE_DRAFT_ID/);
assert.match(publishStep, /value\.id !== expectedId/);
assert.match(publishStep, /value\.tag_name !== process\.argv\[3\]/);
assert.match(publishStep, /value\.draft !== true/);
assert.match(publishStep, /prepublish release is not owned by this run/);
assert.match(publishStep, /verify-release-assets\.mjs draft/);
assert.match(publishStep, /gh api --method PATCH/);
assert.match(publishStep, /-F draft=false/);
assert.doesNotMatch(release, /gh release edit/,
  "publication must target the captured numeric release id, never resolve the tag again");

const cleanup = release.slice(cleanupStepIndex);
assert.match(cleanup, /if: \$\{\{ failure\(\) \}\}/);
assert.match(cleanup, /RELEASE_DRAFT_MARKER/);
assert.match(cleanup, /cleanup_state.*== "draft"/s);
assert.match(cleanup, /cleanup_owner.*!= "owned"/s);
assert.match(cleanup, /different actor owns the draft/);
assert.match(cleanup, /is published; leaving it and its tag untouched/);
assert.match(cleanup, /gh api --method DELETE "repos\/\$GITHUB_REPOSITORY\/releases\/\$cleanup_id"/);

for (const [name, text] of workflowFiles) {
  for (const match of text.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith("./")) continue;
    assert.match(reference, /@[0-9a-f]{40}$/, `${name} has a mutable or abbreviated action reference: ${reference}`);
  }
}

const sandbox = mkdtempSync(join(tmpdir(), "brain-release-contract-"));
try {
  const versioned = join(sandbox, "brain-installer-9.8.7.tgz");
  const canonical = join(sandbox, "brain-installer.tgz");
  const bytes = Buffer.from("synthetic release bytes\n");
  writeFileSync(versioned, bytes);
  writeFileSync(canonical, bytes);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const assets = [versioned, canonical].map((path) => ({
    name: basename(path),
    size: bytes.length,
    digest,
    state: "uploaded",
  }));

  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tag_name: "v9.8.7", draft: true, immutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: true, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }));
  assert.throws(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /not immutable/);
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets: assets.slice(0, 1) },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /1 assets, expected 2/);

  writeFileSync(canonical, Buffer.from("changed\n"));
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical],
  }), /does not match|not byte-identical/);
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log("release workflow contract: one exact package across CI and release, tag-preserving draft recovery, immutable publication");

// The REST get-release-by-tag endpoint returns PUBLISHED releases only, so it 404s
// on the draft this workflow creates: the job died there and a retry left an orphan
// draft behind while creating a second one. Listing returns drafts to a token with
// push access. Forbid the broken lookup outright rather than trusting a comment.
assert.doesNotMatch(
  release,
  /releases\/tags\//,
  "release.yml must not resolve a release by tag: that endpoint cannot see a draft",
);
