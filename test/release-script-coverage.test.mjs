import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TEST_COMMANDS, parseTestCommand } from '../scripts/run-test-chain.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const frontend = JSON.parse(read('frontend/package.json'));
assert.equal(pkg.scripts.test, 'node scripts/run-test-chain.mjs');
assert.equal(frontend.scripts.test, 'vitest run --no-file-parallelism --testTimeout 15000');
const scheduled = new Set(TEST_COMMANDS.flatMap((command) => {
  const parsed = parseTestCommand(command);
  return parsed.kind === 'node' ? parsed.args.filter((arg) => !arg.startsWith('--')) : [];
}));
for (const browserTest of ['owner-upload.browser.mjs', 'document-access.browser.mjs']) {
  assert.ok(frontend.scripts['test:browser'].includes(`test/browser/${browserTest}`), `owner browser gate omits ${browserTest}`);
}
for (const name of readdirSync(join(root, 'scripts')).filter((path) => /^test-.*\.mjs$/.test(path))) {
  assert.ok(scheduled.has(`scripts/${name}`), `npm test omits scripts/${name}`);
}
for (const path of ['test/update-audit.test.mjs', 'test/install-page-version.test.mjs', 'test/preflight-posix.test.mjs', 'test/wrangler-spec-pinned.test.mjs']) {
  assert.ok(scheduled.has(path), `npm test omits ${path}`);
}
assert.equal(pkg.scripts['audit:updates'], 'node scripts/audit-updates.mjs --release');
assert.equal(pkg.scripts['audit:regressions'], 'node scripts/audit-updates.mjs --regressions');
// Windows checks out workflow YAML with CRLF unless .gitattributes pins it,
// and the exact-string scans below would silently find nothing. Normalise,
// the same way update-audit and the release workflow contract already do.
const ci = read('.github/workflows/ci.yml').replace(/\r\n/g, '\n');
assert.doesNotMatch(ci, /continue-on-error:\s*true/);
assert.match(ci, /history-privacy:[\s\S]+npm run privacy:history:remote/);
assert.match(ci, /package:[\s\S]*?needs: history-privacy/);
assert.match(ci, /independent incident regressions\s+if: \$\{\{ !cancelled\(\) \}\}\s+run: npm run audit:regressions/);
for (const required of ['npm ci --prefix frontend --ignore-scripts', 'npm --prefix frontend test', 'npm --prefix frontend run test:browser:install', 'npm --prefix frontend run test:browser', 'git diff --exit-code -- worker/src/lib/app-assets.js', 'Windows DPAPI 25-round release gate', 'packed Windows DPAPI and admin-key release gate']) {
  assert.ok(ci.includes(required), `newer gate was lost: ${required}`);
}
assert.match(ci, /- name: unit and integration suite\s+if: \$\{\{ !cancelled\(\) \}\}\s+run: npm test -- --continue-on-failure/);
const matrixStep = (name, workflow = ci) => {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.ok(start >= 0, `CI omits ${name}`);
  const next = workflow.indexOf('\n      - name: ', start + 1);
  return workflow.slice(start, next < 0 ? workflow.length : next);
};
// Continuation steps fall into two kinds, and the difference is a security
// boundary, not a style choice. Steps that only exercise the source checkout
// must stay visible when an unrelated check fails. Steps that install or run
// the packaged bytes must ALSO require that the exact-package checksum
// actually passed, because a red job does not stop a later step from
// executing unverified bytes.
const PACKAGE_BARRIER = "steps.verify_package.outcome == 'success'";
assert.ok(
  matrixStep('verify exact shared package bytes').includes('id: verify_package'),
  'the exact-package verification step has no id for later steps to require',
);
for (const [name, condition] of [
  ['install owner browser test runtime', 'if: ${{ !cancelled() }}'],
  ['owner scope browser regressions', 'if: ${{ !cancelled() }}'],
  ['unit and integration suite', 'if: ${{ !cancelled() }}'],
  ['independent incident regressions', 'if: ${{ !cancelled() }}'],
  ['cli starts and prints usage', 'if: ${{ !cancelled() }}'],
  ['doctor reports rather than crashing', 'if: ${{ !cancelled() }}'],
  ['Windows DPAPI 25-round release gate', "if: ${{ !cancelled() && runner.os == 'Windows' }}"],
]) {
  const step = matrixStep(name);
  assert.ok(step.includes(condition), `${name} can be hidden by an earlier failure`);
  assert.ok(!step.includes(PACKAGE_BARRIER), `${name} runs from source and must not wait on the package`);
}
const windowsRehearsal = read('.github/workflows/windows-rehearsal.yml').replace(/\r\n/g, '\n');
for (const name of ['install owner browser test runtime', 'owner scope browser regressions']) {
  assert.ok(matrixStep(name, windowsRehearsal).includes('if: ${{ !cancelled() }}'),
    `${name} can be hidden by an earlier Windows rehearsal failure`);
}
for (const [name, condition] of [
  ['packed tarball installs globally and the bin works', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} }}`],
  ['packed tarball installs in a user-owned prefix', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} }}`],
  ['package contains no private data', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} }}`],
  ['packaged preflight runs and prints (Windows)', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} && runner.os == 'Windows' }}`],
  ['packed Windows DPAPI and admin-key release gate', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} && runner.os == 'Windows' }}`],
  ['Windows PowerShell user-prefix command works', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} && runner.os == 'Windows' }}`],
  ['packaged preflight runs and prints (macOS and Linux)', `if: \${{ !cancelled() && ${PACKAGE_BARRIER} && runner.os != 'Windows' }}`],
]) {
  assert.ok(
    matrixStep(name).includes(condition),
    `${name} consumes the package and must require verified bytes and stay visible: ${condition}`,
  );
}
// A future edit must not be able to add a package-consuming continuation step
// without the barrier. Scan the matrix job itself rather than trusting the list
// above to stay complete.
const matrixJob = ci.slice(ci.indexOf('\n  test:\n'), ci.indexOf('\n  preflight-traps:'));
const matrixSteps = matrixJob.split('\n      - name: ').slice(1);
for (const body of matrixSteps) {
  const label = body.split('\n')[0].trim();
  const usesPackage = /\$TARBALL|\.packaged-preflight|\.release-package|PACKAGE_FILENAME/.test(body);
  const continues = body.includes('!cancelled()');
  if (!usesPackage || !continues) continue;
  assert.ok(
    body.includes(PACKAGE_BARRIER),
    `${label} keeps running after a failure and touches the package without requiring verified bytes`,
  );
}
const traps = ci.slice(ci.indexOf('  preflight-traps:'));
assert.match(traps, /needs: package/);
assert.match(traps, /artifact-ids: \$\{\{ needs.package.outputs.artifact_id \}\}/);
assert.match(traps, /\.packaged-preflight\\package\\tools\\preflight.ps1/);
assert.doesNotMatch(traps, /-File \.\\tools\\preflight.ps1/);
const release = read('.github/workflows/release.yml').replace(/\r\n/g, '\n');
const installMatrix = read('.github/workflows/install-matrix.yml').replace(/\r\n/g, '\n');
assert.ok(release.indexOf('node scripts/audit-updates.mjs --release') < release.indexOf('gh release create'));
assert.doesNotMatch(release, /continue-on-error: true|if: always\(\)/);
assert.match(installMatrix, /^  workflow_call:$/m);
assert.match(release, /public-contract-install:[\s\S]*uses: \.\/\.github\/workflows\/install-matrix\.yml/);
assert.match(release, /needs:\n      - gate\n      - public-contract-install/);
console.log('Release coverage: script tests join npm test; history, frontend, DPAPI, shared-package traps, public contract, and held incident gates remain mandatory');
