import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'src');
function modules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? modules(resolve(directory, entry.name)) : /\.[cm]?js$/.test(entry.name) ? [resolve(directory, entry.name)] : []);
}
test('separate broker package has no runtime import path to accounting processing', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, true);
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.equal(manifest.type, 'module');
  const files = modules(source);
  assert.ok(files.length > 0);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.equal(/\b(?:eval|Function|require)\s*\(/.test(text), false, 'runtime code cannot bypass the closed import graph');
    assert.equal(/\bimport\s*\(/.test(text), false, 'dynamic imports are outside the closed broker graph');
    for (const match of text.matchAll(/\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      assert.ok(specifier.startsWith('.'), 'broker runtime dependencies are package-local');
      const target = resolve(dirname(file), specifier);
      assert.ok(!relative(source, target).startsWith('..'), 'broker imports stay inside its source boundary');
      assert.ok(files.includes(target), 'every broker runtime import resolves to a reviewed source module');
    }
    assert.equal(/\bglobalThis\s*\.\s*fetch\b|\b(?:await|return)\s+fetch\s*\(|\b(?:XMLHttpRequest|WebSocket)\s*\(/.test(text), false, 'outbound I/O must use an explicitly injected transport');
  }
});
