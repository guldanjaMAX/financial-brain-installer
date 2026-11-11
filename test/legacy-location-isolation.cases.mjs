import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelSwitchFixture, updateAdapters } from './fixtures/legacy-model-switch.mjs';
test('legacy update fixture isolates its installed-manifest pointer', t => {
  const root=realpathSync.native(mkdtempSync(join(tmpdir(),'legacy-location-isolation-'))); const f=modelSwitchFixture(root);
  t.after(()=>{f.db.close();rmSync(root,{recursive:true,force:true})});
  assert.equal(updateAdapters(f).options.installedManifestOptions?.stateDirectory,join(root,'install-state'));
});
