import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

test('generated lane evidence is absent from the delivery', () => {
  assert.equal(existsSync(new URL('../.lane-scratch', import.meta.url)), false);
});

// Check the entire scratch namespace, rather than particular fixture names.
// --no-index tests the rule even when reviewing deletions of tracked evidence.
for (const sibling of ['home/fixture/synthetic.manifest.json', 'home/fixture/.brain-admin-key',
  'npm-cache/content/entry', 'runtime/helper.ps1', 'base-root.txt', 'results.json']) {
  test(`scratch exclusion: ${sibling}`, () => {
    const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
      cwd: root, encoding: 'utf8', input: `.lane-scratch/${sibling}\nworker/src/index.js\n`,
    });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), [`.lane-scratch/${sibling}`],
      'generated sibling ignored; shared source remains a candidate');
  });
}
