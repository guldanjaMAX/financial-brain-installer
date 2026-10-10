// Kept Node-test compatible so this contract also runs without a browser install.
import test from 'node:test';
import assert from 'node:assert/strict';
import { quickBooksSetupPresentation, QUICKBOOKS_SETUP_STATES } from '../frontend/src/components/quickbooks-setup-state.mjs';

test('P05 every safe setup state separates grant and completed import', () => {
  assert.ok(Object.keys(QUICKBOOKS_SETUP_STATES).length >= 10);
  for (const stage of ['keys_staged', 'reconnect', 'revocation_uncertain']) {
    const view = quickBooksSetupPresentation({ stage, connected: false, error: 'private-provider-canary' });
    assert.equal(view.connected, false);
    assert.equal(view.lastImport, null);
    assert.equal(JSON.stringify(view).includes('private-provider-canary'), false);
  }
  const good = quickBooksSetupPresentation({ stage: 'import_pending', connected: true });
  assert.equal(good.connected, true);
  assert.equal(good.lastImport, null);
  assert.equal(quickBooksSetupPresentation({ stage: 'unexpected', connected: true }).connected, false);
});

test('owner setup and shell compile with the installed source compiler', async () => {
  const { transformSync } = await import('esbuild');
  const { readFileSync } = await import('node:fs');
  for (const file of ['App.tsx', 'components/QuickBooksSetup.tsx']) {
    const source = readFileSync(new URL('../frontend/src/' + file, import.meta.url), 'utf8');
    const result = transformSync(source, { loader: 'tsx', jsx: 'automatic', format: 'esm' });
    assert.ok(result.code.length > 100);
    assert.equal(result.warnings.length, 0);
  }
});
