import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json'));
const frontend = JSON.parse(read('frontend/package.json'));
for (const browserTest of ['owner-upload.browser.mjs', 'document-access.browser.mjs']) {
  assert.ok(frontend.scripts['test:browser'].includes(`test/browser/${browserTest}`), `owner browser gate omits ${browserTest}`);
}
for (const name of readdirSync(join(root, 'scripts')).filter((path) => /^test-.*\.mjs$/.test(path))) {
  assert.ok(pkg.scripts.test.includes(`scripts/${name}`), `npm test omits scripts/${name}`);
}
for (const path of ['test/update-audit.test.mjs', 'test/install-page-version.test.mjs', 'test/preflight-posix.test.mjs', 'test/wrangler-spec-pinned.test.mjs']) {
  assert.ok(pkg.scripts.test.includes(path), `npm test omits ${path}`);
}
assert.equal(pkg.scripts['audit:updates'], 'node scripts/audit-updates.mjs --release');
assert.equal(pkg.scripts['audit:regressions'], 'node scripts/audit-updates.mjs --regressions');
const ci = read('.github/workflows/ci.yml');
assert.match(ci, /history-privacy:[\s\S]+npm run privacy:history:remote/);
assert.match(ci, /package:[\s\S]*?needs: history-privacy/);
assert.match(ci, /independent incident regressions\s+if: \$\{\{ !cancelled\(\) \}\}\s+run: npm run audit:regressions/);
for (const required of ['npm ci --prefix frontend --ignore-scripts', 'npm --prefix frontend test', 'npm --prefix frontend run test:browser:install', 'npm --prefix frontend run test:browser', 'git diff --exit-code -- worker/src/lib/app-assets.js', 'Windows DPAPI 25-round release gate', 'packed Windows DPAPI and admin-key release gate']) {
  assert.ok(ci.includes(required), `newer gate was lost: ${required}`);
}
const traps = ci.slice(ci.indexOf('  preflight-traps:'));
assert.match(traps, /needs: package/);
assert.match(traps, /artifact-ids: \$\{\{ needs.package.outputs.artifact_id \}\}/);
assert.match(traps, /\.packaged-preflight\\package\\tools\\preflight.ps1/);
assert.doesNotMatch(traps, /-File \.\\tools\\preflight.ps1/);
const release = read('.github/workflows/release.yml');
assert.ok(release.indexOf('node scripts/audit-updates.mjs --release') < release.indexOf('gh release create'));
assert.doesNotMatch(release, /continue-on-error: true|if: always\(\)/);
console.log('Release coverage: script tests join npm test; history, frontend, DPAPI, shared-package traps, and held incident gate remain mandatory');
