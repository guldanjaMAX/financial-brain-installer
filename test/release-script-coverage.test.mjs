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
for (const browserTest of [
  'passkey-gate.browser.mjs',
  'owner-upload.browser.mjs',
  'document-access.browser.mjs',
  'financial-map.browser.mjs',
  'document-journey.browser.mjs',
]) {
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
const assertBrowserBundleOrder = (workflow, label) => {
  const bundle = workflow.indexOf('      - name: owner app production bundle parity\n');
  const browser = workflow.indexOf('      - name: owner scope browser regressions\n');
  assert.ok(bundle >= 0, `${label} omits the owner app production bundle`);
  assert.ok(browser >= 0, `${label} omits the owner browser regressions`);
  assert.ok(bundle < browser, `${label} must build frontend/dist before the browser harness serves it`);
};
assertBrowserBundleOrder(ci, 'CI');
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
assertBrowserBundleOrder(windowsRehearsal, 'Windows rehearsal');
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
// CI CONCURRENCY. Without a concurrency key, a push to a branch with an open PR
// started TWO complete matrix runs, they competed for runners, and GitHub did not
// supersede the loser, so a commit whose twin was green could stay BLOCKED on the
// red context with auto-merge unable to fire.
//
// These assertions exist because the key is otherwise unpinned: every clause of it
// is a one-token edit away from silently doing nothing.
const ciConcurrency = ci.match(/^concurrency:\n  group: (.+)\n  cancel-in-progress: (.+)$/m);
assert.ok(ciConcurrency, 'ci.yml lost its concurrency key, so every push runs the matrix twice');
const [, ciGroup, ciCancel] = ciConcurrency;

// ref_name, not ref. push carries refs/heads/<branch> and pull_request carries
// refs/pull/<n>/merge, so grouping on github.ref puts the twins in separate groups
// and cancels nothing. head_ref is the short branch name on pull_request and empty
// on push, so it must pair with ref_name, the matching short name, or the two
// events produce "foo" and "refs/heads/foo" and the bug survives looking fixed.
assert.equal(ciGroup, 'ci-${{ github.head_ref || github.ref_name }}',
  'the CI concurrency group must collapse a branch push and its pull_request into one key');
assert.doesNotMatch(ciGroup, /github\.ref\s*}}/,
  'grouping on github.ref cannot match a pull_request ref against a push ref');

// The tag guard is load-bearing. A release builds on a tag, so an unguarded
// cancel-in-progress would let a second tag push kill a release matrix mid-flight.
assert.equal(ciCancel, "${{ !startsWith(github.ref, 'refs/tags/') }}",
  'cancel-in-progress must never be able to cancel a tag build');
assert.notEqual(ciCancel.trim(), 'true', 'an unguarded cancel would make a release cancellable');

// No group may collide with another workflow's, and above all not with the CALLER's.
// release.yml runs ci.yml through `uses:`, so ci.yml's jobs execute inside the
// release run; a reusable workflow whose group matches its caller's deadlocks,
// because the caller waits for the callee while the callee queues behind it.
const groupOf = (workflow, file) => {
  const found = workflow.match(/^concurrency:\n  group: (.+)$/m);
  assert.ok(found, `${file} lost its concurrency group`);
  return found[1];
};
const groups = [
  ['ci.yml', ciGroup],
  ['release.yml', groupOf(release, 'release.yml')],
  ['windows-rehearsal.yml', groupOf(windowsRehearsal, 'windows-rehearsal.yml')],
];
assert.equal(new Set(groups.map(([, group]) => group)).size, groups.length,
  `two workflows share a concurrency group: ${groups.map(([f, g]) => `${f}=${g}`).join(' | ')}`);
for (const [file, group] of groups) {
  const prefix = group.slice(0, group.indexOf('${{'));
  assert.ok(prefix.length > 0, `${file} has no literal prefix namespacing its group`);
  for (const [otherFile, otherGroup] of groups) {
    if (otherFile === file) continue;
    const otherPrefix = otherGroup.slice(0, otherGroup.indexOf('${{'));
    assert.ok(!prefix.startsWith(otherPrefix) && !otherPrefix.startsWith(prefix),
      `${file} prefix "${prefix}" can collide with ${otherFile} prefix "${otherPrefix}"`);
  }
}

// The push trigger is deliberate: branches without an open PR keep their CI.
assert.match(ci, /^  push:\n    branches:\n      - "\*\*"$/m,
  'branch pushes must keep their own CI coverage');

console.log('Release coverage: script tests join npm test; history, frontend, DPAPI, shared-package traps, public contract, and held incident gates remain mandatory');
