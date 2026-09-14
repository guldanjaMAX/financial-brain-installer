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
const windowsRehearsal = readText(join(root, ".github/workflows/windows-rehearsal.yml"));
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
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.package_version \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.package_bytes \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.package_file_count \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.runtime_identity_artifact_id \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.runtime_identity_artifact_name \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.runtime_identity_artifact_sha256 \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.runtime_identity_artifact_bytes \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.identity_scheme \}\}/);
assert.match(ci, /value: \$\{\{ jobs\.package\.outputs\.runtime_payload_sha256 \}\}/);
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
assert.match(packageJob, /node-version: '24\.13\.1'/);
assert.match(packageJob, /actual_node="\$\(node --version\)"/);
assert.match(packageJob, /actual_npm="\$\(npm --version\)"/);
assert.match(packageJob,
  /"\$actual_node" != "v24\.13\.1" \|\| "\$actual_npm" != "11\.8\.0"/);
assert.match(packageJob,
  /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
assert.match(packageJob, /artifact_id: \$\{\{ steps\.upload\.outputs\.artifact-id \}\}/);
assert.match(packageJob, /package_version: \$\{\{ steps\.pack\.outputs\.package_version \}\}/);
assert.match(packageJob, /package_bytes: \$\{\{ steps\.pack\.outputs\.package_bytes \}\}/);
assert.match(packageJob, /package_file_count: \$\{\{ steps\.pack\.outputs\.package_file_count \}\}/);
assert.match(packageJob,
  /runtime_identity_artifact_id: \$\{\{ steps\.upload_runtime_identity\.outputs\.artifact-id \}\}/);
assert.match(packageJob,
  /identity_scheme: \$\{\{ steps\.pack\.outputs\.identity_scheme \}\}/);
assert.match(packageJob,
  /runtime_payload_sha256: \$\{\{ steps\.pack\.outputs\.runtime_payload_sha256 \}\}/);
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
assert.equal([...packageJob.matchAll(/^\s+run: npm ci\b/gm)].length, 1,
  "the package producer must install exactly once");
const setupNodeIndex = packageJob.indexOf("actions/setup-node@");
const toolchainAssertionIndex = packageJob.indexOf(
  "- name: assert exact package producer toolchain",
);
const installIndex = packageJob.indexOf(
  "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
);
const privacyScanIndex = packageJob.indexOf("node test/package-privacy.test.mjs --scan-only");
const packCommandIndex = packageJob.indexOf("npm pack --json");
const bundleVerificationIndex = packageJob.indexOf("node scripts/verify-package-bundles.mjs");
const runtimeReceiptIndex = packageJob.indexOf("node scripts/runtime-identity-receipt.mjs");
const uploadActionIndex = packageJob.indexOf("actions/upload-artifact@");
assert.ok(setupNodeIndex > 0 && toolchainAssertionIndex > setupNodeIndex &&
  installIndex > toolchainAssertionIndex && privacyScanIndex > installIndex &&
  packCommandIndex > privacyScanIndex &&
  bundleVerificationIndex > packCommandIndex && runtimeReceiptIndex > bundleVerificationIndex &&
  uploadActionIndex > runtimeReceiptIndex,
"the exact producer must be asserted before install, private inputs before packaging, and the runtime receipt sealed before upload");
assert.match(packageJob, /--json > "\$bundle_proof_path"/);
assert.match(packageJob, /proof\.archive_sha256/);
assert.match(packageJob, /proof\.archive_bytes/);
assert.match(packageJob, /proof\.archive_file_count/);
assert.match(packageJob, /runtime_identity_artifact_name="brain-installer-\$package_version-runtime-identity\.json"/);
assert.match(packageJob, /--create receipt/);
assert.match(packageJob, /--source-sha "\$checkout_commit"/);
assert.match(packageJob, /echo "package_version=\$package_version" >> "\$GITHUB_OUTPUT"/);
assert.match(packageJob, /echo "package_bytes=\$package_bytes" >> "\$GITHUB_OUTPUT"/);
assert.match(packageJob, /echo "package_file_count=\$package_file_count" >> "\$GITHUB_OUTPUT"/);
assert.match(packageJob, /echo "identity_scheme=\$identity_scheme" >> "\$GITHUB_OUTPUT"/);
assert.match(packageJob,
  /echo "runtime_payload_sha256=\$runtime_payload_sha256" >> "\$GITHUB_OUTPUT"/);
assert.equal([...packageJob.matchAll(/actions\/upload-artifact@/g)].length, 2,
  "the producer must upload only the raw package and its raw runtime identity receipt");
assert.match(packageJob,
  /- name: upload the raw runtime identity receipt[\s\S]*?archive: false/);
assert.match(packageJob, /RUNTIME_IDENTITY_UPLOAD_DIGEST:/);
assert.match(packageJob,
  /uploaded_runtime_identity_sha256="\$\{RUNTIME_IDENTITY_UPLOAD_DIGEST#sha256:\}"/);
assert.doesNotMatch(packageJob, /createHash\("sha256"\).*readFileSync\(process\.argv\[1\]\)/s,
  "the package digest must come from the verifier's stable archive read");

const windowsPackIndex = windowsRehearsal.indexOf("npm pack --json");
const windowsBundleVerificationIndex = windowsRehearsal.indexOf(
  "node scripts/verify-package-bundles.mjs",
);
const windowsReviewedDigestIndex = windowsRehearsal.indexOf("expected_reviewed_sha256=");
const windowsUploadIndex = windowsRehearsal.indexOf("actions/upload-artifact@");
assert.ok(windowsPackIndex > 0 && windowsBundleVerificationIndex > windowsPackIndex &&
  windowsReviewedDigestIndex > windowsBundleVerificationIndex &&
  windowsUploadIndex > windowsReviewedDigestIndex,
"Windows rehearsal must verify lock-derived bundles before its reviewed digest and upload");
assert.match(windowsRehearsal, /--json > "\$bundle_proof_path"/);
assert.match(windowsRehearsal, /proof\.archive_sha256/);
const windowsPackageJob = windowsRehearsal.slice(
  windowsRehearsal.indexOf("  package:"),
  windowsRehearsal.indexOf("  test:"),
);
assert.match(windowsPackageJob, /node-version: '24\.13\.1'/);
assert.match(windowsPackageJob, /actual_node="\$\(node --version\)"/);
assert.match(windowsPackageJob, /actual_npm="\$\(npm --version\)"/);
assert.match(windowsPackageJob,
  /"\$actual_node" != "v24\.13\.1" \|\| "\$actual_npm" != "11\.8\.0"/);
assert.match(windowsPackageJob,
  /npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
assert.match(windowsPackageJob, /proof\.archive_bytes/);
assert.match(windowsPackageJob, /proof\.archive_file_count/);
assert.match(windowsPackageJob,
  /package_version: \$\{\{ steps\.pack\.outputs\.package_version \}\}/);
assert.match(windowsPackageJob,
  /package_bytes: \$\{\{ steps\.pack\.outputs\.package_bytes \}\}/);
assert.match(windowsPackageJob,
  /package_file_count: \$\{\{ steps\.pack\.outputs\.package_file_count \}\}/);
assert.equal([...windowsPackageJob.matchAll(/^\s+run: npm ci\b/gm)].length, 1,
  "the Windows rehearsal package producer must install exactly once");
const windowsSetupNodeIndex = windowsPackageJob.indexOf("actions/setup-node@");
const windowsToolchainAssertionIndex = windowsPackageJob.indexOf(
  "- name: assert exact package producer toolchain",
);
const windowsInstallIndex = windowsPackageJob.indexOf(
  "npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
);
const windowsPrivacyScanIndex = windowsPackageJob.indexOf(
  "node test/package-privacy.test.mjs --scan-only",
);
const windowsPackagePackIndex = windowsPackageJob.indexOf("npm pack --json");
const windowsPackageBundleVerificationIndex = windowsPackageJob.indexOf(
  "node scripts/verify-package-bundles.mjs",
);
const windowsRuntimeReceiptIndex = windowsPackageJob.indexOf(
  "node scripts/runtime-identity-receipt.mjs",
);
const windowsPackageReviewedDigestIndex = windowsPackageJob.indexOf(
  "expected_reviewed_sha256=",
);
const windowsPackageUploadIndex = windowsPackageJob.indexOf("actions/upload-artifact@");
assert.ok(windowsSetupNodeIndex > 0 &&
  windowsToolchainAssertionIndex > windowsSetupNodeIndex &&
  windowsInstallIndex > windowsToolchainAssertionIndex &&
  windowsPrivacyScanIndex > windowsInstallIndex &&
  windowsPackagePackIndex > windowsPrivacyScanIndex &&
  windowsPackageBundleVerificationIndex > windowsPackagePackIndex &&
  windowsRuntimeReceiptIndex > windowsPackageBundleVerificationIndex &&
  windowsPackageReviewedDigestIndex > windowsRuntimeReceiptIndex &&
  windowsPackageUploadIndex > windowsPackageReviewedDigestIndex,
"the Windows reviewed producer must assert its toolchain before install and preserve every package gate");
assert.equal([...windowsPackageJob.matchAll(/actions\/upload-artifact@/g)].length, 2,
  "the Windows producer must upload only the raw package and runtime identity receipt");
assert.match(windowsPackageJob,
  /runtime_identity_artifact_id: \$\{\{ steps\.upload_runtime_identity\.outputs\.artifact-id \}\}/);
assert.match(windowsPackageJob,
  /runtime_payload_sha256: \$\{\{ steps\.pack\.outputs\.runtime_payload_sha256 \}\}/);

assert.match(testJob, /^    needs: package$/m);
assert.match(testJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
assert.match(testJob, /artifact-ids: \$\{\{ needs\.package\.outputs\.artifact_id \}\}/);
assert.match(testJob, /^          skip-decompress: true$/m);
assert.match(testJob, /^          digest-mismatch: error$/m);
assert.match(testJob, /ARTIFACT_NAME: \$\{\{ needs\.package\.outputs\.artifact_name \}\}/);
assert.match(testJob, /EXPECTED_SHA256: \$\{\{ needs\.package\.outputs\.package_sha256 \}\}/);
assert.match(testJob,
  /EXPECTED_PACKAGE_VERSION: \$\{\{ needs\.package\.outputs\.package_version \}\}/);
assert.match(testJob,
  /EXPECTED_PACKAGE_BYTES: \$\{\{ needs\.package\.outputs\.package_bytes \}\}/);
assert.match(testJob,
  /EXPECTED_PACKAGE_FILE_COUNT: \$\{\{ needs\.package\.outputs\.package_file_count \}\}/);
assert.match(testJob,
  /RUNTIME_IDENTITY_ARTIFACT_NAME: \$\{\{ needs\.package\.outputs\.runtime_identity_artifact_name \}\}/);
assert.match(testJob,
  /EXPECTED_RUNTIME_IDENTITY_ARTIFACT_SHA256: \$\{\{ needs\.package\.outputs\.runtime_identity_artifact_sha256 \}\}/);
assert.match(testJob,
  /EXPECTED_RUNTIME_IDENTITY_ARTIFACT_BYTES: \$\{\{ needs\.package\.outputs\.runtime_identity_artifact_bytes \}\}/);
assert.match(testJob,
  /EXPECTED_IDENTITY_SCHEME: \$\{\{ needs\.package\.outputs\.identity_scheme \}\}/);
assert.match(testJob,
  /EXPECTED_RUNTIME_PAYLOAD_SHA256: \$\{\{ needs\.package\.outputs\.runtime_payload_sha256 \}\}/);
assert.match(testJob, /fs\.statSync\(path\)\.size !== byteCount/);
assert.match(testJob,
  /echo "BRAIN_TESTED_PACKAGE_FILENAME=\$ARTIFACT_NAME" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_PACKAGE_VERSION=\$EXPECTED_PACKAGE_VERSION" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_PACKAGE_BYTES=\$EXPECTED_PACKAGE_BYTES" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_PACKAGE_FILE_COUNT=\$EXPECTED_PACKAGE_FILE_COUNT" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_PACKAGE_SHA256=\$EXPECTED_SHA256" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_RUNTIME_IDENTITY_SCHEME=\$EXPECTED_IDENTITY_SCHEME" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /echo "BRAIN_TESTED_RUNTIME_PAYLOAD_SHA256=\$EXPECTED_RUNTIME_PAYLOAD_SHA256" >> "\$GITHUB_ENV"/);
assert.match(testJob,
  /artifact-ids: \$\{\{ needs\.package\.outputs\.runtime_identity_artifact_id \}\}[\s\S]*?path: \.release-runtime-identity/);
assert.match(testJob, /node scripts\/runtime-identity-receipt\.mjs[\s\S]*?--verify receipt/);
assert.doesNotMatch(testJob, /^\s+npm pack\b/m);
const matrixDownloadIndex = testJob.indexOf("- name: download the one shared raw package");
const matrixIdentityDownloadIndex = testJob.indexOf(
  "- name: download the matching raw runtime identity receipt",
);
const matrixHashIndex = testJob.indexOf("- name: verify exact shared package bytes");
const matrixPreflightExtractIndex = testJob.indexOf("- name: extract preflight from exact package");
const matrixInstallIndex = testJob.indexOf("- name: install");
const matrixPackageInstallIndex = testJob.indexOf('npm install -g "$TARBALL"');
const matrixWindowsPrefixIndex = testJob.indexOf(
  "- name: Windows PowerShell user-prefix command works",
);
const matrixInstalledRuntimeIndex = testJob.indexOf(
  "- name: Windows installed runtime identity and preview boundary",
);
assert.ok(matrixDownloadIndex > 0 && matrixIdentityDownloadIndex > matrixDownloadIndex &&
  matrixHashIndex > matrixIdentityDownloadIndex &&
  matrixPreflightExtractIndex > matrixHashIndex && matrixInstallIndex > matrixPreflightExtractIndex &&
  matrixPackageInstallIndex > matrixInstallIndex && matrixWindowsPrefixIndex > matrixPackageInstallIndex &&
  matrixInstalledRuntimeIndex > matrixWindowsPrefixIndex,
"the matrix must hash the package before install and verify the installed Windows runtime after its user-prefix install");
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
const installedRuntimeStep = testJob.slice(
  matrixInstalledRuntimeIndex,
  testJob.indexOf("- name: package contains no private data", matrixInstalledRuntimeIndex),
);
assert.match(installedRuntimeStep,
  /if: \$\{\{ !cancelled\(\) && steps\.verify_package\.outcome == 'success' && runner\.os == 'Windows' \}\}/);
assert.match(installedRuntimeStep,
  /Join-Path \$prefix 'node_modules\\brain-installer'/);
assert.match(installedRuntimeStep,
  /packageManifest\.name !== "brain-installer"[\s\S]*?packageManifest\.version !== expectedVersion[\s\S]*?packageManifest\.bin\?\.brain !== "\.\/brain\.mjs"/);
assert.match(installedRuntimeStep,
  /process\.platform !== "win32" \|\| process\.arch !== "x64"[\s\S]*?process\.versions\.node/);
assert.match(installedRuntimeStep,
  /BRAIN_REVIEWED_SOURCE_ROOT = \(Resolve-Path -LiteralPath \$env:GITHUB_WORKSPACE\)\.Path/);
assert.match(installedRuntimeStep,
  /pathToFileURL\(join\(reviewedRoot, "brain\.mjs"\)\)[\s\S]*?pathToFileURL\(join\(reviewedRoot, "operations", "update-preview\.mjs"\)\)/,
  "the installed tree must be checked by verifier code from the reviewed checkout");
assert.match(installedRuntimeStep,
  /provenanceTargetRuntimePackageFiles\(\{ root \}\)/);
assert.match(installedRuntimeStep,
  /verifyUpdateRuntimePayload\(\{[\s\S]*?expectedRuntimeSha256: expectedRuntime,[\s\S]*?platform: "win32"/);
assert.doesNotMatch(installedRuntimeStep,
  /verifyUpdateRuntimePayload\(\{\s*root,\s*root,/,
  "the installed runtime verifier must receive one unambiguous root");
assert.match(installedRuntimeStep,
  /proof\.runtime_payload_sha256 !== expectedRuntime[\s\S]*?proof\.expected_runtime_sha256 !== expectedRuntime[\s\S]*?proof\.verified_passes !== 2 \|\| proof\.file_count !== expectedFileCount/);
assert.match(installedRuntimeStep,
  /WINDOWS_NODE_LAUNCHER_TEMPLATE !==[\s\S]*?"npm\.cmd-shim-8\.windows-node\.v1"/);
assert.match(installedRuntimeStep,
  /expectedWindowsNodeLauncherBytes\(\{[\s\S]*?launcherDirectory: "\."[\s\S]*?payloadTarget: "node_modules\/brain-installer\/brain\.mjs"/);
assert.match(installedRuntimeStep,
  /\["brain", "plain"\], \["brain\.cmd", "cmd"\], \["brain\.ps1", "powershell"\]/);
assert.match(installedRuntimeStep,
  /actual\.equals\(expectedLaunchers\[templateKey\]\)[\s\S]*?actual\.fill\(0\)/,
  "all three outer launchers must be exact-byte compared and wiped");
assert.match(installedRuntimeStep,
  /installed_brain_sha256: launcherFacts\.brain\.sha256[\s\S]*?installed_brain_cmd_sha256: launcherFacts\["brain\.cmd"\]\.sha256[\s\S]*?installed_brain_ps1_sha256: launcherFacts\["brain\.ps1"\]\.sha256/);
assert.match(installedRuntimeStep,
  /& node --input-type=module -e \$runtimeProofScript/,
  "the inline installed-package verifier must run as an ES module");
assert.match(installedRuntimeStep,
  /\$expectedRuntimeKeys = @\([\s\S]*?'installed_brain_cmd_sha256', 'installed_brain_ps1_bytes',[\s\S]*?'installed_launcher_count', 'launcher_template', 'node_major',[\s\S]*?'package_entrypoint', 'package_name', 'package_version', 'platform',[\s\S]*?the installed runtime receipt shape is not closed/);
assert.match(installedRuntimeStep,
  /\$env:HOME = \$emptyHome[\s\S]*?\$env:USERPROFILE = \$emptyHome[\s\S]*?\$env:APPDATA = \$emptyAppData[\s\S]*?\$env:LOCALAPPDATA = \$emptyLocalAppData/);
assert.match(installedRuntimeStep,
  /& \$brain update --preview --expect-runtime-sha256 \$env:BRAIN_TESTED_RUNTIME_PAYLOAD_SHA256 --json/);
assert.match(installedRuntimeStep,
  /if \(\$previewExit -ne 1\) \{\n\s+throw [^\n]+\n\s+\}\n\s+try \{ \$previewReceipt = \$previewJson \| ConvertFrom-Json \}/,
  "the no-manifest refusal check must close exactly once before parsing its receipt");
assert.doesNotMatch(installedRuntimeStep,
  /if \(\$previewExit -ne 1\)[\s\S]*?\n\s+\}\n\s+\}\n\s+try \{ \$previewReceipt/,
  "the installed Windows step must not contain a stray closing brace before receipt parsing");
assert.match(installedRuntimeStep,
  /\$expectedPreviewKeys = @\([\s\S]*?operation -cne 'brain\.update\.preview'[\s\S]*?read_only -ne \$true[\s\S]*?error_code -cne 'UPDATE_PREVIEW_FAILED'/);
assert.match(installedRuntimeStep,
  /'browser_launches', 'credential_reads', 'manifest_writes',[\s\S]*?'network_requests', 'package_installs', 'skill_writes', 'workspace_writes'/);
assert.match(installedRuntimeStep,
  /if \(Test-Path -LiteralPath \$emptyRoot\)[\s\S]*?wrote inside its isolated no-manifest home/);
assert.doesNotMatch(installedRuntimeStep, /brain\.manifest\.json['"]?\s+--preview/,
  "the installed launcher proof must not open a manifest");
assert.match(preflightTrapJob, /trap 4: an empty earlier Wrangler directory cannot mask a later session/);
assert.match(preflightTrapJob,
  /artifact-ids: \$\{\{ needs\.package\.outputs\.runtime_identity_artifact_id \}\}/);
assert.match(preflightTrapJob,
  /node scripts\/runtime-identity-receipt\.mjs[\s\S]*?--verify receipt/);
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
const releaseRuntimeIdentityDownloadIndex = release.indexOf(
  "- name: download the runtime identity receipt already tested by CI",
);
const releaseBindIndex = release.indexOf(
  "- name: bind the tested package and runtime receipt to the release assets",
);
assert.ok(releaseDownloadIndex > publishIndex &&
  releaseRuntimeIdentityDownloadIndex > releaseDownloadIndex &&
  releaseBindIndex > releaseRuntimeIdentityDownloadIndex,
"release must retrieve and bind the package and runtime receipt tested by its CI gate");
const releaseArtifactBinding = release.slice(releaseDownloadIndex, release.indexOf("gh release create"));
assert.match(releaseArtifactBinding, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/);
assert.match(releaseArtifactBinding, /artifact-ids: \$\{\{ needs\.gate\.outputs\.artifact_id \}\}/);
assert.match(releaseArtifactBinding,
  /artifact-ids: \$\{\{ needs\.gate\.outputs\.runtime_identity_artifact_id \}\}/);
assert.match(releaseArtifactBinding, /TESTED_ARTIFACT_NAME: \$\{\{ needs\.gate\.outputs\.artifact_name \}\}/);
assert.match(releaseArtifactBinding, /TESTED_PACKAGE_SHA256: \$\{\{ needs\.gate\.outputs\.package_sha256 \}\}/);
assert.match(releaseArtifactBinding,
  /TESTED_RUNTIME_IDENTITY_ARTIFACT_NAME: \$\{\{ needs\.gate\.outputs\.runtime_identity_artifact_name \}\}/);
assert.match(releaseArtifactBinding,
  /TESTED_RUNTIME_IDENTITY_ARTIFACT_SHA256: \$\{\{ needs\.gate\.outputs\.runtime_identity_artifact_sha256 \}\}/);
assert.match(releaseArtifactBinding,
  /TESTED_RUNTIME_IDENTITY_ARTIFACT_BYTES: \$\{\{ needs\.gate\.outputs\.runtime_identity_artifact_bytes \}\}/);
assert.match(releaseArtifactBinding,
  /TESTED_RUNTIME_PAYLOAD_SHA256: \$\{\{ needs\.gate\.outputs\.runtime_payload_sha256 \}\}/);
assert.match(releaseArtifactBinding, /node scripts\/runtime-identity-receipt\.mjs[\s\S]*?--verify receipt/);
assert.doesNotMatch(releaseArtifactBinding, /^          (?:github-token|repository|run-id):/m,
  "same-run downloads must use the Actions runtime without cross-run API inputs");
assert.match(releaseArtifactBinding, /^          skip-decompress: true$/m);
assert.match(releaseArtifactBinding, /^          digest-mismatch: error$/m);
assert.match(releaseArtifactBinding, /actual_receipts=.*createHash\("sha256"\)/s);
assert.match(releaseArtifactBinding, /actual_package_receipt.*!=.*TESTED_PACKAGE_BYTES.*TESTED_PACKAGE_SHA256/s);
assert.match(releaseArtifactBinding,
  /actual_runtime_identity_receipt.*!=.*TESTED_RUNTIME_IDENTITY_ARTIFACT_BYTES.*TESTED_RUNTIME_IDENTITY_ARTIFACT_SHA256/s);
assert.match(releaseArtifactBinding, /cp "\$downloaded" "\$versioned"/);
assert.match(releaseArtifactBinding, /cp "\$versioned" "\$canonical"/);
assert.match(releaseArtifactBinding,
  /cp "\$downloaded_runtime_identity" "\$runtime_identity"/);
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
assert.match(release.slice(createIndex, draftVerifyIndex),
  /"\$VERSIONED_TARBALL" "\$CANONICAL_TARBALL" "\$RUNTIME_IDENTITY_RECEIPT"/);
for (const verifyIndex of [draftVerifyIndex, prepublishVerifyIndex, publishedVerifyIndex]) {
  assert.match(release.slice(verifyIndex, verifyIndex + 240),
    /"\$VERSIONED_TARBALL" "\$CANONICAL_TARBALL" "\$RUNTIME_IDENTITY_RECEIPT"/);
}
assert.match(release.slice(publishedVerifyIndex),
  /brain-installer-\$RELEASE_VERSION-runtime-identity\.json/);
assert.match(release.slice(publishedVerifyIndex),
  /node scripts\/runtime-identity-receipt\.mjs[\s\S]*?--verify receipt/);
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
  const runtimeIdentity = join(sandbox, "brain-installer-9.8.7-runtime-identity.json");
  const bytes = Buffer.from("synthetic release bytes\n");
  const runtimeIdentityBytes = Buffer.from("synthetic runtime identity receipt\n");
  writeFileSync(versioned, bytes);
  writeFileSync(canonical, bytes);
  writeFileSync(runtimeIdentity, runtimeIdentityBytes);
  const assets = [versioned, canonical, runtimeIdentity].map((path) => ({
    name: basename(path),
    size: readFileSync(path).length,
    digest: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
    state: "uploaded",
  }));

  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "draft",
    release: { tag_name: "v9.8.7", draft: true, immutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }));
  assert.doesNotThrow(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: true, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }));
  assert.throws(() => verifyRelease({
    phase: "published",
    release: { tagName: "v9.8.7", isDraft: false, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }), /not immutable/);
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets: assets.slice(0, 1) },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }), /1 assets, expected 3/);

  writeFileSync(canonical, Buffer.from("changed\n"));
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }), /does not match|not byte-identical/);

  writeFileSync(canonical, bytes);
  writeFileSync(runtimeIdentity, Buffer.from("changed runtime identity\n"));
  assert.throws(() => verifyRelease({
    phase: "draft",
    release: { tagName: "v9.8.7", isDraft: true, isImmutable: false, assets },
    tag: "v9.8.7",
    assetPaths: [versioned, canonical, runtimeIdentity],
  }), /does not match/);
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
