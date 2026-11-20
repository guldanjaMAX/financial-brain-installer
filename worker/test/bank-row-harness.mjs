import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

// Settings delegates rendering to this module. Execute its real exports and
// function components so source-only probes retain the bundle's dependencies.
export function bankRowHarness({ Date: clock = Date, ...ui } = {}) {
  const React = { Fragment: 'fragment', createElement: (tag, props, ...children) =>
    typeof tag === 'function' ? tag({ ...props, children }) : { tag, props, children } };
  const source = readFileSync(new URL('../../frontend/src/components/BankConnectionRow.tsx', import.meta.url), 'utf8');
  const module = { exports: {} };
  runInNewContext(transformSync(source, { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code, {
    module, exports: module.exports, React, Date: clock,
    require: (name) => {
      assert.equal(name, './ui', 'only the shared UI primitives are substituted');
      return { Row: 'row', Chip: 'chip', Confirm: 'confirm', agoISO: value => value, ...ui };
    },
  });
  assert.equal(typeof module.exports.BankConnectionRow, 'function');
  assert.ok(module.exports.BANK_BUTTON.length > 0);
  return { ...module.exports, React };
}
